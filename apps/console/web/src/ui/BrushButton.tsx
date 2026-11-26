import {
  useCallback,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from 'react'
import { motion } from 'motion/react'
import { useInk } from '../ink/InkProvider.tsx'
import { getPreset } from '../motion/presets.ts'
import { DUR, EASE, SPRING } from '../motion/tokens.ts'
import { useMotionLevel } from '../motion/useMotionLevel.ts'

export type BrushButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type BrushButtonSize = 'md' | 'sm'

type OmittedMotionConflicts =
  | 'onAnimationStart'
  | 'onAnimationEnd'
  | 'onDrag'
  | 'onDragStart'
  | 'onDragEnd'

export interface BrushButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, OmittedMotionConflicts> {
  variant?: BrushButtonVariant
  loading?: boolean
  size?: BrushButtonSize
  className?: string
  style?: CSSProperties
  children?: ReactNode
  ref?: Ref<HTMLButtonElement>
}

// §7.4: loading indicator is a 30%-wide zhusha bar sweeping back and forth in 1.2s
const LOADING_SWEEP_SEC = 1.2

const LOADING_TRACK_STYLE: CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  height: 2,
  overflow: 'hidden',
  pointerEvents: 'none',
}

const UNDERLINE_SVG_STYLE: CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  bottom: -2,
  width: '100%',
  height: 6,
  overflow: 'visible',
  pointerEvents: 'none',
  display: 'block',
}

export function BrushButton({
  variant = 'secondary',
  loading = false,
  size = 'md',
  disabled = false,
  type = 'button',
  className,
  style,
  children,
  ref,
  onClick,
  onPointerDown,
  onPointerEnter,
  onPointerLeave,
  onFocus,
  onBlur,
  ...rest
}: BrushButtonProps) {
  const ink = useInk()
  const motionLevel = useMotionLevel()
  const maskId = useId()
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [pressed, setPressed] = useState(false)

  const assignRef = useCallback(
    (node: HTMLButtonElement | null) => {
      buttonRef.current = node
      if (typeof ref === 'function') {
        ref(node)
      } else if (ref && 'current' in ref) {
        ;(ref as { current: HTMLButtonElement | null }).current = node
      }
    },
    [ref],
  )

  const isDisabled = disabled || loading
  const showBrushLine =
    (variant === 'secondary' || variant === 'danger') && (hovered || focused) && !isDisabled

  const splatCenter = useCallback(() => {
    if (variant !== 'primary' || isDisabled) return
    const el = buttonRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    ink.splat({
      x: rect.left + rect.width * 0.5,
      y: rect.top + rect.height * 0.5,
      radius: 60,
      amount: 0.5,
      color: 'zhusha',
    })
  }, [ink, isDisabled, variant])

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      if (!isDisabled) {
        setPressed(true)
        splatCenter()
      }
      onPointerDown?.(e)
    },
    [isDisabled, onPointerDown, splatCenter],
  )

  const handlePointerEnter = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      setHovered(true)
      onPointerEnter?.(e)
    },
    [onPointerEnter],
  )

  const handlePointerLeave = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      setHovered(false)
      setPressed(false)
      onPointerLeave?.(e)
    },
    [onPointerLeave],
  )

  const handleFocus = useCallback(
    (e: React.FocusEvent<HTMLButtonElement>) => {
      setFocused(true)
      onFocus?.(e)
    },
    [onFocus],
  )

  const handleBlur = useCallback(
    (e: React.FocusEvent<HTMLButtonElement>) => {
      setFocused(false)
      setPressed(false)
      onBlur?.(e)
    },
    [onBlur],
  )

  const handleClick = useCallback(
    (e: ReactMouseEvent<HTMLButtonElement>) => {
      if (isDisabled) return
      // Keyboard activation (detail === 0) also emits the primary splat
      if (e.detail === 0) {
        splatCenter()
      }
      setPressed(false)
      onClick?.(e)
    },
    [isDisabled, onClick, splatCenter],
  )

  const height = size === 'sm' ? 32 : 40
  const fontSize = size === 'sm' ? 'var(--fs-small)' : 'var(--fs-body)'
  const lineHeight = size === 'sm' ? 'var(--lh-small)' : 'var(--lh-body)'

  let variantStyle: CSSProperties
  switch (variant) {
    case 'primary':
      variantStyle = {
        backgroundColor: pressed ? 'var(--zhusha-deep)' : 'var(--zhusha)',
        color: 'var(--plate)',
        padding: size === 'sm' ? '0 var(--sp-3)' : '0 20px',
        borderRadius: 'var(--radius)',
        fontWeight: 600,
      }
      break
    case 'secondary':
      variantStyle = {
        backgroundColor: 'transparent',
        color: 'var(--text-1)',
        padding: size === 'sm' ? '0 var(--sp-1)' : '0 var(--sp-2)',
        borderRadius: 0,
        fontWeight: 500,
      }
      break
    case 'ghost':
      variantStyle = {
        backgroundColor: 'transparent',
        color: hovered || focused ? 'var(--text-1)' : 'var(--text-2)',
        padding: size === 'sm' ? '0 var(--sp-1)' : '0 var(--sp-2)',
        borderRadius: 'var(--radius)',
        fontWeight: 400,
      }
      break
    case 'danger':
      variantStyle = {
        backgroundColor: 'transparent',
        color: 'var(--yanzhi)',
        padding: size === 'sm' ? '0 var(--sp-1)' : '0 var(--sp-2)',
        borderRadius: 0,
        fontWeight: 500,
      }
      break
  }

  const composedStyle: CSSProperties = {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'var(--sp-2)',
    height,
    border: 'none',
    fontFamily: 'var(--font-ui)',
    fontSize,
    lineHeight,
    whiteSpace: 'nowrap',
    userSelect: 'none',
    opacity: disabled ? 0.45 : 1,
    pointerEvents: disabled ? 'none' : undefined,
    transition: `color ${DUR.quick}s ease, background-color ${DUR.instant}s ease`,
    ...variantStyle,
    ...style,
  }

  const brushStrokeColor = variant === 'danger' ? 'var(--yanzhi)' : 'var(--zhusha)'
  const restingLineColor = variant === 'danger' ? 'var(--yanzhi)' : 'var(--hair-strong)'
  const brushInVariants = getPreset('brushIn', motionLevel)

  return (
    <motion.button
      ref={assignRef}
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={className}
      style={composedStyle}
      whileTap={!isDisabled && motionLevel === 'full' ? { scale: 0.96 } : undefined}
      transition={SPRING.press}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerUp={() => setPressed(false)}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onFocus={handleFocus}
      onBlur={handleBlur}
      {...(rest as Record<string, unknown>)}
    >
      <span>{children}</span>

      {/* Resting 1px hairline for secondary and danger variants */}
      {(variant === 'secondary' || variant === 'danger') && !showBrushLine && !loading ? (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: 1,
            backgroundColor: restingLineColor,
            pointerEvents: 'none',
          }}
        />
      ) : null}

      {/* Tapered brush stroke underline drawn with brushIn on hover/focus */}
      {showBrushLine && !loading ? (
        <svg
          aria-hidden="true"
          viewBox="0 0 120 6"
          preserveAspectRatio="none"
          style={UNDERLINE_SVG_STYLE}
        >
          <defs>
            <mask id={maskId} style={{ maskType: 'alpha' }}>
              <path
                d="M 0 3 Q 30 0.6 60 0.6 Q 90 0.6 120 3 Q 90 5.4 60 5.4 Q 30 5.4 0 3 Z"
                fill="white"
              />
            </mask>
          </defs>
          <g mask={`url(#${maskId})`}>
            <motion.path
              d="M 0 3 L 120 3"
              fill="none"
              stroke={brushStrokeColor}
              strokeWidth={6}
              strokeLinecap="round"
              variants={brushInVariants}
              initial="initial"
              animate="animate"
            />
          </g>
        </svg>
      ) : null}

      {/* Loading indicator: 30% zhusha sweep line (no rotating spinner) */}
      {loading ? (
        <span
          aria-hidden="true"
          data-loading-sweep="true"
          style={{
            ...LOADING_TRACK_STYLE,
            bottom: variant === 'primary' ? -4 : 0,
          }}
        >
          {motionLevel === 'full' ? (
            <motion.span
              style={{
                display: 'block',
                width: '30%',
                height: '100%',
                backgroundColor: variant === 'danger' ? 'var(--yanzhi)' : 'var(--zhusha)',
              }}
              animate={{ x: ['0%', '233.33%', '0%'] }}
              transition={{
                duration: LOADING_SWEEP_SEC,
                ease: EASE.brush,
                repeat: Infinity,
              }}
            />
          ) : (
            <span
              style={{
                display: 'block',
                width: '30%',
                height: '100%',
                margin: '0 auto',
                backgroundColor: variant === 'danger' ? 'var(--yanzhi)' : 'var(--zhusha)',
              }}
            />
          )}
        </span>
      ) : null}
    </motion.button>
  )
}
