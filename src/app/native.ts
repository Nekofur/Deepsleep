import { App as NativeApp } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { Capacitor } from '@capacitor/core'
import { closeSettings, useSettingsDialog } from '../components/settings/settingsDialogState.js'

/**
 * 原生壳（安卓）适配：
 * - 外链改走系统浏览器，WebView 里 target="_blank" 会把聊天界面顶掉；
 * - 系统返回键先关设置弹窗，没有可关的再退出应用。
 * 浏览器里运行时不注册任何东西，行为与原版一致。
 */

/** 这些地址留在应用内：官方接口、同步服务、本地地址都不该跳浏览器 */
const isExternal = (url: string) => {
  try {
    const { protocol, hostname } = new URL(url)
    if (protocol !== 'http:' && protocol !== 'https:') {
      return false
    }
    return !(
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      /(^|\.)deepseek\.com$/i.test(hostname) ||
      /(^|\.)opengateway\.ai$/i.test(hostname)
    )
  } catch {
    return false
  }
}

/** 链接点击统一拦截：只有真正的外链才交给系统浏览器 */
const onClick = (event: MouseEvent) => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey) {
    return
  }
  const target = event.target instanceof Element ? event.target.closest('a[href]') : null
  if (!(target instanceof HTMLAnchorElement)) {
    return
  }
  const href = target.href
  if (!isExternal(href)) {
    return
  }
  event.preventDefault()
  void Browser.open({ url: href })
}

export const setupNative = () => {
  if (!Capacitor.isNativePlatform()) {
    return
  }
  document.addEventListener('click', onClick, true)
  // 返回键：设置弹窗开着就只关弹窗，否则退出；监听常驻后必须自己退出，
  // 不然 Capacitor 不会再把返回键交回系统。
  void NativeApp.addListener('backButton', () => {
    if (useSettingsDialog.getState().open) {
      closeSettings()
      return
    }
    void NativeApp.exitApp()
  })
}
