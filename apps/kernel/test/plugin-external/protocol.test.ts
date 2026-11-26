import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test, { afterEach } from 'node:test'
import { BrainError } from '@brain-core/sdk'
import { LineConnection } from '../../src/plugin-external/protocol.ts'
import { harness, readEntries, rejectsWithCode, waitUntil, type Harness, type HarnessOptions } from './helpers.ts'

const base64 = (text: string): string => Buffer.from(text).toString('base64')

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

function response(entries: Record<string, unknown>[], key: string): Record<string, unknown> {
  const found = entries.find((entry) => entry.event === 'response' && entry.key === key)
  assert.ok(found !== undefined, `no response for ${key}: ${JSON.stringify(entries)}`)
  return found
}

test('every plugin-to-kernel method is forwarded to ctx with the same arguments', async () => {
  const write = base64('hello')
  const body = base64('request body')
  const h = await setup({
    script: {
      calls: [
        { method: 'memory.ingest', params: { event: { kind: 'echo.message', channel: 'echo:private:1', subjects: [], actor: 'a', content: { text: 'x' }, tEvent: 1, idempotencyKey: 'k' } } },
        { method: 'memory.record', params: { input: { channel: 'echo:private:1' } } },
        { method: 'memory.update', params: { id: 'r1', patch: { importance: 0.5 }, expectedVersion: 1, view: { channel: 'echo:private:1' } } },
        { method: 'memory.remove', params: { id: 'r1', view: { channel: 'echo:private:1' } } },
        { method: 'memory.search', params: { request: { query: 'x', scope: 'here' }, view: { channel: 'echo:private:1' } } },
        { method: 'memory.context', params: { request: { channel: 'echo:private:1' } } },
        { method: 'memory.forget', params: { selector: { by: 'channel', channel: 'echo:private:1' } } },
        { method: 'agent.wake', params: { channel: 'echo:private:1', input: { reason: 'm' } } },
        { method: 'agent.rotate', params: { channel: 'echo:private:1' } },
        { method: 'tools.register', params: { name: 'echo', description: 'd', parameters: { type: 'object' } } },
        { method: 'channel.provide', params: {} },
        { method: 'channel.send', params: { channel: 'echo:private:1', message: { text: 'hi' } } },
        { method: 'identity.resolve', params: { account: 'echo:1' }, key: 'resolve' },
        { method: 'identity.link', params: { account: 'echo:1', personId: 'p1' } },
        { method: 'scheduler.every', params: { id: 'e1', ms: 1000 } },
        { method: 'scheduler.at', params: { id: 'a1', timeMs: 123 } },
        { method: 'scheduler.ownTime', params: { id: 'o1', name: 'n', everyMs: 1000 } },
        { method: 'events.on', params: { name: 'message.in' } },
        { method: 'events.emit', params: { name: 'echo.x', payload: { a: 1 } } },
        { method: 'http.route', params: { routeId: 'rt', method: 'GET', path: '/x' } },
        { method: 'http.fetch', params: { url: 'https://example.com', options: { method: 'POST', headers: { a: 'b' }, body } }, key: 'fetch' },
        { method: 'console.page', params: { id: 'p', title: 't', entry: 'index.html' } },
        { method: 'secrets.get', params: { name: 'token' }, key: 'secret' },
        { method: 'secrets.get', params: { name: 'missing' }, key: 'secretMissing' },
        { method: 'storage.write', params: { path: 'a/new.txt', base64: write } },
        { method: 'storage.read', params: { path: 'a/b.txt' }, key: 'read' },
        { method: 'storage.read', params: { path: 'a/missing.txt' }, key: 'readMissing' },
        { method: 'storage.remove', params: { path: 'a/old.txt' } },
        { method: 'storage.list', params: { prefix: 'a/' }, key: 'list' },
        { method: 'logger.log', params: { level: 'warn', event: 'x', fields: { n: 1 } } },
        { method: 'llm.complete', params: { request: { system: 's', user: 'u', maxOutputTokens: 10 } }, key: 'llm' },
      ],
    },
    fake: { secrets: { token: 'tok' } },
  })
  h.ctx.state.storage.set('a/b.txt', new TextEncoder().encode('stored'))
  await h.apply(h.ctx.ctx, {})
  await h.waitFor((entries) => entries.some((entry) => entry.event === 'response' && entry.key === 'llm'))

  const state = h.ctx.state
  assert.deepEqual(state.calls.memoryIngest, [[{ kind: 'echo.message', channel: 'echo:private:1', subjects: [], actor: 'a', content: { text: 'x' }, tEvent: 1, idempotencyKey: 'k' }]])
  assert.deepEqual(state.calls.memoryRecord, [[{ channel: 'echo:private:1' }]])
  assert.deepEqual(state.calls.memoryUpdate, [['r1', { importance: 0.5 }, 1, { channel: 'echo:private:1' }]])
  assert.deepEqual(state.calls.memoryRemove, [['r1', { channel: 'echo:private:1' }]])
  assert.deepEqual(state.calls.memorySearch, [[{ query: 'x', scope: 'here' }, { channel: 'echo:private:1' }]])
  assert.deepEqual(state.calls.memoryContext, [[{ channel: 'echo:private:1' }]])
  assert.deepEqual(state.calls.memoryForget, [[{ by: 'channel', channel: 'echo:private:1' }]])
  assert.deepEqual(state.calls.agentWake, [['echo:private:1', { reason: 'm' }]])
  assert.deepEqual(state.calls.agentRotate, [['echo:private:1']])
  assert.ok(state.tools.has('echo'))
  assert.equal(state.providers.length, 1)
  assert.deepEqual(state.calls.identityResolve, [['echo:1']])
  assert.deepEqual(state.calls.identityLink, [['echo:1', 'p1']])
  assert.deepEqual(state.every.map((entry) => entry.ms), [1000])
  assert.deepEqual(state.at.map((entry) => entry.timeMs), [123])
  assert.equal(state.ownTime[0]?.request.name, 'n')
  assert.equal(state.ownTime[0]?.request.everyMs, 1000)
  assert.ok(state.events.has('message.in'))
  assert.deepEqual(state.calls.emits, [{ name: 'echo.x', payload: { a: 1 } }])
  assert.ok(state.routes.has('GET /x'))
  assert.ok(state.pages.has('p'))
  assert.deepEqual(state.calls.secretsGet, [['token'], ['missing']])
  assert.deepEqual(state.calls.llmComplete, [[{ system: 's', user: 'u', maxOutputTokens: 10 }]])
  assert.deepEqual(state.calls.logger, [{ level: 'warn', event: 'x', fields: { n: 1 } }])
  assert.deepEqual(state.calls.httpFetch, [['https://example.com', { method: 'POST', headers: { a: 'b' }, body: new TextEncoder().encode('request body') }]])
  assert.equal(state.storage.get('a/new.txt') !== undefined, true)
  assert.equal(state.storage.has('a/old.txt'), false)

  const entries = h.entries()
  assert.equal(response(entries, 'resolve').result, 'p1')
  assert.deepEqual(response(entries, 'secret').result, 'tok')
  assert.equal(response(entries, 'secretMissing').result, null)
  assert.equal(response(entries, 'readMissing').result, null)
  const initialize = entries.find((entry) => entry.event === 'request' && entry.method === 'initialize')
  assert.deepEqual(initialize?.params, {
    apiVersion: '1.0.0', pluginId: 'echo', version: '1.0.0', config: {},
    permissions: ['memory.ingest', 'memory.search', 'tools.register', 'channel.provide', 'channel.send', 'identity.link', 'schedule.ownTime'],
  })
  assert.deepEqual(response(entries, 'read').result, { base64: base64('stored') })
  assert.deepEqual(response(entries, 'list').result, ['a/b.txt', 'a/new.txt'])
  assert.deepEqual(response(entries, 'fetch').result, { status: 200, headers: { 'content-type': 'text/plain' }, base64: base64('fetched') })
  assert.deepEqual(response(entries, 'llm').result, { text: 'ok', tokens: 1 })
  await h.stop()
})

test('BrainError becomes -32000 with data.code; other errors hide their text; unknown methods are -32601; missing params are INVALID_ARGUMENT', async () => {
  const h = await setup({
    script: {
      calls: [
        { method: 'memory.ingest', params: { event: {} }, key: 'denied' },
        { method: 'memory.record', params: { input: {} }, key: 'internal' },
        { method: 'no.such.method', params: {}, key: 'unknown' },
        { method: 'memory.search', params: {}, key: 'missing' },
      ],
    },
  })
  h.ctx.state.failures.set('memory.ingest', new (await import('@brain-core/sdk')).BrainError('PERMISSION_DENIED', 'no memory.ingest'))
  h.ctx.state.failures.set('memory.record', new Error('chat text must not leak'))
  await h.apply(h.ctx.ctx, {})
  await h.waitFor((entries) => ['denied', 'internal', 'unknown', 'missing'].every((key) => entries.some((entry) => entry.event === 'response' && entry.key === key)))
  const entries = h.entries()

  const denied = response(entries, 'denied').error as Record<string, unknown>
  assert.equal(denied.code, -32000)
  assert.equal((denied.data as Record<string, unknown>).code, 'PERMISSION_DENIED')

  const internal = response(entries, 'internal').error as Record<string, unknown>
  assert.equal(internal.code, -32000)
  assert.equal((internal.data as Record<string, unknown>).code, 'INTERNAL')
  assert.equal(String(internal.message).includes('chat text'), false)

  assert.equal((response(entries, 'unknown').error as Record<string, unknown>).code, -32601)

  const missing = response(entries, 'missing').error as Record<string, unknown>
  assert.equal((missing.data as Record<string, unknown>).code, 'INVALID_ARGUMENT')
  await h.stop()
})

test('tool.invoke, channel.*, schedule.fire, http.request and event reach the plugin', async () => {
  const h = await setup({
    script: {
      calls: [
        { method: 'tools.register', params: { name: 'echo', description: 'd', parameters: { type: 'object' } } },
        { method: 'channel.provide', params: {} },
        { method: 'scheduler.every', params: { id: 'e1', ms: 1000 } },
        { method: 'http.route', params: { routeId: 'rt', method: 'GET', path: '/x' } },
        { method: 'events.on', params: { name: 'message.in' } },
      ],
      toolResults: { echo: { text: 'tool says hi' } },
      respond: {
        'channel.send': { messageId: 'm9' },
        'channel.members': ['p1', 'p2'],
        'channel.resolveIdentity': { displayName: 'Ann' },
        'schedule.fire': { fired: true },
        'http.request': { data: 42 },
      },
    },
  })
  await h.apply(h.ctx.ctx, {})
  const state = h.ctx.state

  const tool = state.tools.get('echo')
  assert.ok(tool !== undefined)
  assert.deepEqual(await tool.handler({ text: 'x' }, { channel: 'echo:private:1', wakeId: 'w' }), { text: 'tool says hi' })

  const provider = state.providers[0]
  assert.ok(provider !== undefined)
  assert.deepEqual(await provider.send('echo:private:1', { text: 'hi' }), { messageId: 'm9' })
  assert.deepEqual(await provider.members('echo:private:1'), ['p1', 'p2'])
  assert.deepEqual(await provider.resolveIdentity('echo:1'), { displayName: 'Ann' })

  assert.ok(state.every[0] !== undefined)
  await state.every[0].run()

  const route = state.routes.get('GET /x')
  assert.ok(route !== undefined)
  assert.deepEqual(await route({ method: 'GET', path: '/x', query: {}, body: null }), { data: 42 })

  const handler = [...(state.events.get('message.in') ?? [])][0]
  assert.ok(handler !== undefined)
  await handler({ channel: 'echo:private:1', count: 1, recordIds: ['r1'] })

  await h.waitFor((entries) => entries.some((entry) => entry.event === 'notification' && entry.method === 'event'))
  const entries = h.entries()
  const request = (method: string): Record<string, unknown> | undefined =>
    entries.find((entry) => entry.event === 'request' && entry.method === method)
  assert.deepEqual(request('tool.invoke')?.params, { name: 'echo', args: { text: 'x' }, call: { channel: 'echo:private:1', wakeId: 'w' } })
  assert.deepEqual(request('channel.send')?.params, { channel: 'echo:private:1', message: { text: 'hi' } })
  assert.deepEqual(request('channel.members')?.params, { channel: 'echo:private:1' })
  assert.deepEqual(request('channel.resolveIdentity')?.params, { account: 'echo:1' })
  assert.deepEqual(request('schedule.fire')?.params, { id: 'e1' })
  assert.deepEqual(request('http.request')?.params, { routeId: 'rt', request: { method: 'GET', path: '/x', query: {}, body: null } })
  assert.deepEqual(entries.find((entry) => entry.event === 'notification' && entry.method === 'event')?.params,
    { name: 'message.in', payload: { channel: 'echo:private:1', count: 1, recordIds: ['r1'] } })
  await h.stop()
})

test('the child sees only PATH, LANG, LC_ALL, TZ and the plugin home and tmp; stderr goes to a 600 file', async () => {
  const h = await setup({
    captureEnv: true,
    script: { stderr: 'oops from the child\n', calls: [{ method: 'secrets.get', params: { name: 'token' }, key: 'first' }] },
    fake: { secrets: { token: 'tok' } },
  })
  await h.apply(h.ctx.ctx, {})
  await h.waitFor((entries) => entries.some((entry) => entry.event === 'response' && entry.key === 'first'))

  const env = JSON.parse(await readFile(h.envPath, 'utf8')) as Record<string, string>
  assert.equal(env.SENTINEL, undefined)
  assert.equal(env.HOME, path.join(h.dir, 'echo', 'home'))
  assert.equal(env.USERPROFILE, path.join(h.dir, 'echo', 'home'))
  assert.equal(env.TMPDIR, path.join(h.dir, 'echo', 'tmp'))
  assert.equal(env.TEMP, path.join(h.dir, 'echo', 'tmp'))
  assert.equal(env.TMP, path.join(h.dir, 'echo', 'tmp'))
  assert.equal(env.PATH, process.env.PATH)
  assert.equal(env.TZ, 'UTC')
  assert.equal(env.LANG, process.env.LANG)

  const stderrFile = path.join(h.dir, 'echo', 'stderr.log')
  assert.equal(await readFile(stderrFile, 'utf8'), 'oops from the child\n')
  if (process.platform !== 'win32') assert.equal((await stat(stderrFile)).mode & 0o777, 0o600)
  assert.equal(h.logs.some((entry) => entry.event.includes('oops')), false)
  await h.stop()
})

test('bad JSON and an overlong line do not break the connection', async () => {
  const h = await setup({
    script: {
      garbage: ['{not json', '[1,2,3]'],
      overlong: 8 * 1024 * 1024 + 1,
      calls: [{ method: 'secrets.get', params: { name: 'token' }, key: 'after' }],
    },
    fake: { secrets: { token: 'tok' } },
  })
  await h.apply(h.ctx.ctx, {})
  await h.waitFor((entries) => entries.some((entry) => entry.event === 'response' && entry.key === 'after'))
  assert.equal(response(h.entries(), 'after').result, 'tok')
  await h.stop()
})

test('initialize with another major API version fails the apply', async () => {
  const h = await setup({ script: { initializeResult: { apiVersion: '2.0.0' } } })
  await rejectsWithCode(h.apply(h.ctx.ctx, {}), 'INVALID_ARGUMENT')
  const pid = readEntries(h.logPath).find((entry) => entry.event === 'start')?.pid
  assert.equal(typeof pid, 'number')
  await h.stop()
})


test('plugin.ready that arrives before the initialize response still completes the apply', async () => {
  const h = await setup({ script: { readyEarly: true, calls: [{ method: 'secrets.get', params: { name: 'token' }, key: 'ready-early' }] }, fake: { secrets: { token: 'tok' } } })
  await h.apply(h.ctx.ctx, {})
  await h.waitFor((entries) => entries.some((entry) => entry.event === 'response' && entry.key === 'ready-early'))
})

test('the child priority is lowered to 10 and a refused setPriority is ignored', async () => {
  const original = os.setPriority
  const calls: [number, number][] = []
  os.setPriority = ((pid: number, priority: number) => {
    calls.push([pid, priority])
    throw new Error('EPERM')
  }) as unknown as typeof os.setPriority
  try {
    const h = await setup({ script: { calls: [] } })
    await h.apply(h.ctx.ctx, {})
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.[1], 10)
    assert.equal(typeof calls[0]?.[0], 'number')
  } finally {
    os.setPriority = original
  }
})

test('stderr is truncated when it passes 1 MiB', async () => {
  const h = await setup({ script: { stderr: `${'x'.repeat(1536 * 1024)}END-MARKER`, calls: [] } })
  await h.apply(h.ctx.ctx, {})
  const file = path.join(h.dir, 'echo', 'stderr.log')
  const deadline = Date.now() + 5000
  const hasMarker = async (): Promise<boolean> => {
    try { return (await readFile(file, 'utf8')).includes('END-MARKER') } catch { return false }
  }
  for (;;) {
    if (await hasMarker()) break
    if (Date.now() > deadline) throw new Error('stderr.log never received the end of the stream')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const info = await stat(file)
  assert.ok(info.size > 0)
  assert.ok(info.size <= 1024 * 1024, String(info.size))
})

test('an out-of-process plugin writes nothing into BRAIN_HOME', async () => {
  const brainHome = await mkdtemp(path.join(os.tmpdir(), 'brain-home-'))
  const saved = process.env.BRAIN_HOME
  process.env.BRAIN_HOME = brainHome
  try {
    const h = await setup({ script: { calls: [] } })
    await h.apply(h.ctx.ctx, {})
    const entries = await readdir(brainHome)
    assert.deepEqual(entries, [])
  } finally {
    if (saved === undefined) delete process.env.BRAIN_HOME
    else process.env.BRAIN_HOME = saved
  }
})

interface UnitPeer {
  readonly conn: LineConnection
  readonly output: PassThrough
  readonly requests: { method: string; params: unknown }[]
  readonly notifications: string[]
  readonly logs: string[]
}

function unitPeer(): UnitPeer {
  const input = new PassThrough()
  const output = new PassThrough()
  const requests: { method: string; params: unknown }[] = []
  const notifications: string[] = []
  const logs: string[] = []
  const conn = new LineConnection(input, output, {
    request: async (method, params) => { requests.push({ method, params }); return null },
    notification: (method) => {
      if (method === 'boom') throw new Error('the notification handler failed')
      notifications.push(method)
    },
    log: (event) => logs.push(event),
  })
  return { conn, output, requests, notifications, logs }
}

const settle = (ms = 100): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

test('an overflowing line is discarded chunk by chunk, logged once, and the next request works', async () => {
  const peer = unitPeer()
  const megabyte = 'x'.repeat(1024 * 1024)
  for (let index = 0; index < 64; index++) {
    if (!peer.output.write(megabyte)) await new Promise<void>((resolve) => peer.output.once('drain', resolve))
  }
  await waitUntil(() => peer.logs.length === 1, 5000)
  await settle()
  assert.ok(peer.conn.bufferedBytes <= 8 * 1024 * 1024, `buffered ${peer.conn.bufferedBytes} bytes of a discarded line`)
  assert.deepEqual(peer.logs, ['plugin.line_too_long'])
  assert.deepEqual(peer.requests, [])

  peer.output.write('\n')
  peer.output.write(`${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'after', params: { ok: true } })}\n`)
  await waitUntil(() => peer.requests.length === 1, 3000)
  assert.deepEqual(peer.requests[0], { method: 'after', params: { ok: true } })
  assert.deepEqual(peer.logs, ['plugin.line_too_long'])
})

test('a line of exactly MAX_LINE_BYTES is handled; one byte more is dropped and logged', async () => {
  const peer = unitPeer()
  const prefix = '{"jsonrpc":"2.0","id":1,"method":"big","params":{"pad":"'
  const suffix = '"}}'
  const atLimit = 8 * 1024 * 1024 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)
  peer.output.write(`${prefix}${'a'.repeat(atLimit)}${suffix}\n`)
  await waitUntil(() => peer.requests.length === 1, 5000)
  assert.equal(peer.requests[0]?.method, 'big')
  assert.equal(peer.logs.includes('plugin.line_too_long'), false)

  peer.output.write(`${prefix}${'b'.repeat(atLimit + 1)}${suffix}\n`)
  await waitUntil(() => peer.logs.includes('plugin.line_too_long'), 5000)
  await settle()
  assert.equal(peer.requests.length, 1)
})

test('a notification handler that throws is logged and later requests still work', async () => {
  const peer = unitPeer()
  peer.output.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'boom' })}\n`)
  peer.output.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'after-throw', params: {} })}\n`)
  await waitUntil(() => peer.requests.length === 1, 3000)
  assert.equal(peer.requests[0]?.method, 'after-throw')
  assert.deepEqual(peer.logs, ['plugin.notification_failed'])
})

test('initialize carries the config that apply was given', async () => {
  const h = await setup({ script: { calls: [] } })
  const config = { greeting: 'hello', nested: { n: 1 } }
  await h.apply(h.ctx.ctx, config)
  const initialize = h.entries().find((entry) => entry.event === 'request' && entry.method === 'initialize')
  assert.deepEqual((initialize?.params as Record<string, unknown>).config, config)
  await h.stop()
})

test('process arguments are passed literally instead of through a shell', async () => {
  const h = await setup({ script: { calls: [] }, processArgs: ['a; echo pwned', 'with space'] })
  await h.apply(h.ctx.ctx, {})
  await h.waitFor((entries) => entries.some((entry) => entry.event === 'argv'))
  const argv = h.entries().find((entry) => entry.event === 'argv')?.argv as string[]
  assert.ok(Array.isArray(argv), JSON.stringify(argv))
  assert.ok(argv.includes('a; echo pwned'), JSON.stringify(argv))
  assert.ok(argv.includes('with space'), JSON.stringify(argv))
  await h.stop()
})

test('invalid method arguments and a missing secret round-trip as INVALID_ARGUMENT and null', async () => {
  const h = await setup({
    script: {
      calls: [
        { method: 'logger.log', params: { level: 'debug', event: 'x' }, key: 'level' },
        { method: 'memory.update', params: { id: 'r1', patch: {}, expectedVersion: '1' }, key: 'version' },
        { method: 'storage.list', params: [1], key: 'params' },
        { method: 'channel.send', params: { channel: '', message: {} }, key: 'channel' },
        { method: 'secrets.get', params: { name: 'missing' }, key: 'missing' },
      ],
    },
  })
  await h.apply(h.ctx.ctx, {})
  await h.waitFor((entries) => ['level', 'version', 'params', 'channel', 'missing']
    .every((key) => entries.some((entry) => entry.event === 'response' && entry.key === key)))
  const entries = h.entries()
  for (const key of ['level', 'version', 'params', 'channel']) {
    const error = response(entries, key).error as Record<string, unknown>
    assert.equal((error.data as Record<string, unknown>).code, 'INVALID_ARGUMENT', key)
  }
  assert.equal(response(entries, 'missing').result, null)
  await h.stop()
})

test('an error response from the plugin becomes a BrainError with its data.code, or a plain Error without data', async () => {
  const h = await setup({
    script: {
      calls: [
        { method: 'tools.register', params: { name: 'known', description: 'd', parameters: { type: 'object' } } },
        { method: 'tools.register', params: { name: 'plain', description: 'd', parameters: { type: 'object' } } },
      ],
      toolResults: {
        known: { error: { code: -32000, message: 'gone', data: { code: 'NOT_FOUND', details: { what: 'record' } } } },
        plain: { error: { code: -32000, message: 'nope' } },
      },
    },
  })
  await h.apply(h.ctx.ctx, {})
  const known = h.ctx.state.tools.get('known')
  assert.ok(known !== undefined)
  const knownError = await known.handler({}, { channel: 'echo:private:1', wakeId: 'w' }).then(() => undefined, (error: unknown) => error)
  assert.ok(knownError instanceof BrainError, String(knownError))
  assert.equal(knownError.code, 'NOT_FOUND')
  assert.deepEqual(knownError.details, { what: 'record' })

  const plain = h.ctx.state.tools.get('plain')
  assert.ok(plain !== undefined)
  const plainError = await plain.handler({}, { channel: 'echo:private:1', wakeId: 'w' }).then(() => undefined, (error: unknown) => error)
  assert.ok(plainError instanceof Error, String(plainError))
  assert.equal(plainError instanceof BrainError, false)
  assert.equal(plainError.message, 'nope')
  await h.stop()
})

test('a kernel request over 8 MiB is rejected before it reaches the plugin', async () => {
  const h = await setup({
    script: { calls: [{ method: 'tools.register', params: { name: 'echo', description: 'd', parameters: { type: 'object' } } }] },
  })
  await h.apply(h.ctx.ctx, {})
  const tool = h.ctx.state.tools.get('echo')
  assert.ok(tool !== undefined)
  await rejectsWithCode(tool.handler({ text: 'x'.repeat(9 * 1024 * 1024) }, { channel: 'echo:private:1', wakeId: 'w' }), 'PAYLOAD_TOO_LARGE')
  await settle()
  assert.equal(h.entries().some((entry) => entry.event === 'request' && entry.method === 'tool.invoke'), false)
  assert.equal(await tool.handler({ text: 'small' }, { channel: 'echo:private:1', wakeId: 'w' }), null)
  await h.stop()
})

test('an existing stderr.log is forced back to mode 600', { skip: process.platform === 'win32' }, async () => {
  const h = await setup({
    script: { stderr: 'chmod check\n', calls: [{ method: 'secrets.get', params: { name: 'token' }, key: 'stderr' }] },
    fake: { secrets: { token: 'tok' } },
  })
  const dir = path.join(h.dir, 'echo')
  const file = path.join(dir, 'stderr.log')
  await mkdir(dir, { recursive: true })
  await writeFile(file, '')
  await chmod(file, 0o644)
  await h.apply(h.ctx.ctx, {})
  await h.waitFor((entries) => entries.some((entry) => entry.event === 'response' && entry.key === 'stderr'))
  const deadline = Date.now() + 3000
  let mode = 0
  for (;;) {
    try { mode = (await stat(file)).mode & 0o777 } catch { /* not created yet */ }
    if (mode === 0o600 || Date.now() > deadline) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.equal(mode, 0o600)
  assert.equal((await readFile(file, 'utf8')).includes('chmod check'), true)
  await h.stop()
})
