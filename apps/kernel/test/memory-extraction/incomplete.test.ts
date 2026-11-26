import assert from 'node:assert/strict'
import test from 'node:test'
import { isCompleteJson } from '../../src/memory-extraction/index.ts'
import { FakeLlm } from '../fakes/index.ts'
import { WINDOW, World, reply } from './helpers.ts'

test('isCompleteJson tells an empty, truncated or non-JSON reply from any reply that parses', () => {
  for (const text of ['', '   \n', '```json\n```', '{"facts":[{"kind":', 'not json']) {
    assert.equal(isCompleteJson(text), false, `expected ${JSON.stringify(text)} to be incomplete`)
  }
  for (const text of ['[]', '123', '{"facts":"x"}', '```json\n{"facts":[]}\n```', '```\n{"facts":[]}\n```']) {
    assert.equal(isCompleteJson(text), true, `expected ${JSON.stringify(text)} to be complete`)
  }
})

test('an empty reply leaves the batch unprocessed and stops the run', async () => {
  const w = new World()
  const first = await w.l0({ content: { text: '一' } })
  const second = await w.l0({ content: { text: '二' } })
  w.llm = new FakeLlm([{ text: '', tokens: 7 }, reply([], 5)])

  const report = await w.extractor({ batchSize: 1 }).runOnce(WINDOW)
  assert.equal(report.incompleteBatches, 1)
  assert.equal(report.processed, 0)
  assert.equal(report.batches, 1)
  assert.equal(report.tokens, 7)
  assert.equal(w.llm.requests.length, 1, 'the remaining batch is not called')
  assert.equal(w.processed.has(first.id), false)
  assert.equal(w.processed.has(second.id), false)
  assert.deepEqual(await w.l1(), [])
})

test('a truncated JSON reply behaves like an empty one', async () => {
  const w = new World()
  const record = await w.l0()
  w.llm = new FakeLlm([{ text: '{"facts":[{"kind":', tokens: 3 }])

  const report = await w.extractor().runOnce(WINDOW)
  assert.equal(report.incompleteBatches, 1)
  assert.equal(report.processed, 0)
  assert.equal(w.processed.has(record.id), false)
  assert.deepEqual(await w.l1(), [])
})

test('the next run retries the same batch and marks it processed on a complete reply', async () => {
  const w = new World()
  const record = await w.l0({ content: { text: '我的生日是5月20日' } })
  w.llm = new FakeLlm([
    { text: '', tokens: 5 },
    reply([{
      kind: 'l1.fact', text: 'p_alice 的生日是 5 月 20 日', subjects: ['p_alice'],
      evidence: [record.id], confidence: 0.9, key: '生日', value: '5月20日',
    }], 5),
  ])

  const extractor = w.extractor()
  const first = await extractor.runOnce(WINDOW)
  assert.equal(first.incompleteBatches, 1)
  assert.equal(w.processed.has(record.id), false)

  const second = await extractor.runOnce(WINDOW)
  assert.equal(second.incompleteBatches, 0)
  assert.equal(second.processed, 1)
  assert.equal(w.processed.has(record.id), true)
  assert.equal(w.llm.requests.length, 2)
  assert.equal((await w.l1()).length, 1)
})

test('a successful retry clears the count, so another batch starts again at one', async () => {
  const w = new World()
  const first = await w.l0({ content: { text: '一' } })
  w.llm = new FakeLlm([
    { text: '', tokens: 1 },
    { text: '', tokens: 1 },
    reply([{
      kind: 'l1.fact', text: '第一件事', subjects: ['p_alice'],
      evidence: [first.id], confidence: 0.9,
    }], 1),
    { text: '', tokens: 1 },
  ])
  const extractor = w.extractor()

  assert.equal((await extractor.runOnce(WINDOW)).incompleteBatches, 1)
  assert.equal((await extractor.runOnce(WINDOW)).incompleteBatches, 1)
  const success = await extractor.runOnce(WINDOW)
  assert.equal(success.processed, 1)
  assert.equal(w.processed.has(first.id), true)

  await w.l0({ content: { text: '二' } })
  const nextBatch = await extractor.runOnce(WINDOW)
  assert.equal(nextBatch.incompleteBatches, 1)
  assert.equal(nextBatch.parkedBatches, 0, 'the new batch counts from one, not from the cleared one')
})

test('the third incomplete reply parks the batch, then the run continues with the next one', async () => {
  const w = new World()
  const stuck = await w.l0({ content: { text: '一' } })
  const fine = await w.l0({ content: { text: '二' } })
  w.llm = new FakeLlm([
    { text: '', tokens: 1 },
    { text: '', tokens: 1 },
    { text: '', tokens: 1 },
    reply([{
      kind: 'l1.fact', text: '第二件事', subjects: ['p_alice'],
      evidence: [fine.id], confidence: 0.9,
    }], 1),
  ])
  const extractor = w.extractor({ batchSize: 1 })

  const first = await extractor.runOnce(WINDOW)
  assert.equal(first.incompleteBatches, 1)
  assert.equal(first.parkedBatches, 0, 'one incomplete reply is not enough to park')
  const second = await extractor.runOnce(WINDOW)
  assert.equal(second.incompleteBatches, 1)
  assert.equal(second.parkedBatches, 0, 'two incomplete replies are not enough to park')

  const third = await extractor.runOnce(WINDOW)
  assert.equal(third.incompleteBatches, 1)
  assert.equal(third.parkedBatches, 1)
  assert.equal(w.llm.requests.length, 4, 'the next batch is called in the same run')
  assert.equal(w.processed.has(stuck.id), false)
  assert.equal(w.processed.has(fine.id), true)

  const fourth = await extractor.runOnce(WINDOW)
  assert.equal(fourth.batches, 0)
  assert.equal(w.llm.requests.length, 4, 'a parked batch is never tried again by the same extractor')
})

test('a new extractor tries a parked batch again', async () => {
  const w = new World()
  const record = await w.l0()
  w.llm = new FakeLlm([
    { text: '', tokens: 1 },
    { text: '', tokens: 1 },
    { text: '', tokens: 1 },
  ])
  const first = w.extractor()
  await first.runOnce(WINDOW)
  await first.runOnce(WINDOW)
  const parkedReport = await first.runOnce(WINDOW)
  assert.equal(parkedReport.parkedBatches, 1)
  assert.equal(w.processed.has(record.id), false)

  w.llm = new FakeLlm([reply([], 5)])
  const restarted = w.extractor()
  const report = await restarted.runOnce(WINDOW)
  assert.equal(report.processed, 1)
  assert.equal(w.llm.requests.length, 1)
  assert.equal(w.processed.has(record.id), true)
})

test('a batch parks when any member reached the attempt limit, not just the last one', async () => {
  const w = new World()
  const stuck = await w.l0({ content: { text: '一' } })
  w.llm = new FakeLlm([
    { text: '', tokens: 1 },
    { text: '', tokens: 1 },
    { text: '', tokens: 1 },
  ])
  const extractor = w.extractor({ batchSize: 2 })

  assert.equal((await extractor.runOnce(WINDOW)).incompleteBatches, 1)
  assert.equal((await extractor.runOnce(WINDOW)).incompleteBatches, 1)

  const second = await w.l0({ content: { text: '二' } })
  assert.ok(second.id > stuck.id, 'the new record sorts after the stuck one, so the batch is [stuck, second]')

  const third = await extractor.runOnce(WINDOW)
  assert.equal(third.incompleteBatches, 1)
  assert.equal(third.parkedBatches, 1, 'the stuck record reached three attempts even though it is not the last one')
  assert.equal(w.processed.has(stuck.id), false)
  assert.equal(w.processed.has(second.id), false)
  assert.equal(w.llm.requests.length, 3)
})

test('maxIncompleteAttempts one parks at once without stopping the run', async () => {
  const w = new World()
  const stuck = await w.l0({ content: { text: '一' } })
  const fine = await w.l0({ content: { text: '二' } })
  w.llm = new FakeLlm([
    { text: '', tokens: 1 },
    reply([{
      kind: 'l1.fact', text: '第二件事', subjects: ['p_alice'],
      evidence: [fine.id], confidence: 0.9,
    }], 1),
  ])

  const report = await w.extractor({ batchSize: 1, maxIncompleteAttempts: 1 }).runOnce(WINDOW)
  assert.equal(report.parkedBatches, 1)
  assert.equal(report.incompleteBatches, 1)
  assert.equal(w.llm.requests.length, 2)
  assert.equal(w.processed.has(stuck.id), false)
  assert.equal(w.processed.has(fine.id), true)
})

test('complete JSON that breaks a rule is discarded, marked processed and never retried', async () => {
  const w = new World()
  const record = await w.l0()
  w.llm = new FakeLlm([{ text: '{"facts":"x"}', tokens: 7 }])

  const extractor = w.extractor()
  const report = await extractor.runOnce(WINDOW)
  assert.equal(report.discardedBatches, 1)
  assert.equal(report.incompleteBatches, 0)
  assert.equal(report.parkedBatches, 0)
  assert.equal(report.processed, 1)
  assert.equal(w.processed.has(record.id), true)

  const again = await extractor.runOnce(WINDOW)
  assert.equal(again.batches, 0)
  assert.equal(w.llm.requests.length, 1)
})

test('an incomplete reply counts toward the daily cap and reports both', async () => {
  const w = new World()
  await w.l0()
  w.llm = new FakeLlm([{ text: '', tokens: 60 }])

  const report = await w.extractor({ dailyTokenCap: 50 }).runOnce(WINDOW)
  assert.equal(report.capped, true)
  assert.equal(report.tokens, 60)
  assert.equal(report.incompleteBatches, 1)
  assert.equal(report.processed, 0)
})

test('a model error still fails the whole run and leaves the batch unprocessed', async () => {
  const w = new World()
  const record = await w.l0()
  w.llm = new FakeLlm([new Error('model down')])

  await assert.rejects(w.extractor().runOnce(WINDOW), /model down/)
  assert.equal(w.processed.has(record.id), false)
  assert.deepEqual(await w.l1(), [])
})
