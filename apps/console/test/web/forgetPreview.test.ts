import assert from 'node:assert/strict'
import test from 'node:test'
import type { Layer, MemoryRecord } from '../../web/src/api/types.ts'
import {
  computeRecordForgetCascade,
  edgeKey,
  fetchAllBrowsePages,
  selectGraphRecords,
} from '../../web/src/pages/memory/forgetPreview.ts'

function makeRecord(overrides: Partial<MemoryRecord> & { id: string; layer: Layer }): MemoryRecord {
  return {
    kind: 'fact',
    source: 'console-chat',
    channel: 'console:private:owner',
    subjects: ['owner'],
    actor: 'owner',
    content: { text: `text-${overrides.id}` },
    evidence: [],
    visibility: 'owner',
    trust: 'owner',
    confidence: 0.9,
    importance: 0.5,
    tEvent: 1_700_000_000_000,
    tIngest: 1_700_000_000_000,
    status: 'active',
    version: 1,
    ...overrides,
  }
}

function createMockStore(records: readonly MemoryRecord[]) {
  const byId = new Map(records.map((r) => [r.id, r]))
  return {
    getRecord: async (id: string) => byId.get(id) ?? null,
    getDependents: async (id: string) =>
      records.filter((r) => r.evidence.some((ref) => ref.id === id)),
  }
}

test('single L0 cascade erases dependent L1/L2 and flags active L3 with exact depths and reversed edges', async () => {
  const l0 = makeRecord({ id: 'l0_1', layer: 'L0' })
  const l1 = makeRecord({ id: 'l1_1', layer: 'L1', evidence: [{ id: 'l0_1' }] })
  const l2 = makeRecord({ id: 'l2_1', layer: 'L2', evidence: [{ id: 'l1_1' }] })
  const l3 = makeRecord({ id: 'l3_1', layer: 'L3', kind: 'l3.self', evidence: [{ id: 'l2_1' }] })

  const result = await computeRecordForgetCascade(l0, createMockStore([l0, l1, l2, l3]))

  assert.equal(result.tombstonedRecords.length, 1)
  assert.equal(result.invalidatedRecords.length, 2)
  assert.equal(result.l3FlaggedRecords.length, 1)
  assert.equal(result.depthById.get('l0_1'), 0)
  assert.equal(result.depthById.get('l1_1'), 1)
  assert.equal(result.depthById.get('l2_1'), 2)
  assert.equal(result.depthById.get('l3_1'), 3)
  assert.ok(result.erasedDepthById.has('l0_1'))
  assert.ok(result.erasedDepthById.has('l1_1'))
  assert.ok(result.erasedDepthById.has('l2_1'))
  assert.ok(!result.erasedDepthById.has('l3_1'))
  assert.ok(result.outdatedIds.has('l3_1'))
  assert.equal(result.edgeDepthByKey.get(edgeKey('l0_1', 'l1_1')), 1)
  assert.equal(result.edgeDepthByKey.get(edgeKey('l1_1', 'l2_1')), 2)
  assert.equal(result.edgeDepthByKey.get(edgeKey('l2_1', 'l3_1')), 3)
})

test('dependent with another surviving evidence reference stays alive', async () => {
  const l0a = makeRecord({ id: 'l0_a', layer: 'L0' })
  const l0b = makeRecord({ id: 'l0_b', layer: 'L0' })
  const l1 = makeRecord({ id: 'l1_shared', layer: 'L1', evidence: [{ id: 'l0_a' }, { id: 'l0_b' }] })

  const result = await computeRecordForgetCascade(l0a, createMockStore([l0a, l0b, l1]))

  assert.equal(result.tombstonedRecords.length, 1)
  assert.equal(result.invalidatedRecords.length, 0)
  assert.equal(result.l3FlaggedRecords.length, 0)
  assert.ok(!result.depthById.has('l1_shared'))
})

test('consecutive forgets cascade accurately even when stale knownRecords still mark prior record active', async () => {
  const l0a = makeRecord({ id: 'l0_a', layer: 'L0' })
  const l0b = makeRecord({ id: 'l0_b', layer: 'L0' })
  const l1 = makeRecord({ id: 'l1_shared', layer: 'L1', evidence: [{ id: 'l0_a' }, { id: 'l0_b' }] })
  const l3 = makeRecord({ id: 'l3_self', layer: 'L3', kind: 'l3.self', evidence: [{ id: 'l1_shared' }] })

  const staleKnownRecords = new Map<string, MemoryRecord>([
    [l0a.id, l0a],
    [l0b.id, l0b],
    [l1.id, l1],
    [l3.id, l3],
  ])

  // First forget: l0_a is tombstoned, l1_shared still has l0_b so it survives.
  const first = await computeRecordForgetCascade(l0a, {
    ...createMockStore([l0a, l0b, l1, l3]),
    knownRecords: staleKnownRecords,
  })
  assert.equal(first.tombstonedRecords.length, 1)
  assert.equal(first.invalidatedRecords.length, 0)
  assert.equal(first.l3FlaggedRecords.length, 0)

  // Backend now reflects l0_a as tombstoned, while staleKnownRecords still claims l0_a is active.
  const l0aTombstoned = { ...l0a, status: 'tombstoned' as const }
  const second = await computeRecordForgetCascade(l0b, {
    ...createMockStore([l0aTombstoned, l0b, l1, l3]),
    knownRecords: staleKnownRecords,
  })

  assert.equal(second.tombstonedRecords.length, 1)
  assert.equal(second.invalidatedRecords.length, 1)
  assert.equal(second.invalidatedRecords[0]?.id, 'l1_shared')
  assert.equal(second.l3FlaggedRecords.length, 1)
  assert.equal(second.l3FlaggedRecords[0]?.id, 'l3_self')
  assert.equal(second.depthById.get('l0_b'), 0)
  assert.equal(second.depthById.get('l1_shared'), 1)
  assert.equal(second.depthById.get('l3_self'), 2)
  assert.equal(second.edgeDepthByKey.get(edgeKey('l0_b', 'l1_shared')), 1)
  assert.equal(second.edgeDepthByKey.get(edgeKey('l1_shared', 'l3_self')), 2)
})

test('diamond dependency re-checks and invalidates L2 once all branches are cascade-erased', async () => {
  const l0 = makeRecord({ id: 'l0_root', layer: 'L0' })
  const l1a = makeRecord({ id: 'l1_a', layer: 'L1', evidence: [{ id: 'l0_root' }] })
  const l1b = makeRecord({ id: 'l1_b', layer: 'L1', evidence: [{ id: 'l0_root' }] })
  const l2 = makeRecord({ id: 'l2_diamond', layer: 'L2', evidence: [{ id: 'l1_a' }, { id: 'l1_b' }] })

  const result = await computeRecordForgetCascade(l0, createMockStore([l0, l1a, l1b, l2]))

  assert.equal(result.tombstonedRecords.length, 1)
  assert.equal(result.invalidatedRecords.length, 3)
  assert.equal(result.depthById.get('l2_diamond'), 2)
  assert.equal(result.edgeDepthByKey.get(edgeKey('l1_a', 'l2_diamond')), 2)
  assert.equal(result.edgeDepthByKey.get(edgeKey('l1_b', 'l2_diamond')), 2)
})

test('cycle protection terminates cleanly even with cyclic evidence', async () => {
  const l1a = makeRecord({ id: 'l1_a', layer: 'L1', evidence: [{ id: 'l1_b' }] })
  const l1b = makeRecord({ id: 'l1_b', layer: 'L1', evidence: [{ id: 'l1_a' }] })

  const result = await computeRecordForgetCascade(l1a, createMockStore([l1a, l1b]))

  assert.equal(result.tombstonedRecords.length, 1)
  assert.equal(result.invalidatedRecords.length, 1)
  assert.equal(result.depthById.get('l1_a'), 0)
  assert.equal(result.depthById.get('l1_b'), 1)
})

test('L3 target returns empty cascade', async () => {
  const l3 = makeRecord({ id: 'l3_1', layer: 'L3', kind: 'l3.self' })
  const result = await computeRecordForgetCascade(l3, createMockStore([l3]))
  assert.equal(result.tombstonedRecords.length, 0)
  assert.equal(result.invalidatedRecords.length, 0)
  assert.equal(result.depthById.size, 0)
})

test('fetchAllBrowsePages walks cursor pages and remembers tailCursor', async () => {
  const pages: Record<string, { items: MemoryRecord[]; nextCursor?: string }> = {
    '': { items: [makeRecord({ id: 'r1', layer: 'L0' })], nextCursor: 'c1' },
    c1: { items: [makeRecord({ id: 'r2', layer: 'L0' })], nextCursor: 'c2' },
    c2: { items: [makeRecord({ id: 'r3', layer: 'L0' })] },
  }
  const result = await fetchAllBrowsePages(async (cursor) => pages[cursor ?? '']!)
  assert.equal(result.items.length, 3)
  assert.equal(result.tailCursor, 'c2')
  assert.equal(result.reachedPageCap, false)
})

test('selectGraphRecords caps L1 at 500, L0 at 1500, filters current L3, and flags truncation', () => {
  const l3 = [
    makeRecord({ id: 'l3_old', layer: 'L3', kind: 'l3.self', content: { profileVersion: 1 }, status: 'archived' }),
    makeRecord({ id: 'l3_cur', layer: 'L3', kind: 'l3.self', content: { profileVersion: 2 }, status: 'active' }),
  ]
  const l2 = [makeRecord({ id: 'l2_1', layer: 'L2' })]
  const l1 = Array.from({ length: 600 }, (_, i) =>
    makeRecord({ id: `l1_${String(i).padStart(4, '0')}`, layer: 'L1', tEvent: 1000 + i }),
  )
  const l0 = Array.from({ length: 2458 }, (_, i) =>
    makeRecord({ id: `l0_${String(i).padStart(4, '0')}`, layer: 'L0', tEvent: 1000 + i }),
  )

  const slice = selectGraphRecords({ l3, l2, l1, l0, currentL3Version: 2 })
  assert.equal(slice.truncated, true)
  assert.equal(slice.records.length, 1 + 1 + 500 + 1500)
  // Verify newest L0 record is retained
  assert.ok(slice.records.some((r) => r.id === 'l0_2457'))
  assert.ok(!slice.records.some((r) => r.id === 'l0_0000'))
  assert.ok(slice.records.some((r) => r.id === 'l3_cur'))
  assert.ok(!slice.records.some((r) => r.id === 'l3_old'))
})
