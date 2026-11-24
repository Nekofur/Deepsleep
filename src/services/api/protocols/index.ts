import type { ProtocolId } from '../../providers/types.js'
import { anthropicAdapter } from './anthropic.js'
import { geminiAdapter } from './gemini.js'
import { openaiAdapter } from './openai.js'
import { responsesAdapter } from './responses.js'
import type { ProtocolAdapter } from './types.js'

const ADAPTERS: Record<ProtocolId, ProtocolAdapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  responses: responsesAdapter,
  gemini: geminiAdapter,
}

/** 按协议取适配器；协议是枚举，查表不会有缺省 */
export const getAdapter = (protocol: ProtocolId): ProtocolAdapter => ADAPTERS[protocol]
