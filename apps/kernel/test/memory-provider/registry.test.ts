import assert from 'node:assert/strict'
import test from 'node:test'
import { BrainError, type MemoryProvider, type MemoryProviderQuery, type MemoryRecord } from '@brain-core/sdk'
import type { Logger, LogFields } from '../../src/log/index.ts'
import { createMemoryProviderRegistry, fuseRankings } from '../../src/memory-provider/index.ts'

function makeQuery(overrides: Partial<MemoryProviderQuery> = {}): MemoryProviderQuery {
  return { query: 'hello', limit: 10, ...overrides }
}

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'l0_01',
    layer: 'L0',
    kind: 'qq.message',
    source: 'qq',
    channel: 'qq:private:1',
    subjects: ['p1'],
    actor: 'p1',
    content: { text: 'hello' },
    evidence: [],
    visibility: 'origin',
    trust: 'member',
    confidence: 1,
    importance: 0.5,
    tEvent: 1000,
    tIngest: 1000,
    status: 'active',
    version: 1,
    ...overrides,
  }
}

function spyLog(): { log: Logger; warnings: { event: string; fields?: LogFields }[] } {
  const warnings: { event: string; fields?: LogFields }[] = []
  return {
    warnings,
    log: {
      info: () => undefined,
      warn: (event, fields) => warnings.push({ event, fields }),
      error: () => undefined,
    },
  }
}

test('fuseRankings computes 1/(k+rank+1) RRF scores and breaks ties deterministically by id asc', () => {
  const listA = [
    { id: 'r2', score: 0.9 },
    { id: 'r1', score: 0.8 },
    { id: 'r3', score: 0.5 },
  ]
  const listB = [
    { id: 'r1', score: 0.95 },
    { id: 'r4', score: 0.7 },
  ]
  const fused = fuseRankings([listA, [], listB])
  // r1: 1/(60+1+1) + 1/(60+0+1) = 1/62 + 1/61
  // r2: 1/61
  // r4: 1/62
  // r3: 1/63
  assert.deepEqual(fused.map((h) => h.id), ['r1', 'r2', 'r4', 'r3'])
  assert.ok(Math.abs(fused[0]!.score - (1 / 62 + 1 / 61)) < 1e-12)
  assert.ok(Math.abs(fused[1]!.score - 1 / 61) < 1e-12)

  // Exact tie across symmetric lists breaks by id asc
  const tied = fuseRankings([
    [{ id: 'b', score: 1 }],
    [{ id: 'a', score: 1 }],
  ], 10)
  assert.deepEqual(tied, [
    { id: 'a', score: 1 / 11 },
    { id: 'b', score: 1 / 11 },
  ])
})

test('register, listIds, conflict detection, and idempotent unregister work', () => {
  const registry = createMemoryProviderRegistry()
  assert.equal(registry.hasProviders(), false)
  assert.deepEqual(registry.listIds(), [])

  const providerA: MemoryProvider = { search: async () => [], onForgotten: async () => undefined }
  const providerB: MemoryProvider = { search: async () => [], onForgotten: async () => undefined }
  const disposeB = registry.register('zeta', providerB)
  const disposeA = registry.register('alpha', providerA)

  assert.equal(registry.hasProviders(), true)
  assert.deepEqual(registry.listIds(), ['alpha', 'zeta'])

  assert.throws(
    () => registry.register('alpha', providerA),
    (err: unknown) => err instanceof BrainError && err.code === 'CONFLICT',
  )

  disposeA()
  disposeA() // idempotent
  assert.deepEqual(registry.listIds(), ['zeta'])

  // Re-registering zeta after disposing does not let the old disposer remove the new registration
  disposeB()
  const providerB2: MemoryProvider = { search: async () => [], onForgotten: async () => undefined }
  const disposeB2 = registry.register('zeta', providerB2)
  disposeB()
  assert.deepEqual(registry.listIds(), ['zeta'])
  disposeB2()
  assert.equal(registry.hasProviders(), false)
})

test('search returns inactive empty result with zero providers and fuses multiple providers when active', async () => {
  const registry = createMemoryProviderRegistry()
  assert.deepEqual(await registry.search(makeQuery()), { hits: [], degraded: false, active: false })

  registry.register('p1', {
    search: async () => [{ id: 'm1', score: 0.9 }, { id: 'm2', score: 0.6 }],
    onForgotten: async () => undefined,
  })
  registry.register('p2', {
    search: async () => [{ id: 'm2', score: 0.95 }, { id: 'm3', score: 0.4 }],
    onForgotten: async () => undefined,
  })

  const res = await registry.search(makeQuery())
  assert.equal(res.active, true)
  assert.equal(res.degraded, false)
  assert.deepEqual(res.hits.map((h) => h.id), ['m2', 'm1', 'm3'])
})

test('search degrades gracefully on timeout or crash while preserving healthy provider hits', async () => {
  const { log, warnings } = spyLog()
  const registry = createMemoryProviderRegistry({ timeoutMs: 40, log })

  registry.register('slow', {
    search: () => new Promise((resolve) => setTimeout(() => resolve([{ id: 'late', score: 1 }]), 250)),
    onForgotten: async () => undefined,
  })
  registry.register('broken', {
    search: async () => { throw new Error('process exited') },
    onForgotten: async () => undefined,
  })
  registry.register('healthy', {
    search: async () => [{ id: 'good', score: 0.8 }],
    onForgotten: async () => undefined,
  })

  const res = await registry.search(makeQuery())
  assert.equal(res.active, true)
  assert.equal(res.degraded, true)
  assert.deepEqual(res.hits.map((h) => h.id), ['good'])
  assert.equal(warnings.length, 2)
  assert.ok(warnings.some((w) => w.fields?.plugin === 'slow' && w.fields?.code === 'UNAVAILABLE'))
  assert.ok(warnings.some((w) => w.fields?.plugin === 'broken' && w.fields?.code === 'INTERNAL'))
})

test('search rethrows BrainError EMBEDDING_MISMATCH immediately without swallowing or degrading', async () => {
  const { log, warnings } = spyLog()
  const registry = createMemoryProviderRegistry({ timeoutMs: 500, log })

  registry.register('ok', {
    search: async () => [{ id: 'ok1', score: 1 }],
    onForgotten: async () => undefined,
  })
  registry.register('mismatch', {
    search: async () => { throw new BrainError('EMBEDDING_MISMATCH', 'model changed') },
    onForgotten: async () => undefined,
  })

  await assert.rejects(
    () => registry.search(makeQuery()),
    (err: unknown) => err instanceof BrainError && err.code === 'EMBEDDING_MISMATCH',
  )
  assert.equal(warnings.length, 0)
})

test('notifyRecorded forwards only active non-L3 records and isolates failures', async () => {
  const { log, warnings } = spyLog()
  const registry = createMemoryProviderRegistry({ timeoutMs: 100, log })
  const seen: string[] = []

  registry.register('failing', {
    search: async () => [],
    onRecord: async () => { throw new BrainError('UNAVAILABLE', 'boom') },
    onForgotten: async () => undefined,
  })
  registry.register('receiver', {
    search: async () => [],
    onRecord: async (record) => { seen.push(record.id) },
    onForgotten: async () => undefined,
  })
  registry.register('minimal', {
    search: async () => [],
    onForgotten: async () => undefined,
  })

  await registry.notifyRecorded(makeRecord({ id: 'l0_active', layer: 'L0', status: 'active' }))
  await registry.notifyRecorded(makeRecord({ id: 'l1_active', layer: 'L1', status: 'active' }))
  await registry.notifyRecorded(makeRecord({ id: 'l0_outdated', layer: 'L0', status: 'outdated' }))
  await registry.notifyRecorded(makeRecord({ id: 'l3_active', layer: 'L3', status: 'active' }))

  assert.deepEqual(seen, ['l0_active', 'l1_active'])
  assert.equal(warnings.length, 2)
})

test('notifyForgotten reaches all active providers concurrently and stops after unregister', async () => {
  const { log, warnings } = spyLog()
  const registry = createMemoryProviderRegistry({ timeoutMs: 100, log })
  const callsA: (readonly string[])[] = []
  const callsB: (readonly string[])[] = []

  const disposeA = registry.register('a', {
    search: async () => [],
    onForgotten: async (ids) => { callsA.push(ids) },
  })
  registry.register('b', {
    search: async () => [],
    onForgotten: async () => { throw new Error('disk full') },
  })
  registry.register('c', {
    search: async () => [],
    onForgotten: async (ids) => { callsB.push(ids) },
  })

  await registry.notifyForgotten([])
  assert.equal(callsA.length, 0)

  await registry.notifyForgotten(['id1', 'id2'])
  assert.deepEqual(callsA, [['id1', 'id2']])
  assert.deepEqual(callsB, [['id1', 'id2']])
  assert.equal(warnings.length, 1)

  disposeA()
  await registry.notifyForgotten(['id3'])
  assert.equal(callsA.length, 1)
  assert.deepEqual(callsB, [['id1', 'id2'], ['id3']])
})

test('health aggregates provider statuses and treats timeouts as degraded', async () => {
  const registryEmpty = createMemoryProviderRegistry()
  assert.equal(await registryEmpty.health(), undefined)

  const registryOk = createMemoryProviderRegistry()
  registryOk.register('a', {
    search: async () => [],
    onForgotten: async () => undefined,
    health: async () => ({ status: 'ok' }),
  })
  registryOk.register('b', {
    search: async () => [],
    onForgotten: async () => undefined,
  })
  assert.equal(await registryOk.health(), 'ok')

  const registryMixed = createMemoryProviderRegistry({ timeoutMs: 30 })
  registryMixed.register('a', {
    search: async () => [],
    onForgotten: async () => undefined,
    health: async () => ({ status: 'ok' }),
  })
  registryMixed.register('b', {
    search: async () => [],
    onForgotten: async () => undefined,
    health: async () => ({ status: 'down' }),
  })
  assert.equal(await registryMixed.health(), 'degraded')

  const registryDown = createMemoryProviderRegistry({ timeoutMs: 30 })
  registryDown.register('a', {
    search: async () => [],
    onForgotten: async () => undefined,
    health: async () => ({ status: 'down' }),
  })
  registryDown.register('b', {
    search: async () => [],
    onForgotten: async () => undefined,
    health: () => new Promise((resolve) => setTimeout(() => resolve({ status: 'ok' }), 200)),
  })
  assert.equal(await registryDown.health(), 'down')
})
