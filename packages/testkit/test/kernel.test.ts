import assert from 'node:assert/strict'
import test from 'node:test'
import { BrainError, LIMITS, type BrainContext, type ToolCallContext, type WebSocketEvent } from '@dsh-brain-core/sdk'
import { codeOf, HERE, ingestEvent, loadIdle, MANIFEST, manifestWith, OTHER, OWN, recordInput, sourceWith } from './helpers.ts'
import { createFakeChannel, createTestKernel, type TestKernel } from '../src/index.ts'
import { filterLogFields } from '../src/kernel.ts'

async function ingest(ctx: BrainContext, overrides: Record<string, unknown> = {}): Promise<string> {
  const result = await ctx.memory.ingest(ingestEvent(overrides) as never)
  return result.id
}

test('loadPlugin rejects an invalid manifest and a second load', async () => {
  const { kernel } = await loadIdle()
  assert.equal(await codeOf(() => kernel.loadPlugin({ apply: () => undefined }, { id: 'Bad' })), 'CONFLICT')
})

test('loadPlugin validates the manifest and throws INVALID_ARGUMENT', async () => {
  const { createTestKernel } = await import('../src/index.ts')
  const kernel = createTestKernel()
  assert.equal(await codeOf(() => kernel.loadPlugin({ apply: () => undefined }, { id: 'Bad' })), 'INVALID_ARGUMENT')
  assert.equal(await codeOf(() => kernel.loadPlugin({ apply: () => undefined }, MANIFEST)), 'ok')
})

test('memory writes carry source, trust and default visibility from the manifest', async () => {
  const { kernel, ctx } = await loadIdle({ manifest: sourceWith({ trust: 'owner', defaultVisibility: 'subject' }) })
  const eventId = await ingest(ctx)
  const recordId = (await ctx.memory.record(recordInput(eventId) as never)).id
  const records = kernel.records()
  const zero = records.find((record) => record.layer === 'L0')
  const one = records.find((record) => record.id === recordId)
  assert.equal(zero?.source, 'demo')
  assert.equal(zero?.trust, 'owner')
  assert.equal(zero?.visibility, 'subject')
  assert.equal(zero?.evidence.length, 0)
  assert.equal(one?.source, 'demo')
  assert.equal(one?.trust, 'owner')
  assert.equal(one?.visibility, 'subject')
  assert.deepEqual(one?.evidence, [{ id: eventId }])
})

test('ingest only takes the plugin own channels and registered event kinds', async () => {
  const { ctx } = await loadIdle()
  assert.equal(await codeOf(() => ingest(ctx, { channel: OTHER })), 'PERMISSION_DENIED')
  assert.equal(await codeOf(() => ingest(ctx, { channel: 'demo:group' })), 'PERMISSION_DENIED')
  assert.equal(await codeOf(() => ingest(ctx, { channel: 'demo:private:2' })), 'PERMISSION_DENIED')
  assert.equal(await codeOf(() => ingest(ctx, { kind: 'demo.other' })), 'PERMISSION_DENIED')
  assert.equal(await codeOf(() => ingest(ctx, { kind: 'other.message' })), 'PERMISSION_DENIED')
  assert.equal(await codeOf(() => ingest(ctx, { channel: 'demo:group:1' })), 'ok')
})

test('content over the limit is PAYLOAD_TOO_LARGE', async () => {
  const { ctx } = await loadIdle()
  const tooBig = { text: 'x'.repeat(LIMITS.contentBytes + 1) }
  assert.equal(await codeOf(() => ingest(ctx, { content: tooBig })), 'PAYLOAD_TOO_LARGE')
})

test('the write rate limit is shared by ingest and record and recovers after an hour', async () => {
  const { kernel, ctx } = await loadIdle({ manifest: sourceWith({ rateLimitPerHour: 2 }) })
  const eventId = await ingest(ctx, { idempotencyKey: 'rl-1' })
  await ctx.memory.record(recordInput(eventId) as never)
  assert.equal(await codeOf(() => ingest(ctx, { idempotencyKey: 'rl-2' })), 'RATE_LIMITED')
  assert.equal(await codeOf(() => ctx.memory.record(recordInput(eventId, { idempotencyKey: 'rl-3' }) as never)), 'RATE_LIMITED')
  await kernel.advance(60 * 60 * 1000 - 1)
  assert.equal(await codeOf(() => ingest(ctx, { idempotencyKey: 'rl-4' })), 'RATE_LIMITED')
  await kernel.advance(1)
  await ingest(ctx, { idempotencyKey: 'rl-5' })
  assert.equal(kernel.records().length, 3)
})

test('idempotencyKey deduplicates both ingest and record', async () => {
  const { kernel, ctx } = await loadIdle()
  const first = await ingest(ctx, { idempotencyKey: 'same' })
  const second = await ingest(ctx, { idempotencyKey: 'same' })
  assert.equal(first, second)
  assert.equal(kernel.records().length, 1)
  const record = await ctx.memory.record(recordInput(first, { idempotencyKey: 'same-record' }) as never)
  const again = await ctx.memory.record(recordInput(first, { idempotencyKey: 'same-record' }) as never)
  assert.equal(record.id, again.id)
  assert.equal(kernel.records().length, 2)
})

test('record requires evidence, a lower-layer evidence record and an L1 kind', async () => {
  const { ctx } = await loadIdle()
  const eventId = await ingest(ctx)
  assert.equal(await codeOf(() => ctx.memory.record({ ...recordInput(eventId), evidence: undefined } as never)), 'INVALID_ARGUMENT')
  assert.equal(await codeOf(() => ctx.memory.record(recordInput(eventId, { evidence: [] }) as never)), 'INVALID_ARGUMENT')
  assert.equal(await codeOf(() => ctx.memory.record(recordInput('l0_missing') as never)), 'INVALID_ARGUMENT')
  assert.equal(await codeOf(() => ctx.memory.record(recordInput(eventId, { kind: 'l1.nope' }) as never)), 'INVALID_ARGUMENT')
  assert.equal(await codeOf(() => ctx.memory.record(recordInput(eventId, { layer: 'L2', kind: 'l2.interest' }) as never)), 'ok')
})

test('an L3 write is refused at the schema, like the real memory service', async () => {
  const { ctx } = await loadIdle()
  const eventId = await ingest(ctx)
  const l3 = { ...recordInput(eventId), layer: 'L3', kind: 'l3.self' }
  assert.equal(await codeOf(() => ctx.memory.record(l3 as never)), 'INVALID_ARGUMENT')
})

test('update checks the version and patches the content; remove tombstones', async () => {
  const { kernel, ctx } = await loadIdle()
  const eventId = await ingest(ctx)
  const created = await ctx.memory.record(recordInput(eventId) as never)
  assert.equal(await codeOf(() => ctx.memory.update(created.id, { content: { text: 'new' } }, 9)), 'CONFLICT')
  assert.equal(await codeOf(() => ctx.memory.update(created.id, { status: 'tombstoned' }, 1)), 'INVALID_ARGUMENT')
  const updated = await ctx.memory.update(created.id, { content: { text: 'new' }, confidence: 0.4 }, 1)
  assert.equal(updated.version, 2)
  assert.deepEqual(updated.content, { text: 'new' })
  assert.equal(updated.confidence, 0.4)
  await ctx.memory.remove(created.id)
  assert.equal(kernel.records().find((record) => record.id === created.id)?.status, 'tombstoned')
  assert.equal(await codeOf(() => ctx.memory.remove(created.id)), 'NOT_FOUND')
})

test('an L0 record cannot be patched and another record is not found', async () => {
  const { ctx } = await loadIdle()
  const eventId = await ingest(ctx)
  assert.equal(await codeOf(() => ctx.memory.update(eventId, { content: {} }, 1)), 'PERMISSION_DENIED')
  assert.equal(await codeOf(() => ctx.memory.update('ghost', {}, 1)), 'NOT_FOUND')
  assert.equal(await codeOf(() => ctx.memory.remove('ghost')), 'NOT_FOUND')
})

test('search is a substring match over open records from this plugin only', async () => {
  const { ctx } = await loadIdle()
  const eventId = await ingest(ctx)
  await ctx.memory.record(recordInput(eventId, { content: { text: 'coffee is good' } }) as never)
  await ctx.memory.record(recordInput(eventId, { content: { text: 'coffee is private' }, visibility: 'owner' }) as never)
  await ctx.memory.record(recordInput(eventId, { content: { text: 'tea is good' } }) as never)
  const all = await ctx.memory.search({ query: 'coffee', scope: 'all' })
  assert.equal(all.items.length, 1)
  assert.deepEqual(all.items[0]?.record.content, { text: 'coffee is good' })
  assert.equal(all.degraded, false)
  assert.deepEqual((await ctx.memory.search({ query: 'coffee', scope: 'all', layers: ['L2'] })).items, [])
  const paged = await ctx.memory.search({ query: 'is', scope: 'all', limit: 1 })
  assert.equal(paged.items.length, 1)
  assert.ok(paged.nextCursor !== undefined)
  const next = await ctx.memory.search({ query: 'is', scope: 'all', limit: 1, cursor: paged.nextCursor })
  assert.equal(next.items.length, 1)
  assert.notEqual(next.items[0]?.record.id, paged.items[0]?.record.id)
  assert.equal(await codeOf(() => ctx.memory.search({ query: 'x', scope: 'all', cursor: 'bad' })), 'INVALID_ARGUMENT')
})

test('scope here needs an own channel and only shows that channel', async () => {
  const { ctx } = await loadIdle()
  const eventId = await ingest(ctx)
  await ctx.memory.record(recordInput(eventId, { content: { text: 'here' } }) as never)
  await ctx.memory.record(recordInput(eventId, { channel: HERE, content: { text: 'here' } }) as never)
  const withView = await ctx.memory.search({ query: 'here', scope: 'here' }, { channel: OWN })
  assert.equal(withView.items.length, 1)
  assert.equal(withView.items[0]?.record.channel, OWN)
  assert.equal((await ctx.memory.search({ query: 'here', scope: 'here' })).items.length, 0)
  assert.equal(await codeOf(() => ctx.memory.search({ query: 'x', scope: 'all' }, { channel: OTHER })), 'PERMISSION_DENIED')
})

test('context returns the open records of this plugin', async () => {
  const { ctx } = await loadIdle()
  const eventId = await ingest(ctx)
  const created = await ctx.memory.record(recordInput(eventId, { content: { text: 'context fact' } }) as never)
  const bundle = await ctx.memory.context({ channel: OWN, query: 'context' })
  assert.equal(bundle.profileVersion, 1)
  assert.equal(bundle.truncated, false)
  assert.deepEqual(bundle.blocks[0]?.items.map((item) => item.id), [created.id])
  assert.equal(await codeOf(() => ctx.memory.context({ channel: OTHER })), 'PERMISSION_DENIED')
})

test('forget follows the owner rules and tombstones the matching records', async () => {
  const { kernel, ctx } = await loadIdle()
  const eventId = await ingest(ctx)
  const created = await ctx.memory.record(recordInput(eventId) as never)
  const report = await ctx.memory.forget({ by: 'record', id: created.id })
  assert.deepEqual(report, { tombstoned: 1, invalidated: 0, l3Flagged: 0 })
  assert.equal(kernel.records().find((record) => record.id === created.id)?.status, 'tombstoned')
  assert.deepEqual(await ctx.memory.forget({ by: 'record', id: created.id }), { tombstoned: 0, invalidated: 0, l3Flagged: 0 })
  assert.equal(await codeOf(() => ctx.memory.forget({ by: 'record', id: 'ghost' })), 'NOT_FOUND')
  assert.equal(await codeOf(() => ctx.memory.forget({ by: 'person', personId: 'p1' })), 'PERMISSION_DENIED')
  assert.equal(await codeOf(() => ctx.memory.forget({ by: 'time', from: 0, to: 1 })), 'PERMISSION_DENIED')
  assert.equal(await codeOf(() => ctx.memory.forget({ by: 'channel', channel: OTHER })), 'PERMISSION_DENIED')
  const byChannel = await ctx.memory.forget({ by: 'channel', channel: OWN })
  assert.deepEqual(byChannel, { tombstoned: 1, invalidated: 0, l3Flagged: 0 })
})

test('forget by time with an own channel bounds tEvent', async () => {
  const { ctx } = await loadIdle()
  const eventId = await ingest(ctx)
  await ctx.memory.record(recordInput(eventId, { tEvent: 10 }) as never)
  await ctx.memory.record(recordInput(eventId, { tEvent: 20 }) as never)
  const report = await ctx.memory.forget({ by: 'time', from: 15, to: 25, channel: OWN })
  assert.equal(report.tombstoned, 1)
})

test('tools.register only accepts manifest tools, once each', async () => {
  const { kernel, ctx } = await loadIdle()
  assert.equal(await codeOf(() => ctx.tools.register({
    name: 'nope', description: 'x', parameters: { type: 'object' }, handler: async () => 'x',
  })), 'PERMISSION_DENIED')
  const dispose = ctx.tools.register({
    name: 'look', description: 'Look around', parameters: { type: 'object' }, handler: async () => 'seen',
  })
  assert.deepEqual(kernel.tools(), ['demo__look'])
  assert.equal(await codeOf(() => ctx.tools.register({
    name: 'look', description: 'Look around', parameters: { type: 'object' }, handler: async () => 'seen',
  })), 'CONFLICT')
  assert.equal(await kernel.callTool('demo__look'), 'seen')
  assert.equal(await codeOf(() => kernel.callTool('demo__missing')), 'NOT_FOUND')
  dispose()
  assert.deepEqual(kernel.tools(), [])
})

test('tool channels and owner audience are enforced on callTool', async () => {
  const tools = [
    ...MANIFEST.tools,
    { name: 'narrow', effect: 'read', load: 'core', summary: 'Narrow', channels: ['demo:group'] },
  ]
  const { kernel, ctx } = await loadIdle({ manifest: manifestWith({ tools }), ownerChannels: [HERE] })
  for (const name of ['look', 'narrow', 'door']) {
    ctx.tools.register({ name, description: name, parameters: { type: 'object' }, handler: async () => name })
  }
  assert.equal(await kernel.callTool('demo__narrow', {}, { channel: OWN }), 'narrow')
  assert.equal(await codeOf(() => kernel.callTool('demo__narrow', {}, { channel: HERE })), 'PERMISSION_DENIED')
  const channel = createFakeChannel()
  ctx.channel.provide(channel)
  assert.equal(await kernel.callTool('demo__door', {}, { channel: HERE }), 'door')
  assert.equal(await codeOf(() => kernel.callTool('demo__door', {}, { channel: OWN })), 'PERMISSION_DENIED')
})

test('a tool handler error reaches the caller', async () => {
  const { kernel, ctx } = await loadIdle()
  ctx.tools.register({
    name: 'look',
    description: 'Look around',
    parameters: { type: 'object' },
    handler: async () => { throw new BrainError('UNAVAILABLE', 'down') },
  })
  assert.equal(await codeOf(() => kernel.callTool('demo__look')), 'UNAVAILABLE')
})

test('agent.wake runs the script, or acknowledges with no script', async () => {
  const { kernel, ctx } = await loadIdle()
  const quiet = await ctx.agent.wake(OWN, { reason: 'message' })
  assert.equal(quiet.acked, true)
  assert.match(quiet.wakeId, /^wake_/)

  let seen: { readonly channel: string; readonly reason: string } | undefined
  let result: unknown
  ctx.tools.register({ name: 'look', description: 'Look around', parameters: { type: 'object' }, handler: async () => 'tool ran' })
  kernel.useAgent(async (wake, helpers) => {
    seen = { channel: wake.channel, reason: wake.input.reason }
    result = await helpers.callTool('demo__look')
  })
  const awake = await ctx.agent.wake(OWN, { reason: 'poke' })
  assert.equal(awake.acked, true)
  assert.deepEqual(seen, { channel: OWN, reason: 'poke' })
  assert.equal(result, 'tool ran')
  assert.equal(await codeOf(() => ctx.agent.wake(OTHER, { reason: 'poke' })), 'PERMISSION_DENIED')
})

test('a tool error reaches the fake agent script', async () => {
  const { kernel, ctx } = await loadIdle()
  let code = ''
  kernel.useAgent(async (_wake, helpers) => {
    code = await codeOf(() => helpers.callTool('demo__missing'))
  })
  await ctx.agent.wake(OWN, { reason: 'message' })
  assert.equal(code, 'NOT_FOUND')
})

test('agent.wake takes only the plugin own channels', async () => {
  const { ctx } = await loadIdle()
  assert.equal(await codeOf(() => ctx.agent.wake(OTHER, { reason: 'poke' })), 'PERMISSION_DENIED')
  assert.equal(await codeOf(() => ctx.agent.wake('demo:private:2', { reason: 'poke' })), 'PERMISSION_DENIED')
  assert.equal((await ctx.agent.wake(OWN, { reason: 'poke' })).acked, true)
})

test('agent.session binds the channel and forwards wake and rotate', async () => {
  const { ctx } = await loadIdle()
  const handle = ctx.agent.session(OWN)
  assert.equal(handle.channel, OWN)
  assert.equal((await handle.wake({ reason: 'message' })).acked, true)
  await handle.rotate()
  assert.equal(await codeOf(() => ctx.agent.session(OTHER)), 'PERMISSION_DENIED')
})

test('channel.provide and channel.send go through the provider', async () => {
  const { ctx } = await loadIdle()
  const channel = createFakeChannel()
  const dispose = ctx.channel.provide(channel)
  assert.deepEqual(await ctx.channel.send(OWN, { text: 'hello' }), { messageId: 'msg_1' })
  assert.deepEqual(channel.sent, [{ channel: OWN, message: { text: 'hello' } }])
  assert.equal(await codeOf(() => ctx.channel.provide(channel)), 'CONFLICT')
  assert.equal(await codeOf(() => ctx.channel.send(OTHER, { text: 'x' })), 'PERMISSION_DENIED')
  dispose()
  assert.equal(await codeOf(() => ctx.channel.send(OWN, { text: 'x' })), 'UNAVAILABLE')
})

test('scheduler every, at and ownTime run only when advance moves the clock', async () => {
  const { kernel, ctx } = await loadIdle()
  const runs = { every: 0, at: 0, own: 0 }
  const stopEvery = ctx.scheduler.every(60_000, () => { runs.every += 1 })
  ctx.scheduler.at(1_000, () => { runs.at += 1 })
  ctx.scheduler.ownTime({ name: 'think', everyMs: 60_000, run: () => { runs.own += 1 } })
  assert.equal(kernel.timers(), 3)
  assert.deepEqual(runs, { every: 0, at: 0, own: 0 })
  await kernel.advance(1_000)
  assert.deepEqual(runs, { every: 0, at: 1, own: 1 })
  await kernel.advance(59_000)
  assert.deepEqual(runs, { every: 1, at: 1, own: 1 })
  stopEvery()
  assert.equal(kernel.timers(), 1)
  await kernel.advance(60_000)
  assert.deepEqual(runs, { every: 1, at: 1, own: 2 })
})

test('scheduler input rules match the real scheduler', async () => {
  const { kernel, ctx } = await loadIdle()
  assert.equal(await codeOf(() => ctx.scheduler.every(59_999, () => undefined)), 'INVALID_ARGUMENT')
  assert.equal(await codeOf(() => ctx.scheduler.at(Number.NaN, () => undefined)), 'INVALID_ARGUMENT')
  assert.equal(await codeOf(() => ctx.scheduler.ownTime({ name: 'Bad Name', everyMs: 60_000, run: () => undefined })), 'INVALID_ARGUMENT')
  assert.equal(await codeOf(() => ctx.scheduler.ownTime({ name: 'x', everyMs: 10, run: () => undefined })), 'INVALID_ARGUMENT')
  ctx.scheduler.ownTime({ name: 'x', everyMs: 60_000, run: () => undefined })
  assert.equal(await codeOf(() => ctx.scheduler.ownTime({ name: 'x', everyMs: 60_000, run: () => undefined })), 'CONFLICT')
  assert.equal(kernel.timers(), 1)
})

test('events dispatch synchronously and one failing handler does not reach the others', async () => {
  const { ctx } = await loadIdle()
  const seen: unknown[] = []
  ctx.events.on('demo.ready', () => { throw new Error('boom') })
  ctx.events.on('demo.ready', (payload) => { seen.push(payload) })
  ctx.events.emit('demo.ready', { a: 1 })
  assert.deepEqual(seen, [{ a: 1 }])
  assert.equal(await codeOf(() => ctx.events.emit('message.in', {})), 'PERMISSION_DENIED')
  assert.equal(await codeOf(() => ctx.events.emit('demoX.ready', {})), 'PERMISSION_DENIED')
})

test('deliver sends a built-in event as the kernel would', async () => {
  const { kernel, ctx } = await loadIdle()
  const seen: unknown[] = []
  ctx.events.on('message.in', (payload) => { seen.push(payload) })
  const payload = { channel: OWN, count: 1, recordIds: ['l0_1'] }
  kernel.deliver('message.in', payload)
  assert.deepEqual(seen, [payload])
})

test('http routes answer with envelopes and errors keep their code', async () => {
  const { kernel, ctx } = await loadIdle()
  ctx.http.route('GET', '/echo', async (request) => ({
    method: request.method,
    path: request.path,
    query: request.query,
    body: request.body,
  }))
  ctx.http.route('GET', '/boom', async () => { throw new BrainError('CONFLICT', 'nope', { field: 'x' }) })
  ctx.http.route('GET', '/crash', async () => { throw new Error('kaboom') })
  assert.equal(await codeOf(() => ctx.http.route('GET', '/echo', async () => null)), 'CONFLICT')
  assert.equal(await codeOf(() => ctx.http.route('GET', 'echo', async () => null)), 'INVALID_ARGUMENT')

  const ok = await kernel.http('GET', '/api/v1/plugins/demo/echo?x=1', { a: 1 })
  assert.equal(ok.ok, true)
  if (ok.ok) {
    assert.deepEqual(ok.data, { method: 'GET', path: '/echo', query: { x: '1' }, body: { a: 1 } })
    assert.equal(typeof ok.meta.requestId, 'string')
  }
  const failed = await kernel.http('GET', '/api/v1/plugins/demo/boom')
  assert.equal(failed.ok, false)
  if (!failed.ok) {
    assert.equal(failed.error.code, 'CONFLICT')
    assert.equal(failed.error.message, 'nope')
    assert.deepEqual(failed.error.details, { field: 'x' })
  }
  const crashed = await kernel.http('GET', '/api/v1/plugins/demo/crash')
  assert.equal(crashed.ok, false)
  if (!crashed.ok) assert.equal(crashed.error.code, 'INTERNAL')
  const missing = await kernel.http('GET', '/api/v1/plugins/demo/nope')
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.equal(missing.error.code, 'NOT_FOUND')
  const elsewhere = await kernel.http('GET', '/api/v1/plugins/other/nope')
  assert.equal(elsewhere.ok, false)
  if (!elsewhere.ok) assert.equal(elsewhere.error.code, 'NOT_FOUND')
})

test('http.fetch checks network permissions and never touches the network', async () => {
  const { kernel, ctx } = await loadIdle()
  kernel.setResponse('https://api.example.com/x', { status: 201, body: '{"ok":true}' })
  const response = await ctx.http.fetch('https://api.example.com/x')
  assert.equal(response.status, 201)
  assert.equal(response.text(), '{"ok":true}')
  assert.deepEqual([...response.bytes()], [...new TextEncoder().encode('{"ok":true}')])
  assert.deepEqual(response.headers, {})
  assert.equal(await codeOf(() => ctx.http.fetch('https://evil.example.com/x')), 'PERMISSION_DENIED')
  assert.equal(await codeOf(() => ctx.http.fetch('ftp://api.example.com/x')), 'PERMISSION_DENIED')
  assert.equal(await codeOf(() => ctx.http.fetch('https://user:pass@api.example.com/x')), 'PERMISSION_DENIED')
  assert.equal(await codeOf(() => ctx.http.fetch('not a url')), 'INVALID_ARGUMENT')
  kernel.setResponse('https://api.example.com/empty', { status: 200, body: '' })
  assert.equal((await ctx.http.fetch('https://api.example.com/empty')).status, 200)
  assert.equal(await codeOf(() => ctx.http.fetch('https://api.example.com/missing')), 'UNAVAILABLE')
})

test('http.fetch supports wildcard, lan and config permissions', async () => {
  const audited = MANIFEST.permissions.filter((permission) => !permission.startsWith('network:') && !permission.startsWith('lan:'))
  const wildcard = await loadIdle({
    manifest: manifestWith({ permissions: [...audited, 'network:*.example.com'] }),
  })
  wildcard.kernel.setResponse('https://api.example.com/x', { status: 200, body: 'ok' })
  assert.equal((await wildcard.ctx.http.fetch('https://api.example.com/x')).text(), 'ok')
  assert.equal(await codeOf(() => wildcard.ctx.http.fetch('https://example.org/x')), 'PERMISSION_DENIED')

  const lan = await loadIdle()
  lan.kernel.setResponse('http://127.0.0.1:9999/x', { status: 200, body: 'lan' })
  assert.equal((await lan.ctx.http.fetch('http://127.0.0.1:9999/x')).text(), 'lan')

  const configured = await loadIdle({
    manifest: manifestWith({ permissions: [...audited, 'network:config:feeds'] }),
    load: { config: { feeds: ['https://cfg.example.net/x'] } },
  })
  configured.kernel.setResponse('https://cfg.example.net/x', { status: 200, body: 'cfg' })
  assert.equal((await configured.ctx.http.fetch('https://cfg.example.net/x')).text(), 'cfg')
  assert.equal(await codeOf(() => configured.ctx.http.fetch('https://other.example.net/x')), 'PERMISSION_DENIED')
})

test('http.fetch does not call the global fetch', async () => {
  const original = globalThis.fetch
  let called = false
  globalThis.fetch = (() => { called = true; throw new Error('real network') }) as typeof fetch
  try {
    const { kernel, ctx } = await loadIdle()
    kernel.setResponse('https://api.example.com/x', { status: 200, body: 'fake' })
    assert.equal((await ctx.http.fetch('https://api.example.com/x')).text(), 'fake')
    assert.equal(called, false)
  } finally {
    globalThis.fetch = original
  }
})

test('secrets, storage, logger and config are in-memory', async () => {
  const { kernel, ctx } = await loadIdle({ load: { config: { a: 1 } } })
  assert.deepEqual(ctx.config, { a: 1 })

  kernel.setSecret('token', 'abc')
  assert.equal(await ctx.secrets.get('token'), 'abc')
  assert.equal(await codeOf(() => ctx.secrets.get('other')), 'PERMISSION_DENIED')

  await ctx.storage.write('dir/note.txt', 'hello')
  assert.equal(new TextDecoder().decode(await ctx.storage.read('dir/note.txt')), 'hello')
  assert.deepEqual(await ctx.storage.list('dir'), ['dir/note.txt'])
  assert.deepEqual(await ctx.storage.list(), ['dir/note.txt'])
  await ctx.storage.remove('dir/note.txt')
  assert.equal(await ctx.storage.read('dir/note.txt'), undefined)

  assert.equal(await codeOf(() => ctx.storage.read('../escape')), 'PERMISSION_DENIED')
  assert.equal(await codeOf(() => ctx.storage.write('/etc/passwd', 'x')), 'PERMISSION_DENIED')
  assert.equal(await codeOf(() => ctx.storage.write('', 'x')), 'INVALID_ARGUMENT')

  ctx.logger.info('evt', { token: 'abc', content: 'chat', text: 'chat', n: 2, flag: true, nested: { a: 1 } })
  const logged = kernel.calls.filter((call) => call.method === 'logger.info').at(-1)
  assert.deepEqual(logged?.args, ['evt', { token: '[redacted]', n: 2, flag: true }])
})

test('llm.complete is UNAVAILABLE even when granted', async () => {
  const { ctx } = await loadIdle()
  assert.equal(await codeOf(() => ctx.llm.complete({ system: 's', user: 'u', maxOutputTokens: 1 })), 'UNAVAILABLE')
})

test('calls keep the order and drop raw content and text', async () => {
  const { kernel, ctx } = await loadIdle()
  await ctx.memory.ingest(ingestEvent({ content: { text: 'secret words' } }) as never)
  const methods = kernel.calls.map((call) => call.method)
  assert.deepEqual(methods.slice(0, 1), ['memory.ingest'])
  const call = kernel.calls.find((entry) => entry.method === 'memory.ingest')
  const input = call?.args[0] as Record<string, unknown> | undefined
  assert.equal(input?.kind, 'demo.message')
  assert.equal(input?.channel, OWN)
  assert.equal('content' in (input ?? {}), false)

  await ctx.agent.wake(OWN, { reason: 'message', note: 'trigger text' })
  const wake = kernel.calls.find((entry) => entry.method === 'agent.wake')
  const inputWake = wake?.args[1] as Record<string, unknown> | undefined
  assert.equal(inputWake?.reason, 'message')
  assert.equal('note' in (inputWake ?? {}), false)
})

test('unload removes tools, routes, timers, listeners and the provider', async () => {
  const { kernel, ctx } = await loadIdle()
  const channel = createFakeChannel()
  ctx.channel.provide(channel)
  ctx.tools.register({ name: 'look', description: 'Look around', parameters: { type: 'object' }, handler: async () => 'ok' })
  ctx.http.route('GET', '/x', async () => 'x')
  ctx.scheduler.every(60_000, () => undefined)
  let delivered = 0
  ctx.events.on('message.in', () => { delivered += 1 })
  const records = kernel.records()

  await kernel.unload()
  assert.deepEqual(kernel.tools(), [])
  assert.deepEqual(kernel.routes(), [])
  assert.equal(kernel.timers(), 0)
  kernel.deliver('message.in', { channel: OWN, count: 1, recordIds: [] })
  assert.equal(delivered, 0)
  assert.deepEqual(kernel.records(), records)
  assert.equal(await codeOf(() => ctx.tools.register({
    name: 'look', description: 'Look around', parameters: { type: 'object' }, handler: async () => 'ok',
  })), 'PERMISSION_DENIED')
  assert.equal(await codeOf(() => ctx.channel.send(OWN, { text: 'x' })), 'PERMISSION_DENIED')
  assert.equal(await codeOf(() => ctx.http.fetch('https://api.example.com/x')), 'PERMISSION_DENIED')
})

// --- 审核第一轮补的用例：权限、归属、过滤、日志和生命周期 ---

const OTHER_MANIFEST = manifestWith({
  id: 'other',
  source: {
    channels: ['other:group:*'],
    eventKinds: ['other.message'],
    defaultVisibility: 'open',
    trust: 'member',
  },
  tools: [],
})

/** Unloads demo and loads a second plugin in the same kernel, so the stores stay shared. */
async function switchToOther(kernel: TestKernel): Promise<BrainContext> {
  await kernel.unload()
  let captured: BrainContext | undefined
  await kernel.loadPlugin({ apply: (ctx) => { captured = ctx } }, OTHER_MANIFEST)
  if (captured === undefined) throw new Error('the kernel never called apply')
  return captured
}

test('record takes only the plugin own channels', async () => {
  const { ctx } = await loadIdle()
  const eventId = await ingest(ctx)
  assert.equal(await codeOf(() => ctx.memory.record(recordInput(eventId, { channel: OTHER }) as never)), 'PERMISSION_DENIED')
  assert.equal(await codeOf(() => ctx.memory.record(recordInput(eventId, { channel: 'demo:private:2' }) as never)), 'PERMISSION_DENIED')
})

test('ingest validates its fields and keeps the event visibility', async () => {
  const { kernel, ctx } = await loadIdle()
  assert.equal(await codeOf(() => ingest(ctx, { subjects: 'p1' })), 'INVALID_ARGUMENT')
  const id = await ingest(ctx, { visibility: 'internal', idempotencyKey: 'internal' })
  assert.equal(kernel.records().find((record) => record.id === id)?.visibility, 'internal')
})

test('record keeps a lowered confidence', async () => {
  const { ctx } = await loadIdle()
  const eventId = await ingest(ctx)
  const created = await ctx.memory.record(recordInput(eventId, { confidence: 0.3 }) as never)
  assert.equal(created.confidence, 0.3)
})

test('evidence must not be tombstoned and must come from a lower layer', async () => {
  const { ctx } = await loadIdle()
  const eventId = await ingest(ctx)
  await ctx.memory.forget({ by: 'record', id: eventId })
  assert.equal(await codeOf(() => ctx.memory.record(recordInput(eventId) as never)), 'INVALID_ARGUMENT')
  const second = await ingest(ctx, { idempotencyKey: 'second' })
  const first = await ctx.memory.record(recordInput(second) as never)
  assert.equal(await codeOf(() => ctx.memory.record(recordInput(first.id) as never)), 'INVALID_ARGUMENT')
})

test('update refuses a tombstoned record', async () => {
  const { ctx } = await loadIdle()
  const eventId = await ingest(ctx)
  const created = await ctx.memory.record(recordInput(eventId) as never)
  await ctx.memory.remove(created.id)
  assert.equal(await codeOf(() => ctx.memory.update(created.id, { content: {} }, 2)), 'NOT_FOUND')
})

test('records stay with their source across a plugin swap', async () => {
  const { kernel, ctx } = await loadIdle()
  const eventId = await ingest(ctx)
  const created = await ctx.memory.record(recordInput(eventId, { content: { text: 'source bound' } }) as never)
  const other = await switchToOther(kernel)
  assert.equal(await codeOf(() => other.memory.update(created.id, { content: {} }, 1)), 'PERMISSION_DENIED')
  assert.equal(await codeOf(() => other.memory.remove(created.id)), 'PERMISSION_DENIED')
  assert.equal(await codeOf(() => other.memory.forget({ by: 'record', id: created.id })), 'NOT_FOUND')
  assert.deepEqual((await other.memory.search({ query: 'source bound', scope: 'all' })).items, [])
  assert.deepEqual((await other.memory.context({ channel: 'other:group:1' })).blocks[0]?.items, [])
})

test('remove tombstones the record and clears its content', async () => {
  const { kernel, ctx } = await loadIdle()
  const eventId = await ingest(ctx)
  const created = await ctx.memory.record(recordInput(eventId, { content: { text: 'forget me' } }) as never)
  await ctx.memory.remove(created.id)
  const stored = kernel.records().find((record) => record.id === created.id)
  assert.equal(stored?.status, 'tombstoned')
  assert.deepEqual(stored?.content, {})
})

test('search drops tombstoned records and filters by time and subjects', async () => {
  const { ctx } = await loadIdle()
  const eventId = await ingest(ctx)
  const older = await ctx.memory.record(recordInput(eventId, { content: { text: 'window' }, tEvent: 10, subjects: ['p1'] }) as never)
  const newer = await ctx.memory.record(recordInput(eventId, { content: { text: 'window' }, tEvent: 20, subjects: ['p2'] }) as never)
  const gone = await ctx.memory.record(recordInput(eventId, { content: { text: 'window' }, tEvent: 15 }) as never)
  await ctx.memory.remove(gone.id)
  const archived = await ctx.memory.record(recordInput(eventId, { content: { text: 'window' }, tEvent: 25 }) as never)
  await ctx.memory.update(archived.id, { status: 'archived' }, 1)
  const ids = async (request: Record<string, unknown>): Promise<readonly string[]> =>
    (await ctx.memory.search({ query: 'window', scope: 'all', ...request } as never)).items.map((hit) => hit.record.id).sort()
  assert.deepEqual(await ids({}), [older.id, newer.id].sort())
  assert.deepEqual(await ids({ from: 15 }), [newer.id])
  assert.deepEqual(await ids({ to: 15 }), [older.id])
  assert.deepEqual(await ids({ subjects: ['p2'] }), [newer.id])
})

test('search enforces the limit cap and rejects a cursor with a negative offset', async () => {
  const { ctx } = await loadIdle()
  assert.equal(await codeOf(() => ctx.memory.search({ query: 'x', scope: 'all', limit: LIMITS.searchLimit + 1 })), 'INVALID_ARGUMENT')
  const negative = Buffer.from(JSON.stringify({ offset: -1 }), 'utf8').toString('base64url')
  assert.equal(await codeOf(() => ctx.memory.search({ query: 'x', scope: 'all', cursor: negative })), 'INVALID_ARGUMENT')
})

test('forget by time without a channel is refused as the owner-only form', async () => {
  const { ctx } = await loadIdle()
  await assert.rejects(ctx.memory.forget({ by: 'time', from: 0, to: 1 }), (error: unknown) => {
    assert.ok(error instanceof BrainError)
    assert.equal(error.code, 'PERMISSION_DENIED')
    assert.match(error.message, /owner/i)
    return true
  })
})

test('identity accounts must start with the plugin id', async () => {
  const { ctx } = await loadIdle()
  assert.equal(await codeOf(() => ctx.identity.resolve('other:1')), 'PERMISSION_DENIED')
  assert.equal(await codeOf(() => ctx.identity.link('other:1', 'p1')), 'PERMISSION_DENIED')
})

test('source channel patterns need three segments and a trailing wildcard', async () => {
  const manifest = manifestWith({
    id: 'qq',
    source: {
      channels: ['qq:group:*'],
      eventKinds: ['qq.message'],
      defaultVisibility: 'open',
      trust: 'member',
    },
  })
  const { ctx } = await loadIdle({ manifest })
  for (const channel of ['qq:group', 'qq:*:1', 'wx:group:1']) {
    assert.equal(
      await codeOf(() => ctx.memory.ingest(ingestEvent({ kind: 'qq.message', channel, idempotencyKey: `no-${channel}` }) as never)),
      'PERMISSION_DENIED',
      channel,
    )
  }
  assert.equal(
    await codeOf(() => ctx.memory.ingest(ingestEvent({ kind: 'qq.message', channel: 'qq:group:1', idempotencyKey: 'yes' }) as never)),
    'ok',
  )
})

test('tool channel patterns compare the source segment too', async () => {
  const tools = [{ name: 'cross', effect: 'read', load: 'core', summary: 'Cross', channels: ['qq:group'] }]
  const { kernel, ctx } = await loadIdle({ manifest: manifestWith({ tools }) })
  ctx.tools.register({
    name: 'cross', description: 'Cross', parameters: { type: 'object' }, handler: async () => 'cross',
  })
  assert.equal(await kernel.callTool('demo__cross', {}, { channel: 'qq:group:1' }), 'cross')
  assert.equal(await codeOf(() => kernel.callTool('demo__cross', {}, { channel: 'wx:group:1' })), 'PERMISSION_DENIED')
})

test('tool registration refuses parameters whose root is not an object', async () => {
  const { ctx } = await loadIdle()
  assert.equal(await codeOf(() => ctx.tools.register({
    name: 'look', description: 'Look', parameters: { type: 'string' } as never, handler: async () => 'x',
  })), 'INVALID_ARGUMENT')
})

test('a tool without channels defaults to its source channel prefixes', async () => {
  const { kernel, ctx } = await loadIdle()
  ctx.tools.register({ name: 'look', description: 'Look', parameters: { type: 'object' }, handler: async () => 'ok' })
  assert.equal(await kernel.callTool('demo__look', {}, { channel: OWN }), 'ok')
  assert.equal(await kernel.callTool('demo__look', {}, { channel: HERE }), 'ok')
  assert.equal(await codeOf(() => kernel.callTool('demo__look', {}, { channel: OTHER })), 'PERMISSION_DENIED')
})

test('ownTime names stay lower case', async () => {
  const { ctx } = await loadIdle()
  assert.equal(
    await codeOf(() => ctx.scheduler.ownTime({ name: 'Bad', everyMs: 60_000, run: () => undefined })),
    'INVALID_ARGUMENT',
  )
})

test('the call log never keeps raw text, even nested in arrays', async () => {
  const { kernel, ctx } = await loadIdle()
  const sentinel = 'SENTINEL-TEXT-9f2'
  await ctx.memory.ingest(ingestEvent({ content: { text: sentinel } }) as never)
  await ctx.agent.wake(OWN, { reason: 'message', text: sentinel } as never)
  ctx.events.emit('demo.note', { items: [{ content: sentinel }] })
  ctx.logger.info('sentinel', { Content: sentinel, text: sentinel })
  assert.equal(JSON.stringify(kernel.calls).includes(sentinel), false)
})

test('the logger drops raw-text keys and keeps only primitives', async () => {
  const { kernel, ctx } = await loadIdle()
  const sentinel = 'SENTINEL-LOG-4c1'
  ctx.logger.info('filtered', { Content: sentinel, TEXT: sentinel, extra: { sentinel } })
  ctx.logger.info('kept', { count: 2, flag: true })
  assert.equal(JSON.stringify(kernel.calls).includes(sentinel), false)
  assert.deepEqual(
    kernel.calls.filter((call) => call.method === 'logger.info').map((call) => call.args),
    [['filtered', {}], ['kept', { count: 2, flag: true }]],
  )
  // The stored log is private, so the case-insensitive key rule is checked at the filter itself.
  assert.deepEqual(filterLogFields({ Content: sentinel, TEXT: sentinel, token: 'abc', n: 1 }, ['abc']), {
    token: '[redacted]',
    n: 1,
  })
})

test('granted entries the manifest never declared are dropped', async () => {
  const kernel = createTestKernel()
  let captured: BrainContext | undefined
  await kernel.loadPlugin({ apply: (ctx) => { captured = ctx } }, MANIFEST, {
    granted: [...MANIFEST.permissions, 'secrets:other'],
  })
  if (captured === undefined) throw new Error('the kernel never called apply')
  kernel.setSecret('other', 'x')
  assert.equal(await codeOf(() => captured?.secrets.get('other')), 'PERMISSION_DENIED')
})

test('a failing apply leaves the kernel unloaded and its context inert', async () => {
  const kernel = createTestKernel()
  let captured: BrainContext | undefined
  await assert.rejects(kernel.loadPlugin({
    apply: async (ctx) => { captured = ctx; throw new Error('boom') },
  }, MANIFEST), /boom/)
  if (captured === undefined) throw new Error('apply never received a context')
  const stale = captured
  assert.equal(await codeOf(() => stale.tools.register({
    name: 'look', description: 'Look', parameters: { type: 'object' }, handler: async () => 'x',
  })), 'PERMISSION_DENIED')
  await kernel.loadPlugin({ apply: () => undefined }, MANIFEST)
  assert.deepEqual(kernel.tools(), [])
})

test('unload drops the provider so the next plugin can provide one', async () => {
  const kernel = createTestKernel()
  let first: BrainContext | undefined
  await kernel.loadPlugin({ apply: (ctx) => { first = ctx } }, MANIFEST)
  if (first === undefined) throw new Error('the kernel never called apply')
  first.channel.provide(createFakeChannel())
  await kernel.unload()
  let second: BrainContext | undefined
  await kernel.loadPlugin({ apply: (ctx) => { second = ctx } }, MANIFEST)
  if (second === undefined) throw new Error('the kernel never called apply')
  second.channel.provide(createFakeChannel())
  assert.deepEqual(await second.channel.send(OWN, { text: 'again' }), { messageId: 'msg_1' })
})

test('the disposer returned by events.on stops delivery', async () => {
  const { kernel, ctx } = await loadIdle()
  let seen = 0
  const off = ctx.events.on('message.in', () => { seen += 1 })
  kernel.deliver('message.in', { channel: OWN, count: 1, recordIds: [] })
  off()
  kernel.deliver('message.in', { channel: OWN, count: 1, recordIds: [] })
  assert.equal(seen, 1)
})

test('storage.list only returns keys under the prefix', async () => {
  const { ctx } = await loadIdle()
  await ctx.storage.write('a/one.txt', '1')
  await ctx.storage.write('a/two.txt', '2')
  await ctx.storage.write('b/three.txt', '3')
  assert.deepEqual(await ctx.storage.list('a'), ['a/one.txt', 'a/two.txt'])
  assert.deepEqual(await ctx.storage.list('b'), ['b/three.txt'])
})

test('http routes match whatever the method case and ignore other plugins', async () => {
  const { kernel, ctx } = await loadIdle()
  ctx.http.route('get', '/echo', async () => 'ok')
  const lower = await kernel.http('get', '/api/v1/plugins/demo/echo')
  assert.equal(lower.ok, true)
  const other = await kernel.http('GET', '/api/v1/plugins/other/echo')
  assert.equal(other.ok, false)
  if (!other.ok) assert.equal(other.error.code, 'NOT_FOUND')
})

test('owner tools only run in the configured owner channels', async () => {
  const tools = MANIFEST.tools.map((tool) => (
    tool.name === 'door' ? { ...structuredClone(tool), channels: ['qq:private'] } : tool
  ))
  const { kernel, ctx } = await loadIdle({
    manifest: manifestWith({ tools }),
    ownerChannels: ['qq:private:1'],
  })
  ctx.tools.register({ name: 'door', description: 'Door', parameters: { type: 'object' }, handler: async () => 'door' })
  const channel = createFakeChannel()
  channel.setMembers('qq:private:2', ['owner'])
  ctx.channel.provide(channel)
  assert.equal(await kernel.callTool('demo__door', {}, { channel: 'qq:private:1' }), 'door')
  assert.equal(await codeOf(() => kernel.callTool('demo__door', {}, { channel: 'qq:private:2' })), 'PERMISSION_DENIED')
})

test('an owner tool without a channel is refused, while an ordinary tool still runs', async () => {
  const { kernel, ctx } = await loadIdle()
  ctx.tools.register({ name: 'look', description: 'Look', parameters: { type: 'object' }, handler: async () => 'look' })
  ctx.tools.register({ name: 'door', description: 'Door', parameters: { type: 'object' }, handler: async () => 'door' })
  assert.equal(await kernel.callTool('demo__look'), 'look')
  assert.equal(await codeOf(() => kernel.callTool('demo__door')), 'PERMISSION_DENIED')
})

test('readL0 filters active L0 records by time and paginates with afterId and limit', async () => {
  const providerManifest = {
    id: 'provider-demo',
    kinds: ['channel', 'memory-provider'],
    api: '^1.0.0',
    runtime: 'node',
    permissions: ['memory.ingest', 'memory.record', 'memory.forget', 'memory.readL0'],
    source: {
      channels: ['provider-demo:group:*'],
      eventKinds: ['provider-demo.message'],
      defaultVisibility: 'open',
      trust: 'member',
    },
  }
  const { ctx } = await loadIdle({ manifest: providerManifest })
  const id1 = (await ctx.memory.ingest(ingestEvent({ kind: 'provider-demo.message', channel: 'provider-demo:group:1', tEvent: 100, idempotencyKey: 'r1' }) as never)).id
  const id2 = (await ctx.memory.ingest(ingestEvent({ kind: 'provider-demo.message', channel: 'provider-demo:group:1', tEvent: 200, idempotencyKey: 'r2' }) as never)).id
  const id3 = (await ctx.memory.ingest(ingestEvent({ kind: 'provider-demo.message', channel: 'provider-demo:group:1', tEvent: 300, idempotencyKey: 'r3' }) as never)).id
  const id4 = (await ctx.memory.ingest(ingestEvent({ kind: 'provider-demo.message', channel: 'provider-demo:group:1', tEvent: 400, idempotencyKey: 'r4' }) as never)).id
  await ctx.memory.forget({ by: 'record', id: id2 })
  await ctx.memory.record(recordInput(id1, { channel: 'provider-demo:group:1' }) as never)

  const page1 = await ctx.memory.readL0({ limit: 2 })
  assert.deepEqual(page1.items.map((item) => item.id), [id1, id3])
  assert.equal(page1.nextCursor, id3)

  const page2 = await ctx.memory.readL0({ afterId: page1.nextCursor, limit: 2 })
  assert.deepEqual(page2.items.map((item) => item.id), [id4])
  assert.equal(page2.nextCursor, undefined)

  // Exact limit boundary: remaining matches === limit must leave nextCursor undefined
  const exactAll = await ctx.memory.readL0({ limit: 3 })
  assert.deepEqual(exactAll.items.map((item) => item.id), [id1, id3, id4])
  assert.equal(exactAll.nextCursor, undefined)
  const exactTail = await ctx.memory.readL0({ afterId: id1, limit: 2 })
  assert.deepEqual(exactTail.items.map((item) => item.id), [id3, id4])
  assert.equal(exactTail.nextCursor, undefined)

  // Inclusive from/to boundaries
  const exactBounds = await ctx.memory.readL0({ from: 300, to: 300 })
  assert.deepEqual(exactBounds.items.map((item) => item.id), [id3])
  const wideBounds = await ctx.memory.readL0({ from: 100, to: 400 })
  assert.deepEqual(wideBounds.items.map((item) => item.id), [id1, id3, id4])

  // Invalid request parameters
  for (const bad of [null, []]) {
    assert.equal(await codeOf(() => ctx.memory.readL0(bad as never)), 'INVALID_ARGUMENT')
  }
  assert.equal(await codeOf(() => ctx.memory.readL0({ afterId: 123 as never })), 'INVALID_ARGUMENT')
  assert.equal(await codeOf(() => ctx.memory.readL0({ from: Number.NaN })), 'INVALID_ARGUMENT')
  assert.equal(await codeOf(() => ctx.memory.readL0({ from: '100' as never })), 'INVALID_ARGUMENT')
  assert.equal(await codeOf(() => ctx.memory.readL0({ to: Number.POSITIVE_INFINITY })), 'INVALID_ARGUMENT')
  assert.equal(await codeOf(() => ctx.memory.readL0({ to: '200' as never })), 'INVALID_ARGUMENT')
  for (const badLimit of [0, -1, 1.5, LIMITS.searchLimit + 1]) {
    assert.equal(await codeOf(() => ctx.memory.readL0({ limit: badLimit })), 'INVALID_ARGUMENT')
  }

  const { ctx: deniedCtx } = await loadIdle()
  assert.equal(await codeOf(() => deniedCtx.memory.readL0()), 'PERMISSION_DENIED')
})

test('writeDerived enforces memory.writeDerived, L0 evidence, and forced l1.candidate metadata', async () => {
  const { kernel, ctx } = await loadIdle({
    manifest: manifestWith({
      kinds: ['activity', 'memory-provider'],
      permissions: [...MANIFEST.permissions, 'memory.readL0', 'memory.writeDerived'],
    }),
  })
  const l0Id = await ingest(ctx, { idempotencyKey: 'wd-l0' })
  const l1 = await ctx.memory.record(recordInput(l0Id, { idempotencyKey: 'wd-l1' }) as never)
  const goneL0 = await ingest(ctx, { idempotencyKey: 'wd-gone' })
  await ctx.memory.forget({ by: 'record', id: goneL0 })

  for (const badInput of [null, []]) {
    assert.equal(await codeOf(() => ctx.memory.writeDerived(badInput as never)), 'INVALID_ARGUMENT')
  }
  assert.equal(await codeOf(() => ctx.memory.writeDerived({
    channel: '', subjects: ['p1'], content: { text: 'bad' }, evidence: [{ id: l0Id }],
  })), 'INVALID_ARGUMENT')
  assert.equal(await codeOf(() => ctx.memory.writeDerived({
    channel: OWN, subjects: ['p1'], content: { text: 'bad' }, evidence: [{ id: l0Id }], visibility: 'public' as never,
  })), 'INVALID_ARGUMENT')
  for (const badScore of [-0.1, 1.1, Number.NaN]) {
    assert.equal(await codeOf(() => ctx.memory.writeDerived({
      channel: OWN, subjects: ['p1'], content: { text: 'bad' }, evidence: [{ id: l0Id }], confidence: badScore,
    })), 'INVALID_ARGUMENT')
    assert.equal(await codeOf(() => ctx.memory.writeDerived({
      channel: OWN, subjects: ['p1'], content: { text: 'bad' }, evidence: [{ id: l0Id }], importance: badScore,
    })), 'INVALID_ARGUMENT')
  }
  assert.equal(await codeOf(() => ctx.memory.writeDerived({
    channel: OWN, subjects: 'p1' as never, content: { text: 'bad' }, evidence: [{ id: l0Id }],
  })), 'INVALID_ARGUMENT')
  assert.equal(await codeOf(() => ctx.memory.writeDerived({
    channel: OWN, subjects: ['p1'], content: null as never, evidence: [{ id: l0Id }],
  })), 'INVALID_ARGUMENT')
  assert.equal(await codeOf(() => ctx.memory.writeDerived({
    channel: OWN, subjects: ['p1'], content: { text: 'bad' }, evidence: [{ id: '' }],
  })), 'INVALID_ARGUMENT')
  assert.equal(await codeOf(() => ctx.memory.writeDerived({
    channel: OWN, subjects: ['p1'], content: { text: 'bad' }, evidence: [],
  })), 'INVALID_ARGUMENT')
  assert.equal(await codeOf(() => ctx.memory.writeDerived({
    channel: OWN, subjects: ['p1'], content: { text: 'bad' }, evidence: [{ id: 'l0_missing' }],
  })), 'INVALID_ARGUMENT')
  assert.equal(await codeOf(() => ctx.memory.writeDerived({
    channel: OWN, subjects: ['p1'], content: { text: 'bad' }, evidence: [{ id: goneL0 }],
  })), 'INVALID_ARGUMENT')
  assert.equal(await codeOf(() => ctx.memory.writeDerived({
    channel: OWN, subjects: ['p1'], content: { text: 'bad' }, evidence: [{ id: l1.id }],
  })), 'INVALID_ARGUMENT')

  const derived = await ctx.memory.writeDerived({
    channel: 'other-source:private:9',
    subjects: ['p1'],
    content: { text: 'candidate fact' },
    evidence: [{ id: l0Id }],
    idempotencyKey: 'wd-1',
  })
  assert.equal(derived.layer, 'L1')
  assert.equal(derived.kind, 'l1.candidate')
  assert.equal(derived.source, 'demo')
  assert.equal(derived.actor, 'demo')
  assert.equal(derived.trust, 'external')
  assert.equal(derived.visibility, 'origin')
  assert.equal(derived.channel, 'other-source:private:9')
  assert.deepEqual(derived.evidence, [{ id: l0Id }])

  const explicit = await ctx.memory.writeDerived({
    channel: 'other-source:private:9',
    subjects: ['p1'],
    content: { text: 'owner fact' },
    evidence: [{ id: l0Id }],
    visibility: 'owner',
    confidence: 0,
    importance: 1,
    idempotencyKey: 'wd-2',
  })
  assert.equal(explicit.visibility, 'owner')
  assert.equal(explicit.confidence, 0)
  assert.equal(explicit.importance, 1)

  const deduped = await ctx.memory.writeDerived({
    channel: 'other-source:private:9',
    subjects: ['p1'],
    content: { text: 'candidate fact' },
    evidence: [{ id: l0Id }],
    idempotencyKey: 'wd-1',
  })
  assert.equal(deduped.id, derived.id)

  const { ctx: deniedCtx } = await loadIdle()
  assert.equal(await codeOf(() => deniedCtx.memory.writeDerived({
    channel: OWN, subjects: [], content: {}, evidence: [{ id: l0Id }],
  })), 'PERMISSION_DENIED')
  void kernel
})

test('memory.provide registers providers for memory-provider plugins and clears on dispose or unload', async () => {
  const provider = {
    search: async () => [],
    onForgotten: async () => undefined,
  }
  const { ctx: wrongKind } = await loadIdle({
    manifest: {
      id: 'non-provider',
      kinds: ['capability'],
      api: '^1.0.0',
      runtime: 'node',
      permissions: [],
    },
  })
  assert.equal(await codeOf(() => wrongKind.memory.provide(provider)), 'PERMISSION_DENIED')

  const { ctx: noReadL0 } = await loadIdle({
    manifest: {
      id: 'ungranted-provider',
      kinds: ['memory-provider'],
      api: '^1.0.0',
      runtime: 'node',
      permissions: [],
    },
  })
  assert.equal(await codeOf(() => noReadL0.memory.provide(provider)), 'PERMISSION_DENIED')

  const { kernel, ctx } = await loadIdle({
    manifest: {
      id: 'vec-provider',
      kinds: ['memory-provider'],
      api: '^1.0.0',
      runtime: 'node',
      permissions: ['memory.readL0', 'memory.writeDerived'],
    },
  })
  for (const badProvider of [
    null,
    {},
    { search: async () => [] },
    { onForgotten: async () => undefined },
  ]) {
    assert.equal(await codeOf(() => ctx.memory.provide(badProvider as never)), 'INVALID_ARGUMENT')
  }

  const dispose = ctx.memory.provide(provider)
  assert.deepEqual(kernel.memoryProviders(), [provider])
  dispose()
  assert.deepEqual(kernel.memoryProviders(), [])

  ctx.memory.provide(provider)
  assert.deepEqual(kernel.memoryProviders(), [provider])
  await kernel.unload()
  assert.deepEqual(kernel.memoryProviders(), [])
})

test('useLlm handles ctx.llm.complete while keeping UNAVAILABLE when unset', async () => {
  const { kernel, ctx } = await loadIdle()
  assert.equal(await codeOf(() => ctx.llm.complete({ system: 'sys', user: 'hi', maxOutputTokens: 16 })), 'UNAVAILABLE')

  kernel.useLlm(async (req) => ({ text: `${req.system}:${req.user}:${req.maxOutputTokens}`, tokens: 42 }))
  const reply = await ctx.llm.complete({ system: 'sys', user: 'hi', maxOutputTokens: 16 })
  assert.deepEqual(reply, { text: 'sys:hi:16', tokens: 42 })
})

test('readChannelEvent enforces active callToken, ownership, L0 status, and policy visibility', async () => {
  const { kernel, ctx } = await loadIdle({ ownerChannels: [HERE] })
  const channel = createFakeChannel()
  channel.setMembers(OWN, ['self', 'p1'])
  channel.setMembers(HERE, ['self', 'p1'])
  ctx.channel.provide(channel)

  const openId = await ingest(ctx, { channel: OWN, visibility: 'open', idempotencyKey: 'rce-open' })
  const originId = await ingest(ctx, { channel: OWN, visibility: 'origin', idempotencyKey: 'rce-origin' })
  const internalId = await ingest(ctx, { channel: OWN, visibility: 'internal', idempotencyKey: 'rce-internal' })
  const ownerOwnId = await ingest(ctx, { channel: OWN, visibility: 'owner', idempotencyKey: 'rce-owner-own' })
  const ownerHereId = await ingest(ctx, { channel: HERE, visibility: 'owner', idempotencyKey: 'rce-owner-here' })
  const subjectMatchId = await ingest(ctx, {
    channel: OWN,
    visibility: 'subject',
    subjects: ['self', OWN, 'p1'],
    idempotencyKey: 'rce-subj-match',
  })
  const subjectPrivateId = await ingest(ctx, {
    channel: HERE,
    visibility: 'subject',
    subjects: ['p1'],
    idempotencyKey: 'rce-subj-priv',
  })
  const subjectMissId = await ingest(ctx, {
    channel: OWN,
    visibility: 'subject',
    subjects: ['self', OWN, 'p2'],
    idempotencyKey: 'rce-subj-miss',
  })
  const tombstonedId = await ingest(ctx, { channel: OWN, visibility: 'open', idempotencyKey: 'rce-tomb' })
  await ctx.memory.forget({ by: 'record', id: tombstonedId })
  const l1 = await ctx.memory.record(recordInput(openId, { channel: OWN, idempotencyKey: 'rce-l1' }) as never)

  let capturedCall: ToolCallContext | undefined
  ctx.tools.register({
    name: 'look',
    description: 'Read L0 event',
    parameters: { type: 'object', properties: { recordId: { type: 'string' } } },
    handler: async (args, call) => {
      capturedCall = call
      if (args.probe === 'forged') {
        assert.equal(await codeOf(() => ctx.memory.readChannelEvent!(openId, { ...call, callToken: 'forged' })), 'PERMISSION_DENIED')
        assert.equal(await codeOf(() => ctx.memory.readChannelEvent!(openId, { ...call, channel: HERE })), 'PERMISSION_DENIED')
        assert.equal(await codeOf(() => ctx.memory.readChannelEvent!(openId, { ...call, wakeId: 'wake_other' })), 'PERMISSION_DENIED')
        assert.equal(await codeOf(() => ctx.memory.readChannelEvent!('', call)), 'INVALID_ARGUMENT')
        return 'probed'
      }
      const res = await ctx.memory.readChannelEvent!(String(args.recordId), call)
      return JSON.stringify(res)
    },
  })

  // Active call reads open & origin records
  const openRes = JSON.parse(await kernel.callTool('demo__look', { recordId: openId }, { channel: OWN }) as string)
  assert.equal(openRes.record.id, openId)
  assert.deepEqual(openRes.disclosure, { speakable: 'yes', label: '就在这里说过' })
  assert.ok(capturedCall?.callToken)

  // Expired token after callTool completes must be rejected
  assert.equal(await codeOf(() => ctx.memory.readChannelEvent!(openId, capturedCall!)), 'PERMISSION_DENIED')
  assert.equal(await codeOf(() => ctx.memory.readChannelEvent!(openId, { channel: OWN, wakeId: 'wake_1' })), 'PERMISSION_DENIED')

  assert.equal(await kernel.callTool('demo__look', { probe: 'forged' }, { channel: OWN }), 'probed')

  const originRes = JSON.parse(await kernel.callTool('demo__look', { recordId: originId }, { channel: OWN }) as string)
  assert.deepEqual(originRes.disclosure, { speakable: 'yes', label: '就在这里说过' })

  // Cross-channel, non-L0, tombstoned, internal -> NOT_FOUND
  assert.equal(await codeOf(() => kernel.callTool('demo__look', { recordId: ownerHereId }, { channel: OWN })), 'NOT_FOUND')
  assert.equal(await codeOf(() => kernel.callTool('demo__look', { recordId: l1.id }, { channel: OWN })), 'NOT_FOUND')
  assert.equal(await codeOf(() => kernel.callTool('demo__look', { recordId: tombstonedId }, { channel: OWN })), 'NOT_FOUND')
  assert.equal(await codeOf(() => kernel.callTool('demo__look', { recordId: internalId }, { channel: OWN })), 'NOT_FOUND')

  // Owner visibility: denied in non-owner channel, allowed in owner channel
  assert.equal(await codeOf(() => kernel.callTool('demo__look', { recordId: ownerOwnId }, { channel: OWN })), 'NOT_FOUND')
  const ownerRes = JSON.parse(await kernel.callTool('demo__look', { recordId: ownerHereId }, { channel: HERE }) as string)
  assert.deepEqual(ownerRes.disclosure, { speakable: 'yes', label: '就在这里说过' })

  // Subject visibility: group uses if-subject-raises, private uses yes, missing subject -> NOT_FOUND
  const subjGroup = JSON.parse(await kernel.callTool('demo__look', { recordId: subjectMatchId }, { channel: OWN }) as string)
  assert.deepEqual(subjGroup.disclosure, { speakable: 'if-subject-raises', label: '就在这里说过，不要当众提，对方自己提起再接话' })
  const subjPriv = JSON.parse(await kernel.callTool('demo__look', { recordId: subjectPrivateId }, { channel: HERE }) as string)
  assert.deepEqual(subjPriv.disclosure, { speakable: 'yes', label: '就在这里说过' })
  assert.equal(await codeOf(() => kernel.callTool('demo__look', { recordId: subjectMissId }, { channel: OWN })), 'NOT_FOUND')

  // Missing memory.search permission -> PERMISSION_DENIED
  const withoutSearch = await loadIdle({
    load: { granted: MANIFEST.permissions.filter((p) => p !== 'memory.search') },
  })
  withoutSearch.ctx.tools.register({
    name: 'look',
    description: 'Read',
    parameters: { type: 'object' },
    handler: async (_args, call) => {
      await withoutSearch.ctx.memory.readChannelEvent!(openId, call)
      return 'ok'
    },
  })
  assert.equal(await codeOf(() => withoutSearch.kernel.callTool('demo__look', {}, { channel: OWN })), 'PERMISSION_DENIED')
})

test('http.fetch enforces FetchOptions.redirect policy and preserves response headers', async () => {
  const { kernel, ctx } = await loadIdle()
  for (const status of [301, 302, 303, 307, 308]) {
    const url = `https://api.example.com/r/${status}`
    kernel.setResponse(url, { status, body: 'redirect', headers: { location: 'https://api.example.com/dest' } })
    const followed = await ctx.http.fetch(url, { redirect: 'follow' })
    assert.equal(followed.status, status)
    assert.deepEqual(followed.headers, { location: 'https://api.example.com/dest' })
    assert.equal(await codeOf(() => ctx.http.fetch(url, { redirect: 'error' })), 'PERMISSION_DENIED')
  }
  kernel.setResponse('https://api.example.com/ok', { status: 200, body: 'ok' })
  assert.equal((await ctx.http.fetch('https://api.example.com/ok', { redirect: 'error' })).status, 200)
  assert.equal(await codeOf(() => ctx.http.fetch('https://api.example.com/ok', { redirect: 'manual' as never })), 'INVALID_ARGUMENT')
})

test('http.subscribeWebSocket enforces authorization, URL, secret, and loopback rules', async () => {
  const audited = MANIFEST.permissions.filter((p) => !p.startsWith('secrets:') && !p.startsWith('lan:') && !p.startsWith('network:'))

  // Missing lan:config / network:config permission
  const noPerm = await loadIdle({
    manifest: manifestWith({ permissions: audited }),
    load: { config: { wsUrl: 'ws://127.0.0.1:3001' } },
  })
  assert.equal(await codeOf(() => noPerm.ctx.http.subscribeWebSocket!({ configKey: 'wsUrl' }, () => undefined)), 'PERMISSION_DENIED')

  // Bad URL shapes & query params
  for (const badConfig of [
    {},
    { wsUrl: '' },
    { wsUrl: 'not-a-url' },
  ]) {
    const bad = await loadIdle({
      manifest: manifestWith({ permissions: [...audited, 'lan:config:wsUrl'] }),
      load: { config: badConfig },
    })
    assert.equal(await codeOf(() => bad.ctx.http.subscribeWebSocket!({ configKey: 'wsUrl' }, () => undefined)), 'INVALID_ARGUMENT')
  }

  for (const deniedUrl of [
    'http://127.0.0.1:3001',
    'ws://user:pass@127.0.0.1:3001',
    'ws://127.0.0.1:3001?token=leak',
    'ws://127.0.0.1:3001?Access_Token=leak',
  ]) {
    const bad = await loadIdle({
      manifest: manifestWith({ permissions: [...audited, 'lan:config:wsUrl'] }),
      load: { config: { wsUrl: deniedUrl } },
    })
    assert.equal(await codeOf(() => bad.ctx.http.subscribeWebSocket!({ configKey: 'wsUrl' }, () => undefined)), 'PERMISSION_DENIED')
  }

  // Custom auth.paramName in URL query must also be refused
  const customParam = await loadIdle({
    manifest: manifestWith({ permissions: [...audited, 'lan:config:wsUrl', 'secrets:ws-tok'] }),
    load: { config: { wsUrl: 'ws://127.0.0.1:3001?MyToken=abc' } },
  })
  assert.equal(
    await codeOf(() => customParam.ctx.http.subscribeWebSocket!(
      { configKey: 'wsUrl', auth: { secretNames: ['ws-tok'], transport: 'query', paramName: 'mytoken' } },
      () => undefined,
    )),
    'PERMISSION_DENIED',
  )

  // Ungranted secret & URL mismatch & non-loopback ws with secret
  const wsFixture = await loadIdle({
    manifest: manifestWith({ permissions: [...audited, 'lan:config:wsUrl', 'secrets:ws-tok'] }),
    load: { config: { wsUrl: 'ws://192.168.1.50:3001' } },
  })
  assert.equal(
    await codeOf(() => wsFixture.ctx.http.subscribeWebSocket!(
      { configKey: 'wsUrl', auth: { secretNames: ['ws-tok', 'missing-tok'] } },
      () => undefined,
    )),
    'PERMISSION_DENIED',
  )
  assert.equal(
    await codeOf(() => wsFixture.ctx.http.subscribeWebSocket!({ configKey: 'wsUrl', url: 'ws://127.0.0.1:3001' }, () => undefined)),
    'PERMISSION_DENIED',
  )
  // Without a secret, ws:// to LAN host is allowed
  const unauthedDispose = await wsFixture.ctx.http.subscribeWebSocket!(
    { configKey: 'wsUrl', auth: { secretNames: ['ws-tok'] } },
    () => undefined,
  )
  unauthedDispose()
  // With a non-empty secret, ws:// to non-loopback host is denied
  wsFixture.kernel.setSecret('ws-tok', 'secret-val')
  assert.equal(
    await codeOf(() => wsFixture.ctx.http.subscribeWebSocket!(
      { configKey: 'wsUrl', auth: { secretNames: ['ws-tok'] } },
      () => undefined,
    )),
    'PERMISSION_DENIED',
  )

  // Loopback ws:// and non-loopback wss:// with secret succeed, emit open + messages, and clean up on dispose/unload
  const live = await loadIdle({
    manifest: manifestWith({ permissions: [...audited, 'lan:config:wsUrl', 'network:config:wssUrl', 'secrets:ws-tok'] }),
    load: { config: { wsUrl: 'ws://127.0.0.1:3001', wssUrl: 'wss://relay.example.com/ws' } },
  })
  live.kernel.setSecret('ws-tok', 'secret-val')
  const events: WebSocketEvent[] = []
  const dispose = await live.ctx.http.subscribeWebSocket!(
    { configKey: 'wsUrl', url: 'ws://127.0.0.1:3001/', auth: { secretNames: ['ws-tok'] } },
    (event) => { events.push(event) },
  )
  const disposeWss = await live.ctx.http.subscribeWebSocket!(
    { configKey: 'wssUrl', auth: { secretNames: ['ws-tok'] } },
    () => undefined,
  )
  assert.equal(typeof disposeWss, 'function')
  assert.deepEqual(live.kernel.webSockets(), [
    { configKey: 'wsUrl', url: 'ws://127.0.0.1:3001/' },
    { configKey: 'wssUrl', url: 'wss://relay.example.com/ws' },
  ])
  await live.kernel.emitWebSocket('wsUrl', { type: 'message', data: '{"ok":true}' })
  assert.deepEqual(events, [{ type: 'open' }, { type: 'message', data: '{"ok":true}' }])
  dispose()
  dispose() // idempotent
  assert.deepEqual(live.kernel.webSockets(), [{ configKey: 'wssUrl', url: 'wss://relay.example.com/ws' }])
  await live.kernel.unload()
  assert.deepEqual(live.kernel.webSockets(), [])
})

test('http.subscribeWebSocket aligns loopback IPv4-mapped IPv6 and URL hash/credentials matching with kernel', async () => {
  const audited = MANIFEST.permissions.filter((p) => !p.startsWith('secrets:') && !p.startsWith('lan:') && !p.startsWith('network:'))

  // ::ffff:127.0.0.1 and localhost. are loopback with secret; ::ffff:10.0.0.1 and 10.0.0.1 reject with PERMISSION_DENIED
  for (const okUrl of [
    'ws://[::ffff:127.0.0.1]:3001/ws',
    'ws://localhost.:3001/ws',
  ]) {
    const okFixture = await loadIdle({
      manifest: manifestWith({ permissions: [...audited, 'lan:config:wsUrl', 'secrets:ws-tok'] }),
      load: { config: { wsUrl: okUrl } },
    })
    okFixture.kernel.setSecret('ws-tok', 'secret-val')
    const dispose = await okFixture.ctx.http.subscribeWebSocket!(
      { configKey: 'wsUrl', auth: { secretNames: ['ws-tok'] } },
      () => undefined,
    )
    dispose()
  }

  for (const badLoopbackUrl of [
    'ws://[::ffff:10.0.0.1]:3001/ws',
    'ws://10.0.0.1:3001/ws',
  ]) {
    const badFixture = await loadIdle({
      manifest: manifestWith({ permissions: [...audited, 'lan:config:wsUrl', 'secrets:ws-tok'] }),
      load: { config: { wsUrl: badLoopbackUrl } },
    })
    badFixture.kernel.setSecret('ws-tok', 'secret-val')
    await assert.rejects(
      () => badFixture.ctx.http.subscribeWebSocket!(
        { configKey: 'wsUrl', auth: { secretNames: ['ws-tok'] } },
        () => undefined,
      ),
      (err: unknown) => err instanceof BrainError && err.code === 'PERMISSION_DENIED',
    )
  }

  // options.url ignores #frag when matching configured URL, but rejects mismatched path/port/host/credentials
  const urlMatchFixture = await loadIdle({
    manifest: manifestWith({ permissions: [...audited, 'lan:config:wsUrl'] }),
    load: { config: { wsUrl: 'ws://127.0.0.1:3001/ws?v=1' } },
  })
  const disposeFrag = await urlMatchFixture.ctx.http.subscribeWebSocket!(
    { configKey: 'wsUrl', url: 'ws://127.0.0.1:3001/ws?v=1#frag' },
    () => undefined,
  )
  disposeFrag()

  for (const mismatchUrl of [
    'ws://127.0.0.1:3001/other?v=1',
    'ws://127.0.0.1:3002/ws?v=1',
    'ws://localhost:3001/ws?v=1',
    'ws://u:p@127.0.0.1:3001/ws?v=1',
  ]) {
    assert.equal(
      await codeOf(() => urlMatchFixture.ctx.http.subscribeWebSocket!(
        { configKey: 'wsUrl', url: mismatchUrl },
        () => undefined,
      )),
      'PERMISSION_DENIED',
    )
  }
})

test('agent.wake preserves WakeMessage.hasMedia for fake agent scripts without leaking raw text', async () => {
  const { kernel, ctx } = await loadIdle()
  let seenHasMedia: boolean | undefined
  kernel.useAgent((wake) => {
    seenHasMedia = wake.input.messages?.[0]?.hasMedia
  })
  await ctx.agent.wake(OWN, {
    reason: 'message',
    messages: [
      { id: 'l0_1', actor: 'p1', name: 'Alice', text: '[图片] secret', tEvent: 100, hasMedia: true },
    ],
  })
  assert.equal(seenHasMedia, true)
  const wakeCall = kernel.calls.find((call) => call.method === 'agent.wake')
  const serialized = JSON.stringify(wakeCall)
  assert.equal(serialized.includes('secret'), false)
  assert.equal(serialized.includes('"hasMedia":true'), true)
})
