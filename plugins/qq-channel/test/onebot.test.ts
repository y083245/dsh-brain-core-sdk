// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BrainError } from '@dsh-brain-core/sdk'
import { HOST_UNSUPPORTED_MESSAGE } from '../src/apply.ts'
import { normalizeMessageId, normalizeAccountId, OneBotHealth, OneBotHttpClient, OneBotHttpError, OneBotWsClient } from '../src/onebot/index.ts'

test('normalizes safe IDs and rejects ambiguous values', () => {
  assert.equal(normalizeMessageId(-42), '-42')
  assert.equal(normalizeAccountId(123), '123')
  for (const value of ['0', '-0', '01', 1.2, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => normalizeMessageId(value))
})
test('heartbeat and bot status control health', () => {
  const health = new OneBotHealth()
  health.connected()
  health.event({ post_type: 'meta_event', meta_event_type: 'heartbeat', status: { online: true, good: true } }, 1)
  assert.equal(health.state, 'healthy')
  health.event({ post_type: 'notice', notice_type: 'bot_status', sub_type: 'offline' }, 2)
  assert.equal(health.state, 'degraded')
  health.event({ post_type: 'notice', notice_type: 'bot_status', sub_type: 'online' }, 3)
  assert.equal(health.state, 'healthy')
  assert.equal(health.stale(90002, 0), true)
})
test('HTTP sends bearer through host and detects authentication failure', async () => {
  let called = false
  let auth = false
  const client = new OneBotHttpClient({
    fetch: async (_url, options) => {
      called = true
      assert.equal(options?.headers?.Authorization, 'Bearer example')
      assert.equal(options?.redirect, 'error')
      return { status: 200, headers: {}, text: () => JSON.stringify({ status: 'failed', retcode: 1401 }), bytes: () => new Uint8Array() }
    }
  }, { get: async () => 'example' }, 'http://127.0.0.1:3000', () => { auth = true })
  await assert.rejects(client.action('get_status'), OneBotHttpError)
  assert.equal(called, true)
  assert.equal(auth, true)
  const remote = new OneBotHttpClient({ fetch: async () => { throw new Error('unexpected') } }, { get: async () => 'example' }, 'http://192.0.2.1')
  await assert.rejects(remote.action('get_status'), OneBotHttpError)
})
test('late subscription is retired after stop', async () => {
  let resolve!: (dispose: () => void) => void
  let disposed = false
  const health = new OneBotHealth()
  const client = new OneBotWsClient({
    http: {
      subscribeWebSocket: async options => {
        assert.deepEqual(options.auth?.secretNames, ['onebot-ws-token', 'onebot-http-token'])
        return await new Promise(r => { resolve = r })
      }
    }, health, onEvent: () => { }, probe: async () => { }, login: async () => { }
  })
  client.start()
  await client.stop()
  resolve(() => { disposed = true })
  await new Promise(r => setImmediate(r))
  assert.equal(disposed, true)
})

test('early close retires late handle and ignores callbacks from old connection', async () => {
  let release!: (dispose: () => void) => void
  let oldListener!: (event: import('@dsh-brain-core/sdk').WebSocketEvent) => void | Promise<void>
  let callback!: () => void
  let disposed = 0
  let calls = 0
  const delays: number[] = []
  const health = new OneBotHealth()
  const client = new OneBotWsClient({
    http: {
      subscribeWebSocket: async (_options, listener) => {
        calls++
        if (calls === 1) {
          oldListener = listener
          await listener({ type: 'open' })
          await listener({ type: 'close', code: 1000, reason: '' })
          return await new Promise(r => { release = r })
        }
        await listener({ type: 'open' })
        return () => { disposed++ }
      }
    }, health, onEvent: () => { throw new Error('should not run') }, login: async () => { }, probe: async () => { }, random: () => 0.5,
    setTimeout: ((fn: () => void, delay: number) => {
      callback = fn
      delays.push(delay)
      return 1
    }) as unknown as typeof setTimeout,
    clearTimeout: (() => { }) as typeof clearTimeout
  })
  client.start()
  await new Promise(r => setImmediate(r))
  assert.deepEqual(delays, [1000])
  callback()
  await new Promise(r => setImmediate(r))
  release(() => { disposed++ })
  await new Promise(r => setImmediate(r))
  assert.equal(disposed, 1)
  await oldListener({ type: 'close', code: 1000, reason: '' })
  assert.equal(health.state, 'ws_connected')
  await client.stop()
  assert.equal(disposed, 2)
})

test('repeated immediate abnormal closures stop with auth error and jitter is capped', async () => {
  let callback!: () => void
  const delays: number[] = []
  let auth = 0
  let attempts = 0
  const health = new OneBotHealth()
  const client = new OneBotWsClient({
    http: {
      subscribeWebSocket: async (_options, listener) => {
        attempts++
        await listener({ type: 'open' })
        await listener({ type: 'close', code: 1006, reason: 'secret' })
        return () => { }
      }
    }, health, onEvent: () => { }, login: async () => { }, probe: async () => { }, onAuthError: () => { auth++ }, now: () => 100, random: () => 1,
    setTimeout: ((fn: () => void, delay: number) => {
      callback = fn
      delays.push(delay)
      return 1
    }) as unknown as typeof setTimeout,
    clearTimeout: (() => { }) as typeof clearTimeout
  })
  client.start()
  await new Promise(r => setImmediate(r))
  assert.deepEqual(delays, [1200])
  callback()
  await new Promise(r => setImmediate(r))
  assert.equal(attempts, 2)
  assert.equal(auth, 1)
  assert.equal(health.authError, true)
  await client.stop()
})

test('HTTP errors do not expose host error or allow plaintext hostname', async () => {
  const http = { fetch: async () => { throw new Error('secret') } }
  const secrets = { get: async () => 'secret' }
  const hostname = new OneBotHttpClient(http, secrets, 'http://localhost:3000')
  await assert.rejects(hostname.action('get_status'), (error: Error) => !error.message.includes('secret'))
  const local = new OneBotHttpClient(http, secrets, 'http://127.0.0.1:3000')
  await assert.rejects(local.action('get_status'), (error: Error) => !error.message.includes('secret'))
})

test('stale status cannot be restored by online notice', () => {
  const health = new OneBotHealth()
  health.connected()
  health.event({ post_type: 'meta_event', meta_event_type: 'heartbeat', status: { online: true, good: true } }, 1)
  health.event({ post_type: 'notice', notice_type: 'bot_status', sub_type: 'online' }, 90002)
  assert.equal(health.state, 'degraded')
})

test('identity from retired connection is discarded', async () => {
  let listener!: (event: import('@dsh-brain-core/sdk').WebSocketEvent) => void | Promise<void>
  let resolve!: (value: unknown) => void
  const client = new OneBotWsClient({
    http: {
      subscribeWebSocket: async (_options, callback) => {
        listener = callback
        return () => { }
      }
    }, health: new OneBotHealth(), onEvent: () => { }, probe: async () => { }, login: async () => await new Promise(r => { resolve = r })
  })
  client.start()
  await new Promise(r => setImmediate(r))
  await listener({ type: 'open' })
  await client.stop()
  resolve({ user_id: 123, nickname: 'old' })
  await new Promise(r => setImmediate(r))
  assert.equal(client.selfId, undefined)
})

test('invalid URL and secret errors are static and URLs reject embedded authentication', async () => {
  const fetch = async () => { throw new Error('unexpected') }
  for (const url of ['http://user:pass@127.0.0.1', 'http://127.0.0.1/?token=secret', 'http://127.0.0.1/#secret', 'secret invalid']) {
    const client = new OneBotHttpClient({ fetch }, { get: async () => undefined }, url)
    await assert.rejects(client.action('get_status'), (error: Error) => !error.message.includes('secret'))
  }
  const client = new OneBotHttpClient({ fetch }, { get: async () => { throw new Error('secret') } }, 'http://127.0.0.1')
  await assert.rejects(client.action('get_status'), (error: Error) => !error.message.includes('secret'))
})

test('watchdog probes once per expired heartbeat and rearms on a new heartbeat', async () => {
  let now = 100000
  let probes = 0
  let listener!: (event: import('@dsh-brain-core/sdk').WebSocketEvent) => void | Promise<void>
  const health = new OneBotHealth()
  const client = new OneBotWsClient({
    http: {
      subscribeWebSocket: async (_options, callback) => {
        listener = callback
        return () => { }
      }
    }, health, now: () => now, onEvent: () => { }, probe: async () => { probes++ }, login: async () => ({ user_id: 123, nickname: 'bot' })
  })
  client.start()
  await new Promise(r => setImmediate(r))
  await listener({ type: 'open' })
  await new Promise(r => setImmediate(r))
  assert.equal(client.selfId, '123')
  assert.equal(client.selfNickname, 'bot')
  const check = (client as unknown as {
    check(generation: number): Promise<void>
    generation: number
  })
  now += 90001
  await check.check(check.generation)
  await check.check(check.generation)
  assert.equal(probes, 1)
  await listener({ type: 'message', data: JSON.stringify({ post_type: 'meta_event', meta_event_type: 'heartbeat', status: { online: true, good: true } }) })
  now += 90001
  await check.check(check.generation)
  assert.equal(probes, 2)
  await client.stop()
})

test('OB-03/OB-04/OB-06: HTTP omits empty Authorization, maps 401 to auth error, and rejects non-loopback HTTP before fetch', async () => {
  for (const emptyToken of [undefined, '']) {
    let seenHeaders: Readonly<Record<string, string>> | undefined
    const client = new OneBotHttpClient({
      fetch: async (_url, options) => {
        seenHeaders = options?.headers
        return { status: 200, headers: {}, text: () => JSON.stringify({ status: 'ok', retcode: 0, data: {} }), bytes: () => new Uint8Array() }
      },
    }, { get: async () => emptyToken }, 'http://127.0.0.1:3000')
    await client.action('get_status')
    assert.ok(seenHeaders !== undefined)
    assert.equal(Object.hasOwn(seenHeaders, 'Authorization'), false)
    assert.equal(Object.hasOwn(seenHeaders, 'authorization'), false)
    assert.equal(seenHeaders['Content-Type'], 'application/json')
  }

  let authErrors = 0
  const unauthClient = new OneBotHttpClient({
    fetch: async () => ({ status: 401, headers: {}, text: () => 'Unauthorized', bytes: () => new Uint8Array() }),
  }, { get: async () => 'tok' }, 'http://127.0.0.1:3000', () => { authErrors++ })
  await assert.rejects(
    unauthClient.action('get_status'),
    (err: unknown) => err instanceof OneBotHttpError && err.kind === 'auth',
  )
  assert.equal(authErrors, 1)

  let fetchCount = 0
  const remoteClient = new OneBotHttpClient({
    fetch: async () => {
      fetchCount++
      return { status: 200, headers: {}, text: () => '{}', bytes: () => new Uint8Array() }
    },
  }, { get: async () => 'tok' }, 'http://192.0.2.1:3000')
  await assert.rejects(
    remoteClient.action('get_status'),
    (err: unknown) => err instanceof OneBotHttpError && err.kind === 'auth',
  )
  assert.equal(fetchCount, 0)
})

test('OB-10/OB-12: heartbeat requires good:true and 90s watchdog degrades health state', async () => {
  const health = new OneBotHealth()
  health.connected()
  health.event({ post_type: 'meta_event', meta_event_type: 'heartbeat', status: { online: true, good: false } }, 10)
  assert.equal(health.state, 'degraded')

  health.event({ post_type: 'meta_event', meta_event_type: 'heartbeat', status: { online: true, good: true } }, 20)
  assert.equal(health.state, 'healthy')
  health.event({ post_type: 'meta_event', meta_event_type: 'heartbeat', status: { online: true } }, 30)
  assert.equal(health.state, 'degraded')

  let now = 1000
  let probes = 0
  let listener!: (event: import('@dsh-brain-core/sdk').WebSocketEvent) => void | Promise<void>
  const wsHealth = new OneBotHealth()
  const client = new OneBotWsClient({
    http: {
      subscribeWebSocket: async (_options, callback) => {
        listener = callback
        return () => {}
      },
    },
    health: wsHealth,
    now: () => now,
    onEvent: () => {},
    probe: async () => { probes++ },
    login: async () => ({ user_id: 123, nickname: 'bot' }),
  })
  client.start()
  await new Promise((r) => setImmediate(r))
  await listener({ type: 'open' })
  await listener({
    type: 'message',
    data: JSON.stringify({ post_type: 'meta_event', meta_event_type: 'heartbeat', status: { online: true, good: true } }),
  })
  assert.equal(wsHealth.state, 'healthy')

  const internal = client as unknown as { check(generation: number): Promise<void>; generation: number }
  now += 90_001
  await internal.check(internal.generation)
  assert.equal(probes, 1)
  assert.equal(wsHealth.state, 'degraded')
  await client.stop()
})

test('post-handshake INVALID_ARGUMENT WS error reconnects while PERMISSION_DENIED and unsupported host stop permanently', async () => {
  let listener!: (event: import('@dsh-brain-core/sdk').WebSocketEvent) => void | Promise<void>
  let scheduledFn: (() => void) | undefined
  let subscribeCalls = 0
  let scheduleCount = 0
  const client = new OneBotWsClient({
    http: {
      subscribeWebSocket: async (_options, callback) => {
        subscribeCalls++
        listener = callback
        return () => {}
      },
    },
    health: new OneBotHealth(),
    onEvent: () => {},
    probe: async () => {},
    login: async () => ({ user_id: 123, nickname: 'bot' }),
    random: () => 0.5,
    setTimeout: ((fn: () => void) => {
      scheduleCount++
      scheduledFn = fn
      return 1
    }) as unknown as typeof setTimeout,
    clearTimeout: (() => {}) as typeof clearTimeout,
  })
  client.start()
  await new Promise((r) => setImmediate(r))
  await listener({ type: 'open' })
  await listener({ type: 'error', code: 'INVALID_ARGUMENT', reason: 'binary frame' })
  assert.equal(scheduleCount, 1)
  assert.equal(client.reconnectCount, 1)
  scheduledFn?.()
  await new Promise((r) => setImmediate(r))
  assert.equal(subscribeCalls, 2)

  await listener({ type: 'open' })
  await listener({ type: 'error', code: 'PERMISSION_DENIED', reason: 'forbidden' })
  assert.equal(scheduleCount, 1)
  await client.stop()

  let unsupportedMessage = ''
  let unsupportedAttempts = 0
  let unsupportedTimers = 0
  const unsupportedClient = new OneBotWsClient({
    http: {
      subscribeWebSocket: async () => {
        unsupportedAttempts++
        throw new BrainError('INVALID_ARGUMENT', HOST_UNSUPPORTED_MESSAGE)
      },
    },
    health: new OneBotHealth(),
    onEvent: () => {},
    probe: async () => {},
    login: async () => {},
    onUnsupportedHost: (msg) => { unsupportedMessage = msg },
    setTimeout: (() => {
      unsupportedTimers++
      return 1
    }) as unknown as typeof setTimeout,
    clearTimeout: (() => {}) as typeof clearTimeout,
  })
  unsupportedClient.start()
  await new Promise((r) => setImmediate(r))
  assert.equal(unsupportedAttempts, 1)
  assert.equal(unsupportedTimers, 0)
  assert.equal(unsupportedMessage, HOST_UNSUPPORTED_MESSAGE)
  await unsupportedClient.stop()
})
