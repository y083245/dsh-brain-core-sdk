import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { clearAuthToken, getAuthToken, setAuthToken, settingsApi } from '../../api/client.ts'
import { ApiError } from '../../api/types.ts'
import { useInktideStore } from '../../data/store.ts'
import type { EnsoState } from '../../ink/engine.ts'
import { useInk } from '../../ink/InkProvider.tsx'
import {
  charStaggerDelay,
  getPreset,
  REDUCED_FADE_DURATION,
  REDUCED_TRANSITION_DURATION,
} from '../../motion/presets.ts'
import { DUR, EASE } from '../../motion/tokens.ts'
import { useMotionLevel } from '../../motion/useMotionLevel.ts'
import { switchThemeWithTransition } from '../../shell/themeTransition.ts'
import { playFlood, playStamp } from '../../sound/synth.ts'
import { BrushButton } from '../../ui/BrushButton.tsx'
import { Enso } from '../../ui/Enso.tsx'
import { HoldToStamp } from '../../ui/HoldToStamp.tsx'
import { InkInput } from '../../ui/InkInput.tsx'
import { InkText } from '../../ui/InkText.tsx'

export interface GateDemoAuthResult {
  readonly ok: boolean
  readonly roleCardName?: string | null
  readonly message?: string
}

export interface GatePageProps {
  readonly onAuthenticated: (info: { readonly roleCardName: string | null }) => void
  readonly demoAuthenticator?: (token: string) => Promise<GateDemoAuthResult>
  readonly demoHint?: string
  readonly onExitDemo?: () => void
}

type GatePhase = 'input' | 'submitting' | 'revealing' | 'fading'

// Section 8.1 choreography timings
const ENSO_SIZE_PX = 320
const ENSO_BRUSH_IN_SEC = 1.2
const TYPING_IDLE_RESET_MS = 1200
const ERROR_ENSO_HOLD_MS = 240
const HERO_NAME_HOLD_MS = 700
const STIR_RADIUS_PX = 140
const STIR_STRENGTH = 0.9
const STIR_MAX_DURATION_MS = 4500

const BRAND_TEXT = 'BRAIN CORE'
const BRAND_CHARS = Array.from(BRAND_TEXT)
// §4.1 / §11: keep the 1.2s Enso brush-in uninterrupted while unlocking the login form within 180ms.
const BRAND_INTRO_DELAY_SEC = 0.12
const FORM_INTRO_DELAY_SEC = 0.08
const FORM_INTERACTIVE_DELAY_MS = 180

const FALLBACK_ROLE_NAME = '墨潮'
const DEFAULT_ERROR_MESSAGE = '令牌不对'

const PAGE_STYLE: CSSProperties = {
  position: 'relative',
  minHeight: '100vh',
  width: '100%',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 'var(--sp-8) var(--sp-5)',
  background: 'transparent',
}

const TOP_RIGHT_CONTROLS_STYLE: CSSProperties = {
  position: 'fixed',
  top: 'var(--sp-4)',
  right: 'var(--sp-5)',
  zIndex: 10,
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sp-2)',
}

const THEME_TOGGLE_STYLE: CSSProperties = {
  width: 36,
  height: 36,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--plate)',
  color: 'var(--text-2)',
  border: '1px solid var(--hair-strong)',
  borderRadius: 'var(--radius)',
  boxShadow: 'var(--shadow-plate)',
  fontSize: 'var(--fs-body)',
  lineHeight: 1,
  cursor: 'pointer',
}

const CENTER_STACK_STYLE: CSSProperties = {
  width: '100%',
  maxWidth: 460,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 'var(--sp-5)',
}

const BRAND_STYLE: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-label)',
  lineHeight: 'var(--lh-label)',
  fontWeight: 600,
  letterSpacing: '0.6em',
  paddingLeft: '0.6em',
  textTransform: 'uppercase',
  color: 'var(--text-2)',
  textAlign: 'center',
  userSelect: 'none',
}

const FORM_STYLE: CSSProperties = {
  width: 420,
  maxWidth: 'calc(100vw - 40px)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 'var(--sp-5)',
}

const HERO_NAME_WRAP_STYLE: CSSProperties = {
  minHeight: 136,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  textAlign: 'center',
}

const HERO_NAME_STYLE: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-display-cjk)',
  fontSize: 'var(--fs-hero)',
  lineHeight: 'var(--lh-hero)',
  fontWeight: 900,
  letterSpacing: '-0.02em',
  color: 'var(--text-1)',
}

const MEMORY_NOTICE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: 'var(--fs-small)',
  lineHeight: 'var(--lh-small)',
  color: 'var(--text-3)',
  textAlign: 'center',
}

const DEMO_HINT_STYLE: CSSProperties = {
  margin: 0,
  padding: 'var(--sp-1) var(--sp-3)',
  background: 'var(--plate)',
  border: '1px solid var(--hair)',
  borderRadius: 'var(--radius)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-label)',
  lineHeight: 'var(--lh-label)',
  color: 'var(--text-2)',
  textAlign: 'center',
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

function resolveAuthErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'UNAUTHENTICATED' || error.status === 401) {
      return DEFAULT_ERROR_MESSAGE
    }
    return error.message.trim() !== '' ? error.message : DEFAULT_ERROR_MESSAGE
  }
  if (error instanceof Error && error.message.trim() !== '') {
    return error.message
  }
  return DEFAULT_ERROR_MESSAGE
}

export function GatePage({
  onAuthenticated,
  demoAuthenticator,
  demoHint,
  onExitDemo,
}: GatePageProps) {
  const ink = useInk()
  const motionLevel = useMotionLevel()
  const themeMode = useInktideStore((s) => s.themeMode)
  const resolvedTheme = useInktideStore((s) => s.resolvedTheme)

  const [tokenInput, setTokenInput] = useState('')
  const [ensoState, setEnsoState] = useState<EnsoState>('offline')
  const [rippleKey, setRippleKey] = useState(0)
  const [phase, setPhase] = useState<GatePhase>('input')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [revealedName, setRevealedName] = useState<string | null>(null)
  const [stampResetKey, setStampResetKey] = useState(0)
  const [introFinished, setIntroFinished] = useState(motionLevel === 'reduced')

  const mountedRef = useRef(true)
  const submittingRef = useRef(false)
  const ensoContainerRef = useRef<HTMLDivElement | null>(null)
  const stampWrapRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const typingTimerRef = useRef<number | null>(null)
  const errorTimerRef = useRef<number | null>(null)
  const stopStirRef = useRef<(() => void) | null>(null)

  const fadeVariants = useMemo(() => getPreset('fade', motionLevel), [motionLevel])
  const bloomVariants = useMemo(() => getPreset('bloom', motionLevel), [motionLevel])

  useEffect(() => {
    if (motionLevel === 'reduced') return
    const timeout = window.setTimeout(() => setIntroFinished(true), FORM_INTERACTIVE_DELAY_MS)
    return () => window.clearTimeout(timeout)
  }, [motionLevel])

  // Ensure full-screen ink fluid is active (not calm) on the login gate
  useEffect(() => {
    ink.setCalm(false)
  }, [ink])

  // Lifecycle cleanup for timers and fluid stir
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (typingTimerRef.current !== null) {
        window.clearTimeout(typingTimerRef.current)
        typingTimerRef.current = null
      }
      if (errorTimerRef.current !== null) {
        window.clearTimeout(errorTimerRef.current)
        errorTimerRef.current = null
      }
      stopStirRef.current?.()
      stopStirRef.current = null
    }
  }, [])

  const clearTypingTimer = useCallback(() => {
    if (typingTimerRef.current !== null) {
      window.clearTimeout(typingTimerRef.current)
      typingTimerRef.current = null
    }
  }, [])

  const clearErrorTimer = useCallback(() => {
    if (errorTimerRef.current !== null) {
      window.clearTimeout(errorTimerRef.current)
      errorTimerRef.current = null
    }
  }, [])

  const stopActiveStir = useCallback(() => {
    if (stopStirRef.current) {
      stopStirRef.current()
      stopStirRef.current = null
    }
  }, [])

  const handleTokenChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const next = event.target.value
      setTokenInput(next)
      if (errorMessage !== null) {
        setErrorMessage(null)
      }
      if (phase !== 'input') return

      clearErrorTimer()
      clearTypingTimer()
      setEnsoState('listening')
      setRippleKey((prev) => prev + 1)

      typingTimerRef.current = window.setTimeout(() => {
        typingTimerRef.current = null
        if (!mountedRef.current || submittingRef.current) return
        setEnsoState((prev) => (prev === 'listening' ? 'offline' : prev))
      }, TYPING_IDLE_RESET_MS)
    },
    [clearErrorTimer, clearTypingTimer, errorMessage, phase],
  )

  const emitManualStampFeedback = useCallback(() => {
    playStamp()
    const el = stampWrapRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const cx = rect.left + rect.width * 0.5
    const cy = rect.top + rect.height * 0.5
    ink.splat({
      x: cx,
      y: cy,
      radius: 90,
      amount: 0.8,
      color: 'zhusha',
    })
  }, [ink])

  const triggerFailureFeedback = useCallback(
    (message: string) => {
      stopActiveStir()
      clearTypingTimer()
      clearErrorTimer()
      setErrorMessage(message)
      setEnsoState('error')
      setPhase('input')
      submittingRef.current = false

      errorTimerRef.current = window.setTimeout(() => {
        errorTimerRef.current = null
        if (!mountedRef.current || submittingRef.current) return
        setEnsoState('offline')
        setStampResetKey((k) => k + 1)
      }, ERROR_ENSO_HOLD_MS)
    },
    [clearErrorTimer, clearTypingTimer, stopActiveStir],
  )

  const performAuthentication = useCallback(
    async (fromStampButton: boolean): Promise<void> => {
      if (submittingRef.current || phase === 'revealing' || phase === 'fading') {
        return
      }

      const candidate = tokenInput.trim()
      if (candidate === '') {
        setErrorMessage(null)
        // Defer one microtask/frame so InkInput detects null -> error transition for shake
        window.requestAnimationFrame(() => {
          if (!mountedRef.current) return
          triggerFailureFeedback('请输入访问令牌')
          inputRef.current?.focus()
        })
        if (fromStampButton) {
          throw new Error('请输入访问令牌')
        }
        return
      }

      clearTypingTimer()
      clearErrorTimer()
      submittingRef.current = true
      setErrorMessage(null)
      setPhase('submitting')
      setEnsoState('thinking')

      if (!fromStampButton) {
        emitManualStampFeedback()
      }

      // Stir fluid around Enso center while verifying
      const ensoEl = ensoContainerRef.current
      if (ensoEl && motionLevel === 'full') {
        const rect = ensoEl.getBoundingClientRect()
        stopActiveStir()
        stopStirRef.current = ink.stir({
          x: rect.left + rect.width * 0.5,
          y: rect.top + rect.height * 0.5,
          radius: STIR_RADIUS_PX,
          strength: STIR_STRENGTH,
          durationMs: STIR_MAX_DURATION_MS,
        })
      }

      let roleCardName: string | null = null
      try {
        if (demoAuthenticator) {
          const demoResult = await demoAuthenticator(candidate)
          if (!mountedRef.current) return
          if (!demoResult.ok) {
            const msg = demoResult.message?.trim() || DEFAULT_ERROR_MESSAGE
            triggerFailureFeedback(msg)
            if (fromStampButton) {
              throw new Error(msg)
            }
            return
          }
          roleCardName = demoResult.roleCardName?.trim() || null
        } else {
          const session = await settingsApi.checkSession(candidate)
          if (!mountedRef.current) return
          if (!session.authenticated) {
            clearAuthToken()
            triggerFailureFeedback(DEFAULT_ERROR_MESSAGE)
            if (fromStampButton) {
              throw new Error(DEFAULT_ERROR_MESSAGE)
            }
            return
          }
          setAuthToken(candidate)
          try {
            const settings = await settingsApi.getSettings()
            roleCardName = settings.roleCard?.name?.trim() || null
          } catch (error) {
            if (error instanceof ApiError && (error.status === 401 || error.code === 'UNAUTHENTICATED')) {
              clearAuthToken()
              throw error
            }
            // Use the fallback name if the authenticated settings request fails transiently.
          }
          if (getAuthToken() !== candidate) {
            throw new ApiError('UNAUTHENTICATED', 401, DEFAULT_ERROR_MESSAGE)
          }
        }
      } catch (err) {
        if (!mountedRef.current) return
        // Avoid double-handling if already handled above
        if (submittingRef.current) {
          const msg = resolveAuthErrorMessage(err)
          triggerFailureFeedback(msg)
        }
        if (fromStampButton) {
          throw err
        }
        return
      }

      if (!mountedRef.current) return

      // Success sequence (§8.1): stop stir -> reveal hero name for 700ms -> zhusha flood -> enter court
      stopActiveStir()
      setTokenInput('')
      setEnsoState('idle')
      setRevealedName(roleCardName ?? FALLBACK_ROLE_NAME)
      setPhase('revealing')

      // Run transition choreography without blocking HoldToStamp's onConfirm promise
      const resolvedRoleName = roleCardName
      void (async () => {
        // AnimatePresence waits for the form's exit before mounting the hero.
        const formExitSec = motionLevel === 'reduced' ? REDUCED_FADE_DURATION : DUR.base
        await waitMs(HERO_NAME_HOLD_MS + Math.round(formExitSec * 1000))
        if (!mountedRef.current) return

        if (motionLevel === 'reduced') {
          setPhase('fading')
          await waitMs(Math.round(REDUCED_TRANSITION_DURATION * 1000))
        } else {
          playFlood()
          const cx = window.innerWidth * 0.5
          const cy = window.innerHeight * 0.5
          await ink.flood({ x: cx, y: cy, color: 'zhusha' })
        }
        if (!mountedRef.current) return
        if (!demoAuthenticator && getAuthToken() !== candidate) {
          setRevealedName(null)
          triggerFailureFeedback(DEFAULT_ERROR_MESSAGE)
          return
        }
        onAuthenticated({ roleCardName: resolvedRoleName })
      })()
    },
    [
      clearErrorTimer,
      clearTypingTimer,
      demoAuthenticator,
      emitManualStampFeedback,
      ink,
      motionLevel,
      onAuthenticated,
      phase,
      stopActiveStir,
      tokenInput,
      triggerFailureFeedback,
    ],
  )

  const handleFormSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      void performAuthentication(false)
    },
    [performAuthentication],
  )

  const handleStampConfirm = useCallback(async () => {
    await performAuthentication(true)
  }, [performAuthentication])

  const handleThemeToggle = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    switchThemeWithTransition({
      x: rect.left + rect.width * 0.5,
      y: rect.top + rect.height * 0.5,
    })
  }, [])

  const themeAriaLabel =
    themeMode === 'auto'
      ? `切换主题（当前：自动 · ${resolvedTheme === 'paper' ? '宣纸' : '夜墨'}）`
      : `切换主题（当前：${themeMode === 'paper' ? '宣纸' : '夜墨'}）`

  const isFormLocked = phase === 'submitting' || phase === 'revealing' || phase === 'fading'

  return (
    <motion.main
      aria-label="落款开印"
      animate={{ opacity: phase === 'fading' ? 0 : 1 }}
      transition={{ duration: REDUCED_TRANSITION_DURATION, ease: EASE.settle }}
      style={PAGE_STYLE}
    >
      {/* Top-right restrained theme toggle (+ optional dev rehearsal exit) */}
      <div style={TOP_RIGHT_CONTROLS_STYLE}>
        {onExitDemo ? (
          <BrushButton variant="ghost" size="sm" onClick={onExitDemo}>
            返回工作台
          </BrushButton>
        ) : null}
        <button
          type="button"
          onClick={handleThemeToggle}
          aria-label={themeAriaLabel}
          title={themeAriaLabel}
          style={THEME_TOGGLE_STYLE}
        >
          ◐
        </button>
      </div>

      <section style={CENTER_STACK_STYLE}>
        {/* 320px centered Enso sharing layoutId="enso" with the Rail */}
        <div ref={ensoContainerRef}>
          <Enso
            size={ENSO_SIZE_PX}
            state={ensoState}
            layoutId="enso"
            brushInDurationSec={ENSO_BRUSH_IN_SEC}
            rippleKey={rippleKey}
            ariaLabel={
              revealedName
                ? `${revealedName}，已落款开印`
                : '圆相，等待落款令牌'
            }
          />
        </div>

        {/* BRAIN CORE staggered character fade */}
        <p style={BRAND_STYLE} aria-label={BRAND_TEXT}>
          {BRAND_CHARS.map((ch, idx) => (
            <motion.span
              key={`${idx}-${ch}`}
              aria-hidden="true"
              variants={fadeVariants}
              initial="initial"
              animate="animate"
              custom={
                motionLevel === 'full'
                  ? BRAND_INTRO_DELAY_SEC + charStaggerDelay(idx, BRAND_CHARS.length)
                  : 0
              }
              style={{ display: 'inline-block', whiteSpace: 'pre' }}
            >
              {ch}
            </motion.span>
          ))}
        </p>

        {/* Swap cleanly between login form and hero role card reveal */}
        <AnimatePresence mode="wait">
          {phase === 'revealing' || phase === 'fading' ? (
            <motion.div
              key="hero-reveal"
              variants={fadeVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              style={HERO_NAME_WRAP_STYLE}
              aria-live="polite"
            >
              <InkText
                as="h1"
                text={revealedName ?? FALLBACK_ROLE_NAME}
                style={HERO_NAME_STYLE}
              />
            </motion.div>
          ) : (
            <motion.form
              key="token-form"
              id="token-login-form"
              autoComplete="off"
              inert={motionLevel === 'full' && !introFinished}
              onSubmit={handleFormSubmit}
              variants={bloomVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              custom={motionLevel === 'full' && !introFinished ? FORM_INTRO_DELAY_SEC : 0}
              style={FORM_STYLE}
            >
              <div style={{ width: '100%' }}>
                <InkInput
                  ref={inputRef}
                  id="token"
                  name="token"
                  type="password"
                  label="令牌"
                  value={tokenInput}
                  onChange={handleTokenChange}
                  error={errorMessage}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="输入启动时打印的一次性令牌…"
                  disabled={isFormLocked}
                  aria-label="访问令牌"
                />
              </div>

              {/* Hidden submit button enables native Enter submission inside the form */}
              <button
                type="submit"
                aria-hidden="true"
                tabIndex={-1}
                style={{ display: 'none' }}
              />

              <div ref={stampWrapRef}>
                <HoldToStamp
                  key={stampResetKey}
                  label="落款"
                  caption="点击落款开印"
                  instant
                  disabled={isFormLocked}
                  ariaLabel="落款开印"
                  onConfirm={handleStampConfirm}
                />
              </div>

              {demoHint ? <p style={DEMO_HINT_STYLE}>{demoHint}</p> : null}

              <p style={MEMORY_NOTICE_STYLE}>
                令牌只保存在这个页面的内存里，刷新后要重新输入。
              </p>
            </motion.form>
          )}
        </AnimatePresence>
      </section>
    </motion.main>
  )
}
