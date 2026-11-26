// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { GroupTrigger, ChatMode, SocialStateMachine } from '@brain-core/chat-kit'
import {
  BrainError,
  hostAllowed,
  type BrainContext,
  type ChannelEventResult,
  type Disposable,
  type MemoryRecord,
  type PluginHttp,
  type PluginMemory,
  type ToolCallContext,
  type ToolDefinition,
  type ToolOutput,
} from '@brain-core/sdk'
import type { QqConfig, SendGapMode } from '../config.ts'
import { allowed } from '../inbound/access.ts'
import { readForwardSummary } from '../inbound/forward.ts'
import type { MediaStore } from '../inbound/media-store.ts'
import { cleanText } from '../inbound/segments.ts'
import { OneBotHttpError } from '../onebot/http-client.ts'
import { normalizeAccountId, normalizeMessageId } from '../onebot/types.ts'
import { normalizeImage, readMessageImages, type ImageLocation } from '../outbound/media-normalize.ts'
import { SendRateLimit } from '../outbound/rate-limit.ts'
import { SentMessageError, type QqSender } from '../outbound/sender.ts'
import type { StickerLibrary } from '../outbound/stickers.ts'
import type { VoiceLibrary } from '../outbound/voice.ts'

const MAX_RPC_LINE_BYTES = 8 * 1024 * 1024
const MEDIA_HOSTS = ['*.qpic.cn', '*.qq.com', '*.qq.com.cn', '*.gtimg.cn', '*.qlogo.cn'] as const
const STICKER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const VOICE_ID_RE = /^[A-Za-z0-9_-]{1,128}\.(?:wav|mp3|ogg|opus|amr|m4a)$/i
const AT_USER_ID_RE = /^[1-9]\d{4,15}$/
const RECORD_ID_RE = /^\S{1,128}$/

const ACTIVE_WINDOW_MIN_MS = 10_000
const ACTIVE_WINDOW_MAX_MS = 3_600_000
const LURK_AFTER_MIN_MS = 30_000
const LURK_AFTER_MAX_MS = 86_400_000
const MAX_KEYWORDS = 32
const MAX_KEYWORD_CHARS = 32
const POKE_PER_MINUTE = 6
const POKE_PER_HOUR = 120

export const QQ_TOOL_NAMES = [
  'send_message',
  'set_wake_config',
  'get_message_images',
  'get_forward_msg',
  'send_poke',
  'get_group_members',
  'list_stickers',
  'get_sticker_image',
  'send_sticker',
  'collect_sticker',
  'sticker_note',
  'list_voices',
  'send_voice',
  'get_message_detail',
] as const

export interface SendStickerRequest {
  readonly channel: string
  readonly stickerId: string
  readonly replyToMessageId?: string
  readonly atUserId?: string
}

export interface GroupMemberInfo {
  readonly userId: string
  readonly nickname?: string
  readonly card?: string
  readonly displayName?: string
  readonly role?: string
  readonly lastActiveAt?: number
}

export interface QqToolsDeps {
  readonly config: () => QqConfig
  readonly canSend: (channel: string) => boolean | Promise<boolean>
  readonly isDisposed: () => boolean
  readonly getSelfId: () => string | undefined
  readonly action: (name: string, params?: unknown) => Promise<unknown>
  readonly httpFetch: PluginHttp['fetch']
  readonly memory: Pick<PluginMemory, 'ingest' | 'readChannelEvent'>
  readonly mediaStore: Pick<MediaStore, 'read' | 'readForward'>
  readonly socialState: Pick<SocialStateMachine, 'getState' | 'updateConfig'>
  readonly sender: Pick<QqSender, 'send'>
  readonly sendSticker: (request: SendStickerRequest) => Promise<string>
  readonly recentSpeakers: (channel: string) => readonly GroupMemberInfo[] | Promise<readonly GroupMemberInfo[]>
  readonly listGroupMembers: (groupId: string) => Promise<readonly GroupMemberInfo[]>
  readonly hasSeenMessage: (channel: string, messageId: string) => boolean | Promise<boolean>
  readonly noteSelfMessage: (channel: string, messageId: string) => void | Promise<void>
  readonly stickerLibrary: Pick<StickerLibrary, 'list' | 'detail' | 'collect' | 'meanings' | 'note'>
  readonly voiceLibrary: Pick<VoiceLibrary, 'list' | 'send'>
  readonly now?: () => number
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}

function assertObjectArgs(args: unknown): Readonly<Record<string, unknown>> {
  if (!isPlainObject(args)) {
    throw new BrainError('INVALID_ARGUMENT', '工具参数必须是对象')
  }
  return args
}

function parseQqChannel(call: ToolCallContext | undefined): { readonly kind: 'private' | 'group'; readonly id: string } {
  if (!call || typeof call.channel !== 'string') {
    throw new BrainError('INVALID_ARGUMENT', '缺少有效的 QQ 通道上下文')
  }
  const match = /^qq:(private|group):([1-9]\d*)$/.exec(call.channel)
  if (!match) {
    throw new BrainError('INVALID_ARGUMENT', '当前通道不是有效的 QQ 会话')
  }
  return { kind: match[1] as 'private' | 'group', id: match[2]! }
}

function assertNotDisposed(deps: QqToolsDeps): void {
  if (deps.isDisposed()) {
    throw new BrainError('UNAVAILABLE', 'QQ 通道插件已停用')
  }
}

async function assertChannelSendable(
  deps: QqToolsDeps,
  config: QqConfig,
  channel: string,
  kind: 'private' | 'group',
  id: string,
): Promise<void> {
  if (!allowed(config, kind, id)) {
    throw new BrainError('PERMISSION_DENIED', '当前通道未在 QQ 允许列表中')
  }
  if (!(await deps.canSend(channel))) {
    throw new BrainError('UNAVAILABLE', '当前通道暂时不可发送')
  }
}

function parseMessageIdStrict(value: unknown): string {
  if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isSafeInteger(value))) {
    throw new BrainError('INVALID_ARGUMENT', '无效的 QQ 消息 ID')
  }
  try {
    return normalizeMessageId(value)
  } catch {
    throw new BrainError('INVALID_ARGUMENT', '无效的 QQ 消息 ID')
  }
}

function parseStickerIdStrict(value: unknown): string {
  if (typeof value !== 'string' || !STICKER_ID_RE.test(value)) {
    throw new BrainError('INVALID_ARGUMENT', '无效的表情包 ID')
  }
  return value
}

function extractPartialSent(
  error: unknown,
): { readonly messageId: string; readonly deliveredIds: readonly string[] } | undefined {
  if (error instanceof SentMessageError) {
    return { messageId: error.messageId, deliveredIds: error.deliveredIds }
  }
  if (error && typeof error === 'object') {
    const raw = error as Record<string, unknown>
    if (raw.sent === true) {
      const deliveredIds = Array.isArray(raw.deliveredIds)
        ? raw.deliveredIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : []
      const messageId = typeof raw.messageId === 'string' && raw.messageId.length > 0
        ? raw.messageId
        : (deliveredIds.at(-1) ?? '')
      if (deliveredIds.length > 0 || messageId !== '') {
        return {
          messageId,
          deliveredIds: deliveredIds.length > 0 ? deliveredIds : [messageId],
        }
      }
    }
  }
  return undefined
}

function toSanitizedBrainError(error: unknown, fallbackMessage: string): BrainError {
  if (error instanceof BrainError) return error
  if (error instanceof Error) {
    const msg = error.message
    if (/Rate limit/i.test(msg)) {
      return new BrainError('RATE_LIMITED', '发送频率已达上限，请稍后再试')
    }
    if (/Sensitive/i.test(msg)) {
      return new BrainError('PERMISSION_DENIED', '消息包含敏感信息，已被安全策略拦截')
    }
    if (/Channel unavailable|disabled/i.test(msg)) {
      return new BrainError('UNAVAILABLE', '当前通道或功能不可用')
    }
    if (/Invalid (channel|messages|mention|reply|voice|sticker)|Burst limit/i.test(msg)) {
      return new BrainError('INVALID_ARGUMENT', '发送参数校验失败')
    }
    if (/NOT_FOUND/i.test(msg)) {
      return new BrainError('NOT_FOUND', '找不到目标资源')
    }
  }
  return new BrainError('UNAVAILABLE', fallbackMessage)
}

function validateQqCdnUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 16_384) return undefined
  try {
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username !== '' || url.password !== '' || url.port !== '') {
      return undefined
    }
    if (!MEDIA_HOSTS.some((pattern) => hostAllowed(pattern, url.hostname.toLowerCase()))) {
      return undefined
    }
    url.hash = ''
    return url.href
  } catch {
    return undefined
  }
}

function fitsRpcLineBudget(output: ToolOutput): boolean {
  return Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: '0', result: output }), 'utf8') <= MAX_RPC_LINE_BYTES
}

async function authorizeVisibleL0(
  deps: QqToolsDeps,
  recordId: string,
  call: ToolCallContext,
): Promise<ChannelEventResult | undefined> {
  if (!deps.memory.readChannelEvent) return undefined
  try {
    const result = await deps.memory.readChannelEvent(recordId, call)
    if (
      result.record.id !== recordId
      || result.record.layer !== 'L0'
      || result.record.channel !== call.channel
      || result.record.status !== 'active'
    ) {
      return undefined
    }
    return result
  } catch {
    return undefined
  }
}

function requireChannelEventReader(deps: QqToolsDeps): void {
  if (!deps.memory.readChannelEvent) {
    throw new BrainError('UNAVAILABLE', '当前宿主不支持读取通道 L0 事件')
  }
}

function mediaContainsSticker(media: unknown, stickerId: string): boolean {
  if (!Array.isArray(media)) return false
  return media.some((item) => {
    if (!item || typeof item !== 'object') return false
    const entry = item as Record<string, unknown>
    return entry.emojiId === stickerId || entry.stickerId === stickerId || entry.file === stickerId
  })
}

function resolveFirstStickerId(media: unknown): string | undefined {
  if (!Array.isArray(media)) return undefined
  for (const item of media) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    for (const candidate of [entry.emojiId, entry.stickerId, entry.file]) {
      if (typeof candidate === 'string' && STICKER_ID_RE.test(candidate)) {
        return candidate
      }
    }
  }
  return undefined
}

function cleanLimitedKeywords(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) {
    throw new BrainError('INVALID_ARGUMENT', 'keywords 必须是字符串数组')
  }
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw new BrainError('INVALID_ARGUMENT', 'keywords 的每一项都必须是字符串')
    }
    const cleaned = [...cleanText(item).trim()].slice(0, MAX_KEYWORD_CHARS).join('').trim()
    if (cleaned === '' || seen.has(cleaned)) continue
    seen.add(cleaned)
    result.push(cleaned)
    if (result.length >= MAX_KEYWORDS) break
  }
  return result
}

function isAuthError(error: unknown): boolean {
  if (error instanceof OneBotHttpError && error.kind === 'auth') return true
  return error instanceof Error && /\b401\b|auth/i.test(error.message)
}

/** Registers all 14 QQ channel tools on `ctx.tools` and returns a single `Disposable`. */
export function registerQqTools(ctx: Pick<BrainContext<unknown>, 'tools'>, deps: QqToolsDeps): Disposable {
  const pokeLimiter = new SendRateLimit(POKE_PER_MINUTE, POKE_PER_HOUR, deps.now)
  let pokeSeq = 0

  const tools: readonly ToolDefinition[] = [
    {
      name: 'send_message',
      description: '发送 QQ 消息（支持单发、引用回复与多气泡连发）',
      parameters: {
        type: 'object',
        properties: {
          messages: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: 6,
            description: '要发送的文本气泡列表（1 到 6 条）',
          },
          replyToMessageId: {
            type: 'string',
            description: '可选，引用回复的当前通道 QQ 消息 ID',
          },
          atUserId: {
            type: 'string',
            description: '可选，群聊中 @ 的成员 QQ 号（纯数字，禁止 @all）',
          },
          gapMode: {
            type: 'string',
            enum: ['auto', 'byLength', 'fixed'],
            description: '可选，多气泡发送节律模式',
          },
        },
        required: ['messages'],
        additionalProperties: false,
      },
      handler: async (rawArgs, call) => {
        assertNotDisposed(deps)
        const { kind, id } = parseQqChannel(call)
        const args = assertObjectArgs(rawArgs)
        const config = deps.config()
        await assertChannelSendable(deps, config, call.channel, kind, id)

        if (!Array.isArray(args.messages) || args.messages.length === 0) {
          throw new BrainError('INVALID_ARGUMENT', 'messages 必须是非空字符串数组')
        }
        const maxBurst = Math.min(6, config.send.maxBurst)
        if (args.messages.length > maxBurst) {
          throw new BrainError('INVALID_ARGUMENT', `单次最多连发 ${maxBurst} 条气泡`)
        }
        const messages: string[] = []
        for (const item of args.messages) {
          if (typeof item !== 'string' || item.trim() === '') {
            throw new BrainError('INVALID_ARGUMENT', 'messages 中不能包含空消息或非字符串项')
          }
          messages.push(item)
        }

        let replyToMessageId: string | undefined
        if (args.replyToMessageId !== undefined) {
          replyToMessageId = parseMessageIdStrict(args.replyToMessageId)
          if (!(await deps.hasSeenMessage(call.channel, replyToMessageId))) {
            throw new BrainError('INVALID_ARGUMENT', '找不到可引用的当前通道消息')
          }
        }

        let atUserId: string | undefined
        if (args.atUserId !== undefined) {
          if (kind !== 'group' || typeof args.atUserId !== 'string' || !AT_USER_ID_RE.test(args.atUserId)) {
            throw new BrainError('INVALID_ARGUMENT', 'atUserId 仅限群聊有效 QQ 号，且禁止 @all')
          }
          atUserId = args.atUserId
        }

        let gapMode: SendGapMode | undefined
        if (args.gapMode !== undefined) {
          if (args.gapMode !== 'auto' && args.gapMode !== 'byLength' && args.gapMode !== 'fixed') {
            throw new BrainError('INVALID_ARGUMENT', '无效的 gapMode')
          }
          gapMode = args.gapMode
        }

        try {
          const deliveredIds = await deps.sender.send({
            channel: call.channel,
            messages,
            ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
            ...(atUserId !== undefined ? { atUserId } : {}),
            ...(gapMode !== undefined ? { gapMode } : {}),
          })
          return JSON.stringify({
            ok: true,
            deliveredMessageIds: deliveredIds,
            lastMessageId: deliveredIds.at(-1),
            count: deliveredIds.length,
          })
        } catch (error) {
          const partial = extractPartialSent(error)
          if (partial) {
            return JSON.stringify({
              ok: false,
              partial: true,
              sent: true,
              deliveredMessageIds: partial.deliveredIds,
              lastMessageId: partial.messageId,
              warning: '部分气泡已送达 QQ，请勿盲目重复发送',
            })
          }
          throw toSanitizedBrainError(error, '发送 QQ 消息失败')
        }
      },
    },

    {
      name: 'set_wake_config',
      description: '调整当前 QQ 群的运行期触发模式与活跃参数（受主人预算上限约束）',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['active', 'lurking', 'muted'],
            description: '当前群聊运行模式',
          },
          groupTrigger: {
            type: 'string',
            enum: ['mention', 'keyword', 'always'],
            description: '群聊唤醒模式',
          },
          keywords: {
            type: 'array',
            items: { type: 'string' },
            maxItems: MAX_KEYWORDS,
            description: '触发唤醒的关键词列表（清洗后最多 32 条，每条不超过 32 字符）',
          },
          activeWindowMs: {
            type: 'number',
            minimum: ACTIVE_WINDOW_MIN_MS,
            maximum: ACTIVE_WINDOW_MAX_MS,
            description: '活跃窗口时长（毫秒，10000 到 3600000）',
          },
          lurkAfterMs: {
            type: 'number',
            minimum: LURK_AFTER_MIN_MS,
            maximum: LURK_AFTER_MAX_MS,
            description: '自动转潜水时长（毫秒，30000 到 86400000）',
          },
          replyProbability: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description: '随机插话概率（不得高于主人配置上限）',
          },
        },
        additionalProperties: false,
      },
      handler: async (rawArgs, call) => {
        assertNotDisposed(deps)
        const { kind, id } = parseQqChannel(call)
        if (kind !== 'group') {
          throw new BrainError('PERMISSION_DENIED', 'set_wake_config 仅支持 QQ 群聊通道')
        }
        const config = deps.config()
        if (!allowed(config, 'group', id)) {
          throw new BrainError('PERMISSION_DENIED', '当前群未在 QQ 允许列表中')
        }

        const args = assertObjectArgs(rawArgs)
        const allowedKeys = new Set(['mode', 'groupTrigger', 'keywords', 'activeWindowMs', 'lurkAfterMs', 'replyProbability'])
        for (const key of Object.keys(args)) {
          if (!allowedKeys.has(key)) {
            throw new BrainError('INVALID_ARGUMENT', `不允许修改参数 ${key}`)
          }
        }

        let mode: ChatMode | undefined
        if (args.mode !== undefined) {
          if (args.mode !== 'active' && args.mode !== 'lurking' && args.mode !== 'muted') {
            throw new BrainError('INVALID_ARGUMENT', 'mode 必须是 active、lurking 或 muted')
          }
          mode = args.mode
        }

        let groupTrigger: GroupTrigger | undefined
        if (args.groupTrigger !== undefined) {
          if (args.groupTrigger !== 'mention' && args.groupTrigger !== 'keyword' && args.groupTrigger !== 'always') {
            throw new BrainError('INVALID_ARGUMENT', 'groupTrigger 必须是 mention、keyword 或 always')
          }
          groupTrigger = args.groupTrigger
        }

        const keywords = args.keywords !== undefined ? cleanLimitedKeywords(args.keywords) : undefined

        let activeWindowMs: number | undefined
        if (args.activeWindowMs !== undefined) {
          if (
            typeof args.activeWindowMs !== 'number'
            || !Number.isFinite(args.activeWindowMs)
            || args.activeWindowMs < ACTIVE_WINDOW_MIN_MS
            || args.activeWindowMs > ACTIVE_WINDOW_MAX_MS
          ) {
            throw new BrainError('INVALID_ARGUMENT', 'activeWindowMs 必须在 10000 到 3600000 之间')
          }
          activeWindowMs = Math.floor(args.activeWindowMs)
        }

        let lurkAfterMs: number | undefined
        if (args.lurkAfterMs !== undefined) {
          if (
            typeof args.lurkAfterMs !== 'number'
            || !Number.isFinite(args.lurkAfterMs)
            || args.lurkAfterMs < LURK_AFTER_MIN_MS
            || args.lurkAfterMs > LURK_AFTER_MAX_MS
          ) {
            throw new BrainError('INVALID_ARGUMENT', 'lurkAfterMs 必须在 30000 到 86400000 之间')
          }
          lurkAfterMs = Math.floor(args.lurkAfterMs)
        }

        let replyProbability: number | undefined
        if (args.replyProbability !== undefined) {
          if (typeof args.replyProbability !== 'number' || !Number.isFinite(args.replyProbability) || args.replyProbability < 0 || args.replyProbability > 1) {
            throw new BrainError('INVALID_ARGUMENT', 'replyProbability 必须是 0 到 1 之间的有限数字')
          }
          if (args.replyProbability > config.wake.replyProbability) {
            throw new BrainError('INVALID_ARGUMENT', 'replyProbability 不得超过主人配置上限')
          }
          replyProbability = args.replyProbability
        }

        const updated = deps.socialState.updateConfig(call.channel, {
          ...(mode !== undefined ? { mode } : {}),
          ...(groupTrigger !== undefined ? { groupTrigger } : {}),
          ...(keywords !== undefined ? { keywords } : {}),
          ...(activeWindowMs !== undefined ? { activeWindowMs } : {}),
          ...(lurkAfterMs !== undefined ? { lurkAfterMs } : {}),
          ...(replyProbability !== undefined ? { replyProbability } : {}),
        })

        return JSON.stringify({
          ok: true,
          channel: call.channel,
          mode: updated.mode,
          groupTrigger: updated.config.groupTrigger,
          keywords: updated.config.keywords,
          activeWindowMs: updated.config.activeWindowMs,
          lurkAfterMs: updated.config.lurkAfterMs,
          replyProbability: Math.min(updated.config.replyProbability ?? 0, config.wake.replyProbability),
        })
      },
    },

    {
      name: 'get_message_images',
      description: '按需读取并归一化当前通道消息中的图片或表情',
      parameters: {
        type: 'object',
        properties: {
          messageId: {
            type: 'string',
            description: '当前通道内的 QQ 消息 ID',
          },
        },
        required: ['messageId'],
        additionalProperties: false,
      },
      handler: async (rawArgs, call) => {
        assertNotDisposed(deps)
        parseQqChannel(call)
        requireChannelEventReader(deps)
        const args = assertObjectArgs(rawArgs)
        const messageId = parseMessageIdStrict(args.messageId)
        const config = deps.config()

        let latestEvent: ChannelEventResult | undefined
        const result = await readMessageImages({
          media: config.media,
          fetch: deps.httpFetch,
          authorize: async () => {
            const entry = await deps.mediaStore.read(call.channel, messageId, async (recordId) => {
              const ev = await authorizeVisibleL0(deps, recordId, call)
              if (!ev) return false
              latestEvent = ev
              return true
            })
            if (!entry || !latestEvent) return undefined
            return {
              recordId: entry.recordId,
              locations: entry.media as readonly ImageLocation[],
            }
          },
          resolveImageUrl: async (file: string) => {
            const response = await deps.action('get_image', { file }) as { url?: unknown } | undefined
            return response?.url
          },
        })

        if (!latestEvent) {
          throw new BrainError('NOT_FOUND', '找不到当前通道中的这条消息')
        }

        const buildPayload = (note: string): string => JSON.stringify({
          source: 'QQ 消息图片（外部内容）',
          disclosure: latestEvent!.disclosure,
          note,
        })

        if (typeof result === 'string') {
          return { text: buildPayload(result) }
        }

        const wrapped: ToolOutput = result.images && result.images.length > 0
          ? { text: buildPayload(result.text), images: result.images }
          : { text: buildPayload(result.text) }

        if (!fitsRpcLineBudget(wrapped)) {
          return { text: buildPayload('图片总大小超出 RPC 单行限制，已降级为文本提示。') }
        }
        return wrapped
      },
    },

    {
      name: 'get_forward_msg',
      description: '展开当前通道内可见的 QQ 合并转发聊天记录',
      parameters: {
        type: 'object',
        properties: {
          forwardId: {
            type: 'string',
            description: '当前通道内的合并转发 ID',
          },
        },
        required: ['forwardId'],
        additionalProperties: false,
      },
      handler: async (rawArgs, call) => {
        assertNotDisposed(deps)
        parseQqChannel(call)
        requireChannelEventReader(deps)
        const args = assertObjectArgs(rawArgs)
        if (typeof args.forwardId !== 'string' || args.forwardId.trim() === '') {
          throw new BrainError('INVALID_ARGUMENT', '无效的合并转发 ID')
        }

        const summary = await readForwardSummary(args.forwardId, {
          authorize: async (forwardId) => {
            let authorizedEvent: ChannelEventResult | undefined
            const entry = await deps.mediaStore.readForward(call.channel, forwardId, async (recordId) => {
              const ev = await authorizeVisibleL0(deps, recordId, call)
              if (!ev) return false
              authorizedEvent = ev
              return true
            })
            return entry ? authorizedEvent : undefined
          },
          fetchForward: async (id) => deps.action('get_forward_msg', { id }),
        })

        return summary.text
      },
    },

    {
      name: 'send_poke',
      description: '在 QQ 中拍一拍对方或回拍',
      parameters: {
        type: 'object',
        properties: {
          targetUserId: {
            type: 'string',
            description: '可选（私聊默认为对端 QQ，群聊必填目标 QQ 号）',
          },
        },
        additionalProperties: false,
      },
      handler: async (rawArgs, call) => {
        assertNotDisposed(deps)
        const { kind, id } = parseQqChannel(call)
        const config = deps.config()
        await assertChannelSendable(deps, config, call.channel, kind, id)
        const args = assertObjectArgs(rawArgs)

        let targetUserId: string
        if (kind === 'private') {
          if (args.targetUserId === undefined) {
            targetUserId = id
          } else {
            let normalized: string
            try {
              normalized = normalizeAccountId(args.targetUserId)
            } catch {
              throw new BrainError('INVALID_ARGUMENT', '无效的目标 QQ 号')
            }
            if (normalized !== id) {
              throw new BrainError('PERMISSION_DENIED', '私聊仅允许拍当前对话对象')
            }
            targetUserId = normalized
          }
        } else {
          if (args.targetUserId === undefined) {
            throw new BrainError('INVALID_ARGUMENT', '群聊拍一拍必须提供目标 QQ 号')
          }
          try {
            targetUserId = normalizeAccountId(args.targetUserId)
          } catch {
            throw new BrainError('INVALID_ARGUMENT', '无效的目标 QQ 号')
          }
          const selfId = deps.getSelfId()
          if (selfId !== undefined && targetUserId === String(selfId)) {
            throw new BrainError('INVALID_ARGUMENT', '不能拍一拍自己')
          }
        }

        let reservation: ReturnType<SendRateLimit['reserve']>
        try {
          reservation = pokeLimiter.reserve(call.channel, 1)
        } catch {
          throw new BrainError('RATE_LIMITED', '拍一拍发送过于频繁，请稍后再试')
        }

        try {
          const primaryAction = kind === 'private' ? 'friend_poke' : 'group_poke'
          const primaryParams = kind === 'private'
            ? { user_id: targetUserId }
            : { group_id: id, user_id: targetUserId }

          try {
            await deps.action(primaryAction, primaryParams)
          } catch (primaryError) {
            if (isAuthError(primaryError)) {
              throw new BrainError('UNAVAILABLE', 'OneBot 鉴权失败')
            }
            await deps.action('send_poke', primaryParams)
          }
          reservation.sent()
        } catch (error) {
          throw toSanitizedBrainError(error, 'QQ 拍一拍发送失败')
        } finally {
          reservation.rollback()
        }

        const tEvent = (deps.now ?? Date.now)()
        pokeSeq += 1
        await deps.memory.ingest({
          kind: 'qq.action',
          channel: call.channel,
          subjects: [],
          actor: 'self',
          visibility: 'origin',
          content: {
            direction: 'outbound',
            action: 'poke',
            targetUserId,
          },
          tEvent,
          idempotencyKey: `qq:poke:${call.channel}:${targetUserId}:${tEvent}:${pokeSeq}`,
        })

        return JSON.stringify({
          ok: true,
          action: 'poke',
          targetUserId,
        })
      },
    },

    {
      name: 'get_group_members',
      description: '读取当前 QQ 群成员列表或近期活跃成员',
      parameters: {
        type: 'object',
        properties: {
          activeOnly: {
            type: 'boolean',
            description: '可选，为 true 时仅返回近期活跃发言成员',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 200,
            description: '可选，返回数量上限（1 到 200，默认 50）',
          },
        },
        additionalProperties: false,
      },
      handler: async (rawArgs, call) => {
        assertNotDisposed(deps)
        const { kind, id } = parseQqChannel(call)
        if (kind !== 'group') {
          throw new BrainError('PERMISSION_DENIED', 'get_group_members 仅支持 QQ 群聊通道')
        }
        const config = deps.config()
        if (!allowed(config, 'group', id)) {
          throw new BrainError('PERMISSION_DENIED', '当前群未在 QQ 允许列表中')
        }
        const args = assertObjectArgs(rawArgs)

        if (args.activeOnly !== undefined && typeof args.activeOnly !== 'boolean') {
          throw new BrainError('INVALID_ARGUMENT', 'activeOnly 必须是布尔值')
        }
        let limit = 50
        if (args.limit !== undefined) {
          if (typeof args.limit !== 'number' || !Number.isFinite(args.limit)) {
            throw new BrainError('INVALID_ARGUMENT', 'limit 必须是有限数字')
          }
          limit = Math.max(1, Math.min(200, Math.floor(args.limit)))
        }

        const activeOnly = args.activeOnly === true
        let rawMembers: readonly GroupMemberInfo[]
        try {
          rawMembers = activeOnly
            ? await deps.recentSpeakers(call.channel)
            : await deps.listGroupMembers(id)
        } catch (error) {
          throw toSanitizedBrainError(error, '读取群成员列表失败')
        }

        const members = rawMembers.slice(0, limit).map((member) => {
          const nickname = member.nickname !== undefined ? cleanText(member.nickname).slice(0, 64) : undefined
          const card = member.card !== undefined ? cleanText(member.card).slice(0, 64) : undefined
          const displayName = member.displayName !== undefined
            ? cleanText(member.displayName).slice(0, 64)
            : (card || nickname || member.userId)
          const role = member.role !== undefined ? cleanText(member.role).slice(0, 32) : undefined
          return {
            userId: cleanText(member.userId).slice(0, 32),
            displayName,
            ...(nickname !== undefined ? { nickname } : {}),
            ...(card !== undefined ? { card } : {}),
            ...(role !== undefined ? { role } : {}),
            ...(member.lastActiveAt !== undefined ? { lastActiveAt: member.lastActiveAt } : {}),
          }
        })

        return JSON.stringify({
          source: 'QQ 群成员列表（外部内容）',
          activeOnly,
          total: rawMembers.length,
          members,
        })
      },
    },

    {
      name: 'list_stickers',
      description: '检索已收藏 QQ 表情列表与本通道学到的含义',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '可选，按表情 ID 或本通道已学含义过滤',
          },
          count: {
            type: 'integer',
            minimum: 1,
            maximum: 100,
            description: '可选，返回数量上限',
          },
          refresh: {
            type: 'boolean',
            description: '可选，是否强制刷新表情列表缓存',
          },
        },
        additionalProperties: false,
      },
      handler: async (rawArgs, call) => {
        assertNotDisposed(deps)
        parseQqChannel(call)
        const config = deps.config()
        if (!config.stickers.enabled) {
          throw new BrainError('UNAVAILABLE', '表情包功能未启用')
        }
        const args = assertObjectArgs(rawArgs)

        if (args.query !== undefined && typeof args.query !== 'string') {
          throw new BrainError('INVALID_ARGUMENT', 'query 必须是字符串')
        }
        if (args.refresh !== undefined && typeof args.refresh !== 'boolean') {
          throw new BrainError('INVALID_ARGUMENT', 'refresh 必须是布尔值')
        }
        let limit = config.stickers.maxListCount
        if (args.count !== undefined) {
          if (typeof args.count !== 'number' || !Number.isFinite(args.count) || args.count < 1) {
            throw new BrainError('INVALID_ARGUMENT', 'count 必须是正整数')
          }
          limit = Math.min(Math.floor(args.count), config.stickers.maxListCount)
        }

        const query = args.query?.trim().toLowerCase() ?? ''
        const allStickers = await deps.stickerLibrary.list(args.refresh === true)

        const items: {
          readonly stickerId: string
          readonly meanings: Awaited<ReturnType<StickerLibrary['meanings']>>
        }[] = []

        if (query === '') {
          for (const sticker of allStickers.slice(0, limit)) {
            const meanings = await deps.stickerLibrary.meanings(sticker.id, call)
            items.push({ stickerId: sticker.id, meanings })
          }
        } else {
          for (const sticker of allStickers) {
            if (items.length >= limit) break
            const meanings = await deps.stickerLibrary.meanings(sticker.id, call)
            const idMatches = sticker.id.toLowerCase().includes(query)
            const meaningMatches = meanings.some((m) =>
              m.note.toLowerCase().includes(query) || m.tags.some((t) => t.toLowerCase().includes(query)))
            if (idMatches || meaningMatches) {
              items.push({ stickerId: sticker.id, meanings })
            }
          }
        }

        return JSON.stringify({
          source: 'QQ 收藏表情列表与本通道含义备注（外部内容）',
          total: allStickers.length,
          stickers: items,
        })
      },
    },

    {
      name: 'get_sticker_image',
      description: '查看指定收藏表情包的归一化预览图',
      parameters: {
        type: 'object',
        properties: {
          stickerId: {
            type: 'string',
            description: '收藏表情 ID',
          },
        },
        required: ['stickerId'],
        additionalProperties: false,
      },
      handler: async (rawArgs, call) => {
        assertNotDisposed(deps)
        parseQqChannel(call)
        const config = deps.config()
        if (!config.stickers.enabled) {
          throw new BrainError('UNAVAILABLE', '表情包功能未启用')
        }
        const args = assertObjectArgs(rawArgs)
        const stickerId = parseStickerIdStrict(args.stickerId)

        const detail = await deps.stickerLibrary.detail(stickerId)
        if (!detail) {
          throw new BrainError('NOT_FOUND', '找不到该收藏表情')
        }

        const buildText = (note: string): string => JSON.stringify({
          source: 'QQ 收藏表情预览（外部内容）',
          stickerId: detail.id,
          note,
        })

        const safeUrl = validateQqCdnUrl(detail.url)
        if (safeUrl !== undefined) {
          try {
            const response = await deps.httpFetch(safeUrl, {
              redirect: 'error',
              maxBytes: Math.min(config.media.maxDownloadBytes, 5 * 1024 * 1024),
            })
            if (response.status >= 200 && response.status < 300) {
              const image = await normalizeImage(response.bytes(), config.media)
              if (image !== undefined) {
                const output: ToolOutput = {
                  text: buildText('已获取归一化表情预览图'),
                  images: [image],
                }
                if (fitsRpcLineBudget(output)) {
                  return output
                }
              }
            }
          } catch {
            // Fall back to text note without leaking remote URL or transport details.
          }
        }

        return { text: buildText('该表情暂无可用预览图或图片处理失败') }
      },
    },

    {
      name: 'send_sticker',
      description: '发送指定的收藏 QQ 表情包',
      parameters: {
        type: 'object',
        properties: {
          stickerId: {
            type: 'string',
            description: '要发送的收藏表情 ID',
          },
          replyToMessageId: {
            type: 'string',
            description: '可选，引用回复的当前通道 QQ 消息 ID',
          },
          atUserId: {
            type: 'string',
            description: '可选，群聊中 @ 的成员 QQ 号（纯数字，禁止 @all）',
          },
        },
        required: ['stickerId'],
        additionalProperties: false,
      },
      handler: async (rawArgs, call) => {
        assertNotDisposed(deps)
        const { kind, id } = parseQqChannel(call)
        const config = deps.config()
        if (!config.stickers.enabled) {
          throw new BrainError('UNAVAILABLE', '表情包功能未启用')
        }
        await assertChannelSendable(deps, config, call.channel, kind, id)
        const args = assertObjectArgs(rawArgs)
        const stickerId = parseStickerIdStrict(args.stickerId)

        let replyToMessageId: string | undefined
        if (args.replyToMessageId !== undefined) {
          replyToMessageId = parseMessageIdStrict(args.replyToMessageId)
          if (!(await deps.hasSeenMessage(call.channel, replyToMessageId))) {
            throw new BrainError('INVALID_ARGUMENT', '找不到可引用的当前通道消息')
          }
        }

        let atUserId: string | undefined
        if (args.atUserId !== undefined) {
          if (kind !== 'group' || typeof args.atUserId !== 'string' || !AT_USER_ID_RE.test(args.atUserId)) {
            throw new BrainError('INVALID_ARGUMENT', 'atUserId 仅限群聊有效 QQ 号，且禁止 @all')
          }
          atUserId = args.atUserId
        }

        const list = await deps.stickerLibrary.list()
        if (!list.some((item) => item.id === stickerId)) {
          throw new BrainError('NOT_FOUND', '找不到该收藏表情')
        }

        try {
          const messageId = await deps.sendSticker({
            channel: call.channel,
            stickerId,
            ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
            ...(atUserId !== undefined ? { atUserId } : {}),
          })
          return JSON.stringify({ ok: true, stickerId, messageId })
        } catch (error) {
          const partial = extractPartialSent(error)
          if (partial) {
            return JSON.stringify({
              ok: false,
              partial: true,
              sent: true,
              stickerId,
              messageId: partial.messageId,
              deliveredMessageIds: partial.deliveredIds,
              warning: '表情已送达 QQ，但本地后续记录失败，请勿盲目重复发送',
            })
          }
          throw toSanitizedBrainError(error, '发送 QQ 表情失败')
        }
      },
    },

    {
      name: 'collect_sticker',
      description: '从当前通道消息中收藏表情包到 QQ 收藏',
      parameters: {
        type: 'object',
        properties: {
          messageId: {
            type: 'string',
            description: '包含目标表情的当前通道 QQ 消息 ID',
          },
          stickerId: {
            type: 'string',
            description: '可选，指定消息中的表情 ID',
          },
        },
        required: ['messageId'],
        additionalProperties: false,
      },
      handler: async (rawArgs, call) => {
        assertNotDisposed(deps)
        parseQqChannel(call)
        requireChannelEventReader(deps)
        const config = deps.config()
        if (!config.stickers.enabled) {
          throw new BrainError('UNAVAILABLE', '表情包功能未启用')
        }
        if (!config.stickers.collectEnabled) {
          throw new BrainError('PERMISSION_DENIED', '表情收藏功能已关闭')
        }

        const args = assertObjectArgs(rawArgs)
        const messageId = parseMessageIdStrict(args.messageId)
        const requestedStickerId = args.stickerId !== undefined ? parseStickerIdStrict(args.stickerId) : undefined

        let authorizedRecord: MemoryRecord | undefined
        const entry = await deps.mediaStore.read(call.channel, messageId, async (recordId) => {
          const ev = await authorizeVisibleL0(deps, recordId, call)
          if (!ev) return false
          authorizedRecord = ev.record
          return true
        })

        if (!entry || !authorizedRecord) {
          throw new BrainError('NOT_FOUND', '找不到当前通道中的这条消息')
        }

        const media = authorizedRecord.content.media
        let resolvedId: string | undefined
        if (requestedStickerId !== undefined) {
          if (!mediaContainsSticker(media, requestedStickerId)) {
            throw new BrainError('NOT_FOUND', '该消息中不包含指定的表情')
          }
          resolvedId = requestedStickerId
        } else {
          resolvedId = resolveFirstStickerId(media)
          if (resolvedId === undefined) {
            throw new BrainError('NOT_FOUND', '该消息中不包含可收藏的有效表情')
          }
        }

        try {
          await deps.stickerLibrary.collect(resolvedId, authorizedRecord.id, call)
        } catch (error) {
          if (error instanceof BrainError) throw error
          if (error instanceof Error) {
            if (/unsupported/i.test(error.message)) {
              throw new BrainError('UNAVAILABLE', '当前协议端未配置表情收藏动作')
            }
            if (/Rate limit/i.test(error.message)) {
              throw new BrainError('RATE_LIMITED', '表情收藏过于频繁，请稍后再试')
            }
            if (/NOT_FOUND|Invalid evidence/i.test(error.message)) {
              throw new BrainError('NOT_FOUND', '找不到当前通道中的这条消息')
            }
          }
          throw toSanitizedBrainError(error, '收藏 QQ 表情失败')
        }

        return JSON.stringify({
          ok: true,
          stickerId: resolvedId,
          evidenceRecordId: authorizedRecord.id,
        })
      },
    },

    {
      name: 'sticker_note',
      description: '依据本通道 L0 证据为表情包记录含义备注',
      parameters: {
        type: 'object',
        properties: {
          stickerId: {
            type: 'string',
            description: '收藏表情 ID',
          },
          evidenceRecordId: {
            type: 'string',
            description: '同通道可见的 L0 证据记录 ID',
          },
          note: {
            type: 'string',
            description: '本通道学到的表情含义备注',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 20,
            description: '可选，表情语义标签列表',
          },
        },
        required: ['stickerId', 'evidenceRecordId', 'note'],
        additionalProperties: false,
      },
      handler: async (rawArgs, call) => {
        assertNotDisposed(deps)
        parseQqChannel(call)
        requireChannelEventReader(deps)
        const config = deps.config()
        if (!config.stickers.enabled) {
          throw new BrainError('UNAVAILABLE', '表情包功能未启用')
        }

        const args = assertObjectArgs(rawArgs)
        const stickerId = parseStickerIdStrict(args.stickerId)

        if (typeof args.evidenceRecordId !== 'string' || !RECORD_ID_RE.test(args.evidenceRecordId.trim())) {
          throw new BrainError('INVALID_ARGUMENT', '无效的证据记录 ID')
        }
        const evidenceRecordId = args.evidenceRecordId.trim()

        const cleanedNote = typeof args.note === 'string' ? cleanText(args.note).replace(/\n/g, '').trim() : ''
        if (cleanedNote === '') {
          throw new BrainError('INVALID_ARGUMENT', '表情含义备注不能为空')
        }

        let tags: readonly string[] = []
        if (args.tags !== undefined) {
          if (!Array.isArray(args.tags) || args.tags.some((t) => typeof t !== 'string')) {
            throw new BrainError('INVALID_ARGUMENT', 'tags 必须是字符串数组')
          }
          tags = args.tags.slice(0, 20).map((t) => cleanText(t).replace(/\n/g, '').trim()).filter(Boolean)
        }

        try {
          await deps.stickerLibrary.note(stickerId, evidenceRecordId, cleanedNote, tags, call)
        } catch (error) {
          if (error instanceof BrainError) throw error
          if (error instanceof Error && /NOT_FOUND|Invalid evidence/i.test(error.message)) {
            throw new BrainError('NOT_FOUND', '找不到匹配的同通道 L0 表情证据')
          }
          throw toSanitizedBrainError(error, '记录表情含义失败')
        }

        return JSON.stringify({
          ok: true,
          stickerId,
          evidenceRecordId,
        })
      },
    },

    {
      name: 'list_voices',
      description: '列出本地可用语音库条目',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      handler: async (rawArgs, call) => {
        assertNotDisposed(deps)
        parseQqChannel(call)
        assertObjectArgs(rawArgs)
        const config = deps.config()
        if (!config.voice.enabled) {
          return JSON.stringify({
            enabled: false,
            voices: [],
            note: '语音发送默认关闭，请在配置中开启 voice.enabled',
          })
        }
        const voices = await deps.voiceLibrary.list()
        return JSON.stringify({
          enabled: true,
          voices,
        })
      },
    },

    {
      name: 'send_voice',
      description: '发送本地语音库中的语音条',
      parameters: {
        type: 'object',
        properties: {
          voiceId: {
            type: 'string',
            description: '本地语音库条目 ID',
          },
          verify: {
            type: 'boolean',
            description: '可选，是否回读验证语音发送结果',
          },
        },
        required: ['voiceId'],
        additionalProperties: false,
      },
      handler: async (rawArgs, call) => {
        assertNotDisposed(deps)
        const { kind, id } = parseQqChannel(call)
        const config = deps.config()
        if (!config.voice.enabled) {
          throw new BrainError('UNAVAILABLE', '语音发送默认关闭，请在配置中开启 voice.enabled')
        }
        await assertChannelSendable(deps, config, call.channel, kind, id)

        const args = assertObjectArgs(rawArgs)
        if (typeof args.voiceId !== 'string' || !VOICE_ID_RE.test(args.voiceId)) {
          throw new BrainError('INVALID_ARGUMENT', '无效的语音 ID')
        }
        if (args.verify !== undefined && typeof args.verify !== 'boolean') {
          throw new BrainError('INVALID_ARGUMENT', 'verify 必须是布尔值')
        }

        try {
          const result = await deps.voiceLibrary.send(call.channel, args.voiceId, args.verify === true)
          return JSON.stringify({
            ok: true,
            messageId: result.messageId,
            verification: result.verification,
          })
        } catch (error) {
          const partial = extractPartialSent(error)
          if (partial) {
            return JSON.stringify({
              ok: false,
              partial: true,
              sent: true,
              deliveredMessageIds: partial.deliveredIds,
              messageId: partial.messageId,
              verification: 'failed',
              warning: '语音已送达 QQ，但本地后续记录失败，请勿盲目重复发送',
            })
          }
          if (error instanceof Error && /too large|duration|exceeds RPC budget/i.test(error.message)) {
            throw new BrainError('INVALID_ARGUMENT', '语音文件不可用、超时长或超出体积限制')
          }
          throw toSanitizedBrainError(error, '发送 QQ 语音失败')
        }
      },
    },

    {
      name: 'get_message_detail',
      description: '读取当前通道内可见的 L0 原始消息详情',
      parameters: {
        type: 'object',
        properties: {
          recordId: {
            type: 'string',
            description: '当前通道内的 L0 记录 ID（与 messageId 二选一）',
          },
          messageId: {
            type: 'string',
            description: '当前通道内的 QQ 消息 ID（与 recordId 二选一）',
          },
        },
        additionalProperties: false,
      },
      handler: async (rawArgs, call) => {
        assertNotDisposed(deps)
        parseQqChannel(call)
        requireChannelEventReader(deps)
        const args = assertObjectArgs(rawArgs)

        const hasRecordId = args.recordId !== undefined
        const hasMessageId = args.messageId !== undefined
        if (hasRecordId === hasMessageId) {
          throw new BrainError('INVALID_ARGUMENT', '必须且只能提供 recordId 或 messageId 中的一个')
        }

        let authorizedEvent: ChannelEventResult | undefined
        if (hasRecordId) {
          if (typeof args.recordId !== 'string' || !RECORD_ID_RE.test(args.recordId.trim())) {
            throw new BrainError('INVALID_ARGUMENT', '无效的 recordId')
          }
          authorizedEvent = await authorizeVisibleL0(deps, args.recordId.trim(), call)
        } else {
          const messageId = parseMessageIdStrict(args.messageId)
          const entry = await deps.mediaStore.read(call.channel, messageId, async (recordId) => {
            const ev = await authorizeVisibleL0(deps, recordId, call)
            if (!ev) return false
            authorizedEvent = ev
            return true
          })
          if (!entry) authorizedEvent = undefined
        }

        if (!authorizedEvent) {
          throw new BrainError('NOT_FOUND', '找不到当前通道中的这条消息')
        }

        const { record, disclosure } = authorizedEvent
        return JSON.stringify({
          source: 'QQ 原始消息详情（外部内容）',
          disclosure,
          record: {
            id: record.id,
            kind: record.kind,
            channel: record.channel,
            actor: record.actor,
            tEvent: record.tEvent,
            content: record.content,
          },
        })
      },
    },
  ]

  const disposables = tools.map((tool) => ctx.tools.register(tool))
  return () => {
    for (const dispose of disposables) {
      dispose()
    }
  }
}
