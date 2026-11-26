import { finiteOr, isPlainObject } from './helpers.ts'
import { DEFAULT_SETTINGS, clamp, halfLifeFactor, type Settings } from './settings.ts'
import {
  modulation, padBaseline, traitValues,
  type Modulation, type PreferenceLike,
} from './temperament.ts'

export const LABELS = Object.freeze([
  '开心', '得意', '感动', '害羞', '想念', '生气', '难过', '委屈', '焦虑', '无聊', '害怕',
] as const)

export type MoodLabel = (typeof LABELS)[number]

export const NEGATIVE_LABELS: ReadonlySet<MoodLabel> = new Set([
  '生气', '难过', '委屈', '焦虑', '无聊', '害怕',
])

export const KINDS = Object.freeze([
  'insult', 'tease', 'praise', 'care', 'vent', 'ask_help', 'ignore', 'apology', 'share', 'normal',
] as const)

export type AppraisalKind = (typeof KINDS)[number]

export interface Pad {
  p: number
  a: number
  d: number
}

export interface KindEffect {
  readonly pad: Pad
  readonly label: MoodLabel | ''
}

export const KIND_EFFECTS: Readonly<Record<AppraisalKind, KindEffect>> = Object.freeze({
  insult: { pad: { p: -1, a: 0.6, d: -0.4 }, label: '生气' },
  tease: { pad: { p: 0.2, a: 0.3, d: 0 }, label: '' },
  praise: { pad: { p: 1, a: 0.3, d: 0.3 }, label: '得意' },
  care: { pad: { p: 0.8, a: 0, d: 0 }, label: '感动' },
  vent: { pad: { p: -0.3, a: 0.1, d: 0 }, label: '' },
  ask_help: { pad: { p: 0.1, a: 0.2, d: 0.2 }, label: '' },
  ignore: { pad: { p: -0.6, a: -0.2, d: -0.3 }, label: '委屈' },
  apology: { pad: { p: 0.3, a: -0.1, d: 0.1 }, label: '' },
  share: { pad: { p: 0.4, a: 0.2, d: 0 }, label: '开心' },
  normal: { pad: { p: 0, a: 0, d: 0 }, label: '' },
})

export interface EmotionCore {
  p: number
  a: number
  d: number
  at: number
}

export interface EmotionScene {
  p: number
  a: number
  d: number
  at: number
}

export interface EmotionLabel {
  name: MoodLabel
  v: number
  key: string
  cause: string
  since: number
  at: number
}

export interface EmotionBudget {
  hour: number
  used: number
}

export interface EmotionHistoryPoint {
  at: number
  p: number
  a: number
  d: number
}

export interface Emotion {
  version: number
  core: EmotionCore
  scenes: Record<string, EmotionScene>
  labels: EmotionLabel[]
  budget: EmotionBudget
  history: EmotionHistoryPoint[]
}

export interface ImpulseLabel {
  readonly name: string
  readonly v: number
  readonly cause?: string
  readonly strong?: boolean
}

export interface Impulse {
  readonly key: string
  readonly delta?: Partial<Pad>
  readonly label?: ImpulseLabel | null
}

export interface Appraisal {
  readonly kind: string
  readonly target?: string
  readonly intensity?: number
  readonly pad?: Pad | null
  readonly emotion?: { readonly label?: string }
  readonly cause?: string
  readonly trigger?: string
  readonly source?: string
  readonly trustDelta?: number
  readonly relation?: { readonly intimacy?: number }
}

export interface ImpulseResultLabel {
  readonly name: MoodLabel
  readonly v: number
  readonly cause: string
  readonly strong: boolean
}

export interface ImpulseResult {
  readonly delta: Pad
  readonly label: ImpulseResultLabel | null
}

export interface MoodSnapshot {
  readonly p: number
  readonly a: number
  readonly d: number
  readonly word: string
  readonly line: string
  readonly at: number
}

const LABEL_SET: ReadonlySet<string> = new Set(LABELS)
const KIND_SET: ReadonlySet<string> = new Set(KINDS)
const SCENE_PRUNE_THRESHOLD = 0.01
const LABEL_PRUNE_THRESHOLD = 0.05
const HISTORY_INTERVAL_MS = 300_000
const MAX_HISTORY_POINTS = 288

function toHourBucket(ms: number): number {
  return Math.floor(ms / 3_600_000)
}

function asMoodLabel(value: unknown): value is MoodLabel {
  return typeof value === 'string' && LABEL_SET.has(value)
}

function isNegativeMood(label: MoodLabel | ''): boolean {
  return label !== '' && NEGATIVE_LABELS.has(label)
}

function decayedPad(raw: unknown, now: number, halfLifeMin: number): { p: number; a: number; d: number } {
  if (!isPlainObject(raw)) return { p: 0, a: 0, d: 0 }
  const at = finiteOr(raw.at, now)
  const k = halfLifeFactor(now - at, halfLifeMin)
  return {
    p: finiteOr(raw.p, 0) * k,
    a: finiteOr(raw.a, 0) * k,
    d: finiteOr(raw.d, 0) * k,
  }
}

function decayedLabelValue(label: EmotionLabel, now: number, baseHalfLifeMin: number, mod: Modulation): number {
  const hl = baseHalfLifeMin * (NEGATIVE_LABELS.has(label.name) ? mod.negHalfLifeMul : 1)
  return finiteOr(label.v, 0) * halfLifeFactor(now - finiteOr(label.at, now), hl)
}

/** Creates an initial neutral Emotion document timestamped at `now`. */
export function newEmotion(now = Date.now()): Emotion {
  return {
    version: 1,
    core: { p: 0, a: 0, d: 0, at: now },
    scenes: {},
    labels: [],
    budget: { hour: toHourBucket(now), used: 0 },
    history: [],
  }
}

/** Mutates and returns `em` after applying half-life decay to core, scenes, and labels up to `now`. */
export function decayEmotion(
  em: Emotion,
  now: number,
  settings: Settings,
  mod: Modulation = modulation({}),
): Emotion {
  const cfg = settings.emotion
  const nextCore = decayedPad(em.core, now, cfg.coreHalfLifeMin)
  em.core = { ...nextCore, at: now }

  if (isPlainObject(em.scenes)) {
    for (const [key, scene] of Object.entries(em.scenes)) {
      const decayed = decayedPad(scene, now, cfg.sceneHalfLifeMin)
      if (Math.abs(decayed.p) + Math.abs(decayed.a) + Math.abs(decayed.d) < SCENE_PRUNE_THRESHOLD) {
        delete em.scenes[key]
      } else {
        em.scenes[key] = { ...decayed, at: now }
      }
    }
  } else {
    em.scenes = {}
  }

  if (Array.isArray(em.labels)) {
    const surviving: EmotionLabel[] = []
    for (const label of em.labels) {
      const nextV = decayedLabelValue(label, now, cfg.labelHalfLifeMin, mod)
      if (nextV >= LABEL_PRUNE_THRESHOLD) {
        surviving.push({ ...label, v: nextV, at: now })
      }
    }
    em.labels = surviving
  } else {
    em.labels = []
  }

  return em
}

/** Applies a PAD delta and optional mood label to `em`, enforcing hourly core budget and top-3 label cap. */
export function applyImpulse(
  em: Emotion,
  { key, delta = {}, label = null }: Impulse,
  now: number,
  settings: Settings,
  mod: Modulation = modulation({}),
): Emotion {
  decayEmotion(em, now, settings, mod)
  const cfg = settings.emotion
  const clampStep = (v: number | undefined): number => clamp(finiteOr(v, 0), -cfg.stepClamp, cfg.stepClamp)
  const stepDelta: Pad = {
    p: clampStep(delta.p),
    a: clampStep(delta.a),
    d: clampStep(delta.d),
  }

  const prevScene = em.scenes[key] ?? { p: 0, a: 0, d: 0, at: now }
  em.scenes[key] = {
    p: clamp(prevScene.p + stepDelta.p, -1, 1),
    a: clamp(prevScene.a + stepDelta.a, -1, 1),
    d: clamp(prevScene.d + stepDelta.d, -1, 1),
    at: now,
  }

  const hour = toHourBucket(now)
  if (em.budget.hour !== hour) em.budget = { hour, used: 0 }
  const desiredCore = (Math.abs(stepDelta.p) + Math.abs(stepDelta.a) + Math.abs(stepDelta.d)) * cfg.coreShare
  const remaining = Math.max(0, cfg.coreHourlyBudget - em.budget.used)
  const ratio = desiredCore > 0 ? Math.min(1, remaining / desiredCore) : 0
  const share = cfg.coreShare * ratio

  em.core = {
    p: clamp(em.core.p + stepDelta.p * share, -1, 1),
    a: clamp(em.core.a + stepDelta.a * share, -1, 1),
    d: clamp(em.core.d + stepDelta.d * share, -1, 1),
    at: now,
  }
  em.budget.used += desiredCore * ratio

  if (label && asMoodLabel(label.name) && label.v > 0) {
    const cap = label.strong ? cfg.labelCapStrong : cfg.labelCap
    const existing = em.labels.find((entry) => entry.name === label.name && entry.key === key)
    if (existing) {
      existing.v = clamp(existing.v + label.v, 0, cap)
      existing.since = now
      existing.at = now
      if (label.cause) existing.cause = String(label.cause).slice(0, 20)
    } else {
      em.labels.push({
        name: label.name,
        v: clamp(label.v, 0, cap),
        key,
        cause: String(label.cause ?? '').slice(0, 20),
        since: now,
        at: now,
      })
    }
    em.labels.sort((a, b) => b.v - a.v)
    if (em.labels.length > 3) em.labels = em.labels.slice(0, 3)
  }

  const lastPoint = em.history[em.history.length - 1]
  if (!lastPoint || now - lastPoint.at >= HISTORY_INTERVAL_MS) {
    em.history.push({
      at: now,
      p: +em.core.p.toFixed(3),
      a: +em.core.a.toFixed(3),
      d: +em.core.d.toFixed(3),
    })
  }
  if (em.history.length > MAX_HISTORY_POINTS) {
    em.history.splice(0, em.history.length - MAX_HISTORY_POINTS)
  }
  return em
}

/** Attenuates negative mood labels in session `key` according to `mod.soothe`. */
export function soothe(
  em: Emotion,
  key: string,
  now: number,
  settings: Settings,
  mod: Modulation = modulation({}),
): Emotion {
  decayEmotion(em, now, settings, mod)
  const reduction = 0.25 * mod.soothe
  for (const label of em.labels) {
    if (label.key === key && NEGATIVE_LABELS.has(label.name)) {
      label.v = Math.max(0, label.v - reduction)
    }
  }
  em.labels = em.labels.filter((label) => label.v >= LABEL_PRUNE_THRESHOLD)
  return em
}

/** Converts an appraisal event into modulated PAD delta and optional mood label impulse. */
export function impulseFromAppraisal(
  a: Appraisal,
  mod: Modulation,
  settings: Settings,
  prefs: readonly PreferenceLike[] = [],
): ImpulseResult {
  const base = KIND_SET.has(a.kind) ? KIND_EFFECTS[a.kind as AppraisalKind] : KIND_EFFECTS.normal
  const rawPad = isPlainObject(a.pad) ? a.pad : null
  const customNonZero = rawPad !== null && (finiteOr(rawPad.p, 0) !== 0 || finiteOr(rawPad.a, 0) !== 0 || finiteOr(rawPad.d, 0) !== 0)
  const dir: Pad = customNonZero
    ? { p: finiteOr(rawPad.p, 0), a: finiteOr(rawPad.a, 0), d: finiteOr(rawPad.d, 0) }
    : { ...base.pad }

  let intensity = clamp(finiteOr(a.intensity, 0.5), 0, 1)
  const candidateLabel = a.emotion?.label
  let labelName: MoodLabel | '' = asMoodLabel(candidateLabel) ? candidateLabel : base.label
  let prefStrong = false

  const matchedPref = a.trigger ? prefs.find((p) => p?.id === a.trigger) : undefined
  if (matchedPref) {
    const strength = clamp(finiteOr(matchedPref.strength, 0.6), 0, 1)
    if (matchedPref.valence === 'dislike') {
      intensity = Math.min(1, intensity * (1 + 0.5 * strength))
      dir.p = -1
      if (!isNegativeMood(labelName)) labelName = '生气'
      prefStrong = strength >= 0.8
    } else if (matchedPref.valence === 'like') {
      intensity = Math.min(1, intensity * (1 + 0.4 * strength))
      dir.p = 1
      if (labelName === '' || isNegativeMood(labelName)) labelName = '开心'
    }
  }

  const negMul =
    (a.kind === 'tease' ? mod.teaseNegMul : 1)
    * (a.kind === 'insult' || a.kind === 'ignore' ? mod.insultGain : 1)
  const praiseMul = a.kind === 'praise' ? mod.praiseGain : 1
  const empathyMul = a.kind === 'vent' ? mod.empathyGain : 1

  let scale = settings.emotion.stepClamp * intensity * (a.target === 'me' ? 1 : 0.4)
  if (a.kind === 'ignore') scale *= mod.missGain
  if (a.kind === 'share') scale *= mod.noveltyGain

  const delta: Pad = {
    p: dir.p * scale,
    a: dir.a * scale,
    d: dir.d * scale,
  }
  if (delta.p < 0) delta.p *= mod.negGain * negMul
  else if (delta.p > 0) delta.p *= praiseMul

  delta.p *= empathyMul
  delta.a *= empathyMul
  delta.d *= empathyMul

  let label: ImpulseResultLabel | null = null
  if (labelName !== '') {
    let v = 0.6 * intensity * (a.target === 'me' ? 1 : 0.4)
    v *= NEGATIVE_LABELS.has(labelName) ? mod.negGain * negMul : praiseMul
    v *= empathyMul
    if (labelName === '想念' || a.kind === 'ignore') v *= mod.missGain
    label = {
      name: labelName,
      v,
      cause: a.cause ?? '',
      strong: intensity >= 0.8 || prefStrong,
    }
  }

  return { delta, label }
}

/** Blends baseline PAD with core mood and session scene residual. */
export function expressedPad(em: Emotion, key: string, values: unknown, settings: Settings): Pad {
  const base = padBaseline(values)
  const w = settings.emotion.coreWeight
  const scene = isPlainObject(em.scenes) && isPlainObject(em.scenes[key]) ? em.scenes[key] : null
  const sp = scene ? finiteOr(scene.p, 0) : 0
  const sa = scene ? finiteOr(scene.a, 0) : 0
  const sd = scene ? finiteOr(scene.d, 0) : 0
  return {
    p: clamp(base.p + w * finiteOr(em.core?.p, 0) + (1 - w) * sp, -1, 1),
    a: clamp(base.a + w * finiteOr(em.core?.a, 0) + (1 - w) * sa, -1, 1),
    d: clamp(base.d + w * finiteOr(em.core?.d, 0) + (1 - w) * sd, -1, 1),
  }
}

export function tierWord(v: number): string {
  if (v < 0.2) return ''
  if (v < 0.4) return '一点'
  if (v < 0.6) return '有点'
  return '很'
}

export function moodWord(p: number): string {
  if (p >= 0.3) return '心情不错'
  if (p >= 0.1) return '心情还行'
  if (p > -0.1) return '心情平平'
  if (p > -0.3) return '心情偏低'
  return '心情很差'
}

export function agoBucket(ms: number): string {
  if (ms < 10 * 60_000) return '刚刚'
  if (ms < 30 * 60_000) return '半小时内'
  if (ms < 60 * 60_000) return '一小时内'
  return '几小时前'
}

function evaluateMoodForKey(
  em: Emotion,
  key: string,
  values: unknown,
  settings: Settings,
  now: number,
): { readonly pad: Pad; readonly word: string; readonly line: string } {
  const cfg = settings.emotion
  const mod = modulation(values)
  const base = padBaseline(values)
  const w = cfg.coreWeight

  const coreDecayed = decayedPad(em.core, now, cfg.coreHalfLifeMin)

  const rawScene = isPlainObject(em.scenes) ? em.scenes[key] : undefined
  let sceneDecayed = rawScene !== undefined ? decayedPad(rawScene, now, cfg.sceneHalfLifeMin) : { p: 0, a: 0, d: 0 }
  if (Math.abs(sceneDecayed.p) + Math.abs(sceneDecayed.a) + Math.abs(sceneDecayed.d) < SCENE_PRUNE_THRESHOLD) {
    sceneDecayed = { p: 0, a: 0, d: 0 }
  }

  const pad: Pad = {
    p: clamp(base.p + w * coreDecayed.p + (1 - w) * sceneDecayed.p, -1, 1),
    a: clamp(base.a + w * coreDecayed.a + (1 - w) * sceneDecayed.a, -1, 1),
    d: clamp(base.d + w * coreDecayed.d + (1 - w) * sceneDecayed.d, -1, 1),
  }

  const displayed: { readonly label: EmotionLabel; readonly shown: number; readonly tier: string }[] = []
  if (Array.isArray(em.labels)) {
    for (const label of em.labels) {
      const nextV = decayedLabelValue(label, now, cfg.labelHalfLifeMin, mod)
      if (nextV < LABEL_PRUNE_THRESHOLD) continue
      const labelKey = typeof label.key === 'string' ? label.key : ''
      const shown = labelKey === key ? nextV : nextV * w
      const tier = tierWord(shown)
      if (tier !== '') {
        displayed.push({ label, shown, tier })
      }
    }
  }
  displayed.sort((x, y) => y.shown - x.shown)

  const labelChunks = displayed.slice(0, 2).map(({ label, tier }) => {
    const labelKey = typeof label.key === 'string' ? label.key : ''
    const cause = typeof label.cause === 'string' ? label.cause : ''
    if (labelKey === key && cause.length > 0) {
      const since = finiteOr(label.since, finiteOr(label.at, now))
      return `${tier}${label.name}（${cause}，${agoBucket(now - since)}）`
    }
    return `${tier}${label.name}`
  })

  const word = moodWord(pad.p)
  let summary = `整体${word}`
  if (pad.a <= -0.3) summary += '，没什么精神'
  else if (pad.a >= 0.35) summary += '，有点来劲'

  const line = `【你此刻】${labelChunks.length > 0 ? `${labelChunks.join('；')}；` : ''}${summary}`
  return { pad, word, line }
}

/** Renders the 【你此刻】 snapshot line for session `key` without mutating `em`. */
export function renderNow(em: Emotion, key: string, values: unknown, settings: Settings, now: number): string {
  return evaluateMoodForKey(em, key, values, settings, now).line
}

/**
 * Single-pass, zero-clone mood snapshot evaluation for PersonaService.mood().
 * Decays core, scene, and labels in one pass without mutating inputs.
 */
export function computeMoodSnapshot(
  emotion: Emotion,
  core: unknown,
  now: number,
  settings: Settings = DEFAULT_SETTINGS,
): MoodSnapshot {
  const values = traitValues(core)
  const { pad, word, line } = evaluateMoodForKey(emotion, '', values, settings, now)
  return {
    p: pad.p,
    a: pad.a,
    d: pad.d,
    word,
    line,
    at: now,
  }
}
