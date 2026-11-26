import { useId, useMemo, type CSSProperties } from 'react'
import { motion } from 'motion/react'
import { getPreset } from '../../motion/presets.ts'
import { useMotionLevel } from '../../motion/useMotionLevel.ts'

export type BrushLineTone = 'default' | 'zhusha' | 'tenghuang' | 'yanzhi' | 'shilv'

export interface BrushLinePoint {
  readonly value: number
  readonly label?: string
  readonly tone?: BrushLineTone
}

export interface CartesianPoint {
  readonly x: number
  readonly y: number
}

export interface BrushLinePadding {
  readonly top?: number
  readonly right?: number
  readonly bottom?: number
  readonly left?: number
}

export interface BrushLineProps {
  readonly data: readonly (number | BrushLinePoint)[]
  readonly width?: number
  readonly height?: number
  readonly padding?: number | BrushLinePadding
  readonly min?: number
  readonly max?: number
  readonly strokeColor?: string
  readonly minStrokeWidth?: number
  readonly maxStrokeWidth?: number
  readonly compact?: boolean
  readonly animate?: boolean
  readonly ariaLabel?: string
  readonly className?: string
  readonly style?: CSSProperties
}

const TONE_COLOR_MAP: Readonly<Record<BrushLineTone, string>> = {
  default: 'var(--text-1)',
  zhusha: 'var(--zhusha)',
  tenghuang: 'var(--tenghuang)',
  yanzhi: 'var(--yanzhi)',
  shilv: 'var(--shilv)',
}

interface CubicSegment {
  readonly d: string
  readonly startIndex: number
  readonly endIndex: number
}

function fmt(n: number): string {
  const fixed = n.toFixed(2)
  return fixed === '-0.00' ? '0.00' : fixed
}

function computeCatmullRomSegments(
  points: readonly CartesianPoint[],
  alpha = 0.5,
): CubicSegment[] {
  const len = points.length
  if (len < 2) return []

  const segments: CubicSegment[] = []
  for (let i = 0; i < len - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)]!
    const p1 = points[i]!
    const p2 = points[i + 1]!
    const p3 = points[Math.min(len - 1, i + 2)]!

    const d1 = Math.hypot(p1.x - p0.x, p1.y - p0.y)
    const d2 = Math.hypot(p2.x - p1.x, p2.y - p1.y)
    const d3 = Math.hypot(p3.x - p2.x, p3.y - p2.y)

    const d1a = Math.pow(d1, alpha)
    const d2a = Math.pow(d2, alpha)
    const d3a = Math.pow(d3, alpha)
    const d1_2a = d1a * d1a
    const d2_2a = d2a * d2a
    const d3_2a = d3a * d3a

    let cp1x: number
    let cp1y: number
    if (d1a > 1e-6 && d1a + d2a > 1e-6) {
      const a = 2 * d1_2a + 3 * d1a * d2a + d2_2a
      const n = 3 * d1a * (d1a + d2a)
      cp1x = (d1_2a * p2.x - d2_2a * p0.x + a * p1.x) / n
      cp1y = (d1_2a * p2.y - d2_2a * p0.y + a * p1.y) / n
    } else {
      cp1x = p1.x + (p2.x - p1.x) / 3
      cp1y = p1.y + (p2.y - p1.y) / 3
    }

    let cp2x: number
    let cp2y: number
    if (d3a > 1e-6 && d3a + d2a > 1e-6) {
      const b = 2 * d3_2a + 3 * d3a * d2a + d2_2a
      const m = 3 * d3a * (d3a + d2a)
      cp2x = (d3_2a * p1.x - d2_2a * p3.x + b * p2.x) / m
      cp2y = (d3_2a * p1.y - d2_2a * p3.y + b * p2.y) / m
    } else {
      cp2x = p2.x - (p2.x - p1.x) / 3
      cp2y = p2.y - (p2.y - p1.y) / 3
    }

    segments.push({
      d: `M ${fmt(p1.x)} ${fmt(p1.y)} C ${fmt(cp1x)} ${fmt(cp1y)} ${fmt(cp2x)} ${fmt(cp2y)} ${fmt(p2.x)} ${fmt(p2.y)}`,
      startIndex: i,
      endIndex: i + 1,
    })
  }
  return segments
}

/**
 * Centripetal Catmull-Rom spline converted to a smooth SVG cubic Bezier path.
 * Pure function with zero third-party chart dependencies.
 */
export function buildCatmullRomPath(
  points: readonly CartesianPoint[],
  alpha = 0.5,
): string {
  const first = points[0]
  if (!first) return ''
  if (points.length === 1) {
    return `M ${fmt(first.x)} ${fmt(first.y)} L ${fmt(first.x)} ${fmt(first.y)}`
  }
  if (points.length === 2) {
    const second = points[1]!
    return `M ${fmt(first.x)} ${fmt(first.y)} L ${fmt(second.x)} ${fmt(second.y)}`
  }

  const segments = computeCatmullRomSegments(points, alpha)
  const commands = [`M ${fmt(first.x)} ${fmt(first.y)}`]
  for (const seg of segments) {
    const cIndex = seg.d.indexOf('C ')
    if (cIndex !== -1) {
      commands.push(seg.d.slice(cIndex))
    }
  }
  return commands.join(' ')
}

function normalizePadding(
  padding: number | BrushLinePadding | undefined,
  compact: boolean,
): { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number } {
  if (typeof padding === 'number') {
    return { top: padding, right: padding, bottom: padding, left: padding }
  }
  if (padding !== undefined) {
    return {
      top: padding.top ?? (compact ? 1 : 12),
      right: padding.right ?? (compact ? 1 : 8),
      bottom: padding.bottom ?? (compact ? 1 : 12),
      left: padding.left ?? (compact ? 1 : 8),
    }
  }
  return compact
    ? { top: 1.5, right: 1, bottom: 1.5, left: 1 }
    : { top: 12, right: 8, bottom: 12, left: 8 }
}

export function BrushLine({
  data,
  width,
  height,
  padding,
  min,
  max,
  strokeColor = 'var(--text-1)',
  minStrokeWidth,
  maxStrokeWidth,
  compact = false,
  animate = true,
  ariaLabel,
  className,
  style,
}: BrushLineProps) {
  const motionLevel = useMotionLevel()
  const maskId = useId()

  const resolvedWidth = width ?? (compact ? 48 : 320)
  const resolvedHeight = height ?? (compact ? 12 : 120)
  const resolvedMinWidth = minStrokeWidth ?? (compact ? 1 : 1.2)
  const resolvedMaxWidth = maxStrokeWidth ?? (compact ? 2.2 : 4.2)
  const pad = normalizePadding(padding, compact)

  const normalized = useMemo(() => {
    const items: BrushLinePoint[] = data.map((entry) =>
      typeof entry === 'number' ? { value: entry } : entry,
    )
    if (items.length === 0) {
      return {
        items,
        points: [] as CartesianPoint[],
        segments: [] as CubicSegment[],
        fullPath: '',
        domainMin: 0,
        domainMax: 1,
      }
    }

    let computedMin = Number.POSITIVE_INFINITY
    let computedMax = Number.NEGATIVE_INFINITY
    for (const item of items) {
      if (item.value < computedMin) computedMin = item.value
      if (item.value > computedMax) computedMax = item.value
    }

    const domainMin = min ?? computedMin
    const domainMax = max ?? computedMax
    const span = domainMax - domainMin

    const innerW = Math.max(1, resolvedWidth - pad.left - pad.right)
    const innerH = Math.max(1, resolvedHeight - pad.top - pad.bottom)

    const points: CartesianPoint[] = items.map((item, idx) => {
      const xRatio = items.length === 1 ? 0.5 : idx / (items.length - 1)
      const yRatio = span > 1e-9 ? (item.value - domainMin) / span : 0.5
      return {
        x: pad.left + xRatio * innerW,
        y: pad.top + (1 - Math.max(0, Math.min(1, yRatio))) * innerH,
      }
    })

    const segments = computeCatmullRomSegments(points, 0.5)
    const fullPath = buildCatmullRomPath(points, 0.5)
    return { items, points, segments, fullPath, domainMin, domainMax }
  }, [data, min, max, resolvedWidth, resolvedHeight, pad.left, pad.right, pad.top, pad.bottom])

  const brushVariants = useMemo(() => getPreset('brushIn', motionLevel), [motionLevel])
  const fadeVariants = useMemo(() => getPreset('fade', motionLevel), [motionLevel])

  const shouldMaskAnimate = animate && motionLevel === 'full' && normalized.fullPath.length > 0
  const shouldReducedFade = animate && motionLevel === 'reduced' && normalized.fullPath.length > 0
  const span = normalized.domainMax - normalized.domainMin

  const singlePoint = normalized.points.length === 1 ? normalized.points[0] : undefined

  return (
    <svg
      width={resolvedWidth}
      height={resolvedHeight}
      viewBox={`0 0 ${resolvedWidth} ${resolvedHeight}`}
      role="img"
      aria-label={ariaLabel ?? '笔触折线图'}
      className={className}
      style={{
        display: 'block',
        overflow: 'visible',
        ...style,
      }}
    >
      {shouldMaskAnimate && (
        <defs>
          <mask id={maskId} style={{ maskType: 'alpha' }}>
            <motion.path
              d={normalized.fullPath}
              fill="none"
              stroke="var(--text-1)"
              strokeWidth={resolvedMaxWidth + 6}
              strokeLinecap="round"
              strokeLinejoin="round"
              variants={brushVariants}
              initial="initial"
              animate="animate"
            />
          </mask>
        </defs>
      )}

      <motion.g
        mask={shouldMaskAnimate ? `url(#${maskId})` : undefined}
        variants={shouldReducedFade ? fadeVariants : undefined}
        initial={shouldReducedFade ? 'initial' : false}
        animate={shouldReducedFade ? 'animate' : undefined}
      >
        {singlePoint !== undefined && (
          <circle
            cx={singlePoint.x}
            cy={singlePoint.y}
            r={resolvedMaxWidth * 0.5}
            fill={
              normalized.items[0]?.tone !== undefined && normalized.items[0].tone !== 'default'
                ? TONE_COLOR_MAP[normalized.items[0].tone]
                : strokeColor
            }
          />
        )}

        {normalized.segments.map((seg) => {
          const itemA = normalized.items[seg.startIndex]
          const itemB = normalized.items[seg.endIndex]
          if (!itemA || !itemB) return null

          const avgValue = (itemA.value + itemB.value) * 0.5
          const pressure = span > 1e-9 ? Math.max(0, Math.min(1, (avgValue - normalized.domainMin) / span)) : 0.5
          const strokeWidth = resolvedMinWidth + pressure * (resolvedMaxWidth - resolvedMinWidth)

          const segTone =
            itemB.tone !== undefined && itemB.tone !== 'default'
              ? itemB.tone
              : itemA.tone !== undefined && itemA.tone !== 'default'
                ? itemA.tone
                : undefined
          const color = segTone !== undefined ? TONE_COLOR_MAP[segTone] : strokeColor

          return (
            <path
              key={`${seg.startIndex}-${seg.endIndex}`}
              d={seg.d}
              fill="none"
              stroke={color}
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )
        })}
      </motion.g>
    </svg>
  )
}
