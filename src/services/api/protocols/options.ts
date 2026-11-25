import type { SafetyCheckLevel, SamplingParams } from '../types.js'

/**
 * 高级设置到请求体的公共翻译：安全审查与采样参数。
 * 只把用户显式填写的项写进请求体，未填写的不下发，服务端用自己的默认值。
 */

/** DeepSeek 私有安全审查；off 表示整个字段不发送，交给服务端默认策略 */
export const applySafetyCheck = (body: Record<string, unknown>, level: SafetyCheckLevel) => {
  if (level !== 'off') {
    body.safety_check = { level }
  }
}

/** 停止词；空数组与未填写等价，不下发 */
const stopWords = (sampling: SamplingParams): string[] | undefined =>
  sampling.stop && sampling.stop.length > 0 ? sampling.stop : undefined

/** OpenAI Chat Completions：temperature / top_p / max_tokens / 两个惩罚项 / stop */
export const applyChatSampling = (body: Record<string, unknown>, sampling: SamplingParams) => {
  if (sampling.temperature !== undefined) {
    body.temperature = sampling.temperature
  }
  if (sampling.topP !== undefined) {
    body.top_p = sampling.topP
  }
  if (sampling.maxTokens !== undefined) {
    body.max_tokens = sampling.maxTokens
  }
  if (sampling.presencePenalty !== undefined) {
    body.presence_penalty = sampling.presencePenalty
  }
  if (sampling.frequencyPenalty !== undefined) {
    body.frequency_penalty = sampling.frequencyPenalty
  }
  const stop = stopWords(sampling)
  if (stop) {
    body.stop = stop
  }
}

/** OpenAI Responses：上限字段叫 max_output_tokens，且同样没有惩罚项 */
export const applyResponsesSampling = (body: Record<string, unknown>, sampling: SamplingParams) => {
  if (sampling.temperature !== undefined) {
    body.temperature = sampling.temperature
  }
  if (sampling.topP !== undefined) {
    body.top_p = sampling.topP
  }
  if (sampling.maxTokens !== undefined) {
    body.max_output_tokens = sampling.maxTokens
  }
}

/** Anthropic Messages：上限是 max_tokens（由调用方结合思考预算处理），停止词叫 stop_sequences */
export const applyAnthropicSampling = (body: Record<string, unknown>, sampling: SamplingParams) => {
  if (sampling.temperature !== undefined) {
    body.temperature = sampling.temperature
  }
  if (sampling.topP !== undefined) {
    body.top_p = sampling.topP
  }
  const stop = stopWords(sampling)
  if (stop) {
    body.stop_sequences = stop
  }
}
