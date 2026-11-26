import {
  useEffect,
  useId,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
} from 'react'
import { motion } from 'motion/react'
import { DUR, EASE, SPRING } from '../motion/tokens.ts'
import { useMotionLevel } from '../motion/useMotionLevel.ts'

export interface BrushTabItem<T extends string = string> {
  readonly id: T
  readonly label: string
  readonly count?: number
  readonly disabled?: boolean
}

export type BrushTabsSize = 'sm' | 'md' | 'lg'

export interface BrushTabsProps<T extends string = string> {
  readonly items: readonly BrushTabItem<T>[]
  readonly value: T
  readonly onChange: (id: T) => void
  readonly size?: BrushTabsSize
  readonly layoutId?: string
  readonly ariaLabel?: string
  readonly className?: string
  readonly style?: CSSProperties
}

const SIZE_STYLES: Readonly<Record<BrushTabsSize, CSSProperties>> = {
  sm: {
    fontSize: 'var(--fs-small)',
    lineHeight: 'var(--lh-small)',
    padding: 'var(--sp-2) 2px',
  },
  md: {
    fontSize: 'var(--fs-body)',
    lineHeight: 'var(--lh-body)',
    padding: '10px 2px',
  },
  lg: {
    fontSize: 'var(--fs-h2)',
    lineHeight: 'var(--lh-h2)',
    padding: 'var(--sp-3) 2px',
  },
}

// Tapered zhusha brush stroke: narrow tips on both ends, thicker belly at center.
const BRUSH_UNDERLINE_PATH =
  'M 0 3.2 Q 18 1.0, 50 0.7 Q 82 1.0, 100 3.0 Q 82 5.2, 50 5.5 Q 18 5.2, 0 3.2 Z'

function findEnabledTabIndex<T extends string>(
  items: readonly BrushTabItem<T>[],
  fromIndex: number,
  direction: 1 | -1,
): number {
  const len = items.length
  if (len === 0) return -1
  let idx = fromIndex
  for (let i = 0; i < len; i += 1) {
    idx = (idx + direction + len) % len
    if (!items[idx]?.disabled) return idx
  }
  return -1
}

function findEdgeTabIndex<T extends string>(
  items: readonly BrushTabItem<T>[],
  edge: 'first' | 'last',
): number {
  if (edge === 'first') {
    for (let i = 0; i < items.length; i += 1) {
      if (!items[i]?.disabled) return i
    }
    return -1
  }
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (!items[i]?.disabled) return i
  }
  return -1
}

export function BrushTabs<T extends string = string>({
  items,
  value,
  onChange,
  size = 'md',
  layoutId,
  ariaLabel,
  className,
  style,
}: BrushTabsProps<T>) {
  const autoId = useId()
  const resolvedLayoutId = layoutId ?? `brush-tabs-${autoId}`
  const motionLevel = useMotionLevel()

  const buttonRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map())
  const prevValueRef = useRef<T>(value)
  const hasSwitchedRef = useRef(false)

  if (prevValueRef.current !== value) {
    hasSwitchedRef.current = true
  }

  useEffect(() => {
    prevValueRef.current = value
  }, [value])

  const handleKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void => {
    let targetIndex: number
    switch (event.key) {
      case 'ArrowRight':
        targetIndex = findEnabledTabIndex(items, index, 1)
        break
      case 'ArrowLeft':
        targetIndex = findEnabledTabIndex(items, index, -1)
        break
      case 'Home':
        targetIndex = findEdgeTabIndex(items, 'first')
        break
      case 'End':
        targetIndex = findEdgeTabIndex(items, 'last')
        break
      default:
        return
    }

    if (targetIndex < 0) return
    event.preventDefault()
    const target = items[targetIndex]
    if (!target || target.disabled) return
    onChange(target.id)
    buttonRefs.current.get(target.id)?.focus()
  }

  const sizeStyle = SIZE_STYLES[size]

  return (
    <div
      role="tablist"
      aria-orientation="horizontal"
      aria-label={ariaLabel}
      className={className}
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: 'clamp(var(--sp-4), 3vw, var(--sp-6))',
        minWidth: 0,
        maxWidth: '100%',
        overflowX: 'auto',
        overflowY: 'hidden',
        paddingBottom: '2px',
        borderBottom: '1px solid var(--hair)',
        ...style,
      }}
    >
      {items.map((item, index) => {
        const isActive = item.id === value
        return (
          <button
            key={item.id}
            ref={(el) => {
              buttonRefs.current.set(item.id, el)
            }}
            type="button"
            role="tab"
            id={`${resolvedLayoutId}-tab-${item.id}`}
            aria-selected={isActive}
            disabled={item.disabled}
            tabIndex={isActive ? 0 : -1}
            onClick={() => {
              if (!item.disabled && item.id !== value) {
                onChange(item.id)
              }
            }}
            onKeyDown={(event) => handleKeyDown(event, index)}
            style={{
              position: 'relative',
              display: 'inline-flex',
              alignItems: 'baseline',
              gap: 'var(--sp-2)',
              border: 0,
              background: 'transparent',
              color: isActive ? 'var(--text-1)' : 'var(--text-2)',
              fontWeight: isActive ? 600 : 400,
              cursor: item.disabled ? 'not-allowed' : 'pointer',
              opacity: item.disabled ? 0.4 : 1,
              whiteSpace: 'nowrap',
              flexShrink: 0,
              ...sizeStyle,
            }}
          >
            <span>{item.label}</span>

            {typeof item.count === 'number' ? (
              <span
                className="num"
                style={{
                  fontSize: 'var(--fs-label)',
                  lineHeight: 'var(--lh-label)',
                  color: isActive ? 'var(--zhusha)' : 'var(--text-3)',
                }}
              >
                {item.count}
              </span>
            ) : null}

            {isActive ? (
              motionLevel === 'full' ? (
                <motion.span
                  layoutId={resolvedLayoutId}
                  transition={SPRING.snappy}
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    bottom: -2,
                    height: '5px',
                    display: 'block',
                    pointerEvents: 'none',
                  }}
                >
                  <motion.svg
                    key={value}
                    viewBox="0 0 100 6"
                    preserveAspectRatio="none"
                    initial={{ scaleY: 1 }}
                    animate={
                      hasSwitchedRef.current
                        ? { scaleY: [1, 0.6, 1] }
                        : { scaleY: 1 }
                    }
                    transition={{ duration: DUR.base, ease: EASE.brush }}
                    style={{
                      display: 'block',
                      width: '100%',
                      height: '100%',
                      transformOrigin: '50% 100%',
                    }}
                  >
                    <path d={BRUSH_UNDERLINE_PATH} fill="var(--zhusha)" />
                  </motion.svg>
                </motion.span>
              ) : (
                <span
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    bottom: -2,
                    height: '5px',
                    display: 'block',
                    pointerEvents: 'none',
                  }}
                >
                  <svg
                    viewBox="0 0 100 6"
                    preserveAspectRatio="none"
                    style={{ display: 'block', width: '100%', height: '100%' }}
                  >
                    <path d={BRUSH_UNDERLINE_PATH} fill="var(--zhusha)" />
                  </svg>
                </span>
              )
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
