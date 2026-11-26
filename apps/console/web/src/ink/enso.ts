import { DUR, SPRING } from '../motion/tokens.ts'
import { lerpRgb, type RgbTuple, type ThemePalette } from './palette.ts'

export type EnsoState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'offline'
  | 'error'
  | 'recovering'

export interface EnsoRect {
  x: number
  y: number
  w: number
  h: number
}

export interface EnsoInstanceSpec {
  id: string
  rect: EnsoRect
  state: EnsoState
  brushInProgress?: number
  visible?: boolean
}

interface StateTargetParams {
  gap: number
  rotRate: number
  widthScale: number
  wobble: number
  breatheAmp: number
  redrawAmount: number
  speakingAmount: number
  errorAmount: number
  offlineAmount: number
  recoverAmount: number
  glowMultiplier: number
}

interface EnsoRuntime {
  id: string
  rect: EnsoRect
  state: EnsoState
  visible: boolean
  brushInProgress: number
  // Interpolation state over DUR.bloom
  from: StateTargetParams
  current: StateTargetParams
  target: StateTargetParams
  transitionElapsed: number
  // Continuous animation accumulators
  rotTime: number
  breathePhase: number
  redrawPhase: number
  // Speaking spring pulse (+3% radius with SPRING.press decay)
  pulseOffset: number
  pulseVelocity: number
  // Error shake (±4px, 3 cycles over 240ms)
  shakeElapsed: number
  shakeActive: boolean
}

interface EnsoUniforms {
  uTime: WebGLUniformLocation | null
  uGap: WebGLUniformLocation | null
  uWobble: WebGLUniformLocation | null
  uWidthScale: WebGLUniformLocation | null
  uScale: WebGLUniformLocation | null
  uPadFactor: WebGLUniformLocation | null
  uBrushIn: WebGLUniformLocation | null
  uThemeMix: WebGLUniformLocation | null
  uSpeakingAmount: WebGLUniformLocation | null
  uErrorAmount: WebGLUniformLocation | null
  uNightStrokeAlpha: WebGLUniformLocation | null
  uPaperStrokeAlpha: WebGLUniformLocation | null
  uNightStroke: WebGLUniformLocation | null
  uNightGlow: WebGLUniformLocation | null
  uNightGlowAlpha: WebGLUniformLocation | null
  uPaperStroke: WebGLUniformLocation | null
  uPaperZhusha: WebGLUniformLocation | null
  uNightYanzhi: WebGLUniformLocation | null
  uPaperYanzhi: WebGLUniformLocation | null
}

const PAD_FACTOR = 1.35
const BREATHE_PERIOD_SEC = 4.2
const REDRAW_PERIOD_SEC = 1.6
const ERROR_SHAKE_DURATION_SEC = 0.24
const ERROR_SHAKE_AMP_PX = 4
const ERROR_SHAKE_CYCLES = 3
const SPEAKING_PULSE_AMPLITUDE = 0.03

// In enso.frag.glsl: u = fract((a / 6.28318) + 0.5 + t * 0.03)
// So advancing t at rate (1 / periodSec) / 0.03 produces 1 revolution per periodSec.
function revPeriodToRotRate(periodSec: number): number {
  return periodSec > 0 ? 1 / (periodSec * 0.03) : 0
}

function getTargetParams(state: EnsoState): StateTargetParams {
  switch (state) {
    case 'idle':
    case 'listening':
      return {
        gap: 0.08,
        rotRate: revPeriodToRotRate(30),
        widthScale: 1.0,
        wobble: 1.0,
        breatheAmp: 0.015,
        redrawAmount: 0,
        speakingAmount: 0,
        errorAmount: 0,
        offlineAmount: 0,
        recoverAmount: 0,
        glowMultiplier: 1.0,
      }
    case 'thinking':
      return {
        gap: 0.08,
        rotRate: revPeriodToRotRate(6),
        widthScale: 1.0,
        wobble: 1.15,
        breatheAmp: 0,
        redrawAmount: 1,
        speakingAmount: 0,
        errorAmount: 0,
        offlineAmount: 0,
        recoverAmount: 0,
        glowMultiplier: 1.0,
      }
    case 'speaking':
      return {
        gap: 0.04,
        rotRate: revPeriodToRotRate(12),
        widthScale: 1.0,
        wobble: 1.05,
        breatheAmp: 0,
        redrawAmount: 0,
        speakingAmount: 1,
        errorAmount: 0,
        offlineAmount: 0,
        recoverAmount: 0,
        glowMultiplier: 1.15,
      }
    case 'offline':
      return {
        gap: 0.35,
        rotRate: 0,
        widthScale: 0.5,
        wobble: 0.6,
        breatheAmp: 0,
        redrawAmount: 0,
        speakingAmount: 0,
        errorAmount: 0,
        offlineAmount: 1,
        recoverAmount: 0,
        glowMultiplier: 0,
      }
    case 'error':
      return {
        gap: 0.08,
        rotRate: 0,
        widthScale: 1.0,
        wobble: 1.2,
        breatheAmp: 0,
        redrawAmount: 0,
        speakingAmount: 0,
        errorAmount: 1,
        offlineAmount: 0,
        recoverAmount: 0,
        glowMultiplier: 0.85,
      }
    case 'recovering':
      return {
        gap: 0.08,
        rotRate: revPeriodToRotRate(6),
        widthScale: 1.0,
        wobble: 1.1,
        breatheAmp: 0,
        redrawAmount: 1,
        speakingAmount: 0,
        errorAmount: 0,
        offlineAmount: 0,
        recoverAmount: 1,
        glowMultiplier: 0.85,
      }
  }
}

function easeInkOut(t: number): number {
  const x = Math.min(1, Math.max(0, t))
  // Smooth expo-out approximation matching EASE.inkOut [0.16, 1, 0.3, 1]
  return 1 - Math.pow(1 - x, 4)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function lerpParams(a: StateTargetParams, b: StateTargetParams, t: number): StateTargetParams {
  return {
    gap: lerp(a.gap, b.gap, t),
    rotRate: lerp(a.rotRate, b.rotRate, t),
    widthScale: lerp(a.widthScale, b.widthScale, t),
    wobble: lerp(a.wobble, b.wobble, t),
    breatheAmp: lerp(a.breatheAmp, b.breatheAmp, t),
    redrawAmount: lerp(a.redrawAmount, b.redrawAmount, t),
    speakingAmount: lerp(a.speakingAmount, b.speakingAmount, t),
    errorAmount: lerp(a.errorAmount, b.errorAmount, t),
    offlineAmount: lerp(a.offlineAmount, b.offlineAmount, t),
    recoverAmount: lerp(a.recoverAmount, b.recoverAmount, t),
    glowMultiplier: lerp(a.glowMultiplier, b.glowMultiplier, t),
  }
}

function mixStateColor(
  base: RgbTuple,
  offlineCol: RgbTuple,
  errorCol: RgbTuple,
  recoverCol: RgbTuple,
  p: StateTargetParams,
): [number, number, number] {
  let c: [number, number, number] = [base[0], base[1], base[2]]
  if (p.offlineAmount > 0.0001) {
    c = lerpRgb(c, offlineCol, p.offlineAmount)
  }
  if (p.errorAmount > 0.0001) {
    c = lerpRgb(c, errorCol, p.errorAmount)
  }
  if (p.recoverAmount > 0.0001) {
    c = lerpRgb(c, recoverCol, p.recoverAmount)
  }
  return c
}

export class EnsoRenderer {
  private readonly instances = new Map<string, EnsoRuntime>()
  private program: WebGLProgram | null = null
  private uniforms: EnsoUniforms | null = null

  attachProgram(gl: WebGL2RenderingContext, program: WebGLProgram): void {
    this.program = program
    this.uniforms = {
      uTime: gl.getUniformLocation(program, 'uTime'),
      uGap: gl.getUniformLocation(program, 'uGap'),
      uWobble: gl.getUniformLocation(program, 'uWobble'),
      uWidthScale: gl.getUniformLocation(program, 'uWidthScale'),
      uScale: gl.getUniformLocation(program, 'uScale'),
      uPadFactor: gl.getUniformLocation(program, 'uPadFactor'),
      uBrushIn: gl.getUniformLocation(program, 'uBrushIn'),
      uThemeMix: gl.getUniformLocation(program, 'uThemeMix'),
      uSpeakingAmount: gl.getUniformLocation(program, 'uSpeakingAmount'),
      uErrorAmount: gl.getUniformLocation(program, 'uErrorAmount'),
      uNightStrokeAlpha: gl.getUniformLocation(program, 'uNightStrokeAlpha'),
      uPaperStrokeAlpha: gl.getUniformLocation(program, 'uPaperStrokeAlpha'),
      uNightStroke: gl.getUniformLocation(program, 'uNightStroke'),
      uNightGlow: gl.getUniformLocation(program, 'uNightGlow'),
      uNightGlowAlpha: gl.getUniformLocation(program, 'uNightGlowAlpha'),
      uPaperStroke: gl.getUniformLocation(program, 'uPaperStroke'),
      uPaperZhusha: gl.getUniformLocation(program, 'uPaperZhusha'),
      uNightYanzhi: gl.getUniformLocation(program, 'uNightYanzhi'),
      uPaperYanzhi: gl.getUniformLocation(program, 'uPaperYanzhi'),
    }
  }

  detachProgram(): void {
    this.program = null
    this.uniforms = null
  }

  setEnso(spec: EnsoInstanceSpec): void {
    const existing = this.instances.get(spec.id)
    const visible = spec.visible ?? true
    const brushInProgress = spec.brushInProgress ?? 1

    if (!existing) {
      const target = getTargetParams(spec.state)
      this.instances.set(spec.id, {
        id: spec.id,
        rect: { ...spec.rect },
        state: spec.state,
        visible,
        brushInProgress,
        from: { ...target },
        current: { ...target },
        target,
        transitionElapsed: DUR.bloom,
        rotTime: 0,
        breathePhase: 0,
        redrawPhase: 0,
        pulseOffset: 0,
        pulseVelocity: 0,
        shakeElapsed: 0,
        shakeActive: spec.state === 'error',
      })
      return
    }

    existing.rect = { ...spec.rect }
    existing.visible = visible
    if (spec.brushInProgress !== undefined) {
      existing.brushInProgress = spec.brushInProgress
    }

    if (existing.state !== spec.state) {
      existing.state = spec.state
      existing.from = { ...existing.current }
      existing.target = getTargetParams(spec.state)
      existing.transitionElapsed = 0
      if (spec.state === 'error') {
        existing.shakeElapsed = 0
        existing.shakeActive = true
      } else {
        existing.shakeActive = false
        existing.shakeElapsed = 0
      }
      if (spec.state === 'thinking' || spec.state === 'recovering') {
        existing.redrawPhase = 0
      }
    }
  }

  removeEnso(id: string): void {
    this.instances.delete(id)
  }

  pulseEnso(id?: string): void {
    if (id !== undefined) {
      const inst = this.instances.get(id)
      if (inst) {
        this.triggerPulse(inst)
      }
      return
    }
    for (const inst of this.instances.values()) {
      this.triggerPulse(inst)
    }
  }

  private triggerPulse(inst: EnsoRuntime): void {
    // Bump radius +3% and let SPRING.press decay smoothly back to 0.
    inst.pulseOffset = Math.max(inst.pulseOffset, SPEAKING_PULSE_AMPLITUDE)
    inst.pulseVelocity = 0.08
  }

  hasVisibleInstances(): boolean {
    for (const inst of this.instances.values()) {
      if (inst.visible && inst.rect.w > 0 && inst.rect.h > 0) {
        return true
      }
    }
    return false
  }

  getCount(): number {
    return this.instances.size
  }

  update(dtSec: number, reducedMotion: boolean): void {
    const dt = Math.min(0.05, Math.max(0, dtSec))
    for (const inst of this.instances.values()) {
      if (inst.transitionElapsed < DUR.bloom) {
        inst.transitionElapsed = Math.min(DUR.bloom, inst.transitionElapsed + dt)
        const progress = easeInkOut(inst.transitionElapsed / DUR.bloom)
        inst.current = lerpParams(inst.from, inst.target, progress)
      } else {
        inst.current = inst.target
      }

      if (reducedMotion) {
        inst.pulseOffset = 0
        inst.pulseVelocity = 0
        inst.shakeActive = false
        continue
      }

      inst.rotTime += inst.current.rotRate * dt
      inst.breathePhase = (inst.breathePhase + dt / BREATHE_PERIOD_SEC) % 1
      inst.redrawPhase = (inst.redrawPhase + dt / REDRAW_PERIOD_SEC) % 1

      // Damped harmonic spring (SPRING.press: stiffness 700, damping 32, mass 0.6)
      if (Math.abs(inst.pulseOffset) > 1e-5 || Math.abs(inst.pulseVelocity) > 1e-5) {
        const force = -SPRING.press.stiffness * inst.pulseOffset - SPRING.press.damping * inst.pulseVelocity
        const accel = force / SPRING.press.mass
        inst.pulseVelocity += accel * dt
        inst.pulseOffset += inst.pulseVelocity * dt
        if (Math.abs(inst.pulseOffset) < 1e-4 && Math.abs(inst.pulseVelocity) < 1e-4) {
          inst.pulseOffset = 0
          inst.pulseVelocity = 0
        }
      }

      if (inst.shakeActive) {
        inst.shakeElapsed += dt
        if (inst.shakeElapsed >= ERROR_SHAKE_DURATION_SEC) {
          inst.shakeActive = false
          inst.shakeElapsed = ERROR_SHAKE_DURATION_SEC
        }
      }
    }
  }

  render(
    gl: WebGL2RenderingContext,
    vao: WebGLVertexArrayObject | null,
    targetFbo: WebGLFramebuffer | null,
    canvasWidthPx: number,
    canvasHeightPx: number,
    dpr: number,
    themeMix: number,
    nightPalette: ThemePalette,
    paperPalette: ThemePalette,
    reducedMotion: boolean,
  ): void {
    if (!this.program || !this.uniforms || this.instances.size === 0) {
      return
    }

    let drewAny = false
    const u = this.uniforms

    for (const inst of this.instances.values()) {
      if (!inst.visible || inst.rect.w <= 0 || inst.rect.h <= 0) {
        continue
      }

      const p = inst.current
      let shakePx = 0
      if (!reducedMotion && inst.shakeActive) {
        const s = Math.min(1, inst.shakeElapsed / ERROR_SHAKE_DURATION_SEC)
        shakePx = Math.sin(s * Math.PI * 2 * ERROR_SHAKE_CYCLES) * ERROR_SHAKE_AMP_PX * (1 - s * 0.25)
      }

      const sizeCss = Math.min(inst.rect.w, inst.rect.h)
      const paddedCss = sizeCss * PAD_FACTOR
      const centerX = inst.rect.x + inst.rect.w * 0.5 + shakePx
      const centerY = inst.rect.y + inst.rect.h * 0.5

      const vpX = Math.round((centerX - paddedCss * 0.5) * dpr)
      const vpY = Math.round(canvasHeightPx - (centerY + paddedCss * 0.5) * dpr)
      const vpW = Math.max(1, Math.round(paddedCss * dpr))
      const vpH = Math.max(1, Math.round(paddedCss * dpr))

      // Frustum cull completely offscreen rects
      if (vpX + vpW <= 0 || vpY + vpH <= 0 || vpX >= canvasWidthPx || vpY >= canvasHeightPx) {
        continue
      }

      if (!drewAny) {
        drewAny = true
        gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo)
        gl.useProgram(this.program)
        gl.bindVertexArray(vao)
        gl.disable(gl.DEPTH_TEST)
        gl.disable(gl.CULL_FACE)
        gl.enable(gl.BLEND)
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        gl.enable(gl.SCISSOR_TEST)
        gl.uniform1f(u.uPadFactor, PAD_FACTOR)
        gl.uniform1f(u.uThemeMix, themeMix)
        gl.uniform3fv(u.uPaperZhusha, paperPalette.zhusha)
        gl.uniform3fv(u.uNightYanzhi, nightPalette.yanzhi)
        gl.uniform3fv(u.uPaperYanzhi, paperPalette.yanzhi)
      }

      // Compute dynamic gap (redrawing brush stroke for thinking/recovering:
      // paints forward from 0.95 -> 0.08 over 1.6s, brief full-circle hold, smooth lift)
      let effectiveGap = p.gap
      if (p.redrawAmount > 0.001) {
        let cycleGap = 0.28
        if (!reducedMotion) {
          const ph = inst.redrawPhase
          if (ph < 0.75) {
            const paintT = easeInkOut(ph / 0.75)
            cycleGap = lerp(0.95, 0.08, paintT)
          } else if (ph < 0.88) {
            cycleGap = 0.08
          } else {
            const liftT = (ph - 0.88) / 0.12
            cycleGap = lerp(0.08, 0.95, liftT * liftT)
          }
        }
        effectiveGap = lerp(p.gap, cycleGap, p.redrawAmount)
      }

      // Breathing (±1.5% 4.2s cycle) + speaking pulse (+3% spring decay)
      const breathe = reducedMotion
        ? 0
        : Math.sin(inst.breathePhase * Math.PI * 2) * p.breatheAmp
      const scale = 1 + breathe + (reducedMotion ? 0 : inst.pulseOffset)

      // Night stroke & glow colors
      const nightOfflineRgb: RgbTuple = [
        nightPalette.text3[0],
        nightPalette.text3[1],
        nightPalette.text3[2],
      ]
      const paperOfflineRgb: RgbTuple = [
        paperPalette.text3[0],
        paperPalette.text3[1],
        paperPalette.text3[2],
      ]
      const nightStroke = mixStateColor(
        nightPalette.zhusha,
        nightOfflineRgb,
        nightPalette.yanzhi,
        nightPalette.tenghuang,
        p,
      )
      const nightGlowBase: RgbTuple = [
        nightPalette.zhushaGlow[0],
        nightPalette.zhushaGlow[1],
        nightPalette.zhushaGlow[2],
      ]
      const nightGlow = mixStateColor(
        nightGlowBase,
        nightOfflineRgb,
        nightPalette.yanzhi,
        nightPalette.tenghuang,
        p,
      )
      const paperStroke = mixStateColor(
        paperPalette.smoke,
        paperOfflineRgb,
        paperPalette.yanzhi,
        paperPalette.tenghuang,
        p,
      )

      const scX = Math.max(0, vpX)
      const scY = Math.max(0, vpY)
      const scRight = Math.min(canvasWidthPx, vpX + vpW)
      const scTop = Math.min(canvasHeightPx, vpY + vpH)
      const scW = Math.max(0, scRight - scX)
      const scH = Math.max(0, scTop - scY)
      if (scW === 0 || scH === 0) {
        continue
      }

      gl.viewport(vpX, vpY, vpW, vpH)
      gl.scissor(scX, scY, scW, scH)

      gl.uniform1f(u.uTime, inst.rotTime)
      gl.uniform1f(u.uGap, effectiveGap)
      gl.uniform1f(u.uWobble, p.wobble)
      gl.uniform1f(u.uWidthScale, p.widthScale)
      gl.uniform1f(u.uScale, scale)
      gl.uniform1f(u.uBrushIn, inst.brushInProgress)
      gl.uniform1f(u.uSpeakingAmount, p.speakingAmount)
      gl.uniform1f(u.uErrorAmount, p.errorAmount)
      gl.uniform1f(u.uNightStrokeAlpha, lerp(1, nightPalette.text3[3], p.offlineAmount))
      gl.uniform1f(u.uPaperStrokeAlpha, lerp(1, paperPalette.text3[3], p.offlineAmount))
      gl.uniform3fv(u.uNightStroke, nightStroke)
      gl.uniform3fv(u.uNightGlow, nightGlow)
      gl.uniform1f(u.uNightGlowAlpha, nightPalette.zhushaGlow[3] * p.glowMultiplier)
      gl.uniform3fv(u.uPaperStroke, paperStroke)

      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }

    if (drewAny) {
      gl.disable(gl.SCISSOR_TEST)
      gl.disable(gl.BLEND)
    }
  }
}
