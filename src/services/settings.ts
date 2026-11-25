import { create } from 'zustand'
import type {
  ReasoningEffort,
  SafetyCheckLevel,
  SamplingParams,
  ThinkingLevel,
} from './api/types.js'
import type { TtsVoice } from './api/speech.js'
import { normalizeLocation, type UserLocation } from './location.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 上传时的解析方式；auto 按扩展名决定（PDF 与 Word、PPT 做版面解析，其余按 user_data） */
export type UploadPurposeMode =
  | 'auto'
  | 'rich_layout_recognition'
  | 'text_recognition'
  | 'user_data'

/** 高级设置：官方接口写死在代码里的私有参数，全局一套，切换供应商时共用 */
type AdvancedSettings = {
  /** 安全审查档位；off 表示不发送，交给服务端默认策略 */
  safetyCheck: SafetyCheckLevel
  /** 上传文件的解析方式；auto 保持按扩展名的原有规则 */
  uploadPurpose: UploadPurposeMode
  /** 思考强度下发方式；auto 时各协议按原有映射处理 */
  reasoningEffort: ReasoningEffort | 'auto'
  /** 采样参数；未填写的项不下发 */
  sampling: SamplingParams
}

/** 本机设置，存 localStorage：语言、主题、位置、朗读音色、思考等级与开关、侧边栏收起状态与高级参数 */
type Settings = {
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  thinking: boolean
  /** 深度思考的强度，默认 medium */
  thinkingLevel: ThinkingLevel
  search: boolean
  siderCollapsed: boolean
  advanced: AdvancedSettings
}

const KEYS = {
  locale: 'deepsleep:locale',
  location: 'deepsleep:location',
  themePreference: 'deepsleep:theme-preference',
  ttsVoice: 'deepsleep:tts-voice',
  thinking: 'deepsleep:thinking',
  thinkingLevel: 'deepsleep:thinking-level',
  search: 'deepsleep:search',
  siderCollapsed: 'deepsleep:sider-collapsed',
  advanced: 'deepsleep:advanced',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

const initialThinkingLevel = (): ThinkingLevel => {
  const saved = read(KEYS.thinkingLevel)
  return saved === 'minimal' ||
    saved === 'low' ||
    saved === 'high' ||
    saved === 'xhigh' ||
    saved === 'max'
    ? saved
    : 'medium'
}

const SAFETY_LEVELS: readonly SafetyCheckLevel[] = ['high', 'low', 'off']
const UPLOAD_PURPOSES: readonly UploadPurposeMode[] = [
  'auto',
  'rich_layout_recognition',
  'text_recognition',
  'user_data',
]
const REASONING_EFFORTS: readonly (ReasoningEffort | 'auto')[] = [
  'auto',
  'minimal',
  'low',
  'medium',
  'high',
  'max',
]

/** 默认值：不发送安全审查、按扩展名决定解析方式、思考强度走原逻辑、不发送采样参数 */
const DEFAULT_ADVANCED: AdvancedSettings = {
  safetyCheck: 'off',
  uploadPurpose: 'auto',
  reasoningEffort: 'auto',
  sampling: {},
}

const finiteNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/** 采样参数逐项校验：不是有限数字的项直接丢弃，避免 NaN 进入请求体 */
const normalizeSampling = (value: unknown): SamplingParams => {
  if (typeof value !== 'object' || value === null) {
    return {}
  }
  const raw = value as Record<string, unknown>
  const stop = Array.isArray(raw.stop)
    ? raw.stop.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : undefined
  const sampling: SamplingParams = {
    temperature: finiteNumber(raw.temperature),
    topP: finiteNumber(raw.topP),
    maxTokens: finiteNumber(raw.maxTokens),
    presencePenalty: finiteNumber(raw.presencePenalty),
    frequencyPenalty: finiteNumber(raw.frequencyPenalty),
    stop: stop && stop.length > 0 ? stop : undefined,
  }
  // undefined 字段不写到 JSON 里，读回来也是干净的
  return Object.fromEntries(
    Object.entries(sampling).filter(([, item]) => item !== undefined)
  ) as SamplingParams
}

/** 读取时逐项校验，坏值回退为默认值，避免一处手改让整个设置不可用 */
const normalizeAdvanced = (value: unknown): AdvancedSettings => {
  if (typeof value !== 'object' || value === null) {
    return { ...DEFAULT_ADVANCED, sampling: {} }
  }
  const raw = value as Record<string, unknown>
  const safetyCheck = SAFETY_LEVELS.find((item) => item === raw.safetyCheck)
  const uploadPurpose = UPLOAD_PURPOSES.find((item) => item === raw.uploadPurpose)
  const reasoningEffort = REASONING_EFFORTS.find((item) => item === raw.reasoningEffort)
  return {
    safetyCheck: safetyCheck ?? DEFAULT_ADVANCED.safetyCheck,
    uploadPurpose: uploadPurpose ?? DEFAULT_ADVANCED.uploadPurpose,
    reasoningEffort: reasoningEffort ?? DEFAULT_ADVANCED.reasoningEffort,
    sampling: normalizeSampling(raw.sampling),
  }
}

const initialAdvanced = (): AdvancedSettings => {
  try {
    return normalizeAdvanced(JSON.parse(read(KEYS.advanced) ?? 'null'))
  } catch {
    return { ...DEFAULT_ADVANCED, sampling: {} }
  }
}

export const useSettings = create<Settings>(() => ({
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  thinking: read(KEYS.thinking) === 'true',
  thinkingLevel: initialThinkingLevel(),
  search: read(KEYS.search) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
  advanced: initialAdvanced(),
}))

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking))
  useSettings.setState({ thinking })
}

export const setThinkingLevel = (thinkingLevel: ThinkingLevel) => {
  write(KEYS.thinkingLevel, thinkingLevel)
  useSettings.setState({ thinkingLevel })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}

/** 高级设置整体保存，改动一项也把整份配置写回，读的时候好做整体校验 */
export const setAdvanced = (patch: Partial<AdvancedSettings>) => {
  const advanced = normalizeAdvanced({ ...useSettings.getState().advanced, ...patch })
  write(KEYS.advanced, JSON.stringify(advanced))
  useSettings.setState({ advanced })
}
