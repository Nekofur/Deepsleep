import * as db from '../chat/db.js'
import {
  applySyncedManifest,
  collectSessionSummaries,
  collectSessions,
  getRemoteSessionIds,
  noteSessionDownloaded,
} from '../chat/store.js'
import type { Session, SessionSummary } from '../chat/types.js'
import type { TranslationMessage } from '../../i18n/index.js'
import { SyncError, type SyncErrorCode } from './errors.js'
import { manifestChanged, mergeSync } from './merge.js'
import {
  emptyManifest,
  imageAttachmentIds,
  packManifest,
  packSession,
  SYNC_FORMAT,
  SYNC_VERSION,
  unpackManifest,
  unpackSession,
  type SyncManifest,
} from './manifest.js'
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

/** 下载会话里远端已有、本地缺失的图片原件；available 为空表示不按清单过滤 */
const downloadImages = async (
  transport: SyncTransport,
  session: Session,
  available: Set<string> | null,
  signal?: AbortSignal
): Promise<db.StoredFile[]> => {
  const files: db.StoredFile[] = []
  for (const id of imageAttachmentIds([session])) {
    signal?.throwIfAborted()
    if (available && !available.has(id)) {
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

/** 读取一个远端会话正文，并补齐本地缺失的图片；远端没有这个对象时返回 null */
const readRemoteSession = async (
  transport: SyncTransport,
  id: string,
  available: Set<string> | null,
  signal?: AbortSignal
): Promise<{ session: Session; files: db.StoredFile[] } | null> => {
  const bytes = await transport.readSession(id, signal)
  if (!bytes) {
    return null
  }
  const session = unpackSession(bytes)
  return { session, files: await downloadImages(transport, session, available, signal) }
}

/** 上传远端还没有的图片原件，返回更新后的远端清单 */
const uploadImages = async (
  transport: SyncTransport,
  sessions: Session[],
  remoteFiles: Set<string>,
  signal?: AbortSignal
): Promise<boolean> => {
  let uploaded = false
  for (const id of imageAttachmentIds(sessions)) {
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
    uploaded = true
  }
  return uploaded
}

const sameSummaries = (left: SessionSummary[], right: SessionSummary[]): boolean => {
  if (left.length !== right.length) {
    return false
  }
  const rightById = new Map(right.map((summary) => [summary.id, summary]))
  return left.every((summary) => {
    const other = rightById.get(summary.id)
    return (
      other !== undefined &&
      other.title === summary.title &&
      other.createdAt === summary.createdAt &&
      other.updatedAt === summary.updatedAt
    )
  })
}

const sameIds = (left: string[], right: string[]): boolean => {
  if (left.length !== right.length) {
    return false
  }
  const rightIds = new Set(right)
  return left.every((id) => rightIds.has(id))
}

/**
 * 一次同步：
 * 1. 只读清单，合并会话摘要，墓碑优先、updatedAt 新者胜；
 * 2. 本地没有正文的远端会话记为「未下载」，只在列表里显示占位项；
 * 3. 本地已有正文、远端更新的会话下载正文与缺失图片；
 * 4. 本地新增或更新的会话逐个上传正文，再补传远端缺少的图片；
 * 5. 条件写回清单，冲突时重读合并后重试一次。
 */
const run = async (): Promise<SyncResultSummary> => {
  setSyncStatus({ phase: 'syncing', message: null, result: null })
  try {
    for (let attempt = 0; ; attempt += 1) {
      const config = getSyncConfig()
      if (!isSyncLinked(config)) {
        throw new SyncError('notConfigured')
      }
      const transport = createTransport(config)
      // 清单不存在（404）视为空账号，旧的 v2 state.json.gz 不再读取
      const remote = await transport.readManifest()
      const remoteManifest = remote
        ? unpackManifest(remote.bytes)
        : emptyManifest(config.deviceName)
      const localSessions = await collectSessions()
      const localSummaries = collectSessionSummaries()
      const remoteFiles = new Set(remoteManifest.files)
      const merged = mergeSync(
        { sessions: localSessions, summaries: localSummaries, tombstones: config.tombstones },
        remoteManifest
      )

      // 远端更新且本地已有正文的会话：下载正文与缺失图片，稍后一次性写入本地
      const downloaded: Session[] = []
      const downloadedFiles: db.StoredFile[] = []
      for (const id of merged.incoming) {
        const remoteSession = await readRemoteSession(transport, id, remoteFiles)
        if (!remoteSession) {
          continue
        }
        downloaded.push(remoteSession.session)
        downloadedFiles.push(...remoteSession.files)
      }

      const knownIds = new Set(localSummaries.map((summary) => summary.id))
      const result: SyncResultSummary = {
        added: merged.sessions.filter((summary) => !knownIds.has(summary.id)).length,
        updated: downloaded.length,
        removed: merged.removed.length,
        uploaded: false,
      }

      if (
        downloaded.length > 0 ||
        merged.removed.length > 0 ||
        !sameSummaries(localSummaries, merged.sessions) ||
        !sameIds(getRemoteSessionIds(), merged.remoteOnly)
      ) {
        await applySyncedManifest(
          merged.sessions,
          merged.removed,
          merged.remoteOnly,
          downloaded,
          downloadedFiles
        )
      }

      // 只上传本地新增/更新的会话正文；图片只补远端清单里没有的
      const localById = new Map(localSessions.map((session) => [session.id, session]))
      for (const id of merged.outgoing) {
        const session = localById.get(id)
        if (!session) {
          continue
        }
        await transport.writeSession(id, packSession(session))
        result.uploaded = true
      }
      const liveIds = new Set(merged.sessions.map((summary) => summary.id))
      if (
        await uploadImages(
          transport,
          localSessions.filter((session) => liveIds.has(session.id)),
          remoteFiles
        )
      ) {
        result.uploaded = true
      }

      const next: SyncManifest = {
        format: SYNC_FORMAT,
        version: SYNC_VERSION,
        updatedAt: new Date().toISOString(),
        device: config.deviceName,
        sessions: merged.sessions,
        tombstones: merged.tombstones,
        files: [...remoteFiles],
      }
      try {
        if (result.uploaded || manifestChanged(next, remote ? remoteManifest : null)) {
          await transport.writeManifest(packManifest(next), remote?.etag ?? null)
          result.uploaded = true
        }
      } catch (error) {
        // 其他设备先写入清单：重新拉取合并后重试，仍冲突则把错误交给界面
        if (error instanceof SyncError && error.code === 'conflict' && attempt < CONFLICT_RETRY) {
          continue
        }
        throw error
      }
      updateSync({ syncedAt: Date.now(), tombstones: merged.tombstones })
      setSyncStatus({ phase: 'idle', message: null, result })
      return result
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

/**
 * 按需下载单个远端会话：正文与本地缺失的图片写入本地库，清除「未下载」标记。
 * 供 chat/store 在用户打开占位会话时通过 dynamic import 调用。
 */
export const fetchSyncedSession = async (id: string): Promise<Session> => {
  const config = getSyncConfig()
  if (!isSyncLinked(config)) {
    throw new SyncError('notConfigured')
  }
  const remote = await readRemoteSession(createTransport(config), id, null)
  if (!remote) {
    throw new SyncError('protocol', `session ${id} is missing on the remote`)
  }
  await db.saveSession(remote.session, remote.files)
  noteSessionDownloaded(remote.session)
  return remote.session
}

/** 下载全部未下载的远端会话，返回下载数量；导出全量历史前调用 */
export const downloadAllSessions = async (): Promise<number> => {
  const config = getSyncConfig()
  if (!isSyncLinked(config)) {
    return 0
  }
  const ids = getRemoteSessionIds()
  if (ids.length === 0) {
    return 0
  }
  const transport = createTransport(config)
  let count = 0
  for (const id of ids) {
    const remote = await readRemoteSession(transport, id, null)
    if (!remote) {
      continue
    }
    await db.saveSession(remote.session, remote.files)
    noteSessionDownloaded(remote.session)
    count += 1
  }
  return count
}

/**
 * 同步时机：页面打开、切回页面/窗口获得焦点、每次推理结束或删除会话时。
 * 没有定时轮询，但切回页面会主动拉取一次，避免另一台设备的改动一直不落地。
 */
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
  const onVisible = () => {
    if (document.visibilityState === 'visible') {
      maybeSync()
    }
  }
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('focus', onVisible)
  return () => {
    window.clearTimeout(initial)
    unsubscribe()
    document.removeEventListener('visibilitychange', onVisible)
    window.removeEventListener('focus', onVisible)
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
