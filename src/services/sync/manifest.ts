import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate'
import type { Session, SessionSummary } from '../chat/types.js'
import { SyncError } from './errors.js'

/**
 * 会话同步 v3：manifest 只放会话列表、删除记录与远端已有图片 id，
 * 每个会话的正文单独存 sessions/<id>.json.gz，图片仍按 files/<id> 存放。
 * 同步默认只拉 manifest，会话正文等用户打开时再下载。
 */
export const SYNC_FORMAT = 'deepsleep-sync'
export const SYNC_VERSION = 3

export type SyncManifest = {
  format: typeof SYNC_FORMAT
  version: number
  /** 清单写入时间，RFC 3339 */
  updatedAt: string
  /** 生成该清单的设备名 */
  device: string
  /** 会话列表，只有元数据；正文按 id 单独存取 */
  sessions: SessionSummary[]
  /** 已删除的会话：会话 id → 删除时间（毫秒） */
  tombstones: Record<string, number>
  /** 远端已存在的图片附件 id；避免重复上传同一张图片 */
  files: string[]
}

export const emptyManifest = (device = ''): SyncManifest => ({
  format: SYNC_FORMAT,
  version: SYNC_VERSION,
  updatedAt: new Date(0).toISOString(),
  device,
  sessions: [],
  tombstones: {},
  files: [],
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const readSummary = (value: unknown): SessionSummary | null => {
  if (!isRecord(value)) {
    return null
  }
  const { id, title, createdAt, updatedAt } = value
  if (
    typeof id !== 'string' ||
    !id ||
    typeof title !== 'string' ||
    typeof createdAt !== 'number' ||
    typeof updatedAt !== 'number'
  ) {
    return null
  }
  return { id, title, createdAt, updatedAt }
}

/** gzip 压缩后的清单；通常只有会话列表大小，拉取一次很轻 */
export const packManifest = (manifest: SyncManifest): Uint8Array<ArrayBuffer> =>
  gzipSync(strToU8(JSON.stringify(manifest)))

export const unpackManifest = (bytes: Uint8Array): SyncManifest => {
  let value: unknown
  try {
    value = JSON.parse(strFromU8(gunzipSync(bytes)))
  } catch {
    throw new SyncError('protocol', 'invalid sync manifest')
  }
  if (!isRecord(value) || value.format !== SYNC_FORMAT) {
    throw new SyncError('protocol', 'unsupported sync manifest')
  }
  if (typeof value.version !== 'number' || value.version > SYNC_VERSION) {
    throw new SyncError('protocol', 'sync manifest is newer than this app')
  }
  const tombstones: Record<string, number> = {}
  if (isRecord(value.tombstones)) {
    for (const [id, at] of Object.entries(value.tombstones)) {
      if (typeof at === 'number' && Number.isFinite(at)) {
        tombstones[id] = at
      }
    }
  }
  return {
    format: SYNC_FORMAT,
    version: value.version,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
    device: typeof value.device === 'string' ? value.device : '',
    sessions: Array.isArray(value.sessions)
      ? value.sessions.map(readSummary).filter((item): item is SessionSummary => item !== null)
      : [],
    tombstones,
    files: Array.isArray(value.files)
      ? value.files.filter((id): id is string => typeof id === 'string' && !!id)
      : [],
  }
}

/** 单个会话正文的 gzip 对象，按会话 id 单独上传与下载 */
export const packSession = (session: Session): Uint8Array<ArrayBuffer> =>
  gzipSync(strToU8(JSON.stringify(session)))

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

export const unpackSession = (bytes: Uint8Array): Session => {
  let value: unknown
  try {
    value = JSON.parse(strFromU8(gunzipSync(bytes)))
  } catch {
    throw new SyncError('protocol', 'invalid synced session')
  }
  const session = readSession(value)
  if (!session) {
    throw new SyncError('protocol', 'invalid synced session')
  }
  return session
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
