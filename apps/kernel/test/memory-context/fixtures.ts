import type { MemoryRecord, Viewer } from '@brain-core/sdk'
import type { ChannelFacts, ContextAssembler, CrossChannelMode, NewRecord, Policy } from '../../src/contracts/index.ts'
import { createContextAssembler } from '../../src/memory-context/index.ts'
import { FakeAudit, FakeClock, FakeKeywordIndex, FakePolicy, FakeProfiles, FakeRecordStore } from '../fakes/index.ts'

/** The FakeClock default, so every fixture agrees on "now". */
export const NOW = Date.UTC(2026, 10, 7)
export const HERE = 'qq:group:100'
export const ELSEWHERE = 'qq:group:200'

export function recordInput(overrides: Partial<NewRecord> = {}): NewRecord {
  return {
    layer: 'L1',
    kind: 'l1.fact',
    source: 'plugin.test',
    channel: ELSEWHERE,
    subjects: [],
    actor: 'owner',
    content: { text: 'hello' },
    evidence: [],
    visibility: 'open',
    trust: 'owner',
    confidence: 0.5,
    importance: 0.5,
    tEvent: NOW - 3_600_000,
    ...overrides,
  }
}

/**
 * One world per test: a fake store and index seeded together, plus the assembler wiring. The default viewer
 * sits in HERE with alice and bob present.
 */
export class World {
  readonly clock = new FakeClock(NOW)
  readonly store = new FakeRecordStore(this.clock)
  readonly index = new FakeKeywordIndex()
  readonly profiles = new FakeProfiles({ version: 7, stable: 'stable-7' })
  readonly audit = new FakeAudit()
  readonly facts: ChannelFacts = {
    ownerChannels: new Set(['qq:private:10001']),
    members: new Map([[HERE, new Set(['p_alice', 'p_bob'])]]),
    kindOf: (channel) => {
      const kind = channel.split(':')[1]
      return kind === 'private' ? 'private' : kind === 'group' ? 'group' : 'other'
    },
  }
  mode: CrossChannelMode = 'on'
  policy: Policy = new FakePolicy()
  readonly viewer: Viewer = { caller: 'agent', channel: HERE, participants: ['p_alice', 'p_bob'] }

  #evidence: string | undefined

  /** A neutral L0 that never matches a block by itself: old, actor system, in the kernel's own channel. */
  async l0(overrides: Partial<NewRecord> = {}): Promise<MemoryRecord> {
    const record = await this.store.insert(recordInput({
      layer: 'L0',
      kind: 'l0.event',
      actor: 'system',
      channel: 'kernel:system:evidence',
      subjects: [],
      content: { text: 'evidence' },
      tEvent: NOW - 10 * 86_400_000,
      ...overrides,
    }))
    await this.index.add(record)
    return record
  }

  /** Writes an L1–L3 record backed by a shared L0, then indexes it the way the real store would. */
  async add(overrides: Partial<NewRecord> = {}): Promise<MemoryRecord> {
    if (this.#evidence === undefined) this.#evidence = (await this.l0()).id
    const record = await this.store.insert(recordInput({ evidence: [{ id: this.#evidence }], ...overrides }))
    await this.index.add(record)
    return record
  }

  async update(record: MemoryRecord, patch: Parameters<FakeRecordStore['patch']>[1]): Promise<MemoryRecord> {
    const updated = await this.store.patch(record.id, patch, record.version)
    await this.index.add(updated)
    return updated
  }

  assembler(budgets?: Readonly<Record<string, number>>): ContextAssembler {
    return createContextAssembler({
      store: this.store,
      index: this.index,
      policy: { decide: (record, viewer, facts) => this.policy.decide(record, viewer, facts) },
      profiles: this.profiles,
      audit: this.audit,
      clock: this.clock,
      facts: async () => this.facts,
      crossChannelMode: () => this.mode,
      ...(budgets === undefined ? {} : { budgets: budgets as never }),
    })
  }

  clearAudit(): void {
    this.audit.entries.length = 0
  }
}

export function viewerIn(channel: string | null, participants: readonly string[] = ['p_alice', 'p_bob']): Viewer {
  return { caller: 'agent', channel, participants }
}

export const BLOCK_ORDER = ['profile', 'working', 'topics', 'facts', 'lessons', 'recall', 'elsewhere', 'promises'] as const

interface BlockItem {
  readonly id: string
  readonly text: string
  readonly disclosure: unknown
}

interface NamedBlock {
  readonly name: string
  readonly items: readonly BlockItem[]
}

export function blockOf(bundle: { readonly blocks: readonly NamedBlock[] }, name: string): NamedBlock {
  const block = bundle.blocks.find((candidate) => candidate.name === name)
  if (block === undefined) throw new Error(`no block ${name}`)
  return block
}

export function idsOf(bundle: { readonly blocks: readonly NamedBlock[] }, name: string): string[] {
  return blockOf(bundle, name).items.map((item) => item.id)
}
