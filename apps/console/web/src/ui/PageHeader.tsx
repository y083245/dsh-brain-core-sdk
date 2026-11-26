import type { CSSProperties, ReactNode } from 'react'
import { InkText } from './InkText.tsx'

export interface PageHeaderProps {
  label: string
  title: string
  actions?: ReactNode
  className?: string
  style?: CSSProperties
}

const HEADER_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'space-between',
  gap: 'var(--sp-4)',
  marginBottom: 'var(--sp-7)',
}

const LEFT_GROUP_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--sp-2)',
  minWidth: 0,
}

const TITLE_STYLE: CSSProperties = {
  margin: 0,
}

const ACTIONS_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sp-3)',
  flexShrink: 0,
}

export function PageHeader({ label, title, actions, className, style }: PageHeaderProps) {
  return (
    <header className={className} style={{ ...HEADER_STYLE, ...style }}>
      <div style={LEFT_GROUP_STYLE}>
        <div className="label inktide-page-label">{label}</div>
        <InkText as="h1" text={title} className="title-display" style={TITLE_STYLE} />
      </div>
      {actions ? <div style={ACTIONS_STYLE}>{actions}</div> : null}
    </header>
  )
}
