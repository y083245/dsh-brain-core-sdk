import type { ReadCursorState } from './types.ts'
import { assertFiniteNumber, assertNonEmptyString, assertNonNegativeFinite, isPlainObject } from './validate.ts'

const MAX_SEEN_IDS_PER_CHANNEL = 1000

export interface ReadCursor {
  onInbound(channel: string, messageId: string, tEvent: number): ReadCursorState
  markRead(channel: string, messageId: string, at: number): ReadCursorState
  unreadOf<T extends { readonly messageId: string }>(channel: string, messages: readonly T[]): readonly T[]
  get(channel: string): ReadCursorState
  snapshot(): Readonly<Record<string, ReadCursorState>>
}

interface MutableCursorEntry {
  lastReadMessageId: string | undefined
  lastReadAt: number | undefined
  lastInboundMessageId: string | undefined
  lastInboundAt: number | undefined
  unreadCount: number
  seenInboundIds: Set<string>
}

function toReadOnlyState(entry: MutableCursorEntry): ReadCursorState {
  return {
    ...(entry.lastReadMessageId !== undefined ? { lastReadMessageId: entry.lastReadMessageId } : {}),
    ...(entry.lastReadAt !== undefined ? { lastReadAt: entry.lastReadAt } : {}),
    ...(entry.lastInboundMessageId !== undefined ? { lastInboundMessageId: entry.lastInboundMessageId } : {}),
    ...(entry.lastInboundAt !== undefined ? { lastInboundAt: entry.lastInboundAt } : {}),
    unreadCount: entry.unreadCount,
  }
}

export function createReadCursor(initial?: Readonly<Record<string, ReadCursorState>>): ReadCursor {
  const entries = new Map<string, MutableCursorEntry>()

  if (initial !== undefined) {
    if (!isPlainObject(initial)) {
      throw new TypeError('initial read cursor state must be an object')
    }
    for (const [channel, raw] of Object.entries(initial)) {
      const key = assertNonEmptyString(channel, 'channel')
      if (!isPlainObject(raw)) {
        throw new TypeError(`initial[${key}] must be an object`)
      }
      const seenInboundIds = new Set<string>()
      const lastReadMessageId = raw.lastReadMessageId === undefined
        ? undefined
        : assertNonEmptyString(raw.lastReadMessageId, 'lastReadMessageId')
      const lastReadAt = raw.lastReadAt === undefined
        ? undefined
        : assertFiniteNumber(raw.lastReadAt, 'lastReadAt')
      const lastInboundMessageId = raw.lastInboundMessageId === undefined
        ? undefined
        : assertNonEmptyString(raw.lastInboundMessageId, 'lastInboundMessageId')
      const lastInboundAt = raw.lastInboundAt === undefined
        ? undefined
        : assertFiniteNumber(raw.lastInboundAt, 'lastInboundAt')
      const unreadCount = raw.unreadCount === undefined
        ? 0
        : assertNonNegativeFinite(raw.unreadCount, 'unreadCount')
      if (lastInboundMessageId !== undefined) seenInboundIds.add(lastInboundMessageId)
      if (lastReadMessageId !== undefined) seenInboundIds.add(lastReadMessageId)
      entries.set(key, {
        lastReadMessageId,
        lastReadAt,
        lastInboundMessageId,
        lastInboundAt,
        unreadCount,
        seenInboundIds,
      })
    }
  }

  const getOrCreate = (channel: string): MutableCursorEntry => {
    const key = assertNonEmptyString(channel, 'channel')
    let entry = entries.get(key)
    if (entry === undefined) {
      entry = {
        lastReadMessageId: undefined,
        lastReadAt: undefined,
        lastInboundMessageId: undefined,
        lastInboundAt: undefined,
        unreadCount: 0,
        seenInboundIds: new Set<string>(),
      }
      entries.set(key, entry)
    }
    return entry
  }

  return {
    onInbound(channel: string, messageId: string, tEvent: number): ReadCursorState {
      const id = assertNonEmptyString(messageId, 'messageId')
      const ts = assertFiniteNumber(tEvent, 'tEvent')
      const entry = getOrCreate(channel)

      if (entry.seenInboundIds.has(id) || entry.lastReadMessageId === id) {
        return toReadOnlyState(entry)
      }

      if (entry.seenInboundIds.size >= MAX_SEEN_IDS_PER_CHANNEL) {
        const oldest = entry.seenInboundIds.values().next().value
        if (oldest !== undefined) entry.seenInboundIds.delete(oldest)
      }
      entry.seenInboundIds.add(id)
      entry.unreadCount += 1
      entry.lastInboundMessageId = id
      entry.lastInboundAt = ts
      return toReadOnlyState(entry)
    },

    markRead(channel: string, messageId: string, at: number): ReadCursorState {
      const id = assertNonEmptyString(messageId, 'messageId')
      const ts = assertFiniteNumber(at, 'at')
      const entry = getOrCreate(channel)
      entry.lastReadMessageId = id
      entry.lastReadAt = ts
      entry.unreadCount = 0
      entry.seenInboundIds.add(id)
      return toReadOnlyState(entry)
    },

    unreadOf<T extends { readonly messageId: string }>(channel: string, messages: readonly T[]): readonly T[] {
      const key = assertNonEmptyString(channel, 'channel')
      const entry = entries.get(key)
      if (entry === undefined || entry.lastReadMessageId === undefined) {
        return messages.slice()
      }
      let idx = -1
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i]!.messageId === entry.lastReadMessageId) {
          idx = i
          break
        }
      }
      return idx === -1 ? messages.slice() : messages.slice(idx + 1)
    },

    get(channel: string): ReadCursorState {
      const key = assertNonEmptyString(channel, 'channel')
      const entry = entries.get(key)
      return entry === undefined ? { unreadCount: 0 } : toReadOnlyState(entry)
    },

    snapshot(): Readonly<Record<string, ReadCursorState>> {
      const out: Record<string, ReadCursorState> = {}
      for (const [channel, entry] of entries) {
        out[channel] = toReadOnlyState(entry)
      }
      return out
    },
  }
}
