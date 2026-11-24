/** 同步失败的原因；界面按 code 选择文案，服务端原文放在 message 里备用 */
export type SyncErrorCode =
  /** 没有配置服务器或尚未登录 */
  | 'notConfigured'
  /** 登录已过期（401） */
  | 'unauthorized'
  /** 请求没有到达服务器 */
  | 'network'
  /** 服务端返回其他错误 */
  | 'server'
  /** 同步文件格式不正确 */
  | 'protocol'
  /** 其他设备先写入了新版本（412 / 409），重试一次即可 */
  | 'conflict'
  /** 正在同步或正在替换历史，稍后重试 */
  | 'busy'

export class SyncError extends Error {
  constructor(
    readonly code: SyncErrorCode,
    message = '',
    readonly status?: number
  ) {
    super(message || code)
    this.name = 'SyncError'
  }
}
