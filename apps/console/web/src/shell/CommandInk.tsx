import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { memoryApi, satelliteApi } from '../api/client.ts'
import {
  ApiError,
  type AgentProcessStatus,
  type ConsolePluginItem,
  type CrossChannelMode,
  type SearchHit,
} from '../api/types.ts'
import {
  inktideStore,
  useInktideStore,
  type QualityPreference,
} from '../data/store.ts'
import { useInk } from '../ink/InkProvider.tsx'
import { summarizeRecordContent } from '../lib/memoryHelpers.ts'
import { getPreset } from '../motion/presets.ts'
import { SPRING } from '../motion/tokens.ts'
import { useMotionLevel } from '../motion/useMotionLevel.ts'
import { PluginSeal } from '../plugins/PluginSeal.tsx'
import type { PluginSealVariant } from '../plugins/seal.ts'
import { BrushButton } from '../ui/BrushButton.tsx'
import { Covenant } from '../ui/Covenant.tsx'
import { HoldToStamp } from '../ui/HoldToStamp.tsx'
import { LayerTag } from '../ui/LayerTag.tsx'
import { toast } from '../ui/SealToast.tsx'
import {
  buildCommandCovenantConfig,
  canCloseConfirmCovenant,
  describeCrossChannelActionSubtitle,
  describeRestartChatActionSubtitle,
  evaluateChatRestart,
  getNextCrossChannelMode,
  requiresCrossChannelConfirm,
  resolvePaletteOpenWithConfirm,
  type CommandConfirmIntent,
} from './commandConfirm.ts'
import type { NavigationOrigin } from './PageTransition.tsx'
import { STATIONS, StationBrushIcon } from './routes.ts'
import { switchThemeWithTransition } from './themeTransition.ts'

export interface CommandInkAction {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly keywords?: readonly string[]
  readonly shortcut?: string
  readonly onSelect: () => void | Promise<void>
}

export interface CommandInkProps {
  readonly open: boolean
  readonly rehearsal?: boolean
  readonly onClose: () => void
  readonly onNavigate: (route: string, origin?: NavigationOrigin) => void
  readonly plugins?: readonly ConsolePluginItem[]
  readonly actions?: readonly CommandInkAction[]
  readonly searchMemory?: (query: string) => Promise<readonly SearchHit[]>
  readonly crossChannelMode?: CrossChannelMode | null
  readonly chatProcess?: AgentProcessStatus | null
  readonly onRefreshShellData?: () => void
}

type ResultGroupId = 'stations' | 'memory' | 'plugins' | 'actions'

interface CommandEntry {
  readonly key: string
  readonly group: ResultGroupId
  readonly title: string
  readonly subtitle?: string
  readonly shortcut?: string
  readonly leading: ReactNode
  readonly execute: () => void
}

const GROUP_LABELS: Readonly<Record<ResultGroupId, string>> = {
  stations: '站点',
  memory: '记忆',
  plugins: '插件',
  actions: '操作',
}

const GROUP_ORDER: readonly ResultGroupId[] = ['stations', 'memory', 'plugins', 'actions']

const MEMORY_DEBOUNCE_MS = 180
const MEMORY_MAX_RESULTS = 6
const SPLAT_REVEAL_DELAY_MS = 80

const QUALITY_CYCLE: readonly QualityPreference[] = ['auto', 'high', 'medium', 'low', 'static']
const QUALITY_LABEL_ZH: Readonly<Record<QualityPreference, string>> = {
  auto: '自动',
  high: '浓墨 (high)',
  medium: '中墨 (medium)',
  low: '淡墨 (low)',
  static: '静墨 (static)',
}

function pluginStateToSealVariant(state: ConsolePluginItem['state']): PluginSealVariant {
  if (state === 'disabled' || state === 'discovered') return 'hollow'
  if (state === 'pending') return 'pending'
  if (state === 'failed') return 'failed'
  return 'auto'
}

function pluginStateZh(state: ConsolePluginItem['state']): string {
  switch (state) {
    case 'discovered':
      return '本地未启用'
    case 'enabled':
      return '已启用'
    case 'disabled':
      return '已停用'
    case 'pending':
      return '待确认'
    case 'failed':
      return '异常'
  }
}

function matchesQuery(fields: readonly (string | undefined)[], query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  const tokens = q.split(/\s+/).filter(Boolean)
  const haystack = fields
    .filter((f): f is string => typeof f === 'string' && f !== '')
    .join(' ')
    .toLowerCase()
  return tokens.every((token) => haystack.includes(token))
}

function renderHighlightedText(text: string, rawQuery: string): ReactNode {
  const q = rawQuery.trim()
  if (q === '') return text

  const lowerText = text.toLowerCase()
  const lowerQuery = q.toLowerCase()
  const directIdx = lowerText.indexOf(lowerQuery)

  if (directIdx !== -1) {
    const end = directIdx + q.length
    return (
      <>
        {text.slice(0, directIdx)}
        <span
          style={{
            textDecorationLine: 'underline',
            textDecorationColor: 'var(--zhusha)',
            textUnderlineOffset: '3px',
            textDecorationThickness: '1.5px',
            color: 'var(--text-1)',
          }}
        >
          {text.slice(directIdx, end)}
        </span>
        {text.slice(end)}
      </>
    )
  }

  // Highlight individual matching characters when query is multi-part / fuzzy
  const queryChars = new Set(Array.from(lowerQuery).filter((ch) => ch.trim() !== ''))
  if (queryChars.size === 0) return text

  return Array.from(text).map((ch, idx) => {
    if (queryChars.has(ch.toLowerCase())) {
      return (
        <span
          key={idx}
          style={{
            textDecorationLine: 'underline',
            textDecorationColor: 'var(--zhusha)',
            textUnderlineOffset: '3px',
            textDecorationThickness: '1.5px',
            color: 'var(--text-1)',
          }}
        >
          {ch}
        </span>
      )
    }
    return ch
  })
}

async function defaultMemorySearch(query: string): Promise<readonly SearchHit[]> {
  const res = await memoryApi.search({
    query,
    scope: 'all',
    limit: MEMORY_MAX_RESULTS,
  })
  return res.items.slice(0, MEMORY_MAX_RESULTS)
}

export function CommandInk({
  open,
  rehearsal = false,
  onClose,
  onNavigate,
  plugins = [],
  actions,
  searchMemory,
  crossChannelMode,
  chatProcess,
  onRefreshShellData,
}: CommandInkProps) {
  const ink = useInk()
  const motionLevel = useMotionLevel()
  const themeMode = useInktideStore((s) => s.themeMode)
  const motionPref = useInktideStore((s) => s.motionPreference)
  const qualityPref = useInktideStore((s) => s.qualityPreference)
  const soundEnabled = useInktideStore((s) => s.soundEnabled)

  const [panelVisible, setPanelVisible] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [memoryHits, setMemoryHits] = useState<readonly SearchHit[]>([])
  const [memoryLoading, setMemoryLoading] = useState(false)
  const [pendingConfirm, setPendingConfirm] = useState<CommandConfirmIntent | null>(null)
  const [lastConfirm, setLastConfirm] = useState<CommandConfirmIntent | null>(null)
  const [confirmSeq, setConfirmSeq] = useState(0)
  const [confirming, setConfirming] = useState(false)
  const pendingConfirmRef = useRef<CommandConfirmIntent | null>(null)
  const confirmingRef = useRef(false)

  const openConfirm = useCallback((intent: CommandConfirmIntent): void => {
    pendingConfirmRef.current = intent
    confirmingRef.current = false
    setLastConfirm(intent)
    setConfirmSeq((n) => n + 1)
    setConfirming(false)
    setPendingConfirm(intent)
  }, [])

  const closeConfirm = useCallback((): void => {
    if (!canCloseConfirmCovenant(confirmingRef.current)) return
    pendingConfirmRef.current = null
    setPendingConfirm(null)
  }, [])

  const resultsId = useId()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  const searchSeqRef = useRef(0)
  const revealTimerRef = useRef<number | null>(null)

  // §6.3 Opening sequence: splat ink at screen center, reveal panel 80ms later with bloom
  useEffect(() => {
    if (revealTimerRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(revealTimerRef.current)
      revealTimerRef.current = null
    }

    if (!open) {
      setPanelVisible(false)
      setQuery('')
      setMemoryHits([])
      setMemoryLoading(false)
      setActiveIndex(0)
      searchSeqRef.current += 1
      return
    }

    const openDecision = resolvePaletteOpenWithConfirm(
      pendingConfirmRef.current,
      confirmingRef.current,
    )
    if (openDecision.suppressPalette) {
      setPanelVisible(false)
      onClose()
      return
    }
    if (openDecision.dismissConfirm) {
      pendingConfirmRef.current = null
      setPendingConfirm(null)
    }

    if (motionLevel === 'reduced' || typeof window === 'undefined') {
      setPanelVisible(true)
      return
    }

    ink.splat({
      x: window.innerWidth * 0.5,
      y: window.innerHeight * 0.5,
      radius: 220,
      color: 'smoke',
      amount: 0.6,
    })

    revealTimerRef.current = window.setTimeout(() => {
      revealTimerRef.current = null
      setPanelVisible(true)
    }, SPLAT_REVEAL_DELAY_MS)

    return () => {
      if (revealTimerRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(revealTimerRef.current)
        revealTimerRef.current = null
      }
    }
  }, [ink, motionLevel, onClose, open])

  // The input is the only Tab stop. Arrow keys move within the result list.
  useLayoutEffect(() => {
    if (!open || pendingConfirm !== null) return
    const opener = document.activeElement
    const focusInput = (): void => inputRef.current?.focus({ preventScroll: true })
    const keepTabInside = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Tab') {
        event.preventDefault()
        focusInput()
      }
    }
    const keepFocusInside = (event: FocusEvent): void => {
      if (panelRef.current && event.target instanceof Node && !panelRef.current.contains(event.target)) {
        focusInput()
      }
    }
    document.addEventListener('keydown', keepTabInside)
    document.addEventListener('focusin', keepFocusInside)
    return () => {
      document.removeEventListener('keydown', keepTabInside)
      document.removeEventListener('focusin', keepFocusInside)
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus({ preventScroll: true })
      }
    }
  }, [open, pendingConfirm])

  useLayoutEffect(() => {
    if (open && panelVisible && pendingConfirm === null) {
      inputRef.current?.focus({ preventScroll: true })
    }
  }, [open, panelVisible, pendingConfirm])

  // Global Esc to close even before input focuses
  useEffect(() => {
    if (!open || pendingConfirm !== null || typeof window === 'undefined') return
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose, open, pendingConfirm])

  // §6.3 Memory search: 180ms debounce + incrementing seq race guard, max 6 hits
  useEffect(() => {
    if (!open) return
    const trimmed = query.trim()
    const runner = searchMemory ?? (rehearsal ? undefined : defaultMemorySearch)
    if (trimmed === '' || runner === undefined) {
      searchSeqRef.current += 1
      setMemoryHits([])
      setMemoryLoading(false)
      return
    }

    const seq = ++searchSeqRef.current
    setMemoryLoading(true)

    const timer = window.setTimeout(() => {
      void runner(trimmed)
        .then((hits) => {
          if (searchSeqRef.current !== seq) return
          setMemoryHits(hits.slice(0, MEMORY_MAX_RESULTS))
          setMemoryLoading(false)
        })
        .catch(() => {
          if (searchSeqRef.current !== seq) return
          setMemoryHits([])
          setMemoryLoading(false)
        })
    }, MEMORY_DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timer)
    }
  }, [open, query, rehearsal, searchMemory])

  const defaultActions = useMemo<readonly CommandInkAction[]>(() => {
    const nextCrossMode = getNextCrossChannelMode(crossChannelMode)
    const currentQualityIdx = QUALITY_CYCLE.indexOf(qualityPref)
    const nextQuality = QUALITY_CYCLE[(currentQualityIdx + 1) % QUALITY_CYCLE.length] ?? 'auto'
    const nextMotion = motionPref === 'full' ? 'reduced' : 'full'

    const remoteActions: readonly CommandInkAction[] = rehearsal ? [] : [
      {
        id: 'restart-chat',
        label: '重启 chat 进程',
        description: describeRestartChatActionSubtitle(chatProcess),
        keywords: ['restart', 'chat', 'satellite', '脉动', '重启'],
        shortcut: 'PULSE',
        onSelect: () => {
          openConfirm('restart-chat')
        },
      },
      {
        id: 'cycle-cross-channel',
        label: `切换跨通道模式（→ ${nextCrossMode}）`,
        description: describeCrossChannelActionSubtitle(crossChannelMode),
        keywords: ['cross', 'channel', 'off', 'shadow', 'on', '跨通道', '记忆'],
        shortcut: nextCrossMode.toUpperCase(),
        onSelect: async () => {
          if (requiresCrossChannelConfirm(nextCrossMode)) {
            openConfirm('enable-cross-channel')
            return
          }
          try {
            await memoryApi.setCrossChannelMode(nextCrossMode)
            toast.success(`跨通道模式已切换为 ${nextCrossMode}`)
            onRefreshShellData?.()
          } catch (error) {
            const message = error instanceof Error ? error.message : '切换跨通道模式失败'
            toast.error(message, error instanceof ApiError ? error : undefined)
          }
        },
      },
    ]

    return [
      ...remoteActions,
      {
        id: 'cycle-theme',
        label: '切换主题（夜墨 / 宣纸 / 自动）',
        description: `当前：${themeMode === 'night' ? '夜墨' : themeMode === 'paper' ? '宣纸' : '跟随系统'}`,
        keywords: ['theme', 'night', 'paper', 'auto', '夜墨', '宣纸', '主题'],
        shortcut: '◐',
        onSelect: () => {
          switchThemeWithTransition()
        },
      },
      {
        id: 'toggle-motion',
        label: nextMotion === 'reduced' ? '切换动效级别：减少动效' : '切换动效级别：完整动效',
        description: `当前：${motionPref === 'full' ? '完整动效' : '减少动效'}`,
        keywords: ['motion', 'reduced', 'full', '动效', '动画'],
        shortcut: nextMotion === 'reduced' ? 'REDUCED' : 'FULL',
        onSelect: () => {
          inktideStore.setMotionPreference(nextMotion)
          toast.info(nextMotion === 'reduced' ? '已切换为减少动效模式' : '已恢复完整动效模式')
        },
      },
      {
        id: 'cycle-quality',
        label: `锁定流体档位（→ ${QUALITY_LABEL_ZH[nextQuality]}）`,
        description: `当前：${QUALITY_LABEL_ZH[qualityPref]}`,
        keywords: ['quality', 'fluid', 'ink', 'high', 'medium', 'low', 'static', '流体', '档位'],
        shortcut: nextQuality.toUpperCase(),
        onSelect: () => {
          inktideStore.setQualityPreference(nextQuality)
          toast.info(`流体档位已设为 ${QUALITY_LABEL_ZH[nextQuality]}`)
        },
      },
      {
        id: 'toggle-sound',
        label: soundEnabled ? '关闭合成音效' : '开启合成音效',
        description: 'Web Audio 落印与泼墨音效',
        keywords: ['sound', 'audio', 'mute', '音效', '声音'],
        shortcut: soundEnabled ? 'OFF' : 'ON',
        onSelect: () => {
          const next = !soundEnabled
          inktideStore.setSoundEnabled(next)
          toast.info(next ? '已开启墨潮合成音效' : '已关闭墨潮合成音效')
        },
      },
    ]
  }, [chatProcess, crossChannelMode, motionPref, onRefreshShellData, openConfirm, qualityPref, rehearsal, soundEnabled, themeMode])

  const mergedActions = useMemo<readonly CommandInkAction[]>(() => {
    if (!actions || actions.length === 0) return defaultActions
    const seen = new Set(actions.map((a) => a.id))
    return [...actions, ...defaultActions.filter((a) => !seen.has(a.id))]
  }, [actions, defaultActions])

  const groupedEntries = useMemo(() => {
    const stationEntries: CommandEntry[] = STATIONS.filter((station) =>
      matchesQuery(
        [station.id, station.glyph, station.title, station.label, station.description],
        query,
      ),
    ).map((station) => ({
      key: `station:${station.id}`,
      group: 'stations',
      title: `${station.glyph} · ${station.title}`,
      subtitle: station.label,
      shortcut: `#${station.id}`,
      leading: <StationBrushIcon stationId={station.id} size={18} />,
      execute: () => {
        onClose()
        onNavigate(station.id)
      },
    }))

    const memoryEntries: CommandEntry[] = memoryHits.map((hit) => ({
      key: `memory:${hit.record.id}`,
      group: 'memory',
      title: summarizeRecordContent(hit.record, 72),
      subtitle: `${hit.record.kind} · ${hit.record.channel}`,
      shortcut: `${Math.round(hit.score * 100)}%`,
      leading: <LayerTag layer={hit.record.layer} />,
      execute: () => {
        onClose()
        onNavigate(rehearsal ? 'memory' : `memory?record=${encodeURIComponent(hit.record.id)}`)
      },
    }))

    const pluginEntries: CommandEntry[] = plugins
      .filter((plugin) =>
        matchesQuery([plugin.id, plugin.state, ...plugin.kinds], query),
      )
      .map((plugin) => ({
        key: `plugin:${plugin.id}`,
        group: 'plugins',
        title: plugin.id,
        subtitle: `${pluginStateZh(plugin.state)} · ${plugin.kinds.join(', ')}`,
        shortcut: `v${plugin.version}`,
        leading: (
          <PluginSeal
            pluginId={plugin.id}
            size={20}
            variant={pluginStateToSealVariant(plugin.state)}
          />
        ),
        execute: () => {
          onClose()
          onNavigate(rehearsal ? 'seals' : `seals?plugin=${encodeURIComponent(plugin.id)}`)
        },
      }))

    const actionEntries: CommandEntry[] = mergedActions
      .filter((action) =>
        matchesQuery(
          [action.id, action.label, action.description, ...(action.keywords ?? [])],
          query,
        ),
      )
      .map((action) => ({
        key: `action:${action.id}`,
        group: 'actions',
        title: action.label,
        subtitle: action.description,
        shortcut: action.shortcut,
        leading: (
          <span
            aria-hidden="true"
            className="num"
            style={{
              width: '18px',
              textAlign: 'center',
              color: 'var(--zhusha)',
              fontSize: 'var(--fs-mono)',
            }}
          >
            ›
          </span>
        ),
        execute: () => {
          onClose()
          void action.onSelect()
        },
      }))

    const byGroup: Record<ResultGroupId, readonly CommandEntry[]> = {
      stations: stationEntries,
      memory: memoryEntries,
      plugins: pluginEntries,
      actions: actionEntries,
    }

    const flat: CommandEntry[] = [
      ...stationEntries,
      ...memoryEntries,
      ...pluginEntries,
      ...actionEntries,
    ]

    return { byGroup, flat }
  }, [memoryHits, mergedActions, onClose, onNavigate, plugins, query, rehearsal])

  // Keep activeIndex in bounds whenever results change
  useEffect(() => {
    setActiveIndex((prev) => {
      if (groupedEntries.flat.length === 0) return 0
      return Math.min(prev, groupedEntries.flat.length - 1)
    })
  }, [groupedEntries.flat.length])

  // Scroll active item into view
  useEffect(() => {
    const active = groupedEntries.flat[activeIndex]
    if (!active) return
    const node = itemRefs.current.get(active.key)
    node?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, groupedEntries.flat])

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>): void => {
      if (event.nativeEvent.isComposing) return
      const total = groupedEntries.flat.length
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        if (total > 0) {
          setActiveIndex((prev) => (prev + 1) % total)
        }
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        if (total > 0) {
          setActiveIndex((prev) => (prev - 1 + total) % total)
        }
      } else if (event.key === 'Enter') {
        event.preventDefault()
        const active = groupedEntries.flat[activeIndex]
        active?.execute()
      }
    },
    [activeIndex, groupedEntries.flat],
  )

  const panelVariants = useMemo(() => ({
    ...getPreset('bloom', motionLevel),
    exit: getPreset('dissolve', motionLevel).exit!,
  }), [motionLevel])
  const fadeVariants = useMemo(() => getPreset('fade', motionLevel), [motionLevel])
  const activeEntry = groupedEntries.flat[activeIndex]

  const displayConfirm = pendingConfirm ?? lastConfirm
  const covenantConfig = useMemo(
    () => (displayConfirm !== null ? buildCommandCovenantConfig(displayConfirm, chatProcess) : null),
    [chatProcess, displayConfirm],
  )

  const handleConfirmStamp = useCallback(async (): Promise<void> => {
    confirmingRef.current = true
    setConfirming(true)
    try {
      if (displayConfirm === 'enable-cross-channel') {
        await memoryApi.setCrossChannelMode('on')
        toast.success('跨通道模式已切换为 on')
        onRefreshShellData?.()
        return
      }
      if (displayConfirm === 'restart-chat') {
        const evaluation = evaluateChatRestart(chatProcess)
        if (!evaluation.canRestart) {
          throw new Error(evaluation.notice ?? '当前状态不可重启 chat 进程')
        }
        await satelliteApi.restart('chat')
        toast.success('已发起 chat 进程重启')
        onRefreshShellData?.()
      }
    } finally {
      confirmingRef.current = false
      setConfirming(false)
    }
  }, [chatProcess, displayConfirm, onRefreshShellData])

  const handleConfirmError = useCallback(
    (error: unknown): void => {
      const fallback =
        displayConfirm === 'enable-cross-channel'
          ? '切换跨通道模式失败'
          : '重启 chat 进程失败'
      const message = error instanceof Error ? error.message : fallback
      toast.error(message, error instanceof ApiError ? error : undefined)
    },
    [displayConfirm],
  )

  const backdropStyle: CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 50,
    background: 'color-mix(in srgb, var(--ink-void) 50%, transparent)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    paddingLeft: 'var(--sp-4)',
    paddingRight: 'var(--sp-4)',
  }

  let runningIndex = -1

  const covenantNoticeId =
    covenantConfig !== null && covenantConfig.blockNotice !== null
      ? `${covenantConfig.consequenceId}-notice`
      : undefined
  const covenantDescribedBy =
    covenantConfig === null
      ? undefined
      : covenantNoticeId !== undefined
        ? `${covenantConfig.consequenceId} ${covenantNoticeId}`
        : covenantConfig.consequenceId

  return (
    <>
      <AnimatePresence>
        {panelVisible && (
        <motion.div
          key="command-ink-backdrop"
          variants={fadeVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          inert={!open}
          onClick={onClose}
          style={backdropStyle}
          data-command-ink-backdrop="true"
        >
          <motion.div
            key="command-ink-panel"
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="砚 · 命令面板"
            variants={panelVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            onClick={(e) => e.stopPropagation()}
            className="plate"
            data-command-ink="true"
            style={{
              width: '640px',
              maxWidth: '100%',
              maxHeight: '70vh',
              background: 'var(--plate-raised)',
              boxShadow: 'var(--shadow-raised)',
              borderRadius: 'var(--radius)',
              border: '1px solid var(--hair-strong)',
              borderTop: '2px solid var(--zhusha)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            {/* Input row: > calligraphy mark + borderless --fs-h2 input */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--sp-3)',
                padding: 'var(--sp-4) var(--sp-5)',
                borderBottom: '1px solid var(--hair)',
                flexShrink: 0,
              }}
            >
              <span
                aria-hidden="true"
                className="num"
                style={{
                  fontSize: 'var(--fs-h2)',
                  lineHeight: 'var(--lh-h2)',
                  color: 'var(--zhusha)',
                  fontWeight: 700,
                  userSelect: 'none',
                }}
              >
                &gt;
              </span>
              <input
                ref={inputRef}
                type="text"
                role="combobox"
                value={query}
                onChange={(e) => {
                  searchSeqRef.current += 1
                  setQuery(e.target.value)
                  setMemoryHits([])
                  setActiveIndex(0)
                }}
                onKeyDown={handleKeyDown}
                placeholder="直达站点、检索记忆、插件或操作…"
                aria-label="搜索站点、记忆、插件或操作"
                aria-autocomplete="list"
                aria-expanded={open}
                aria-controls={resultsId}
                aria-activedescendant={activeEntry && `${resultsId}-${encodeURIComponent(activeEntry.key)}`}
                autoComplete="off"
                spellCheck={false}
                style={{
                  flex: 1,
                  minWidth: 0,
                  border: 0,
                  outline: 'none',
                  background: 'transparent',
                  color: 'var(--text-1)',
                  fontSize: 'var(--fs-h2)',
                  lineHeight: 'var(--lh-h2)',
                  fontWeight: 500,
                }}
              />
              <span
                className="num"
                style={{
                  fontSize: 'var(--fs-label)',
                  color: 'var(--text-3)',
                  flexShrink: 0,
                }}
              >
                ESC
              </span>
            </div>

            {/* Grouped results */}
            <div
              id={resultsId}
              role="listbox"
              aria-label="命令面板结果"
              style={{
                flex: 1,
                minHeight: 0,
                overflowY: 'auto',
                padding: 'var(--sp-2) 0',
              }}
            >
              {GROUP_ORDER.map((groupId) => {
                const entries = groupedEntries.byGroup[groupId]
                const showMemoryLoading =
                  groupId === 'memory' && query.trim() !== '' && memoryLoading && entries.length === 0

                if (entries.length === 0 && !showMemoryLoading) {
                  return null
                }

                return (
                  <div key={groupId} style={{ padding: 'var(--sp-2) 0' }}>
                    <div
                      className="num"
                      style={{
                        padding: '0 var(--sp-5) var(--sp-1)',
                        fontSize: 'var(--fs-label)',
                        lineHeight: 'var(--lh-label)',
                        letterSpacing: '0.14em',
                        color: 'var(--text-3)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                      }}
                    >
                      <span>{GROUP_LABELS[groupId]}</span>
                      {groupId === 'memory' && memoryLoading && (
                        <span>检索中…</span>
                      )}
                    </div>

                    {showMemoryLoading && (
                      <div
                        style={{
                          padding: 'var(--sp-2) var(--sp-5)',
                          fontSize: 'var(--fs-small)',
                          color: 'var(--text-3)',
                        }}
                      >
                        正在检索相关记忆…
                      </div>
                    )}

                    {entries.map((entry) => {
                      runningIndex += 1
                      const itemIdx = runningIndex
                      const isSelected = itemIdx === activeIndex

                      return (
                        <button
                          key={entry.key}
                          id={`${resultsId}-${encodeURIComponent(entry.key)}`}
                          ref={(node) => {
                            if (node !== null) {
                              itemRefs.current.set(entry.key, node)
                            } else {
                              itemRefs.current.delete(entry.key)
                            }
                          }}
                          type="button"
                          role="option"
                          tabIndex={-1}
                          aria-selected={isSelected}
                          onMouseDown={(event) => event.preventDefault()}
                          onMouseEnter={() => setActiveIndex(itemIdx)}
                          onClick={entry.execute}
                          style={{
                            position: 'relative',
                            width: '100%',
                            padding: 'var(--sp-2) var(--sp-5)',
                            border: 0,
                            background: isSelected
                              ? 'var(--plate)'
                              : 'transparent',
                            color: isSelected ? 'var(--text-1)' : 'var(--text-2)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 'var(--sp-3)',
                            textAlign: 'left',
                            cursor: 'pointer',
                          }}
                        >
                          {isSelected && (
                            <motion.span
                              aria-hidden="true"
                              layoutId={motionLevel === 'reduced' ? undefined : 'command-ink-active'}
                              transition={SPRING.snappy}
                              style={{
                                position: 'absolute',
                                left: 0,
                                top: '4px',
                                bottom: '4px',
                                width: '2px',
                                background: 'var(--zhusha)',
                                pointerEvents: 'none',
                              }}
                            />
                          )}

                          <span
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 'var(--sp-3)',
                              minWidth: 0,
                              flex: 1,
                            }}
                          >
                            <span
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                flexShrink: 0,
                              }}
                            >
                              {entry.leading}
                            </span>

                            <span
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                minWidth: 0,
                                flex: 1,
                              }}
                            >
                              <span
                                style={{
                                  fontSize: 'var(--fs-body)',
                                  lineHeight: 'var(--lh-body)',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {renderHighlightedText(entry.title, query)}
                              </span>
                              {entry.subtitle !== undefined && entry.subtitle !== '' && (
                                <span
                                  style={{
                                    fontSize: 'var(--fs-small)',
                                    lineHeight: 'var(--lh-small)',
                                    color: 'var(--text-3)',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                  }}
                                >
                                  {renderHighlightedText(entry.subtitle, query)}
                                </span>
                              )}
                            </span>
                          </span>

                          {entry.shortcut !== undefined && (
                            <span
                              className="num"
                              style={{
                                fontSize: 'var(--fs-label)',
                                lineHeight: 'var(--lh-label)',
                                color: 'var(--text-3)',
                                flexShrink: 0,
                              }}
                            >
                              {entry.shortcut}
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                )
              })}

              {groupedEntries.flat.length === 0 && !memoryLoading && (
                <div
                  style={{
                    padding: 'var(--sp-7) var(--sp-5)',
                    textAlign: 'center',
                    color: 'var(--text-3)',
                    fontSize: 'var(--fs-small)',
                  }}
                >
                  未找到与「{query.trim()}」匹配的站点、记忆、插件或操作
                </div>
              )}
            </div>

            {/* Footer keyboard hints */}
            <div
              className="num"
              style={{
                padding: 'var(--sp-2) var(--sp-5)',
                borderTop: '1px solid var(--hair)',
                background: 'var(--plate-sunken)',
                color: 'var(--text-3)',
                fontSize: 'var(--fs-label)',
                lineHeight: 'var(--lh-label)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 'var(--sp-4)',
                flexShrink: 0,
              }}
            >
              <span>↑↓ 移动 · Enter 执行 · Esc 关闭</span>
              <span>砚 · COMMAND INK</span>
            </div>
          </motion.div>
        </motion.div>
        )}
      </AnimatePresence>

      <Covenant
        open={!rehearsal && pendingConfirm !== null && covenantConfig !== null}
        title={covenantConfig?.title ?? '准许'}
        onClose={closeConfirm}
        closeOnBackdrop={!confirming}
        closeOnEscape={!confirming}
        footer={
          covenantConfig !== null ? (
            <>
              <HoldToStamp
                key={`${covenantConfig.intent}-${confirmSeq}`}
                label={covenantConfig.stampLabel}
                ariaLabel={covenantConfig.stampAriaLabel}
                ariaDescribedBy={covenantDescribedBy}
                disabled={covenantConfig.stampDisabled}
                onConfirm={handleConfirmStamp}
                onComplete={closeConfirm}
                onError={handleConfirmError}
              />
              <BrushButton variant="ghost" disabled={confirming} onClick={closeConfirm}>
                {covenantConfig.cancelLabel}
              </BrushButton>
            </>
          ) : undefined
        }
      >
        {covenantConfig !== null && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
            <p id={covenantConfig.consequenceId} style={{ margin: 0 }}>
              {covenantConfig.body}
            </p>
            {covenantConfig.blockNotice !== null && (
              <p
                id={covenantNoticeId}
                role="status"
                style={{
                  margin: 0,
                  fontSize: 'var(--fs-small)',
                  lineHeight: 'var(--lh-small)',
                  color: 'var(--tenghuang)',
                }}
              >
                {covenantConfig.blockNotice}
              </p>
            )}
            {covenantConfig.blockReason === 'no-model' && (
              <div>
                <BrushButton
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    closeConfirm()
                    onNavigate('settings')
                  }}
                >
                  去设置模型
                </BrushButton>
              </div>
            )}
          </div>
        )}
      </Covenant>
    </>
  )
}
