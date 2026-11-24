import { ApiError } from '../api/client.js'
import { verifyTools } from '../api/tools.js'
import { getToolsEndpoint } from '../providers/store.js'
import { SyncError } from './errors.js'

/**
 * 同步身份：先用工具服务的 Key 向供应商校验，通过后只把 Key 的 SHA-256
 * 作为凭据发给同步服务器，原始 Key 不离开本机。
 * 校验结果按 Key 缓存在内存里，一次会话只确认一次。
 */
let cached: { key: string; token: string } | null = null

const toHex = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')

export const hashApiKey = async (key: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
  return toHex(new Uint8Array(digest))
}

export const resolveSyncToken = async (): Promise<string> => {
  const endpoint = getToolsEndpoint()
  if (!endpoint) {
    throw new SyncError('notConfigured')
  }
  if (cached && cached.key === endpoint.apiKey) {
    return cached.token
  }
  try {
    await verifyTools(endpoint)
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      throw new SyncError('unauthorized', 'tools key rejected', 401)
    }
    throw new SyncError('network', error instanceof Error ? error.message : String(error))
  }
  const token = await hashApiKey(endpoint.apiKey)
  cached = { key: endpoint.apiKey, token }
  return token
}
