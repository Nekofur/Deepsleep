import * as db from '../chat/db.js'
import { applySyncedSessions, collectSessions } from '../chat/store.js'
import type { TranslationMessage } from '../../i18n/index.js'
import { SyncError, type SyncErrorCode } from './errors.js'
import { mergeArchives, stateChanged } from './merge.js'
import {
  emptyState,
  imageAttachmentIds,
  packState,
  SYNC_FORMAT,
  SYNC_VERSION,
  unpackState,
  type SyncState,
} from './state.js'
import {
  getSyncConfig,
  isSyncLinked,
  setSyncStatus,
  updateSync,
  useSync,
  type SyncResultSummary,
} from './store.js'
import { createTransport, type SyncTransport } from './transport.js'
import { onSyncRequest } from './signals.js'

/** 冲突时重新拉取合并的最多次数 */
const CONFLICT_RETRY = 1
/** 自动同步间隔 */

/** 与服务端错误码一一对应的文案；服务器异常时把原文填进 message */
const errorMessages: Record<SyncErrorCode, TranslationMessage> = {
  notConfigured: { key: 'syncErrorNotConfigured' },
  unauthorized: { key: 'syncErrorAuthExpired' },
  network: { key: 'syncErrorNetwork' },
  protocol: { key: 'syncErrorProtocol' },
  conflict: { key: 'syncErrorConflict' },
  busy: { key: 'syncErrorBusy' },
  server: { key: 'syncErrorServer' },
}

let running: Promise<SyncResultSummary> | null = null
let scheduled = 0

const statusMessage = (error: unknown): TranslationMessage => {
  const code = error instanceof SyncError ? error.code : 'server'
  const message = errorMessages[code]
  return code === 'server'
    ? { ...message, params: { message: error instanceof Error ? error.message : String(error) } }
    : message
}

/** 下载合并结果里本地缺失的图片原件；没有对应远端文件时跳过 */
const downloadFiles = async (
  transport: SyncTransport,
  state: SyncState,
  incoming: { id: string }[],
  signal?: AbortSignal
): Promise<db.StoredFile[]> => {
  const available = new Set(state.files)
  const files: db.StoredFile[] = []
  for (const { id } of incoming) {
    signal?.throwIfAborted()
    if (!available.has(id)) {
      continue
    }
    if (await db.loadFile(id).catch(() => undefined)) {
      continue
    }
    const blob = await transport.readFile(id, signal).catch(() => null)
    if (blob) {
      files.push({ id, blob })
    }
  }
  return files
}

/** 上传远端还没有的图片原件，返回更新后的远端清单 */
const uploadFiles = async (
  transport: SyncTransport,
  sessions: ReturnType<typeof imageAttachmentIds>,
  remoteFiles: Set<string>,
  signal?: AbortSignal
): Promise<Set<string>> => {
  for (const id of sessions) {
    signal?.throwIfAborted()
    if (remoteFiles.has(id)) {
      continue
    }
    const blob = await db.loadFile(id).catch(() => undefined)
    if (!blob) {
      continue
    }
    await transport.writeFile(id, blob, signal)
    remoteFiles.add(id)
  }
  return remoteFiles
}

const applyState = async (state: SyncState, transport: SyncTransport) => {
  const config = getSyncConfig()
  const localSessions = await collectSessions()
  const localIds = new Set(localSessions.map((session) => session.id))
  const remote = {
    sessions: state.sessions,
    tombstones: state.tombstones,
    files: state.files,
    device: state.device,
  }
  const merged = mergeArchives({ sessions: localSessions, tombstones: config.tombstones }, remote)
  const missing = imageAttachmentIds(merged.incoming)
  const files = await downloadFiles(
    transport,
    state,
    [...missing].map((id) => ({ id }))
  )
  if (merged.changed) {
    await applySyncedSessions(merged.incoming, merged.removed, files)
  }
  const remoteFiles = await uploadFiles(
    transport,
    imageAttachmentIds(merged.sessions),
    new Set(state.files)
  )
  const added = merged.incoming.filter((session) => !localIds.has(session.id)).length
  const summary: SyncResultSummary = {
    added,
    updated: merged.incoming.length - added,
    removed: merged.removed.length,
    uploaded: false,
  }
  return { merged, remoteFiles, summary, remote }
}

const run = async (): Promise<SyncResultSummary> => {
  setSyncStatus({ phase: 'syncing', message: null, result: null })
  try {
    for (let attempt = 0; ; attempt += 1) {
      const config = getSyncConfig()
      if (!isSyncLinked(config)) {
        throw new SyncError('notConfigured')
      }
      const transport = createTransport(config)
      const remote = await transport.readState()
      const remoteState = remote ? unpackState(remote.bytes) : emptyState(config.deviceName)
      const { merged, remoteFiles, summary } = await applyState(remoteState, transport)
      const next: SyncState = {
        format: SYNC_FORMAT,
        version: SYNC_VERSION,
        updatedAt: new Date().toISOString(),
        device: config.deviceName,
        tombstones: merged.tombstones,
        sessions: merged.sessions,
        files: [...remoteFiles],
      }
      const changed = stateChanged(
        merged.sessions,
        merged.tombstones,
        next.files,
        remote
          ? {
              sessions: remoteState.sessions,
              tombstones: remoteState.tombstones,
              files: remoteState.files,
            }
          : null
      )
      if (!changed) {
        updateSync({ syncedAt: Date.now(), tombstones: merged.tombstones })
        setSyncStatus({ phase: 'idle', message: null, result: summary })
        return summary
      }
      try {
        await transport.writeState(packState(next), remote?.etag ?? null)
        updateSync({ syncedAt: Date.now(), tombstones: merged.tombstones })
        summary.uploaded = true
        setSyncStatus({ phase: 'idle', message: null, result: summary })
        return summary
      } catch (error) {
        // 其他设备先写入：重新拉取合并后重试，仍冲突则把错误交给界面
        if (error instanceof SyncError && error.code === 'conflict' && attempt < CONFLICT_RETRY) {
          continue
        }
        throw error
      }
    }
  } catch (error) {
    setSyncStatus({ phase: 'error', message: statusMessage(error), result: null })
    throw error
  }
}

/** 立即同步；已有同步进行中时复用同一个 Promise */
export const syncNow = (): Promise<SyncResultSummary> => {
  if (running) {
    return running
  }
  running = run().finally(() => {
    running = null
  })
  return running
}

/** 同步时机：页面打开后同步一次，之后每次推理结束或删除会话时同步 */
export const startAutoSync = () => {
  const maybeSync = () => {
    const config = getSyncConfig()
    if (config.enabled && isSyncLinked(config)) {
      void syncNow().catch(() => {
        // 失败原因已写入同步状态，由设置页展示
      })
    }
  }
  const initial = window.setTimeout(maybeSync, 3000)
  const unsubscribe = onSyncRequest(scheduleSync)
  return () => {
    window.clearTimeout(initial)
    unsubscribe()
  }
}

/** 本机刚改动过（如删除会话）时，延迟触发一次自动同步 */
export const scheduleSync = () => {
  const config = getSyncConfig()
  if (!config.enabled || !isSyncLinked(config)) {
    return
  }
  window.clearTimeout(scheduled)
  scheduled = window.setTimeout(() => {
    void syncNow().catch(() => {})
  }, 2000)
}

/** 供设置页展示：当前是否打开了自动同步 */
export const isAutoSyncEnabled = () => useSync.getState().enabled
