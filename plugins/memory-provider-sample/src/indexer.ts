import type { Layer, MemoryProviderHit, MemoryProviderQuery, MemoryRecord } from '@dsh-brain-core/sdk'

interface IndexedMeta {
  readonly id: string
  readonly tokens: ReadonlySet<string>
  readonly layer: Layer
  readonly channel: string
  readonly subjects: readonly string[]
  readonly tEvent: number
}

const MAX_EXTRACT_DEPTH = 4

function collectStrings(value: unknown, depth: number, out: string[]): void {
  if (depth > MAX_EXTRACT_DEPTH || value === null || value === undefined) return
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed !== '') out.push(trimmed)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, depth + 1, out)
    return
  }
  if (typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      collectStrings(entry, depth + 1, out)
    }
  }
}

/** Extracts text segments from a record content object for tokenization without retaining raw text. */
export function extractRecordText(content: Readonly<Record<string, unknown>>): string {
  const parts: string[] = []
  collectStrings(content, 0, parts)
  return parts.join(' ')
}

/**
 * Tokenizes mixed English/CJK text into normalized word tokens and CJK character bigrams
 * (plus CJK unigrams when a run has length 1) for zero-dependency recall.
 */
export function tokenizeText(text: string): Set<string> {
  const tokens = new Set<string>()
  const normalized = text.toLowerCase().trim()
  if (normalized === '') return tokens

  const wordMatches = normalized.match(/[a-z0-9_]+/g)
  if (wordMatches !== null) {
    for (const word of wordMatches) {
      tokens.add(word)
    }
  }

  // Split non-ASCII / CJK contiguous segments into character bigrams (and unigrams for single chars).
  const cjkRuns = normalized.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g)
  if (cjkRuns !== null) {
    for (const run of cjkRuns) {
      const chars = [...run]
      if (chars.length === 1) {
        tokens.add(chars[0]!)
      } else {
        for (let i = 0; i < chars.length - 1; i += 1) {
          tokens.add(`${chars[i]!}${chars[i + 1]!}`)
        }
        for (const ch of chars) {
          tokens.add(ch)
        }
      }
    }
  }

  return tokens
}

export interface SampleIndex {
  upsert(record: MemoryRecord): void
  forget(ids: readonly string[]): void
  search(query: MemoryProviderQuery): readonly MemoryProviderHit[]
  has(id: string): boolean
  size(): number
}

/** In-memory inverted index storing only token sets and filter metadata (never raw text). */
export function createSampleIndex(): SampleIndex {
  const docs = new Map<string, IndexedMeta>()
  const postings = new Map<string, Set<string>>()

  function removeDoc(id: string): void {
    const existing = docs.get(id)
    if (existing === undefined) return
    for (const token of existing.tokens) {
      const bucket = postings.get(token)
      if (bucket === undefined) continue
      bucket.delete(id)
      if (bucket.size === 0) postings.delete(token)
    }
    docs.delete(id)
  }

  return {
    upsert(record) {
      if (record.status !== 'active' || record.layer === 'L3') {
        removeDoc(record.id)
        return
      }
      removeDoc(record.id)
      const tokens = tokenizeText(extractRecordText(record.content))
      if (tokens.size === 0) return
      const meta: IndexedMeta = {
        id: record.id,
        tokens,
        layer: record.layer,
        channel: record.channel,
        subjects: [...record.subjects],
        tEvent: record.tEvent,
      }
      docs.set(record.id, meta)
      for (const token of tokens) {
        let bucket = postings.get(token)
        if (bucket === undefined) {
          bucket = new Set()
          postings.set(token, bucket)
        }
        bucket.add(record.id)
      }
    },

    forget(ids) {
      for (const id of ids) {
        removeDoc(id)
      }
    },

    search(query) {
      if (query.limit <= 0 || docs.size === 0) return []
      const queryTokens = tokenizeText(query.query)
      if (queryTokens.size === 0) return []

      const matchCounts = new Map<string, number>()
      for (const token of queryTokens) {
        const bucket = postings.get(token)
        if (bucket === undefined) continue
        for (const id of bucket) {
          matchCounts.set(id, (matchCounts.get(id) ?? 0) + 1)
        }
      }

      const hits: MemoryProviderHit[] = []
      for (const [id, matched] of matchCounts) {
        const meta = docs.get(id)
        if (meta === undefined) continue
        if (query.layers !== undefined && !query.layers.includes(meta.layer)) continue
        if (query.channels !== undefined && !query.channels.includes(meta.channel)) continue
        if (query.subjects !== undefined && query.subjects.length > 0
          && !meta.subjects.some((subject) => query.subjects!.includes(subject))) continue
        if (query.from !== undefined && meta.tEvent < query.from) continue
        if (query.to !== undefined && meta.tEvent > query.to) continue

        const coverage = matched / queryTokens.size
        const density = matched / meta.tokens.size
        hits.push({ id, score: coverage + density * 0.1 })
      }

      hits.sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score
        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
      })

      return hits.slice(0, query.limit)
    },

    has(id) {
      return docs.has(id)
    },

    size() {
      return docs.size
    },
  }
}
