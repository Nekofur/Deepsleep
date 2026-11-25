import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate'
import type { Session } from '../chat/types.js'
import { SyncError } from './errors.js'

/**
 * 会话同步的存储格式 v2：不再把全部会话与图片打成一个 ZIP，而是
 * - state.json.gz：gzip 压缩的会话、删除记录与远端已有附件清单；
 * - files/{附件 id}：图片原件逐个对象保存。
 * 合并只需要下载状态文件（很小），新增图片才逐个上传，避免每次同步重传整包。
 *
 * v3 起改用 manifest.json.gz + sessions/<id>.json.gz（见 manifest.ts），
 * 这个模块只为兼容旧构建保留，同步引擎不再引用。
 */
export const SYNC_FORMAT = 'chat-demo-sync'
export const SYNC_VERSION = 2

export type SyncState = {
  format: typeof SYNC_FORMAT
  version: number
  /** 生成时间，RFC 3339 */
  updatedAt: string
  /** 生成该状态的设备名 */
  device: string
  /** 已删除的会话：会话 id → 删除时间（毫秒） */
  tombstones: Record<string, number>
  sessions: Session[]
  /** 远端已保存原件的附件 id；避免重复上传同一张图片 */
  files: string[]
}

export const emptyState = (device = ''): SyncState => ({
  format: SYNC_FORMAT,
  version: SYNC_VERSION,
  updatedAt: new Date(0).toISOString(),
  device,
  tombstones: {},
  sessions: [],
  files: [],
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const readSession = (value: unknown): Session | null => {
  if (!isRecord(value)) {
    return null
  }
  const { id, title, createdAt, updatedAt, messages } = value
  if (
    typeof id !== 'string' ||
    !id ||
    typeof title !== 'string' ||
    typeof createdAt !== 'number' ||
    typeof updatedAt !== 'number' ||
    !Array.isArray(messages)
  ) {
    return null
  }
  return value as unknown as Session
}

const readSessions = (value: unknown): Session[] => {
  if (!Array.isArray(value)) {
    throw new SyncError('protocol', 'sessions is not an array')
  }
  const sessions = value.map(readSession)
  if (sessions.some((session) => session === null)) {
    throw new SyncError('protocol', 'invalid session')
  }
  return sessions as Session[]
}

const readTombstones = (value: unknown): Record<string, number> => {
  const result: Record<string, number> = {}
  if (isRecord(value)) {
    for (const [id, at] of Object.entries(value)) {
      if (typeof at === 'number' && Number.isFinite(at)) {
        result[id] = at
      }
    }
  }
  return result
}

/** gzip 压缩后的状态文件；体积通常只有原始 JSON 的十分之一 */
export const packState = (state: SyncState): Uint8Array<ArrayBuffer> =>
  gzipSync(strToU8(JSON.stringify(state)))

export const unpackState = (bytes: Uint8Array): SyncState => {
  let value: unknown
  try {
    value = JSON.parse(strFromU8(gunzipSync(bytes)))
  } catch {
    throw new SyncError('protocol', 'invalid sync state')
  }
  if (!isRecord(value) || value.format !== SYNC_FORMAT) {
    throw new SyncError('protocol', 'unsupported sync state')
  }
  if (typeof value.version !== 'number' || value.version > SYNC_VERSION) {
    throw new SyncError('protocol', 'sync state is newer than this app')
  }
  return {
    format: SYNC_FORMAT,
    version: value.version,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
    device: typeof value.device === 'string' ? value.device : '',
    tombstones: readTombstones(value.tombstones),
    sessions: readSessions(value.sessions),
    files: Array.isArray(value.files)
      ? value.files.filter((id): id is string => typeof id === 'string' && !!id)
      : [],
  }
}

/** 会话里所有图片附件的 id，用于挑选需要下载或上传的原件 */
export const imageAttachmentIds = (sessions: Session[]): Set<string> => {
  const ids = new Set<string>()
  for (const session of sessions) {
    for (const message of session.messages) {
      if (message.role !== 'user') {
        continue
      }
      for (const file of message.files) {
        if (file.isImage) {
          ids.add(file.id)
        }
      }
    }
  }
  return ids
}
