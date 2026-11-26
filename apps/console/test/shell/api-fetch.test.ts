import assert from 'node:assert/strict'
import test from 'node:test'
import { apiFetch } from '../../src/shell/api-fetch.ts'

function jsonResponse(body: unknown, status = 200): typeof globalThis.fetch {
  return responseOf(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }))
}

interface Recorded {
  readonly url: string
  readonly init: RequestInit | undefined
}

function responseOf(response: Response): typeof globalThis.fetch {
  return recordingFetch(response).fetchImpl
}

function recordingFetch(response: Response | (() => Promise<Response>)): { fetchImpl: typeof globalThis.fetch; calls: Recorded[] } {
  const calls: Recorded[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return typeof response === 'function' ? await response() : response
  }) as unknown as typeof globalThis.fetch
  return { fetchImpl, calls }
}

const OK_META = { requestId: 'req-1', apiVersion: '1.0' }

test('apiFetch returns data and meta from a success envelope', async () => {
  const { fetchImpl } = recordingFetch(new Response(
    JSON.stringify({ ok: true, data: { hello: 'world' }, meta: OK_META }),
    { status: 200 },
  ))
  const result = await apiFetch<{ hello: string }>('http://127.0.0.1:1/api/v1/console/settings', { fetchImpl })
  assert.deepEqual(result, { ok: true, status: 200, data: { hello: 'world' }, meta: OK_META })
})

test('apiFetch reports a business failure by error.code alone', async () => {
  const cases: readonly { status: number; code: string }[] = [
    { status: 400, code: 'INVALID_ARGUMENT' },
    { status: 401, code: 'UNAUTHENTICATED' },
    { status: 404, code: 'NOT_FOUND' },
    { status: 409, code: 'CONFLICT' },
    { status: 503, code: 'UNAVAILABLE' },
  ]
  for (const { status, code } of cases) {
    const { fetchImpl } = recordingFetch(new Response(JSON.stringify({
      ok: false,
      error: { code, message: `failed with ${code}`, details: { field: 'model' } },
      meta: { requestId: `req-${String(status)}` },
    }), { status }))
    const result = await apiFetch<never>('http://127.0.0.1:1/api/v1/x', { fetchImpl })
    assert.deepEqual(result, {
      ok: false,
      status,
      code,
      message: `failed with ${code}`,
      details: { field: 'model' },
      requestId: `req-${String(status)}`,
    })
  }
})

test('apiFetch omits details and requestId when the envelope leaves them out', async () => {
  const { fetchImpl } = recordingFetch(new Response(JSON.stringify({
    ok: false,
    error: { code: 'NOT_FOUND', message: 'not found' },
    meta: { requestId: 'req-2' },
  }), { status: 404 }))
  const result = await apiFetch<never>('http://127.0.0.1:1/api/v1/x', { fetchImpl })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.deepEqual(result.details, {})
})

test('apiFetch sends the bearer token, content type, If-Match and the JSON body', async () => {
  const { fetchImpl, calls } = recordingFetch(new Response(JSON.stringify({ ok: true, data: {}, meta: OK_META }), { status: 200 }))
  await apiFetch('http://127.0.0.1:1/api/v1/memory/records/l1_1', {
    fetchImpl,
    token: 'token-abc',
    method: 'PATCH',
    body: { confidence: 1 },
    ifMatch: 7,
    headers: { 'X-Trace': 'yes' },
  })
  const call = calls[0]
  assert.ok(call !== undefined)
  const headers = call.init?.headers as Record<string, string>
  assert.equal(headers.Authorization, 'Bearer token-abc')
  assert.equal(headers['If-Match'], '7')
  assert.equal(headers['Content-Type'], 'application/json')
  assert.equal(headers['X-Trace'], 'yes')
  assert.equal(call.init?.method, 'PATCH')
  assert.equal(call.init?.body, JSON.stringify({ confidence: 1 }))
})

test('apiFetch sends no body, no content type and no If-Match when none were given', async () => {
  const { fetchImpl, calls } = recordingFetch(new Response(JSON.stringify({ ok: true, data: {}, meta: OK_META }), { status: 200 }))
  await apiFetch('http://127.0.0.1:1/api/v1/console/session', { fetchImpl, token: '' })
  const call = calls[0]
  assert.ok(call !== undefined)
  const headers = call.init?.headers as Record<string, string>
  assert.equal(headers.Authorization, undefined)
  assert.equal(headers['If-Match'], undefined)
  assert.equal(headers['Content-Type'], undefined)
  assert.equal(call.init?.body, undefined)
  assert.equal(call.init?.method, 'GET')
})

test('apiFetch turns a dropped connection into UNAVAILABLE with status 0 instead of throwing', async () => {
  const fetchImpl = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof globalThis.fetch
  const result = await apiFetch('http://127.0.0.1:1/api/v1/x', { fetchImpl })
  assert.deepEqual(result, { ok: false, status: 0, code: 'UNAVAILABLE', message: 'fetch failed', details: {} })
})

test('apiFetch turns a timeout into UNAVAILABLE with status 0', async () => {
  const fetchImpl = (async () => {
    const error = new Error('The operation was aborted due to timeout')
    error.name = 'TimeoutError'
    throw error
  }) as unknown as typeof globalThis.fetch
  const result = await apiFetch('http://127.0.0.1:1/api/v1/x', { fetchImpl })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'UNAVAILABLE')
  assert.equal(result.status, 0)
})

test('apiFetch keeps the HTTP status when the body is not JSON', async () => {
  const fetchImpl = responseOf(new Response('<html>not json</html>', { status: 200 }))
  const result = await apiFetch('http://127.0.0.1:1/api/v1/x', { fetchImpl })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'UNAVAILABLE')
  assert.equal(result.status, 200)
  assert.deepEqual(result.details, {})
})

test('apiFetch maps a non-envelope 401 to UNAUTHENTICATED and keeps status 401', async () => {
  const fetchImpl = responseOf(new Response('unauthorized', { status: 401 }))
  const result = await apiFetch('http://127.0.0.1:1/api/v1/console/settings', { fetchImpl })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'UNAUTHENTICATED')
  assert.equal(result.status, 401)
})

test('apiFetch does not trust an unknown error code as the typed code', async () => {
  const { fetchImpl } = recordingFetch(new Response(JSON.stringify({
    ok: false,
    error: { code: 'NOT_A_REAL_CODE', message: 'boom', details: {} },
    meta: { requestId: 'req-3' },
  }), { status: 500 }))
  const result = await apiFetch<never>('http://127.0.0.1:1/api/v1/x', { fetchImpl })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'INTERNAL')
})

test('apiFetch treats an object that only looks like an envelope as a non-envelope', async () => {
  const fetchImpl = jsonResponse({ ok: true })
  const result = await apiFetch('http://127.0.0.1:1/api/v1/x', { fetchImpl })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'UNAVAILABLE')
  assert.equal(result.status, 200)
})

test('apiFetch never leaks a non-Error rejection as the message', async () => {
  const fetchImpl = (async () => { throw 'raw string rejection' }) as unknown as typeof globalThis.fetch
  const result = await apiFetch('http://127.0.0.1:1/api/v1/x', { fetchImpl })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.message, 'network error')
})

test('apiFetch treats anything short of a complete envelope as UNAVAILABLE', async () => {
  const cases: readonly { readonly label: string; readonly body: unknown }[] = [
    { label: 'an array body', body: [1, 2, 3] },
    { label: 'a success envelope without meta', body: { ok: true, data: 1 } },
    { label: 'a success envelope without data', body: { ok: true, meta: OK_META } },
    { label: 'a failure envelope without a code', body: { ok: false, error: {} } },
    { label: 'a failure envelope whose code is not a string', body: { ok: false, error: { code: 123, message: 'msg' } } },
    { label: 'a failure envelope whose message is not a string', body: { ok: false, error: { code: 'NOT_FOUND', message: 123 } } },
    { label: 'a failure envelope whose details is an array', body: { ok: false, error: { code: 'NOT_FOUND', message: 'msg', details: [] } } },
  ]
  for (const { label, body } of cases) {
    const fetchImpl = jsonResponse(body)
    const result = await apiFetch<never>('http://127.0.0.1:1/api/v1/x', { fetchImpl })
    assert.equal(result.ok, false, label)
    if (result.ok) continue
    assert.equal(result.code, 'UNAVAILABLE', label)
    assert.equal(result.status, 200, label)
    assert.deepEqual(result.details, {}, label)
  }
})

test('apiFetch falls back to "network error" when the rejection carries an empty message', async () => {
  const fetchImpl = (async () => { throw new Error('') }) as unknown as typeof globalThis.fetch
  const result = await apiFetch('http://127.0.0.1:1/api/v1/x', { fetchImpl })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'UNAVAILABLE')
  assert.equal(result.status, 0)
  assert.equal(result.message, 'network error')
})
