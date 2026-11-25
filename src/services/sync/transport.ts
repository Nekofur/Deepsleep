import type { SyncConfig } from './store.js'
import {
  readFile,
  readManifest,
  readSession,
  writeFile,
  writeManifest,
  writeSession,
} from './api.js'
import { resolveSyncToken } from './token.js'
import {
  readS3File,
  readS3Manifest,
  readS3Session,
  writeS3File,
  writeS3Manifest,
  writeS3Session,
} from './s3.js'

/** 需要版本条件的远端对象；ETag 用于 manifest 的条件写入 */
export type RemoteObject = { bytes: Uint8Array<ArrayBuffer>; etag: string }

/**
 * 同步通道：会话清单 + 会话正文 + 图片原件，服务器与 S3 的接口形状完全一致。
 * 只有清单带版本条件；会话正文按 id 覆盖写，先后顺序由清单里的 updatedAt 合并保证。
 */
export type SyncTransport = {
  readManifest(signal?: AbortSignal): Promise<RemoteObject | null>
  writeManifest(
    bytes: Uint8Array<ArrayBuffer>,
    etag: string | null,
    signal?: AbortSignal
  ): Promise<{ etag: string }>
  readSession(id: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer> | null>
  writeSession(id: string, bytes: Uint8Array<ArrayBuffer>, signal?: AbortSignal): Promise<void>
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
        readManifest: (signal) => readS3Manifest(config.s3, signal),
        writeManifest: (bytes, etag, signal) => writeS3Manifest(config.s3, bytes, etag, signal),
        readSession: (id, signal) => readS3Session(config.s3, id, signal),
        writeSession: (id, bytes, signal) => writeS3Session(config.s3, id, bytes, signal),
        readFile: (id, signal) => readS3File(config.s3, id, signal),
        writeFile: (id, blob, signal) => writeS3File(config.s3, id, blob, signal),
      }
    : {
        readManifest: async (signal) => readManifest(await serverConfig(config), signal),
        writeManifest: async (bytes, etag, signal) =>
          writeManifest(await serverConfig(config), bytes, etag, signal),
        readSession: async (id, signal) => readSession(await serverConfig(config), id, signal),
        writeSession: async (id, bytes, signal) =>
          writeSession(await serverConfig(config), id, bytes, signal),
        readFile: async (id, signal) => readFile(await serverConfig(config), id, signal),
        writeFile: async (id, blob, signal) =>
          writeFile(await serverConfig(config), id, blob, signal),
      }
