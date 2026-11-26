import assert from 'node:assert/strict'
import test from 'node:test'
import type { MemoryRecord } from '@brain-core/sdk'
import { FakeKeywordIndex, FakeLlm } from '../fakes/index.ts'
import { WINDOW, World, reply } from './helpers.ts'

test('promoted and candidate records both reach the keyword index as stored', async () => {
  const w = new World()
  const source = await w.l0({ content: { text: '我的生日是5月20日' } })
  const backing = new FakeKeywordIndex()
  const added: MemoryRecord[] = []
  const index = {
    async add(record: MemoryRecord): Promise<void> {
      added.push(record)
      await backing.add(record)
    },
  }
  w.llm = new FakeLlm([reply([
    {
      kind: 'l1.fact', text: 'p_alice 的生日是 5 月 20 日', subjects: ['p_alice'],
      evidence: [source.id], confidence: 0.9, key: '生日', value: '5月20日',
    },
    {
      kind: 'l1.fact', text: 'p_alice 喜欢猫', subjects: ['p_alice'],
      evidence: [source.id], confidence: 0.5,
    },
  ])])

  const report = await w.extractor({ index }).runOnce(WINDOW)
  assert.equal(report.promoted, 1)
  assert.equal(report.candidates, 1)
  assert.equal(added.length, 2)
  assert.deepEqual(added.map((record) => record.kind).sort(), ['l1.candidate', 'l1.fact'])

  for (const record of added) {
    assert.match(record.id, /^l1_/)
    assert.deepEqual(await w.store.get(record.id), record)
  }

  const hits = await backing.search({ text: '生日', limit: 10 })
  const promoted = added.find((record) => record.kind === 'l1.fact') as MemoryRecord
  assert.deepEqual(hits.map((hit) => hit.id), [promoted.id])
})

test('an index failure fails the run, and the retry adds the same record again', async () => {
  const w = new World()
  const source = await w.l0({ content: { text: '我的生日是5月20日' } })
  const fact = {
    kind: 'l1.fact', text: 'p_alice 的生日是 5 月 20 日', subjects: ['p_alice'],
    evidence: [source.id], confidence: 0.9, key: '生日', value: '5月20日',
  }
  w.llm = new FakeLlm([reply([fact], 5), reply([fact], 5)])

  const backing = new FakeKeywordIndex()
  let calls = 0
  const index = {
    async add(record: MemoryRecord): Promise<void> {
      calls += 1
      if (calls === 1) throw new Error('index down')
      await backing.add(record)
    },
  }
  const extractor = w.extractor({ index })

  await assert.rejects(extractor.runOnce(WINDOW), /index down/)
  assert.equal(w.processed.has(source.id), false)
  assert.equal((await w.l1()).length, 1, 'the record is written before the index call fails')

  const report = await extractor.runOnce(WINDOW)
  assert.equal(report.processed, 1)
  assert.equal(w.processed.has(source.id), true)
  assert.equal((await w.l1()).length, 1, 'the idempotency key keeps the retry from writing a second record')
  assert.equal(calls, 2)
  assert.equal((await backing.search({ text: '生日', limit: 10 })).length, 1)
})
