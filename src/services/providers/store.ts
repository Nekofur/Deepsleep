import { create } from 'zustand'
import { createId } from '../../utils/id.js'
import { findPreset } from './presets.js'
import {
  isProtocolId,
  PROTOCOL_FEATURES,
  type ProtocolFeatures,
  type ProviderConfig,
  type ProviderExtensions,
  type ToolsConfig,
} from './types.js'

/** 供应商、当前选择与工具服务，存 localStorage；Key 与旧版本一样只保存在本机 */
const STORAGE_KEY = 'deepsleep:providers'
/** 旧版本只保存一个 API Key，升级时迁移为 DeepSeek 供应商 */
const LEGACY_API_KEY = 'deepsleep:api-key'

type ProvidersState = {
  providers: ProviderConfig[]
  activeId: string | null
  /** 搜索、抓取、OCR、ASR、TTS 共用的工具服务；目前只有官方 DeepSeek 提供 */
  tools: ToolsConfig
}

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(STORAGE_KEY)
    } else {
      localStorage.setItem(STORAGE_KEY, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

const text = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback)

/** 只有官方地址才认识 DeepSeek 私有字段；中转站会以「参数非法」直接拒绝 */
export const isOfficialDeepSeekUrl = (baseUrl: string): boolean => {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'api.deepseek.com'
  } catch {
    return false
  }
}

/**
 * 私有能力默认值：DeepSeek 模板 + 官方地址才打开。
 * 以前只看模板 id，把地址改成中转站后仍会下发 thinking / deepseek_read_url 等字段，
 * 网关不认识就报「The request was malformed or contained invalid parameters」。
 */
const defaultDeepseekExtensions = (presetId: string, baseUrl: string) =>
  presetId.startsWith('deepseek') && isOfficialDeepSeekUrl(baseUrl)

/** 读取时严格校验，坏字段回退为默认值，避免一处手改让整个设置不可用 */
const normalizeProvider = (value: unknown): ProviderConfig | null => {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || !raw.id || !isProtocolId(raw.protocol)) {
    return null
  }
  const preset = findPreset(text(raw.presetId, 'custom'))
  const models = Array.isArray(raw.models)
    ? [...new Set(raw.models.filter((item): item is string => typeof item === 'string' && !!item))]
    : []
  const model = text(raw.model) || models[0] || ''
  const baseUrl = text(raw.baseUrl).trim() || preset.baseUrl
  return {
    id: raw.id,
    presetId: preset.id,
    name: text(raw.name).trim() || preset.name,
    protocol: raw.protocol,
    baseUrl,
    apiKey: text(raw.apiKey),
    models,
    model,
    // 旧存档没有这个字段，按地址补算
    deepseekExtensions:
      typeof raw.deepseekExtensions === 'boolean'
        ? raw.deepseekExtensions
        : defaultDeepseekExtensions(preset.id, baseUrl),
  }
}

const normalizeTools = (value: unknown): ToolsConfig => {
  const raw = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  return {
    // 官方地址作为默认值，用户也可以指向自建代理
    baseUrl: text(raw.baseUrl).trim() || __API_ORIGIN__,
    apiKey: text(raw.apiKey),
  }
}

/** 把带 key 的旧版本设置迁移为 DeepSeek 供应商；旧键只读一次，迁移后删除 */
const migrateLegacy = (providers: ProviderConfig[]): ProviderConfig[] => {
  const apiKey = read(LEGACY_API_KEY)
  if (!apiKey) {
    return providers
  }
  try {
    localStorage.removeItem(LEGACY_API_KEY)
  } catch {
    // 存储不可用时不处理
  }
  if (providers.some((provider) => provider.presetId === 'deepseek')) {
    return providers
  }
  const preset = findPreset('deepseek')
  return [
    {
      id: createId(),
      presetId: preset.id,
      name: preset.name,
      protocol: preset.protocol,
      baseUrl: preset.baseUrl,
      apiKey,
      models: [...preset.models],
      model: preset.models[0] ?? '',
      deepseekExtensions: defaultDeepseekExtensions(preset.id, preset.baseUrl),
    },
    ...providers,
  ]
}

const initial = (): ProvidersState => {
  let providers: ProviderConfig[] = []
  let savedActiveId: string | null = null
  let tools: ToolsConfig = normalizeTools(null)
  const saved = read(STORAGE_KEY)
  if (saved) {
    try {
      const parsed: unknown = JSON.parse(saved)
      if (typeof parsed === 'object' && parsed !== null) {
        const raw = parsed as Record<string, unknown>
        providers = Array.isArray(raw.providers)
          ? raw.providers.flatMap((item) => normalizeProvider(item) ?? [])
          : []
        savedActiveId = typeof raw.activeId === 'string' ? raw.activeId : null
        tools = normalizeTools(raw.tools)
      }
    } catch {
      // 内容损坏时按首次使用处理
    }
  }
  const migrated = migrateLegacy(providers)
  const activeId =
    savedActiveId && migrated.some((item) => item.id === savedActiveId)
      ? savedActiveId
      : (migrated[0]?.id ?? null)
  return { providers: migrated, activeId, tools }
}

export const useProviders = create<ProvidersState>(initial)

const { setState: set, getState: get } = useProviders

const persist = () => write(JSON.stringify(get()))

/** 按模板新建供应商并选中；名称重复时追加序号 */
export const addProvider = (presetId: string): ProviderConfig => {
  const preset = findPreset(presetId)
  const used = new Set(get().providers.map((provider) => provider.name))
  let name = preset.name
  for (let index = 2; used.has(name); index++) {
    name = `${preset.name} ${index}`
  }
  const provider: ProviderConfig = {
    id: createId(),
    presetId: preset.id,
    name,
    protocol: preset.protocol,
    baseUrl: preset.baseUrl,
    apiKey: '',
    models: [...preset.models],
    model: preset.models[0] ?? '',
    deepseekExtensions: defaultDeepseekExtensions(preset.id, preset.baseUrl),
  }
  set((state) => ({ providers: [...state.providers, provider], activeId: provider.id }))
  persist()
  return provider
}

export const updateProvider = (id: string, patch: Partial<Omit<ProviderConfig, 'id'>>) => {
  set((state) => ({
    providers: state.providers.map((provider) => {
      if (provider.id !== id) {
        return provider
      }
      const baseUrl = (patch.baseUrl ?? provider.baseUrl).trim() || provider.baseUrl
      return {
        ...provider,
        ...patch,
        baseUrl,
        // 只改地址时重新判定私有能力：从官方改到中转站必须自动关闭，
        // 否则会继续下发 DeepSeek 私有字段。显式传了开关值就以调用方为准。
        deepseekExtensions:
          patch.deepseekExtensions ??
          (patch.baseUrl === undefined
            ? provider.deepseekExtensions
            : defaultDeepseekExtensions(provider.presetId, baseUrl)),
        // 改协议或地址后原先勾选的模型可能已不存在，列表仍保留由用户决定。
        models: patch.models ? [...new Set(patch.models)] : provider.models,
      }
    }),
  }))
  persist()
}

export const removeProvider = (id: string) => {
  set((state) => {
    const providers = state.providers.filter((provider) => provider.id !== id)
    return {
      providers,
      activeId: state.activeId === id ? (providers[0]?.id ?? null) : state.activeId,
    }
  })
  persist()
}

export const setActiveProvider = (id: string) => {
  if (get().providers.some((provider) => provider.id === id)) {
    set({ activeId: id })
    persist()
  }
}

export const setProviderModel = (id: string, model: string) => {
  updateProvider(id, { model })
}

export const getActiveProvider = (): ProviderConfig | null => {
  const { providers, activeId } = get()
  return providers.find((provider) => provider.id === activeId) ?? null
}

/**
 * 供应商模板声明的能力覆盖只对同协议生效，用户改协议后回到该协议的默认能力。
 * DeepSeek 模板自带的「联网 + 标题」也只在私有能力开启时才算数：
 * 指向中转站时这两项由「工具服务」在客户端补，不能算服务端能力。
 */
export const getProviderFeatures = (provider: ProviderConfig): ProtocolFeatures => {
  const preset = findPreset(provider.presetId)
  const sameProtocol = preset.protocol === provider.protocol
  // DeepSeek 模板的能力声明绑定官方服务，私有能力关掉后不应继承
  const inheritPreset = sameProtocol && (provider.deepseekExtensions || !preset.id.startsWith('deepseek'))
  const features = {
    ...PROTOCOL_FEATURES[provider.protocol],
    ...(inheritPreset ? preset.features : undefined),
  }
  return provider.deepseekExtensions ? { ...features, search: true, title: true } : features
}

export const getProviderExtensions = (provider: ProviderConfig): ProviderExtensions => ({
  deepseek: provider.deepseekExtensions,
})

export const updateTools = (patch: Partial<ToolsConfig>) => {
  set((state) => ({ tools: { ...state.tools, ...patch } }))
  persist()
}

export const getToolsConfig = (): ToolsConfig => get().tools

/** 工具服务已配置：地址与 Key 都有才能调用官方工具接口 */
export const isToolsUsable = (config = get().tools): boolean =>
  Boolean(config.baseUrl.trim() && config.apiKey.trim())

export const getToolsEndpoint = (): ToolsConfig | null => (isToolsUsable() ? get().tools : null)

/** 当前供应商是否可用：填了地址，模型已选，需要鉴权的服务已填 Key */
export const isProviderUsable = (provider: ProviderConfig | null): provider is ProviderConfig => {
  if (!provider || !provider.baseUrl.trim() || !provider.model.trim()) {
    return false
  }
  return Boolean(provider.apiKey) || Boolean(findPreset(provider.presetId).keyOptional)
}
