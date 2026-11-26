import type { ChatSnapshotMessage, FormattedSnapshotItem } from './types.ts'
import { assertFiniteNumber, assertNonNegativeFinite } from './validate.ts'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

export function formatRelativeTime(elapsedMs: number): string {
  const ms = assertFiniteNumber(elapsedMs, 'elapsedMs')
  if (ms < MINUTE_MS) return '刚刚'
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)} 分钟前`
  if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)} 小时前`
  return `${Math.floor(ms / DAY_MS)} 天前`
}

export function truncateCodePoints(text: string, maxChars: number): string {
  if (typeof text !== 'string') {
    throw new TypeError('text must be a string')
  }
  const limit = assertNonNegativeFinite(maxChars, 'maxChars')
  const points = [...text]
  if (points.length <= limit) return text
  const intLimit = Math.floor(limit)
  if (intLimit <= 0) return ''
  if (intLimit === 1) return '…'
  return `${points.slice(0, intLimit - 1).join('')}…`
}

export interface SnapshotOptions {
  readonly maxMessages?: number
  readonly maxMessageChars?: number
  readonly maxTotalChars?: number
}

export function buildMessageSnapshot(
  messages: readonly ChatSnapshotMessage[],
  now: number,
  options?: SnapshotOptions,
): readonly FormattedSnapshotItem[] {
  const nowTs = assertFiniteNumber(now, 'now')
  const maxMessages = options?.maxMessages === undefined
    ? undefined
    : assertNonNegativeFinite(options.maxMessages, 'maxMessages')
  const maxMessageChars = options?.maxMessageChars === undefined
    ? undefined
    : assertNonNegativeFinite(options.maxMessageChars, 'maxMessageChars')
  const maxTotalChars = options?.maxTotalChars === undefined
    ? undefined
    : assertNonNegativeFinite(options.maxTotalChars, 'maxTotalChars')

  if (maxMessages === 0 || messages.length === 0) return []

  const windowed = maxMessages === undefined
    ? messages
    : messages.slice(-Math.floor(maxMessages))

  const formatted: FormattedSnapshotItem[] = windowed.map((msg) => ({
    id: msg.id,
    who: msg.who,
    ago: formatRelativeTime(nowTs - msg.tEvent),
    text: maxMessageChars === undefined ? msg.text : truncateCodePoints(msg.text, maxMessageChars),
    ...(msg.direction !== undefined ? { direction: msg.direction } : {}),
    ...(msg.hasMedia === true ? { hasMedia: true as const } : {}),
    ...(msg.forwarded === true ? { forwarded: true as const } : {}),
  }))

  if (maxTotalChars === undefined) return formatted

  const selected: FormattedSnapshotItem[] = []
  let usedChars = 0
  for (let i = formatted.length - 1; i >= 0; i -= 1) {
    const item = formatted[i]!
    const itemChars = [...item.text].length
    if (usedChars + itemChars > maxTotalChars) break
    selected.push(item)
    usedChars += itemChars
  }
  selected.reverse()
  return selected
}
