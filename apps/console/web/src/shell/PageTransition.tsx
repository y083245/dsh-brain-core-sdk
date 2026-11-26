import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { motion } from 'motion/react'
import { inktideStore, normalizeRoute, useInktideStore } from '../data/store.ts'
import { useInk } from '../ink/InkProvider.tsx'
import { getPreset, REDUCED_TRANSITION_DURATION } from '../motion/presets.ts'
import { EASE } from '../motion/tokens.ts'
import { getMotionLevel, useMotionLevel } from '../motion/useMotionLevel.ts'
import { playFlood } from '../sound/synth.ts'

export interface NavigationOrigin {
  readonly x: number
  readonly y: number
}

export interface ShellNavigationValue {
  readonly displayedRoute: string
  readonly targetRoute: string
  readonly isTransitioning: boolean
  readonly transitionCount: number
  readonly navigate: (nextRoute: string, origin?: NavigationOrigin) => void
}

export const ShellNavigationContext = createContext<ShellNavigationValue | null>(null)

export function useShellNavigation(): ShellNavigationValue {
  const ctx = useContext(ShellNavigationContext)
  if (ctx === null) {
    throw new Error('useShellNavigation must be used within a PageTransitionProvider')
  }
  return ctx
}

function isDataDenseCalmRoute(route: string): boolean {
  const base = normalizeRoute(route).split(/[/?]/)[0] ?? ''
  return base === 'memory'
}

function getPageKey(route: string): string {
  return route.split('?')[0] ?? route
}

function getViewportCenter(): NavigationOrigin {
  if (typeof window === 'undefined') {
    return { x: 0, y: 0 }
  }
  return {
    x: window.innerWidth * 0.5,
    y: window.innerHeight * 0.5,
  }
}

export interface PageTransitionProviderProps {
  readonly children: ReactNode
}

export function PageTransitionProvider({ children }: PageTransitionProviderProps) {
  const ink = useInk()
  const storeRoute = useInktideStore((s) => s.route)

  const [displayedRoute, setDisplayedRoute] = useState<string>(storeRoute)
  const [targetRoute, setTargetRoute] = useState<string>(storeRoute)
  const [isTransitioning, setIsTransitioning] = useState<boolean>(false)
  const [transitionCount, setTransitionCount] = useState(0)
  const memoryPageDisplayed = isDataDenseCalmRoute(displayedRoute)

  const navSeqRef = useRef<number>(0)
  const mountedRef = useRef<boolean>(true)
  const timerRef = useRef<number | null>(null)
  const internalCommitRef = useRef<string | null>(null)
  const calmOwnedRef = useRef<boolean>(false)
  const stateRef = useRef<{ displayed: string; target: string }>({
    displayed: storeRoute,
    target: storeRoute,
  })

  stateRef.current = { displayed: displayedRoute, target: targetRoute }

  const clearPendingTimer = useCallback((): void => {
    if (timerRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearPendingTimer()
    }
  }, [clearPendingTimer])

  // §8.4: Data-dense views (memory) automatically engage calm ink mode without
  // overriding calm state owned by other non-memory surfaces.
  useEffect(() => {
    if (memoryPageDisplayed) {
      ink.setCalm(true)
      calmOwnedRef.current = true
    } else if (calmOwnedRef.current) {
      ink.setCalm(false)
      calmOwnedRef.current = false
    }
  }, [ink, memoryPageDisplayed])

  useEffect(() => {
    return () => {
      if (calmOwnedRef.current) {
        ink.setCalm(false)
        calmOwnedRef.current = false
      }
    }
  }, [ink])

  const startTransition = useCallback(
    (nextRoute: string, origin: NavigationOrigin | undefined, commitStore: boolean): void => {
      const normalized = normalizeRoute(nextRoute)
      if (
        normalized === stateRef.current.target &&
        normalized === stateRef.current.displayed
      ) {
        return
      }

      clearPendingTimer()
      navSeqRef.current += 1
      const seq = navSeqRef.current

      setTargetRoute(normalized)

      // Dev routes and selections within the same page do not flood.
      if (
        normalized.startsWith('dev/') ||
        stateRef.current.displayed.startsWith('dev/') ||
        getPageKey(normalized) === getPageKey(stateRef.current.displayed)
      ) {
        if (commitStore) {
          internalCommitRef.current = normalized
          inktideStore.setRoute(normalized)
        }
        setDisplayedRoute(normalized)
        setIsTransitioning(false)
        return
      }

      setIsTransitioning(true)

      const finish = (): void => {
        if (!mountedRef.current || navSeqRef.current !== seq) return
        if (commitStore) {
          internalCommitRef.current = normalized
          inktideStore.setRoute(normalized)
        }
        if (normalized !== stateRef.current.displayed) {
          setTransitionCount((count) => count + 1)
        }
        setDisplayedRoute(normalized)
        setIsTransitioning(false)
      }

      if (getMotionLevel() === 'reduced') {
        const delayMs = Math.round(REDUCED_TRANSITION_DURATION * 1000)
        if (typeof window === 'undefined') {
          finish()
          return
        }
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null
          finish()
        }, delayMs)
        return
      }

      const center = getViewportCenter()
      const x = origin !== undefined && Number.isFinite(origin.x) ? origin.x : center.x
      const y = origin !== undefined && Number.isFinite(origin.y) ? origin.y : center.y
      const color = normalized === 'seals' ? 'zhusha' : 'smoke'

      playFlood()
      void ink.flood({ x, y, color }).then(finish, finish)
    },
    [clearPendingTimer, ink],
  )

  const navigate = useCallback(
    (nextRoute: string, origin?: NavigationOrigin): void => {
      startTransition(nextRoute, origin, true)
    },
    [startTransition],
  )

  // Synchronize external store.route changes (e.g. browser Back/Forward hashchange)
  useEffect(() => {
    if (internalCommitRef.current === storeRoute) {
      internalCommitRef.current = null
      return
    }
    if (
      storeRoute === stateRef.current.target &&
      storeRoute === stateRef.current.displayed
    ) {
      return
    }
    startTransition(storeRoute, undefined, false)
  }, [startTransition, storeRoute])

  const value = useMemo<ShellNavigationValue>(
    () => ({
      displayedRoute,
      targetRoute,
      isTransitioning,
      transitionCount,
      navigate,
    }),
    [displayedRoute, targetRoute, isTransitioning, transitionCount, navigate],
  )

  return (
    <ShellNavigationContext.Provider value={value}>
      {children}
    </ShellNavigationContext.Provider>
  )
}

export interface PageTransitionStageProps {
  readonly children: ReactNode
  readonly className?: string
  readonly style?: CSSProperties
}

export function PageTransitionStage({
  children,
  className,
  style,
}: PageTransitionStageProps) {
  const { displayedRoute, isTransitioning } = useShellNavigation()
  const motionLevel = useMotionLevel()

  const stageVariants = useMemo(() => {
    const base = getPreset('bloom', motionLevel)
    if (motionLevel === 'reduced') {
      return {
        ...base,
        animate: {
          opacity: 1,
          filter: 'none',
          transition: {
            duration: REDUCED_TRANSITION_DURATION,
            ease: EASE.settle,
          },
        },
        exit: {
          opacity: 0,
          filter: 'none',
          transition: {
            duration: REDUCED_TRANSITION_DURATION,
            ease: EASE.settle,
          },
        },
      }
    }
    return base
  }, [motionLevel])

  return (
    <motion.div
      key={getPageKey(displayedRoute)}
      data-page-route={displayedRoute}
      data-page-transitioning={isTransitioning ? 'true' : 'false'}
      inert={isTransitioning}
      variants={stageVariants}
      initial="initial"
      animate={isTransitioning ? 'exit' : 'animate'}
      className={className}
      style={{
        pointerEvents: 'auto',
        ...style,
      }}
    >
      {children}
    </motion.div>
  )
}
