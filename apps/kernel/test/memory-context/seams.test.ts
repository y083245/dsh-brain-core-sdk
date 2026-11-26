import assert from 'node:assert/strict'
import test from 'node:test'
import type { ContextAssembler } from '../../src/contracts/index.ts'
import { createContextAssembler } from '../../src/memory-context/index.ts'
import {
  openTempBrain, OWNER_IDENTITY, OWNER_VIEWER, type TempBrain,
} from '../memory-api/helpers.ts'
import { HERE, World, blockOf } from './fixtures.ts'

type ItemWithInference = { readonly id: string; readonly inferred?: boolean }

function assemblerWithGate(
  world: World,
  recallGate?: { readonly maxItems: number; readonly minMatched: (queryBigrams: number) => number },
): ContextAssembler {
  return createContextAssembler({
    store: world.store,
    index: world.index,
    policy: { decide: (record, viewer, facts) => world.policy.decide(record, viewer, facts) },
    profiles: world.profiles,
    audit: world.audit,
    clock: world.clock,
    facts: async () => world.facts,
    crossChannelMode: () => world.mode,
    ...(recallGate === undefined ? {} : { recallGate }),
  })
}

test('without a gate, recall keeps every indexed hit in its original order', async () => {
  const w = new World()
  const first = await w.add({ channel: HERE, kind: 'l1.promise', content: { text: '猫 咖啡' } })
  const second = await w.add({ kind: 'l1.promise', channel: HERE, content: { text: '猫咪咖啡' } })
  const bundle = await w.assembler().assemble({ channel: HERE, query: '猫 咖啡' }, w.viewer)
  assert.deepEqual(blockOf(bundle, 'recall').items.map(item => item.id), [first.id, second.id])
})

test('a record must share enough bigrams to stay in recall', async () => {
  const w = new World()
  const enough = await w.add({ kind: 'l1.promise', channel: HERE, content: { text: '猫 咖啡' } })
  const tooFew = await w.add({ kind: 'l1.promise', channel: HERE, content: { text: '猫咪咖啡' } })
  assert.ok(tooFew.id !== enough.id)

  const bundle = await assemblerWithGate(w, { maxItems: 6, minMatched: n => n })
    .assemble({ channel: HERE, query: '猫 咖啡' }, w.viewer)
  assert.deepEqual(blockOf(bundle, 'recall').items.map(item => item.id), [enough.id])
})

test('recall keeps at most maxItems, in the order it would have used', async () => {
  const w = new World()
  const first = await w.add({ kind: 'l1.promise', channel: HERE, content: { text: '猫 咖啡 一' } })
  await w.add({ kind: 'l1.promise', channel: HERE, content: { text: '猫 咖啡 二' } })
  const bundle = await assemblerWithGate(w, { maxItems: 1, minMatched: () => 0 })
    .assemble({ channel: HERE, query: '猫 咖啡' }, w.viewer)
  assert.deepEqual(blockOf(bundle, 'recall').items.map(item => item.id), [first.id])
})

test('inferred marks L2, low-confidence L1 and L1 candidates, but not settled L1 facts', async () => {
  const w = new World()
  const scene = await w.add({ layer: 'L2', kind: 'l2.scene', subjects: ['p_alice'], confidence: 0.9 })
  const low = await w.add({ kind: 'l1.fact', subjects: ['p_alice'], confidence: 0.7 })
  const boundary = await w.add({ kind: 'l1.fact', subjects: ['p_alice'], confidence: 0.8 })
  const high = await w.add({ kind: 'l1.fact', subjects: ['p_alice'], confidence: 0.9 })
  const candidate = await w.add({
    kind: 'l1.candidate', subjects: ['p_carol'], confidence: 0.9, channel: HERE,
    content: { text: '龙果候选' },
  })

  const bundle = await w.assembler().assemble({ channel: HERE, query: '龙果候选' }, w.viewer)

  assert.equal((blockOf(bundle, 'lessons').items.find(item => item.id === scene.id) as ItemWithInference).inferred, true)
  assert.equal((blockOf(bundle, 'facts').items.find(item => item.id === low.id) as ItemWithInference).inferred, true)
  assert.equal('inferred' in (blockOf(bundle, 'facts').items.find(item => item.id === boundary.id) as ItemWithInference), false)
  assert.equal('inferred' in (blockOf(bundle, 'facts').items.find(item => item.id === high.id) as ItemWithInference), false)
  assert.equal((blockOf(bundle, 'recall').items.find(item => item.id === candidate.id) as ItemWithInference).inferred, true)
})

const GATE_CHANNEL = 'qq:group:gate'
/** Ten characters, so the real gate's minMatched is min(3, ceil(9 * 0.25)) = 3. */
const GATE_QUERY = '甲乙丙丁戊己庚辛壬癸'

async function ingestGate(brain: TempBrain, key: string, content: Readonly<Record<string, unknown>>): Promise<string> {
  const stored = await brain.memory.service.ingest({
    kind: 'chat.message', channel: GATE_CHANNEL, subjects: [], actor: 'p_alice',
    content, tEvent: Date.now(), idempotencyKey: key,
  }, OWNER_IDENTITY)
  return stored.id
}

function gateViewer(): typeof OWNER_VIEWER {
  return { ...OWNER_VIEWER, channel: GATE_CHANNEL }
}

async function gateRecall(brain: TempBrain): Promise<readonly { readonly id: string }[]> {
  const bundle = await brain.memory.service.context(
    { channel: GATE_CHANNEL, query: GATE_QUERY },
    gateViewer(),
  )
  return bundle.blocks.find(block => block.name === 'recall')?.items ?? []
}

test('openMemory passes the real recallGate: seven qualifying records keep six', async () => {
  const brain = await openTempBrain()
  try {
    for (let index = 0; index < 7; index += 1) await ingestGate(brain, `full-${index}`, { text: GATE_QUERY })
    await brain.memory.service.flush()
    assert.equal((await gateRecall(brain)).length, 6)
  } finally {
    await brain.close()
  }
})

test('openMemory uses the real minMatched: a record matching only two bigrams is dropped', async () => {
  const brain = await openTempBrain()
  try {
    const control = await ingestGate(brain, 'control', { text: GATE_QUERY })
    const partial = await ingestGate(brain, 'partial', { text: '甲乙乙丙', note: GATE_QUERY })
    await brain.memory.service.flush()

    // The index does return the partial record (its note holds the whole query); only the gate drops it.
    const hits = await brain.memory.service.search({ query: GATE_QUERY, scope: 'all' }, gateViewer())
    assert.equal(hits.items.some(hit => hit.record.id === partial), true)

    assert.deepEqual((await gateRecall(brain)).map(item => item.id), [control])
  } finally {
    await brain.close()
  }
})
