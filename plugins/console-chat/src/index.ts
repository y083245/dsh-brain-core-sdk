import {
  buildMessageSnapshot,
  computeHumanPauseMs,
  createMessageDebouncer,
  createReadCursor,
  type ChatClock,
  type ChatTimers,
  type FormattedSnapshotItem,
  type MessageDebouncer,
} from '@brain-core/chat-kit'
import { BrainError, type BrainContext, type PluginApply, type WakeMessage, type WakeResult } from '@brain-core/sdk'
import { renderChatUiHtml } from './ui.ts'

export interface ChatHistoryEntry {
  readonly messageId: string
  readonly channel: string
  readonly direction: 'inbound' | 'outbound'
  readonly actor: string
  readonly displayName: string
  readonly text: string
  readonly replyTo?: string
  readonly recordId: string
  readonly tEvent: number
}

export interface InboundMessageRequest {
  readonly channel?: string              // defaults to 'console-chat:private:owner'
  readonly account?: string              // defaults to 'owner' (resolved as 'console-chat:owner')
  readonly displayName?: string          // defaults to '主人'
  readonly text: string
  readonly tEvent?: number
  readonly messageId?: string
  readonly debounceMs?: number
}

interface InboundMessageResult {
  readonly recordId: string
  readonly personId: string
  readonly messageId: string
  readonly wake: WakeResult
}

const DEFAULT_CHANNEL = 'console-chat:private:owner'
const DEFAULT_ACCOUNT = 'owner'
const DEFAULT_DISPLAY_NAME = '主人'
const VALID_CHANNEL = /^console-chat:(?:private|group):[^\s]+$/

function assertValidChannel(channel: unknown): string {
  if (typeof channel !== 'string' || !VALID_CHANNEL.test(channel)) {
    throw new BrainError(
      'INVALID_ARGUMENT',
      'channel must match console-chat:private:<id> or console-chat:group:<id> without whitespace',
    )
  }
  return channel
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BrainError('INVALID_ARGUMENT', `${field} must be a non-empty string`)
  }
  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface ChannelWakeBatchOptions {
  readonly clock?: ChatClock
  readonly timers?: ChatTimers
  readonly minQuietMs?: number
  readonly maxWaitMs?: number
  readonly onFlush: (channel: string, messages: readonly WakeMessage[]) => Promise<void> | void
}

/** Optional chat-kit debouncer helper for batching inbound wake messages per channel. */
export function createConsoleChatDebouncer(options: ChannelWakeBatchOptions): MessageDebouncer<WakeMessage> {
  return createMessageDebouncer<WakeMessage>({
    clock: options.clock ?? { now: () => Date.now() },
    timers: options.timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    minQuietMs: options.minQuietMs ?? 0,
    maxWaitMs: options.maxWaitMs ?? 0,
    onFlush: options.onFlush,
  })
}

export const apply: PluginApply = (ctx: BrainContext): void => {
  const profiles = new Map<string, string>([['console-chat:owner', DEFAULT_DISPLAY_NAME]])
  const channelMembers = new Map<string, Set<string>>()
  const history = new Map<string, ChatHistoryEntry[]>()
  const inboundDedupe = new Map<string, InboundMessageResult>()
  const latestWakeByChannel = new Map<string, string>()
  const readCursor = createReadCursor()
  let nextMessageSeq = 0

  const nextMessageId = (): string => {
    nextMessageSeq += 1
    return `msg_${nextMessageSeq}`
  }

  const appendHistory = (channel: string, entry: ChatHistoryEntry): void => {
    const list = history.get(channel) ?? []
    list.push(entry)
    history.set(channel, list)
  }

  ctx.channel.provide({
    send: async (channel) => {
      assertValidChannel(channel)
      return { messageId: nextMessageId() }
    },
    members: async (channel) => [...(channelMembers.get(channel) ?? [])].sort(),
    resolveIdentity: async (account) => {
      if (!account.startsWith('console-chat:')) return null
      const displayName = profiles.get(account)
      return displayName === undefined ? null : { displayName }
    },
  })

  ctx.tools.register({
    name: 'send_message',
    description: '在控制台对话里发送一条消息。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要发送的消息内容' },
        replyTo: { type: 'string', description: '回复的消息 ID' },
      },
      required: ['text'],
    },
    handler: async (args, call) => {
      const text = assertNonEmptyString(args.text, 'text')
      if (args.replyTo !== undefined && typeof args.replyTo !== 'string') {
        throw new BrainError('INVALID_ARGUMENT', 'replyTo must be a string')
      }
      const replyTo = args.replyTo
      const channel = assertValidChannel(call.channel)

      const sent = await ctx.channel.send(channel, {
        text,
        ...(replyTo === undefined ? {} : { replyTo }),
      })
      const messageId = sent.messageId ?? nextMessageId()
      const tEvent = Date.now()
      const ingested = await ctx.memory.ingest({
        kind: 'console-chat.message',
        channel,
        subjects: ['self'],
        actor: 'self',
        content: {
          text,
          direction: 'outbound',
          messageId,
          ...(replyTo === undefined ? {} : { replyTo }),
        },
        tEvent,
        idempotencyKey: `console-chat:out:${call.wakeId}:${messageId}`,
      })

      appendHistory(channel, {
        messageId,
        channel,
        direction: 'outbound',
        actor: 'self',
        displayName: '她',
        text,
        ...(replyTo === undefined ? {} : { replyTo }),
        recordId: ingested.id,
        tEvent,
      })

      const suggestedPauseMs = computeHumanPauseMs(text)
      ctx.logger.info('console_chat.sent', { channel, recordId: ingested.id, suggestedPauseMs })
      return 'sent'
    },
  })

  ctx.http.route('POST', '/messages', async (request) => {
    if (!isPlainObject(request.body)) {
      throw new BrainError('INVALID_ARGUMENT', 'request body must be an object')
    }
    const body = request.body
    const channel = assertValidChannel(body.channel === undefined ? DEFAULT_CHANNEL : body.channel)
    const text = assertNonEmptyString(body.text, 'text')

    const rawAccount = body.account === undefined ? DEFAULT_ACCOUNT : body.account
    const account = assertNonEmptyString(rawAccount, 'account')
    if (/\s/.test(account)) {
      throw new BrainError('INVALID_ARGUMENT', 'account must not contain whitespace')
    }
    const fullAccount = account.startsWith('console-chat:') ? account : `console-chat:${account}`

    if (body.displayName !== undefined && typeof body.displayName !== 'string') {
      throw new BrainError('INVALID_ARGUMENT', 'displayName must be a string')
    }
    const displayName = body.displayName !== undefined && body.displayName.trim().length > 0
      ? body.displayName
      : (profiles.get(fullAccount) ?? DEFAULT_DISPLAY_NAME)

    const tEvent = body.tEvent === undefined ? Date.now() : body.tEvent
    if (typeof tEvent !== 'number' || !Number.isFinite(tEvent)) {
      throw new BrainError('INVALID_ARGUMENT', 'tEvent must be a finite number')
    }

    if (body.debounceMs !== undefined && (typeof body.debounceMs !== 'number' || !Number.isFinite(body.debounceMs) || body.debounceMs < 0)) {
      throw new BrainError('INVALID_ARGUMENT', 'debounceMs must be a non-negative finite number')
    }
    const debounceMs = body.debounceMs

    const messageId = body.messageId === undefined
      ? nextMessageId()
      : assertNonEmptyString(body.messageId, 'messageId')

    profiles.set(fullAccount, displayName)
    const personId = await ctx.identity.resolve(fullAccount)
    const members = channelMembers.get(channel) ?? new Set<string>()
    members.add(personId)
    channelMembers.set(channel, members)

    const dedupeKey = `${channel}\u0000${messageId}`
    const cached = inboundDedupe.get(dedupeKey)
    if (cached !== undefined) {
      return cached
    }

    const ingested = await ctx.memory.ingest({
      kind: 'console-chat.message',
      channel,
      subjects: [personId],
      actor: personId,
      content: {
        text,
        direction: 'inbound',
        account: fullAccount,
        displayName,
        messageId,
      },
      tEvent,
      idempotencyKey: `console-chat:in:${channel}:${messageId}`,
    })

    const existingInHistory = (history.get(channel) ?? []).some(
      (entry) => entry.direction === 'inbound' && entry.messageId === messageId,
    )
    if (!existingInHistory) {
      appendHistory(channel, {
        messageId,
        channel,
        direction: 'inbound',
        actor: personId,
        displayName,
        text,
        recordId: ingested.id,
        tEvent,
      })
    }

    readCursor.onInbound(channel, messageId, tEvent)

    const wake = await ctx.agent.wake(channel, {
      reason: 'message',
      ...(debounceMs === undefined ? {} : { debounceMs }),
      messages: [{
        id: ingested.id,
        actor: personId,
        name: displayName,
        text,
        tEvent,
      }],
    })
    readCursor.markRead(channel, messageId, Date.now())
    latestWakeByChannel.set(channel, wake.wakeId)

    const result: InboundMessageResult = {
      recordId: ingested.id,
      personId,
      messageId,
      wake,
    }
    inboundDedupe.set(dedupeKey, result)
    return result
  })

  ctx.http.route('GET', '/messages', async (request) => {
    const channel = assertValidChannel(request.query.channel ?? DEFAULT_CHANNEL)
    const entries = history.get(channel) ?? []
    const now = Date.now()
    const cursor = readCursor.get(channel)
    const snapshot: readonly FormattedSnapshotItem[] = buildMessageSnapshot(
      entries.map((entry) => ({
        id: entry.messageId,
        who: entry.displayName,
        text: entry.text,
        tEvent: entry.tEvent,
        direction: entry.direction,
      })),
      now,
    )
    return {
      channel,
      items: [...entries],
      unreadCount: cursor.unreadCount,
      ...(cursor.lastReadMessageId === undefined ? {} : { lastReadMessageId: cursor.lastReadMessageId }),
      ...(cursor.lastReadAt === undefined ? {} : { lastReadAt: cursor.lastReadAt }),
      snapshot,
    }
  })

  ctx.http.route('GET', '/ui', async (request) => {
    const channel = assertValidChannel(request.query.channel ?? DEFAULT_CHANNEL)
    const messages = history.get(channel) ?? []
    const latestWakeId = latestWakeByChannel.get(channel)
    const cursor = readCursor.get(channel)
    return renderChatUiHtml({
      channel,
      messages,
      unreadCount: cursor.unreadCount,
      now: Date.now(),
      ...(latestWakeId === undefined ? {} : { latestWakeId }),
    })
  })

  ctx.console.page({
    id: 'chat',
    title: '与她对话',
    entry: '/api/v1/plugins/console-chat/ui',
  })
}
