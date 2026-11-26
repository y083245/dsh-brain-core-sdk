import assert from 'node:assert/strict'
import test from 'node:test'
import { LIMITS } from '@brain-core/sdk'
import type { WakeMessage } from '@brain-core/sdk'
import { FEED, GROUP, OTHER, PRIVATE, harness, msg, rejection, settle, textOf, until } from './helpers.ts'
import type { Harness } from './helpers.ts'

async function withHarness(t: { after(fn: () => Promise<void>): void }, options?: Parameters<typeof harness>[0]): Promise<Harness> {
  const h = await harness(options)
  t.after(() => h.cleanup())
  return h
}

function messagesIn(h: Harness, index: number): string[] {
  return textOf(h.runner.runs[index]?.input ?? '').split('\n').filter((line) => line.startsWith('{"who"')).map((line) => (JSON.parse(line) as { text: string }).text)
}

test('two wakes on one channel run one after the other, and the second waits for the first (FR-G01)', async (t) => {
  const h = await withHarness(t)
  const first = h.runner.gate()
  const a = h.wake(PRIVATE, { messages: [msg('1', 'one')] })
  await until(() => h.runner.runs.length === 1)
  const b = h.wake(PRIVATE, { messages: [msg('2', 'two')] })
  await settle()
  assert.equal(h.runner.runs.length, 1, 'the second does not start while the first is running')
  first.release()
  await a
  await b
  assert.equal(h.runner.runs.length, 2)
  assert.equal(h.runner.maxActive, 1)
  assert.deepEqual(messagesIn(h, 0), ['one'])
  assert.deepEqual(messagesIn(h, 1), ['two'])
})

test('different channels do not wait for each other', async (t) => {
  const h = await withHarness(t)
  const first = h.runner.gate()
  const a = h.wake(PRIVATE, { messages: [msg('1', 'one')] })
  await until(() => h.runner.runs.length === 1)
  const b = await h.wake(OTHER, { messages: [msg('2', 'two')] })
  assert.equal(b.acked, true)
  assert.equal(h.runner.runs.length, 2)
  first.release()
  assert.equal((await a).acked, true)
})

test('three quick wakes with a debounce run once, with all three messages, and all three promises finish together (FR-T06)', async (t) => {
  const h = await withHarness(t)
  const results: Promise<unknown>[] = []
  for (const [id, text] of [['1', 'a'], ['2', 'b'], ['3', 'c']] as const) {
    results.push(h.wake(PRIVATE, { debounceMs: 800, messages: [msg(id, text)] }))
    await settle()
  }
  assert.equal(h.runner.runs.length, 0, 'nothing runs while the debounce is open')
  assert.equal(h.timers.pending, 1, 'one timer for the one waiting batch')
  assert.equal(h.timers.cleared.length, 2, 'each new wake reset the timer')
  assert.equal([...h.timers.timers.values()][0]?.ms, 800)
  h.timers.fireAll()
  const done = (await Promise.all(results)) as { wakeId: string; acked: boolean }[]
  assert.equal(h.runner.runs.length, 1)
  assert.deepEqual(messagesIn(h, 0), ['a', 'b', 'c'])
  assert.equal(new Set(done.map((r) => r.wakeId)).size, 1)
  assert.ok(done.every((r) => r.acked))
  assert.equal(h.metrics[0]?.debounceMs, 800)
})

test('a wake with no debounce makes the waiting batch ready at once and drops the timer', async (t) => {
  const h = await withHarness(t)
  const a = h.wake(PRIVATE, { debounceMs: 5_000, messages: [msg('1', 'a')] })
  await until(() => h.timers.pending === 1)
  const b = h.wake(PRIVATE, { messages: [msg('2', 'b')] })
  await Promise.all([a, b])
  assert.equal(h.timers.pending, 0)
  assert.deepEqual(messagesIn(h, 0), ['a', 'b'])
  assert.equal(h.metrics[0]?.debounceMs, 0)
})

test('a wake that arrives during a turn is merged into one next run, and several arrivals still cause only one more run', async (t) => {
  const h = await withHarness(t)
  const first = h.runner.gate()
  const a = h.wake(PRIVATE, { messages: [msg('1', 'one')] })
  await until(() => h.runner.runs.length === 1)
  const later = [h.wake(PRIVATE, { messages: [msg('2', 'two')] }), h.wake(PRIVATE, { messages: [msg('3', 'three')] }), h.wake(PRIVATE, { messages: [msg('4', 'four')] })]
  await settle()
  first.release()
  await a
  await Promise.all(later)
  assert.equal(h.runner.runs.length, 2)
  assert.deepEqual(messagesIn(h, 1), ['two', 'three', 'four'])
})

test('a debounce that ends while a turn is still running waits for the turn', async (t) => {
  const h = await withHarness(t)
  const first = h.runner.gate()
  const a = h.wake(PRIVATE, { messages: [msg('1', 'one')] })
  await until(() => h.runner.runs.length === 1)
  const b = h.wake(PRIVATE, { debounceMs: 100, messages: [msg('2', 'two')] })
  await until(() => h.timers.pending === 1)
  h.timers.fireAll()
  await settle()
  assert.equal(h.runner.runs.length, 1)
  first.release()
  await a
  await b
  assert.equal(h.runner.runs.length, 2)
})

test('merging: messages are de-duplicated by id and the newest 50 are kept', async (t) => {
  const h = await withHarness(t)
  const first = h.runner.gate()
  const a = h.wake(PRIVATE, { messages: [msg('start', 'start')] })
  await until(() => h.runner.runs.length === 1)
  const batch1: WakeMessage[] = Array.from({ length: 30 }, (_, i) => msg(`m${i}`, `t${i}`))
  const batch2: WakeMessage[] = Array.from({ length: 40 }, (_, i) => msg(`m${i + 20}`, `t${i + 20}`))
  const b = h.wake(PRIVATE, { messages: batch1 })
  const c = h.wake(PRIVATE, { messages: [...batch2, msg('m0', 'again')] })
  await settle()
  first.release()
  await Promise.all([a, b, c])
  const texts = messagesIn(h, 1)
  assert.equal(texts.length, LIMITS.wakeMessages)
  assert.deepEqual(texts, Array.from({ length: 50 }, (_, i) => `t${i + 10}`), 'the oldest ten fell off, and the repeat of m0 was not added again')
})

test('merging: more than 50 in one call keeps the newest, and a duplicate keeps the first copy', async (t) => {
  const h = await withHarness(t)
  const many = Array.from({ length: 60 }, (_, i) => msg(`m${i}`, `t${i}`))
  await h.wake(PRIVATE, { messages: [...many, msg('m59', 'dup')] })
  const texts = messagesIn(h, 0)
  assert.equal(texts.length, 50)
  assert.equal(texts[0], 't10')
  assert.equal(texts[49], 't59')
})

test('merging: silent only when every wake was silent, reason is the newest, evidence is merged, event and note are the newest', async (t) => {
  const h = await withHarness(t)
  const first = h.runner.gate()
  const a = h.wake(PRIVATE, { messages: [msg('start', 's')] })
  await until(() => h.runner.runs.length === 1)
  const waiting = [
    h.wake(PRIVATE, { reason: 'message', silent: true, evidence: ['e1'], note: 'old note', messages: [msg('1', 'x')] }),
    h.wake(PRIVATE, { reason: 'poke', silent: true, evidence: ['e2', 'e1'], event: 'poke', note: 'new note' }),
  ]
  await settle()
  first.release()
  await a
  await Promise.all(waiting)
  const plan = h.gateway.plans[1]
  assert.equal(plan?.silent, true)
  assert.deepEqual(plan?.evidence, ['1', 'e1', 'e2'])
  assert.equal(plan?.features.event.poke, true)
  const text = textOf(h.runner.runs[1]?.input ?? '')
  assert.ok(text.startsWith('<wake reason="poke"'))
  assert.ok(text.includes('<note>{"text":"new note"}</note>'))
})

test('merging: one wake that is not silent makes the whole turn not silent, and one that is not proactive too', async (t) => {
  const h = await withHarness(t)
  const first = h.runner.gate()
  const a = h.wake(PRIVATE, { messages: [msg('start', 's')] })
  await until(() => h.runner.runs.length === 1)
  const waiting = [h.wake(PRIVATE, { silent: true }), h.wake(PRIVATE, { silent: false, messages: [msg('1', 'x')] }), h.wake(PRIVATE, { silent: true })]
  await settle()
  first.release()
  await a
  await Promise.all(waiting)
  assert.equal(h.gateway.plans[1]?.silent, false)
})

test('a silent wake on its own is a silent plan', async (t) => {
  const h = await withHarness(t)
  await h.wake(PRIVATE, { silent: true })
  assert.equal(h.gateway.plans[0]?.silent, true)
  await h.wake(PRIVATE, {})
  assert.equal(h.gateway.plans[1]?.silent, false)
})

test('a missing model: every caller is rejected with UNAVAILABLE, nothing runs, the messages are not lost from memory', async (t) => {
  const h = await withHarness(t, { settings: { agents: { activity: { provider: 'p', model: 'm', effort: 'high' } }, timezone: 'UTC' } })
  const a = h.wake(PRIVATE, { debounceMs: 100, messages: [msg('1', 'a')] })
  const b = h.wake(PRIVATE, { debounceMs: 100, messages: [msg('2', 'b')] })
  const caught = [rejection(a), rejection(b)]
  await until(() => h.timers.pending === 1)
  h.timers.fireAll()
  for (const error of await Promise.all(caught)) {
    assert.equal(error.code, 'UNAVAILABLE')
    assert.equal(error.message, '还没选模型')
  }
  assert.equal(h.runner.runs.length, 0)
  assert.equal(h.gateway.plans.length, 0)
  assert.equal(h.contexts.length, 0)
  assert.equal(h.metrics[0]?.outcome, 'unavailable')
  assert.equal(h.events.filter((event) => event.name === 'message.in').length, 2, 'the plugin already ingested them; the arrival was announced')
  h.state.settings = { agents: { chat: { provider: 'p', model: 'm', effort: 'high' } }, timezone: 'UTC' }
  const ok = await h.wake(PRIVATE, { messages: [msg('3', 'c')] })
  assert.equal(ok.acked, true)
  assert.deepEqual(messagesIn(h, 0), ['c'], 'the rejected snapshot is not replayed')
})

test('the model is looked up for the channel class: a group needs the chat model, a feed the activity model', async (t) => {
  const h = await withHarness(t, { settings: { agents: { chat: { provider: 'p', model: 'm', effort: 'high' } }, timezone: 'UTC' } })
  assert.equal((await h.wake(GROUP, { messages: [msg('1', 'a')] })).acked, true)
  assert.equal((await rejection(h.wake(FEED, { messages: [msg('2', 'b')] }))).code, 'UNAVAILABLE')
  assert.deepEqual(h.runner.runs.map((run) => run.agentClass), ['chat'])
})

test('an incomplete or invalid selection is UNAVAILABLE too', async (t) => {
  const h = await withHarness(t, { settings: { agents: { chat: { provider: 'p', model: 'm' } }, timezone: 'UTC' } })
  assert.equal((await rejection(h.wake(PRIVATE))).code, 'UNAVAILABLE')
  h.state.settings = { agents: { chat: { provider: 'p', model: 'm', effort: 'sideways' as never } }, timezone: 'UTC' }
  assert.equal((await rejection(h.wake(PRIVATE))).code, 'UNAVAILABLE')
  assert.equal(h.runner.runs.length, 0)
})

test('no role card: UNAVAILABLE, and the session is not touched', async (t) => {
  const h = await withHarness(t, { profileVersion: 0 })
  const error = await rejection(h.wake(PRIVATE, { messages: [msg('1', 'a')] }))
  assert.equal(error.code, 'UNAVAILABLE')
  assert.equal(error.message, '还没有角色卡')
  assert.equal(h.runner.runs.length, 0)
  assert.equal(h.contexts.length, 0)
  assert.equal(h.metrics[0]?.outcome, 'unavailable')
  h.profiles.set({ version: 3, stable: 'S' })
  assert.equal((await h.wake(PRIVATE)).acked, true)
})

test('a wake nobody awaits that fails does not become an unhandled rejection', async (t) => {
  const h = await withHarness(t, { profileVersion: 0 })
  const seen: unknown[] = []
  const listener = (reason: unknown): void => { seen.push(reason) }
  process.on('unhandledRejection', listener)
  t.after(() => { process.off('unhandledRejection', listener) })
  void h.wake(PRIVATE, { messages: [msg('1', 'a')] })
  void h.runtime.wake('not a channel', { reason: 'message' })
  void h.runtime.wake(PRIVATE, { reason: 'Bad Reason' })
  await settle()
  await settle()
  assert.deepEqual(seen, [])
})

test('a bad reason, channel or debounce is INVALID_ARGUMENT', async (t) => {
  const h = await withHarness(t)
  for (const reason of ['', 'Message', 'a b', 'x'.repeat(33), 'été']) {
    assert.equal((await rejection(h.runtime.wake(PRIVATE, { reason }))).code, 'INVALID_ARGUMENT', reason)
  }
  assert.equal((await rejection(h.runtime.wake(PRIVATE, { reason: undefined as never }))).code, 'INVALID_ARGUMENT')
  for (const reason of ['message', 'own-time', 'a_b', 'x'.repeat(32), '1']) {
    assert.equal((await h.runtime.wake(PRIVATE, { reason })).acked, true, reason)
  }
  for (const channel of ['', 'qq', 'qq:private', 'QQ:private:a', 'qq:private:a b']) {
    assert.equal((await rejection(h.wake(channel))).code, 'INVALID_ARGUMENT', channel)
  }
  for (const debounceMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, '5' as never]) {
    assert.equal((await rejection(h.wake(PRIVATE, { debounceMs }))).code, 'INVALID_ARGUMENT')
  }
})

test('two wakes from different plugins get the same profile version (FR-G02)', async (t) => {
  const h = await withHarness(t)
  h.state.bundle = { ...h.state.bundle, profileVersion: 7 }
  const [a, b] = await Promise.all([h.wake(PRIVATE, { reason: 'message' }), h.wake(OTHER, { reason: 'own-time' })])
  assert.equal(a.profileVersion, 7)
  assert.equal(b.profileVersion, 7)
  assert.equal(h.metrics[0]?.profileVersion, 7)
})

test('close rejects the callers still waiting, stops the timers, and refuses new wakes', async (t) => {
  const h = await withHarness(t)
  const waiting = h.wake(PRIVATE, { debounceMs: 10_000, messages: [msg('1', 'a')] })
  const caught = rejection(waiting)
  await until(() => h.timers.pending === 1)
  await h.runtime.close()
  assert.equal((await caught).code, 'UNAVAILABLE')
  assert.equal(h.timers.pending, 0)
  assert.equal((await rejection(h.wake(PRIVATE))).code, 'UNAVAILABLE')
  assert.equal(h.runner.runs.length, 0)
})

test('merging: debounced and queued wakes preserve WakeMessage.hasMedia when combined with text-only messages', async (t) => {
  const h = await withHarness(t)

  // Case 1: media message first, then text-only message via debounce
  const d1 = h.wake(PRIVATE, { debounceMs: 500, messages: [msg('m1', '[图片#1]', { hasMedia: true })] })
  await settle()
  const d2 = h.wake(PRIVATE, { debounceMs: 500, messages: [msg('m2', '看看这个')] })
  await settle()
  h.timers.fireAll()
  await Promise.all([d1, d2])
  assert.equal(h.gateway.plans[0]?.features.message.hasMedia, true)

  // Case 2: text-only message first, then media message queued while a turn is running
  const gate = h.runner.gate()
  const running = h.wake(PRIVATE, { messages: [msg('m3', 'busy')] })
  await until(() => h.runner.runs.length === 2)
  const q1 = h.wake(PRIVATE, { messages: [msg('m4', '先说一句')] })
  const q2 = h.wake(PRIVATE, { messages: [msg('m5', '[图片#2]', { hasMedia: true })] })
  await settle()
  gate.release()
  await Promise.all([running, q1, q2])
  assert.equal(h.gateway.plans[2]?.features.message.hasMedia, true)
})
