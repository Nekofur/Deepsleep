import { create } from 'zustand'
import { getActiveProvider, isProviderUsable } from '../../services/providers/store.js'

/** 设置弹窗的分组：通用设置 / 模型服务 / 高级参数 / 工具服务 / 同步 / 数据管理 */
export type SettingsSection = 'general' | 'providers' | 'advanced' | 'tools' | 'sync' | 'data'

/** 设置弹窗：侧边栏底部、没有可用供应商时的操作与 401 提示都可以打开；section 为打开时选中的分组 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
}))

export const openSettings = (section: SettingsSection) =>
  useSettingsDialog.setState({ open: true, section })

export const closeSettings = () => useSettingsDialog.setState({ open: false })

/** 没有可用供应商（地址、模型或 Key 缺失）时打开设置并选中「模型服务」，返回当前是否可用 */
export const ensureProvider = () => {
  if (isProviderUsable(getActiveProvider())) {
    return true
  }
  openSettings('providers')
  return false
}
