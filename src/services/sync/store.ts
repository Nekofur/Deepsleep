import { create } from 'zustand'
import type { TranslationMessage } from '../../i18n/index.js'
import { createId } from '../../utils/id.js'
import { getToolsConfig } from '../providers/store.js'
import { isS3Configured, type S3Config } from './s3.js'

/** 同步通道：自建服务器，或直连 S3 兼容对象存储 */
export type SyncTransportKind = 'server' | 's3'

const DEFAULT_S3: S3Config = {
  endpoint: '',
  region: 'auto',
  bucket: '',
  prefix: 'chat-demo/',
  accessKeyId: '',
  secretAccessKey: '',
  pathStyle: true,
}

/** 同步设置与进度，存 localStorage；服务器通道复用工具服务的 API Key，S3 直接保存凭据 */
export type SyncConfig = {
  transport: SyncTransportKind
  /** 自动同步：打开后定时同步，并在窗口重新可见时同步 */
  enabled: boolean
  /** 同步服务器地址，例如 http://localhost:8080 */
  serverUrl: string
  /** S3 直连配置（transport 为 s3 时使用） */
  s3: S3Config
  /** 本设备的稳定标识，用于生成与展示同步文件 */
  deviceId: string
  deviceName: string
  /** 上次同步完成的时间（毫秒），0 表示从未同步 */
  syncedAt: number
  /** 已删除的会话：会话 id → 删除时间，跨设备合并时用于删除旧版本 */
  tombstones: Record<string, number>
}

const STORAGE_KEY = 'chat-demo:sync'

const read = () => {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

const write = (value: SyncConfig) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 按浏览器信息给设备起个名字，仅用于展示同步来源 */
const detectDevice = () => {
  if (typeof navigator === 'undefined') {
    return 'Web'
  }
  const ua = navigator.userAgent
  for (const [pattern, name] of [
    [/iPhone|iPad|iPod/, 'iOS'],
    [/Android/, 'Android'],
    [/Macintosh/, 'macOS'],
    [/Windows/, 'Windows'],
    [/Linux/, 'Linux'],
  ] as const) {
    if (pattern.test(ua)) {
      return name
    }
  }
  return 'Web'
}

const text = (value: unknown) => (typeof value === 'string' ? value : '')

const boolean = (value: unknown, fallback: boolean) =>
  typeof value === 'boolean' ? value : fallback

const normalizeS3 = (value: unknown): S3Config => {
  const raw = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  return {
    endpoint: text(raw.endpoint),
    region: text(raw.region) || DEFAULT_S3.region,
    bucket: text(raw.bucket),
    prefix: text(raw.prefix) || DEFAULT_S3.prefix,
    accessKeyId: text(raw.accessKeyId),
    secretAccessKey: text(raw.secretAccessKey),
    pathStyle: boolean(raw.pathStyle, true),
  }
}

const tombstones = (value: unknown): Record<string, number> => {
  const result: Record<string, number> = {}
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const [id, at] of Object.entries(value as Record<string, unknown>)) {
      if (typeof at === 'number' && Number.isFinite(at)) {
        result[id] = at
      }
    }
  }
  return result
}

const initial = (): SyncConfig => {
  const fallback: SyncConfig = {
    transport: __SYNC_SERVER__ ? 'server' : 's3',
    enabled: false,
    serverUrl: '',
    s3: { ...DEFAULT_S3 },
    deviceId: createId(),
    deviceName: detectDevice(),
    syncedAt: 0,
    tombstones: {},
  }
  const saved = read()
  if (!saved) {
    return fallback
  }
  try {
    const raw: unknown = JSON.parse(saved)
    if (typeof raw !== 'object' || raw === null) {
      return fallback
    }
    const value = raw as Record<string, unknown>
    return {
      transport: !__SYNC_SERVER__ || value.transport === 's3' ? 's3' : 'server',
      enabled: value.enabled === true,
      serverUrl: text(value.serverUrl),
      s3: normalizeS3(value.s3),
      deviceId: text(value.deviceId) || fallback.deviceId,
      deviceName: text(value.deviceName) || fallback.deviceName,
      syncedAt: typeof value.syncedAt === 'number' ? value.syncedAt : 0,
      tombstones: tombstones(value.tombstones),
    }
  } catch {
    return fallback
  }
}

export const useSync = create<SyncConfig>(initial)

const { getState: get, setState: set } = useSync

export const updateSync = (patch: Partial<SyncConfig>) => {
  set(patch)
  write(get())
}

export const getSyncConfig = (): SyncConfig => get()

/** 已配置同步通道：服务器需要地址与工具服务 Key，S3 需要完整的连接信息 */
export const isSyncLinked = (config = get()): boolean =>
  config.transport === 's3'
    ? isS3Configured(config.s3)
    : Boolean(config.serverUrl.trim() && getToolsConfig().apiKey)

/** 删除会话时登记删除时间，其他设备同步时据此删除 */
export const recordTombstone = (sessionId: string) => {
  updateSync({ tombstones: { ...get().tombstones, [sessionId]: Date.now() } })
}

export type SyncResultSummary = {
  /** 从服务器新增到本地的会话数 */
  added: number
  /** 被服务器版本覆盖的会话数 */
  updated: number
  /** 因其他设备删除而移除的会话数 */
  removed: number
  /** 本次是否上传了新版本 */
  uploaded: boolean
}

export type SyncPhase = 'idle' | 'syncing' | 'error'

type SyncStatusState = {
  phase: SyncPhase
  message: TranslationMessage | string | null
  result: SyncResultSummary | null
}

export const useSyncStatus = create<SyncStatusState>(() => ({
  phase: 'idle',
  message: null,
  result: null,
}))

export const setSyncStatus = (next: Partial<SyncStatusState>) =>
  useSyncStatus.setState((state) => ({ ...state, ...next }))
