// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from 'node:assert/strict'
import test from 'node:test'
import { createReadCursor, createSocialStateMachine } from '@dsh-brain-core/chat-kit'
import type { BrainContext, Disposable, PluginRequest } from '@dsh-brain-core/sdk'
import configSchema, { DEFAULT_QQ_CONFIG } from '../src/config.ts'
import { createInboundPipeline } from '../src/inbound/pipeline.ts'
import { OneBotHealth } from '../src/onebot/health.ts'
import { OneBotHttpError } from '../src/onebot/http-client.ts'
import { OneBotWsClient } from '../src/onebot/ws-client.ts'
import { QqSender, SentMessageError } from '../src/outbound/sender.ts'
import {
  escapeHtml,
  probeFfmpeg,
  registerQqUiRoutes,
  renderStatusPageHtml,
  sanitizeEndpointOrigin,
} from '../src/ui/index.ts'

test('config schema supports sticker collectAction/collectParamKey and matches DEFAULT_QQ_CONFIG', () => {
  assert.deepEqual(configSchema({}), DEFAULT_QQ_CONFIG)
  assert.equal(DEFAULT_QQ_CONFIG.stickers.collectAction, '')
  assert.equal(DEFAULT_QQ_CONFIG.stickers.collectParamKey, 'id')

  const custom = configSchema({
    stickers: { collectAction: 'collect_custom_face', collectParamKey: 'emoji_id' },
  })
  assert.equal(custom.stickers.collectAction, 'collect_custom_face')
  assert.equal(custom.stickers.collectParamKey, 'emoji_id')

  assert.throws(() => configSchema({ stickers: { collectAction: 'BAD-ACTION' } }))
  assert.throws(() => configSchema({ stickers: { collectParamKey: '' } }))
  assert.throws(() => configSchema({ stickers: { collectParamKey: 'BadKey' } }))
})

test('ws-client tracks reconnectCount and unrefs watchdog timer', async () => {
  let listener!: (event: import('@dsh-brain-core/sdk').WebSocketEvent) => void | Promise<void>
  let reconnectCallback!: () => void
  const health = new OneBotHealth()
  const client = new OneBotWsClient({
    http: {
      subscribeWebSocket: async (_options, cb) => {
        listener = cb
        return () => {}
      },
    },
    health,
    onEvent: () => {},
    probe: async () => {},
    login: async () => ({ user_id: 123, nickname: 'bot' }),
    now: () => 10_000,
    setTimeout: ((fn: () => void) => {
      reconnectCallback = fn
      return 1
    }) as unknown as typeof setTimeout,
    clearTimeout: (() => {}) as typeof clearTimeout,
  })
  assert.equal(client.reconnectCount, 0)
  client.start()
  await new Promise((r) => setImmediate(r))
  await listener({ type: 'open' })
  await listener({ type: 'close', code: 1000, reason: '' })
  assert.equal(client.reconnectCount, 1)
  reconnectCallback()
  await new Promise((r) => setImmediate(r))
  await listener({ type: 'open' })
  await listener({ type: 'close', code: 1000, reason: '' })
  assert.equal(client.reconnectCount, 2)
  await client.stop()
})

test('inbound pipeline supports dynamic getSelfId/event.self_id, fail-closed drop, and recentSpeakers', async () => {
  const ingests: string[] = []
  const wakes: string[] = []
  const ctx = {
    identity: { resolve: async (id: string) => `person:${id}` },
    memory: {
      ingest: async (ev: { idempotencyKey: string; content: { text?: string } }) => {
        ingests.push(String(ev.content.text ?? ''))
        return { id: ev.idempotencyKey }
      },
    },
    agent: {
      wake: async (_ch: string, input: { messages: readonly { text: string }[] }) => {
        wakes.push(...input.messages.map((m) => m.text))
        return {}
      },
    },
    channel: { send: async () => ({}) },
  } as unknown as BrainContext

  assert.throws(() => createInboundPipeline({ ctx, config: DEFAULT_QQ_CONFIG, selfId: 'bad' }))

  let dynamicSelfId: string | undefined = undefined
  const pipeline = createInboundPipeline({
    ctx,
    config: {
      ...DEFAULT_QQ_CONFIG,
      allowGroups: ['22'],
      wake: { ...DEFAULT_QQ_CONFIG.wake, groupTrigger: 'always', quietDebounceMs: 0 },
    },
    getSelfId: () => dynamicSelfId,
  })

  // Without selfId from getSelfId or event.self_id, non-recall messages are fail-closed dropped.
  await pipeline.process({
    post_type: 'message',
    group_id: 22,
    user_id: 1001,
    message_id: 1,
    message: [{ type: 'text', data: { text: 'drop me' } }],
  })
  assert.equal(ingests.length, 0)

  // Falls back to event.self_id and filters self messages.
  await pipeline.process({
    post_type: 'message',
    group_id: 22,
    self_id: 999,
    user_id: 999,
    message_id: 2,
    message: [{ type: 'text', data: { text: 'self loop' } }],
  })
  assert.equal(ingests.length, 0)

  dynamicSelfId = '999'
  await pipeline.process({
    post_type: 'message',
    group_id: 22,
    user_id: 1001,
    sender: { nickname: 'Alice\u200b' },
    message_id: 3,
    message: [{ type: 'text', data: { text: 'hello' } }],
  })
  await pipeline.process({
    post_type: 'message',
    group_id: 22,
    user_id: 1002,
    sender: { card: 'Bob' },
    message_id: 4,
    message: [{ type: 'text', data: { text: 'world' } }],
  })
  assert.deepEqual(ingests, ['hello', 'world'])
  assert.deepEqual(pipeline.recentSpeakers('qq:group:22'), [
    { userId: '1002', displayName: 'Bob' },
    { userId: '1001', displayName: 'Alice' },
  ])
  assert.deepEqual(pipeline.recentSpeakers('qq:group:999'), [])
  pipeline.dispose()
})

test('sender sendSticker validates, serializes, rate-limits, and throws SentMessageError on local failure', async () => {
  const config = {
    ...DEFAULT_QQ_CONFIG,
    allowGroups: ['12345'],
    send: { ...DEFAULT_QQ_CONFIG.send, maxPerMinute: 1, maxPerHour: 1 },
  }
  const actions: unknown[] = []
  const noted: string[] = []
  const ingested: unknown[] = []
  let failIngest = false
  const sender = new QqSender({
    config: () => config,
    secrets: async () => [],
    canSend: () => true,
    hasSeenMessage: (_ch, id) => id === '-10',
    noteSelfMessage: (ch, id) => {
      noted.push(`${ch}:${id}`)
    },
    action: async (name, params) => {
      actions.push({ name, params })
      return { message_id: -88 }
    },
    ingest: async (event) => {
      if (failIngest) throw new Error('db down')
      ingested.push(event)
    },
  })

  await assert.rejects(sender.sendSticker({ channel: 'qq:group:12345', sticker: { id: 'stk1' }, atUserId: 'all' }), /mention/)
  await assert.rejects(sender.sendSticker({ channel: 'qq:group:12345', sticker: { id: 'stk1' }, replyToMessageId: '-99' }), /reply/)

  const messageId = await sender.sendSticker({
    channel: 'qq:group:12345',
    sticker: { id: 'stk1', url: 'https://gxh.vip.qq.com/stk1.png' },
    replyToMessageId: '-10',
    atUserId: '10001',
  })
  assert.equal(messageId, '-88')
  assert.deepEqual(noted, ['qq:group:12345:-88'])
  assert.equal(actions.length, 1)
  assert.deepEqual(actions[0], {
    name: 'send_group_msg',
    params: {
      group_id: '12345',
      message: [
        { type: 'reply', data: { id: '-10' } },
        { type: 'at', data: { qq: '10001' } },
        { type: 'image', data: { file: 'https://gxh.vip.qq.com/stk1.png', subType: 1, url: 'https://gxh.vip.qq.com/stk1.png' } },
      ],
    },
  })
  assert.equal(ingested.length, 1)
  await assert.rejects(sender.sendSticker({ channel: 'qq:group:12345', sticker: { id: 'stk2' } }), /Rate limit/)

  // Verify SentMessageError when local ingest fails after protocol delivery
  const sender2 = new QqSender({
    config: () => config,
    secrets: async () => [],
    canSend: () => true,
    hasSeenMessage: () => true,
    action: async () => ({ message_id: 77 }),
    ingest: async () => {
      failIngest = true
      throw new Error('ingest failed')
    },
  })
  await assert.rejects(
    sender2.sendSticker({ channel: 'qq:group:12345', sticker: { id: 'stk1' } }),
    (err: unknown) => err instanceof SentMessageError && err.messageId === '77',
  )
})

test('status page escapes XSS, obeys sandbox="" constraints, and never leaks tokens/auth params', () => {
  assert.equal(escapeHtml('<script>"\'&`</script>'), '&lt;script&gt;&quot;&#39;&amp;&#96;&lt;/script&gt;')
  assert.equal(
    sanitizeEndpointOrigin('ws://user:SUPER_SECRET_PASS@127.0.0.1:3001/ws?access_token=SUPER_SECRET_TOKEN#frag'),
    'ws://127.0.0.1:3001',
  )
  assert.equal(sanitizeEndpointOrigin('not-a-url'), '(invalid)')

  const xssPayload = '"><script>alert(1)</script><img src=x onerror=alert(2)>'
  const html = renderStatusPageHtml({
    status: {
      health: { state: 'degraded', authError: true, lastHeartbeat: 10_000, heartbeatAgeMs: 5_000 },
      identity: { selfId: '123456', selfNickname: xssPayload },
      reconnectCount: 3,
      endpoints: {
        httpOrigin: 'http://user:TOP_SECRET_HTTP@127.0.0.1:3000/onebot?token=SECRET_Q',
        wsOrigin: 'wss://user:TOP_SECRET_WS@example.com:3001/?access_token=SECRET_WS',
      },
      access: {
        failClosed: true,
        allowAllWhenEmpty: false,
        ownerQQ: xssPayload,
        allowPrivate: ['10001', xssPayload],
        allowGroups: ['20002'],
        denyPrivate: ['30003'],
        denyGroups: [],
        ignoredSenders: ['40004'],
      },
      stickers: { enabled: true, collectEnabled: true, cachedCount: 12 },
      voice: { enabled: false },
      ffmpeg: { available: true, version: 'ffmpeg version 7.0 <script>x</script>' },
      channelsCount: 1,
      timestamp: 15_000,
    },
    channels: [
      {
        channel: `qq:group:${xssPayload}`,
        mode: 'active',
        unreadCount: 2,
        lastActivityAt: 14_000,
        lastWakeAt: 13_000,
        hourlyBudget: { used: 3, limit: 24, remaining: 21 },
      },
    ],
  })

  // Sandbox="" structural guarantees (no unescaped script, form, link, inline handlers, external attrs, or CSS urls)
  assert.equal(/<script/i.test(html), false)
  assert.equal(/<form/i.test(html), false)
  assert.equal(/<link\b/i.test(html), false)
  assert.equal(/<[a-z][^>]*\son[a-z]+\s*=/i.test(html), false)
  assert.equal(/<[a-z][^>]*\b(?:href|src|action)\s*=/i.test(html), false)
  assert.equal(/@import|url\(/i.test(html), false)

  // XSS must be escaped (raw tag never appears)
  assert.equal(html.includes('<script>alert(1)</script>'), false)
  assert.equal(html.includes('<img src=x onerror=alert(2)>'), false)
  assert.equal(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), true)

  // Secrets / query tokens / userinfo must never appear
  assert.equal(html.includes('TOP_SECRET_HTTP'), false)
  assert.equal(html.includes('TOP_SECRET_WS'), false)
  assert.equal(html.includes('SECRET_Q'), false)
  assert.equal(html.includes('SECRET_WS'), false)
  assert.equal(html.includes('http://127.0.0.1:3000'), true)
  assert.equal(html.includes('wss://example.com:3001'), true)

  // INKTIDE palette & status indicators
  assert.equal(html.includes('#0E0C0A'), true)
  assert.equal(html.includes('@media (prefers-color-scheme: light)'), true)
  assert.equal(html.includes('data-health-state="degraded"'), true)
  assert.equal(html.includes('OneBot 鉴权故障告警'), true)
})

test('probeFfmpeg validates path and silently returns unavailable on errors', async () => {
  assert.deepEqual(await probeFfmpeg('relative/ffmpeg'), { available: false })
  assert.deepEqual(await probeFfmpeg('/tmp/not-ffmpeg-binary'), { available: false })
  assert.deepEqual(await probeFfmpeg('/nonexistent-dir-xyz/ffmpeg'), { available: false })
})

test('registerQqUiRoutes registers 5 routes + console page, returns sanitized data, and cleans up on dispose', async () => {
  const routes = new Map<string, (req: PluginRequest) => Promise<unknown>>()
  const pages = new Map<string, { readonly id: string; readonly title: string; readonly entry: string }>()

  const ctx = {
    http: {
      route(method: string, path: string, handler: (req: PluginRequest) => Promise<unknown>): Disposable {
        const key = `${method} ${path}`
        routes.set(key, handler)
        return () => {
          routes.delete(key)
        }
      },
    },
    console: {
      page(descriptor: { readonly id: string; readonly title: string; readonly entry: string }): Disposable {
        pages.set(descriptor.id, descriptor)
        return () => {
          pages.delete(descriptor.id)
        }
      },
    },
  } as unknown as Pick<BrainContext, 'http' | 'console'>

  const now = 100_000
  const socialState = createSocialStateMachine({
    clock: { now: () => now },
    defaultConfig: DEFAULT_QQ_CONFIG.wake,
  })
  socialState.evaluateWake('qq:group:22', {
    channelKind: 'group',
    text: 'hi',
    mentioned: true,
    tEvent: now - 10_000,
  }, now - 10_000)

  const readCursor = createReadCursor()
  readCursor.onInbound('qq:group:22', '1', now - 5_000)

  const config = {
    ...DEFAULT_QQ_CONFIG,
    onebotHttpUrl: 'http://user:pass@127.0.0.1:3000/api?token=RAW_SECRET',
    onebotWsUrl: 'ws://user:pass@127.0.0.1:3001/ws?access_token=RAW_WS_SECRET',
    ownerQQ: '10001',
    allowGroups: ['22'],
  }

  let probeSuccess = true
  let ffmpegAvailable = true

  const dispose = registerQqUiRoutes(ctx, {
    config: () => config,
    health: () => ({ state: 'healthy', authError: false, lastHeartbeat: now - 2_000 }),
    selfIdentity: () => ({ selfId: '888888', selfNickname: '墨潮测试号' }),
    reconnectCount: () => 4,
    channels: () => ['qq:group:22'],
    socialState,
    readCursor,
    stickers: async () => ({
      cachedCount: 1,
      items: [{ id: 'face_1', url: 'https://qpic.cn/secret?k=1', description: 'remote note' } as unknown as { id: string }],
    }),
    action: async (name) => {
      if (!probeSuccess) {
        if (name === 'get_login_info') throw new OneBotHttpError('auth')
        throw new Error('sensitive internal detail: RAW_SECRET')
      }
      if (name === 'get_login_info') return { user_id: 888888, nickname: '墨潮\u200b测试号' }
      if (name === 'get_status') return { online: true, good: true }
      return {}
    },
    probeFfmpeg: async () => (ffmpegAvailable ? { available: true, version: 'ffmpeg version 7.0' } : { available: false }),
    now: () => now,
  })

  assert.deepEqual([...routes.keys()].sort(), [
    'GET /channels',
    'GET /status',
    'GET /stickers',
    'GET /ui',
    'POST /probe',
  ])
  assert.deepEqual(pages.get('qq-status'), {
    id: 'qq-status',
    title: 'QQ 通道',
    entry: '/api/v1/plugins/qq/ui',
  })

  const fakeReq = (method: string, path: string): PluginRequest => ({ method, path, query: {}, body: undefined })

  const statusJson = await routes.get('GET /status')!(fakeReq('GET', '/status')) as Record<string, unknown>
  assert.equal(JSON.stringify(statusJson).includes('RAW_SECRET'), false)
  assert.equal(JSON.stringify(statusJson).includes('RAW_WS_SECRET'), false)
  assert.deepEqual(statusJson.endpoints, {
    httpOrigin: 'http://127.0.0.1:3000',
    wsOrigin: 'ws://127.0.0.1:3001',
  })
  assert.equal(statusJson.reconnectCount, 4)

  const channelsJson = await routes.get('GET /channels')!(fakeReq('GET', '/channels')) as {
    items: readonly { channel: string; mode: string; unreadCount: number; hourlyBudget: { used: number; limit: number; remaining: number } }[]
  }
  assert.equal(channelsJson.items.length, 1)
  assert.equal(channelsJson.items[0]!.channel, 'qq:group:22')
  assert.equal(channelsJson.items[0]!.mode, 'active')
  assert.equal(channelsJson.items[0]!.unreadCount, 1)
  assert.equal(channelsJson.items[0]!.hourlyBudget.used, 1)
  assert.equal(channelsJson.items[0]!.hourlyBudget.limit, 24)
  assert.equal(channelsJson.items[0]!.hourlyBudget.remaining, 23)

  const stickersJson = await routes.get('GET /stickers')!(fakeReq('GET', '/stickers')) as {
    enabled: boolean
    cachedCount: number
    items: readonly Record<string, unknown>[]
  }
  assert.deepEqual(stickersJson, {
    enabled: true,
    cachedCount: 1,
    items: [{ id: 'face_1' }],
  })
  assert.equal(Object.keys(stickersJson.items[0]!).length, 1)

  const probeOk = await routes.get('POST /probe')!(fakeReq('POST', '/probe')) as Record<string, unknown>
  assert.equal(probeOk.ok, true)
  assert.deepEqual(probeOk.loginInfo, { ok: true, userId: '888888', nickname: '墨潮测试号' })
  assert.deepEqual(probeOk.status, { ok: true, online: true, good: true })

  probeSuccess = false
  const probeFail = await routes.get('POST /probe')!(fakeReq('POST', '/probe')) as Record<string, unknown>
  assert.equal(probeFail.ok, false)
  assert.equal(probeFail.errorKind, 'auth')
  assert.deepEqual(probeFail.loginInfo, { ok: false, errorKind: 'auth' })
  assert.deepEqual(probeFail.status, { ok: false, errorKind: 'unknown' })
  assert.equal(JSON.stringify(probeFail).includes('RAW_SECRET'), false)

  const uiHtml1 = await routes.get('GET /ui')!(fakeReq('GET', '/ui')) as string
  assert.equal(uiHtml1.includes('ffmpeg version 7.0'), true)
  assert.equal(uiHtml1.includes('888888'), true)

  ffmpegAvailable = false
  const uiHtml2 = await routes.get('GET /ui')!(fakeReq('GET', '/ui')) as string
  assert.equal(uiHtml2.includes('ffmpeg version 7.0'), false)
  assert.equal(uiHtml2.includes('不可用'), true)

  // Dispose must remove all 5 routes and the console page cleanly (and be idempotent)
  dispose()
  dispose()
  assert.equal(routes.size, 0)
  assert.equal(pages.size, 0)
})
