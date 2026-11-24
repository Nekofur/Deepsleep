import clsx from 'clsx'
import { useState } from 'react'
import { useTranslate, type TranslationMessage } from '../../i18n/index.js'
import { ApiError } from '../../services/api/client.js'
import { classifyApiError } from '../../services/api/errors.js'
import { verifyTools } from '../../services/api/tools.js'
import { updateTools, useProviders } from '../../services/providers/store.js'
import { Button } from '../base/Button.js'
import styles from './ToolsSettings.module.css'

const TOOLS_DOCS = 'https://api-docs.deepseek.com/zh-cn/guides/search/'

const describeFailure = (
  error: unknown,
  t: ReturnType<typeof useTranslate>
): TranslationMessage => {
  const condition = classifyApiError(error)
  if (condition === 'unauthorized') {
    return { key: 'apiKeyInvalid' }
  }
  if (condition === 'network') {
    return { key: 'commonNetworkErrorToast' }
  }
  const message =
    error instanceof ApiError && error.localMessage
      ? t(error.localMessage.key, error.localMessage.params)
      : error instanceof Error
        ? error.message
        : String(error)
  return { key: 'toolsVerifyFailed', params: { message } }
}

/**
 * 工具服务：搜索、抓取、OCR、语音识别与朗读共用的官方接口。
 * 与对话供应商分开配置，换成其他对话模型时仍然可用。
 */
export const ToolsSettings = () => {
  const t = useTranslate()
  const tools = useProviders((state) => state.tools)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [failure, setFailure] = useState<TranslationMessage | null>(null)

  const verify = async () => {
    if (busy) {
      return
    }
    setBusy(true)
    setNotice(null)
    setFailure(null)
    try {
      await verifyTools(tools)
      setNotice(t('toolsVerified'))
    } catch (error) {
      setFailure(describeFailure(error, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.hint}>{t('toolsSectionHint')}</div>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t('toolsBaseUrl')}</span>
        <input
          className={styles.input}
          value={tools.baseUrl}
          placeholder="https://api.deepseek.com"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => updateTools({ baseUrl: event.target.value })}
        />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t('toolsApiKey')}</span>
        <input
          className={styles.input}
          type="password"
          value={tools.apiKey}
          placeholder={t('toolsApiKeyPlaceholder')}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => updateTools({ apiKey: event.target.value })}
        />
      </label>
      <div className={styles.row}>
        <Button
          variant="outlined"
          size="m"
          disabled={busy || !tools.baseUrl.trim() || !tools.apiKey.trim()}
          onClick={() => void verify()}
        >
          {busy ? t('toolsVerifying') : t('toolsVerify')}
        </Button>
        <a className={styles.link} href={TOOLS_DOCS} target="_blank" rel="noreferrer">
          {t('toolsDocs')}
        </a>
        <span
          className={clsx(styles.status, failure && styles.statusError)}
          role="status"
          aria-live="polite"
        >
          {failure ? t(failure.key, failure.params) : (notice ?? '')}
        </span>
      </div>
      <div className={styles.hint}>{t('toolsClientSearchHint')}</div>
    </div>
  )
}
