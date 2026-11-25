import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { THINKING_LEVELS, type ThinkingLevel } from '../../services/api/types.js'
import {
  getProviderFeatures,
  setActiveProvider,
  setProviderModel,
  useProviders,
} from '../../services/providers/store.js'
import { setThinkingLevel, useSettings } from '../../services/settings.js'
import { VIEWPORT_PADDING, useDismiss } from '../base/anchored.js'
import {
  IconCheckOutline16,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
} from '../base/icons.js'
import { openSettings } from '../settings/settingsDialogState.js'
import styles from './ModelMenu.module.css'

const LEVEL_LABELS: Record<ThinkingLevel, TranslationKey> = {
  minimal: 'thinkingLevelMinimal',
  low: 'thinkingLevelLow',
  medium: 'thinkingLevelMedium',
  high: 'thinkingLevelHigh',
  xhigh: 'thinkingLevelXhigh',
  max: 'thinkingLevelMax',
}

type View = 'root' | 'models' | 'levels'

/** 打开时按触发按钮算好的浮层位置；用 bottom 定位，展开/收起不受内容高度影响 */
type PanelBox = {
  width: number
  maxHeight: number
  left: number
  bottom: number
}

/**
 * 输入框里的模型菜单：触发按钮显示「模型 + 推理等级」，
 * 展开后先选「模型 / 推理等级」，再进入可搜索的模型列表或等级列表。
 */
export const ModelMenu = () => {
  const t = useTranslate()
  const providers = useProviders((state) => state.providers)
  const activeId = useProviders((state) => state.activeId)
  const thinkingLevel = useSettings((state) => state.thinkingLevel)
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<View>('root')
  const [query, setQuery] = useState('')
  const [box, setBox] = useState<PanelBox | null>(null)
  const anchorRef = useRef<HTMLButtonElement | null>(null)
  const floatingRef = useRef<HTMLDivElement | null>(null)

  const active = providers.find((provider) => provider.id === activeId) ?? providers[0] ?? null
  const thinkingSupported = active ? getProviderFeatures(active).thinking : false
  const close = () => {
    setOpen(false)
    setView('root')
    setQuery('')
    setBox(null)
  }
  /**
   * 打开前先量触发按钮，按「浮层底边贴住输入框」定位。
   * 这样不需要等浮层挂载后测量自身高度，第一帧就在正确位置，展开没有延迟。
   */
  const openMenu = () => {
    const rect = anchorRef.current?.getBoundingClientRect()
    if (!rect) {
      return
    }
    const width = window.innerWidth >= 768 ? 300 : Math.min(340, window.innerWidth - 24)
    const maxHeight = Math.min(360, Math.max(120, rect.top - 6 - VIEWPORT_PADDING))
    setBox({
      width,
      maxHeight,
      left: Math.max(
        VIEWPORT_PADDING,
        Math.min(rect.left, window.innerWidth - width - VIEWPORT_PADDING)
      ),
      bottom: window.innerHeight - rect.top + 6,
    })
    setView('root')
    setQuery('')
    setOpen(true)
  }
  useDismiss(open, [anchorRef, floatingRef], close, { captureEscape: true })

  // 窗口尺寸变化后原来的坐标已不适用，直接收起
  useEffect(() => {
    if (!open) {
      return
    }
    const onResize = () => setOpen(false)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open])

  /** 模型按供应商分组；搜索词同时匹配供应商名与模型名 */
  const groups = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return providers
      .map((provider) => {
        const models =
          provider.model && !provider.models.includes(provider.model)
            ? [provider.model, ...provider.models]
            : provider.models
        const providerMatches = keyword !== '' && provider.name.toLowerCase().includes(keyword)
        return {
          provider,
          models: providerMatches
            ? models
            : models.filter((model) => !keyword || model.toLowerCase().includes(keyword)),
        }
      })
      .filter((group) => group.models.length > 0)
  }, [providers, query])

  if (!active) {
    return (
      <button type="button" className={styles.trigger} onClick={() => openSettings('providers')}>
        <span className={styles.triggerLabel}>{t('modelPickerConfigure')}</span>
        <span className={styles.arrow}>
          <IconChevronDownOutline14 />
        </span>
      </button>
    )
  }

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${active.name} · ${active.model || t('providerNoModel')}`}
        onClick={() => (open ? close() : openMenu())}
      >
        <span className={styles.triggerLabel}>{active.model || t('providerNoModel')}</span>
        <span className={styles.triggerLevel}>{t(LEVEL_LABELS[thinkingLevel])}</span>
        <span className={styles.arrow}>
          <IconChevronDownOutline14 />
        </span>
      </button>
      {open
        ? createPortal(
            <div
              ref={floatingRef}
              className={styles.panel}
              style={box ?? undefined}
              role="menu"
              aria-label={t('modelPickerLabel')}
            >
              {view === 'root' ? (
                <div className={styles.rootRows}>
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.row}
                    onClick={() => setView('models')}
                  >
                    <span className={styles.rowLabel}>{t('modelMenuModel')}</span>
                    <span className={styles.rowValue}>{active.model || t('providerNoModel')}</span>
                    <span className={styles.rowArrow}>
                      <IconChevronRightOutline14 />
                    </span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.row}
                    onClick={() => setView('levels')}
                  >
                    <span className={styles.rowLabel}>{t('modelMenuReasoning')}</span>
                    <span className={styles.rowValue}>{t(LEVEL_LABELS[thinkingLevel])}</span>
                    <span className={styles.rowArrow}>
                      <IconChevronRightOutline14 />
                    </span>
                  </button>
                </div>
              ) : view === 'models' ? (
                <>
                  <div className={styles.header}>
                    <button
                      type="button"
                      className={styles.back}
                      aria-label={t('modelMenuBack')}
                      onClick={() => {
                        setView('root')
                        setQuery('')
                      }}
                    >
                      <IconChevronRightOutline14 />
                    </button>
                    <input
                      className={styles.search}
                      value={query}
                      placeholder={t('modelSearchPlaceholder')}
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </div>
                  <div className={styles.list}>
                    {groups.length === 0 ? (
                      <div className={styles.empty}>
                        {query.trim() ? t('modelNoMatch') : t('modelMenuNoModels')}
                      </div>
                    ) : (
                      groups.map(({ provider, models }) => (
                        <div key={provider.id}>
                          <div className={styles.group}>{provider.name}</div>
                          {models.map((model) => {
                            const selected = provider.id === active.id && model === active.model
                            return (
                              <button
                                key={model}
                                type="button"
                                role="menuitemradio"
                                aria-checked={selected}
                                className={clsx(styles.option, selected && styles.optionActive)}
                                onClick={() => {
                                  setActiveProvider(provider.id)
                                  setProviderModel(provider.id, model)
                                  close()
                                }}
                              >
                                <span className={styles.optionName}>{model}</span>
                                {selected ? (
                                  <span className={styles.check}>
                                    <IconCheckOutline16 />
                                  </span>
                                ) : null}
                              </button>
                            )
                          })}
                        </div>
                      ))
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className={styles.header}>
                    <button
                      type="button"
                      className={styles.back}
                      aria-label={t('modelMenuBack')}
                      onClick={() => setView('root')}
                    >
                      <IconChevronRightOutline14 />
                    </button>
                    <span className={styles.title}>{t('modelMenuReasoning')}</span>
                  </div>
                  <div className={styles.list}>
                    {THINKING_LEVELS.map((level) => {
                      const selected = level === thinkingLevel
                      return (
                        <button
                          key={level}
                          type="button"
                          role="menuitemradio"
                          aria-checked={selected}
                          className={clsx(styles.option, selected && styles.optionActive)}
                          onClick={() => {
                            setThinkingLevel(level)
                            close()
                          }}
                        >
                          <span className={styles.optionName}>{t(LEVEL_LABELS[level])}</span>
                          {selected ? (
                            <span className={styles.check}>
                              <IconCheckOutline16 />
                            </span>
                          ) : null}
                        </button>
                      )
                    })}
                  </div>
                  <div className={styles.hint}>
                    {thinkingSupported ? t('modelMenuReasoningHint') : t('thinkingUnsupported')}
                  </div>
                </>
              )}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
