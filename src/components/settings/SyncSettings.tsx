import clsx from 'clsx'
import { useState } from 'react'
import { useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import { verifyServer } from '../../services/sync/api.js'
import { SyncError } from '../../services/sync/errors.js'
import { syncNow } from '../../services/sync/engine.js'
import { verifyS3, type S3Config } from '../../services/sync/s3.js'
import {
  isSyncLinked,
  logoutSync,
  updateSync,
  useSync,
  useSyncStatus,
  type SyncResultSummary,
  type SyncTransportKind,
} from '../../services/sync/store.js'
import { Button } from '../base/Button.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
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
 * 会话同步：自建服务器只填地址和一个密码，或直连 S3 兼容对象存储。
 * 纯前端构建（pnpm build:s3）只保留 S3 通道。
 */
export const SyncSettings = () => {
  const t = useTranslate()
  const config = useSync()
  const status = useSyncStatus()
  const [busy, setBusy] = useState<'connect' | 'sync' | 'verify' | null>(null)
  const [error, setError] = useState<TranslationMessage | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const linked = isSyncLinked(config)

  const updateS3 = (patch: Partial<S3Config>) => {
    updateSync({ s3: { ...config.s3, ...patch } })
  }

  /** 服务器与 S3 都先验证连接，再执行一次同步 */
  const connect = async () => {
    if (busy) {
      return
    }
    setBusy('connect')
    setError(null)
    setNotice(null)
    try {
      if (config.transport === 's3') {
        await verifyS3(config.s3)
        setNotice(t('syncS3Verified'))
      } else {
        await verifyServer({ serverUrl: config.serverUrl, password: config.password })
        setNotice(t('syncConnected'))
      }
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
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('syncPassword')}</span>
            <input
              className={styles.input}
              type="password"
              value={config.password}
              placeholder={t('syncPasswordPlaceholder')}
              autoComplete="current-password"
              disabled={busy !== null}
              onChange={(event) => updateSync({ password: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  void connect()
                }
              }}
            />
          </label>
          <div className={styles.row}>
            <Button
              variant="primary"
              size="m"
              disabled={busy !== null || !linked}
              onClick={() => void connect()}
            >
              {busy === 'connect' ? t('syncConnecting') : t('syncConnect')}
            </Button>
            <span className={styles.hint}>{t('syncServerHint')}</span>
          </div>
        </>
      )}

      {linked ? (
        <div className={styles.account}>
          <span className={styles.accountName}>
            {config.transport === 's3'
              ? `${config.s3.bucket} · ${config.s3.prefix}`
              : t('syncConnected')}
          </span>
          <span className={styles.device}>{config.deviceName}</span>
          <span className={styles.spacer} />
          <Button variant="primary" size="m" disabled={busy !== null} onClick={() => void sync()}>
            {busy === 'sync' ? t('syncSyncing') : t('syncNow')}
          </Button>
          <Button
            variant="outlined"
            size="m"
            disabled={busy !== null}
            aria-pressed={config.enabled}
            onClick={() => updateSync({ enabled: !config.enabled })}
          >
            {t('syncAuto')}
            {config.enabled ? ' · ON' : ''}
          </Button>
          {config.transport === 'server' ? (
            <Button
              variant="outlined"
              size="m"
              disabled={busy !== null}
              onClick={() => {
                logoutSync()
                setNotice(null)
                setError(null)
                showToast({ key: 'syncClearPassword' })
              }}
            >
              {t('syncClearPassword')}
            </Button>
          ) : null}
        </div>
      ) : null}

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
