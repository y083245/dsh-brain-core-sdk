import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { X } from 'lucide-react'
import { getPreset, REDUCED_FADE_DURATION } from '../motion/presets.ts'
import { DUR, EASE, SPRING } from '../motion/tokens.ts'
import { useMotionLevel } from '../motion/useMotionLevel.ts'

export type ScrollDrawerSize = 'md' | 'lg'

export interface ScrollDrawerProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly size?: ScrollDrawerSize
  readonly title?: ReactNode
  readonly headerExtra?: ReactNode
  readonly footer?: ReactNode
  readonly closeOnBackdrop?: boolean
  readonly closeOnEscape?: boolean
  readonly ariaLabel?: string
  readonly children?: ReactNode
  readonly className?: string
  readonly style?: CSSProperties
}

const SIZE_WIDTH_PX: Readonly<Record<ScrollDrawerSize, number>> = {
  md: 560,
  lg: 720,
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

export function ScrollDrawer({
  open,
  onClose,
  size = 'md',
  title,
  headerExtra,
  footer,
  closeOnBackdrop = true,
  closeOnEscape = true,
  ariaLabel,
  children,
  className,
  style,
}: ScrollDrawerProps) {
  const motionLevel = useMotionLevel()
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  const handleClose = useCallback(() => {
    onClose()
  }, [onClose])

  useEffect(() => {
    if (!open || typeof document === 'undefined') return

    const activeEl = document.activeElement
    previousFocusRef.current = activeEl instanceof HTMLElement ? activeEl : null

    const focusTimer = window.requestAnimationFrame(() => {
      const panel = panelRef.current
      if (!panel) return
      const focusables = getFocusableElements(panel)
      const first = focusables[0]
      if (first) {
        first.focus()
      } else {
        panel.focus()
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
        const panel = panelRef.current
        if (!panel) return
        const focusables = getFocusableElements(panel)
        if (focusables.length === 0) {
          event.preventDefault()
          panel.focus()
          return
        }
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        if (!first || !last) return
        const current = document.activeElement
        if (event.shiftKey) {
          if (current === first || !panel.contains(current)) {
            event.preventDefault()
            last.focus()
          }
        } else if (current === last || !panel.contains(current)) {
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

  const contentVariants = useMemo(() => getPreset('bloom', motionLevel), [motionLevel])
  const isReduced = motionLevel === 'reduced'
  const drawerWidth = SIZE_WIDTH_PX[size]

  if (typeof document === 'undefined') {
    return null
  }

  return createPortal(
    <AnimatePresence>
      {open && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 60,
            display: 'flex',
            justifyContent: 'flex-end',
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

          {/* Scroll container */}
          <div
            style={{
              position: 'relative',
              zIndex: 1,
              width: `${drawerWidth}px`,
              maxWidth: 'calc(100vw - 24px)',
              height: '100%',
              display: 'flex',
            }}
          >
            {/* Leading 2px zhusha vertical axis appearing first before unrolling */}
            <motion.span
              aria-hidden="true"
              initial={isReduced ? { opacity: 0 } : { opacity: 0, scaleY: 0 }}
              animate={
                isReduced
                  ? {
                      opacity: 1,
                      transition: { duration: REDUCED_FADE_DURATION, ease: EASE.settle },
                    }
                  : {
                      opacity: 1,
                      scaleY: 1,
                      transition: { duration: DUR.instant, ease: EASE.inkOut },
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
                      scaleY: 0,
                      transition: {
                        duration: DUR.instant,
                        delay: DUR.quick,
                        ease: EASE.inkIn,
                      },
                    }
              }
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: '2px',
                background: 'var(--zhusha)',
                transformOrigin: 'top center',
                zIndex: 3,
                pointerEvents: 'none',
              }}
            />

            {/* Unrolling scroll plate */}
            <motion.div
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={title !== undefined ? titleId : undefined}
              aria-label={title === undefined ? (ariaLabel ?? '详情抽屉') : undefined}
              tabIndex={-1}
              initial={
                isReduced
                  ? { opacity: 0 }
                  : { clipPath: 'inset(0% 100% 0% 0%)' }
              }
              animate={
                isReduced
                  ? {
                      opacity: 1,
                      transition: { duration: REDUCED_FADE_DURATION, ease: EASE.settle },
                    }
                  : {
                      clipPath: 'inset(0% 0% 0% 0%)',
                      transition: { ...SPRING.float, delay: DUR.instant * 0.6 },
                    }
              }
              exit={
                isReduced
                  ? {
                      opacity: 0,
                      transition: { duration: REDUCED_FADE_DURATION, ease: EASE.settle },
                    }
                  : {
                      clipPath: 'inset(0% 100% 0% 0%)',
                      transition: { duration: DUR.base, ease: EASE.inkIn },
                    }
              }
              className={['plate', className].filter(Boolean).join(' ')}
              style={{
                width: '100%',
                height: '100%',
                background: 'var(--plate-raised)',
                boxShadow: 'var(--shadow-raised)',
                borderRadius: 0,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                outline: 'none',
                ...style,
              }}
            >
              {/* Inner content blooms in around ~60% of scroll expansion */}
              <motion.div
                variants={contentVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                custom={isReduced ? 0 : DUR.quick}
                style={{
                  position: 'relative',
                  zIndex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  height: '100%',
                  minHeight: 0,
                }}
              >
                <div
                  className="flex items-start justify-between gap-4"
                  style={{
                    padding: 'var(--sp-5) var(--sp-6) var(--sp-4)',
                    borderBottom: '1px solid var(--hair)',
                    flexShrink: 0,
                  }}
                >
                  <div className="min-w-0 flex-1">
                    {title !== undefined && (
                      <div
                        id={titleId}
                        style={{
                          fontSize: 'var(--fs-h2)',
                          lineHeight: 'var(--lh-h2)',
                          fontWeight: 600,
                          color: 'var(--text-1)',
                        }}
                      >
                        {title}
                      </div>
                    )}
                    {headerExtra !== undefined && <div className="mt-1">{headerExtra}</div>}
                  </div>

                  <button
                    type="button"
                    onClick={handleClose}
                    aria-label="关闭抽屉"
                    className="flex items-center justify-center shrink-0"
                    style={{
                      width: '32px',
                      height: '32px',
                      background: 'transparent',
                      border: '1px solid var(--hair)',
                      borderRadius: 'var(--radius)',
                      color: 'var(--text-2)',
                      cursor: 'pointer',
                    }}
                  >
                    <X size={16} strokeWidth={1.5} aria-hidden="true" />
                  </button>
                </div>

                <div
                  style={{
                    flex: 1,
                    minHeight: 0,
                    overflowY: 'auto',
                    padding: 'var(--sp-5) var(--sp-6)',
                  }}
                >
                  {children}
                </div>

                {footer !== undefined && (
                  <div
                    className="flex items-center justify-between gap-3"
                    style={{
                      padding: 'var(--sp-4) var(--sp-6)',
                      borderTop: '1px solid var(--hair)',
                      flexShrink: 0,
                    }}
                  >
                    {footer}
                  </div>
                )}
              </motion.div>
            </motion.div>
          </div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
