export type PluginSealVariant = 'auto' | 'hollow' | 'pending' | 'failed'

export interface PluginSealDistressCircle {
  readonly cx: number
  readonly cy: number
  readonly r: number
}

export interface PluginSealSpec {
  readonly pluginId: string
  readonly viewBoxSize: number
  readonly glyphs: string
  readonly style: 'baiwen' | 'zhuwen'
  readonly isBaiwen: boolean
  readonly framePath: string
  readonly frameStrokeWidth: number
  readonly distressCircles: readonly PluginSealDistressCircle[]
  readonly cornerChip: PluginSealDistressCircle
  readonly crackPath: string
}

interface Point2D {
  readonly x: number
  readonly y: number
}

const SPEC_CACHE = new Map<string, PluginSealSpec>()
const SEAL_CACHE = new Map<string, string>()

const VIEWBOX_SIZE = 96
const CENTER = VIEWBOX_SIZE / 2
const FRAME_MIN = 6
const FRAME_MAX = VIEWBOX_SIZE - 6
const POINTS_PER_EDGE = 7
const EDGE_JITTER = 1.6
const CORNER_COORDS: readonly Point2D[] = [
  { x: FRAME_MIN, y: FRAME_MIN },
  { x: FRAME_MAX, y: FRAME_MIN },
  { x: FRAME_MAX, y: FRAME_MAX },
  { x: FRAME_MIN, y: FRAME_MAX },
]

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function fmt(n: number): string {
  const fixed = n.toFixed(2)
  return fixed === '-0.00' ? '0.00' : fixed
}

/**
 * Extract 1-2 uppercase ASCII alphanumeric seal glyphs from a plugin id
 * split by '-', '_', or '.'; falls back to '◆' when no allowed characters exist.
 */
export function extractSealGlyphs(pluginId: string): string {
  const segments = pluginId.split(/[-_.]+/)
  const glyphs: string[] = []
  for (const segment of segments) {
    if (segment.length === 0) continue
    const first = segment.charAt(0).toUpperCase()
    if (/^[A-Z0-9]$/.test(first)) {
      glyphs.push(first)
      if (glyphs.length === 2) break
    }
  }
  return glyphs.length > 0 ? glyphs.join('') : '◆'
}

function buildOrganicFramePath(rand: () => number): string {
  const perimeter: Point2D[] = []
  const span = FRAME_MAX - FRAME_MIN

  // Top edge: left -> right (7 points)
  for (let i = 0; i < POINTS_PER_EDGE; i += 1) {
    const t = i / POINTS_PER_EDGE
    const jitter = (rand() * 2 - 1) * EDGE_JITTER
    perimeter.push({ x: FRAME_MIN + t * span, y: FRAME_MIN + jitter })
  }
  // Right edge: top -> bottom (7 points)
  for (let i = 0; i < POINTS_PER_EDGE; i += 1) {
    const t = i / POINTS_PER_EDGE
    const jitter = (rand() * 2 - 1) * EDGE_JITTER
    perimeter.push({ x: FRAME_MAX + jitter, y: FRAME_MIN + t * span })
  }
  // Bottom edge: right -> left (7 points)
  for (let i = 0; i < POINTS_PER_EDGE; i += 1) {
    const t = i / POINTS_PER_EDGE
    const jitter = (rand() * 2 - 1) * EDGE_JITTER
    perimeter.push({ x: FRAME_MAX - t * span, y: FRAME_MAX + jitter })
  }
  // Left edge: bottom -> top (7 points)
  for (let i = 0; i < POINTS_PER_EDGE; i += 1) {
    const t = i / POINTS_PER_EDGE
    const jitter = (rand() * 2 - 1) * EDGE_JITTER
    perimeter.push({ x: FRAME_MIN + jitter, y: FRAME_MAX - t * span })
  }

  const count = perimeter.length
  const last = perimeter[count - 1]!
  const first = perimeter[0]!
  const startMidX = (last.x + first.x) * 0.5
  const startMidY = (last.y + first.y) * 0.5

  const parts: string[] = [`M ${fmt(startMidX)} ${fmt(startMidY)}`]
  for (let i = 0; i < count; i += 1) {
    const curr = perimeter[i]!
    const next = perimeter[(i + 1) % count]!
    const midX = (curr.x + next.x) * 0.5
    const midY = (curr.y + next.y) * 0.5
    parts.push(`Q ${fmt(curr.x)} ${fmt(curr.y)} ${fmt(midX)} ${fmt(midY)}`)
  }
  parts.push('Z')
  return parts.join(' ')
}

function sampleDistressCircles(rand: () => number): readonly PluginSealDistressCircle[] {
  const count = 14 + Math.floor(rand() * 9) // 14..22 inclusive
  const circles: PluginSealDistressCircle[] = []
  const maxHalf = FRAME_MAX - CENTER
  const maxCornerDist = maxHalf * Math.SQRT2

  for (let i = 0; i < count; i += 1) {
    let cx = FRAME_MIN
    let cy = FRAME_MIN

    for (let attempt = 0; attempt < 16; attempt += 1) {
      cx = FRAME_MIN - 1 + rand() * (FRAME_MAX - FRAME_MIN + 2)
      cy = FRAME_MIN - 1 + rand() * (FRAME_MAX - FRAME_MIN + 2)
      const radial = Math.min(1, Math.hypot(cx - CENTER, cy - CENTER) / maxCornerDist)
      const edgeProx = Math.min(
        1,
        Math.max(Math.abs(cx - CENTER), Math.abs(cy - CENTER)) / maxHalf,
      )
      const r = Math.max(radial, edgeProx)
      if (rand() < 0.6 + 0.4 * r) {
        break
      }
    }

    const radius = 0.6 + rand() * 1.8 // 0.6..2.4
    circles.push({ cx, cy, r: radius })
  }
  return circles
}

/**
 * Deterministically builds the cached geometric specification of a plugin's carved seal
 * (FNV-1a 32-bit -> mulberry32 in fixed draw order per Appendix D).
 */
export function buildPluginSealSpec(pluginId: string): PluginSealSpec {
  const cached = SPEC_CACHE.get(pluginId)
  if (cached !== undefined) {
    return cached
  }

  const seed = fnv1a32(pluginId)
  const rand = mulberry32(seed)
  const glyphs = extractSealGlyphs(pluginId)

  // Fixed PRNG draw sequence (shared identically across all variants for the same pluginId)
  const isBaiwen = rand() < 0.5
  const frameStrokeWidth = 4 + rand() * 2 // 4..6
  const framePath = buildOrganicFramePath(rand)
  const distressCircles = sampleDistressCircles(rand)

  const cornerIdx = Math.floor(rand() * 4)
  const cornerBase = CORNER_COORDS[cornerIdx]!
  const cornerChip: PluginSealDistressCircle = {
    cx: cornerBase.x + (rand() * 2 - 1) * 2.0,
    cy: cornerBase.y + (rand() * 2 - 1) * 2.0,
    r: 4 + rand() * 3, // 4..7
  }

  // Deterministic crack path for failed state
  const crackStartY = 14 + rand() * 16
  const crackMid1X = 36 + rand() * 10
  const crackMid1Y = 38 + rand() * 10
  const crackMid2X = 52 + rand() * 12
  const crackMid2Y = 54 + rand() * 10
  const crackEndY = 72 + rand() * 14
  const crackPath = `M ${fmt(FRAME_MIN + 2)} ${fmt(crackStartY)} L ${fmt(crackMid1X)} ${fmt(crackMid1Y)} L ${fmt(crackMid2X)} ${fmt(crackMid2Y)} L ${fmt(FRAME_MAX - 2)} ${fmt(crackEndY)}`

  const spec: PluginSealSpec = {
    pluginId,
    viewBoxSize: VIEWBOX_SIZE,
    glyphs,
    style: isBaiwen ? 'baiwen' : 'zhuwen',
    isBaiwen,
    framePath,
    frameStrokeWidth,
    distressCircles,
    cornerChip,
    crackPath,
  }
  SPEC_CACHE.set(pluginId, spec)
  return spec
}

function renderGlyphMarkup(
  glyphs: string,
  fill: string,
  stroke?: string,
  strokeWidth?: string,
): string {
  const fontAttr =
    'font-family="var(--font-display-latin)" font-weight="900" style="font-variation-settings:\'wght\' 900,\'SOFT\' 0,\'WONK\' 1"'
  const paintAttr =
    stroke !== undefined
      ? `fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth ?? '1.6'}" stroke-linejoin="round"`
      : `fill="${fill}"`

  if (glyphs.length === 2) {
    const left = glyphs.charAt(0)
    const right = glyphs.charAt(1)
    return [
      `<text x="32" y="50" font-size="36" text-anchor="middle" dominant-baseline="central" ${fontAttr} ${paintAttr}>${left}</text>`,
      `<text x="64" y="50" font-size="36" text-anchor="middle" dominant-baseline="central" ${fontAttr} ${paintAttr}>${right}</text>`,
    ].join('')
  }

  return `<text x="48" y="50" font-size="48" text-anchor="middle" dominant-baseline="central" ${fontAttr} ${paintAttr}>${glyphs}</text>`
}

/**
 * Deterministically generates a carved square seal SVG string (96x96 viewBox)
 * for a plugin id following Appendix D of the Inktide design spec.
 */
export function generatePluginSealSvg(
  pluginId: string,
  variant: PluginSealVariant = 'auto',
): string {
  const cacheKey = `${variant}\0${pluginId}`
  const cached = SEAL_CACHE.get(cacheKey)
  if (cached !== undefined) {
    return cached
  }

  const spec = buildPluginSealSpec(pluginId)
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${spec.viewBoxSize} ${spec.viewBoxSize}" data-seal-style="${spec.style}" data-seal-variant="${variant}">`,
  ]

  if (variant === 'hollow') {
    parts.push(
      `<path d="${spec.framePath}" fill="none" stroke="var(--zhusha)" stroke-width="${fmt(spec.frameStrokeWidth)}" stroke-linejoin="round"/>`,
    )
    parts.push(renderGlyphMarkup(spec.glyphs, 'none', 'var(--zhusha)', '1.6'))
  } else if (variant === 'pending') {
    parts.push(
      `<path d="${spec.framePath}" fill="none" stroke="var(--tenghuang)" stroke-width="${fmt(spec.frameStrokeWidth)}" stroke-dasharray="6 4" stroke-linejoin="round"/>`,
    )
    parts.push(renderGlyphMarkup(spec.glyphs, 'var(--tenghuang)'))
  } else {
    const frameFill = spec.isBaiwen ? 'var(--zhusha)' : 'var(--plate)'
    const glyphFill = spec.isBaiwen ? 'var(--plate)' : 'var(--zhusha)'

    parts.push(
      `<path d="${spec.framePath}" fill="${frameFill}" stroke="var(--zhusha)" stroke-width="${fmt(spec.frameStrokeWidth)}" stroke-linejoin="round"/>`,
    )
    parts.push(renderGlyphMarkup(spec.glyphs, glyphFill))

    for (const circle of spec.distressCircles) {
      parts.push(
        `<circle cx="${fmt(circle.cx)}" cy="${fmt(circle.cy)}" r="${fmt(circle.r)}" fill="var(--plate)" data-seal-chip="small"/>`,
      )
    }
    parts.push(
      `<circle cx="${fmt(spec.cornerChip.cx)}" cy="${fmt(spec.cornerChip.cy)}" r="${fmt(spec.cornerChip.r)}" fill="var(--plate)" data-seal-chip="corner"/>`,
    )

    if (variant === 'failed') {
      parts.push(
        `<path d="${spec.crackPath}" fill="none" stroke="var(--yanzhi)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" data-seal-crack="true"/>`,
      )
    }
  }

  parts.push('</svg>')
  const svg = parts.join('')
  SEAL_CACHE.set(cacheKey, svg)
  return svg
}
