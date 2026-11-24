import type { ToolsEndpoint, OcrPurpose } from '../api/tools.js'
import { fetchPage, recognizeText, searchWeb, type WebSearchResult } from '../api/tools.js'
import type { MessageStreamEvent } from '../api/types.js'
import * as db from './db.js'
import type { FileAttachment, UserMessage } from './types.js'

/**
 * 对话供应商不支持 DeepSeek 服务端工具时，用「工具服务」在客户端补齐：
 * - 智能搜索：调用 Search 接口，把摘要与链接拼进本轮提问，并把结果块展示到回答前；
 * - 阅读链接：抓取提问里的链接正文；
 * - OCR：非图片附件（PDF / Word / PPT）在无法上传时识别成文字。
 * 这些结果只用于本次请求与展示，不会回传给模型历史。
 */

/** 注入上下文的字符上限，避免挤占模型上下文 */
const MAX_CONTEXT_CHARS = 6000
/** 一次最多抓取的链接数 */
const MAX_FETCH_PAGES = 2
const MAX_FETCH_CHARS = 3000
const MAX_OCR_CHARS = 6000
const MAX_SEARCH_RESULTS = 6

export type ClientToolOutcome = {
  /** 追加到本轮提问后的参考资料 */
  context: string
  /** 展示用的搜索 / 阅读块，按接收顺序插入回答开头 */
  events: MessageStreamEvent[]
  searched: boolean
  fetched: number
  ocrCount: number
}

const URL_PATTERN = /https?:\/\/[^\s<>"'）)】]+/gi

export const extractUrls = (text: string): string[] => [
  ...new Set((text.match(URL_PATTERN) ?? []).map((url) => url.replace(/[.,;:!?]+$/, ''))),
]

const searchBlock = (query: string, results: WebSearchResult[] | null): MessageStreamEvent[] => {
  const id = `client-search-${Date.now()}`
  const content = results
    ? results.map((result) => ({
        type: 'web_search_result' as const,
        url: result.url,
        title: result.title || result.url,
        snippet: result.snippet || result.summary,
        site_icon: result.siteIcon,
        site_name: result.siteName,
        page_age: result.date,
        encrypted_content: '',
      }))
    : [{ type: 'web_search_tool_result_error' as const, error_code: 'unavailable' as const }]
  return [
    {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'server_tool_use',
        id,
        name: 'deepseek_web_search',
        input: { action: 'search', query, queries: [query] },
        caller: { type: 'direct' },
        kind: 'search',
      },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'web_search_tool_result',
        tool_use_id: id,
        kind: 'search',
        content,
      },
    },
    { type: 'content_block_stop', index: 1 },
  ]
}

const fetchBlocks = (pages: { url: string; title: string }[]): MessageStreamEvent[] =>
  pages.flatMap((page, index) => {
    const id = `client-fetch-${index}-${Date.now()}`
    const base = index * 3
    return [
      {
        type: 'content_block_start' as const,
        index: base,
        content_block: {
          type: 'server_tool_use' as const,
          id,
          name: 'deepseek_read_url' as const,
          input: { action: 'read_link' as const, url: page.url },
          caller: { type: 'direct' as const },
          kind: 'read_link' as const,
        },
      },
      { type: 'content_block_stop' as const, index: base },
      {
        type: 'content_block_start' as const,
        index: base + 1,
        content_block: {
          type: 'web_fetch_tool_result' as const,
          tool_use_id: id,
          kind: 'read_link' as const,
          content: {
            type: 'web_fetch_result' as const,
            url: page.url,
            content: {
              type: 'document' as const,
              source: { type: 'text' as const, media_type: 'text/plain' as const, data: '' },
              title: page.title,
            },
            published_at: null,
          },
        },
      },
      { type: 'content_block_stop' as const, index: base + 1 },
    ]
  })

const searchContext = (results: WebSearchResult[]) =>
  results
    .map(
      (result, index) =>
        `${index + 1}. ${result.title || result.url}\n${result.url}\n${(result.summary || result.snippet).slice(0, 500)}`
    )
    .join('\n\n')

const ocrText = async (
  endpoint: ToolsEndpoint,
  documents: FileAttachment[],
  signal: AbortSignal
): Promise<string> => {
  const parts: string[] = []
  let remaining = MAX_OCR_CHARS
  for (const file of documents) {
    signal.throwIfAborted()
    if (remaining <= 0) {
      break
    }
    const blob = await db.loadFile(file.id).catch(() => undefined)
    if (!blob) {
      continue
    }
    const purpose: OcrPurpose = 'text_recognition'
    try {
      const result = await recognizeText(endpoint, blob, file.name, purpose, signal)
      const text = result.pages
        .map((page) => page.text)
        .join('\n\n')
        .slice(0, remaining)
      if (text) {
        parts.push(`【${file.name}】\n${text}`)
        remaining -= text.length
      }
    } catch {
      // 单个文档识别失败不影响本轮请求
    }
  }
  return parts.join('\n\n')
}

/** 在发出对话请求前收集工具结果；任何一步失败都不会中断对话 */
export const runClientTools = async ({
  endpoint,
  question,
  search,
  documents,
  signal,
}: {
  endpoint: ToolsEndpoint
  question: UserMessage
  search: boolean
  /** 无法随请求上传的文档，用 OCR 转成文字 */
  documents: FileAttachment[]
  signal: AbortSignal
}): Promise<ClientToolOutcome> => {
  const events: MessageStreamEvent[] = []
  const context: string[] = []
  const questionText = question.content.trim()
  let searched = false

  if (search && questionText) {
    try {
      const results = await searchWeb(
        endpoint,
        {
          query: questionText.slice(0, 128),
          oriQuestion: questionText.slice(0, 128),
          count: MAX_SEARCH_RESULTS,
        },
        signal
      )
      searched = true
      events.push(...searchBlock(questionText.slice(0, 128), results))
      if (results.length > 0) {
        context.push(`以下是网页搜索结果，请结合来源回答：\n\n${searchContext(results)}`)
      }
    } catch {
      signal.throwIfAborted()
      // 搜索失败时仍然回答，并用错误卡片说明
      events.push(...searchBlock(questionText.slice(0, 128), null))
    }
  }

  const urls = questionText ? extractUrls(questionText).slice(0, MAX_FETCH_PAGES) : []
  const fetched: { title: string; content: string; url: string }[] = []
  for (const url of urls) {
    signal.throwIfAborted()
    try {
      const page = await fetchPage(endpoint, url, signal)
      if (page.content) {
        fetched.push({ ...page, url })
      }
    } catch {
      // 单个链接抓取失败时跳过
    }
  }
  if (fetched.length > 0) {
    events.push(...fetchBlocks(fetched.map(({ url, title }) => ({ url, title }))))
    context.push(
      `以下是已抓取的网页正文：\n\n${fetched
        .map(
          (page) =>
            `【${page.title || page.url}】${page.url}\n${page.content.slice(0, MAX_FETCH_CHARS)}`
        )
        .join('\n\n')}`
    )
  }

  let ocrCount = 0
  if (documents.length > 0) {
    const text = await ocrText(endpoint, documents, signal)
    if (text) {
      ocrCount = documents.length
      context.push(`以下是附件经 OCR 识别出的文字：\n\n${text}`)
    }
  }

  return {
    context: context.join('\n\n').slice(0, MAX_CONTEXT_CHARS),
    events,
    searched,
    fetched: fetched.length,
    ocrCount,
  }
}
