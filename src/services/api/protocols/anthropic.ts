import {
  ApiError,
  isErrorBody,
  originOf,
  readErrorResponse,
  request,
  trimBaseUrl,
} from '../client.js'
import { readMessageEvent } from '../parseEvent.js'
import { readServerSentEvents } from '../sse.js'
import type {
  AssistantBlockParam,
  FileBlockParam,
  FileObject,
  FilePurpose,
  MessageParam,
  MessageStreamEvent,
  ThinkingLevel,
} from '../types.js'
import type { AttachmentLoader, ProtocolAdapter, StreamOptions } from './types.js'
import { UNAVAILABLE_ATTACHMENT_TEXT } from './types.js'

/** Anthropic Messages 接口的版本头，官方服务必传；DeepSeek 兼容接口不需要 */
const ANTHROPIC_VERSION = '2023-06-01'
/** 引用 Files API 上传的图片、调用 Files API 时必须携带 */
const FILES_BETA = 'files-api-2025-04-14'
/** 官方 Anthropic 必须给 max_tokens，且要大于思考预算 */
const MAX_TOKENS = 8192
/** 思考等级到预算的映射；官方 Messages 只接受 budget_tokens */
const THINKING_BUDGET: Record<ThinkingLevel, number> = {
  minimal: 1024,
  low: 2048,
  medium: 4096,
  high: 8192,
  xhigh: 16384,
  max: 32768,
}

const baseUrl = (base: string) => trimBaseUrl(base)

const messageHeaders = (
  apiKey: string,
  options: { deepseek: boolean; beta: boolean }
): Record<string, string> => ({
  // DeepSeek 兼容接口的鉴权方式，也可使用 Authorization: Bearer。
  'x-api-key': apiKey,
  ...(options.deepseek ? {} : { 'anthropic-version': ANTHROPIC_VERSION }),
  // Files API 和通过 file_id 引用图片时必传；纯文本聊天无需携带。
  ...(options.beta ? { 'anthropic-beta': FILES_BETA } : {}),
})

/** 文件块：file 源原样下发；local 源读取本地原件后内联为 base64，读不到就跳过 */
const fileBlock = async (block: FileBlockParam, load: AttachmentLoader) => {
  if (block.source.type === 'file') {
    // 只回传协议字段，本地原件信息（local）不能出现在请求里
    return { type: block.type, source: block.source }
  }
  const loaded = await load({ id: block.source.id, mediaType: block.source.media_type })
  return loaded
    ? {
        type: block.type,
        source: { type: 'base64', media_type: loaded.mediaType, data: loaded.base64 },
      }
    : null
}

const toUserContent = async (
  content: string | (FileBlockParam | { type: 'text'; text: string })[],
  load: AttachmentLoader
) => {
  if (typeof content === 'string') {
    return content
  }
  const blocks = []
  for (const block of content) {
    if (block.type === 'text') {
      if (block.text) {
        blocks.push(block)
      }
      continue
    }
    const converted = await fileBlock(block, load)
    if (converted) {
      blocks.push(converted)
    }
  }
  return blocks.length > 0 ? blocks : UNAVAILABLE_ATTACHMENT_TEXT
}

/**
 * assistant 内容块：DeepSeek 扩展按原样回传思考与工具块；
 * 其他 Anthropic 兼容服务只接受文本，思考签名与工具块对它们无效。
 */
const toAssistantContent = (
  content: Extract<MessageParam, { role: 'assistant' }>['content'],
  deepseek: boolean
) => {
  const blocks: AssistantBlockParam[] = []
  for (const block of content) {
    if (block.type === 'text') {
      if (block.text) {
        blocks.push(block)
      }
    } else if (deepseek) {
      blocks.push(block)
    }
  }
  return blocks
}

const toMessages = async (messages: MessageParam[], deepseek: boolean, load: AttachmentLoader) => {
  const result: Record<string, unknown>[] = []
  for (const message of messages) {
    if (message.role === 'latest_reminder') {
      // 新版官方接口不接受该角色，只有 DeepSeek 扩展认识。
      if (deepseek) {
        result.push(message)
      }
      continue
    }
    if (message.role === 'user') {
      result.push({ role: 'user', content: await toUserContent(message.content, load) })
      continue
    }
    const content = toAssistantContent(message.content, deepseek)
    if (content.length > 0) {
      result.push({ role: 'assistant', content })
    }
  }
  return result
}

/** 阅读链接始终开启，智能搜索开关控制是否另行声明搜索工具（含边想边搜）。 */
const tools = (search: boolean) => [
  { type: 'deepseek_read_url', name: 'deepseek_read_url' },
  ...(search ? [{ type: 'deepseek_web_search', name: 'deepseek_web_search' }] : []),
]

const requestBody = (
  { request, deepseek }: Pick<StreamOptions, 'request' | 'deepseek'>,
  messages: Record<string, unknown>[]
): Record<string, unknown> => {
  const body: Record<string, unknown> = {
    model: request.model,
    system: request.system,
    messages,
    stream: true,
  }
  if (deepseek) {
    body.thinking = { type: request.thinking ? 'enabled' : 'disabled' }
    body.tools = tools(request.search)
    body.safety_check = { level: 'high' }
    if (request.title) {
      body.title = { enabled: true }
    }
    return body
  }
  const budget = THINKING_BUDGET[request.thinkingLevel]
  body.max_tokens = Math.max(MAX_TOKENS, budget + 4096)
  if (request.thinking) {
    body.thinking = { type: 'enabled', budget_tokens: budget }
  }
  return body
}

/** 解析 Anthropic 兼容的 SSE：事件名与 JSON 的 type 相同，以 message_stop 结束 */
async function* stream(options: StreamOptions): AsyncGenerator<MessageStreamEvent> {
  const { provider, deepseek, request: chat, loadAttachment, signal } = options
  const messages = await toMessages(chat.messages, deepseek, loadAttachment)
  const body = requestBody(options, messages)
  const hasFile = chat.messages.some(
    (message) =>
      message.role !== 'latest_reminder' &&
      typeof message.content !== 'string' &&
      message.content.some((block) => block.type === 'image' || block.type === 'document')
  )
  const response = await request(`${baseUrl(provider.baseUrl)}/messages`, {
    method: 'POST',
    headers: {
      ...messageHeaders(provider.apiKey, { deepseek, beta: hasFile }),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      if (eventName !== 'error') {
        continue
      }
    }
    if (isErrorBody(payload)) {
      throw new ApiError('stream', payload.error.message)
    }
    if (eventName === 'error') {
      throw new ApiError('stream', data)
    }
    const event = readMessageEvent(payload)
    if (!event) {
      continue
    }
    yield event
    if (event.type === 'message_stop') {
      return
    }
  }
  // 服务端没有提供错误内容时保持为空，不推测断流原因。
  throw new ApiError('interrupted', '')
}

/** GET /models 的候选地址：官方 Anthropic 在 /v1/models，DeepSeek 在服务根下 */
const modelEndpoints = (provider: {
  baseUrl: string
  apiKey: string
}): { url: string; headers: Record<string, string> }[] => {
  const base = baseUrl(provider.baseUrl)
  return [
    {
      url: `${base}/models`,
      headers: { 'x-api-key': provider.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
    },
    {
      url: `${originOf(base)}/models`,
      headers: { Authorization: `Bearer ${provider.apiKey}` },
    },
  ]
}

const isMissing = (error: unknown) =>
  error instanceof ApiError && (error.status === 404 || error.status === 405)

const requestModels = async (
  provider: { baseUrl: string; apiKey: string },
  signal: AbortSignal | undefined,
  parse: (body: unknown) => string[]
): Promise<string[]> => {
  let failure: unknown
  for (const endpoint of modelEndpoints(provider)) {
    try {
      const response = await request(endpoint.url, {
        method: 'GET',
        headers: endpoint.headers,
        signal,
      })
      return parse(await response.json())
    } catch (error) {
      if (!isMissing(error)) {
        throw error
      }
      failure = error
    }
  }
  throw failure instanceof ApiError
    ? failure
    : new ApiError('protocol', 'Model list is unavailable')
}

const readModelIds = (body: unknown): string[] => {
  if (typeof body !== 'object' || body === null || !('data' in body)) {
    return []
  }
  const data = (body as { data: unknown }).data
  return Array.isArray(data)
    ? data.flatMap((item) => {
        const id =
          typeof item === 'object' && item !== null && 'id' in item
            ? (item as { id: unknown }).id
            : undefined
        return typeof id === 'string' && id ? [id] : []
      })
    : []
}

/**
 * POST {base}/files 上传附件（不设过期时间，会话里的历史附件一直可用）。
 * purpose 为 null 时不传该字段（图片）；purpose 必须排在 file 之前。
 */
export const uploadFile = async (
  provider: { baseUrl: string; apiKey: string; deepseek: boolean },
  name: string,
  body: Blob,
  purpose: FilePurpose | null,
  signal?: AbortSignal
): Promise<FileObject> => {
  const form = new FormData()
  if (purpose) {
    form.append('purpose', purpose)
  }
  form.append('file', body, name)
  const response = await request(`${baseUrl(provider.baseUrl)}/files`, {
    method: 'POST',
    headers: messageHeaders(provider.apiKey, {
      deepseek: provider.deepseek,
      beta: true,
    }),
    body: form,
    signal,
  })
  return (await response.json()) as FileObject
}

export const anthropicAdapter: ProtocolAdapter = {
  id: 'anthropic',
  stream,
  async verify(provider, signal) {
    await requestModels(provider, signal, () => [])
  },
  listModels(provider, signal) {
    return requestModels(provider, signal, readModelIds)
  },
}
