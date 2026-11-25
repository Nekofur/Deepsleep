import { API_ORIGIN } from '../api/client.js'
import type { ProviderPreset } from './types.js'

/**
 * 内置供应商模板：只保留 DeepSeek 官方接口和自定义。
 * DeepSeek 走 OpenAI 兼容协议，API 地址为 https://api.deepseek.com
 * （构建期可用 API_ORIGIN 覆盖），同时支持思考、服务端搜索与标题。
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    url: 'https://platform.deepseek.com/api_keys',
    protocol: 'openai',
    baseUrl: API_ORIGIN,
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    features: { search: true, title: true },
    extensions: { deepseek: true },
  },
  {
    id: 'custom',
    name: 'Custom',
    url: '',
    protocol: 'openai',
    baseUrl: '',
    models: [],
    keyOptional: true,
  },
]

/** 找不到模板时（如以后删除模板）使用的空配置 */
export const CUSTOM_PRESET = PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1]

export const findPreset = (presetId: string): ProviderPreset =>
  PROVIDER_PRESETS.find((preset) => preset.id === presetId) ?? CUSTOM_PRESET
