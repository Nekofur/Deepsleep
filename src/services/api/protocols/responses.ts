import { ApiError, isErrorBody, readErrorResponse, request, trimBaseUrl } from '../client.js'
import { readServerSentEvents } from '../sse.js'
import type {
  FileBlockParam,
  MessageParam,
  MessageStreamEvent,
  MessageUsage,
  StopReason,
} from '../types.js'
import { BlockStream, usageOf } from './blocks.js'
import { dataUrl, localRef } from './inline.js'
import { asNumber, asString, at, isRecord } from './json.js'
import { applyResponsesSampling, applySafetyCheck } from './options.js'
import type { AttachmentLoader, ProtocolAdapter, StreamOptions } from './types.js'
import { UNAVAILABLE_ATTACHMENT_TEXT } from './types.js'

const baseUrl = (base: string) => trimBaseUrl(base)

const authorization = (apiKey: string) => ({
  Authorization: `Bearer ${apiKey}`,
  'Content-Type': 'application/json',
})

const textOf = (content: Extract<MessageParam, { role: 'assistant' }>['content']) =>
  content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('')
    .trim()

const inputParts = async (
  blocks: (FileBlockParam | { type: 'text'; text: string })[],
  load: AttachmentLoader
) => {
  const parts: Record<string, unknown>[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text) {
        parts.push({ type: 'input_text', text: block.text })
      }
      continue
    }
    const ref = localRef(block)
    const loaded = ref ? await load(ref) : null
    if (loaded && loaded.mediaType.startsWith('image/')) {
      parts.push({ type: 'input_image', image_url: dataUrl(loaded.mediaType, loaded.base64) })
    }
  }
  return parts
}

const toInput = async (messages: MessageParam[], load: AttachmentLoader) => {
  const input: Record<string, unknown>[] = []
  for (const message of messages) {
    if (message.role === 'latest_reminder') {
      input.push({ role: 'system', content: message.content })
      continue
    }
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        input.push({ role: 'user', content: message.content })
        continue
      }
      const parts = await inputParts(message.content, load)
      input.push({
        role: 'user',
        content:
          parts.length > 0 ? parts : [{ type: 'input_text', text: UNAVAILABLE_ATTACHMENT_TEXT }],
      })
      continue
    }
    const text = textOf(message.content)
    if (text) {
      input.push({ role: 'assistant', content: text })
    }
  }
  return input
}

const readUsage = (value: unknown): MessageUsage | undefined => {
  if (!isRecord(value)) {
    return undefined
  }
  const input = asNumber(value.input_tokens)
  const output = asNumber(value.output_tokens)
  if (input === undefined && output === undefined) {
    return undefined
  }
  return usageOf(
    input ?? 0,
    output ?? 0,
    asNumber(at(value, ['input_tokens_details', 'cached_tokens'])) ?? 0
  )
}

/** 流式事件名即响应类型；只消费文本、思考与结束事件，其余（工具、附件扫描等）忽略 */
async function* stream(options: StreamOptions): AsyncGenerator<MessageStreamEvent> {
  const { provider, deepseek, request: chat, loadAttachment, signal } = options
  const input = await toInput(chat.messages, loadAttachment)
  const body: Record<string, unknown> = {
    model: chat.model,
    instructions: chat.system,
    input,
    stream: true,
  }
  if (deepseek) {
    // DeepSeek 的 Responses 接口同样在服务端完成搜索、阅读链接与安全校验
    // Responses 里 low 仍然是思考，只有 none 才是关闭；关闭时不考虑用户指定的强度
    body.reasoning = { effort: chat.thinking ? (chat.reasoningEffort ?? 'high') : 'none' }
    body.tools = [
      { type: 'deepseek_read_url' },
      ...(chat.search ? [{ type: 'deepseek_web_search' }] : []),
    ]
    applySafetyCheck(body, chat.safetyCheck)
    if (chat.title) {
      body.title = { enabled: true }
    }
  } else if (chat.reasoningEffort) {
    // 高级设置里指定了原值：直接下发，不再限定 o 系列与 GPT-5
    body.reasoning = { effort: chat.reasoningEffort }
  } else if (
    (provider.presetId === 'openai' || provider.presetId === 'openai-responses') &&
    /^(o\d|gpt-5)/i.test(chat.model)
  ) {
    body.reasoning = { effort: chat.thinking ? chat.thinkingLevel : 'minimal' }
  }
  applyResponsesSampling(body, chat.sampling)
  const response = await request(`${baseUrl(provider.baseUrl)}/responses`, {
    method: 'POST',
    headers: { ...authorization(provider.apiKey), Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }

  const blocks = new BlockStream()
  for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      continue
    }
    if (isErrorBody(payload)) {
      throw new ApiError('stream', payload.error.message)
    }
    if (eventName === 'error') {
      throw new ApiError('stream', asString(at(payload, ['error', 'message'])) ?? data)
    }
    if (!isRecord(payload)) {
      continue
    }
    switch (asString(payload.type) ?? eventName) {
      case 'response.output_text.delta':
        yield* blocks.text(asString(payload.delta))
        break
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        yield* blocks.thinking(asString(payload.delta))
        break
      case 'response.completed':
      case 'response.incomplete': {
        const result = isRecord(payload.response) ? payload.response : undefined
        const usage = readUsage(result?.usage)
        let stopReason: StopReason = 'end_turn'
        if (asString(result?.status) === 'incomplete') {
          const reason = asString(at(result, ['incomplete_details', 'reason'])) ?? ''
          stopReason = reason.includes('max_output') ? 'max_tokens' : 'end_turn'
        }
        yield* blocks.finish(stopReason, usage)
        return
      }
      case 'response.failed': {
        const message = asString(at(payload, ['response', 'error', 'message'])) ?? ''
        throw new ApiError('stream', message)
      }
      default:
        break
    }
  }
  throw new ApiError('interrupted', '')
}

const modelIds = (body: unknown): string[] => {
  const data = isRecord(body) ? body.data : undefined
  return Array.isArray(data)
    ? data.flatMap((item) => {
        const id = isRecord(item) ? asString(item.id) : undefined
        return id ? [id] : []
      })
    : []
}

const listModels = async (provider: { baseUrl: string; apiKey: string }, signal?: AbortSignal) => {
  const response = await request(`${baseUrl(provider.baseUrl)}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${provider.apiKey}` },
    signal,
  })
  return modelIds(await response.json())
}

export const responsesAdapter: ProtocolAdapter = {
  id: 'responses',
  stream,
  async verify(provider, signal) {
    await listModels(provider, signal)
  },
  listModels,
}
