import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import {
  createHttpSatellitePageApi,
  SatelliteApiError,
  type IsolationDoctorStatus,
  type SatelliteSnapshot,
} from '../../src/pages/satellite/index.ts'

interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly authorization: string | undefined
}

async function withTestServer(
  handler: (req: IncomingMessage, res: ServerResponse, recorded: RecordedRequest) => void,
  run: (baseUrl: string, requests: RecordedRequest[]) => Promise<void>,
): Promise<void> {
  const requests: RecordedRequest[] = []
  const server = createServer((req, res) => {
    const recorded: RecordedRequest = {
      method: req.method ?? '',
      url: req.url ?? '',
      authorization: req.headers.authorization,
    }
    requests.push(recorded)
    handler(req, res, recorded)
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${String(address.port)}`

  try {
    await run(baseUrl, requests)
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }
}

test('createHttpSatellitePageApi calls expected routes and handles envelopes', async () => {
  const expectedSnapshot: SatelliteSnapshot = {
    processes: {
      chat: {
        agentClass: 'chat',
        status: 'running',
        pid: 1234,
        activeSessions: 1,
        selection: { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'high' },
        deniedApprovals: 0,
      },
      activity: {
        agentClass: 'activity',
        status: 'stopped',
        activeSessions: 0,
        selection: null,
        deniedApprovals: 0,
      },
    },
    sessions: [],
    isolation: { ok: true, checkedAt: 1700000000000, problems: [] },
    metrics: [],
    sharedQuotaWarning: false,
  }
  const expectedDoctor: IsolationDoctorStatus = {
    ok: false,
    checkedAt: 1700000002000,
    problems: ['bad path'],
  }

  await withTestServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.method === 'GET' && req.url === '/api/v1/console/satellite') {
      res.end(JSON.stringify({ ok: true, data: expectedSnapshot, meta: { requestId: 'r1' } }))
      return
    }
    if (req.method === 'POST' && req.url === '/api/v1/console/satellite/chat/restart') {
      res.end(JSON.stringify({ ok: true, data: { restarted: true }, meta: { requestId: 'r2' } }))
      return
    }
    if (req.method === 'POST' && req.url === '/api/v1/console/satellite/doctor') {
      res.end(JSON.stringify({ ok: true, data: expectedDoctor, meta: { requestId: 'r3' } }))
      return
    }
    res.statusCode = 404
    res.end(JSON.stringify({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'unknown route', details: {} },
      meta: { requestId: 'r4' },
    }))
  }, async (baseUrl, requests) => {
    // Also test trailing slash normalization
    const api = createHttpSatellitePageApi(`${baseUrl}/`, 'secret-token')

    const snap = await api.getSnapshot()
    assert.deepEqual(snap, expectedSnapshot)

    await api.restart('chat')

    const doctor = await api.runIsolationDoctor()
    assert.deepEqual(doctor, expectedDoctor)

    assert.deepEqual(requests, [
      { method: 'GET', url: '/api/v1/console/satellite', authorization: 'Bearer secret-token' },
      { method: 'POST', url: '/api/v1/console/satellite/chat/restart', authorization: 'Bearer secret-token' },
      { method: 'POST', url: '/api/v1/console/satellite/doctor', authorization: 'Bearer secret-token' },
    ])
  })
})

test('createHttpSatellitePageApi throws SatelliteApiError on envelope error and transport failure', async () => {
  await withTestServer((_req, res) => {
    res.statusCode = 401
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({
      ok: false,
      error: { code: 'UNAUTHENTICATED', message: 'invalid token', details: {} },
      meta: { requestId: 'r-auth' },
    }))
  }, async (baseUrl) => {
    const api = createHttpSatellitePageApi(baseUrl, 'bad-token')

    await assert.rejects(
      () => api.getSnapshot(),
      (err: unknown) => {
        assert.ok(err instanceof SatelliteApiError)
        assert.equal(err.code, 'UNAUTHENTICATED')
        assert.equal(err.status, 401)
        assert.equal(err.requestId, 'r-auth')
        return true
      },
    )

    await assert.rejects(
      () => api.restart('activity'),
      (err: unknown) => err instanceof SatelliteApiError && err.code === 'UNAUTHENTICATED',
    )

    await assert.rejects(
      () => api.runIsolationDoctor(),
      (err: unknown) => err instanceof SatelliteApiError && err.code === 'UNAUTHENTICATED',
    )
  })

  const networkFailApi = createHttpSatellitePageApi('http://127.0.0.1:1', 'tok', (async () => {
    throw new Error('connect ECONNREFUSED')
  }) as unknown as typeof globalThis.fetch)

  await assert.rejects(
    () => networkFailApi.getSnapshot(),
    (err: unknown) => err instanceof SatelliteApiError && err.code === 'UNAVAILABLE' && err.status === 0,
  )
})
