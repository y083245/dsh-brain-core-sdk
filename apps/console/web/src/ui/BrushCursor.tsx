import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react'
import { createPortal } from 'react-dom'
import { motion, useMotionValue, useSpring } from 'motion/react'
import { useInktideStore } from '../data/store.ts'
import { useInk } from '../ink/InkProvider.tsx'
import { DUR, SPRING } from '../motion/tokens.ts'
import { useMotionLevel } from '../motion/useMotionLevel.ts'

export interface BrushCursorProps {
  enabled?: boolean
  className?: string
}

type CursorKind = 'default' | 'interactive' | 'text' | 'graph'

const FINE_POINTER_QUERY = '(pointer: fine)'
const INTERACTIVE_SELECTOR =
  'a, button, [role="button"], [data-cursor="interactive"], [data-magnetic]'
const TEXT_SELECTOR = 'input, textarea, [contenteditable="true"], [data-cursor="text"]'
const GRAPH_SELECTOR = '[data-cursor="graph"]'
const MAGNETIC_SELECTOR = '[data-magnetic]'

const DEFAULT_RING_DIAMETER = 28
const MAX_RING_DIAMETER = 72
const RING_PADDING = 12
const SVG_BOX_SIZE = 80
const SVG_CENTER = SVG_BOX_SIZE / 2

function getFinePointerMatches(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }
  return window.matchMedia(FINE_POINTER_QUERY).matches
}

function getServerFinePointer(): boolean {
  return false
}

function subscribeFinePointer(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {}
  }
  const mql = window.matchMedia(FINE_POINTER_QUERY)
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }
  if (typeof mql.addListener === 'function') {
    mql.addListener(onChange)
    return () => mql.removeListener(onChange)
  }
  return () => {}
}

function useFinePointer(): boolean {
  return useSyncExternalStore(
    subscribeFinePointer,
    getFinePointerMatches,
    getServerFinePointer,
  )
}

const OVERLAY_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  pointerEvents: 'none',
  zIndex: 9999,
}

const FIXED_LAYER_STYLE: CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  pointerEvents: 'none',
  willChange: 'transform',
}

const RING_SVG_STYLE: CSSProperties = {
  display: 'block',
  marginLeft: -SVG_CENTER,
  marginTop: -SVG_CENTER,
  overflow: 'visible',
}

const DOT_BASE_STYLE: CSSProperties = {
  position: 'absolute',
  width: 8,
  height: 8,
  marginLeft: -4,
  marginTop: -4,
  borderRadius: '50%',
}

const TEXT_BAR_STYLE: CSSProperties = {
  position: 'absolute',
  width: 2,
  height: 20,
  marginLeft: -1,
  marginTop: -10,
  backgroundColor: 'var(--text-1)',
}

const CROSSHAIR_H_STYLE: CSSProperties = {
  position: 'absolute',
  width: 12,
  height: 1,
  marginLeft: -6,
  marginTop: -0.5,
  backgroundColor: 'var(--text-1)',
}

const CROSSHAIR_V_STYLE: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 12,
  marginLeft: -0.5,
  marginTop: -6,
  backgroundColor: 'var(--text-1)',
}

export function BrushCursor({ enabled = true, className }: BrushCursorProps) {
  const ink = useInk()
  const motionLevel = useMotionLevel()
  const cursorMode = useInktideStore((s) => s.cursorMode)
  const isFinePointer = useFinePointer()

  const active = enabled && isFinePointer && motionLevel === 'full' && cursorMode === 'brush'

  const [visible, setVisible] = useState(false)
  const [kind, setKind] = useState<CursorKind>('default')
  const [ringDiameter, setRingDiameter] = useState(DEFAULT_RING_DIAMETER)
  const [pressed, setPressed] = useState(false)

  const rawDotX = useMotionValue(-100)
  const rawDotY = useMotionValue(-100)
  const rawRingX = useMotionValue(-100)
  const rawRingY = useMotionValue(-100)

  const dotX = useSpring(rawDotX, SPRING.magnet)
  const dotY = useSpring(rawDotY, SPRING.magnet)
  const ringX = useSpring(rawRingX, SPRING.float)
  const ringY = useSpring(rawRingY, SPRING.float)

  const stateRef = useRef({
    visible: false,
    kind: 'default' as CursorKind,
    ringDiameter: DEFAULT_RING_DIAMETER,
    pressed: false,
  })

  useEffect(() => {
    if (typeof document === 'undefined') return
    if (!active) {
      document.documentElement.classList.remove('has-brush-cursor')
      return
    }

    document.documentElement.classList.add('has-brush-cursor')

    let hasLastInkSample = false
    let lastInkX = 0
    let lastInkY = 0
    let pendingInk = false
    let latestX = 0
    let latestY = 0
    let latestDown = false
    let rafId = 0

    const flushInkPointer = (): void => {
      rafId = window.requestAnimationFrame(flushInkPointer)
      if (!pendingInk) return
      pendingInk = false
      if (!hasLastInkSample) {
        hasLastInkSample = true
        lastInkX = latestX
        lastInkY = latestY
        ink.pointer({ x: latestX, y: latestY, dx: 0, dy: 0, down: latestDown })
        return
      }
      const dx = latestX - lastInkX
      const dy = latestY - lastInkY
      lastInkX = latestX
      lastInkY = latestY
      ink.pointer({ x: latestX, y: latestY, dx, dy, down: latestDown })
    }

    rafId = window.requestAnimationFrame(flushInkPointer)

    const updateHoverState = (target: EventTarget | null, clientX: number, clientY: number): void => {
      let nextKind: CursorKind = 'default'
      let nextRingDiameter = DEFAULT_RING_DIAMETER
      let targetRingX = clientX
      let targetRingY = clientY

      if (target instanceof Element) {
        const textEl = target.closest(TEXT_SELECTOR)
        if (textEl) {
          nextKind = 'text'
        } else {
          const graphEl = target.closest(GRAPH_SELECTOR)
          if (graphEl) {
            nextKind = 'graph'
          } else {
            const interactiveEl = target.closest(INTERACTIVE_SELECTOR)
            if (interactiveEl) {
              nextKind = 'interactive'
              const rect = interactiveEl.getBoundingClientRect()
              nextRingDiameter = Math.min(
                MAX_RING_DIAMETER,
                Math.max(DEFAULT_RING_DIAMETER, Math.max(rect.width, rect.height) + RING_PADDING),
              )
              const magneticEl = interactiveEl.matches(MAGNETIC_SELECTOR)
                ? interactiveEl
                : interactiveEl.closest(MAGNETIC_SELECTOR)
              if (magneticEl) {
                const magRect = magneticEl.getBoundingClientRect()
                targetRingX = magRect.left + magRect.width * 0.5
                targetRingY = magRect.top + magRect.height * 0.5
              }
            }
          }
        }
      }

      if (!stateRef.current.visible) {
        rawDotX.jump(clientX)
        rawDotY.jump(clientY)
        rawRingX.jump(targetRingX)
        rawRingY.jump(targetRingY)
        stateRef.current.visible = true
        setVisible(true)
      } else {
        rawDotX.set(clientX)
        rawDotY.set(clientY)
        rawRingX.set(targetRingX)
        rawRingY.set(targetRingY)
      }

      if (stateRef.current.kind !== nextKind) {
        stateRef.current.kind = nextKind
        setKind(nextKind)
      }
      if (Math.abs(stateRef.current.ringDiameter - nextRingDiameter) >= 0.5) {
        stateRef.current.ringDiameter = nextRingDiameter
        setRingDiameter(nextRingDiameter)
      }
    }

    const onPointerMove = (e: PointerEvent): void => {
      if (e.pointerType === 'touch') return
      latestX = e.clientX
      latestY = e.clientY
      latestDown = (e.buttons & 1) !== 0
      pendingInk = true
      updateHoverState(e.target, e.clientX, e.clientY)
    }

    const onPointerDown = (e: PointerEvent): void => {
      if (e.pointerType === 'touch') return
      latestX = e.clientX
      latestY = e.clientY
      latestDown = true
      pendingInk = true

      if (!stateRef.current.pressed) {
        stateRef.current.pressed = true
        setPressed(true)
      }
      updateHoverState(e.target, e.clientX, e.clientY)
      ink.splat({
        x: e.clientX,
        y: e.clientY,
        radius: 30,
        color: 'zhusha',
        amount: 0.25,
      })
    }

    const onPointerUp = (e: PointerEvent): void => {
      if (e.pointerType === 'touch') return
      latestX = e.clientX
      latestY = e.clientY
      latestDown = false
      pendingInk = true
      if (stateRef.current.pressed) {
        stateRef.current.pressed = false
        setPressed(false)
      }
    }

    const onHide = (): void => {
      hasLastInkSample = false
      if (stateRef.current.visible) {
        stateRef.current.visible = false
        setVisible(false)
      }
      if (stateRef.current.pressed) {
        stateRef.current.pressed = false
        setPressed(false)
      }
    }

    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('pointerdown', onPointerDown, { passive: true })
    window.addEventListener('pointerup', onPointerUp, { passive: true })
    window.addEventListener('blur', onHide)
    document.addEventListener('pointerleave', onHide)

    return () => {
      document.documentElement.classList.remove('has-brush-cursor')
      window.cancelAnimationFrame(rafId)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('blur', onHide)
      document.removeEventListener('pointerleave', onHide)
      stateRef.current.visible = false
      stateRef.current.pressed = false
      stateRef.current.kind = 'default'
      stateRef.current.ringDiameter = DEFAULT_RING_DIAMETER
    }
  }, [active, ink, rawDotX, rawDotY, rawRingX, rawRingY])

  if (!active || typeof document === 'undefined') {
    return null
  }

  const showRing = visible && (kind === 'default' || kind === 'interactive')
  const showDot = visible && (pressed || kind === 'default')
  const showTextBar = visible && !pressed && kind === 'text'
  const showCrosshair = visible && !pressed && kind === 'graph'
  const ringStroke = kind === 'interactive' ? 'var(--zhusha)' : 'var(--hair-strong)'

  // Dialogs and drawers portal to the body, above the app's stacking context.
  return createPortal(
    <div aria-hidden="true" className={className} data-brush-cursor-mode={kind} style={OVERLAY_STYLE}>
      {/* Trailing ring (SPRING.float) */}
      <motion.div
        style={{
          ...FIXED_LAYER_STYLE,
          x: ringX,
          y: ringY,
        }}
      >
        <svg
          width={SVG_BOX_SIZE}
          height={SVG_BOX_SIZE}
          viewBox={`0 0 ${SVG_BOX_SIZE} ${SVG_BOX_SIZE}`}
          style={RING_SVG_STYLE}
        >
          <motion.circle
            cx={SVG_CENTER}
            cy={SVG_CENTER}
            fill="none"
            strokeWidth={1}
            initial={false}
            animate={{
              r: ringDiameter / 2,
              opacity: showRing ? 1 : 0,
              stroke: ringStroke,
            }}
            transition={SPRING.float}
          />
        </svg>
      </motion.div>

      {/* Leading brush tip (SPRING.magnet) */}
      <motion.div
        style={{
          ...FIXED_LAYER_STYLE,
          x: dotX,
          y: dotY,
        }}
      >
        <motion.span
          style={DOT_BASE_STYLE}
          initial={false}
          animate={{
            opacity: showDot ? 1 : 0,
            scale: showDot ? (pressed ? 14 / 8 : 1) : 0,
            backgroundColor: pressed ? 'var(--zhusha)' : 'var(--text-1)',
          }}
          transition={pressed ? SPRING.press : { duration: DUR.instant }}
        />

        {showTextBar ? <span style={TEXT_BAR_STYLE} /> : null}

        {showCrosshair ? (
          <>
            <span style={CROSSHAIR_H_STYLE} />
            <span style={CROSSHAIR_V_STYLE} />
          </>
        ) : null}
      </motion.div>
    </div>,
    document.body,
  )
}
