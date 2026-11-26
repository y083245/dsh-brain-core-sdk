import type { CSSProperties, ReactNode } from 'react'

export type BadgeTone =
  | 'neutral'
  | 'zhusha'
  | 'tenghuang'
  | 'shilv'
  | 'shiqing'
  | 'yanzhi'

export interface BadgeProps {
  readonly tone?: BadgeTone
  readonly children: ReactNode
  readonly className?: string
  readonly style?: CSSProperties
}

const TONE_STYLES: Readonly<
  Record<BadgeTone, { readonly color: string; readonly borderColor: string }>
> = {
  neutral: {
    color: 'var(--text-2)',
    borderColor: 'var(--hair-strong)',
  },
  zhusha: {
    color: 'var(--zhusha)',
    borderColor: 'var(--zhusha)',
  },
  tenghuang: {
    color: 'var(--tenghuang)',
    borderColor: 'var(--tenghuang)',
  },
  shilv: {
    color: 'var(--shilv)',
    borderColor: 'var(--shilv)',
  },
  shiqing: {
    color: 'var(--shiqing)',
    borderColor: 'var(--shiqing)',
  },
  yanzhi: {
    color: 'var(--yanzhi)',
    borderColor: 'var(--yanzhi)',
  },
}

export function Badge({
  tone = 'neutral',
  children,
  className,
  style,
}: BadgeProps) {
  const colors = TONE_STYLES[tone]
  return (
    <span
      data-tone={tone}
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--sp-1)',
        padding: '1px 6px',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--fs-mono)',
        lineHeight: 'var(--lh-mono)',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
        background: 'transparent',
        border: `1px solid ${colors.borderColor}`,
        borderRadius: 'var(--radius)',
        color: colors.color,
        ...style,
      }}
    >
      {children}
    </span>
  )
}
