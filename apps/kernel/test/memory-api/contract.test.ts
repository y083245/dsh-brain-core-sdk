import assert from 'node:assert/strict'
import { connect } from 'node:net'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import test from 'node:test'
import { BrainError, LIMITS, validate, type MemoryRecord } from '@brain-core/sdk'
import type { Memory } from '../../src/memory-api/index.ts'
import {
  agentViewer, openTempBrain, OWNER_IDENTITY, startApi, type TestApi,
} from './helpers.ts'

type OkBody = {
  readonly ok: true
  readonly data: unknown
  readonly meta: { readonly requestId: string; readonly apiVersion?: string; readonly degraded?: boolean; readonly nextCursor?: string }
}
type ErrBody = {
  readonly ok: false
  readonly error: { readonly code: string; readonly message: string; readonly details: Record<string, unknown> }
  readonly meta: { readonly requestId: string }
}

function ok(body: Record<string, unknown>): OkBody {
  assert.equal(body.ok, true)
  return body as unknown as OkBody
}

function failure(body: Record<string, unknown>): ErrBody {
  assert.equal(body.ok, false)
  return body as unknown as ErrBody
}

async function ingestEvent(
  api: TestApi,
  options: { readonly key: string; readonly text?: string; readonly channel?: string; readonly actor?: string; readonly extra?: Record<string, unknown> },
): Promise<string> {
  const response = await api.request('POST', '/memory/events', {
    kind: 'chat.message',
    channel: options.channel ?? 'qq:group:1',
    subjects: [],
    actor: options.actor ?? 'p_alice',
    content: { text: options.text ?? '我今天读了一篇关于记忆的文章' },
    tEvent: Date.now(),
    idempotencyKey: options.key,
    ...options.extra,
  })
  assert.equal(response.status, 202)
  validate('Envelope', response.body)
  return (ok(response.body).data as { id: string }).id
}

async function createRecord(
  api: TestApi,
  evidence: string,
  options: { readonly text?: string; readonly channel?: string; readonly visibility?: string; readonly subjects?: readonly string[]; readonly extra?: Record<string, unknown> } = {},
): Promise<MemoryRecord> {
  const response = await api.request('POST', '/memory/records', {
    layer: 'L1',
    kind: 'l1.fact',
    channel: options.channel ?? 'qq:group:1',
    subjects: options.subjects ?? ['p_alice'],
    actor: 'p_alice',
    content: { text: options.text ?? '记忆很重要' },
    evidence: [{ id: evidence }],
    visibility: options.visibility ?? 'open',
    ...options.extra,
  })
  assert.equal(response.status, 200)
  validate('Envelope', response.body)
  const record = ok(response.body).data as MemoryRecord
  validate('MemoryRecord', record)
  return record
}

function recordRow(brain: { readonly paths: { readonly memory: string } }, id: string): { source: string; trust: string } {
  const db = new DatabaseSync(path.join(brain.paths.memory, 'records.db'))
  try {
    const row = db.prepare('SELECT source, trust FROM records WHERE id = ?').get(id) as { source: string; trust: string }
    return { source: row.source, trust: row.trust }
  } finally {
    db.close()
  }
}

function countRecords(brain: { readonly paths: { readonly memory: string } }, layer: string): number {
  const db = new DatabaseSync(path.join(brain.paths.memory, 'records.db'))
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM records WHERE layer = ?').get(layer) as { n: number }
    return Number(row.n)
  } finally {
    db.close()
  }
}

function findExternalIPv4(): string | undefined {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return undefined
}

/** 'CONNECTED' when the port answered, otherwise the socket error code (or ETIMEDOUT). */
function connectOutcome(port: number, host: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ port, host })
    let settled = false
    const done = (outcome: string): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(outcome)
    }
    socket.setTimeout(3000, () => done('ETIMEDOUT'))
    socket.once('connect', () => done('CONNECTED'))
    socket.once('error', (error: NodeJS.ErrnoException) => done(error.code ?? 'ERROR'))
  })
}

async function capture(fn: () => Promise<unknown>): Promise<BrainError | undefined> {
  try {
    await fn()
    return undefined
  } catch (error) {
    assert.ok(error instanceof BrainError)
    return error
  }
}

test('every route answers with a valid envelope and its own schema', async () => {
  const brain = await openTempBrain()
  const api = await startApi(brain.memory)
  try {
    const l0 = await ingestEvent(api, { key: 'contract-l0' })

    const created = await api.request('POST', '/memory/records', {
      layer: 'L1',
      kind: 'l1.fact',
      channel: 'qq:group:1',
      subjects: ['p_alice'],
      actor: 'p_alice',
      content: { text: '记忆很重要' },
      evidence: [{ id: l0 }],
      visibility: 'open',
    })
    assert.equal(created.status, 200)
    validate('Envelope', created.body)
    const record = ok(created.body).data as MemoryRecord
    validate('MemoryRecord', record)

    const patched = await api.request('PATCH', `/memory/records/${record.id}`, { content: { text: '改过了' } }, { 'If-Match': '1' })
    assert.equal(patched.status, 200)
    validate('Envelope', patched.body)
    validate('MemoryRecord', ok(patched.body).data)
    assert.equal((ok(patched.body).data as MemoryRecord).version, 2)

    const removed = await api.request('DELETE', `/memory/records/${record.id}`)
    assert.equal(removed.status, 200)
    validate('Envelope', removed.body)

    const search = await api.request('POST', '/memory/search', { query: '记忆', scope: 'all' })
    assert.equal(search.status, 200)
    validate('Envelope', search.body)
    const items = (ok(search.body).data as { items: unknown[] }).items
    assert.ok(items.length > 0)
    for (const item of items) validate('SearchHit', item)

    const context = await api.request('POST', '/memory/context', { channel: 'qq:group:1' })
    assert.equal(context.status, 200)
    validate('Envelope', context.body)
    validate('ContextBundle', ok(context.body).data)

    const forget = await api.request('POST', '/memory/forget', { by: 'record', id: l0 })
    assert.equal(forget.status, 200)
    validate('Envelope', forget.body)
    validate('ForgetReport', ok(forget.body).data)

    const job = await api.request('POST', '/memory/jobs', { type: 'rebuildIndex' })
    assert.equal(job.status, 200)
    validate('Envelope', job.body)
    const jobId = (ok(job.body).data as { id: string }).id

    const got = await api.request('GET', `/memory/jobs/${jobId}`)
    assert.equal(got.status, 200)
    validate('Envelope', got.body)

    const health = await api.request('GET', '/memory/health')
    assert.equal(health.status, 200)
    validate('Envelope', health.body)
    assert.deepEqual(ok(health.body).data, { store: 'ok', index: 'ok', jobs: 'ok' })
  } finally {
    await api.close()
    await brain.close()
  }
})

test('each error code crosses the envelope', async () => {
  const brain = await openTempBrain()
  const api = await startApi(brain.memory)
  const broken: Memory = {
    ...brain.memory,
    service: {
      ...brain.memory.service,
      health: async () => { throw new Error('secret detail') },
    },
  }
  const brokenApi = await startApi(broken, 'broken-token')
  try {
    const l0 = await ingestEvent(api, { key: 'errors-l0' })
    const record = await createRecord(api, l0)

    // 400: a required field is missing.
    const bad = await api.request('POST', '/memory/search', { query: '记忆' })
    assert.equal(bad.status, 400)
    validate('Envelope', bad.body)
    assert.equal(failure(bad.body).error.code, 'INVALID_ARGUMENT')

    // 401: wrong token.
    const unauthorized = await api.request('GET', '/memory/health', undefined, { Authorization: 'Bearer nope' })
    assert.equal(unauthorized.status, 401)
    assert.equal(failure(unauthorized.body).error.code, 'UNAUTHENTICATED')

    // 404: unknown job.
    const missing = await api.request('GET', '/memory/jobs/unknown')
    assert.equal(missing.status, 404)
    assert.equal(failure(missing.body).error.code, 'NOT_FOUND')

    // 409: stale version.
    const first = await api.request('PATCH', `/memory/records/${record.id}`, { content: { text: 'v2' } }, { 'If-Match': '1' })
    assert.equal(first.status, 200)
    const stale = await api.request('PATCH', `/memory/records/${record.id}`, { content: { text: 'v3' } }, { 'If-Match': '1' })
    assert.equal(stale.status, 409)
    validate('Envelope', stale.body)
    assert.equal(failure(stale.body).error.code, 'CONFLICT')

    // 413: one record's content is over the cap, the request body is not.
    const tooMuch = await api.request('POST', '/memory/records', {
      layer: 'L1',
      kind: 'l1.fact',
      channel: 'qq:group:1',
      subjects: ['p_alice'],
      actor: 'p_alice',
      content: { text: 'a'.repeat(LIMITS.contentBytes) },
      evidence: [{ id: l0 }],
    })
    assert.equal(tooMuch.status, 413)
    validate('Envelope', tooMuch.body)
    assert.equal(failure(tooMuch.body).error.code, 'PAYLOAD_TOO_LARGE')

    // 500: a component throws a plain Error; its message never reaches the response.
    const internal = await brokenApi.request('GET', '/memory/health')
    assert.equal(internal.status, 500)
    validate('Envelope', internal.body)
    assert.equal(failure(internal.body).error.code, 'INTERNAL')
    assert.equal(failure(internal.body).error.message, 'internal error')
    assert.deepEqual(failure(internal.body).error.details, {})
    assert.equal(JSON.stringify(internal.body).includes('secret detail'), false)

    // 503: no extraction model in S2.
    const unavailable = await api.request('POST', '/memory/jobs', { type: 'extract', from: 0, to: 1 })
    assert.equal(unavailable.status, 503)
    validate('Envelope', unavailable.body)
    assert.equal(failure(unavailable.body).error.code, 'UNAVAILABLE')
  } finally {
    await brokenApi.close()
    await api.close()
    await brain.close()
  }
})

test('the API only listens on the loopback address', async () => {
  const brain = await openTempBrain()
  const api = await startApi(brain.memory)
  try {
    const address = api.server.address()
    assert.ok(address !== null && typeof address === 'object')
    assert.equal((address as AddressInfo).address, '127.0.0.1')

    const external = findExternalIPv4()
    if (external === undefined) {
      console.log('no non-internal IPv4 address on this machine; skipped the outside-connection check')
      return
    }
    const outcome = await connectOutcome(api.port, external)
    assert.notEqual(outcome, 'CONNECTED', `the API answered on the external address ${external}`)
    if (process.platform === 'win32') {
      // The Windows runner's firewall drops the packet instead of sending a reset.
      console.log(`connecting to ${external}:${api.port} gave ${outcome} on Windows (not CONNECTED)`)
    } else {
      assert.equal(outcome, 'ECONNREFUSED')
    }
  } finally {
    await api.close()
    await brain.close()
  }
})

test('a missing, wrong or longer token is 401', async () => {
  const brain = await openTempBrain()
  const api = await startApi(brain.memory, 'test-token')
  try {
    const bare = await fetch(`http://127.0.0.1:${api.port}/api/v1/memory/health`)
    assert.equal(bare.status, 401)
    validate('Envelope', await bare.json() as Record<string, unknown>)

    for (const header of ['Bearer wrong-token', 'Bearer test-tokenx']) {
      const response = await api.request('GET', '/memory/health', undefined, { Authorization: header })
      assert.equal(response.status, 401)
      assert.equal(failure(response.body).error.code, 'UNAUTHENTICATED')
    }
  } finally {
    await api.close()
    await brain.close()
  }
})

test('idempotency and optimistic locking', async () => {
  const brain = await openTempBrain()
  const api = await startApi(brain.memory)
  try {
    const event = {
      kind: 'chat.message',
      channel: 'qq:group:1',
      subjects: [],
      actor: 'p_alice',
      content: { text: '同一条消息' },
      tEvent: Date.now(),
      idempotencyKey: 'same-key',
    }
    const first = await api.request('POST', '/memory/events', event)
    const second = await api.request('POST', '/memory/events', event)
    assert.equal(first.status, 202)
    assert.equal(second.status, 202)
    assert.equal((ok(first.body).data as { id: string }).id, (ok(second.body).data as { id: string }).id)
    assert.equal(countRecords(brain, 'L0'), 1)

    const l0 = (ok(first.body).data as { id: string }).id
    const record = await createRecord(api, l0)
    const stale = await api.request('PATCH', `/memory/records/${record.id}`, { content: { text: 'v2' } }, { 'If-Match': '2' })
    assert.equal(stale.status, 409)

    const headerSets: Record<string, string>[] = [{}, { 'If-Match': 'abc' }, { 'If-Match': '0' }]
    for (const headers of headerSets) {
      const response = await api.request('PATCH', `/memory/records/${record.id}`, { content: { text: 'v2' } }, headers)
      assert.equal(response.status, 400)
      assert.equal(failure(response.body).error.code, 'INVALID_ARGUMENT')
    }
  } finally {
    await api.close()
    await brain.close()
  }
})

test('a request body over the cap is 413', async () => {
  const brain = await openTempBrain()
  const api = await startApi(brain.memory)
  try {
    const huge = 'x'.repeat(LIMITS.requestBytes + 1)
    const response = await api.request('POST', '/memory/records', huge)
    assert.equal(response.status, 413)
    validate('Envelope', response.body)
    assert.equal(failure(response.body).error.code, 'PAYLOAD_TOO_LARGE')
  } finally {
    await api.close()
    await brain.close()
  }
})

test('an invisible record and a missing record are indistinguishable over HTTP', async () => {
  const brain = await openTempBrain()
  const api = await startApi(brain.memory)
  try {
    const missingId = 'l1_00000000000000000000000000'

    const missingPatch = await api.request('PATCH', `/memory/records/${missingId}`, { content: { text: 'x' } }, { 'If-Match': '1' })
    const missingDelete = await api.request('DELETE', `/memory/records/${missingId}`)
    assert.equal(missingPatch.status, 404)
    assert.equal(missingDelete.status, 404)

    // A tombstoned record is invisible too.
    const l0 = await ingestEvent(api, { key: 'tombstone' })
    const record = await createRecord(api, l0)
    const removed = await api.request('DELETE', `/memory/records/${record.id}`)
    assert.equal(removed.status, 200)

    const tombstonedPatch = await api.request('PATCH', `/memory/records/${record.id}`, { content: { text: 'x' } }, { 'If-Match': '1' })
    const tombstonedDelete = await api.request('DELETE', `/memory/records/${record.id}`)
    assert.equal(tombstonedPatch.status, 404)
    assert.equal(tombstonedDelete.status, 404)

    assert.deepEqual(tombstonedPatch.body.error, missingPatch.body.error)
    assert.deepEqual(tombstonedDelete.body.error, missingDelete.body.error)
  } finally {
    await api.close()
    await brain.close()
  }
})

test('the service layer gives the same NOT_FOUND for invisible and missing records', async () => {
  const brain = await openTempBrain()
  try {
    const l0 = await brain.memory.service.ingest({
      kind: 'chat.message', channel: 'qq:group:1', subjects: [], actor: 'p_alice',
      content: { text: '只给主人看' }, tEvent: Date.now(), idempotencyKey: 'hidden-l0',
    }, OWNER_IDENTITY)
    const hidden = await brain.memory.service.record({
      layer: 'L1', kind: 'l1.fact', channel: 'qq:group:1', subjects: ['p_alice'], actor: 'p_alice',
      content: { text: '只给主人看' }, evidence: [{ id: l0.id }], visibility: 'owner',
    }, OWNER_IDENTITY)

    const viewer = agentViewer('qq:group:1')
    const invisibleUpdate = await capture(() => brain.memory.service.update(hidden.id, {}, 1, OWNER_IDENTITY, viewer))
    const missingUpdate = await capture(() => brain.memory.service.update('l1_00000000000000000000000000', {}, 1, OWNER_IDENTITY, viewer))
    assert.ok(invisibleUpdate !== undefined && missingUpdate !== undefined)
    assert.equal(invisibleUpdate.code, missingUpdate.code)
    assert.equal(invisibleUpdate.message, missingUpdate.message)
    assert.deepEqual(invisibleUpdate.details, missingUpdate.details)

    const invisibleRemove = await capture(() => brain.memory.service.remove(hidden.id, OWNER_IDENTITY, viewer))
    const missingRemove = await capture(() => brain.memory.service.remove('l1_00000000000000000000000000', OWNER_IDENTITY, viewer))
    assert.ok(invisibleRemove !== undefined && missingRemove !== undefined)
    assert.equal(invisibleRemove.code, missingRemove.code)
    assert.equal(invisibleRemove.message, missingRemove.message)
    assert.deepEqual(invisibleRemove.details, missingRemove.details)
  } finally {
    await brain.close()
  }
})

test('viewer, source and trust in the body are ignored', async () => {
  const brain = await openTempBrain()
  const api = await startApi(brain.memory)
  try {
    const extra = {
      viewer: { caller: 'agent', channel: 'qq:group:1', participants: [] },
      source: 'evil',
      trust: 'self',
    }
    const l0 = await ingestEvent(api, { key: 'extra-l0', extra })
    const record = await createRecord(api, l0, { extra })
    assert.deepEqual(recordRow(brain, l0), { source: 'owner-console', trust: 'owner' })
    assert.deepEqual(recordRow(brain, record.id), { source: 'owner-console', trust: 'owner' })

    const clean = await api.request('POST', '/memory/search', { query: '记忆', scope: 'all' })
    const dirty = await api.request('POST', '/memory/search', { query: '记忆', scope: 'all', ...extra })
    assert.equal(clean.status, 200)
    assert.equal(dirty.status, 200)
    assert.deepEqual(ok(dirty.body).data, ok(clean.body).data)
  } finally {
    await api.close()
    await brain.close()
  }
})

test('an empty or malformed context request is 400, not 500', async () => {
  const brain = await openTempBrain()
  const api = await startApi(brain.memory)
  try {
    const noBody = await api.request('POST', '/memory/context')
    assert.equal(noBody.status, 400)
    validate('Envelope', noBody.body)
    assert.equal(failure(noBody.body).error.code, 'INVALID_ARGUMENT')

    for (const body of [[], { channel: 1 }]) {
      const response = await api.request('POST', '/memory/context', body)
      assert.equal(response.status, 400)
      assert.equal(failure(response.body).error.code, 'INVALID_ARGUMENT')
    }
  } finally {
    await api.close()
    await brain.close()
  }
})
