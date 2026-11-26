import assert from 'node:assert/strict'
import test from 'node:test'
import { ELSEWHERE, HERE, World, search } from './helpers.ts'

test('by record forgets exactly that record; a missing id and an L3 id select nothing', async () => {
  const w = new World()
  const target = await w.l0({ channel: HERE, content: { text: 'target' } })
  const bystander = await w.l0({ channel: HERE, content: { text: 'bystander' } })
  const profile = await w.insert({
    layer: 'L3',
    kind: 'l3.person',
    evidence: [{ id: bystander.id }],
    content: { text: 'profile' },
  })

  const report = await w.service().forget({ by: 'record', id: target.id })
  assert.deepEqual(report, { tombstoned: 1, invalidated: 0, l3Flagged: 0 })
  assert.equal(await w.statusOf(target.id), 'tombstoned')
  assert.equal(await w.statusOf(bystander.id), 'active')
  assert.equal(await w.statusOf(profile.id), 'active')
  assert.deepEqual(w.notifications, [[target.id]])
  assert.deepEqual(await search(w, 'target'), [])
  assert.deepEqual(await search(w, 'bystander'), [bystander.id])

  const missing = await w.service().forget({ by: 'record', id: 'l1_01MISSING000000000000000' })
  assert.deepEqual(missing, { tombstoned: 0, invalidated: 0, l3Flagged: 0 })

  // L3 is never edited directly (M3), so selecting one is an empty request.
  const byProfile = await w.service().forget({ by: 'record', id: profile.id })
  assert.deepEqual(byProfile, { tombstoned: 0, invalidated: 0, l3Flagged: 0 })
  assert.equal(await w.statusOf(profile.id), 'active')
  assert.equal(w.notifications.length, 1)
})

test('by channel forgets only records in that channel', async () => {
  const w = new World()
  const hereOne = await w.l0({ channel: HERE, content: { text: 'here one' } })
  const hereTwo = await w.l0({ channel: HERE, content: { text: 'here two' } })
  const elsewhere = await w.l0({ channel: ELSEWHERE, content: { text: 'elsewhere' } })
  const profileHere = await w.insert({
    layer: 'L3',
    kind: 'l3.person',
    channel: HERE,
    evidence: [{ id: hereOne.id }],
    content: { text: 'profile here' },
  })

  const report = await w.service().forget({ by: 'channel', channel: HERE })
  assert.deepEqual(report, { tombstoned: 2, invalidated: 0, l3Flagged: 1 })
  assert.equal(await w.statusOf(hereOne.id), 'tombstoned')
  assert.equal(await w.statusOf(hereTwo.id), 'tombstoned')
  assert.equal(await w.statusOf(elsewhere.id), 'active')
  assert.equal(await w.statusOf(profileHere.id), 'outdated')
  assert.deepEqual(await search(w, 'elsewhere'), [elsewhere.id])
  assert.deepEqual(await search(w, 'here one'), [])
})

test('by person takes what is about them and what they said, without duplicates or other people', async () => {
  const w = new World()
  const about = await w.l0({ channel: HERE, subjects: ['p_alice'], actor: 'owner', content: { text: 'about alice' } })
  const said = await w.l0({ channel: HERE, subjects: ['self'], actor: 'p_alice', content: { text: 'alice said' } })
  const both = await w.l0({ channel: HERE, subjects: ['p_alice'], actor: 'p_alice', content: { text: 'alice both' } })
  const other = await w.l0({ channel: HERE, subjects: ['p_bob'], actor: 'owner', content: { text: 'about bob' } })

  const report = await w.service().forget({ by: 'person', personId: 'p_alice' })
  // `both` is matched by both filters but counted once.
  assert.deepEqual(report, { tombstoned: 3, invalidated: 0, l3Flagged: 0 })
  for (const record of [about, said, both]) assert.equal(await w.statusOf(record.id), 'tombstoned')
  assert.equal(await w.statusOf(other.id), 'active')

  const ids = w.notifications[0]
  assert.ok(ids !== undefined)
  assert.equal(new Set(ids).size, ids.length)
  assert.deepEqual(ids, [...ids].sort())
  assert.deepEqual(new Set(ids), new Set([about.id, said.id, both.id]))
})

test('by time includes both ends', async () => {
  const w = new World()
  const before = await w.l0({ channel: HERE, tEvent: 99, content: { text: 'before' } })
  const fromEdge = await w.l0({ channel: HERE, tEvent: 100, content: { text: 'from edge' } })
  const middle = await w.l0({ channel: ELSEWHERE, tEvent: 150, content: { text: 'middle' } })
  const toEdge = await w.l0({ channel: HERE, tEvent: 200, content: { text: 'to edge' } })
  const after = await w.l0({ channel: HERE, tEvent: 201, content: { text: 'after' } })

  const report = await w.service().forget({ by: 'time', from: 100, to: 200 })
  assert.deepEqual(report, { tombstoned: 3, invalidated: 0, l3Flagged: 0 })
  assert.equal(await w.statusOf(before.id), 'active')
  assert.equal(await w.statusOf(fromEdge.id), 'tombstoned')
  assert.equal(await w.statusOf(middle.id), 'tombstoned')
  assert.equal(await w.statusOf(toEdge.id), 'tombstoned')
  assert.equal(await w.statusOf(after.id), 'active')
})

test('by channel pages through more than one page of records', async () => {
  const w = new World()
  for (let index = 0; index < 1001; index += 1) {
    await w.l0({ channel: HERE, content: { text: `paged ${index}` } })
  }

  const report = await w.service().forget({ by: 'channel', channel: HERE })
  assert.deepEqual(report, { tombstoned: 1001, invalidated: 0, l3Flagged: 0 })
  const ids = w.notifications[0]
  assert.ok(ids !== undefined)
  assert.equal(ids.length, 1001)

  // The second page must have been read: one leftover active L0 would fail this.
  const active = (await w.all()).filter((record) => record.status === 'active')
  assert.deepEqual(active, [])
})

test('by time and channel forgets only that channel inside the window', async () => {
  const w = new World()
  const hereInside = await w.l0({ channel: HERE, tEvent: 150, content: { text: 'here inside' } })
  const elsewhereInside = await w.l0({ channel: ELSEWHERE, tEvent: 150, content: { text: 'elsewhere inside' } })
  const hereOutside = await w.l0({ channel: HERE, tEvent: 300, content: { text: 'here outside' } })

  const report = await w.service().forget({ by: 'time', from: 100, to: 200, channel: HERE })
  assert.deepEqual(report, { tombstoned: 1, invalidated: 0, l3Flagged: 0 })
  assert.equal(await w.statusOf(hereInside.id), 'tombstoned')
  assert.equal(await w.statusOf(elsewhereInside.id), 'active')
  assert.equal(await w.statusOf(hereOutside.id), 'active')
})
