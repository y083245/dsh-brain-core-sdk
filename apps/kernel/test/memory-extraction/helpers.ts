import type { MemoryRecord } from '@dsh-brain-core/sdk'
import type { NewRecord } from '../../src/contracts/index.ts'
import {
  createExtractor, createMemoryProcessedLog, type ProcessedLog,
} from '../../src/memory-extraction/index.ts'
import { FakeClock, FakeLlm, FakeRecordStore } from '../fakes/index.ts'

/** The FakeClock default, so every fixture agrees on "now". */
export const NOW = Date.UTC(2026, 10, 7)
export const HERE = 'qq:group:100'
export const WINDOW = { from: 0, to: Number.MAX_SAFE_INTEGER } as const
export const DAY = 86_400_000

export function l0Input(overrides: Partial<NewRecord> = {}): NewRecord {
  return {
    layer: 'L0',
    kind: 'l0.message',
    source: 'plugin.qq',
    channel: HERE,
    subjects: ['p_alice'],
    actor: 'p_alice',
    content: { text: 'hello' },
    evidence: [],
    visibility: 'open',
    trust: 'owner',
    confidence: 1,
    importance: 0.5,
    tEvent: NOW,
    ...overrides,
  }
}

export function reply(facts: readonly unknown[], tokens = 10): { text: string; tokens: number } {
  return { text: JSON.stringify({ facts }), tokens }
}

export class World {
  readonly clock = new FakeClock(NOW)
  readonly store = new FakeRecordStore(this.clock)
  readonly processed: ProcessedLog = createMemoryProcessedLog()

  /** Swappable so a second extractor can share the store while proving it never calls the model. */
  llm = new FakeLlm([])

  async l0(overrides: Partial<NewRecord> = {}): Promise<MemoryRecord> {
    return this.store.insert(l0Input(overrides))
  }

  extractor(options: Partial<Parameters<typeof createExtractor>[0]> = {}): ReturnType<typeof createExtractor> {
    return createExtractor({
      store: this.store,
      llm: this.llm,
      clock: this.clock,
      processed: this.processed,
      dailyTokenCap: 1_000_000,
      maxOutputTokens: 512,
      ...options,
    })
  }

  async all(): Promise<MemoryRecord[]> {
    const records: MemoryRecord[] = []
    for await (const record of this.store.scan()) records.push(record)
    return records
  }

  async l1(): Promise<MemoryRecord[]> {
    return (await this.all()).filter((record) => record.layer === 'L1')
  }
}
