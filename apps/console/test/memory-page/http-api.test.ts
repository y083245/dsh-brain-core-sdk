import assert from 'node:assert/strict'
import test from 'node:test'
import { BrainError, type MemoryRecord } from '@dsh-brain-core/sdk'
import { createHttpMemoryPageApi } from '../../src/pages/memory/index.ts'

interface RecordedCall {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: unknown
}

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'l1_01',
    layer: 'L1',
    kind: 'l1.fact',
    source: 'plugin-a',
    channel: 'plugin-a:dm:u1',
    subjects: ['person_1'],
    actor: 'u1',
    content: { text: 'likes tea' },
    evidence: [{ id: 'l0_01' }],
    visibility: 'owner',
    trust: 'owner',
    confidence: 0.9,
    importance: 0.5,
    tEvent: 1000,
    tIngest: 1001,
    status: 'active',
    version: 1,
    ...overrides,
  }
}

function mockFetch(
  handler: (call: RecordedCall) => Response | Promise<Response>,
): { readonly fetchImpl: typeof globalThis.fetch; readonly calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: rawHeaders,
      body,
    }
    calls.push(call)
    return handler(call)
  }) as unknown as typeof globalThis.fetch
  return { fetchImpl, calls }
}

function okResponse(data: unknown, meta: Record<string, unknown> = {}, status = 200): Response {
  return new Response(
    JSON.stringify({ ok: true, data, meta: { requestId: 'req-1', apiVersion: '1.0', ...meta } }),
    { status, headers: { 'Content-Type': 'application/json' } },
  )
}

function errResponse(code: string, message: string, status: number): Response {
  return new Response(
    JSON.stringify({ ok: false, error: { code, message, details: {} }, meta: { requestId: 'req-err' } }),
    { status, headers: { 'Content-Type': 'application/json' } },
  )
}

test('createHttpMemoryPageApi routes browse, search, getRecord, getDependents, updateRecord, and forget', async () => {
  const rec = makeRecord()
  const { fetchImpl, calls } = mockFetch((call) => {
    if (call.url.includes('/api/v1/console/memory/records?')) {
      return okResponse({ items: [rec] }, { nextCursor: 'cur-2' })
    }
    if (call.url.endsWith('/api/v1/console/memory/records')) {
      return okResponse({ items: [rec], nextCursor: 'cur-1' })
    }
    if (call.url === 'http://127.0.0.1:9000/api/v1/memory/search') {
      return okResponse({ items: [{ record: rec, disclosure: { speakable: 'yes', label: 'owner' }, score: 0.8 }] }, { degraded: true, nextCursor: 's-2' })
    }
    if (call.url === 'http://127.0.0.1:9000/api/v1/console/memory/records/l1_01/dependents') {
      return okResponse({ items: [makeRecord({ id: 'l2_01', layer: 'L2' })] })
    }
    if (call.url === 'http://127.0.0.1:9000/api/v1/console/memory/records/missing') {
      return errResponse('NOT_FOUND', 'not found', 404)
    }
    if (call.url === 'http://127.0.0.1:9000/api/v1/console/memory/records/l1_01' && call.method === 'GET') {
      return okResponse(rec)
    }
    if (call.url === 'http://127.0.0.1:9000/api/v1/memory/records/l1_01' && call.method === 'PATCH') {
      return okResponse(makeRecord({ version: 2, status: 'outdated' }))
    }
    if (call.url === 'http://127.0.0.1:9000/api/v1/memory/forget') {
      return okResponse({ tombstoned: 1, invalidated: 2, l3Flagged: 1 })
    }
    return errResponse('NOT_FOUND', 'unexpected', 404)
  })

  const api = createHttpMemoryPageApi('http://127.0.0.1:9000/', 'secret-tok', fetchImpl)

  const b1 = await api.browse({})
  assert.equal(b1.items.length, 1)
  assert.equal(b1.nextCursor, 'cur-1')
  assert.equal(calls[0]?.headers.Authorization, 'Bearer secret-tok')

  const b2 = await api.browse({ layer: 'L1', personId: 'p1', channel: 'c1', cursor: 'cur-1', limit: 10 })
  assert.equal(b2.nextCursor, 'cur-2')
  assert.ok(calls[1]?.url.includes('layer=L1'))
  assert.ok(calls[1]?.url.includes('personId=p1'))
  assert.ok(calls[1]?.url.includes('channel=c1'))
  assert.ok(calls[1]?.url.includes('cursor=cur-1'))
  assert.ok(calls[1]?.url.includes('limit=10'))

  const s = await api.search({ query: 'tea', scope: 'all' })
  assert.equal(s.degraded, true)
  assert.equal(s.nextCursor, 's-2')
  assert.equal(s.items.length, 1)

  assert.equal((await api.getRecord('l1_01'))?.id, 'l1_01')
  assert.equal(await api.getRecord('missing'), null)

  const deps = await api.getDependents('l1_01')
  assert.equal(deps[0]?.id, 'l2_01')

  const updated = await api.updateRecord('l1_01', { status: 'outdated' }, 7)
  assert.equal(updated.version, 2)
  const patchCall = calls.find((c) => c.method === 'PATCH')
  assert.equal(patchCall?.headers['If-Match'], '7')

  const report = await api.forget({ by: 'record', id: 'l1_01' })
  assert.deepEqual(report, { tombstoned: 1, invalidated: 2, l3Flagged: 1 })
})

test('createHttpMemoryPageApi routes audit, cross-channel mode, and person merge/split', async () => {
  const { fetchImpl, calls } = mockFetch((call) => {
    if (call.url.endsWith('/api/v1/console/memory/audit')) {
      return okResponse([{ recordId: 'l1_1', viewerChannel: 'ch:2', mode: 'shadow', tAt: 10 }])
    }
    if (call.url.includes('/api/v1/console/memory/audit?recordId=l1_1')) {
      return okResponse({ items: [{ recordId: 'l1_1', viewerChannel: 'ch:2', mode: 'on', tAt: 20 }] })
    }
    if (call.url.endsWith('/api/v1/console/memory/cross-channel') && call.method === 'GET') {
      return okResponse({ mode: 'shadow' })
    }
    if (call.url.endsWith('/api/v1/console/memory/cross-channel') && call.method === 'PUT') {
      return okResponse({})
    }
    if (call.url.endsWith('/api/v1/console/memory/persons')) {
      return okResponse([{ personId: 'p1', accounts: ['tg:1'], aliases: ['a1'] }])
    }
    if (call.url.endsWith('/api/v1/console/memory/persons/merge')) {
      return okResponse({})
    }
    if (call.url.endsWith('/api/v1/console/memory/persons/p1/split')) {
      return okResponse({ personId: 'p2' })
    }
    return errResponse('INTERNAL', 'boom', 500)
  })

  const api = createHttpMemoryPageApi('http://127.0.0.1:9000', 'tok', fetchImpl)

  assert.equal((await api.listAudit()).length, 1)
  assert.equal((await api.listAudit('l1_1'))[0]?.mode, 'on')
  assert.equal(await api.getCrossChannelMode(), 'shadow')
  await api.setCrossChannelMode('on')
  assert.deepEqual(calls.find((c) => c.method === 'PUT')?.body, { mode: 'on' })

  assert.equal((await api.listPersons())[0]?.personId, 'p1')
  await api.mergePerson('p2', 'p1')
  assert.deepEqual(calls.find((c) => c.url.endsWith('/merge'))?.body, { from: 'p2', into: 'p1' })
  assert.equal(await api.splitPerson('p1', ['tg:2']), 'p2')
})

test('createHttpMemoryPageApi throws BrainError on CONFLICT and non-404 errors', async () => {
  const { fetchImpl } = mockFetch((call) => {
    if (call.method === 'PATCH') return errResponse('CONFLICT', 'version mismatch', 409)
    return errResponse('UNAVAILABLE', 'db down', 503)
  })

  const api = createHttpMemoryPageApi('http://127.0.0.1:9000', 'tok', fetchImpl)
  await assert.rejects(
    () => api.updateRecord('l1_01', { status: 'outdated' }, 1),
    (err: unknown) => err instanceof BrainError && err.code === 'CONFLICT',
  )
  await assert.rejects(
    () => api.getRecord('l1_01'),
    (err: unknown) => err instanceof BrainError && err.code === 'UNAVAILABLE',
  )
})

test('createHttpMemoryPageApi sends exact HTTP method, URL encoding, and request bodies for search/dependents/forget/split', async () => {
  const rec = makeRecord()
  const { fetchImpl, calls } = mockFetch((call) => {
    if (call.url.endsWith('/api/v1/memory/search')) {
      return okResponse({ items: [] })
    }
    if (call.url.includes('/dependents')) {
      return okResponse([rec])
    }
    if (call.url.endsWith('/api/v1/memory/forget')) {
      return okResponse({ tombstoned: 1, invalidated: 0, l3Flagged: 0 })
    }
    if (call.url.includes('/split')) {
      return okResponse('p_new')
    }
    return errResponse('NOT_FOUND', 'unexpected', 404)
  })

  const api = createHttpMemoryPageApi('http://127.0.0.1:9000', 'tok', fetchImpl)

  await api.search({ query: 'tea', scope: 'all' })
  assert.equal(calls[0]?.method, 'POST')
  assert.deepEqual(calls[0]?.body, { query: 'tea', scope: 'all' })

  await api.getDependents('l1/01?x')
  assert.ok(calls[1]?.url.endsWith('/api/v1/console/memory/records/l1%2F01%3Fx/dependents'))

  await api.forget({ by: 'record', id: 'l1_01' })
  assert.equal(calls[2]?.method, 'POST')
  assert.deepEqual(calls[2]?.body, { by: 'record', id: 'l1_01' })

  assert.equal(await api.splitPerson('p/1', ['tg:2', 'wx:3']), 'p_new')
  assert.equal(calls[3]?.method, 'POST')
  assert.ok(calls[3]?.url.endsWith('/api/v1/console/memory/persons/p%2F1/split'))
  assert.deepEqual(calls[3]?.body, { accounts: ['tg:2', 'wx:3'] })
})
