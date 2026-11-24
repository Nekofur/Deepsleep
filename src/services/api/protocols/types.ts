import type { ProtocolId, ProtocolFeatures, ProviderConfig } from '../../providers/types.js'
import type { ChatRequest, MessageStreamEvent } from '../types.js'

/** 本地附件的 base64 内容；没有原件或读取失败时为 null */
export type LoadedAttachment = {
  mediaType: string
  base64: string
  /** 原文字节数，用于判断能否内联 */
  bytes: number
}

export type AttachmentLoader = (file: {
  id: string
  mediaType: string
}) => Promise<LoadedAttachment | null>

export type StreamOptions = {
  provider: ProviderConfig
  features: ProtocolFeatures
  /** DeepSeek 扩展：工具、safety_check、服务端标题与 latest_reminder 角色 */
  deepseek: boolean
  request: ChatRequest
  loadAttachment: AttachmentLoader
  signal: AbortSignal
}

/** 各协议的适配器：把规范请求翻译成服务端格式，并把响应流转换回 MessageStreamEvent */
export type ProtocolAdapter = {
  id: ProtocolId
  stream(options: StreamOptions): AsyncGenerator<MessageStreamEvent>
  /** 用不产生费用的接口校验地址与 API Key，失败抛 ApiError */
  verify(provider: ProviderConfig, signal?: AbortSignal): Promise<void>
  /** 拉取可选模型；服务端不支持时抛 ApiError，由调用方提示手动填写 */
  listModels(provider: ProviderConfig, signal?: AbortSignal): Promise<string[]>
}

/** 内联附件的上限：超过后多半会被服务端拒绝，直接跳过 */
export const MAX_INLINE_BYTES = 8 * 1024 * 1024

/** 附件无法读取时占位，避免整条消息因缺少内容块而变成空请求 */
export const UNAVAILABLE_ATTACHMENT_TEXT = '[attachment unavailable]'
