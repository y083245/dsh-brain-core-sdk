import { DUR, EASE, FLOOD_COVER_END_MS, FLOOD_COVER_START_MS, INK } from '../motion/tokens.ts'
import {
  EnsoRenderer,
  type EnsoInstanceSpec,
} from './enso.ts'
import {
  DEFAULT_PALETTES,
  lerpRgb,
  readThemePaletteFromDOM,
  toCssRgb,
  type InkTheme,
  type ThemePalette,
} from './palette.ts'
import {
  createQualityController,
  type QualityController,
  type QualityTier,
} from './quality.ts'

import advectFragSrc from './shaders/advect.frag.glsl?raw'
import clearFragSrc from './shaders/clear.frag.glsl?raw'
import commonGlslSrc from './shaders/common.glsl?raw'
import curlFragSrc from './shaders/curl.frag.glsl?raw'
import diluteFragSrc from './shaders/dilute.frag.glsl?raw'
import displayFragSrc from './shaders/display.frag.glsl?raw'
import divergenceFragSrc from './shaders/divergence.frag.glsl?raw'
import ensoFragSrc from './shaders/enso.frag.glsl?raw'
import floodFragSrc from './shaders/flood.frag.glsl?raw'
import fullscreenVertSrc from './shaders/fullscreen.vert.glsl?raw'
import gradientSubtractFragSrc from './shaders/gradientSubtract.frag.glsl?raw'
import pressureFragSrc from './shaders/pressure.frag.glsl?raw'
import splatFragSrc from './shaders/splat.frag.glsl?raw'
import swirlFragSrc from './shaders/swirl.frag.glsl?raw'
import vorticityFragSrc from './shaders/vorticity.frag.glsl?raw'

export type { EnsoInstanceSpec, EnsoRect, EnsoState } from './enso.ts'
export type { InkTheme } from './palette.ts'
export type { QualityTier } from './quality.ts'

export interface InkEngineStats {
  backend: 'webgl2' | 'static-2d'
  quality: QualityTier
  lockedQuality: QualityTier | null
  calm: boolean
  theme: InkTheme
  reducedMotion: boolean
  floatSupported: boolean
  contextLost: boolean
  avgFrameMs: number | null
  lastFrameMs: number
  gpuFrameMs: number | null
  simResolution: [number, number]
  dyeResolution: [number, number]
  ensoCount: number
}

export type ExternalRenderHook = (
  gl: WebGL2RenderingContext,
  info: { width: number; height: number; dpr: number; timeSec: number; dtSec: number },
) => void

export interface InkEngine {
  /** 在屏幕坐标 (x, y) 滴一滴墨。color: 'smoke' | 'zhusha'。radius 是屏幕像素。 */
  splat(p: {
    x: number
    y: number
    dx?: number
    dy?: number
    radius?: number
    amount?: number
    color?: 'smoke' | 'zhusha'
  }): void
  /** 在 (x, y) 处制造一个持续 durationMs 的漩涡，strength 正为逆时针。她在思考时用。 */
  stir(p: {
    x: number
    y: number
    radius: number
    strength: number
    durationMs: number
  }): () => void
  /** 泼墨：从 (x, y) 涨满全屏，然后自动退去。返回一个在「涨满」那一刻 resolve 的 Promise，换页就在这一刻做。 */
  flood(p: { x: number; y: number; color?: 'smoke' | 'zhusha' }): Promise<void>
  /** 稀释：把 rect 区域里的墨在 durationMs 内淡掉。遗忘时用。 */
  dilute(rect: { x: number; y: number; w: number; h: number }, durationMs: number): void
  /** 静墨档开关：数据密集的视图里打开（5.6）。 */
  setCalm(calm: boolean): void
  /** 用户指针移动，引擎根据速度注入墨和力（由光标组件调用，见 7.2）。 */
  pointer(p: { x: number; y: number; dx: number; dy: number; down: boolean }): void
  setTheme(theme: 'night' | 'paper'): void
  setQuality(q: 'high' | 'medium' | 'low' | 'static'): void
  dispose(): void

  // Enso, auto-quality, motion, shared context & diagnostics
  setEnso(spec: EnsoInstanceSpec): void
  removeEnso(id: string): void
  pulseEnso(id?: string): void
  setAutoQuality(): void
  setReducedMotion(reduced: boolean): void
  getStats(): InkEngineStats
  getGLContext(): WebGL2RenderingContext | null
  setExternalRenderHook(hook: ExternalRenderHook | null): void
  resetState(): void
  simulateContextLoss?(): void
}

interface TextureFormatSpec {
  internalFormat: number
  format: number
  type: number
}

interface FboTarget {
  texture: WebGLTexture
  fbo: WebGLFramebuffer
  width: number
  height: number
  texelSizeX: number
  texelSizeY: number
}

interface DoubleFbo {
  width: number
  height: number
  texelSizeX: number
  texelSizeY: number
  read: FboTarget
  write: FboTarget
  swap(): void
}

interface CompiledProgram {
  program: WebGLProgram
  uniforms: Record<string, WebGLUniformLocation | null>
}

interface QueuedSplat {
  x: number
  y: number
  dx: number
  dy: number
  radius: number
  amount: number
  color: 'smoke' | 'zhusha'
  dyeOnly?: boolean
  velocityOnly?: boolean
}

interface ActiveStir {
  id: number
  x: number
  y: number
  radius: number
  strength: number
  durationMs: number
  startMs: number
  stoppingAtMs: number | null
}

interface ActiveDilute {
  rect: { x: number; y: number; w: number; h: number }
  startMs: number
  durationMs: number
}

interface ActiveFlood {
  x: number
  y: number
  color: 'smoke' | 'zhusha'
  startMs: number
  floodMs: number
  ebbMs: number
  resolved: boolean
  resolve: () => void
  fallbackTimer: ReturnType<typeof setTimeout> | null
}

interface PointerSample {
  x: number
  y: number
  dx: number
  dy: number
  down: boolean
}

interface DisjointTimerQueryExt {
  readonly TIME_ELAPSED_EXT: number
  readonly GPU_DISJOINT_EXT: number
}

const THEME_TRANSITION_MS = 600
const STIR_FADE_OUT_MS = 400
const REDUCED_FLOOD_MS = 150
const MAX_DPR = 2
const PAPER_FIBER_URL = '/synapse/textures/paper-fiber.png'

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

function evalCubicBezier(t: number, p1x: number, p1y: number, p2x: number, p2y: number): number {
  const x = clamp(t, 0, 1)
  // Solve x(u) = x via 5 Newton-Raphson iterations
  let u = x
  for (let i = 0; i < 5; i += 1) {
    const inv = 1 - u
    const bx = 3 * inv * inv * u * p1x + 3 * inv * u * u * p2x + u * u * u
    const dbx = 3 * inv * inv * p1x + 6 * inv * u * (p2x - p1x) + 3 * u * u * (1 - p2x)
    if (Math.abs(dbx) < 1e-6) break
    u = clamp(u - (bx - x) / dbx, 0, 1)
  }
  const inv = 1 - u
  return 3 * inv * inv * u * p1y + 3 * inv * u * u * p2y + u * u * u
}

function easeInkOut(t: number): number {
  return evalCubicBezier(t, EASE.inkOut[0], EASE.inkOut[1], EASE.inkOut[2], EASE.inkOut[3])
}

function computeScaledResolution(baseMax: number, canvasW: number, canvasH: number): [number, number] {
  const safeW = Math.max(1, canvasW)
  const safeH = Math.max(1, canvasH)
  if (safeW >= safeH) {
    const h = Math.max(16, Math.round((baseMax * safeH) / safeW))
    return [Math.max(16, Math.round(baseMax)), h]
  }
  const w = Math.max(16, Math.round((baseMax * safeW) / safeH))
  return [w, Math.max(16, Math.round(baseMax))]
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) {
    throw new Error('Failed to allocate WebGL2 shader')
  }
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? 'unknown shader error'
    gl.deleteShader(shader)
    throw new Error(`WebGL2 shader compile failed: ${log}`)
  }
  return shader
}

function createProgram(
  gl: WebGL2RenderingContext,
  vertShader: WebGLShader,
  fragBody: string,
  uniformNames: readonly string[],
): CompiledProgram {
  const fullFrag = `#version 300 es\n${commonGlslSrc}\n${fragBody}`
  const fragShader = compileShader(gl, gl.FRAGMENT_SHADER, fullFrag)
  const program = gl.createProgram()
  if (!program) {
    gl.deleteShader(fragShader)
    throw new Error('Failed to allocate WebGL2 program')
  }
  gl.attachShader(program, vertShader)
  gl.attachShader(program, fragShader)
  gl.linkProgram(program)
  gl.deleteShader(fragShader)

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? 'unknown link error'
    gl.deleteProgram(program)
    throw new Error(`WebGL2 program link failed: ${log}`)
  }

  const uniforms: Record<string, WebGLUniformLocation | null> = {}
  for (const name of uniformNames) {
    uniforms[name] = gl.getUniformLocation(program, name)
  }
  return { program, uniforms }
}

function probeRenderableFormat(
  gl: WebGL2RenderingContext,
  spec: TextureFormatSpec,
): boolean {
  const tex = gl.createTexture()
  const fbo = gl.createFramebuffer()
  if (!tex || !fbo) {
    if (tex) gl.deleteTexture(tex)
    if (fbo) gl.deleteFramebuffer(fbo)
    return false
  }
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texImage2D(gl.TEXTURE_2D, 0, spec.internalFormat, 4, 4, 0, spec.format, spec.type, null)

  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)

  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.bindTexture(gl.TEXTURE_2D, null)
  gl.deleteFramebuffer(fbo)
  gl.deleteTexture(tex)
  return status === gl.FRAMEBUFFER_COMPLETE
}

function createFbo(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  spec: TextureFormatSpec,
  filter: number,
): FboTarget {
  const texture = gl.createTexture()
  const fbo = gl.createFramebuffer()
  if (!texture || !fbo) {
    throw new Error('Failed to create WebGL2 FBO')
  }
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texImage2D(gl.TEXTURE_2D, 0, spec.internalFormat, width, height, 0, spec.format, spec.type, null)

  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
  gl.viewport(0, 0, width, height)
  gl.clearColor(0, 0, 0, 1)
  gl.clear(gl.COLOR_BUFFER_BIT)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)

  return {
    texture,
    fbo,
    width,
    height,
    texelSizeX: 1 / width,
    texelSizeY: 1 / height,
  }
}

function createDoubleFbo(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  spec: TextureFormatSpec,
  filter: number,
): DoubleFbo {
  let fboA = createFbo(gl, width, height, spec, filter)
  let fboB = createFbo(gl, width, height, spec, filter)
  return {
    width,
    height,
    texelSizeX: 1 / width,
    texelSizeY: 1 / height,
    get read() {
      return fboA
    },
    set read(v: FboTarget) {
      fboA = v
    },
    get write() {
      return fboB
    },
    set write(v: FboTarget) {
      fboB = v
    },
    swap() {
      const tmp = fboA
      fboA = fboB
      fboB = tmp
    },
  }
}

function destroyFbo(gl: WebGL2RenderingContext, target: FboTarget | null): void {
  if (!target) return
  gl.deleteFramebuffer(target.fbo)
  gl.deleteTexture(target.texture)
}

function destroyDoubleFbo(gl: WebGL2RenderingContext, target: DoubleFbo | null): void {
  if (!target) return
  destroyFbo(gl, target.read)
  destroyFbo(gl, target.write)
}

function createFallbackPaperFiberBytes(size: number): Uint8Array {
  const data = new Uint8Array(size * size * 4)
  let seed = 0x1a2b3c
  for (let i = 0; i < size * size; i += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const v = 195 + ((seed >>> 24) & 0x3f)
    const idx = i * 4
    data[idx] = v
    data[idx + 1] = v
    data[idx + 2] = v
    data[idx + 3] = 255
  }
  return data
}

function createStatic2DFallback(canvas: HTMLCanvasElement): InkEngine {
  const ctx2d = canvas.getContext('2d')
  let theme: InkTheme = 'night'
  let calm = false
  let reducedMotion = false
  let disposed = false
  const ensoIds = new Set<string>()
  const activeTimers = new Set<ReturnType<typeof setTimeout>>()

  function drawStaticWash(): void {
    if (disposed || !ctx2d) return
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1)
    const cssW = Math.max(1, canvas.clientWidth || window.innerWidth || 1)
    const cssH = Math.max(1, canvas.clientHeight || window.innerHeight || 1)
    const targetW = Math.max(1, Math.round(cssW * dpr))
    const targetH = Math.max(1, Math.round(cssH * dpr))
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW
      canvas.height = targetH
    }
    const palette = readThemePaletteFromDOM(theme)
    ctx2d.fillStyle = toCssRgb(palette.inkVoid)
    ctx2d.fillRect(0, 0, targetW, targetH)

    // Soft static ink wash radial glow matching the chosen theme
    const cx = targetW * 0.52
    const cy = targetH * 0.44
    const r = Math.hypot(targetW, targetH) * 0.48
    const grad = ctx2d.createRadialGradient(cx, cy, r * 0.05, cx, cy, r)
    const peakAlpha = theme === 'night' ? 0.14 : 0.1
    grad.addColorStop(0, toCssRgb(palette.smoke, peakAlpha))
    grad.addColorStop(0.55, toCssRgb(palette.smoke, peakAlpha * 0.35))
    grad.addColorStop(1, toCssRgb(palette.inkVoid, 0))
    ctx2d.fillStyle = grad
    ctx2d.fillRect(0, 0, targetW, targetH)
  }

  const onResize = () => drawStaticWash()
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', onResize)
  }
  drawStaticWash()

  return {
    splat() {},
    stir() {
      return () => {}
    },
    flood() {
      return new Promise<void>((resolve) => {
        const delayMs = reducedMotion ? REDUCED_FLOOD_MS : Math.round(DUR.flood * 1000)
        const timer = setTimeout(() => {
          activeTimers.delete(timer)
          resolve()
        }, delayMs)
        activeTimers.add(timer)
      })
    },
    dilute() {},
    setCalm(next) {
      calm = next
    },
    pointer() {},
    setTheme(next) {
      theme = next
      drawStaticWash()
    },
    setQuality() {},
    setAutoQuality() {},
    setReducedMotion(next) {
      reducedMotion = next
    },
    setEnso(spec) {
      ensoIds.add(spec.id)
    },
    removeEnso(id) {
      ensoIds.delete(id)
    },
    pulseEnso() {},
    getStats(): InkEngineStats {
      return {
        backend: 'static-2d',
        quality: 'static',
        lockedQuality: 'static',
        calm,
        theme,
        reducedMotion,
        floatSupported: false,
        contextLost: false,
        avgFrameMs: null,
        lastFrameMs: 0,
        gpuFrameMs: null,
        simResolution: [0, 0],
        dyeResolution: [0, 0],
        ensoCount: ensoIds.size,
      }
    },
    getGLContext() {
      return null
    },
    setExternalRenderHook() {},
    resetState() {},
    dispose() {
      disposed = true
      for (const timer of activeTimers) {
        clearTimeout(timer)
      }
      activeTimers.clear()
      if (typeof window !== 'undefined') {
        window.removeEventListener('resize', onResize)
      }
    },
  }
}

export function createInkEngine(canvas: HTMLCanvasElement): InkEngine {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    depth: true,
    stencil: false,
    antialias: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  })

  if (!gl) {
    return createStatic2DFallback(canvas)
  }

  let disposed = false
  let contextLost = false
  let calm = false
  let reducedMotion = false
  let theme: InkTheme = 'night'
  let themeMix = 0
  let themeFromMix = 0
  let themeTargetMix = 0
  let themeTransitionStartMs = 0
  let themeTransitioning = false
  let palettes: Record<InkTheme, ThemePalette> = {
    night: { ...DEFAULT_PALETTES.night },
    paper: { ...DEFAULT_PALETTES.paper },
  }

  let floatSupported = false
  let velocitySpec: TextureFormatSpec = {
    internalFormat: gl.RGBA8,
    format: gl.RGBA,
    type: gl.UNSIGNED_BYTE,
  }
  let scalarSpec: TextureFormatSpec = {
    internalFormat: gl.RGBA8,
    format: gl.RGBA,
    type: gl.UNSIGNED_BYTE,
  }
  let dyeSpec: TextureFormatSpec = {
    internalFormat: gl.RGBA8,
    format: gl.RGBA,
    type: gl.UNSIGNED_BYTE,
  }

  let qualityController: QualityController = createQualityController({
    initialCeiling: 'high',
    floatSupported: true,
  })
  let allocatedSimBase = 0
  let allocatedDyeBase = 0
  let allocatedCanvasW = 0
  let allocatedCanvasH = 0

  let vao: WebGLVertexArrayObject | null = null
  let paperFiberTexture: WebGLTexture | null = null
  let loadedPaperImage: HTMLImageElement | null = null

  let velocityFbo: DoubleFbo | null = null
  let dyeFbo: DoubleFbo | null = null
  let pressureFbo: DoubleFbo | null = null
  let divergenceFbo: FboTarget | null = null
  let curlFbo: FboTarget | null = null
  let sceneFbo: FboTarget | null = null

  let splatProg: CompiledProgram | null = null
  let curlProg: CompiledProgram | null = null
  let vorticityProg: CompiledProgram | null = null
  let divergenceProg: CompiledProgram | null = null
  let clearProg: CompiledProgram | null = null
  let pressureProg: CompiledProgram | null = null
  let gradientSubtractProg: CompiledProgram | null = null
  let advectProg: CompiledProgram | null = null
  let diluteProg: CompiledProgram | null = null
  let swirlProg: CompiledProgram | null = null
  let displayProg: CompiledProgram | null = null
  let floodProg: CompiledProgram | null = null
  let ensoProg: CompiledProgram | null = null

  const ensoRenderer = new EnsoRenderer()
  let externalRenderHook: ExternalRenderHook | null = null

  const queuedSplats: QueuedSplat[] = []
  const activeStirs = new Map<number, ActiveStir>()
  const activeDilutes: ActiveDilute[] = []
  let activeFlood: ActiveFlood | null = null
  let pendingPointer: PointerSample | null = null

  let nextStirId = 1
  let splatSeedCounter = 1
  let rafId: number | null = null
  let lastFrameNowMs = 0
  let lastFrameMs = 0
  let elapsedSec = 0
  let lastUserInputMs = performance.now()
  let lastIdleWispMs = performance.now()
  let staticSeeded = false

  // Optional EXT_disjoint_timer_query_webgl2 (never stalls the pipeline)
  let timerExt: DisjointTimerQueryExt | null = null
  const pendingGpuQueries: WebGLQuery[] = []
  let gpuFrameMs: number | null = null

  function effectiveTier(): QualityTier {
    if (reducedMotion || contextLost) {
      return 'static'
    }
    return qualityController.getTier()
  }

  function refreshCanvasSize(): { width: number; height: number; cssW: number; cssH: number; dpr: number } {
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1)
    const cssW = Math.max(1, canvas.clientWidth || window.innerWidth || 1)
    const cssH = Math.max(1, canvas.clientHeight || window.innerHeight || 1)
    const width = Math.max(1, Math.round(cssW * dpr))
    const height = Math.max(1, Math.round(cssH * dpr))
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    return { width, height, cssW, cssH, dpr }
  }

  function detectFormats(): void {
    const hasColorBufferFloat = Boolean(gl!.getExtension('EXT_color_buffer_float'))
    const hasColorBufferHalfFloat = Boolean(gl!.getExtension('EXT_color_buffer_half_float'))
    gl!.getExtension('OES_texture_float_linear')

    const rg16f: TextureFormatSpec = {
      internalFormat: gl!.RG16F,
      format: gl!.RG,
      type: gl!.HALF_FLOAT,
    }
    const r16f: TextureFormatSpec = {
      internalFormat: gl!.R16F,
      format: gl!.RED,
      type: gl!.HALF_FLOAT,
    }
    const rgba16f: TextureFormatSpec = {
      internalFormat: gl!.RGBA16F,
      format: gl!.RGBA,
      type: gl!.HALF_FLOAT,
    }

    const canUseHalfFloat =
      (hasColorBufferFloat || hasColorBufferHalfFloat)
      && probeRenderableFormat(gl!, rg16f)
      && probeRenderableFormat(gl!, r16f)
      && probeRenderableFormat(gl!, rgba16f)

    floatSupported = canUseHalfFloat
    if (canUseHalfFloat) {
      velocitySpec = rg16f
      scalarSpec = r16f
      dyeSpec = rgba16f
    } else {
      const rgba8: TextureFormatSpec = {
        internalFormat: gl!.RGBA8,
        format: gl!.RGBA,
        type: gl!.UNSIGNED_BYTE,
      }
      velocitySpec = rgba8
      scalarSpec = rgba8
      dyeSpec = rgba8
    }

    const prevLock = qualityController.getLockedQuality()
    const narrowCeiling: QualityTier =
      typeof window !== 'undefined' && window.innerWidth > 0 && window.innerWidth < 1024
        ? 'low'
        : 'high'
    qualityController = createQualityController({
      initialCeiling: narrowCeiling,
      floatSupported,
    })
    if (prevLock !== null) {
      qualityController.setLockedQuality(prevLock)
    }
  }

  function buildPaperFiberTexture(): void {
    const tex = gl!.createTexture()
    if (!tex) return
    paperFiberTexture = tex
    gl!.bindTexture(gl!.TEXTURE_2D, tex)
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR)
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR)
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.REPEAT)
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.REPEAT)

    if (loadedPaperImage && loadedPaperImage.complete && loadedPaperImage.naturalWidth > 0) {
      gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, gl!.RGBA, gl!.UNSIGNED_BYTE, loadedPaperImage)
    } else {
      const fallback = createFallbackPaperFiberBytes(64)
      gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, 64, 64, 0, gl!.RGBA, gl!.UNSIGNED_BYTE, fallback)
    }
    gl!.bindTexture(gl!.TEXTURE_2D, null)
  }

  function loadPaperFiberImage(): void {
    if (typeof Image === 'undefined') return
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => {
      loadedPaperImage = img
      if (disposed || contextLost || !paperFiberTexture) return
      gl!.bindTexture(gl!.TEXTURE_2D, paperFiberTexture)
      gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, gl!.RGBA, gl!.UNSIGNED_BYTE, img)
      gl!.bindTexture(gl!.TEXTURE_2D, null)
    }
    img.src = PAPER_FIBER_URL
  }

  function buildPrograms(): void {
    const vertShader = compileShader(gl!, gl!.VERTEX_SHADER, `#version 300 es\n${fullscreenVertSrc}`)
    try {
      splatProg = createProgram(gl!, vertShader, splatFragSrc, [
        'uTarget',
        'uPoint',
        'uValue',
        'uRadius',
        'uAspect',
        'uSeed',
      ])
      curlProg = createProgram(gl!, vertShader, curlFragSrc, ['uVelocity', 'uTexelSize'])
      vorticityProg = createProgram(gl!, vertShader, vorticityFragSrc, [
        'uVelocity',
        'uCurl',
        'uTexelSize',
        'uCurlStrength',
        'uDt',
      ])
      divergenceProg = createProgram(gl!, vertShader, divergenceFragSrc, ['uVelocity', 'uTexelSize'])
      clearProg = createProgram(gl!, vertShader, clearFragSrc, ['uTexture', 'uValue'])
      pressureProg = createProgram(gl!, vertShader, pressureFragSrc, [
        'uPressure',
        'uDivergence',
        'uTexelSize',
      ])
      gradientSubtractProg = createProgram(gl!, vertShader, gradientSubtractFragSrc, [
        'uPressure',
        'uVelocity',
        'uTexelSize',
      ])
      advectProg = createProgram(gl!, vertShader, advectFragSrc, [
        'uVelocity',
        'uSource',
        'uTexelSize',
        'uDt',
        'uDissipation',
      ])
      diluteProg = createProgram(gl!, vertShader, diluteFragSrc, [
        'uTarget',
        'uRect',
        'uFactor',
        'uMark',
      ])
      swirlProg = createProgram(gl!, vertShader, swirlFragSrc, [
        'uTarget',
        'uPoint',
        'uRadius',
        'uStrength',
        'uAspect',
        'uDt',
      ])
      displayProg = createProgram(gl!, vertShader, displayFragSrc, [
        'uDye',
        'uPaperFiber',
        'uResolution',
        'uTime',
        'uThemeMix',
        'uNightVoid',
        'uNightSmoke',
        'uNightZhusha',
        'uPaperVoid',
        'uPaperSmoke',
        'uPaperZhusha',
      ])
      floodProg = createProgram(gl!, vertShader, floodFragSrc, [
        'uOrigin',
        'uProgress',
        'uAspect',
        'uColor',
        'uScene',
        'uCoverBoost',
      ])
      ensoProg = createProgram(gl!, vertShader, ensoFragSrc, [])
      ensoRenderer.attachProgram(gl!, ensoProg.program)
    } finally {
      gl!.deleteShader(vertShader)
    }
  }

  function destroySimulationFbos(): void {
    destroyDoubleFbo(gl!, velocityFbo)
    destroyDoubleFbo(gl!, dyeFbo)
    destroyDoubleFbo(gl!, pressureFbo)
    destroyFbo(gl!, divergenceFbo)
    destroyFbo(gl!, curlFbo)
    velocityFbo = null
    dyeFbo = null
    pressureFbo = null
    divergenceFbo = null
    curlFbo = null
    allocatedSimBase = 0
    allocatedDyeBase = 0
  }

  function destroySceneFbo(): void {
    destroyFbo(gl!, sceneFbo)
    sceneFbo = null
    allocatedCanvasW = 0
    allocatedCanvasH = 0
  }

  function ensureSimulationFbos(simBase: number, dyeBase: number, canvasW: number, canvasH: number): void {
    const safeSimBase = Math.max(64, simBase || 96)
    const safeDyeBase = Math.max(256, dyeBase || 512)
    const [simW, simH] = computeScaledResolution(safeSimBase, canvasW, canvasH)
    const [dyeW, dyeH] = computeScaledResolution(safeDyeBase, canvasW, canvasH)

    if (
      velocityFbo
      && dyeFbo
      && allocatedSimBase === safeSimBase
      && allocatedDyeBase === safeDyeBase
      && velocityFbo.width === simW
      && velocityFbo.height === simH
      && dyeFbo.width === dyeW
      && dyeFbo.height === dyeH
    ) {
      return
    }

    destroySimulationFbos()
    velocityFbo = createDoubleFbo(gl!, simW, simH, velocitySpec, gl!.LINEAR)
    dyeFbo = createDoubleFbo(gl!, dyeW, dyeH, dyeSpec, gl!.LINEAR)
    pressureFbo = createDoubleFbo(gl!, simW, simH, scalarSpec, gl!.NEAREST)
    divergenceFbo = createFbo(gl!, simW, simH, scalarSpec, gl!.NEAREST)
    curlFbo = createFbo(gl!, simW, simH, scalarSpec, gl!.NEAREST)
    allocatedSimBase = safeSimBase
    allocatedDyeBase = safeDyeBase
    staticSeeded = false
  }

  function ensureSceneFbo(canvasW: number, canvasH: number): FboTarget {
    if (sceneFbo && allocatedCanvasW === canvasW && allocatedCanvasH === canvasH) {
      return sceneFbo
    }
    destroySceneFbo()
    sceneFbo = createFbo(
      gl!,
      canvasW,
      canvasH,
      { internalFormat: gl!.RGBA8, format: gl!.RGBA, type: gl!.UNSIGNED_BYTE },
      gl!.LINEAR,
    )
    allocatedCanvasW = canvasW
    allocatedCanvasH = canvasH
    return sceneFbo
  }

  function resetState(): void {
    if (contextLost || disposed) return
    gl!.bindVertexArray(vao)
    gl!.disable(gl!.DEPTH_TEST)
    gl!.disable(gl!.CULL_FACE)
    gl!.disable(gl!.SCISSOR_TEST)
    gl!.disable(gl!.BLEND)
    gl!.colorMask(true, true, true, true)
    gl!.activeTexture(gl!.TEXTURE0)
  }

  function blit(target: FboTarget | null, width: number, height: number): void {
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, target ? target.fbo : null)
    gl!.viewport(0, 0, target ? target.width : width, target ? target.height : height)
    gl!.drawArrays(gl!.TRIANGLES, 0, 3)
  }

  function bindTextureUnit(unit: number, tex: WebGLTexture): void {
    gl!.activeTexture(gl!.TEXTURE0 + unit)
    gl!.bindTexture(gl!.TEXTURE_2D, tex)
  }

  function applySplat(
    s: QueuedSplat,
    cssW: number,
    cssH: number,
    aspect: number,
  ): void {
    if (!splatProg || !velocityFbo || !dyeFbo) return

    const uvX = clamp(s.x / Math.max(1, cssW), -0.2, 1.2)
    const uvY = clamp(1 - s.y / Math.max(1, cssH), -0.2, 1.2)
    const normRadius = Math.max(0.004, s.radius / Math.max(1, cssH))

    gl!.useProgram(splatProg.program)
    gl!.uniform2f(splatProg.uniforms.uPoint!, uvX, uvY)
    gl!.uniform1f(splatProg.uniforms.uAspect!, aspect)

    if (!s.dyeOnly && (Math.abs(s.dx) > 1e-4 || Math.abs(s.dy) > 1e-4)) {
      const seed = (splatSeedCounter += 0.37) % 1000
      const velScale = 6.0 / Math.max(1, cssH)
      const vx = clamp(s.dx * velScale * velocityFbo.width, -450, 450)
      const vy = clamp(-s.dy * velScale * velocityFbo.height, -450, 450)
      bindTextureUnit(0, velocityFbo.read.texture)
      gl!.uniform1i(splatProg.uniforms.uTarget!, 0)
      gl!.uniform3f(splatProg.uniforms.uValue!, vx, vy, 0)
      gl!.uniform1f(splatProg.uniforms.uRadius!, normRadius * 1.15)
      gl!.uniform1f(splatProg.uniforms.uSeed!, seed)
      blit(velocityFbo.write, velocityFbo.width, velocityFbo.height)
      velocityFbo.swap()
    }

    if (!s.velocityOnly && s.amount > 1e-4) {
      const seed = (splatSeedCounter += 0.73) % 1000
      const smokeVal = s.color === 'smoke' ? s.amount : 0
      const zhushaVal = s.color === 'zhusha' ? s.amount : 0
      bindTextureUnit(0, dyeFbo.read.texture)
      gl!.uniform1i(splatProg.uniforms.uTarget!, 0)
      gl!.uniform3f(splatProg.uniforms.uValue!, smokeVal, zhushaVal, 0)
      gl!.uniform1f(splatProg.uniforms.uRadius!, normRadius)
      gl!.uniform1f(splatProg.uniforms.uSeed!, seed)
      blit(dyeFbo.write, dyeFbo.width, dyeFbo.height)
      dyeFbo.swap()
    }
  }

  function seedStaticWash(cssW: number, cssH: number, aspect: number): void {
    if (!dyeFbo || !velocityFbo || !splatProg) return
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, dyeFbo.read.fbo)
    gl!.viewport(0, 0, dyeFbo.width, dyeFbo.height)
    gl!.clearColor(0, 0, 0, 1)
    gl!.clear(gl!.COLOR_BUFFER_BIT)
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, null)

    applySplat(
      {
        x: cssW * 0.54,
        y: cssH * 0.42,
        dx: 0,
        dy: 0,
        radius: Math.min(cssW, cssH) * 0.34,
        amount: 0.22,
        color: 'smoke',
        dyeOnly: true,
      },
      cssW,
      cssH,
      aspect,
    )
    applySplat(
      {
        x: cssW * 0.34,
        y: cssH * 0.62,
        dx: 0,
        dy: 0,
        radius: Math.min(cssW, cssH) * 0.22,
        amount: 0.14,
        color: 'smoke',
        dyeOnly: true,
      },
      cssW,
      cssH,
      aspect,
    )
    staticSeeded = true
  }

  function seedAmbientInk(cssW: number, cssH: number): void {
    // Two gentle opening smoke wisps so frame 1 has subtle living ink motion
    queuedSplats.push({
      x: cssW * 0.25,
      y: cssH * 0.35,
      dx: 38,
      dy: 12,
      radius: Math.min(cssW, cssH) * 0.18,
      amount: 0.22,
      color: 'smoke',
    })
    queuedSplats.push({
      x: cssW * 0.72,
      y: cssH * 0.64,
      dx: -34,
      dy: -16,
      radius: Math.min(cssW, cssH) * 0.16,
      amount: 0.18,
      color: 'smoke',
    })
  }

  function pollGpuTimerQueries(): void {
    if (!timerExt || pendingGpuQueries.length === 0) return
    const disjoint = Boolean(gl!.getParameter(timerExt.GPU_DISJOINT_EXT))
    while (pendingGpuQueries.length > 0) {
      const oldest = pendingGpuQueries[0]!
      const available = Boolean(gl!.getQueryParameter(oldest, gl!.QUERY_RESULT_AVAILABLE))
      if (!available) {
        break
      }
      pendingGpuQueries.shift()
      if (!disjoint) {
        const ns = Number(gl!.getQueryParameter(oldest, gl!.QUERY_RESULT))
        if (Number.isFinite(ns) && ns >= 0) {
          gpuFrameMs = ns / 1_000_000
        }
      }
      gl!.deleteQuery(oldest)
    }
  }

  function refreshPalettes(): void {
    palettes = {
      night: readThemePaletteFromDOM('night'),
      paper: readThemePaletteFromDOM('paper'),
    }
  }

  function initWebGLResources(): void {
    refreshPalettes()
    detectFormats()
    vao = gl!.createVertexArray()
    buildPaperFiberTexture()
    buildPrograms()
    timerExt = gl!.getExtension('EXT_disjoint_timer_query_webgl2') as DisjointTimerQueryExt | null

    const { width, height, cssW, cssH } = refreshCanvasSize()
    const params = qualityController.getParams(calm)
    ensureSimulationFbos(params.sim || 96, params.dye || 512, width, height)
    seedAmbientInk(cssW, cssH)
    resetState()
  }

  function renderDisplayPass(
    target: FboTarget | null,
    canvasW: number,
    canvasH: number,
  ): void {
    if (!displayProg || !dyeFbo || !paperFiberTexture) return
    gl!.useProgram(displayProg.program)
    bindTextureUnit(0, dyeFbo.read.texture)
    gl!.uniform1i(displayProg.uniforms.uDye!, 0)
    bindTextureUnit(1, paperFiberTexture)
    gl!.uniform1i(displayProg.uniforms.uPaperFiber!, 1)
    gl!.uniform2f(displayProg.uniforms.uResolution!, canvasW, canvasH)
    gl!.uniform1f(displayProg.uniforms.uTime!, elapsedSec)
    gl!.uniform1f(displayProg.uniforms.uThemeMix!, themeMix)

    gl!.uniform3fv(displayProg.uniforms.uNightVoid!, palettes.night.inkVoid)
    gl!.uniform3fv(displayProg.uniforms.uNightSmoke!, palettes.night.smoke)
    gl!.uniform3fv(displayProg.uniforms.uNightZhusha!, palettes.night.zhusha)
    gl!.uniform3fv(displayProg.uniforms.uPaperVoid!, palettes.paper.inkVoid)
    gl!.uniform3fv(displayProg.uniforms.uPaperSmoke!, palettes.paper.smoke)
    gl!.uniform3fv(displayProg.uniforms.uPaperZhusha!, palettes.paper.zhusha)

    blit(target, canvasW, canvasH)
  }

  function renderFloodOverlay(
    flood: ActiveFlood,
    nowMs: number,
    scene: FboTarget,
    canvasW: number,
    canvasH: number,
    cssW: number,
    cssH: number,
    aspect: number,
  ): void {
    if (!floodProg) return
    const elapsed = Math.max(0, nowMs - flood.startMs)
    let progress: number
    let coverBoost = 0

    if (elapsed <= flood.floodMs) {
      const t = flood.floodMs > 0 ? elapsed / flood.floodMs : 1
      progress = easeInkOut(t)
      if (elapsed >= FLOOD_COVER_START_MS && flood.floodMs > FLOOD_COVER_START_MS) {
        coverBoost = clamp((elapsed - FLOOD_COVER_START_MS) / (flood.floodMs - FLOOD_COVER_START_MS), 0, 1)
      }
    } else {
      const ebbElapsed = elapsed - flood.floodMs
      const t = flood.ebbMs > 0 ? clamp(ebbElapsed / flood.ebbMs, 0, 1) : 1
      progress = 1 - t
      const coverEndElapsed = Math.max(flood.floodMs + 1, FLOOD_COVER_END_MS)
      if (elapsed < coverEndElapsed) {
        coverBoost = clamp(1 - (elapsed - flood.floodMs) / (coverEndElapsed - flood.floodMs), 0, 1)
      }
    }

    const uvX = clamp(flood.x / Math.max(1, cssW), 0, 1)
    const uvY = clamp(1 - flood.y / Math.max(1, cssH), 0, 1)

    // Appendix C.3: night smoke flood is 0.9x --smoke brightness, paper is --smoke; zhusha uses --zhusha
    const nightFloodCol: readonly [number, number, number] =
      flood.color === 'zhusha'
        ? palettes.night.zhusha
        : [
            palettes.night.smoke[0] * 0.9,
            palettes.night.smoke[1] * 0.9,
            palettes.night.smoke[2] * 0.9,
          ]
    const paperFloodCol =
      flood.color === 'zhusha' ? palettes.paper.zhusha : palettes.paper.smoke
    const floodColor = lerpRgb(nightFloodCol, paperFloodCol, themeMix)

    gl!.useProgram(floodProg.program)
    bindTextureUnit(0, scene.texture)
    gl!.uniform1i(floodProg.uniforms.uScene!, 0)
    gl!.uniform2f(floodProg.uniforms.uOrigin!, uvX, uvY)
    gl!.uniform1f(floodProg.uniforms.uProgress!, progress)
    gl!.uniform1f(floodProg.uniforms.uAspect!, aspect)
    gl!.uniform3fv(floodProg.uniforms.uColor!, floodColor)
    gl!.uniform1f(floodProg.uniforms.uCoverBoost!, coverBoost)

    blit(null, canvasW, canvasH)
  }

  function stepFrame(nowMs: number): void {
    if (disposed || contextLost) return
    rafId = window.requestAnimationFrame(stepFrame)

    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return
    }

    const rawFrameMs = lastFrameNowMs > 0 ? nowMs - lastFrameNowMs : 16.67
    lastFrameNowMs = nowMs
    lastFrameMs = clamp(rawFrameMs, 0, 200)
    const dtSec = clamp(rawFrameMs / 1000, 1 / 240, 0.05)
    elapsedSec += dtSec

    // Smooth 600ms theme crossfade
    if (themeTransitioning) {
      if (reducedMotion) {
        themeMix = themeTargetMix
        themeTransitioning = false
      } else {
        const t = clamp((nowMs - themeTransitionStartMs) / THEME_TRANSITION_MS, 0, 1)
        themeMix = themeFromMix + (themeTargetMix - themeFromMix) * easeInkOut(t)
        if (t >= 1) {
          themeMix = themeTargetMix
          themeTransitioning = false
        }
      }
    }

    // Update quality state machine when running live fluid
    if (!reducedMotion) {
      qualityController.recordFrame(lastFrameMs, nowMs)
    }

    const { width, height, cssW, cssH, dpr } = refreshCanvasSize()
    const aspect = cssW / Math.max(1, cssH)
    const tier = effectiveTier()
    const params = qualityController.getParams(calm)

    // Advance flood promise lifecycle
    if (activeFlood) {
      const floodElapsed = nowMs - activeFlood.startMs
      if (!activeFlood.resolved && floodElapsed >= activeFlood.floodMs) {
        activeFlood.resolved = true
        if (activeFlood.fallbackTimer !== null) {
          clearTimeout(activeFlood.fallbackTimer)
          activeFlood.fallbackTimer = null
        }
        activeFlood.resolve()
      }
      if (floodElapsed >= activeFlood.floodMs + activeFlood.ebbMs) {
        activeFlood = null
      }
    }

    // Update Enso state interpolation & animation
    ensoRenderer.update(dtSec, reducedMotion)

    // Poll previous GPU timer queries without stalling
    pollGpuTimerQueries()

    // Begin GPU timer query if supported and ring buffer has room
    let frameQuery: WebGLQuery | null = null
    if (timerExt && pendingGpuQueries.length < 4) {
      frameQuery = gl!.createQuery()
      if (frameQuery) {
        gl!.beginQuery(timerExt.TIME_ELAPSED_EXT, frameQuery)
      }
    }

    resetState()

    if (tier === 'static') {
      ensureSimulationFbos(96, 512, width, height)
      if (!staticSeeded) {
        seedStaticWash(cssW, cssH, aspect)
      }
      queuedSplats.length = 0
      pendingPointer = null

      if (activeFlood && !reducedMotion) {
        const scene = ensureSceneFbo(width, height)
        renderDisplayPass(scene, width, height)
        ensoRenderer.render(
          gl!,
          vao,
          scene.fbo,
          width,
          height,
          dpr,
          themeMix,
          palettes.night,
          palettes.paper,
          reducedMotion,
        )
        resetState()
        renderFloodOverlay(activeFlood, nowMs, scene, width, height, cssW, cssH, aspect)
      } else {
        renderDisplayPass(null, width, height)
        if (externalRenderHook) {
          externalRenderHook(gl!, { width, height, dpr, timeSec: elapsedSec, dtSec })
          resetState()
        }
        ensoRenderer.render(
          gl!,
          vao,
          null,
          width,
          height,
          dpr,
          themeMix,
          palettes.night,
          palettes.paper,
          reducedMotion,
        )
      }
    } else {
      ensureSimulationFbos(params.sim, params.dye, width, height)
      staticSeeded = false

      if (velocityFbo && dyeFbo && pressureFbo && divergenceFbo && curlFbo) {
        // 1. Drain rate-limited pointer sample (max once per frame)
        if (pendingPointer) {
          const ptr = pendingPointer
          pendingPointer = null
          const speed = Math.hypot(ptr.dx, ptr.dy)
          const velocityOnly = speed < INK.pointerMinSpeed
          const rawAmount = clamp(speed / INK.pointerAmountDivisor, 0, INK.pointerAmountMax)
          const scaledAmount = velocityOnly ? 0 : rawAmount * params.pointerInkScale
          const forceBoost = ptr.down ? 1.45 : 1.0
          applySplat(
            {
              x: ptr.x,
              y: ptr.y,
              dx: ptr.dx * forceBoost * 2.2,
              dy: ptr.dy * forceBoost * 2.2,
              radius: ptr.down ? 34 : 26,
              amount: scaledAmount,
              color: 'smoke',
              velocityOnly,
            },
            cssW,
            cssH,
            aspect,
          )
        }

        // 2. Idle wisp after 30s without user input, every 6s
        if (
          nowMs - lastUserInputMs >= INK.idleAfterMs
          && nowMs - lastIdleWispMs >= INK.idleWispEveryMs
        ) {
          lastIdleWispMs = nowMs
          const edge = Math.floor(Math.random() * 4)
          let wx: number
          let wy: number
          let wdx: number
          let wdy: number
          if (edge === 0) {
            wx = Math.random() * cssW
            wy = 4
            wdx = (Math.random() - 0.5) * 40
            wdy = 32 + Math.random() * 24
          } else if (edge === 1) {
            wx = Math.random() * cssW
            wy = cssH - 4
            wdx = (Math.random() - 0.5) * 40
            wdy = -(32 + Math.random() * 24)
          } else if (edge === 2) {
            wx = 4
            wy = Math.random() * cssH
            wdx = 32 + Math.random() * 24
            wdy = (Math.random() - 0.5) * 40
          } else {
            wx = cssW - 4
            wy = Math.random() * cssH
            wdx = -(32 + Math.random() * 24)
            wdy = (Math.random() - 0.5) * 40
          }
          queuedSplats.push({
            x: wx,
            y: wy,
            dx: wdx,
            dy: wdy,
            radius: 120,
            amount: INK.idleWispAmount,
            color: 'smoke',
          })
        }

        // 3. Expanding ink splat during flood swell
        if (activeFlood && nowMs - activeFlood.startMs <= activeFlood.floodMs) {
          const floodProgress = clamp((nowMs - activeFlood.startMs) / activeFlood.floodMs, 0, 1)
          const diag = Math.hypot(cssW, cssH)
          queuedSplats.push({
            x: activeFlood.x,
            y: activeFlood.y,
            dx: (Math.random() - 0.5) * 60,
            dy: (Math.random() - 0.5) * 60,
            radius: 48 + easeInkOut(floodProgress) * diag * 0.45,
            amount: 0.45,
            color: activeFlood.color,
          })
        }

        // 4. Apply all queued splats
        while (queuedSplats.length > 0) {
          const s = queuedSplats.shift()!
          applySplat(s, cssW, cssH, aspect)
        }

        // 5. Apply active tangential swirls (stir)
        if (swirlProg && activeStirs.size > 0) {
          for (const [id, stir] of activeStirs) {
            const ageMs = nowMs - stir.startMs
            if (stir.stoppingAtMs === null && stir.durationMs > 0 && ageMs >= stir.durationMs) {
              stir.stoppingAtMs = nowMs
            }

            let strengthFactor = 1
            if (stir.stoppingAtMs !== null) {
              const fadeElapsed = nowMs - stir.stoppingAtMs
              strengthFactor = clamp(1 - fadeElapsed / STIR_FADE_OUT_MS, 0, 1)
              if (strengthFactor <= 0) {
                activeStirs.delete(id)
                continue
              }
            }

            const uvX = clamp(stir.x / Math.max(1, cssW), 0, 1)
            const uvY = clamp(1 - stir.y / Math.max(1, cssH), 0, 1)
            const normRadius = Math.max(0.01, stir.radius / Math.max(1, cssH))

            gl!.useProgram(swirlProg.program)
            bindTextureUnit(0, velocityFbo.read.texture)
            gl!.uniform1i(swirlProg.uniforms.uTarget!, 0)
            gl!.uniform2f(swirlProg.uniforms.uPoint!, uvX, uvY)
            gl!.uniform1f(swirlProg.uniforms.uRadius!, normRadius)
            gl!.uniform1f(swirlProg.uniforms.uStrength!, stir.strength * strengthFactor * 180)
            gl!.uniform1f(swirlProg.uniforms.uAspect!, aspect)
            gl!.uniform1f(swirlProg.uniforms.uDt!, dtSec)
            blit(velocityFbo.write, velocityFbo.width, velocityFbo.height)
            velocityFbo.swap()

            // Subtle ambient ink lift so swirling is perceptible even on calm canvas
            applySplat(
              {
                x: stir.x + Math.cos(elapsedSec * 2.4) * stir.radius * 0.35,
                y: stir.y + Math.sin(elapsedSec * 2.4) * stir.radius * 0.35,
                dx: 0,
                dy: 0,
                radius: stir.radius * 0.32,
                amount: 0.015 * strengthFactor * params.pointerInkScale,
                color: 'smoke',
                dyeOnly: true,
              },
              cssW,
              cssH,
              aspect,
            )
          }
        }

        // 6. Apply active rect dilutions (dilute)
        if (diluteProg && activeDilutes.length > 0) {
          for (let i = activeDilutes.length - 1; i >= 0; i -= 1) {
            const d = activeDilutes[i]!
            const elapsed = nowMs - d.startMs
            if (elapsed >= d.durationMs) {
              activeDilutes.splice(i, 1)
              continue
            }
            const progress = clamp(elapsed / Math.max(1, d.durationMs), 0, 1)
            const minX = clamp(d.rect.x / Math.max(1, cssW), 0, 1)
            const maxX = clamp((d.rect.x + d.rect.w) / Math.max(1, cssW), 0, 1)
            const minY = clamp(1 - (d.rect.y + d.rect.h) / Math.max(1, cssH), 0, 1)
            const maxY = clamp(1 - d.rect.y / Math.max(1, cssH), 0, 1)
            const factor = Math.pow(0.04, dtSec / Math.max(0.05, d.durationMs / 1000))

            gl!.useProgram(diluteProg.program)
            bindTextureUnit(0, dyeFbo.read.texture)
            gl!.uniform1i(diluteProg.uniforms.uTarget!, 0)
            gl!.uniform4f(diluteProg.uniforms.uRect!, minX, minY, maxX, maxY)
            gl!.uniform1f(diluteProg.uniforms.uFactor!, factor)
            gl!.uniform1f(diluteProg.uniforms.uMark!, 1 - progress)
            blit(dyeFbo.write, dyeFbo.width, dyeFbo.height)
            dyeFbo.swap()
          }
        }

        // 7. Stable Fluid Simulation (§5.2 exact pass order)
        // 7.1 curl
        if (curlProg) {
          gl!.useProgram(curlProg.program)
          bindTextureUnit(0, velocityFbo.read.texture)
          gl!.uniform1i(curlProg.uniforms.uVelocity!, 0)
          gl!.uniform2f(curlProg.uniforms.uTexelSize!, velocityFbo.texelSizeX, velocityFbo.texelSizeY)
          blit(curlFbo, curlFbo.width, curlFbo.height)
        }

        // 7.2 vorticity confinement
        if (vorticityProg) {
          gl!.useProgram(vorticityProg.program)
          bindTextureUnit(0, velocityFbo.read.texture)
          gl!.uniform1i(vorticityProg.uniforms.uVelocity!, 0)
          bindTextureUnit(1, curlFbo.texture)
          gl!.uniform1i(vorticityProg.uniforms.uCurl!, 1)
          gl!.uniform2f(vorticityProg.uniforms.uTexelSize!, velocityFbo.texelSizeX, velocityFbo.texelSizeY)
          gl!.uniform1f(vorticityProg.uniforms.uCurlStrength!, params.curl)
          gl!.uniform1f(vorticityProg.uniforms.uDt!, dtSec)
          blit(velocityFbo.write, velocityFbo.width, velocityFbo.height)
          velocityFbo.swap()
        }

        // 7.3 divergence
        if (divergenceProg) {
          gl!.useProgram(divergenceProg.program)
          bindTextureUnit(0, velocityFbo.read.texture)
          gl!.uniform1i(divergenceProg.uniforms.uVelocity!, 0)
          gl!.uniform2f(divergenceProg.uniforms.uTexelSize!, velocityFbo.texelSizeX, velocityFbo.texelSizeY)
          blit(divergenceFbo, divergenceFbo.width, divergenceFbo.height)
        }

        // 7.4 pressure warm-start clear (0.8 * pressure)
        if (clearProg) {
          gl!.useProgram(clearProg.program)
          bindTextureUnit(0, pressureFbo.read.texture)
          gl!.uniform1i(clearProg.uniforms.uTexture!, 0)
          gl!.uniform1f(clearProg.uniforms.uValue!, 0.8)
          blit(pressureFbo.write, pressureFbo.width, pressureFbo.height)
          pressureFbo.swap()
        }

        // 7.5 Jacobi pressure iterations
        if (pressureProg) {
          gl!.useProgram(pressureProg.program)
          bindTextureUnit(1, divergenceFbo.texture)
          gl!.uniform1i(pressureProg.uniforms.uDivergence!, 1)
          gl!.uniform2f(pressureProg.uniforms.uTexelSize!, velocityFbo.texelSizeX, velocityFbo.texelSizeY)
          for (let i = 0; i < params.pressureIters; i += 1) {
            bindTextureUnit(0, pressureFbo.read.texture)
            gl!.uniform1i(pressureProg.uniforms.uPressure!, 0)
            blit(pressureFbo.write, pressureFbo.width, pressureFbo.height)
            pressureFbo.swap()
          }
        }

        // 7.6 gradientSubtract
        if (gradientSubtractProg) {
          gl!.useProgram(gradientSubtractProg.program)
          bindTextureUnit(0, pressureFbo.read.texture)
          gl!.uniform1i(gradientSubtractProg.uniforms.uPressure!, 0)
          bindTextureUnit(1, velocityFbo.read.texture)
          gl!.uniform1i(gradientSubtractProg.uniforms.uVelocity!, 1)
          gl!.uniform2f(
            gradientSubtractProg.uniforms.uTexelSize!,
            velocityFbo.texelSizeX,
            velocityFbo.texelSizeY,
          )
          blit(velocityFbo.write, velocityFbo.width, velocityFbo.height)
          velocityFbo.swap()
        }

        // 7.7 advect velocity
        const frameScale = dtSec * 60
        if (advectProg) {
          gl!.useProgram(advectProg.program)
          bindTextureUnit(0, velocityFbo.read.texture)
          gl!.uniform1i(advectProg.uniforms.uVelocity!, 0)
          gl!.uniform1i(advectProg.uniforms.uSource!, 0)
          gl!.uniform2f(advectProg.uniforms.uTexelSize!, velocityFbo.texelSizeX, velocityFbo.texelSizeY)
          gl!.uniform1f(advectProg.uniforms.uDt!, dtSec)
          gl!.uniform1f(
            advectProg.uniforms.uDissipation!,
            Math.pow(params.velocityDissipation, frameScale),
          )
          blit(velocityFbo.write, velocityFbo.width, velocityFbo.height)
          velocityFbo.swap()

          // 7.8 advect dye (faster dissipation during flood ebb phase)
          const isFloodEbb = activeFlood !== null && nowMs - activeFlood.startMs > activeFlood.floodMs
          const baseDyeDissipation = isFloodEbb ? 0.91 : params.dyeDissipation
          bindTextureUnit(0, velocityFbo.read.texture)
          gl!.uniform1i(advectProg.uniforms.uVelocity!, 0)
          bindTextureUnit(1, dyeFbo.read.texture)
          gl!.uniform1i(advectProg.uniforms.uSource!, 1)
          gl!.uniform2f(advectProg.uniforms.uTexelSize!, velocityFbo.texelSizeX, velocityFbo.texelSizeY)
          gl!.uniform1f(advectProg.uniforms.uDt!, dtSec)
          gl!.uniform1f(
            advectProg.uniforms.uDissipation!,
            Math.pow(baseDyeDissipation, frameScale),
          )
          blit(dyeFbo.write, dyeFbo.width, dyeFbo.height)
          dyeFbo.swap()
        }

        // 8. Display + Enso + optional Three.js hook + optional Flood overlay
        if (activeFlood) {
          const scene = ensureSceneFbo(width, height)
          renderDisplayPass(scene, width, height)
          ensoRenderer.render(
            gl!,
            vao,
            scene.fbo,
            width,
            height,
            dpr,
            themeMix,
            palettes.night,
            palettes.paper,
            reducedMotion,
          )
          resetState()
          renderFloodOverlay(activeFlood, nowMs, scene, width, height, cssW, cssH, aspect)
        } else {
          renderDisplayPass(null, width, height)
          if (externalRenderHook) {
            externalRenderHook(gl!, { width, height, dpr, timeSec: elapsedSec, dtSec })
            resetState()
          }
          ensoRenderer.render(
            gl!,
            vao,
            null,
            width,
            height,
            dpr,
            themeMix,
            palettes.night,
            palettes.paper,
            reducedMotion,
          )
        }
      }
    }

    if (timerExt && frameQuery) {
      gl!.endQuery(timerExt.TIME_ELAPSED_EXT)
      pendingGpuQueries.push(frameQuery)
    }
  }

  function startLoop(): void {
    if (disposed || contextLost || rafId !== null) return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    lastFrameNowMs = 0
    rafId = window.requestAnimationFrame(stepFrame)
  }

  function stopLoop(): void {
    if (rafId !== null) {
      window.cancelAnimationFrame(rafId)
      rafId = null
    }
  }

  function onVisibilityChange(): void {
    if (disposed) return
    if (document.visibilityState === 'hidden') {
      stopLoop()
    } else {
      startLoop()
    }
  }

  function onResize(): void {
    if (disposed || contextLost) return
    if (!qualityController.isLocked()) {
      const nextCeiling: QualityTier = window.innerWidth < 1024 ? 'low' : 'high'
      qualityController.setCeiling(nextCeiling)
    }
  }

  function onContextLost(event: Event): void {
    event.preventDefault()
    contextLost = true
    stopLoop()
    ensoRenderer.detachProgram()
    pendingGpuQueries.length = 0
    gpuFrameMs = null
    velocityFbo = null
    dyeFbo = null
    pressureFbo = null
    divergenceFbo = null
    curlFbo = null
    sceneFbo = null
    vao = null
    paperFiberTexture = null
    splatProg = null
    curlProg = null
    vorticityProg = null
    divergenceProg = null
    clearProg = null
    pressureProg = null
    gradientSubtractProg = null
    advectProg = null
    diluteProg = null
    swirlProg = null
    displayProg = null
    floodProg = null
    ensoProg = null
  }

  function onContextRestored(): void {
    if (disposed) return
    contextLost = false
    try {
      initWebGLResources()
      startLoop()
    } catch {
      contextLost = true
    }
  }

  try {
    initWebGLResources()
    loadPaperFiberImage()
  } catch {
    return createStatic2DFallback(canvas)
  }

  canvas.addEventListener('webglcontextlost', onContextLost, false)
  canvas.addEventListener('webglcontextrestored', onContextRestored, false)
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange)
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', onResize)
  }
  startLoop()

  return {
    splat(p) {
      if (disposed || reducedMotion) return
      lastUserInputMs = performance.now()
      queuedSplats.push({
        x: p.x,
        y: p.y,
        dx: p.dx ?? 0,
        dy: p.dy ?? 0,
        radius: p.radius ?? 60,
        amount: p.amount ?? 0.35,
        color: p.color ?? 'smoke',
      })
    },

    stir(p) {
      if (disposed || reducedMotion) {
        return () => {}
      }
      lastUserInputMs = performance.now()
      const id = nextStirId++
      activeStirs.set(id, {
        id,
        x: p.x,
        y: p.y,
        radius: p.radius,
        strength: p.strength,
        durationMs: p.durationMs,
        startMs: performance.now(),
        stoppingAtMs: null,
      })
      return () => {
        const entry = activeStirs.get(id)
        if (entry && entry.stoppingAtMs === null) {
          entry.stoppingAtMs = performance.now()
        }
      }
    },

    flood(p) {
      if (disposed) {
        return Promise.resolve()
      }
      lastUserInputMs = performance.now()
      if (activeFlood && !activeFlood.resolved) {
        activeFlood.resolved = true
        if (activeFlood.fallbackTimer !== null) {
          clearTimeout(activeFlood.fallbackTimer)
          activeFlood.fallbackTimer = null
        }
        activeFlood.resolve()
      }

      const floodMs = reducedMotion ? REDUCED_FLOOD_MS : Math.round(DUR.flood * 1000)
      const ebbMs = reducedMotion ? 0 : Math.round(DUR.ebb * 1000)

      return new Promise<void>((resolve) => {
        const floodEntry: ActiveFlood = {
          x: p.x,
          y: p.y,
          color: p.color ?? 'smoke',
          startMs: performance.now(),
          floodMs,
          ebbMs,
          resolved: false,
          resolve,
          fallbackTimer: null,
        }
        // Guarantee route switch resolves even if tab becomes hidden mid-transition
        floodEntry.fallbackTimer = setTimeout(() => {
          if (!floodEntry.resolved) {
            floodEntry.resolved = true
            floodEntry.fallbackTimer = null
            floodEntry.resolve()
          }
        }, floodMs + 32)
        activeFlood = floodEntry
      })
    },

    dilute(rect, durationMs) {
      if (disposed || reducedMotion) return
      activeDilutes.push({
        rect: { ...rect },
        startMs: performance.now(),
        durationMs: Math.max(50, durationMs),
      })
    },

    setCalm(nextCalm) {
      calm = nextCalm
    },

    pointer(p) {
      if (disposed || reducedMotion) return
      lastUserInputMs = performance.now()
      if (pendingPointer) {
        pendingPointer.x = p.x
        pendingPointer.y = p.y
        pendingPointer.dx += p.dx
        pendingPointer.dy += p.dy
        pendingPointer.down = pendingPointer.down || p.down
      } else {
        pendingPointer = { ...p }
      }
    },

    setTheme(nextTheme) {
      if (theme === nextTheme) return
      theme = nextTheme
      refreshPalettes()
      themeFromMix = themeMix
      themeTargetMix = nextTheme === 'paper' ? 1 : 0
      themeTransitionStartMs = performance.now()
      if (reducedMotion || lastFrameNowMs === 0) {
        themeMix = themeTargetMix
        themeTransitioning = false
      } else {
        themeTransitioning = true
      }
    },

    setQuality(q) {
      qualityController.setLockedQuality(q)
    },

    setAutoQuality() {
      qualityController.setLockedQuality(null)
    },

    setReducedMotion(nextReduced) {
      reducedMotion = nextReduced
      if (reducedMotion && themeTransitioning) {
        themeMix = themeTargetMix
        themeTransitioning = false
      }
    },

    setEnso(spec) {
      ensoRenderer.setEnso(spec)
    },

    removeEnso(id) {
      ensoRenderer.removeEnso(id)
    },

    pulseEnso(id) {
      ensoRenderer.pulseEnso(id)
    },

    getStats(): InkEngineStats {
      return {
        backend: 'webgl2',
        quality: effectiveTier(),
        lockedQuality: qualityController.getLockedQuality(),
        calm,
        theme,
        reducedMotion,
        floatSupported,
        contextLost,
        avgFrameMs: qualityController.getLastAvgFrameMs(),
        lastFrameMs,
        gpuFrameMs,
        simResolution: velocityFbo ? [velocityFbo.width, velocityFbo.height] : [0, 0],
        dyeResolution: dyeFbo ? [dyeFbo.width, dyeFbo.height] : [0, 0],
        ensoCount: ensoRenderer.getCount(),
      }
    },

    getGLContext() {
      return contextLost ? null : gl
    },

    setExternalRenderHook(hook) {
      externalRenderHook = hook
    },

    resetState,

    simulateContextLoss() {
      const loseExt = gl.getExtension('WEBGL_lose_context')
      if (!loseExt) return
      loseExt.loseContext()
      setTimeout(() => {
        if (!disposed) {
          loseExt.restoreContext()
        }
      }, 600)
    },

    dispose() {
      if (disposed) return
      disposed = true
      stopLoop()

      if (activeFlood) {
        if (activeFlood.fallbackTimer !== null) {
          clearTimeout(activeFlood.fallbackTimer)
        }
        if (!activeFlood.resolved) {
          activeFlood.resolved = true
          activeFlood.resolve()
        }
        activeFlood = null
      }

      canvas.removeEventListener('webglcontextlost', onContextLost)
      canvas.removeEventListener('webglcontextrestored', onContextRestored)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange)
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('resize', onResize)
      }

      if (!contextLost) {
        for (const q of pendingGpuQueries) {
          gl.deleteQuery(q)
        }
        pendingGpuQueries.length = 0
        destroySimulationFbos()
        destroySceneFbo()
        if (paperFiberTexture) gl.deleteTexture(paperFiberTexture)
        if (vao) gl.deleteVertexArray(vao)
        const programs = [
          splatProg,
          curlProg,
          vorticityProg,
          divergenceProg,
          clearProg,
          pressureProg,
          gradientSubtractProg,
          advectProg,
          diluteProg,
          swirlProg,
          displayProg,
          floodProg,
          ensoProg,
        ]
        for (const p of programs) {
          if (p) gl.deleteProgram(p.program)
        }
      }
      ensoRenderer.detachProgram()
    },
  }
}
