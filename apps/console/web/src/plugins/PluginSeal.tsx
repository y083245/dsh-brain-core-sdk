import { useMemo, type CSSProperties, type JSX } from 'react'
import {
  buildPluginSealSpec,
  type PluginSealVariant,
} from './seal.ts'

export interface PluginSealProps {
  readonly pluginId: string
  readonly size?: number
  readonly variant?: PluginSealVariant
  readonly className?: string
  readonly title?: string
  readonly style?: CSSProperties
}

const DEFAULT_SIZE = 96

const GLYPH_FONT_STYLE: CSSProperties = {
  fontFamily: 'var(--font-display-latin)',
  fontWeight: 900,
  fontVariationSettings: '"wght" 900, "SOFT" 0, "WONK" 1',
  userSelect: 'none',
}

function renderGlyphNodes(
  glyphs: string,
  fill: string,
  stroke?: string,
  strokeWidth?: number,
): JSX.Element {
  const strokeProps =
    stroke !== undefined
      ? {
          stroke,
          strokeWidth: strokeWidth ?? 1.6,
          strokeLinejoin: 'round' as const,
        }
      : {}

  if (glyphs.length === 2) {
    return (
      <>
        <text
          x={32}
          y={50}
          fontSize={36}
          textAnchor="middle"
          dominantBaseline="central"
          fill={fill}
          style={GLYPH_FONT_STYLE}
          {...strokeProps}
        >
          {glyphs.charAt(0)}
        </text>
        <text
          x={64}
          y={50}
          fontSize={36}
          textAnchor="middle"
          dominantBaseline="central"
          fill={fill}
          style={GLYPH_FONT_STYLE}
          {...strokeProps}
        >
          {glyphs.charAt(1)}
        </text>
      </>
    )
  }

  return (
    <text
      x={48}
      y={50}
      fontSize={48}
      textAnchor="middle"
      dominantBaseline="central"
      fill={fill}
      style={GLYPH_FONT_STYLE}
      {...strokeProps}
    >
      {glyphs}
    </text>
  )
}

export function PluginSeal({
  pluginId,
  size = DEFAULT_SIZE,
  variant = 'auto',
  className,
  title,
  style,
}: PluginSealProps): JSX.Element {
  const spec = useMemo(() => buildPluginSealSpec(pluginId), [pluginId])

  const frameStrokeWidth = Number(spec.frameStrokeWidth.toFixed(2))
  const frameFill =
    variant === 'hollow' || variant === 'pending'
      ? 'none'
      : spec.isBaiwen
        ? 'var(--zhusha)'
        : 'var(--plate)'
  const frameStroke = variant === 'pending' ? 'var(--tenghuang)' : 'var(--zhusha)'

  const ariaLabel = title ?? `${pluginId} 印章`

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox={`0 0 ${spec.viewBoxSize} ${spec.viewBoxSize}`}
      role="img"
      aria-label={ariaLabel}
      data-seal-style={spec.style}
      data-seal-variant={variant}
      className={className}
      style={{
        display: 'block',
        flexShrink: 0,
        ...style,
      }}
    >
      {title !== undefined && <title>{title}</title>}

      <path
        d={spec.framePath}
        fill={frameFill}
        stroke={frameStroke}
        strokeWidth={frameStrokeWidth}
        strokeDasharray={variant === 'pending' ? '6 4' : undefined}
        strokeLinejoin="round"
      />

      {variant === 'hollow'
        ? renderGlyphNodes(spec.glyphs, 'none', 'var(--zhusha)', 1.6)
        : variant === 'pending'
          ? renderGlyphNodes(spec.glyphs, 'var(--tenghuang)')
          : renderGlyphNodes(
              spec.glyphs,
              spec.isBaiwen ? 'var(--plate)' : 'var(--zhusha)',
            )}

      {(variant === 'auto' || variant === 'failed') && (
        <>
          {spec.distressCircles.map((circle, idx) => (
            <circle
              key={idx}
              cx={Number(circle.cx.toFixed(2))}
              cy={Number(circle.cy.toFixed(2))}
              r={Number(circle.r.toFixed(2))}
              fill="var(--plate)"
              data-seal-chip="small"
            />
          ))}
          <circle
            cx={Number(spec.cornerChip.cx.toFixed(2))}
            cy={Number(spec.cornerChip.cy.toFixed(2))}
            r={Number(spec.cornerChip.r.toFixed(2))}
            fill="var(--plate)"
            data-seal-chip="corner"
          />
        </>
      )}

      {variant === 'failed' && (
        <path
          d={spec.crackPath}
          fill="none"
          stroke="var(--yanzhi)"
          strokeWidth={2.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          data-seal-crack="true"
        />
      )}
    </svg>
  )
}
