import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ALL_TRAITS, CHAR_NAMES, CHAR_TRAITS, CLOSE_STAGES, DEFAULT_SETTINGS, KIND_EFFECTS, KINDS, LABELS,
  NEGATIVE_LABELS, STAGE_COEF, TRAIT_NAMES, TRAIT_PHRASES, TRAITS,
  agoBucket, applyImpulse, applyRelation, band, clamp, computeMoodSnapshot, dayOf, decayEmotion,
  expressedPad, halfLifeFactor, impulseFromAppraisal, inQuiet, mergeSettings, modulation, moodWord,
  newCore, newEmotion, newPerson, normalizePrefs, padBaseline, renderCore, renderNow, renderRelation,
  soothe, stageOf, tierWord, traitValues, traitView, upgradeCore,
  type Emotion, type Modulation, type Person, type Preference, type TraitKey, type TraitViewEntry,
} from '../../src/persona-roles/persona-state.ts'

const approx = (actual: number, expected: number, msg = ''): void => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg}: got ${actual}, expected ${expected}`)
}

const S = mergeSettings({})
const T0 = Date.parse('2026-11-10T14:00:00')
const MIN = 60_000

test('DEFAULT_SETTINGS omits model/baseUrl and freezes only the top level', () => {
  assert.equal('model' in DEFAULT_SETTINGS.appraisal, false)
  assert.equal('baseUrl' in DEFAULT_SETTINGS.appraisal, false)
  assert.equal(Object.isFrozen(DEFAULT_SETTINGS), true)
  assert.equal(Object.isFrozen(DEFAULT_SETTINGS.appraisal), false)
  assert.equal(Object.isFrozen(DEFAULT_SETTINGS.appraisal.groupBatch), false)
  assert.equal(Object.isFrozen(DEFAULT_SETTINGS.emotion), false)
  assert.equal(Object.isFrozen(DEFAULT_SETTINGS.growth), false)
  assert.equal(Object.isFrozen(DEFAULT_SETTINGS.express), false)
  assert.equal(Object.isFrozen(DEFAULT_SETTINGS.express.expectMinutes), false)
})

test('mergeSettings handles empty input, two-level overrides, and isolation from defaults', () => {
  const empty = mergeSettings()
  assert.equal(empty.appraisal.dailyLimit, 400)
  empty.appraisal.dailyLimit = 99
  assert.equal(DEFAULT_SETTINGS.appraisal.dailyLimit, 400)

  const custom = mergeSettings({
    inject: false,
    appraisal: { dailyLimit: 50, groupBatch: { minutes: 12 } },
  })
  assert.equal(custom.inject, false)
  assert.equal(custom.appraisal.dailyLimit, 50)
  assert.equal(custom.appraisal.groupBatch.minutes, 12)
  assert.equal(custom.appraisal.groupBatch.messages, 20)
  assert.equal(mergeSettings(null).enabled, true)
})

test('clamp, band, halfLifeFactor, dayOf, and inQuiet handle boundaries and wrap-around', () => {
  assert.equal(clamp(15, 0, 10), 10)
  assert.equal(clamp(-3, 0, 10), 0)
  assert.equal(clamp(Number.NaN, 2, 8), 2)

  assert.equal(band(60), '高')
  assert.equal(band(59.9), '中')
  assert.equal(band(40.1), '中')
  assert.equal(band(40), '低')
  assert.equal(band(undefined), '中')
  assert.equal(band(''), '中')

  assert.equal(halfLifeFactor(0, 45), 1)
  assert.equal(halfLifeFactor(-100, 45), 1)
  assert.equal(halfLifeFactor(45 * MIN, 0), 1)
  approx(halfLifeFactor(45 * MIN, 45), 0.5)
  approx(halfLifeFactor(90 * MIN, 45), 0.25)

  assert.equal(dayOf(Date.parse('2026-03-05T09:15:00')), '2026-03-05')

  assert.equal(inQuiet(Date.parse('2026-11-10T00:00:00'), S), true)
  assert.equal(inQuiet(Date.parse('2026-11-10T07:59:00'), S), true)
  assert.equal(inQuiet(Date.parse('2026-11-10T08:00:00'), S), false)

  const wrap = mergeSettings({ express: { quiet: [22, 6] } })
  assert.equal(inQuiet(Date.parse('2026-11-10T23:00:00'), wrap), true)
  assert.equal(inQuiet(Date.parse('2026-11-10T03:00:00'), wrap), true)
  assert.equal(inQuiet(Date.parse('2026-11-10T06:00:00'), wrap), false)
  assert.equal(inQuiet(Date.parse('2026-11-10T15:00:00'), wrap), false)
})

test('newCore, upgradeCore, and traitValues initialize, upgrade idempotently, and fall back to 50', () => {
  const c = newCore({ O: 130, C: -10, E: 35 }, { grudge: 82, empathy: -5 })
  assert.equal(c.version, 2)
  assert.equal(c.traits.O.factory, 100)
  assert.equal(c.traits.C.value, 0)
  assert.equal(c.traits.A.value, 50)
  assert.equal(c.character.grudge.value, 82)
  assert.equal(c.character.empathy.factory, 0)
  assert.equal(c.character.pride.value, 50)

  assert.equal(upgradeCore(null), null)
  assert.equal(upgradeCore(['not-object']), null)

  const v1 = {
    version: 1,
    traits: newCore({ O: 72 }).traits,
    beliefs: [{ type: 'prior', text: '坦诚', status: 'accepted' }],
    confirmedAt: 999,
  }
  const upgraded = upgradeCore(v1)!
  assert.equal(upgraded.version, 2)
  assert.equal(upgraded.confirmedAt, 999)
  assert.equal(upgraded.traits.O.value, 72)
  assert.deepEqual(Object.keys(upgraded.character), [...CHAR_TRAITS])
  assert.deepEqual(upgraded.manifests, {})
  assert.deepEqual(upgraded.prefs, [])
  assert.strictEqual(upgradeCore(upgraded), upgraded)

  const partial = upgradeCore({
    version: 2,
    traits: v1.traits,
    character: { pride: { factory: 75, value: 68, locked: true }, grudge: { factory: 'bad' } },
    manifests: { O: { band: '高', text: 'custom' } },
  })!
  assert.deepEqual(partial.character.pride, { factory: 75, value: 68, locked: true })
  assert.deepEqual(partial.character.grudge, { factory: 50, value: 50, locked: false })
  assert.deepEqual(partial.prefs, [])

  const vals = traitValues({ traits: { O: { value: 88 }, C: { value: null } }, character: { empathy: { value: 77 } } })
  assert.deepEqual(Object.keys(vals), [...ALL_TRAITS])
  assert.equal(vals.O, 88)
  assert.equal(vals.C, 50)
  assert.equal(vals.empathy, 77)
  assert.equal(traitValues(null).N, 50)
})

test('padBaseline and modulation follow Mehrabian mapping and 11-trait kinetic bounds', () => {
  const zero = padBaseline({ O: 50, C: 50, E: 50, A: 50, N: 50 })
  assert.deepEqual(zero, { p: 0, a: 0, d: 0 })
  assert.equal(Object.is(zero.a, -0), false)
  assert.ok(padBaseline({ A: 100 }).p > 0)
  assert.ok(padBaseline({ N: 100 }).a > 0)
  assert.ok(padBaseline({ E: 100 }).d > 0)
  assert.deepEqual(padBaseline({ grudge: 100, guarded: 0 }), zero)

  assert.deepEqual(modulation({}), {
    negGain: 1,
    negHalfLifeMul: 1,
    soothe: 0.5,
    missGain: 1,
    noveltyGain: 1,
    teaseNegMul: 1,
    insultGain: 1,
    praiseGain: 1,
    empathyGain: 1,
    expectMul: 1,
    expressThreshold: -0.15,
  })

  const matrix: Array<[keyof Modulation, TraitKey, [number, number, number]]> = [
    ['negGain', 'N', [0.5, 1, 1.5]],
    ['noveltyGain', 'O', [0.5, 1, 1.5]],
    ['negHalfLifeMul', 'grudge', [0.4, 1, 1.6]],
    ['soothe', 'guarded', [0.9, 0.5, 0.1]],
    ['expressThreshold', 'guarded', [0, -0.15, -0.3]],
    ['missGain', 'clingy', [0.5, 1, 1.5]],
    ['expectMul', 'clingy', [1.4, 1, 0.6]],
    ['teaseNegMul', 'playful', [1.5, 1, 0.5]],
    ['insultGain', 'pride', [1.4, 1, 0.6]],
    ['praiseGain', 'pride', [1.3, 1, 0.7]],
    ['empathyGain', 'empathy', [0.4, 1, 1.6]],
  ]
  for (const [modKey, trait, [lo, mid, hi]] of matrix) {
    approx(modulation({ [trait]: 0 })[modKey], lo, `${modKey}@0`)
    approx(modulation({ [trait]: 50 })[modKey], mid, `${modKey}@50`)
    approx(modulation({ [trait]: 100 })[modKey], hi, `${modKey}@100`)
  }
})

test('normalizePrefs strips prefixes, deduplicates keywords, caps at 12, and assigns p1..pN in two passes', () => {
  assert.deepEqual(normalizePrefs(null), [])
  assert.deepEqual(normalizePrefs('bad'), [])

  const res = normalizePrefs([
    { id: 'p2', text: '最讨厌香菜', valence: 'dislike', strength: 0.1, keywords: ['!', '菜', '香菜', '香菜', '太长了九个字以上的词', '绿叶菜', '调味品'] },
    { id: 'p2', text: '喜欢晴天', valence: 'like', strength: 5 },
    { id: 'bad', text: '讨厌', valence: 'dislike' },
    { text: '喜欢', valence: 'like' },
    { text: '超长条目'.repeat(5), valence: 'like' },
    { text: '无效情绪', valence: 'neutral' },
    null,
    { id: 'p1', text: '  看电影  ', valence: 'like', hits: 3, lastHitAt: 555 },
  ])
  assert.equal(res.length, 5)
  assert.deepEqual(res.map((p) => p.id), ['p2', 'p3', 'p4', 'p5', 'p1'])
  assert.equal(res[0]!.text, '香菜')
  assert.equal(res[0]!.strength, 0.3)
  assert.deepEqual(res[0]!.keywords, ['香菜', '绿叶菜', '调味品'])
  assert.equal(res[1]!.text, '晴天')
  assert.equal(res[1]!.strength, 1)
  assert.equal(res[2]!.text, '讨厌')
  assert.equal(res[3]!.text, '喜欢')
  assert.equal(res[4]!.text, '看电影')
  assert.equal(res[4]!.hits, 3)
  assert.equal(res[4]!.lastHitAt, 555)

  const capped = normalizePrefs(Array.from({ length: 15 }, (_, i) => ({ text: `项${i}`, valence: 'like' })))
  assert.equal(capped.length, 12)
  assert.equal(capped[11]!.text, '项11')
})

test('traitView and renderCore render original phrases, manifests, habits, prefs, and accepted beliefs safely', () => {
  assert.deepEqual([...TRAITS], ['O', 'C', 'E', 'A', 'N'])
  assert.deepEqual(Object.keys(TRAIT_NAMES), [...TRAITS])
  assert.deepEqual(Object.keys(CHAR_NAMES), [...CHAR_TRAITS])
  assert.deepEqual(Object.keys(TRAIT_PHRASES).sort(), [...ALL_TRAITS].sort())
  for (const key of ALL_TRAITS) {
    assert.ok(TRAIT_PHRASES[key].高.length > 0 && TRAIT_PHRASES[key].低.length > 0, key)
  }

  const c = newCore({ O: 78, C: 50, E: 30, A: 85, N: 20 }, { grudge: 70, guarded: 90, clingy: 30, playful: 55 })
  c.manifests = {
    O: { band: '中', text: 'band mismatch ignored' },
    A: { band: '高', text: '定制高宜人描述' },
    grudge: { band: '高', text: '定制记仇描述' },
  }
  c.prefs = [
    { id: 'p1', text: '冰美式', valence: 'like', strength: 0.9, keywords: [], hits: 42, lastHitAt: 1 },
    { id: 'p2', text: '散步', valence: 'like', strength: 0.5, keywords: [], hits: 0, lastHitAt: 0 },
    { id: 'p3', text: '猫', valence: 'like', strength: 0.7, keywords: [], hits: 0, lastHitAt: 0 },
    { id: 'p4', text: '早起', valence: 'like', strength: 0.4, keywords: [], hits: 0, lastHitAt: 0 },
    { id: 'p5', text: '被放鸽子', valence: 'dislike', strength: 0.85, keywords: ['鸽子'], hits: 9, lastHitAt: 2 },
    { id: 'p6', text: '噪音', valence: 'dislike', strength: 0.5, keywords: [], hits: 0, lastHitAt: 0 },
  ]
  c.beliefs = [
    { text: '我其实很重情义', status: 'accepted' },
    { text: '未采纳信念', status: 'candidate' },
  ]

  const view = traitView(c)
  assert.deepEqual(view.map((v) => v.key), [...ALL_TRAITS])
  const byKey = Object.fromEntries(view.map((v) => [v.key, v])) as Record<TraitKey, TraitViewEntry>
  assert.equal(byKey.O.phraseSource, 'generic')
  assert.equal(byKey.O.phrase, TRAIT_PHRASES.O.高)
  assert.equal(byKey.C.phraseSource, '')
  assert.equal(byKey.A.phraseSource, 'manifest')
  assert.equal(byKey.A.phrase, '定制高宜人描述')

  const rendered = renderCore(c)
  assert.ok(rendered.startsWith('【你现在的性格】'))
  assert.match(rendered, /^- 开放很高：/m)
  assert.match(rendered, /^- 尽责中等$/m)
  assert.match(rendered, /^- 宜人很高：定制高宜人描述$/m)
  assert.doesNotMatch(rendered, /band mismatch ignored/)
  assert.doesNotMatch(rendered, /爱玩梗/)
  assert.match(rendered, /^你喜欢：冰美式、猫、散步$/m)
  assert.doesNotMatch(rendered, /早起/)
  assert.match(rendered, /^你讨厌：被放鸽子（雷点）、噪音$/m)
  assert.doesNotMatch(rendered, /42|hits|p5/)
  assert.match(rendered, /我其实很重情义/)
  assert.doesNotMatch(rendered, /未采纳信念/)

  // Malformed prefs/beliefs arrays on core do not crash renderCore.
  const corruptedCore = { ...newCore({}), prefs: [null as unknown as Preference], beliefs: [null as never] }
  assert.match(renderCore(corruptedCore), /^【你现在的性格】/)
})

test('decayEmotion, applyImpulse, and soothe enforce half-life, hourly budget, top-3 labels, and history cap', () => {
  assert.equal(LABELS.length, 11)
  assert.equal(KINDS.length, 10)
  assert.equal(NEGATIVE_LABELS.has('委屈'), true)
  assert.equal(KIND_EFFECTS.insult.label, '生气')

  const em = newEmotion(T0)
  applyImpulse(em, { key: 'private:1', delta: { p: -1 }, label: { name: '委屈', v: 0.4, cause: '等太久了' } }, T0, S)
  approx(em.scenes['private:1']!.p, -0.12)
  approx(em.core.p, -0.12 * 0.4)
  assert.equal(em.labels.length, 1)
  assert.equal(em.history.length, 1)

  // Budget exhaustion caps cumulative core drift within one hour, then resets next hour.
  for (let i = 0; i < 40; i++) {
    applyImpulse(em, { key: 'private:1', delta: { p: -1, a: 1, d: -1 } }, T0 + i * 1000, S)
  }
  const coreL1 = Math.abs(em.core.p) + Math.abs(em.core.a) + Math.abs(em.core.d)
  assert.ok(coreL1 <= S.emotion.coreHourlyBudget + 1e-9)

  // Next hour resets budget and allows core change again.
  const prevCoreP = em.core.p
  applyImpulse(em, { key: 'private:1', delta: { p: 1 } }, T0 + 3_600_000, S)
  assert.ok(em.core.p > prevCoreP)

  // Labels merge per (name, key), cap at labelCap / labelCapStrong, and keep top 3.
  const emLabels = newEmotion(T0)
  applyImpulse(emLabels, { key: 'k', label: { name: '生气', v: 0.5 } }, T0, S)
  applyImpulse(emLabels, { key: 'k', label: { name: '生气', v: 0.5, strong: true } }, T0, S)
  assert.equal(emLabels.labels[0]!.v, S.emotion.labelCapStrong)
  for (const name of ['开心', '得意', '感动']) {
    applyImpulse(emLabels, { key: 'k', label: { name, v: 0.25 } }, T0, S)
  }
  assert.equal(emLabels.labels.length, 3)
  assert.equal(emLabels.labels[0]!.name, '生气')

  // Soothe only attenuates negative labels in matching key, leaving positive labels untouched.
  const happyBefore = emLabels.labels.find((l) => l.name === '开心')!.v
  soothe(emLabels, 'other', T0, S, modulation({ guarded: 0 }))
  assert.equal(emLabels.labels[0]!.v, S.emotion.labelCapStrong)
  soothe(emLabels, 'k', T0, S, modulation({ guarded: 0 }))
  assert.ok(emLabels.labels[0]!.v < S.emotion.labelCapStrong)
  assert.equal(emLabels.labels.find((l) => l.name === '开心')!.v, happyBefore)

  // Decay removes negligible scenes and labels.
  decayEmotion(em, T0 + 1000 * MIN, S)
  assert.equal(em.scenes['private:1'], undefined)
})

test('impulseFromAppraisal handles modulation, preference triggers, and null pad fallback', () => {
  const mod = modulation({})
  const withNull = impulseFromAppraisal({ kind: 'praise', pad: null }, mod, S)
  const withoutPad = impulseFromAppraisal({ kind: 'praise' }, mod, S)
  assert.deepEqual(withNull, withoutPad)

  const pad = { p: 1, a: 1, d: 0 }
  const prefs = [
    { id: 'p1', valence: 'dislike' as const, strength: 1 },
    { id: 'p2', valence: 'like' as const, strength: 0.6 },
  ]
  const hitDislike = impulseFromAppraisal({ kind: 'tease', target: 'me', intensity: 0.5, pad, trigger: 'p1' }, mod, S, prefs)
  assert.deepEqual(pad, { p: 1, a: 1, d: 0 }, 'must not mutate input pad')
  assert.ok(hitDislike.delta.p < 0)
  assert.equal(hitDislike.label!.name, '生气')
  assert.equal(hitDislike.label!.strong, true)

  const me = impulseFromAppraisal({ kind: 'insult', target: 'me', intensity: 0.8 }, mod, S)
  const other = impulseFromAppraisal({ kind: 'insult', target: 'other', intensity: 0.8 }, mod, S)
  approx(other.delta.p, me.delta.p * 0.4)
  approx(other.label!.v, me.label!.v * 0.4)

  const hitLike = impulseFromAppraisal({ kind: 'tease', target: 'other', intensity: 0.5, pad: { p: -1, a: 0, d: 0 }, emotion: { label: '难过' }, trigger: 'p2' }, mod, S, prefs)
  assert.ok(hitLike.delta.p > 0)
  assert.equal(hitLike.label!.name, '开心')

  const ventHigh = impulseFromAppraisal({ kind: 'vent', target: 'me', intensity: 0.5 }, modulation({ empathy: 100 }), S)
  const ventLow = impulseFromAppraisal({ kind: 'vent', target: 'me', intensity: 0.5 }, modulation({ empathy: 0 }), S)
  approx(ventHigh.delta.p, ventLow.delta.p * 4)
})

test('computeMoodSnapshot matches single-pass decay with expressedPad and renderNow without cloning or mutating', () => {
  assert.equal(tierWord(0.19), '')
  assert.equal(tierWord(0.25), '一点')
  assert.equal(tierWord(0.45), '有点')
  assert.equal(tierWord(0.7), '很')

  assert.equal(moodWord(0.35), '心情不错')
  assert.equal(moodWord(0.15), '心情还行')
  assert.equal(moodWord(0), '心情平平')
  assert.equal(moodWord(-0.2), '心情偏低')
  assert.equal(moodWord(-0.4), '心情很差')

  assert.equal(agoBucket(5 * MIN), '刚刚')
  assert.equal(agoBucket(20 * MIN), '半小时内')
  assert.equal(agoBucket(45 * MIN), '一小时内')
  assert.equal(agoBucket(90 * MIN), '几小时前')

  const core = newCore({ E: 80, A: 75 }, { grudge: 80 })
  const em: Emotion = newEmotion(T0)
  applyImpulse(em, { key: 'group:1', delta: { p: -0.1, a: 0.1, d: 0 }, label: { name: '委屈', v: 0.5, cause: '被忽视' } }, T0, S)
  applyImpulse(em, { key: '', delta: { p: 0.1, a: 0.12, d: 0.05 }, label: { name: '开心', v: 0.45, cause: '收到礼物' } }, T0, S)

  const evalTime = T0 + 15 * MIN
  const beforeJson = JSON.stringify(em)
  const snap = computeMoodSnapshot(em, core, evalTime)
  assert.equal(JSON.stringify(em), beforeJson, 'computeMoodSnapshot must not mutate emotion')

  const values = traitValues(core)
  const decayed = decayEmotion(structuredClone(em), evalTime, S, modulation(values))
  const expectedPad = expressedPad(decayed, '', values, S)
  const expectedLine = renderNow(em, '', values, S, evalTime)

  approx(snap.p, expectedPad.p)
  approx(snap.a, expectedPad.a)
  approx(snap.d, expectedPad.d)
  assert.equal(snap.word, moodWord(expectedPad.p))
  assert.equal(snap.line, expectedLine)
  assert.equal(snap.at, evalTime)
  assert.doesNotMatch(snap.line, /被忽视/, 'other session cause must not leak')
  assert.match(snap.line, /收到礼物，半小时内/)
})

test('stageOf, applyRelation, and renderRelation cover stages, trust caps, channel scoping, and missing offsets fallback', () => {
  assert.equal(STAGE_COEF.朋友, 1)
  assert.equal(CLOSE_STAGES.has('熟人'), true)
  assert.equal(stageOf(null), '陌生')
  assert.equal(stageOf({ familiarity: 12, intimacy: 15 }), '认识')
  assert.equal(stageOf({ familiarity: 12, intimacy: 30 }), '熟人')
  assert.equal(stageOf({ familiarity: 12, intimacy: 50 }), '朋友')
  assert.equal(stageOf({ familiarity: 12, intimacy: 80 }), '亲近')

  const p = newPerson(T0)
  p.lastSeenAt = T0 - 24 * 3_600_000
  applyRelation(p, { kind: 'vent', target: 'me', intensity: 0.5 }, T0)
  assert.equal(p.trust, 33)
  for (let i = 0; i < 4; i++) {
    applyRelation(p, { kind: 'share', target: 'me', intensity: 0.5, source: 'rules', trustDelta: 4 }, T0 + i + 1)
  }
  assert.equal(p.trust, 34, 'daily trust gain capped at +4')

  // Model-sourced trustDelta is ignored; rules-sourced negative trustDelta + insults cap at -12/day.
  applyRelation(p, { kind: 'normal', target: 'me', source: 'model', trustDelta: -5 }, T0 + 10)
  assert.equal(p.trust, 34)
  for (let i = 0; i < 4; i++) {
    applyRelation(p, { kind: 'insult', target: 'me', intensity: 0.8 }, T0 + 20 + i)
  }
  assert.equal(p.trust, 22, 'daily trust loss capped at -12')

  // Missing offsets fallback (from persona-state-port contract).
  const withOffsets = newPerson(0)
  const withoutOffsets = newPerson(0)
  delete withoutOffsets.offsets
  assert.doesNotThrow(() => renderRelation(withoutOffsets, '小满'))
  assert.equal(renderRelation(withoutOffsets, '小满'), renderRelation(withOffsets, '小满'))

  const rel: Person = {
    ...newPerson(),
    familiarity: 25,
    intimacy: 55,
    trust: 75,
    offsets: { O: 0, C: 0, E: 5, A: -4, N: 0 },
    nickname: '满宝',
    jokes: ['梗1', '梗2', '梗3'],
    beliefs: [
      { text: '私聊里的秘密', status: 'accepted', keys: ['private:101'] },
      { text: '群里大家的事', status: 'accepted', keys: ['group:202'] },
    ],
  }
  const privOut = renderRelation(rel, '小满', { key: 'private:101' })
  assert.match(privOut, /【你和小满】朋友；信任高；你对他嘴更毒；跟他话更多/)
  assert.match(privOut, /私聊里的秘密/)
  assert.match(privOut, /群里大家的事/)
  assert.match(privOut, /你叫他"满宝"/)
  assert.match(privOut, /你们的梗：梗1、梗2$/)

  const groupOut = renderRelation(rel, '小满', { key: 'group:202' })
  assert.doesNotMatch(groupOut, /私聊里的秘密/)
  assert.match(groupOut, /群里大家的事/)
})
