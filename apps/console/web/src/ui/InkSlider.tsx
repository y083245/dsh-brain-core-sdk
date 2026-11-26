import {
  useCallback,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { getPreset } from '../motion/presets.ts'
import { SPRING } from '../motion/tokens.ts'
import { useMotionLevel } from '../motion/useMotionLevel.ts'

export interface InkSliderProps {
  readonly value: number
  readonly onChange: (value: number) => void
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly disabled?: boolean
  readonly label?: string
  readonly formatValue?: (value: number) => string
  readonly id?: string
  readonly ariaLabel?: string
  readonly className?: string
  readonly style?: CSSProperties
}

function getStepPrecision(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0
  const text = String(step)
  const dot = text.indexOf('.')
  return dot >= 0 ? text.length - dot - 1 : 0
}

function clampAndStep(raw: number, min: number, max: number, step: number): number {
  const safeMin = Math.min(min, max)
  const safeMax = Math.max(min, max)
  const clamped = Math.min(safeMax, Math.max(safeMin, raw))
  if (step <= 0) return clamped
  const stepped = safeMin + Math.round((clamped - safeMin) / step) * step
  const precision = getStepPrecision(step)
  const rounded = Number(stepped.toFixed(precision))
  return Math.min(safeMax, Math.max(safeMin, rounded))
}

export function InkSlider({
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  disabled = false,
  label,
  formatValue = (v) => String(v),
  id,
  ariaLabel,
  className,
  style,
}: InkSliderProps) {
  const autoId = useId()
  const sliderId = id ?? autoId
  const labelId = `${sliderId}-label`
  const motionLevel = useMotionLevel()

  const trackRef = useRef<HTMLDivElement | null>(null)
  const [dragging, setDragging] = useState(false)
  const [focused, setFocused] = useState(false)

  const safeSpan = max - min
  const clampedValue = clampAndStep(value, min, max, step)
  const ratio = safeSpan > 0 ? Math.min(1, Math.max(0, (clampedValue - min) / safeSpan)) : 0
  const percent = ratio * 100

  const updateFromClientX = useCallback(
    (clientX: number): void => {
      if (disabled || !trackRef.current || safeSpan <= 0) return
      const rect = trackRef.current.getBoundingClientRect()
      if (rect.width <= 0) return
      const nextRatio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      const nextValue = clampAndStep(min + nextRatio * safeSpan, min, max, step)
      if (nextValue !== clampedValue) {
        onChange(nextValue)
      }
    },
    [clampedValue, disabled, max, min, onChange, safeSpan, step],
  )

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (disabled) return
    event.preventDefault()
    event.currentTarget.focus()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setDragging(true)
    updateFromClientX(event.clientX)
  }

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (!dragging || disabled) return
    updateFromClientX(event.clientX)
  }

  const handlePointerEnd = (event: PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setDragging(false)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return
    const largeStep = step * 10
    let nextValue: number

    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        nextValue = clampAndStep(clampedValue + step, min, max, step)
        break
      case 'ArrowLeft':
      case 'ArrowDown':
        nextValue = clampAndStep(clampedValue - step, min, max, step)
        break
      case 'PageUp':
        nextValue = clampAndStep(clampedValue + largeStep, min, max, step)
        break
      case 'PageDown':
        nextValue = clampAndStep(clampedValue - largeStep, min, max, step)
        break
      case 'Home':
        nextValue = min
        break
      case 'End':
        nextValue = max
        break
      default:
        return
    }

    event.preventDefault()
    if (nextValue !== clampedValue) {
      onChange(nextValue)
    }
  }

  const formattedValue = formatValue(clampedValue)
  const showValueCard = (dragging || focused) && !disabled
  const bloomVariants = getPreset('bloom', motionLevel)

  return (
    <div
      className={className}
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        opacity: disabled ? 0.5 : 1,
        ...style,
      }}
    >
      {label ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            marginBottom: 'var(--sp-2)',
          }}
        >
          <span
            id={labelId}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--fs-label)',
              lineHeight: 'var(--lh-label)',
              fontWeight: 600,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--text-2)',
            }}
          >
            {label}
          </span>
          <span
            className="num"
            style={{
              fontSize: 'var(--fs-mono)',
              lineHeight: 'var(--lh-mono)',
              color: 'var(--text-2)',
            }}
          >
            {formattedValue}
          </span>
        </div>
      ) : null}

      <div
        ref={trackRef}
        id={sliderId}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={clampedValue}
        aria-valuetext={formattedValue}
        aria-disabled={disabled || undefined}
        aria-labelledby={label ? labelId : undefined}
        aria-label={!label ? ariaLabel : undefined}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={handleKeyDown}
        style={{
          position: 'relative',
          height: '28px',
          display: 'flex',
          alignItems: 'center',
          cursor: disabled ? 'not-allowed' : 'pointer',
          touchAction: 'none',
          userSelect: 'none',
        }}
      >
        {/* 1px hairline track */}
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: '50%',
            height: '1px',
            transform: 'translateY(-50%)',
            background: 'var(--hair-strong)',
            pointerEvents: 'none',
          }}
        />

        {/* 2px zhusha selected track */}
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 0,
            width: `${percent}%`,
            top: '50%',
            height: '2px',
            transform: 'translateY(-50%)',
            background: 'var(--zhusha)',
            pointerEvents: 'none',
          }}
        />

        {/* Floating value card + 14x14px square seal thumb */}
        <div
          style={{
            position: 'absolute',
            left: `${percent}%`,
            top: '50%',
            transform: 'translate(-50%, -50%)',
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: '50%',
              bottom: 'calc(100% + 10px)',
              transform: 'translateX(-50%)',
            }}
          >
            <AnimatePresence>
              {showValueCard ? (
                <motion.div
                  variants={bloomVariants}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  className="plate num"
                  style={{
                    padding: '2px var(--sp-2)',
                    background: 'var(--plate-raised)',
                    boxShadow: 'var(--shadow-raised)',
                    border: '1px solid var(--hair-strong)',
                    borderRadius: 'var(--radius)',
                    fontSize: 'var(--fs-mono)',
                    lineHeight: 'var(--lh-mono)',
                    color: 'var(--text-1)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {formattedValue}
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>

          <motion.span
            aria-hidden="true"
            initial={false}
            animate={
              motionLevel === 'full'
                ? { scale: dragging ? 1.12 : 1 }
                : { scale: 1 }
            }
            transition={SPRING.press}
            style={{
              display: 'block',
              width: '14px',
              height: '14px',
              borderRadius: 'var(--radius)',
              background: dragging ? 'var(--zhusha)' : 'var(--plate-raised)',
              border: '2px solid var(--zhusha)',
              boxShadow: 'var(--shadow-plate)',
            }}
          />
        </div>
      </div>
    </div>
  )
}
