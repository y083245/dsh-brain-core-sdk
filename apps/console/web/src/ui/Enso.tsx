import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useInktideStore } from '../data/store.ts'
import type { EnsoState } from '../ink/engine.ts'
import { useInk } from '../ink/InkProvider.tsx'
import { getPreset } from '../motion/presets.ts'
import { DUR, EASE, SPRING } from '../motion/tokens.ts'
import { useMotionLevel } from '../motion/useMotionLevel.ts'
import { InkText } from './InkText.tsx'

export type EnsoLabelVariant = 'h1' | 'hero' | 'compact'

export interface EnsoProps {
  size: number
  state: EnsoState
  label?: string
  labelVariant?: EnsoLabelVariant
  brushInDurationSec?: number
  layoutId?: string
  rippleKey?: number
  pulseKey?: number
  ariaLabel?: string
  ensoId?: string
  className?: string
  style?: CSSProperties
}

const RECT_EPSILON_PX = 0.25

const STATE_ARIA_ZH: Readonly<Record<EnsoState, string>> = {
  idle: '空闲',
  listening: '正在倾听',
  thinking: '正在思考',
  speaking: '正在回复',
  offline: '已离线',
  error: '状态异常',
  recovering: '正在恢复',
}

const LABEL_STYLES: Readonly<Record<EnsoLabelVariant, CSSProperties>> = {
  hero: {
    fontFamily: 'var(--font-display-cjk)',
    fontSize: 'var(--fs-hero)',
    lineHeight: 'var(--lh-hero)',
    fontWeight: 900,
    letterSpacing: '-0.02em',
    color: 'var(--text-1)',
    margin: 0,
  },
  h1: {
    fontFamily: 'var(--font-display-cjk)',
    fontSize: 'var(--fs-h1)',
    lineHeight: 'var(--lh-h1)',
    fontWeight: 700,
    letterSpacing: '-0.01em',
    color: 'var(--text-1)',
    margin: 0,
  },
  compact: {
    fontFamily: 'var(--font-display-cjk)',
    fontSize: 'var(--fs-small)',
    lineHeight: 'var(--lh-small)',
    fontWeight: 700,
    color: 'var(--text-1)',
    margin: 0,
  },
}

function evalCubicBezier(t: number, p1x: number, p1y: number, p2x: number, p2y: number): number {
  const x = Math.min(1, Math.max(0, t))
  let u = x
  for (let i = 0; i < 5; i += 1) {
    const inv = 1 - u
    const bx = 3 * inv * inv * u * p1x + 3 * inv * u * u * p2x + u * u * u
    const dbx = 3 * inv * inv * p1x + 6 * inv * u * (p2x - p1x) + 3 * u * u * (1 - p2x)
    if (Math.abs(dbx) < 1e-6) break
    u = Math.min(1, Math.max(0, u - (bx - x) / dbx))
  }
  const inv = 1 - u
  return 3 * inv * inv * u * p1y + 3 * inv * u * u * p2y + u * u * u
}

function describeArcPath(cx: number, cy: number, radius: number, startAngle: number, endAngle: number): string {
  const sx = cx + radius * Math.cos(startAngle)
  const sy = cy + radius * Math.sin(startAngle)
  const ex = cx + radius * Math.cos(endAngle)
  const ey = cy + radius * Math.sin(endAngle)
  const sweep = endAngle - startAngle
  const largeArcFlag = sweep > Math.PI ? 1 : 0
  return `M ${sx.toFixed(2)} ${sy.toFixed(2)} A ${radius.toFixed(2)} ${radius.toFixed(2)} 0 ${largeArcFlag} 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`
}

interface FallbackSvgEnsoProps {
  size: number
  state: EnsoState
  resolvedTheme: 'night' | 'paper'
  brushIn: boolean
  motionLevel: 'full' | 'reduced'
}

function FallbackSvgEnso({
  size,
  state,
  resolvedTheme,
  brushIn,
  motionLevel,
}: FallbackSvgEnsoProps) {
  const maskId = useId()
  const gradId = useId()
  const brushVariants = getPreset('brushIn', motionLevel)

  const gapFraction =
    state === 'offline' ? 0.35 : state === 'speaking' ? 0.04 : 0.08
  const startAngle = -Math.PI * 0.65
  const endAngle = startAngle + Math.PI * 2 * (1 - gapFraction)

  const baseRadius = 38
  const fullArc = describeArcPath(50, 50, baseRadius, startAngle, endAngle)
  const coreArc = describeArcPath(
    50,
    50,
    baseRadius,
    startAngle + 0.22,
    endAngle - 0.35,
  )

  let strokeColor = resolvedTheme === 'night' ? 'var(--zhusha)' : 'var(--smoke)'
  if (state === 'offline') strokeColor = 'var(--text-3)'
  else if (state === 'error') strokeColor = 'var(--yanzhi)'
  else if (state === 'recovering') strokeColor = 'var(--tenghuang)'

  const widthFactor = state === 'offline' ? 0.5 : 1

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden="true"
      data-enso-fallback="svg"
      style={{ display: 'block', overflow: 'visible' }}
    >
      <defs>
        <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="white" stopOpacity="0.95" />
          <stop offset="68%" stopColor="white" stopOpacity="0.88" />
          <stop offset="100%" stopColor="white" stopOpacity="0.32" />
        </linearGradient>
        <mask id={maskId} style={{ maskType: 'alpha' }}>
          {/* Tapered calligraphy silhouette: thin entry/exit, thick belly */}
          <path
            d={fullArc}
            fill="none"
            stroke={`url(#${gradId})`}
            strokeWidth={4.2 * widthFactor}
            strokeLinecap="round"
          />
          <path
            d={coreArc}
            fill="none"
            stroke="white"
            strokeWidth={9.5 * widthFactor}
            strokeLinecap="round"
          />
        </mask>
      </defs>

      <g mask={`url(#${maskId})`}>
        {brushIn ? (
          <motion.path
            d={fullArc}
            fill="none"
            stroke={strokeColor}
            strokeWidth={11 * widthFactor}
            strokeLinecap="round"
            variants={brushVariants}
            initial="initial"
            animate="animate"
          />
        ) : (
          <path
            d={fullArc}
            fill="none"
            stroke={strokeColor}
            strokeWidth={11 * widthFactor}
            strokeLinecap="round"
          />
        )}
      </g>

      {state === 'error' ? (
        <line
          x1="74"
          y1="26"
          x2="86"
          y2="38"
          stroke="var(--yanzhi)"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      ) : null}
    </svg>
  )
}

export function Enso({
  size,
  state,
  label,
  labelVariant = 'h1',
  brushInDurationSec,
  layoutId,
  rippleKey,
  pulseKey,
  ariaLabel,
  ensoId,
  className,
  style,
}: EnsoProps) {
  const ink = useInk()
  const motionLevel = useMotionLevel()
  const resolvedTheme = useInktideStore((s) => s.resolvedTheme)
  const generatedId = useId()
  const resolvedId = ensoId ?? `enso-${generatedId}`

  const anchorRef = useRef<HTMLDivElement | null>(null)
  const brushInProgressRef = useRef<number>(
    brushInDurationSec !== undefined && brushInDurationSec > 0 && motionLevel === 'full' ? 0 : 1,
  )
  const lastPushedRef = useRef<{
    x: number
    y: number
    w: number
    h: number
    state: EnsoState
    brushInProgress: number
  } | null>(null)

  const [useSvgFallback, setUseSvgFallback] = useState<boolean>(() => {
    const stats = ink.getStats()
    return stats.backend === 'static-2d' || stats.contextLost
  })

  const [ripples, setRipples] = useState<readonly number[]>([])
  const rippleCounterRef = useRef(1)
  const rippleTimersRef = useRef<Set<number>>(new Set())
  const prevRippleKeyRef = useRef<number | undefined>(rippleKey)
  const prevPulseKeyRef = useRef<number | undefined>(pulseKey)

  // Detect WebGL2 availability & context loss for SVG fallback
  useEffect(() => {
    const syncBackend = (): void => {
      const stats = ink.getStats()
      const fallback = stats.backend === 'static-2d' || stats.contextLost
      setUseSvgFallback((prev) => (prev === fallback ? prev : fallback))
    }

    syncBackend()

    const canvas = typeof document !== 'undefined' ? document.getElementById('ink') : null
    if (!canvas) return

    const onLost = (): void => setUseSvgFallback(true)
    const onRestored = (): void => syncBackend()
    canvas.addEventListener('webglcontextlost', onLost, false)
    canvas.addEventListener('webglcontextrestored', onRestored, false)

    return () => {
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
    }
  }, [ink])

  // Optional mount brushIn progress animation (0 -> 1 over brushInDurationSec)
  useEffect(() => {
    if (brushInDurationSec === undefined || brushInDurationSec <= 0 || motionLevel === 'reduced') {
      brushInProgressRef.current = 1
      return
    }

    brushInProgressRef.current = 0
    const durationMs = brushInDurationSec * 1000
    const startMs = performance.now()
    let rafId = 0

    const tick = (nowMs: number): void => {
      const t = Math.min(1, Math.max(0, (nowMs - startMs) / durationMs))
      brushInProgressRef.current = evalCubicBezier(
        t,
        EASE.brush[0],
        EASE.brush[1],
        EASE.brush[2],
        EASE.brush[3],
      )
      if (t < 1) {
        rafId = window.requestAnimationFrame(tick)
      } else {
        brushInProgressRef.current = 1
      }
    }

    rafId = window.requestAnimationFrame(tick)
    return () => {
      window.cancelAnimationFrame(rafId)
    }
  }, [brushInDurationSec, motionLevel])

  // Sync Enso DOM rect to WebGL2 InkEngine at 60fps during layoutId flight & scroll,
  // only calling ink.setEnso when rect changes >= 0.25px or state/brushIn changes.
  useEffect(() => {
    const el = anchorRef.current
    if (!el) return

    const pushIfChanged = (force = false): void => {
      const node = anchorRef.current
      if (!node) return
      const rect = node.getBoundingClientRect()
      const progress = brushInProgressRef.current
      const prev = lastPushedRef.current

      const changed =
        force ||
        prev === null ||
        Math.abs(rect.left - prev.x) >= RECT_EPSILON_PX ||
        Math.abs(rect.top - prev.y) >= RECT_EPSILON_PX ||
        Math.abs(rect.width - prev.w) >= RECT_EPSILON_PX ||
        Math.abs(rect.height - prev.h) >= RECT_EPSILON_PX ||
        prev.state !== state ||
        Math.abs(progress - prev.brushInProgress) >= 0.001

      if (!changed) return

      lastPushedRef.current = {
        x: rect.left,
        y: rect.top,
        w: rect.width,
        h: rect.height,
        state,
        brushInProgress: progress,
      }

      ink.setEnso({
        id: resolvedId,
        rect: {
          x: rect.left,
          y: rect.top,
          w: rect.width,
          h: rect.height,
        },
        state,
        brushInProgress: progress,
        visible: true,
      })
    }

    pushIfChanged(true)

    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => pushIfChanged(false))
        : null
    ro?.observe(el)

    let rafId = 0
    const poll = (): void => {
      pushIfChanged(false)
      rafId = window.requestAnimationFrame(poll)
    }
    rafId = window.requestAnimationFrame(poll)

    return () => {
      ro?.disconnect()
      window.cancelAnimationFrame(rafId)
    }
  }, [ink, resolvedId, state])

  // Remove Enso from engine on unmount or id change
  useEffect(() => {
    return () => {
      lastPushedRef.current = null
      ink.removeEnso(resolvedId)
    }
  }, [ink, resolvedId])

  // Listening ripple on rippleKey increment (full motion only)
  useEffect(() => {
    if (rippleKey === prevRippleKeyRef.current) return
    prevRippleKeyRef.current = rippleKey
    if (rippleKey === undefined || rippleKey <= 0 || motionLevel !== 'full') return

    const id = rippleCounterRef.current++
    setRipples((prev) => [...prev.slice(-4), id])
    const timer = window.setTimeout(() => {
      rippleTimersRef.current.delete(timer)
      setRipples((prev) => prev.filter((item) => item !== id))
    }, Math.round(DUR.bloom * 1000) + 40)
    rippleTimersRef.current.add(timer)
  }, [rippleKey, motionLevel])

  // Clear pending ripple timers on unmount
  useEffect(() => {
    const timers = rippleTimersRef.current
    return () => {
      for (const timer of timers) {
        window.clearTimeout(timer)
      }
      timers.clear()
    }
  }, [])

  // Speaking pulse on pulseKey increment
  useEffect(() => {
    if (pulseKey === prevPulseKeyRef.current) return
    prevPulseKeyRef.current = pulseKey
    if (pulseKey === undefined || pulseKey <= 0) return
    ink.pulseEnso(resolvedId)
  }, [ink, pulseKey, resolvedId])

  const stateText = STATE_ARIA_ZH[state]
  const computedAriaLabel =
    ariaLabel ?? (label ? `${label}，${stateText}` : `圆相，${stateText}`)

  const isHero = labelVariant === 'hero'
  const containerStyle: CSSProperties = {
    display: 'inline-flex',
    flexDirection: isHero ? 'column' : 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: isHero ? 'var(--sp-4)' : labelVariant === 'compact' ? 'var(--sp-2)' : 'var(--sp-4)',
    ...style,
  }

  return (
    <div className={className} style={containerStyle} data-enso-state={state}>
      <motion.div
        ref={anchorRef}
        layoutId={motionLevel === 'full' ? layoutId : undefined}
        transition={SPRING.heavy}
        role="img"
        aria-label={computedAriaLabel}
        style={{
          position: 'relative',
          width: size,
          height: size,
          flexShrink: 0,
        }}
      >
        {useSvgFallback ? (
          <FallbackSvgEnso
            size={size}
            state={state}
            resolvedTheme={resolvedTheme}
            brushIn={brushInDurationSec !== undefined && brushInDurationSec > 0}
            motionLevel={motionLevel}
          />
        ) : null}

        <AnimatePresence>
          {ripples.map((id) => (
            <motion.span
              key={id}
              aria-hidden="true"
              initial={{ scale: 1, opacity: 0.7 }}
              animate={{ scale: 1.4, opacity: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: DUR.bloom, ease: EASE.inkOut }}
              style={{
                position: 'absolute',
                inset: 0,
                borderRadius: '50%',
                border: '1px solid var(--zhusha)',
                pointerEvents: 'none',
              }}
            />
          ))}
        </AnimatePresence>
      </motion.div>

      {label ? (
        <InkText
          as={isHero ? 'h1' : 'span'}
          text={label}
          style={LABEL_STYLES[labelVariant]}
        />
      ) : null}
    </div>
  )
}
