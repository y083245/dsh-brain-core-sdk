import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { type BrainManifest, type WebSocketEvent } from '@dsh-brain-core/sdk'
import type { GatewayTool, InstalledPlugin } from '../../src/contracts/index.ts'
import { prepareBrainHome } from '../../src/home/index.ts'
import { openMemory } from '../../src/memory-api/index.ts'
import { createExternalApply } from '../../src/plugin-external/index.ts'
import { createPluginRuntime } from '../../src/plugin-runtime/index.ts'
import { harness, isAlive, waitUntil } from './helpers.ts'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const silentLog = { info() {}, warn() {}, error() {} }

function buildServerTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  const header = len < 126
    ? Buffer.from([0x81, len])
    : Buffer.from([0x81, 126, (len >> 8) & 0xff, len & 0xff])
  return Buffer.concat([header, payload])
}

async function startTestWsServer(): Promise<{
  readonly port: number
  readonly sockets: Set<Socket>
  sendText(socket: Socket, text: string): void
  close(): Promise<void>
}> {
  const sockets = new Set<Socket>()
  const server = http.createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  server.on('upgrade', (req, socket: Socket) => {
    sockets.add(socket)
    socket.on('data', () => undefined)
    socket.on('close', () => sockets.delete(socket))
    socket.on('end', () => { if (!socket.destroyed) socket.end() })
    const key = String(req.headers['sec-websocket-key'] ?? '')
    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    sockets,
    sendText: (socket, text) => { socket.write(buildServerTextFrame(text)) },
    async close() {
      for (const s of [...sockets]) s.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

async function writeBridgeChildScript(dir: string): Promise<string> {
  const scriptPath = path.join(dir, 'ws-memory-child.mjs')
  await writeFile(scriptPath, `
    import { createInterface } from 'node:readline';

    let nextId = 1;
    const pending = new Map();
    const wsEvents = [];
    let holdWsEventMs = 0;

    function send(msg) {
      process.stdout.write(JSON.stringify(msg) + '\\n');
    }
    function rpc(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send({ jsonrpc: '2.0', id, method, params });
      });
    }

    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on('line', async (line) => {
      if (!line.trim()) return;
      const msg = JSON.parse(line);
      if (typeof msg.method === 'string') {
        if (msg.id === undefined) {
          if (msg.method === 'shutdown') setTimeout(() => process.exit(0), 10);
          return;
        }
        if (msg.method === 'initialize') {
          send({ jsonrpc: '2.0', id: msg.id, result: { apiVersion: '1.0.0' } });
          await rpc('tools.register', {
            name: 'read_ev',
            description: 'read channel event',
            parameters: { type: 'object' },
          });
          send({ jsonrpc: '2.0', method: 'plugin.ready' });
          return;
        }
        if (msg.method === 'tool.invoke') {
          const { args, call } = msg.params;
          try {
            if (args.mode === 'read') {
              const ev = await rpc('memory.readChannelEvent', { recordId: args.recordId, call });
              send({ jsonrpc: '2.0', id: msg.id, result: JSON.stringify({ ok: true, ev, callToken: call.callToken }) });
              return;
            }
            if (args.mode === 'read-with-forged') {
              await rpc('memory.readChannelEvent', { recordId: args.recordId, call: { ...call, callToken: 'forged-token' } });
              send({ jsonrpc: '2.0', id: msg.id, result: 'unexpected' });
              return;
            }
            if (args.mode === 'read-expired') {
              await rpc('memory.readChannelEvent', { recordId: args.recordId, call: args.staleCall });
              send({ jsonrpc: '2.0', id: msg.id, result: 'unexpected' });
              return;
            }
            if (args.mode === 'subscribe-ws') {
              holdWsEventMs = args.holdWsEventMs ?? 0;
              await rpc('http.subscribeWebSocket', { subscriptionId: args.subscriptionId, options: args.options });
              send({ jsonrpc: '2.0', id: msg.id, result: 'subscribed' });
              return;
            }
            if (args.mode === 'unsubscribe-ws') {
              await rpc('http.unsubscribeWebSocket', { subscriptionId: args.subscriptionId });
              send({ jsonrpc: '2.0', id: msg.id, result: 'unsubscribed' });
              return;
            }
            if (args.mode === 'ws-events') {
              send({ jsonrpc: '2.0', id: msg.id, result: JSON.stringify(wsEvents) });
              return;
            }
            if (args.mode === 'pid') {
              send({ jsonrpc: '2.0', id: msg.id, result: String(process.pid) });
              return;
            }
            if (args.mode === 'crash') {
              send({ jsonrpc: '2.0', id: msg.id, result: 'crashing' });
              setTimeout(() => process.exit(1), 20);
              return;
            }
            send({ jsonrpc: '2.0', id: msg.id, result: 'unknown' });
          } catch (err) {
            send({ jsonrpc: '2.0', id: msg.id, result: JSON.stringify({ ok: false, code: err.code, message: err.message }) });
          }
          return;
        }
        if (msg.method === 'http.wsEvent') {
          const { event } = msg.params;
          wsEvents.push(event);
          if (holdWsEventMs > 0 && event.type === 'message') {
            await new Promise((r) => setTimeout(r, holdWsEventMs));
          }
          send({ jsonrpc: '2.0', id: msg.id, result: null });
          return;
        }
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
        return;
      }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) {
        const err = new Error(msg.error.message || 'rpc error');
        err.code = msg.error.data?.code;
        p.reject(err);
      } else {
        p.resolve(msg.result);
      }
    });
  `)
  return scriptPath
}

test('plugin-external: http.fetch validates redirect option and forwards redirect: "error"', async () => {
  const h = await harness({
    script: {
      calls: [
        { method: 'http.fetch', params: { url: 'https://example.com/a', options: { redirect: 'error' } }, key: 'valid' },
        { method: 'http.fetch', params: { url: 'https://example.com/b', options: { redirect: 'manual' } }, key: 'bad' },
      ],
    },
  })
  try {
    await h.apply(h.ctx.ctx, {})
    await h.waitFor((entries) => entries.filter((e) => e.event === 'response').length === 2)
    const validResp = h.entries().find((e) => e.event === 'response' && e.key === 'valid')!
    assert.equal(validResp.error, undefined)
    assert.deepEqual((h.ctx.state.calls.httpFetch[0]![1] as Record<string, unknown>).redirect, 'error')

    const badResp = h.entries().find((e) => e.event === 'response' && e.key === 'bad')!
    assert.equal((badResp.error as { data: { code: string } }).data.code, 'INVALID_ARGUMENT')
    assert.equal(h.ctx.state.calls.httpFetch.length, 1)
  } finally {
    await h.stop()
  }
})

test('plugin-external: memory.readChannelEvent & http.subscribeWebSocket end-to-end with real kernel runtime and memory', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ext-ws-mem-'))
  const wsServer = await startTestWsServer()
  let memory: Awaited<ReturnType<typeof openMemory>> | undefined
  let runtime: ReturnType<typeof createPluginRuntime> | undefined
  let childPid: number | undefined

  try {
    const childScript = await writeBridgeChildScript(dir)
    const paths = await prepareBrainHome({ env: { BRAIN_HOME: path.join(dir, 'home') }, userHome: os.homedir() })
    memory = await openMemory({
      paths,
      clock: { now: () => Date.now() },
      log: silentLog,
      crossChannelMode: () => 'shadow',
      ownerChannels: [],
    })

    const channel = 'qq:group:1001'
    const otherChannel = 'qq:group:1002'
    const alice = await memory.identity.resolve('qq:101')
    const { id: l0Id } = await memory.service.ingest({
      kind: 'qq.message',
      channel,
      subjects: [alice],
      actor: alice,
      content: { text: 'external bridge message', legacy: true },
      visibility: 'origin',
      tEvent: 1000,
      idempotencyKey: 'ext-l0-1',
    }, {
      kind: 'plugin',
      source: 'qq',
      trust: 'external',
      defaultVisibility: 'origin',
      channels: [channel],
      eventKinds: ['qq.message'],
    })
    const { id: otherL0Id } = await memory.service.ingest({
      kind: 'qq.message',
      channel: otherChannel,
      subjects: [alice],
      actor: alice,
      content: { text: 'other channel secret' },
      visibility: 'origin',
      tEvent: 1001,
      idempotencyKey: 'ext-l0-2',
    }, {
      kind: 'plugin',
      source: 'qq',
      trust: 'external',
      defaultVisibility: 'origin',
      channels: [otherChannel],
      eventKinds: ['qq.message'],
    })

    const registeredTools = new Map<string, GatewayTool>()
    const manifest: BrainManifest = {
      id: 'qq',
      kinds: ['channel'],
      api: '^1',
      runtime: 'process',
      process: { command: process.execPath, args: [childScript] },
      permissions: ['memory.search', 'tools.register', 'lan:config:onebotWsUrl'],
      source: { channels: ['qq:group:*'], eventKinds: ['qq.message'], defaultVisibility: 'origin', trust: 'external' },
      tools: [{ name: 'read_ev', effect: 'read', load: 'core', summary: 'read event' }],
    }
    const plugin: InstalledPlugin = {
      manifest,
      version: '1.0.0',
      dir,
      granted: manifest.permissions,
      config: { onebotWsUrl: `ws://127.0.0.1:${wsServer.port}/ws` },
    }

    const externalDeps = {
      pluginsDir: path.join(dir, 'plugins'),
      log: silentLog,
      now: () => Date.now(),
      onFailed: () => {},
      parentEnv: { PATH: process.env.PATH, LANG: process.env.LANG, TZ: 'UTC' },
    }

    runtime = createPluginRuntime({
      memory: memory.service,
      identity: memory.identity,
      gateway: {
        register: (t) => { registeredTools.set(t.manifest.name, t); return () => registeredTools.delete(t.manifest.name) },
        checkOutbound: () => null,
        noteOutbound: () => {},
        admitSend: () => true,
      },
      agent: {
        wake: async () => ({} as never),
        wakeProactiveMessage: async () => ({} as never),
        rotate: async () => {},
        forgotten: async () => {},
        close: async () => {},
      },
      scheduler: { every: () => () => {}, at: () => () => {}, ownTime: () => () => {} },
      channels: { provide: () => () => {}, providerOf: () => undefined, proactiveProviderOf: () => undefined },
      audit: { sent: async () => {} },
      secrets: { get: async () => undefined },
      clock: { now: () => Date.now() },
      log: silentLog,
      pluginsDir: path.join(dir, 'plugins'),
      participantsOf: async () => [alice],
      readRecord: (id) => memory!.store.get(id),
      readChannelEvent: (recordId, sourcePluginId, viewer) => memory!.readChannelEvent(recordId, sourcePluginId, viewer),
      loadEntry: async (p) => createExternalApply(p, externalDeps),
    })

    await runtime.enable(plugin)
    const tool = registeredTools.get('read_ev')!
    assert.ok(tool !== undefined)
    const pidOut = Number(await tool.invoke({ mode: 'pid' }, { channel, wakeId: 'w0' }))
    if (Number.isInteger(pidOut) && pidOut > 0) childPid = pidOut

    // 1. readChannelEvent succeeds with host-issued callToken during active tool call
    const okOut = JSON.parse(await tool.invoke({ mode: 'read', recordId: l0Id }, { channel, wakeId: 'w1' }) as string) as {
      ok: boolean; callToken: string; ev: { record: { id: string; content: { text: string } }; disclosure: { label: string } }
    }
    assert.equal(okOut.ok, true)
    assert.equal(typeof okOut.callToken, 'string')
    assert.equal(okOut.ev.record.id, l0Id)
    assert.equal(okOut.ev.record.content.text, 'external bridge message')
    assert.ok(okOut.ev.disclosure.label.includes('旧系统历史存档'))

    // 2. Forged callToken rejected
    const forgedOut = JSON.parse(await tool.invoke({ mode: 'read-with-forged', recordId: l0Id }, { channel, wakeId: 'w2' }) as string) as { ok: boolean; code: string }
    assert.equal(forgedOut.ok, false)
    assert.equal(forgedOut.code, 'PERMISSION_DENIED')

    // 3. Expired callToken from previous tool call rejected
    const expiredOut = JSON.parse(await tool.invoke({
      mode: 'read-expired',
      recordId: l0Id,
      staleCall: { channel, wakeId: 'w1', callToken: okOut.callToken },
    }, { channel, wakeId: 'w3' }) as string) as { ok: boolean; code: string }
    assert.equal(expiredOut.ok, false)
    assert.equal(expiredOut.code, 'PERMISSION_DENIED')

    // 4. Other channel L0 rejected as NOT_FOUND
    const crossChanOut = JSON.parse(await tool.invoke({ mode: 'read', recordId: otherL0Id }, { channel, wakeId: 'w4' }) as string) as { ok: boolean; code: string }
    assert.equal(crossChanOut.ok, false)
    assert.equal(crossChanOut.code, 'NOT_FOUND')

    // 5. Subscribe WS over JSON-RPC, duplicate subscriptionId rejected, and backpressure overflow closes with 1008
    assert.equal(await tool.invoke({
      mode: 'subscribe-ws',
      subscriptionId: 'sub1',
      holdWsEventMs: 120,
      options: { configKey: 'onebotWsUrl', maxQueueLength: 2 },
    }, { channel, wakeId: 'w5' }), 'subscribed')

    // Duplicate subscriptionId -> CONFLICT
    const dupOut = JSON.parse(await tool.invoke({
      mode: 'subscribe-ws',
      subscriptionId: 'sub1',
      options: { configKey: 'onebotWsUrl' },
    }, { channel, wakeId: 'w6' }) as string) as { ok: boolean; code: string }
    assert.equal(dupOut.ok, false)
    assert.equal(dupOut.code, 'CONFLICT')

    await waitUntil(() => wsServer.sockets.size === 1)
    const sock1 = [...wsServer.sockets][0]!
    // Blast 3 messages while child delays 120ms on the first message -> triggers queue overflow 1008 over RPC backpressure
    wsServer.sendText(sock1, 'm1')
    wsServer.sendText(sock1, 'm2')
    wsServer.sendText(sock1, 'm3')

    await waitUntil(() => wsServer.sockets.size === 0)
    const events1 = JSON.parse(await tool.invoke({ mode: 'ws-events' }, { channel, wakeId: 'w7' }) as string) as WebSocketEvent[]
    assert.equal(events1[0]?.type, 'open')
    assert.equal(events1.some((e) => e.type === 'error' && e.code === 'UNAVAILABLE'), true)
    assert.equal(events1.some((e) => e.type === 'close' && e.code === 1008 && e.reason === 'queue_overflow'), true)

    // 6. Subscribe again and test explicit unsubscribe
    assert.equal(await tool.invoke({
      mode: 'subscribe-ws',
      subscriptionId: 'sub2',
      holdWsEventMs: 0,
      options: { configKey: 'onebotWsUrl' },
    }, { channel, wakeId: 'w8' }), 'subscribed')
    await waitUntil(() => wsServer.sockets.size === 1)
    assert.equal(await tool.invoke({ mode: 'unsubscribe-ws', subscriptionId: 'sub2' }, { channel, wakeId: 'w9' }), 'unsubscribed')
    await waitUntil(() => wsServer.sockets.size === 0)

    // 7. Subscribe again and test plugin disable immediately tears down WS
    assert.equal(await tool.invoke({
      mode: 'subscribe-ws',
      subscriptionId: 'sub3',
      options: { configKey: 'onebotWsUrl' },
    }, { channel, wakeId: 'w10' }), 'subscribed')
    await waitUntil(() => wsServer.sockets.size === 1)
    await runtime.disable('qq')
    await waitUntil(() => wsServer.sockets.size === 0)
  } finally {
    await runtime?.disable('qq').catch(() => undefined)
    await wsServer.close()
    await memory?.close()
    if (childPid !== undefined) {
      const pid = childPid
      await waitUntil(() => !isAlive(pid), 5000).catch(() => undefined)
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('plugin-external: child process crash immediately revokes and closes active WS subscription', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ext-ws-crash-'))
  const wsServer = await startTestWsServer()
  let runtime: ReturnType<typeof createPluginRuntime> | undefined
  let childPid: number | undefined

  try {
    const childScript = await writeBridgeChildScript(dir)
    const registeredTools = new Map<string, GatewayTool>()
    const manifest: BrainManifest = {
      id: 'qq',
      kinds: ['channel'],
      api: '^1',
      runtime: 'process',
      process: { command: process.execPath, args: [childScript] },
      permissions: ['tools.register', 'lan:config:onebotWsUrl'],
      source: { channels: ['qq:group:*'], eventKinds: ['qq.message'], defaultVisibility: 'origin', trust: 'external' },
      tools: [{ name: 'read_ev', effect: 'read', load: 'core', summary: 'read event' }],
    }
    const plugin: InstalledPlugin = {
      manifest,
      version: '1.0.0',
      dir,
      granted: manifest.permissions,
      config: { onebotWsUrl: `ws://127.0.0.1:${wsServer.port}/ws` },
    }
    const externalDeps = {
      pluginsDir: path.join(dir, 'plugins'),
      log: silentLog,
      now: () => Date.now(),
      onFailed: () => {},
      parentEnv: { PATH: process.env.PATH, LANG: process.env.LANG, TZ: 'UTC' },
    }
    runtime = createPluginRuntime({
      memory: {} as never,
      identity: {} as never,
      gateway: {
        register: (t) => { registeredTools.set(t.manifest.name, t); return () => registeredTools.delete(t.manifest.name) },
        checkOutbound: () => null,
        noteOutbound: () => {},
        admitSend: () => true,
      },
      agent: {} as never,
      scheduler: { every: () => () => {}, at: () => () => {}, ownTime: () => () => {} },
      channels: { provide: () => () => {}, providerOf: () => undefined, proactiveProviderOf: () => undefined },
      audit: { sent: async () => {} },
      secrets: { get: async () => undefined },
      clock: { now: () => Date.now() },
      log: silentLog,
      pluginsDir: path.join(dir, 'plugins'),
      participantsOf: async () => [],
      readRecord: async () => null,
      loadEntry: async (p) => createExternalApply(p, externalDeps),
    })

    await runtime.enable(plugin)
    const tool = registeredTools.get('read_ev')!
    const pidOut = Number(await tool.invoke({ mode: 'pid' }, { channel: 'qq:group:1', wakeId: 'w0' }))
    if (Number.isInteger(pidOut) && pidOut > 0) childPid = pidOut
    assert.equal(await tool.invoke({
      mode: 'subscribe-ws',
      subscriptionId: 'sub-crash',
      options: { configKey: 'onebotWsUrl' },
    }, { channel: 'qq:group:1', wakeId: 'w1' }), 'subscribed')
    await waitUntil(() => wsServer.sockets.size === 1)

    assert.equal(await tool.invoke({ mode: 'crash' }, { channel: 'qq:group:1', wakeId: 'w2' }), 'crashing')
    await waitUntil(() => wsServer.sockets.size === 0)
  } finally {
    await runtime?.disable('qq').catch(() => undefined)
    await wsServer.close()
    if (childPid !== undefined) {
      const pid = childPid
      await waitUntil(() => !isAlive(pid), 5000).catch(() => undefined)
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('plugin-external: rejects subscribeWebSocket and readChannelEvent when kernel omits optional methods', async () => {
  const h = await harness({
    script: {
      calls: [
        { method: 'http.subscribeWebSocket', params: { subscriptionId: 's1', options: { configKey: 'wsUrl' } }, key: 'ws' },
        { method: 'memory.readChannelEvent', params: { recordId: 'r1', call: { channel: 'echo:private:1', wakeId: 'w1' } }, key: 'rce' },
      ],
    },
  })
  // Simulate an older kernel context without optional methods
  delete (h.ctx.ctx.http as { subscribeWebSocket?: unknown }).subscribeWebSocket
  delete (h.ctx.ctx.memory as { readChannelEvent?: unknown }).readChannelEvent

  try {
    await h.apply(h.ctx.ctx, {})
    await h.waitFor((entries) => entries.filter((e) => e.event === 'response').length === 2)
    for (const key of ['ws', 'rce']) {
      const resp = h.entries().find((e) => e.event === 'response' && e.key === key)!
      assert.equal((resp.error as { data: { code: string } }).data.code, 'UNAVAILABLE')
    }
  } finally {
    await h.stop()
  }
})

test('plugin-external: rapid subscribe -> mid-handshake unsubscribe -> immediate resubscribe keeps per-attempt token', async () => {
  let callIndex = 0
  let resolveFirst!: (dispose: () => void) => void
  let resolveSecond!: (dispose: () => void) => void
  let firstCalled!: () => void
  let secondCalled!: () => void
  const firstStarted = new Promise<void>((r) => { firstCalled = r })
  const secondStarted = new Promise<void>((r) => { secondCalled = r })
  let disposed1 = false
  let disposed2 = false

  const h = await harness({
    script: {
      calls: [
        { method: 'http.subscribeWebSocket', params: { subscriptionId: 'race-sub', options: { configKey: 'ws1' } }, key: 'sub1' },
        { method: 'http.unsubscribeWebSocket', params: { subscriptionId: 'race-sub' }, key: 'unsub' },
        { method: 'http.subscribeWebSocket', params: { subscriptionId: 'race-sub', options: { configKey: 'ws2' } }, key: 'sub2' },
      ],
    },
  })

  h.ctx.ctx.http.subscribeWebSocket = async () => {
    callIndex += 1
    if (callIndex === 1) {
      firstCalled()
      return new Promise<() => void>((resolve) => {
        resolveFirst = resolve
      })
    }
    secondCalled()
    return new Promise<() => void>((resolve) => {
      resolveSecond = resolve
    })
  }

  try {
    await h.apply(h.ctx.ctx, {})
    await Promise.all([firstStarted, secondStarted])
    await h.waitFor((entries) => entries.some((e) => e.event === 'response' && e.key === 'unsub'))

    // Attempt 1 resolves after mid-handshake unsubscribe and attempt 2 start, while attempt 2 is still pending
    resolveFirst(() => { disposed1 = true })
    await h.waitFor((entries) => entries.some((e) => e.event === 'response' && e.key === 'sub1'))
    assert.equal(disposed1, true)
    const sub1Resp = h.entries().find((e) => e.event === 'response' && e.key === 'sub1')!
    assert.equal((sub1Resp.error as { data: { code: string } }).data.code, 'UNAVAILABLE')

    // Attempt 2 resolves cleanly and remains active without being clobbered by attempt 1
    resolveSecond(() => { disposed2 = true })
    await h.waitFor((entries) => entries.some((e) => e.event === 'response' && e.key === 'sub2'))
    const sub2Resp = h.entries().find((e) => e.event === 'response' && e.key === 'sub2')!
    assert.equal(sub2Resp.error, undefined)
    assert.equal(sub2Resp.result, null)
    assert.equal(disposed2, false)
  } finally {
    await h.stop()
  }
})
