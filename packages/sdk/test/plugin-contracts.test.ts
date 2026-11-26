import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  ChannelEventResult,
  FetchOptions,
  PluginHttp,
  PluginMemory,
  ToolCallContext,
  WakeMessage,
  WebSocketAuthOptions,
  WebSocketEvent,
  WebSocketSubscribeOptions,
} from '../src/index.ts'
import { evalWhen, parsePermission, parseWhen, validateManifest } from '../src/index.ts'

test('ToolCallContext supports optional callToken without breaking legacy callers', () => {
  const legacyCall: ToolCallContext = { channel: 'qq:private:123', wakeId: 'wake_1' }
  const tokenCall: ToolCallContext = { channel: 'qq:group:456', wakeId: 'wake_2', callToken: 'tok_abc' }

  assert.equal(legacyCall.callToken, undefined)
  assert.equal(tokenCall.callToken, 'tok_abc')
})

test('PluginMemory.readChannelEvent returns ChannelEventResult with record and disclosure', async () => {
  const result: ChannelEventResult = {
    record: {
      id: 'l0_01J00000000000000000000001',
      layer: 'L0',
      kind: 'qq.message',
      source: 'qq',
      channel: 'qq:group:456',
      subjects: ['person_1'],
      actor: 'person_1',
      content: { text: 'hello' },
      evidence: [],
      visibility: 'origin',
      trust: 'external',
      confidence: 1,
      importance: 0.5,
      tEvent: 1700000000000,
      tIngest: 1700000000100,
      status: 'active',
      version: 1,
    },
    disclosure: { speakable: 'yes', label: '本群刚才的话' },
  }

  const readChannelEvent: NonNullable<PluginMemory['readChannelEvent']> = async (recordId, call) => {
    assert.equal(recordId, result.record.id)
    assert.equal(call.callToken, 'tok_abc')
    return result
  }

  const fetched = await readChannelEvent(result.record.id, {
    channel: 'qq:group:456',
    wakeId: 'wake_2',
    callToken: 'tok_abc',
  })
  assert.equal(fetched.record.id, result.record.id)
  assert.equal(fetched.disclosure.speakable, 'yes')
})

test('WakeMessage supports optional hasMedia flag for on-demand media tools', () => {
  const withoutMedia: WakeMessage = {
    id: 'l0_1',
    actor: 'person_1',
    name: '小明',
    text: '在吗',
    tEvent: 1700000000000,
  }
  const withDeferredMedia: WakeMessage = {
    id: 'l0_2',
    actor: 'person_1',
    name: '小明',
    text: '[图片]',
    tEvent: 1700000001000,
    hasMedia: true,
  }

  assert.equal(withoutMedia.hasMedia, undefined)
  assert.equal(withDeferredMedia.hasMedia, true)
  assert.equal(
    evalWhen(parseWhen('message.hasMedia'), {
      message: { hasMedia: withDeferredMedia.hasMedia === true, hasForward: false },
      event: { poke: false },
      channel: { kind: 'group' },
    }),
    true,
  )
})

test('FetchOptions supports optional redirect policy', () => {
  const defaultOpts: FetchOptions = { method: 'POST', body: '{}' }
  const followOpts: FetchOptions = { method: 'GET', redirect: 'follow' }
  const strictOpts: FetchOptions = { method: 'POST', redirect: 'error', timeoutMs: 5000 }

  assert.equal(defaultOpts.redirect, undefined)
  assert.equal(followOpts.redirect, 'follow')
  assert.equal(strictOpts.redirect, 'error')
})

test('WebSocket subscription contracts cover auth, options, events, and PluginHttp.subscribeWebSocket', async () => {
  const auth: WebSocketAuthOptions = {
    secretNames: ['qq-ws-token', 'qq-ws-token-alt'],
    transport: 'header',
    paramName: 'Authorization',
  }
  const options: WebSocketSubscribeOptions = {
    configKey: 'wsUrl',
    url: 'ws://127.0.0.1:3001',
    auth,
    timeoutMs: 10000,
    maxMessageBytes: 1024 * 1024,
    maxQueueLength: 256,
  }
  const events: WebSocketEvent[] = [
    { type: 'open' },
    { type: 'message', data: '{"post_type":"meta_event"}' },
    { type: 'close', code: 1000, reason: 'normal closure' },
    { type: 'error', code: 'PAYLOAD_TOO_LARGE', reason: 'frame exceeds 1 MiB' },
  ]

  const received: WebSocketEvent[] = []
  let disposed = false
  const subscribeWebSocket: NonNullable<PluginHttp['subscribeWebSocket']> = async (opts, listener) => {
    assert.equal(opts.configKey, 'wsUrl')
    assert.equal(opts.auth?.secretNames[0], 'qq-ws-token')
    for (const event of events) {
      await listener(event)
    }
    return () => {
      disposed = true
    }
  }

  const stop = await subscribeWebSocket(options, (event) => {
    received.push(event)
  })
  stop()

  assert.equal(received.length, 4)
  assert.equal(received[1]?.type, 'message')
  assert.equal(received[3]?.type === 'error' ? received[3].code : undefined, 'PAYLOAD_TOO_LARGE')
  assert.equal(disposed, true)
})

test('manifest permissions for WebSocket subscription and readChannelEvent validate cleanly', () => {
  assert.deepEqual(parsePermission('lan:config:wsUrl'), { kind: 'lan-config', key: 'wsUrl' })
  assert.deepEqual(parsePermission('network:config:wsUrl'), { kind: 'network-config', key: 'wsUrl' })

  const manifestResult = validateManifest({
    id: 'qq',
    kinds: ['channel'],
    api: '^1.0.0',
    runtime: 'process',
    process: { command: 'node', args: ['src/index.ts'] },
    permissions: [
      'memory.ingest',
      'memory.search',
      'tools.register',
      'channel.provide',
      'channel.send',
      'lan:config:wsUrl',
      'secrets:qq-ws-token',
    ],
    source: {
      channels: ['qq:private:*', 'qq:group:*'],
      eventKinds: ['qq.message'],
      defaultVisibility: 'origin',
      trust: 'external',
    },
    groups: {
      media: { summary: '媒体按需查看' },
    },
    tools: [
      {
        name: 'get_message_images',
        effect: 'read',
        load: 'context',
        group: 'media',
        when: 'message.hasMedia',
        summary: '查看消息图片',
      },
    ],
  })

  assert.equal(manifestResult.ok, true)
})
