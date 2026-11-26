import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { animate as animateValue, motion, useMotionValue, useSpring } from 'motion/react'
import { SPRING } from '../../motion/tokens.ts'
import { useMotionLevel } from '../../motion/useMotionLevel.ts'
import {
  BrushLine,
  buildCatmullRomPath,
  type CartesianPoint,
} from './BrushLine.tsx'

export interface InkAreaPoint {
  readonly label: string
  readonly value: number
  readonly sublabel?: string
}

export interface InkAreaProps {
  readonly data: readonly InkAreaPoint[]
  readonly width?: number
  readonly height?: number
  readonly formatValue?: (value: number, point: InkAreaPoint) => string
  readonly formatAxisValue?: (value: number) => string
  readonly showXAxis?: boolean
  readonly showYAxis?: boolean
  readonly animate?: boolean
  readonly ariaLabel?: string
  readonly className?: string
  readonly style?: CSSProperties
}

const RESAMPLE_COUNT = 64
const DEFAULT_WIDTH = 640
const DEFAULT_HEIGHT = 220

const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect

function resampleValues(values: readonly number[], targetCount = RESAMPLE_COUNT): number[] {
  if (values.length === 0) {
    return Array.from({ length: targetCount }, () => 0)
  }
  if (values.length === 1) {
    const only = values[0] ?? 0
    return Array.from({ length: targetCount }, () => only)
  }
  const out: number[] = []
  const lastIndex = values.length - 1
  for (let i = 0; i < targetCount; i += 1) {
    const pos = (i / (targetCount - 1)) * lastIndex
    const leftIdx = Math.floor(pos)
    const rightIdx = Math.min(lastIndex, leftIdx + 1)
    const frac = pos - leftIdx
    const leftVal = values[leftIdx] ?? 0
    const rightVal = values[rightIdx] ?? leftVal
    out.push(leftVal + (rightVal - leftVal) * frac)
  }
  return out
}

function computeDomain(values: readonly number[]): { readonly min: number; readonly max: number } {
  if (values.length === 0) return { min: 0, max: 1 }
  let minVal = 0
  let maxVal = Number.NEGATIVE_INFINITY
  for (const v of values) {
    if (v < minVal) minVal = v
    if (v > maxVal) maxVal = v
  }
  if (!Number.isFinite(maxVal) || maxVal <= minVal) {
    return { min: minVal, max: minVal + 1 }
  }
  return { min: minVal, max: maxVal }
}

function buildAreaClosedPath(
  points: readonly CartesianPoint[],
  baselineY: number,
): string {
  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last) return ''
  const linePath = buildCatmullRomPath(points, 0.5)
  return `${linePath} L ${last.x.toFixed(2)} ${baselineY.toFixed(2)} L ${first.x.toFixed(2)} ${baselineY.toFixed(2)} Z`
}

function defaultFormatValue(value: number): string {
  if (Math.abs(value) >= 1000) return value.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(2)
}

export function InkArea({
  data,
  width,
  height = DEFAULT_HEIGHT,
  formatValue = defaultFormatValue,
  formatAxisValue = defaultFormatValue,
  showXAxis = true,
  showYAxis = true,
  animate = true,
  ariaLabel,
  className,
  style,
}: InkAreaProps) {
  const motionLevel = useMotionLevel()
  const gradId = useId()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(width ?? null)
  const [activeIndex, setActiveIndex] = useState<number | null>(null)

  useIsomorphicLayoutEffect(() => {
    if (width !== undefined) {
      setMeasuredWidth(width)
      return
    }
    const node = containerRef.current
    if (!node) return
    const update = (nextWidth?: number): void => {
      const candidate = Math.floor(nextWidth ?? node.clientWidth)
      if (candidate > 0) {
        setMeasuredWidth((prev) => (prev === candidate ? prev : candidate))
      }
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const entryWidth = entries[0]?.contentRect.width
      update(entryWidth !== undefined && entryWidth > 0 ? entryWidth : undefined)
    })
    observer.observe(node)
    return () => {
      observer.disconnect()
    }
  }, [width])

  const plotWidth = Math.max(120, width ?? measuredWidth ?? DEFAULT_WIDTH)
  const plotHeight = Math.max(80, height)
  const responsiveWidthStyle = width !== undefined ? `${plotWidth}px` : '100%'
  const pad = useMemo(
    () => ({
      top: 16,
      right: 14,
      bottom: showXAxis ? 28 : 12,
      left: showYAxis ? 52 : 12,
    }),
    [showXAxis, showYAxis],
  )

  // Labels and array identity can change while the same numeric curve is still morphing.
  const valuesKey = useMemo(() => data.map((point) => point.value).join(','), [data])
  const target = useMemo(() => {
    const values = valuesKey === '' ? [] : valuesKey.split(',').map(Number)
    return { values: resampleValues(values), domain: computeDomain(values) }
  }, [valuesKey])
  const targetDomain = target.domain
  const [display, setDisplay] = useState(target)
  const [hasMorphedOnce, setHasMorphedOnce] = useState(false)
  const latestDisplayRef = useRef(target)
  const isReduced = motionLevel === 'reduced'
  const shouldMorph = animate && !isReduced
  const { values: displayValues, domain: displayDomain } = shouldMorph ? display : target

  useEffect(() => {
    if (latestDisplayRef.current === target) return
    const updateDisplay = (next: typeof target): void => {
      latestDisplayRef.current = next
      setDisplay(next)
    }

    if (!shouldMorph) {
      updateDisplay(target)
      return
    }

    setHasMorphedOnce(true)
    const { values: fromValues, domain: fromDomain } = latestDisplayRef.current
    const { values: toValues, domain: toDomain } = target

    const controls = animateValue(0, 1, {
      ...SPRING.float,
      onUpdate: (t) => {
        updateDisplay({
          values: toValues.map((toValue, idx) => {
            const fromValue = fromValues[idx] ?? toValue
            return fromValue + (toValue - fromValue) * t
          }),
          domain: {
            min: fromDomain.min + (toDomain.min - fromDomain.min) * t,
            max: fromDomain.max + (toDomain.max - fromDomain.max) * t,
          },
        })
      },
      onComplete: () => updateDisplay(target),
    })

    return () => {
      controls.stop()
    }
  }, [shouldMorph, target])

  const innerW = Math.max(1, plotWidth - pad.left - pad.right)
  const innerH = Math.max(1, plotHeight - pad.top - pad.bottom)
  const baselineY = pad.top + innerH

  const displayPoints = useMemo<CartesianPoint[]>(() => {
    const span = displayDomain.max - displayDomain.min
    return displayValues.map((val, idx) => {
      const xRatio = displayValues.length <= 1 ? 0.5 : idx / (displayValues.length - 1)
      const yRatio = span > 1e-9 ? (val - displayDomain.min) / span : 0
      return {
        x: pad.left + xRatio * innerW,
        y: pad.top + (1 - Math.max(0, Math.min(1, yRatio))) * innerH,
      }
    })
  }, [displayDomain.max, displayDomain.min, displayValues, innerH, innerW, pad.left, pad.top])

  const areaPath = useMemo(
    () => buildAreaClosedPath(displayPoints, baselineY),
    [displayPoints, baselineY],
  )

  const originalCoords = useMemo<CartesianPoint[]>(() => {
    const span = targetDomain.max - targetDomain.min
    return data.map((point, idx) => {
      const xRatio = data.length <= 1 ? 0.5 : idx / (data.length - 1)
      const yRatio = span > 1e-9 ? (point.value - targetDomain.min) / span : 0
      return {
        x: pad.left + xRatio * innerW,
        y: pad.top + (1 - Math.max(0, Math.min(1, yRatio))) * innerH,
      }
    })
  }, [data, innerH, innerW, pad.left, pad.top, targetDomain.max, targetDomain.min])

  const crosshairXRaw = useMotionValue(pad.left)
  const crosshairYRaw = useMotionValue(baselineY)
  const crosshairXSpring = useSpring(crosshairXRaw, SPRING.magnet)
  const crosshairYSpring = useSpring(crosshairYRaw, SPRING.magnet)

  const activeIndexRef = useRef<number | null>(null)

  const snapToIndex = useCallback(
    (index: number) => {
      const coord = originalCoords[index]
      if (!coord) return
      const isInitialAppear = activeIndexRef.current === null
      activeIndexRef.current = index
      setActiveIndex(index)
      if (isReduced || isInitialAppear) {
        crosshairXRaw.jump(coord.x)
        crosshairYRaw.jump(coord.y)
      } else {
        crosshairXRaw.set(coord.x)
        crosshairYRaw.set(coord.y)
      }
    },
    [crosshairXRaw, crosshairYRaw, isReduced, originalCoords],
  )

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (originalCoords.length === 0) return
      const rect = event.currentTarget.getBoundingClientRect()
      const localX = event.clientX - rect.left
      let nearestIdx = 0
      let minDist = Number.POSITIVE_INFINITY
      for (let i = 0; i < originalCoords.length; i += 1) {
        const pt = originalCoords[i]
        if (!pt) continue
        const dist = Math.abs(pt.x - localX)
        if (dist < minDist) {
          minDist = dist
          nearestIdx = i
        }
      }
      snapToIndex(nearestIdx)
    },
    [originalCoords, snapToIndex],
  )

  const handlePointerLeave = useCallback(() => {
    activeIndexRef.current = null
    setActiveIndex(null)
  }, [])

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (data.length === 0) return
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        const next = activeIndex === null ? 0 : Math.min(data.length - 1, activeIndex + 1)
        snapToIndex(next)
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        const prev = activeIndex === null ? data.length - 1 : Math.max(0, activeIndex - 1)
        snapToIndex(prev)
      } else if (event.key === 'Escape') {
        activeIndexRef.current = null
        setActiveIndex(null)
      }
    },
    [activeIndex, data.length, snapToIndex],
  )

  const activePoint = activeIndex !== null ? data[activeIndex] : undefined
  const activeCoord = activeIndex !== null ? originalCoords[activeIndex] : undefined
  const tooltipOnLeft = activeCoord !== undefined && activeCoord.x > plotWidth * 0.68

  const xTickIndices = useMemo(() => {
    if (data.length === 0) return [] as number[]
    if (data.length <= 4) return data.map((_, i) => i)
    const mid = Math.floor((data.length - 1) / 2)
    return [0, mid, data.length - 1]
  }, [data])

  const yTicks = useMemo(() => {
    const mid = (targetDomain.min + targetDomain.max) * 0.5
    return [
      { value: targetDomain.max, y: pad.top },
      { value: mid, y: pad.top + innerH * 0.5 },
      { value: targetDomain.min, y: baselineY },
    ]
  }, [baselineY, innerH, pad.top, targetDomain.max, targetDomain.min])

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={ariaLabel ?? '墨面积趋势图'}
      tabIndex={data.length > 0 ? 0 : undefined}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      onKeyDown={handleKeyDown}
      className={className}
      style={{
        position: 'relative',
        width: responsiveWidthStyle,
        minWidth: 0,
        maxWidth: '100%',
        height: `${plotHeight}px`,
        overflow: 'hidden',
        userSelect: 'none',
        ...style,
      }}
    >
      {/* Base SVG: axes, grid hairlines, and ink density vertical gradient fill */}
      <svg
        width={width !== undefined ? plotWidth : '100%'}
        height={plotHeight}
        viewBox={`0 0 ${plotWidth} ${plotHeight}`}
        style={{
          display: 'block',
          width: responsiveWidthStyle,
          maxWidth: '100%',
          height: `${plotHeight}px`,
          overflow: 'visible',
        }}
      >
        <defs>
          {/* §7.15: The sole vertical gradient permitted — ink density from --text-1 to transparent */}
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--text-1)" stopOpacity={0.26} />
            <stop offset="100%" stopColor="var(--text-1)" stopOpacity={0} />
          </linearGradient>
        </defs>

        {/* Horizontal hairlines and Y-axis ticks */}
        {yTicks.map((tick, i) => (
          <g key={i}>
            <line
              x1={pad.left}
              x2={plotWidth - pad.right}
              y1={tick.y}
              y2={tick.y}
              stroke={i === yTicks.length - 1 ? 'var(--hair-strong)' : 'var(--hair)'}
              strokeWidth={1}
            />
            {showYAxis && (
              <text
                x={pad.left - 8}
                y={tick.y}
                textAnchor="end"
                dominantBaseline="middle"
                className="num"
                style={{
                  fontSize: 'var(--fs-label)',
                  fill: 'var(--text-3)',
                }}
              >
                {formatAxisValue(tick.value)}
              </text>
            )}
          </g>
        ))}

        {/* X-axis ticks */}
        {showXAxis &&
          xTickIndices.map((idx) => {
            const point = data[idx]
            const coord = originalCoords[idx]
            if (!point || !coord) return null
            const anchor = idx === 0 ? 'start' : idx === data.length - 1 ? 'end' : 'middle'
            return (
              <text
                key={idx}
                x={coord.x}
                y={plotHeight - 6}
                textAnchor={anchor}
                className="num"
                style={{
                  fontSize: 'var(--fs-label)',
                  fill: 'var(--text-3)',
                }}
              >
                {point.label}
              </text>
            )
          })}

        {/* Ink area vertical gradient fill */}
        {data.length > 0 && areaPath.length > 0 && (
          <path d={areaPath} fill={`url(#${gradId})`} stroke="none" />
        )}
      </svg>

      {/* Top edge BrushLine aligned identically to the plot coordinates */}
      {data.length > 0 && (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
          }}
        >
          <BrushLine
            data={displayValues}
            width={plotWidth}
            height={plotHeight}
            padding={pad}
            min={displayDomain.min}
            max={displayDomain.max}
            animate={animate && !hasMorphedOnce}
            style={{
              width: responsiveWidthStyle,
              maxWidth: '100%',
              height: `${plotHeight}px`,
            }}
          />
        </div>
      )}

      {/* Crosshair vertical dashed line + 6px zhusha point dot */}
      {activePoint !== undefined && activeCoord !== undefined && (
        <svg
          aria-hidden="true"
          width={width !== undefined ? plotWidth : '100%'}
          height={plotHeight}
          viewBox={`0 0 ${plotWidth} ${plotHeight}`}
          style={{
            position: 'absolute',
            inset: 0,
            width: responsiveWidthStyle,
            maxWidth: '100%',
            height: `${plotHeight}px`,
            pointerEvents: 'none',
            overflow: 'visible',
          }}
        >
          <motion.line
            x1={isReduced ? activeCoord.x : crosshairXSpring}
            x2={isReduced ? activeCoord.x : crosshairXSpring}
            y1={pad.top}
            y2={baselineY}
            stroke="var(--hair-strong)"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
          <motion.circle
            cx={isReduced ? activeCoord.x : crosshairXSpring}
            cy={isReduced ? activeCoord.y : crosshairYSpring}
            r={3}
            fill="var(--zhusha)"
          />
        </svg>
      )}

      {/* Floating paper plate value card */}
      {activePoint !== undefined && activeCoord !== undefined && (
        <motion.div
          role="status"
          aria-live="polite"
          className="plate"
          initial={isReduced ? false : { opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={isReduced ? { duration: 0 } : SPRING.magnet}
          style={{
            position: 'absolute',
            top: Math.max(4, Math.min(plotHeight - 64, activeCoord.y - 26)),
            left: tooltipOnLeft
              ? Math.max(pad.left, activeCoord.x - 148)
              : Math.min(Math.max(4, plotWidth - 144), activeCoord.x + 12),
            minWidth: '124px',
            padding: 'var(--sp-2) var(--sp-3)',
            background: 'var(--plate-raised)',
            boxShadow: 'var(--shadow-raised)',
            border: '1px solid var(--hair-strong)',
            borderRadius: 'var(--radius)',
            pointerEvents: 'none',
            zIndex: 4,
          }}
        >
          <div
            className="num"
            style={{
              fontSize: 'var(--fs-label)',
              lineHeight: 'var(--lh-label)',
              color: 'var(--text-3)',
            }}
          >
            {activePoint.label}
          </div>
          <div
            className="num mt-0.5"
            style={{
              fontSize: 'var(--fs-mono)',
              lineHeight: 'var(--lh-mono)',
              fontWeight: 600,
              color: 'var(--text-1)',
            }}
          >
            {formatValue(activePoint.value, activePoint)}
          </div>
          {activePoint.sublabel !== undefined && (
            <div
              className="mt-0.5"
              style={{
                fontSize: 'var(--fs-label)',
                lineHeight: 'var(--lh-label)',
                color: 'var(--text-2)',
              }}
            >
              {activePoint.sublabel}
            </div>
          )}
        </motion.div>
      )}
    </div>
  )
}
