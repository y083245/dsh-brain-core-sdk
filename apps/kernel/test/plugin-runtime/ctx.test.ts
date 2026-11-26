import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import test from 'node:test'
import { BrainError, type BrainContext } from '@brain-core/sdk'
import { denial, installed, manifest, setup, stored } from './helpers.ts'

const OWN = 'qq:private:1'
const GROUP = 'qq:group:123'
const tool = { name: 'say', description: 'd', parameters: { type: 'object' as const }, handler: async () => 'ok' }

const TABLE: readonly { name: string; permission: string; call: (c: BrainContext) => unknown }[] = [
  { name: 'memory.ingest', permission: 'memory.ingest', call: (c) => c.memory.ingest({ kind: 'qq.message', channel: OWN } as never) },
  { name: 'memory.record', permission: 'memory.record', call: (c) => c.memory.record({ channel: OWN } as never) },
  { name: 'memory.update', permission: 'memory.record', call: (c) => c.memory.update('r', {}, 1) },
  { name: 'memory.remove', permission: 'memory.record', call: (c) => c.memory.remove('r') },
  { name: 'memory.search', permission: 'memory.search', call: (c) => c.memory.search({} as never) },
  { name: 'memory.context', permission: 'memory.context', call: (c) => c.memory.context({ channel: OWN } as never) },
  { name: 'memory.forget', permission: 'memory.forget', call: (c) => c.memory.forget({ by: 'channel', channel: OWN }) },
  { name: 'agent.session', permission: 'agent.session', call: (c) => c.agent.session(OWN) },
  { name: 'agent.wake', permission: 'agent.session', call: (c) => c.agent.wake(OWN, { reason: 'm' }) },
  { name: 'tools.register', permission: 'tools.register', call: (c) => c.tools.register(tool) },
  { name: 'channel.provide', permission: 'channel.provide', call: (c) => c.channel.provide({} as never) },
  { name: 'channel.send', permission: 'channel.send', call: (c) => c.channel.send(OWN, { text: 'hi' }) },
  { name: 'identity.resolve', permission: 'identity.link', call: (c) => c.identity.resolve('qq:1') },
  { name: 'identity.link', permission: 'identity.link', call: (c) => c.identity.link('qq:1', 'p') },
  { name: 'scheduler.ownTime', permission: 'schedule.ownTime', call: (c) => c.scheduler.ownTime({ name: 'n', everyMs: 1, run: () => undefined }) },
  { name: 'secrets.get', permission: 'secrets:token', call: (c) => c.secrets.get('token') },
  { name: 'llm.complete', permission: 'llm.invoke', call: (c) => c.llm.complete({} as never) },
]

for (const row of TABLE) {
  test(`${row.name} needs ${row.permission}: denied without it, passes with it`, async () => {
    const without = await setup()
    const rest = installed().granted.filter((p) => p !== row.permission)
    await without.runtime.enable(installed(rest))
    await denial(async () => row.call(without.ctx()))

    const granted = await setup()
    granted.state.provider = { send: async () => ({}) }
    await granted.runtime.enable(installed())
    try { await row.call(granted.ctx()) } catch (error) {
      // llm.complete is granted but UNAVAILABLE; everything else must pass
      assert.ok(error instanceof BrainError && error.code === 'UNAVAILABLE' && row.name === 'llm.complete', String(error))
    }
  })
}

test('a permission listed in the manifest but missing from granted does not count', async () => {
  const s = await setup()
  await s.runtime.enable(installed(['memory.record'], {}, manifest({ permissions: ['memory.record', 'memory.ingest'] })))
  await denial(s.ctx().memory.ingest({ kind: 'qq.message', channel: OWN } as never))
})

test('methods without a permission work with nothing granted', async () => {
  const s = await setup({
    apply: (ctx) => {
      ctx.scheduler.every(1, () => undefined)
      ctx.scheduler.at(1, () => undefined)
      ctx.events.on('message.in', () => undefined)
      ctx.logger.info('hello')
      assert.deepEqual(ctx.config, { a: 1 })
    },
  })
  await s.runtime.enable(installed([], { config: { a: 1 } }))
  assert.equal(s.runtime.state('qq'), 'enabled')
})

test('memory writes carry the identity from the manifest, not from the caller', async () => {
  const s = await setup()
  await s.runtime.enable(installed())
  await s.ctx().memory.ingest({ kind: 'qq.message', channel: GROUP, source: 'evil', trust: 'self' } as never)
  const [, identity] = s.calls['memory.ingest']![0] as [unknown, Record<string, unknown>]
  assert.deepEqual(identity, {
    kind: 'plugin', source: 'qq', trust: 'member', defaultVisibility: 'origin', channels: [GROUP], eventKinds: ['qq.message'],
  })
})

test('channel patterns: qq:group:* matches qq:group:123 but not qq:private:1x, qq:group or qq:group:', async () => {
  const s = await setup()
  await s.runtime.enable(installed())
  const ok = (channel: string) => s.ctx().memory.ingest({ kind: 'qq.message', channel } as never)
  await ok('qq:group:123')
  await ok('qq:private:1')
  for (const bad of ['qq:private:2', 'qq:group', 'qq:group:', 'other:group:1', 'qq:privateX:1']) await denial(ok(bad))
  assert.equal(s.calls['memory.ingest']!.length, 2)
})

test('rate limit: N+1th write is RATE_LIMITED, an hour later it recovers, ingest and record share it', async () => {
  const m = manifest()
  const s = await setup()
  await s.runtime.enable(installed(undefined, {}, { ...m, source: { ...m.source!, rateLimitPerHour: 2 } }))
  const c = s.ctx()
  await c.memory.ingest({ kind: 'qq.message', channel: OWN } as never)
  await c.memory.record({ channel: OWN } as never)
  await denial(c.memory.ingest({ kind: 'qq.message', channel: OWN } as never), 'RATE_LIMITED')
  await denial(c.memory.record({ channel: OWN } as never), 'RATE_LIMITED')
  s.clock.advance(60 * 60 * 1000 - 1)
  await denial(c.memory.record({ channel: OWN } as never), 'RATE_LIMITED')
  s.clock.advance(1)
  await c.memory.record({ channel: OWN } as never)
  assert.equal(s.calls['memory.ingest']!.length + s.calls['memory.record']!.length, 3)
})

test('a refused write does not use up the rate limit', async () => {
  const m = manifest()
  const s = await setup()
  await s.runtime.enable(installed(undefined, {}, { ...m, source: { ...m.source!, rateLimitPerHour: 1 } }))
  await denial(s.ctx().memory.ingest({ kind: 'qq.message', channel: 'other:x:1' } as never))
  await s.ctx().memory.ingest({ kind: 'qq.message', channel: OWN } as never)
})

test('view: no channel is null with no participants; another plugin\'s channel is refused; own channel asks the kernel for participants', async () => {
  const s = await setup()
  await s.runtime.enable(installed())
  await s.ctx().memory.search({} as never)
  assert.deepEqual((s.calls['memory.search']![0] as unknown[])[1], { caller: 'qq', channel: null, participants: [] })
  await denial(s.ctx().memory.search({} as never, { channel: 'other:group:1' }))
  await denial(s.ctx().memory.remove('r', { channel: 'other:group:1' }))
  await denial(s.ctx().memory.context({ channel: 'other:group:1' } as never))
  await s.ctx().memory.search({} as never, { channel: GROUP, participants: ['evil'] } as never)
  assert.deepEqual((s.calls['memory.search']![1] as unknown[])[1], { caller: 'qq', channel: GROUP, participants: ['p1', 'p2'] })
  await s.ctx().memory.context({ channel: GROUP } as never)
  assert.deepEqual((s.calls['memory.context']![0] as unknown[])[1], { caller: 'qq', channel: GROUP, participants: ['p1', 'p2'] })
})

test('forget: record is checked against our source and forgotten; channel and time-with-channel need own channels; person and bare time are denied', async () => {
  const s = await setup()
  await s.runtime.enable(installed())
  const c = s.ctx()
  s.state.records.set('r1', stored('r1'))
  await c.memory.forget({ by: 'record', id: 'r1' })
  assert.equal(s.calls['memory.remove'], undefined)
  assert.deepEqual(s.calls['memory.forget']![0], [{ by: 'record', id: 'r1' }])
  await c.memory.forget({ by: 'channel', channel: GROUP })
  await c.memory.forget({ by: 'time', from: 0, to: 1, channel: GROUP })
  assert.equal(s.calls['memory.forget']!.length, 3)
  await denial(c.memory.forget({ by: 'channel', channel: 'other:group:1' }))
  await denial(c.memory.forget({ by: 'time', from: 0, to: 1, channel: 'other:group:1' }))
  await denial(c.memory.forget({ by: 'time', from: 0, to: 1 }))
  await denial(c.memory.forget({ by: 'person', personId: 'p1' }))
  assert.equal(s.calls['memory.forget']!.length, 3)
})

test('a plugin without a source cannot write memory', async () => {
  const s = await setup()
  const m = manifest(); delete (m as { source?: unknown }).source
  await s.runtime.enable(installed(undefined, {}, m))
  await denial(s.ctx().memory.ingest({ kind: 'qq.message', channel: OWN } as never))
})

test('tools.register: unlisted names refused; channels come from the tool, else the source, else *:*; group info is passed on', async () => {
  const s = await setup()
  await s.runtime.enable(installed())
  await denial(async () => s.ctx().tools.register({ ...tool, name: 'nope' }))
  s.ctx().tools.register(tool)
  s.ctx().tools.register({ ...tool, name: 'look' })
  const [say, look] = s.calls['gateway.register']!.map((a) => a[0] as Record<string, unknown>)
  assert.deepEqual(say!.channels, ['qq:group', 'qq:private'])
  assert.deepEqual(say!.group, { summary: 'group g' })
  assert.equal(say!.pluginId, 'qq')
  assert.deepEqual(look!.channels, ['qq:private'])
  assert.equal(look!.group, undefined)

  const bare = await setup()
  const m = manifest(); delete (m as { source?: unknown }).source
  await bare.runtime.enable(installed(undefined, {}, m))
  bare.ctx().tools.register(tool)
  assert.deepEqual((bare.calls['gateway.register']![0]![0] as { channels: string[] }).channels, ['*:*'])
})

test('a registered tool refuses to run once the plugin is disabled', async () => {
  const s = await setup()
  await s.runtime.enable(installed())
  s.ctx().tools.register(tool)
  const gw = s.calls['gateway.register']![0]![0] as { invoke(a: object, c: object): Promise<unknown> }
  assert.equal(await gw.invoke({}, {}), 'ok')
  await s.runtime.disable('qq')
  await denial(gw.invoke({}, {}))
})

test('agent.session and wake: own channel only, forwarded to the agent runtime', async () => {
  const s = await setup()
  await s.runtime.enable(installed())
  const handle = s.ctx().agent.session(GROUP)
  assert.equal(handle.channel, GROUP)
  await handle.wake({ reason: 'm' })
  await handle.rotate()
  await s.ctx().agent.wake(OWN, { reason: 'm' })
  assert.equal(s.calls['agent.wake']!.length, 2)
  assert.equal(s.calls['agent.rotate']!.length, 1)
  assert.throws(() => s.ctx().agent.session('other:group:1'), (e: unknown) => e instanceof BrainError && e.code === 'PERMISSION_DENIED')
  await denial(s.ctx().agent.wake('other:group:1', { reason: 'm' }))
})

test('channel.provide hands the provider to the registry', async () => {
  const s = await setup()
  await s.runtime.enable(installed())
  const provider = { send: async () => ({}) } as never
  s.ctx().channel.provide(provider)
  assert.deepEqual(s.calls['channels.provide']![0], ['qq', provider])
})

test('channel.send: other channel, failed check, rate limit, no provider; audited either way; noted only on success', async () => {
  const s = await setup()
  await s.runtime.enable(installed())
  const c = s.ctx()
  await denial(c.channel.send('other:group:1', { text: 'x' }))
  assert.equal(s.calls['audit.sent'], undefined)

  s.state.outbound = 'too long'
  try { await c.channel.send(OWN, { text: 'x' }); assert.fail() } catch (e) {
    assert.ok(e instanceof BrainError && e.code === 'INVALID_ARGUMENT' && e.message === 'too long')
  }
  s.state.outbound = null
  s.state.admit = false
  await denial(c.channel.send(OWN, { text: 'x' }), 'RATE_LIMITED')
  s.state.admit = true
  await denial(c.channel.send(OWN, { text: 'x' }), 'UNAVAILABLE')
  assert.equal(s.calls['audit.sent']!.length, 1)
  assert.equal((s.calls['audit.sent']![0]![0] as { ok: boolean }).ok, false)
  assert.equal(s.calls['gateway.noteOutbound'], undefined)

  s.state.provider = { send: async () => { throw new Error('down') } }
  await assert.rejects(c.channel.send(OWN, { text: 'x' }))
  assert.equal(s.calls['audit.sent']!.length, 2)
  assert.equal(s.calls['gateway.noteOutbound'], undefined)

  s.state.provider = { send: async () => ({ messageId: 'm1' }) }
  assert.deepEqual(await c.channel.send(OWN, { text: 'hello' }), { messageId: 'm1' })
  assert.equal(s.calls['audit.sent']!.length, 3)
  const entry = s.calls['audit.sent']![2]![0] as Record<string, unknown>
  assert.deepEqual({ ...entry, tAt: 0 }, { tool: 'channel.send', pluginId: 'qq', channel: OWN, ok: true, tAt: 0 })
  assert.deepEqual(s.calls['gateway.noteOutbound']![0], [OWN, 'hello'])
})

test('identity: accounts must start with <id>:', async () => {
  const s = await setup()
  await s.runtime.enable(installed())
  assert.equal(await s.ctx().identity.resolve('qq:42'), 'p1')
  await s.ctx().identity.link('qq:42', 'p9')
  await denial(s.ctx().identity.resolve('wx:42'))
  await denial(s.ctx().identity.link('wx:42', 'p9'))
  await denial(s.ctx().identity.resolve('qqx:42'))
})

test('scheduler: forwarded with the plugin id as owner', async () => {
  const s = await setup()
  await s.runtime.enable(installed())
  s.ctx().scheduler.every(5, () => undefined)
  s.ctx().scheduler.at(9, () => undefined)
  assert.equal(s.calls['scheduler.every']![0]![0], 'qq')
  assert.equal(s.calls['scheduler.at']![0]![0], 'qq')
})

test('events.emit: the name must start with <id>.; own events reach own listeners', async () => {
  const got: unknown[] = []
  let ctx: BrainContext | undefined
  const s = await setup({ apply: (c) => { ctx = c; c.events.on('qq.ready', (p) => { got.push(p) }) } })
  await s.runtime.enable(installed())
  ctx!.events.emit('qq.ready', { a: 1 })
  assert.deepEqual(got, [{ a: 1 }])
  assert.throws(() => ctx!.events.emit('message.in', {}), (e: unknown) => e instanceof BrainError && e.code === 'PERMISSION_DENIED')
  assert.throws(() => ctx!.events.emit('qqx.ready', {}), (e: unknown) => e instanceof BrainError && e.code === 'PERMISSION_DENIED')
})

test('secrets: reads the prefixed key, and only for a granted name', async () => {
  const s = await setup()
  s.state.secrets.set('plugin.qq.token', 'abc')
  await s.runtime.enable(installed())
  assert.equal(await s.ctx().secrets.get('token'), 'abc')
  assert.deepEqual(s.calls['secrets.get']![0], ['plugin.qq.token'])
  await denial(s.ctx().secrets.get('other'))
})

test('llm.complete is UNAVAILABLE even when granted', async () => {
  const s = await setup()
  await s.runtime.enable(installed())
  await denial(s.ctx().llm.complete({} as never), 'UNAVAILABLE')
})

// ---- review round 1 -------------------------------------------------------------------------------------------------

test('forget by record: our own record is forgotten and the report is the one the memory service returned', async () => {
  const s = await setup()
  const report = { tombstoned: 7, invalidated: 2, l3Flagged: 1 }
  ;(s.deps.memory as { forget: unknown }).forget = async (...a: unknown[]) => { (s.calls['memory.forget'] ??= []).push(a); return report }
  s.state.records.set('mine', stored('mine', { visibility: 'subject', channel: 'qq:group:9' }))
  await s.runtime.enable(installed())
  assert.deepEqual(await s.ctx().memory.forget({ by: 'record', id: 'mine' }), report)
  assert.deepEqual(s.calls['memory.forget'], [[{ by: 'record', id: 'mine' }]])
  assert.deepEqual(s.calls['readRecord'], [['mine']])
  assert.equal(s.calls['memory.remove'], undefined)
})

test('forget by record: someone else\'s record and a missing id look the same, and nothing is forgotten', async () => {
  const s = await setup()
  s.state.records.set('theirs', stored('theirs', { source: 'wx' }))
  await s.runtime.enable(installed())
  const failure = async (id: string): Promise<BrainError> => {
    try { await s.ctx().memory.forget({ by: 'record', id }) } catch (error) { return error as BrainError }
    throw new Error('should have thrown')
  }
  const other = await failure('theirs')
  const missing = await failure('ghost')
  assert.equal(other.code, 'NOT_FOUND')
  assert.equal(missing.code, 'NOT_FOUND')
  assert.equal(other.message, missing.message)
  assert.equal(s.calls['memory.forget'], undefined)
})

test('forget by record: L3 is refused, an empty or non-string id is INVALID_ARGUMENT, no permission is refused', async () => {
  const s = await setup()
  s.state.records.set('l3', stored('l3', { layer: 'L3' }))
  await s.runtime.enable(installed())
  await denial(s.ctx().memory.forget({ by: 'record', id: 'l3' }))
  await denial(s.ctx().memory.forget({ by: 'record', id: '' }), 'INVALID_ARGUMENT')
  await denial(s.ctx().memory.forget({ by: 'record', id: 5 } as never), 'INVALID_ARGUMENT')
  assert.equal(s.calls['memory.forget'], undefined)

  const bare = await setup()
  bare.state.records.set('mine', stored('mine'))
  await bare.runtime.enable(installed(installed().granted.filter((p) => p !== 'memory.forget')))
  await denial(bare.ctx().memory.forget({ by: 'record', id: 'mine' }))
  assert.equal(bare.calls['readRecord'], undefined)
  assert.equal(bare.calls['memory.forget'], undefined)
})

test('record refuses a channel that is not ours, and the refusal uses no rate-limit slot', async () => {
  const m = manifest()
  const s = await setup()
  await s.runtime.enable(installed(undefined, {}, { ...m, source: { ...m.source!, rateLimitPerHour: 1 } }))
  await denial(s.ctx().memory.record({ channel: 'other:x:1' } as never))
  await denial(s.ctx().memory.record({} as never))
  assert.equal(s.calls['memory.record'], undefined)
  await s.ctx().memory.record({ channel: OWN } as never)
})

test('rate limit: refused attempts take no slot, the oldest write frees one an hour after it was made', async () => {
  const m = manifest()
  const s = await setup()
  await s.runtime.enable(installed(undefined, {}, { ...m, source: { ...m.source!, rateLimitPerHour: 2 } }))
  const c = s.ctx()
  await c.memory.record({ channel: OWN } as never)
  s.clock.advance(10 * 60 * 1000)
  await c.memory.record({ channel: OWN } as never)
  for (let i = 0; i < 3; i += 1) await denial(c.memory.record({ channel: OWN } as never), 'RATE_LIMITED')
  s.clock.advance(50 * 60 * 1000 - 1)
  await denial(c.memory.record({ channel: OWN } as never), 'RATE_LIMITED')
  s.clock.advance(1)
  await c.memory.record({ channel: OWN } as never)
  assert.equal(s.calls['memory.record']!.length, 3)
})

test('update and remove write as the plugin: id, trust and visibility come from the manifest', async () => {
  const m = manifest()
  const s = await setup()
  await s.runtime.enable(installed(undefined, {}, { ...m, source: { ...m.source!, trust: 'external', defaultVisibility: 'subject' } }))
  const c = s.ctx()
  await c.memory.update('r', {}, 1, { channel: GROUP })
  await c.memory.remove('r', { channel: GROUP })
  await c.memory.update('r', {}, 1)
  await c.memory.remove('r')
  const identities = [
    (s.calls['memory.update']![0] as unknown[])[3], (s.calls['memory.remove']![0] as unknown[])[1],
    (s.calls['memory.update']![1] as unknown[])[3], (s.calls['memory.remove']![1] as unknown[])[1],
  ] as Record<string, unknown>[]
  for (const identity of identities) {
    assert.equal(identity.kind, 'plugin')
    assert.equal(identity.source, 'qq')
    assert.equal(identity.trust, 'external')
    assert.equal(identity.defaultVisibility, 'subject')
    assert.deepEqual(identity.eventKinds, ['qq.message'])
  }
  assert.deepEqual(identities.map((identity) => identity.channels), [[GROUP], [GROUP], [], []])
})

test('after disable a session handle obtained before refuses wake and rotate', async () => {
  const s = await setup()
  await s.runtime.enable(installed())
  const handle = s.ctx().agent.session(OWN)
  await s.runtime.disable('qq')
  await denial(async () => handle.wake({ reason: 'm' }))
  await denial(async () => handle.rotate())
  assert.equal(s.calls['agent.wake'], undefined)
  assert.equal(s.calls['agent.rotate'], undefined)
})

test('after disable http.fetch is refused even for a host that is granted, and nothing connects', async () => {
  let hits = 0
  const server = http.createServer((_, res) => { hits += 1; res.end('hi') })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  try {
    const port = (server.address() as AddressInfo).port
    const s = await setup({ deps: { lookup: async () => ['127.0.0.1'] } })
    await s.runtime.enable(installed([...installed().granted, 'lan:fake.local']))
    const ctx = s.ctx()
    assert.equal((await ctx.http.fetch(`http://fake.local:${port}/`)).text(), 'hi')
    await s.runtime.disable('qq')
    await denial(ctx.http.fetch(`http://fake.local:${port}/`))
    assert.equal(hits, 1)
  } finally { server.closeAllConnections(); server.close() }
})

test('channel.send: a failing audit is only logged, the send result stands and the message is noted', async () => {
  const warns: unknown[][] = []
  const s = await setup({
    deps: {
      audit: { sent: async () => { throw new Error('disk full') } },
      log: { info: () => undefined, warn: (...a: unknown[]) => { warns.push(a) }, error: () => undefined },
    },
  })
  await s.runtime.enable(installed())
  s.state.provider = { send: async () => ({ messageId: 'm1' }) }
  assert.deepEqual(await s.ctx().channel.send(OWN, { text: 'hello' }), { messageId: 'm1' })
  assert.deepEqual(s.calls['gateway.noteOutbound'], [[OWN, 'hello']])
  assert.deepEqual(warns, [['plugin.audit_failed', { plugin: 'qq', channel: OWN }]])

  s.state.provider = { send: async () => { throw new BrainError('UNAVAILABLE', 'provider down') } }
  await assert.rejects(s.ctx().channel.send(OWN, { text: 'again' }), (e: unknown) => e instanceof BrainError && e.message === 'provider down')
  assert.equal(s.calls['gateway.noteOutbound']!.length, 1)
  assert.equal(warns.length, 2)
})

test('the plugin log masks a secret the plugin read, in fields and in the event name', async () => {
  const value = 'hunter2-not-an-sk-key'
  const s = await setup()
  s.state.secrets.set('plugin.qq.token', value)
  await s.runtime.enable(installed())
  const ctx = s.ctx()
  assert.equal(await ctx.secrets.get('token'), value)
  ctx.logger.info(`got ${value}`, { note: `v=${value}`, fine: 'plain' })
  let text = ''
  for (const started = Date.now(); !text.endsWith('\n'); await new Promise((r) => setTimeout(r, 10))) {
    if (Date.now() - started > 2000) throw new Error(`plugin.log: waited ${Date.now() - started} ms, read ${text.length} bytes`)
    text = await readFile(path.join(s.dir, 'qq', 'plugin.log'), 'utf8').catch(() => '')
  }
  assert.ok(!text.includes(value), text)
  const [line] = text.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
  assert.equal(line!.event, 'got [redacted]')
  assert.equal(line!.note, 'v=[redacted]')
  assert.equal(line!.fine, 'plain')
})

// ---- Wave 0B: readChannelEvent & callToken --------------------------------------------------------------------------

test('memory.readChannelEvent: host-issued callToken succeeds during active tool call and passes trusted viewer', async () => {
  const expectedResult = {
    record: stored('l0_1', { layer: 'L0', kind: 'qq.message', channel: OWN }),
    disclosure: { speakable: 'yes' as const, label: '就在这里说过' },
  }
  const seen: unknown[][] = []
  let capturedCall: { channel: string; wakeId: string; callToken?: string } | undefined
  let capturedCtx: BrainContext | undefined
  let readResult: unknown
  const s = await setup({
    apply: (ctx) => {
      capturedCtx = ctx
      ctx.tools.register({
        name: 'look',
        description: 'look',
        parameters: { type: 'object' },
        handler: async (args, call) => {
          capturedCall = call
          readResult = await ctx.memory.readChannelEvent!(String(args.recordId), call)
          return 'ok'
        },
      })
    },
    deps: {
      participantsOf: async () => ['p_alice', 'p_bob'],
      readChannelEvent: async (recordId, sourcePluginId, viewer) => {
        seen.push([recordId, sourcePluginId, viewer])
        return expectedResult
      },
    },
  })
  await s.runtime.enable(installed())
  const registered = s.calls['gateway.register']![0]![0] as { invoke: (args: Record<string, unknown>, call: { channel: string; wakeId: string }) => Promise<unknown> }
  await registered.invoke({ recordId: 'l0_1' }, { channel: OWN, wakeId: 'w_1' })

  assert.equal(typeof capturedCall?.callToken, 'string')
  assert.ok((capturedCall?.callToken?.length ?? 0) >= 16)
  assert.deepEqual(readResult, expectedResult)
  assert.deepEqual(seen, [['l0_1', 'qq', { caller: 'qq', channel: OWN, participants: ['p_alice', 'p_bob'] }]])

  // Expired callToken after tool handler returns is rejected
  await denial(capturedCtx!.memory.readChannelEvent!('l0_1', capturedCall!))
})

test('memory.readChannelEvent: rejects missing permission, invalid recordId, missing/forged/tampered/cross-plugin callToken, and unconfigured dep', async () => {
  const withoutSearch = await setup({
    apply: (ctx) => {
      ctx.tools.register({
        name: 'look',
        description: 'look',
        parameters: { type: 'object' },
        handler: async (_args, call) => {
          await ctx.memory.readChannelEvent!('l0_1', call)
          return 'ok'
        },
      })
    },
    deps: { readChannelEvent: async () => ({ record: stored('l0_1', { layer: 'L0' }), disclosure: { speakable: 'yes', label: '就在这里说过' } }) },
  })
  await withoutSearch.runtime.enable(installed(installed().granted.filter((p) => p !== 'memory.search')))
  const toolNoPerm = withoutSearch.calls['gateway.register']![0]![0] as { invoke: (args: Record<string, unknown>, call: { channel: string; wakeId: string }) => Promise<unknown> }
  await denial(toolNoPerm.invoke({}, { channel: OWN, wakeId: 'w1' }))

  const other = await setup({
    apply: (ctx) => {
      ctx.tools.register({
        name: 'look',
        description: 'look',
        parameters: { type: 'object' },
        handler: async (_args, call) => {
          return call.callToken ?? ''
        },
      })
    },
  })
  await other.runtime.enable(installed(undefined, {}, manifest({ id: 'wx', source: { channels: ['wx:private:1'], eventKinds: ['wx.msg'], defaultVisibility: 'origin', trust: 'member' } })))

  let activeError: unknown
  const s = await setup({
    apply: (ctx) => {
      ctx.tools.register({
        name: 'look',
        description: 'look',
        parameters: { type: 'object' },
        handler: async (_args, call) => {
          await denial(ctx.memory.readChannelEvent!('', call), 'INVALID_ARGUMENT')
          await denial(ctx.memory.readChannelEvent!(123 as never, call), 'INVALID_ARGUMENT')
          await denial(ctx.memory.readChannelEvent!('l0_1', { channel: call.channel, wakeId: call.wakeId }))
          await denial(ctx.memory.readChannelEvent!('l0_1', { channel: call.channel, wakeId: call.wakeId, callToken: 'forged' }))
          await denial(ctx.memory.readChannelEvent!('l0_1', { channel: 'qq:group:999', wakeId: call.wakeId, callToken: call.callToken }))
          await denial(ctx.memory.readChannelEvent!('l0_1', { channel: call.channel, wakeId: 'other-wake', callToken: call.callToken }))
          // Cross-plugin token during an active call on another plugin
          const otherTool = other.calls['gateway.register']![0]![0] as { invoke: (args: Record<string, unknown>, call: { channel: string; wakeId: string }) => Promise<string> }
          let crossError: unknown
          const outerCall = call
          // Verify unconfigured readChannelEvent returns UNAVAILABLE
          try { await ctx.memory.readChannelEvent!('l0_1', outerCall) } catch (err) { crossError = err }
          activeError = crossError
          void otherTool
          return 'done'
        },
      })
    },
  })
  await s.runtime.enable(installed())
  const tool = s.calls['gateway.register']![0]![0] as { invoke: (args: Record<string, unknown>, call: { channel: string; wakeId: string }) => Promise<unknown> }
  await tool.invoke({}, { channel: OWN, wakeId: 'w_2' })
  assert.ok(activeError instanceof BrainError && activeError.code === 'UNAVAILABLE')

  // Cross-plugin callToken rejected even while the other plugin's tool call is actively in flight
  let crossPluginCheck: unknown
  const s2 = await setup({ deps: { readChannelEvent: async () => ({ record: stored('l0_1', { layer: 'L0' }), disclosure: { speakable: 'yes', label: '就在这里说过' } }) } })
  await s2.runtime.enable(installed())
  const other2 = await setup({
    apply: (ctx) => {
      ctx.tools.register({
        name: 'look',
        description: 'look',
        parameters: { type: 'object' },
        handler: async (_args, call) => {
          try {
            await s2.ctx().memory.readChannelEvent!('l0_1', call)
          } catch (err) {
            crossPluginCheck = err
          }
          return 'ok'
        },
      })
    },
  })
  await other2.runtime.enable(installed(undefined, {}, manifest({ id: 'wx', source: { channels: ['wx:private:1'], eventKinds: ['wx.msg'], defaultVisibility: 'origin', trust: 'member' } })))
  const otherTool2 = other2.calls['gateway.register']![0]![0] as { invoke: (args: Record<string, unknown>, call: { channel: string; wakeId: string }) => Promise<unknown> }
  await otherTool2.invoke({}, { channel: 'wx:private:1', wakeId: 'w_wx' })
  assert.ok(crossPluginCheck instanceof BrainError && crossPluginCheck.code === 'PERMISSION_DENIED')
})
