import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { afterEach } from 'node:test'
import { BrainError } from '@brain-core/sdk'
import { harness, isAlive, waitUntil, type Harness, type HarnessOptions } from './helpers.ts'

const live = new Set<Harness>()
async function setup(options: HarnessOptions): Promise<Harness> {
  const h = await harness(options)
  live.add(h)
  return h
}
afterEach(async () => {
  await Promise.all([...live].map(async (h) => { await h.stop() }))
  live.clear()
})

function starts(entries: Record<string, unknown>[]): Record<string, unknown>[] {
  return entries.filter((entry) => entry.event === 'start')
}

test('a crash revokes the old registrations, restarts, and fails in-flight requests', async () => {
  const generationFile = path.join(await mkdtemp(path.join(os.tmpdir(), 'plugin-generation-')), 'generation')
  const h = await setup({
    script: {
      generationFile,
      exitAfterReadyMs: 800,
      exitAfterReadyGenerations: [1],
      delay: { 'tool.invoke': 5000 },
      calls: [
        { method: 'tools.register', params: { name: 'echo', description: 'd', parameters: { type: 'object' } } },
        { method: 'channel.provide', params: {} },
        { method: 'scheduler.every', params: { id: 'e1', ms: 1000 } },
        { method: 'http.route', params: { routeId: 'r', method: 'GET', path: '/x' } },
        { method: 'events.on', params: { name: 'message.in' } },
        { method: 'console.page', params: { id: 'p', title: 't', entry: 'i.html' } },
      ],
      respond: { 'tool.invoke': { text: 'second' } },
    },
  })
  await h.apply(h.ctx.ctx, {})
  const first = h.ctx.state.tools.get('echo')
  assert.ok(first !== undefined)
  const pending = first.handler({ text: 'x' }, { channel: 'echo:private:1', wakeId: 'w' })
  const rejected = pending.then(() => undefined, (error: unknown) => error)
  assert.equal(h.ctx.state.disposed.includes('tool:echo'), false)
  assert.equal(starts(h.entries()).length, 1)

  await h.waitFor((entries) => starts(entries).length >= 2, 10_000)
  for (const name of ['tool:echo', 'provider', 'every', 'route:GET /x', 'event:message.in', 'page:p']) {
    assert.equal(h.ctx.state.disposed.includes(name), true, `${name} was not revoked`)
  }
  await h.waitFor((entries) => entries.filter((entry) => entry.event === 'request' && entry.method === 'initialize').length >= 2, 5000)
  await waitUntil(() => h.ctx.state.tools.has('echo'), 2000)

  const caught = await rejected
  assert.ok(caught instanceof BrainError && caught.code === 'UNAVAILABLE', String(caught))
  const second = h.ctx.state.tools.get('echo')
  assert.ok(second !== undefined)
  assert.notEqual(second, first)
  assert.deepEqual(await second.handler({ text: 'y' }, { channel: 'echo:private:1', wakeId: 'w' }), { text: 'second' })
})

test('four crashes inside the restart window stop the plugin and call onFailed', async () => {
  const h = await setup({
    script: {
      exitAfterReadyMs: 100,
      exitAfterReadyGenerations: [1],
      crashGenerations: [2, 3, 4, 5],
      calls: [{ method: 'tools.register', params: { name: 'echo', description: 'd', parameters: { type: 'object' } } }],
    },
  })
  await h.apply(h.ctx.ctx, {})
  await waitUntil(() => h.failed.length === 1, 14_000)
  assert.deepEqual(h.failed, ['echo'])
  const entries = starts(h.entries())
  assert.ok(entries.length >= 4, JSON.stringify(h.entries()))
  assert.ok((entries[1]?.t as number) - (entries[0]?.t as number) >= 900)
  assert.ok((entries[2]?.t as number) - (entries[1]?.t as number) >= 1900)
  assert.ok((entries[3]?.t as number) - (entries[2]?.t as number) >= 3900)
  await new Promise((resolve) => setTimeout(resolve, 1500))
  assert.equal(starts(h.entries()).length, entries.length)
})

test('ctx revocation sends shutdown and a cooperative plugin exits', async () => {
  const h = await setup({ script: { calls: [] } })
  await h.apply(h.ctx.ctx, {})
  const pid = starts(h.entries())[0]?.pid
  assert.equal(typeof pid, 'number')
  h.ctx.revoke()
  await h.waitFor((entries) => entries.some((entry) => entry.event === 'shutdown'), 3000)
  await waitUntil(() => !isAlive(pid as number), 3000)
})

test('a plugin that ignores shutdown is killed after three seconds and leaves no process', async () => {
  const h = await setup({ script: { calls: [], ignoreShutdown: true } })
  await h.apply(h.ctx.ctx, {})
  const pid = starts(h.entries())[0]?.pid
  assert.equal(typeof pid, 'number')
  h.ctx.revoke()
  await h.waitFor((entries) => entries.some((entry) => entry.event === 'shutdown'), 3000)
  assert.equal(isAlive(pid as number), true)
  await waitUntil(() => !isAlive(pid as number), 6000)
})

test('without plugin.ready the apply stays pending for the outer timeout and is cleaned up on revocation', async () => {
  const h = await setup({ script: { ready: false } })
  const pending = Promise.resolve(h.apply(h.ctx.ctx, {})).then(() => 'ready', () => 'failed')
  const outcome = await Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve('timeout'), 500))])
  assert.equal(outcome, 'timeout')
  h.ctx.revoke()
  assert.equal(await pending, 'failed')
  const pid = starts(h.entries())[0]?.pid
  assert.equal(typeof pid, 'number')
  await waitUntil(() => !isAlive(pid as number), 5000)
})

test('initialize with a malformed apiVersion fails too', async () => {
  const h = await setup({ script: { initializeResult: { apiVersion: 'one' } } })
  await assert.rejects(Promise.resolve(h.apply(h.ctx.ctx, {})), BrainError)
  const pid = starts(h.entries())[0]?.pid
  assert.equal(typeof pid, 'number')
  await waitUntil(() => !isAlive(pid as number), 5000)
})

test('the first restart waits 1000-1800 ms and the fourth crash stops with exactly four starts', { timeout: 30_000 }, async () => {
  const generationFile = path.join(await mkdtemp(path.join(os.tmpdir(), 'plugin-generation-')), 'generation')
  const h = await setup({
    script: { generationFile, exitAfterReadyMs: 100, exitAfterReadyGenerations: [1], crashGenerations: [2, 3, 4, 5], calls: [] },
  })
  await h.apply(h.ctx.ctx, {})
  await waitUntil(() => h.failed.length === 1, 20_000)
  const entries = starts(h.entries())
  assert.equal(entries.length, 4, JSON.stringify(entries))
  const firstGap = (entries[1]?.t as number) - (entries[0]?.t as number)
  assert.ok(firstGap >= 1000, `first restart waited ${firstGap} ms`)
  assert.ok(firstGap <= 1800, `first restart waited ${firstGap} ms`)
  assert.deepEqual(h.failed, ['echo'])
})

test('crashes older than the restart window are not counted, so the plugin keeps restarting', { timeout: 60_000 }, async () => {
  let now = 1_000_000
  const h = await setup({
    deps: { now: () => now },
    script: {
      exitAfterReadyMs: 300,
      exitAfterReadyGenerations: [1, 2, 3, 4, 5, 6, 7],
      calls: [],
    },
  })
  await h.apply(h.ctx.ctx, {})
  let seen = starts(h.entries()).length
  assert.equal(seen, 1)
  for (let round = 0; round < 4; round++) {
    await h.waitFor((entries) => starts(entries).length > seen, 10_000)
    seen = starts(h.entries()).length
    now += 61_000
  }
  await new Promise((resolve) => setTimeout(resolve, 1500))
  assert.deepEqual(h.failed, [])
  assert.ok(starts(h.entries()).length >= 5, JSON.stringify(starts(h.entries())))
})

test('crashes fifteen seconds apart still count as inside the restart window', { timeout: 45_000 }, async () => {
  let now = 1_000_000
  const h = await setup({
    deps: { now: () => now },
    script: { exitAfterReadyMs: 300, exitAfterReadyGenerations: [1, 2, 3, 4, 5], calls: [] },
  })
  await h.apply(h.ctx.ctx, {})
  let seen = starts(h.entries()).length
  assert.equal(seen, 1)
  for (let round = 0; round < 3; round++) {
    await h.waitFor((entries) => starts(entries).length > seen, 15_000)
    seen = starts(h.entries()).length
    now += 15_000
  }
  await waitUntil(() => h.failed.length === 1, 20_000)
  assert.deepEqual(h.failed, ['echo'])
  assert.equal(starts(h.entries()).length, 4, JSON.stringify(starts(h.entries())))
})

test('revoking ctx while a restart timer waits stops further starts', { timeout: 20_000 }, async () => {
  const generationFile = path.join(await mkdtemp(path.join(os.tmpdir(), 'plugin-generation-')), 'generation')
  const h = await setup({
    script: { generationFile, exitAfterReadyMs: 100, exitAfterReadyGenerations: [1, 2], calls: [] },
  })
  await h.apply(h.ctx.ctx, {})
  await h.waitFor((entries) => starts(entries).length >= 2, 6000)
  await h.waitFor((entries) => entries.some((entry) => entry.event === 'crash' && entry.generation === 2), 6000)
  h.ctx.revoke()
  await new Promise((resolve) => setTimeout(resolve, 3000))
  assert.equal(starts(h.entries()).length, 2, JSON.stringify(starts(h.entries())))
})

test('shutdown revokes the registrations before the process is gone', { timeout: 20_000 }, async () => {
  const h = await setup({
    script: {
      ignoreShutdown: true,
      calls: [
        { method: 'tools.register', params: { name: 'echo', description: 'd', parameters: { type: 'object' } } },
        { method: 'channel.provide', params: {} },
      ],
    },
  })
  await h.apply(h.ctx.ctx, {})
  await waitUntil(() => h.ctx.state.tools.has('echo') && h.ctx.state.providers.length === 1, 3000)
  h.ctx.revoke()
  await waitUntil(() => !h.ctx.state.tools.has('echo') && h.ctx.state.providers.length === 0, 1500)
  assert.ok(h.ctx.state.disposed.includes('tool:echo'))
  assert.ok(h.ctx.state.disposed.includes('provider'))
})
