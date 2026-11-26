import assert from 'node:assert/strict'
import test from 'node:test'
import type { MemoryRecord, Viewer } from '@brain-core/sdk'
import type { ChannelFacts, NewRecord } from '../../src/contracts/index.ts'
import { createContextAssembler } from '../../src/memory-context/index.ts'
import { FakeAudit, FakeClock, FakeKeywordIndex, FakePolicy, FakeProfiles, FakeRecordStore } from '../fakes/index.ts'

const NOW = Date.UTC(2026, 10, 7)
const CHANNELS = 200
const PEOPLE = 500
const L0_COUNT = 100_000
const L1_COUNT = 10_000
const RUNS = 50
const DAY = 86_400_000

function channelOf(index: number): string {
  return `perf:group:${index % CHANNELS}`
}

function personOf(index: number): string {
  return `p_${String(index % PEOPLE).padStart(3, '0')}`
}

function eventInput(index: number): NewRecord {
  return {
    layer: 'L0',
    kind: 'l0.message',
    source: 'plugin.perf',
    channel: channelOf(index),
    subjects: [],
    actor: 'self',
    content: { text: `event ${index} walrus` },
    evidence: [],
    visibility: 'open',
    trust: 'owner',
    confidence: 0.5,
    importance: (index % 100) / 100,
    tEvent: NOW - Math.floor((index / L0_COUNT) * 30 * DAY),
  }
}

function factInput(index: number, evidence: MemoryRecord): NewRecord {
  return {
    layer: 'L1',
    kind: 'l1.fact',
    source: 'plugin.perf',
    channel: channelOf(index * 7),
    subjects: [personOf(index)],
    actor: 'owner',
    content: { text: `fact ${index} walrus` },
    evidence: [{ id: evidence.id }],
    visibility: 'open',
    trust: 'owner',
    confidence: 0.5,
    importance: (index % 100) / 100,
    tEvent: NOW - Math.floor((index / L1_COUNT) * 30 * DAY),
  }
}

async function buildDataset(): Promise<{
  readonly store: FakeRecordStore
  readonly index: FakeKeywordIndex
  readonly clock: FakeClock
}> {
  const clock = new FakeClock(NOW)
  const store = new FakeRecordStore(clock)
  const index = new FakeKeywordIndex()

  const l0: MemoryRecord[] = []
  for (let position = 0; position < L0_COUNT; position += 1) {
    const record = await store.insert(eventInput(position))
    l0.push(record)
    await index.add(record)
  }
  for (let position = 0; position < L1_COUNT; position += 1) {
    const evidence = l0[(position * 10) % l0.length] as MemoryRecord
    const record = await store.insert(factInput(position, evidence))
    await index.add(record)
  }
  return { store, index, clock }
}

function p95(durations: readonly number[]): number {
  const sorted = [...durations].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)] as number
}

test('PERF: NFR-01: p95 of /context assembly stays within 300 ms on a 100k L0 + 10k L1 dataset', async () => {
  const { store, index, clock } = await buildDataset()

  const facts: ChannelFacts = {
    ownerChannels: new Set(),
    members: new Map([[channelOf(3), new Set([personOf(0), personOf(1), personOf(2)])]]),
    kindOf: () => 'group',
  }
  const viewer: Viewer = {
    caller: 'agent',
    channel: channelOf(3),
    participants: [personOf(0), personOf(1), personOf(2)],
  }
  const assembler = createContextAssembler({
    store,
    index,
    policy: new FakePolicy(),
    profiles: new FakeProfiles({ version: 3, stable: 'perf' }),
    audit: new FakeAudit(),
    clock,
    facts: async () => facts,
    crossChannelMode: () => 'on',
  })

  const request = { channel: channelOf(3), query: 'walrus' }
  const durations: number[] = []
  let blocks = 0
  for (let run = 0; run < RUNS; run += 1) {
    const started = performance.now()
    const bundle = await assembler.assemble(request, viewer)
    durations.push(performance.now() - started)
    blocks = bundle.blocks.length
  }

  const measured = p95(durations)
  const mean = durations.reduce((sum, value) => sum + value, 0) / durations.length
  console.log(`memory-context p95 ${measured.toFixed(1)} ms, mean ${mean.toFixed(1)} ms over ${RUNS} runs`)
  assert.equal(blocks, 8)
  assert.ok(measured <= 300, `p95 was ${measured.toFixed(1)} ms, above the 300 ms budget`)
})
