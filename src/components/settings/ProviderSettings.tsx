import clsx from 'clsx'
import { useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { ApiError } from '../../services/api/client.js'
import { classifyApiError } from '../../services/api/errors.js'
import { getAdapter } from '../../services/api/protocols/index.js'
import { PROVIDER_PRESETS, findPreset } from '../../services/providers/presets.js'
import {
  addProvider,
  removeProvider,
  setActiveProvider,
  setProviderModel,
  updateProvider,
  useProviders,
} from '../../services/providers/store.js'
import {
  PROTOCOL_IDS,
  PROTOCOL_LABELS,
  type ProviderConfig,
} from '../../services/providers/types.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Select } from '../base/Select.js'
import { IconEditOutline16, IconRefreshOutline16, IconTrashOutline16 } from '../base/icons.js'
import styles from './ProviderSettings.module.css'

type Translator = ReturnType<typeof useTranslate>

/** 验证与拉取模型共用的失败文案：优先按状态码归类，其余展示服务端原文 */
const failureText = (error: unknown, t: Translator) => {
  const condition = classifyApiError(error)
  if (condition === 'unauthorized') {
    return t('apiKeyInvalid')
  }
  if (condition === 'network') {
    return t('commonNetworkErrorToast')
  }
  const message =
    error instanceof ApiError && error.localMessage
      ? t(error.localMessage.key, error.localMessage.params)
      : error instanceof Error
        ? error.message
        : String(error)
  return message
}

/** 供应商列表的模型选项：保留当前值，即使它已不在列表里 */
const modelOptions = (provider: ProviderConfig) => {
  const models =
    provider.model && !provider.models.includes(provider.model)
      ? [provider.model, ...provider.models]
      : provider.models
  return models.map((model) => ({ value: model, label: model || '—' }))
}

/**
 * 模型服务：列出全部供应商并切换当前使用的一个。
 * 编辑直接写入设置（自动保存），只有删除需要二次确认。
 */
export const ProviderSettings = () => {
  const t = useTranslate()
  const providers = useProviders((state) => state.providers)
  const activeId = useProviders((state) => state.activeId)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [presetId, setPresetId] = useState(PROVIDER_PRESETS[0].id)

  return (
    <div className={styles.wrap}>
      <div className={styles.hint}>{t('providerSectionHint')}</div>
      {providers.length === 0 ? <div className={styles.empty}>{t('providerEmpty')}</div> : null}
      <div className={styles.list}>
        {providers.map((provider) => (
          <div
            key={provider.id}
            className={clsx(styles.item, provider.id === activeId && styles.itemActive)}
          >
            <div className={styles.itemRow}>
              <button
                type="button"
                className={styles.itemButton}
                aria-pressed={provider.id === activeId}
                title={t('providerUse')}
                onClick={() => setActiveProvider(provider.id)}
              >
                <span
                  className={clsx(styles.dot, provider.id === activeId && styles.dotActive)}
                  aria-hidden
                />
                <span className={styles.itemText}>
                  <span className={styles.itemName}>{provider.name}</span>
                  <span className={styles.itemMeta}>
                    {PROTOCOL_LABELS[provider.protocol]} · {provider.baseUrl || '—'}
                  </span>
                </span>
              </button>
              <div className={styles.actions}>
                <Select
                  className={styles.modelSelect}
                  ariaLabel={t('providerModel')}
                  value={provider.model}
                  placeholder={t('providerNoModel')}
                  options={modelOptions(provider)}
                  onChange={(model) => setProviderModel(provider.id, model)}
                  disabled={provider.models.length === 0 && !provider.model}
                />
                <IconButton
                  icon={<IconEditOutline16 />}
                  tooltip={t('providerEdit')}
                  onClick={() => {
                    setConfirmingId(null)
                    setEditingId(editingId === provider.id ? null : provider.id)
                  }}
                />
                <IconButton
                  icon={<IconTrashOutline16 />}
                  tooltip={t('providerDelete')}
                  onClick={() => {
                    setEditingId(null)
                    setConfirmingId(confirmingId === provider.id ? null : provider.id)
                  }}
                />
              </div>
            </div>
            {confirmingId === provider.id ? (
              <div className={styles.confirmRow} role="alert">
                <span className={styles.confirmText}>{t('providerDeleteConfirm')}</span>
                <Button
                  variant="dangerOutlined"
                  size="s"
                  onClick={() => {
                    removeProvider(provider.id)
                    setConfirmingId(null)
                  }}
                >
                  {t('delete')}
                </Button>
                <Button variant="outlined" size="s" onClick={() => setConfirmingId(null)}>
                  {t('cancel')}
                </Button>
              </div>
            ) : null}
            {editingId === provider.id ? (
              <ProviderEditor provider={provider} onDone={() => setEditingId(null)} />
            ) : null}
          </div>
        ))}
      </div>
      <div className={styles.addRow}>
        <Select
          className={styles.addSelect}
          ariaLabel={t('providerAddPreset')}
          value={presetId}
          options={PROVIDER_PRESETS.map((preset) => ({ value: preset.id, label: preset.name }))}
          onChange={setPresetId}
        />
        <Button
          variant="outlined"
          size="m"
          onClick={() => {
            const provider = addProvider(presetId)
            setConfirmingId(null)
            setEditingId(provider.id)
          }}
        >
          {t('providerAdd')}
        </Button>
      </div>
    </div>
  )
}

/** 编辑面板：名称、协议、API 地址、Key、模型列表；改动即时保存 */
const ProviderEditor = ({ provider, onDone }: { provider: ProviderConfig; onDone: () => void }) => {
  const t = useTranslate()
  const preset = findPreset(provider.presetId)
  // 模型列表用多行文本编辑，失焦或拉取成功后写回设置
  const [models, setModels] = useState(() => provider.models.join('\n'))
  const [busy, setBusy] = useState<'verify' | 'models' | null>(null)
  const [status, setStatus] = useState<{
    ok: boolean
    key: TranslationKey
    params?: Record<string, string | number>
  } | null>(null)

  const commitModels = () => {
    const list = [
      ...new Set(
        models
          .split(/[\n,]/)
          .map((item) => item.trim())
          .filter(Boolean)
      ),
    ]
    updateProvider(provider.id, {
      models: list,
      model: list.includes(provider.model) ? provider.model : (list[0] ?? ''),
    })
  }

  const verify = async () => {
    setBusy('verify')
    setStatus(null)
    try {
      await getAdapter(provider.protocol).verify(provider)
      setStatus({ ok: true, key: 'providerVerified' })
    } catch (error) {
      setStatus({
        ok: false,
        key: 'providerVerifyFailed',
        params: { message: failureText(error, t) },
      })
    } finally {
      setBusy(null)
    }
  }

  const fetchModels = async () => {
    setBusy('models')
    setStatus(null)
    try {
      const list = await getAdapter(provider.protocol).listModels(provider)
      if (list.length === 0) {
        setStatus({ ok: false, key: 'providerModelsEmpty' })
        return
      }
      const next = [...new Set(list)].sort()
      updateProvider(provider.id, {
        models: next,
        model: next.includes(provider.model) ? provider.model : (next[0] ?? ''),
      })
      setModels(next.join('\n'))
      setStatus({ ok: true, key: 'providerModelsFetched', params: { count: next.length } })
    } catch (error) {
      setStatus({
        ok: false,
        key: 'providerVerifyFailed',
        params: { message: failureText(error, t) },
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={styles.editor}>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t('providerName')}</span>
        <input
          className={styles.input}
          value={provider.name}
          onChange={(event) => updateProvider(provider.id, { name: event.target.value })}
        />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t('providerProtocol')}</span>
        <Select
          ariaLabel={t('providerProtocol')}
          value={provider.protocol}
          options={PROTOCOL_IDS.map((id) => ({ value: id, label: PROTOCOL_LABELS[id] }))}
          onChange={(protocol) => updateProvider(provider.id, { protocol })}
        />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t('providerBaseUrl')}</span>
        <input
          className={styles.input}
          value={provider.baseUrl}
          placeholder="https://api.example.com/v1"
          spellCheck={false}
          onChange={(event) => updateProvider(provider.id, { baseUrl: event.target.value })}
        />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t('providerApiKey')}</span>
        <input
          className={styles.input}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={provider.apiKey}
          placeholder={
            preset.keyOptional ? t('providerApiKeyOptional') : t('providerApiKeyPlaceholder')
          }
          onChange={(event) => updateProvider(provider.id, { apiKey: event.target.value })}
        />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t('providerModels')}</span>
        <textarea
          className={styles.textarea}
          value={models}
          spellCheck={false}
          placeholder={t('providerModelsHint')}
          onChange={(event) => setModels(event.target.value)}
          onBlur={commitModels}
        />
      </label>
      <div className={styles.row}>
        <Button
          variant="outlined"
          size="s"
          disabled={busy !== null}
          onClick={() => void fetchModels()}
        >
          {busy === 'models' ? t('providerFetching') : t('providerFetchModels')}
          <IconRefreshOutline16 />
        </Button>
        <Button
          variant="outlined"
          size="s"
          disabled={busy !== null || !provider.baseUrl.trim()}
          onClick={() => void verify()}
        >
          {busy === 'verify' ? t('providerVerifying') : t('providerVerify')}
        </Button>
        {preset.url ? (
          <a className={styles.hint} href={preset.url} target="_blank" rel="noreferrer">
            {t('providerGetKey')}
          </a>
        ) : null}
        <span
          className={clsx(styles.status, status && !status.ok && styles.statusError)}
          role="status"
        >
          {status ? t(status.key, status.params) : ''}
        </span>
      </div>
      <div className={styles.footer}>
        <Button
          variant="primary"
          size="s"
          onClick={() => {
            commitModels()
            onDone()
          }}
        >
          {t('providerDone')}
        </Button>
      </div>
    </div>
  )
}
