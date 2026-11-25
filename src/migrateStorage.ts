/**
 * 旧版使用 chat-demo: 前缀，首次启动时复制到 deepsleep:，避免设置与 Key 丢失。
 * 必须作为最早执行的模块导入，早于各 store 读取 localStorage。
 */
try {
  const legacyKeys: string[] = []
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (key?.startsWith('chat-demo:')) {
      legacyKeys.push(key)
    }
  }
  for (const key of legacyKeys) {
    const next = `deepsleep:${key.slice('chat-demo:'.length)}`
    const value = localStorage.getItem(key)
    if (value !== null && localStorage.getItem(next) === null) {
      localStorage.setItem(next, value)
    }
  }
} catch {
  // 隐私模式或存储不可用时忽略，保持空设置启动
}
