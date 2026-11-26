import type { Appraisal } from './affect.ts'
import { finiteOr, isPlainObject } from './helpers.ts'
import { clamp, dayOf } from './settings.ts'

export const STAGE_COEF = Object.freeze({
  陌生: 0.3,
  认识: 0.6,
  熟人: 0.8,
  朋友: 1,
  亲近: 1.2,
} as const)

export const CLOSE_STAGES: ReadonlySet<string> = new Set(['熟人', '朋友', '亲近'])

export interface TraitOffsets {
  O: number
  C: number
  E: number
  A: number
  N: number
}

export interface TrustDay {
  day: string
  gain: number
  loss: number
}

export interface PersonBelief {
  text: string
  status: string
  keys?: string[]
}

export interface Person {
  name: string
  intimacy: number
  trust: number
  familiarity: number
  offsets?: TraitOffsets
  beliefs: PersonBelief[]
  nickname: string
  jokes: string[]
  trustDay: TrustDay
  lastSeenAt: number
  createdAt: number
}

const INTIMACY_BY_KIND: Readonly<Record<string, number>> = Object.freeze({
  praise: 1,
  care: 1.5,
  share: 1,
  vent: 1.5,
  ask_help: 0.5,
  apology: 0.5,
  tease: 0.3,
  normal: 0.2,
  ignore: -0.5,
  insult: -3,
})

const DAILY_TRUST_GAIN_CAP = 4
const DAILY_TRUST_LOSS_CAP = 12
const RETURN_GAP_MS = 20 * 3_600_000

/** Initializes a neutral stranger relationship record. */
export function newPerson(now = Date.now()): Person {
  return {
    name: '',
    intimacy: 10,
    trust: 30,
    familiarity: 0,
    offsets: { O: 0, C: 0, E: 0, A: 0, N: 0 },
    beliefs: [],
    nickname: '',
    jokes: [],
    trustDay: { day: '', gain: 0, loss: 0 },
    lastSeenAt: 0,
    createdAt: now,
  }
}

/** Classifies a person into one of the five relationship stages. */
export function stageOf(p: unknown): '陌生' | '认识' | '熟人' | '朋友' | '亲近' {
  const doc = isPlainObject(p) ? p : {}
  const familiarity = finiteOr(doc.familiarity, 0)
  if (familiarity < 10) return '陌生'
  const intimacy = finiteOr(doc.intimacy, 0)
  if (intimacy < 25) return '认识'
  if (intimacy < 45) return '熟人'
  if (intimacy < 70) return '朋友'
  return '亲近'
}

/** Updates familiarity, daily-capped trust, and intimacy on `p` for one appraisal event. */
export function applyRelation(p: Person, a: Appraisal, now: number): Person {
  const day = dayOf(now)
  const gap = p.lastSeenAt ? now - p.lastSeenAt : 0
  p.familiarity = clamp(p.familiarity + 0.5 * (1 - p.familiarity / 100), 0, 100)

  if (p.trustDay.day !== day) {
    p.trustDay = { day, gain: 0, loss: 0 }
  }

  let trustShift = 0
  if (gap >= RETURN_GAP_MS) trustShift += 2
  if (a.target === 'me' && (a.kind === 'vent' || a.kind === 'share')) trustShift += 1
  if (a.target === 'me' && a.kind === 'insult') trustShift -= 6
  if (a.source === 'rules') {
    const ruleDelta = finiteOr(a.trustDelta, Number.NaN)
    if (Number.isFinite(ruleDelta)) trustShift += clamp(ruleDelta, -6, 4)
  }

  if (trustShift > 0) {
    const allowed = Math.min(trustShift, DAILY_TRUST_GAIN_CAP - p.trustDay.gain)
    if (allowed > 0) {
      p.trust = clamp(p.trust + allowed, 0, 100)
      p.trustDay.gain += allowed
    }
  } else if (trustShift < 0) {
    const allowed = Math.min(-trustShift, DAILY_TRUST_LOSS_CAP - p.trustDay.loss)
    if (allowed > 0) {
      p.trust = clamp(p.trust - allowed, 0, 100)
      p.trustDay.loss += allowed
    }
  }

  if (a.target === 'me' || a.kind === 'normal') {
    const base = INTIMACY_BY_KIND[a.kind] ?? 0
    const intensity = clamp(finiteOr(a.intensity, 0.5), 0, 1)
    const nudge = 0.5 * Math.sign(finiteOr(a.relation?.intimacy, 0))
    p.intimacy = clamp(p.intimacy + base * (0.5 + intensity) + nudge, 0, 100)
  }

  p.lastSeenAt = now
  return p
}

/** Renders the 【你和<name>】 relationship summary line, scoping private-chat beliefs to their channel. */
export function renderRelation(p: Person, name: string, options: { key?: string } = {}): string {
  const key = options.key ?? ''
  const trust = finiteOr(p?.trust, 0)
  const trustLabel = trust >= 70 ? '信任高' : trust >= 40 ? '信任一般' : '还不太信任'
  const parts = [stageOf(p), trustLabel]

  const offsets: Partial<TraitOffsets> = isPlainObject(p?.offsets) ? p.offsets : {}
  const offsetA = finiteOr(offsets.A, 0)
  const offsetE = finiteOr(offsets.E, 0)
  if (offsetA >= 4) parts.push('你对他更软一点')
  else if (offsetA <= -4) parts.push('你对他嘴更毒')
  if (offsetE >= 4) parts.push('跟他话更多')
  else if (offsetE <= -4) parts.push('跟他话少')

  if (Array.isArray(p?.beliefs)) {
    let added = 0
    for (const belief of p.beliefs) {
      if (!isPlainObject(belief) || belief.status !== 'accepted' || typeof belief.text !== 'string') continue
      const keys = Array.isArray(belief.keys) ? belief.keys : []
      if (!keys.some((k) => k === key || (typeof k === 'string' && k.startsWith('group:')))) continue
      parts.push(belief.text)
      added += 1
      if (added >= 3) break
    }
  }

  if (typeof p?.nickname === 'string' && p.nickname.length > 0) {
    parts.push(`你叫他"${p.nickname}"`)
  }
  if (Array.isArray(p?.jokes) && p.jokes.length > 0) {
    parts.push(`你们的梗：${p.jokes.slice(0, 2).join('、')}`)
  }

  return `【你和${name}】${parts.join('；')}`
}
