import type { MemoryRecord } from '@dsh-brain-core/sdk'

let next = 0

/** A record for index tests; the keyword index never looks at evidence or versions. */
export function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  next += 1
  return {
    id: `l1_test${String(next).padStart(4, '0')}`,
    layer: 'L1',
    kind: 'l1.fact',
    source: 'plugin.test',
    channel: 'chan-1',
    subjects: [],
    actor: 'owner',
    content: { text: `record ${next}` },
    evidence: [],
    visibility: 'open',
    trust: 'owner',
    confidence: 0.5,
    importance: 0.5,
    tEvent: 1000,
    tIngest: 1000,
    status: 'active',
    version: 1,
    ...overrides,
  }
}
