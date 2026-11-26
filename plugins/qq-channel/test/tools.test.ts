// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createSocialStateMachine } from '@brain-core/chat-kit'
import {
  BrainError,
  type ChannelEventResult,
  type Disclosure,
  type MemoryRecord,
  type PluginHttp,
  type ToolCallContext,
  type ToolDefinition,
} from '@brain-core/sdk'
import { DEFAULT_QQ_CONFIG, type QqConfig } from '../src/config.ts'
import { MediaStore } from '../src/inbound/media-store.ts'
import { OneBotHttpError } from '../src/onebot/http-client.ts'
import { QqSender, SentMessageError } from '../src/outbound/sender.ts'
import { StickerLibrary } from '../src/outbound/stickers.ts'
import { VoiceLibrary } from '../src/outbound/voice.ts'
import { QQ_TOOL_NAMES, registerQqTools, type GroupMemberInfo, type QqToolsDeps } from '../src/tools/index.ts'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXxkAAAAASUVORK5CYII=',
  'base64',
)

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'l0_1',
    layer: 'L0',
    kind: 'qq.message',
    source: 'qq',
    channel: 'qq:group:10001',
    subjects: ['person_1'],
    actor: 'person_1',
    content: { direction: 'inbound', text: 'hello' },
    evidence: [],
    visibility: 'origin',
    trust: 'external',
    confidence: 1,
    importance: 0.5,
    tEvent: 1_700_000_000_000,
    tIngest: 1_700_000_000_000,
    status: 'active',
    version: 1,
    ...overrides,
  }
}

interface Harness {
  readonly tools: Map<string, ToolDefinition>
  readonly dispose: () => void
  readonly mediaStore: MediaStore
  readonly socialState: ReturnType<typeof createSocialStateMachine>
  readonly memoryRecords: Map<string, ChannelEventResult>
  readonly ingested: unknown[]
  readonly recorded: unknown[]
  readonly actionCalls: { name: string; params: unknown }[]
  readonly fetchCalls: { url: string; options: unknown }[]
  readonly seenMessages: Set<string>
  setConfig: (patch: Partial<QqConfig>) => void
  setDisposed: (value: boolean) => void
  setCanSend: (value: boolean) => void
  setNow: (value: number) => void
}

function createHarness(options: {
  readonly config?: Partial<QqConfig>
  readonly collectAdapter?: (stickerId: string) => Promise<void>
  readonly sendStickerImpl?: QqToolsDeps['sendSticker']
  readonly listGroupMembersImpl?: QqToolsDeps['listGroupMembers']
  readonly recentSpeakersImpl?: QqToolsDeps['recentSpeakers']
  readonly fetchImpl?: PluginHttp['fetch']
  readonly actionImpl?: (name: string, params?: unknown) => Promise<unknown>
  readonly voiceFiles?: ReadonlyMap<string, Uint8Array>
} = {}): Harness {
  let currentConfig: QqConfig = {
    ...DEFAULT_QQ_CONFIG,
    allowPrivate: ['20001'],
    allowGroups: ['10001'],
    ...options.config,
  }
  let disposed = false
  let canSendFlag = true
  let currentNow = 1_700_000_000_000

  const tools = new Map<string, ToolDefinition>()
  const mediaStore = new MediaStore()
  const socialState = createSocialStateMachine({
    clock: { now: () => currentNow },
    defaultConfig: currentConfig.wake,
  })
  const memoryRecords = new Map<string, ChannelEventResult>()
  const ingested: unknown[] = []
  const recorded: unknown[] = []
  const actionCalls: { name: string; params: unknown }[] = []
  const fetchCalls: { url: string; options: unknown }[] = []
  const seenMessages = new Set<string>(['qq:group:10001:101', 'qq:private:20001:201'])
  const storageFiles = new Map<string, Uint8Array>()
  for (const [k, v] of options.voiceFiles ?? []) {
    storageFiles.set(`voices/${k}`, v)
  }

  const action = async (name: string, params?: unknown): Promise<unknown> => {
    actionCalls.push({ name, params })
    if (options.actionImpl) return options.actionImpl(name, params)
    return { message_id: actionCalls.length }
  }

  const httpFetch: PluginHttp['fetch'] = async (url, fetchOptions) => {
    fetchCalls.push({ url, options: fetchOptions })
    if (options.fetchImpl) return options.fetchImpl(url, fetchOptions)
    return {
      status: 200,
      headers: {},
      text: () => '',
      bytes: () => new Uint8Array(TINY_PNG),
    }
  }

  const memory = {
    ingest: async (event: unknown) => {
      ingested.push(event)
      return { id: `l0_ingested_${ingested.length}` }
    },
    readChannelEvent: async (recordId: string, call: ToolCallContext): Promise<ChannelEventResult> => {
      const entry = memoryRecords.get(recordId)
      if (!entry || entry.record.channel !== call.channel || entry.record.status !== 'active') {
        throw new BrainError('NOT_FOUND', 'not found')
      }
      return entry
    },
    record: async (input: unknown) => {
      recorded.push(input)
      return makeRecord({ id: `l2_${recorded.length}`, layer: 'L2', kind: 'l2.expression' })
    },
    search: async (req: { query: string; scope: string; layers?: readonly string[] }, view?: { channel?: string }) => {
      const items = recorded
        .filter((item): item is { channel: string; kind: string; content: Record<string, unknown> } =>
          !!item && typeof item === 'object')
        .filter((item) => item.channel === view?.channel && item.kind === 'l2.expression')
        .map((item, index) => ({
          record: makeRecord({
            id: `l2_hit_${index}`,
            layer: 'L2',
            kind: 'l2.expression',
            channel: item.channel,
            content: item.content,
          }),
          disclosure: { speakable: 'yes' as const, label: '本通道学到的表情含义' },
          score: 1,
        }))
      return { items, degraded: false }
    },
  }

  const storage = {
    read: async (file: string) => storageFiles.get(file),
    write: async (file: string, data: string | Uint8Array) => {
      storageFiles.set(file, typeof data === 'string' ? new TextEncoder().encode(data) : data)
    },
    list: async (prefix = '') => [...storageFiles.keys()].filter((k) => k.startsWith(prefix)).sort(),
  }

  const sender = new QqSender({
    config: () => currentConfig,
    secrets: async () => ['top-secret-token'],
    canSend: () => canSendFlag,
    hasSeenMessage: (channel, msgId) => seenMessages.has(`${channel}:${msgId}`),
    action,
    ingest: memory.ingest,
    noteSelfMessage: (channel, msgId) => {
      seenMessages.add(`${channel}:${msgId}`)
    },
    sleep: async () => {},
    now: () => currentNow,
  })

  const stickerLibrary = new StickerLibrary({
    action,
    storage,
    memory,
    collect: options.collectAdapter,
    now: () => currentNow,
  })

  const voiceLibrary = new VoiceLibrary({
    storage,
    settings: () => currentConfig.voice,
    probeDuration: async () => 2,
    normalize: async (bytes) => bytes,
    send: async (channel, segment) => sender.sendRecord(channel, segment),
    readSent: async (channel, messageId) => sender.readSentRecord(channel, messageId),
  })

  const deps: QqToolsDeps = {
    config: () => currentConfig,
    canSend: () => canSendFlag,
    isDisposed: () => disposed,
    getSelfId: () => '99999',
    action,
    httpFetch,
    memory,
    mediaStore,
    socialState,
    sender,
    sendSticker: options.sendStickerImpl ?? (async () => '7001'),
    recentSpeakers: options.recentSpeakersImpl ?? (async () => []),
    listGroupMembers: options.listGroupMembersImpl ?? (async () => []),
    hasSeenMessage: (channel, msgId) => seenMessages.has(`${channel}:${msgId}`),
    noteSelfMessage: (channel, msgId) => {
      seenMessages.add(`${channel}:${msgId}`)
    },
    stickerLibrary,
    voiceLibrary,
    now: () => currentNow,
  }

  const dispose = registerQqTools(
    {
      tools: {
        register: (tool) => {
          tools.set(tool.name, tool)
          return () => {
            tools.delete(tool.name)
          }
        },
      },
    },
    deps,
  )

  return {
    tools,
    dispose,
    mediaStore,
    socialState,
    memoryRecords,
    ingested,
    recorded,
    actionCalls,
    fetchCalls,
    seenMessages,
    setConfig: (patch) => {
      currentConfig = { ...currentConfig, ...patch }
    },
    setDisposed: (value) => {
      disposed = value
    },
    setCanSend: (value) => {
      canSendFlag = value
    },
    setNow: (value) => {
      currentNow = value
    },
  }
}

test('registers exact 14 manifest tools with object root parameters and cleans up on dispose', async () => {
  const pkg = JSON.parse(await readFile(path.join(PLUGIN_ROOT, 'package.json'), 'utf8')) as {
    brain: { tools: { name: string }[] }
  }
  const manifestNames = pkg.brain.tools.map((t) => t.name)
  const h = createHarness()

  assert.deepEqual([...h.tools.keys()], manifestNames)
  assert.deepEqual([...h.tools.keys()], [...QQ_TOOL_NAMES])
  assert.equal(h.tools.size, 14)

  for (const tool of h.tools.values()) {
    assert.ok(!tool.name.startsWith('qq__'))
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.parameters.properties, 'object')
  }

  h.setDisposed(true)
  await assert.rejects(
    h.tools.get('list_voices')!.handler({}, { channel: 'qq:group:10001', wakeId: 'w1' }),
    (err: unknown) => err instanceof BrainError && err.code === 'UNAVAILABLE',
  )

  h.dispose()
  assert.equal(h.tools.size, 0)
})

test('send_message handles normal send, validation, and partial SentMessageError', async () => {
  const h = createHarness()
  const tool = h.tools.get('send_message')!
  const call: ToolCallContext = { channel: 'qq:group:10001', wakeId: 'w1' }

  const okOut = await tool.handler({ messages: ['第一句', '第二句'], replyToMessageId: '101', atUserId: '123456', gapMode: 'fixed' }, call)
  assert.equal(typeof okOut, 'string')
  const okJson = JSON.parse(okOut as string) as { ok: boolean; deliveredMessageIds: string[]; count: number }
  assert.equal(okJson.ok, true)
  assert.equal(okJson.count, 2)
  assert.deepEqual(okJson.deliveredMessageIds, ['1', '2'])

  // Validation checks
  await assert.rejects(tool.handler({ messages: [] }, call), { code: 'INVALID_ARGUMENT' })
  await assert.rejects(tool.handler({ messages: ['hi'], atUserId: 'all' }, call), { code: 'INVALID_ARGUMENT' })
  await assert.rejects(
    tool.handler({ messages: ['hi'], atUserId: '123456' }, { channel: 'qq:private:20001', wakeId: 'w2' }),
    { code: 'INVALID_ARGUMENT' },
  )
  await assert.rejects(tool.handler({ messages: ['hi'], replyToMessageId: '999999' }, call), { code: 'INVALID_ARGUMENT' })
  await assert.rejects(tool.handler({ messages: ['top-secret-token'] }, call), { code: 'PERMISSION_DENIED' })
  await assert.rejects(
    tool.handler({ messages: ['hi'] }, { channel: 'qq:group:88888', wakeId: 'w3' }),
    { code: 'PERMISSION_DENIED' },
  )

  // Partial delivery via SentMessageError returns structured JSON warning instead of throwing
  let throwPartial = false
  const hPartial = createHarness({
    actionImpl: async () => {
      if (throwPartial) throw new Error('network failed with secret /Users/x/token')
      throwPartial = true
      return { message_id: 501 }
    },
  })
  const partialOut = await hPartial.tools.get('send_message')!.handler({ messages: ['a', 'b'] }, call)
  const partialJson = JSON.parse(partialOut as string) as {
    ok: boolean
    partial: boolean
    sent: boolean
    deliveredMessageIds: string[]
    lastMessageId: string
    warning: string
  }
  assert.equal(partialJson.ok, false)
  assert.equal(partialJson.partial, true)
  assert.equal(partialJson.sent, true)
  assert.deepEqual(partialJson.deliveredMessageIds, ['501'])
  assert.equal(partialJson.lastMessageId, '501')
  assert.match(partialJson.warning, /部分气泡已送达/)

  // Duck-typed SentMessageError object
  const hDuck = createHarness()
  const duckTools = new Map<string, ToolDefinition>()
  registerQqTools(
    { tools: { register: (t) => { duckTools.set(t.name, t); return () => {} } } },
    {
      config: () => ({ ...DEFAULT_QQ_CONFIG, allowGroups: ['10001'] }),
      canSend: () => true,
      isDisposed: () => false,
      getSelfId: () => '99999',
      action: async () => ({}),
      httpFetch: async () => ({ status: 200, headers: {}, text: () => '', bytes: () => new Uint8Array() }),
      memory: { ingest: async () => ({ id: '1' }) },
      mediaStore: hDuck.mediaStore,
      socialState: hDuck.socialState,
      sender: {
        send: async () => {
          throw Object.assign(new Error('partial'), { sent: true, messageId: '888', deliveredIds: ['887', '888'] })
        },
      },
      sendSticker: async () => '1',
      recentSpeakers: async () => [],
      listGroupMembers: async () => [],
      hasSeenMessage: () => true,
      noteSelfMessage: () => {},
      stickerLibrary: { list: async () => [], detail: async () => undefined, collect: async () => {}, meanings: async () => [], note: async () => {} },
      voiceLibrary: { list: async () => [], send: async () => ({ messageId: '1', verification: 'not_requested' }) },
    },
  )
  const duckJson = JSON.parse(await duckTools.get('send_message')!.handler({ messages: ['x'] }, call) as string) as {
    ok: boolean; partial: boolean; sent: boolean; deliveredMessageIds: string[]; lastMessageId: string
  }
  assert.equal(duckJson.partial, true)
  assert.deepEqual(duckJson.deliveredMessageIds, ['887', '888'])
  assert.equal(duckJson.lastMessageId, '888')
})

test('set_wake_config enforces group scope, owner replyProbability cap, bounds, and immutable owner budgets', async () => {
  const h = createHarness({
    config: {
      wake: {
        ...DEFAULT_QQ_CONFIG.wake,
        replyProbability: 0.25,
        maxWakePerHour: 12,
        minWakeIntervalMs: 15_000,
      },
    },
  })
  const tool = h.tools.get('set_wake_config')!
  const groupCall: ToolCallContext = { channel: 'qq:group:10001', wakeId: 'w1' }

  // Disallowed in private or unlisted group
  await assert.rejects(
    tool.handler({ mode: 'active' }, { channel: 'qq:private:20001', wakeId: 'w1' }),
    { code: 'PERMISSION_DENIED' },
  )
  await assert.rejects(
    tool.handler({ mode: 'active' }, { channel: 'qq:group:99999', wakeId: 'w1' }),
    { code: 'PERMISSION_DENIED' },
  )

  // Exceeding owner replyProbability cap throws INVALID_ARGUMENT
  await assert.rejects(tool.handler({ replyProbability: 0.5 }, groupCall), { code: 'INVALID_ARGUMENT' })

  // Bounds checks
  await assert.rejects(tool.handler({ activeWindowMs: 9_999 }, groupCall), { code: 'INVALID_ARGUMENT' })
  await assert.rejects(tool.handler({ activeWindowMs: 3_600_001 }, groupCall), { code: 'INVALID_ARGUMENT' })
  await assert.rejects(tool.handler({ lurkAfterMs: 29_999 }, groupCall), { code: 'INVALID_ARGUMENT' })
  await assert.rejects(tool.handler({ lurkAfterMs: 86_400_001 }, groupCall), { code: 'INVALID_ARGUMENT' })

  // Cannot override owner maxWakePerHour / minWakeIntervalMs
  await assert.rejects(tool.handler({ maxWakePerHour: 999 }, groupCall), { code: 'INVALID_ARGUMENT' })
  await assert.rejects(tool.handler({ minWakeIntervalMs: 0 }, groupCall), { code: 'INVALID_ARGUMENT' })

  // Valid update cleans keywords (max 32 items, max 32 chars each) and updates state
  const manyKeywords = Array.from({ length: 40 }, (_, i) => `\u200bkw_${i}_${'a'.repeat(40)}\u200b`)
  const out = JSON.parse(await tool.handler({
    mode: 'active',
    groupTrigger: 'keyword',
    keywords: ['  ', ...manyKeywords],
    activeWindowMs: 60_000,
    lurkAfterMs: 120_000,
    replyProbability: 0.2,
  }, groupCall) as string) as {
    ok: boolean; mode: string; groupTrigger: string; keywords: string[]; replyProbability: number
  }
  assert.equal(out.ok, true)
  assert.equal(out.mode, 'active')
  assert.equal(out.groupTrigger, 'keyword')
  assert.equal(out.replyProbability, 0.2)
  assert.equal(out.keywords.length, 32)
  assert.ok(out.keywords.every((k) => [...k].length <= 32 && !k.includes('\u200b')))

  const state = h.socialState.getState('qq:group:10001')
  assert.equal(state.config.maxWakePerHour, 12)
  assert.equal(state.config.minWakeIntervalMs, 15_000)
})

test('get_message_images validates L0 visibility, passes disclosure, handles cross-channel/recall/forget, and writes zero memory', async () => {
  let tombstoneDuringFetch = false
  const disclosure: Disclosure = { speakable: 'if-subject-raises', label: '本群听说' }
  const h = createHarness({
    actionImpl: async (name) => {
      if (name === 'get_image') return { url: 'https://gchat.qpic.cn/gchatpic_new/123.png' }
      return {}
    },
    fetchImpl: async () => ({
      status: 200,
      headers: {},
      text: () => '',
      bytes: () => {
        if (tombstoneDuringFetch) {
          h.memoryRecords.set(record.id, { record: { ...record, status: 'tombstoned' }, disclosure })
        }
        return new Uint8Array(TINY_PNG)
      },
    }),
  })
  const tool = h.tools.get('get_message_images')!
  const call: ToolCallContext = { channel: 'qq:group:10001', wakeId: 'w1' }

  const record = makeRecord({ id: 'l0_img_1', channel: 'qq:group:10001' })
  h.memoryRecords.set(record.id, { record, disclosure })
  h.mediaStore.put('qq:group:10001', '301', {
    recordId: record.id,
    media: [{ type: 'image', file: 'abc.png', url: 'https://gchat.qpic.cn/fallback.png' }],
    forwardIds: [],
  })

  const output = await tool.handler({ messageId: '301' }, call)
  assert.equal(typeof output, 'object')
  const obj = output as { text: string; images?: { mediaType: string; base64: string }[] }
  const meta = JSON.parse(obj.text) as { source: string; disclosure: Disclosure; note: string }
  assert.equal(meta.source, 'QQ 消息图片（外部内容）')
  assert.deepEqual(meta.disclosure, disclosure)
  assert.equal(obj.images?.length, 1)
  assert.equal(obj.images?.[0]?.mediaType, 'image/png')
  assert.equal(h.ingested.length, 0)
  assert.equal(h.recorded.length, 0)

  // Cross-channel -> NOT_FOUND
  await assert.rejects(
    tool.handler({ messageId: '301' }, { channel: 'qq:group:10002', wakeId: 'w2' }),
    (err: unknown) => err instanceof BrainError && err.code === 'NOT_FOUND' && err.message === '找不到当前通道中的这条消息',
  )

  // TOCTOU tombstoning during fetchImpl -> NOT_FOUND
  tombstoneDuringFetch = true
  await assert.rejects(
    tool.handler({ messageId: '301' }, call),
    (err: unknown) => err instanceof BrainError && err.code === 'NOT_FOUND',
  )
  tombstoneDuringFetch = false

  // Forgotten (tombstoned) -> NOT_FOUND
  h.memoryRecords.set(record.id, { record: { ...record, status: 'tombstoned' }, disclosure })
  await assert.rejects(
    tool.handler({ messageId: '301' }, call),
    (err: unknown) => err instanceof BrainError && err.code === 'NOT_FOUND',
  )

  // RPC line > 8 MiB degrades wrapped payload to text without images
  h.memoryRecords.set(record.id, { record, disclosure: { speakable: 'yes', label: 'x'.repeat(8 * 1024 * 1024) } })
  const rpcOverflowOut = await tool.handler({ messageId: '301' }, call) as { text: string; images?: unknown[] }
  assert.equal(rpcOverflowOut.images, undefined)
  assert.match(rpcOverflowOut.text, /RPC 单行限制/)

  // Recalled -> NOT_FOUND
  h.memoryRecords.set(record.id, { record, disclosure })
  h.mediaStore.revoke('qq:group:10001', '301')
  await assert.rejects(
    tool.handler({ messageId: '301' }, call),
    (err: unknown) => err instanceof BrainError && err.code === 'NOT_FOUND',
  )

  // Invalid messageId -> INVALID_ARGUMENT
  await assert.rejects(tool.handler({ messageId: 'not-an-id' }, call), { code: 'INVALID_ARGUMENT' })
})

test('get_forward_msg expands authorized forward with disclosure, rejects unauthorized, and writes zero memory', async () => {
  const disclosure: Disclosure = { speakable: 'yes', label: '本群聊天' }
  const h = createHarness({
    actionImpl: async (name) => {
      if (name === 'get_forward_msg') {
        return { messages: [{ sender: { nickname: '群友A\u200b' }, message: '合并内容' }] }
      }
      return {}
    },
  })
  const tool = h.tools.get('get_forward_msg')!
  const call: ToolCallContext = { channel: 'qq:group:10001', wakeId: 'w1' }

  const record = makeRecord({ id: 'l0_fwd_1', channel: 'qq:group:10001' })
  h.memoryRecords.set(record.id, { record, disclosure })
  h.mediaStore.put('qq:group:10001', '401', {
    recordId: record.id,
    media: [],
    forwardIds: ['fwd_root'],
  })

  const res = JSON.parse(await tool.handler({ forwardId: 'fwd_root' }, call) as string) as {
    source: string; disclosure: Disclosure; messages: { name: string; text: string }[]
  }
  assert.match(res.source, /外部内容/)
  assert.deepEqual(res.disclosure, disclosure)
  assert.equal(res.messages[0]?.name, '群友A')
  assert.equal(res.messages[0]?.text, '合并内容')
  assert.equal(h.ingested.length, 0)
  assert.equal(h.recorded.length, 0)

  // Cross-channel & forgotten -> NOT_FOUND
  await assert.rejects(
    tool.handler({ forwardId: 'fwd_root' }, { channel: 'qq:private:20001', wakeId: 'w2' }),
    { code: 'NOT_FOUND' },
  )
  h.memoryRecords.delete(record.id)
  await assert.rejects(tool.handler({ forwardId: 'fwd_root' }, call), { code: 'NOT_FOUND' })
})

test('send_poke handles private/group targets, self check, fallback, rate limit, and writes qq.action L0', async () => {
  let failPrimary = false
  let authFail = false
  const h = createHarness({
    actionImpl: async (name) => {
      if (authFail) throw new OneBotHttpError('auth')
      if (failPrimary && (name === 'friend_poke' || name === 'group_poke')) {
        throw new OneBotHttpError('protocol')
      }
      return {}
    },
  })
  const tool = h.tools.get('send_poke')!
  const privCall: ToolCallContext = { channel: 'qq:private:20001', wakeId: 'w1' }
  const groupCall: ToolCallContext = { channel: 'qq:group:10001', wakeId: 'w2' }

  // Private default target is peer QQ
  const privOut = JSON.parse(await tool.handler({}, privCall) as string) as { ok: boolean; targetUserId: string }
  assert.equal(privOut.ok, true)
  assert.equal(privOut.targetUserId, '20001')
  assert.equal(h.actionCalls.at(-1)?.name, 'friend_poke')

  // Private rejects non-peer QQ
  await assert.rejects(tool.handler({ targetUserId: '30001' }, privCall), { code: 'PERMISSION_DENIED' })

  // Group rejects missing targetUserId and selfId
  await assert.rejects(tool.handler({}, groupCall), { code: 'INVALID_ARGUMENT' })
  await assert.rejects(tool.handler({ targetUserId: '99999' }, groupCall), { code: 'INVALID_ARGUMENT' })

  // Group valid target + fallback to send_poke
  failPrimary = true
  const grpOut = JSON.parse(await tool.handler({ targetUserId: '123456' }, groupCall) as string) as { ok: boolean }
  assert.equal(grpOut.ok, true)
  assert.equal(h.actionCalls.at(-2)?.name, 'group_poke')
  assert.equal(h.actionCalls.at(-1)?.name, 'send_poke')

  // Auth error must NOT fall back to send_poke
  const countBeforeAuth = h.actionCalls.length
  authFail = true
  await assert.rejects(tool.handler({ targetUserId: '123456' }, groupCall), { code: 'UNAVAILABLE' })
  assert.equal(h.actionCalls.length, countBeforeAuth + 1)
  authFail = false
  failPrimary = false

  // Verify L0 qq.action ingested
  assert.equal(h.ingested.length, 2)
  assert.deepEqual(h.ingested[0], {
    kind: 'qq.action',
    channel: 'qq:private:20001',
    subjects: [],
    actor: 'self',
    visibility: 'origin',
    content: { direction: 'outbound', action: 'poke', targetUserId: '20001' },
    tEvent: 1_700_000_000_000,
    idempotencyKey: 'qq:poke:qq:private:20001:20001:1700000000000:1',
  })

  // Rate limit: 6/minute per channel (groupCall already succeeded 1 time above -> 5 more succeed, 7th fails)
  for (let i = 0; i < 5; i++) {
    await tool.handler({ targetUserId: '123456' }, groupCall)
  }
  await assert.rejects(tool.handler({ targetUserId: '123456' }, groupCall), { code: 'RATE_LIMITED' })
})

test('get_group_members supports activeOnly, clamps limit 1..200, cleans text, and writes zero memory', async () => {
  const many: GroupMemberInfo[] = Array.from({ length: 210 }, (_, i) => ({
    userId: String(10000 + i),
    nickname: `nick\u200b${i}`,
    card: i === 0 ? '名片\x00测试' : undefined,
  }))
  const h = createHarness({
    listGroupMembersImpl: async () => many,
    recentSpeakersImpl: async () => [{ userId: '55555', displayName: '活跃\u200b群友', lastActiveAt: 123 }],
  })
  const tool = h.tools.get('get_group_members')!
  const groupCall: ToolCallContext = { channel: 'qq:group:10001', wakeId: 'w1' }

  await assert.rejects(
    tool.handler({}, { channel: 'qq:private:20001', wakeId: 'w1' }),
    { code: 'PERMISSION_DENIED' },
  )

  const defaultOut = JSON.parse(await tool.handler({}, groupCall) as string) as {
    members: { userId: string; displayName: string; card?: string }[]
  }
  assert.equal(defaultOut.members.length, 50)
  assert.equal(defaultOut.members[0]?.card, '名片测试')
  assert.equal(defaultOut.members[0]?.displayName, '名片测试')

  const clampedOut = JSON.parse(await tool.handler({ limit: 500 }, groupCall) as string) as { members: unknown[] }
  assert.equal(clampedOut.members.length, 200)

  const activeOut = JSON.parse(await tool.handler({ activeOnly: true }, groupCall) as string) as {
    activeOnly: boolean; members: { userId: string; displayName: string }[]
  }
  assert.equal(activeOut.activeOnly, true)
  assert.deepEqual(activeOut.members, [{ userId: '55555', displayName: '活跃群友', lastActiveAt: 123 }])
  assert.equal(h.ingested.length, 0)
  assert.equal(h.recorded.length, 0)
})

test('get_group_members sanitizes OneBotHttpError and plain Error to UNAVAILABLE while passing through BrainError', async () => {
  let nextError: unknown = new OneBotHttpError('http')
  const h = createHarness({
    listGroupMembersImpl: async () => {
      throw nextError
    },
  })
  const tool = h.tools.get('get_group_members')!
  const groupCall: ToolCallContext = { channel: 'qq:group:10001', wakeId: 'w1' }

  await assert.rejects(
    tool.handler({}, groupCall),
    (err: unknown) => err instanceof BrainError && err.code === 'UNAVAILABLE' && err.message === '读取群成员列表失败',
  )

  nextError = new Error('internal leak: token=super-secret-value')
  await assert.rejects(
    tool.handler({}, groupCall),
    (err: unknown) => err instanceof BrainError
      && err.code === 'UNAVAILABLE'
      && err.message === '读取群成员列表失败'
      && !err.message.includes('super-secret-value'),
  )

  nextError = new BrainError('RATE_LIMITED', '上游限流')
  await assert.rejects(
    tool.handler({}, groupCall),
    (err: unknown) => err instanceof BrainError && err.code === 'RATE_LIMITED' && err.message === '上游限流',
  )
})

test('list_stickers filters by query/meanings, excludes remote url/description, and writes zero memory', async () => {
  const h = createHarness({
    actionImpl: async (name) => {
      if (name === 'fetch_custom_face') {
        return [
          { id: 'stk_happy', url: 'https://gxh.vip.qq.com/secret.png', description: 'REMOTE_SECRET_DESC' },
          { id: 'stk_cry', url: 'https://gxh.vip.qq.com/cry.png', description: 'REMOTE_CRY_DESC' },
        ]
      }
      return {}
    },
  })
  const call: ToolCallContext = { channel: 'qq:group:10001', wakeId: 'w1' }
  const rec = makeRecord({ id: 'l0_s1', channel: 'qq:group:10001', content: { media: [{ emojiId: 'stk_cry' }] } })
  h.memoryRecords.set(rec.id, { record: rec, disclosure: { speakable: 'yes', label: '本群' } })

  // Reject control-char/zero-width/newline-only note before any memory write
  await assert.rejects(
    h.tools.get('sticker_note')!.handler({
      stickerId: 'stk_cry',
      evidenceRecordId: 'l0_s1',
      note: '\u200b\n\u200f',
      tags: ['委屈'],
    }, call),
    (err: unknown) => err instanceof BrainError && err.code === 'INVALID_ARGUMENT',
  )
  assert.equal(h.recorded.length, 0)

  await h.tools.get('sticker_note')!.handler({
    stickerId: 'stk_cry',
    evidenceRecordId: 'l0_s1',
    note: '  流泪猫猫头\u200b\n ',
    tags: [' 委屈\u200b ', '\u200f\n ', ''],
  }, call)
  const recordedCount = h.recorded.length
  assert.equal(recordedCount, 1)
  assert.deepEqual(h.recorded[0], {
    layer: 'L2',
    kind: 'l2.expression',
    channel: 'qq:group:10001',
    subjects: [],
    actor: 'self',
    content: { stickerId: 'stk_cry', note: '流泪猫猫头', tags: ['委屈'] },
    evidence: [{ id: 'l0_s1' }],
    visibility: 'origin',
  })

  const outText = await h.tools.get('list_stickers')!.handler({ query: '猫猫' }, call) as string
  assert.ok(!outText.includes('REMOTE_SECRET_DESC'))
  assert.ok(!outText.includes('REMOTE_CRY_DESC'))
  assert.ok(!outText.includes('https://'))
  const out = JSON.parse(outText) as { stickers: { stickerId: string; meanings: { note: string }[] }[] }
  assert.equal(out.stickers.length, 1)
  assert.equal(out.stickers[0]?.stickerId, 'stk_cry')
  assert.equal(out.stickers[0]?.meanings[0]?.note, '流泪猫猫头')
  assert.equal(h.recorded.length, recordedCount)
  assert.equal(h.ingested.length, 0)
})

test('get_sticker_image enforces QQ CDN allowlist, redirect:error, normalizes image, and degrades safely', async () => {
  const h = createHarness({
    actionImpl: async (name, params) => {
      if (name === 'fetch_custom_face') return [{ id: 'stk_ok' }, { id: 'stk_bad_url' }]
      if (name === 'fetch_custom_face_detail') {
        const id = (params as { id: string }).id
        return id === 'stk_ok'
          ? { id, url: 'https://p.qpic.cn/qq_sticker/1.png' }
          : { id, url: 'https://evil.example.com/1.png' }
      }
      return {}
    },
  })
  const tool = h.tools.get('get_sticker_image')!
  const call: ToolCallContext = { channel: 'qq:group:10001', wakeId: 'w1' }

  const ok = await tool.handler({ stickerId: 'stk_ok' }, call) as { text: string; images?: unknown[] }
  assert.equal(ok.images?.length, 1)
  assert.equal(h.fetchCalls.length, 1)
  assert.deepEqual(h.fetchCalls[0]?.options, { redirect: 'error', maxBytes: DEFAULT_QQ_CONFIG.media.maxDownloadBytes })

  const badUrlFallback = await tool.handler({ stickerId: 'stk_bad_url' }, call) as { text: string; images?: unknown[] }
  assert.equal(badUrlFallback.images, undefined)
  assert.equal(h.fetchCalls.length, 1) // Never fetched non-QQ host

  await assert.rejects(tool.handler({ stickerId: 'stk_missing' }, call), { code: 'NOT_FOUND' })
  await assert.rejects(tool.handler({ stickerId: '../bad' }, call), { code: 'INVALID_ARGUMENT' })
  assert.equal(h.ingested.length, 0)
})

test('send_sticker verifies existence, sends, and surfaces SentMessageError partial warning', async () => {
  let shouldPartial = false
  const h = createHarness({
    actionImpl: async (name) => name === 'fetch_custom_face' ? [{ id: 'stk_1' }] : {},
    sendStickerImpl: async () => {
      if (shouldPartial) throw new SentMessageError('9001')
      return '9000'
    },
  })
  const tool = h.tools.get('send_sticker')!
  const call: ToolCallContext = { channel: 'qq:group:10001', wakeId: 'w1' }

  const ok = JSON.parse(await tool.handler({ stickerId: 'stk_1', replyToMessageId: '101' }, call) as string) as {
    ok: boolean; messageId: string
  }
  assert.equal(ok.ok, true)
  assert.equal(ok.messageId, '9000')

  await assert.rejects(tool.handler({ stickerId: 'stk_unknown' }, call), { code: 'NOT_FOUND' })

  shouldPartial = true
  const partial = JSON.parse(await tool.handler({ stickerId: 'stk_1' }, call) as string) as {
    ok: boolean; partial: boolean; sent: boolean; messageId: string
  }
  assert.equal(partial.ok, false)
  assert.equal(partial.partial, true)
  assert.equal(partial.sent, true)
  assert.equal(partial.messageId, '9001')
})

test('collect_sticker and sticker_note validate same-channel L0 evidence and collect adapter status', async () => {
  const collected: string[] = []
  const call: ToolCallContext = { channel: 'qq:group:10001', wakeId: 'w1' }

  // Case 1: unconfigured collect adapter -> UNAVAILABLE
  const hUnconfigured = createHarness()
  const rec = makeRecord({
    id: 'l0_stk',
    channel: 'qq:group:10001',
    content: { media: [{ type: 'mface', emojiId: 'face_123', isMarketSticker: true }] },
  })
  hUnconfigured.memoryRecords.set(rec.id, { record: rec, disclosure: { speakable: 'yes', label: '本群' } })
  hUnconfigured.mediaStore.put('qq:group:10001', '601', {
    recordId: rec.id,
    media: [{ type: 'mface', emojiId: 'face_123' }],
    forwardIds: [],
  })

  await assert.rejects(
    hUnconfigured.tools.get('collect_sticker')!.handler({ messageId: '601' }, call),
    (err: unknown) => err instanceof BrainError && err.code === 'UNAVAILABLE' && err.message === '当前协议端未配置表情收藏动作',
  )

  // Case 2: configured collect adapter
  const hConfigured = createHarness({
    collectAdapter: async (id) => {
      collected.push(id)
    },
  })
  hConfigured.memoryRecords.set(rec.id, { record: rec, disclosure: { speakable: 'yes', label: '本群' } })
  hConfigured.mediaStore.put('qq:group:10001', '601', {
    recordId: rec.id,
    media: [{ type: 'mface', emojiId: 'face_123' }],
    forwardIds: [],
  })

  const collectOut = JSON.parse(await hConfigured.tools.get('collect_sticker')!.handler({ messageId: '601' }, call) as string) as {
    ok: boolean; stickerId: string; evidenceRecordId: string
  }
  assert.equal(collectOut.ok, true)
  assert.equal(collectOut.stickerId, 'face_123')
  assert.equal(collectOut.evidenceRecordId, 'l0_stk')
  assert.deepEqual(collected, ['face_123'])

  // collectEnabled=false rejected
  hConfigured.setConfig({ stickers: { ...DEFAULT_QQ_CONFIG.stickers, collectEnabled: false } })
  await assert.rejects(
    hConfigured.tools.get('collect_sticker')!.handler({ messageId: '601' }, call),
    { code: 'PERMISSION_DENIED' },
  )

  // sticker_note maps cross-channel / non-matching media to NOT_FOUND
  await assert.rejects(
    hConfigured.tools.get('sticker_note')!.handler({
      stickerId: 'wrong_id',
      evidenceRecordId: 'l0_stk',
      note: '含义',
    }, call),
    (err: unknown) => err instanceof BrainError && err.code === 'NOT_FOUND' && err.message === '找不到匹配的同通道 L0 表情证据',
  )
  await assert.rejects(
    hConfigured.tools.get('sticker_note')!.handler({
      stickerId: 'face_123',
      evidenceRecordId: 'l0_stk',
      note: '含义',
    }, { channel: 'qq:group:10002', wakeId: 'w2' }),
    (err: unknown) => err instanceof BrainError && err.code === 'NOT_FOUND',
  )

  // Missing memory.readChannelEvent throws UNAVAILABLE before param validation
  const legacyTools = new Map<string, ToolDefinition>()
  registerQqTools(
    { tools: { register: (t) => { legacyTools.set(t.name, t); return () => {} } } },
    {
      config: () => ({ ...DEFAULT_QQ_CONFIG, allowGroups: ['10001'] }),
      canSend: () => true,
      isDisposed: () => false,
      getSelfId: () => '99999',
      action: async () => ({}),
      httpFetch: async () => ({ status: 200, headers: {}, text: () => '', bytes: () => new Uint8Array() }),
      memory: { ingest: async () => ({ id: '1' }) },
      mediaStore: hConfigured.mediaStore,
      socialState: hConfigured.socialState,
      sender: { send: async () => ['1'] },
      sendSticker: async () => '1',
      recentSpeakers: async () => [],
      listGroupMembers: async () => [],
      hasSeenMessage: () => true,
      noteSelfMessage: () => {},
      stickerLibrary: { list: async () => [], detail: async () => undefined, collect: async () => {}, meanings: async () => [], note: async () => {} },
      voiceLibrary: { list: async () => [], send: async () => ({ messageId: '1', verification: 'not_requested' as const }) },
    },
  )
  await assert.rejects(
    legacyTools.get('sticker_note')!.handler({}, call),
    (err: unknown) => err instanceof BrainError && err.code === 'UNAVAILABLE' && err.message === '当前宿主不支持读取通道 L0 事件',
  )
})

test('list_voices and send_voice respect voice.enabled, path rules, and SentMessageError', async () => {
  const h = createHarness({
    voiceFiles: new Map([['hello.wav', new Uint8Array([1, 2, 3, 4])]]),
  })
  const listTool = h.tools.get('list_voices')!
  const sendTool = h.tools.get('send_voice')!
  const call: ToolCallContext = { channel: 'qq:group:10001', wakeId: 'w1' }

  // Disabled by default
  const disabledList = JSON.parse(await listTool.handler({}, call) as string) as {
    enabled: boolean; voices: string[]; note: string
  }
  assert.equal(disabledList.enabled, false)
  assert.deepEqual(disabledList.voices, [])
  assert.match(disabledList.note, /voice\.enabled/)
  await assert.rejects(sendTool.handler({ voiceId: 'hello.wav' }, call), { code: 'UNAVAILABLE' })

  // Enable voice
  h.setConfig({
    voice: { ...DEFAULT_QQ_CONFIG.voice, enabled: true, normalizeLoudness: false, verifyReadback: false },
  })
  const enabledList = JSON.parse(await listTool.handler({}, call) as string) as { enabled: boolean; voices: string[] }
  assert.equal(enabledList.enabled, true)
  assert.deepEqual(enabledList.voices, ['hello.wav'])

  await assert.rejects(sendTool.handler({ voiceId: '../secret.wav' }, call), { code: 'INVALID_ARGUMENT' })

  const sentOk = JSON.parse(await sendTool.handler({ voiceId: 'hello.wav' }, call) as string) as {
    ok: boolean; messageId: string; verification: string
  }
  assert.equal(sentOk.ok, true)
  assert.equal(sentOk.verification, 'not_requested')

  // SentMessageError on voiceLibrary.send
  const hPartial = createHarness({
    config: { voice: { ...DEFAULT_QQ_CONFIG.voice, enabled: true, normalizeLoudness: false, verifyReadback: false } },
    voiceFiles: new Map([['hello.wav', new Uint8Array([1, 2, 3, 4])]]),
    actionImpl: async () => ({ message_id: -77 }),
  })
  const origIngest = hPartial.ingested
  void origIngest
  // Override via custom tools registration where voiceLibrary throws SentMessageError
  const vTools = new Map<string, ToolDefinition>()
  registerQqTools(
    { tools: { register: (t) => { vTools.set(t.name, t); return () => {} } } },
    {
      config: () => ({ ...DEFAULT_QQ_CONFIG, allowGroups: ['10001'], voice: { ...DEFAULT_QQ_CONFIG.voice, enabled: true } }),
      canSend: () => true,
      isDisposed: () => false,
      getSelfId: () => '99999',
      action: async () => ({}),
      httpFetch: async () => ({ status: 200, headers: {}, text: () => '', bytes: () => new Uint8Array() }),
      memory: { ingest: async () => ({ id: '1' }) },
      mediaStore: hPartial.mediaStore,
      socialState: hPartial.socialState,
      sender: { send: async () => ['1'] },
      sendSticker: async () => '1',
      recentSpeakers: async () => [],
      listGroupMembers: async () => [],
      hasSeenMessage: () => true,
      noteSelfMessage: () => {},
      stickerLibrary: { list: async () => [], detail: async () => undefined, collect: async () => {}, meanings: async () => [], note: async () => {} },
      voiceLibrary: {
        list: async () => ['hello.wav'],
        send: async () => {
          throw new SentMessageError('-77')
        },
      },
    },
  )
  const partialVoice = JSON.parse(await vTools.get('send_voice')!.handler({ voiceId: 'hello.wav' }, call) as string) as {
    ok: boolean; partial: boolean; sent: boolean; messageId: string; deliveredMessageIds: string[]; verification: string
  }
  assert.equal(partialVoice.ok, false)
  assert.equal(partialVoice.partial, true)
  assert.equal(partialVoice.sent, true)
  assert.equal(partialVoice.messageId, '-77')
  assert.deepEqual(partialVoice.deliveredMessageIds, ['-77'])
  assert.equal(partialVoice.verification, 'failed')
})

test('get_message_detail requires exactly one of recordId/messageId, never calls get_msg, enforces visibility, and writes zero memory', async () => {
  const h = createHarness()
  const tool = h.tools.get('get_message_detail')!
  const call: ToolCallContext = { channel: 'qq:group:10001', wakeId: 'w1' }
  const disclosure: Disclosure = { speakable: 'yes', label: '本群聊天' }

  // Strict XOR
  await assert.rejects(tool.handler({}, call), { code: 'INVALID_ARGUMENT' })
  await assert.rejects(tool.handler({ recordId: 'l0_1', messageId: '101' }, call), { code: 'INVALID_ARGUMENT' })

  const rec = makeRecord({ id: 'l0_detail_1', channel: 'qq:group:10001', content: { text: '原始内容' } })
  h.memoryRecords.set(rec.id, { record: rec, disclosure })
  h.mediaStore.put('qq:group:10001', '-505', { recordId: rec.id, media: [], forwardIds: [] })

  const byRecord = JSON.parse(await tool.handler({ recordId: 'l0_detail_1' }, call) as string) as {
    source: string; disclosure: Disclosure; record: { id: string; content: { text: string } }
  }
  assert.match(byRecord.source, /外部内容/)
  assert.deepEqual(byRecord.disclosure, disclosure)
  assert.equal(byRecord.record.id, 'l0_detail_1')
  assert.equal(byRecord.record.content.text, '原始内容')

  const byMessage = JSON.parse(await tool.handler({ messageId: '-505' }, call) as string) as {
    record: { id: string }
  }
  assert.equal(byMessage.record.id, 'l0_detail_1')

  // Must NEVER call OneBot get_msg
  assert.equal(h.actionCalls.some((c) => c.name === 'get_msg'), false)
  assert.equal(h.ingested.length, 0)
  assert.equal(h.recorded.length, 0)

  // Cross-channel, recalled, forgotten -> NOT_FOUND
  await assert.rejects(
    tool.handler({ recordId: 'l0_detail_1' }, { channel: 'qq:group:10002', wakeId: 'w2' }),
    { code: 'NOT_FOUND' },
  )
  h.mediaStore.revoke('qq:group:10001', '-505')
  await assert.rejects(tool.handler({ messageId: '-505' }, call), { code: 'NOT_FOUND' })
  h.memoryRecords.set(rec.id, { record: { ...rec, status: 'tombstoned' }, disclosure })
  await assert.rejects(tool.handler({ recordId: 'l0_detail_1' }, call), { code: 'NOT_FOUND' })
})
