import clsx from 'clsx'
import { useState } from 'react'
import { useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import { useProviders } from '../../services/providers/store.js'
import { SyncError } from '../../services/sync/errors.js'
import { syncNow } from '../../services/sync/engine.js'
import { verifyS3, type S3Config } from '../../services/sync/s3.js'
import {
  isSyncLinked,
  updateSync,
  useSync,
  useSyncStatus,
  type SyncResultSummary,
  type SyncTransportKind,
} from '../../services/sync/store.js'
import { Button } from '../base/Button.js'
import { Select } from '../base/Select.js'
import { openSettings } from './settingsDialogState.js'
import styles from './SyncSettings.module.css'

/** 同步错误统一转成可展示的文案 */
const describeError = (error: unknown): TranslationMessage => {
  const code = error instanceof SyncError ? error.code : 'server'
  const key =
    code === 'notConfigured'
      ? 'syncErrorNotConfigured'
      : code === 'unauthorized'
        ? 'syncErrorAuthExpired'
        : code === 'network'
          ? 'syncErrorNetwork'
          : code === 'protocol'
            ? 'syncErrorProtocol'
            : code === 'conflict'
              ? 'syncErrorConflict'
              : code === 'busy'
                ? 'syncErrorBusy'
                : 'syncErrorServer'
  return code === 'server'
    ? { key, params: { message: error instanceof Error ? error.message : String(error) } }
    : { key }
}

/** 同步状态行：进行中、上次结果或上次时间 */
const summaryText = (
  t: ReturnType<typeof useTranslate>,
  result: SyncResultSummary | null,
  syncedAt: number
) => {
  if (result) {
    if (result.added + result.updated + result.removed === 0) {
      return result.uploaded ? t('syncUploaded') : t('syncUpToDate')
    }
    return t('syncCompleted', {
      added: result.added,
      updated: result.updated,
      removed: result.removed,
    })
  }
  return syncedAt > 0
    ? t('syncLastSynced', { time: new Date(syncedAt).toLocaleString() })
    : t('syncNever')
}

/** 只露末四位的 Key，避免在设置页展示完整凭据 */
const maskKey = (key: string) => `••••${key.slice(-4)}`

type S3TextField = Exclude<keyof S3Config, 'pathStyle'>

const S3_FIELDS: { key: S3TextField; label: TranslationKey; secret?: boolean }[] = [
  { key: 'endpoint', label: 'syncS3Endpoint' },
  { key: 'region', label: 'syncS3Region' },
  { key: 'bucket', label: 'syncS3Bucket' },
  { key: 'prefix', label: 'syncS3Prefix' },
  { key: 'accessKeyId', label: 'syncS3AccessKey' },
  { key: 'secretAccessKey', label: 'syncS3SecretKey', secret: true },
]

/**
 * 会话同步：服务器通道复用工具服务的 API Key，开启「启用同步」即同步一次；
 * 也可以直连 S3 兼容对象存储。纯前端构建（pnpm build:s3）只保留 S3 通道。
 */
export const SyncSettings = () => {
  const t = useTranslate()
  const config = useSync()
  const status = useSyncStatus()
  const apiKey = useProviders((state) => state.tools.apiKey)
  const [busy, setBusy] = useState<'connect' | 'sync' | null>(null)
  const [error, setError] = useState<TranslationMessage | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const linked = isSyncLinked(config)

  const updateS3 = (patch: Partial<S3Config>) => {
    updateSync({ s3: { ...config.s3, ...patch } })
  }

  /** S3：先验证连接，再执行一次同步 */
  const connect = async () => {
    if (busy) {
      return
    }
    setBusy('connect')
    setError(null)
    setNotice(null)
    try {
      await verifyS3(config.s3)
      setNotice(t('syncS3Verified'))
      setBusy(null)
      await sync()
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(null)
    }
  }

  const sync = async () => {
    if (busy === 'sync') {
      return
    }
    setBusy('sync')
    setError(null)
    setNotice(null)
    try {
      const result = await syncNow()
      setNotice(summaryText(t, result, Date.now()))
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(null)
    }
  }

  /** 启用开关：打开时立即同步一次，之后按自动同步的频率运行 */
  const toggleEnabled = async () => {
    if (config.enabled) {
      updateSync({ enabled: false })
      return
    }
    if (!linked) {
      setError({
        key: config.transport === 's3' ? 'syncErrorNotConfigured' : 'syncErrorToolsKey',
      })
      return
    }
    updateSync({ enabled: true })
    await sync()
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.hint}>{t('syncSectionHint')}</div>

      {__SYNC_SERVER__ ? (
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('syncTransport')}</span>
          <Select<SyncTransportKind>
            ariaLabel={t('syncTransport')}
            value={config.transport}
            options={[
              { value: 'server', label: t('syncTransportServer') },
              { value: 's3', label: t('syncTransportS3') },
            ]}
            onChange={(transport) => {
              setError(null)
              setNotice(null)
              updateSync({ transport })
            }}
          />
        </label>
      ) : null}

      {config.transport === 's3' ? (
        <>
          {S3_FIELDS.map((field) => (
            <label key={field.key} className={styles.field}>
              <span className={styles.fieldLabel}>{t(field.label)}</span>
              <input
                className={styles.input}
                type={field.secret ? 'password' : 'text'}
                value={config.s3[field.key]}
                spellCheck={false}
                autoComplete="off"
                disabled={busy !== null}
                placeholder={field.key === 'endpoint' ? 'https://s3.us-east-1.amazonaws.com' : ''}
                onChange={(event) => updateS3({ [field.key]: event.target.value })}
              />
            </label>
          ))}
          <div className={styles.row}>
            <Button
              variant="outlined"
              size="m"
              disabled={busy !== null}
              onClick={() => updateS3({ pathStyle: !config.s3.pathStyle })}
            >
              {t('syncS3PathStyle')}
              {config.s3.pathStyle ? ' · ON' : ''}
            </Button>
            <Button
              variant="primary"
              size="m"
              disabled={busy !== null || !linked}
              onClick={() => void connect()}
            >
              {busy === 'connect' ? t('syncConnecting') : t('syncConnect')}
            </Button>
            <span className={styles.hint}>{t('syncS3Hint')}</span>
          </div>
        </>
      ) : (
        <>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('syncServerUrl')}</span>
            <input
              className={styles.input}
              value={config.serverUrl}
              placeholder={t('syncServerUrlPlaceholder')}
              spellCheck={false}
              autoComplete="off"
              disabled={busy !== null}
              onChange={(event) => updateSync({ serverUrl: event.target.value })}
            />
          </label>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>{t('syncCredential')}</span>
            <div className={styles.credential}>
              <span className={clsx(styles.credentialValue, !apiKey && styles.credentialMissing)}>
                {apiKey
                  ? `${t('syncCredentialTools')} ${maskKey(apiKey)}`
                  : t('syncCredentialMissing')}
              </span>
              <Button variant="outlined" size="m" onClick={() => openSettings('tools')}>
                {t('syncConfigureTools')}
              </Button>
            </div>
          </div>
          <div className={styles.row}>
            <Button
              variant="outlined"
              size="m"
              aria-pressed={config.enabled}
              disabled={busy !== null}
              onClick={() => void toggleEnabled()}
            >
              {t('syncEnable')}
              {config.enabled ? ' · ON' : ''}
            </Button>
            <Button
              variant="primary"
              size="m"
              disabled={busy !== null || !linked}
              onClick={() => void sync()}
            >
              {busy === 'sync' ? t('syncSyncing') : t('syncNow')}
            </Button>
            <span className={styles.hint}>{t('syncEnableHint')}</span>
          </div>
        </>
      )}

      <div
        className={clsx(styles.status, (error || status.phase === 'error') && styles.statusError)}
        role="status"
        aria-live="polite"
      >
        {error
          ? t(error.key, error.params)
          : status.phase === 'syncing'
            ? t('syncSyncing')
            : status.phase === 'error' && status.message
              ? typeof status.message === 'string'
                ? status.message
                : t(status.message.key, status.message.params)
              : (notice ?? summaryText(t, status.result, config.syncedAt))}
      </div>
      <div className={styles.hint}>{t('syncAutoHint')}</div>
    </div>
  )
}
