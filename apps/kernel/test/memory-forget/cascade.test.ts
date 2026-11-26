import assert from 'node:assert/strict'
import test from 'node:test'
import { BrainError } from '@brain-core/sdk'
import type { MemoryRecord, RecordPatch } from '@brain-core/sdk'
import { createForgetService } from '../../src/memory-forget/index.ts'
import { FakeClock, FakeKeywordIndex, FakeRecordStore } from '../fakes/index.ts'
import { ELSEWHERE, HERE, NOW, World, recordInput, search } from './helpers.ts'

test('an L1 that loses its only evidence is tombstoned; one with another valid L0 keeps its evidence', async () => {
  const w = new World()
  const doomed = await w.l0({ content: { text: 'doomed root' } })
  const survivor = await w.l0({ content: { text: 'other root' } })
  const sole = await w.insert({ evidence: [{ id: doomed.id }], content: { text: 'sole child' } })
  const backed = await w.insert({
    evidence: [{ id: doomed.id }, { id: survivor.id }],
    content: { text: 'backed child' },
  })

  const report = await w.service().forget({ by: 'record', id: doomed.id })
  assert.deepEqual(report, { tombstoned: 1, invalidated: 1, l3Flagged: 0 })
  assert.equal(await w.statusOf(sole.id), 'tombstoned')
  assert.deepEqual((await w.store.get(sole.id))?.content, {})

  // The invalid reference is kept: RecordPatch cannot change evidence, and a tombstone leaks nothing.
  const kept = await w.store.get(backed.id)
  assert.equal(kept?.status, 'active')
  assert.deepEqual(kept?.evidence, [{ id: doomed.id }, { id: survivor.id }])
  assert.equal(kept?.version, 1)

  // A kept record was not forgotten, so enhancement plugins must not drop their copy of it.
  const ids = w.notifications[0]
  assert.ok(ids !== undefined)
  assert.deepEqual(ids, [doomed.id, sole.id].sort())
  assert.equal(ids.includes(backed.id), false)

  assert.deepEqual(await search(w, 'sole child'), [])
  assert.deepEqual(await search(w, 'backed child'), [backed.id])
})

test('invalidation climbs L0 to L1 to L2, but an L2 with another valid L1 survives', async () => {
  const w = new World()
  const root = await w.l0({ content: { text: 'root memory' } })
  const otherRoot = await w.l0({ content: { text: 'other root' } })
  const l1 = await w.insert({ evidence: [{ id: root.id }], content: { text: 'level one' } })
  const l2 = await w.insert({
    layer: 'L2',
    kind: 'l2.scene',
    evidence: [{ id: l1.id }],
    content: { text: 'level two' },
  })
  const keptL1 = await w.insert({ evidence: [{ id: otherRoot.id }], content: { text: 'kept one' } })
  const keptL2 = await w.insert({
    layer: 'L2',
    kind: 'l2.scene',
    evidence: [{ id: l1.id }, { id: keptL1.id }],
    content: { text: 'kept two' },
  })

  const report = await w.service().forget({ by: 'record', id: root.id })
  assert.deepEqual(report, { tombstoned: 1, invalidated: 2, l3Flagged: 0 })
  assert.equal(await w.statusOf(l1.id), 'tombstoned')
  assert.equal(await w.statusOf(l2.id), 'tombstoned')
  assert.equal(await w.statusOf(keptL1.id), 'active')
  assert.equal(await w.statusOf(keptL2.id), 'active')
  assert.deepEqual((await w.store.get(keptL2.id))?.evidence, [{ id: l1.id }, { id: keptL1.id }])

  for (const text of ['root memory', 'level one', 'level two']) assert.deepEqual(await search(w, text), [])
  assert.deepEqual(await search(w, 'kept two'), [keptL2.id])
})

test('outdated and archived evidence still counts as valid', async () => {
  const w = new World()
  const doomed = await w.l0({ content: { text: 'doomed' } })
  const survivorA = await w.l0({ content: { text: 'survivor a' } })
  const survivorB = await w.l0({ content: { text: 'survivor b' } })
  const doomedL1 = await w.insert({ evidence: [{ id: doomed.id }], content: { text: 'doomed child' } })
  const archived = await w.insert({ evidence: [{ id: survivorA.id }], content: { text: 'archived child' } })
  const outdated = await w.insert({ evidence: [{ id: survivorB.id }], content: { text: 'outdated child' } })
  await w.store.patch(archived.id, { status: 'archived' }, archived.version)
  await w.store.patch(outdated.id, { status: 'outdated' }, outdated.version)
  // Evaluated because its other evidence is gone; the archived and outdated references keep it alive.
  const top = await w.insert({
    layer: 'L2',
    kind: 'l2.scene',
    evidence: [{ id: doomedL1.id }, { id: archived.id }, { id: outdated.id }],
    content: { text: 'top' },
  })

  const report = await w.service().forget({ by: 'record', id: doomed.id })
  assert.deepEqual(report, { tombstoned: 1, invalidated: 1, l3Flagged: 0 })
  assert.equal(await w.statusOf(doomedL1.id), 'tombstoned')
  assert.equal(await w.statusOf(archived.id), 'archived')
  assert.equal(await w.statusOf(outdated.id), 'outdated')
  assert.equal(await w.statusOf(top.id), 'active')
})

test('a diamond reaches the shared L2 exactly once', async () => {
  // Two same-layer records cannot cite each other (evidence must point lower), so the cycle check uses a diamond.
  const w = new World()
  const root = await w.l0({ content: { text: 'root' } })
  const left = await w.insert({ evidence: [{ id: root.id }], content: { text: 'left' } })
  const right = await w.insert({ evidence: [{ id: root.id }], content: { text: 'right' } })
  const top = await w.insert({
    layer: 'L2',
    kind: 'l2.scene',
    evidence: [{ id: left.id }, { id: right.id }],
    content: { text: 'top' },
  })

  const report = await w.service().forget({ by: 'record', id: root.id })
  assert.deepEqual(report, { tombstoned: 1, invalidated: 3, l3Flagged: 0 })
  assert.equal(await w.statusOf(top.id), 'tombstoned')
  assert.equal(w.store.dependentsCalls.filter((id) => id === top.id).length, 1)
})

test('a dependent kept early is re-checked once another of its evidence records is tombstoned later', async () => {
  // a is built first, so the cascade sees s while p is still alive; p dies only after b is processed.
  const w = new World()
  const a = await w.l0({ channel: HERE, content: { text: 'root a' } })
  const b = await w.l0({ channel: HERE, content: { text: 'root b' } })
  const p = await w.insert({ channel: ELSEWHERE, evidence: [{ id: b.id }], content: { text: 'middle p' } })
  const s = await w.insert({
    layer: 'L2',
    kind: 'l2.scene',
    channel: ELSEWHERE,
    evidence: [{ id: a.id }, { id: p.id }],
    content: { text: 'top s' },
  })

  const report = await w.service().forget({ by: 'channel', channel: HERE })
  assert.deepEqual(report, { tombstoned: 2, invalidated: 2, l3Flagged: 0 })
  assert.equal(await w.statusOf(p.id), 'tombstoned')
  assert.equal(await w.statusOf(s.id), 'tombstoned')
  assert.deepEqual(await search(w, 'top s'), [])
})

test('an L3 kept early is re-checked and flagged once a deeper record is tombstoned later', async () => {
  const w = new World()
  const a = await w.l0({ content: { text: 'root a' } })
  const p = await w.insert({ evidence: [{ id: a.id }], content: { text: 'middle p' } })
  const r = await w.insert({
    layer: 'L2',
    kind: 'l2.scene',
    evidence: [{ id: p.id }],
    content: { text: 'top r' },
  })
  const profile = await w.insert({
    layer: 'L3',
    kind: 'l3.person',
    evidence: [{ id: a.id }, { id: r.id }],
    content: { text: 'profile t' },
  })

  const report = await w.service().forget({ by: 'record', id: a.id })
  assert.deepEqual(report, { tombstoned: 1, invalidated: 2, l3Flagged: 1 })
  const after = await w.store.get(profile.id)
  assert.equal(after?.status, 'outdated')
  assert.deepEqual(after?.content, { text: 'profile t' })
})

test('a selected record that is a dependent of another selected record enters the queue once', async () => {
  const w = new World()
  const root = await w.l0({ channel: HERE, content: { text: 'selected root' } })
  const child = await w.insert({ channel: HERE, evidence: [{ id: root.id }], content: { text: 'selected child' } })

  const report = await w.service().forget({ by: 'channel', channel: HERE })
  assert.deepEqual(report, { tombstoned: 2, invalidated: 0, l3Flagged: 0 })
  assert.equal(await w.statusOf(root.id), 'tombstoned')
  assert.equal(await w.statusOf(child.id), 'tombstoned')
  assert.equal(w.store.dependentsCalls.filter((id) => id === root.id).length, 1)
  assert.equal(w.store.dependentsCalls.filter((id) => id === child.id).length, 1)

  const ids = w.notifications[0]
  assert.ok(ids !== undefined)
  assert.deepEqual(ids, [root.id, child.id].sort())
  assert.equal(new Set(ids).size, ids.length)
})

test('an L3 with no evidence left is set outdated with its content intact; one with other evidence stays active', async () => {
  const w = new World()
  const root = await w.l0({ content: { text: 'root' } })
  const otherRoot = await w.l0({ content: { text: 'other root' } })
  const emptied = await w.insert({
    layer: 'L3',
    kind: 'l3.person',
    evidence: [{ id: root.id }],
    content: { text: 'gone profile' },
  })
  const kept = await w.insert({
    layer: 'L3',
    kind: 'l3.person',
    evidence: [{ id: root.id }, { id: otherRoot.id }],
    content: { text: 'kept profile' },
  })

  const report = await w.service().forget({ by: 'record', id: root.id })
  assert.deepEqual(report, { tombstoned: 1, invalidated: 0, l3Flagged: 1 })

  const flagged = await w.store.get(emptied.id)
  assert.equal(flagged?.status, 'outdated')
  assert.deepEqual(flagged?.content, { text: 'gone profile' })
  const untouched = await w.store.get(kept.id)
  assert.equal(untouched?.status, 'active')
  assert.deepEqual(untouched?.content, { text: 'kept profile' })
  assert.notEqual(flagged?.status, 'tombstoned')
  assert.notEqual(untouched?.status, 'tombstoned')

  // L3 is not part of the notification set.
  assert.deepEqual(w.notifications, [[root.id]])
})

/** Bumps an L3 behind the caller's back, then reports the write as stale: the service must re-read and retry. */
class ConflictOnceStore extends FakeRecordStore {
  #conflicted = false

  override async patch(id: string, patch: RecordPatch, expectedVersion: number): Promise<MemoryRecord> {
    if (!this.#conflicted) {
      this.#conflicted = true
      const current = await this.get(id)
      if (current === null) throw new Error(`record ${id} vanished`)
      await super.patch(id, {}, current.version)
      throw new BrainError('CONFLICT', `record ${id} is at version ${current.version + 1}`)
    }
    return super.patch(id, patch, expectedVersion)
  }
}

test('an L3 patch that hits CONFLICT is re-read and retried once', async () => {
  const clock = new FakeClock(NOW)
  const store = new ConflictOnceStore(clock)
  const index = new FakeKeywordIndex()
  const root = await store.insert(recordInput({
    layer: 'L0',
    kind: 'l0.event',
    actor: 'system',
    channel: 'kernel:system:evidence',
    content: { text: 'root' },
  }))
  await index.add(root)
  const profile = await store.insert(recordInput({
    layer: 'L3',
    kind: 'l3.person',
    evidence: [{ id: root.id }],
    content: { text: 'profile' },
  }))
  await index.add(profile)

  const service = createForgetService({ store, index, onForgotten: async () => {} })
  const report = await service.forget({ by: 'record', id: root.id })

  assert.deepEqual(report, { tombstoned: 1, invalidated: 0, l3Flagged: 1 })
  const after = await store.get(profile.id)
  assert.equal(after?.status, 'outdated')
  // 1 → the simulated concurrent bump to 2 → the retry to 3.
  assert.equal(after?.version, 3)
})
