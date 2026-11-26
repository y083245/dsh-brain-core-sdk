import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react'
import { ChevronDown } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { getPreset, REDUCED_FADE_DURATION } from '../motion/presets.ts'
import { DUR, EASE } from '../motion/tokens.ts'
import { useMotionLevel } from '../motion/useMotionLevel.ts'

export interface InkSelectOption<T extends string = string> {
  readonly value: T
  readonly label: string
  readonly description?: string
  readonly disabled?: boolean
}

export interface InkSelectProps<T extends string = string> {
  readonly options: readonly InkSelectOption<T>[]
  readonly value: T | null
  readonly onChange: (value: T) => void
  readonly placeholder?: string
  readonly label?: string
  readonly error?: string | null
  readonly helperText?: string
  readonly disabled?: boolean
  readonly id?: string
  readonly name?: string
  readonly ariaLabel?: string
  readonly className?: string
  readonly style?: CSSProperties
}

const LABEL_STYLE: CSSProperties = {
  display: 'block',
  marginBottom: 'var(--sp-2)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-label)',
  lineHeight: 'var(--lh-label)',
  fontWeight: 600,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--text-2)',
}

const POPUP_MAX_HEIGHT = 280

function findNextEnabledIndex<T extends string>(
  options: readonly InkSelectOption<T>[],
  fromIndex: number,
  direction: 1 | -1,
): number {
  const len = options.length
  if (len === 0) return -1
  let idx = fromIndex
  for (let i = 0; i < len; i += 1) {
    idx = (idx + direction + len) % len
    if (!options[idx]?.disabled) {
      return idx
    }
  }
  return -1
}

function findEdgeEnabledIndex<T extends string>(
  options: readonly InkSelectOption<T>[],
  edge: 'first' | 'last',
): number {
  if (edge === 'first') {
    for (let i = 0; i < options.length; i += 1) {
      if (!options[i]?.disabled) return i
    }
    return -1
  }
  for (let i = options.length - 1; i >= 0; i -= 1) {
    if (!options[i]?.disabled) return i
  }
  return -1
}

export function InkSelect<T extends string = string>({
  options,
  value,
  onChange,
  placeholder = '未选择',
  label,
  error,
  helperText,
  disabled = false,
  id,
  name,
  ariaLabel,
  className,
  style,
}: InkSelectProps<T>) {
  const autoId = useId()
  const triggerId = id ?? autoId
  const labelId = `${triggerId}-label`
  const listboxId = `${triggerId}-listbox`
  const messageId = `${triggerId}-msg`

  const motionLevel = useMotionLevel()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)

  const [open, setOpen] = useState(false)
  const [focused, setFocused] = useState(false)
  const [activeIndex, setActiveIndex] = useState<number>(-1)
  const [openUpward, setOpenUpward] = useState(false)

  const hasError = Boolean(error && error.length > 0)
  const selectedIndex =
    value === null ? -1 : options.findIndex((opt) => opt.value === value)
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined

  const closeMenu = useCallback((returnFocus = false): void => {
    setOpen(false)
    setActiveIndex(-1)
    if (returnFocus) {
      triggerRef.current?.focus()
    }
  }, [])

  const openMenu = useCallback(
    (initialDirection?: 'down' | 'up'): void => {
      if (disabled) return
      if (triggerRef.current && typeof window !== 'undefined') {
        const rect = triggerRef.current.getBoundingClientRect()
        const spaceBelow = window.innerHeight - rect.bottom
        const spaceAbove = rect.top
        setOpenUpward(spaceBelow < POPUP_MAX_HEIGHT + 16 && spaceAbove > spaceBelow)
      }
      setOpen(true)
      if (selectedIndex >= 0 && !options[selectedIndex]?.disabled) {
        setActiveIndex(selectedIndex)
      } else if (initialDirection === 'down') {
        setActiveIndex(findEdgeEnabledIndex(options, 'first'))
      } else if (initialDirection === 'up') {
        setActiveIndex(findEdgeEnabledIndex(options, 'last'))
      } else {
        // Never preselect an option when value is null and opened by click.
        setActiveIndex(-1)
      }
    },
    [disabled, options, selectedIndex],
  )

  const commitOption = useCallback(
    (index: number): void => {
      const option = options[index]
      if (!option || option.disabled) return
      onChange(option.value)
      closeMenu(true)
    },
    [closeMenu, onChange, options],
  )

  // Close on outside click
  useEffect(() => {
    if (!open || typeof document === 'undefined') return
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (containerRef.current && target && !containerRef.current.contains(target)) {
        closeMenu(false)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [closeMenu, open])

  // Keep keyboard-highlighted option visible inside scrollable listbox
  useEffect(() => {
    if (!open || activeIndex < 0 || !listRef.current) return
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-option-index="${activeIndex}"]`,
    )
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' })
    }
  }, [activeIndex, open])

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (disabled) return

    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault()
        if (!open) {
          openMenu('down')
        } else {
          setActiveIndex((prev) =>
            prev < 0
              ? findEdgeEnabledIndex(options, 'first')
              : findNextEnabledIndex(options, prev, 1),
          )
        }
        break
      }
      case 'ArrowUp': {
        event.preventDefault()
        if (!open) {
          openMenu('up')
        } else {
          setActiveIndex((prev) =>
            prev < 0
              ? findEdgeEnabledIndex(options, 'last')
              : findNextEnabledIndex(options, prev, -1),
          )
        }
        break
      }
      case 'Home': {
        if (!open) return
        event.preventDefault()
        setActiveIndex(findEdgeEnabledIndex(options, 'first'))
        break
      }
      case 'End': {
        if (!open) return
        event.preventDefault()
        setActiveIndex(findEdgeEnabledIndex(options, 'last'))
        break
      }
      case 'Enter':
      case ' ': {
        event.preventDefault()
        if (!open) {
          openMenu()
        } else if (activeIndex >= 0) {
          commitOption(activeIndex)
        } else {
          closeMenu(false)
        }
        break
      }
      case 'Escape': {
        if (!open) return
        event.preventDefault()
        closeMenu(true)
        break
      }
      case 'Tab': {
        if (open) {
          closeMenu(false)
        }
        break
      }
      default:
        break
    }
  }

  const activeOptionId =
    open && activeIndex >= 0 ? `${listboxId}-opt-${activeIndex}` : undefined

  const bloomVariants = getPreset('bloom', motionLevel)

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        ...style,
      }}
    >
      {label ? (
        <span id={labelId} style={LABEL_STYLE}>
          {label}
        </span>
      ) : null}

      {name ? <input type="hidden" name={name} value={value ?? ''} /> : null}

      <div
        style={{
          position: 'relative',
          height: '40px',
          background: 'var(--plate-sunken)',
          borderRadius: 0,
          borderBottom: hasError
            ? '1px solid var(--yanzhi)'
            : '1px solid var(--hair-strong)',
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <button
          ref={triggerRef}
          id={triggerId}
          type="button"
          role="combobox"
          disabled={disabled}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={listboxId}
          aria-activedescendant={activeOptionId}
          aria-labelledby={label ? labelId : undefined}
          aria-label={!label ? ariaLabel : undefined}
          aria-invalid={hasError || undefined}
          aria-describedby={hasError || helperText ? messageId : undefined}
          onClick={() => {
            if (open) {
              closeMenu(false)
            } else {
              openMenu()
            }
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={handleKeyDown}
          style={{
            width: '100%',
            height: '100%',
            padding: '0 var(--sp-3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--sp-2)',
            border: 0,
            borderRadius: 0,
            background: 'transparent',
            textAlign: 'left',
            cursor: disabled ? 'not-allowed' : 'pointer',
          }}
        >
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: 'var(--fs-body)',
              lineHeight: 'var(--lh-body)',
              color: selectedOption ? 'var(--text-1)' : 'var(--text-3)',
            }}
          >
            {selectedOption ? selectedOption.label : placeholder}
          </span>

          <motion.span
            aria-hidden="true"
            initial={false}
            animate={{ rotate: open ? 180 : 0 }}
            transition={
              motionLevel === 'reduced'
                ? { duration: REDUCED_FADE_DURATION, ease: EASE.settle }
                : { duration: DUR.quick, ease: EASE.inkOut }
            }
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              color: 'var(--text-2)',
              flexShrink: 0,
            }}
          >
            <ChevronDown size={16} strokeWidth={1.5} />
          </motion.span>
        </button>

        <motion.span
          aria-hidden="true"
          initial={false}
          animate={{
            scaleX: focused || open || hasError ? 1 : 0,
            opacity: focused || open || hasError ? 1 : 0,
          }}
          transition={
            motionLevel === 'reduced'
              ? { duration: REDUCED_FADE_DURATION, ease: EASE.settle }
              : { duration: DUR.base, ease: EASE.inkOut }
          }
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: -1,
            height: '2px',
            background: hasError ? 'var(--yanzhi)' : 'var(--zhusha)',
            transformOrigin: '50% 50%',
            pointerEvents: 'none',
          }}
        />
      </div>

      <AnimatePresence>
        {open ? (
          <motion.ul
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-labelledby={label ? labelId : undefined}
            aria-label={!label ? ariaLabel : undefined}
            variants={bloomVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="plate"
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              ...(openUpward
                ? { bottom: 'calc(100% + 4px)' }
                : { top: 'calc(100% + 4px)' }),
              zIndex: 40,
              margin: 0,
              padding: 'var(--sp-1) 0',
              listStyle: 'none',
              maxHeight: `${POPUP_MAX_HEIGHT}px`,
              overflowY: 'auto',
              background: 'var(--plate-raised)',
              boxShadow: 'var(--shadow-raised)',
              border: '1px solid var(--hair-strong)',
              borderRadius: 'var(--radius)',
            }}
          >
            {options.length === 0 ? (
              <li
                style={{
                  padding: 'var(--sp-2) var(--sp-3)',
                  fontSize: 'var(--fs-small)',
                  color: 'var(--text-3)',
                }}
              >
                {placeholder}
              </li>
            ) : (
              options.map((option, index) => {
                const isSelected = value !== null && option.value === value
                const isHighlighted = index === activeIndex
                const showStroke = (isHighlighted || isSelected) && !option.disabled
                return (
                  <li
                    key={option.value}
                    id={`${listboxId}-opt-${index}`}
                    data-option-index={index}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={option.disabled || undefined}
                    onMouseEnter={() => {
                      if (!option.disabled) {
                        setActiveIndex(index)
                      }
                    }}
                    onMouseDown={(event) => {
                      // Keep focus from bluring before click commit
                      event.preventDefault()
                    }}
                    onClick={() => {
                      commitOption(index)
                    }}
                    style={{
                      position: 'relative',
                      padding: 'var(--sp-2) var(--sp-3)',
                      cursor: option.disabled ? 'not-allowed' : 'pointer',
                      opacity: option.disabled ? 0.4 : 1,
                      background: isHighlighted ? 'var(--plate)' : 'transparent',
                      color: isSelected ? 'var(--text-1)' : 'var(--text-2)',
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        position: 'absolute',
                        left: 0,
                        top: '4px',
                        bottom: '4px',
                        width: '2px',
                        background: 'var(--zhusha)',
                        opacity: showStroke ? 1 : 0,
                      }}
                    />

                    <div
                      style={{
                        fontSize: 'var(--fs-body)',
                        lineHeight: 'var(--lh-body)',
                        fontWeight: isSelected ? 600 : 400,
                        color: isSelected || isHighlighted ? 'var(--text-1)' : 'var(--text-2)',
                      }}
                    >
                      {option.label}
                    </div>

                    {option.description ? (
                      <div
                        style={{
                          fontSize: 'var(--fs-small)',
                          lineHeight: 'var(--lh-small)',
                          color: 'var(--text-3)',
                          marginTop: '2px',
                        }}
                      >
                        {option.description}
                      </div>
                    ) : null}
                  </li>
                )
              })
            )}
          </motion.ul>
        ) : null}
      </AnimatePresence>

      {hasError ? (
        <p
          id={messageId}
          role="alert"
          style={{
            marginTop: 'var(--sp-1)',
            fontSize: 'var(--fs-small)',
            lineHeight: 'var(--lh-small)',
            color: 'var(--yanzhi)',
          }}
        >
          {error}
        </p>
      ) : helperText ? (
        <p
          id={messageId}
          style={{
            marginTop: 'var(--sp-1)',
            fontSize: 'var(--fs-small)',
            lineHeight: 'var(--lh-small)',
            color: 'var(--text-3)',
          }}
        >
          {helperText}
        </p>
      ) : null}
    </div>
  )
}
