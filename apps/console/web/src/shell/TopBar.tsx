import { useMemo, useRef, type CSSProperties, type MouseEvent } from 'react'
import type { AgentProcessStatus, RunnerStatus, SatelliteSnapshot } from '../api/types.ts'
import type { ResolvedInktideTheme, ThemeMode } from '../data/store.ts'
import type { NavigationOrigin } from './PageTransition.tsx'
import { switchThemeWithTransition } from './themeTransition.ts'

export interface TopBarProps {
  readonly routeLabel: string
  readonly themeMode: ThemeMode
  readonly resolvedTheme: ResolvedInktideTheme
  readonly satellite?: SatelliteSnapshot
  readonly onOpenCommand: () => void
  readonly onNavigate: (route: string, origin?: NavigationOrigin) => void
  readonly horizontalPadding?: string
  readonly className?: string
  readonly style?: CSSProperties
}

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const platform = navigator.platform || navigator.userAgent || ''
  return /Mac|iPhone|iPad|iPod/i.test(platform)
}

function getRunnerStatusColor(process?: AgentProcessStatus): string {
  const status: RunnerStatus | undefined = process?.status
  if (process?.recoveryPhase === 'restarting') return 'var(--tenghuang)'
  switch (status) {
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

function getRunnerStatusText(process?: AgentProcessStatus): string {
  const status: RunnerStatus | undefined = process?.status
  switch (status) {
    case 'running':
      return '运行中'
    case 'starting':
      return '启动中'
    case 'stopping':
      return '停止中'
    case 'crashed':
      return '已崩溃'
    case 'failed':
      return '异常'
    case 'stopped':
      return '已停止'
    case 'idle':
      return '空闲'
    default:
      return '未知'
  }
}

function getThemeTitle(mode: ThemeMode, resolved: ResolvedInktideTheme): string {
  if (mode === 'night') return '当前主题：夜墨（点击切至宣纸）'
  if (mode === 'paper') return '当前主题：宣纸（点击切至跟随系统）'
  const resolvedLabel = resolved === 'paper' ? '宣纸' : '夜墨'
  return `当前主题：跟随系统 · ${resolvedLabel}（点击切至夜墨）`
}

function getButtonCenter(el: HTMLElement | null, fallbackEvent: MouseEvent): NavigationOrigin {
  if (el !== null) {
    const rect = el.getBoundingClientRect()
    return {
      x: rect.left + rect.width * 0.5,
      y: rect.top + rect.height * 0.5,
    }
  }
  return { x: fallbackEvent.clientX, y: fallbackEvent.clientY }
}

const TRAY_BUTTON_STYLE: CSSProperties = {
  height: '28px',
  padding: '0 var(--sp-2)',
  border: 0,
  borderRadius: 'var(--radius)',
  background: 'transparent',
  color: 'var(--text-2)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '6px',
  cursor: 'pointer',
  fontSize: 'var(--fs-mono)',
  lineHeight: 1,
}

export function TopBar({
  routeLabel,
  themeMode,
  resolvedTheme,
  satellite,
  onOpenCommand,
  onNavigate,
  horizontalPadding = 'var(--sp-8)',
  className,
  style,
}: TopBarProps) {
  const themeBtnRef = useRef<HTMLButtonElement | null>(null)
  const pulseBtnRef = useRef<HTMLButtonElement | null>(null)

  const shortcutLabel = useMemo(() => (isMacPlatform() ? '⌘K' : 'Ctrl+K'), [])

  const chatProc = satellite?.processes.chat
  const activityProc = satellite?.processes.activity
  const chatColor = getRunnerStatusColor(chatProc)
  const activityColor = getRunnerStatusColor(activityProc)
  const pulseLabel = `附属进程状态：chat ${getRunnerStatusText(chatProc)}，activity ${getRunnerStatusText(activityProc)}，点击前往脉动页`

  const handleThemeClick = (event: MouseEvent<HTMLButtonElement>): void => {
    const origin = getButtonCenter(themeBtnRef.current, event)
    switchThemeWithTransition(origin)
  }

  const handlePulseClick = (event: MouseEvent<HTMLButtonElement>): void => {
    const origin = getButtonCenter(pulseBtnRef.current, event)
    onNavigate('pulse', origin)
  }

  return (
    <header
      data-shell-topbar="true"
      className={className}
      style={{
        height: 'var(--topbar-h)',
        width: '100%',
        paddingLeft: horizontalPadding,
        paddingRight: horizontalPadding,
        background: 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 'var(--sp-4)',
        flexShrink: 0,
        position: 'relative',
        zIndex: 10,
        ...style,
      }}
    >
      {/* Left: current page English uppercase label with 24px zhusha dash */}
      <span
        className="label"
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0,
        }}
      >
        {routeLabel}
      </span>

      {/* Right: solid paper plate tray for controls so ink fluid shows behind the rest of TopBar */}
      <div
        className="plate"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 'var(--sp-1)',
          padding: '4px 6px',
          background: 'var(--plate)',
          border: '1px solid var(--hair)',
          borderRadius: 'var(--radius)',
          boxShadow: 'var(--shadow-plate)',
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          onClick={(event) => {
            event.currentTarget.focus({ preventScroll: true })
            onOpenCommand()
          }}
          className="num"
          aria-label={`打开砚命令面板（${shortcutLabel}）`}
          title={`打开砚命令面板（${shortcutLabel}）`}
          data-topbar-command="true"
          style={{
            ...TRAY_BUTTON_STYLE,
            color: 'var(--text-1)',
          }}
        >
          <span>{shortcutLabel}</span>
        </button>

        <span
          aria-hidden="true"
          style={{
            width: '1px',
            height: '14px',
            background: 'var(--hair)',
          }}
        />

        <button
          ref={themeBtnRef}
          type="button"
          onClick={handleThemeClick}
          aria-label={getThemeTitle(themeMode, resolvedTheme)}
          title={getThemeTitle(themeMode, resolvedTheme)}
          data-topbar-theme="true"
          style={{
            ...TRAY_BUTTON_STYLE,
            width: '28px',
            padding: 0,
            color: 'var(--text-1)',
            fontSize: '15px',
          }}
        >
          <span aria-hidden="true">◐</span>
        </button>

        <span
          aria-hidden="true"
          style={{
            width: '1px',
            height: '14px',
            background: 'var(--hair)',
          }}
        />

        <button
          ref={pulseBtnRef}
          type="button"
          onClick={handlePulseClick}
          aria-label={pulseLabel}
          title={pulseLabel}
          data-topbar-pulse="true"
          style={{
            ...TRAY_BUTTON_STYLE,
            padding: '0 var(--sp-2)',
            gap: '6px',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: '7px',
              height: '7px',
              borderRadius: '50%',
              background: chatColor,
              display: 'inline-block',
            }}
          />
          <span
            aria-hidden="true"
            style={{
              width: '7px',
              height: '7px',
              borderRadius: '50%',
              background: activityColor,
              display: 'inline-block',
            }}
          />
        </button>
      </div>
    </header>
  )
}
