import assert from 'node:assert/strict'
import test from 'node:test'
import { BrainError, type BrainContext, type PluginApply } from '@brain-core/sdk'
import { denial, installed, manifest, setup } from './helpers.ts'

test('enable then disable undoes every registration and the plugin can be enabled again', async () => {
  const s = await setup({
    apply: async (ctx) => {
      ctx.tools.register({ name: 'say', description: 'd', parameters: { type: 'object' }, handler: async () => 'ok' })
      ctx.scheduler.every(1000, () => undefined)
      ctx.scheduler.at(5, () => undefined)
      ctx.channel.provide({} as never)
      ctx.http.route('GET', '/x', async () => 1)
      ctx.console.page({ id: 'p', title: 't', entry: '/e' })
      ctx.events.on('message.in', () => undefined)
    },
  })
  await s.runtime.enable(installed())
  assert.equal(s.runtime.state('qq'), 'enabled')
  assert.equal(s.runtime.pages().length, 1)
  assert.equal(await s.runtime.route('qq', { method: 'GET', path: '/x', query: {}, body: null }), 1)
  await s.runtime.disable('qq')
  assert.equal(s.runtime.state('qq'), 'disabled')
  assert.deepEqual([...s.undone].sort(), ['at', 'every', 'provider', 'tool:say'])
  assert.equal(s.runtime.pages().length, 0)
  await denial(s.runtime.route('qq', { method: 'GET', path: '/x', query: {}, body: null }), 'NOT_FOUND')
  await s.runtime.enable(installed())
  assert.equal(s.runtime.state('qq'), 'enabled')
})

test('enabling an enabled plugin is a CONFLICT; disabling a disabled one does nothing', async () => {
  const s = await setup()
  await s.runtime.disable('qq')
  await s.runtime.enable(installed())
  await denial(s.runtime.enable(installed()), 'CONFLICT')
  assert.equal(s.runtime.state('qq'), 'enabled')
})

test('events: a disabled plugin no longer hears them, handler errors are swallowed', async () => {
  const heard: unknown[] = []
  const s = await setup({
    apply: (ctx) => {
      ctx.events.on('message.in', (p) => { heard.push(p) })
      ctx.events.on('message.in', () => { throw new Error('boom') })
      ctx.events.on('message.in', async () => { throw new Error('async boom') })
    },
  })
  await s.runtime.enable(installed())
  s.runtime.emit('message.in', { channel: 'c', count: 1, recordIds: [] })
  assert.equal(heard.length, 1)
  await s.runtime.disable('qq')
  s.runtime.emit('message.in', { channel: 'c', count: 1, recordIds: [] })
  assert.equal(heard.length, 1)
})

test('apply that throws: failed, registrations undone, other plugins unaffected', async () => {
  const s = await setup()
  await s.runtime.enable(installed(undefined, {}, { ...installed().manifest, id: 'other' }))
  const bad = await setup({
    apply: (ctx) => { ctx.scheduler.every(1, () => undefined); throw new Error('nope') },
  })
  await denial(bad.runtime.enable(installed()), 'INTERNAL')
  assert.equal(bad.runtime.state('qq'), 'failed')
  assert.deepEqual(bad.undone, ['every'])
  assert.equal(s.runtime.state('other'), 'enabled')
})

test('a failed start reports a fixed message with the plugin id, not the cause', async () => {
  const s = await setup({ apply: () => { throw new Error('secret detail') } })
  try { await s.runtime.enable(installed()); assert.fail('should throw') } catch (error) {
    assert.ok(error instanceof BrainError)
    assert.equal(error.message, '插件启动失败')
    assert.deepEqual(error.details, { plugin: 'qq' })
  }
})

test('apply that never returns: times out, failed, undone, disable ends, later registrations refused', async () => {
  let late: (() => void) | undefined
  const apply: PluginApply = async (ctx) => {
    ctx.scheduler.every(1, () => undefined)
    late = () => ctx.scheduler.at(1, () => undefined)
    await new Promise(() => undefined)
  }
  const s = await setup({ apply, deps: { applyTimeoutMs: 30 } })
  await denial(s.runtime.enable(installed()), 'INTERNAL')
  assert.equal(s.runtime.state('qq'), 'failed')
  assert.deepEqual(s.undone, ['every'])
  await s.runtime.disable('qq')
  assert.throws(() => late?.(), (e: unknown) => e instanceof BrainError && e.code === 'PERMISSION_DENIED')
  assert.deepEqual(s.undone, ['every'])
})

test('a failed plugin can be enabled again', async () => {
  let attempts = 0
  const s = await setup({ apply: () => { attempts += 1; if (attempts === 1) throw new Error('x') } })
  await denial(s.runtime.enable(installed()), 'INTERNAL')
  await s.runtime.enable(installed())
  assert.equal(s.runtime.state('qq'), 'enabled')
})

test('a throwing undo function does not stop the others', async () => {
  const s = await setup({
    deps: {
      scheduler: {
        every: () => () => { throw new Error('undo failed') },
        at: () => () => undefined,
        ownTime: () => () => undefined,
      },
    },
    apply: (ctx) => {
      ctx.scheduler.every(1, () => undefined)
      ctx.tools.register({ name: 'say', description: 'd', parameters: { type: 'object' }, handler: async () => 'ok' })
    },
  })
  await s.runtime.enable(installed())
  await s.runtime.disable('qq').catch(() => undefined)
  assert.deepEqual(s.undone, ['tool:say'])
})

test('an early Disposable undoes only its own item and is not undone twice', async () => {
  let first: (() => void) | undefined
  const s = await setup({
    apply: (ctx) => {
      first = ctx.scheduler.every(1, () => undefined)
      ctx.scheduler.at(1, () => undefined)
    },
  })
  await s.runtime.enable(installed())
  first?.()
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(s.undone, ['every'])
  await s.runtime.disable('qq')
  assert.deepEqual([...s.undone].sort(), ['at', 'every'])
})

test('after disable the old ctx refuses every method', async () => {
  const s = await setup()
  await s.runtime.enable(installed())
  const ctx = s.ctx()
  await s.runtime.disable('qq')
  const calls: (() => unknown)[] = [
    () => ctx.memory.ingest({} as never), () => ctx.memory.record({} as never), () => ctx.memory.search({} as never),
    () => ctx.memory.context({} as never), () => ctx.memory.forget({ by: 'channel', channel: 'qq:private:1' }),
    () => ctx.agent.session('qq:private:1'), () => ctx.agent.wake('qq:private:1', { reason: 'm' }),
    () => ctx.tools.register({ name: 'say' } as never), () => ctx.channel.provide({} as never),
    () => ctx.channel.send('qq:private:1', {}), () => ctx.identity.resolve('qq:1'), () => ctx.identity.link('qq:1', 'p'),
    () => ctx.scheduler.every(1, () => undefined), () => ctx.scheduler.at(1, () => undefined),
    () => ctx.scheduler.ownTime({ name: 'n', everyMs: 1, run: () => undefined }),
    () => ctx.events.on('x', () => undefined), () => ctx.events.emit('qq.x', {}),
    () => ctx.http.route('GET', '/a', async () => 1), () => ctx.http.fetch('http://example.com'),
    () => ctx.console.page({ id: 'a', title: 't', entry: 'e' }), () => ctx.secrets.get('token'),
    () => ctx.storage.read('a'), () => ctx.storage.write('a', 'b'), () => ctx.storage.remove('a'), () => ctx.storage.list(),
    () => ctx.logger.info('e'), () => ctx.llm.complete({} as never),
  ]
  for (const call of calls) await denial(async () => call())
})

test('route: dispatches by method and path, 404 otherwise, BrainError passes through', async () => {
  const s = await setup({
    apply: (ctx) => {
      ctx.http.route('post', '/a', async (r) => r.body)
      ctx.http.route('GET', '/err', async () => { throw new BrainError('RATE_LIMITED', 'slow') })
    },
  })
  await s.runtime.enable(installed())
  assert.equal(await s.runtime.route('qq', { method: 'POST', path: '/a', query: {}, body: 7 }), 7)
  await denial(s.runtime.route('qq', { method: 'GET', path: '/a', query: {}, body: null }), 'NOT_FOUND')
  await denial(s.runtime.route('qq', { method: 'GET', path: '/nope', query: {}, body: null }), 'NOT_FOUND')
  await denial(s.runtime.route('ghost', { method: 'GET', path: '/a', query: {}, body: null }), 'NOT_FOUND')
  await denial(s.runtime.route('qq', { method: 'GET', path: '/err', query: {}, body: null }), 'RATE_LIMITED')
})

test('duplicate route and duplicate page are CONFLICT; paths must start with /', async () => {
  const s = await setup({
    apply: async (ctx) => {
      ctx.http.route('GET', '/a', async () => 1)
      ctx.http.route('POST', '/a', async () => 1)
      ctx.console.page({ id: 'p', title: 't', entry: 'e' })
      await denial(async () => ctx.http.route('GET', '/a', async () => 2), 'CONFLICT')
      await denial(async () => ctx.console.page({ id: 'p', title: 'x', entry: 'e' }), 'CONFLICT')
      await denial(async () => ctx.http.route('GET', 'a', async () => 2), 'INVALID_ARGUMENT')
    },
  })
  await s.runtime.enable(installed())
  assert.deepEqual(s.runtime.pages(), [{ pluginId: 'qq', id: 'p', title: 't', entry: 'e' }])
})

// ---- review round 1 -------------------------------------------------------------------------------------------------

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('two enables of one plugin at once: one succeeds, the other is a CONFLICT, apply ran once, the plugin is enabled', async () => {
  let applies = 0
  const s = await setup({ apply: async (ctx) => { applies += 1; ctx.scheduler.every(1, () => undefined); await pause(40) } })
  const results = await Promise.allSettled([s.runtime.enable(installed()), s.runtime.enable(installed())])
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected'])
  assert.equal((results[1] as PromiseRejectedResult).reason.code, 'CONFLICT')
  assert.equal(applies, 1)
  assert.equal(s.runtime.state('qq'), 'enabled')
  assert.deepEqual(s.undone, [])
})

test('a disable that arrives while the plugin is still starting waits for it, then really disables', async () => {
  const s = await setup({
    apply: async (ctx) => {
      ctx.scheduler.every(1, () => undefined)
      ctx.http.route('GET', '/x', async () => 1)
      ctx.console.page({ id: 'p', title: 't', entry: 'e' })
      await pause(40)
    },
  })
  const enabling = s.runtime.enable(installed())
  const disabling = s.runtime.disable('qq')
  await Promise.all([enabling, disabling])
  assert.equal(s.runtime.state('qq'), 'disabled')
  assert.deepEqual(s.undone, ['every'])
  assert.equal(s.runtime.pages().length, 0)
  await denial(s.runtime.route('qq', { method: 'GET', path: '/x', query: {}, body: null }), 'NOT_FOUND')
})

test('a failed enable does not block the queued one behind it', async () => {
  let attempts = 0
  const s = await setup({ apply: async () => { attempts += 1; await pause(10); if (attempts === 1) throw new Error('first fails') } })
  const results = await Promise.allSettled([s.runtime.enable(installed()), s.runtime.enable(installed())])
  assert.equal((results[0] as PromiseRejectedResult).reason.code, 'INTERNAL')
  assert.equal(results[1]!.status, 'fulfilled')
  assert.equal(s.runtime.state('qq'), 'enabled')
})

test('a plugin whose apply is stuck does not hold up another plugin', async () => {
  let release: () => void = () => undefined
  const gate = new Promise<void>((r) => { release = r })
  const s = await setup({
    deps: {
      applyTimeoutMs: 5000,
      loadEntry: async (plugin) => (plugin.manifest.id === 'slow' ? async () => { await gate } : () => undefined),
    },
  })
  const slow = s.runtime.enable(installed(undefined, {}, manifest({ id: 'slow' })))
  await s.runtime.enable(installed())
  assert.equal(s.runtime.state('qq'), 'enabled')
  assert.notEqual(s.runtime.state('slow'), 'enabled')
  release()
  await slow
  assert.equal(s.runtime.state('slow'), 'enabled')
})

test('an undo function that throws on disable still leaves the plugin disabled, the old ctx refused, and it can be enabled again', async () => {
  let old: BrainContext | undefined
  const s = await setup({
    deps: {
      scheduler: { every: () => () => { throw new Error('undo failed') }, at: () => () => undefined, ownTime: () => () => undefined },
    },
    apply: (ctx) => {
      old = ctx
      ctx.scheduler.every(1, () => undefined)
      ctx.tools.register({ name: 'say', description: 'd', parameters: { type: 'object' }, handler: async () => 'ok' })
    },
  })
  await s.runtime.enable(installed())
  await s.runtime.disable('qq')
  assert.equal(s.runtime.state('qq'), 'disabled')
  assert.deepEqual(s.undone, ['tool:say'])
  await denial(async () => old!.scheduler.at(1, () => undefined))
  await denial(old!.memory.search({} as never))
  await s.runtime.enable(installed())
  assert.equal(s.runtime.state('qq'), 'enabled')
})

test('an early Disposable from http.route or console.page removes only that route or page', async () => {
  let dropRoute: (() => void) | undefined
  let dropPage: (() => void) | undefined
  const s = await setup({
    apply: (ctx) => {
      dropRoute = ctx.http.route('GET', '/a', async () => 'a')
      ctx.http.route('GET', '/b', async () => 'b')
      dropPage = ctx.console.page({ id: 'a', title: 'A', entry: 'ea' })
      ctx.console.page({ id: 'b', title: 'B', entry: 'eb' })
    },
  })
  await s.runtime.enable(installed())
  dropRoute?.()
  dropPage?.()
  await new Promise((r) => setImmediate(r))
  await denial(s.runtime.route('qq', { method: 'GET', path: '/a', query: {}, body: null }), 'NOT_FOUND')
  assert.equal(await s.runtime.route('qq', { method: 'GET', path: '/b', query: {}, body: null }), 'b')
  assert.deepEqual(s.runtime.pages(), [{ pluginId: 'qq', id: 'b', title: 'B', entry: 'eb' }])
})
