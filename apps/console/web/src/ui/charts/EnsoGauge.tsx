import { useMemo, type CSSProperties } from 'react'
import { motion } from 'motion/react'
import { getPreset, REDUCED_FADE_DURATION } from '../../motion/presets.ts'
import { DUR, EASE, SPRING } from '../../motion/tokens.ts'
import { useMotionLevel } from '../../motion/useMotionLevel.ts'

export interface EnsoGaugeProps {
  readonly ratio: number
  readonly size?: number
  readonly label?: string
  readonly sublabel?: string
  readonly animate?: boolean
  readonly ariaLabel?: string
  readonly className?: string
  readonly style?: CSSProperties
}

const DEFAULT_SIZE = 160
const START_ANGLE_DEG = -55
const BASE_SWEEP_DEG = 315
const MAX_OVERFLOW_DEG = 26

function polarToCartesian(
  cx: number,
  cy: number,
  radius: number,
  angleDeg: number,
): { readonly x: number; readonly y: number } {
  const rad = (angleDeg * Math.PI) / 180
  return {
    x: cx + radius * Math.cos(rad),
    y: cy + radius * Math.sin(rad),
  }
}

function buildArcPath(
  cx: number,
  cy: number,
  radius: number,
  startDeg: number,
  sweepDeg: number,
): string {
  const clampedSweep = Math.max(0.01, Math.min(359.5, sweepDeg))
  const start = polarToCartesian(cx, cy, radius, startDeg)
  const end = polarToCartesian(cx, cy, radius, startDeg + clampedSweep)
  const largeArc = clampedSweep > 180 ? 1 : 0
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${radius.toFixed(2)} ${radius.toFixed(2)} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`
}

function resolveStrokeColor(ratio: number): string {
  if (ratio > 1) return 'var(--yanzhi)'
  if (ratio >= 0.8) return 'var(--tenghuang)'
  return 'var(--zhusha)'
}

export function EnsoGauge({
  ratio,
  size = DEFAULT_SIZE,
  label,
  sublabel,
  animate = true,
  ariaLabel,
  className,
  style,
}: EnsoGaugeProps) {
  const motionLevel = useMotionLevel()
  const isReduced = motionLevel === 'reduced'

  const safeRatio = Number.isFinite(ratio) ? Math.max(0, ratio) : 0
  const baseFillRatio = Math.min(1, safeRatio)
  const isOverflow = safeRatio > 1
  const overflowSweepDeg = isOverflow
    ? Math.min(MAX_OVERFLOW_DEG, Math.max(8, (safeRatio - 1) * 44))
    : 0

  const strokeColor = resolveStrokeColor(safeRatio)
  const percent = Math.round(safeRatio * 100)
  const displayLabel = label ?? `${percent}%`

  const cx = size * 0.5
  const cy = size * 0.5
  const strokeWidth = Math.max(4, Math.min(10, size * 0.055))
  const radius = Math.max(12, size * 0.5 - strokeWidth * 1.4)

  const { trackPath, overflowPath } = useMemo(() => {
    const track = buildArcPath(cx, cy, radius, START_ANGLE_DEG, BASE_SWEEP_DEG)
    const overflow =
      overflowSweepDeg > 0
        ? buildArcPath(
            cx,
            cy,
            radius,
            START_ANGLE_DEG + BASE_SWEEP_DEG - 2,
            overflowSweepDeg + 2,
          )
        : ''
    return { trackPath: track, overflowPath: overflow }
  }, [cx, cy, radius, overflowSweepDeg])

  const fadeVariants = useMemo(() => getPreset('fade', motionLevel), [motionLevel])
  const labelFontSize = Math.max(16, Math.round(size * 0.175))

  return (
    <div
      role="progressbar"
      aria-valuenow={Math.min(100, percent)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={isOverflow ? `${percent}%` : undefined}
      aria-label={ariaLabel ?? '圆相进度'}
      className={className}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: `${size}px`,
        height: `${size}px`,
        ...style,
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{ display: 'block', overflow: 'visible' }}
      >
        {/* Base unclosed Enso track */}
        <path
          d={trackPath}
          fill="none"
          stroke="var(--hair-strong)"
          strokeWidth={Math.max(2, strokeWidth * 0.45)}
          strokeLinecap="round"
        />

        {/* Active ink brushstroke arc */}
        {baseFillRatio > 0 && (
          <motion.path
            d={trackPath}
            fill="none"
            stroke={strokeColor}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            initial={
              !animate
                ? { pathLength: baseFillRatio, opacity: 1 }
                : isReduced
                  ? { pathLength: baseFillRatio, opacity: 0 }
                  : { pathLength: 0, opacity: 1 }
            }
            animate={{
              pathLength: baseFillRatio,
              opacity: 1,
            }}
            transition={
              !animate
                ? { duration: 0 }
                : isReduced
                  ? { duration: REDUCED_FADE_DURATION, ease: EASE.settle }
                  : { duration: DUR.brush, ease: EASE.brush }
            }
          />
        )}

        {/* Overflow brushstroke spilling past the Enso gap when ratio > 1.0 */}
        {isOverflow && overflowPath.length > 0 && (
          <motion.path
            d={overflowPath}
            fill="none"
            stroke="var(--yanzhi)"
            strokeWidth={Math.max(3, strokeWidth * 0.8)}
            strokeLinecap="round"
            initial={
              !animate
                ? { pathLength: 1, opacity: 1 }
                : isReduced
                  ? { pathLength: 1, opacity: 0 }
                  : { pathLength: 0, opacity: 1 }
            }
            animate={{
              pathLength: 1,
              opacity: 1,
            }}
            transition={
              !animate
                ? { duration: 0 }
                : isReduced
                  ? { duration: REDUCED_FADE_DURATION, ease: EASE.settle }
                  : { ...SPRING.float, delay: DUR.brush * 0.72 }
            }
          />
        )}
      </svg>

      {/* Center metric & sublabel */}
      <motion.div
        variants={animate ? fadeVariants : undefined}
        initial={animate ? 'initial' : false}
        animate={animate ? 'animate' : undefined}
        className="flex flex-col items-center justify-center text-center"
        style={{
          position: 'absolute',
          inset: `${Math.round(strokeWidth * 2.2)}px`,
          pointerEvents: 'none',
        }}
      >
        <span
          className="num"
          style={{
            fontSize: `${labelFontSize}px`,
            lineHeight: 1.1,
            fontWeight: 600,
            color: safeRatio >= 0.8 ? strokeColor : 'var(--text-1)',
          }}
        >
          {displayLabel}
        </span>
        {sublabel !== undefined && (
          <span
            className="mt-1"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--fs-label)',
              lineHeight: 'var(--lh-label)',
              color: 'var(--text-2)',
              maxWidth: '100%',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {sublabel}
          </span>
        )}
      </motion.div>
    </div>
  )
}
