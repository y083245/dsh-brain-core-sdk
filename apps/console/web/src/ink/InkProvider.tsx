import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { useInktideStore } from '../data/store.ts'
import { DUR, FLOOD_COVER_END_MS, FLOOD_COVER_START_MS } from '../motion/tokens.ts'
import { useMotionLevel } from '../motion/useMotionLevel.ts'
import {
  createInkEngine,
  type EnsoInstanceSpec,
  type ExternalRenderHook,
  type InkEngine,
  type InkEngineStats,
  type InkTheme,
  type QualityTier,
} from './engine.ts'

export const InkContext = createContext<InkEngine | null>(null)

const CANVAS_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  width: '100%',
  height: '100%',
  zIndex: 0,
  pointerEvents: 'none',
}

const CONTEXT_LOST_WASH_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  width: '100%',
  height: '100%',
  zIndex: 0,
  pointerEvents: 'none',
  backgroundColor: 'var(--ink-void)',
  backgroundImage:
    'radial-gradient(ellipse 56% 52% at 48% 42%, color-mix(in srgb, var(--smoke) 14%, transparent) 0%, color-mix(in srgb, var(--smoke) 5%, transparent) 48%, transparent 78%), radial-gradient(ellipse 38% 36% at 32% 66%, color-mix(in srgb, var(--smoke) 9%, transparent) 0%, transparent 72%)',
}

const CONTENT_LAYER_STYLE: CSSProperties = {
  position: 'relative',
  zIndex: 1,
  minHeight: '100vh',
}

interface RetainedEngineState {
  theme: InkTheme
  quality: QualityTier | 'auto'
  calm: boolean
  reducedMotion: boolean
  ensos: Map<string, EnsoInstanceSpec>
  externalHook: ExternalRenderHook | null
}

function createNoopStats(retained: RetainedEngineState): InkEngineStats {
  return {
    backend: 'static-2d',
    quality: retained.quality === 'auto' ? 'static' : retained.quality,
    lockedQuality: retained.quality === 'auto' ? null : retained.quality,
    calm: retained.calm,
    theme: retained.theme,
    reducedMotion: retained.reducedMotion,
    floatSupported: false,
    contextLost: false,
    avgFrameMs: null,
    lastFrameMs: 0,
    gpuFrameMs: null,
    simResolution: [0, 0],
    dyeResolution: [0, 0],
    ensoCount: retained.ensos.size,
  }
}

export interface InkProviderProps {
  children: ReactNode
}

export function InkProvider({ children }: InkProviderProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const floodCoverRef = useRef<Animation | null>(null)
  const engineRef = useRef<InkEngine | null>(null)
  const [contextLost, setContextLost] = useState(false)

  const resolvedTheme = useInktideStore((s) => s.resolvedTheme)
  const qualityPreference = useInktideStore((s) => s.qualityPreference)
  const motionLevel = useMotionLevel()

  const retainedRef = useRef<RetainedEngineState>({
    theme: resolvedTheme,
    quality: qualityPreference,
    calm: false,
    reducedMotion: motionLevel === 'reduced',
    ensos: new Map(),
    externalHook: null,
  })

  const facade = useMemo<InkEngine>(() => {
    const retained = retainedRef.current
    return {
      splat(p) {
        engineRef.current?.splat(p)
      },
      stir(p) {
        return engineRef.current ? engineRef.current.stir(p) : () => {}
      },
      flood(p) {
        const engine = engineRef.current
        if (!engine) return Promise.resolve()
        const stats = engine.getStats()
        if (!retained.reducedMotion && stats.backend === 'webgl2' && !stats.contextLost) {
          // The single WebGL canvas is under the DOM. Reveal its full-cover pass at peak ink.
          floodCoverRef.current?.cancel()
          floodCoverRef.current = contentRef.current?.animate?.([
            { opacity: 1, offset: 0 },
            { opacity: 1, offset: FLOOD_COVER_START_MS / FLOOD_COVER_END_MS },
            { opacity: 0, offset: DUR.flood * 1000 / FLOOD_COVER_END_MS },
            { opacity: 1, offset: 1 },
          ], FLOOD_COVER_END_MS) ?? null
        }
        return engine.flood(p)
      },
      dilute(rect, durationMs) {
        engineRef.current?.dilute(rect, durationMs)
      },
      setCalm(calm) {
        retained.calm = calm
        engineRef.current?.setCalm(calm)
      },
      pointer(p) {
        engineRef.current?.pointer(p)
      },
      setTheme(theme) {
        retained.theme = theme
        engineRef.current?.setTheme(theme)
      },
      setQuality(q) {
        retained.quality = q
        engineRef.current?.setQuality(q)
      },
      setAutoQuality() {
        retained.quality = 'auto'
        engineRef.current?.setAutoQuality()
      },
      setReducedMotion(reduced) {
        retained.reducedMotion = reduced
        if (reduced) floodCoverRef.current?.cancel()
        engineRef.current?.setReducedMotion(reduced)
      },
      setEnso(spec) {
        retained.ensos.set(spec.id, {
          ...spec,
          rect: { ...spec.rect },
        })
        engineRef.current?.setEnso(spec)
      },
      removeEnso(id) {
        retained.ensos.delete(id)
        engineRef.current?.removeEnso(id)
      },
      pulseEnso(id) {
        engineRef.current?.pulseEnso(id)
      },
      getStats() {
        return engineRef.current
          ? engineRef.current.getStats()
          : createNoopStats(retained)
      },
      getGLContext() {
        return engineRef.current ? engineRef.current.getGLContext() : null
      },
      setExternalRenderHook(hook) {
        retained.externalHook = hook
        engineRef.current?.setExternalRenderHook(hook)
      },
      resetState() {
        engineRef.current?.resetState()
      },
      simulateContextLoss() {
        engineRef.current?.simulateContextLoss?.()
      },
      dispose() {
        engineRef.current?.dispose()
        engineRef.current = null
      },
    }
  }, [])

  // Mount single WebGL2 InkEngine once on <canvas id="ink">
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const engine = createInkEngine(canvas)
    engineRef.current = engine

    // Sync any state/Enso instances registered prior to mount (or across StrictMode remount)
    const retained = retainedRef.current
    engine.setTheme(retained.theme)
    engine.setReducedMotion(retained.reducedMotion)
    engine.setCalm(retained.calm)
    if (retained.quality === 'auto') {
      engine.setAutoQuality()
    } else {
      engine.setQuality(retained.quality)
    }
    if (retained.externalHook) {
      engine.setExternalRenderHook(retained.externalHook)
    }
    for (const spec of retained.ensos.values()) {
      engine.setEnso(spec)
    }

    const handleLost = (): void => {
      floodCoverRef.current?.cancel()
      setContextLost(true)
    }
    const handleRestored = (): void => setContextLost(false)
    canvas.addEventListener('webglcontextlost', handleLost, false)
    canvas.addEventListener('webglcontextrestored', handleRestored, false)

    return () => {
      canvas.removeEventListener('webglcontextlost', handleLost)
      canvas.removeEventListener('webglcontextrestored', handleRestored)
      floodCoverRef.current?.cancel()
      floodCoverRef.current = null
      setContextLost(false)
      engine.dispose()
      if (engineRef.current === engine) {
        engineRef.current = null
      }
    }
  }, [])

  // Sync resolvedTheme from store
  useEffect(() => {
    facade.setTheme(resolvedTheme)
  }, [facade, resolvedTheme])

  // Sync qualityPreference from store
  useEffect(() => {
    if (qualityPreference === 'auto') {
      facade.setAutoQuality()
    } else {
      facade.setQuality(qualityPreference)
    }
  }, [facade, qualityPreference])

  // Sync motion level (store preference + OS prefers-reduced-motion)
  useEffect(() => {
    facade.setReducedMotion(motionLevel === 'reduced')
  }, [facade, motionLevel])

  // Global pointer tracking when motion level is 'full'
  useEffect(() => {
    if (motionLevel !== 'full' || typeof window === 'undefined') {
      return
    }

    let hasLast = false
    let lastX = 0
    let lastY = 0

    const onPointerMove = (e: PointerEvent): void => {
      if (document.documentElement.classList.contains('has-brush-cursor')) return
      const x = e.clientX
      const y = e.clientY
      if (!hasLast) {
        hasLast = true
        lastX = x
        lastY = y
        return
      }
      const dx = x - lastX
      const dy = y - lastY
      lastX = x
      lastY = y
      facade.pointer({
        x,
        y,
        dx,
        dy,
        down: (e.buttons & 1) !== 0,
      })
    }

    const onPointerDown = (e: PointerEvent): void => {
      if (document.documentElement.classList.contains('has-brush-cursor')) return
      hasLast = true
      lastX = e.clientX
      lastY = e.clientY
      facade.pointer({
        x: e.clientX,
        y: e.clientY,
        dx: 0,
        dy: 0,
        down: true,
      })
    }

    const resetLast = (): void => {
      hasLast = false
    }

    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('pointerdown', onPointerDown, { passive: true })
    window.addEventListener('blur', resetLast)
    document.addEventListener('pointerleave', resetLast)

    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('blur', resetLast)
      document.removeEventListener('pointerleave', resetLast)
    }
  }, [facade, motionLevel])

  return (
    <InkContext.Provider value={facade}>
      <canvas id="ink" ref={canvasRef} aria-hidden="true" style={CANVAS_STYLE} />
      {contextLost ? (
        <div
          data-testid="ink-context-lost-wash"
          aria-hidden="true"
          style={CONTEXT_LOST_WASH_STYLE}
        />
      ) : null}
      <div ref={contentRef} style={CONTENT_LAYER_STYLE}>{children}</div>
    </InkContext.Provider>
  )
}

export function useInk(): InkEngine {
  const ctx = useContext(InkContext)
  if (!ctx) {
    throw new Error('useInk must be used within an InkProvider')
  }
  return ctx
}
