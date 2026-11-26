import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { REDUCED_FADE_DURATION } from '../motion/presets.ts'
import { DUR, EASE, SPRING } from '../motion/tokens.ts'
import { useMotionLevel } from '../motion/useMotionLevel.ts'

export type CovenantTitleSize = 'display' | 'h1'

export interface CovenantProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly title: string
  readonly titleSize?: CovenantTitleSize
  readonly subtitle?: ReactNode
  readonly children?: ReactNode
  readonly footer?: ReactNode
  readonly closeOnBackdrop?: boolean
  readonly closeOnEscape?: boolean
  readonly maxWidth?: number
  readonly ariaLabel?: string
  readonly className?: string
  readonly style?: CSSProperties
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const nodes = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
  return nodes.filter((el) => {
    if (el.hasAttribute('disabled')) return false
    if (el.getAttribute('aria-hidden') === 'true') return false
    const style = window.getComputedStyle(el)
    return style.display !== 'none' && style.visibility !== 'hidden'
  })
}

export function Covenant({
  open,
  onClose,
  title,
  titleSize = 'display',
  subtitle,
  children,
  footer,
  closeOnBackdrop = true,
  closeOnEscape = true,
  maxWidth = 640,
  ariaLabel,
  className,
  style,
}: CovenantProps) {
  const motionLevel = useMotionLevel()
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  const handleClose = useCallback(() => {
    onClose()
  }, [onClose])

  useEffect(() => {
    if (!open || typeof document === 'undefined') return

    const activeEl = document.activeElement
    previousFocusRef.current = activeEl instanceof HTMLElement ? activeEl : null

    const focusTimer = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current
      if (!dialog) return
      const focusables = getFocusableElements(dialog)
      const first = focusables[0]
      if (first) {
        first.focus()
      } else {
        dialog.focus()
      }
    })

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && closeOnEscape) {
        event.preventDefault()
        event.stopPropagation()
        handleClose()
        return
      }
      if (event.key === 'Tab') {
        const dialog = dialogRef.current
        if (!dialog) return
        const focusables = getFocusableElements(dialog)
        if (focusables.length === 0) {
          event.preventDefault()
          dialog.focus()
          return
        }
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        if (!first || !last) return
        const current = document.activeElement
        if (event.shiftKey) {
          if (current === first || !dialog.contains(current)) {
            event.preventDefault()
            last.focus()
          }
        } else if (current === last || !dialog.contains(current)) {
          event.preventDefault()
          first.focus()
        }
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.cancelAnimationFrame(focusTimer)
      document.removeEventListener('keydown', onKeyDown)
      const opener = previousFocusRef.current
      previousFocusRef.current = null
      if (opener && opener.isConnected) {
        opener.focus()
      }
    }
  }, [open, closeOnEscape, handleClose])

  const isReduced = motionLevel === 'reduced'

  if (typeof document === 'undefined') {
    return null
  }

  return createPortal(
    <AnimatePresence>
      {open && (
        <div
          className="flex items-center justify-center"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 70,
            padding: 'var(--sp-5)',
          }}
        >
          {/* Backdrop: 50% --ink-void, flat scrim without frosting */}
          <motion.div
            aria-hidden="true"
            initial={{ opacity: 0 }}
            animate={{
              opacity: 1,
              transition: {
                duration: isReduced ? REDUCED_FADE_DURATION : DUR.base,
                ease: EASE.settle,
              },
            }}
            exit={{
              opacity: 0,
              transition: {
                duration: isReduced ? REDUCED_FADE_DURATION : DUR.quick,
                ease: EASE.inkIn,
              },
            }}
            onClick={closeOnBackdrop ? handleClose : undefined}
            style={{
              position: 'fixed',
              inset: 0,
              background: 'color-mix(in srgb, var(--ink-void) 50%, transparent)',
            }}
          />

          {/* Covenant formal document modal */}
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-label={ariaLabel}
            tabIndex={-1}
            initial={isReduced ? { opacity: 0 } : { opacity: 0, scale: 1.06 }}
            animate={
              isReduced
                ? {
                    opacity: 1,
                    transition: { duration: REDUCED_FADE_DURATION, ease: EASE.settle },
                  }
                : {
                    opacity: 1,
                    scale: 1,
                    transition: SPRING.heavy,
                  }
            }
            exit={
              isReduced
                ? {
                    opacity: 0,
                    transition: { duration: REDUCED_FADE_DURATION, ease: EASE.settle },
                  }
                : {
                    opacity: 0,
                    scale: 1.03,
                    transition: { duration: DUR.quick, ease: EASE.inkIn },
                  }
            }
            className={['plate', className].filter(Boolean).join(' ')}
            style={{
              position: 'relative',
              zIndex: 1,
              width: '100%',
              maxWidth: `${maxWidth}px`,
              maxHeight: 'calc(100vh - 48px)',
              display: 'flex',
              flexDirection: 'column',
              background: 'var(--plate-raised)',
              boxShadow: 'var(--shadow-raised)',
              border: '1px solid var(--hair-strong)',
              borderRadius: 'var(--radius)',
              overflow: 'hidden',
              outline: 'none',
              ...style,
            }}
          >
            <header
              className="flex flex-col items-center text-center"
              style={{
                padding: 'var(--sp-6) var(--sp-6) var(--sp-4)',
                borderBottom: '1px solid var(--hair)',
                flexShrink: 0,
              }}
            >
              <h2
                id={titleId}
                style={{
                  margin: 0,
                  fontFamily: 'var(--font-display-cjk)',
                  fontSize: titleSize === 'display' ? 'var(--fs-display)' : 'var(--fs-h1)',
                  lineHeight: titleSize === 'display' ? 'var(--lh-display)' : 'var(--lh-h1)',
                  fontWeight: titleSize === 'display' ? 900 : 700,
                  letterSpacing: titleSize === 'display' ? '0.18em' : '0.12em',
                  paddingLeft: titleSize === 'display' ? '0.18em' : '0.12em',
                  color: 'var(--text-1)',
                }}
              >
                {title}
              </h2>
              {subtitle !== undefined && (
                <div
                  className="mt-2"
                  style={{
                    fontSize: 'var(--fs-small)',
                    lineHeight: 'var(--lh-small)',
                    color: 'var(--text-2)',
                  }}
                >
                  {subtitle}
                </div>
              )}
            </header>

            <div
              style={{
                flex: 1,
                minHeight: 0,
                overflowY: 'auto',
                padding: 'var(--sp-5) var(--sp-6)',
                color: 'var(--text-1)',
              }}
            >
              {children}
            </div>

            {footer !== undefined && (
              <footer
                className="flex flex-col items-center gap-3"
                style={{
                  padding: 'var(--sp-5) var(--sp-6) var(--sp-6)',
                  borderTop: '1px solid var(--hair)',
                  flexShrink: 0,
                }}
              >
                {footer}
              </footer>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
