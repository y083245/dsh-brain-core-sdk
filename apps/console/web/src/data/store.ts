import { useSyncExternalStore } from 'react'
import type { MotionLevel, QualityTier } from '../motion/tokens.ts'

export type ThemeMode = 'auto' | 'night' | 'paper'
export type ResolvedInktideTheme = 'night' | 'paper'
export type QualityPreference = 'auto' | QualityTier
export type CursorMode = 'brush' | 'system'

export interface InktideState {
  readonly authenticated: boolean
  readonly roleCardName: string | null
  readonly themeMode: ThemeMode
  readonly resolvedTheme: ResolvedInktideTheme
  readonly motionPreference: MotionLevel
  readonly qualityPreference: QualityPreference
  readonly cursorMode: CursorMode
  readonly soundEnabled: boolean
  readonly route: string
}

const LEGACY_ROUTE_MAP: Readonly<Record<string, string>> = {
  overview: 'court',
  chat: 'voice',
  memory: 'memory',
  telemetry: 'pulse',
  plugins: 'seals',
  settings: 'settings',
}

export function normalizeRoute(rawHash: string): string {
  const cleaned = rawHash.replace(/^#/, '').trim()
  if (cleaned === '') return 'court'
  return LEGACY_ROUTE_MAP[cleaned] ?? cleaned
}

export function resolveInktideTheme(mode: ThemeMode): ResolvedInktideTheme {
  if (mode === 'night' || mode === 'paper') return mode
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'paper' : 'night'
  }
  return 'night'
}

function readRouteFromWindow(): string {
  if (typeof window === 'undefined') return 'court'
  return normalizeRoute(window.location.hash)
}

function createInitialState(): InktideState {
  const themeMode: ThemeMode = 'auto'
  return {
    authenticated: false,
    roleCardName: null,
    themeMode,
    resolvedTheme: resolveInktideTheme(themeMode),
    motionPreference: 'full',
    qualityPreference: 'auto',
    cursorMode: 'brush',
    soundEnabled: false,
    route: readRouteFromWindow(),
  }
}

let state: InktideState = createInitialState()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

function updateState(patch: Partial<InktideState>): void {
  let changed = false
  for (const key of Object.keys(patch) as (keyof InktideState)[]) {
    if (!Object.is(state[key], patch[key])) {
      changed = true
      break
    }
  }
  if (!changed) return
  state = { ...state, ...patch }
  emit()
}

function applyThemeToDocument(): void {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', state.resolvedTheme)
  }
}

function setThemeMode(mode: ThemeMode): void {
  const resolvedTheme = resolveInktideTheme(mode)
  updateState({ themeMode: mode, resolvedTheme })
  applyThemeToDocument()
}

const THEME_CYCLE: Readonly<Record<ThemeMode, ThemeMode>> = {
  night: 'paper',
  paper: 'auto',
  auto: 'night',
}

function cycleThemeMode(): ThemeMode {
  const next = THEME_CYCLE[state.themeMode]
  setThemeMode(next)
  return next
}

function setRoute(nextRoute: string): void {
  const normalized = normalizeRoute(nextRoute)
  if (typeof window !== 'undefined') {
    const currentNormalized = normalizeRoute(window.location.hash)
    const targetHash = `#${normalized}`
    if (currentNormalized !== normalized || window.location.hash !== targetHash) {
      window.location.hash = targetHash
    }
  }
  updateState({ route: normalized })
}

function initSystemListeners(): () => void {
  applyThemeToDocument()
  if (typeof window === 'undefined') {
    return () => {}
  }

  updateState({
    route: readRouteFromWindow(),
    resolvedTheme: resolveInktideTheme(state.themeMode),
  })
  applyThemeToDocument()

  const handleHashChange = (): void => {
    updateState({ route: readRouteFromWindow() })
  }
  window.addEventListener('hashchange', handleHashChange)

  let detachColorScheme: (() => void) | undefined
  if (typeof window.matchMedia === 'function') {
    const mql = window.matchMedia('(prefers-color-scheme: light)')
    const handleColorSchemeChange = (): void => {
      if (state.themeMode !== 'auto') return
      const resolvedTheme: ResolvedInktideTheme = mql.matches ? 'paper' : 'night'
      updateState({ resolvedTheme })
      applyThemeToDocument()
    }
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', handleColorSchemeChange)
      detachColorScheme = () => mql.removeEventListener('change', handleColorSchemeChange)
    } else if (typeof mql.addListener === 'function') {
      mql.addListener(handleColorSchemeChange)
      detachColorScheme = () => mql.removeListener(handleColorSchemeChange)
    }
  }

  let cleaned = false
  return () => {
    if (cleaned) return
    cleaned = true
    window.removeEventListener('hashchange', handleHashChange)
    detachColorScheme?.()
  }
}

function reset(): void {
  state = createInitialState()
  applyThemeToDocument()
  emit()
}

export const inktideStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },

  getSnapshot(): InktideState {
    return state
  },

  setAuthenticated(authenticated: boolean): void {
    updateState({ authenticated })
  },

  setRoleCardName(roleCardName: string | null): void {
    updateState({ roleCardName })
  },

  setThemeMode,
  cycleThemeMode,

  setMotionPreference(motionPreference: MotionLevel): void {
    updateState({ motionPreference })
  },

  setQualityPreference(qualityPreference: QualityPreference): void {
    updateState({ qualityPreference })
  },

  setCursorMode(cursorMode: CursorMode): void {
    updateState({ cursorMode })
  },

  setSoundEnabled(soundEnabled: boolean): void {
    updateState({ soundEnabled })
  },

  setRoute,
  applyThemeToDocument,
  initSystemListeners,
  reset,
} as const

export function useInktideStore(): InktideState
export function useInktideStore<T>(selector: (snapshot: InktideState) => T): T
export function useInktideStore<T = InktideState>(
  selector?: (snapshot: InktideState) => T,
): T | InktideState {
  const snapshot = useSyncExternalStore(
    inktideStore.subscribe,
    inktideStore.getSnapshot,
    inktideStore.getSnapshot,
  )
  return selector === undefined ? snapshot : selector(snapshot)
}
