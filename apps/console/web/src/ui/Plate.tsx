import {
  useCallback,
  useRef,
  type CSSProperties,
  type HTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from 'react'
import { motion } from 'motion/react'
import { DUR, SPRING } from '../motion/tokens.ts'
import { useMotionLevel } from '../motion/useMotionLevel.ts'

export type PlateLevel = 'base' | 'raised' | 'sunken'
export type PlateTone = 'default' | 'warn' | 'danger'
export type PlateTag = 'div' | 'section' | 'article' | 'aside' | 'main' | 'header' | 'footer'

type OmittedMotionConflicts =
  | 'onAnimationStart'
  | 'onAnimationEnd'
  | 'onDrag'
  | 'onDragStart'
  | 'onDragEnd'

export interface PlateProps extends Omit<HTMLAttributes<HTMLElement>, OmittedMotionConflicts> {
  level?: PlateLevel
  interactive?: boolean
  tone?: PlateTone
  as?: PlateTag
  className?: string
  style?: CSSProperties
  children?: ReactNode
  ref?: Ref<HTMLElement>
}

const LEVEL_BACKGROUND: Readonly<Record<PlateLevel, string>> = {
  base: 'var(--plate)',
  raised: 'var(--plate-raised)',
  sunken: 'var(--plate-sunken)',
}

const LEVEL_SHADOW: Readonly<Record<PlateLevel, string>> = {
  base: 'var(--shadow-plate)',
  raised: 'var(--shadow-raised)',
  sunken: 'none',
}

const MOTION_ELEMENTS = {
  div: motion.div,
  section: motion.section,
  article: motion.article,
  aside: motion.aside,
  main: motion.main,
  header: motion.header,
  footer: motion.footer,
} as const

const HIGHLIGHT_LAYER_STYLE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  pointerEvents: 'none',
  borderRadius: 'inherit',
  backgroundImage:
    'radial-gradient(240px circle at var(--mx, -999px) var(--my, -999px), var(--hair), transparent 70%)',
  opacity: 'var(--plate-glow-opacity, 0)',
  transition: `opacity ${DUR.quick}s ease`,
}

export function Plate({
  level = 'base',
  interactive = false,
  tone = 'default',
  as = 'div',
  className,
  style,
  children,
  ref,
  onPointerEnter,
  onPointerMove,
  onPointerLeave,
  ...rest
}: PlateProps) {
  const motionLevel = useMotionLevel()
  const localRef = useRef<HTMLElement | null>(null)

  const assignRef = useCallback(
    (node: HTMLElement | null) => {
      localRef.current = node
      if (typeof ref === 'function') {
        ref(node)
      } else if (ref && 'current' in ref) {
        ;(ref as { current: HTMLElement | null }).current = node
      }
    },
    [ref],
  )

  const handlePointerEnter = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (interactive) {
        const el = localRef.current
        if (el) {
          el.style.setProperty('--plate-shadow', 'var(--shadow-raised)')
        }
      }
      onPointerEnter?.(e)
    },
    [interactive, onPointerEnter],
  )

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (interactive) {
        const el = localRef.current
        if (el) {
          const rect = el.getBoundingClientRect()
          const x = e.clientX - rect.left
          const y = e.clientY - rect.top
          el.style.setProperty('--mx', `${x}px`)
          el.style.setProperty('--my', `${y}px`)
          el.style.setProperty('--plate-glow-opacity', '1')
        }
      }
      onPointerMove?.(e)
    },
    [interactive, onPointerMove],
  )

  const handlePointerLeave = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (interactive) {
        const el = localRef.current
        if (el) {
          el.style.removeProperty('--plate-shadow')
          el.style.setProperty('--plate-glow-opacity', '0')
        }
      }
      onPointerLeave?.(e)
    },
    [interactive, onPointerLeave],
  )

  const baseShadow = LEVEL_SHADOW[level]
  const composedStyle: CSSProperties = {
    position: 'relative',
    backgroundColor: LEVEL_BACKGROUND[level],
    borderRadius: 'var(--radius)',
    boxShadow: interactive ? `var(--plate-shadow, ${baseShadow})` : baseShadow,
    transition: interactive ? `box-shadow ${DUR.quick}s ease` : undefined,
    ...style,
  }

  const classes = className ? `plate ${className}` : 'plate'
  const MotionTag = MOTION_ELEMENTS[as] as typeof motion.div

  return (
    <MotionTag
      ref={assignRef as Ref<HTMLDivElement>}
      className={classes}
      style={composedStyle}
      whileHover={interactive && motionLevel === 'full' ? { y: -2 } : undefined}
      transition={interactive ? SPRING.float : undefined}
      onPointerEnter={handlePointerEnter as HTMLAttributes<HTMLDivElement>['onPointerEnter']}
      onPointerMove={handlePointerMove as HTMLAttributes<HTMLDivElement>['onPointerMove']}
      onPointerLeave={handlePointerLeave as HTMLAttributes<HTMLDivElement>['onPointerLeave']}
      data-cursor={interactive ? 'interactive' : undefined}
      {...(rest as Record<string, unknown>)}
      data-tone={tone === 'default' ? undefined : tone}
    >
      {interactive ? <span aria-hidden="true" style={HIGHLIGHT_LAYER_STYLE} /> : null}
      {children}
    </MotionTag>
  )
}
