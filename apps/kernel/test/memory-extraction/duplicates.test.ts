import assert from 'node:assert/strict'
import test from 'node:test'
import type { MemoryRecord } from '@brain-core/sdk'
import { FakeLlm } from '../fakes/index.ts'
import { HERE, NOW, WINDOW, World, reply } from './helpers.ts'

async function insertFact(w: World, sourceId: string, key: string, value: string): Promise<MemoryRecord> {
  return w.store.insert({
    layer: 'L1',
    kind: 'l1.fact',
    source: 'plugin.test',
    channel: HERE,
    subjects: ['p_alice'],
    actor: 'owner',
    content: { text: `生日是${value}`, kind: 'l1.fact', key, value },
    evidence: [{ id: sourceId }],
    visibility: 'open',
    trust: 'owner',
    confidence: 0.9,
    importance: 0.5,
    tEvent: NOW,
  })
}

test('a repeated key and value stays a candidate that points at the existing record', async () => {
  const w = new World()
  const source = await w.l0({ content: { text: '生日是3月1日' } })
  const existing = await insertFact(w, source.id, '生日', '3月1日')
  w.llm = new FakeLlm([reply([
    {
      kind: 'l1.fact', text: 'p_alice 的生日是 3 月 1 日', subjects: ['p_alice'],
      evidence: [source.id], confidence: 0.95, key: '生日', value: '3月1日',
    },
  ])])

  const report = await w.extractor().runOnce(WINDOW)
  assert.equal(report.promoted, 0)
  assert.equal(report.candidates, 1)

  const [written] = (await w.l1()).filter((record) => record.source === 'kernel')
  assert.equal(written?.kind, 'l1.candidate')
  assert.equal(written?.content.duplicateOf, existing.id)
})

test('a repeated key and value below the threshold carries duplicateOf too', async () => {
  const w = new World()
  const source = await w.l0({ content: { text: '生日是3月1日' } })
  const existing = await insertFact(w, source.id, '生日', '3月1日')
  w.llm = new FakeLlm([reply([
    {
      kind: 'l1.fact', text: 'p_alice 的生日是 3 月 1 日', subjects: ['p_alice'],
      evidence: [source.id], confidence: 0.5, key: '生日', value: '3月1日',
    },
  ])])

  const report = await w.extractor().runOnce(WINDOW)
  assert.equal(report.promoted, 0)
  assert.equal(report.candidates, 1)

  const [written] = (await w.l1()).filter((record) => record.source === 'kernel')
  assert.equal(written?.content.duplicateOf, existing.id)
})

test('a same-key fact with both a matching and a different value counts as a conflict', async () => {
  const w = new World()
  const source = await w.l0({ content: { text: '生日是3月1日' } })
  await insertFact(w, source.id, '生日', '3月1日')
  await insertFact(w, source.id, '生日', '4月2日')
  w.llm = new FakeLlm([reply([
    {
      kind: 'l1.fact', text: 'p_alice 的生日是 3 月 1 日', subjects: ['p_alice'],
      evidence: [source.id], confidence: 0.95, key: '生日', value: '3月1日',
    },
  ])])

  const report = await w.extractor().runOnce(WINDOW)
  assert.equal(report.promoted, 0)
  assert.equal(report.candidates, 1)

  const [written] = (await w.l1()).filter((record) => record.source === 'kernel')
  assert.equal(written?.kind, 'l1.candidate')
  assert.equal(written?.content.duplicateOf, undefined)
})

test('an event with a key and value is never compared against facts', async () => {
  const w = new World()
  const source = await w.l0({ content: { text: '生日改成4月2日了' } })
  await insertFact(w, source.id, '生日', '3月1日')
  w.llm = new FakeLlm([reply([
    {
      kind: 'l1.event', text: '生日改成 4 月 2 日了', subjects: ['p_alice'],
      evidence: [source.id], confidence: 0.9, key: '生日', value: '4月2日',
    },
    {
      kind: 'l1.event', text: '生日是 3 月 1 日', subjects: ['p_alice'],
      evidence: [source.id], confidence: 0.9, key: '生日', value: '3月1日',
    },
  ])])

  const report = await w.extractor().runOnce(WINDOW)
  assert.equal(report.promoted, 2)
  assert.equal(report.candidates, 0)

  const written = (await w.l1()).filter((record) => record.source === 'kernel')
  assert.equal(written.length, 2)
  for (const record of written) {
    assert.equal(record.kind, 'l1.event')
    assert.equal(record.content.duplicateOf, undefined)
  }
})

test('facts without a key and value are never compared and still promote', async () => {
  const w = new World()
  const source = await w.l0({ content: { text: '聊了一些事' } })
  await w.store.insert({
    layer: 'L1',
    kind: 'l1.fact',
    source: 'plugin.test',
    channel: HERE,
    subjects: ['p_alice'],
    actor: 'owner',
    content: { text: '同名的事', kind: 'l1.fact' },
    evidence: [{ id: source.id }],
    visibility: 'open',
    trust: 'owner',
    confidence: 0.9,
    importance: 0.5,
    tEvent: NOW,
  })
  w.llm = new FakeLlm([reply([
    { kind: 'l1.fact', text: '同名的事', subjects: ['p_alice'], evidence: [source.id], confidence: 0.95 },
    { kind: 'l1.event', text: '一起吃了饭', subjects: ['p_alice'], evidence: [source.id], confidence: 0.95 },
    { kind: 'l1.promise', text: '下次再约', subjects: ['p_alice'], evidence: [source.id], confidence: 0.95 },
  ])])

  const report = await w.extractor().runOnce(WINDOW)
  assert.equal(report.promoted, 3)
  assert.equal(report.candidates, 0)

  const written = (await w.l1()).filter((record) => record.source === 'kernel')
  assert.equal(written.length, 3)
  for (const record of written) {
    assert.equal(record.kind.startsWith('l1.'), true)
    assert.equal(record.content.duplicateOf, undefined)
  }
})
