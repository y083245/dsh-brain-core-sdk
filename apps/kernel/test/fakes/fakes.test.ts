import assert from 'node:assert/strict'
import test from 'node:test'
import { BrainError, type MemoryRecord, type Viewer } from '@brain-core/sdk'
import type { ChannelFacts, NewRecord, RecordFilter } from '../../src/contracts/index.ts'
import {
  FakeAudit, FakeClock, FakeKeywordIndex, FakeLlm, FakePolicy, FakeProfiles, FakeRecordStore,
} from './index.ts'

async function rejectsCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof BrainError, `expected BrainError, got ${String(error)}`)
    assert.equal(error.code, code)
    return true
  })
}

function input(overrides: Partial<NewRecord> = {}): NewRecord {
  return {
    layer: 'L1',
    kind: 'l1.fact',
    source: 'plugin.test',
    channel: 'plugin.test:chat:1',
    subjects: [],
    actor: 'owner',
    content: { text: 'hello' },
    evidence: [],
    visibility: 'open',
    trust: 'owner',
    confidence: 0.5,
    importance: 0.5,
    tEvent: 1000,
    ...overrides,
  }
}

function l0(overrides: Partial<NewRecord> = {}): NewRecord {
  return input({ layer: 'L0', kind: 'l0.event', evidence: [], ...overrides })
}

async function dataset() {
  const clock = new FakeClock()
  const store = new FakeRecordStore(clock)
  const a = await store.insert(l0({ channel: 'ch1', actor: 'alice', subjects: ['s1'], tEvent: 100 }))
  const b = await store.insert(l0({ kind: 'l0.sys', channel: 'ch2', actor: 'bob', subjects: [], tEvent: 200 }))
  const c = await store.insert(input({ kind: 'l1.fact', channel: 'ch1', actor: 'alice', subjects: ['s2'], tEvent: 300, evidence: [{ id: a.id }] }))
  const d = await store.insert(input({ kind: 'l1.fact', channel: 'ch3', actor: 'carol', subjects: ['s1', 's2'], tEvent: 400, evidence: [{ id: b.id }] }))
  const e = await store.insert(input({ layer: 'L2', kind: 'l2.scene', channel: 'ch2', actor: 'bob', subjects: ['s2'], tEvent: 500, evidence: [{ id: c.id }] }))
  return { clock, store, a, b, c, d, e }
}

async function listIds(store: FakeRecordStore, filter: RecordFilter = {}, page: { limit: number; cursor?: string } = { limit: 1000 }): Promise<string[]> {
  return (await store.list(filter, page)).items.map((record) => record.id)
}

test('FakeClock advances and can be set', () => {
  const clock = new FakeClock()
  assert.equal(clock.now(), Date.UTC(2026, 10, 7))
  clock.advance(500)
  assert.equal(clock.now(), Date.UTC(2026, 10, 7) + 500)
  clock.set(42)
  assert.equal(clock.now(), 42)
})

test('insert fills the envelope and ids are monotonic per layer', async () => {
  const clock = new FakeClock()
  const store = new FakeRecordStore(clock)
  const first = await store.insert(l0())
  const second = await store.insert(l0())
  assert.match(first.id, /^l0_[0-9A-HJKMNP-TV-Z]{26}$/)
  assert.ok(second.id > first.id)
  assert.equal(first.tIngest, clock.now())
  assert.equal(first.status, 'active')
  assert.equal(first.version, 1)
  assert.equal(first.source, 'plugin.test')
})

test('insert validates evidence', async () => {
  const { store, a, c, d } = await dataset()
  await rejectsCode(store.insert(l0({ evidence: [{ id: a.id }] })), 'INVALID_ARGUMENT')
  await rejectsCode(store.insert(input({ evidence: [] })), 'INVALID_ARGUMENT')
  await rejectsCode(store.insert(input({ evidence: [{ id: 'l0_missing' }] })), 'INVALID_ARGUMENT')

  const tombstoned = await store.tombstone(c.id)
  await rejectsCode(store.insert(input({ evidence: [{ id: tombstoned.id }] })), 'INVALID_ARGUMENT')

  await rejectsCode(store.insert(input({ layer: 'L1', evidence: [{ id: d.id }] })), 'INVALID_ARGUMENT')

  const higher = await store.insert(input({ layer: 'L2', kind: 'l2.scene', evidence: [{ id: d.id }, { id: a.id }] }))
  assert.equal(higher.layer, 'L2')
})

test('idempotency is scoped to source and returns the current state', async () => {
  const clock = new FakeClock()
  const store = new FakeRecordStore(clock)
  const base = await store.insert(l0())
  const first = await store.insert(input({ evidence: [{ id: base.id }] }), 'k1')
  const again = await store.insert(input({ evidence: [{ id: base.id }], content: { text: 'ignored' } }), 'k1')
  assert.equal(again.id, first.id)
  assert.deepEqual(again.content, first.content)
  assert.equal((await listIds(store, { layers: ['L1'] })).length, 1)

  const otherSource = await store.insert(input({ evidence: [{ id: base.id }], source: 'other.plugin' }), 'k1')
  assert.notEqual(otherSource.id, first.id)

  const patched = await store.patch(first.id, { content: { text: 'patched' } }, 1)
  const afterPatch = await store.insert(input({ evidence: [{ id: base.id }] }), 'k1')
  assert.equal(afterPatch.id, patched.id)
  assert.equal(afterPatch.version, 2)
  assert.deepEqual(afterPatch.content, { text: 'patched' })

  const noKeyA = await store.insert(l0())
  const noKeyB = await store.insert(l0())
  assert.notEqual(noKeyA.id, noKeyB.id)
})

test('get returns null when missing and tombstoned records with empty content', async () => {
  const { store, c } = await dataset()
  assert.equal(await store.get('l1_missing'), null)
  const buried = await store.tombstone(c.id)
  const fetched = await store.get(c.id)
  assert.deepEqual(fetched, buried)
  assert.deepEqual(fetched?.content, {})
  assert.equal(fetched?.status, 'tombstoned')
})

test('patch rejects in the documented order', async () => {
  const { store, a, c } = await dataset()
  await rejectsCode(store.patch('l1_missing', {}, 1), 'NOT_FOUND')
  await rejectsCode(store.patch(a.id, {}, 1), 'PERMISSION_DENIED')
  await rejectsCode(store.patch(a.id, { status: 'tombstoned' }, 99), 'PERMISSION_DENIED')
  await rejectsCode(store.patch(c.id, {}, 99), 'CONFLICT')
  await rejectsCode(store.patch(c.id, { status: 'tombstoned' }, 99), 'CONFLICT')
  await rejectsCode(store.patch(c.id, { status: 'tombstoned' }, 1), 'INVALID_ARGUMENT')
  await store.tombstone(c.id)
  await rejectsCode(store.patch(c.id, {}, 2), 'NOT_FOUND')
})

test('patch changes only the given fields and bumps the version', async () => {
  const { store, c } = await dataset()
  const patched = await store.patch(c.id, { content: { text: 'new' }, confidence: 0.9, status: 'archived', validTo: 5000 }, 1)
  assert.deepEqual(patched.content, { text: 'new' })
  assert.equal(patched.confidence, 0.9)
  assert.equal(patched.status, 'archived')
  assert.equal(patched.validTo, 5000)
  assert.equal(patched.version, 2)
  assert.equal(patched.id, c.id)
  assert.equal(patched.tIngest, c.tIngest)
  assert.deepEqual(patched.subjects, c.subjects)
  assert.equal(patched.importance, c.importance)
})

test('tombstone is idempotent and bumps the version once', async () => {
  const { store, c } = await dataset()
  await rejectsCode(store.tombstone('l1_missing'), 'NOT_FOUND')
  const first = await store.tombstone(c.id)
  assert.equal(first.status, 'tombstoned')
  assert.deepEqual(first.content, {})
  assert.equal(first.version, c.version + 1)
  const second = await store.tombstone(c.id)
  assert.deepEqual(second, first)
})

test('list applies every filter, with empty arrays matching nothing', async () => {
  const { store, a, b, c, d, e } = await dataset()
  const sorted = [a.id, b.id, c.id, d.id, e.id].sort()
  assert.deepEqual(await listIds(store), sorted)
  assert.deepEqual(await listIds(store, { layers: ['L0'] }), [a.id, b.id].sort())
  assert.deepEqual(await listIds(store, { channels: ['ch1'] }), [a.id, c.id].sort())
  assert.deepEqual(await listIds(store, { subjects: ['s1'] }), [a.id, d.id].sort())
  assert.deepEqual(await listIds(store, { actors: ['alice'] }), [a.id, c.id].sort())
  assert.deepEqual(await listIds(store, { kinds: ['l1.fact'] }), [c.id, d.id].sort())
  assert.deepEqual(await listIds(store, { from: 200, to: 400 }), [b.id, c.id, d.id].sort())
  assert.deepEqual(await listIds(store, { layers: [] }), [])
  assert.deepEqual(await listIds(store, { layers: ['L0'], actors: ['bob'] }), [b.id])
  await store.tombstone(b.id)
  assert.deepEqual(await listIds(store, { statuses: ['active'] }), [a.id, c.id, d.id, e.id].sort())
  assert.deepEqual(await listIds(store, { statuses: ['tombstoned'] }), [b.id])
})

test('list validates the page limit', async () => {
  const { store } = await dataset()
  for (const limit of [0, 1001, 1.5, Number.NaN]) {
    await rejectsCode(store.list({}, { limit }), 'INVALID_ARGUMENT')
  }
})

test('list paginates with an id cursor', async () => {
  const { store, a, b, c, d, e } = await dataset()
  const sorted = [a.id, b.id, c.id, d.id, e.id].sort()
  const first = await store.list({}, { limit: 2 })
  assert.deepEqual(first.items.map((record) => record.id), sorted.slice(0, 2))
  assert.equal(first.nextCursor, sorted[1])
  const second = await store.list({}, { limit: 2, cursor: first.nextCursor })
  assert.deepEqual(second.items.map((record) => record.id), sorted.slice(2, 4))
  assert.equal(second.nextCursor, sorted[3])
  const last = await store.list({}, { limit: 2, cursor: second.nextCursor })
  assert.deepEqual(last.items.map((record) => record.id), [sorted[4]])
  assert.equal(last.nextCursor, undefined)
  const pastEnd = await store.list({}, { limit: 2, cursor: sorted[4] })
  assert.deepEqual(pastEnd.items, [])
  assert.equal(pastEnd.nextCursor, undefined)
})

test('dependentsOf finds every status, sorted by id', async () => {
  const { store, a, c } = await dataset()
  const extra = await store.insert(input({ kind: 'l1.other', evidence: [{ id: a.id }] }))
  assert.deepEqual((await store.dependentsOf(a.id)).map((record) => record.id), [c.id, extra.id].sort())
  await store.tombstone(c.id)
  assert.deepEqual((await store.dependentsOf(a.id)).map((record) => record.id), [c.id, extra.id].sort())
  assert.deepEqual(await store.dependentsOf('l1_none'), [])
})

test('scan yields every status in id order and honours the layer filter', async () => {
  const { store, a, b, c, d, e } = await dataset()
  const sorted = [a.id, b.id, c.id, d.id, e.id].sort()
  const all: string[] = []
  for await (const record of store.scan()) all.push(record.id)
  assert.deepEqual(all, sorted)

  await store.tombstone(c.id)
  const l1: string[] = []
  for await (const record of store.scan(['L1'])) l1.push(record.id)
  assert.deepEqual(l1, [c.id, d.id].sort())

  const none: string[] = []
  for await (const record of store.scan([])) none.push(record.id)
  assert.deepEqual(none, [])
})

test('stored records and returned records are copies', async () => {
  const { store, c } = await dataset()
  const mutableInserted = c as unknown as { content: Record<string, unknown> }
  mutableInserted.content['text'] = 'mutated'
  const fetched = await store.get(c.id)
  assert.deepEqual(fetched?.content, { text: 'hello' })

  const mutableFetched = fetched as MemoryRecord
  ;(mutableFetched.content as Record<string, unknown>)['text'] = 'mutated again'
  const fetchedAgain = await store.get(c.id)
  assert.deepEqual(fetchedAgain?.content, { text: 'hello' })
})

async function indexFixture() {
  const store = new FakeRecordStore(new FakeClock())
  const alpha = await store.insert(l0({ channel: 'ch1', actor: 'alice', subjects: ['s1'], tEvent: 100, content: { text: 'Hello World', nested: { deep: 'Foo Bar' }, list: ['Baz'] } }))
  const beta = await store.insert(l0({ channel: 'ch2', actor: 'bob', subjects: ['s2'], tEvent: 200, content: { text: 'quiet' } }))
  const index = new FakeKeywordIndex()
  await index.add(alpha)
  await index.add(beta)
  return { store, index, alpha, beta }
}

test('FakeKeywordIndex matches every term in any nested string, ignoring case', async () => {
  const { index, alpha, beta } = await indexFixture()
  assert.deepEqual(await index.search({ text: 'hello', limit: 10 }), [{ id: alpha.id, score: 1 }])
  assert.deepEqual(await index.search({ text: 'HELLO world', limit: 10 }), [{ id: alpha.id, score: 1 }])
  assert.deepEqual(await index.search({ text: 'foo baz', limit: 10 }), [{ id: alpha.id, score: 1 }])
  assert.deepEqual(await index.search({ text: 'hello quiet', limit: 10 }), [])
  assert.deepEqual(await index.search({ text: '   ', limit: 10 }), [])
  assert.deepEqual(await index.search({ text: 'quiet', limit: 10 }), [{ id: beta.id, score: 1 }])
})

test('FakeKeywordIndex honours its filters and the limit', async () => {
  const { index, alpha, beta } = await indexFixture()
  assert.deepEqual(await index.search({ text: 'hello', limit: 10, layers: ['L1'] }), [])
  assert.deepEqual(await index.search({ text: 'hello', limit: 10, channels: ['ch1'] }), [{ id: alpha.id, score: 1 }])
  assert.deepEqual(await index.search({ text: 'quiet', limit: 10, channels: ['ch1'] }), [])
  assert.deepEqual(await index.search({ text: 'hello', limit: 10, subjects: ['s1'] }), [{ id: alpha.id, score: 1 }])
  assert.deepEqual(await index.search({ text: 'quiet', limit: 10, from: 150, to: 250 }), [{ id: beta.id, score: 1 }])
  assert.deepEqual(await index.search({ text: 'quiet', limit: 10, to: 150 }), [])
  const both = await index.search({ text: 'hello', limit: 10 })
  assert.equal(both.length, 1)
  assert.deepEqual(await index.search({ text: 'hello', limit: 0 }), [])
})

test('FakeKeywordIndex replaces entries and drops non-active records', async () => {
  const { index, alpha } = await indexFixture()
  await index.add({ ...alpha, status: 'archived' })
  assert.deepEqual(await index.search({ text: 'hello', limit: 10 }), [])
  await index.add({ ...alpha, content: { text: 'replaced' } })
  assert.deepEqual(await index.search({ text: 'hello', limit: 10 }), [])
  assert.deepEqual((await index.search({ text: 'replaced', limit: 10 })).map((hit) => hit.id), [alpha.id])
  await index.remove(alpha.id)
  assert.deepEqual(await index.search({ text: 'replaced', limit: 10 }), [])
})

async function* iterate<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) yield item
}

test('FakeKeywordIndex rebuild clears first and returns the active count', async () => {
  const { index, alpha, beta } = await indexFixture()
  const archived = { ...beta, status: 'archived' as const, content: { text: 'archived-word' } }
  const count = await index.rebuild(iterate([alpha, archived]))
  assert.equal(count, 1)
  assert.deepEqual((await index.search({ text: 'hello', limit: 10 })).map((hit) => hit.id), [alpha.id])
  assert.deepEqual(await index.search({ text: 'quiet', limit: 10 }), [])
  assert.deepEqual(await index.search({ text: 'archived-word', limit: 10 }), [])
})

const record = (id: string): MemoryRecord => ({
  id,
  layer: 'L1',
  kind: 'l1.fact',
  source: 'plugin.test',
  channel: 'ch1',
  subjects: ['s1'],
  actor: 'owner',
  content: {},
  evidence: [],
  visibility: 'open',
  trust: 'owner',
  confidence: 0.5,
  importance: 0.5,
  tEvent: 1,
  tIngest: 1,
  status: 'active',
  version: 1,
})

const viewer: Viewer = { caller: 'agent', channel: 'ch1', participants: [] }
const facts: ChannelFacts = { ownerChannels: new Set(), members: new Map(), kindOf: () => 'other' }

test('FakePolicy allows everything by default and delegates a custom decision', () => {
  const policy = new FakePolicy()
  assert.deepEqual(policy.decide(record('l1_x'), viewer, facts), {
    visible: true, injection: 'verbatim', disclosure: { speakable: 'yes', label: '就在这里说过' },
  })
  const custom = new FakePolicy((seen, seenViewer) => ({
    visible: seen.id === 'l1_x' && seenViewer.caller === 'agent',
    injection: 'none',
    disclosure: { speakable: 'never', label: '' },
  }))
  assert.equal(custom.decide(record('l1_x'), viewer, facts).visible, true)
  assert.equal(custom.decide(record('l1_y'), viewer, facts).visible, false)
})

test('FakeProfiles starts empty, accepts updates and returns copies', async () => {
  const profiles = new FakeProfiles()
  assert.deepEqual(await profiles.current(), { version: 0, stable: '' })
  profiles.set({ version: 2, stable: 'abc' })
  const snapshot = await profiles.current()
  assert.deepEqual(snapshot, { version: 2, stable: 'abc' })
  ;(snapshot as { stable: string }).stable = 'mutated'
  assert.deepEqual(await profiles.current(), { version: 2, stable: 'abc' })
})

test('FakeAudit records every cross-channel use', async () => {
  const audit = new FakeAudit()
  const entry = { recordId: 'l1_x', viewerChannel: 'ch1', mode: 'shadow' as const, tAt: 5 }
  await audit.crossChannelUse(entry)
  await audit.crossChannelUse({ ...entry, recordId: 'l1_y' })
  assert.deepEqual(audit.entries, [entry, { ...entry, recordId: 'l1_y' }])
})

test('FakeLlm answers in order and records requests', async () => {
  const reply = { text: 'answer', tokens: 3 }
  const llm = new FakeLlm([reply, new Error('model failed')])
  const request = { system: 's', user: 'u', maxOutputTokens: 10 }
  assert.deepEqual(await llm.complete(request), reply)
  assert.deepEqual(llm.requests, [request])
  await assert.rejects(llm.complete(request), /model failed/)
  await assert.rejects(llm.complete(request), /FakeLlm has no more replies/)
  assert.equal(llm.requests.length, 3)
  assert.deepEqual(llm.requests[2], request)
})
