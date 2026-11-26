import {
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { Check, Copy } from 'lucide-react'
import { motion } from 'motion/react'
import { InkContext } from '../ink/InkProvider.tsx'
import { EASE, SPRING } from '../motion/tokens.ts'
import { useMotionLevel } from '../motion/useMotionLevel.ts'

// Section 7.13: subtle radial ink wash drifting left-to-right over 1.8s with EASE.brush.
const SKELETON_WASH_DURATION_SEC = 1.8
const COPY_FEEDBACK_MS = 1600

export interface InkSkeletonProps {
  readonly width?: number | string
  readonly height?: number | string
  readonly rows?: number
  readonly gap?: number
  readonly ariaLabel?: string
  readonly className?: string
  readonly style?: CSSProperties
}

export function InkSkeleton({
  width = '100%',
  height = 18,
  rows = 1,
  gap = 12,
  ariaLabel = '加载中',
  className,
  style,
}: InkSkeletonProps) {
  const motionLevel = useMotionLevel()
  const count = Math.max(1, Math.floor(rows))

  const renderBlock = (rowIndex: number): ReactNode => {
    const rowWidth =
      count > 1 && rowIndex === count - 1 && width === '100%' ? '72%' : width

    return (
      <div
        key={rowIndex}
        style={{
          position: 'relative',
          width: rowWidth,
          height,
          background: 'var(--plate-sunken)',
          borderRadius: 'var(--radius)',
          border: '1px solid var(--hair)',
          overflow: 'hidden',
        }}
      >
        {motionLevel === 'full' ? (
          <motion.span
            aria-hidden="true"
            initial={{ x: '-80%' }}
            animate={{ x: '180%' }}
            transition={{
              duration: SKELETON_WASH_DURATION_SEC,
              ease: EASE.brush,
              repeat: Infinity,
            }}
            style={{
              position: 'absolute',
              inset: 0,
              width: '64%',
              background:
                'radial-gradient(ellipse 52% 135% at 50% 50%, color-mix(in srgb, var(--smoke) 11%, transparent) 0%, color-mix(in srgb, var(--smoke) 4%, transparent) 46%, transparent 74%)',
              pointerEvents: 'none',
            }}
          />
        ) : null}
      </div>
    )
  }

  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={ariaLabel}
      className={className}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: `${gap}px`,
        width: count > 1 ? '100%' : undefined,
        ...style,
      }}
    >
      {Array.from({ length: count }, (_, idx) => renderBlock(idx))}
    </div>
  )
}

export interface EmptyStateProps {
  readonly glyph?: string
  readonly description?: string
  readonly actionLabel?: string
  readonly onAction?: () => void
  readonly action?: ReactNode
  readonly className?: string
  readonly style?: CSSProperties
}

export function EmptyState({
  glyph = '无痕',
  description,
  actionLabel,
  onAction,
  action,
  className,
  style,
}: EmptyStateProps) {
  const motionLevel = useMotionLevel()
  const ink = useContext(InkContext)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const splattedRef = useRef(false)

  useEffect(() => {
    if (splattedRef.current || motionLevel !== 'full' || !ink || !containerRef.current) {
      return
    }
    splattedRef.current = true
    const rect = containerRef.current.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    ink.splat({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      radius: 72,
      amount: 0.15,
      color: 'smoke',
    })
  }, [ink, motionLevel])

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: 'var(--sp-9) var(--sp-6)',
        gap: 'var(--sp-4)',
        ...style,
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-display-cjk)',
          fontSize: 'var(--fs-display)',
          lineHeight: 'var(--lh-display)',
          fontWeight: 900,
          letterSpacing: '-0.015em',
          color: 'var(--text-3)',
          userSelect: 'none',
        }}
      >
        {glyph}
      </div>

      {description ? (
        <p
          style={{
            margin: 0,
            maxWidth: '420px',
            fontSize: 'var(--fs-small)',
            lineHeight: 'var(--lh-small)',
            color: 'var(--text-2)',
          }}
        >
          {description}
        </p>
      ) : null}

      {action ? (
        <div style={{ marginTop: 'var(--sp-2)' }}>{action}</div>
      ) : actionLabel && onAction ? (
        <motion.button
          type="button"
          onClick={onAction}
          whileTap={motionLevel === 'full' ? { scale: 0.96 } : undefined}
          transition={SPRING.press}
          style={{
            marginTop: 'var(--sp-2)',
            padding: 'var(--sp-2) var(--sp-3)',
            border: 0,
            borderBottom: '1px solid var(--hair-strong)',
            borderRadius: 0,
            background: 'transparent',
            color: 'var(--text-1)',
            fontSize: 'var(--fs-body)',
            lineHeight: 'var(--lh-body)',
            cursor: 'pointer',
          }}
        >
          {actionLabel}
        </motion.button>
      ) : null}
    </div>
  )
}

export interface ErrorStateProps {
  readonly title?: string
  readonly code?: string
  readonly message?: string
  readonly requestId?: string
  readonly onRetry?: () => void
  readonly retryLabel?: string
  readonly className?: string
  readonly style?: CSSProperties
}

export function ErrorState({
  title = '失联',
  code,
  message,
  requestId,
  onRetry,
  retryLabel = '重试',
  className,
  style,
}: ErrorStateProps) {
  const motionLevel = useMotionLevel()
  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
      }
    }
  }, [])

  const handleCopyRequestId = async (): Promise<void> => {
    if (!requestId || typeof navigator === 'undefined' || !navigator.clipboard) {
      return
    }
    try {
      await navigator.clipboard.writeText(requestId)
      setCopied(true)
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
      }
      copyTimerRef.current = window.setTimeout(() => {
        setCopied(false)
      }, COPY_FEEDBACK_MS)
    } catch {
      // Clipboard may be unavailable in restricted environments
    }
  }

  return (
    <section
      role="alert"
      className={className ? `plate ${className}` : 'plate'}
      style={{
        padding: 'var(--sp-6)',
        background: 'var(--plate)',
        boxShadow: 'var(--shadow-plate)',
        borderRadius: 'var(--radius)',
        border: '1px solid var(--hair)',
        borderLeft: '2px solid var(--yanzhi)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 'var(--sp-3)',
        ...style,
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-display-cjk)',
          fontSize: 'var(--fs-display)',
          lineHeight: 'var(--lh-display)',
          fontWeight: 900,
          letterSpacing: '-0.015em',
          color: 'var(--text-1)',
        }}
      >
        {title}
      </div>

      {code || requestId ? (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 'var(--sp-3)',
          }}
        >
          {code ? (
            <span
              className="num"
              style={{
                padding: '1px 6px',
                border: '1px solid var(--yanzhi)',
                borderRadius: 'var(--radius)',
                fontSize: 'var(--fs-mono)',
                lineHeight: 'var(--lh-mono)',
                color: 'var(--yanzhi)',
              }}
            >
              {code}
            </span>
          ) : null}

          {requestId ? (
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
                gap: 'var(--sp-2)',
                padding: '2px var(--sp-2)',
                border: '1px solid var(--hair-strong)',
                borderRadius: 'var(--radius)',
                background: 'var(--plate-sunken)',
                color: 'var(--text-2)',
                fontSize: 'var(--fs-mono)',
                lineHeight: 'var(--lh-mono)',
                cursor: 'pointer',
              }}
            >
              <span>{copied ? '已复制' : requestId}</span>
              {copied ? (
                <Check size={14} strokeWidth={1.5} style={{ color: 'var(--shilv)' }} />
              ) : (
                <Copy size={14} strokeWidth={1.5} />
              )}
            </button>
          ) : null}
        </div>
      ) : null}

      {message ? (
        <p
          style={{
            margin: 0,
            fontSize: 'var(--fs-body)',
            lineHeight: 'var(--lh-body)',
            color: 'var(--text-2)',
          }}
        >
          {message}
        </p>
      ) : null}

      {onRetry ? (
        <motion.button
          type="button"
          onClick={onRetry}
          whileTap={motionLevel === 'full' ? { scale: 0.96 } : undefined}
          transition={SPRING.press}
          style={{
            marginTop: 'var(--sp-2)',
            padding: 'var(--sp-2) var(--sp-3)',
            border: 0,
            borderBottom: '1px solid var(--hair-strong)',
            borderRadius: 0,
            background: 'transparent',
            color: 'var(--text-1)',
            fontSize: 'var(--fs-body)',
            lineHeight: 'var(--lh-body)',
            cursor: 'pointer',
          }}
        >
          {retryLabel}
        </motion.button>
      ) : null}
    </section>
  )
}
