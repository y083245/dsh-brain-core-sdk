import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { motion, AnimatePresence } from 'motion/react'
import {
  inktideStore,
  useInktideStore,
  type QualityPreference,
  type ThemeMode,
} from '../data/store.ts'
import {
  type EnsoState,
  type InkEngineStats,
} from '../ink/engine.ts'
import { useInk } from '../ink/InkProvider.tsx'
import { DUR, EASE, QUALITY } from '../motion/tokens.ts'
import { useMotionLevel } from '../motion/useMotionLevel.ts'

interface InktideDevHandle {
  getStats(): InkEngineStats
  getLastFloodResolveMs(): number | null
  getEnsoState(): EnsoState
}

declare global {
  interface Window {
    __INKTIDE_DEV__?: InktideDevHandle
  }
}

const ENSO_STATES: readonly EnsoState[] = [
  'idle',
  'listening',
  'thinking',
  'speaking',
  'offline',
  'error',
  'recovering',
]

const QUALITY_OPTIONS: readonly QualityPreference[] = [
  'auto',
  'high',
  'medium',
  'low',
  'static',
]

const THEME_OPTIONS: readonly { mode: ThemeMode; label: string }[] = [
  { mode: 'night', label: '夜墨' },
  { mode: 'paper', label: '宣纸' },
  { mode: 'auto', label: '自动' },
]

const DEV_ENSO_ID = 'dev-ink-enso'

function getButtonStyle(active = false, accent = false): CSSProperties {
  if (accent) {
    return {
      borderRadius: 'var(--radius)',
      backgroundColor: 'var(--zhusha)',
      color: 'var(--plate)',
      border: '1px solid var(--zhusha)',
      fontSize: 'var(--fs-small)',
      lineHeight: '18px',
      padding: '4px 8px',
      cursor: 'pointer',
      fontWeight: 600,
    }
  }
  return {
    borderRadius: 'var(--radius)',
    backgroundColor: active ? 'var(--plate-raised)' : 'var(--plate-sunken)',
    color: active ? 'var(--text-1)' : 'var(--text-2)',
    border: active ? '1px solid var(--zhusha)' : '1px solid var(--hair-strong)',
    fontSize: 'var(--fs-small)',
    lineHeight: '18px',
    padding: '4px 8px',
    cursor: 'pointer',
    fontWeight: active ? 600 : 400,
  }
}

const SECTION_HEADING_STYLE: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-label)',
  lineHeight: 'var(--lh-label)',
  fontWeight: 600,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--text-2)',
  paddingBottom: 'var(--sp-1)',
  borderBottom: '1px solid var(--hair)',
  marginBottom: 'var(--sp-2)',
}

export function DevInkPage() {
  const ink = useInk()
  const themeMode = useInktideStore((s) => s.themeMode)
  const qualityPreference = useInktideStore((s) => s.qualityPreference)
  const motionPreference = useInktideStore((s) => s.motionPreference)
  const motionLevel = useMotionLevel()

  const poolRef = useRef<HTMLDivElement | null>(null)
  const ensoAnchorRef = useRef<HTMLDivElement | null>(null)
  const diluteZoneRef = useRef<HTMLDivElement | null>(null)

  const [ensoState, setEnsoState] = useState<EnsoState>('idle')
  const [calm, setCalm] = useState(false)
  const [manualStirActive, setManualStirActive] = useState(false)
  const [lastFloodResolveMs, setLastFloodResolveMs] = useState<number | null>(null)
  const [ripples, setRipples] = useState<readonly number[]>([])
  const [stats, setStats] = useState<InkEngineStats>(() => ink.getStats())

  const brushInRef = useRef(1)
  const brushInRafRef = useRef<number | null>(null)
  const manualStirStopRef = useRef<(() => void) | null>(null)
  const thinkingStirStopRef = useRef<(() => void) | null>(null)
  const diluteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rippleCounterRef = useRef(1)
  const lastFloodRef = useRef<number | null>(null)
  const ensoStateRef = useRef<EnsoState>(ensoState)

  useEffect(() => {
    ensoStateRef.current = ensoState
  }, [ensoState])

  useEffect(() => {
    lastFloodRef.current = lastFloodResolveMs
  }, [lastFloodResolveMs])

  const syncEnsoRect = useCallback(
    (state: EnsoState, brushInProgress: number) => {
      const el = ensoAnchorRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      ink.setEnso({
        id: DEV_ENSO_ID,
        rect: { x: r.left, y: r.top, w: r.width, h: r.height },
        state,
        brushInProgress,
        visible: true,
      })
    },
    [ink],
  )

  const triggerRipple = useCallback(() => {
    const id = rippleCounterRef.current++
    setRipples((prev) => [...prev.slice(-4), id])
    setTimeout(() => {
      setRipples((prev) => prev.filter((item) => item !== id))
    }, 650)
  }, [])

  // Register & keep Enso screen rect synchronized
  useEffect(() => {
    const el = ensoAnchorRef.current
    if (!el) return

    const update = () => syncEnsoRect(ensoState, brushInRef.current)
    update()

    const ro = new ResizeObserver(update)
    ro.observe(el)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, { passive: true })

    return () => {
      ro.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update)
    }
  }, [ensoState, syncEnsoRect])

  // Cleanup Enso, active stirs, and timers on unmount
  useEffect(() => {
    return () => {
      ink.removeEnso(DEV_ENSO_ID)
      ink.setCalm(false)
      if (manualStirStopRef.current) {
        manualStirStopRef.current()
        manualStirStopRef.current = null
      }
      if (thinkingStirStopRef.current) {
        thinkingStirStopRef.current()
        thinkingStirStopRef.current = null
      }
      if (brushInRafRef.current !== null) {
        window.cancelAnimationFrame(brushInRafRef.current)
      }
      if (diluteTimerRef.current !== null) {
        clearTimeout(diluteTimerRef.current)
      }
    }
  }, [ink])

  // Auto-stir around Enso when entering 'thinking' state (§5.5)
  useEffect(() => {
    if (ensoState !== 'thinking') {
      if (thinkingStirStopRef.current) {
        thinkingStirStopRef.current()
        thinkingStirStopRef.current = null
      }
      return
    }

    const el = ensoAnchorRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const stop = ink.stir({
      x: r.left + r.width * 0.5,
      y: r.top + r.height * 0.5,
      radius: 140,
      strength: 0.9,
      durationMs: 0,
    })
    thinkingStirStopRef.current = stop

    return () => {
      stop()
      if (thinkingStirStopRef.current === stop) {
        thinkingStirStopRef.current = null
      }
    }
  }, [ensoState, ink])

  // Periodic gentle ripple while in 'listening' state (full motion only)
  useEffect(() => {
    if (ensoState !== 'listening' || motionLevel !== 'full') {
      return
    }
    const timer = setInterval(triggerRipple, 1100)
    return () => clearInterval(timer)
  }, [ensoState, motionLevel, triggerRipple])

  // Poll live engine stats for HUD (250ms) and expose dev-only read-only handle
  useEffect(() => {
    const refresh = () => setStats(ink.getStats())
    refresh()
    const timer = setInterval(refresh, 250)

    const devHandle: InktideDevHandle = {
      getStats: () => ink.getStats(),
      getLastFloodResolveMs: () => lastFloodRef.current,
      getEnsoState: () => ensoStateRef.current,
    }
    window.__INKTIDE_DEV__ = devHandle

    return () => {
      clearInterval(timer)
      if (window.__INKTIDE_DEV__ === devHandle) {
        delete window.__INKTIDE_DEV__
      }
    }
  }, [ink])

  const getOpenPoolCenter = (): { x: number; y: number } => {
    const el = poolRef.current
    if (el) {
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.45 }
    }
    return { x: window.innerWidth * 0.38, y: window.innerHeight * 0.45 }
  }

  const handleSplatSmoke = () => {
    const { x, y } = getOpenPoolCenter()
    ink.splat({ x, y, dx: 48, dy: -22, radius: 70, amount: 0.65, color: 'smoke' })
  }

  const handleSplatZhusha = () => {
    const { x, y } = getOpenPoolCenter()
    ink.splat({ x, y, dx: -40, dy: 28, radius: 65, amount: 0.6, color: 'zhusha' })
  }

  const handleSplatStamp = () => {
    const { x, y } = getOpenPoolCenter()
    // §5.4 stamp splat: center radius 90, amount 0.8 + 6 radial splats radius 24, dx/dy ±120
    ink.splat({ x, y, dx: 0, dy: 0, radius: 90, amount: 0.8, color: 'zhusha' })
    for (let i = 0; i < 6; i += 1) {
      const angle = (Math.PI * 2 * i) / 6
      ink.splat({
        x: x + Math.cos(angle) * 20,
        y: y + Math.sin(angle) * 20,
        dx: Math.cos(angle) * 120,
        dy: Math.sin(angle) * 120,
        radius: 24,
        amount: 0.42,
        color: 'zhusha',
      })
    }
  }

  const handleToggleStir = () => {
    if (manualStirActive) {
      if (manualStirStopRef.current) {
        manualStirStopRef.current()
        manualStirStopRef.current = null
      }
      setManualStirActive(false)
      return
    }
    const anchor = ensoAnchorRef.current?.getBoundingClientRect()
    const cx = anchor ? anchor.left + anchor.width * 0.5 : getOpenPoolCenter().x
    const cy = anchor ? anchor.top + anchor.height * 0.5 : getOpenPoolCenter().y
    manualStirStopRef.current = ink.stir({
      x: cx,
      y: cy,
      radius: 140,
      strength: 0.9,
      durationMs: 0,
    })
    setManualStirActive(true)
  }

  const handleFlood = (color: 'smoke' | 'zhusha') => {
    const { x, y } = getOpenPoolCenter()
    const t0 = performance.now()
    void ink.flood({ x, y, color }).then(() => {
      const elapsed = Math.round(performance.now() - t0)
      setLastFloodResolveMs(elapsed)
    })
  }

  const handleTriggerDilute = () => {
    const zone = diluteZoneRef.current
    if (!zone) return
    const r = zone.getBoundingClientRect()
    // Seed visible smoke ink inside the target zone first
    for (let i = 0; i < 5; i += 1) {
      const px = r.left + r.width * (0.14 + i * 0.18)
      const py = r.top + r.height * (0.38 + (i % 2) * 0.24)
      ink.splat({
        x: px,
        y: py,
        dx: (i % 2 === 0 ? 1 : -1) * 18,
        dy: -10,
        radius: 56,
        amount: 0.72,
        color: 'smoke',
      })
    }
    if (diluteTimerRef.current !== null) {
      clearTimeout(diluteTimerRef.current)
    }
    diluteTimerRef.current = setTimeout(() => {
      diluteTimerRef.current = null
      const liveRect = diluteZoneRef.current?.getBoundingClientRect()
      if (!liveRect) return
      ink.dilute(
        { x: liveRect.left, y: liveRect.top, w: liveRect.width, h: liveRect.height },
        900,
      )
    }, 180)
  }

  const handleToggleCalm = () => {
    const next = !calm
    setCalm(next)
    ink.setCalm(next)
  }

  const handleBrushIn = () => {
    if (brushInRafRef.current !== null) {
      window.cancelAnimationFrame(brushInRafRef.current)
      brushInRafRef.current = null
    }
    if (motionLevel === 'reduced') {
      brushInRef.current = 1
      syncEnsoRect(ensoState, 1)
      return
    }
    const startMs = performance.now()
    const durationMs = 1200
    const tick = (nowMs: number) => {
      const t = Math.min(1, (nowMs - startMs) / durationMs)
      brushInRef.current = t
      syncEnsoRect(ensoStateRef.current, t)
      if (t < 1) {
        brushInRafRef.current = window.requestAnimationFrame(tick)
      } else {
        brushInRafRef.current = null
      }
    }
    brushInRef.current = 0
    syncEnsoRect(ensoState, 0)
    brushInRafRef.current = window.requestAnimationFrame(tick)
  }

  const handleSelectQuality = (q: QualityPreference) => {
    inktideStore.setQualityPreference(q)
  }

  const handleToggleReducedMotion = () => {
    inktideStore.setMotionPreference(motionPreference === 'reduced' ? 'full' : 'reduced')
  }

  const handleContextLoss = () => {
    ink.simulateContextLoss?.()
  }

  const frameMsForFps = stats.avgFrameMs ?? (stats.lastFrameMs > 0 ? stats.lastFrameMs : null)
  const fpsDisplay =
    stats.quality === 'static'
      ? 'static'
      : frameMsForFps !== null && frameMsForFps > 0
        ? `${Math.round(1000 / frameMsForFps)}`
        : '—'

  const pressureIters =
    stats.quality === 'static' ? 0 : QUALITY[stats.quality].pressureIters

  const bufferFormatLabel =
    stats.backend === 'static-2d'
      ? '2D static'
      : stats.floatSupported
        ? 'RGBA16F'
        : 'RGBA8'

  return (
    <div
      className="flex min-h-screen w-full flex-col"
      style={{ padding: 'var(--sp-4) var(--sp-6)', gap: 'var(--sp-3)' }}
    >
      {/* Top Bar: left header on transparent ink band, right controls on solid plate */}
      <header className="flex items-start justify-between" style={{ gap: 'var(--sp-4)' }}>
        <div
          className="plate"
          style={{
            padding: 'var(--sp-2) var(--sp-5)',
            border: '1px solid var(--hair)',
          }}
        >
          <div className="label">DEV · INK ENGINE</div>
          <h1
            className="title-display"
            style={{ margin: '2px 0 0', fontSize: 'var(--fs-display)', lineHeight: 'var(--lh-display)' }}
          >
            墨潮
          </h1>
        </div>

        <div
          className="plate flex items-center"
          style={{
            padding: 'var(--sp-2) var(--sp-3)',
            gap: 'var(--sp-2)',
            border: '1px solid var(--hair)',
          }}
        >
          <a
            href="#dev/tokens"
            data-testid="link-dev-tokens"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--fs-mono)',
              color: 'var(--shiqing)',
              padding: '4px 8px',
            }}
          >
            #dev/tokens
          </a>
          <span style={{ color: 'var(--hair-strong)' }}>|</span>
          {THEME_OPTIONS.map((opt) => (
            <button
              key={opt.mode}
              type="button"
              data-testid={`theme-${opt.mode}`}
              onClick={() => inktideStore.setThemeMode(opt.mode)}
              style={getButtonStyle(themeMode === opt.mode)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </header>

      {/* Main Split: >= 65% Open Ink Pool on left + 340px solid Control Dock on right */}
      <div
        className="flex flex-1 items-stretch"
        style={{ gap: 'var(--sp-5)', minHeight: 'calc(100vh - 132px)' }}
      >
        {/* Open Live Ink Pool Stage */}
        <section
          ref={poolRef}
          aria-label="Ink Tide Stage"
          className="relative flex flex-1 flex-col items-center justify-between"
          style={{ padding: 'var(--sp-6) var(--sp-4)' }}
        >
          {/* 220x220 Enso Placeholder + Crisp Opaque Name Badge */}
          <div className="flex flex-col items-center" style={{ gap: 'var(--sp-4)', marginTop: 'var(--sp-4)' }}>
            <div
              ref={ensoAnchorRef}
              data-testid="dev-enso-anchor"
              role="img"
              aria-label={`小鲸鱼，${ensoState}`}
              className="relative flex items-center justify-center"
              style={{ width: 220, height: 220, pointerEvents: 'none' }}
            >
              <AnimatePresence>
                {ripples.map((id) => (
                  <motion.span
                    key={id}
                    initial={{ scale: 1, opacity: 0.75 }}
                    animate={{ scale: 1.4, opacity: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: DUR.bloom, ease: EASE.inkOut }}
                    style={{
                      position: 'absolute',
                      inset: 0,
                      borderRadius: '50%',
                      border: '1px solid var(--zhusha)',
                      pointerEvents: 'none',
                    }}
                  />
                ))}
              </AnimatePresence>
            </div>

            <div
              className="plate flex items-baseline"
              style={{
                padding: 'var(--sp-2) var(--sp-5)',
                gap: 'var(--sp-3)',
                border: '1px solid var(--hair)',
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--font-display-cjk)',
                  fontSize: 'var(--fs-h1)',
                  lineHeight: 'var(--lh-h1)',
                  fontWeight: 700,
                  color: 'var(--text-1)',
                }}
              >
                小鲸鱼
              </span>
              <span
                className="num"
                data-testid="enso-current-state"
                style={{
                  fontSize: 'var(--fs-mono)',
                  color: 'var(--text-2)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                }}
              >
                {ensoState}
              </span>
            </div>
          </div>

          {/* Dedicated Dilute Target Zone */}
          <div
            ref={diluteZoneRef}
            data-testid="dilute-target-zone"
            className="relative flex w-full items-start justify-start"
            style={{
              maxWidth: 520,
              height: 150,
              border: '1px dashed var(--hair-strong)',
              borderRadius: 'var(--radius)',
              padding: 'var(--sp-2)',
            }}
          >
            <span
              className="plate num"
              style={{
                padding: '2px 8px',
                fontSize: 'var(--fs-label)',
                color: 'var(--text-2)',
                border: '1px solid var(--hair)',
              }}
            >
              DILUTE · 目标区
            </span>
          </div>
        </section>

        {/* Compact Right-Side Opaque Control Dock (~340px wide, zero clip at 1440x900) */}
        <aside
          className="plate flex flex-col"
          data-testid="ink-control-dock"
          style={{
            width: 340,
            flexShrink: 0,
            padding: 'var(--sp-3)',
            gap: 'var(--sp-3)',
            border: '1px solid var(--hair)',
          }}
        >
          {/* Section 1: Fluid Engine API (§5.4) */}
          <div>
            <div style={SECTION_HEADING_STYLE}>流体 · API (§5.4)</div>
            <div className="grid grid-cols-2" style={{ gap: '6px' }}>
              <button
                type="button"
                data-testid="splat-smoke"
                onClick={handleSplatSmoke}
                style={getButtonStyle()}
              >
                splat · 白墨
              </button>
              <button
                type="button"
                data-testid="splat-zhusha"
                onClick={handleSplatZhusha}
                style={getButtonStyle()}
              >
                splat · 朱砂
              </button>
              <button
                type="button"
                data-testid="splat-stamp"
                onClick={handleSplatStamp}
                style={getButtonStyle(false, true)}
              >
                落印 · stamp
              </button>
              <button
                type="button"
                data-testid="toggle-stir"
                onClick={handleToggleStir}
                style={getButtonStyle(manualStirActive)}
              >
                {manualStirActive ? '停 · stir' : '流转 · stir'}
              </button>
              <button
                type="button"
                data-testid="flood-smoke"
                onClick={() => handleFlood('smoke')}
                style={getButtonStyle()}
              >
                flood · 白墨
              </button>
              <button
                type="button"
                data-testid="flood-zhusha"
                onClick={() => handleFlood('zhusha')}
                style={getButtonStyle()}
              >
                flood · 朱砂
              </button>
              <button
                type="button"
                data-testid="trigger-dilute"
                onClick={handleTriggerDilute}
                style={getButtonStyle()}
              >
                淡化 · dilute
              </button>
              <button
                type="button"
                data-testid="toggle-calm"
                onClick={handleToggleCalm}
                style={getButtonStyle(calm)}
              >
                静墨 · {calm ? 'on' : 'off'}
              </button>
            </div>
          </div>

          {/* Section 2: Enso 7 States (§5.5) */}
          <div>
            <div style={SECTION_HEADING_STYLE}>圆相 · 七态 (§5.5)</div>
            <div className="grid grid-cols-3" style={{ gap: '6px' }}>
              {ENSO_STATES.map((st) => (
                <button
                  key={st}
                  type="button"
                  data-testid={`enso-state-${st}`}
                  onClick={() => setEnsoState(st)}
                  style={getButtonStyle(ensoState === st)}
                >
                  {st}
                </button>
              ))}
            </div>
            <div
              className="grid grid-cols-3"
              style={{ gap: '6px', marginTop: '6px' }}
            >
              <button
                type="button"
                data-testid="enso-ripple"
                onClick={triggerRipple}
                style={getButtonStyle()}
              >
                ripple
              </button>
              <button
                type="button"
                data-testid="enso-pulse"
                onClick={() => ink.pulseEnso(DEV_ENSO_ID)}
                style={getButtonStyle()}
              >
                pulse
              </button>
              <button
                type="button"
                data-testid="enso-brushin"
                onClick={handleBrushIn}
                style={getButtonStyle()}
              >
                brushIn
              </button>
            </div>
          </div>

          {/* Section 3: Quality, Motion & Recovery (§5.6) */}
          <div>
            <div style={SECTION_HEADING_STYLE}>画质与恢复 (§5.6)</div>
            <div className="grid grid-cols-5" style={{ gap: 'var(--sp-1)' }}>
              {QUALITY_OPTIONS.map((q) => (
                <button
                  key={q}
                  type="button"
                  data-testid={`quality-${q}`}
                  onClick={() => handleSelectQuality(q)}
                  style={{
                    ...getButtonStyle(qualityPreference === q),
                    padding: '4px 4px',
                    fontSize: 'var(--fs-mono)',
                  }}
                >
                  {q}
                </button>
              ))}
            </div>
            <div
              className="grid grid-cols-2"
              style={{ gap: '6px', marginTop: '6px' }}
            >
              <button
                type="button"
                data-testid="toggle-reduced-motion"
                onClick={handleToggleReducedMotion}
                style={getButtonStyle(motionLevel === 'reduced')}
              >
                动效 · {motionLevel === 'reduced' ? '减少' : '完整'}
              </button>
              <button
                type="button"
                data-testid="toggle-context-loss"
                onClick={handleContextLoss}
                style={getButtonStyle()}
              >
                失联恢复
              </button>
            </div>
          </div>

          {/* Section 4: Live Telemetry HUD */}
          <div>
            <div style={SECTION_HEADING_STYLE}>性能 · HUD</div>
            <div
              className="num grid grid-cols-2"
              data-testid="ink-hud"
              style={{
                backgroundColor: 'var(--plate-sunken)',
                borderRadius: 'var(--radius)',
                border: '1px solid var(--hair)',
                padding: 'var(--sp-2) var(--sp-3)',
                rowGap: '3px',
                columnGap: 'var(--sp-2)',
                fontSize: 'var(--fs-mono)',
                lineHeight: '17px',
              }}
            >
              <span style={{ color: 'var(--text-2)' }}>FPS</span>
              <span style={{ textAlign: 'right', color: 'var(--text-1)' }} data-testid="hud-fps">
                {fpsDisplay}
              </span>

              <span style={{ color: 'var(--text-2)' }}>Avg Frame</span>
              <span style={{ textAlign: 'right', color: 'var(--text-1)' }} data-testid="hud-frame-ms">
                {frameMsForFps !== null ? `${frameMsForFps.toFixed(1)} ms` : '—'}
              </span>

              <span style={{ color: 'var(--text-2)' }}>GPU Time</span>
              <span style={{ textAlign: 'right', color: 'var(--text-1)' }} data-testid="hud-gpu-ms">
                {stats.gpuFrameMs !== null ? `${stats.gpuFrameMs.toFixed(2)} ms` : 'n/a'}
              </span>

              <span style={{ color: 'var(--text-2)' }}>Tier / Iter</span>
              <span style={{ textAlign: 'right', color: 'var(--text-1)' }} data-testid="hud-tier">
                {stats.quality} · {pressureIters}
              </span>

              <span style={{ color: 'var(--text-2)' }}>Sim / Dye</span>
              <span style={{ textAlign: 'right', color: 'var(--text-1)' }} data-testid="hud-res">
                {stats.simResolution[0]}×{stats.simResolution[1]} / {stats.dyeResolution[0]}×
                {stats.dyeResolution[1]}
              </span>

              <span style={{ color: 'var(--text-2)' }}>Buffer</span>
              <span style={{ textAlign: 'right', color: 'var(--text-1)' }} data-testid="hud-buffer">
                {bufferFormatLabel}
              </span>

              <span style={{ color: 'var(--text-2)' }}>Calm</span>
              <span style={{ textAlign: 'right', color: 'var(--text-1)' }} data-testid="hud-calm">
                {stats.calm ? 'on' : 'off'}
              </span>

              <span style={{ color: 'var(--text-2)' }}>Context</span>
              <span
                style={{
                  textAlign: 'right',
                  color: stats.contextLost ? 'var(--yanzhi)' : 'var(--shilv)',
                }}
                data-testid="hud-context"
              >
                {stats.contextLost ? 'lost' : 'ok'}
              </span>

              <span style={{ color: 'var(--text-2)' }}>Flood Resolve</span>
              <span style={{ textAlign: 'right', color: 'var(--text-1)' }} data-testid="hud-flood-ms">
                {lastFloodResolveMs !== null ? `${lastFloodResolveMs} ms` : '—'}
              </span>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
