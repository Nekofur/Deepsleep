import { SyncError } from './errors.js'

/**
 * 自建同步服务器的客户端：前端校验工具服务 Key 后，只发送它的 SHA-256，
 * 服务端按这个哈希隔离用户目录，保存 state.json.gz 与 files/{附件 id}。
 */
export type ServerConfig = { serverUrl: string; token: string }

const normalizeServerUrl = (value: string) => {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) {
    return ''
  }
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
}

const url = (config: ServerConfig, path: string) => `${normalizeServerUrl(config.serverUrl)}${path}`

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })

const failure = async (response: Response): Promise<SyncError> => {
  const text = await response.text().catch(() => '')
  let message = text
  try {
    const body: unknown = JSON.parse(text)
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const error = (body as { error: unknown }).error
      if (typeof error === 'string') {
        message = error
      }
    }
  } catch {
    // 非 JSON 响应体直接展示原文
  }
  if (response.status === 401 || response.status === 403) {
    return new SyncError('unauthorized', message, response.status)
  }
  if (response.status === 409 || response.status === 412) {
    return new SyncError('conflict', message, response.status)
  }
  return new SyncError('server', message || response.statusText, response.status)
}

const send = async (input: string, init: RequestInit): Promise<Response> => {
  try {
    return await fetch(input, init)
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }
    throw new SyncError('network', error instanceof Error ? error.message : String(error))
  }
}

/** 读取状态文件；服务器上还没有时返回 null */
export const readState = async (
  config: ServerConfig,
  signal?: AbortSignal
): Promise<{ bytes: Uint8Array<ArrayBuffer>; etag: string } | null> => {
  const response = await send(url(config, '/api/sync/state'), {
    method: 'GET',
    headers: auth(config.token),
    signal,
  })
  if (response.status === 404) {
    return null
  }
  if (!response.ok) {
    throw await failure(response)
  }
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    etag: response.headers.get('ETag') ?? '',
  }
}

/** 条件写入状态文件：etag 为空时要求服务器上还没有状态 */
export const writeState = async (
  config: ServerConfig,
  bytes: Uint8Array<ArrayBuffer>,
  etag: string | null,
  signal?: AbortSignal
): Promise<{ etag: string }> => {
  const headers: Record<string, string> = {
    ...auth(config.token),
    'Content-Type': 'application/gzip',
  }
  if (etag) {
    headers['If-Match'] = etag
  } else {
    headers['If-None-Match'] = '*'
  }
  const response = await send(url(config, '/api/sync/state'), {
    method: 'PUT',
    headers,
    body: bytes,
    signal,
  })
  if (!response.ok) {
    throw await failure(response)
  }
  return { etag: response.headers.get('ETag') ?? '' }
}

/** 读取附件原件；不存在时返回 null */
export const readFile = async (
  config: ServerConfig,
  id: string,
  signal?: AbortSignal
): Promise<Blob | null> => {
  const response = await send(url(config, `/api/sync/files/${encodeURIComponent(id)}`), {
    method: 'GET',
    headers: auth(config.token),
    signal,
  })
  if (response.status === 404) {
    return null
  }
  if (!response.ok) {
    throw await failure(response)
  }
  return response.blob()
}

/** 上传附件原件；同一 id 重复写入是幂等的 */
export const writeFile = async (
  config: ServerConfig,
  id: string,
  blob: Blob,
  signal?: AbortSignal
): Promise<void> => {
  const response = await send(url(config, `/api/sync/files/${encodeURIComponent(id)}`), {
    method: 'PUT',
    headers: {
      ...auth(config.token),
      'Content-Type': blob.type || 'application/octet-stream',
    },
    body: blob,
    signal,
  })
  if (!response.ok) {
    throw await failure(response)
  }
}

/** 验证地址与密码：GET 状态文件，404 表示服务器可达且密码正确 */
export const verifyServer = async (config: ServerConfig, signal?: AbortSignal): Promise<void> => {
  const response = await send(url(config, '/api/sync/state'), {
    method: 'GET',
    headers: auth(config.token),
    signal,
  })
  if (response.status === 404 || response.ok) {
    return
  }
  throw await failure(response)
}
