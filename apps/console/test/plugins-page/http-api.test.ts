import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { BrainError } from '@dsh-brain-core/sdk'
import { createHttpPluginsPageApi } from '../../src/pages/plugins/index.ts'

interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly auth: string | undefined
  readonly body: unknown
}

async function withFakeServer(
  handler: (req: RecordedRequest) => { readonly status: number; readonly payload: unknown },
  run: (baseUrl: string, requests: RecordedRequest[]) => Promise<void>,
): Promise<void> {
  const requests: RecordedRequest[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let parsed: unknown = undefined
      if (raw !== '') {
        parsed = JSON.parse(raw)
      }
      const recorded: RecordedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        auth: req.headers.authorization,
        body: parsed,
      }
      requests.push(recorded)
      const { status, payload } = handler(recorded)
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('unexpected server address')
  }
  const baseUrl = `http://127.0.0.1:${String(address.port)}`
  try {
    await run(baseUrl, requests)
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }
}

const META = { requestId: 'req-test', apiVersion: '1.0' }

test('createHttpPluginsPageApi calls all 8 routes with exact methods, paths, auth header, and JSON bodies', async () => {
  await withFakeServer((req) => {
    if (req.url === '/api/v1/console/plugins' && req.method === 'GET') {
      return { status: 200, payload: { ok: true, data: { plugins: [], coreBudgets: [] }, meta: META } }
    }
    if (req.url === '/api/v1/console/plugins/install' && req.method === 'POST') {
      return {
        status: 200,
        payload: {
          ok: true,
          data: { id: 'p1', version: '1.0.0', permissions: [], newPermissions: [], warnings: [] },
          meta: META,
        },
      }
    }
    if (req.url === '/api/v1/console/plugins/p1/upgrade' && req.method === 'POST') {
      return {
        status: 200,
        payload: {
          ok: true,
          data: { id: 'p1', version: '1.1.0', permissions: [], newPermissions: [], warnings: [], applied: true },
          meta: META,
        },
      }
    }
    if (req.url === '/api/v1/console/plugins/check' && req.method === 'POST') {
      return {
        status: 200,
        payload: {
          ok: true,
          data: { ok: true, manifest: { ok: false, errors: [] }, contract: [], findings: [], notes: [] },
          meta: META,
        },
      }
    }
    return { status: 200, payload: { ok: true, data: null, meta: META } }
  }, async (baseUrl, requests) => {
    // Pass trailing slash to verify baseUrl normalization
    const api = createHttpPluginsPageApi(`${baseUrl}/`, 'secret-token')

    const listed = await api.list()
    assert.deepEqual(listed, { plugins: [], coreBudgets: [] })

    const preview = await api.install('./plugins/p1')
    assert.equal(preview.id, 'p1')

    await api.confirm('p1')
    await api.enable('p1')
    await api.disable('p1')

    const upgraded = await api.upgrade('p1', '1.1.0')
    assert.equal(upgraded.applied, true)

    await api.uninstall('p1', { keepData: true })
    await api.uninstall('p1', { keepData: false })

    const report = await api.check('/tmp/p1')
    assert.equal(report.ok, true)

    assert.equal(requests.length, 9)
    for (const r of requests) {
      assert.equal(r.auth, 'Bearer secret-token')
    }

    assert.deepEqual(requests.map((r) => `${r.method} ${r.url}`), [
      'GET /api/v1/console/plugins',
      'POST /api/v1/console/plugins/install',
      'POST /api/v1/console/plugins/p1/confirm',
      'POST /api/v1/console/plugins/p1/enable',
      'POST /api/v1/console/plugins/p1/disable',
      'POST /api/v1/console/plugins/p1/upgrade',
      'POST /api/v1/console/plugins/p1/uninstall',
      'POST /api/v1/console/plugins/p1/uninstall',
      'POST /api/v1/console/plugins/check',
    ])

    assert.deepEqual(requests[1]?.body, { spec: './plugins/p1' })
    assert.deepEqual(requests[5]?.body, { spec: '1.1.0' })
    assert.deepEqual(requests[6]?.body, { keepData: true })
    assert.deepEqual(requests[7]?.body, { keepData: false })
    assert.deepEqual(requests[8]?.body, { dir: '/tmp/p1' })
  })
})

test('createHttpPluginsPageApi encodes plugin ids and converts error envelopes into BrainError', async () => {
  const seenUrls: string[] = []
  await withFakeServer((req) => {
    seenUrls.push(req.url)
    if (req.url === '/api/v1/console/plugins/scope%2Fname/confirm') {
      return { status: 200, payload: { ok: true, data: null, meta: META } }
    }
    if (req.url === '/api/v1/console/plugins/scope%2Fname/enable') {
      return {
        status: 409,
        payload: {
          ok: false,
          error: { code: 'CONFLICT', message: 'plugin already enabled', details: { id: 'scope/name' } },
          meta: META,
        },
      }
    }
    return {
      status: 401,
      payload: {
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'bad token', details: {} },
        meta: META,
      },
    }
  }, async (baseUrl) => {
    const api = createHttpPluginsPageApi(baseUrl, 'bad-token')
    await api.confirm('scope/name')
    assert.equal(seenUrls.includes('/api/v1/console/plugins/scope%2Fname/confirm'), true)
    await assert.rejects(
      () => api.enable('scope/name'),
      (err: unknown) => err instanceof BrainError && err.code === 'CONFLICT' && err.message === 'plugin already enabled' && err.details.id === 'scope/name',
    )
    await assert.rejects(
      () => api.list(),
      (err: unknown) => err instanceof BrainError && err.code === 'UNAUTHENTICATED' && err.message === 'bad token',
    )
  })
})

test('createHttpPluginsPageApi calls scan and applyLocal endpoints with exact methods, paths, and JSON bodies', async () => {
  await withFakeServer((req) => {
    if (req.url === '/api/v1/console/plugins/scan' && req.method === 'POST') {
      return {
        status: 200,
        payload: {
          ok: true,
          data: {
            plugins: [
              {
                id: 'local-plugin',
                version: '0.1.0',
                kinds: ['capability'],
                runtime: 'node',
                state: 'discovered',
                permissions: ['memory.search'],
                granted: [],
                checkPassed: true,
                tools: [],
                source: 'workspace',
              },
            ],
            coreBudgets: [],
          },
          meta: META,
        },
      }
    }
    if (req.url === '/api/v1/console/plugins/local-plugin/apply-local' && req.method === 'POST') {
      return {
        status: 200,
        payload: {
          ok: true,
          data: {
            id: 'local-plugin',
            version: '0.1.0',
            permissions: ['memory.search'],
            newPermissions: [],
            warnings: [],
            applied: true,
            state: 'enabled',
          },
          meta: META,
        },
      }
    }
    if (req.url === '/api/v1/console/plugins/scope%2Fname/apply-local' && req.method === 'POST') {
      return {
        status: 200,
        payload: {
          ok: true,
          data: {
            id: 'scope/name',
            version: '0.2.0',
            permissions: ['memory.search', 'memory.ingest'],
            newPermissions: ['memory.ingest'],
            warnings: [],
            applied: false,
            state: 'disabled',
          },
          meta: META,
        },
      }
    }
    return { status: 404, payload: { ok: false, error: { code: 'NOT_FOUND', message: 'not found', details: {} }, meta: META } }
  }, async (baseUrl, requests) => {
    const api = createHttpPluginsPageApi(baseUrl, 'secret-token')

    const scanned = await api.scan?.()
    assert.equal(scanned?.plugins.length, 1)
    assert.equal(scanned?.plugins[0]?.state, 'discovered')

    const enabled = await api.applyLocal?.('local-plugin', { action: 'enable', confirmPermissions: true })
    assert.equal(enabled?.applied, true)
    assert.equal(enabled?.state, 'enabled')

    const updated = await api.applyLocal?.('scope/name', { action: 'update' })
    assert.equal(updated?.applied, false)
    assert.equal(updated?.state, 'disabled')

    assert.deepEqual(requests.map((r) => `${r.method} ${r.url}`), [
      'POST /api/v1/console/plugins/scan',
      'POST /api/v1/console/plugins/local-plugin/apply-local',
      'POST /api/v1/console/plugins/scope%2Fname/apply-local',
    ])
    assert.equal(requests[0]?.body, undefined)
    assert.deepEqual(requests[1]?.body, { action: 'enable', confirmPermissions: true })
    assert.deepEqual(requests[2]?.body, { action: 'update' })
  })
})
