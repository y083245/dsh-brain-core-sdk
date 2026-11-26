import type { Pad } from './affect.ts'
import { finiteOr, isPlainObject } from './helpers.ts'
import { band, clamp } from './settings.ts'

export const TRAITS = Object.freeze(['O', 'C', 'E', 'A', 'N'] as const)
export const TRAIT_NAMES = Object.freeze({
  O: '开放',
  C: '尽责',
  E: '外向',
  A: '宜人',
  N: '神经质',
} as const)

export const CHAR_TRAITS = Object.freeze(['grudge', 'clingy', 'guarded', 'playful', 'pride', 'empathy'] as const)
export const CHAR_NAMES = Object.freeze({
  grudge: '记仇',
  clingy: '黏人',
  guarded: '嘴硬',
  playful: '爱玩梗',
  pride: '自尊',
  empathy: '共情',
} as const)

export const ALL_TRAITS = Object.freeze([...TRAITS, ...CHAR_TRAITS] as const)

export type Trait = (typeof TRAITS)[number]
export type CharTrait = (typeof CHAR_TRAITS)[number]
export type TraitKey = (typeof ALL_TRAITS)[number]

export interface TraitPhrase {
  readonly 高: string
  readonly 低: string
}

/** Original behavioral anchoring descriptions for high/low extremes across all 11 dimensions. */
export const TRAIT_PHRASES: Readonly<Record<TraitKey, TraitPhrase & Partial<Record<'中', string>>>> = Object.freeze({
  O: Object.freeze({
    高: '好奇心旺盛，乐于探索新观点和新鲜事物',
    低: '更信赖熟悉的做法和话题，对新奇变化兴致不高',
  }),
  C: Object.freeze({
    高: '做事有条理且守诺，答应过的事会认真跟到底',
    低: '行事随性自由，不太喜欢被计划和条框束缚',
  }),
  E: Object.freeze({
    高: '精力充沛，喜欢主动开启话题、融入热闹氛围',
    低: '性格偏安静，不太主动找人搭腔，更喜欢默默观察',
  }),
  A: Object.freeze({
    高: '待人温和体贴，习惯顺着对方说话，少与人起争执',
    低: '有自己的主见，遇到不认同的说法会直接反驳',
  }),
  N: Object.freeze({
    高: '内心敏感细腻，一点风吹草动就容易牵动情绪',
    低: '心态平和笃定，不容易被几句话扰乱情绪',
  }),
  grudge: Object.freeze({
    高: '心里有疙瘩会记很久，就算对方道了歉也未必立刻翻篇',
    低: '心宽大度，不快的事转头就忘，很少往心里积攒',
  }),
  clingy: Object.freeze({
    高: '格外在意对方的回应速度，久等不到消息会失落牵挂',
    低: '边界感清晰，即使对方忙得顾不上回复也不大会失落',
  }),
  guarded: Object.freeze({
    高: '明明心里已经软下来了，嘴上还是不肯服软示弱',
    低: '情绪和想法都摆在明面上，高兴或难过都直白坦露',
  }),
  playful: Object.freeze({
    高: '擅长接梗和打趣互动，被朋友调侃几句也不放在心上',
    低: '说话比较正经实诚，遇到玩笑式调侃有时会认真起来',
  }),
  pride: Object.freeze({
    高: '骨子里很有自信底气，挨骂不易动摇，受夸也觉得自然',
    低: '容易自我反省或怀疑，受到肯定会雀跃，挨批则难受良久',
  }),
  empathy: Object.freeze({
    高: '感知他人情绪的能力很强，听到倾诉会感同身受并先安慰',
    低: '面对别人的情绪波动时能保持抽离和冷静，不易被带偏',
  }),
})

export interface TraitEntry {
  factory: number
  value: number
  locked: boolean
}

export interface TraitManifest {
  band: string
  text: string
}

export interface Preference {
  id: string | null
  text: string
  valence: 'like' | 'dislike'
  strength: number
  keywords: string[]
  hits: number
  lastHitAt: number
}

export interface PreferenceLike {
  readonly id?: string | null
  readonly valence?: 'like' | 'dislike'
  readonly strength?: number
}

export interface Belief {
  text: string
  status: string
  type?: string
  prior?: boolean
  keys?: string[]
}

export interface Core {
  version: number
  traits: Record<Trait, TraitEntry>
  character: Record<CharTrait, TraitEntry>
  manifests: Record<string, TraitManifest>
  prefs: Preference[]
  beliefs: Belief[]
  confirmedAt: number | null
}

export interface Modulation {
  negGain: number
  negHalfLifeMul: number
  soothe: number
  missGain: number
  noveltyGain: number
  teaseNegMul: number
  insultGain: number
  praiseGain: number
  empathyGain: number
  expectMul: number
  expressThreshold: number
}

export interface TraitViewEntry {
  key: TraitKey
  name: string
  group: 'big5' | 'char'
  factory: number
  value: number
  locked: boolean
  level: string
  band: '高' | '中' | '低'
  phrase: string
  phraseSource: 'manifest' | 'generic' | ''
}

const BIG5_SET: ReadonlySet<string> = new Set(TRAITS)
const LEADING_PREF_PREFIX = /^(最讨厌|很讨厌|不喜欢|讨厌|最恨|喜欢)/
const PUNCT_ONLY_RE = /^[\p{P}\p{S}\s]+$/u
const EXPLICIT_PREF_ID_RE = /^p\d+$/

/** Creates a v2 Core personality document with clamped 0–100 factory/current values. */
export function newCore(
  factory: Partial<Record<Trait, number>> = {},
  character: Partial<Record<CharTrait, number>> = {},
): Core {
  const traits = {} as Record<Trait, TraitEntry>
  for (const key of TRAITS) {
    const score = clamp(finiteOr(factory[key], 50), 0, 100)
    traits[key] = { factory: score, value: score, locked: false }
  }
  const chars = {} as Record<CharTrait, TraitEntry>
  for (const key of CHAR_TRAITS) {
    const score = clamp(finiteOr(character[key], 50), 0, 100)
    chars[key] = { factory: score, value: score, locked: false }
  }
  return {
    version: 2,
    traits,
    character: chars,
    manifests: {},
    prefs: [],
    beliefs: [],
    confirmedAt: null,
  }
}

function hasCompleteCharTraits(doc: Record<string, unknown>): boolean {
  if (!isPlainObject(doc.character)) return false
  for (const key of CHAR_TRAITS) {
    const entry = doc.character[key]
    if (!isPlainObject(entry)) return false
    if (typeof entry.factory !== 'number' || !Number.isFinite(entry.factory)) return false
    if (typeof entry.value !== 'number' || !Number.isFinite(entry.value)) return false
  }
  return true
}

/** Idempotently upgrades v1 or partial Core documents to v2; returns null for non-objects. */
export function upgradeCore(core: unknown): Core | null {
  if (!isPlainObject(core)) return null
  if (core.version === 2 && hasCompleteCharTraits(core) && isPlainObject(core.manifests) && Array.isArray(core.prefs)) {
    return core as unknown as Core
  }
  const rawChars = isPlainObject(core.character) ? core.character : {}
  const character = {} as Record<CharTrait, TraitEntry>
  for (const key of CHAR_TRAITS) {
    const entry = isPlainObject(rawChars[key]) ? rawChars[key] : {}
    const f = clamp(finiteOr(entry.factory, 50), 0, 100)
    character[key] = {
      factory: f,
      value: clamp(finiteOr(entry.value, f), 0, 100),
      locked: Boolean(entry.locked),
    }
  }
  return {
    ...core,
    version: 2,
    character,
    manifests: isPlainObject(core.manifests) ? { ...core.manifests } : {},
    prefs: Array.isArray(core.prefs) ? core.prefs.map((p) => (isPlainObject(p) ? { ...p } : p)) : [],
  } as unknown as Core
}

/** Extracts all 11 trait scores into a flat map, defaulting missing entries to 50. */
export function traitValues(core: unknown): Record<TraitKey, number> {
  const result = {} as Record<TraitKey, number>
  const doc = isPlainObject(core) ? core : {}
  const traits = isPlainObject(doc.traits) ? doc.traits : {}
  const character = isPlainObject(doc.character) ? doc.character : {}
  for (const key of ALL_TRAITS) {
    const entry = BIG5_SET.has(key) ? traits[key] : character[key]
    result[key] = finiteOr(isPlainObject(entry) ? entry.value : undefined, 50)
  }
  return result
}

function normalizedOffset(values: unknown, key: TraitKey): number {
  const doc = isPlainObject(values) ? values : {}
  return (clamp(finiteOr(doc[key], 50), 0, 100) - 50) / 50
}

function zeroSafe(n: number): number {
  return n === 0 ? 0 : n
}

/**
 * Computes baseline PAD mood from Big Five scores using Mehrabian (1996) linear mapping
 * scaled by 0.5, with emotional stability S = -N.
 */
export function padBaseline(values: unknown): Pad {
  const O = normalizedOffset(values, 'O')
  const C = normalizedOffset(values, 'C')
  const E = normalizedOffset(values, 'E')
  const A = normalizedOffset(values, 'A')
  const S = -normalizedOffset(values, 'N')
  const scale = 0.5
  return {
    p: zeroSafe(clamp(scale * (0.21 * E + 0.59 * A + 0.19 * S), -1, 1)),
    a: zeroSafe(clamp(scale * (0.15 * O + 0.30 * A - 0.57 * S), -1, 1)),
    d: zeroSafe(clamp(scale * (0.25 * O + 0.17 * C + 0.60 * E - 0.32 * A), -1, 1)),
  }
}

/** Computes the 11 kinetic emotional modulation multipliers from current trait values. */
export function modulation(values: unknown): Modulation {
  const nN = normalizedOffset(values, 'N')
  const nO = normalizedOffset(values, 'O')
  const nGrudge = normalizedOffset(values, 'grudge')
  const nGuarded = normalizedOffset(values, 'guarded')
  const nClingy = normalizedOffset(values, 'clingy')
  const nPlayful = normalizedOffset(values, 'playful')
  const nPride = normalizedOffset(values, 'pride')
  const nEmpathy = normalizedOffset(values, 'empathy')
  return {
    negGain: 1 + 0.5 * nN,
    negHalfLifeMul: 1 + 0.6 * nGrudge,
    soothe: 0.5 - 0.4 * nGuarded,
    missGain: 1 + 0.5 * nClingy,
    noveltyGain: 1 + 0.5 * nO,
    teaseNegMul: 1 - 0.5 * nPlayful,
    insultGain: 1 - 0.4 * nPride,
    praiseGain: 1 - 0.3 * nPride,
    empathyGain: 1 + 0.6 * nEmpathy,
    expectMul: 1 - 0.4 * nClingy,
    expressThreshold: -0.15 - 0.15 * nGuarded,
  }
}

function stripPreferencePrefix(raw: string): string {
  const match = raw.match(LEADING_PREF_PREFIX)
  if (!match) return raw
  const remainder = raw.slice(match[0].length).trim()
  return remainder.length > 0 ? remainder : raw
}

/** Validates, normalizes, deduplicates keywords, caps at 12, and assigns p1..pN IDs in two passes. */
export function normalizePrefs(list: unknown): Preference[] {
  if (!Array.isArray(list)) return []
  const cleaned: Preference[] = []
  const reservedIds = new Set<string>()

  for (const item of list) {
    if (!isPlainObject(item)) continue
    const text = stripPreferencePrefix(String(item.text ?? '').trim())
    if (text.length === 0 || text.length > 16) continue
    if (item.valence !== 'like' && item.valence !== 'dislike') continue

    const rawStrength = finiteOr(item.strength, Number.NaN)
    const strength = Number.isFinite(rawStrength) ? clamp(rawStrength, 0.3, 1) : 0.6

    const keywordSet = new Set<string>()
    if (Array.isArray(item.keywords)) {
      for (const kw of item.keywords) {
        const trimmed = String(kw ?? '').trim()
        if (trimmed.length >= 2 && trimmed.length <= 8 && !PUNCT_ONLY_RE.test(trimmed)) {
          keywordSet.add(trimmed)
          if (keywordSet.size >= 3) break
        }
      }
    }

    const explicitId = typeof item.id === 'string' && EXPLICIT_PREF_ID_RE.test(item.id) && !reservedIds.has(item.id)
      ? item.id
      : null
    if (explicitId !== null) reservedIds.add(explicitId)

    cleaned.push({
      id: explicitId,
      text,
      valence: item.valence,
      strength,
      keywords: [...keywordSet],
      hits: finiteOr(item.hits, 0),
      lastHitAt: finiteOr(item.lastHitAt, 0),
    })
    if (cleaned.length >= 12) break
  }

  let seq = 1
  for (const pref of cleaned) {
    if (pref.id !== null) continue
    while (reservedIds.has(`p${seq}`)) seq += 1
    pref.id = `p${seq}`
    reservedIds.add(pref.id)
  }

  return cleaned
}

function levelLabel(score: number): string {
  if (score >= 75) return '很高'
  if (score >= 60) return '偏高'
  if (score > 40) return '中等'
  if (score > 25) return '偏低'
  return '很低'
}

function resolvePhrase(
  manifests: Record<string, unknown>,
  key: TraitKey,
  score: number,
): { readonly text: string; readonly source: 'manifest' | 'generic' | '' } {
  const b = band(score)
  const manifest = manifests[key]
  if (isPlainObject(manifest) && manifest.band === b && typeof manifest.text === 'string' && manifest.text.length > 0) {
    return { text: manifest.text, source: 'manifest' }
  }
  const fallback = TRAIT_PHRASES[key][b]
  if (fallback !== undefined && fallback.length > 0) {
    return { text: fallback, source: 'generic' }
  }
  return { text: '', source: '' }
}

/** Builds the ordered 11-entry personality view shared by rendering and UI consumers. */
export function traitView(core: unknown): TraitViewEntry[] {
  const values = traitValues(core)
  const doc = isPlainObject(core) ? core : {}
  const traits = isPlainObject(doc.traits) ? doc.traits : {}
  const character = isPlainObject(doc.character) ? doc.character : {}
  const manifests = isPlainObject(doc.manifests) ? doc.manifests : {}

  return ALL_TRAITS.map((key) => {
    const group: 'big5' | 'char' = BIG5_SET.has(key) ? 'big5' : 'char'
    const entry = group === 'big5' ? traits[key] : character[key]
    const value = values[key]
    const phrase = resolvePhrase(manifests, key, value)
    return {
      key,
      name: group === 'big5' ? TRAIT_NAMES[key as Trait] : CHAR_NAMES[key as CharTrait],
      group,
      factory: finiteOr(isPlainObject(entry) ? entry.factory : undefined, 50),
      value,
      locked: isPlainObject(entry) ? Boolean(entry.locked) : false,
      level: levelLabel(value),
      band: band(value),
      phrase: phrase.text,
      phraseSource: phrase.source,
    }
  })
}

function formatTraitLine(entry: TraitViewEntry): string {
  return entry.phrase.length > 0
    ? `- ${entry.name}${entry.level}：${entry.phrase}`
    : `- ${entry.name}${entry.level}`
}

/** Renders cache-stable behavioral persona prose without dynamic numeric scores or hit counts. */
export function renderCore(core: Core): string {
  const view = traitView(core)
  const lines = ['【你现在的性格】（会随经历慢慢变化；按它自然表现，不要说出来）']

  for (const entry of view) {
    if (entry.group === 'big5') lines.push(formatTraitLine(entry))
  }

  const nonMidHabits = view
    .map((entry, idx) => ({ entry, idx }))
    .filter(({ entry }) => entry.group === 'char' && entry.band !== '中')
    .sort((a, b) => Math.abs(b.entry.value - 50) - Math.abs(a.entry.value - 50) || a.idx - b.idx)

  if (nonMidHabits.length > 0) {
    lines.push('相处习惯：')
    for (const { entry } of nonMidHabits) lines.push(formatTraitLine(entry))
  }

  const rawPrefs = Array.isArray(core?.prefs)
    ? core.prefs.filter((p): p is Preference => isPlainObject(p) && typeof p.text === 'string' && p.text.length > 0)
    : []

  const topByStrength = (valence: 'like' | 'dislike'): Preference[] =>
    rawPrefs
      .filter((p) => p.valence === valence)
      .sort((a, b) => finiteOr(b.strength, 0) - finiteOr(a.strength, 0))
      .slice(0, 3)

  const likes = topByStrength('like')
  const dislikes = topByStrength('dislike')

  if (likes.length > 0) {
    lines.push(`你喜欢：${likes.map((p) => p.text).join('、')}`)
  }
  if (dislikes.length > 0) {
    lines.push(`你讨厌：${dislikes.map((p) => (finiteOr(p.strength, 0) >= 0.8 ? `${p.text}（雷点）` : p.text)).join('、')}`)
  }

  const acceptedBeliefs = Array.isArray(core?.beliefs)
    ? core.beliefs
        .filter((b): b is Belief => isPlainObject(b) && b.status === 'accepted' && typeof b.text === 'string')
        .slice(0, 10)
        .map((b) => `- ${b.text}`)
    : []

  if (acceptedBeliefs.length > 0) {
    lines.push(`你对自己的看法：\n${acceptedBeliefs.join('\n')}`)
  }

  return lines.join('\n')
}
