import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { MemoryRecord } from '@dsh-brain-core/sdk'
import {
  createExtractor, createFileProcessedLog, createMemoryProcessedLog,
} from '../../src/memory-extraction/index.ts'
import { FakeLlm } from '../fakes/index.ts'
import { DAY, HERE, NOW, WINDOW, World, reply } from './helpers.ts'

test('a sample conversation becomes L1 records that point back at their evidence', async () => {
  const w = new World()
  const hello = await w.l0({ content: { text: '你好呀' } })
  const birthday = await w.l0({ content: { text: '我的生日是5月20日' } })
  const ack = await w.l0({ actor: 'owner', content: { text: '记下了' } })
  const invite = await w.l0({ subjects: ['p_alice', 'self'], content: { text: '周末一起去看展吧' } })
  const accept = await w.l0({ actor: 'self', subjects: ['p_alice'], content: { text: '好呀' } })

  w.llm = new FakeLlm([reply([
    {
      kind: 'l1.fact', text: 'p_alice 的生日是 5 月 20 日', subjects: ['p_alice'],
      evidence: [birthday.id], confidence: 0.9, key: '生日', value: '5月20日',
    },
    {
      kind: 'l1.promise', text: '约好周末一起去看展', subjects: ['p_alice', 'self'],
      evidence: [invite.id, accept.id], confidence: 0.9,
    },
  ], 42)])

  const report = await w.extractor().runOnce(WINDOW)
  assert.deepEqual(report, {
    processed: 5, batches: 1, candidates: 0, promoted: 2, discardedBatches: 0,
    incompleteBatches: 0, parkedBatches: 0, droppedFacts: 0, injectedFacts: 0, tokens: 42, capped: false,
  })

  const records = await w.l1()
  assert.equal(records.length, 2)
  const birthdayRecord = records.find((record) => record.kind === 'l1.fact') as MemoryRecord
  const promiseRecord = records.find((record) => record.kind === 'l1.promise') as MemoryRecord

  assert.equal(birthdayRecord.source, 'kernel')
  assert.equal(birthdayRecord.actor, 'kernel')
  assert.equal(birthdayRecord.channel, HERE)
  assert.equal(birthdayRecord.importance, 0.5)
  assert.deepEqual(birthdayRecord.evidence, [{ id: birthday.id }])
  assert.deepEqual(birthdayRecord.content, { text: 'p_alice 的生日是 5 月 20 日', kind: 'l1.fact', key: '生日', value: '5月20日' })

  assert.deepEqual(promiseRecord.evidence, [{ id: invite.id }, { id: accept.id }])
  assert.deepEqual(promiseRecord.content, { text: '约好周末一起去看展', kind: 'l1.promise' })
  assert.equal(promiseRecord.tEvent, NOW)

  // Nothing about the unrelated records was invented.
  assert.ok(!records.some((record) => [hello.id, ack.id].includes(record.evidence[0]?.id as string)))
})

test('promotion follows confidence and the configurable threshold', async () => {
  const w = new World()
  const record = await w.l0()
  w.llm = new FakeLlm([reply([
    { kind: 'l1.fact', text: '高置信', subjects: ['p_alice'], evidence: [record.id], confidence: 0.9 },
    { kind: 'l1.fact', text: '低置信', subjects: ['p_alice'], evidence: [record.id], confidence: 0.5 },
  ])])

  const report = await w.extractor().runOnce(WINDOW)
  assert.equal(report.promoted, 1)
  assert.equal(report.candidates, 1)
  assert.deepEqual((await w.l1()).map((entry) => entry.kind).sort(), ['l1.candidate', 'l1.fact'])

  const strict = new World()
  const strictRecord = await strict.l0()
  strict.llm = new FakeLlm([reply([
    { kind: 'l1.fact', text: '高置信', subjects: ['p_alice'], evidence: [strictRecord.id], confidence: 0.9 },
  ])])
  const strictReport = await strict.extractor({ promoteConfidence: 0.95 }).runOnce(WINDOW)
  assert.equal(strictReport.promoted, 0)
  assert.equal(strictReport.candidates, 1)
})

test('only evidence-backed, valid calendar dates become pending promise metadata', async () => {
  const w = new World()
  const confirmed = await w.l0({ content: { text: '约好了，2028 年 2 月 29 日一起看展。' } })
  const relative = await w.l0({ content: { text: '约好了，明天一起跑步。' } })
  const invalid = await w.l0({ content: { text: '约好了，2027/2/29 一起吃饭。' } })
  w.llm = new FakeLlm([reply([
    { kind: 'l1.promise', text: '一起看展', subjects: ['p_alice'], evidence: [confirmed.id], confidence: 0.95, due: '2028-02-29' },
    { kind: 'l1.promise', text: '一起跑步', subjects: ['p_alice'], evidence: [relative.id], confidence: 0.95, due: '2028-02-29' },
    { kind: 'l1.promise', text: '一起吃饭', subjects: ['p_alice'], evidence: [invalid.id], confidence: 0.95, due: '2027-02-29' },
    { kind: 'l1.event', text: '聊到看展', subjects: ['p_alice'], evidence: [confirmed.id], confidence: 0.95, due: '2028-02-29' },
  ], 42)])

  const report = await w.extractor().runOnce(WINDOW)
  assert.equal(report.promoted, 4)
  const records = await w.l1()
  assert.deepEqual(records.find((record) => record.content.text === '一起看展')?.content, {
    kind: 'l1.promise',
    text: '一起看展',
    due: '2028-02-29',
    promiseStatus: 'pending',
  })
  assert.equal(records.filter((record) => record.content.due !== undefined).length, 1)
})

test('a conflicting value and a repeated value both stay candidates', async () => {
  const w = new World()
  const source = await w.l0({ content: { text: '生日记错了，是4月2日' } })
  const existing = await w.store.insert({
    layer: 'L1',
    kind: 'l1.fact',
    source: 'plugin.test',
    channel: HERE,
    subjects: ['p_alice'],
    actor: 'owner',
    content: { text: '生日是3月1日', kind: 'l1.fact', key: '生日', value: '3月1日' },
    evidence: [{ id: source.id }],
    visibility: 'open',
    trust: 'owner',
    confidence: 0.9,
    importance: 0.5,
    tEvent: NOW,
  })

  w.llm = new FakeLlm([reply([
    {
      kind: 'l1.fact', text: '生日是4月2日', subjects: ['p_alice'],
      evidence: [source.id], confidence: 0.95, key: '生日', value: '4月2日',
    },
    {
      kind: 'l1.fact', text: '生日是3月1日', subjects: ['p_alice'],
      evidence: [source.id], confidence: 0.95, key: '生日', value: '3月1日',
    },
  ])])

  const report = await w.extractor().runOnce(WINDOW)
  assert.equal(report.promoted, 0)
  assert.equal(report.candidates, 2)

  const extracted = (await w.l1()).filter((record) => record.source === 'kernel')
  const conflict = extracted.find((record) => record.content.value === '4月2日') as MemoryRecord
  const repeated = extracted.find((record) => record.content.value === '3月1日') as MemoryRecord
  assert.equal(conflict.kind, 'l1.candidate')
  assert.equal(conflict.content.duplicateOf, undefined)
  assert.equal(repeated.kind, 'l1.candidate')
  assert.equal(repeated.content.duplicateOf, existing.id)
})

test('the daily token cap stops at once and resets the next UTC day', async () => {
  const w = new World()
  await w.l0({ content: { text: '一' } })
  const second = await w.l0({ content: { text: '二' } })
  await w.l0({ content: { text: '三' } })
  w.llm = new FakeLlm([
    reply([], 60),
    reply([{ kind: 'l1.fact', text: '第二批写下的事', subjects: ['p_alice'], evidence: [second.id], confidence: 0.9 }], 60),
    reply([], 60),
  ])

  const extractor = w.extractor({ batchSize: 1, dailyTokenCap: 100 })
  const first = await extractor.runOnce(WINDOW)
  assert.deepEqual(first, {
    processed: 2, batches: 2, candidates: 0, promoted: 1, discardedBatches: 0,
    incompleteBatches: 0, parkedBatches: 0, droppedFacts: 0, injectedFacts: 0, tokens: 120, capped: true,
  })
  const written = await w.l1()
  assert.equal(written.length, 1)
  assert.equal(written[0]?.content.text, '第二批写下的事')
  assert.equal(w.llm.requests.length, 2)

  const sameDay = await extractor.runOnce(WINDOW)
  assert.equal(sameDay.batches, 0)
  assert.equal(sameDay.capped, true)
  assert.equal(w.llm.requests.length, 2)

  w.clock.advance(DAY)
  const nextDay = await extractor.runOnce(WINDOW)
  assert.deepEqual(nextDay, {
    processed: 1, batches: 1, candidates: 0, promoted: 0, discardedBatches: 0,
    incompleteBatches: 0, parkedBatches: 0, droppedFacts: 0, injectedFacts: 0, tokens: 60, capped: false,
  })
  assert.equal(w.llm.requests.length, 3)
})

test('a cap of zero makes no model call at all', async () => {
  const w = new World()
  await w.l0()
  const report = await w.extractor({ dailyTokenCap: 0 }).runOnce(WINDOW)
  assert.deepEqual(report, {
    processed: 0, batches: 0, candidates: 0, promoted: 0, discardedBatches: 0,
    incompleteBatches: 0, parkedBatches: 0, droppedFacts: 0, injectedFacts: 0, tokens: 0, capped: true,
  })
  assert.equal(w.llm.requests.length, 0)
})

test('a bad reply discards the whole batch, writes nothing and marks it processed', async () => {
  const w = new World()
  const record = await w.l0()
  w.llm = new FakeLlm([{ text: '{"facts":"not an array"}', tokens: 7 }])

  const report = await w.extractor().runOnce(WINDOW)
  assert.deepEqual(report, {
    processed: 1, batches: 1, candidates: 0, promoted: 0, discardedBatches: 1,
    incompleteBatches: 0, parkedBatches: 0, droppedFacts: 0, injectedFacts: 0, tokens: 7, capped: false,
  })
  assert.deepEqual(await w.l1(), [])
  assert.equal(w.processed.has(record.id), true)
})

test('running twice extracts nothing the second time, also across a reopened file log', async () => {
  const w = new World()
  await w.l0()
  w.llm = new FakeLlm([reply([], 5)])

  const extractor = w.extractor()
  await extractor.runOnce(WINDOW)
  assert.equal(w.llm.requests.length, 1)
  const second = await extractor.runOnce(WINDOW)
  assert.equal(second.batches, 0)
  assert.equal(second.processed, 0)
  assert.equal(w.llm.requests.length, 1)

  const dir = await mkdtemp(path.join(tmpdir(), 'brain-extraction-repeat-'))
  try {
    const file = path.join(dir, 'processed.log')
    const fileWorld = new World()
    await fileWorld.l0()
    fileWorld.llm = new FakeLlm([reply([], 5)])

    const processed = await createFileProcessedLog(file)
    const first = createExtractor({
      store: fileWorld.store, llm: fileWorld.llm, clock: fileWorld.clock, processed,
      dailyTokenCap: 1_000_000, maxOutputTokens: 512,
    })
    const firstReport = await first.runOnce(WINDOW)
    assert.equal(firstReport.batches, 1)
    assert.equal(fileWorld.llm.requests.length, 1)

    const reopened = await createFileProcessedLog(file)
    const otherLlm = new FakeLlm([])
    const secondExtractor = createExtractor({
      store: fileWorld.store, llm: otherLlm, clock: fileWorld.clock, processed: reopened,
      dailyTokenCap: 1_000_000, maxOutputTokens: 512,
    })
    const reopenedReport = await secondExtractor.runOnce(WINDOW)
    assert.equal(reopenedReport.batches, 0)
    assert.equal(reopenedReport.processed, 0)
    assert.equal(otherLlm.requests.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('trust falls back to the least trusted piece of evidence', async () => {
  const w = new World()
  const member = await w.l0({ trust: 'member', content: { text: 'member said' } })
  const external = await w.l0({ trust: 'external', content: { text: 'external said' } })
  w.llm = new FakeLlm([reply([
    {
      kind: 'l1.fact', text: '两处都提到了', subjects: ['p_alice'],
      evidence: [external.id, member.id], confidence: 0.9,
    },
  ])])

  await w.extractor().runOnce(WINDOW)
  const [record] = await w.l1()
  assert.equal(record?.trust, 'external')

  const onlyExternal = new World()
  const source = await onlyExternal.l0({ trust: 'external' })
  onlyExternal.llm = new FakeLlm([reply([
    { kind: 'l1.event', text: '发生了一件事', subjects: ['p_alice'], evidence: [source.id], confidence: 0.9 },
  ])])
  await onlyExternal.extractor().runOnce(WINDOW)
  const [other] = await onlyExternal.l1()
  assert.equal(other?.trust, 'external')
})

test('records never have wider visibility than their source, and visibility splits batches', async () => {
  const w = new World()
  const open = await w.l0({ visibility: 'open', content: { text: '公开场合说的' } })
  const ownerOnly = await w.l0({ visibility: 'owner', content: { text: '只跟主人说的' } })
  w.llm = new FakeLlm([
    reply([{ kind: 'l1.fact', text: '公开的事', subjects: ['p_alice'], evidence: [open.id], confidence: 0.9 }]),
    reply([{ kind: 'l1.fact', text: '私密的事', subjects: ['p_alice'], evidence: [ownerOnly.id], confidence: 0.9 }]),
  ])

  const report = await w.extractor().runOnce(WINDOW)
  assert.equal(report.batches, 2)

  const records = await w.l1()
  assert.equal(records.length, 2)
  for (const record of records) {
    const source = await w.store.get(record.evidence[0]?.id as string)
    assert.equal(record.visibility, source?.visibility)
  }
  assert.deepEqual(records.map((record) => record.visibility).sort(), ['open', 'owner'])
})

test('different channels are extracted in separate batches and keep their channel', async () => {
  const w = new World()
  const here = await w.l0({ channel: HERE, content: { text: '这个通道说的' } })
  const elsewhere = await w.l0({ channel: 'discord:2', content: { text: '另一个通道说的' } })
  w.llm = new FakeLlm([
    reply([{ kind: 'l1.fact', text: '这里的事', subjects: ['p_alice'], evidence: [here.id], confidence: 0.9 }]),
    reply([{ kind: 'l1.fact', text: '那里的事', subjects: ['p_alice'], evidence: [elsewhere.id], confidence: 0.9 }]),
  ])

  const report = await w.extractor().runOnce(WINDOW)
  assert.equal(report.batches, 2)
  const records = await w.l1()
  assert.equal(records.length, 2)
  for (const record of records) {
    const source = await w.store.get(record.evidence[0]?.id as string)
    assert.equal(record.channel, source?.channel)
  }
  assert.deepEqual(records.map((record) => record.channel).sort(), [HERE, 'discord:2'].sort())
})

test('the run is capped when the last batch reaches the limit', async () => {
  const w = new World()
  await w.l0({ content: { text: '一' } })
  await w.l0({ content: { text: '二' } })
  w.llm = new FakeLlm([reply([], 60), reply([], 60)])

  const report = await w.extractor({ batchSize: 1, dailyTokenCap: 100 }).runOnce(WINDOW)
  assert.equal(report.batches, 2)
  assert.equal(report.processed, 2)
  assert.equal(report.tokens, 120)
  assert.equal(report.capped, true)
})

test('tEvent is the latest evidence time', async () => {
  const w = new World()
  const early = await w.l0({ tEvent: NOW - 1_000, content: { text: '早说的' } })
  const late = await w.l0({ tEvent: NOW + 1_000, content: { text: '晚说的' } })
  w.llm = new FakeLlm([reply([
    { kind: 'l1.event', text: '两件事', subjects: ['p_alice'], evidence: [early.id, late.id], confidence: 0.9 },
  ])])

  await w.extractor().runOnce(WINDOW)
  const [record] = await w.l1()
  assert.equal(record?.tEvent, NOW + 1_000)
})

test('a crash between writing L1 and marking processed does not duplicate records', async () => {
  const w = new World()
  const source = await w.l0()
  const fact = {
    kind: 'l1.fact', text: 'p_alice 的生日是 5 月 20 日', subjects: ['p_alice'],
    evidence: [source.id], confidence: 0.9, key: '生日', value: '5月20日',
  }
  w.llm = new FakeLlm([reply([fact])])

  await w.extractor().runOnce(WINDOW)
  assert.equal((await w.l1()).length, 1)

  // A fresh log models a crash after insert but before processed.add: the same L0 is fetched again.
  const retryLlm = new FakeLlm([reply([fact])])
  const retry = createExtractor({
    store: w.store, llm: retryLlm, clock: w.clock, processed: createMemoryProcessedLog(),
    dailyTokenCap: 1_000_000, maxOutputTokens: 512,
  })
  const report = await retry.runOnce(WINDOW)
  assert.equal(report.batches, 1)
  assert.equal(retryLlm.requests.length, 1)
  assert.equal((await w.l1()).length, 1)
})

test('every page of L0 is read', async () => {
  const w = new World()
  for (let index = 0; index < 1_001; index += 1) {
    await w.l0({ content: { text: `第 ${index} 条` } })
  }
  w.llm = new FakeLlm([reply([], 5)])

  const report = await w.extractor({ batchSize: 1_001 }).runOnce(WINDOW)
  assert.equal(report.processed, 1_001)
  assert.equal(report.batches, 1)
  assert.equal(w.llm.requests.length, 1)
  const user = w.llm.requests[0]?.user as string
  assert.equal((JSON.parse(user.split('\n')[2] as string) as unknown[]).length, 1_001)
})

test('the window channel limits extraction to that channel', async () => {
  const w = new World()
  const here = await w.l0({ channel: HERE, content: { text: '这里的事' } })
  await w.l0({ channel: 'discord:2', content: { text: '那里的事' } })
  w.llm = new FakeLlm([reply([
    { kind: 'l1.fact', text: '这里的事', subjects: ['p_alice'], evidence: [here.id], confidence: 0.9 },
  ])])

  const report = await w.extractor().runOnce({ ...WINDOW, channel: HERE })
  assert.equal(report.processed, 1)
  assert.equal(report.batches, 1)
  const sent = JSON.parse((w.llm.requests[0]?.user as string).split('\n')[2] as string) as unknown[]
  assert.equal(sent.length, 1)
  const records = await w.l1()
  assert.equal(records.length, 1)
  assert.equal(records[0]?.channel, HERE)
})

test('the window bounds are inclusive and exclude records outside', async () => {
  const w = new World()
  const before = await w.l0({ tEvent: 100, content: { text: '早于 from' } })
  const atFrom = await w.l0({ tEvent: 200, content: { text: '等于 from' } })
  const atTo = await w.l0({ tEvent: 300, content: { text: '等于 to' } })
  const after = await w.l0({ tEvent: 400, content: { text: '晚于 to' } })
  w.llm = new FakeLlm([reply([], 5)])

  const report = await w.extractor().runOnce({ from: 200, to: 300 })
  assert.equal(report.processed, 2)
  assert.equal(w.processed.has(atFrom.id), true)
  assert.equal(w.processed.has(atTo.id), true)
  assert.equal(w.processed.has(before.id), false)
  assert.equal(w.processed.has(after.id), false)
})

test('tombstoned L0 records are not extracted', async () => {
  const w = new World()
  const record = await w.l0()
  await w.store.tombstone(record.id)
  w.llm = new FakeLlm([reply([], 5)])

  const report = await w.extractor().runOnce(WINDOW)
  assert.equal(report.processed, 0)
  assert.equal(report.batches, 0)
  assert.equal(w.llm.requests.length, 0)
})

test('a confidence exactly at the threshold promotes', async () => {
  const w = new World()
  const record = await w.l0()
  w.llm = new FakeLlm([reply([
    { kind: 'l1.fact', text: '刚好到阈值', subjects: ['p_alice'], evidence: [record.id], confidence: 0.8 },
  ])])

  const report = await w.extractor({ promoteConfidence: 0.8 }).runOnce(WINDOW)
  assert.equal(report.promoted, 1)
  assert.equal(report.candidates, 0)
  const [stored] = await w.l1()
  assert.equal(stored?.kind, 'l1.fact')
})

test('a different key is not a conflict even with a different value', async () => {
  const w = new World()
  const source = await w.l0({ content: { text: '我的生日是4月2日' } })
  await w.store.insert({
    layer: 'L1',
    kind: 'l1.fact',
    source: 'plugin.test',
    channel: HERE,
    subjects: ['p_alice'],
    actor: 'owner',
    content: { text: '喜欢喝咖啡', kind: 'l1.fact', key: '喜欢的饮料', value: '咖啡' },
    evidence: [{ id: source.id }],
    visibility: 'open',
    trust: 'owner',
    confidence: 0.9,
    importance: 0.5,
    tEvent: NOW,
  })
  w.llm = new FakeLlm([reply([
    {
      kind: 'l1.fact', text: '生日是4月2日', subjects: ['p_alice'],
      evidence: [source.id], confidence: 0.95, key: '生日', value: '4月2日',
    },
  ])])

  const report = await w.extractor().runOnce(WINDOW)
  assert.equal(report.promoted, 1)
  assert.equal(report.candidates, 0)
})

test('the default batch size is twenty', async () => {
  const w = new World()
  for (let index = 0; index < 21; index += 1) {
    await w.l0({ content: { text: `第 ${index} 条` } })
  }
  w.llm = new FakeLlm([reply([], 5), reply([], 5), reply([], 5)])

  const report = await w.extractor().runOnce(WINDOW)
  assert.equal(report.batches, 2)
  assert.equal(report.processed, 21)
  const sizes = w.llm.requests.map((request) => (JSON.parse((request.user as string).split('\n')[2] as string) as unknown[]).length)
  assert.deepEqual(sizes, [20, 1])
})
