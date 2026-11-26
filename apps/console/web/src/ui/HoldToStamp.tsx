import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { motion } from 'motion/react'
import { ApiError } from '../api/types.ts'
import { useInk } from '../ink/InkProvider.tsx'
import { getPreset } from '../motion/presets.ts'
import { DUR, HOLD_TO_STAMP_MS, SPRING } from '../motion/tokens.ts'
import { useMotionLevel } from '../motion/useMotionLevel.ts'
import { playStamp } from '../sound/synth.ts'

export interface HoldToStampProps {
  label: string
  caption?: string
  instant?: boolean
  disabled?: boolean
  ariaLabel: string
  ariaDescribedBy?: string
  onConfirm: () => Promise<void> | void
  onComplete?: () => void
  onError?: (err: unknown) => void
  className?: string
  style?: CSSProperties
}

type StampPhase = 'idle' | 'holding' | 'pending' | 'success' | 'error'
type HoldInput = { pointerId: number } | { key: ' ' | 'Enter' }

interface ErrorDetail {
  readonly code: string | null
  readonly message: string
}

// §7.5: early release retreats fill in 200ms; success seal holds "讫" for 600ms
const RETREAT_MS = 200
const SUCCESS_HOLD_MS = 600
const SEAL_SIZE_PX = 56
const JITTER_AMP_PX = 0.6

function extractErrorDetail(err: unknown): ErrorDetail {
  if (err instanceof ApiError) {
    return { code: err.code, message: err.message }
  }
  if (typeof err === 'object' && err !== null) {
    const rec = err as Record<string, unknown>
    const code = typeof rec.code === 'string' && rec.code.length > 0 ? rec.code : null
    const message =
      typeof rec.message === 'string' && rec.message.length > 0
        ? rec.message
        : '操作未能完成'
    return { code, message }
  }
  if (typeof err === 'string' && err.length > 0) {
    return { code: null, message: err }
  }
  return { code: null, message: '操作未能完成' }
}

const WRAPPER_STYLE: CSSProperties = {
  display: 'inline-flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 'var(--sp-2)',
}

const SEAL_BOX_BASE_STYLE: CSSProperties = {
  position: 'relative',
  width: SEAL_SIZE_PX,
  height: SEAL_SIZE_PX,
  borderRadius: 'var(--radius)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  userSelect: 'none',
  touchAction: 'none',
  fontFamily: 'var(--font-display-cjk)',
  fontWeight: 700,
  fontSize: 'var(--fs-body)',
  lineHeight: 1,
  letterSpacing: '0.06em',
  backgroundColor: 'var(--plate)',
  overflow: 'hidden',
}

const CAPTION_STYLE: CSSProperties = {
  fontFamily: 'var(--font-ui)',
  fontSize: 'var(--fs-small)',
  lineHeight: 'var(--lh-small)',
  color: 'var(--text-3)',
  margin: 0,
}

const ERROR_BOX_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 'var(--sp-1)',
  textAlign: 'center',
  maxWidth: 260,
}

const ERROR_CODE_STYLE: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-label)',
  lineHeight: 'var(--lh-label)',
  letterSpacing: '0.08em',
  color: 'var(--yanzhi)',
}

const ERROR_MSG_STYLE: CSSProperties = {
  fontFamily: 'var(--font-ui)',
  fontSize: 'var(--fs-small)',
  lineHeight: 'var(--lh-small)',
  color: 'var(--yanzhi)',
}

export function HoldToStamp({
  label,
  caption,
  instant = false,
  disabled = false,
  ariaLabel,
  ariaDescribedBy,
  onConfirm,
  onComplete,
  onError,
  className,
  style,
}: HoldToStampProps) {
  const ink = useInk()
  const motionLevel = useMotionLevel()

  const sealRef = useRef<HTMLDivElement | null>(null)
  const jitterRef = useRef<HTMLDivElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const successTimerRef = useRef<number | null>(null)
  const mountedRef = useRef(true)

  const progressRef = useRef(0)
  const holdInputRef = useRef<HoldInput | null>(null)
  const phaseRef = useRef<StampPhase>('idle')

  const [phase, setPhase] = useState<StampPhase>('idle')
  const [stampTrigger, setStampTrigger] = useState(0)
  const [errorDetail, setErrorDetail] = useState<ErrorDetail | null>(null)

  const updatePhase = useCallback((next: StampPhase) => {
    phaseRef.current = next
    setPhase(next)
  }, [])

  const applyVisualProgress = useCallback((p: number, jx = 0, jy = 0) => {
    const clamped = Math.min(1, Math.max(0, p))
    progressRef.current = clamped
    const el = sealRef.current
    if (el) {
      el.style.setProperty('--stamp-angle', `${(clamped * 360).toFixed(2)}deg`)
    }
    const jitterEl = jitterRef.current
    if (jitterEl) {
      jitterEl.style.transform =
        jx === 0 && jy === 0 ? '' : `translate3d(${jx.toFixed(2)}px, ${jy.toFixed(2)}px, 0)`
    }
  }, [])

  const stopRaf = useCallback(() => {
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  const emitStampSplat = useCallback(() => {
    const el = sealRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const cx = rect.left + rect.width * 0.5
    const cy = rect.top + rect.height * 0.5

    // §5.4 stamp splat: center radius 90 amount 0.8 + 6 radial directions magnitude 120, radius 24 amount 0.35
    ink.splat({
      x: cx,
      y: cy,
      dx: 0,
      dy: 0,
      radius: 90,
      amount: 0.8,
      color: 'zhusha',
    })
    for (let i = 0; i < 6; i += 1) {
      const angle = (Math.PI * 2 * i) / 6
      ink.splat({
        x: cx + Math.cos(angle) * 20,
        y: cy + Math.sin(angle) * 20,
        dx: Math.cos(angle) * 120,
        dy: Math.sin(angle) * 120,
        radius: 24,
        amount: 0.35,
        color: 'zhusha',
      })
    }
  }, [ink])

  const executeConfirm = useCallback(() => {
    if (phaseRef.current === 'pending' || phaseRef.current === 'success') return
    stopRaf()
    holdInputRef.current = null
    applyVisualProgress(1, 0, 0)
    setErrorDetail(null)
    setStampTrigger((n) => n + 1)
    updatePhase('pending')

    playStamp()
    emitStampSplat()

    Promise.resolve()
      .then(() => onConfirm())
      .then(() => {
        if (!mountedRef.current) return
        updatePhase('success')
        successTimerRef.current = window.setTimeout(() => {
          successTimerRef.current = null
          if (!mountedRef.current) return
          onComplete?.()
        }, SUCCESS_HOLD_MS)
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return
        applyVisualProgress(0, 0, 0)
        setErrorDetail(extractErrorDetail(err))
        updatePhase('error')
        onError?.(err)
      })
  }, [applyVisualProgress, emitStampSplat, onComplete, onConfirm, onError, stopRaf, updatePhase])

  const startRetreat = useCallback(() => {
    if (!holdInputRef.current) return
    holdInputRef.current = null
    stopRaf()
    updatePhase('idle')

    const startProgress = progressRef.current
    if (startProgress <= 0.001) {
      applyVisualProgress(0, 0, 0)
      return
    }

    const startMs = performance.now()
    const retreatDuration = Math.max(16, RETREAT_MS * startProgress)

    const tickRetreat = (nowMs: number): void => {
      const t = Math.min(1, Math.max(0, (nowMs - startMs) / retreatDuration))
      const p = startProgress * (1 - t)
      applyVisualProgress(p, 0, 0)
      if (t < 1) {
        rafRef.current = window.requestAnimationFrame(tickRetreat)
      } else {
        rafRef.current = null
        applyVisualProgress(0, 0, 0)
      }
    }

    rafRef.current = window.requestAnimationFrame(tickRetreat)
  }, [applyVisualProgress, stopRaf, updatePhase])

  const startHold = useCallback((input: HoldInput) => {
    if (
      disabled ||
      document.hidden ||
      holdInputRef.current ||
      phaseRef.current === 'pending' ||
      phaseRef.current === 'success'
    ) {
      return
    }

    if (instant) {
      executeConfirm()
      return
    }

    stopRaf()
    applyVisualProgress(0)
    setErrorDetail(null)
    holdInputRef.current = input
    updatePhase('holding')

    const startMs = performance.now()

    const tickHold = (nowMs: number): void => {
      if (holdInputRef.current !== input) return
      const elapsedMs = Math.max(0, nowMs - startMs)
      const progress = Math.min(1, elapsedMs / HOLD_TO_STAMP_MS)

      let jx = 0
      let jy = 0
      if (motionLevel === 'full' && progress > 0) {
        const elapsedSec = elapsedMs / 1000
        const freqHz = 16 + progress * 44
        jx = Math.sin(elapsedSec * freqHz * Math.PI * 2) * JITTER_AMP_PX
        jy = Math.cos(elapsedSec * freqHz * 1.27 * Math.PI * 2) * JITTER_AMP_PX
      }

      applyVisualProgress(progress, jx, jy)

      if (progress >= 1) {
        rafRef.current = null
        executeConfirm()
        return
      }
      rafRef.current = window.requestAnimationFrame(tickHold)
    }

    rafRef.current = window.requestAnimationFrame(tickHold)
  }, [applyVisualProgress, disabled, executeConfirm, instant, motionLevel, stopRaf, updatePhase])

  useLayoutEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      holdInputRef.current = null
      stopRaf()
      if (successTimerRef.current !== null) {
        window.clearTimeout(successTimerRef.current)
        successTimerRef.current = null
      }
    }
  }, [stopRaf])

  const handlePointerEnd = useCallback((e: { pointerId: number }) => {
    const input = holdInputRef.current
    if (input && 'pointerId' in input && input.pointerId === e.pointerId) startRetreat()
  }, [startRetreat])

  useLayoutEffect(() => {
    if (disabled || instant) {
      startRetreat()
      return
    }
    if (phase !== 'holding') return

    const handleVisibilityChange = () => {
      if (document.hidden) startRetreat()
    }
    window.addEventListener('pointerup', handlePointerEnd, true)
    window.addEventListener('pointercancel', handlePointerEnd, true)
    window.addEventListener('blur', startRetreat)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('pointerup', handlePointerEnd, true)
      window.removeEventListener('pointercancel', handlePointerEnd, true)
      window.removeEventListener('blur', startRetreat)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [disabled, handlePointerEnd, instant, phase, startRetreat])

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      startHold({ pointerId: e.pointerId })
    },
    [startHold],
  )

  const handlePointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const input = holdInputRef.current
    if (!input || !('pointerId' in input) || input.pointerId !== e.pointerId) return

    // Touch can keep sending events to the seal after leaving it via implicit pointer capture.
    const { left, right, top, bottom } = e.currentTarget.getBoundingClientRect()
    if (
      (e.buttons & 1) === 0 ||
      e.clientX < left ||
      e.clientX >= right ||
      e.clientY < top ||
      e.clientY >= bottom
    ) {
      startRetreat()
    }
  }, [startRetreat])

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key !== ' ' && e.key !== 'Enter') return
      e.preventDefault()
      if (e.repeat) return
      startHold({ key: e.key })
    },
    [startHold],
  )

  const handleKeyUp = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key !== ' ' && e.key !== 'Enter') return
      e.preventDefault()
      const input = holdInputRef.current
      if (input && 'key' in input && e.key === input.key) startRetreat()
    },
    [startRetreat],
  )

  const isSolidFill = phase === 'pending' || phase === 'success'
  const isError = phase === 'error'
  const borderColor = isError ? 'var(--yanzhi)' : 'var(--zhusha)'

  const displayedText =
    phase === 'pending' ? '…' : phase === 'success' ? '讫' : label

  const resolvedCaption =
    caption !== undefined ? caption : instant ? undefined : '按住 0.9 秒'

  const brushInVariants = getPreset('brushIn', motionLevel)

  const animateProps =
    motionLevel === 'reduced'
      ? { scale: 1, x: 0 }
      : phase === 'holding'
        ? { scale: 0.94, x: 0 }
        : isError
          ? { scale: 1, x: [0, -4, 4, -3, 3, -1, 0] }
          : phase === 'pending' && stampTrigger > 0
            ? { scale: [1.1, 1], x: 0 }
            : { scale: 1, x: 0 }

  const transitionProps =
    isError && motionLevel === 'full'
      ? { duration: DUR.base }
      : phase === 'holding'
        ? SPRING.press
        : SPRING.heavy

  return (
    <div className={className} style={{ ...WRAPPER_STYLE, ...style }}>
      <motion.div
        ref={sealRef}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-disabled={disabled || undefined}
        aria-busy={phase === 'pending' || undefined}
        data-stamp-phase={phase}
        data-cursor={disabled ? undefined : 'interactive'}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onPointerLeave={handlePointerEnd}
        onLostPointerCapture={handlePointerEnd}
        onPointerMove={handlePointerMove}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onBlur={startRetreat}
        animate={animateProps}
        transition={transitionProps}
        style={{
          ...SEAL_BOX_BASE_STYLE,
          border: `2px solid ${borderColor}`,
          opacity: disabled ? 0.45 : 1,
          pointerEvents: disabled ? 'none' : undefined,
        }}
      >
        {/* Inner jitter wrapper driven directly via DOM transform during hold */}
        <div
          ref={jitterRef}
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {/* Conic clockwise fill layer */}
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              inset: 0,
              backgroundImage: isSolidFill
                ? undefined
                : 'conic-gradient(var(--zhusha) var(--stamp-angle, 0deg), transparent var(--stamp-angle, 0deg))',
              backgroundColor: isSolidFill ? 'var(--zhusha)' : 'transparent',
              pointerEvents: 'none',
            }}
          />

          {/* Base label (unfilled surface) */}
          <span
            style={{
              position: 'relative',
              zIndex: 1,
              color: isSolidFill
                ? 'var(--plate)'
                : isError
                  ? 'var(--yanzhi)'
                  : 'var(--zhusha)',
            }}
          >
            {displayedText}
          </span>

          {/* Inverted plate-colored label revealed strictly under the sweeping conic wedge */}
          {!isSolidFill ? (
            <span
              aria-hidden="true"
              style={{
                position: 'absolute',
                inset: 0,
                zIndex: 2,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--plate)',
                WebkitMaskImage:
                  'conic-gradient(var(--text-1) var(--stamp-angle, 0deg), transparent var(--stamp-angle, 0deg))',
                maskImage:
                  'conic-gradient(var(--text-1) var(--stamp-angle, 0deg), transparent var(--stamp-angle, 0deg))',
                pointerEvents: 'none',
              }}
            >
              {displayedText}
            </span>
          ) : null}

          {/* Error diagonal yanzhi crack stroke drawn with brushIn */}
          {isError ? (
            <svg
              aria-hidden="true"
              viewBox="0 0 56 56"
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                zIndex: 3,
                pointerEvents: 'none',
              }}
            >
              <motion.path
                d="M 8 48 L 48 8"
                fill="none"
                stroke="var(--yanzhi)"
                strokeWidth={2.5}
                strokeLinecap="round"
                variants={brushInVariants}
                initial="initial"
                animate="animate"
              />
            </svg>
          ) : null}
        </div>
      </motion.div>

      {resolvedCaption ? <p style={CAPTION_STYLE}>{resolvedCaption}</p> : null}

      {isError && errorDetail ? (
        <div role="alert" style={ERROR_BOX_STYLE}>
          {errorDetail.code ? <span style={ERROR_CODE_STYLE}>{errorDetail.code}</span> : null}
          <span style={ERROR_MSG_STYLE}>{errorDetail.message}</span>
        </div>
      ) : null}
    </div>
  )
}
