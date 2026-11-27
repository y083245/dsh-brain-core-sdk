import assert from 'node:assert/strict'
import test from 'node:test'
import { BrainError } from '@dsh-brain-core/sdk'
import type { MemoryRecord } from '@dsh-brain-core/sdk'
import { createMemoryDecay, parseDecayState } from '../../src/memory-decay/index.ts'

const DAY = 86_400_000
const T0 = Date.UTC(2026, 0, 1)

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'l1_01JDECAY00000000000000000',
    layer: 'L1',
    kind: 'l1.fact',
    source: 'plugin.test',
    channel: 'qq:group:100',
    subjects: ['p_alice'],
    actor: 'owner',
    content: { text: 'likes oolong tea' },
    evidence: [{ id: 'l0_01J000000000000000000000' }],
    visibility: 'open',
    trust: 'owner',
    confidence: 0.5,
    importance: 0.5,
    tEvent: T0,
    tIngest: T0,
    status: 'active',
    version: 1,
    ...overrides,
  }
}

test('RFC M8: retrievabilityOf and priorityOf never mutate record.status after 30d or 365d', () => {
  const decay = createMemoryDecay()
  const fact = makeRecord({ kind: 'l1.fact', layer: 'L1', importance: 0.8, confidence: 0.6 })
  const tip = makeRecord({ id: 'l2_01JDECAY', kind: 'l2.person_tip', layer: 'L2', importance: 0.7, confidence: 0.9 })

  for (const days of [30, 365, 3650]) {
    const now = T0 + days * DAY
    const rFact = decay.retrievabilityOf(fact, now)
    const pFact = decay.priorityOf(fact, now)
    const rTip = decay.retrievabilityOf(tip, now)
    const pTip = decay.priorityOf(tip, now)

    assert.ok(rFact > 0 && rFact < 1)
    assert.ok(Math.abs(pFact - fact.importance * rFact) < 1e-12)
    assert.ok(rTip > 0 && rTip < 1)
    assert.ok(Math.abs(pTip - tip.importance * rTip) < 1e-12)
    assert.equal(fact.status, 'active')
    assert.equal(tip.status, 'active')
  }
})

test('FSRS retrievability decreases monotonically and equals 0.9 at elapsedDays === stabilityDays', () => {
  const decay = createMemoryDecay()
  const record = makeRecord({ importance: 0.8, confidence: 0.5 })
  const state = parseDecayState(record)

  assert.equal(decay.retrievabilityOf(record, T0), 1)
  assert.equal(decay.retrievabilityOf(record, T0 - DAY), 1)

  const atStability = decay.retrievabilityOf(record, T0 + state.stabilityDays * DAY)
  assert.ok(Math.abs(atStability - 0.9) < 1e-6, `expected ~0.9, got ${atStability}`)

  const r1 = decay.retrievabilityOf(record, T0 + 1 * DAY)
  const r7 = decay.retrievabilityOf(record, T0 + 7 * DAY)
  const r30 = decay.retrievabilityOf(record, T0 + 30 * DAY)
  const r365 = decay.retrievabilityOf(record, T0 + 365 * DAY)
  assert.ok(r1 < 1)
  assert.ok(r7 < r1)
  assert.ok(r30 < r7)
  assert.ok(r365 < r30)
})

test('RFC M10: l1.event keeps a 0.35 retrievability floor even after 10 years while l1.fact decays below', () => {
  const decay = createMemoryDecay()
  const event = makeRecord({ kind: 'l1.event', importance: 0.5, confidence: 0.5 })
  const fact = makeRecord({ kind: 'l1.fact', importance: 0.5, confidence: 0.5 })
  const tenYears = T0 + 3650 * DAY

  const rEvent = decay.retrievabilityOf(event, tenYears)
  const rFact = decay.retrievabilityOf(fact, tenYears)

  assert.equal(rEvent, 0.35)
  assert.ok(rFact < 0.35, `expected l1.fact retrievability < 0.35, got ${rFact}`)
  assert.equal(event.status, 'active')
})

test('L0 and L3 records always have retrievability 1', () => {
  const decay = createMemoryDecay()
  const l0 = makeRecord({ id: 'l0_01J', layer: 'L0', kind: 'l0.message', importance: 0.4 })
  const l3Self = makeRecord({ id: 'l3_01J', layer: 'L3', kind: 'l3.self', importance: 0.9 })
  const l3Person = makeRecord({ id: 'l3_02J', layer: 'L3', kind: 'l3.person', importance: 0.6 })

  for (const record of [l0, l3Self, l3Person]) {
    assert.equal(decay.retrievabilityOf(record, T0 + 3650 * DAY), 1)
    assert.equal(decay.priorityOf(record, T0 + 3650 * DAY), record.importance)
  }
})

test('reinforce updates stabilityDays, difficulty, lastReviewedAt and reps according to grade', () => {
  const decay = createMemoryDecay()
  const record = makeRecord({ importance: 0.5, confidence: 0.5 })
  const initial = parseDecayState(record)
  const now = T0 + 5 * DAY

  const defaultReinforce = decay.reinforce(record, now)
  const grade3 = decay.reinforce(record, now, 3)
  assert.deepEqual(defaultReinforce, grade3)
  assert.ok(grade3.stabilityDays > initial.stabilityDays)
  assert.equal(grade3.difficulty, initial.difficulty)
  assert.equal(grade3.lastReviewedAt, now)
  assert.equal(grade3.reps, 1)

  const grade2 = decay.reinforce(record, now, 2)
  const grade4 = decay.reinforce(record, now, 4)
  assert.ok(grade2.stabilityDays > initial.stabilityDays)
  assert.ok(grade3.stabilityDays > grade2.stabilityDays)
  assert.ok(grade4.stabilityDays > grade3.stabilityDays)
  assert.ok(grade4.difficulty < grade3.difficulty)
  assert.ok(grade2.difficulty > grade3.difficulty)

  // Exact formula verification with non-zero elapsedDays (r = 0.9 < 1).
  const seeded = makeRecord({
    content: { text: 'seeded', decay: { stabilityDays: 5, difficulty: 4, lastReviewedAt: T0, reps: 1 } },
  })
  const expectedR = Math.pow(1 + (19 / 81) * (5 / 5), -0.5)
  for (const [grade, weight] of [[2, 0.15], [3, 0.35], [4, 0.55]] as const) {
    const out = decay.reinforce(seeded, T0 + 5 * DAY, grade)
    const expectedDifficulty = 4 - 0.4 * (grade - 3)
    const expectedGain = Math.exp(1.2) * (11 - expectedDifficulty) * Math.pow(5, -0.2) * ((1 + (1 - expectedR)) * weight)
    const expectedStability = 5 * (1 + expectedGain)
    assert.ok(Math.abs(out.difficulty - expectedDifficulty) < 1e-9)
    assert.ok(Math.abs(out.stabilityDays - expectedStability) < 1e-9)
    assert.equal(out.reps, 2)
  }

  const grade1 = decay.reinforce(record, now, 1)
  assert.equal(grade1.stabilityDays, Math.max(0.5, initial.stabilityDays * 0.5))
  assert.equal(grade1.reps, 1)
  assert.ok(grade1.difficulty > initial.difficulty)

  // Floor at 0.5 on grade 1 even when existing stabilityDays is small.
  const fragile = makeRecord({
    content: { text: 'fragile', decay: { stabilityDays: 0.6, difficulty: 9.8, lastReviewedAt: T0, reps: 2 } },
  })
  const fragileAgain = decay.reinforce(fragile, now, 1)
  assert.equal(fragileAgain.stabilityDays, 0.5)
  assert.equal(fragileAgain.difficulty, 10)
  assert.equal(fragileAgain.reps, 3)

  // Cap at 3650 on high stability grade 4, and keep lastReviewedAt >= previous.
  const strong = makeRecord({
    content: { text: 'strong', decay: { stabilityDays: 3500, difficulty: 1.1, lastReviewedAt: T0 + 10 * DAY, reps: 10 } },
  })
  const strongEasy = decay.reinforce(strong, now, 4)
  assert.equal(strongEasy.stabilityDays, 3650)
  assert.equal(strongEasy.difficulty, 1)
  assert.equal(strongEasy.lastReviewedAt, T0 + 10 * DAY)

  for (const badGrade of [0, 5, 2.5, NaN] as unknown as Array<1 | 2 | 3 | 4>) {
    assert.throws(
      () => decay.reinforce(record, now, badGrade),
      (err: unknown) => err instanceof BrainError && err.code === 'INVALID_ARGUMENT',
    )
  }
})

test('parseDecayState prefers valid content.decay and falls back when malformed or out of bounds', () => {
  const valid = { stabilityDays: 12.5, difficulty: 4.2, lastReviewedAt: T0 + DAY, reps: 3 }
  const withValid = makeRecord({ content: { text: 'ok', decay: valid } })
  assert.deepEqual(parseDecayState(withValid), valid)

  // Boundary valid values: difficulty 1 / 10 and reps 0 must be accepted verbatim.
  const minBoundary = { stabilityDays: 2.5, difficulty: 1, lastReviewedAt: T0 + DAY, reps: 0 }
  assert.deepEqual(parseDecayState(makeRecord({ content: { text: 'min', decay: minBoundary } })), minBoundary)
  const maxBoundary = { stabilityDays: 2.5, difficulty: 10, lastReviewedAt: T0 + DAY, reps: 0 }
  assert.deepEqual(parseDecayState(makeRecord({ content: { text: 'max', decay: maxBoundary } })), maxBoundary)

  const base = makeRecord({ importance: 0.5, confidence: 0.5 })
  const fallback = parseDecayState(base)
  assert.equal(fallback.stabilityDays, 4.5)
  assert.equal(fallback.difficulty, 3.5)
  assert.equal(fallback.lastReviewedAt, T0)
  assert.equal(fallback.reps, 0)

  const malformedCases: unknown[] = [
    null,
    'bad',
    [],
    { stabilityDays: 0, difficulty: 5, lastReviewedAt: T0, reps: 0 },
    { stabilityDays: -1, difficulty: 5, lastReviewedAt: T0, reps: 0 },
    { stabilityDays: Infinity, difficulty: 5, lastReviewedAt: T0, reps: 0 },
    { stabilityDays: 5, difficulty: 0.9, lastReviewedAt: T0, reps: 0 },
    { stabilityDays: 5, difficulty: 10.1, lastReviewedAt: T0, reps: 0 },
    { stabilityDays: 5, difficulty: 5, lastReviewedAt: NaN, reps: 0 },
    { stabilityDays: 5, difficulty: 5, lastReviewedAt: T0, reps: -1 },
    { stabilityDays: 5, difficulty: 5, lastReviewedAt: T0, reps: 1.5 },
  ]
  for (const decayPayload of malformedCases) {
    const rec = makeRecord({ content: { text: 'fallback', decay: decayPayload } })
    assert.deepEqual(parseDecayState(rec), fallback)
  }
})
