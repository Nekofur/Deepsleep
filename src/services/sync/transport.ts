import { getToolsConfig } from '../providers/store.js'
import type { SyncConfig } from './store.js'
import { readFile, readState, writeFile, writeState } from './api.js'
import { readS3File, readS3State, writeS3File, writeS3State } from './s3.js'

export type RemoteState = { bytes: Uint8Array<ArrayBuffer>; etag: string }

/** 同步通道：状态文件 + 附件原件，服务器与 S3 的接口形状完全一致 */
export type SyncTransport = {
  readState(signal?: AbortSignal): Promise<RemoteState | null>
  writeState(
    bytes: Uint8Array<ArrayBuffer>,
    etag: string | null,
    signal?: AbortSignal
  ): Promise<{ etag: string }>
  readFile(id: string, signal?: AbortSignal): Promise<Blob | null>
  writeFile(id: string, blob: Blob, signal?: AbortSignal): Promise<void>
}

/** 服务器通道每次请求都取当前工具服务 Key，换 Key 即切换同步用户 */
const serverConfig = (config: SyncConfig) => ({
  serverUrl: config.serverUrl,
  apiKey: getToolsConfig().apiKey,
})

export const createTransport = (config: SyncConfig): SyncTransport =>
  config.transport === 's3'
    ? {
        readState: (signal) => readS3State(config.s3, signal),
        writeState: (bytes, etag, signal) => writeS3State(config.s3, bytes, etag, signal),
        readFile: (id, signal) => readS3File(config.s3, id, signal),
        writeFile: (id, blob, signal) => writeS3File(config.s3, id, blob, signal),
      }
    : {
        readState: (signal) => readState(serverConfig(config), signal),
        writeState: (bytes, etag, signal) => writeState(serverConfig(config), bytes, etag, signal),
        readFile: (id, signal) => readFile(serverConfig(config), id, signal),
        writeFile: (id, blob, signal) => writeFile(serverConfig(config), id, blob, signal),
      }
