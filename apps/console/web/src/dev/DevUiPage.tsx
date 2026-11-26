import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { ApiError, type ConsolePluginItem, type SearchHit } from '../api/types.ts'
import {
  inktideStore,
  useInktideStore,
  type ThemeMode,
} from '../data/store.ts'
import type { EnsoState } from '../ink/engine.ts'
import { useInk } from '../ink/InkProvider.tsx'
import { COVENANT_LOCK_MS } from '../motion/tokens.ts'
import { useMotionLevel } from '../motion/useMotionLevel.ts'
import { PluginSeal } from '../plugins/PluginSeal.tsx'
import type { PluginSealVariant } from '../plugins/seal.ts'
import { CommandInk } from '../shell/CommandInk.tsx'
import { switchThemeWithTransition } from '../shell/themeTransition.ts'
import {
  playFlood,
  playForget,
  playReplyTick,
  playStamp,
} from '../sound/synth.ts'
import { Badge, type BadgeTone } from '../ui/Badge.tsx'
import { BrushButton } from '../ui/BrushButton.tsx'
import { BrushTabs, type BrushTabItem } from '../ui/BrushTabs.tsx'
import { BrushLine, EnsoGauge, InkArea, type InkAreaPoint } from '../ui/charts/index.ts'
import { Covenant } from '../ui/Covenant.tsx'
import { Enso } from '../ui/Enso.tsx'
import { HoldToStamp } from '../ui/HoldToStamp.tsx'
import { InkInput, InkTextarea } from '../ui/InkInput.tsx'
import { formatCostMicros, InkNumber } from '../ui/InkNumber.tsx'
import { InkSelect, type InkSelectOption } from '../ui/InkSelect.tsx'
import { InkSlider } from '../ui/InkSlider.tsx'
import { EmptyState, ErrorState, InkSkeleton } from '../ui/InkStates.tsx'
import { InkSwitch } from '../ui/InkSwitch.tsx'
import { InkTable, type InkTableColumn } from '../ui/InkTable.tsx'
import { LayerTag, type MemoryLayer } from '../ui/LayerTag.tsx'
import { MagneticButton } from '../ui/MagneticButton.tsx'
import { PageHeader } from '../ui/PageHeader.tsx'
import { Plate } from '../ui/Plate.tsx'
import { ScrollDrawer } from '../ui/ScrollDrawer.tsx'
import { toast } from '../ui/SealToast.tsx'

export interface DevUiPageProps {
  readonly onStartRehearsal?: () => void
}

const ENSO_STATES: readonly EnsoState[] = [
  'idle',
  'listening',
  'thinking',
  'speaking',
  'offline',
  'error',
  'recovering',
]

const ENSO_STATE_LABELS: Readonly<Record<EnsoState, string>> = {
  idle: 'idle · 空闲',
  listening: 'listening · 倾听',
  thinking: 'thinking · 思考',
  speaking: 'speaking · 回复',
  offline: 'offline · 离线',
  error: 'error · 异常',
  recovering: 'recovering · 恢复',
}

const THEME_OPTIONS: readonly { readonly mode: ThemeMode; readonly label: string }[] = [
  { mode: 'night', label: '夜墨' },
  { mode: 'paper', label: '宣纸' },
  { mode: 'auto', label: '自动' },
]

const MODEL_OPTIONS: readonly InkSelectOption[] = [
  { value: 'deepseek-flash', label: 'deepseek-flash', description: 'addition-only · 增量工具更新' },
  { value: 'deepseek-v4-pro', label: 'deepseek-v4-pro', description: 'fixed · 会话级固定工具面' },
]

const EFFORT_OPTIONS: readonly InkSelectOption[] = [
  { value: 'off', label: '关闭 (off)' },
  { value: 'low', label: '低 (low)' },
  { value: 'high', label: '高 (high)' },
  { value: 'max', label: '最大 (max)' },
  { value: 'model-default', label: '跟随模型默认' },
]

const DEMO_TABS: readonly BrushTabItem<'strata' | 'search' | 'graph' | 'persons'>[] = [
  { id: 'strata', label: '墨阶', count: 2458 },
  { id: 'search', label: '检索', count: 12 },
  { id: 'graph', label: '墨痕', count: 84 },
  { id: 'persons', label: '人物', count: 19 },
]

const CHART_RANGE_TABS: readonly BrushTabItem<'7d' | '14d' | '30d'>[] = [
  { id: '7d', label: '7 天' },
  { id: '14d', label: '14 天' },
  { id: '30d', label: '30 天' },
]

const BADGE_ITEMS: readonly { readonly tone: BadgeTone; readonly label: string }[] = [
  { tone: 'neutral', label: 'NEUTRAL' },
  { tone: 'zhusha', label: 'L3 · 朱砂' },
  { tone: 'tenghuang', label: 'PENDING · 藤黄' },
  { tone: 'shilv', label: 'HEALTHY · 石绿' },
  { tone: 'shiqing', label: 'SHADOW · 石青' },
  { tone: 'yanzhi', label: 'CRASHED · 胭脂' },
]

const LAYERS: readonly MemoryLayer[] = ['L0', 'L1', 'L2', 'L3']

const SEAL_PLUGINS: readonly string[] = [
  'console-chat',
  'memory-bridge',
  'calendar-sync',
  'web-search',
]

const SEAL_VARIANTS: readonly { readonly id: PluginSealVariant; readonly label: string }[] = [
  { id: 'auto', label: 'auto · 启用' },
  { id: 'hollow', label: 'hollow · 停用' },
  { id: 'pending', label: 'pending · 待确认' },
  { id: 'failed', label: 'failed · 异常裂纹' },
]

const PULSE_CHAT_SERIES: readonly number[] = [
  12, 18, 15, 28, 34, 22, 19, 31, 44, 38, 25, 29, 41, 35, 24, 30,
]

const PULSE_ACTIVITY_SERIES: readonly number[] = [
  8, 10, 14, 9, 11, 26, 48, 32, 18, 14, 12, 22, 19, 15, 11, 13,
]

const AREA_SERIES: Readonly<Record<'7d' | '14d' | '30d', readonly InkAreaPoint[]>> = {
  '7d': [
    { label: '11-16', value: 0.42, sublabel: '18.2k tok' },
    { label: '11-17', value: 0.78, sublabel: '31.4k tok' },
    { label: '11-18', value: 0.61, sublabel: '25.9k tok' },
    { label: '11-19', value: 1.15, sublabel: '46.8k tok' },
    { label: '11-20', value: 0.94, sublabel: '38.1k tok' },
    { label: '11-21', value: 1.38, sublabel: '54.2k tok' },
    { label: '11-22', value: 0.83, sublabel: '33.6k tok' },
  ],
  '14d': Array.from({ length: 14 }, (_, idx) => {
    const day = 9 + idx
    const value = Number((0.35 + Math.sin(idx * 0.65) * 0.45 + (idx % 4) * 0.22 + 0.45).toFixed(2))
    return {
      label: `11-${String(day).padStart(2, '0')}`,
      value,
      sublabel: `${(value * 39).toFixed(1)}k tok`,
    }
  }),
  '30d': Array.from({ length: 30 }, (_, idx) => {
    const value = Number(
      (0.4 + Math.cos(idx * 0.38) * 0.35 + Math.sin(idx * 0.21) * 0.42 + (idx % 5) * 0.16 + 0.55).toFixed(2),
    )
    return {
      label: `D-${String(30 - idx).padStart(2, '0')}`,
      value,
      sublabel: `${(value * 41).toFixed(1)}k tok`,
    }
  }),
}

interface DemoMemoryRow {
  readonly id: string
  readonly layer: MemoryLayer
  readonly summary: string
  readonly channel: string
  readonly confidence: number
  readonly version: number
  readonly status: 'active' | 'outdated' | 'pending'
}

function buildDemoRows(count: number): readonly DemoMemoryRow[] {
  const channels = ['console-chat', 'telegram', 'nightly-tide', 'owner-edit'] as const
  const templates = [
    '偏好夜墨界面，夜间处理长文本时不喜刺眼高饱和背景',
    '周三晚八点固定复盘系统设计文档并整理 L2 阶段反思',
    '提醒：外部渠道记忆写入默认以 shadow 模式审计留痕',
    'L3 身份主轴确认：保持克制编辑排版与诚实的数据表达',
    '测试环境隔离策略：所有实验读写严禁触碰主 DSH home',
    '新安装插件权限需逐条审阅，高危能力必须长按落印生效',
    '今日夜间巩固合并 14 条零散片段为 2 条中层情境记忆',
    '花费预算预警线设为 80%（藤黄），超额 100% 溢出胭脂提示',
  ] as const

  return Array.from({ length: count }, (_, idx) => {
    const layer = LAYERS[idx % LAYERS.length]!
    const status: DemoMemoryRow['status'] =
      idx % 13 === 5 ? 'pending' : idx % 17 === 9 ? 'outdated' : 'active'
    return {
      id: `mem_${String(idx + 1).padStart(4, '0')}`,
      layer,
      summary: `${templates[idx % templates.length]!} #${String(idx + 1)}`,
      channel: channels[idx % channels.length]!,
      confidence: Number((0.68 + ((idx * 17) % 31) * 0.01).toFixed(2)),
      version: 1 + (idx % 7),
      status,
    }
  })
}

const ROWS_SHORT = buildDemoRows(8)
const ROWS_VIRTUAL = buildDemoRows(260)

const MOCK_COMMAND_PLUGINS: readonly ConsolePluginItem[] = [
  {
    id: 'console-chat',
    version: '1.2.0',
    kinds: ['channel'],
    runtime: 'node',
    state: 'enabled',
    permissions: ['memory.read', 'chat.send'],
    granted: ['memory.read', 'chat.send'],
    checkPassed: true,
    tools: [],
  },
  {
    id: 'memory-bridge',
    version: '0.9.4',
    kinds: ['memory-provider'],
    runtime: 'node',
    state: 'disabled',
    permissions: ['memory.read'],
    granted: ['memory.read'],
    checkPassed: true,
    tools: [],
  },
  {
    id: 'calendar-sync',
    version: '0.4.1',
    kinds: ['activity'],
    runtime: 'process',
    state: 'pending',
    permissions: ['network.outbound'],
    granted: [],
    checkPassed: true,
    tools: [],
  },
  {
    id: 'web-search',
    version: '1.0.2',
    kinds: ['capability'],
    runtime: 'process',
    state: 'failed',
    permissions: ['network.outbound'],
    granted: ['network.outbound'],
    checkPassed: false,
    tools: [],
  },
]

const MOCK_MEMORY_HITS: readonly SearchHit[] = ROWS_SHORT.slice(0, 6).map((row, idx) => ({
  record: {
    id: row.id,
    layer: row.layer,
    kind: 'fact',
    source: 'dev-ui',
    channel: row.channel,
    subjects: ['owner'],
    actor: 'owner',
    content: { summary: row.summary, text: row.summary },
    evidence: [],
    visibility: 'open',
    trust: 'owner',
    confidence: row.confidence,
    importance: 0.7,
    tEvent: 1_763_800_000_000 - idx * 3_600_000,
    tIngest: 1_763_800_000_000 - idx * 3_600_000,
    status: 'active',
    version: row.version,
  },
  disclosure: { speakable: 'yes', label: '公开' },
  score: Number((0.95 - idx * 0.06).toFixed(2)),
}))

async function mockSearchMemory(query: string): Promise<readonly SearchHit[]> {
  const q = query.trim().toLowerCase()
  if (q === '') return []
  return MOCK_MEMORY_HITS.filter((hit) => {
    const text = String(hit.record.content.summary ?? '').toLowerCase()
    return text.includes(q) || hit.record.layer.toLowerCase().includes(q) || hit.record.channel.includes(q)
  })
}

const PAGE_CONTAINER_STYLE: CSSProperties = {
  maxWidth: 1344,
  margin: '0 auto',
  padding: 'var(--sp-6) var(--sp-6) var(--sp-11)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--sp-6)',
}

const CONTROL_BAR_STYLE: CSSProperties = {
  position: 'sticky',
  top: 'var(--sp-3)',
  zIndex: 30,
  padding: 'var(--sp-3) var(--sp-4)',
  border: '1px solid var(--hair-strong)',
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--sp-3)',
}

const SECTION_PLATE_STYLE: CSSProperties = {
  padding: 'var(--sp-6)',
  border: '1px solid var(--hair)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--sp-5)',
}

const SECTION_HEADER_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 'var(--sp-3)',
  paddingBottom: 'var(--sp-3)',
  borderBottom: '1px solid var(--hair)',
}

const SECTION_TITLE_STYLE: CSSProperties = {
  margin: 'var(--sp-1) 0 0',
  fontFamily: 'var(--font-display-cjk)',
  fontSize: 'var(--fs-h1)',
  lineHeight: 'var(--lh-h1)',
  fontWeight: 700,
  letterSpacing: '-0.01em',
  color: 'var(--text-1)',
}

const SECTION_NOTE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: 'var(--fs-small)',
  lineHeight: 'var(--lh-small)',
  color: 'var(--text-2)',
}

const SUBLABEL_STYLE: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-label)',
  lineHeight: 'var(--lh-label)',
  fontWeight: 600,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--text-3)',
}

function SectionHeading({
  eyebrow,
  title,
  note,
}: {
  readonly eyebrow: string
  readonly title: string
  readonly note?: string
}) {
  return (
    <div style={SECTION_HEADER_STYLE}>
      <div>
        <div className="label">{eyebrow}</div>
        <h2 style={SECTION_TITLE_STYLE}>{title}</h2>
      </div>
      {note ? <p style={SECTION_NOTE_STYLE}>{note}</p> : null}
    </div>
  )
}

function getToggleChipStyle(active: boolean): CSSProperties {
  return {
    padding: '4px 10px',
    borderRadius: 'var(--radius)',
    border: active ? '1px solid var(--zhusha)' : '1px solid var(--hair-strong)',
    background: active ? 'var(--plate-raised)' : 'var(--plate-sunken)',
    color: active ? 'var(--text-1)' : 'var(--text-2)',
    fontSize: 'var(--fs-small)',
    lineHeight: 'var(--lh-small)',
    fontWeight: active ? 600 : 400,
    cursor: 'pointer',
  }
}

export function DevUiPage({ onStartRehearsal }: DevUiPageProps) {
  const ink = useInk()
  const themeMode = useInktideStore((s) => s.themeMode)
  const motionPreference = useInktideStore((s) => s.motionPreference)
  const cursorMode = useInktideStore((s) => s.cursorMode)
  const soundEnabled = useInktideStore((s) => s.soundEnabled)
  const motionLevel = useMotionLevel()

  // CommandInk workbench state
  const [commandOpen, setCommandOpen] = useState(false)
  const [calmMode, setCalmMode] = useState(false)

  // Enso demo state
  const [ensoState, setEnsoState] = useState<EnsoState>('idle')
  const [rippleKey, setRippleKey] = useState(0)
  const [pulseKey, setPulseKey] = useState(0)
  const [ensoBrushKey, setEnsoBrushKey] = useState(0)

  // Buttons demo state
  const [buttonsLoading, setButtonsLoading] = useState(false)

  // HoldToStamp demo states
  const [stampSuccessKey, setStampSuccessKey] = useState(0)
  const [stampFailKey, setStampFailKey] = useState(0)
  const [stampInstantKey, setStampInstantKey] = useState(0)

  // Form controls demo states (strictly null initial values for Model & Effort!)
  const [plainInput, setPlainInput] = useState('夜墨 · 墨潮控制台')
  const [errorInput, setErrorInput] = useState('invalid-token-sample')
  const [inputError, setInputError] = useState<string | null>(null)
  const [secretInput, setSecretInput] = useState('')
  const [textareaValue, setTextareaValue] = useState('她的心智是一池会流动的墨，记录越沉越浓。')
  const [selectedModel, setSelectedModel] = useState<string | null>(null)
  const [selectedEffort, setSelectedEffort] = useState<string | null>(null)

  // Tabs / Switch / Slider states
  const [activeTab, setActiveTab] = useState<'strata' | 'search' | 'graph' | 'persons'>('strata')
  const [switchChecked, setSwitchChecked] = useState(true)
  const [sliderValue, setSliderValue] = useState(65)

  // InkNumber states
  const [tokenCounter, setTokenCounter] = useState(12480)
  const [costMicros, setCostMicros] = useState(830_000)

  // InkTable states
  const [tableVirtual, setTableVirtual] = useState(false)
  const [selectedRowKey, setSelectedRowKey] = useState<string | number | null>('mem_0002')

  // ScrollDrawer & Covenant states
  const [drawerSize, setDrawerSize] = useState<'md' | 'lg' | null>(null)
  const [covenantOpen, setCovenantOpen] = useState(false)
  const [covenantLocked, setCovenantLocked] = useState(true)
  const [covenantStampKey, setCovenantStampKey] = useState(0)
  const covenantTimerRef = useRef<number | null>(null)

  // Charts states
  const [chartRange, setChartRange] = useState<'7d' | '14d' | '30d'>('7d')
  const [customGaugePct, setCustomGaugePct] = useState(72)

  // Global Cmd+K / Ctrl+K listener on #dev/ui
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCommandOpen((prev) => !prev)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  // Covenant 1.2s lock countdown
  useEffect(() => {
    if (covenantTimerRef.current !== null) {
      window.clearTimeout(covenantTimerRef.current)
      covenantTimerRef.current = null
    }
    if (!covenantOpen) {
      setCovenantLocked(true)
      return
    }
    setCovenantLocked(true)
    setCovenantStampKey((k) => k + 1)
    covenantTimerRef.current = window.setTimeout(() => {
      covenantTimerRef.current = null
      setCovenantLocked(false)
    }, COVENANT_LOCK_MS)
    return () => {
      if (covenantTimerRef.current !== null) {
        window.clearTimeout(covenantTimerRef.current)
        covenantTimerRef.current = null
      }
    }
  }, [covenantOpen])

  const handleThemePick = useCallback(
    (mode: ThemeMode, event: ReactMouseEvent<HTMLButtonElement>) => {
      const rect = event.currentTarget.getBoundingClientRect()
      switchThemeWithTransition(
        {
          x: rect.left + rect.width * 0.5,
          y: rect.top + rect.height * 0.5,
        },
        mode,
      )
    },
    [],
  )

  const handleCalmToggle = useCallback(
    (next: boolean) => {
      setCalmMode(next)
      ink.setCalm(next)
    },
    [ink],
  )

  const triggerInputShake = useCallback(() => {
    setInputError(null)
    window.requestAnimationFrame(() => {
      setInputError('格式不合法 · 校验未通过（观察 ±3px 240ms 抖动）')
    })
  }, [])

  const tableColumns = useMemo<readonly InkTableColumn<DemoMemoryRow>[]>(
    () => [
      {
        key: 'layer',
        header: '墨阶',
        width: 72,
        render: (row) => <LayerTag layer={row.layer} />,
      },
      {
        key: 'summary',
        header: '记忆摘录',
        render: (row) => (
          <span style={{ color: 'var(--text-1)' }}>{row.summary}</span>
        ),
      },
      {
        key: 'channel',
        header: '通道',
        width: 136,
        render: (row) => (
          <span className="num" style={{ color: 'var(--text-2)', fontSize: 'var(--fs-mono)' }}>
            {row.channel}
          </span>
        ),
      },
      {
        key: 'confidence',
        header: '置信度',
        width: 96,
        numeric: true,
        render: (row) => `${Math.round(row.confidence * 100)}%`,
      },
      {
        key: 'version',
        header: '版本',
        width: 76,
        numeric: true,
        render: (row) => `v${row.version}`,
      },
      {
        key: 'status',
        header: '状态',
        width: 108,
        align: 'right',
        render: (row) => (
          <Badge
            tone={
              row.status === 'active'
                ? 'shilv'
                : row.status === 'pending'
                  ? 'tenghuang'
                  : 'yanzhi'
            }
          >
            {row.status}
          </Badge>
        ),
      },
    ],
    [],
  )

  const tableRows = tableVirtual ? ROWS_VIRTUAL : ROWS_SHORT

  return (
    <main style={PAGE_CONTAINER_STYLE} aria-label="阶段 2 墨潮组件工作台">
      {/* Sticky Top Control Bar */}
      <Plate level="raised" style={CONTROL_BAR_STYLE}>
        <div className="flex flex-wrap items-center gap-2">
          <span style={SUBLABEL_STYLE}>主题</span>
          {THEME_OPTIONS.map((opt) => (
            <button
              key={opt.mode}
              type="button"
              onClick={(e) => handleThemePick(opt.mode, e)}
              style={getToggleChipStyle(themeMode === opt.mode)}
            >
              {opt.label}
            </button>
          ))}

          <span style={{ ...SUBLABEL_STYLE, marginLeft: 'var(--sp-2)' }}>动效</span>
          <button
            type="button"
            onClick={() =>
              inktideStore.setMotionPreference(motionPreference === 'full' ? 'reduced' : 'full')
            }
            style={getToggleChipStyle(motionLevel === 'full')}
          >
            {motionLevel === 'full' ? '完整动效' : '减少动效'}
          </button>

          <span style={{ ...SUBLABEL_STYLE, marginLeft: 'var(--sp-2)' }}>光标</span>
          <button
            type="button"
            onClick={() =>
              inktideStore.setCursorMode(cursorMode === 'brush' ? 'system' : 'brush')
            }
            style={getToggleChipStyle(cursorMode === 'brush')}
          >
            {cursorMode === 'brush' ? '笔锋光标' : '系统光标'}
          </button>

          <span style={{ ...SUBLABEL_STYLE, marginLeft: 'var(--sp-2)' }}>音效</span>
          <button
            type="button"
            onClick={() => {
              const next = !soundEnabled
              inktideStore.setSoundEnabled(next)
              if (next) playStamp()
            }}
            style={getToggleChipStyle(soundEnabled)}
          >
            {soundEnabled ? '合成音效 · 开' : '合成音效 · 关'}
          </button>

          <button
            type="button"
            onClick={() => handleCalmToggle(!calmMode)}
            style={getToggleChipStyle(calmMode)}
          >
            {calmMode ? '静墨 · 开' : '流体 · 活'}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <BrushButton
            variant="secondary"
            size="sm"
            onClick={(event) => {
              event.currentTarget.focus({ preventScroll: true })
              setCommandOpen(true)
            }}
          >
            打开 ⌘K 砚
          </BrushButton>
          {onStartRehearsal ? (
            <BrushButton
              variant="primary"
              size="sm"
              onClick={onStartRehearsal}
            >
              演练登录落款 + 8 站转场
            </BrushButton>
          ) : null}
          <BrushButton
            variant="ghost"
            size="sm"
            onClick={() => inktideStore.setRoute('dev/tokens')}
          >
            #dev/tokens
          </BrushButton>
          <BrushButton
            variant="ghost"
            size="sm"
            onClick={() => inktideStore.setRoute('dev/ink')}
          >
            #dev/ink
          </BrushButton>
        </div>
      </Plate>

      {/* PageHeader + Rehearsal Guide */}
      <Plate level="base" style={SECTION_PLATE_STYLE}>
        <PageHeader
          label="DEV · STAGE 2 COMPONENT BENCH"
          title="墨件"
          actions={
            <div className="flex flex-wrap items-center gap-3">
              <Badge tone="neutral">1440 × 900</Badge>
              {soundEnabled ? (
                <div className="flex items-center gap-2">
                  <BrushButton variant="ghost" size="sm" onClick={playStamp}>
                    试听落印
                  </BrushButton>
                  <BrushButton variant="ghost" size="sm" onClick={playFlood}>
                    试听泼墨
                  </BrushButton>
                  <BrushButton variant="ghost" size="sm" onClick={playReplyTick}>
                    试听轻点
                  </BrushButton>
                  <BrushButton variant="ghost" size="sm" onClick={playForget}>
                    试听遗忘
                  </BrushButton>
                </div>
              ) : null}
            </div>
          }
          style={{ marginBottom: 0 }}
        />
        <p style={SECTION_NOTE_STYLE}>
          覆盖设计稿第 7 节全部基础组件、图表原语、插件印章与第 6 / 8.1 节登录及外壳泼墨转场演练。演练模式测试令牌为{' '}
          <code className="num" style={{ color: 'var(--text-1)' }}>
            inktide-ok
          </code>
          （输入其他任意内容验证失败抖动与 240ms 恢复）。
        </p>
      </Plate>

      {/* 01 · Plate */}
      <Plate level="base" style={SECTION_PLATE_STYLE}>
        <SectionHeading
          eyebrow="7.1 · PLATE"
          title="纸版"
          note="实色底 + 纸边阴影 + 构建期平铺纹理；无毛玻璃、无发光描边、圆角 2px。"
        />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Plate level="base" style={{ padding: 'var(--sp-4)', border: '1px solid var(--hair)' }}>
            <div style={SUBLABEL_STYLE}>LEVEL · BASE</div>
            <p className="mt-2 mb-0" style={{ color: 'var(--text-1)' }}>
              基础纸版：常规卡片与正文承载面。
            </p>
          </Plate>
          <Plate level="raised" style={{ padding: 'var(--sp-4)', border: '1px solid var(--hair-strong)' }}>
            <div style={SUBLABEL_STYLE}>LEVEL · RAISED</div>
            <p className="mt-2 mb-0" style={{ color: 'var(--text-1)' }}>
              抬起纸版：抽屉、契约弹窗与命令面板。
            </p>
          </Plate>
          <Plate level="sunken" style={{ padding: 'var(--sp-4)', border: '1px solid var(--hair)' }}>
            <div style={SUBLABEL_STYLE}>LEVEL · SUNKEN</div>
            <p className="mt-2 mb-0" style={{ color: 'var(--text-2)' }}>
              内收纸版：输入框、底栏与代码区域。
            </p>
          </Plate>
          <Plate
            level="base"
            interactive
            style={{ padding: 'var(--sp-4)', border: '1px solid var(--hair)' }}
          >
            <div style={SUBLABEL_STYLE}>INTERACTIVE</div>
            <p className="mt-2 mb-0" style={{ color: 'var(--text-1)' }}>
              悬停抬起 y -2px（SPRING.float）+ 240px CSS 变量径向微光。
            </p>
          </Plate>
          <Plate
            level="base"
            tone="warn"
            style={{ padding: 'var(--sp-4)', border: '1px solid var(--hair)' }}
          >
            <div style={SUBLABEL_STYLE}>TONE · WARN</div>
            <p className="mt-2 mb-0" style={{ color: 'var(--text-1)' }}>
              左缘 2px 藤黄线，用于待确认或遗忘预览。
            </p>
          </Plate>
          <Plate
            level="base"
            tone="danger"
            style={{ padding: 'var(--sp-4)', border: '1px solid var(--hair)' }}
          >
            <div style={SUBLABEL_STYLE}>TONE · DANGER</div>
            <p className="mt-2 mb-0" style={{ color: 'var(--text-1)' }}>
              左缘 2px 胭脂线，用于异常、失联与崩溃态。
            </p>
          </Plate>
        </div>
      </Plate>

      {/* 02 · Enso */}
      <Plate level="base" style={SECTION_PLATE_STYLE}>
        <SectionHeading
          eyebrow="7.3 · ENSO"
          title="圆相"
          note="由 WebGL2 流体上下文直接绘制（无 WebGL 时自动回退 SVG 变宽笔触），支持七态、涟漪与脉冲。"
        />
        <div className="flex flex-wrap items-center gap-8">
          <div
            style={{
              padding: 'var(--sp-5)',
              background: 'transparent',
              border: '1px dashed var(--hair-strong)',
              borderRadius: 'var(--radius)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              minWidth: 240,
              minHeight: 220,
            }}
          >
            <Enso
              key={ensoBrushKey}
              size={180}
              state={ensoState}
              rippleKey={rippleKey}
              pulseKey={pulseKey}
              brushInDurationSec={ensoBrushKey > 0 ? 1.2 : undefined}
              ariaLabel={`演示圆相，${ENSO_STATE_LABELS[ensoState]}`}
            />
          </div>

          <div className="flex-1 min-w-[280px] flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              {ENSO_STATES.map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setEnsoState(st)}
                  style={getToggleChipStyle(ensoState === st)}
                >
                  {ENSO_STATE_LABELS[st]}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <BrushButton
                variant="secondary"
                size="sm"
                onClick={() => setRippleKey((k) => k + 1)}
              >
                释放 1px 倾听涟漪
              </BrushButton>
              <BrushButton
                variant="secondary"
                size="sm"
                onClick={() => setPulseKey((k) => k + 1)}
              >
                触发说话脉冲
              </BrushButton>
              <BrushButton
                variant="secondary"
                size="sm"
                onClick={() => setEnsoBrushKey((k) => k + 1)}
              >
                1.2s 一笔重绘
              </BrushButton>
            </div>

            <div className="flex items-center gap-4 pt-2" style={{ borderTop: '1px solid var(--hair)' }}>
              <span style={SUBLABEL_STYLE}>COMPACT + LABEL</span>
              <Enso size={36} state={ensoState} label="小鲸鱼" labelVariant="compact" />
            </div>
          </div>
        </div>
      </Plate>

      {/* 03 · BrushButton & MagneticButton */}
      <Plate level="base" style={SECTION_PLATE_STYLE}>
        <SectionHeading
          eyebrow="7.4 · BUTTONS"
          title="笔触"
          note="按下 SPRING.press 缩放 0.96；次按钮悬停朱砂毛笔线 brushIn；加载用 30% 朱砂扫线，绝不用转圈 spinner。"
        />
        <div className="flex flex-wrap items-center gap-4">
          <MagneticButton>
            <BrushButton
              variant="primary"
              loading={buttonsLoading}
              onClick={() => toast.info('主按钮已触发朱砂滴墨')}
            >
              磁吸主按钮
            </BrushButton>
          </MagneticButton>
          <BrushButton variant="secondary" loading={buttonsLoading}>
            次要毛笔线按钮
          </BrushButton>
          <BrushButton variant="ghost" loading={buttonsLoading}>
            幽灵按钮
          </BrushButton>
          <BrushButton variant="danger" loading={buttonsLoading}>
            危险入口按钮
          </BrushButton>
          <BrushButton variant="secondary" disabled>
            禁用状态
          </BrushButton>
        </div>

        <div className="flex flex-wrap items-center gap-4 pt-2" style={{ borderTop: '1px solid var(--hair)' }}>
          <BrushButton variant="primary" size="sm" loading={buttonsLoading}>
            小号主按钮
          </BrushButton>
          <BrushButton variant="secondary" size="sm" loading={buttonsLoading}>
            小号次按钮
          </BrushButton>
          <BrushButton variant="ghost" size="sm" loading={buttonsLoading}>
            小号幽灵
          </BrushButton>
          <BrushButton variant="danger" size="sm" loading={buttonsLoading}>
            小号危险
          </BrushButton>
          <InkSwitch
            checked={buttonsLoading}
            onChange={setButtonsLoading}
            label="切换 Loading 扫线"
          />
        </div>
      </Plate>

      {/* 04 · HoldToStamp */}
      <Plate level="base" style={SECTION_PLATE_STYLE}>
        <SectionHeading
          eyebrow="7.5 · HOLD TO STAMP"
          title="落印"
          note="不可逆操作统一走 900ms 顺时针填充 + 压印微抖；中途松开 200ms 退回；失败出现胭脂斜裂。"
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          <Plate
            level="sunken"
            style={{
              padding: 'var(--sp-5)',
              border: '1px solid var(--hair)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 'var(--sp-3)',
            }}
          >
            <span style={SUBLABEL_STYLE}>正常按满 → 讫</span>
            <HoldToStamp
              key={stampSuccessKey}
              label="遗忘"
              ariaLabel="按住 0.9 秒以确认遗忘演示"
              onConfirm={async () => {
                await new Promise<void>((r) => window.setTimeout(r, 280))
              }}
              onComplete={() => {
                toast.success('已落印「讫」，执行遗忘动画')
              }}
            />
            <BrushButton
              variant="ghost"
              size="sm"
              onClick={() => setStampSuccessKey((k) => k + 1)}
            >
              重置印面
            </BrushButton>
          </Plate>

          <Plate
            level="sunken"
            style={{
              padding: 'var(--sp-5)',
              border: '1px solid var(--hair)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 'var(--sp-3)',
            }}
          >
            <span style={SUBLABEL_STYLE}>中途松开 → 退回</span>
            <HoldToStamp
              label="回滚"
              caption="按住约 0.4 秒后松手"
              ariaLabel="演示中途松开退回"
              onConfirm={async () => {
                await new Promise<void>((r) => window.setTimeout(r, 220))
              }}
              onComplete={() => {
                toast.info('若完整按满则会落印完成')
              }}
            />
            <span style={{ fontSize: 'var(--fs-small)', color: 'var(--text-3)' }}>
              松手后 200ms 平滑退色
            </span>
          </Plate>

          <Plate
            level="sunken"
            style={{
              padding: 'var(--sp-5)',
              border: '1px solid var(--hair)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 'var(--sp-3)',
            }}
          >
            <span style={SUBLABEL_STYLE}>模拟失败 → 裂纹</span>
            <HoldToStamp
              key={stampFailKey}
              label="卸载"
              ariaLabel="按住 0.9 秒演示失败裂纹"
              onConfirm={async () => {
                await new Promise<void>((r) => window.setTimeout(r, 240))
                throw new ApiError('CONFLICT', 409, '仍有依赖插件处于启用态')
              }}
            />
            <BrushButton
              variant="ghost"
              size="sm"
              onClick={() => setStampFailKey((k) => k + 1)}
            >
              清除裂纹
            </BrushButton>
          </Plate>

          <Plate
            level="sunken"
            style={{
              padding: 'var(--sp-5)',
              border: '1px solid var(--hair)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 'var(--sp-3)',
            }}
          >
            <span style={SUBLABEL_STYLE}>INSTANT 单击变体</span>
            <HoldToStamp
              key={stampInstantKey}
              label="落款"
              caption="点击落款开印"
              instant
              ariaLabel="点击落款开印演示"
              onConfirm={async () => {
                await new Promise<void>((r) => window.setTimeout(r, 240))
              }}
              onComplete={() => {
                toast.success('单击落款演示完成')
              }}
            />
            <BrushButton
              variant="ghost"
              size="sm"
              onClick={() => setStampInstantKey((k) => k + 1)}
            >
              重置印面
            </BrushButton>
          </Plate>
        </div>
      </Plate>

      {/* 05 · InkInput, InkTextarea, InkSelect */}
      <Plate level="base" style={SECTION_PLATE_STYLE}>
        <SectionHeading
          eyebrow="7.6 · FORM CONTROLS"
          title="笔墨"
          note="零圆角下划线输入、密码框严禁显密切换、模型与思考强度初始必须为「未选择」。"
        />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <InkInput
            label="常规输入 · TEXT"
            value={plainInput}
            onChange={(e) => setPlainInput(e.target.value)}
            helperText="聚焦时底边线从中心向两侧展开为 2px 朱砂线"
          />

          <div className="flex flex-col gap-2">
            <InkInput
              label="错误抖动验证 · ERROR"
              monospace
              value={errorInput}
              onChange={(e) => {
                setErrorInput(e.target.value)
                setInputError(null)
              }}
              error={inputError}
            />
            <div className="flex items-center gap-3">
              <BrushButton variant="danger" size="sm" onClick={triggerInputShake}>
                触发 ±3px 抖动
              </BrushButton>
              {inputError ? (
                <BrushButton variant="ghost" size="sm" onClick={() => setInputError(null)}>
                  清除错误
                </BrushButton>
              ) : null}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <InkInput
              label="密钥输入 · PASSWORD（无显密按钮）"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={secretInput}
              onChange={(e) => setSecretInput(e.target.value)}
              placeholder="输入 API Key，保存后自动清空…"
              helperText="遵循 FR-C05：始终 type=password，无明文切换按钮"
            />
            <div>
              <BrushButton
                variant="secondary"
                size="sm"
                disabled={secretInput.trim() === ''}
                onClick={() => {
                  setSecretInput('')
                  toast.success('密钥已保存并从输入态清空')
                }}
              >
                模拟保存并清空
              </BrushButton>
            </div>
          </div>

          <InkTextarea
            label="多行文本 · TEXTAREA"
            rows={3}
            value={textareaValue}
            onChange={(e) => setTextareaValue(e.target.value)}
            helperText="角色卡描述或记忆编辑正文"
          />

          <InkSelect
            label="聊天类模型 · MODEL（初始未选择）"
            options={MODEL_OPTIONS}
            value={selectedModel}
            onChange={setSelectedModel}
            placeholder="未选择"
            helperText="硬规矩 4：绝不预选任何模型"
          />

          <div className="flex flex-col gap-2">
            <InkSelect
              label="思考强度 · EFFORT（初始未选择）"
              options={EFFORT_OPTIONS}
              value={selectedEffort}
              onChange={setSelectedEffort}
              placeholder="未选择"
            />
            <div>
              <BrushButton
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSelectedModel(null)
                  setSelectedEffort(null)
                }}
              >
                重置模型与思考强度为「未选择」
              </BrushButton>
            </div>
          </div>
        </div>
      </Plate>

      {/* 06 · BrushTabs, InkSwitch, InkSlider */}
      <Plate level="base" style={SECTION_PLATE_STYLE}>
        <SectionHeading
          eyebrow="7.7–7.8 · TABS, SWITCH & SLIDER"
          title="游标"
          note="BrushTabs 提落笔下划线、InkSwitch 弹性拉伸与落定滴墨、InkSlider 方形印柄与悬浮等宽数值卡。"
        />
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <BrushTabs
              items={DEMO_TABS}
              value={activeTab}
              onChange={setActiveTab}
              ariaLabel="记忆视图切换演示"
            />
            <span className="num" style={{ fontSize: 'var(--fs-small)', color: 'var(--text-2)' }}>
              当前视图：{activeTab}
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
            <div className="flex flex-wrap items-center gap-6">
              <InkSwitch
                checked={switchChecked}
                onChange={setSwitchChecked}
                label="跨通道影子模式"
                description="开启落定时于开关处滴入朱砂微墨"
              />
              <InkSwitch
                checked={false}
                onChange={() => {}}
                disabled
                label="禁用开关"
              />
            </div>

            <InkSlider
              label="预算阈值滑块 · THRESHOLD"
              min={0}
              max={100}
              step={5}
              value={sliderValue}
              onChange={setSliderValue}
              formatValue={(v) => `${v}%`}
            />
          </div>
        </div>
      </Plate>

      {/* 07 · LayerTag & Badge */}
      <Plate level="base" style={SECTION_PLATE_STYLE}>
        <SectionHeading
          eyebrow="7.9 · LAYER TAG & BADGE"
          title="墨阶"
          note="记忆层以墨的浓淡区分（L0 淡墨 → L2 浓墨 → L3 朱砂方印）；Badge 为直角细框等宽字，严禁胶囊药丸。"
        />
        <div className="flex flex-wrap items-center gap-6">
          <div className="flex items-center gap-3">
            {LAYERS.map((layer) => (
              <div key={layer} className="flex items-center gap-2">
                <LayerTag layer={layer} />
                <span style={{ fontSize: 'var(--fs-small)', color: 'var(--text-2)' }}>
                  {layer === 'L0'
                    ? '淡墨'
                    : layer === 'L1'
                      ? '中墨'
                      : layer === 'L2'
                        ? '浓墨'
                        : '焦墨朱印'}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 pt-3" style={{ borderTop: '1px solid var(--hair)' }}>
          {BADGE_ITEMS.map((item) => (
            <Badge key={item.tone} tone={item.tone}>
              {item.label}
            </Badge>
          ))}
        </div>
      </Plate>

      {/* 08 · InkNumber */}
      <Plate level="base" style={SECTION_PLATE_STYLE}>
        <SectionHeading
          eyebrow="7.14 · INK NUMBER"
          title="数韵"
          note="逐位 SPRING.snappy 独立滚动；xl 档 Fraunces 变化瞬间 wght 300→500→300 墨洇 400ms。"
        />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-end">
          <div className="flex flex-col gap-2">
            <span style={SUBLABEL_STYLE}>FRAUNCES XL · TODAY TOKENS</span>
            <InkNumber value={tokenCounter} variant="xl" ariaLabel="今日 Token 数" />
          </div>

          <div className="flex flex-col gap-2">
            <span style={SUBLABEL_STYLE}>FORMAT COST MICROS · CNY</span>
            <InkNumber
              value={formatCostMicros(costMicros, 'CNY')}
              variant="h1"
              ariaLabel="今日人民币花费"
            />
          </div>

          <div className="flex flex-col gap-2">
            <span style={SUBLABEL_STYLE}>FORMAT COST MICROS · USD</span>
            <InkNumber
              value={formatCostMicros(costMicros, 'USD')}
              variant="h2"
              ariaLabel="今日美元花费"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 pt-3" style={{ borderTop: '1px solid var(--hair)' }}>
          <BrushButton
            variant="secondary"
            size="sm"
            onClick={() => {
              setTokenCounter((n) => n + 137)
              setCostMicros((c) => c + 470_000)
            }}
          >
            +137 tok / +¥0.47
          </BrushButton>
          <BrushButton
            variant="secondary"
            size="sm"
            onClick={() => {
              setTokenCounter((n) => n + 12_850)
              setCostMicros((c) => c + 3_250_000)
            }}
          >
            +12,850 tok / +¥3.25
          </BrushButton>
          <BrushButton
            variant="ghost"
            size="sm"
            onClick={() => {
              setTokenCounter(12480)
              setCostMicros(830_000)
            }}
          >
            重置数字
          </BrushButton>
        </div>
      </Plate>

      {/* 09 · InkTable */}
      <Plate level="base" style={SECTION_PLATE_STYLE}>
        <SectionHeading
          eyebrow="7.10 · INK TABLE"
          title="列谱"
          note="无竖线、无斑马纹；悬停行左缘 2px 朱砂竖笔 layoutId 滑动；超过 200 行自动启用定高虚拟滚动。"
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setTableVirtual(false)}
              style={getToggleChipStyle(!tableVirtual)}
            >
              8 行（常规 bloom）
            </button>
            <button
              type="button"
              onClick={() => setTableVirtual(true)}
              style={getToggleChipStyle(tableVirtual)}
            >
              260 行（虚拟滚动）
            </button>
          </div>
          <span className="num" style={{ fontSize: 'var(--fs-small)', color: 'var(--text-2)' }}>
            当前行数：{tableRows.length} · 选中行：{String(selectedRowKey ?? '无')}
          </span>
        </div>

        <InkTable
          columns={tableColumns}
          rows={tableRows}
          getRowKey={(row) => row.id}
          selectedKey={selectedRowKey}
          onRowClick={(row) => setSelectedRowKey(row.id)}
          rowTone={(row) =>
            row.status === 'pending' ? 'warn' : row.status === 'outdated' ? 'danger' : 'default'
          }
          virtualMaxHeight={360}
          ariaLabel="记忆墨阶演示表格"
        />
      </Plate>

      {/* 10 · ScrollDrawer & Covenant */}
      <Plate level="base" style={SECTION_PLATE_STYLE}>
        <SectionHeading
          eyebrow="7.11 · SCROLL DRAWER & COVENANT"
          title="卷契"
          note="卷帘由 2px 朱砂轴向右 clip-path 展开；契约弹窗含 1.2s 锁定计时，之后才解锁 HoldToStamp。"
        />
        <div className="flex flex-wrap items-center gap-4">
          <BrushButton variant="secondary" onClick={() => setDrawerSize('md')}>
            打开 560px 卷帘（记忆详情）
          </BrushButton>
          <BrushButton variant="secondary" onClick={() => setDrawerSize('lg')}>
            打开 720px 卷帘（巩固提案）
          </BrushButton>
          <BrushButton variant="danger" onClick={() => setCovenantOpen(true)}>
            打开契约弹窗（1.2s 锁印）
          </BrushButton>
        </div>
      </Plate>

      {/* 11 · SealToast */}
      <Plate level="base" style={SECTION_PLATE_STYLE}>
        <SectionHeading
          eyebrow="7.12 · SEAL TOAST"
          title="印示"
          note="右下角最多堆叠 4 枚，左方 28px 小方印（成/慎/误/知），4.5 秒后去饱和褪色，悬停暂停计时。"
        />
        <div className="flex flex-wrap items-center gap-3">
          <BrushButton
            variant="secondary"
            size="sm"
            onClick={() => toast.success('记忆已写入墨阶 L1', { title: '落墨完成' })}
          >
            成功「成」
          </BrushButton>
          <BrushButton
            variant="secondary"
            size="sm"
            onClick={() => toast.warn('本月预算已达 84% 警戒线', { title: '预算提醒' })}
          >
            警告「慎」
          </BrushButton>
          <BrushButton
            variant="secondary"
            size="sm"
            onClick={() => toast.info('跨通道模式已切换至 shadow', { title: '状态变更' })}
          >
            信息「知」
          </BrushButton>
          <BrushButton
            variant="danger"
            size="sm"
            onClick={() =>
              toast.error('写入冲突：远端版本已推进至 v4', {
                title: '请求失败',
                code: 'CONFLICT',
                requestId: 'req_ink_20261122_9f4a2c',
              })
            }
          >
            错误「误」（含 requestId 复制）
          </BrushButton>
          <BrushButton variant="ghost" size="sm" onClick={() => toast.clear()}>
            清空堆叠
          </BrushButton>
        </div>
      </Plate>

      {/* 12 · InkSkeleton, EmptyState, ErrorState */}
      <Plate level="base" style={SECTION_PLATE_STYLE}>
        <SectionHeading
          eyebrow="7.13 · STATES"
          title="态象"
          note="墨晕缓流占位（无 shimmer、无 spinner）、两字宋体空态、胭脂边线失联态。"
        />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          <Plate level="sunken" style={{ padding: 'var(--sp-5)', border: '1px solid var(--hair)' }}>
            <div style={{ ...SUBLABEL_STYLE, marginBottom: 'var(--sp-3)' }}>INK SKELETON</div>
            <InkSkeleton rows={4} height={20} gap={14} />
          </Plate>

          <Plate level="sunken" style={{ border: '1px solid var(--hair)' }}>
            <EmptyState
              glyph="无痕"
              description="当前筛选条件下尚无匹配记忆记录。"
              actionLabel="重置筛选"
              onAction={() => toast.info('已重置空态演示筛选')}
              style={{ padding: 'var(--sp-6) var(--sp-4)' }}
            />
          </Plate>

          <ErrorState
            title="失联"
            code="UNAVAILABLE"
            requestId="req_ink_err_0042"
            message="内核响应超时，请确认守护进程仍在运行。"
            onRetry={() => toast.info('已重新发起连接探测')}
          />
        </div>
      </Plate>

      {/* 13 · Charts */}
      <Plate level="base" style={SECTION_PLATE_STYLE}>
        <SectionHeading
          eyebrow="7.15 · CHARTS"
          title="墨图"
          note="纯手写 SVG（零图表库）：Catmull-Rom 按笔折线、64 点弹簧形变墨面积、磁吸准星与圆相预算环。"
        />

        {/* InkArea with 7/14/30 day range morph */}
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span style={SUBLABEL_STYLE}>INK AREA · 64-POINT MORPH + MAGNETIC CROSSHAIR</span>
            <BrushTabs
              items={CHART_RANGE_TABS}
              value={chartRange}
              onChange={setChartRange}
              size="sm"
              ariaLabel="花费区间切换"
            />
          </div>
          <Plate level="sunken" style={{ padding: 'var(--sp-4)', border: '1px solid var(--hair)' }}>
            <InkArea
              data={AREA_SERIES[chartRange]}
              height={220}
              formatValue={(v) => `¥${v.toFixed(2)}`}
              formatAxisValue={(v) => `¥${v.toFixed(1)}`}
              ariaLabel={`${chartRange} 花费趋势图`}
            />
          </Plate>
        </div>

        {/* BrushLine full + compact pulse sparklines */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 pt-3" style={{ borderTop: '1px solid var(--hair)' }}>
          <div className="flex flex-col gap-2">
            <span style={SUBLABEL_STYLE}>BRUSH LINE · 按笔压力折线</span>
            <Plate level="sunken" style={{ padding: 'var(--sp-4)', border: '1px solid var(--hair)' }}>
              <BrushLine
                data={PULSE_CHAT_SERIES}
                width={360}
                height={96}
                strokeColor="var(--text-1)"
                ariaLabel="笔触折线演示"
              />
            </Plate>
          </div>

          <div className="flex flex-col gap-3">
            <span style={SUBLABEL_STYLE}>COMPACT SPARKLINES · 底栏 48 × 12 脉搏</span>
            <Plate
              level="sunken"
              style={{
                padding: 'var(--sp-4)',
                border: '1px solid var(--hair)',
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 'var(--sp-6)',
              }}
            >
              <div className="flex items-center gap-2">
                <span className="num" style={{ fontSize: 'var(--fs-mono)', color: 'var(--text-2)' }}>
                  chat
                </span>
                <BrushLine
                  data={PULSE_CHAT_SERIES}
                  compact
                  strokeColor="var(--shilv)"
                  ariaLabel="chat 进程脉搏"
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="num" style={{ fontSize: 'var(--fs-mono)', color: 'var(--text-2)' }}>
                  activity
                </span>
                <BrushLine
                  data={PULSE_ACTIVITY_SERIES}
                  compact
                  strokeColor="var(--tenghuang)"
                  ariaLabel="activity 进程脉搏"
                />
              </div>
            </Plate>
          </div>
        </div>

        {/* EnsoGauge 42% / 84% / 118% + live slider */}
        <div className="flex flex-col gap-4 pt-3" style={{ borderTop: '1px solid var(--hair)' }}>
          <span style={SUBLABEL_STYLE}>ENSO GAUGE · 42% 朱砂 / 84% 藤黄 / 118% 胭脂溢出</span>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-5 items-center">
            <div className="flex flex-col items-center gap-2">
              <EnsoGauge ratio={0.42} size={148} sublabel="正常 · 朱砂" />
            </div>
            <div className="flex flex-col items-center gap-2">
              <EnsoGauge ratio={0.84} size={148} sublabel="预警 · 藤黄" />
            </div>
            <div className="flex flex-col items-center gap-2">
              <EnsoGauge ratio={1.18} size={148} sublabel="超额 · 胭脂溢出" />
            </div>
            <div className="flex flex-col items-center gap-3">
              <EnsoGauge ratio={customGaugePct / 100} size={148} sublabel="实时调节" />
              <div style={{ width: 160 }}>
                <InkSlider
                  min={0}
                  max={135}
                  step={1}
                  value={customGaugePct}
                  onChange={setCustomGaugePct}
                  ariaLabel="实时调节圆相环百分比"
                  formatValue={(v) => `${v}%`}
                />
              </div>
            </div>
          </div>
        </div>
      </Plate>

      {/* 14 · PluginSeal */}
      <Plate level="base" style={SECTION_PLATE_STYLE}>
        <SectionHeading
          eyebrow="APPENDIX D · PLUGIN SEAL"
          title="印谱"
          note="由 pluginId 确定性 FNV-1a 哈希生成（朱文/白文、圆/方/椭圆、残边斑点），支持四态纯 React SVG 渲染。"
        />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {SEAL_PLUGINS.map((pluginId) => (
            <Plate
              key={pluginId}
              level="sunken"
              style={{
                padding: 'var(--sp-4)',
                border: '1px solid var(--hair)',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--sp-3)',
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="num" style={{ fontSize: 'var(--fs-mono)', color: 'var(--text-1)' }}>
                  {pluginId}
                </span>
                <PluginSeal pluginId={pluginId} size={20} variant="auto" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                {SEAL_VARIANTS.map((variant) => (
                  <div
                    key={variant.id}
                    className="flex flex-col items-center gap-1"
                    style={{
                      padding: 'var(--sp-2)',
                      background: 'var(--plate)',
                      borderRadius: 'var(--radius)',
                    }}
                  >
                    <PluginSeal pluginId={pluginId} size={64} variant={variant.id} />
                    <span
                      className="num"
                      style={{ fontSize: 'var(--fs-label)', color: 'var(--text-3)' }}
                    >
                      {variant.id}
                    </span>
                  </div>
                ))}
              </div>
            </Plate>
          ))}
        </div>
      </Plate>

      {/* 15 · BrushCursor Test Pad */}
      <Plate level="base" style={SECTION_PLATE_STYLE}>
        <SectionHeading
          eyebrow="7.2 · BRUSH CURSOR TEST PAD"
          title="笔锋"
          note="桌面细指针且开启笔锋光标时：移动测试普通、可点包裹、磁吸吸附、文本竖线与图谱十字准星。"
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          <Plate
            level="sunken"
            style={{
              padding: 'var(--sp-5)',
              border: '1px solid var(--hair)',
              minHeight: 112,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
            }}
          >
            <span style={SUBLABEL_STYLE}>DEFAULT</span>
            <span style={{ fontSize: 'var(--fs-small)', color: 'var(--text-2)' }}>
              8px 实点 + 28px 拖尾细环
            </span>
          </Plate>

          <Plate
            level="sunken"
            interactive
            style={{
              padding: 'var(--sp-5)',
              border: '1px solid var(--hair)',
              minHeight: 112,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
            }}
          >
            <span style={SUBLABEL_STYLE}>INTERACTIVE</span>
            <span style={{ fontSize: 'var(--fs-small)', color: 'var(--text-2)' }}>
              细环放大并变为朱砂色
            </span>
          </Plate>

          <Plate
            level="sunken"
            style={{
              padding: 'var(--sp-5)',
              border: '1px solid var(--hair)',
              minHeight: 112,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 'var(--sp-2)',
            }}
          >
            <MagneticButton>
              <BrushButton variant="primary" size="sm">
                磁吸中心
              </BrushButton>
            </MagneticButton>
            <span style={{ fontSize: 'var(--fs-label)', color: 'var(--text-3)' }}>
              环吸附中心 · 按钮偏移 ≤ 6px
            </span>
          </Plate>

          <Plate
            level="sunken"
            style={{
              padding: 'var(--sp-5)',
              border: '1px solid var(--hair)',
              minHeight: 112,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
            }}
          >
            <span style={SUBLABEL_STYLE}>TEXT INPUT</span>
            <InkInput
              aria-label="笔锋文本态测试输入"
              placeholder="移入变 2×20 竖线…"
              defaultValue=""
            />
          </Plate>

          <Plate
            level="sunken"
            data-cursor="graph"
            style={{
              padding: 'var(--sp-5)',
              border: '1px solid var(--hair)',
              minHeight: 112,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
            }}
          >
            <span style={SUBLABEL_STYLE}>GRAPH CROSSHAIR</span>
            <span style={{ fontSize: 'var(--fs-small)', color: 'var(--text-2)' }}>
              12px 十字准星（墨痕图谱态）
            </span>
          </Plate>
        </div>
      </Plate>

      {/* ScrollDrawer Instance (560px md / 720px lg) */}
      <ScrollDrawer
        open={drawerSize !== null}
        onClose={() => setDrawerSize(null)}
        size={drawerSize ?? 'md'}
        title={drawerSize === 'lg' ? '夜间巩固提案 · 卷帘 720px' : '记忆证据链 · 卷帘 560px'}
        headerExtra={
          <div className="flex items-center gap-2">
            <LayerTag layer={drawerSize === 'lg' ? 'L3' : 'L2'} />
            <Badge tone={drawerSize === 'lg' ? 'tenghuang' : 'shilv'}>
              {drawerSize === 'lg' ? 'PENDING PROPOSAL' : 'VERIFIED'}
            </Badge>
          </div>
        }
        footer={
          <>
            <span className="num" style={{ fontSize: 'var(--fs-label)', color: 'var(--text-3)' }}>
              按 ESC 或点击遮罩收卷
            </span>
            <BrushButton variant="secondary" size="sm" onClick={() => setDrawerSize(null)}>
              收起卷帘
            </BrushButton>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p style={{ margin: 0, color: 'var(--text-1)' }}>
            卷帘从左缘 2px 朱砂竖轴向右展开，内容于展开 60% 处 bloom 显现；焦点锁定于面板内，关闭后自动归还触发按钮。
          </p>
          <Plate level="sunken" style={{ padding: 'var(--sp-4)', border: '1px solid var(--hair)' }}>
            <div style={SUBLABEL_STYLE}>EVIDENCE TRACE</div>
            <p className="num mt-2 mb-0" style={{ fontSize: 'var(--fs-mono)', color: 'var(--text-2)' }}>
              mem_0002 ← [mem_0014, mem_0027, mem_0031] · trust: owner · visibility: open
            </p>
          </Plate>
        </div>
      </ScrollDrawer>

      {/* Covenant Formal Modal with 1.2s Lock + HoldToStamp */}
      <Covenant
        open={covenantOpen}
        onClose={() => setCovenantOpen(false)}
        title="准许"
        subtitle="危险操作契约 · 打开后锁定 1.2 秒防误触"
        footer={
          <>
            <HoldToStamp
              key={covenantStampKey}
              label="准许"
              caption={covenantLocked ? '请先审阅条款（1.2 秒解锁）' : '按住 0.9 秒落印生效'}
              disabled={covenantLocked}
              ariaLabel="按住 0.9 秒以确认契约权限"
              onConfirm={async () => {
                await new Promise<void>((r) => window.setTimeout(r, 260))
              }}
              onComplete={() => {
                setCovenantOpen(false)
                toast.success('契约已落印生效', { title: '准许完成' })
              }}
            />
            <BrushButton variant="ghost" size="sm" onClick={() => setCovenantOpen(false)}>
              算了
            </BrushButton>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p style={{ margin: 0, color: 'var(--text-2)' }}>
            该插件申请以下运行权限，高危项以朱砂与胭脂标明，请逐条核对后再长按落印：
          </p>
          <Plate level="sunken" tone="danger" style={{ padding: 'var(--sp-4)', border: '1px solid var(--hair)' }}>
            <div className="flex items-center justify-between gap-2">
              <span className="num" style={{ fontSize: 'var(--fs-mono)', color: 'var(--text-1)' }}>
                memory.write:L1
              </span>
              <Badge tone="yanzhi">高危写入</Badge>
            </div>
            <p className="mt-2 mb-0" style={{ fontSize: 'var(--fs-small)', color: 'var(--text-2)' }}>
              允许向中层记忆写入事实与承诺记录（受审计日志约束）。
            </p>
          </Plate>
          <Plate level="sunken" tone="warn" style={{ padding: 'var(--sp-4)', border: '1px solid var(--hair)' }}>
            <div className="flex items-center justify-between gap-2">
              <span className="num" style={{ fontSize: 'var(--fs-mono)', color: 'var(--text-1)' }}>
                network.outbound
              </span>
              <Badge tone="tenghuang">需留痕</Badge>
            </div>
            <p className="mt-2 mb-0" style={{ fontSize: 'var(--fs-small)', color: 'var(--text-2)' }}>
              允许发起受控出站网络请求。
            </p>
          </Plate>
        </div>
      </Covenant>

      {/* CommandInk ⌘K「砚」Workbench Instance */}
      <CommandInk
        open={commandOpen}
        rehearsal
        onClose={() => setCommandOpen(false)}
        plugins={MOCK_COMMAND_PLUGINS}
        searchMemory={mockSearchMemory}
        crossChannelMode="shadow"
        onNavigate={(nextRoute) => {
          setCommandOpen(false)
          toast.info(`命令面板导航目标：#${nextRoute}`)
        }}
      />
    </main>
  )
}
