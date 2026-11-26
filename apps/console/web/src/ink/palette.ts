export type RgbTuple = readonly [number, number, number]
export type RgbaTuple = readonly [number, number, number, number]
export type InkTheme = 'night' | 'paper'

export interface ThemePalette {
  inkVoid: RgbTuple
  smoke: RgbTuple
  zhusha: RgbTuple
  zhushaGlow: RgbaTuple
  tenghuang: RgbTuple
  yanzhi: RgbTuple
  text3: RgbaTuple
}

function rgb(r: number, g: number, b: number): RgbTuple {
  return [r / 255, g / 255, b / 255]
}

function rgba(r: number, g: number, b: number, a: number): RgbaTuple {
  return [r / 255, g / 255, b / 255, a]
}

// Appendix A normalized RGB values for both themes so crossfades always have both endpoints ready.
export const DEFAULT_PALETTES: Readonly<Record<InkTheme, ThemePalette>> = {
  night: {
    inkVoid: rgb(7, 6, 5),
    smoke: rgb(243, 235, 221),
    zhusha: rgb(255, 74, 28),
    zhushaGlow: rgba(255, 74, 28, 0.28),
    tenghuang: rgb(233, 174, 58),
    yanzhi: rgb(210, 51, 92),
    text3: rgba(236, 228, 212, 0.4),
  },
  paper: {
    inkVoid: rgb(233, 226, 211),
    smoke: rgb(20, 16, 9),
    zhusha: rgb(226, 58, 18),
    zhushaGlow: rgba(226, 58, 18, 0.18),
    tenghuang: rgb(185, 122, 14),
    yanzhi: rgb(176, 32, 63),
    text3: rgba(26, 21, 17, 0.44),
  },
}

const HASH_PREFIX = String.fromCharCode(35)

function parseCssColor(raw: string): RgbaTuple | null {
  const s = raw.trim()
  if (!s) return null

  if (s.startsWith(HASH_PREFIX)) {
    const body = s.slice(1)
    if (body.length === 6) {
      const r = Number.parseInt(body.slice(0, 2), 16)
      const g = Number.parseInt(body.slice(2, 4), 16)
      const b = Number.parseInt(body.slice(4, 6), 16)
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
        return [r / 255, g / 255, b / 255, 1]
      }
    } else if (body.length === 3) {
      const r = Number.parseInt(body[0]! + body[0]!, 16)
      const g = Number.parseInt(body[1]! + body[1]!, 16)
      const b = Number.parseInt(body[2]! + body[2]!, 16)
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
        return [r / 255, g / 255, b / 255, 1]
      }
    }
    return null
  }

  const rgbMatch = /^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i.exec(s)
  if (rgbMatch) {
    const r = Number.parseFloat(rgbMatch[1]!)
    const g = Number.parseFloat(rgbMatch[2]!)
    const b = Number.parseFloat(rgbMatch[3]!)
    const a = rgbMatch[4] !== undefined ? Number.parseFloat(rgbMatch[4]) : 1
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) && Number.isFinite(a)) {
      return [r / 255, g / 255, b / 255, Math.min(1, Math.max(0, a))]
    }
  }

  return null
}

function readRgbVar(style: CSSStyleDeclaration, name: string, fallback: RgbTuple): RgbTuple {
  const parsed = parseCssColor(style.getPropertyValue(name))
  return parsed ? [parsed[0], parsed[1], parsed[2]] : fallback
}

function readRgbaVar(style: CSSStyleDeclaration, name: string, fallback: RgbaTuple): RgbaTuple {
  const parsed = parseCssColor(style.getPropertyValue(name))
  return parsed ?? fallback
}

export function readThemePaletteFromDOM(theme: InkTheme): ThemePalette {
  const fallback = DEFAULT_PALETTES[theme]
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return fallback
  }
  const root = document.documentElement
  if (root.getAttribute('data-theme') !== theme) {
    return fallback
  }
  const style = window.getComputedStyle(root)
  return {
    inkVoid: readRgbVar(style, '--ink-void', fallback.inkVoid),
    smoke: readRgbVar(style, '--smoke', fallback.smoke),
    zhusha: readRgbVar(style, '--zhusha', fallback.zhusha),
    zhushaGlow: readRgbaVar(style, '--zhusha-glow', fallback.zhushaGlow),
    tenghuang: readRgbVar(style, '--tenghuang', fallback.tenghuang),
    yanzhi: readRgbVar(style, '--yanzhi', fallback.yanzhi),
    text3: readRgbaVar(style, '--text-3', fallback.text3),
  }
}

export function lerpRgb(a: RgbTuple, b: RgbTuple, t: number): [number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ]
}

export function toCssRgb(c: RgbTuple, alpha?: number): string {
  const r = Math.round(Math.min(1, Math.max(0, c[0])) * 255)
  const g = Math.round(Math.min(1, Math.max(0, c[1])) * 255)
  const b = Math.round(Math.min(1, Math.max(0, c[2])) * 255)
  if (alpha === undefined) {
    return `rgb(${r}, ${g}, ${b})`
  }
  return `rgba(${r}, ${g}, ${b}, ${Math.min(1, Math.max(0, alpha)).toFixed(3)})`
}
