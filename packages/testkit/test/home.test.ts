import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runPluginContractTests, createTestKernel } from '../src/index.ts'

// FR-D01: a plugin can be exercised with an empty HOME and without network access.
const MANIFEST = {
  id: 'offline',
  kinds: ['capability'],
  api: '^1.0.0',
  runtime: 'node',
  permissions: ['tools.register', 'memory.ingest', 'memory.record', 'memory.search', 'network:api.example.com'],
  source: {
    channels: ['offline:test:here'],
    eventKinds: ['offline.event'],
    defaultVisibility: 'open',
    trust: 'member',
  },
  tools: [{ name: 'look', effect: 'read', load: 'core', summary: 'Look around' }],
} as const

test('a plugin runs with an empty HOME and no network access', async () => {
  const emptyHome = await mkdtemp(path.join(tmpdir(), 'brain-testkit-home-'))
  const previousHome = process.env.HOME
  const originalFetch = globalThis.fetch
  let networkAttempts = 0
  process.env.HOME = emptyHome
  globalThis.fetch = (() => { networkAttempts += 1; throw new Error('the test has no network') }) as typeof fetch
  try {
    const kernel = createTestKernel({ now: 1_000 })
    kernel.setResponse('https://api.example.com/feed', { status: 200, body: 'offline feed' })
    let fetched = ''
    let created: string | undefined
    await kernel.loadPlugin({
      apply: async (ctx) => {
        const eventId = (await ctx.memory.ingest({
          kind: 'offline.event',
          channel: 'offline:test:here',
          subjects: ['p1'],
          actor: 'p1',
          content: { text: 'hello' },
          tEvent: 1_000,
          idempotencyKey: 'offline-1',
        })).id
        created = (await ctx.memory.record({
          layer: 'L1',
          kind: 'l1.fact',
          channel: 'offline:test:here',
          subjects: ['p1'],
          actor: 'p1',
          content: { text: 'remembered' },
          evidence: [{ id: eventId }],
        })).id
        ctx.tools.register({
          name: 'look',
          description: 'Look around',
          parameters: { type: 'object' },
          handler: async () => 'looked',
        })
        ctx.http.route('GET', '/feed', async () => ({ feed: 'ok' }))
        ctx.scheduler.every(60_000, () => undefined)
        fetched = (await ctx.http.fetch('https://api.example.com/feed')).text()
      },
    }, MANIFEST)

    assert.equal(fetched, 'offline feed')
    assert.equal(networkAttempts, 0)
    assert.deepEqual(kernel.tools(), ['offline__look'])
    assert.equal(await kernel.callTool('offline__look'), 'looked')
    const hits = await kernel.http('GET', '/api/v1/plugins/offline/feed')
    assert.equal(hits.ok, true)
    assert.ok(created !== undefined)
    assert.equal(kernel.records().find((record) => record.id === created)?.layer, 'L1')
    await kernel.advance(60_000)
    assert.equal(kernel.timers(), 1)
    assert.deepEqual(await readdir(emptyHome), [])
  } finally {
    globalThis.fetch = originalFetch
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(emptyHome, { recursive: true, force: true })
  }
})

test('the contract checks pass with an empty HOME and no network', async () => {
  const emptyHome = await mkdtemp(path.join(tmpdir(), 'brain-testkit-home-'))
  const previousHome = process.env.HOME
  const originalFetch = globalThis.fetch
  globalThis.fetch = (() => { throw new Error('the test has no network') }) as typeof fetch
  process.env.HOME = emptyHome
  try {
    const plugin = {
      apply: (ctx: import('@brain-core/sdk').BrainContext) => {
        ctx.tools.register({ name: 'look', description: 'Look around', parameters: { type: 'object' }, handler: async () => 'ok' })
      },
    }
    const results = await runPluginContractTests(plugin, MANIFEST)
    for (const result of results) assert.equal(result.ok, true, `${result.name}: ${result.message}`)
    assert.deepEqual(await readdir(emptyHome), [])
  } finally {
    globalThis.fetch = originalFetch
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(emptyHome, { recursive: true, force: true })
  }
})
