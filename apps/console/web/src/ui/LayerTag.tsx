import type { CSSProperties } from 'react'

export type MemoryLayer = 'L0' | 'L1' | 'L2' | 'L3'

export interface LayerTagProps {
  readonly layer: MemoryLayer
  readonly className?: string
  readonly style?: CSSProperties
}

const BASE_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'var(--font-mono)',
  fontVariantNumeric: 'tabular-nums',
  fontWeight: 600,
  lineHeight: 1,
  borderRadius: 'var(--radius)',
  userSelect: 'none',
  flexShrink: 0,
}

const LAYER_STYLES: Readonly<Record<MemoryLayer, CSSProperties>> = {
  L0: {
    fontSize: 'var(--fs-label)',
    padding: '2px 5px',
    color: 'var(--tone-l0)',
    background: 'transparent',
    border: '1px solid var(--tone-l0)',
  },
  L1: {
    fontSize: 'var(--fs-label)',
    padding: '2px 5px',
    color: 'var(--tone-l1)',
    background: 'var(--plate-raised)',
    border: '1px solid var(--hair)',
  },
  L2: {
    fontSize: 'var(--fs-label)',
    padding: '2px 5px',
    color: 'var(--plate)',
    background: 'var(--text-1)',
    border: '1px solid var(--text-1)',
  },
  L3: {
    width: '18px',
    height: '18px',
    padding: 0,
    fontSize: 'var(--fs-label)',
    letterSpacing: '-0.02em',
    color: 'var(--plate)',
    background: 'var(--zhusha)',
    border: '1px solid var(--zhusha)',
  },
}

export function LayerTag({ layer, className, style }: LayerTagProps) {
  return (
    <span
      data-layer={layer}
      className={className}
      style={{
        ...BASE_STYLE,
        ...LAYER_STYLES[layer],
        ...style,
      }}
    >
      {layer}
    </span>
  )
}
