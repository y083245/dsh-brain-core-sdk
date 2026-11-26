import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
} from 'react'
import { motion, useAnimate } from 'motion/react'
import { REDUCED_FADE_DURATION } from '../motion/presets.ts'
import { DUR, EASE } from '../motion/tokens.ts'
import { useMotionLevel } from '../motion/useMotionLevel.ts'

// Section 7.6 specifies 3 horizontal oscillations (+/-3px) over 240ms on error.
const ERROR_SHAKE_KEYFRAMES = [0, -3, 3, -3, 3, -3, 0]
const ERROR_SHAKE_DURATION_SEC = 0.24

const FIELD_LABEL_STYLE: CSSProperties = {
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

const HELPER_TEXT_STYLE: CSSProperties = {
  marginTop: 'var(--sp-1)',
  fontSize: 'var(--fs-small)',
  lineHeight: 'var(--lh-small)',
  color: 'var(--text-3)',
}

const ERROR_TEXT_STYLE: CSSProperties = {
  marginTop: 'var(--sp-1)',
  fontSize: 'var(--fs-small)',
  lineHeight: 'var(--lh-small)',
  color: 'var(--yanzhi)',
}

export interface InkInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> {
  readonly label?: string
  readonly error?: string | null
  readonly helperText?: string
  readonly monospace?: boolean
  readonly prefix?: ReactNode
  readonly suffix?: ReactNode
  readonly containerClassName?: string
  readonly containerStyle?: CSSProperties
  readonly ref?: Ref<HTMLInputElement>
}

export function InkInput({
  label,
  error,
  helperText,
  monospace = false,
  prefix,
  suffix,
  containerClassName,
  containerStyle,
  className,
  style,
  id,
  type = 'text',
  disabled,
  onFocus,
  onBlur,
  'aria-describedby': ariaDescribedBy,
  ref,
  ...rest
}: InkInputProps) {
  const autoId = useId()
  const inputId = id ?? autoId
  const messageId = `${inputId}-msg`
  const motionLevel = useMotionLevel()
  const [focused, setFocused] = useState(false)
  const [scope, animate] = useAnimate<HTMLDivElement>()
  const prevErrorRef = useRef<string | null | undefined>(error)

  const hasError = Boolean(error && error.length > 0)
  const isPassword = type === 'password'

  useEffect(() => {
    const prevError = prevErrorRef.current
    prevErrorRef.current = error
    if (error && error !== prevError && motionLevel === 'full' && scope.current) {
      void animate(
        scope.current,
        { x: ERROR_SHAKE_KEYFRAMES },
        { duration: ERROR_SHAKE_DURATION_SEC, ease: EASE.settle },
      )
    }
  }, [animate, error, motionLevel, scope])

  const describedBy = [
    ariaDescribedBy,
    hasError || helperText ? messageId : undefined,
  ]
    .filter(Boolean)
    .join(' ') || undefined

  const handleFocus = (event: FocusEvent<HTMLInputElement>): void => {
    setFocused(true)
    onFocus?.(event)
  }

  const handleBlur = (event: FocusEvent<HTMLInputElement>): void => {
    setFocused(false)
    onBlur?.(event)
  }

  return (
    <div
      className={containerClassName}
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        ...containerStyle,
      }}
    >
      {label ? (
        <label htmlFor={inputId} style={FIELD_LABEL_STYLE}>
          {label}
        </label>
      ) : null}

      <div
        ref={scope}
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          height: '40px',
          background: 'var(--plate-sunken)',
          borderRadius: 0,
          borderBottom: hasError
            ? '1px solid var(--yanzhi)'
            : '1px solid var(--hair-strong)',
          opacity: disabled ? 0.5 : 1,
        }}
      >
        {prefix ? (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              paddingLeft: 'var(--sp-3)',
              color: 'var(--text-2)',
              flexShrink: 0,
            }}
          >
            {prefix}
          </span>
        ) : null}

        <input
          {...rest}
          ref={ref}
          id={inputId}
          type={type}
          disabled={disabled}
          aria-invalid={hasError || undefined}
          aria-describedby={describedBy}
          onFocus={handleFocus}
          onBlur={handleBlur}
          className={className}
          style={{
            width: '100%',
            height: '100%',
            padding: '0 var(--sp-3)',
            border: 0,
            borderRadius: 0,
            background: 'transparent',
            color: 'var(--text-1)',
            fontFamily: monospace || isPassword ? 'var(--font-mono)' : 'var(--font-ui)',
            fontSize: monospace || isPassword ? 'var(--fs-mono)' : 'var(--fs-body)',
            lineHeight: monospace || isPassword ? 'var(--lh-mono)' : 'var(--lh-body)',
            fontVariantNumeric: 'tabular-nums',
            ...style,
          }}
        />

        {/* Password fields strictly omit any plaintext reveal control (FR-C05 / Section 7.6). */}
        {!isPassword && suffix ? (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              paddingRight: 'var(--sp-3)',
              color: 'var(--text-2)',
              flexShrink: 0,
            }}
          >
            {suffix}
          </span>
        ) : null}

        <motion.span
          aria-hidden="true"
          initial={false}
          animate={{
            scaleX: focused || hasError ? 1 : 0,
            opacity: focused || hasError ? 1 : 0,
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

      {hasError ? (
        <p id={messageId} role="alert" style={ERROR_TEXT_STYLE}>
          {error}
        </p>
      ) : helperText ? (
        <p id={messageId} style={HELPER_TEXT_STYLE}>
          {helperText}
        </p>
      ) : null}
    </div>
  )
}

export interface InkTextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  readonly label?: string
  readonly error?: string | null
  readonly helperText?: string
  readonly monospace?: boolean
  readonly containerClassName?: string
  readonly containerStyle?: CSSProperties
  readonly ref?: Ref<HTMLTextAreaElement>
}

export function InkTextarea({
  label,
  error,
  helperText,
  monospace = false,
  containerClassName,
  containerStyle,
  className,
  style,
  id,
  rows = 4,
  disabled,
  onFocus,
  onBlur,
  'aria-describedby': ariaDescribedBy,
  ref,
  ...rest
}: InkTextareaProps) {
  const autoId = useId()
  const textareaId = id ?? autoId
  const messageId = `${textareaId}-msg`
  const motionLevel = useMotionLevel()
  const [focused, setFocused] = useState(false)
  const [scope, animate] = useAnimate<HTMLDivElement>()
  const prevErrorRef = useRef<string | null | undefined>(error)

  const hasError = Boolean(error && error.length > 0)

  useEffect(() => {
    const prevError = prevErrorRef.current
    prevErrorRef.current = error
    if (error && error !== prevError && motionLevel === 'full' && scope.current) {
      void animate(
        scope.current,
        { x: ERROR_SHAKE_KEYFRAMES },
        { duration: ERROR_SHAKE_DURATION_SEC, ease: EASE.settle },
      )
    }
  }, [animate, error, motionLevel, scope])

  const describedBy = [
    ariaDescribedBy,
    hasError || helperText ? messageId : undefined,
  ]
    .filter(Boolean)
    .join(' ') || undefined

  const handleFocus = (event: FocusEvent<HTMLTextAreaElement>): void => {
    setFocused(true)
    onFocus?.(event)
  }

  const handleBlur = (event: FocusEvent<HTMLTextAreaElement>): void => {
    setFocused(false)
    onBlur?.(event)
  }

  return (
    <div
      className={containerClassName}
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        ...containerStyle,
      }}
    >
      {label ? (
        <label htmlFor={textareaId} style={FIELD_LABEL_STYLE}>
          {label}
        </label>
      ) : null}

      <div
        ref={scope}
        style={{
          position: 'relative',
          display: 'flex',
          background: 'var(--plate-sunken)',
          borderRadius: 0,
          borderBottom: hasError
            ? '1px solid var(--yanzhi)'
            : '1px solid var(--hair-strong)',
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <textarea
          {...rest}
          ref={ref}
          id={textareaId}
          rows={rows}
          disabled={disabled}
          aria-invalid={hasError || undefined}
          aria-describedby={describedBy}
          onFocus={handleFocus}
          onBlur={handleBlur}
          className={className}
          style={{
            width: '100%',
            minHeight: '96px',
            padding: 'var(--sp-3)',
            border: 0,
            borderRadius: 0,
            background: 'transparent',
            color: 'var(--text-1)',
            resize: 'vertical',
            fontFamily: monospace ? 'var(--font-mono)' : 'var(--font-ui)',
            fontSize: monospace ? 'var(--fs-mono)' : 'var(--fs-body)',
            lineHeight: monospace ? 'var(--lh-mono)' : 'var(--lh-body)',
            ...style,
          }}
        />

        <motion.span
          aria-hidden="true"
          initial={false}
          animate={{
            scaleX: focused || hasError ? 1 : 0,
            opacity: focused || hasError ? 1 : 0,
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

      {hasError ? (
        <p id={messageId} role="alert" style={ERROR_TEXT_STYLE}>
          {error}
        </p>
      ) : helperText ? (
        <p id={messageId} style={HELPER_TEXT_STYLE}>
          {helperText}
        </p>
      ) : null}
    </div>
  )
}
