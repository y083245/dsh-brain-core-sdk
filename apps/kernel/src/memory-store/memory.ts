import { BrainError } from '@brain-core/sdk'
import type { Layer, MemoryRecord, RecordPatch } from '@brain-core/sdk'
import { createUlid } from '@brain-core/shared'
import type { Clock, NewRecord, Page, RecordFilter, RecordStore } from '../contracts/index.ts'

const LAYER_ORDER: Record<Layer, number> = { L0: 0, L1: 1, L2: 2, L3: 3 }

function clone<T>(value: T): T {
  return structuredClone(value)
}

function byId(a: { readonly id: string }, b: { readonly id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function byEventAndId(a: MemoryRecord, b: MemoryRecord): number {
  return a.tEvent !== b.tEvent ? a.tEvent - b.tEvent : byId(a, b)
}

function invalidArgument(message: string): BrainError {
  return new BrainError('INVALID_ARGUMENT', message)
}

function matchesFilter(record: MemoryRecord, filter: RecordFilter): boolean {
  if (filter.layers !== undefined && !filter.layers.includes(record.layer)) return false
  if (filter.channels !== undefined && !filter.channels.includes(record.channel)) return false
  if (filter.subjects !== undefined && !record.subjects.some((subject) => filter.subjects?.includes(subject))) return false
  if (filter.actors !== undefined && !filter.actors.includes(record.actor)) return false
  if (filter.kinds !== undefined && !filter.kinds.includes(record.kind)) return false
  if (filter.statuses !== undefined && !filter.statuses.includes(record.status)) return false
  if (filter.from !== undefined && record.tEvent < filter.from) return false
  if (filter.to !== undefined && record.tEvent > filter.to) return false
  return true
}

/** The in-memory RecordStore. Same rules as the SQLite one, so both pass the same suite (FR-M01). */
export function createMemoryRecordStore(options: { readonly clock: Clock }): RecordStore {
  const records = new Map<string, MemoryRecord>()
  const idempotency = new Map<string, string>()
  const nextId = createUlid({ now: () => options.clock.now() })

  function assertEvidence(record: NewRecord): void {
    if (record.layer === 'L0') {
      if (record.evidence.length !== 0) throw invalidArgument('L0 records take no evidence')
      return
    }
    if (record.evidence.length === 0) throw invalidArgument(`${record.layer} records need at least one evidence reference`)
    for (const reference of record.evidence) {
      const target = records.get(reference.id)
      if (target === undefined) throw invalidArgument(`evidence ${reference.id} does not exist`)
      if (target.status === 'tombstoned') throw invalidArgument(`evidence ${reference.id} is tombstoned`)
      if (LAYER_ORDER[target.layer] >= LAYER_ORDER[record.layer]) throw invalidArgument(`evidence ${reference.id} is not from a lower layer`)
    }
  }

  return {
    async insert(record: NewRecord, idempotencyKey?: string): Promise<MemoryRecord> {
      const key = idempotencyKey === undefined ? undefined : `${record.source}\u0000${idempotencyKey}`
      if (key !== undefined) {
        const existingId = idempotency.get(key)
        const existing = existingId === undefined ? undefined : records.get(existingId)
        if (existing !== undefined) return clone(existing)
      }
      assertEvidence(record)
      const stored: MemoryRecord = {
        ...clone(record),
        id: `${record.layer.toLowerCase()}_${nextId()}`,
        tIngest: options.clock.now(),
        status: 'active',
        version: 1,
      }
      records.set(stored.id, stored)
      if (key !== undefined) idempotency.set(key, stored.id)
      return clone(stored)
    },

    async get(id: string): Promise<MemoryRecord | null> {
      const record = records.get(id)
      return record === undefined ? null : clone(record)
    },

    async patch(id: string, patch: RecordPatch, expectedVersion: number): Promise<MemoryRecord> {
      const current = records.get(id)
      if (current === undefined || current.status === 'tombstoned') throw new BrainError('NOT_FOUND', `record ${id} not found`)
      if (current.layer === 'L0') throw new BrainError('PERMISSION_DENIED', 'L0 records cannot be patched')
      if (expectedVersion !== current.version) throw new BrainError('CONFLICT', `record ${id} is at version ${current.version}`)
      if (patch.status === 'tombstoned') throw invalidArgument("use tombstone() instead of patch({ status: 'tombstoned' })")
      const next: MemoryRecord = {
        ...current,
        ...(patch.content === undefined ? {} : { content: clone(patch.content) }),
        ...(patch.subjects === undefined ? {} : { subjects: clone(patch.subjects) }),
        ...(patch.visibility === undefined ? {} : { visibility: patch.visibility }),
        ...(patch.confidence === undefined ? {} : { confidence: patch.confidence }),
        ...(patch.importance === undefined ? {} : { importance: patch.importance }),
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.validTo === undefined ? {} : { validTo: patch.validTo }),
        version: current.version + 1,
      }
      records.set(id, next)
      return clone(next)
    },

    async tombstone(id: string): Promise<MemoryRecord> {
      const current = records.get(id)
      if (current === undefined) throw new BrainError('NOT_FOUND', `record ${id} not found`)
      if (current.status === 'tombstoned') return clone(current)
      const next: MemoryRecord = { ...current, content: {}, status: 'tombstoned', version: current.version + 1 }
      records.set(id, next)
      return clone(next)
    },

    async list(filter: RecordFilter, page: { readonly limit: number; readonly cursor?: string }): Promise<Page<MemoryRecord>> {
      if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 1000) {
        throw invalidArgument('page.limit must be an integer from 1 to 1000')
      }
      const filtered = [...records.values()].filter((record) => matchesFilter(record, filter)).sort(byId)
      const remaining = page.cursor === undefined ? filtered : filtered.filter((record) => record.id > (page.cursor as string))
      const items = remaining.slice(0, page.limit)
      if (items.length < remaining.length) {
        return { items: items.map(clone), nextCursor: (items[items.length - 1] as MemoryRecord).id }
      }
      return { items: items.map(clone) }
    },

    async dependentsOf(id: string): Promise<readonly MemoryRecord[]> {
      return [...records.values()]
        .filter((record) => record.evidence.some((reference) => reference.id === id))
        .sort(byId)
        .map(clone)
    },

    async *scan(layers?: readonly Layer[]): AsyncIterable<MemoryRecord> {
      const snapshot = [...records.values()]
        .filter((record) => layers === undefined || layers.includes(record.layer))
        .sort(byId)
      for (const record of snapshot) yield clone(record)
    },

    async neighborsOf(id: string, window: number): Promise<{
      readonly before: readonly MemoryRecord[]
      readonly after: readonly MemoryRecord[]
    }> {
      if (!Number.isInteger(window) || window < 0 || window > 10) {
        throw invalidArgument('neighbors window must be an integer in 0..10')
      }
      if (window === 0) return { before: [], after: [] }
      const anchor = records.get(id)
      if (anchor === undefined || anchor.layer !== 'L0' || anchor.status !== 'active') {
        return { before: [], after: [] }
      }
      const sameChannel = [...records.values()]
        .filter((record) => record.channel === anchor.channel && record.layer === 'L0' && record.status === 'active')
        .sort(byEventAndId)
      const index = sameChannel.findIndex((record) => record.id === anchor.id)
      if (index === -1) return { before: [], after: [] }
      return {
        before: sameChannel.slice(Math.max(0, index - window), index).map(clone),
        after: sameChannel.slice(index + 1, index + 1 + window).map(clone),
      }
    },

    async close(): Promise<void> {
      // Nothing to release; the maps live as long as the caller keeps the reference.
    },
  }
}
