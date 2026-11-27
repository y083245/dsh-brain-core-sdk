import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { BrainError, type MemoryRecord } from '@dsh-brain-core/sdk'
import type { NewRecord, RecordFilter, RecordStore } from '../../src/contracts/index.ts'
import { FakeClock } from '../fakes/index.ts'

async function rejectsCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof BrainError, `expected BrainError, got ${String(error)}`)
    assert.equal(error.code, code)
    return true
  })
}

function recordInput(overrides: Partial<NewRecord> = {}): NewRecord {
  return {
    layer: 'L1',
    kind: 'l1.fact',
    source: 'plugin.test',
    channel: 'ch1',
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

function eventInput(overrides: Partial<NewRecord> = {}): NewRecord {
  return recordInput({ layer: 'L0', kind: 'l0.event', content: { text: 'raw' }, ...overrides })
}

async function listIds(store: RecordStore, filter: RecordFilter = {}, page: { limit: number; cursor?: string } = { limit: 1000 }): Promise<string[]> {
  return (await store.list(filter, page)).items.map((record) => record.id)
}

interface Dataset { readonly a: MemoryRecord; readonly b: MemoryRecord; readonly c: MemoryRecord; readonly d: MemoryRecord; readonly e: MemoryRecord }

async function dataset(store: RecordStore): Promise<Dataset> {
  const a = await store.insert(eventInput({ channel: 'ch1', actor: 'alice', subjects: ['s1'], tEvent: 100 }))
  const b = await store.insert(eventInput({ kind: 'l0.sys', channel: 'ch2', actor: 'bob', subjects: [], tEvent: 200 }))
  const c = await store.insert(recordInput({ kind: 'l1.fact', channel: 'ch1', actor: 'alice', subjects: ['s2'], tEvent: 300, evidence: [{ id: a.id }] }))
  const d = await store.insert(recordInput({ kind: 'l1.fact', channel: 'ch3', actor: 'carol', subjects: ['s1', 's2'], tEvent: 400, evidence: [{ id: b.id }] }))
  const e = await store.insert(recordInput({ layer: 'L2', kind: 'l2.scene', channel: 'ch2', actor: 'bob', subjects: ['s2'], tEvent: 500, evidence: [{ id: c.id }] }))
  return { a, b, c, d, e }
}

export function recordStoreSuite(name: string, open: (clock: FakeClock) => Promise<{ store: RecordStore; cleanup: () => Promise<void> }>): void {
  async function withStore<T>(fn: (store: RecordStore, clock: FakeClock) => Promise<T>): Promise<T> {
    const clock = new FakeClock()
    const opened = await open(clock)
    try {
      return await fn(opened.store, clock)
    } finally {
      await opened.store.close()
      await opened.cleanup()
    }
  }

  describe(name, () => {
    test('insert fills the envelope and get returns every field for all four layers', async () => {
      await withStore(async (store, clock) => {
        const zeroInput = eventInput({ tEvent: 100 })
        const zero = await store.insert(zeroInput)
        const oneInput = recordInput({ evidence: [{ id: zero.id }], tEvent: 200 })
        const one = await store.insert(oneInput)
        const twoInput = recordInput({ layer: 'L2', kind: 'l2.scene', evidence: [{ id: one.id }], tEvent: 300 })
        const two = await store.insert(twoInput)
        const threeInput = recordInput({ layer: 'L3', kind: 'l3.self', evidence: [{ id: two.id }], tEvent: 400, validFrom: 50 })
        const three = await store.insert(threeInput)

        const pairs = [
          [zero, zeroInput, 'L0'],
          [one, oneInput, 'L1'],
          [two, twoInput, 'L2'],
          [three, threeInput, 'L3'],
        ] as const
        for (const [stored, input, layer] of pairs) {
          assert.match(stored.id, new RegExp(`^${layer.toLowerCase()}_[0-9A-HJKMNP-TV-Z]{26}$`))
          assert.equal(stored.layer, layer)
          assert.equal(stored.status, 'active')
          assert.equal(stored.version, 1)
          assert.equal(stored.tIngest, clock.now())
          const read = await store.get(stored.id)
          assert.deepEqual(read, { ...input, id: stored.id, tIngest: clock.now(), status: 'active', version: 1 })
        }
      })
    })

    test('get returns null when missing', async () => {
      await withStore(async (store) => {
        assert.equal(await store.get('l1_missing'), null)
      })
    })

    test('insert validates evidence', async () => {
      await withStore(async (store) => {
        const zero = await store.insert(eventInput())
        const one = await store.insert(recordInput({ evidence: [{ id: zero.id }] }))

        await rejectsCode(store.insert(eventInput({ evidence: [{ id: zero.id }] })), 'INVALID_ARGUMENT')
        await rejectsCode(store.insert(recordInput({ evidence: [] })), 'INVALID_ARGUMENT')
        await rejectsCode(store.insert(recordInput({ evidence: [{ id: 'l0_missing' }] })), 'INVALID_ARGUMENT')
        await rejectsCode(store.insert(recordInput({ evidence: [{ id: one.id }] })), 'INVALID_ARGUMENT')

        await store.tombstone(zero.id)
        await rejectsCode(store.insert(recordInput({ evidence: [{ id: zero.id }] })), 'INVALID_ARGUMENT')

        const two = await store.insert(recordInput({ layer: 'L2', kind: 'l2.scene', evidence: [{ id: one.id }] }))
        assert.equal(two.layer, 'L2')
      })
    })

    test('patch rejects in the documented order and turns away tombstones', async () => {
      await withStore(async (store) => {
        const zero = await store.insert(eventInput())
        const a = await store.insert(recordInput({ evidence: [{ id: zero.id }] }))
        const b = await store.insert(recordInput({ evidence: [{ id: zero.id }] }))

        await rejectsCode(store.patch('l1_missing', {}, 1), 'NOT_FOUND')
        await rejectsCode(store.patch(zero.id, {}, 1), 'PERMISSION_DENIED')
        await rejectsCode(store.patch(zero.id, { status: 'tombstoned' }, 99), 'PERMISSION_DENIED')
        await rejectsCode(store.patch(a.id, {}, 99), 'CONFLICT')
        await rejectsCode(store.patch(a.id, { status: 'tombstoned' }, 99), 'CONFLICT')
        await rejectsCode(store.patch(a.id, { status: 'tombstoned' }, 1), 'INVALID_ARGUMENT')

        await store.tombstone(b.id)
        await rejectsCode(store.patch(b.id, {}, 2), 'NOT_FOUND')
      })
    })

    test('patch changes only the given fields and bumps the version', async () => {
      await withStore(async (store) => {
        const zero = await store.insert(eventInput())
        const c = await store.insert(recordInput({ evidence: [{ id: zero.id }], subjects: ['s1'] }))
        const patched = await store.patch(c.id, {
          content: { text: 'new' },
          subjects: ['s2', 's3'],
          visibility: 'owner',
          confidence: 0.9,
          status: 'archived',
          validTo: 5000,
        }, 1)
        assert.deepEqual(patched.content, { text: 'new' })
        assert.deepEqual(patched.subjects, ['s2', 's3'])
        assert.equal(patched.visibility, 'owner')
        assert.equal(patched.confidence, 0.9)
        assert.equal(patched.status, 'archived')
        assert.equal(patched.validTo, 5000)
        assert.equal(patched.version, 2)
        assert.equal(patched.id, c.id)
        assert.equal(patched.tIngest, c.tIngest)
        assert.equal(patched.importance, c.importance)
        assert.deepEqual(patched.evidence, c.evidence)
      })
    })

    test('tombstone is idempotent and bumps the version once', async () => {
      await withStore(async (store) => {
        const zero = await store.insert(eventInput())
        const c = await store.insert(recordInput({ evidence: [{ id: zero.id }] }))
        await rejectsCode(store.tombstone('l1_missing'), 'NOT_FOUND')
        const first = await store.tombstone(c.id)
        assert.equal(first.status, 'tombstoned')
        assert.deepEqual(first.content, {})
        assert.equal(first.version, c.version + 1)
        const second = await store.tombstone(c.id)
        assert.deepEqual(second, first)
        assert.deepEqual(await store.get(c.id), first)
      })
    })

    test('idempotency is scoped to source and returns the current state', async () => {
      await withStore(async (store) => {
        const base = await store.insert(eventInput())
        const first = await store.insert(recordInput({ evidence: [{ id: base.id }] }), 'k1')
        const again = await store.insert(recordInput({ evidence: [{ id: base.id }], content: { text: 'ignored' } }), 'k1')
        assert.equal(again.id, first.id)
        assert.deepEqual(again.content, first.content)
        assert.equal((await listIds(store, { layers: ['L1'] })).length, 1)

        const otherSource = await store.insert(recordInput({ evidence: [{ id: base.id }], source: 'other.plugin' }), 'k1')
        assert.notEqual(otherSource.id, first.id)

        const patched = await store.patch(first.id, { content: { text: 'patched' } }, 1)
        const afterPatch = await store.insert(recordInput({ evidence: [{ id: base.id }] }), 'k1')
        assert.equal(afterPatch.id, patched.id)
        assert.equal(afterPatch.version, 2)
        assert.deepEqual(afterPatch.content, { text: 'patched' })

        const noKeyA = await store.insert(eventInput())
        const noKeyB = await store.insert(eventInput())
        assert.notEqual(noKeyA.id, noKeyB.id)
      })
    })

    test('list applies every filter, with empty arrays matching nothing', async () => {
      await withStore(async (store) => {
        const { a, b, c, d, e } = await dataset(store)
        assert.deepEqual(await listIds(store), [a.id, b.id, c.id, d.id, e.id].sort())
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
    })

    test('list validates the page limit', async () => {
      await withStore(async (store) => {
        for (const limit of [0, 1001, 1.5, Number.NaN]) {
          await rejectsCode(store.list({}, { limit }), 'INVALID_ARGUMENT')
        }
      })
    })

    test('list paginates with an id cursor', async () => {
      await withStore(async (store) => {
        const ids: string[] = []
        for (let index = 0; index < 10; index += 1) ids.push((await store.insert(eventInput({ tEvent: index }))).id)
        ids.sort()

        const seen: string[] = []
        let cursor: string | undefined
        for (let page = 0; page < 4; page += 1) {
          const result = await store.list({}, { limit: 3, ...(cursor === undefined ? {} : { cursor }) })
          seen.push(...result.items.map((record) => record.id))
          if (page < 3) {
            assert.equal(result.items.length, 3)
            assert.equal(result.nextCursor, result.items[2]?.id)
            cursor = result.nextCursor
          } else {
            assert.equal(result.items.length, 1)
            assert.equal(result.nextCursor, undefined)
          }
        }
        assert.deepEqual(seen, ids)
        assert.equal(new Set(seen).size, 10)

        const pastEnd = await store.list({}, { limit: 3, cursor: ids[9] })
        assert.deepEqual(pastEnd.items, [])
        assert.equal(pastEnd.nextCursor, undefined)
      })
    })

    test('dependentsOf finds every status, sorted by id', async () => {
      await withStore(async (store) => {
        const { a, c } = await dataset(store)
        const extra = await store.insert(recordInput({ kind: 'l1.other', evidence: [{ id: a.id }] }))
        assert.deepEqual((await store.dependentsOf(a.id)).map((record) => record.id), [c.id, extra.id].sort())
        await store.tombstone(c.id)
        assert.deepEqual((await store.dependentsOf(a.id)).map((record) => record.id), [c.id, extra.id].sort())
        assert.deepEqual(await store.dependentsOf('l1_none'), [])
      })
    })

    test('scan yields every status in id order and honours the layer filter', async () => {
      await withStore(async (store) => {
        const { a, b, c, d, e } = await dataset(store)
        const all: string[] = []
        for await (const record of store.scan()) all.push(record.id)
        assert.deepEqual(all, [a.id, b.id, c.id, d.id, e.id].sort())

        await store.tombstone(c.id)
        const l1: string[] = []
        for await (const record of store.scan(['L1'])) l1.push(record.id)
        assert.deepEqual(l1, [c.id, d.id].sort())

        const none: string[] = []
        for await (const record of store.scan([])) none.push(record.id)
        assert.deepEqual(none, [])
      })
    })

    test('stored records and returned records are copies', async () => {
      await withStore(async (store) => {
        const zero = await store.insert(eventInput())
        const c = await store.insert(recordInput({ evidence: [{ id: zero.id }] }))
        const mutableInserted = c as unknown as { content: Record<string, unknown> }
        mutableInserted.content['text'] = 'mutated'
        const fetched = await store.get(c.id)
        assert.deepEqual(fetched?.content, { text: 'hello' })

        const mutableFetched = fetched as MemoryRecord
        ;(mutableFetched.content as Record<string, unknown>)['text'] = 'mutated again'
        const fetchedAgain = await store.get(c.id)
        assert.deepEqual(fetchedAgain?.content, { text: 'hello' })
      })
    })

    test('neighborsOf anchors by (tEvent, id) total order and keeps only same-channel active L0 records', async () => {
      await withStore(async (store, clock) => {
        // Insert out of chronological order and with same-millisecond ties.
        const mLate = await store.insert(eventInput({ channel: 'ch1', tEvent: 3000, content: { text: 't3000' } }))
        const mTie1 = await store.insert(eventInput({ channel: 'ch1', tEvent: 2000, content: { text: 't2000-a' } }))
        clock.advance(1)
        const mTie2 = await store.insert(eventInput({ channel: 'ch1', tEvent: 2000, content: { text: 't2000-b' } }))
        clock.advance(1)
        const mTie3 = await store.insert(eventInput({ channel: 'ch1', tEvent: 2000, content: { text: 't2000-c' } }))
        const mTomb = await store.insert(eventInput({ channel: 'ch1', tEvent: 2500, content: { text: 'tomb' } }))
        await store.tombstone(mTomb.id)
        await store.insert(eventInput({ channel: 'ch2', tEvent: 2000, content: { text: 'other-channel' } }))
        const mEarly = await store.insert(eventInput({ channel: 'ch1', tEvent: 1000, content: { text: 't1000' } }))
        const l1SameCh = await store.insert(recordInput({
          channel: 'ch1',
          tEvent: 2000,
          evidence: [{ id: mTie2.id }],
          content: { text: 'l1-ignored' },
        }))

        assert.ok(mTie1.id < mTie2.id && mTie2.id < mTie3.id)

        const mid = await store.neighborsOf!(mTie2.id, 2)
        assert.deepEqual(mid.before.map((r) => r.id), [mEarly.id, mTie1.id])
        assert.deepEqual(mid.after.map((r) => r.id), [mTie3.id, mLate.id])

        const one = await store.neighborsOf!(mTie2.id, 1)
        assert.deepEqual(one.before.map((r) => r.id), [mTie1.id])
        assert.deepEqual(one.after.map((r) => r.id), [mTie3.id])

        const zero = await store.neighborsOf!(mTie2.id, 0)
        assert.deepEqual(zero, { before: [], after: [] })

        const maxWindow = await store.neighborsOf!(mTie2.id, 10)
        assert.deepEqual(maxWindow.before.map((r) => r.id), [mEarly.id, mTie1.id])
        assert.deepEqual(maxWindow.after.map((r) => r.id), [mTie3.id, mLate.id])

        // Non-L0, tombstoned, or missing anchor returns empty.
        assert.deepEqual(await store.neighborsOf!(l1SameCh.id, 2), { before: [], after: [] })
        assert.deepEqual(await store.neighborsOf!(mTomb.id, 2), { before: [], after: [] })
        assert.deepEqual(await store.neighborsOf!('l0_missing', 2), { before: [], after: [] })

        // Invalid window values throw INVALID_ARGUMENT.
        for (const bad of [-1, 11, 1.5, Number.NaN]) {
          await assert.rejects(
            () => store.neighborsOf!(mTie2.id, bad),
            (error: unknown) => error instanceof BrainError && error.code === 'INVALID_ARGUMENT',
          )
        }
      })
    })
  })
}
