import type { TopicEntry } from './types.ts'
import {
  assertFiniteNumber,
  assertNonEmptyString,
  assertNonNegativeFinite,
  assertPositiveInteger,
  isPlainObject,
} from './validate.ts'

const DEFAULT_WINDOW_MS = 24 * 60 * 60_000
const DEFAULT_MAX_ENTRIES = 20
const DEFAULT_THRESHOLD = 0.55

function extractBigrams(text: string): readonly string[] {
  const normalized = text.toLowerCase().replace(/[\p{P}\p{S}\p{Z}\s]+/gu, '')
  const chars = [...normalized]
  if (chars.length === 0) return []
  if (chars.length === 1) return [chars[0]!]
  const bigrams: string[] = []
  for (let i = 0; i < chars.length - 1; i += 1) {
    bigrams.push(`${chars[i]!}${chars[i + 1]!}`)
  }
  return bigrams
}

function countTokens(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1)
  }
  return counts
}

export function topicSimilarity(a: string, b: string): number {
  if (typeof a !== 'string' || typeof b !== 'string') {
    throw new TypeError('topic inputs must be strings')
  }
  const bigramsA = extractBigrams(a)
  const bigramsB = extractBigrams(b)
  if (bigramsA.length === 0 || bigramsB.length === 0) return 0

  const countsA = countTokens(bigramsA)
  const countsB = countTokens(bigramsB)
  let intersection = 0
  for (const [gram, countA] of countsA) {
    const countB = countsB.get(gram)
    if (countB !== undefined) {
      intersection += Math.min(countA, countB)
    }
  }
  return (2 * intersection) / (bigramsA.length + bigramsB.length)
}

export interface TopicNoveltyResult {
  readonly allowed: boolean
  readonly maxSimilarity: number
  readonly matchedTopic?: string
}

export interface TopicDeduperSnapshot {
  readonly version: 1
  readonly channels: Readonly<Record<string, readonly TopicEntry[]>>
}

export interface TopicDeduper {
  check(channel: string, candidateTopic: string, now: number): TopicNoveltyResult
  record(channel: string, topic: string, now: number): void
  snapshot(): TopicDeduperSnapshot
  restore(data: unknown): void
}

export function createTopicDeduper(options?: {
  readonly windowMs?: number
  readonly maxEntries?: number
  readonly threshold?: number
}): TopicDeduper {
  const windowMs = options?.windowMs === undefined
    ? DEFAULT_WINDOW_MS
    : assertNonNegativeFinite(options.windowMs, 'windowMs')
  const maxEntries = options?.maxEntries === undefined
    ? DEFAULT_MAX_ENTRIES
    : assertPositiveInteger(options.maxEntries, 'maxEntries')
  const threshold = options?.threshold === undefined
    ? DEFAULT_THRESHOLD
    : assertFiniteNumber(options.threshold, 'threshold')
  if (threshold < 0 || threshold > 1) {
    throw new RangeError('threshold must be between 0 and 1')
  }

  const channels = new Map<string, TopicEntry[]>()

  const prune = (channel: string, now: number): TopicEntry[] => {
    const existing = channels.get(channel)
    if (existing === undefined) return []
    const active = existing.filter((entry) => now - entry.recordedAt < windowMs)
    if (active.length === 0) {
      channels.delete(channel)
    } else {
      channels.set(channel, active)
    }
    return active
  }

  return {
    check(channel: string, candidateTopic: string, now: number): TopicNoveltyResult {
      const key = assertNonEmptyString(channel, 'channel')
      const ts = assertFiniteNumber(now, 'now')
      if (typeof candidateTopic !== 'string') {
        throw new TypeError('candidateTopic must be a string')
      }

      const active = prune(key, ts)
      let maxSimilarity = 0
      let matchedTopic: string | undefined

      for (const entry of active) {
        const sim = topicSimilarity(candidateTopic, entry.topic)
        if (sim > maxSimilarity) {
          maxSimilarity = sim
          matchedTopic = entry.topic
        }
      }

      const allowed = maxSimilarity < threshold
      return {
        allowed,
        maxSimilarity,
        ...(matchedTopic !== undefined ? { matchedTopic } : {}),
      }
    },

    record(channel: string, topic: string, now: number): void {
      const key = assertNonEmptyString(channel, 'channel')
      const text = assertNonEmptyString(topic, 'topic')
      const ts = assertFiniteNumber(now, 'now')

      const active = prune(key, ts)
      active.push({ topic: text, recordedAt: ts })
      while (active.length > maxEntries) {
        active.shift()
      }
      channels.set(key, active)
    },

    snapshot(): TopicDeduperSnapshot {
      const out: Record<string, readonly TopicEntry[]> = {}
      for (const [channel, entries] of channels) {
        out[channel] = entries.map((entry) => ({ ...entry }))
      }
      return { version: 1, channels: out }
    },

    restore(data: unknown): void {
      if (!isPlainObject(data) || data.version !== 1 || !isPlainObject(data.channels)) {
        throw new TypeError('data must be a valid TopicDeduperSnapshot (version 1)')
      }
      const next = new Map<string, TopicEntry[]>()
      for (const [channel, rawList] of Object.entries(data.channels)) {
        const key = assertNonEmptyString(channel, 'snapshot.channel')
        if (!Array.isArray(rawList)) {
          throw new TypeError(`snapshot.channels[${key}] must be an array`)
        }
        const entries: TopicEntry[] = []
        for (const item of rawList) {
          if (!isPlainObject(item)) {
            throw new TypeError(`snapshot.channels[${key}] items must be objects`)
          }
          entries.push({
            topic: assertNonEmptyString(item.topic, 'topic'),
            recordedAt: assertFiniteNumber(item.recordedAt, 'recordedAt'),
          })
        }
        next.set(key, entries.slice(-maxEntries))
      }
      channels.clear()
      for (const [k, v] of next) {
        channels.set(k, v)
      }
    },
  }
}
