import assert from 'node:assert/strict'
import test from 'node:test'
import type { MemoryRecord } from '@dsh-brain-core/sdk'
import type { PolicyDecision } from '../../src/contracts/index.ts'
import { DEFAULT_BUDGETS, createContextAssembler, renderText, stableStringify } from '../../src/memory-context/index.ts'
import { createWorkingMemoryStore } from '../../src/working-memory/index.ts'
import { FakePolicy } from '../fakes/index.ts'
import { BLOCK_ORDER, ELSEWHERE, HERE, NOW, World, blockOf, idsOf, recordInput, viewerIn } from './fixtures.ts'

const VERBATIM: PolicyDecision = {
  visible: true,
  injection: 'verbatim',
  disclosure: { speakable: 'yes', label: '就在这里说过' },
}

const HIDDEN: PolicyDecision = {
  visible: false,
  injection: 'none',
  disclosure: { speakable: 'never', label: '' },
}

test('every block takes exactly the records the work order names', async () => {
  const w = new World()

  const profileHit = await w.add({ layer: 'L3', kind: 'l3.person', subjects: ['p_alice'], channel: ELSEWHERE })
  await w.add({ layer: 'L3', kind: 'l3.person', subjects: ['p_carol'] })
  await w.add({ layer: 'L3', kind: 'l3.self', subjects: ['p_alice'] })

  const factsSubject = await w.add({ kind: 'l1.fact', subjects: ['p_alice'], channel: ELSEWHERE, importance: 0.6 })
  const factsChannel = await w.add({ kind: 'l1.event', subjects: ['self'], channel: HERE, importance: 0.5 })
  await w.add({ kind: 'l1.candidate', subjects: ['p_alice'] })
  const outdated = await w.add({ kind: 'l1.fact', subjects: ['p_alice'] })
  await w.update(outdated, { status: 'outdated' })
  await w.add({ kind: 'l1.fact', subjects: ['p_carol'], channel: ELSEWHERE })

  const lessonsSubject = await w.add({ layer: 'L2', kind: 'l2.person_tip', subjects: ['p_bob'], importance: 0.7 })
  const lessonsChannel = await w.add({ layer: 'L2', kind: 'l2.scene', subjects: ['self'], channel: HERE, importance: 0.6 })

  const recallHit = await w.add({
    kind: 'l1.topic',
    subjects: ['p_carol'],
    channel: 'qq:private:999',
    content: { text: 'about dragonfruit' },
    importance: 0.5,
  })
  const recallInactive = await w.add({
    kind: 'l1.topic',
    subjects: ['p_carol'],
    channel: 'qq:private:999',
    content: { text: 'dragonfruit again' },
  })
  // The index still holds the active copy, so only the store's status check can keep this out.
  await w.store.patch(recallInactive.id, { status: 'outdated' }, recallInactive.version)
  // An index hit whose record no longer exists in the store.
  await w.index.add({
    ...recordInput({ kind: 'l1.topic', content: { text: 'dragonfruit ghost' } }),
    id: 'l1_01JGHOST0000000000000000',
    tIngest: NOW,
    status: 'active',
    version: 1,
  })
  // An index hit above the recall layers.
  await w.add({ layer: 'L3', kind: 'l3.person', subjects: ['p_carol'], content: { text: 'dragonfruit profile' } })

  const elsewhereSelf = await w.l0({ actor: 'self', channel: ELSEWHERE, tEvent: NOW - 3_600_000, importance: 0.5 })
  await w.l0({ actor: 'self', channel: HERE, tEvent: NOW - 3_600_000 })
  await w.l0({ actor: 'owner', channel: ELSEWHERE, tEvent: NOW - 3_600_000 })
  await w.l0({ actor: 'self', channel: ELSEWHERE, tEvent: NOW - 25 * 3_600_000 })
  const elsewhereL1 = await w.add({
    kind: 'l1.self',
    subjects: ['self'],
    actor: 'self',
    channel: ELSEWHERE,
    tEvent: NOW - 7_200_000,
    importance: 0.4,
  })

  const promiseSubject = await w.add({
    kind: 'l1.promise',
    subjects: ['p_alice'],
    channel: ELSEWHERE,
    validTo: NOW + 1_000,
    importance: 0.8,
  })
  const promiseNoValidTo = await w.add({
    kind: 'l1.promise',
    subjects: ['p_bob'],
    channel: ELSEWHERE,
    importance: 0.6,
  })
  const promiseChannel = await w.add({
    kind: 'l1.promise',
    subjects: ['self'],
    channel: HERE,
    importance: 0.4,
  })
  await w.add({ kind: 'l1.promise', subjects: ['p_alice'], channel: ELSEWHERE, validTo: NOW - 1 })
  await w.add({ kind: 'l1.promise', subjects: ['p_carol'], channel: ELSEWHERE })

  // request.channel is untrusted and unused; only the viewer picks the channel.
  const bundle = await w.assembler().assemble({ channel: 'qq:group:ignored', query: 'dragonfruit' }, w.viewer)

  assert.deepEqual(idsOf(bundle, 'profile'), [profileHit.id])
  assert.deepEqual(idsOf(bundle, 'facts'), [factsSubject.id, factsChannel.id])
  assert.deepEqual(idsOf(bundle, 'lessons'), [lessonsSubject.id, lessonsChannel.id])
  assert.deepEqual(idsOf(bundle, 'recall'), [recallHit.id])
  assert.deepEqual(idsOf(bundle, 'elsewhere'), [elsewhereSelf.id, elsewhereL1.id])
  assert.deepEqual(idsOf(bundle, 'promises'), [promiseSubject.id, promiseNoValidTo.id, promiseChannel.id])
})

test('a record already taken by an earlier block is dropped from a later one', async () => {
  const w = new World()
  const both = await w.add({
    kind: 'l1.fact',
    subjects: ['p_alice'],
    channel: ELSEWHERE,
    content: { text: 'dragonfruit everywhere' },
  })
  const onlyRecall = await w.add({
    kind: 'l1.topic',
    subjects: ['p_carol'],
    channel: 'qq:private:999',
    content: { text: 'dragonfruit alone' },
  })

  const bundle = await w.assembler().assemble({ channel: HERE, query: 'dragonfruit' }, w.viewer)

  assert.deepEqual(idsOf(bundle, 'facts'), [both.id])
  assert.deepEqual(idsOf(bundle, 'recall'), [onlyRecall.id])
})

test('an empty or blank query takes nothing from recall', async () => {
  const w = new World()
  await w.add({ kind: 'l1.topic', subjects: ['p_carol'], content: { text: 'dragonfruit' } })

  const blank = await w.assembler().assemble({ channel: HERE, query: '   ' }, w.viewer)
  assert.deepEqual(idsOf(blank, 'recall'), [])

  const absent = await w.assembler().assemble({ channel: HERE }, w.viewer)
  assert.deepEqual(idsOf(absent, 'recall'), [])
})

test('on injects cross-channel records and audits each one in block order', async () => {
  const w = new World()
  const crossFact = await w.add({
    kind: 'l1.fact',
    subjects: ['p_alice'],
    channel: ELSEWHERE,
    content: { text: 'cross fact' },
    importance: 0.9,
  })
  const hereFact = await w.add({
    kind: 'l1.event',
    subjects: ['self'],
    channel: HERE,
    content: { text: 'here fact' },
    importance: 0.8,
  })
  const crossLesson = await w.add({
    layer: 'L2',
    kind: 'l2.scene',
    subjects: ['p_alice'],
    channel: ELSEWHERE,
    content: { text: 'cross lesson' },
    importance: 0.9,
  })
  const profile = await w.add({
    layer: 'L3',
    kind: 'l3.person',
    subjects: ['p_alice'],
    channel: ELSEWHERE,
    content: { text: 'profile text' },
  })

  w.mode = 'on'
  const on = await w.assembler().assemble({ channel: HERE }, w.viewer)
  assert.deepEqual(idsOf(on, 'facts'), [crossFact.id, hereFact.id])
  assert.deepEqual(idsOf(on, 'lessons'), [crossLesson.id])
  assert.deepEqual(idsOf(on, 'profile'), [profile.id])
  const onAudit = w.audit.entries.map((entry) => ({ ...entry }))
  assert.deepEqual(onAudit, [
    { recordId: crossFact.id, viewerChannel: HERE, mode: 'on', tAt: NOW },
    { recordId: crossLesson.id, viewerChannel: HERE, mode: 'on', tAt: NOW },
  ])
})

test('shadow injects the same bundle minus cross-channel records and audits exactly those', async () => {
  const w = new World()
  const crossFact = await w.add({
    kind: 'l1.fact',
    subjects: ['p_alice'],
    channel: ELSEWHERE,
    content: { text: 'cross fact' },
    importance: 0.9,
  })
  const hereFact = await w.add({
    kind: 'l1.event',
    subjects: ['self'],
    channel: HERE,
    content: { text: 'here fact' },
    importance: 0.8,
  })
  const crossLesson = await w.add({
    layer: 'L2',
    kind: 'l2.scene',
    subjects: ['p_alice'],
    channel: ELSEWHERE,
    content: { text: 'cross lesson' },
  })
  const profile = await w.add({ layer: 'L3', kind: 'l3.person', subjects: ['p_alice'], channel: ELSEWHERE })

  w.mode = 'on'
  const on = await w.assembler().assemble({ channel: HERE }, w.viewer)
  const wouldInject = w.audit.entries.map((entry) => entry.recordId)

  w.clearAudit()
  w.mode = 'shadow'
  const shadow = await w.assembler().assemble({ channel: HERE }, w.viewer)

  assert.deepEqual(idsOf(shadow, 'facts'), [hereFact.id])
  assert.deepEqual(idsOf(shadow, 'lessons'), [])
  assert.deepEqual(idsOf(shadow, 'profile'), [profile.id])
  assert.deepEqual(w.audit.entries.map((entry) => entry.recordId), wouldInject)
  assert.deepEqual(w.audit.entries.map((entry) => entry.recordId), [crossFact.id, crossLesson.id])
  assert.ok(w.audit.entries.every((entry) => entry.mode === 'shadow'))
  assert.deepEqual(idsOf(on, 'facts'), [crossFact.id, hereFact.id])
})

test('off drops cross-channel records and leaves the audit empty; L3 is never cross-channel', async () => {
  const w = new World()
  const crossFact = await w.add({
    kind: 'l1.fact',
    subjects: ['p_alice'],
    channel: ELSEWHERE,
    content: { text: 'cross fact' },
    importance: 0.9,
  })
  const hereFact = await w.add({
    kind: 'l1.event',
    subjects: ['self'],
    channel: HERE,
    content: { text: 'here fact' },
    importance: 0.8,
  })
  const profile = await w.add({ layer: 'L3', kind: 'l3.person', subjects: ['p_alice'], channel: ELSEWHERE })

  w.mode = 'off'
  const bundle = await w.assembler().assemble({ channel: HERE }, w.viewer)

  assert.deepEqual(idsOf(bundle, 'facts'), [hereFact.id])
  assert.deepEqual(idsOf(bundle, 'profile'), [profile.id])
  assert.deepEqual(w.audit.entries, [])
  assert.equal(idsOf(bundle, 'facts').includes(crossFact.id), false)
})

test('a null viewer channel treats every non-L3 record as cross-channel', async () => {
  const w = new World()
  const fact = await w.add({ kind: 'l1.fact', subjects: ['p_alice'], channel: ELSEWHERE })
  const profile = await w.add({ layer: 'L3', kind: 'l3.person', subjects: ['p_alice'], channel: HERE })

  w.mode = 'shadow'
  const bundle = await w.assembler().assemble({ channel: HERE }, viewerIn(null, ['p_alice']))

  assert.deepEqual(idsOf(bundle, 'facts'), [])
  assert.deepEqual(idsOf(bundle, 'profile'), [profile.id])
  assert.deepEqual(w.audit.entries, [
    { recordId: fact.id, viewerChannel: '', mode: 'shadow', tAt: NOW },
  ])
})

test('an over-budget block keeps the top-priority items that fit and never truncates one', async () => {
  const w = new World()
  const budgets = { profile: 1_000, facts: 10, lessons: 1_000, recall: 1_000, elsewhere: 1_000, promises: 1_000 }
  const first = await w.add({ subjects: ['p_alice'], content: { text: 'aaaa' }, importance: 0.9, tEvent: NOW - 3_000 })
  const second = await w.add({ subjects: ['p_alice'], content: { text: 'bbbbbb' }, importance: 0.5, tEvent: NOW - 1_000 })
  await w.add({ subjects: ['p_alice'], content: { text: 'c' }, importance: 0.5, tEvent: NOW - 2_000 })
  await w.add({ subjects: ['p_alice'], content: { text: 'dd' }, importance: 0.1, tEvent: NOW - 500 })

  const bundle = await w.assembler(budgets).assemble({ channel: HERE }, w.viewer)

  assert.deepEqual(blockOf(bundle, 'facts').items.map((item) => item.text), [renderText(first), renderText(second)])
  assert.equal(bundle.truncated, true)
})

test('a smaller item after a skipped one still fits', async () => {
  const w = new World()
  const budgets = { profile: 1_000, facts: 10, lessons: 1_000, recall: 1_000, elsewhere: 1_000, promises: 1_000 }
  const big = await w.add({ subjects: ['p_alice'], content: { text: 'a'.repeat(8) }, importance: 0.9 })
  await w.add({ subjects: ['p_alice'], content: { text: 'b'.repeat(5) }, importance: 0.8 })
  const small = await w.add({ subjects: ['p_alice'], content: { text: 'cc' }, importance: 0.7 })

  const bundle = await w.assembler(budgets).assemble({ channel: HERE }, w.viewer)

  assert.deepEqual(idsOf(bundle, 'facts'), [big.id, small.id])
  assert.equal(bundle.truncated, true)
})

test('when everything fits, truncated stays false', async () => {
  const w = new World()
  const budgets = { profile: 1_000, facts: 100, lessons: 1_000, recall: 1_000, elsewhere: 1_000, promises: 1_000 }
  const first = await w.add({ subjects: ['p_alice'], content: { text: 'aaaa' }, importance: 0.9 })
  const second = await w.add({ subjects: ['p_alice'], content: { text: 'bbbbbb' }, importance: 0.5 })

  const bundle = await w.assembler(budgets).assemble({ channel: HERE }, w.viewer)

  assert.deepEqual(idsOf(bundle, 'facts'), [first.id, second.id])
  assert.equal(bundle.truncated, false)
})

test('the budget counts code points, not UTF-16 units', async () => {
  const w = new World()
  const budgets = { profile: 1_000, facts: 3, lessons: 1_000, recall: 1_000, elsewhere: 1_000, promises: 1_000 }
  const emoji = await w.add({ subjects: ['p_alice'], content: { text: '😀😀' }, importance: 0.9 })
  await w.add({ subjects: ['p_alice'], content: { text: 'aa' }, importance: 0.8 })

  const bundle = await w.assembler(budgets).assemble({ channel: HERE }, w.viewer)

  assert.deepEqual(idsOf(bundle, 'facts'), [emoji.id])
  assert.deepEqual(blockOf(bundle, 'facts').items.map((item) => item.text), ['😀😀'])
  assert.equal(bundle.truncated, true)
})

test('request.budgetChars scales every block budget by the same ratio', async () => {
  const w = new World()
  const budgets = { profile: 100, facts: 100, lessons: 100, recall: 100, elsewhere: 100, promises: 100 }
  const long = await w.add({ subjects: ['p_alice'], content: { text: 'a'.repeat(30) }, importance: 0.9 })
  const short = await w.add({ subjects: ['p_alice'], content: { text: 'b'.repeat(20) }, importance: 0.8 })

  const wide = await w.assembler(budgets).assemble({ channel: HERE, budgetChars: 300 }, w.viewer)
  assert.deepEqual(idsOf(wide, 'facts'), [long.id, short.id])
  assert.equal(wide.truncated, false)

  const narrow = await w.assembler(budgets).assemble({ channel: HERE, budgetChars: 240 }, w.viewer)
  assert.deepEqual(idsOf(narrow, 'facts'), [long.id])
  assert.equal(narrow.truncated, true)
})

test('invisible records disappear and conclusion-only records carry only their conclusion', async () => {
  const w = new World()
  const hidden = await w.add({ subjects: ['p_alice'], content: { text: 'hidden one' }, importance: 0.95 })
  const concluded = await w.add({
    subjects: ['p_alice'],
    content: { text: 'the original wording', conclusion: 'a safe summary' },
    importance: 0.8,
  })
  const noConclusion = await w.add({
    subjects: ['p_alice'],
    content: { text: 'another original' },
    importance: 0.7,
  })
  const normal = await w.add({ subjects: ['p_alice'], content: { text: 'visible text' }, importance: 0.6 })

  w.policy = new FakePolicy((record) => {
    if (record.id === hidden.id) return HIDDEN
    if (record.id === concluded.id || record.id === noConclusion.id) {
      return {
        visible: true,
        injection: 'conclusion-only',
        disclosure: { speakable: 'never', label: '只作判断依据，不要说出来' },
      }
    }
    return VERBATIM
  })

  const bundle = await w.assembler().assemble({ channel: HERE }, w.viewer)
  const items = blockOf(bundle, 'facts').items

  assert.deepEqual(items.map((item) => item.id), [concluded.id, normal.id])
  assert.equal(items[0]?.text, 'a safe summary')
  assert.equal(items[1]?.text, 'visible text')
  assert.deepEqual(items[0]?.disclosure, { speakable: 'never', label: '只作判断依据，不要说出来' })
  const serialized = JSON.stringify(bundle)
  assert.equal(serialized.includes('the original wording'), false)
  assert.equal(serialized.includes('another original'), false)
})

test('the bundle carries profileVersion, stable, six fixed blocks and a disclosure on every item', async () => {
  const w = new World()
  w.profiles.set({ version: 12, stable: 'stable-12' })
  const fact = await w.add({ subjects: ['p_alice'], content: { text: 'kept' } })

  const bundle = await w.assembler().assemble({ channel: HERE }, w.viewer)

  assert.equal(bundle.profileVersion, 12)
  assert.equal(bundle.stable, 'stable-12')
  assert.deepEqual(bundle.blocks.map((block) => block.name), [...BLOCK_ORDER])
  assert.deepEqual(blockOf(bundle, 'facts').items.map((item) => item.id), [fact.id])
  for (const block of bundle.blocks) {
    for (const item of block.items) {
      assert.deepEqual(item.disclosure, VERBATIM.disclosure)
    }
  }
  assert.deepEqual(idsOf(bundle, 'profile'), [])
  assert.deepEqual(idsOf(bundle, 'working'), [])
  assert.deepEqual(idsOf(bundle, 'topics'), [])
  assert.deepEqual(idsOf(bundle, 'lessons'), [])
  assert.deepEqual(idsOf(bundle, 'recall'), [])
  assert.deepEqual(idsOf(bundle, 'elsewhere'), [])
  assert.deepEqual(idsOf(bundle, 'promises'), [])
})

test('equal importance and tEvent fall back to ascending id, and two runs are byte-identical', async () => {
  const w = new World()
  const one = await w.add({ subjects: ['p_alice'], content: { text: 'one' }, importance: 0.5, tEvent: NOW - 1_000 })
  const two = await w.add({ subjects: ['p_alice'], content: { text: 'two' }, importance: 0.5, tEvent: NOW - 1_000 })
  await w.add({ kind: 'l1.promise', subjects: ['p_alice'], channel: ELSEWHERE, validTo: NOW + 10 })
  await w.l0({ actor: 'self', channel: ELSEWHERE, tEvent: NOW - 1_000 })

  const assembler = w.assembler()
  const first = await assembler.assemble({ channel: HERE, query: 'nothing-matches' }, w.viewer)
  const firstAudit = w.audit.entries.map((entry) => ({ ...entry }))
  const second = await assembler.assemble({ channel: HERE, query: 'nothing-matches' }, w.viewer)

  assert.deepEqual(idsOf(first, 'facts'), [one.id, two.id].sort())
  assert.equal(JSON.stringify(second), JSON.stringify(first))
  assert.deepEqual(w.audit.entries.slice(firstAudit.length), firstAudit)
})

test('ties fall back to ascending id even when the store returns them the other way round', async () => {
  const w = new World()
  // Inserted first, so its id is lower; only the channel query finds it.
  const low = await w.add({ kind: 'l1.event', subjects: ['self'], channel: HERE, importance: 0.5, tEvent: NOW - 1_000 })
  // Inserted second, so its id is higher; only the subject query finds it, and that query runs first.
  const high = await w.add({ kind: 'l1.fact', subjects: ['p_alice'], channel: ELSEWHERE, importance: 0.5, tEvent: NOW - 1_000 })
  assert.ok(low.id < high.id)

  const bundle = await w.assembler().assemble({ channel: HERE }, w.viewer)
  assert.deepEqual(idsOf(bundle, 'facts'), [low.id, high.id])
})

test('stableStringify sorts object keys recursively and renderText prefers content.text', () => {
  assert.equal(stableStringify({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}')
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }))
  assert.equal(stableStringify([{ b: 1, a: 2 }]), '[{"a":2,"b":1}]')
  assert.equal(stableStringify({ list: [3, { y: 1, x: 2 }] }), '{"list":[3,{"x":2,"y":1}]}')

  const record: MemoryRecord = {
    ...recordInput({ content: { text: 'plain' } }),
    id: 'l1_01JTEST00000000000000000',
    tIngest: NOW,
    status: 'active',
    version: 1,
  }
  assert.equal(renderText(record), 'plain')
  assert.equal(renderText({ ...record, content: { b: 1, a: { d: 2, c: 3 } } }), '{"a":{"c":3,"d":2},"b":1}')
})

test('DEFAULT_BUDGETS is the published default', () => {
  assert.deepEqual(DEFAULT_BUDGETS, {
    profile: 1_500,
    working: 600,
    topics: 400,
    facts: 1_500,
    lessons: 800,
    recall: 800,
    elsewhere: 600,
    promises: 300,
  })
  assert.ok(Object.isFrozen(DEFAULT_BUDGETS))
})

test('working block injects only active working memory for the current channel (FR-M17)', async () => {
  const w = new World()
  const workingMemory = createWorkingMemoryStore({ clock: w.clock })

  const expired = await workingMemory.put({ channel: HERE, key: 'stale', text: 'already expired', ttlMs: 1_000 })
  await workingMemory.put({ channel: ELSEWHERE, key: 'other', text: 'other channel state', ttlMs: 60_000 })
  w.clock.advance(2_000)
  const activeOlder = await workingMemory.put({ channel: HERE, key: 'step', text: 'comparing flights', ttlMs: 60_000 })
  w.clock.advance(500)
  const activeNewer = await workingMemory.put({ channel: HERE, key: 'mood', text: 'excited for the upcoming Kyoto autumn trip', ttlMs: 60_000 })

  const assembler = createContextAssembler({
    store: w.store,
    index: w.index,
    policy: w.policy,
    profiles: w.profiles,
    audit: w.audit,
    clock: w.clock,
    facts: async () => w.facts,
    crossChannelMode: () => 'off',
    workingMemory,
  })

  const bundle = await assembler.assemble({ channel: HERE }, w.viewer)
  const working = blockOf(bundle, 'working')
  assert.deepEqual(working.items, [
    { id: activeNewer.id, text: 'mood: excited for the upcoming Kyoto autumn trip', disclosure: { speakable: 'yes', label: '当前会话短期状态' } },
    { id: activeOlder.id, text: 'step: comparing flights', disclosure: { speakable: 'yes', label: '当前会话短期状态' } },
  ])
  assert.equal(working.items.some((item) => item.id === expired.id), false)
  assert.deepEqual(w.audit.entries, [])

  const nullChannelBundle = await assembler.assemble({ channel: HERE }, viewerIn(null))
  assert.deepEqual(idsOf(nullChannelBundle, 'working'), [])

  // Budget trimming skips oversized working items and fits smaller ones, marking truncated.
  const tightAssembler = createContextAssembler({
    store: w.store,
    index: w.index,
    policy: w.policy,
    profiles: w.profiles,
    audit: w.audit,
    clock: w.clock,
    facts: async () => w.facts,
    crossChannelMode: () => 'off',
    workingMemory,
    budgets: { working: 'step: comparing flights'.length },
  })
  const tightBundle = await tightAssembler.assemble({ channel: HERE }, w.viewer)
  assert.deepEqual(idsOf(tightBundle, 'working'), [activeOlder.id])
  assert.equal(tightBundle.truncated, true)
})

test('topics block injects open, suspended, and legacy undefined topics, while closed topics stay out of topics and facts (FR-M18)', async () => {
  const w = new World()
  const openTopic = await w.add({
    kind: 'l1.topic',
    channel: HERE,
    subjects: ['p_alice'],
    content: { text: 'plan Kyoto itinerary', state: 'open' },
    importance: 0.9,
  })
  const suspendedTopic = await w.add({
    kind: 'l1.topic',
    channel: ELSEWHERE,
    subjects: ['p_bob'],
    content: { text: 'resume book club', state: 'suspended' },
    importance: 0.7,
  })
  const legacyTopic = await w.add({
    kind: 'l1.topic',
    channel: HERE,
    subjects: ['self'],
    content: { text: 'legacy topic without state' },
    importance: 0.5,
  })
  const closedTopic = await w.add({
    kind: 'l1.topic',
    channel: HERE,
    subjects: ['p_alice'],
    content: { text: 'settled dragonfruit debate', state: 'closed' },
    importance: 1.0,
  })

  const bundle = await w.assembler().assemble({ channel: HERE }, w.viewer)
  assert.deepEqual(idsOf(bundle, 'topics'), [openTopic.id, suspendedTopic.id, legacyTopic.id])
  assert.equal(idsOf(bundle, 'topics').includes(closedTopic.id), false)
  assert.equal(idsOf(bundle, 'facts').includes(closedTopic.id), false)

  // A closed topic can still be retrieved as historical recall when queried.
  const recallBundle = await w.assembler().assemble({ channel: HERE, query: 'dragonfruit debate' }, w.viewer)
  assert.equal(idsOf(recallBundle, 'topics').includes(closedTopic.id), false)
  assert.equal(idsOf(recallBundle, 'recall').includes(closedTopic.id), true)
})

test('facts and lessons rank equal-importance records by FSRS priorityOf descending (FR-M14)', async () => {
  const w = new World()
  const thirtyDaysAgo = NOW - 30 * 86_400_000

  const staleFact = await w.add({
    kind: 'l1.fact',
    subjects: ['p_alice'],
    importance: 0.8,
    confidence: 0.5,
    tEvent: thirtyDaysAgo,
    content: { text: 'stale fact' },
  })
  const reviewedFact = await w.add({
    kind: 'l1.fact',
    subjects: ['p_alice'],
    importance: 0.8,
    confidence: 0.5,
    tEvent: thirtyDaysAgo,
    content: {
      text: 'recently reviewed fact',
      decay: { stabilityDays: 20, difficulty: 3, lastReviewedAt: NOW - 86_400_000, reps: 2 },
    },
  })

  const staleLesson = await w.add({
    layer: 'L2',
    kind: 'l2.person_tip',
    subjects: ['p_bob'],
    importance: 0.7,
    confidence: 0.5,
    tEvent: thirtyDaysAgo,
    content: { text: 'stale lesson' },
  })
  const reviewedLesson = await w.add({
    layer: 'L2',
    kind: 'l2.person_tip',
    subjects: ['p_bob'],
    importance: 0.7,
    confidence: 0.5,
    tEvent: thirtyDaysAgo,
    content: {
      text: 'recently reviewed lesson',
      decay: { stabilityDays: 30, difficulty: 2.5, lastReviewedAt: NOW - 86_400_000, reps: 3 },
    },
  })

  const bundle = await w.assembler().assemble({ channel: HERE }, w.viewer)
  assert.deepEqual(idsOf(bundle, 'facts'), [reviewedFact.id, staleFact.id])
  assert.deepEqual(idsOf(bundle, 'lessons'), [reviewedLesson.id, staleLesson.id])
})

test('legacy L0 records receive the archive tone disclaimer suffix idempotently in /context (FR-M19)', async () => {
  const w = new World()
  const legacyL0 = await w.l0({
    channel: HERE,
    content: { text: '旧系统的抹茶记录', legacy: true },
  })
  const normalL0 = await w.l0({
    channel: HERE,
    content: { text: '新系统的抹茶记录' },
  })
  const legacyL1 = await w.add({
    kind: 'l1.fact',
    channel: HERE,
    subjects: ['p_alice'],
    content: { text: '喜欢抹茶', legacy: true },
  })

  const bundle = await w.assembler().assemble({ channel: HERE, query: '抹茶' }, w.viewer)
  const recall = bundle.blocks.find((b) => b.name === 'recall')?.items ?? []
  const facts = bundle.blocks.find((b) => b.name === 'facts')?.items ?? []
  const suffix = '（旧系统历史存档，仅作事实参考，不作为当前说话语气）'

  const legItem = recall.find((item) => item.id === legacyL0.id)
  const normItem = recall.find((item) => item.id === normalL0.id)
  const l1Item = facts.find((item) => item.id === legacyL1.id)

  assert.ok(legItem !== undefined)
  assert.equal(legItem.disclosure.label.endsWith(suffix), true)
  assert.equal(legItem.disclosure.label.split(suffix).length - 1, 1)
  assert.ok(normItem !== undefined)
  assert.equal(normItem.disclosure.label.includes(suffix), false)
  assert.ok(l1Item !== undefined)
  assert.equal(l1Item.disclosure.label.includes(suffix), false)

  // Idempotent even when policy decision label already contains the legacy suffix.
  w.policy = {
    decide: () => ({
      visible: true,
      injection: 'verbatim',
      disclosure: { speakable: 'yes', label: `就在这里说过${suffix}` },
    }),
  }
  const idempBundle = await w.assembler().assemble({ channel: HERE, query: '抹茶' }, w.viewer)
  const idempItem = (idempBundle.blocks.find((b) => b.name === 'recall')?.items ?? []).find((item) => item.id === legacyL0.id)
  assert.equal(idempItem?.disclosure.label, `就在这里说过${suffix}`)
})
