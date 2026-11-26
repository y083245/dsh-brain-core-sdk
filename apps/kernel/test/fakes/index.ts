import { BrainError, type Layer, type MemoryRecord, type RecordPatch, type Viewer } from '@brain-core/sdk'
import { createUlid } from '@brain-core/shared'
import type {
  ChannelFacts, Clock, IndexHit, IndexQuery, KeywordIndex, LlmClient, MemoryAudit, NewRecord, Page, Policy,
  PolicyDecision, ProfileReader, ProfileSnapshot, RecordFilter, RecordStore,
} from '../../src/contracts/index.ts'

const LAYER_ORDER: Record<Layer, number> = { L0: 0, L1: 1, L2: 2, L3: 3 }

function clone<T>(value: T): T {
  return structuredClone(value)
}

function byId(a: { readonly id: string }, b: { readonly id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
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

export class FakeClock implements Clock {
  #now: number

  constructor(start = Date.UTC(2026, 10, 7)) {
    this.#now = start
  }

  now(): number {
    return this.#now
  }

  advance(ms: number): void {
    this.#now += ms
  }

  set(ms: number): void {
    this.#now = ms
  }
}

export class FakeRecordStore implements RecordStore {
  readonly #records = new Map<string, MemoryRecord>()
  readonly #idempotency = new Map<string, string>()
  readonly #clock: Clock
  readonly #nextId: () => string

  constructor(clock: Clock) {
    this.#clock = clock
    this.#nextId = createUlid({ now: () => clock.now() })
  }

  #assertEvidence(record: NewRecord): void {
    if (record.layer === 'L0') {
      if (record.evidence.length !== 0) throw invalidArgument('L0 records take no evidence')
      return
    }
    if (record.evidence.length === 0) throw invalidArgument(`${record.layer} records need at least one evidence reference`)
    for (const reference of record.evidence) {
      const target = this.#records.get(reference.id)
      if (target === undefined) throw invalidArgument(`evidence ${reference.id} does not exist`)
      if (target.status === 'tombstoned') throw invalidArgument(`evidence ${reference.id} is tombstoned`)
      if (LAYER_ORDER[target.layer] >= LAYER_ORDER[record.layer]) throw invalidArgument(`evidence ${reference.id} is not from a lower layer`)
    }
  }

  async insert(record: NewRecord, idempotencyKey?: string): Promise<MemoryRecord> {
    const key = idempotencyKey === undefined ? undefined : `${record.source}\u0000${idempotencyKey}`
    if (key !== undefined) {
      const existingId = this.#idempotency.get(key)
      if (existingId !== undefined) {
        const existing = this.#records.get(existingId)
        if (existing !== undefined) return clone(existing)
      }
    }
    this.#assertEvidence(record)
    const stored: MemoryRecord = {
      ...clone(record),
      id: `${record.layer.toLowerCase()}_${this.#nextId()}`,
      tIngest: this.#clock.now(),
      status: 'active',
      version: 1,
    }
    this.#records.set(stored.id, stored)
    if (key !== undefined) this.#idempotency.set(key, stored.id)
    return clone(stored)
  }

  async get(id: string): Promise<MemoryRecord | null> {
    const record = this.#records.get(id)
    return record === undefined ? null : clone(record)
  }

  async patch(id: string, patch: RecordPatch, expectedVersion: number): Promise<MemoryRecord> {
    const current = this.#records.get(id)
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
    this.#records.set(id, next)
    return clone(next)
  }

  async tombstone(id: string): Promise<MemoryRecord> {
    const current = this.#records.get(id)
    if (current === undefined) throw new BrainError('NOT_FOUND', `record ${id} not found`)
    if (current.status === 'tombstoned') return clone(current)
    const next: MemoryRecord = { ...current, content: {}, status: 'tombstoned', version: current.version + 1 }
    this.#records.set(id, next)
    return clone(next)
  }

  async list(filter: RecordFilter, page: { readonly limit: number; readonly cursor?: string }): Promise<Page<MemoryRecord>> {
    if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 1000) {
      throw invalidArgument('page.limit must be an integer from 1 to 1000')
    }
    const filtered = [...this.#records.values()].filter((record) => matchesFilter(record, filter)).sort(byId)
    const remaining = page.cursor === undefined ? filtered : filtered.filter((record) => record.id > (page.cursor as string))
    const items = remaining.slice(0, page.limit)
    if (items.length < remaining.length) {
      return { items: items.map(clone), nextCursor: (items[items.length - 1] as MemoryRecord).id }
    }
    return { items: items.map(clone) }
  }

  async dependentsOf(id: string): Promise<readonly MemoryRecord[]> {
    return [...this.#records.values()]
      .filter((record) => record.evidence.some((reference) => reference.id === id))
      .sort(byId)
      .map(clone)
  }

  async *scan(layers?: readonly Layer[]): AsyncIterable<MemoryRecord> {
    const records = [...this.#records.values()]
      .filter((record) => layers === undefined || layers.includes(record.layer))
      .sort(byId)
    for (const record of records) yield clone(record)
  }

  async close(): Promise<void> {
    // The fake keeps its data; close only exists so callers can write cleanup code once.
  }
}

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(collectStrings)
  if (value !== null && typeof value === 'object') return Object.values(value as Record<string, unknown>).flatMap(collectStrings)
  return []
}

function matchesIndexQuery(record: MemoryRecord, query: IndexQuery): boolean {
  if (query.layers !== undefined && !query.layers.includes(record.layer)) return false
  if (query.channels !== undefined && !query.channels.includes(record.channel)) return false
  if (query.subjects !== undefined && !record.subjects.some((subject) => query.subjects?.includes(subject))) return false
  if (query.from !== undefined && record.tEvent < query.from) return false
  if (query.to !== undefined && record.tEvent > query.to) return false
  return true
}

export class FakeKeywordIndex implements KeywordIndex {
  readonly #records = new Map<string, MemoryRecord>()

  async add(record: MemoryRecord): Promise<void> {
    this.#records.delete(record.id)
    if (record.status !== 'active') return
    this.#records.set(record.id, clone(record))
  }

  async remove(id: string): Promise<void> {
    this.#records.delete(id)
  }

  async search(query: IndexQuery): Promise<readonly IndexHit[]> {
    const text = query.text.trim()
    if (text === '') return []
    const terms = text.toLowerCase().split(/\s+/)
    const hits: IndexHit[] = []
    for (const record of this.#records.values()) {
      if (!matchesIndexQuery(record, query)) continue
      const haystack = collectStrings(record.content).join(' ').toLowerCase()
      if (!terms.every((term) => haystack.includes(term))) continue
      hits.push({ id: record.id, score: 1 })
    }
    hits.sort(byId)
    return hits.slice(0, query.limit)
  }

  async rebuild(records: AsyncIterable<MemoryRecord>): Promise<number> {
    this.#records.clear()
    let active = 0
    for await (const record of records) {
      await this.add(record)
      if (record.status === 'active') active += 1
    }
    return active
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}

type Decide = (record: MemoryRecord, viewer: Viewer, facts: ChannelFacts) => PolicyDecision

const DEFAULT_DECISION: PolicyDecision = {
  visible: true,
  injection: 'verbatim',
  disclosure: { speakable: 'yes', label: '就在这里说过' },
}

export class FakePolicy implements Policy {
  readonly #decide: Decide

  constructor(decide?: Decide) {
    this.#decide = decide ?? (() => DEFAULT_DECISION)
  }

  decide(record: MemoryRecord, viewer: Viewer, facts: ChannelFacts): PolicyDecision {
    return this.#decide(record, viewer, facts)
  }
}

export class FakeProfiles implements ProfileReader {
  #snapshot: ProfileSnapshot

  constructor(snapshot: ProfileSnapshot = { version: 0, stable: '' }) {
    this.#snapshot = clone(snapshot)
  }

  async current(): Promise<ProfileSnapshot> {
    return clone(this.#snapshot)
  }

  set(snapshot: ProfileSnapshot): void {
    this.#snapshot = clone(snapshot)
  }
}

type AuditEntry = Parameters<MemoryAudit['crossChannelUse']>[0]

export class FakeAudit implements MemoryAudit {
  readonly entries: AuditEntry[] = []

  async crossChannelUse(entry: AuditEntry): Promise<void> {
    this.entries.push(clone(entry))
  }
}

type LlmRequest = Parameters<LlmClient['complete']>[0]
type LlmReply = { readonly text: string; readonly tokens: number }

export class FakeLlm implements LlmClient {
  readonly requests: LlmRequest[] = []
  readonly #replies: Array<LlmReply | Error>

  constructor(replies: Array<{ text: string; tokens: number } | Error>) {
    this.#replies = [...replies]
  }

  async complete(request: LlmRequest): Promise<LlmReply> {
    this.requests.push(clone(request))
    const reply = this.#replies.shift()
    if (reply === undefined) throw new Error('FakeLlm has no more replies')
    if (reply instanceof Error) throw reply
    return reply
  }
}
