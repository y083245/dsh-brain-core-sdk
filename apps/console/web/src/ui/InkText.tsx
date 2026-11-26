import { Fragment, type CSSProperties, type HTMLAttributes } from 'react'
import { motion } from 'motion/react'
import { getPreset } from '../motion/presets.ts'
import { useMotionLevel } from '../motion/useMotionLevel.ts'

export type InkTextTag = 'span' | 'h1' | 'h2' | 'p' | 'div'

type OmittedMotionConflicts =
  | 'children'
  | 'onAnimationStart'
  | 'onAnimationEnd'
  | 'onDrag'
  | 'onDragStart'
  | 'onDragEnd'

export interface InkTextProps extends Omit<HTMLAttributes<HTMLElement>, OmittedMotionConflicts> {
  text: string
  fromIndex?: number
  as?: InkTextTag
  className?: string
  style?: CSSProperties
}

const MOTION_TAGS = {
  span: motion.span,
  h1: motion.h1,
  h2: motion.h2,
  p: motion.p,
  div: motion.div,
} as const

const CHAR_SPAN_STYLE: CSSProperties = {
  display: 'inline-block',
  whiteSpace: 'pre',
}

export function InkText({
  text,
  fromIndex = 0,
  as = 'span',
  className,
  style,
  'aria-label': ariaLabel,
  ...rest
}: InkTextProps) {
  const motionLevel = useMotionLevel()
  const variants = getPreset('inkText', motionLevel)

  if (motionLevel === 'reduced') {
    const MotionTag = MOTION_TAGS[as] as typeof motion.span
    return (
      <MotionTag
        className={className}
        style={style}
        variants={variants}
        initial="initial"
        animate="animate"
        aria-label={ariaLabel}
        {...(rest as Record<string, unknown>)}
      >
        {text}
      </MotionTag>
    )
  }

  const chars = Array.from(text)
  const clampedStart = Math.max(0, Math.min(fromIndex, chars.length))
  const staticPrefix = clampedStart > 0 ? chars.slice(0, clampedStart).join('') : ''
  const animatedChars = chars.slice(clampedStart)
  const animatedTotal = animatedChars.length

  const ContainerTag = as

  return (
    <ContainerTag
      className={className}
      style={style}
      aria-label={ariaLabel ?? text}
      {...(rest as HTMLAttributes<HTMLSpanElement>)}
    >
      {staticPrefix ? <span aria-hidden="true">{staticPrefix}</span> : null}
      {animatedChars.map((char, offset) => {
        const absoluteIndex = clampedStart + offset
        if (char === '\n') {
          return <br key={absoluteIndex} />
        }
        return (
          <Fragment key={absoluteIndex}>
            <motion.span
              aria-hidden="true"
              variants={variants}
              initial="initial"
              animate="animate"
              custom={{ index: offset, total: animatedTotal }}
              style={CHAR_SPAN_STYLE}
            >
              {char}
            </motion.span>
          </Fragment>
        )
      })}
    </ContainerTag>
  )
}
