import { useState, type ReactNode } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import type { ReasoningEffort, SafetyCheckLevel, SamplingParams } from '../../services/api/types.js'
import { setAdvanced, useSettings, type UploadPurposeMode } from '../../services/settings.js'
import { Select } from '../base/Select.js'
import styles from './AdvancedSettings.module.css'

/** 安全审查档位：off 表示整个 safety_check 字段不发送 */
const safetyOptions: { value: SafetyCheckLevel; key: TranslationKey }[] = [
  { value: 'off', key: 'safetyCheckOff' },
  { value: 'low', key: 'safetyCheckLow' },
  { value: 'high', key: 'safetyCheckHigh' },
]

/** 上传时的解析方式：auto 保持按扩展名的原有规则 */
const uploadOptions: { value: UploadPurposeMode; key: TranslationKey }[] = [
  { value: 'auto', key: 'uploadPurposeAuto' },
  { value: 'rich_layout_recognition', key: 'uploadPurposeRichLayout' },
  { value: 'text_recognition', key: 'uploadPurposeTextRecognition' },
  { value: 'user_data', key: 'uploadPurposeUserData' },
]

/** 思考强度原值：auto 时各协议按原有映射（budget_tokens 等）处理 */
const effortOptions: { value: ReasoningEffort | 'auto'; key: TranslationKey }[] = [
  { value: 'auto', key: 'reasoningEffortAuto' },
  { value: 'minimal', key: 'thinkingLevelMinimal' },
  { value: 'low', key: 'thinkingLevelLow' },
  { value: 'medium', key: 'thinkingLevelMedium' },
  { value: 'high', key: 'thinkingLevelHigh' },
  { value: 'max', key: 'thinkingLevelMax' },
]

/**
 * 高级设置：把原版写死在代码里的 DeepSeek 私有参数搬进界面——
 * 安全审查档位、上传解析方式、思考强度原值与采样参数。
 * 只在本机保存，切换供应商时共用同一套；未填写的采样项不下发。
 */
export const AdvancedSettings = () => {
  const t = useTranslate()
  const advanced = useSettings((state) => state.advanced)
  return (
    <div className={styles.wrap}>
      <div className={styles.hint}>{t('settingsAdvancedHint')}</div>
      <SettingRow
        label={t('settingsSafetyCheck')}
        description={t('settingsSafetyCheckDescription')}
        action={
          <Select
            ariaLabel={t('settingsSafetyCheck')}
            value={advanced.safetyCheck}
            options={safetyOptions.map((item) => ({ value: item.value, label: t(item.key) }))}
            onChange={(safetyCheck) => setAdvanced({ safetyCheck })}
          />
        }
      />
      <SettingRow
        label={t('settingsUploadPurpose')}
        description={t('settingsUploadPurposeDescription')}
        action={
          <Select
            ariaLabel={t('settingsUploadPurpose')}
            value={advanced.uploadPurpose}
            options={uploadOptions.map((item) => ({ value: item.value, label: t(item.key) }))}
            onChange={(uploadPurpose) => setAdvanced({ uploadPurpose })}
          />
        }
      />
      <SettingRow
        label={t('settingsReasoningEffort')}
        description={t('settingsReasoningEffortDescription')}
        action={
          <Select
            ariaLabel={t('settingsReasoningEffort')}
            value={advanced.reasoningEffort}
            options={effortOptions.map((item) => ({ value: item.value, label: t(item.key) }))}
            onChange={(reasoningEffort) => setAdvanced({ reasoningEffort })}
          />
        }
      />
      <SamplingPanel />
    </div>
  )
}

/** 采样参数面板：六个输入框，留空即不发送该项 */
const SamplingPanel = () => {
  const t = useTranslate()
  const sampling = useSettings((state) => state.advanced.sampling)
  const patch = (next: Partial<SamplingParams>) =>
    setAdvanced({ sampling: { ...sampling, ...next } })

  return (
    <div className={styles.block}>
      <div className={styles.label}>{t('settingsSampling')}</div>
      <div className={styles.description}>{t('settingsSamplingDescription')}</div>
      <div className={styles.grid}>
        <NumberField
          label={t('samplingTemperature')}
          value={sampling.temperature}
          onChange={(temperature) => patch({ temperature })}
        />
        <NumberField
          label={t('samplingTopP')}
          value={sampling.topP}
          onChange={(topP) => patch({ topP })}
        />
        <NumberField
          label={t('samplingMaxTokens')}
          value={sampling.maxTokens}
          onChange={(maxTokens) => patch({ maxTokens })}
        />
        <NumberField
          label={t('samplingPresencePenalty')}
          value={sampling.presencePenalty}
          onChange={(presencePenalty) => patch({ presencePenalty })}
        />
        <NumberField
          label={t('samplingFrequencyPenalty')}
          value={sampling.frequencyPenalty}
          onChange={(frequencyPenalty) => patch({ frequencyPenalty })}
        />
        <StopField value={sampling.stop} onChange={(stop) => patch({ stop })} />
      </div>
      <div className={styles.note}>{t('settingsSamplingThinkingNote')}</div>
    </div>
  )
}

/** 数字输入：本地保留原文，能解析成有限数字才写回设置，空串等于清空该项 */
const NumberField = ({
  label,
  value,
  onChange,
}: {
  label: string
  value: number | undefined
  onChange: (value: number | undefined) => void
}) => {
  const [text, setText] = useState(() => (value === undefined ? '' : String(value)))
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <input
        className={styles.input}
        inputMode="decimal"
        spellCheck={false}
        value={text}
        onChange={(event) => {
          const raw = event.target.value
          setText(raw)
          if (raw.trim() === '') {
            onChange(undefined)
            return
          }
          const parsed = Number(raw)
          if (Number.isFinite(parsed)) {
            onChange(parsed)
          }
        }}
      />
    </label>
  )
}

/** 停止词：逗号或换行分隔，失焦时写回设置，重复与空项自动去掉 */
const StopField = ({
  value,
  onChange,
}: {
  value: string[] | undefined
  onChange: (value: string[] | undefined) => void
}) => {
  const t = useTranslate()
  const [text, setText] = useState(() => (value ?? []).join(', '))
  const commit = () => {
    const list = [
      ...new Set(
        text
          .split(/[\n,，]/)
          .map((item) => item.trim())
          .filter(Boolean)
      ),
    ]
    onChange(list.length > 0 ? list : undefined)
  }
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{t('samplingStop')}</span>
      <input
        className={styles.input}
        spellCheck={false}
        value={text}
        placeholder={t('samplingStopPlaceholder')}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
      />
    </label>
  )
}

const SettingRow = ({
  label,
  description,
  action,
}: {
  label: string
  description: string
  action: ReactNode
}) => (
  <div className={styles.row}>
    <div className={styles.text}>
      <div className={styles.label}>{label}</div>
      <div className={styles.description}>{description}</div>
    </div>
    {action}
  </div>
)
