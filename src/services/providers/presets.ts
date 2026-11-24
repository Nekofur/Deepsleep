import { API_ORIGIN } from '../api/client.js'
import type { ProviderPreset } from './types.js'

/**
 * 内置供应商模板。API 地址与模型名可按需修改，用户新增供应商时复制模板字段。
 * DeepSeek 模板沿用构建期的 API 地址（rspack createConfig 的 apiOrigin），
 * 其余为各家的公开地址；本地部署模板默认不带 API Key。
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    url: 'https://platform.deepseek.com/api_keys',
    protocol: 'anthropic',
    baseUrl: `${API_ORIGIN}/anthropic/v1`,
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    // DeepSeek 兼容接口额外提供联网搜索、阅读链接与服务端标题
    features: { search: true, title: true },
    extensions: { deepseek: true },
  },
  {
    id: 'deepseek-openai',
    name: 'DeepSeek (OpenAI)',
    url: 'https://platform.deepseek.com/api_keys',
    protocol: 'openai',
    baseUrl: `${API_ORIGIN}/v1`,
    models: ['deepseek-chat', 'deepseek-reasoner'],
    // 对话接口同样支持 deepseek_web_search / deepseek_read_url、思考与安全校验
    features: { search: true },
    extensions: { deepseek: true },
  },
  {
    id: 'deepseek-responses',
    name: 'DeepSeek (Responses)',
    url: 'https://platform.deepseek.com/api_keys',
    protocol: 'responses',
    baseUrl: API_ORIGIN,
    models: ['deepseek-flash'],
    features: { search: true },
    extensions: { deepseek: true },
  },
  {
    id: 'openai',
    name: 'OpenAI',
    url: 'https://platform.openai.com/api-keys',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o', 'o4-mini'],
  },
  {
    id: 'openai-responses',
    name: 'OpenAI Responses',
    url: 'https://platform.openai.com/api-keys',
    protocol: 'responses',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-5', 'gpt-4.1', 'o4-mini'],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    url: 'https://console.anthropic.com/settings/keys',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    url: 'https://aistudio.google.com/app/apikey',
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    url: 'https://openrouter.ai/settings/keys',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['deepseek/deepseek-chat', 'anthropic/claude-sonnet-4.5', 'openai/gpt-4.1'],
  },
  {
    id: 'moonshot',
    name: 'Moonshot (Kimi)',
    url: 'https://platform.moonshot.cn/console/api-keys',
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2-0905-preview', 'moonshot-v1-32k'],
  },
  {
    id: 'zhipu',
    name: 'Zhipu GLM',
    url: 'https://bigmodel.cn/usercenter/apikeys',
    protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.6', 'glm-4-flash'],
  },
  {
    id: 'qwen',
    name: 'Alibaba Qwen',
    url: 'https://bailian.console.aliyun.com/',
    protocol: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3-max', 'qwen-plus'],
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    url: 'https://cloud.siliconflow.cn/account/ak',
    protocol: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen3-8B'],
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    url: 'https://ollama.com/',
    protocol: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    models: ['llama3.2', 'qwen3:8b'],
    keyOptional: true,
  },
  {
    id: 'lmstudio',
    name: 'LM Studio (local)',
    url: 'https://lmstudio.ai/',
    protocol: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    models: [],
    keyOptional: true,
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
