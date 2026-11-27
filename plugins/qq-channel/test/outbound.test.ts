// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BrainError } from '@dsh-brain-core/sdk'
import { DEFAULT_QQ_CONFIG } from '../src/config.ts'
import { SendRateLimit } from '../src/outbound/rate-limit.ts'
import { sensitiveReason } from '../src/outbound/sensitive.ts'
import { plainQqText, splitText } from '../src/outbound/split.ts'
import { QqSender, SentMessageError } from '../src/outbound/sender.ts'

test('sensitive content and surrogate-safe splitting', () => {
  assert.equal(sensitiveReason('Bearer token'), 'credential')
  assert.equal(sensitiveReason('prefix secret', ['secret']), 'secret')
  assert.deepEqual(splitText('abc😀x', 4), ['abc', '😀x'])
  assert.equal(plainQqText('## 状态\n**通过**\n```js\n  a ** b\n```'), '状态\n通过\n  a ** b\n')
})
test('rechecks access and rolls back unsent reservations', async () => {
  const config = { ...DEFAULT_QQ_CONFIG, allowPrivate: ['12345'], send: { ...DEFAULT_QQ_CONFIG.send, maxPerMinute: 2, maxPerHour: 2 } }
  let active = true
  const sends: unknown[] = [], records: unknown[] = []
  const sender = new QqSender({ config: () => config, secrets: async () => [], canSend: () => active, hasSeenMessage: () => true, action: async (_name, params) => { sends.push(params); return { message_id: sends.length } }, ingest: async (event) => { records.push(event) }, sleep: async () => { active = false } })
  await assert.rejects(sender.send({ channel: 'qq:private:12345', messages: ['one', 'two'] }), (error: unknown) => {
    assert.ok(error instanceof SentMessageError)
    assert.deepEqual(error.deliveredIds, ['1'])
    return true
  })
  assert.equal(sends.length, 1); assert.equal(records.length, 1)
  active = true
  await sender.send({ channel: 'qq:private:12345', messages: ['three'] })
  await assert.rejects(sender.send({ channel: 'qq:private:12345', messages: ['four'] }), /Rate limit/)
})
test('rejects invalid mentions, cross-channel replies and secrets before sending', async () => {
  const config = { ...DEFAULT_QQ_CONFIG, allowGroups: ['12345'] }
  const sender = new QqSender({ config: () => config, secrets: async () => ['secret'], canSend: () => true, hasSeenMessage: () => false, action: async () => { throw Error('unexpected send') }, ingest: async () => {} })
  await assert.rejects(sender.send({ channel: 'qq:group:12345', messages: ['hi'], atUserId: 'all' }), /mention/)
  await assert.rejects(sender.send({ channel: 'qq:group:12345', messages: ['hi'], replyToMessageId: '-10' }), /reply/)
  await assert.rejects(sender.send({ channel: 'qq:group:12345', messages: ['secret'] }), /Sensitive/)
})

test('sticker notes require visible same-channel media evidence', async () => {
  const { StickerLibrary } = await import('../src/outbound/stickers.ts')
  const records: unknown[] = []
  const evidence = { id: 'l0_a', layer: 'L0', channel: 'qq:group:12345', status: 'active', content: { media: [{ emojiId: 'sticker1' }] } }
  const lib = new StickerLibrary({ action: async () => [], storage: { read: async () => undefined, write: async () => {} }, memory: { search: async () => ({ items: [], degraded: false }), readChannelEvent: async () => ({ record: evidence, disclosure: { speakable: 'yes', label: '' } }) as never, record: async (value) => { records.push(value); return {} as never } } })
  const call = { channel: 'qq:group:12345' } as never
  await assert.rejects(lib.note('other', 'l0_a', 'note', [], call), /NOT_FOUND/)
  await lib.note('sticker1', 'l0_a', 'note', [], call)
  assert.equal(records.length, 1)
  await assert.rejects(lib.note('sticker1', 'l0_a', 'note', [], { channel: 'qq:group:99999' } as never), /NOT_FOUND/)
})
test('voice is disabled by default and forbids traversal', async () => {
  const { VoiceLibrary } = await import('../src/outbound/voice.ts')
  let enabled = false
  const lib = new VoiceLibrary({ storage: { list: async () => [], read: async () => new Uint8Array([1]) }, settings: () => ({ ...DEFAULT_QQ_CONFIG.voice, enabled, normalizeLoudness: false, verifyReadback: false }), probeDuration: async () => 1, send: async () => '1' })
  await assert.rejects(lib.send('qq:private:12345', 'a.wav'), /disabled/)
  enabled = true
  await assert.rejects(lib.send('qq:private:12345', '../a.wav'), /Invalid voice ID/)
  assert.deepEqual(await lib.send('qq:private:12345', 'a.wav'), { messageId: '1', verification: 'not_requested' })
})

test('same-channel sends serialize and cross-boundary secrets are blocked', async () => {
  const config = { ...DEFAULT_QQ_CONFIG, allowPrivate: ['12345'], send: { ...DEFAULT_QQ_CONFIG.send, hardSplitChars: 4 } }
  const order: string[] = []
  const sender = new QqSender({ config: () => config, secrets: async () => ['secret'], canSend: () => true, hasSeenMessage: () => false, action: async (_name, params) => { const value = params as { message: { data: { text: string } }[] }; order.push(value.message[0]!.data.text); await Promise.resolve(); return { message_id: order.length } }, ingest: async () => {} })
  await assert.rejects(sender.send({ channel: 'qq:private:12345', messages: ['xxsecret'] }), /Sensitive/)
  await Promise.all([sender.send({ channel: 'qq:private:12345', messages: ['one'] }), sender.send({ channel: 'qq:private:12345', messages: ['two'] })])
  assert.deepEqual(order, ['one', 'two'])
})

test('sticker cache excludes remote descriptions and URLs; collection is explicit and limited', async () => {
  const { StickerLibrary } = await import('../src/outbound/stickers.ts')
  let cache = '', calls = 0
  const record = { id: 'l0_a', layer: 'L0', channel: 'qq:group:12345', status: 'active', content: { media: [{ emojiId: 'sticker1' }] } }
  const lib = new StickerLibrary({ action: async () => [{ id: 'sticker1', url: 'https://x.qq.com/a?token=secret', description: 'global note' }], storage: { read: async () => undefined, write: async (_p, data) => { cache = String(data) } }, memory: { readChannelEvent: async () => ({ record }) as never, record: async () => ({} as never), search: async () => ({ items: [], degraded: false }) }, collect: async () => { calls++ }, collectPerMinute: 1, collectPerHour: 1 })
  await lib.list(); assert.equal(cache, '[{"id":"sticker1"}]')
  await lib.collect('sticker1', 'l0_a', { channel: 'qq:group:12345' } as never)
  await assert.rejects(lib.collect('sticker1', 'l0_a', { channel: 'qq:group:12345' } as never), /Rate limit/)
  assert.equal(calls, 1)
})
test('voice uses sender guard, limits, audit and same-channel readback', async () => {
  const config = { ...DEFAULT_QQ_CONFIG, allowGroups: ['12345'], voice: { ...DEFAULT_QQ_CONFIG.voice, enabled: true, maxPerMinute: 1 } }
  let sends = 0, records = 0
  const sender = new QqSender({ config: () => config, secrets: async () => [], canSend: () => true, hasSeenMessage: () => false, action: async (action) => { if (action === 'get_msg') return { message_id: 1, message_type: 'group', group_id: 12345, message: [{ type: 'record' }] }; sends++; return { message_id: 1 } }, ingest: async () => { records++ } })
  const segment = { type: 'record' as const, data: { file: 'base64://YQ==' } }
  await assert.rejects(sender.readSentRecord('qq:group:99999', '1'), /NOT_FOUND/)
  assert.equal(await sender.sendRecord('qq:group:12345', segment), '1')
  await sender.readSentRecord('qq:group:12345', '1')
  await assert.rejects(sender.sendRecord('qq:group:12345', segment), /Rate limit/)
  assert.equal(sends, 1); assert.equal(records, 1)
})

test('voice readback failure reports confirmed message instead of a send failure', async () => {
  const { VoiceLibrary } = await import('../src/outbound/voice.ts')
  const lib = new VoiceLibrary({ storage: { list: async () => [], read: async () => new Uint8Array([1]) }, settings: () => ({ ...DEFAULT_QQ_CONFIG.voice, enabled: true, normalizeLoudness: false, verifyReadback: true }), probeDuration: async () => 1, send: async () => '-2', readSent: async () => { throw new Error('readback unavailable') } })
  assert.deepEqual(await lib.send('qq:private:12345', 'a.wav'), { messageId: '-2', verification: 'failed' })
})

test('confirmed voice exposes message ID when local audit fails', async () => {
  const { SentMessageError } = await import('../src/outbound/sender.ts')
  const config = { ...DEFAULT_QQ_CONFIG, allowPrivate: ['12345'], voice: { ...DEFAULT_QQ_CONFIG.voice, enabled: true } }
  const sender = new QqSender({ config: () => config, secrets: async () => [], canSend: () => true, hasSeenMessage: () => false, action: async () => ({ message_id: -42 }), ingest: async () => { throw new Error('unavailable') } })
  await assert.rejects(sender.sendRecord('qq:private:12345', { type: 'record', data: { file: 'base64://YQ==' } }), (error: unknown) => error instanceof SentMessageError && error.sent && error.messageId === '-42')
})

test('confirmed messages notify self-message index and voice readback removes raw fields', async () => {
  const config = { ...DEFAULT_QQ_CONFIG, allowGroups: ['12345'], voice: { ...DEFAULT_QQ_CONFIG.voice, enabled: true } }
  const noted: string[] = []
  const sender = new QqSender({ config: () => config, secrets: async () => [], canSend: () => true, hasSeenMessage: () => true, noteSelfMessage: (channel, id) => { noted.push(`${channel}:${id}`) }, action: async (action) => action === 'get_msg' ? { message_id: -7, message_type: 'group', group_id: 12345, message: [{ type: 'record', data: { file: 'private' } }], secret: 'private' } : { message_id: -7 }, ingest: async () => {} })
  await sender.sendRecord('qq:group:12345', { type: 'record', data: { file: 'base64://YQ==' } })
  assert.deepEqual(noted, ['qq:group:12345:-7'])
  assert.deepEqual(await sender.readSentRecord('qq:group:12345', '-7'), { message_id: '-7', message: [{ type: 'record' }] })
})

test('sensitiveReason and QqSender block all path, credential, URL-encoded, and markdown-obfuscated leaks', async () => {
  const cases: readonly { readonly text: string; readonly expected: string; readonly secrets?: readonly string[] }[] = [
    { text: '/Users/alice/x', expected: 'local path' },
    { text: '/home/bob/y', expected: 'local path' },
    { text: 'C:\\Users\\bob\\z', expected: 'local path' },
    { text: '.dsh/config', expected: 'local path' },
    { text: 'sk-1234567890', expected: 'credential' },
    { text: 'Bearer secret', expected: 'credential' },
    { text: 'access_token=abc', expected: 'credential' },
    { text: '"access_token": "abc"', expected: 'credential' },
    { text: 'cookie: sid=1', expected: 'credential' },
    { text: '50% off %2FUsers%2Falice', expected: 'local path' },
    { text: '50% %2FUsers%2Falice', expected: 'local path' },
    { text: 'query=access_token%3Dabc', expected: 'credential' },
    { text: 'token=tok%2Ben%2F1%3D', expected: 'secret', secrets: ['tok+en/1='] },
  ]
  for (const item of cases) {
    const reason = sensitiveReason(item.text, item.secrets)
    assert.equal(reason, item.expected, `failed for ${item.text}`)
    assert.ok(!reason!.includes(item.text))
  }
  assert.equal(sensitiveReason('50% off today'), undefined)

  const config = { ...DEFAULT_QQ_CONFIG, allowGroups: ['12345'] }
  let actionCalls = 0
  const sender = new QqSender({
    config: () => config,
    secrets: async () => ['tok+en/1='],
    canSend: () => true,
    hasSeenMessage: () => false,
    action: async () => { actionCalls++; return { message_id: 1 } },
    ingest: async () => {},
  })
  for (const item of [...cases, { text: 'sk-**abc**', expected: 'credential' }]) {
    await assert.rejects(sender.send({ channel: 'qq:group:12345', messages: [item.text] }), /Sensitive/)
  }
  assert.equal(actionCalls, 0)
})

test('QqSender rejects private atUserId and group @all directly', async () => {
  const config = { ...DEFAULT_QQ_CONFIG, allowPrivate: ['12345'], allowGroups: ['12345'] }
  const sender = new QqSender({
    config: () => config,
    secrets: async () => [],
    canSend: () => true,
    hasSeenMessage: () => false,
    action: async () => { throw new Error('unexpected send') },
    ingest: async () => {},
  })
  await assert.rejects(sender.send({ channel: 'qq:private:12345', messages: ['hi'], atUserId: '123456' }), /mention/)
  await assert.rejects(sender.send({ channel: 'qq:group:12345', messages: ['hi'], atUserId: 'all' }), /mention/)
})

test('SendRateLimit enforces hourly cap independently of minute cap', () => {
  let now = 0
  const limiter = new SendRateLimit(3, 4, () => now)
  const r1 = limiter.reserve('qq:group:1', 3)
  for (let i = 0; i < 3; i++) r1.sent()
  assert.throws(() => limiter.reserve('qq:group:1', 1), /Rate limit/)

  // Advance >1 minute: minute window resets, hourly window still holds 3 entries.
  now += 61_000
  const r2 = limiter.reserve('qq:group:1', 1)
  r2.sent()
  assert.throws(() => limiter.reserve('qq:group:1', 1), /Rate limit/)

  // Advance past 1 hour from initial burst: initial 3 expire, leaving 1 from t=61_000.
  now = 3_600_001
  const r3 = limiter.reserve('qq:group:1', 3)
  r3.rollback()
  const r4 = limiter.reserve('qq:group:1', 3)
  for (let i = 0; i < 3; i++) r4.sent()
  assert.throws(() => limiter.reserve('qq:group:1', 1), /Rate limit/)
})

test('VoiceLibrary enforces 300s duration, 4 MiB raw ceiling, and 8 MiB double-base64 RPC budget', async () => {
  const { VoiceLibrary } = await import('../src/outbound/voice.ts')
  let sendCalls = 0
  let currentBytes = new Uint8Array(1024)
  let currentDuration = 10
  let normalizedBytes: Uint8Array | undefined
  let normalizeLoudness = false
  let settingsMaxBytes = 8 * 1024 * 1024
  let settingsMaxSeconds = 600

  const lib = new VoiceLibrary({
    storage: { list: async () => ['voices/a.wav'], read: async () => currentBytes },
    settings: () => ({
      ...DEFAULT_QQ_CONFIG.voice,
      enabled: true,
      maxBytes: settingsMaxBytes,
      maxSeconds: settingsMaxSeconds,
      normalizeLoudness,
      verifyReadback: false,
    }),
    probeDuration: async () => currentDuration,
    normalize: async () => normalizedBytes ?? currentBytes,
    send: async () => { sendCalls++; return '1' },
  })

  // OUT-19: >300s rejected even if settings.maxSeconds is larger; 300s allowed.
  currentDuration = 301
  await assert.rejects(lib.send('qq:private:12345', 'a.wav'), /Invalid voice duration/)
  currentDuration = 0
  await assert.rejects(lib.send('qq:private:12345', 'a.wav'), /Invalid voice duration/)
  currentDuration = 300
  await lib.send('qq:private:12345', 'a.wav')
  assert.equal(sendCalls, 1)

  // OUT-20: >4 MiB raw rejected even when settings.maxBytes is 8 MiB (both raw and post-normalization).
  currentDuration = 10
  currentBytes = new Uint8Array(4 * 1024 * 1024 + 1)
  await assert.rejects(lib.send('qq:private:12345', 'a.wav'), /too large/)
  currentBytes = new Uint8Array(1024)
  normalizeLoudness = true
  normalizedBytes = new Uint8Array(4 * 1024 * 1024 + 1)
  await assert.rejects(lib.send('qq:private:12345', 'a.wav'), /Normalized voice too large/)
  assert.equal(sendCalls, 1)

  // OUT-21: 4 MiB passes raw check and succeeds on normal channel, but rejects when double-base64 RPC line >= 8 MiB - 4096.
  normalizeLoudness = false
  normalizedBytes = undefined
  settingsMaxBytes = 4 * 1024 * 1024
  settingsMaxSeconds = 300
  currentBytes = new Uint8Array(4 * 1024 * 1024)
  await lib.send('qq:private:12345', 'a.wav')
  assert.equal(sendCalls, 2)
  await assert.rejects(lib.send(`qq:private:${'1'.repeat(800_000)}`, 'a.wav'), /RPC budget/)
  assert.equal(sendCalls, 2)
})

test('StickerLibrary.note writes full L2.3 origin record, trims tags, and rejects invisible/empty notes', async () => {
  const { StickerLibrary } = await import('../src/outbound/stickers.ts')
  const records: unknown[] = []
  const evidence = { id: 'l0_a', layer: 'L0', channel: 'qq:group:12345', status: 'active', content: { media: [{ emojiId: 'sticker1' }] } }
  const lib = new StickerLibrary({
    action: async () => [],
    storage: { read: async () => undefined, write: async () => {} },
    memory: {
      search: async () => ({ items: [], degraded: false }),
      readChannelEvent: async () => ({ record: evidence, disclosure: { speakable: 'yes', label: '' } }) as never,
      record: async (value) => { records.push(value); return {} as never },
    },
  })
  const call = { channel: 'qq:group:12345' } as never

  await assert.rejects(
    lib.note('sticker1', 'l0_a', '\u200b\n\u200f', ['tag'], call),
    (err: unknown) => err instanceof BrainError && err.code === 'INVALID_ARGUMENT',
  )
  assert.equal(records.length, 0)

  await lib.note('sticker1', 'l0_a', '  表示赞同\u200b\n ', [' 赞同\u200b ', '\u200f\n ', '', '  附议  '], call)
  assert.equal(records.length, 1)
  assert.deepEqual(records[0], {
    layer: 'L2',
    kind: 'l2.expression',
    channel: 'qq:group:12345',
    subjects: [],
    actor: 'self',
    content: { stickerId: 'sticker1', note: '表示赞同', tags: ['赞同', '附议'] },
    evidence: [{ id: 'l0_a' }],
    visibility: 'origin',
  })
})

test('StickerLibrary.list supports SnowLuma-style QQ CDN URL string arrays and keeps disk cache ID-only', async () => {
  const { StickerLibrary } = await import('../src/outbound/stickers.ts')
  let diskCache = ''
  const validUrl1 = 'https://p.qpic.cn/qq_expression/1000000001/1000000001_0_0_0_0123456789ABCDEF0123456789ABCDEF_0_0/0?token=secret-token#frag'
  const validUrl1Clean = 'https://p.qpic.cn/qq_expression/1000000001/1000000001_0_0_0_0123456789ABCDEF0123456789ABCDEF_0_0/0?token=secret-token'
  const validUrl2 = 'https://gxh.vip.qq.com/club/item/123.png'
  const lib = new StickerLibrary({
    action: async () => [
      validUrl1,
      validUrl1Clean, // duplicate after hash stripping -> deduplicated
      validUrl2,
      'https://evil.example/sticker.png',
      'https://p.qpic.cn.evil.test/sticker.png',
      'http://user:pass@p.qpic.cn/sticker.png',
      'https://p.qpic.cn:8443/sticker.png',
      'file:///etc/passwd',
      'not-a-url',
      `https://p.qpic.cn/${'a'.repeat(4100)}`,
    ],
    storage: { read: async () => undefined, write: async (_path, data) => { diskCache = String(data) } },
    memory: { readChannelEvent: async () => ({} as never), record: async () => ({} as never), search: async () => ({ items: [], degraded: false }) },
  })

  const first = await lib.list()
  assert.equal(first.length, 2)
  assert.match(first[0]!.id, /^cf_[0-9a-f]{24}$/)
  assert.equal(first[0]!.url, validUrl1Clean)
  assert.match(first[1]!.id, /^cf_[0-9a-f]{24}$/)
  assert.equal(first[1]!.url, validUrl2)
  assert.notEqual(first[0]!.id, first[1]!.id)

  // Deterministic across refreshes and available in detail() even if detail RPC is unsupported.
  const refreshed = await lib.list(true)
  assert.deepEqual(refreshed, first)
  assert.deepEqual(await lib.detail(first[0]!.id), first[0])

  // Security rule: disk cache must strictly persist { id } only, zero URLs or tokens.
  assert.equal(diskCache, JSON.stringify([{ id: first[0]!.id }, { id: first[1]!.id }]))
  assert.ok(!diskCache.includes('http'))
  assert.ok(!diskCache.includes('qpic.cn'))
  assert.ok(!diskCache.includes('qq.com'))
  assert.ok(!diskCache.includes('secret-token'))
})
