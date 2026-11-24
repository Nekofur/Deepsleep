import { ApiError, request, trimBaseUrl } from './client.js'

/**
 * 官方 DeepSeek 工具接口：搜索、抓取与 OCR。
 * 这些接口与对话供应商分开配置（见 providers/store 的 tools），使用 Bearer 鉴权。
 * 语音识别与合成同样走这套地址，见 speech.ts。
 */
export type ToolsEndpoint = { baseUrl: string; apiKey: string }

/** 允许填写到 /v1，最终统一拼成 {base}/v1/tools/* */
export const toolsBase = (baseUrl: string) => trimBaseUrl(baseUrl).replace(/\/v1$/, '')

export const toolsUrl = (endpoint: ToolsEndpoint, path: string) =>
  `${toolsBase(endpoint.baseUrl)}/v1/tools${path}`

const jsonHeaders = (apiKey: string) => ({
  Authorization: `Bearer ${apiKey}`,
  'Content-Type': 'application/json',
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const asText = (value: unknown) => (typeof value === 'string' ? value : '')

export type WebSearchResult = {
  title: string
  url: string
  snippet: string
  summary: string
  content: string
  siteName: string | null
  siteIcon: string | null
  /** RFC 3339；未知为 null */
  date: string | null
  authority: number
  rerankScore: number
}

export type WebSearchParams = {
  query: string
  count?: number
  /** 触发搜索的原始问题，帮助理解搜索意图 */
  oriQuestion?: string
  /** 优先返回本地化结果的 IP 地址 */
  localization?: string
  /** 是否返回网页正文 */
  needContent?: boolean
}

const readResults = (body: unknown): WebSearchResult[] => {
  const results = isRecord(body) ? body.results : undefined
  if (!Array.isArray(results)) {
    return []
  }
  return results.flatMap((item) => {
    if (!isRecord(item) || typeof item.url !== 'string' || !item.url) {
      return []
    }
    return [
      {
        title: asText(item.title),
        url: item.url,
        snippet: asText(item.snippet),
        summary: asText(item.summary),
        content: asText(item.content),
        siteName: typeof item.site_name === 'string' ? item.site_name : null,
        siteIcon: typeof item.site_icon === 'string' ? item.site_icon : null,
        date: typeof item.date === 'string' ? item.date : null,
        authority: typeof item.authority === 'number' ? item.authority : 0,
        rerankScore: typeof item.rerank_score === 'number' ? item.rerank_score : 0,
      },
    ]
  })
}

/** POST /v1/tools/search：按 query 搜索网页，返回结构化结果 */
export const searchWeb = async (
  endpoint: ToolsEndpoint,
  { query, count = 8, oriQuestion, localization, needContent }: WebSearchParams,
  signal?: AbortSignal
): Promise<WebSearchResult[]> => {
  const response = await request(toolsUrl(endpoint, '/search'), {
    method: 'POST',
    headers: jsonHeaders(endpoint.apiKey),
    body: JSON.stringify({
      query,
      count,
      need_content: needContent === true,
      ...(oriQuestion ? { ori_question: oriQuestion } : {}),
      ...(localization ? { localization } : {}),
    }),
    signal,
  })
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new ApiError('protocol', 'invalid search response')
  }
  return readResults(body)
}

/** POST /v1/tools/fetch：抓取单个网页，返回 Markdown 正文 */
export const fetchPage = async (
  endpoint: ToolsEndpoint,
  url: string,
  signal?: AbortSignal
): Promise<{ title: string; content: string }> => {
  const response = await request(toolsUrl(endpoint, '/fetch'), {
    method: 'POST',
    headers: jsonHeaders(endpoint.apiKey),
    body: JSON.stringify({ url }),
    signal,
  })
  const body: unknown = await response.json().catch(() => null)
  if (!isRecord(body)) {
    throw new ApiError('protocol', 'invalid fetch response')
  }
  return { title: asText(body.title), content: asText(body.content) }
}

export type OcrPage = { index: number; text: string; finishReason: 'stop' | 'length' }

export type OcrResult = { pages: OcrPage[]; pageCount: number }

export type OcrPurpose = 'text_recognition' | 'rich_layout_recognition'

/**
 * POST /v1/tools/ocr：逐页识别 PDF / Word / PPT / 图片中的文字。
 * 识别过程可能长达数分钟；服务端先发换行保活，最后返回一个 JSON。
 */
export const recognizeText = async (
  endpoint: ToolsEndpoint,
  file: Blob,
  name: string,
  purpose: OcrPurpose,
  signal?: AbortSignal
): Promise<OcrResult> => {
  const form = new FormData()
  form.append('purpose', purpose)
  form.append('file', file, name)
  const response = await request(toolsUrl(endpoint, '/ocr'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${endpoint.apiKey}` },
    body: form,
    signal,
  })
  const raw = await response.text()
  let body: unknown
  try {
    // 保活换行会出现在 JSON 前，从第一个 { 开始解析
    body = JSON.parse(raw.slice(raw.indexOf('{')))
  } catch {
    throw new ApiError('protocol', raw.slice(0, 200))
  }
  if (!isRecord(body)) {
    throw new ApiError('protocol', 'invalid ocr response')
  }
  if (isRecord(body.error)) {
    throw new ApiError('http', asText(body.error.message) || 'OCR failed')
  }
  const pages = Array.isArray(body.pages) ? body.pages : []
  return {
    pageCount: typeof body.page_count === 'number' ? body.page_count : pages.length,
    pages: pages.flatMap((page) => {
      if (!isRecord(page)) {
        return []
      }
      return [
        {
          index: typeof page.index === 'number' ? page.index : 0,
          text: asText(page.text),
          finishReason: page.finish_reason === 'length' ? 'length' : 'stop',
        },
      ]
    }),
  }
}

/** 验证工具服务的地址与 Key：GET /models 不产生费用 */
export const verifyTools = async (endpoint: ToolsEndpoint, signal?: AbortSignal): Promise<void> => {
  await request(`${toolsBase(endpoint.baseUrl)}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${endpoint.apiKey}` },
    signal,
  })
}
