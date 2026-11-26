// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import {
  BrainError,
  PLUGIN_API_VERSION,
  type BrainContext,
  type ChannelProvider,
  type MemoryProvider,
  type MemoryRecord,
} from '@brain-core/sdk'
import { HOST_UNSUPPORTED_MESSAGE } from '../src/apply.ts'
import { OneBotHealth, OneBotWsClient } from '../src/onebot/index.ts'
import {
  MAX_LINE_BYTES,
  MethodNotFound,
  runStdioPlugin,
  StdioRpcConnection,
} from '../src/rpc/stdio-bridge.ts'

interface RpcMessage {
  readonly jsonrpc?: string
  readonly id?: number | string
  readonly method?: string
  readonly params?: Record<string, unknown>
  readonly result?: unknown
  readonly error?: {
    readonly code: number
    readonly message: string
    readonly data?: { readonly code?: string; readonly details?: Record<string, unknown> }
  }
}

class MockKernelPeer {
  readonly toPlugin = new PassThrough()
  readonly fromPlugin = new PassThrough()
  readonly received: RpcMessage[] = []
  readonly #waiters: ((msg: RpcMessage) => boolean)[] = []
  readonly #handlers = new Map<string, (params: Record<string, unknown>, id: number | string) => unknown | Promise<unknown>>()
  readonly #pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  #nextId = 1
  #buffer = ''

  constructor() {
    this.fromPlugin.setEncoding('utf8')
    this.fromPlugin.on('data', (chunk: string) => {
      this.#buffer += chunk
      for (;;) {
        const idx = this.#buffer.indexOf('\n')
        if (idx === -1) return
        const line = this.#buffer.slice(0, idx)
        this.#buffer = this.#buffer.slice(idx + 1)
        if (line.trim() === '') continue
        const msg = JSON.parse(line) as RpcMessage
        this.#onMessage(msg)
      }
    })
  }

  onRequest(
    method: string,
    handler: (params: Record<string, unknown>, id: number | string) => unknown | Promise<unknown>,
  ): void {
    this.#handlers.set(method, handler)
  }

  #onMessage(msg: RpcMessage): void {
    this.received.push(msg)

    for (let i = this.#waiters.length - 1; i >= 0; i--) {
      if (this.#waiters[i]!(msg)) {
        this.#waiters.splice(i, 1)
      }
    }

    if (typeof msg.method === 'string' && msg.id !== undefined) {
      const handler = this.#handlers.get(msg.method)
      const params = (msg.params ?? {}) as Record<string, unknown>
      if (handler === undefined) {
        this.writeLine({ jsonrpc: '2.0', id: msg.id, result: null })
        return
      }
      Promise.resolve()
        .then(() => handler(params, msg.id!))
        .then(
          (result) => {
            this.writeLine({ jsonrpc: '2.0', id: msg.id, result: result === undefined ? null : result })
          },
          (error: unknown) => {
            if (error instanceof MethodNotFound) {
              this.writeLine({
                jsonrpc: '2.0',
                id: msg.id,
                error: { code: -32601, message: 'Method not found' },
              })
              return
            }
            if (error instanceof BrainError) {
              this.writeLine({
                jsonrpc: '2.0',
                id: msg.id,
                error: {
                  code: -32000,
                  message: error.message,
                  data: { code: error.code, details: error.details },
                },
              })
              return
            }
            this.writeLine({
              jsonrpc: '2.0',
              id: msg.id,
              error: { code: -32000, message: 'internal error', data: { code: 'INTERNAL', details: {} } },
            })
          },
        )
      return
    }

    if (msg.method === undefined && msg.id !== undefined) {
      const pending = this.#pending.get(msg.id)
      if (pending === undefined) return
      this.#pending.delete(msg.id)
      if (msg.error !== undefined) {
        if (msg.error.data?.code) {
          pending.reject(new BrainError(msg.error.data.code as never, msg.error.message, msg.error.data.details ?? {}))
        } else {
          pending.reject(new Error(msg.error.message))
        }
      } else {
        pending.resolve(msg.result)
      }
    }
  }

  writeLine(payload: unknown): void {
    this.toPlugin.write(`${JSON.stringify(payload)}\n`)
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.#nextId++
    this.writeLine(params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params })
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
    })
  }

  requestRaw(method: string, params?: unknown): Promise<RpcMessage> {
    const id = this.#nextId++
    const promise = this.waitFor((msg) => msg.method === undefined && msg.id === id)
    this.writeLine(params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params })
    return promise
  }

  notify(method: string, params?: unknown): void {
    this.writeLine(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params })
  }

  waitFor(predicate: (msg: RpcMessage) => boolean): Promise<RpcMessage> {
    const existing = this.received.find(predicate)
    if (existing !== undefined) return Promise.resolve(existing)
    return new Promise((resolve) => {
      this.#waiters.push((msg) => {
        if (!predicate(msg)) return false
        resolve(msg)
        return true
      })
    })
  }

  async initialize(overrides: Partial<{ apiVersion: string; pluginId: string; version: string; config: Record<string, unknown> }> = {}): Promise<unknown> {
    return this.request('initialize', {
      apiVersion: overrides.apiVersion ?? PLUGIN_API_VERSION,
      pluginId: overrides.pluginId ?? 'qq',
      version: overrides.version ?? '0.1.0',
      config: overrides.config ?? { mode: 'test' },
      permissions: [],
    })
  }

  close(): void {
    this.toPlugin.end()
    this.fromPlugin.end()
  }
}

test('initialize rejects incompatible major apiVersion and accepts compatible 1.x', async () => {
  const peerBad = new MockKernelPeer()
  let applyCalled = false
  const badRun = runStdioPlugin({
    input: peerBad.toPlugin,
    output: peerBad.fromPlugin,
    apply: () => {
      applyCalled = true
    },
  })

  const badResp = await peerBad.requestRaw('initialize', {
    apiVersion: '2.0.0',
    pluginId: 'qq',
    version: '0.1.0',
    config: {},
  })
  assert.equal(badResp.error?.code, -32000)
  assert.equal(badResp.error?.data?.code, 'INVALID_ARGUMENT')
  assert.equal(applyCalled, false)
  peerBad.close()
  await badRun

  const peerGood = new MockKernelPeer()
  let seenContext: BrainContext | undefined
  let seenConfig: Readonly<Record<string, unknown>> | undefined
  const goodRun = runStdioPlugin({
    input: peerGood.toPlugin,
    output: peerGood.fromPlugin,
    apply: (ctx, config) => {
      seenContext = ctx
      seenConfig = config
    },
  })

  const initResult = await peerGood.initialize({ apiVersion: '1.4.0', pluginId: 'qq', version: '0.2.0', config: { port: 3000 } })
  assert.deepEqual(initResult, { apiVersion: PLUGIN_API_VERSION })
  await peerGood.waitFor((m) => m.method === 'plugin.ready')
  assert.deepEqual(seenContext?.plugin, { id: 'qq', version: '0.2.0' })
  assert.deepEqual(seenConfig, { port: 3000 })
  assert.deepEqual(seenContext?.config, { port: 3000 })

  peerGood.notify('shutdown')
  await goodRun
  peerGood.close()
})

test('registrations complete before plugin.ready and startBackground runs strictly after plugin.ready', async () => {
  const peer = new MockKernelPeer()
  const timeline: string[] = []
  let resolveTool!: () => void
  let resolveChannel!: () => void
  let resolveRoute!: () => void
  let resolvePage!: () => void

  peer.onRequest('tools.register', () => new Promise<null>((r) => {
    resolveTool = () => {
      timeline.push('rpc:tools.register')
      r(null)
    }
  }))
  peer.onRequest('channel.provide', () => new Promise<null>((r) => {
    resolveChannel = () => {
      timeline.push('rpc:channel.provide')
      r(null)
    }
  }))
  peer.onRequest('http.route', () => new Promise<null>((r) => {
    resolveRoute = () => {
      timeline.push('rpc:http.route')
      r(null)
    }
  }))
  peer.onRequest('console.page', () => new Promise<null>((r) => {
    resolvePage = () => {
      timeline.push('rpc:console.page')
      r(null)
    }
  }))

  let readyWritten = false
  let readySeen = false
  const origWrite = peer.fromPlugin.write.bind(peer.fromPlugin)
  peer.fromPlugin.write = ((chunk: unknown, ...rest: unknown[]) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : ''
    if (text.includes('"plugin.ready"')) {
      readyWritten = true
      timeline.push('write:plugin.ready')
    }
    return origWrite(chunk as never, ...(rest as []))
  }) as typeof peer.fromPlugin.write

  const readyPromise = peer.waitFor((m) => m.method === 'plugin.ready').then(() => {
    readySeen = true
    timeline.push('notify:plugin.ready')
  })

  const runPromise = runStdioPlugin({
    input: peer.toPlugin,
    output: peer.fromPlugin,
    apply: (ctx) => {
      timeline.push('apply:start')
      ctx.tools.register({
        name: 'ping',
        description: 'ping tool',
        parameters: { type: 'object', properties: {} },
        handler: async () => 'pong',
      })
      ctx.channel.provide({
        send: async () => ({ messageId: 'm1' }),
        members: async () => ['u1'],
        resolveIdentity: async () => ({ displayName: 'Alice' }),
      })
      ctx.http.route('GET', '/health', async () => ({ ok: true }))
      ctx.console.page({ id: 'status', title: 'Status', entry: './status.js' })
      timeline.push('apply:end')
      return {
        startBackground: () => {
          assert.equal(readyWritten, true)
          timeline.push('startBackground')
        },
      }
    },
  })

  await peer.initialize()
  await peer.waitFor((m) => m.method === 'console.page')
  // Wait one tick to verify plugin.ready has not fired prematurely.
  await new Promise((r) => setTimeout(r, 15))
  assert.equal(readySeen, false)
  assert.equal(readyWritten, false)

  resolveTool()
  resolveChannel()
  resolveRoute()
  await new Promise((r) => setTimeout(r, 15))
  assert.equal(readySeen, false)
  assert.equal(readyWritten, false)

  resolvePage()
  await readyPromise
  await new Promise((r) => setTimeout(r, 10))

  assert.equal(readySeen, true)
  assert.equal(timeline.indexOf('write:plugin.ready') > timeline.indexOf('rpc:console.page'), true)
  assert.equal(timeline.indexOf('startBackground') > timeline.indexOf('write:plugin.ready'), true)

  peer.notify('shutdown')
  await runPromise
  peer.close()
})

test('http.fetch encodes string/Uint8Array body as base64, forwards redirect, and decodes response', async () => {
  const peer = new MockKernelPeer()
  const fetchCalls: Record<string, unknown>[] = []
  peer.onRequest('http.fetch', (params) => {
    fetchCalls.push(params)
    return {
      status: 201,
      headers: { 'content-type': 'text/plain' },
      base64: Buffer.from('hello-世界', 'utf8').toString('base64'),
    }
  })

  let capturedCtx!: BrainContext
  const runPromise = runStdioPlugin({
    input: peer.toPlugin,
    output: peer.fromPlugin,
    apply: (ctx) => {
      capturedCtx = ctx
    },
  })

  await peer.initialize()
  await peer.waitFor((m) => m.method === 'plugin.ready')

  const res1 = await capturedCtx.http.fetch('https://example.com/a', {
    method: 'POST',
    headers: { 'x-test': '1' },
    body: 'abc-payload',
    redirect: 'error',
    timeoutMs: 2000,
    maxBytes: 4096,
  })
  assert.equal(res1.status, 201)
  assert.deepEqual(res1.headers, { 'content-type': 'text/plain' })
  assert.equal(res1.text(), 'hello-世界')
  assert.deepEqual(res1.bytes(), new Uint8Array(Buffer.from('hello-世界', 'utf8')))

  const rawView = new Uint8Array([0, 1, 2, 3, 4]).subarray(1, 4)
  await capturedCtx.http.fetch('https://example.com/b', {
    method: 'PUT',
    body: rawView,
    redirect: 'follow',
  })

  assert.deepEqual(fetchCalls[0], {
    url: 'https://example.com/a',
    options: {
      method: 'POST',
      headers: { 'x-test': '1' },
      body: Buffer.from('abc-payload', 'utf8').toString('base64'),
      redirect: 'error',
      timeoutMs: 2000,
      maxBytes: 4096,
    },
  })
  assert.deepEqual(fetchCalls[1], {
    url: 'https://example.com/b',
    options: {
      method: 'PUT',
      body: Buffer.from([1, 2, 3]).toString('base64'),
      redirect: 'follow',
    },
  })

  peer.notify('shutdown')
  await runPromise
  peer.close()
})

test('http.subscribeWebSocket handles early open event before RPC ack, message, close auto-cleanup, and dispose', async () => {
  const peer = new MockKernelPeer()
  let earlyOpenAcked = false
  let subIdFromKernel = ''

  peer.onRequest('http.subscribeWebSocket', async (params) => {
    subIdFromKernel = String(params.subscriptionId)
    // Kernel sends `open` event BEFORE resolving `http.subscribeWebSocket`.
    await peer.request('http.wsEvent', {
      subscriptionId: subIdFromKernel,
      event: { type: 'open' },
    })
    earlyOpenAcked = true
    return null
  })

  const unsubscribed: string[] = []
  peer.onRequest('http.unsubscribeWebSocket', (params) => {
    unsubscribed.push(String(params.subscriptionId))
    return null
  })

  let capturedCtx!: BrainContext
  const runPromise = runStdioPlugin({
    input: peer.toPlugin,
    output: peer.fromPlugin,
    apply: (ctx) => {
      capturedCtx = ctx
    },
  })

  await peer.initialize()
  await peer.waitFor((m) => m.method === 'plugin.ready')

  const events: string[] = []
  let releaseMessage!: () => void
  const dispose1 = await capturedCtx.http.subscribeWebSocket!(
    { configKey: 'onebotWsUrl' },
    async (event) => {
      events.push(event.type)
      if (event.type === 'message') {
        await new Promise<void>((r) => {
          releaseMessage = r
        })
      }
    },
  )

  assert.equal(earlyOpenAcked, true)
  assert.deepEqual(events, ['open'])

  // Verify wsEvent waits for async listener completion before replying.
  let msgReplied = false
  const msgPromise = peer.request('http.wsEvent', {
    subscriptionId: subIdFromKernel,
    event: { type: 'message', data: '{"post_type":"message"}' },
  }).then(() => {
    msgReplied = true
  })

  await new Promise((r) => setTimeout(r, 15))
  assert.equal(msgReplied, false)
  releaseMessage()
  await msgPromise
  assert.equal(msgReplied, true)

  // Close event removes listener after delivery.
  await peer.request('http.wsEvent', {
    subscriptionId: subIdFromKernel,
    event: { type: 'close', code: 1000, reason: 'done' },
  })
  await peer.request('http.wsEvent', {
    subscriptionId: subIdFromKernel,
    event: { type: 'message', data: 'after-close' },
  })
  assert.deepEqual(events, ['open', 'message', 'close'])

  // Calling dispose sends unsubscribeWebSocket.
  dispose1()
  await peer.waitFor((m) => m.method === 'http.unsubscribeWebSocket')
  assert.deepEqual(unsubscribed, [subIdFromKernel])

  // Failed subscription removes listener and restores BrainError.
  peer.onRequest('http.subscribeWebSocket', () => {
    throw new BrainError('PERMISSION_DENIED', 'missing lan permission')
  })
  await assert.rejects(
    () => capturedCtx.http.subscribeWebSocket!({ configKey: 'blocked' }, () => undefined),
    (err: unknown) => err instanceof BrainError && err.code === 'PERMISSION_DENIED',
  )

  peer.notify('shutdown')
  await runPromise
  peer.close()
})

test('memory.readChannelEvent forwards callToken and full BrainContext proxy works', async () => {
  const peer = new MockKernelPeer()
  const calls: { method: string; params: Record<string, unknown> }[] = []

  peer.onRequest('memory.readChannelEvent', (params) => {
    calls.push({ method: 'memory.readChannelEvent', params })
    return {
      record: { id: params.recordId, layer: 'L0' },
      disclosure: { speakable: 'yes', label: 'QQ群聊' },
    }
  })
  peer.onRequest('memory.ingest', (p) => { calls.push({ method: 'memory.ingest', params: p }); return { id: 'l0_1' } })
  peer.onRequest('memory.record', (p) => { calls.push({ method: 'memory.record', params: p }); return { id: 'l1_1' } })
  peer.onRequest('memory.update', (p) => { calls.push({ method: 'memory.update', params: p }); return { id: 'l1_1', version: 2 } })
  peer.onRequest('memory.remove', (p) => { calls.push({ method: 'memory.remove', params: p }); return null })
  peer.onRequest('memory.search', (p) => { calls.push({ method: 'memory.search', params: p }); return { items: [], degraded: false } })
  peer.onRequest('memory.context', (p) => { calls.push({ method: 'memory.context', params: p }); return { profileVersion: 1, stable: '', blocks: [], truncated: false } })
  peer.onRequest('memory.forget', (p) => { calls.push({ method: 'memory.forget', params: p }); return { tombstoned: 1, invalidated: 0, l3Flagged: 0 } })
  peer.onRequest('memory.readL0', (p) => { calls.push({ method: 'memory.readL0', params: p }); return { items: [] } })
  peer.onRequest('memory.writeDerived', (p) => { calls.push({ method: 'memory.writeDerived', params: p }); return { id: 'l1_2' } })
  peer.onRequest('memory.provide', () => null)
  peer.onRequest('agent.wake', (p) => { calls.push({ method: 'agent.wake', params: p }); return { wakeId: 'w1', acked: true, profileVersion: 1, sent: 0, steps: 1 } })
  peer.onRequest('agent.rotate', (p) => { calls.push({ method: 'agent.rotate', params: p }); return null })
  peer.onRequest('channel.send', (p) => { calls.push({ method: 'channel.send', params: p }); return { messageId: 'm9' } })
  peer.onRequest('identity.resolve', () => 'person_1')
  peer.onRequest('identity.link', (p) => { calls.push({ method: 'identity.link', params: p }); return null })
  peer.onRequest('secrets.get', (p) => (p.name === 'present' ? 'secret-val' : null))
  peer.onRequest('storage.read', (p) => (p.path === 'a.bin' ? { base64: Buffer.from([9, 8]).toString('base64') } : null))
  peer.onRequest('storage.write', (p) => { calls.push({ method: 'storage.write', params: p }); return null })
  peer.onRequest('storage.remove', (p) => { calls.push({ method: 'storage.remove', params: p }); return null })
  peer.onRequest('storage.list', () => ['a.bin'])
  peer.onRequest('logger.log', (p) => { calls.push({ method: 'logger.log', params: p }); return null })
  peer.onRequest('events.emit', (p) => { calls.push({ method: 'events.emit', params: p }); return null })
  peer.onRequest('llm.complete', () => ({ text: 'ok', tokens: 3 }))

  const mpEvents: string[] = []
  const memoryProvider: MemoryProvider = {
    search: async (q) => [{ id: `hit:${q.query}`, score: 0.9 }],
    onRecord: async (rec) => { mpEvents.push(`record:${rec.id}`) },
    onForgotten: async (ids) => { mpEvents.push(`forgotten:${ids.join(',')}`) },
    health: async () => ({ status: 'ok', dimension: 128 }),
  }

  let capturedCtx!: BrainContext
  const runPromise = runStdioPlugin({
    input: peer.toPlugin,
    output: peer.fromPlugin,
    apply: (ctx) => {
      capturedCtx = ctx
      ctx.memory.provide(memoryProvider)
    },
  })

  await peer.initialize()
  await peer.waitFor((m) => m.method === 'plugin.ready')

  const l0Read = await capturedCtx.memory.readChannelEvent!('l0_abc', {
    channel: 'qq:group:1',
    wakeId: 'w_1',
    callToken: 'tok_secret_99',
  })
  assert.equal((l0Read.record as unknown as { id: string }).id, 'l0_abc')
  assert.deepEqual(calls.find((c) => c.method === 'memory.readChannelEvent')?.params, {
    recordId: 'l0_abc',
    call: { channel: 'qq:group:1', wakeId: 'w_1', callToken: 'tok_secret_99' },
  })

  await capturedCtx.memory.ingest({ kind: 'qq.message', channel: 'qq:private:1', subjects: ['p1'], actor: 'p1', content: { text: 'hi' }, tEvent: 1, idempotencyKey: 'k1' })
  await capturedCtx.memory.record({ layer: 'L1', kind: 'l1.fact', channel: 'qq:private:1', subjects: ['p1'], actor: 'p1', content: {}, evidence: [] })
  await capturedCtx.memory.update('l1_1', { confidence: 0.8 }, 1, { channel: 'qq:private:1' })
  await capturedCtx.memory.remove('l1_1', { channel: 'qq:private:1' })
  await capturedCtx.memory.search({ query: 'hi', scope: 'here' }, { channel: 'qq:private:1' })
  await capturedCtx.memory.context({ channel: 'qq:private:1' })
  await capturedCtx.memory.forget({ by: 'record', id: 'l0_1' })
  await capturedCtx.memory.readL0({ limit: 10 })
  await capturedCtx.memory.writeDerived({ channel: 'qq:private:1', subjects: ['p1'], content: {}, evidence: [] })

  const session = capturedCtx.agent.session('qq:private:1')
  assert.equal(session.channel, 'qq:private:1')
  await session.wake({ reason: 'message' })
  await session.rotate()
  await capturedCtx.agent.wake('qq:group:1', { reason: 'poke' })
  await capturedCtx.channel.send('qq:private:1', { text: 'yo' })
  assert.equal(await capturedCtx.identity.resolve('qq:100'), 'person_1')
  await capturedCtx.identity.link('qq:100', 'person_1')

  assert.equal(await capturedCtx.secrets.get('present'), 'secret-val')
  assert.equal(await capturedCtx.secrets.get('missing'), undefined)

  assert.deepEqual(await capturedCtx.storage.read('a.bin'), new Uint8Array([9, 8]))
  assert.equal(await capturedCtx.storage.read('none.bin'), undefined)
  await capturedCtx.storage.write('b.txt', 'hello')
  await capturedCtx.storage.remove('b.txt')
  assert.deepEqual(await capturedCtx.storage.list('a'), ['a.bin'])

  capturedCtx.logger.info('qq.started', { count: 2 })
  capturedCtx.events.emit('qq.ping', { ok: true })
  assert.deepEqual(await capturedCtx.llm.complete({ system: 's', user: 'u', maxOutputTokens: 16 }), { text: 'ok', tokens: 3 })

  // Inbound memoryProvider.* calls
  const hits = await peer.request('memoryProvider.search', { query: { query: 'cat', limit: 5 } })
  assert.deepEqual(hits, [{ id: 'hit:cat', score: 0.9 }])
  await peer.request('memoryProvider.onRecord', { record: { id: 'rec_9' } as unknown as MemoryRecord })
  await peer.request('memoryProvider.onForgotten', { ids: ['rec_1', 'rec_2'] })
  assert.deepEqual(await peer.request('memoryProvider.health', {}), { status: 'ok', dimension: 128 })
  assert.deepEqual(mpEvents, ['record:rec_9', 'forgotten:rec_1,rec_2'])

  await peer.waitFor((m) => m.method === 'events.emit')
  assert.equal(calls.some((c) => c.method === 'logger.log'), true)

  peer.notify('shutdown')
  await runPromise
  peer.close()
})

test('dispatches tool.invoke, channel.*, http.request, schedule.fire, event, and errors cleanly', async () => {
  const peer = new MockKernelPeer()
  const fired: string[] = []
  const eventsSeen: unknown[] = []
  let timerAtId = ''
  let timerEveryId = ''
  let routeId = ''

  peer.onRequest('scheduler.at', (p) => { timerAtId = String(p.id); return null })
  peer.onRequest('scheduler.every', (p) => { timerEveryId = String(p.id); return null })
  peer.onRequest('http.route', (p) => { routeId = String(p.routeId); return null })

  const provider: ChannelProvider = {
    send: async (channel, message) => ({ messageId: `${channel}:${message.text ?? ''}` }),
    members: async () => ['p1', 'p2'],
    resolveIdentity: async (account) => ({ displayName: `Nick(${account})` }),
  }

  let disposeEvery!: () => void
  let disposeChannel!: () => void
  const runPromise = runStdioPlugin({
    input: peer.toPlugin,
    output: peer.fromPlugin,
    apply: (ctx) => {
      ctx.tools.register({
        name: 'echo_token',
        description: 'echo',
        parameters: { type: 'object', properties: {} },
        handler: async (args, call) => JSON.stringify({ args, call }),
      })
      disposeChannel = ctx.channel.provide(provider)
      ctx.http.route('POST', '/hook', async (req) => ({ method: req.method, body: req.body }))
      ctx.scheduler.at(1000, () => { fired.push('at') })
      disposeEvery = ctx.scheduler.every(500, () => { fired.push('every') })
      ctx.events.on('message.in', (payload) => { eventsSeen.push(payload) })
      ctx.events.on('message.in', (payload) => { eventsSeen.push(payload) })
    },
  })

  await peer.initialize()
  await peer.waitFor((m) => m.method === 'plugin.ready')

  // Only one events.on RPC sent for duplicate local listeners on same event name.
  assert.equal(peer.received.filter((m) => m.method === 'events.on').length, 1)

  const toolRes = await peer.request('tool.invoke', {
    name: 'echo_token',
    args: { msg: 'hi' },
    call: { channel: 'qq:group:1', wakeId: 'w2', callToken: 'ct_1' },
  })
  assert.deepEqual(JSON.parse(String(toolRes)), {
    args: { msg: 'hi' },
    call: { channel: 'qq:group:1', wakeId: 'w2', callToken: 'ct_1' },
  })

  const missingTool = await peer.requestRaw('tool.invoke', { name: 'nope', args: {}, call: { channel: 'c', wakeId: 'w' } })
  assert.equal(missingTool.error?.data?.code, 'NOT_FOUND')

  assert.deepEqual(await peer.request('channel.send', { channel: 'qq:private:1', message: { text: 'yo' } }), { messageId: 'qq:private:1:yo' })
  assert.deepEqual(await peer.request('channel.members', { channel: 'qq:group:1' }), ['p1', 'p2'])
  assert.deepEqual(await peer.request('channel.resolveIdentity', { account: 'qq:42' }), { displayName: 'Nick(qq:42)' })

  disposeChannel()
  const unavailableResp = await peer.requestRaw('channel.send', { channel: 'qq:private:1', message: { text: 'yo' } })
  assert.equal(unavailableResp.error?.data?.code, 'UNAVAILABLE')

  const routeRes = await peer.request('http.request', {
    routeId,
    request: { method: 'POST', path: '/hook', query: {}, body: { ok: 1 } },
  })
  assert.deepEqual(routeRes, { method: 'POST', body: { ok: 1 } })

  const missingRoute = await peer.requestRaw('http.request', {
    routeId: 'route-999',
    request: { method: 'GET', path: '/', query: {}, body: null },
  })
  assert.equal(missingRoute.error?.data?.code, 'NOT_FOUND')

  await peer.request('schedule.fire', { id: timerAtId })
  await peer.request('schedule.fire', { id: timerAtId }) // once-only `at` does not fire twice
  await peer.request('schedule.fire', { id: timerEveryId })
  disposeEvery()
  await peer.request('schedule.fire', { id: timerEveryId })
  assert.deepEqual(fired, ['at', 'every'])

  peer.notify('event', { name: 'message.in', payload: { count: 1 } })
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(eventsSeen, [{ count: 1 }, { count: 1 }])

  const unknownMethod = await peer.requestRaw('unknown.method', {})
  assert.equal(unknownMethod.error?.code, -32601)

  peer.notify('shutdown')
  await runPromise
  peer.close()
})

test('BrainError bidirectional codec and non-BrainError sanitization', async () => {
  const peer = new MockKernelPeer()
  peer.onRequest('secrets.get', () => {
    throw new BrainError('RATE_LIMITED', 'too fast', { retryAfter: 10 })
  })
  peer.onRequest('identity.resolve', () => {
    const err = new Error('plain rpc error')
    throw err
  })

  let capturedCtx!: BrainContext
  const runPromise = runStdioPlugin({
    input: peer.toPlugin,
    output: peer.fromPlugin,
    apply: (ctx) => {
      capturedCtx = ctx
      ctx.tools.register({
        name: 'brain_err',
        description: 'throws BrainError',
        parameters: { type: 'object', properties: {} },
        handler: async () => {
          throw new BrainError('PERMISSION_DENIED', 'forbidden action', { scope: 'send' })
        },
      })
      ctx.tools.register({
        name: 'secret_leak_err',
        description: 'throws raw Error',
        parameters: { type: 'object', properties: {} },
        handler: async () => {
          throw new Error('token=sk-super-secret path=/home/example/.dsh/creds.json')
        },
      })
    },
  })

  await peer.initialize()
  await peer.waitFor((m) => m.method === 'plugin.ready')

  const brainErrResp = await peer.requestRaw('tool.invoke', {
    name: 'brain_err',
    args: {},
    call: { channel: 'qq:private:1', wakeId: 'w1' },
  })
  assert.deepEqual(brainErrResp.error, {
    code: -32000,
    message: 'forbidden action',
    data: { code: 'PERMISSION_DENIED', details: { scope: 'send' } },
  })

  const rawErrResp = await peer.requestRaw('tool.invoke', {
    name: 'secret_leak_err',
    args: {},
    call: { channel: 'qq:private:1', wakeId: 'w1' },
  })
  assert.deepEqual(rawErrResp.error, {
    code: -32000,
    message: 'internal error',
    data: { code: 'INTERNAL', details: {} },
  })
  assert.equal(JSON.stringify(rawErrResp).includes('sk-super-secret'), false)
  assert.equal(JSON.stringify(rawErrResp).includes('.dsh'), false)

  await assert.rejects(
    () => capturedCtx.secrets.get('a'),
    (err: unknown) =>
      err instanceof BrainError && err.code === 'RATE_LIMITED' && err.details.retryAfter === 10,
  )

  peer.notify('shutdown')
  await runPromise
  peer.close()
})

test('enforces 8 MiB inbound streaming discard and outbound PAYLOAD_TOO_LARGE', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const receivedMethods: string[] = []
  const outputLines: string[] = []
  let outBuf = ''

  output.setEncoding('utf8')
  output.on('data', (chunk: string) => {
    outBuf += chunk
    for (;;) {
      const idx = outBuf.indexOf('\n')
      if (idx === -1) return
      const line = outBuf.slice(0, idx)
      outBuf = outBuf.slice(idx + 1)
      if (line.trim() !== '') outputLines.push(line)
    }
  })

  const conn = new StdioRpcConnection(input, output, {
    request: async (method) => {
      receivedMethods.push(method)
      if (method === 'huge_response') {
        return { data: 'x'.repeat(MAX_LINE_BYTES + 100) }
      }
      return { ok: true }
    },
    notification: (method) => {
      receivedMethods.push(`notify:${method}`)
    },
  })

  // Stream an inbound line exceeding 8 MiB in two chunks without buffering it.
  const halfHuge = 'a'.repeat(5 * 1024 * 1024)
  input.write(`{"jsonrpc":"2.0","id":1,"method":"ping","params":{"blob":"${halfHuge}`)
  assert.equal(conn.bufferedBytes <= MAX_LINE_BYTES, true)
  input.write(`${halfHuge}"}}\n`)
  assert.equal(conn.bufferedBytes, 0)

  // Next valid message after the discarded oversized line works normally.
  input.write('{"jsonrpc":"2.0","id":2,"method":"after_overflow","params":{}}\n')
  await new Promise((r) => setTimeout(r, 20))

  assert.deepEqual(receivedMethods, ['after_overflow'])
  assert.equal(outputLines.length, 1)
  assert.deepEqual(JSON.parse(outputLines[0]!), { jsonrpc: '2.0', id: 2, result: { ok: true } })

  // Outbound request > 8 MiB rejects with PAYLOAD_TOO_LARGE without writing to output.
  await assert.rejects(
    () => conn.request('memory.ingest', { blob: 'z'.repeat(MAX_LINE_BYTES + 10) }),
    (err: unknown) => err instanceof BrainError && err.code === 'PAYLOAD_TOO_LARGE',
  )
  assert.equal(outputLines.length, 1)

  // Outbound response > 8 MiB returns PAYLOAD_TOO_LARGE error instead of huge line.
  input.write('{"jsonrpc":"2.0","id":3,"method":"huge_response","params":{}}\n')
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(outputLines.length, 2)
  const hugeResp = JSON.parse(outputLines[1]!) as RpcMessage
  assert.equal(hugeResp.id, 3)
  assert.equal(hugeResp.error?.data?.code, 'PAYLOAD_TOO_LARGE')

  conn.close()
  input.end()
  output.end()
})

test('startup failure calls handle.stop and rejects without plugin.ready; shutdown is idempotent', async () => {
  // Case 1: pending registration fails -> stop() called, no plugin.ready, no startBackground, rejects.
  const peerFail = new MockKernelPeer()
  peerFail.onRequest('tools.register', () => {
    throw new BrainError('PERMISSION_DENIED', 'tool not allowed')
  })

  let stopCount = 0
  let bgCalled = false
  const failRun = runStdioPlugin({
    input: peerFail.toPlugin,
    output: peerFail.fromPlugin,
    apply: (ctx) => {
      ctx.tools.register({
        name: 'bad_tool',
        description: 'bad',
        parameters: { type: 'object', properties: {} },
        handler: async () => 'x',
      })
      return {
        startBackground: () => { bgCalled = true },
        stop: () => { stopCount += 1 },
      }
    },
  })

  await peerFail.initialize()
  await assert.rejects(
    () => failRun,
    (err: unknown) => err instanceof BrainError && err.code === 'PERMISSION_DENIED',
  )
  assert.equal(stopCount, 1)
  assert.equal(bgCalled, false)
  assert.equal(peerFail.received.some((m) => m.method === 'plugin.ready'), false)
  peerFail.close()

  // Case 2: shutdown notification followed by input end runs stop() at most once and resolves.
  const peerShutdown = new MockKernelPeer()
  let cleanStops = 0
  const cleanRun = runStdioPlugin({
    input: peerShutdown.toPlugin,
    output: peerShutdown.fromPlugin,
    apply: () => ({
      stop: async () => {
        cleanStops += 1
        await new Promise((r) => setTimeout(r, 5))
      },
    }),
  })

  await peerShutdown.initialize()
  await peerShutdown.waitFor((m) => m.method === 'plugin.ready')

  peerShutdown.notify('shutdown')
  peerShutdown.toPlugin.end()
  await cleanRun
  assert.equal(cleanStops, 1)
  peerShutdown.close()
})

test('BR-01: streaming >8 MiB overflow without newline clears buffer during chunk 2 and processes subsequent message', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const receivedMethods: string[] = []
  const outputLines: string[] = []
  let outBuf = ''

  output.setEncoding('utf8')
  output.on('data', (chunk: string) => {
    outBuf += chunk
    for (;;) {
      const idx = outBuf.indexOf('\n')
      if (idx === -1) return
      const line = outBuf.slice(0, idx)
      outBuf = outBuf.slice(idx + 1)
      if (line.trim() !== '') outputLines.push(line)
    }
  })

  const conn = new StdioRpcConnection(input, output, {
    request: async (method) => {
      receivedMethods.push(method)
      return { ok: true }
    },
    notification: () => {},
  })

  const chunk5M = 'a'.repeat(5 * 1024 * 1024)
  const chunk4M = 'b'.repeat(4 * 1024 * 1024)
  const chunk1M = 'c'.repeat(1 * 1024 * 1024)

  // Chunk 1: 5 MiB without newline -> buffered below 8 MiB limit.
  input.write(`{"jsonrpc":"2.0","id":1,"method":"giant","params":{"blob":"${chunk5M}`)
  assert.ok(conn.bufferedBytes > 5 * 1024 * 1024 && conn.bufferedBytes <= MAX_LINE_BYTES)

  // Chunk 2: +4 MiB without newline -> exceeds 8 MiB, #overflow triggers and drops buffer immediately.
  input.write(chunk4M)
  assert.equal(conn.bufferedBytes, 0)

  // Chunk 3: +1 MiB without newline -> remains discarded in #overflow state.
  input.write(chunk1M)
  assert.equal(conn.bufferedBytes, 0)

  // Chunk 4: remaining tail + newline + valid JSON-RPC message on the next line.
  input.write(`${chunk1M}"}}\n{"jsonrpc":"2.0","id":2,"method":"after_streaming_overflow","params":{}}\n`)
  assert.equal(conn.bufferedBytes, 0)

  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(receivedMethods, ['after_streaming_overflow'])
  assert.equal(outputLines.length, 1)
  assert.deepEqual(JSON.parse(outputLines[0]!), { jsonrpc: '2.0', id: 2, result: { ok: true } })

  conn.close()
  input.end()
  output.end()
})

test('stdio proxy maps -32601 on subscribeWebSocket and readChannelEvent to INVALID_ARGUMENT upgrade error and stops WS reconnect loop', async () => {
  const peer = new MockKernelPeer()
  let wsAttempts = 0
  peer.onRequest('http.subscribeWebSocket', () => {
    wsAttempts++
    throw new MethodNotFound()
  })
  peer.onRequest('memory.readChannelEvent', () => {
    throw new MethodNotFound()
  })

  let capturedCtx!: BrainContext
  const runPromise = runStdioPlugin({
    input: peer.toPlugin,
    output: peer.fromPlugin,
    apply: (ctx) => {
      capturedCtx = ctx
    },
  })

  await peer.initialize()
  await peer.waitFor((m) => m.method === 'plugin.ready')

  await assert.rejects(
    () => capturedCtx.http.subscribeWebSocket!({ configKey: 'onebotWsUrl' }, () => undefined),
    (err: unknown) =>
      err instanceof BrainError
      && err.code === 'INVALID_ARGUMENT'
      && err.message === HOST_UNSUPPORTED_MESSAGE,
  )

  await assert.rejects(
    () => capturedCtx.memory.readChannelEvent!('rec_1', { channel: 'qq:private:1', wakeId: 'w_1', callToken: 'tok' }),
    (err: unknown) =>
      err instanceof BrainError
      && err.code === 'INVALID_ARGUMENT'
      && err.message === HOST_UNSUPPORTED_MESSAGE,
  )

  let unsupportedMsg = ''
  let timersScheduled = 0
  const wsClient = new OneBotWsClient({
    http: capturedCtx.http,
    health: new OneBotHealth(),
    onEvent: () => {},
    probe: async () => {},
    login: async () => {},
    onUnsupportedHost: (msg) => {
      unsupportedMsg = msg
    },
    setTimeout: (() => {
      timersScheduled++
      return 1
    }) as unknown as typeof setTimeout,
    clearTimeout: (() => {}) as typeof clearTimeout,
  })
  wsClient.start()
  await new Promise((r) => setTimeout(r, 25))
  assert.equal(wsAttempts, 2)
  assert.equal(timersScheduled, 0)
  assert.equal(unsupportedMsg, HOST_UNSUPPORTED_MESSAGE)
  await wsClient.stop()

  peer.notify('shutdown')
  await runPromise
  peer.close()
})
