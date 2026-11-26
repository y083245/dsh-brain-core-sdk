import { useMemo, type CSSProperties, type MouseEvent } from 'react'
import type {
  AccountingSummary,
  AgentClass,
  AgentProcessStatus,
  CrossChannelMode,
  SatelliteSnapshot,
  WakeMetricSample,
} from '../api/types.ts'
import { BrushLine, type BrushLinePoint } from '../ui/charts/BrushLine.tsx'
import { formatCostMicros } from '../ui/InkNumber.tsx'
import type { NavigationOrigin } from './PageTransition.tsx'

export interface StatusBarProps {
  readonly satellite?: SatelliteSnapshot
  readonly accounting?: AccountingSummary
  readonly crossChannelMode?: CrossChannelMode | null
  readonly l3Version?: number | null
  readonly onNavigate: (route: string, origin?: NavigationOrigin) => void
  readonly className?: string
  readonly style?: CSSProperties
}

function getStatusStrokeColor(process?: AgentProcessStatus): string {
  if (process?.recoveryPhase === 'restarting') return 'var(--tenghuang)'
  switch (process?.status) {
    case 'running':
      return 'var(--shilv)'
    case 'starting':
    case 'stopping':
      return 'var(--tenghuang)'
    case 'crashed':
    case 'failed':
      return 'var(--yanzhi)'
    case 'idle':
    case 'stopped':
    default:
      return 'var(--text-3)'
  }
}

function buildPulseSeries(
  metrics: readonly WakeMetricSample[] | undefined,
  agentClass: AgentClass,
  process?: AgentProcessStatus,
): readonly BrushLinePoint[] {
  const filtered = (metrics ?? [])
    .filter((sample) => sample.agentClass === agentClass)
    .slice(-12)

  if (filtered.length >= 2) {
    return filtered.map((sample) => {
      const latency =
        sample.firstSendAt !== undefined && sample.firstSendAt >= sample.arrivedAt
          ? Math.max(1, sample.firstSendAt - sample.arrivedAt)
          : Math.max(1, sample.debounceMs + 100)
      const tone =
        sample.outcome === 'unavailable'
          ? 'yanzhi'
          : sample.outcome === 'interrupted'
            ? 'tenghuang'
            : 'default'
      return { value: latency, tone }
    })
  }

  if (process?.status === 'running') {
    return [
      { value: 2 },
      { value: 2 },
      { value: 2.3 },
      { value: 2 },
      { value: 2 },
      { value: 2.2 },
      { value: 2 },
    ]
  }

  if (process?.status === 'crashed' || process?.status === 'failed') {
    return [{ value: 1, tone: 'yanzhi' }, { value: 1, tone: 'yanzhi' }]
  }

  return [{ value: 1 }, { value: 1 }]
}

function formatCompactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return '0'
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(2)}m`
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}k`
  }
  return String(Math.round(tokens))
}

function getCrossChannelColor(mode: CrossChannelMode | null | undefined): string {
  if (mode === 'on') return 'var(--shiqing)'
  if (mode === 'shadow') return 'var(--tenghuang)'
  return 'var(--text-2)'
}

function originFromClick(event: MouseEvent<HTMLButtonElement>): NavigationOrigin {
  const rect = event.currentTarget.getBoundingClientRect()
  return {
    x: rect.left + rect.width * 0.5,
    y: rect.top + rect.height * 0.5,
  }
}

const ITEM_BUTTON_STYLE: CSSProperties = {
  height: '22px',
  padding: '0 var(--sp-1)',
  border: 0,
  borderRadius: 'var(--radius)',
  background: 'transparent',
  color: 'var(--text-2)',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  flexShrink: 0,
}

const SEP_STYLE: CSSProperties = {
  color: 'var(--text-3)',
  userSelect: 'none',
  flexShrink: 0,
}

export function StatusBar({
  satellite,
  accounting,
  crossChannelMode,
  l3Version,
  onNavigate,
  className,
  style,
}: StatusBarProps) {
  const chatProc = satellite?.processes.chat
  const activityProc = satellite?.processes.activity

  const chatSeries = useMemo(
    () => buildPulseSeries(satellite?.metrics, 'chat', chatProc),
    [satellite?.metrics, chatProc],
  )
  const activitySeries = useMemo(
    () => buildPulseSeries(satellite?.metrics, 'activity', activityProc),
    [satellite?.metrics, activityProc],
  )

  const chatStroke = getStatusStrokeColor(chatProc)
  const activityStroke = getStatusStrokeColor(activityProc)

  const accountingLabel =
    accounting !== undefined
      ? `今日 ${formatCompactTokens(accounting.todayTokens)} tok / ${formatCostMicros(accounting.todayCostMicros, accounting.currency)}`
      : '今日 —'

  const crossChannelLabel =
    crossChannelMode !== null && crossChannelMode !== undefined
      ? crossChannelMode
      : '—'

  const l3Label =
    l3Version !== null && l3Version !== undefined && Number.isFinite(l3Version)
      ? `v${String(l3Version)}`
      : '—'

  return (
    <footer
      aria-label="运行状态栏"
      data-shell-statusbar="true"
      className={className ? `num ${className}` : 'num'}
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        height: 'var(--statusbar-h)',
        zIndex: 25,
        background: 'var(--plate-sunken)',
        borderTop: '1px solid var(--hair)',
        fontSize: 'var(--fs-mono)',
        lineHeight: 'var(--lh-mono)',
        color: 'var(--text-2)',
        padding: '0 var(--sp-4)',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-3)',
        overflowX: 'auto',
        overflowY: 'hidden',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {/* Satellite mini pulse lines -> #pulse */}
      <button
        type="button"
        onClick={(e) => onNavigate('pulse', originFromClick(e))}
        title="查看附属运行时脉动"
        data-statusbar-item="pulse"
        style={ITEM_BUTTON_STYLE}
      >
        <span style={{ color: 'var(--text-1)' }}>脉</span>
        <span>chat</span>
        <BrushLine
          data={chatSeries}
          compact
          width={48}
          height={12}
          strokeColor={chatStroke}
          animate={false}
          ariaLabel="chat 进程脉搏线"
        />
        <span>activity</span>
        <BrushLine
          data={activitySeries}
          compact
          width={48}
          height={12}
          strokeColor={activityStroke}
          animate={false}
          ariaLabel="activity 进程脉搏线"
        />
      </button>

      <span aria-hidden="true" style={SEP_STYLE}>
        ·
      </span>

      {/* Cross-channel mode -> #memory */}
      <button
        type="button"
        onClick={(e) => onNavigate('memory', originFromClick(e))}
        title="前往记忆页调整跨通道模式"
        data-statusbar-item="memory"
        style={ITEM_BUTTON_STYLE}
      >
        <span>跨通道</span>
        <span style={{ color: getCrossChannelColor(crossChannelMode) }}>
          {crossChannelLabel}
        </span>
      </button>

      <span aria-hidden="true" style={SEP_STYLE}>
        ·
      </span>

      {/* Today tokens & cost -> #ledger */}
      <button
        type="button"
        onClick={(e) => onNavigate('ledger', originFromClick(e))}
        title="前往账通页查看花费与互联"
        data-statusbar-item="ledger"
        style={ITEM_BUTTON_STYLE}
      >
        <span style={{ color: accounting !== undefined ? 'var(--text-1)' : 'var(--text-3)' }}>
          {accountingLabel}
        </span>
      </button>

      <span aria-hidden="true" style={SEP_STYLE}>
        ·
      </span>

      {/* Current L3 version -> #heart */}
      <button
        type="button"
        onClick={(e) => onNavigate(l3Version ? `heart?version=${String(l3Version)}` : 'heart', originFromClick(e))}
        title="前往心潮页查看 L3 版本卷"
        data-statusbar-item="heart"
        style={ITEM_BUTTON_STYLE}
      >
        <span style={{ color: l3Version != null ? 'var(--zhusha)' : 'var(--text-3)' }}>
          {l3Label}
        </span>
      </button>
    </footer>
  )
}
