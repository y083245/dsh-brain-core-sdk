import { useEffect, useRef, type CSSProperties } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { getPreset } from '../motion/presets.ts'
import { SPRING } from '../motion/tokens.ts'
import { useMotionLevel } from '../motion/useMotionLevel.ts'

export type InkNumberVariant = 'mono' | 'xl' | 'h1' | 'h2' | 'body'

export interface InkNumberProps {
  readonly value: number | string
  readonly format?: (value: number) => string
  readonly variant?: InkNumberVariant
  readonly className?: string
  readonly style?: CSSProperties
  readonly ariaLabel?: string
}

const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  USD: '$',
  CNY: '¥',
  RMB: '¥',
  JPY: '¥',
  EUR: '€',
  GBP: '£',
}

const CURRENCY_RAW_SYMBOLS = new Set(['$', '¥', '€', '£'])

// Section 7.14: XL Fraunces ink bleed pulses wght 300 -> 500 -> 300 over 400ms.
const XL_INK_BLEED_MS = 400
const XL_WGHT_BASE = 300
const XL_WGHT_PEAK_DELTA = 200
const XL_BASE_VARIATION = '"wght" 300, "opsz" 144'

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const

const VARIANT_STYLES: Readonly<Record<InkNumberVariant, CSSProperties>> = {
  mono: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--fs-mono)',
    lineHeight: 'var(--lh-mono)',
  },
  body: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--fs-body)',
    lineHeight: 'var(--lh-body)',
  },
  h2: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--fs-h2)',
    lineHeight: 'var(--lh-h2)',
  },
  h1: {
    fontFamily: 'var(--font-display-latin)',
    fontSize: 'var(--fs-h1)',
    lineHeight: 'var(--lh-h1)',
    letterSpacing: '-0.01em',
  },
  xl: {
    fontFamily: 'var(--font-display-latin)',
    fontSize: 'var(--fs-num-xl)',
    lineHeight: 'var(--lh-num-xl)',
    letterSpacing: '-0.03em',
    fontVariationSettings: XL_BASE_VARIATION,
  },
}

const SR_ONLY_STYLE: CSSProperties = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  padding: 0,
  margin: '-1px',
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
}

function resolveCurrencyPrefix(currency?: string): string {
  const trimmed = currency?.trim() ?? ''
  if (trimmed === '') return '$'
  if (CURRENCY_RAW_SYMBOLS.has(trimmed)) return trimmed
  const upper = trimmed.toUpperCase()
  return CURRENCY_SYMBOLS[upper] ?? `${upper} `
}

/**
 * Formats integer micro-currency units (`costMicros / 1e6`) rounded to cents
 * with the currency symbol leading.
 */
export function formatCostMicros(costMicros: number, currency = 'USD'): string {
  const prefix = resolveCurrencyPrefix(currency)
  const raw = Number.isFinite(costMicros) ? costMicros / 1_000_000 : 0
  const normalized = Math.abs(raw) < 0.005 ? 0 : raw
  const sign = normalized < 0 ? '-' : ''
  const absFormatted = Math.abs(normalized).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${sign}${prefix}${absFormatted}`
}

function defaultFormatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return value.toLocaleString('en-US')
}

function isAsciiDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

interface DigitColumnProps {
  readonly digit: number
  readonly isNew: boolean
}

function DigitColumn({ digit, isNew }: DigitColumnProps) {
  const bloomVariants = getPreset('bloom', 'full')
  return (
    <motion.span
      layout={false}
      variants={bloomVariants}
      initial={isNew ? 'initial' : false}
      animate="animate"
      exit="exit"
      style={{
        display: 'inline-block',
        position: 'relative',
        height: '1em',
        lineHeight: 1,
        overflow: 'hidden',
        verticalAlign: 'baseline',
      }}
    >
      {/* Invisible placeholder sets exact tabular column width */}
      <span style={{ visibility: 'hidden', display: 'block', lineHeight: 1 }}>
        0
      </span>
      <motion.span
        initial={false}
        animate={{ y: `${-digit * 10}%` }}
        transition={SPRING.snappy}
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 0,
          display: 'flex',
          flexDirection: 'column',
          lineHeight: 1,
          willChange: 'transform',
        }}
      >
        {DIGITS.map((d) => (
          <span
            key={d}
            style={{
              display: 'block',
              height: '1em',
              lineHeight: 1,
              textAlign: 'center',
            }}
          >
            {d}
          </span>
        ))}
      </motion.span>
    </motion.span>
  )
}

export function InkNumber({
  value,
  format,
  variant = 'mono',
  className,
  style,
  ariaLabel,
}: InkNumberProps) {
  const motionLevel = useMotionLevel()
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const mountedRef = useRef(false)

  const formatted =
    typeof value === 'string'
      ? value
      : (format ? format(value) : defaultFormatNumber(value))

  const prevFormattedRef = useRef<string>(formatted)

  // Track mount status so initial digits do not bloom-animate, while newly added columns do.
  useEffect(() => {
    mountedRef.current = true
  }, [])

  // Section 7.14: XL Fraunces ink bleed (wght 300 -> 500 -> 300 over 400ms) on value change.
  useEffect(() => {
    const prev = prevFormattedRef.current
    prevFormattedRef.current = formatted

    if (
      variant !== 'xl' ||
      motionLevel !== 'full' ||
      prev === formatted ||
      !rootRef.current ||
      typeof requestAnimationFrame !== 'function'
    ) {
      return
    }

    const el = rootRef.current
    let rafId = 0
    const start = performance.now()

    const tick = (now: number): void => {
      const elapsed = now - start
      const progress = Math.min(1, elapsed / XL_INK_BLEED_MS)
      const weight = Math.round(
        XL_WGHT_BASE + XL_WGHT_PEAK_DELTA * Math.sin(Math.PI * progress),
      )
      el.style.fontVariationSettings = `"wght" ${weight}, "opsz" 144`
      if (progress < 1) {
        rafId = requestAnimationFrame(tick)
      } else {
        el.style.fontVariationSettings = XL_BASE_VARIATION
      }
    }

    rafId = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(rafId)
      el.style.fontVariationSettings = XL_BASE_VARIATION
    }
  }, [formatted, motionLevel, variant])

  const variantStyle = VARIANT_STYLES[variant]
  const baseStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'baseline',
    position: 'relative',
    fontVariantNumeric: 'tabular-nums',
    ...variantStyle,
    ...style,
  }

  if (motionLevel === 'reduced') {
    return (
      <span
        ref={rootRef}
        aria-label={ariaLabel}
        className={className}
        style={baseStyle}
      >
        {formatted}
      </span>
    )
  }

  const chars = Array.from(formatted)
  const bloomVariants = getPreset('bloom', 'full')
  const isMounted = mountedRef.current

  return (
    <span
      ref={rootRef}
      aria-label={ariaLabel}
      className={className}
      style={baseStyle}
    >
      <span style={SR_ONLY_STYLE}>{formatted}</span>
      <span
        aria-hidden="true"
        style={{
          display: 'inline-flex',
          alignItems: 'baseline',
        }}
      >
        <AnimatePresence initial={false} mode="popLayout">
          {chars.map((ch, idx) => {
            const posFromRight = chars.length - 1 - idx
            if (isAsciiDigit(ch)) {
              return (
                <DigitColumn
                  key={`d-${posFromRight}`}
                  digit={Number(ch)}
                  isNew={isMounted}
                />
              )
            }
            return (
              <motion.span
                key={`s-${posFromRight}-${ch}`}
                variants={bloomVariants}
                initial={isMounted ? 'initial' : false}
                animate="animate"
                exit="exit"
                style={{
                  display: 'inline-block',
                  lineHeight: 1,
                }}
              >
                {ch === ' ' ? '\u00A0' : ch}
              </motion.span>
            )
          })}
        </AnimatePresence>
      </span>
    </span>
  )
}
