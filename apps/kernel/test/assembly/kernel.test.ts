import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createKernel } from '../../src/assembly.ts'
import {
  BIG_CORE_PLUGIN, CHANNEL, FLAKY_MEMBERS_PLUGIN, FLASH, MCP_PLUGIN, SAMPLE_PLUGIN, TOKEN,
  capturingLogger, httpGet, installPlugin, readSatellitePid, setup, type LogEntry,
} from './helpers.ts'

test('A4: a kernel with no plugins starts, serves HTTP and has no DSH child', async (t) => {
  const originalSet = globalThis.setInterval
  const delays: number[] = []
  try {
    // Count every interval the kernel creates, so "no extraction timer" is observable without waiting ten minutes.
    globalThis.setInterval = ((callback: () => void, ms: number) => {
      delays.push(ms)
      return originalSet(callback, ms)
    }) as typeof setInterval

    const h = await setup(t)
    const { kernel } = h
    const health = await httpGet(kernel, '/api/v1/memory/health')
    assert.equal(health.status, 200)
    const body = await health.json() as { ok: boolean; data: Record<string, string> }
    assert.equal(body.ok, true)
    assert.equal(body.data.store, 'ok')

    assert.equal(kernel.runner.status('chat'), 'stopped')
    assert.equal(kernel.runner.status('activity'), 'stopped')
    assert.equal(await readSatellitePid(h.home), undefined, 'no DSH was ever started')
    assert.equal(delays.includes(600_000), false, 'no extraction timer without an activity model')

    // The token is required: the same route without it is a 401, not a 200.
    const denied = await httpGet(kernel, '/api/v1/memory/health', 'wrong-token')
    assert.equal(denied.status, 401)
  } finally {
    globalThis.setInterval = originalSet
  }
})

test('the sample plugin installs, answers a wake through a tool, writes memory and disappears when disabled', async (t) => {
  const { kernel, fake } = await setup(t, {
    settings: { agents: { chat: { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'low' } } },
    apiKey: 'fake-key',
    roleCard: '你是小满，说话简短。',
    script: (_request, index) => index === 0
      ? { tool: 'sample__remember', input: { text: '她喜欢苹果' } }
      : { text: '记住了。' },
  })

  assert.equal(kernel.gateway.catalog().some((tool) => tool.name.startsWith('sample__')), false)
  await installPlugin(kernel, SAMPLE_PLUGIN, 'sample')
  assert.ok(kernel.gateway.catalog().some((tool) => tool.name === 'sample__remember'))

  const messageId = await (async () => {
    const { id } = await kernel.memory.service.ingest(
      { kind: 'sample.message', channel: CHANNEL, subjects: [], actor: 'p1', content: { text: '我喜欢苹果' }, tEvent: Date.now(), idempotencyKey: 'm1' },
      { kind: 'kernel', source: 'test', trust: 'owner', defaultVisibility: 'owner' },
    )
    return id
  })()
  const result = await kernel.agent.wake(CHANNEL, {
    reason: 'message',
    messages: [{ id: messageId, actor: 'p1', name: '小明', text: '我喜欢苹果', tEvent: Date.now() }],
  })
  assert.equal(result.acked, true)
  assert.ok(result.steps >= 2)
  const requests = fake.requests
  assert.ok(requests.some((request) => request.tools.includes('sample__remember')))

  const found = await kernel.memory.service.search(
    { query: '苹果', scope: 'here' },
    { caller: 'owner-console', channel: CHANNEL, participants: [] },
  )
  assert.ok(found.items.some((hit) => hit.record.content.text === '她喜欢苹果'))

  await kernel.plugins.disable('sample')
  assert.equal(kernel.gateway.catalog().some((tool) => tool.name.startsWith('sample__')), false)
  // The kernel and its HTTP API are still up after the plugin goes away.
  const health = await httpGet(kernel, '/api/v1/memory/health', TOKEN)
  assert.equal(health.status, 200)
})

test('a restart enables what the registry says is enabled and survives one plugin that cannot start', async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const { createKernel } = await import('../../src/assembly.ts')
  const { capturingLogger } = await import('./helpers.ts')
  const { BROKEN_PLUGIN } = await import('./helpers.ts')

  const home = await mkdtemp(path.join(os.tmpdir(), 'brain-restart-'))
  const { mkdir } = await import('node:fs/promises')
  // The CLI child below gets its own DSH home, so no doctor path can reach the real ~/.dsh.
  const dshHome = path.join(home, 'dsh')
  await mkdir(dshHome, { recursive: true })
  const env = { ...process.env, BRAIN_HOME: home, DSH_HOME: dshHome }
  const { removeTree } = await import('@dsh-brain-core/satellite-host')

  try {
    const firstLogs: import('./helpers.ts').LogEntry[] = []
    const first = await createKernel({ env, userHome: home, port: 0, crossChannel: 'shadow', log: capturingLogger(firstLogs), token: 'first', baseUrl: 'http://127.0.0.1:9' })
    try {
      await installPlugin(first, SAMPLE_PLUGIN, 'sample')
      await first.plugins.install(BROKEN_PLUGIN)
      await first.plugins.confirm('broken')
    } finally {
      await first.close()
    }

    // The CLI only edits files: this marks the broken plugin enabled for the next start, without applying it now.
    const cli = fileURLToPath(new URL('../../src/cli.ts', import.meta.url))
    const enable = spawnSync(process.execPath, [cli, 'plugin', 'enable', 'broken'], { encoding: 'utf8', env })
    assert.equal(enable.status, 0, enable.stderr)

    const secondLogs: import('./helpers.ts').LogEntry[] = []
    const second = await createKernel({ env, userHome: home, port: 0, crossChannel: 'shadow', log: capturingLogger(secondLogs), token: 'second', baseUrl: 'http://127.0.0.1:9' })
    try {
      assert.ok(second.gateway.catalog().some((tool) => tool.name === 'sample__remember'))
      assert.equal(second.runtime.state('broken'), 'failed')
      assert.ok(secondLogs.some((entry) => entry.event === 'kernel.plugin_enable_failed' && entry.fields?.plugin === 'broken'))
      const health = await httpGet(second, '/api/v1/memory/health', 'second')
      assert.equal(health.status, 200)
    } finally {
      // Close before removing the tree: Windows refuses to unlink open SQLite files (EBUSY).
      await second.close()
    }
  } finally {
    await removeTree(home)
  }
})

test('an install preview warns when the manifest asks for too many core tools', async (t) => {
  const h = await setup(t)
  const preview = await h.kernel.plugins.install(BIG_CORE_PLUGIN)
  assert.equal(preview.id, 'bigcore')
  assert.ok(
    preview.warnings.some((warning) => warning.includes('core 工具过多')),
    `warnings: ${JSON.stringify(preview.warnings)}`,
  )
})

test('a node plugin gets the tools of its MCP server once it is enabled', async (t) => {
  const h = await setup(t)
  assert.equal(h.kernel.gateway.catalog().some((tool) => tool.name.startsWith('mcpdemo__')), false)
  await installPlugin(h.kernel, MCP_PLUGIN, 'mcpdemo')
  assert.ok(h.kernel.gateway.catalog().some((tool) => tool.name === 'mcpdemo__ping'))
})

test('a channel provider whose members() throws reads as an empty participant list', async (t) => {
  const h = await setup(t, {
    settings: { agents: { chat: { ...FLASH } } },
    apiKey: 'fake-key',
    roleCard: '你是小满。',
    script: (_request, index) => (index === 0 ? { tool: 'flaky__probe' } : { text: '好。' }),
  })
  await installPlugin(h.kernel, FLAKY_MEMBERS_PLUGIN, 'flaky')
  const result = await h.wake('flaky:private:u1', '试试')
  assert.equal(result.acked, true)
  assert.ok(h.fake.requests.some((request) => request.raw.includes('participants-empty-ok')))
})

test('a kernel that fails while starting closes its stores, so the home is removable and reusable', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'brain-startup-failure-'))
  const blocker: Server = createServer()
  await new Promise<void>((resolve) => { blocker.listen(0, '127.0.0.1', () => resolve()) })
  const port = (blocker.address() as AddressInfo).port
  const env = { ...process.env, BRAIN_HOME: home }
  const logs: LogEntry[] = []
  try {
    let failed: unknown
    try {
      await createKernel({
        env, userHome: home, port, crossChannel: 'shadow', log: capturingLogger(logs), token: 'failed',
        baseUrl: 'http://127.0.0.1:9',
      })
    } catch (error) {
      failed = error
    }
    assert.ok(failed instanceof Error)
    assert.equal((failed as NodeJS.ErrnoException).code, 'EADDRINUSE')

    // No retry loop: a leaked SQLite handle shows up here as EBUSY on Windows.
    await rm(home, { recursive: true, force: true })

    const second = await createKernel({
      env, userHome: home, port: 0, crossChannel: 'shadow', log: capturingLogger([]), token: 'second',
      baseUrl: 'http://127.0.0.1:9',
    })
    try {
      assert.equal((await httpGet(second, '/api/v1/memory/health', 'second')).status, 200)
    } finally {
      await second.close()
    }
    await rm(home, { recursive: true, force: true })
  } finally {
    blocker.closeAllConnections()
    await new Promise<void>((resolve) => { blocker.close(() => resolve()) })
  }
})
