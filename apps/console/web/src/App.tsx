import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { LayoutGroup } from 'motion/react'
import { clearAuthToken, hasAuthToken, onAuthExpired } from './api/client.ts'
import { inktideStore, useInktideStore } from './data/store.ts'
import { GatePage, type GateDemoAuthResult } from './pages/gate/GatePage.tsx'
import { ConsoleShell } from './shell/ConsoleShell.tsx'
import { useShellNavigation } from './shell/PageTransition.tsx'
import {
  parsePluginPageRoute,
  resolveStationDef,
  STATIONS,
  type StationId,
} from './shell/routes.ts'
import { Badge } from './ui/Badge.tsx'
import { BrushButton } from './ui/BrushButton.tsx'
import { BrushCursor } from './ui/BrushCursor.tsx'
import { EmptyState, InkSkeleton } from './ui/InkStates.tsx'
import { PageHeader } from './ui/PageHeader.tsx'
import { Plate } from './ui/Plate.tsx'
import { SealToastStack, toast } from './ui/SealToast.tsx'

const DevTokensPage = import.meta.env.DEV
  ? lazy(() => import('./dev/DevTokensPage.tsx').then((m) => ({ default: m.DevTokensPage })))
  : null

const DevInkPage = import.meta.env.DEV
  ? lazy(() => import('./dev/DevInkPage.tsx').then((m) => ({ default: m.DevInkPage })))
  : null

const DevUiPage = import.meta.env.DEV
  ? lazy(() => import('./dev/DevUiPage.tsx').then((m) => ({ default: m.DevUiPage })))
  : null

const STATION_PAGES: Record<StationId, ComponentType> = {
  court: lazy(() => import('./pages/court/CourtPage.tsx').then((m) => ({ default: m.CourtPage }))),
  voice: lazy(() => import('./pages/voice/VoicePage.tsx').then((m) => ({ default: m.VoicePage }))),
  memory: lazy(() => import('./pages/memory/MemoryPage.tsx').then((m) => ({ default: m.MemoryPage }))),
  heart: lazy(() => import('./pages/heart/HeartPage.tsx').then((m) => ({ default: m.HeartPage }))),
  seals: lazy(() => import('./pages/seals/SealsPage.tsx').then((m) => ({ default: m.SealsPage }))),
  pulse: lazy(() => import('./pages/pulse/PulsePage.tsx').then((m) => ({ default: m.PulsePage }))),
  ledger: lazy(() => import('./pages/ledger/LedgerPage.tsx').then((m) => ({ default: m.LedgerPage }))),
  settings: lazy(() => import('./pages/settings/SettingsPage.tsx').then((m) => ({ default: m.SettingsPage }))),
}

const PluginPage = lazy(() => import('./pages/pluginPage/PluginPage.tsx').then((m) => ({ default: m.PluginPage })))

type DevRehearsalMode = 'off' | 'gate' | 'shell'

const STAGE2_STATION_COPY: Readonly<
  Record<StationId, { readonly glyph: string; readonly description: string }>
> = {
  court: {
    glyph: '庭',
    description: '阶段 2 外壳已就位。阶段 3 将在此接入今日脉搏、待批提案与最近活动。',
  },
  voice: {
    glyph: '语',
    description: '阶段 2 外壳已就位。阶段 3 将在此接入对话流、飞字入列与逐字洇出回复。',
  },
  memory: {
    glyph: '忆',
    description: '阶段 2 外壳已就位（已自动降入静墨档）。阶段 3 将接入墨阶、检索、证据图谱与遗忘墨散。',
  },
  heart: {
    glyph: '心',
    description: '阶段 2 外壳已就位。阶段 3 将接入 L3 手卷版本对比、回滚与夜间巩固潮汐提案。',
  },
  seals: {
    glyph: '印',
    description: '阶段 2 外壳已就位。阶段 3 将接入插件印谱、权限契约、启用落印与停用稀释。',
  },
  pulse: {
    glyph: '脉',
    description: '阶段 2 外壳已就位。阶段 3 将接入附属进程双脉搏线、起搏重启与隔离体检。',
  },
  ledger: {
    glyph: '账',
    description: '阶段 2 外壳已就位。阶段 3 将接入花费趋势、预算圆相环、价目表与互联开关。',
  },
  settings: {
    glyph: '设',
    description: '阶段 2 外壳已就位。阶段 3 将接入模型/思考强度配置、密钥、角色卡与界面设置。',
  },
}

const DEMO_REHEARSAL_TOKEN = 'inktide-ok'
const DEMO_THINKING_MS = 360

const STATION_GRID_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(12, minmax(0, 1fr))',
  gap: 'var(--sp-5)',
}

const FULL_SPAN_STYLE: CSSProperties = {
  gridColumn: '1 / -1',
}

const QUICK_JUMP_ROW_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 'var(--sp-3)',
  marginTop: 'var(--sp-4)',
}

const REHEARSAL_BAR_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--sp-3)',
  padding: 'var(--sp-3) var(--sp-4)',
  border: '1px solid var(--hair-strong)',
}

interface StationRehearsalViewProps {
  readonly renderTopBanner?: (transitionCount: number) => ReactNode
}

function StationRehearsalView({
  renderTopBanner,
}: StationRehearsalViewProps) {
  const { displayedRoute, navigate, transitionCount } = useShellNavigation()

  const station = resolveStationDef(displayedRoute)
  const pluginPage = parsePluginPageRoute(displayedRoute)

  const headerLabel = pluginPage
    ? `PLUGIN · ${pluginPage.pluginId.toUpperCase()}`
    : (station?.label ?? 'COURT · OVERVIEW')
  const headerTitle = pluginPage ? '插件' : (station?.title ?? '总览')

  const emptyGlyph = pluginPage
    ? '印'
    : STAGE2_STATION_COPY[station?.id ?? 'court'].glyph
  const emptyDesc = pluginPage
    ? `插件页面 ${pluginPage.pluginId} / ${pluginPage.pageId} 将在阶段 3 挂载隔离沙箱 iframe。`
    : STAGE2_STATION_COPY[station?.id ?? 'court'].description

  const nextStation = useMemo(() => {
    const currentId = station?.id ?? 'court'
    const idx = STATIONS.findIndex((s) => s.id === currentId)
    return STATIONS[(idx + 1) % STATIONS.length] ?? STATIONS[0]!
  }, [station])

  const handleJump = useCallback(
    (targetId: StationId, event: ReactMouseEvent<HTMLButtonElement>) => {
      const rect = event.currentTarget.getBoundingClientRect()
      navigate(targetId, {
        x: rect.left + rect.width * 0.5,
        y: rect.top + rect.height * 0.5,
      })
    },
    [navigate],
  )

  return (
    <div style={STATION_GRID_STYLE}>
      {renderTopBanner ? <div style={FULL_SPAN_STYLE}>{renderTopBanner(transitionCount)}</div> : null}

      <div style={FULL_SPAN_STYLE}>
        <PageHeader
          label={headerLabel}
          title={headerTitle}
          actions={
            <div className="flex items-center gap-3">
              <BrushButton
                variant="secondary"
                size="sm"
                onClick={(e) => handleJump(nextStation.id, e)}
              >
                前往「{nextStation.title}」
              </BrushButton>
            </div>
          }
        />
      </div>

      <div style={FULL_SPAN_STYLE}>
        <Plate level="base" style={{ padding: 'var(--sp-6)', border: '1px solid var(--hair)' }}>
          <EmptyState
            glyph={emptyGlyph}
            description={emptyDesc}
            action={
              <div style={QUICK_JUMP_ROW_STYLE}>
                {STATIONS.map((item) => {
                  const isCurrent = item.id === (station?.id ?? 'court')
                  return (
                    <BrushButton
                      key={item.id}
                      variant={isCurrent ? 'primary' : 'secondary'}
                      size="sm"
                      disabled={isCurrent}
                      onClick={(e) => handleJump(item.id, e)}
                    >
                      {item.glyph} · {item.title}
                    </BrushButton>
                  )
                })}
              </div>
            }
          />
        </Plate>
      </div>
    </div>
  )
}

function AuthenticatedConsole({ onSignOut }: { readonly onSignOut: () => void }) {
  return (
    <ConsoleShell onSignOut={onSignOut}>
      <ConsolePage />
    </ConsoleShell>
  )
}

function ConsolePage() {
  const { displayedRoute } = useShellNavigation()
  const pluginPage = parsePluginPageRoute(displayedRoute)
  const station = resolveStationDef(displayedRoute)
  const Page = STATION_PAGES[station?.id ?? 'court']

  return (
    <Suspense fallback={<InkSkeleton height={140} />}>
      {pluginPage ? (
        <PluginPage pluginId={pluginPage.pluginId} pageId={pluginPage.pageId} />
      ) : <Page />}
    </Suspense>
  )
}

interface DevAppRouterProps {
  readonly route: string
  readonly authenticated: boolean
  readonly onAuthenticated: (info: { readonly roleCardName: string | null }) => void
  readonly onSignOut: () => void
}

function DevAppRouter({
  route,
  authenticated,
  onAuthenticated,
  onSignOut,
}: DevAppRouterProps) {
  const [devRehearsal, setDevRehearsal] = useState<DevRehearsalMode>('off')
  const [rehearsalRoleCardName, setRehearsalRoleCardName] = useState<string | null>(null)
  const isDevRoute = route.startsWith('dev/')

  useEffect(() => {
    if (devRehearsal !== 'off' && isDevRoute) {
      setRehearsalRoleCardName(null)
      setDevRehearsal('off')
    }
  }, [devRehearsal, isDevRoute])

  const handleStartRehearsal = useCallback(() => {
    // Keep the workbench in browser history so Back can leave the rehearsal.
    if (inktideStore.getSnapshot().route.startsWith('dev/')) {
      inktideStore.setRoute('court')
    }
    setRehearsalRoleCardName(null)
    setDevRehearsal('gate')
  }, [])

  const handleRehearsalAuthenticated = useCallback(
    (info: { readonly roleCardName: string | null }) => {
      setRehearsalRoleCardName(info.roleCardName ?? '小鲸鱼')
      inktideStore.setRoute('court')
      setDevRehearsal('shell')
    },
    [],
  )

  const handleExitRehearsal = useCallback(() => {
    setRehearsalRoleCardName(null)
    setDevRehearsal('off')
    inktideStore.setRoute('dev/ui')
  }, [])

  const demoAuthenticator = useCallback(
    async (candidate: string): Promise<GateDemoAuthResult> => {
      if (candidate === DEMO_REHEARSAL_TOKEN) {
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, DEMO_THINKING_MS)
        })
        return { ok: true, roleCardName: '小鲸鱼' }
      }
      return { ok: false, message: '令牌不对' }
    },
    [],
  )

  if (!isDevRoute && devRehearsal === 'gate') {
    return (
      <GatePage
        onAuthenticated={handleRehearsalAuthenticated}
        demoAuthenticator={demoAuthenticator}
        demoHint={`演练令牌：${DEMO_REHEARSAL_TOKEN}（其他任意输入演示失败抖动）`}
        onExitDemo={handleExitRehearsal}
      />
    )
  }

  if (!isDevRoute && devRehearsal === 'shell') {
    return (
      <ConsoleShell
        onSignOut={handleStartRehearsal}
        rehearsal
        rehearsalRoleCardName={rehearsalRoleCardName}
      >
        <StationRehearsalView
          renderTopBanner={(transitionCount) => (
            <Plate level="raised" style={REHEARSAL_BAR_STYLE}>
              <div className="flex flex-wrap items-center gap-3">
                <Badge tone="zhusha">阶段 2 演练态</Badge>
                <span
                  className="num"
                  style={{
                    fontSize: 'var(--fs-small)',
                    lineHeight: 'var(--lh-small)',
                    color: 'var(--text-2)',
                  }}
                >
                  已完成泼墨转场：{transitionCount} 次 · 可按 ⌘K / Ctrl+K 打开「砚」
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <BrushButton
                  variant="secondary"
                  size="sm"
                  onClick={handleStartRehearsal}
                >
                  再试登录落款
                </BrushButton>
                <BrushButton
                  variant="primary"
                  size="sm"
                  onClick={handleExitRehearsal}
                >
                  返回 #dev/ui
                </BrushButton>
              </div>
            </Plate>
          )}
        />
      </ConsoleShell>
    )
  }

  if (route === 'dev/tokens' && DevTokensPage !== null) {
    return (
      <Suspense fallback={null}>
        <DevTokensPage />
      </Suspense>
    )
  }

  if (route === 'dev/ink' && DevInkPage !== null) {
    return (
      <Suspense fallback={null}>
        <DevInkPage />
      </Suspense>
    )
  }

  if (route === 'dev/ui' && DevUiPage !== null) {
    return (
      <Suspense fallback={null}>
        <DevUiPage onStartRehearsal={handleStartRehearsal} />
      </Suspense>
    )
  }

  if (!authenticated) {
    return <GatePage onAuthenticated={onAuthenticated} />
  }

  return <AuthenticatedConsole onSignOut={onSignOut} />
}

export function App() {
  const route = useInktideStore((s) => s.route)
  const authenticated = useInktideStore((s) => s.authenticated)

  useEffect(() => {
    inktideStore.setAuthenticated(hasAuthToken())
    return onAuthExpired(() => {
      clearAuthToken()
      inktideStore.setAuthenticated(false)
      inktideStore.setRoleCardName(null)
      toast.warn('会话令牌已失效，请重新落款', { code: 'UNAUTHENTICATED' })
    })
  }, [])

  const handleAuthenticated = useCallback(
    (info: { readonly roleCardName: string | null }) => {
      inktideStore.setRoleCardName(info.roleCardName)
      inktideStore.setAuthenticated(true)
      const current = inktideStore.getSnapshot().route
      if (current === '' || (import.meta.env.DEV && current.startsWith('dev/'))) {
        inktideStore.setRoute('court')
      }
    },
    [],
  )

  const handleSignOut = useCallback(() => {
    clearAuthToken()
    inktideStore.setAuthenticated(false)
    inktideStore.setRoleCardName(null)
  }, [])

  return (
    <LayoutGroup>
      <BrushCursor />
      <SealToastStack />
      {import.meta.env.DEV ? (
        <DevAppRouter
          route={route}
          authenticated={authenticated}
          onAuthenticated={handleAuthenticated}
          onSignOut={handleSignOut}
        />
      ) : authenticated ? (
        <AuthenticatedConsole onSignOut={handleSignOut} />
      ) : (
        <GatePage onAuthenticated={handleAuthenticated} />
      )}
    </LayoutGroup>
  )
}
