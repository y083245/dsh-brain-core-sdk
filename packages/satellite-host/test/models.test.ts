import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { fetchToolUpdateMode, type ModelSelection } from '../src/index.ts'

const OFFICIAL: ModelSelection = { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'low' }

async function withServer(
  handler: () => { status: number; body: string },
  run: (baseUrl: string, seen: { path?: string; apiKey?: string }) => Promise<void>,
): Promise<void> {
  const seen: { path?: string; apiKey?: string } = {}
  const server: Server = createServer((req, res) => {
    seen.path = req.url
    seen.apiKey = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined
    const reply = handler()
    res.writeHead(reply.status, { 'content-type': 'application/json' })
    res.end(reply.body)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${port}`, seen)
  } finally {
    await new Promise<void>(resolve => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  }
}

function listing(model: string, update: string): string {
  return JSON.stringify({ data: [{ id: model, api_capabilities: { anthropic_messages: { tool_update: update } } }] })
}

test('an official model listed as addition-only gets addition-only', async () => {
  await withServer(
    () => ({ status: 200, body: listing('deepseek-flash', 'addition-only') }),
    async (baseUrl, seen) => {
      assert.equal(await fetchToolUpdateMode(OFFICIAL, 'secret-key', baseUrl), 'addition-only')
      assert.equal(seen.path, '/models')
      assert.equal(seen.apiKey, 'secret-key')
    },
  )
})

test('leading-only, a missing model and any other value are fixed', async () => {
  for (const body of [listing('deepseek-flash', 'leading-only'), listing('other-model', 'addition-only'), JSON.stringify({ data: [] })]) {
    await withServer(
      () => ({ status: 200, body }),
      async (baseUrl) => {
        assert.equal(await fetchToolUpdateMode(OFFICIAL, 'k', baseUrl), 'fixed')
      },
    )
  }
})

test('a non-2xx response is fixed even when its body lists the model as addition-only', async () => {
  await withServer(
    () => ({ status: 500, body: listing('deepseek-flash', 'addition-only') }),
    async (baseUrl) => {
      assert.equal(await fetchToolUpdateMode(OFFICIAL, 'k', baseUrl), 'fixed')
    },
  )
})

test('a failed request or broken JSON is fixed, never an error', async () => {
  for (const reply of [{ status: 500, body: '{}' }, { status: 200, body: 'not json' }, { status: 200, body: 'null' }]) {
    await withServer(
      () => reply,
      async (baseUrl) => {
        assert.equal(await fetchToolUpdateMode(OFFICIAL, 'k', baseUrl), 'fixed')
      },
    )
  }
})

test('a non-official provider is fixed without asking the server', async () => {
  await withServer(
    () => ({ status: 200, body: listing('deepseek-flash', 'addition-only') }),
    async (baseUrl, seen) => {
      assert.equal(await fetchToolUpdateMode({ ...OFFICIAL, provider: 'other' }, 'k', baseUrl), 'fixed')
      assert.equal(seen.path, undefined)
    },
  )
})

test('a connection failure is fixed', async () => {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  await new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
  assert.equal(await fetchToolUpdateMode(OFFICIAL, 'k', `http://127.0.0.1:${port}`), 'fixed')
})
