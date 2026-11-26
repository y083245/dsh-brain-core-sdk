// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from 'node:assert/strict'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const KERNEL_CLI_PATH = path.resolve(PLUGIN_ROOT, '../../apps/kernel/src/cli.ts')

const HTTP_TOKEN = 'test-http-secret-token-01'
const WS_TOKEN = 'test-ws-secret-token-02'

interface RpcErrorPayload {
  readonly code: number
  readonly message: string
  readonly data?: { readonly code?: string; readonly details?: Record<string, unknown> }
}

interface RpcMessage {
  readonly jsonrpc?: string
  readonly id?: number | string
  readonly method?: string
  readonly params?: Record<string, unknown>
  readonly result?: unknown
  readonly error?: RpcErrorPayload
}

interface TimelineEntry {
  readonly kind: 'request' | 'notification' | 'response-sent'
  readonly method: string
  readonly at: number
}

interface RegisteredRoute {
  readonly routeId: string
  readonly method: string
  readonly path: string
}

class HostRpcPeer {
  readonly #child: ChildProcess
  readonly #timers = new Set<ReturnType<typeof setTimeout>>()
  readonly #handlers = new Map<string, (params: Record<string, unknown>) => unknown | Promise<unknown>>()
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  readonly #waiters: (() => boolean)[] = []

  readonly timeline: TimelineEntry[] = []
  readonly registeredTools: string[] = []
  readonly registeredRoutes: RegisteredRoute[] = []
  readonly consolePages: Record<string, unknown>[] = []
  readonly stderrChunks: string[] = []

  #buffer = ''
  #nextId = 1
  #closed = false

  constructor(child: ChildProcess) {
    this.#child = child

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      this.#buffer += chunk
      for (;;) {
        const idx = this.#buffer.indexOf('\n')
        if (idx === -1) return
        const line = this.#buffer.slice(0, idx)
        this.#buffer = this.#buffer.slice(idx + 1)
        if (line.trim() === '') continue
        const msg = JSON.parse(line) as RpcMessage
        this.#handleMessage(msg)
      }
    })

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      this.stderrChunks.push(chunk)
    })
  }

  onRequest(
    method: string,
    handler: (params: Record<string, unknown>) => unknown | Promise<unknown>,
  ): void {
    this.#handlers.set(method, handler)
  }

  delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#timers.delete(timer)
        resolve()
      }, ms)
      this.#timers.add(timer)
    })
  }

  #send(msg: Record<string, unknown>): void {
    if (this.#closed || this.#child.stdin === null || this.#child.stdin.destroyed) return
    this.#child.stdin.write(`${JSON.stringify(msg)}\n`)
  }

  #notifyWaiters(): void {
    for (let i = this.#waiters.length - 1; i >= 0; i--) {
      if (this.#waiters[i]!()) {
        this.#waiters.splice(i, 1)
      }
    }
  }

  #handleMessage(msg: RpcMessage): void {
    if (typeof msg.method === 'string' && msg.id === undefined) {
      this.timeline.push({ kind: 'notification', method: msg.method, at: Date.now() })
      this.#notifyWaiters()
      return
    }

    if (typeof msg.method === 'string' && msg.id !== undefined) {
      const method = msg.method
      const params = (msg.params ?? {}) as Record<string, unknown>
      this.timeline.push({ kind: 'request', method, at: Date.now() })

      if (method === 'tools.register' && typeof params.name === 'string') {
        this.registeredTools.push(params.name)
      } else if (
        method === 'http.route'
        && typeof params.routeId === 'string'
        && typeof params.method === 'string'
        && typeof params.path === 'string'
      ) {
        this.registeredRoutes.push({
          routeId: params.routeId,
          method: params.method,
          path: params.path,
        })
      } else if (method === 'console.page') {
        this.consolePages.push(params)
      }

      const handler = this.#handlers.get(method)
      Promise.resolve()
        .then(() => (handler ? handler(params) : null))
        .then(
          (result) => {
            this.#send({ jsonrpc: '2.0', id: msg.id, result: result === undefined ? null : result })
            this.timeline.push({ kind: 'response-sent', method, at: Date.now() })
            this.#notifyWaiters()
          },
          (error: unknown) => {
            const rpcError = error instanceof RpcFailure
              ? { code: -32000, message: error.message, data: { code: error.code, details: {} } }
              : { code: -32000, message: error instanceof Error ? error.message : String(error), data: { code: 'INTERNAL', details: {} } }
            this.#send({ jsonrpc: '2.0', id: msg.id, error: rpcError })
            this.timeline.push({ kind: 'response-sent', method, at: Date.now() })
            this.#notifyWaiters()
          },
        )
      return
    }

    if (msg.id !== undefined && typeof msg.id === 'number') {
      const pending = this.#pending.get(msg.id)
      if (!pending) return
      this.#pending.delete(msg.id)
      if (msg.error) {
        const err = new Error(msg.error.message || 'RPC error') as Error & { code?: string }
        err.code = msg.error.data?.code
        pending.reject(err)
      } else {
        pending.resolve(msg.result)
      }
      this.#notifyWaiters()
    }
  }

  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#send(params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.#send(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params })
  }

  waitFor(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
    if (predicate()) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#timers.delete(timer)
        const idx = this.#waiters.indexOf(check)
        if (idx >= 0) this.#waiters.splice(idx, 1)
        reject(new Error(`Timed out waiting for ${label}. stderr=${this.stderrChunks.join('')}`))
      }, timeoutMs)
      this.#timers.add(timer)

      const check = (): boolean => {
        if (!predicate()) return false
        clearTimeout(timer)
        this.#timers.delete(timer)
        resolve()
        return true
      }
      this.#waiters.push(check)
    })
  }

  dispose(): void {
    this.#closed = true
    for (const timer of this.#timers) clearTimeout(timer)
    this.#timers.clear()
    for (const pending of this.#pending.values()) {
      pending.reject(new Error('HostRpcPeer disposed'))
    }
    this.#pending.clear()
    this.#waiters.length = 0
  }
}

class RpcFailure extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

function jsonFetchResponse(payload: unknown, status = 200) {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    base64: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
  }
}

test('1. real child process stdio JSON-RPC lifecycle, non-blocking wsEvent, wake/tool loop, routes, and graceful shutdown', async (t) => {
  const child = spawn(process.execPath, ['src/index.ts'], {
    cwd: PLUGIN_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const peer = new HostRpcPeer(child)

  const exitPromise = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })

  t.after(async () => {
    peer.dispose()
    if (child.exitCode === null && child.signalCode === null) {
      try {
        peer.notify('shutdown')
      } catch {
        // Ignore if stdin already closed.
      }
      const settled = await Promise.race([
        exitPromise.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 1500)),
      ])
      if (!settled && child.exitCode === null && child.signalCode === null) {
        child.kill()
        await exitPromise
      }
    }
    child.stdin?.destroy()
    child.stdout?.destroy()
    child.stderr?.destroy()
  })

  let wsAttempts = 0
  let activeSubId = ''
  let delayNextIngestMs = 0
  let ingestResolvedAt = 0
  let seq = 0

  const ingestedEvents: Array<{ readonly id: string; readonly event: Record<string, unknown> }> = []
  const wakeCalls: Array<{ readonly channel: string; readonly input: Record<string, unknown> }> = []
  const fetchCalls: Array<{ readonly url: string; readonly options: Record<string, unknown> }> = []
  const readChannelEventCalls: Array<{ readonly recordId: string; readonly call: Record<string, unknown> }> = []

  peer.onRequest('secrets.get', (params) => {
    if (params.name === 'onebot-http-token') return HTTP_TOKEN
    if (params.name === 'onebot-ws-token') return WS_TOKEN
    return null
  })

  peer.onRequest('identity.resolve', (params) => `person:${String(params.account ?? '')}`)

  peer.onRequest('memory.ingest', async (params) => {
    if (delayNextIngestMs > 0) {
      const waitMs = delayNextIngestMs
      delayNextIngestMs = 0
      await peer.delay(waitMs)
    }
    const id = `rec_${++seq}`
    ingestResolvedAt = Date.now()
    ingestedEvents.push({ id, event: (params.event ?? {}) as Record<string, unknown> })
    return { id }
  })

  peer.onRequest('agent.wake', (params) => {
    wakeCalls.push({
      channel: String(params.channel ?? ''),
      input: (params.input ?? {}) as Record<string, unknown>,
    })
    return { wakeId: 'wake_1', acked: true, steps: 1, sent: 1 }
  })

  peer.onRequest('memory.readChannelEvent', (params) => {
    const recordId = String(params.recordId ?? '')
    const call = (params.call ?? {}) as Record<string, unknown>
    readChannelEventCalls.push({ recordId, call })
    const found = ingestedEvents.find((entry) => entry.id === recordId)
    if (!found) throw new RpcFailure('NOT_FOUND', 'record not found')
    return {
      record: {
        id: found.id,
        layer: 'L0',
        kind: found.event.kind ?? 'qq.message',
        channel: found.event.channel,
        actor: found.event.actor,
        subjects: found.event.subjects ?? [],
        tEvent: found.event.tEvent ?? Date.now(),
        status: 'active',
        trust: 'external',
        visibility: 'origin',
        source: 'qq',
        content: found.event.content ?? {},
        createdAt: Date.now(),
        version: 1,
        idempotencyKey: found.event.idempotencyKey ?? found.id,
      },
      disclosure: {
        label: '[QQ 外部消息]',
        trust: 'external',
        source: 'qq',
      },
    }
  })

  peer.onRequest('http.fetch', (params) => {
    const url = String(params.url ?? '')
    const options = (params.options ?? {}) as Record<string, unknown>
    fetchCalls.push({ url, options })

    if (url.endsWith('/get_login_info')) {
      return jsonFetchResponse({ status: 'ok', retcode: 0, data: { user_id: 999888, nickname: '小鲸鱼' } })
    }
    if (url.endsWith('/get_status')) {
      return jsonFetchResponse({ status: 'ok', retcode: 0, data: { online: true, good: true } })
    }
    if (url.endsWith('/send_private_msg')) {
      return jsonFetchResponse({ status: 'ok', retcode: 0, data: { message_id: 7001 } })
    }
    if (url.endsWith('/fetch_custom_face')) {
      return jsonFetchResponse({ status: 'ok', retcode: 0, data: [] })
    }
    return jsonFetchResponse({ status: 'ok', retcode: 0, data: {} })
  })

  peer.onRequest('http.subscribeWebSocket', (params) => {
    wsAttempts += 1
    if (wsAttempts === 1) {
      // Simulate offline protocol server on the very first attempt: must not block plugin.ready.
      throw new RpcFailure('UNAVAILABLE', 'onebot ws server offline')
    }
    activeSubId = String(params.subscriptionId ?? '')
    return null
  })

  // Step 1: Send initialize and verify strict startup RPC ordering.
  const initResult = (await peer.request('initialize', {
    apiVersion: '1.0.0',
    pluginId: 'qq',
    version: '0.1.0',
    config: {
      allowPrivate: ['123456'],
      allowGroups: ['654321'],
      ownerQQ: '123456',
      onebotHttpUrl: 'http://127.0.0.1:3000',
      onebotWsUrl: 'ws://127.0.0.1:3001',
      wake: { batchWindowMs: 20, quietDebounceMs: 0, minWakeIntervalMs: 0 },
    },
  })) as { apiVersion: string }
  assert.equal(initResult.apiVersion, '1.0.0')

  await peer.waitFor(
    () => peer.timeline.some((e) => e.kind === 'notification' && e.method === 'plugin.ready')
      && wsAttempts >= 1,
    'plugin.ready and first http.subscribeWebSocket attempt',
  )

  const readyIndex = peer.timeline.findIndex((e) => e.kind === 'notification' && e.method === 'plugin.ready')
  const firstWsIndex = peer.timeline.findIndex((e) => e.kind === 'request' && e.method === 'http.subscribeWebSocket')
  assert.ok(readyIndex >= 0, 'plugin.ready must be emitted even if OneBot WS is initially UNAVAILABLE')
  assert.ok(firstWsIndex > readyIndex, 'http.subscribeWebSocket must occur strictly after plugin.ready')

  const beforeReady = peer.timeline.slice(0, readyIndex)
  const expectedRegistrations = [
    ...Array.from({ length: 14 }, () => 'tools.register'),
    'channel.provide',
    ...Array.from({ length: 5 }, () => 'http.route'),
    'console.page',
  ]
  for (const method of new Set(expectedRegistrations)) {
    const expectedCount = expectedRegistrations.filter((item) => item === method).length
    const reqCount = beforeReady.filter((e) => e.kind === 'request' && e.method === method).length
    const respCount = beforeReady.filter((e) => e.kind === 'response-sent' && e.method === method).length
    assert.equal(reqCount, expectedCount, `expected ${expectedCount} ${method} requests before plugin.ready`)
    assert.equal(respCount, expectedCount, `expected ${expectedCount} ${method} responses before plugin.ready`)
  }
  assert.equal(peer.registeredTools.length, 14)
  assert.equal(peer.registeredRoutes.length, 5)
  assert.equal(peer.consolePages.length, 1)

  // Step 2: Wait for automatic WS reconnect after the initial UNAVAILABLE failure.
  await peer.waitFor(() => wsAttempts >= 2 && activeSubId !== '', 'second http.subscribeWebSocket reconnect')

  // Step 3: Inject open + heartbeat, then inject inbound message while memory.ingest is delayed 80ms.
  await peer.request('http.wsEvent', { subscriptionId: activeSubId, event: { type: 'open' } })
  await peer.waitFor(
    () => fetchCalls.some((c) => c.url.endsWith('/get_login_info')),
    'get_login_info fetch on open',
  )

  await peer.request('http.wsEvent', {
    subscriptionId: activeSubId,
    event: {
      type: 'message',
      data: JSON.stringify({
        post_type: 'meta_event',
        meta_event_type: 'heartbeat',
        status: { online: true, good: true },
      }),
    },
  })

  delayNextIngestMs = 80
  await peer.request('http.wsEvent', {
    subscriptionId: activeSubId,
    event: {
      type: 'message',
      data: JSON.stringify({
        post_type: 'message',
        message_type: 'private',
        user_id: 123456,
        message_id: 1001,
        time: 1_700_000_000,
        sender: { user_id: 123456, nickname: '主人' },
        message: [
          { type: 'text', data: { text: '看看这张图' } },
          { type: 'image', data: { file: 'pic.png', url: 'https://gchat.qpic.cn/gchatpic_new/pic.png' } },
        ],
      }),
    },
  })
  const wsEventRepliedAt = Date.now()
  assert.equal(ingestResolvedAt, 0, 'http.wsEvent must reply immediately before delayed memory.ingest resolves')

  // Step 4: Verify identity.resolve -> memory.ingest -> agent.wake (with hasMedia).
  await peer.waitFor(() => wakeCalls.length === 1, 'agent.wake after inbound message')
  assert.equal(ingestedEvents.length, 1)
  assert.ok(wsEventRepliedAt < ingestResolvedAt, 'http.wsEvent reply timestamp must precede memory.ingest resolution')

  const inboundId = ingestedEvents[0]!.id
  const wake = wakeCalls[0]!
  assert.equal(wake.channel, 'qq:private:123456')
  assert.equal(wake.input.reason, 'message')
  const wakeMessages = wake.input.messages as Array<{ id: string; hasMedia?: boolean }>
  assert.equal(wakeMessages.length, 1)
  assert.equal(wakeMessages[0]!.id, inboundId)
  assert.equal(wakeMessages[0]!.hasMedia, true)

  // Step 5: Invoke send_message and verify Authorization header, redirect: 'error', and outbound L0 ingest.
  const sendResRaw = await peer.request('tool.invoke', {
    name: 'send_message',
    args: { messages: ['收到图片啦'] },
    call: { channel: 'qq:private:123456', wakeId: 'w-send', callToken: 'tok-send' },
  })
  const sendRes = JSON.parse(String(sendResRaw)) as { ok: boolean; deliveredMessageIds: string[] }
  assert.equal(sendRes.ok, true)
  assert.deepEqual(sendRes.deliveredMessageIds, ['7001'])

  const sendFetch = fetchCalls.find((c) => c.url === 'http://127.0.0.1:3000/send_private_msg')
  assert.ok(sendFetch !== undefined, 'send_message must call http.fetch on /send_private_msg')
  assert.equal(sendFetch.options.method, 'POST')
  assert.equal(sendFetch.options.redirect, 'error')
  const sendHeaders = sendFetch.options.headers as Record<string, string>
  assert.equal(sendHeaders.Authorization ?? sendHeaders.authorization, `Bearer ${HTTP_TOKEN}`)

  const outboundIngest = ingestedEvents.find((entry) => entry.event.actor === 'self')
  assert.ok(outboundIngest !== undefined, 'send_message must ingest outbound L0 record')
  assert.equal((outboundIngest.event.content as Record<string, unknown>).direction, 'outbound')

  // Step 6: Invoke get_message_detail and verify callToken pass-through to memory.readChannelEvent.
  const detailRaw = await peer.request('tool.invoke', {
    name: 'get_message_detail',
    args: { messageId: '1001' },
    call: { channel: 'qq:private:123456', wakeId: 'w-detail', callToken: 'call-token-passthrough-xyz' },
  })
  const detail = JSON.parse(String(detailRaw)) as { record: { id: string } }
  assert.equal(detail.record.id, inboundId)
  assert.equal(readChannelEventCalls.length, 1)
  assert.equal(readChannelEventCalls[0]!.recordId, inboundId)
  assert.equal(readChannelEventCalls[0]!.call.callToken, 'call-token-passthrough-xyz')

  // Step 7: Exercise all 5 registered HTTP routes via http.request.
  const routeByPath = new Map(peer.registeredRoutes.map((route) => [`${route.method} ${route.path}`, route.routeId]))

  const uiHtml = await peer.request('http.request', {
    routeId: routeByPath.get('GET /ui'),
    request: { method: 'GET', path: '/ui', query: {} },
  })
  assert.equal(typeof uiHtml, 'string')
  assert.match(String(uiHtml), /QQ 通道只读状态面板/)
  assert.equal(/<script\b/i.test(String(uiHtml)), false, 'UI HTML must contain zero <script> tags')
  assert.equal(/<form\b/i.test(String(uiHtml)), false, 'UI HTML must contain zero <form> tags')
  assert.equal(String(uiHtml).includes(HTTP_TOKEN), false)
  assert.equal(String(uiHtml).includes(WS_TOKEN), false)

  const statusBody = (await peer.request('http.request', {
    routeId: routeByPath.get('GET /status'),
    request: { method: 'GET', path: '/status', query: {} },
  })) as { health: { state: string }; identity: { selfId: string | null } }
  assert.equal(statusBody.health.state, 'healthy')
  assert.equal(statusBody.identity.selfId, '999888')

  const probeBody = (await peer.request('http.request', {
    routeId: routeByPath.get('POST /probe'),
    request: { method: 'POST', path: '/probe', query: {} },
  })) as { ok: boolean; status: { ok: boolean; online: boolean; good: boolean } }
  assert.equal(probeBody.ok, true)
  assert.equal(probeBody.status.ok, true)
  assert.equal(probeBody.status.online, true)

  const channelsBody = (await peer.request('http.request', {
    routeId: routeByPath.get('GET /channels'),
    request: { method: 'GET', path: '/channels', query: {} },
  })) as { items: Array<{ channel: string }>; total: number }
  assert.ok(channelsBody.total >= 2)
  assert.ok(channelsBody.items.some((item) => item.channel === 'qq:private:123456'))

  const stickersBody = (await peer.request('http.request', {
    routeId: routeByPath.get('GET /stickers'),
    request: { method: 'GET', path: '/stickers', query: {} },
  })) as { enabled: boolean; items: unknown[] }
  assert.equal(stickersBody.enabled, true)
  assert.ok(Array.isArray(stickersBody.items))

  // Step 8: Graceful shutdown exits cleanly with code 0.
  peer.notify('shutdown')
  const exit = await exitPromise
  assert.equal(exit.code, 0)
  assert.equal(exit.signal, null)
})

test('2. offline CLI brain plugin check --json passes with zero must findings', async () => {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [KERNEL_CLI_PATH, 'plugin', 'check', '--json', PLUGIN_ROOT],
    { windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  )
  const report = JSON.parse(stdout) as {
    readonly ok: boolean
    readonly manifest: { readonly ok: boolean }
    readonly findings: readonly { readonly level: string; readonly rule: string; readonly message: string }[]
  }
  assert.equal(report.ok, true, `check failed: ${stderr} ${stdout}`)
  assert.equal(report.manifest.ok, true)
  assert.equal(
    report.findings.some((finding) => finding.level === 'must'),
    false,
    `unexpected must findings: ${JSON.stringify(report.findings)}`,
  )
})
