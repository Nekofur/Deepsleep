import type { SyncConfig } from './store.js'
import { readFile, readState, writeFile, writeState } from './api.js'
import { resolveSyncToken } from './token.js'
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

/** 服务器通道每次请求先确保 Key 已校验，并使用它的 SHA-256 作为凭据 */
const serverConfig = async (config: SyncConfig) => ({
  serverUrl: config.serverUrl,
  token: await resolveSyncToken(),
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
        readState: async (signal) => readState(await serverConfig(config), signal),
        writeState: async (bytes, etag, signal) =>
          writeState(await serverConfig(config), bytes, etag, signal),
        readFile: async (id, signal) => readFile(await serverConfig(config), id, signal),
        writeFile: async (id, blob, signal) =>
          writeFile(await serverConfig(config), id, blob, signal),
      }
