import assert from 'node:assert/strict'
import test from 'node:test'
import { keepGroundedFacts } from '../../src/memory-extraction/index.ts'
import type { ExtractedFact } from '../../src/memory-extraction/index.ts'
import { FakeLlm } from '../fakes/index.ts'
import { WINDOW, World, reply } from './helpers.ts'

test('a fact about someone else backed only by the agent\'s own words is dropped, the rest is written', async () => {
  const w = new World()
  const ownWords = await w.l0({ actor: 'self', subjects: ['p_alice'], content: { text: '你生日是三月一号吧' } })
  const alice = await w.l0({ actor: 'p_alice', subjects: ['p_alice'], content: { text: '我喜欢喝咖啡' } })
  w.llm = new FakeLlm([reply([
    {
      kind: 'l1.fact', text: 'p_alice 的生日是 3 月 1 日', subjects: ['p_alice'],
      evidence: [ownWords.id], confidence: 0.95, key: '生日', value: '3月1日',
    },
    {
      kind: 'l1.fact', text: 'p_alice 喜欢喝咖啡', subjects: ['p_alice'],
      evidence: [alice.id], confidence: 0.95,
    },
  ])])

  const report = await w.extractor().runOnce(WINDOW)
  assert.equal(report.droppedFacts, 1)
  assert.equal(report.promoted, 1)
  assert.equal(report.processed, 2)
  assert.equal(w.processed.has(ownWords.id), true)
  assert.equal(w.processed.has(alice.id), true)

  const records = await w.l1()
  assert.equal(records.length, 1)
  assert.equal(records[0]?.content.text, 'p_alice 喜欢喝咖啡')
})

test('the same fact is written once a record by that person backs it too', async () => {
  const w = new World()
  const ownWords = await w.l0({ actor: 'self', subjects: ['p_alice'], content: { text: '你生日是三月一号吧' } })
  const alice = await w.l0({ actor: 'p_alice', subjects: ['p_alice'], content: { text: '对，三月一号' } })
  w.llm = new FakeLlm([reply([
    {
      kind: 'l1.fact', text: 'p_alice 的生日是 3 月 1 日', subjects: ['p_alice'],
      evidence: [ownWords.id, alice.id], confidence: 0.95, key: '生日', value: '3月1日',
    },
  ])])

  const report = await w.extractor().runOnce(WINDOW)
  assert.equal(report.droppedFacts, 0)
  assert.equal(report.promoted, 1)
  const [record] = await w.l1()
  assert.deepEqual(record?.evidence, [{ id: ownWords.id }, { id: alice.id }])
})

test('a fact about the agent itself backed only by its own words is written', async () => {
  const w = new World()
  const ownWords = await w.l0({ actor: 'self', subjects: ['self'], content: { text: '我最近开始晨跑' } })
  w.llm = new FakeLlm([reply([
    {
      kind: 'l1.fact', text: '她最近开始晨跑', subjects: ['self'],
      evidence: [ownWords.id], confidence: 0.9,
    },
  ])])

  const report = await w.extractor().runOnce(WINDOW)
  assert.equal(report.droppedFacts, 0)
  assert.equal(report.promoted, 1)
  const [record] = await w.l1()
  assert.deepEqual(record?.subjects, ['self'])
})

test('a fact that includes someone else is dropped even when the agent is a subject too', async () => {
  const w = new World()
  const ownWords = await w.l0({ actor: 'self', subjects: ['self', 'p_alice'], content: { text: '我们俩生日很近' } })
  w.llm = new FakeLlm([reply([
    {
      kind: 'l1.fact', text: '她们俩生日很近', subjects: ['self', 'p_alice'],
      evidence: [ownWords.id], confidence: 0.9,
    },
  ])])

  const report = await w.extractor().runOnce(WINDOW)
  assert.equal(report.droppedFacts, 1)
  assert.deepEqual(await w.l1(), [])
})

test('an event about someone else backed only by the agent\'s words is dropped, unless it includes the agent', async () => {
  const w = new World()
  const ownWords = await w.l0({ actor: 'self', subjects: ['p_alice'], content: { text: '你昨天去了展会吧' } })
  w.llm = new FakeLlm([reply([
    {
      kind: 'l1.event', text: 'p_alice 昨天去了展会', subjects: ['p_alice'],
      evidence: [ownWords.id], confidence: 0.9,
    },
  ])])
  const report = await w.extractor().runOnce(WINDOW)
  assert.equal(report.droppedFacts, 1)
  assert.deepEqual(await w.l1(), [])

  const together = new World()
  const ownWordsTwo = await together.l0({ actor: 'self', subjects: ['p_alice'], content: { text: '我们昨天去看展了' } })
  together.llm = new FakeLlm([reply([
    {
      kind: 'l1.event', text: '她和 p_alice 昨天去看了展', subjects: ['p_alice', 'self'],
      evidence: [ownWordsTwo.id], confidence: 0.9,
    },
  ])])
  const togetherReport = await together.extractor().runOnce(WINDOW)
  assert.equal(togetherReport.droppedFacts, 0)
  assert.equal(togetherReport.promoted, 1)
  assert.equal((await together.l1()).length, 1)
})

test('a promise made by the agent alone is written', async () => {
  const w = new World()
  const ownWords = await w.l0({ actor: 'self', subjects: ['p_alice'], content: { text: '明天我提醒你' } })
  w.llm = new FakeLlm([reply([
    {
      kind: 'l1.promise', text: '她答应明天提醒 p_alice', subjects: ['p_alice', 'self'],
      evidence: [ownWords.id], confidence: 0.9,
    },
  ])])

  const report = await w.extractor().runOnce(WINDOW)
  assert.equal(report.droppedFacts, 0)
  assert.equal(report.promoted, 1)
  const [record] = await w.l1()
  assert.equal(record?.kind, 'l1.promise')
})

test('keepGroundedFacts keeps the input order and counts what it drops', async () => {
  const w = new World()
  const ownWords = await w.l0({ actor: 'self', subjects: ['p_alice'] })
  const alice = await w.l0({ actor: 'p_alice', subjects: ['p_alice'] })
  const facts: ExtractedFact[] = [
    { kind: 'l1.fact', text: 'a', subjects: ['p_alice'], evidence: [ownWords.id], confidence: 0.9 },
    { kind: 'l1.fact', text: 'b', subjects: ['p_alice'], evidence: [alice.id], confidence: 0.9 },
    { kind: 'l1.event', text: 'c', subjects: ['p_alice'], evidence: [ownWords.id], confidence: 0.9 },
    { kind: 'l1.promise', text: 'd', subjects: ['p_alice'], evidence: [ownWords.id], confidence: 0.9 },
    { kind: 'l1.fact', text: 'e', subjects: ['self', 'p_alice'], evidence: [ownWords.id], confidence: 0.9 },
  ]

  const { kept, dropped } = keepGroundedFacts(facts, [ownWords, alice])
  assert.deepEqual(kept.map((fact) => fact.text), ['b', 'd'])
  assert.equal(dropped, 3)
})
