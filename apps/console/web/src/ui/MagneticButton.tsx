import {
  useEffect,
  useRef,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from 'react'
import { motion, useMotionValue, useSpring } from 'motion/react'
import { SPRING } from '../motion/tokens.ts'
import { useMotionLevel } from '../motion/useMotionLevel.ts'

type OmittedMotionConflicts =
  | 'onAnimationStart'
  | 'onAnimationEnd'
  | 'onDrag'
  | 'onDragStart'
  | 'onDragEnd'

export interface MagneticButtonProps
  extends Omit<HTMLAttributes<HTMLDivElement>, OmittedMotionConflicts> {
  children: ReactNode
  disabled?: boolean
  radius?: number
  maxOffset?: number
  className?: string
  style?: CSSProperties
}

const DEFAULT_RADIUS_PX = 60
const DEFAULT_MAX_OFFSET_PX = 6

export function MagneticButton({
  children,
  disabled = false,
  radius = DEFAULT_RADIUS_PX,
  maxOffset = DEFAULT_MAX_OFFSET_PX,
  className,
  style,
  ...rest
}: MagneticButtonProps) {
  const motionLevel = useMotionLevel()
  const containerRef = useRef<HTMLDivElement | null>(null)

  const rawX = useMotionValue(0)
  const rawY = useMotionValue(0)
  const springX = useSpring(rawX, SPRING.magnet)
  const springY = useSpring(rawY, SPRING.magnet)

  const active = motionLevel === 'full' && !disabled

  useEffect(() => {
    if (!active || typeof window === 'undefined') {
      rawX.set(0)
      rawY.set(0)
      return
    }

    const onPointerMove = (e: PointerEvent): void => {
      if (e.pointerType === 'touch') return
      const el = containerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return

      const dxEdge = Math.max(rect.left - e.clientX, 0, e.clientX - rect.right)
      const dyEdge = Math.max(rect.top - e.clientY, 0, e.clientY - rect.bottom)
      const edgeDist = Math.hypot(dxEdge, dyEdge)

      if (edgeDist > radius) {
        if (rawX.get() !== 0 || rawY.get() !== 0) {
          rawX.set(0)
          rawY.set(0)
        }
        return
      }

      const cx = rect.left + rect.width * 0.5
      const cy = rect.top + rect.height * 0.5
      const vx = e.clientX - cx
      const vy = e.clientY - cy
      const dist = Math.hypot(vx, vy)
      const proximity = radius > 0 ? 1 - edgeDist / radius : 1
      const targetMag = Math.min(maxOffset, dist * 0.25) * proximity
      const nx = dist > 0.001 ? vx / dist : 0
      const ny = dist > 0.001 ? vy / dist : 0

      rawX.set(nx * targetMag)
      rawY.set(ny * targetMag)
    }

    const reset = (): void => {
      rawX.set(0)
      rawY.set(0)
    }

    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('blur', reset)
    document.addEventListener('pointerleave', reset)

    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('blur', reset)
      document.removeEventListener('pointerleave', reset)
      rawX.set(0)
      rawY.set(0)
    }
  }, [active, maxOffset, radius, rawX, rawY])

  return (
    <motion.div
      ref={containerRef}
      data-magnetic="true"
      className={className}
      style={{
        display: 'inline-flex',
        x: active ? springX : 0,
        y: active ? springY : 0,
        ...style,
      }}
      {...(rest as Record<string, unknown>)}
    >
      {children}
    </motion.div>
  )
}
