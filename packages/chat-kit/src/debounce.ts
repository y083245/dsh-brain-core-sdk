import type { ChannelKind, ChatClock, ChatTimers } from './types.ts'
import { assertNonEmptyString, assertNonNegativeFinite } from './validate.ts'

export interface MessageDebouncerOptions<T> {
  readonly clock: ChatClock
  readonly timers: ChatTimers
  readonly minQuietMs: number
  readonly maxWaitMs: number
  readonly privateMinQuietMs?: number
  readonly onFlush: (channel: string, items: readonly T[]) => Promise<void> | void
}

export interface DebouncePushOptions {
  readonly channelKind?: ChannelKind
  readonly quietMs?: number
}

export interface MessageDebouncer<T> {
  push(channel: string, item: T, opts?: DebouncePushOptions): Promise<void>
  flushNow(channel: string): Promise<void>
  cancel(channel: string): void
  pendingCount(channel: string): number
  dispose(): void
}

interface PendingBatch<T> {
  readonly items: T[]
  readonly firstPushAt: number
  timer: unknown
  hasTimer: boolean
}

export function createMessageDebouncer<T>(options: MessageDebouncerOptions<T>): MessageDebouncer<T> {
  const minQuietMs = assertNonNegativeFinite(options.minQuietMs, 'minQuietMs')
  const maxWaitMs = assertNonNegativeFinite(options.maxWaitMs, 'maxWaitMs')
  if (maxWaitMs < minQuietMs) {
    throw new RangeError('maxWaitMs must be greater than or equal to minQuietMs')
  }
  const privateMinQuietMs = options.privateMinQuietMs === undefined
    ? undefined
    : assertNonNegativeFinite(options.privateMinQuietMs, 'privateMinQuietMs')

  const { clock, timers, onFlush } = options
  const pending = new Map<string, PendingBatch<T>>()
  let disposed = false

  const clearEntryTimer = (entry: PendingBatch<T>): void => {
    if (entry.hasTimer) {
      timers.clearTimeout(entry.timer)
      entry.hasTimer = false
      entry.timer = undefined
    }
  }

  const flushNow = async (channel: string): Promise<void> => {
    const key = assertNonEmptyString(channel, 'channel')
    const entry = pending.get(key)
    if (entry === undefined) return
    clearEntryTimer(entry)
    pending.delete(key)
    await onFlush(key, entry.items)
  }

  return {
    async push(channel: string, item: T, opts?: DebouncePushOptions): Promise<void> {
      const key = assertNonEmptyString(channel, 'channel')
      if (disposed) return

      const quietMs = opts?.quietMs !== undefined
        ? assertNonNegativeFinite(opts.quietMs, 'quietMs')
        : (opts?.channelKind === 'private' && privateMinQuietMs !== undefined
            ? privateMinQuietMs
            : minQuietMs)

      const now = clock.now()
      let entry = pending.get(key)
      if (entry === undefined) {
        entry = {
          items: [],
          firstPushAt: now,
          timer: undefined,
          hasTimer: false,
        }
        pending.set(key, entry)
      }

      entry.items.push(item)
      clearEntryTimer(entry)

      if (quietMs === 0 || now - entry.firstPushAt >= maxWaitMs) {
        await flushNow(key)
        return
      }

      const remainingMaxWait = Math.max(0, entry.firstPushAt + maxWaitMs - now)
      const delay = Math.min(quietMs, remainingMaxWait)
      if (delay === 0) {
        await flushNow(key)
        return
      }

      entry.hasTimer = true
      entry.timer = timers.setTimeout(() => {
        void flushNow(key)
      }, delay)
    },

    flushNow,

    cancel(channel: string): void {
      const key = assertNonEmptyString(channel, 'channel')
      const entry = pending.get(key)
      if (entry === undefined) return
      clearEntryTimer(entry)
      pending.delete(key)
    },

    pendingCount(channel: string): number {
      const key = assertNonEmptyString(channel, 'channel')
      return pending.get(key)?.items.length ?? 0
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      for (const entry of pending.values()) {
        clearEntryTimer(entry)
      }
      pending.clear()
    },
  }
}
