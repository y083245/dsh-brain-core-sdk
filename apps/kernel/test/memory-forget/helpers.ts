import type { MemoryRecord } from '@brain-core/sdk'
import type { ForgetService, NewRecord } from '../../src/contracts/index.ts'
import { createForgetService } from '../../src/memory-forget/index.ts'
import { FakeClock, FakeKeywordIndex, FakeRecordStore } from '../fakes/index.ts'

/** The FakeClock default, so every fixture agrees on "now". */
export const NOW = Date.UTC(2026, 10, 7)
export const HERE = 'qq:group:100'
export const ELSEWHERE = 'qq:group:200'

export function recordInput(overrides: Partial<NewRecord> = {}): NewRecord {
  return {
    layer: 'L1',
    kind: 'l1.fact',
    source: 'plugin.test',
    channel: HERE,
    subjects: [],
    actor: 'owner',
    content: { text: 'hello' },
    evidence: [],
    visibility: 'open',
    trust: 'owner',
    confidence: 0.5,
    importance: 0.5,
    tEvent: NOW,
    ...overrides,
  }
}

/** Records which ids the cascade asked about, so a test can prove a shared dependent is handled once. */
export class SpyRecordStore extends FakeRecordStore {
  readonly dependentsCalls: string[] = []

  override async dependentsOf(id: string): Promise<readonly MemoryRecord[]> {
    this.dependentsCalls.push(id)
    return super.dependentsOf(id)
  }
}

/** One world per test: a fake store and index seeded together, plus the forget wiring. */
export class World {
  readonly clock = new FakeClock(NOW)
  readonly store = new SpyRecordStore(this.clock)
  readonly index = new FakeKeywordIndex()
  readonly notifications: (readonly string[])[] = []

  /** Swappable so a test can make a notification fail and then recover. */
  onForgotten: (ids: readonly string[]) => Promise<void> = async (ids) => {
    this.notifications.push(ids)
  }

  async insert(overrides: Partial<NewRecord> = {}): Promise<MemoryRecord> {
    const record = await this.store.insert(recordInput(overrides))
    await this.index.add(record)
    return record
  }

  /** A neutral L0. Like the real store, every insert is mirrored into the keyword index. */
  async l0(overrides: Partial<NewRecord> = {}): Promise<MemoryRecord> {
    return this.insert({
      layer: 'L0',
      kind: 'l0.event',
      actor: 'system',
      channel: 'kernel:system:evidence',
      subjects: [],
      content: { text: 'evidence' },
      ...overrides,
    })
  }

  /** Tombstones a record outside the service, for "already gone before this call" setups. */
  async forgetDirect(record: MemoryRecord): Promise<void> {
    await this.store.tombstone(record.id)
    await this.index.remove(record.id)
  }

  service(): ForgetService {
    return createForgetService({
      store: this.store,
      index: this.index,
      onForgotten: (ids) => this.onForgotten(ids),
    })
  }

  /** Every record in the store, sorted by id, for before/after comparisons. */
  async all(): Promise<MemoryRecord[]> {
    const records: MemoryRecord[] = []
    for await (const record of this.store.scan()) records.push(record)
    return records
  }

  async statusOf(id: string): Promise<string | undefined> {
    return (await this.store.get(id))?.status
  }
}

export async function search(world: World, text: string): Promise<string[]> {
  const hits = await world.index.search({ text, limit: 100 })
  return hits.map((hit) => hit.id)
}
