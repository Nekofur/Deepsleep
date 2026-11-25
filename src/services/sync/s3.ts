import { SyncError } from './errors.js'

/**
 * 直连 S3 兼容对象存储（AWS S3、Cloudflare R2、MinIO、阿里云 OSS 的 S3 网关等）。
 * 用户在设置里填写 endpoint / region / bucket / AccessKey，签名在浏览器内用 WebCrypto 完成，
 * 因此不需要自建同步服务器。
 *
 * 对象布局（prefix 默认 chat-demo/）：
 * - {prefix}manifest.json.gz：会话列表、删除记录与图片清单，其 ETag 用作版本条件；
 * - {prefix}sessions/<会话 id>.json.gz：每个会话的正文，按需上传与下载；
 * - {prefix}files/<附件 id>：图片原件，按需上传。
 *
 * 需要给存储桶配置 CORS（见 README）：允许 GET / PUT / HEAD，允许 Authorization、
 * x-amz-* 与 If-Match / If-None-Match 请求头，并暴露 ETag 响应头。
 */
export type S3Config = {
  /** 服务地址，例如 https://s3.us-east-1.amazonaws.com 或 https://<id>.r2.cloudflarestorage.com */
  endpoint: string
  /** 区域，例如 us-east-1；R2 填 auto */
  region: string
  bucket: string
  /** 对象前缀，默认 chat-demo/ */
  prefix: string
  accessKeyId: string
  secretAccessKey: string
  /** MinIO、R2 等自建端点用路径风格；AWS 建议虚拟主机风格 */
  pathStyle: boolean
}

export const isS3Configured = (config: S3Config): boolean =>
  Boolean(
    config.endpoint.trim() &&
    config.region.trim() &&
    config.bucket.trim() &&
    config.accessKeyId.trim() &&
    config.secretAccessKey.trim()
  )

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const ALGORITHM = 'AWS4-HMAC-SHA256'
const SERVICE = 's3'

const encoder = new TextEncoder()

const toHex = (bytes: Uint8Array<ArrayBuffer>) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')

const sha256Hex = async (data: BufferSource): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', data)
  return toHex(new Uint8Array(digest))
}

const hmac = async (key: BufferSource, data: string): Promise<Uint8Array<ArrayBuffer>> => {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data)))
}

/** RFC 3986 编码：SigV4 要求对 ! ' ( ) * 也编码 */
const rfc3986 = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  )

const encodeKey = (key: string) =>
  key
    .split('/')
    .filter((segment) => segment.length > 0)
    .map(rfc3986)
    .join('/')

/** 规范化前缀：去掉首尾多余的斜杠，非空时补一个结尾斜杠 */
const prefixOf = (config: S3Config) =>
  config.prefix.trim().replace(/^\/+|\/+$/g, '') + (config.prefix.trim() ? '/' : '')

export const stateKeyOf = (config: S3Config) => `${prefixOf(config)}state.json.gz`

export const manifestKeyOf = (config: S3Config) => `${prefixOf(config)}manifest.json.gz`

export const sessionKeyOf = (config: S3Config, id: string) =>
  `${prefixOf(config)}sessions/${id}.json.gz`

export const fileKeyOf = (config: S3Config, id: string) => `${prefixOf(config)}files/${id}`

type SignedRequest = {
  url: string
  headers: Record<string, string>
}

/**
 * 构造 SigV4 签名请求。只签 host 与 x-amz-* 头；
 * If-Match / If-None-Match 不作为签名头，但仍会发送，用于条件写入。
 */
const sign = async (
  config: S3Config,
  method: 'GET' | 'PUT',
  key: string,
  payloadHash: string,
  extraHeaders: Record<string, string>
): Promise<SignedRequest> => {
  const endpoint = new URL(config.endpoint)
  const basePath = endpoint.pathname.replace(/\/+$/, '')
  const bucket = config.bucket.trim()
  const encodedKey = encodeKey(key)
  const host = config.pathStyle ? endpoint.host : `${bucket}.${endpoint.host}`
  const path = config.pathStyle
    ? `${basePath}/${rfc3986(bucket)}/${encodedKey}`
    : `${basePath}/${encodedKey}`
  const url = `${endpoint.protocol}//${host}${path}`

  const now = new Date()
  const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const date = stamp.slice(0, 8)
  const xAmzHeaders: Record<string, string> = {
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': stamp,
  }
  const canonicalHeaders = Object.entries({ host, ...xAmzHeaders })
    .map(([name, value]) => `${name}:${value.trim()}\n`)
    .sort()
    .join('')
  const signedHeaders = Object.keys({ host, ...xAmzHeaders })
    .map((name) => name.toLowerCase())
    .sort()
    .join(';')
  const canonicalRequest = [method, path, '', canonicalHeaders, signedHeaders, payloadHash].join(
    '\n'
  )
  const scope = `${date}/${config.region}/s3/aws4_request`
  const stringToSign = [
    ALGORITHM,
    stamp,
    scope,
    await sha256Hex(encoder.encode(canonicalRequest)),
  ].join('\n')

  const kDate = await hmac(encoder.encode(`AWS4${config.secretAccessKey}`), date)
  const kRegion = await hmac(kDate, config.region)
  const kService = await hmac(kRegion, SERVICE)
  const kSigning = await hmac(kService, 'aws4_request')
  const signature = toHex(await hmac(kSigning, stringToSign))

  return {
    url,
    headers: {
      ...extraHeaders,
      ...xAmzHeaders,
      Authorization: `${ALGORITHM} Credential=${config.accessKeyId.trim()}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  }
}

const failure = async (response: Response, action: string): Promise<SyncError> => {
  const text = await response.text().catch(() => '')
  if (response.status === 401 || response.status === 403) {
    return new SyncError('unauthorized', text || `${action} denied`, response.status)
  }
  if (response.status === 409 || response.status === 412) {
    return new SyncError('conflict', text, response.status)
  }
  return new SyncError(
    'server',
    text || `${action} failed with ${response.status}`,
    response.status
  )
}

const send = async (url: string, init: RequestInit): Promise<Response> => {
  try {
    return await fetch(url, { mode: 'cors', ...init })
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }
    throw new SyncError('network', error instanceof Error ? error.message : String(error))
  }
}

const getObject = async (
  config: S3Config,
  key: string,
  signal?: AbortSignal
): Promise<{ bytes: Uint8Array<ArrayBuffer>; etag: string } | null> => {
  const { url, headers } = await sign(config, 'GET', key, EMPTY_SHA256, {})
  const response = await send(url, { method: 'GET', headers, signal })
  if (response.status === 404) {
    return null
  }
  if (!response.ok) {
    throw await failure(response, 'GET')
  }
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    etag: response.headers.get('ETag') ?? '',
  }
}

const putObject = async (
  config: S3Config,
  key: string,
  body: Uint8Array<ArrayBuffer>,
  contentType: string,
  conditional: Record<string, string>,
  signal?: AbortSignal
): Promise<{ etag: string }> => {
  const payloadHash = await sha256Hex(body)
  const { url, headers } = await sign(config, 'PUT', key, payloadHash, {
    ...conditional,
    'Content-Type': contentType,
  })
  const response = await send(url, { method: 'PUT', headers, body, signal })
  if (!response.ok) {
    throw await failure(response, 'PUT')
  }
  return { etag: response.headers.get('ETag') ?? '' }
}

export const readS3State = async (
  config: S3Config,
  signal?: AbortSignal
): Promise<{ bytes: Uint8Array<ArrayBuffer>; etag: string } | null> =>
  getObject(config, stateKeyOf(config), signal)

/**
 * 条件写入状态文件。v3 起客户端只写 manifest，保留这个接口只是为了兼容旧构建
 * 与已经写入过的 state.json.gz。
 */
export const writeS3State = async (
  config: S3Config,
  bytes: Uint8Array<ArrayBuffer>,
  etag: string | null,
  signal?: AbortSignal
): Promise<{ etag: string }> =>
  putObject(
    config,
    stateKeyOf(config),
    bytes,
    'application/gzip',
    etag ? { 'If-Match': etag } : { 'If-None-Match': '*' },
    signal
  )

/** 读取会话清单；远端还没有同步数据时返回 null */
export const readS3Manifest = async (
  config: S3Config,
  signal?: AbortSignal
): Promise<{ bytes: Uint8Array<ArrayBuffer>; etag: string } | null> =>
  getObject(config, manifestKeyOf(config), signal)

/** 条件写入会话清单：带 ETag 时用 If-Match，首次写入用 If-None-Match: * */
export const writeS3Manifest = async (
  config: S3Config,
  bytes: Uint8Array<ArrayBuffer>,
  etag: string | null,
  signal?: AbortSignal
): Promise<{ etag: string }> =>
  putObject(
    config,
    manifestKeyOf(config),
    bytes,
    'application/gzip',
    etag ? { 'If-Match': etag } : { 'If-None-Match': '*' },
    signal
  )

/** 读取单个会话正文；不存在时返回 null */
export const readS3Session = async (
  config: S3Config,
  id: string,
  signal?: AbortSignal
): Promise<Uint8Array<ArrayBuffer> | null> => {
  const object = await getObject(config, sessionKeyOf(config, id), signal)
  return object?.bytes ?? null
}

/** 上传单个会话正文；同一 id 重复写入是幂等的，顺序由 updatedAt 合并保证 */
export const writeS3Session = async (
  config: S3Config,
  id: string,
  bytes: Uint8Array<ArrayBuffer>,
  signal?: AbortSignal
): Promise<void> => {
  await putObject(config, sessionKeyOf(config, id), bytes, 'application/gzip', {}, signal)
}

/** 读取附件原件；不存在时返回 null */
export const readS3File = async (
  config: S3Config,
  id: string,
  signal?: AbortSignal
): Promise<Blob | null> => {
  const object = await getObject(config, fileKeyOf(config, id), signal)
  return object ? new Blob([object.bytes]) : null
}

/** 上传附件原件；同一 id 重复写入是幂等的 */
export const writeS3File = async (
  config: S3Config,
  id: string,
  blob: Blob,
  signal?: AbortSignal
): Promise<void> => {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  await putObject(
    config,
    fileKeyOf(config, id),
    bytes,
    blob.type || 'application/octet-stream',
    {},
    signal
  )
}

/** 验证配置：读取会话清单可区分鉴权失败（403）与尚未同步（404，视为通过） */
export const verifyS3 = async (config: S3Config, signal?: AbortSignal): Promise<void> => {
  await getObject(config, manifestKeyOf(config), signal)
}
