import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react'
import { Check, Copy, X } from 'lucide-react'
import { AnimatePresence, motion, type Variants } from 'motion/react'
import { getPreset, REDUCED_FADE_DURATION } from '../motion/presets.ts'
import { EASE } from '../motion/tokens.ts'
import { useMotionLevel } from '../motion/useMotionLevel.ts'

export type SealToastKind = 'success' | 'warn' | 'error' | 'info'

export interface SealToastOptions {
  readonly title?: string
  readonly code?: string
  readonly requestId?: string
  readonly durationMs?: number
}

export interface SealToastItem {
  readonly id: string
  readonly kind: SealToastKind
  readonly message: string
  readonly title?: string
  readonly code?: string
  readonly requestId?: string
  readonly durationMs: number
  readonly createdAt: number
}

export interface SealToastStackProps {
  readonly className?: string
  readonly style?: CSSProperties
}

// Section 7.12: max 4 stacked toasts, 4500ms lifetime, 600ms dry-ink fade out.
const MAX_VISIBLE_TOASTS = 4
const DEFAULT_TOAST_DURATION_MS = 4500
const DRY_FADE_DURATION_SEC = 0.6
const COPY_FEEDBACK_MS = 1600

const SEAL_META: Readonly<
  Record<SealToastKind, { readonly glyph: string; readonly color: string; readonly label: string }>
> = {
  success: { glyph: '成', color: 'var(--shilv)', label: '成功' },
  warn: { glyph: '慎', color: 'var(--tenghuang)', label: '警告' },
  error: { glyph: '误', color: 'var(--yanzhi)', label: '错误' },
  info: { glyph: '知', color: 'var(--shiqing)', label: '提示' },
}

// Pure in-memory toast store (ephemeral, never persisted to browser storage).
let toastSeq = 0
let toastItems: readonly SealToastItem[] = []
const toastListeners = new Set<() => void>()

function emitToasts(): void {
  for (const listener of toastListeners) {
    listener()
  }
}

function pushToast(
  kind: SealToastKind,
  message: string,
  options?: SealToastOptions,
): string {
  toastSeq += 1
  const id = `seal-toast-${toastSeq}`
  const item: SealToastItem = {
    id,
    kind,
    message,
    title: options?.title,
    code: options?.code,
    requestId: options?.requestId,
    durationMs: options?.durationMs ?? DEFAULT_TOAST_DURATION_MS,
    createdAt: Date.now(),
  }
  const next = [...toastItems, item]
  toastItems = next.length > MAX_VISIBLE_TOASTS ? next.slice(-MAX_VISIBLE_TOASTS) : next
  emitToasts()
  return id
}

function dismissToast(id: string): void {
  const next = toastItems.filter((item) => item.id !== id)
  if (next.length === toastItems.length) return
  toastItems = next
  emitToasts()
}

function clearToasts(): void {
  if (toastItems.length === 0) return
  toastItems = []
  emitToasts()
}

function subscribeToasts(listener: () => void): () => void {
  toastListeners.add(listener)
  return () => {
    toastListeners.delete(listener)
  }
}

function getToastsSnapshot(): readonly SealToastItem[] {
  return toastItems
}

export const toast = {
  success(message: string, options?: SealToastOptions): string {
    return pushToast('success', message, options)
  },
  warn(message: string, options?: SealToastOptions): string {
    return pushToast('warn', message, options)
  },
  error(message: string, options?: SealToastOptions): string {
    return pushToast('error', message, options)
  },
  info(message: string, options?: SealToastOptions): string {
    return pushToast('info', message, options)
  },
  dismiss: dismissToast,
  clear: clearToasts,
  subscribe: subscribeToasts,
  getSnapshot: getToastsSnapshot,
} as const

export function useToasts(): readonly SealToastItem[] {
  return useSyncExternalStore(
    subscribeToasts,
    getToastsSnapshot,
    getToastsSnapshot,
  )
}

interface SealToastCardProps {
  readonly item: SealToastItem
  readonly compact?: boolean
}

function useIsCompactViewport(): boolean {
  const [compact, setCompact] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.innerWidth < 1024
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    const update = (): void => {
      setCompact(window.innerWidth < 1024)
    }
    update()
    const mql =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(max-width: 1023px)')
        : null
    mql?.addEventListener('change', update)
    window.addEventListener('resize', update, { passive: true })
    return () => {
      mql?.removeEventListener('change', update)
      window.removeEventListener('resize', update)
    }
  }, [])

  return compact
}

function SealToastCard({ item, compact = false }: SealToastCardProps) {
  const motionLevel = useMotionLevel()
  const [paused, setPaused] = useState(false)
  const [copied, setCopied] = useState(false)

  const remainingMsRef = useRef<number>(item.durationMs)
  const startedAtRef = useRef<number>(0)
  const copyTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (paused || item.durationMs <= 0) return
    startedAtRef.current = Date.now()
    const timer = window.setTimeout(() => {
      toast.dismiss(item.id)
    }, remainingMsRef.current)

    return () => {
      window.clearTimeout(timer)
      const elapsed = Date.now() - startedAtRef.current
      remainingMsRef.current = Math.max(0, remainingMsRef.current - elapsed)
    }
  }, [item.durationMs, item.id, paused])

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
      }
    }
  }, [])

  const handleCopyRequestId = async (): Promise<void> => {
    if (!item.requestId || typeof navigator === 'undefined' || !navigator.clipboard) {
      return
    }
    try {
      await navigator.clipboard.writeText(item.requestId)
      setCopied(true)
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
      }
      copyTimerRef.current = window.setTimeout(() => {
        setCopied(false)
      }, COPY_FEEDBACK_MS)
    } catch {
      // Clipboard may be unavailable in restricted contexts
    }
  }

  const meta = SEAL_META[item.kind]
  const bloomPreset = getPreset('bloom', motionLevel)
  const stampPreset = getPreset('stamp', motionLevel)

  const cardVariants: Variants = {
    ...bloomPreset,
    exit:
      motionLevel === 'reduced'
        ? {
            opacity: 0,
            filter: 'none',
            transition: { duration: REDUCED_FADE_DURATION, ease: EASE.settle },
          }
        : {
            opacity: 0,
            filter: 'saturate(0)',
            transition: { duration: DRY_FADE_DURATION_SEC, ease: EASE.settle },
          },
  }

  return (
    <motion.div
      layout={motionLevel === 'full'}
      role={item.kind === 'error' ? 'alert' : 'status'}
      variants={cardVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className="plate"
      style={{
        width: '320px',
        maxWidth: compact ? 'calc(100vw - 32px)' : 'calc(100vw - 48px)',
        padding: 'var(--sp-3) var(--sp-4)',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--sp-3)',
        pointerEvents: 'auto',
        background: 'var(--plate-raised)',
        boxShadow: 'var(--shadow-raised)',
        border: '1px solid var(--hair-strong)',
        borderRadius: 'var(--radius)',
      }}
    >
      <motion.span
        aria-label={meta.label}
        variants={stampPreset}
        initial="initial"
        animate="animate"
        style={{
          width: '28px',
          height: '28px',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          borderRadius: 'var(--radius)',
          background: meta.color,
          color: 'var(--plate)',
          fontFamily: 'var(--font-display-cjk)',
          fontWeight: 900,
          fontSize: '15px',
          lineHeight: 1,
          userSelect: 'none',
        }}
      >
        {meta.glyph}
      </motion.span>

      <div style={{ flex: 1, minWidth: 0 }}>
        {item.title ? (
          <div
            style={{
              fontSize: 'var(--fs-small)',
              lineHeight: 'var(--lh-small)',
              fontWeight: 600,
              color: 'var(--text-1)',
              marginBottom: '2px',
            }}
          >
            {item.title}
          </div>
        ) : null}

        <div
          style={{
            fontSize: 'var(--fs-small)',
            lineHeight: 'var(--lh-small)',
            color: item.title ? 'var(--text-2)' : 'var(--text-1)',
            wordBreak: 'break-word',
          }}
        >
          {item.message}
        </div>

        {item.code || item.requestId ? (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 'var(--sp-2)',
              marginTop: 'var(--sp-2)',
            }}
          >
            {item.code ? (
              <span
                className="num"
                style={{
                  fontSize: 'var(--fs-label)',
                  lineHeight: 'var(--lh-label)',
                  color: meta.color,
                }}
              >
                {item.code}
              </span>
            ) : null}

            {item.requestId ? (
              <button
                type="button"
                onClick={() => {
                  void handleCopyRequestId()
                }}
                title="点击复制 requestId"
                className="num"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  padding: '1px 5px',
                  border: '1px solid var(--hair-strong)',
                  borderRadius: 'var(--radius)',
                  background: 'var(--plate-sunken)',
                  color: 'var(--text-2)',
                  fontSize: 'var(--fs-label)',
                  lineHeight: 'var(--lh-label)',
                  cursor: 'pointer',
                  maxWidth: '100%',
                }}
              >
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: '150px',
                  }}
                >
                  {copied ? '已复制' : item.requestId}
                </span>
                {copied ? (
                  <Check size={12} strokeWidth={1.5} style={{ color: 'var(--shilv)', flexShrink: 0 }} />
                ) : (
                  <Copy size={12} strokeWidth={1.5} style={{ flexShrink: 0 }} />
                )}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <button
        type="button"
        aria-label="关闭提示"
        onClick={() => toast.dismiss(item.id)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '20px',
          height: '20px',
          padding: 0,
          border: 0,
          background: 'transparent',
          color: 'var(--text-3)',
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        <X size={14} strokeWidth={1.5} />
      </button>
    </motion.div>
  )
}

export function SealToastStack({ className, style }: SealToastStackProps) {
  const items = useToasts()
  const isCompact = useIsCompactViewport()

  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className={className ? `seal-toast-stack ${className}` : 'seal-toast-stack'}
      style={{
        position: 'fixed',
        right: isCompact ? '16px' : '24px',
        bottom: isCompact
          ? 'calc(var(--statusbar-h) + 56px + 12px)'
          : 'calc(var(--statusbar-h) + 16px)',
        maxWidth: isCompact ? 'calc(100vw - 32px)' : undefined,
        zIndex: 60,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 'var(--sp-3)',
        pointerEvents: 'none',
        ...style,
      }}
    >
      <AnimatePresence initial={false}>
        {items.map((item) => (
          <SealToastCard key={item.id} item={item} compact={isCompact} />
        ))}
      </AnimatePresence>
    </div>
  )
}
