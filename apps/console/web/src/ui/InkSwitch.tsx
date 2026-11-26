import {
  useContext,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { motion } from 'motion/react'
import { InkContext } from '../ink/InkProvider.tsx'
import { DUR, EASE, SPRING } from '../motion/tokens.ts'
import { useMotionLevel } from '../motion/useMotionLevel.ts'

export interface InkSwitchProps {
  readonly checked: boolean
  readonly onChange: (checked: boolean) => void
  readonly disabled?: boolean
  readonly label?: string
  readonly description?: string
  readonly id?: string
  readonly ariaLabel?: string
  readonly className?: string
  readonly style?: CSSProperties
}

// Track is 40x20px with 1px border (38x18px inner); 16px knob sits 1px from edges -> 20px travel.
const KNOB_TRAVEL_PX = 20

export function InkSwitch({
  checked,
  onChange,
  disabled = false,
  label,
  description,
  id,
  ariaLabel,
  className,
  style,
}: InkSwitchProps) {
  const autoId = useId()
  const switchId = id ?? autoId
  const labelId = `${switchId}-label`
  const descriptionId = `${switchId}-description`
  const motionLevel = useMotionLevel()
  const ink = useContext(InkContext)

  const trackRef = useRef<HTMLButtonElement | null>(null)
  const pendingSplatRef = useRef(false)
  const [stretchCount, setStretchCount] = useState(0)

  const handleToggle = (): void => {
    if (disabled) return
    const next = !checked
    if (motionLevel === 'full') {
      setStretchCount((c) => c + 1)
      if (next) {
        pendingSplatRef.current = true
      }
    }
    onChange(next)
  }

  const fireSettleSplat = (): void => {
    if (!pendingSplatRef.current) return
    pendingSplatRef.current = false
    if (motionLevel !== 'full' || !ink || !trackRef.current) return
    const rect = trackRef.current.getBoundingClientRect()
    ink.splat({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      radius: 18,
      amount: 0.15,
      color: 'zhusha',
    })
  }

  return (
    <div
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--sp-3)',
        opacity: disabled ? 0.5 : 1,
        ...style,
      }}
    >
      <button
        ref={trackRef}
        id={switchId}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={label ? labelId : undefined}
        aria-label={!label ? ariaLabel : undefined}
        aria-describedby={description ? descriptionId : undefined}
        disabled={disabled}
        onClick={handleToggle}
        style={{
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          width: '40px',
          height: '20px',
          padding: 0,
          borderRadius: '10px',
          border: checked
            ? '1px solid var(--zhusha)'
            : '1px solid var(--hair-strong)',
          background: 'var(--plate-sunken)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          flexShrink: 0,
        }}
      >
        <motion.span
          aria-hidden="true"
          initial={false}
          animate={{
            x: checked ? KNOB_TRAVEL_PX : 0,
          }}
          transition={
            motionLevel === 'reduced'
              ? { duration: 0 }
              : SPRING.snappy
          }
          onAnimationComplete={fireSettleSplat}
          style={{
            position: 'absolute',
            left: '1px',
            top: '1px',
            width: '16px',
            height: '16px',
            display: 'block',
            pointerEvents: 'none',
          }}
        >
          <motion.span
            key={stretchCount}
            initial={false}
            animate={
              motionLevel === 'full' && stretchCount > 0
                ? { scaleX: [1, 1.35, 1] }
                : { scaleX: 1 }
            }
            transition={{ duration: DUR.quick, ease: EASE.inkOut }}
            style={{
              display: 'block',
              width: '100%',
              height: '100%',
              borderRadius: '50%',
              background: checked ? 'var(--zhusha)' : 'var(--text-2)',
              transformOrigin: '50% 50%',
            }}
          />
        </motion.span>
      </button>

      {label || description ? (
        <span
          onClick={handleToggle}
          style={{
            display: 'flex',
            flexDirection: 'column',
            cursor: disabled ? 'not-allowed' : 'pointer',
            userSelect: 'none',
          }}
        >
          {label ? (
            <span
              id={labelId}
              style={{
                fontSize: 'var(--fs-body)',
                lineHeight: 'var(--lh-body)',
                color: 'var(--text-1)',
              }}
            >
              {label}
            </span>
          ) : null}
          {description ? (
            <span
              id={descriptionId}
              style={{
                fontSize: 'var(--fs-small)',
                lineHeight: 'var(--lh-small)',
                color: 'var(--text-2)',
              }}
            >
              {description}
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  )
}
