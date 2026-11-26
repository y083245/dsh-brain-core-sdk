import assert from 'node:assert/strict'
import test from 'node:test'
import { ELSEWHERE, HERE, World } from './helpers.ts'

test('running the same forget twice reports zeros but replays the same ids', async () => {
  const w = new World()
  const root = await w.l0({ content: { text: 'root' } })
  const l1 = await w.insert({ evidence: [{ id: root.id }], content: { text: 'one' } })
  const l2 = await w.insert({
    layer: 'L2',
    kind: 'l2.scene',
    evidence: [{ id: l1.id }],
    content: { text: 'two' },
  })
  const profile = await w.insert({
    layer: 'L3',
    kind: 'l3.person',
    evidence: [{ id: root.id }],
    content: { text: 'profile' },
  })

  const service = w.service()
  const first = await service.forget({ by: 'record', id: root.id })
  assert.deepEqual(first, { tombstoned: 1, invalidated: 2, l3Flagged: 1 })
  const afterFirst = await w.all()
  const idsFirst = w.notifications[0]
  assert.ok(idsFirst !== undefined)

  const second = await service.forget({ by: 'record', id: root.id })
  assert.deepEqual(second, { tombstoned: 0, invalidated: 0, l3Flagged: 0 })
  assert.deepEqual(await w.all(), afterFirst)
  assert.equal(w.notifications.length, 2)
  assert.deepEqual(w.notifications[1], idsFirst)

  // The notification is deduplicated and sorted by id, and never carries the L3 profile.
  assert.deepEqual(idsFirst, [...idsFirst].sort())
  assert.equal(new Set(idsFirst).size, idsFirst.length)
  assert.deepEqual(new Set(idsFirst), new Set([root.id, l1.id, l2.id]))
  assert.equal((await w.statusOf(profile.id)), 'outdated')
})

test('a failing onForgotten rejects the call; the next attempt re-sends the full list', async () => {
  const w = new World()
  const root = await w.l0({ content: { text: 'root' } })
  const l1 = await w.insert({ evidence: [{ id: root.id }], content: { text: 'child' } })
  const boom = new Error('plugin index is down')
  w.onForgotten = async () => {
    throw boom
  }
  const service = w.service()

  await assert.rejects(
    service.forget({ by: 'record', id: root.id }),
    (error: unknown) => error === boom,
  )
  // The storage changes are already committed when the notification fails.
  assert.equal(await w.statusOf(root.id), 'tombstoned')
  assert.equal(await w.statusOf(l1.id), 'tombstoned')
  const afterFailure = await w.all()

  w.onForgotten = async (ids) => {
    w.notifications.push(ids)
  }
  const retried = await service.forget({ by: 'record', id: root.id })
  assert.deepEqual(retried, { tombstoned: 0, invalidated: 0, l3Flagged: 0 })
  assert.deepEqual(await w.all(), afterFailure)
  assert.equal(w.notifications.length, 1)
  const ids = w.notifications[0]
  assert.ok(ids !== undefined)
  assert.deepEqual(ids, [root.id, l1.id].sort())
})

test('the report counts only what this call changed', async () => {
  const w = new World()
  const live = await w.l0({ subjects: ['p_zed'], actor: 'owner', channel: HERE, content: { text: 'live root' } })
  const already = await w.l0({ subjects: ['p_zed'], actor: 'owner', channel: HERE, content: { text: 'already gone' } })
  await w.forgetDirect(already)
  // These two are selected by neither flag of the person selector, so only the cascade can reach them.
  const l1 = await w.insert({
    kind: 'l1.fact',
    subjects: ['self'],
    actor: 'owner',
    channel: ELSEWHERE,
    evidence: [{ id: live.id }],
    content: { text: 'first level' },
  })
  const l2 = await w.insert({
    layer: 'L2',
    kind: 'l2.scene',
    subjects: ['self'],
    actor: 'owner',
    channel: ELSEWHERE,
    evidence: [{ id: l1.id }],
    content: { text: 'second level' },
  })
  const profile = await w.insert({
    layer: 'L3',
    kind: 'l3.person',
    subjects: ['p_zed'],
    evidence: [{ id: live.id }],
    content: { text: 'profile' },
  })

  const report = await w.service().forget({ by: 'person', personId: 'p_zed' })
  // Two L0 were selected, one of them already a tombstone; the cascade then took one L1, one L2 and one L3.
  assert.deepEqual(report, { tombstoned: 1, invalidated: 2, l3Flagged: 1 })
  assert.equal(await w.statusOf(live.id), 'tombstoned')
  assert.equal(await w.statusOf(already.id), 'tombstoned')
  assert.equal(await w.statusOf(l1.id), 'tombstoned')
  assert.equal(await w.statusOf(l2.id), 'tombstoned')
  assert.equal(await w.statusOf(profile.id), 'outdated')
})
