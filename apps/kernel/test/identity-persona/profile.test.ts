import assert from 'node:assert/strict'
import test from 'node:test'
import { BrainError, type MemoryRecord } from '@brain-core/sdk'
import type { NewRecord } from '../../src/contracts/index.ts'
import { createProfileStore, type ProfileStore } from '../../src/identity-persona/index.ts'
import { FakeClock, FakeRecordStore } from '../fakes/index.ts'

interface Setup {
  readonly clock: FakeClock
  readonly store: FakeRecordStore
  readonly evidence: MemoryRecord
  readonly profiles: ProfileStore
}

async function setup(): Promise<Setup> {
  const clock = new FakeClock()
  const store = new FakeRecordStore(clock)
  const evidence = await store.insert(l0(clock, 'she said hi'))
  const profiles = createProfileStore({ store, clock })
  return { clock, store, evidence, profiles }
}

function l0(clock: FakeClock, text: string): NewRecord {
  return {
    layer: 'L0',
    kind: 'qq.message',
    source: 'qq',
    channel: 'qq:group:1',
    subjects: ['self'],
    actor: 'self',
    content: { text },
    evidence: [],
    visibility: 'owner',
    trust: 'self',
    confidence: 1,
    importance: 1,
    tEvent: clock.now(),
  }
}

async function l3Records(store: FakeRecordStore, version?: number): Promise<readonly MemoryRecord[]> {
  const page = await store.list({ layers: ['L3'], kinds: ['l3.self'] }, { limit: 1000 })
  return version === undefined
    ? page.items
    : page.items.filter((record) => record.content.profileVersion === version)
}

async function versionRecord(store: FakeRecordStore, version: number): Promise<MemoryRecord> {
  const [record] = await l3Records(store, version)
  assert.notEqual(record, undefined, `no L3 record for version ${version}`)
  return record as MemoryRecord
}

async function expectCode(token: string, operation: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof BrainError, `${token}: expected BrainError`)
    assert.equal(error.code, code, `${token}: wrong error code`)
    return true
  })
}

test('commit stores versioned L3 records, and list, current and diff read them', async () => {
  const { clock, store, evidence, profiles } = await setup()
  assert.deepEqual(await profiles.current(), { version: 0, stable: '' })
  assert.deepEqual(await profiles.list(), [])

  const start = clock.now()
  const one: Record<string, unknown> = { a: 1, b: 'x', nested: { y: 1, x: 2 } }
  const two: Record<string, unknown> = { a: 1, c: true }
  const three: Record<string, unknown> = { a: 2, b: 'x', c: true, nested: { x: 2, y: 1 } }
  assert.equal(await profiles.commit({ stable: 'one', data: one, evidence: [{ id: evidence.id }] }), 1)
  clock.advance(1000)
  assert.equal(await profiles.commit({ stable: 'one', data: two, evidence: [{ id: evidence.id }] }), 2)
  clock.advance(1000)
  assert.equal(await profiles.commit({ stable: 'three', data: three, evidence: [{ id: evidence.id }] }), 3)

  const record = await versionRecord(store, 1)
  assert.equal(record.layer, 'L3')
  assert.equal(record.kind, 'l3.self')
  assert.equal(record.source, 'kernel')
  assert.equal(record.actor, 'kernel')
  assert.equal(record.channel, 'kernel:profile:self')
  assert.deepEqual(record.subjects, ['self'])
  assert.deepEqual(record.content, { profileVersion: 1, stable: 'one', data: one })
  assert.deepEqual(record.evidence, [{ id: evidence.id }])
  assert.equal(record.visibility, 'owner')
  assert.equal(record.trust, 'self')
  assert.equal(record.confidence, 1)
  assert.equal(record.importance, 1)
  assert.equal(record.tEvent, start)

  const listed = await profiles.list()
  assert.deepEqual(listed.map((entry) => entry.version), [1, 2, 3])
  assert.deepEqual(listed.map((entry) => entry.status), ['active', 'active', 'active'])
  assert.deepEqual(listed.map((entry) => entry.current), [false, false, true])
  assert.deepEqual(listed.map((entry) => entry.tAt), (await l3Records(store)).map((item) => item.tIngest))
  assert.deepEqual(await profiles.current(), { version: 3, stable: 'three' })

  assert.deepEqual(await profiles.diff(1, 3), {
    from: 1,
    to: 3,
    stableChanged: true,
    added: ['c'],
    removed: [],
    changed: ['a'],
  })
  assert.deepEqual(await profiles.diff(3, 1), {
    from: 3,
    to: 1,
    stableChanged: true,
    added: [],
    removed: ['c'],
    changed: ['a'],
  })
  assert.deepEqual(await profiles.diff(1, 2), {
    from: 1,
    to: 2,
    stableChanged: false,
    added: ['c'],
    removed: ['b', 'nested'],
    changed: [],
  })
  await expectCode('missing-a', profiles.diff(99, 1), 'NOT_FOUND')
  await expectCode('missing-b', profiles.diff(1, 99), 'NOT_FOUND')
})

test('rollback moves the current version and never deletes a version', async () => {
  const { store, evidence, profiles } = await setup()
  const evidenceRef = [{ id: evidence.id }]
  await profiles.commit({ stable: 'one', data: { a: 1 }, evidence: evidenceRef })
  await profiles.commit({ stable: 'two', data: { a: 2 }, evidence: evidenceRef })
  await profiles.commit({ stable: 'three', data: { a: 3 }, evidence: evidenceRef })

  assert.equal(await profiles.rollback(1), 1)
  assert.deepEqual(await profiles.current(), { version: 1, stable: 'one' })
  assert.deepEqual((await profiles.list()).map((entry) => entry.status), ['active', 'archived', 'archived'])
  assert.deepEqual((await profiles.list()).map((entry) => entry.current), [true, false, false])
  assert.equal((await l3Records(store)).length, 3)
  for (const version of [1, 2, 3]) {
    assert.notEqual((await versionRecord(store, version)).status, 'tombstoned')
  }

  // A later version can be made current again, and versions older than it stay untouched.
  assert.equal(await profiles.rollback(3), 3)
  assert.deepEqual(await profiles.current(), { version: 3, stable: 'three' })
  assert.deepEqual((await profiles.list()).map((entry) => entry.status), ['active', 'archived', 'active'])
  assert.deepEqual((await profiles.list()).map((entry) => entry.current), [false, false, true])

  // New commits keep numbering upward from the highest version ever written.
  assert.equal(await profiles.rollback(1), 1)
  assert.equal(await profiles.commit({ stable: 'four', data: { a: 4 }, evidence: evidenceRef }), 4)
  assert.deepEqual(await profiles.current(), { version: 4, stable: 'four' })
  assert.deepEqual((await profiles.list()).map((entry) => entry.version), [1, 2, 3, 4])

  await expectCode('missing', profiles.rollback(99), 'NOT_FOUND')
})

test('an outdated version cannot be rolled back and a tombstoned one is gone', async () => {
  const { store, evidence, profiles } = await setup()
  const evidenceRef = [{ id: evidence.id }]
  await profiles.commit({ stable: 'one', data: { a: 1 }, evidence: evidenceRef })
  await profiles.commit({ stable: 'two', data: { a: 2 }, evidence: evidenceRef })
  await profiles.commit({ stable: 'three', data: { a: 3 }, evidence: evidenceRef })

  const second = await versionRecord(store, 2)
  await store.tombstone(evidence.id)
  await store.patch(second.id, { status: 'outdated' }, second.version)

  await expectCode('outdated', profiles.rollback(2), 'INVALID_ARGUMENT')
  // The current version is untouched by the rejected rollback.
  assert.equal((await profiles.current()).version, 3)

  const third = await versionRecord(store, 3)
  await store.tombstone(third.id)
  await expectCode('tombstoned', profiles.rollback(3), 'NOT_FOUND')
})

test('commit needs evidence, stable reads are byte-identical and concurrent commits differ', async () => {
  const { clock, store, evidence, profiles } = await setup()
  await expectCode('no-evidence', profiles.commit({ stable: 'x', data: {}, evidence: [] }), 'INVALID_ARGUMENT')

  await profiles.commit({ stable: 'a stable string', data: { text: 'hello' }, evidence: [{ id: evidence.id }] })
  const first = JSON.stringify(await profiles.current())
  const second = JSON.stringify(await profiles.current())
  assert.equal(first, second)
  assert.equal((await profiles.current()).stable, 'a stable string')

  const other = new FakeRecordStore(clock)
  const otherEvidence = await other.insert(l0(clock, 'second store'))
  const concurrent = createProfileStore({ store: other, clock })
  const versions = await Promise.all([
    concurrent.commit({ stable: 'p', data: { n: 1 }, evidence: [{ id: otherEvidence.id }] }),
    concurrent.commit({ stable: 'q', data: { n: 2 }, evidence: [{ id: otherEvidence.id }] }),
  ])
  assert.equal(new Set(versions).size, 2)
  assert.deepEqual((await concurrent.list()).map((entry) => entry.version), [1, 2])

  // The first store still has exactly the versions it was given.
  assert.deepEqual((await profiles.list()).map((entry) => entry.version), [1])
  assert.equal((await l3Records(store)).length, 1)
})

test('editByOwner records author, ownerLockedKeys, and getVersion returns detail', async () => {
  const { clock, evidence, profiles } = await setup()
  await expectCode(
    'edit-without-base-needs-evidence',
    profiles.editByOwner({ data: { catchphrase: '主人先写' } }),
    'INVALID_ARGUMENT',
  )

  const v1 = await profiles.commit({
    stable: 'initial stable',
    data: { catchphrase: '默认口头禅', hobby: '听歌' },
    evidence: [{ id: evidence.id }],
    author: 'settlement',
  })
  assert.equal(v1, 1)

  clock.advance(1000)
  const v2 = await profiles.editByOwner({
    data: { catchphrase: '主人定的口头禅', hobby: '听歌' },
  })
  assert.equal(v2, 2)

  clock.advance(1000)
  const v3 = await profiles.editByOwner({
    stable: 'owner stable',
    data: { catchphrase: '主人定的口头禅', hobby: '听歌', tone: '温和' },
    lockedKeys: ['extraKey'],
  })
  assert.equal(v3, 3)

  const listed = await profiles.list()
  assert.deepEqual(listed.map((v) => v.author), ['settlement', 'owner', 'owner'])
  assert.deepEqual(listed.map((v) => v.evidenceCount), [1, 1, 1])
  assert.deepEqual(listed[1]?.ownerLockedKeys, ['catchphrase'])
  assert.deepEqual(listed[2]?.ownerLockedKeys, ['catchphrase', 'extraKey', 'tone'])

  const detail = await profiles.getVersion(3)
  assert.equal(detail.version, 3)
  assert.equal(detail.current, true)
  assert.equal(detail.author, 'owner')
  assert.equal(detail.stable, 'owner stable')
  assert.deepEqual(detail.data, { catchphrase: '主人定的口头禅', hobby: '听歌', tone: '温和' })
  assert.deepEqual(detail.evidence, [{ id: evidence.id }])
  assert.deepEqual(detail.ownerLockedKeys, ['catchphrase', 'extraKey', 'tone'])

  await expectCode('missing-version', profiles.getVersion(99), 'NOT_FOUND')

  // Rollback back to v1 makes current() return v1 and getVersion(1).current === true.
  await profiles.rollback(1)
  assert.deepEqual(await profiles.current(), { version: 1, stable: 'initial stable' })
  assert.equal((await profiles.getVersion(1)).current, true)
  assert.equal((await profiles.getVersion(3)).current, false)
})
