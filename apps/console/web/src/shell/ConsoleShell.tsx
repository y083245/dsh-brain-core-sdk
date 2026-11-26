import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  accountingApi,
  hasAuthToken,
  memoryApi,
  pluginsApi,
  satelliteApi,
} from '../api/client.ts'
import type {
  AccountingSummary,
  ConsolePageItem,
  CrossChannelMode,
  L3ProfileVersionSummary,
  PluginsListResponse,
  SatelliteSnapshot,
} from '../api/types.ts'
import { COURT_POLL_INTERVALS, POLL_INTERVALS, usePolling } from '../data/polling.ts'
import { useInktideStore } from '../data/store.ts'
import type { EnsoState } from '../ink/engine.ts'
import { useInk } from '../ink/InkProvider.tsx'
import { useMotionLevel } from '../motion/useMotionLevel.ts'
import { fetchRecentMemoryTail } from '../pages/court/memoryTail.ts'
import { CommandInk, type CommandInkAction } from './CommandInk.tsx'
import {
  PageTransitionProvider,
  PageTransitionStage,
  useShellNavigation,
} from './PageTransition.tsx'
import { Rail } from './Rail.tsx'
import { parsePluginPageRoute, resolveStationDef } from './routes.ts'
import { StatusBar } from './StatusBar.tsx'
import { TopBar } from './TopBar.tsx'

export interface ConsoleShellData {
  readonly satellite: SatelliteSnapshot | undefined
  readonly satelliteError: unknown
  readonly accounting: AccountingSummary | undefined
  readonly accountingError: unknown
  readonly accountingDays: AccountingDays
  readonly plugins: PluginsListResponse | undefined
  readonly pluginsError: unknown
  readonly pluginPages: readonly ConsolePageItem[]
  readonly pluginPagesError: unknown
  readonly pluginPagesLoading: boolean
  readonly crossChannelMode: CrossChannelMode | undefined
  readonly l3Versions: readonly L3ProfileVersionSummary[]
  readonly l3VersionsError: unknown
  readonly l3Version: number | null
  readonly setAccountingDays: (days: AccountingDays) => void
  readonly refreshSatellite: () => Promise<SatelliteSnapshot | undefined>
  readonly refreshAccounting: () => Promise<AccountingSummary | undefined>
  readonly refreshPlugins: () => Promise<PluginsListResponse | undefined>
  readonly refreshPluginPages: () => Promise<readonly ConsolePageItem[] | undefined>
  readonly refreshCrossChannelMode: () => Promise<CrossChannelMode | undefined>
  readonly refreshL3Versions: () => Promise<readonly L3ProfileVersionSummary[] | undefined>
  readonly refreshAll: () => void
  readonly openCommandPalette: () => void
  readonly observeMemoryRecords: (
    records: readonly { readonly id: string }[],
    options?: { readonly splat?: boolean },
  ) => void
  readonly notifyNewMemory: (recordId: string) => void
}

export type AccountingDays = 7 | 14 | 30

const ConsoleShellDataContext = createContext<ConsoleShellData | null>(null)

export function useConsoleShellData(): ConsoleShellData {
  const ctx = useContext(ConsoleShellDataContext)
  if (ctx === null) {
    throw new Error('useConsoleShellData must be used within a ConsoleShell')
  }
  return ctx
}

export interface ConsoleShellProps {
  readonly children: ReactNode
  readonly onSignOut?: () => void
  readonly ensoState?: EnsoState
  readonly extraActions?: readonly CommandInkAction[]
  readonly rehearsal?: boolean
  readonly rehearsalRoleCardName?: string | null
}

function readViewportWidth(): number {
  if (typeof window === 'undefined') return 1440
  return window.innerWidth
}

function useViewportWidth(): number {
  const [width, setWidth] = useState<number>(readViewportWidth)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onResize = (): void => {
      setWidth(window.innerWidth)
    }
    window.addEventListener('resize', onResize, { passive: true })
    return () => {
      window.removeEventListener('resize', onResize)
    }
  }, [])

  return width
}

function deriveEnsoState(satellite?: SatelliteSnapshot): EnsoState {
  const chat = satellite?.processes.chat
  if (!chat) return 'idle'
  if (chat.recoveryPhase === 'restarting') return 'recovering'
  switch (chat.status) {
    case 'crashed':
    case 'failed':
      return 'error'
    case 'starting':
      return 'recovering'
    case 'stopped':
      return 'offline'
    case 'running':
    case 'idle':
    case 'stopping':
    default:
      return 'idle'
  }
}

function deriveCurrentL3Version(
  versions: readonly L3ProfileVersionSummary[] | undefined,
): number | null {
  if (!versions || versions.length === 0) return null
  const active = versions.find((v) => v.current)
  if (active !== undefined) return active.version
  let highest = versions[0]!.version
  for (const item of versions) {
    if (item.version > highest) highest = item.version
  }
  return highest
}

function resolveRouteLabel(
  route: string,
  pluginPages: readonly ConsolePageItem[],
): string {
  const station = resolveStationDef(route)
  if (station !== undefined) return station.label

  const pluginMatch = parsePluginPageRoute(route)
  if (pluginMatch !== null) {
    const matched = pluginPages.find(
      (page) =>
        page.pluginId === pluginMatch.pluginId && page.id === pluginMatch.pageId,
    )
    if (matched !== undefined) {
      return `${matched.pluginId.toUpperCase()} · ${matched.title}`
    }
    return `PLUGIN · ${pluginMatch.pluginId.toUpperCase()}`
  }

  return route.trim() === '' ? 'COURT · OVERVIEW' : route.toUpperCase()
}

const EMPTY_PLUGIN_PAGES: readonly ConsolePageItem[] = []
const EMPTY_L3_VERSIONS: readonly L3ProfileVersionSummary[] = []

function ConsoleShellInner({
  children,
  onSignOut,
  ensoState,
  extraActions,
  rehearsal = false,
  rehearsalRoleCardName = null,
}: ConsoleShellProps) {
  const { displayedRoute, targetRoute, navigate } = useShellNavigation()
  const displayedStation = resolveStationDef(displayedRoute)?.id
  const activeRailRoute = targetRoute.split('?')[0] ?? targetRoute
  const authenticated = useInktideStore((s) => s.authenticated)
  const roleCardName = useInktideStore((s) => s.roleCardName)
  const themeMode = useInktideStore((s) => s.themeMode)
  const resolvedTheme = useInktideStore((s) => s.resolvedTheme)

  const viewportWidth = useViewportWidth()
  const isCompact = viewportWidth < 1024
  const horizontalPadding =
    viewportWidth >= 1440
      ? 'var(--sp-8)'
      : viewportWidth >= 1100
        ? 'var(--sp-6)'
        : '20px'

  const [commandOpen, setCommandOpen] = useState(false)
  const [accountingDays, setAccountingDays] = useState<AccountingDays>(7)
  const previousAccountingDays = useRef(accountingDays)

  const ink = useInk()
  const motionLevel = useMotionLevel()
  const seenMemoryIdsRef = useRef<Set<string> | null>(null)
  const preSeedNotifiedRef = useRef<Set<string>>(new Set())
  const displayedStationRef = useRef(displayedStation)
  displayedStationRef.current = displayedStation
  const motionLevelRef = useRef(motionLevel)
  motionLevelRef.current = motionLevel

  // Only poll backend APIs when authenticated with an in-memory bearer token
  const pollingEnabled = !rehearsal && authenticated && hasAuthToken()

  useEffect(() => {
    if (!pollingEnabled) {
      seenMemoryIdsRef.current = null
      preSeedNotifiedRef.current.clear()
    }
  }, [pollingEnabled])

  const splatMemoryStation = useCallback((): void => {
    if (displayedStationRef.current === 'memory') return
    if (motionLevelRef.current !== 'full') return
    if (typeof document === 'undefined') return
    const target = document.querySelector<HTMLElement>('[data-station="memory"]')
    if (target === null) return
    const rect = target.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    ink.splat({
      x: rect.left + rect.width * 0.5,
      y: rect.top + rect.height * 0.5,
      radius: 40,
      amount: 0.25,
      color: 'smoke',
    })
  }, [ink])

  const observeMemoryRecords = useCallback(
    (
      records: readonly { readonly id: string }[],
      options?: { readonly splat?: boolean },
    ): void => {
      if (options?.splat === false && records.length === 0) return
      if (seenMemoryIdsRef.current === null) {
        const seeded = new Set(records.map((record) => record.id))
        for (const id of preSeedNotifiedRef.current) seeded.add(id)
        preSeedNotifiedRef.current.clear()
        seenMemoryIdsRef.current = seeded
        return
      }
      let hasNew = false
      for (const record of records) {
        if (!seenMemoryIdsRef.current.has(record.id)) {
          seenMemoryIdsRef.current.add(record.id)
          hasNew = true
        }
      }
      if (hasNew && options?.splat !== false) {
        splatMemoryStation()
      }
    },
    [splatMemoryStation],
  )

  const notifyNewMemory = useCallback(
    (recordId: string): void => {
      if (recordId === '') return
      if (seenMemoryIdsRef.current !== null) {
        if (seenMemoryIdsRef.current.has(recordId)) return
        seenMemoryIdsRef.current.add(recordId)
        splatMemoryStation()
        return
      }
      if (preSeedNotifiedRef.current.has(recordId)) return
      preSeedNotifiedRef.current.add(recordId)
      splatMemoryStation()
    },
    [splatMemoryStation],
  )

  const satellitePoll = usePolling(
    () => satelliteApi.snapshot(),
    displayedStation === 'pulse'
      ? POLL_INTERVALS.satelliteActivePulseMs
      : POLL_INTERVALS.satelliteActiveOtherMs,
    { enabled: pollingEnabled },
  )

  const accountingPoll = usePolling(
    () => accountingApi.summary(accountingDays),
    displayedStation === 'ledger' || displayedStation === 'court'
      ? POLL_INTERVALS.accountingActiveMs
      : POLL_INTERVALS.accountingBackgroundMs,
    { enabled: pollingEnabled },
  )

  useEffect(() => {
    if (previousAccountingDays.current === accountingDays) return
    previousAccountingDays.current = accountingDays
    if (pollingEnabled) void accountingPoll.refresh()
  }, [accountingDays, accountingPoll.refresh, pollingEnabled])

  const pluginsPoll = usePolling(
    () => pluginsApi.list(),
    displayedStation === 'seals'
      ? POLL_INTERVALS.pluginsActiveMs
      : displayedStation === 'court'
        ? COURT_POLL_INTERVALS.pluginsMs
        : POLL_INTERVALS.pluginsBackgroundMs,
    { enabled: pollingEnabled },
  )

  const pluginPagesPoll = usePolling(
    () => pluginsApi.pages(),
    POLL_INTERVALS.pluginsBackgroundMs,
    { enabled: pollingEnabled },
  )

  const crossChannelPoll = usePolling(
    () => memoryApi.getCrossChannelMode(),
    displayedStation === 'memory'
      ? POLL_INTERVALS.memoryActiveMs
      : POLL_INTERVALS.accountingBackgroundMs,
    { enabled: pollingEnabled },
  )

  const l3VersionsPoll = usePolling(
    () => memoryApi.listL3Versions(),
    displayedStation === 'heart'
      ? POLL_INTERVALS.proposalsActiveMs
      : POLL_INTERVALS.proposalsBackgroundMs,
    { enabled: pollingEnabled },
  )

  // Low-frequency tail-cursor observation when away from court (which already polls at 10s)
  // and away from memory (which handles in-page splat itself).
  usePolling(
    (signal) => fetchRecentMemoryTail(signal),
    POLL_INTERVALS.accountingActiveMs,
    {
      enabled: pollingEnabled && displayedStation !== 'court' && displayedStation !== 'memory',
      onData: (tail) => observeMemoryRecords(tail.tailRecords),
    },
  )

  const refreshAll = useCallback((): void => {
    void satellitePoll.refresh()
    void accountingPoll.refresh()
    void pluginsPoll.refresh()
    void pluginPagesPoll.refresh()
    void crossChannelPoll.refresh()
    void l3VersionsPoll.refresh()
  }, [
    accountingPoll,
    crossChannelPoll,
    l3VersionsPoll,
    pluginPagesPoll,
    pluginsPoll,
    satellitePoll,
  ])

  // Global ⌘K / Ctrl+K shortcut for CommandInk
  useEffect(() => {
    if (typeof window === 'undefined') return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCommandOpen((prev) => !prev)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  const pluginPages = pluginPagesPoll.data ?? EMPTY_PLUGIN_PAGES
  const l3Versions = l3VersionsPoll.data ?? EMPTY_L3_VERSIONS
  const l3Version = useMemo(() => deriveCurrentL3Version(l3Versions), [l3Versions])

  const resolvedEnsoState = ensoState ?? deriveEnsoState(satellitePoll.data)
  const routeLabel = useMemo(
    () => resolveRouteLabel(displayedRoute, pluginPages),
    [displayedRoute, pluginPages],
  )

  const commandActions = useMemo<readonly CommandInkAction[]>(() => {
    const list: CommandInkAction[] = [...(extraActions ?? [])]
    if (onSignOut !== undefined) {
      list.push({
        id: 'sign-out',
        label: '清空内存令牌并退出',
        description: '回到落款开印页',
        keywords: ['logout', 'signout', 'token', '退出', '令牌'],
        shortcut: 'GATE',
        onSelect: onSignOut,
      })
    }
    return list
  }, [extraActions, onSignOut])

  const openCommandPalette = useCallback((): void => {
    setCommandOpen(true)
  }, [])

  const shellData = useMemo<ConsoleShellData>(
    () => ({
      satellite: satellitePoll.data,
      satelliteError: satellitePoll.error,
      accounting: accountingPoll.data,
      accountingError: accountingPoll.error,
      accountingDays,
      plugins: pluginsPoll.data,
      pluginsError: pluginsPoll.error,
      pluginPages,
      pluginPagesError: pluginPagesPoll.error,
      pluginPagesLoading: pluginPagesPoll.loading,
      crossChannelMode: crossChannelPoll.data,
      l3Versions,
      l3VersionsError: l3VersionsPoll.error,
      l3Version,
      setAccountingDays,
      refreshSatellite: satellitePoll.refresh,
      refreshAccounting: accountingPoll.refresh,
      refreshPlugins: pluginsPoll.refresh,
      refreshPluginPages: pluginPagesPoll.refresh,
      refreshCrossChannelMode: crossChannelPoll.refresh,
      refreshL3Versions: l3VersionsPoll.refresh,
      refreshAll,
      openCommandPalette,
      observeMemoryRecords,
      notifyNewMemory,
    }),
    [
      accountingDays,
      accountingPoll.data,
      accountingPoll.error,
      accountingPoll.refresh,
      crossChannelPoll.data,
      crossChannelPoll.refresh,
      l3Version,
      l3Versions,
      l3VersionsPoll.error,
      l3VersionsPoll.refresh,
      notifyNewMemory,
      observeMemoryRecords,
      openCommandPalette,
      pluginPages,
      pluginPagesPoll.error,
      pluginPagesPoll.loading,
      pluginPagesPoll.refresh,
      pluginsPoll.data,
      pluginsPoll.error,
      pluginsPoll.refresh,
      refreshAll,
      satellitePoll.data,
      satellitePoll.error,
      satellitePoll.refresh,
    ],
  )

  return (
    <ConsoleShellDataContext.Provider value={shellData}>
      <div
        data-console-shell="true"
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          paddingLeft: isCompact ? 0 : 'var(--rail-w)',
          paddingBottom: isCompact
            ? 'calc(var(--statusbar-h) + 56px)'
            : 'var(--statusbar-h)',
        }}
      >
        <Rail
          activeRoute={activeRailRoute}
          roleCardName={rehearsal ? rehearsalRoleCardName : roleCardName}
          ensoState={resolvedEnsoState}
          pluginPages={pluginPages}
          onNavigate={navigate}
          compact={isCompact}
        />

        <TopBar
          routeLabel={routeLabel}
          themeMode={themeMode}
          resolvedTheme={resolvedTheme}
          satellite={satellitePoll.data}
          onOpenCommand={openCommandPalette}
          onNavigate={navigate}
          horizontalPadding={horizontalPadding}
        />

        <main
          data-shell-main="true"
          style={{
            flex: 1,
            minWidth: 0,
            paddingLeft: horizontalPadding,
            paddingRight: horizontalPadding,
            paddingTop: 'var(--sp-5)',
            paddingBottom: 'var(--sp-8)',
            display: 'grid',
            gridTemplateColumns: viewportWidth <= 1024
              ? 'repeat(8, minmax(0, 1fr))'
              : 'repeat(12, minmax(0, 1fr))',
            columnGap: 'var(--sp-5)',
            alignContent: 'start',
          }}
        >
          <PageTransitionStage style={{ gridColumn: '1 / -1', minWidth: 0 }}>
            {children}
          </PageTransitionStage>
        </main>

        <StatusBar
          satellite={satellitePoll.data}
          accounting={accountingPoll.data}
          crossChannelMode={crossChannelPoll.data}
          l3Version={l3Version}
          onNavigate={navigate}
        />

        <CommandInk
          open={commandOpen}
          rehearsal={rehearsal}
          onClose={() => setCommandOpen(false)}
          onNavigate={navigate}
          plugins={pluginsPoll.data?.plugins}
          actions={commandActions}
          crossChannelMode={crossChannelPoll.data}
          chatProcess={satellitePoll.data?.processes.chat}
          onRefreshShellData={refreshAll}
        />
      </div>
    </ConsoleShellDataContext.Provider>
  )
}

export function ConsoleShell(props: ConsoleShellProps) {
  return (
    <PageTransitionProvider>
      <ConsoleShellInner {...props} />
    </PageTransitionProvider>
  )
}
