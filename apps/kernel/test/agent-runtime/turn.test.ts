import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { RunnerFailedError, SelectionMissingError, TurnInterruptedError, decodeSessionId, encodeSessionId } from '@dsh-brain-core/satellite-host'
import { buildSystemPrompt, KERNEL_RULES } from '../../src/agent-runtime/index.ts'
import { createToolGateway } from '../../src/tool-gateway/index.ts'
import { FEED, GROUP, OTHER, PRIVATE, bundleOf, harness, msg, rejection, settle, textOf, turn, until } from './helpers.ts'
import type { Harness } from './helpers.ts'

async function withHarness(t: { after(fn: () => Promise<void>): void }, options?: Parameters<typeof harness>[0]): Promise<Harness> {
  const h = await harness(options)
  t.after(() => h.cleanup())
  return h
}

async function readState(h: Harness): Promise<{ channels: Record<string, Record<string, unknown>> }> {
  return JSON.parse(await readFile(h.stateFile, 'utf8')) as { channels: Record<string, Record<string, unknown>> }
}

function messagesIn(h: Harness, index: number): string[] {
  return textOf(h.runner.runs[index]?.input ?? '').split('\n').filter((line) => line.startsWith('{"who"')).map((line) => (JSON.parse(line) as { text: string }).text)
}

test('the session is the channel and generation, and the class follows the second segment of the channel', async (t) => {
  const h = await withHarness(t)
  await h.wake(PRIVATE)
  await h.wake(GROUP)
  await h.wake(FEED)
  assert.deepEqual(h.runner.runs.map((run) => run.agentClass), ['chat', 'chat', 'activity'])
  assert.deepEqual(h.runner.runs.map((run) => decodeSessionId(run.sessionId)), [
    { agentClass: 'chat', channel: PRIVATE, generation: 0 },
    { agentClass: 'chat', channel: GROUP, generation: 0 },
    { agentClass: 'activity', channel: FEED, generation: 0 },
  ])
  assert.deepEqual(h.gateway.plans.map((plan) => plan.sessionId), h.runner.runs.map((run) => run.sessionId))
})

test('the four features come from the snapshot, the event and the channel', async (t) => {
  const h = await withHarness(t)
  const image = { mediaType: 'image/png', base64: 'AAAA' }
  await h.wake(PRIVATE, { messages: [msg('1', 'plain')] })
  await h.wake(PRIVATE, { messages: [msg('2', 'pic', { images: [image] })] })
  await h.wake(GROUP, { messages: [msg('3', 'fwd', { forwarded: true })] })
  await h.wake(FEED, { event: 'poke' })
  await h.wake(PRIVATE, { messages: [msg('4', 'no pic', { images: [] }), msg('5', 'not forwarded', { forwarded: false })] })
  assert.deepEqual(h.gateway.plans.map((plan) => plan.features), [
    { message: { hasMedia: false, hasForward: false }, event: { poke: false }, channel: { kind: 'private' } },
    { message: { hasMedia: true, hasForward: false }, event: { poke: false }, channel: { kind: 'private' } },
    { message: { hasMedia: false, hasForward: true }, event: { poke: false }, channel: { kind: 'group' } },
    { message: { hasMedia: false, hasForward: false }, event: { poke: true }, channel: { kind: 'feed' } },
    { message: { hasMedia: false, hasForward: false }, event: { poke: false }, channel: { kind: 'private' } },
  ])
})

test('the plan carries the evidence, the peer texts, the mode, the wake id and the participants', async (t) => {
  const h = await withHarness(t)
  h.state.mode = 'fixed'
  const result = await h.wake(PRIVATE, {
    evidence: ['l0_extra', 'l0_1'], messages: [msg('l0_1', 'hello'), msg('l0_2', 'world', { actor: 'bob' })],
  })
  const plan = h.gateway.plans[0]
  assert.deepEqual(plan?.evidence, ['l0_1', 'l0_2', 'l0_extra'])
  assert.deepEqual(plan?.peerTexts, ['hello', 'world'])
  assert.equal(plan?.mode, 'fixed')
  assert.equal(plan?.wakeId, result.wakeId)
  assert.deepEqual(plan?.participants, ['alice', 'bob'])
  assert.equal(plan?.silent, false)
})

test('the viewer is the agent in this channel with this snapshot’s people, and the query is the messages', async (t) => {
  const h = await withHarness(t)
  await h.wake(GROUP, { messages: [msg('1', '周末去哪里玩？'), msg('2', '去海边吧', { actor: 'bob' })] })
  assert.deepEqual(h.contexts[0], {
    request: { channel: GROUP, query: '周末去哪里玩？ 去海边吧' },
    viewer: { caller: 'agent', channel: GROUP, participants: ['alice', 'bob'] },
  })
  await h.wake(GROUP, { messages: [msg('3', '好的')] })
  assert.deepEqual(h.contexts[1]?.request, { channel: GROUP }, 'no query for an acknowledgement')
  await h.wake(GROUP, { reason: 'poke' })
  assert.deepEqual(h.contexts[2]?.request, { channel: GROUP }, 'no query without messages')
})

test('participants: the snapshot first, then the people remembered from earlier turns, never self, at most 32', async (t) => {
  const h = await withHarness(t)
  await h.wake(PRIVATE, { messages: [msg('1', 'a', { actor: 'alice' }), msg('2', 'b', { actor: 'bob' })] })
  await h.wake(PRIVATE, { messages: [msg('3', 'c', { actor: 'carol' }), msg('4', 'd', { actor: 'self' }), msg('5', 'e', { actor: 'carol' })] })
  assert.deepEqual(h.gateway.plans[1]?.participants, ['carol', 'bob', 'alice'])
  const crowd = Array.from({ length: 40 }, (_, i) => msg(`c${i}`, `t${i}`, { actor: `p${i}` }))
  await h.wake(PRIVATE, { messages: crowd })
  assert.equal(h.gateway.plans[2]?.participants.length, 32)
  assert.deepEqual(h.gateway.plans[2]?.participants.slice(0, 3), ['p0', 'p1', 'p2'])
  await h.wake(PRIVATE, { reason: 'own-time' })
  const remembered = h.gateway.plans[3]?.participants ?? []
  assert.equal(remembered.length, 32)
  assert.equal(remembered[0], 'p39', 'newest speaker first')
  assert.ok(!remembered.includes('self'))
  assert.equal((await readState(h)).channels[PRIVATE]?.people instanceof Array, true)
  assert.equal(((await readState(h)).channels[PRIVATE]?.people as string[]).length, 32)
})

test('members come from the channel provider at most every five minutes; failure falls back and is only logged', async (t) => {
  const h = await withHarness(t)
  let calls = 0
  let fail = false
  h.providers.set(PRIVATE, {
    send: async () => ({}),
    members: async () => { calls += 1; if (fail) throw new Error('offline'); return ['alice', 'bob'] },
    resolveIdentity: async () => null,
  })
  await h.wake(PRIVATE)
  assert.equal(calls, 1)
  assert.deepEqual(h.members, [{ channel: PRIVATE, people: ['alice', 'bob'] }])
  h.clock.advance(5 * 60_000)
  await h.wake(PRIVATE)
  assert.equal(calls, 1, 'exactly five minutes is still the cache')
  h.clock.advance(1)
  fail = true
  await h.wake(PRIVATE)
  assert.equal(calls, 2)
  assert.deepEqual(h.members[1], { channel: PRIVATE, people: null })
  assert.ok(h.logs.some((line) => line.event === 'agent-runtime.members_failed'))
  assert.ok(!JSON.stringify(h.logs).includes('offline'))
  await h.wake(PRIVATE)
  assert.equal(calls, 2, 'a failure also waits out the five minutes')
  await h.wake(OTHER)
  assert.equal(h.members.length, 2, 'a channel without a provider never calls setMembers')
})

test('a model that calls no tool and says nothing ends the turn and the wake is acked (FR-T06)', async (t) => {
  const h = await withHarness(t)
  h.runner.script.push(() => turn({ finalResponse: '', steps: [
    { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  ] }))
  const result = await h.wake(PRIVATE, { messages: [msg('1', 'hi')] })
  assert.deepEqual(result, { wakeId: result.wakeId, acked: true, profileVersion: 1, sent: 0, steps: 2 })
  assert.deepEqual(h.gateway.ended, [h.runner.runs[0]?.sessionId])
})

test('the sent count comes from the gateway', async (t) => {
  const h = await withHarness(t)
  h.runner.script.push(() => { h.gateway.sent = 2; return turn() })
  const result = await h.wake(PRIVATE, { messages: [msg('1', 'hi')] })
  assert.equal(result.sent, 2)
  assert.equal(result.acked, true)
})

test('the wake text goes to the runner as input, and the dynamic parts never enter the system prompt (FR-T05)', async (t) => {
  const h = await withHarness(t)
  h.gateway.recent = ['一', '二', '三', '四', '五', '六']
  h.state.bundle = bundleOf({ blocks: [{ name: 'facts', items: [{ id: 'a', text: '喜欢茶', disclosure: { label: '私下', speakable: 'yes' } }] }] })
  h.state.mood = '【你此刻】困'
  await h.wake(PRIVATE, { messages: [msg('1', 'hello', { tEvent: h.clock.now() })] })
  h.clock.advance(3_600_000)
  h.state.mood = '【你此刻】精神'
  h.state.bundle = bundleOf({ blocks: [] })
  await h.wake(PRIVATE, { messages: [msg('2', 'again', { tEvent: h.clock.now() })] })
  const [first, second] = h.runner.runs.map((run) => textOf(run.input))
  assert.ok(first?.startsWith('<wake reason="message" at="12:00">'))
  assert.ok(first?.includes('<mood>【你此刻】困</mood>'))
  assert.ok(first?.includes('{"block":"facts","text":"喜欢茶"'))
  assert.ok(first?.includes('<recent-self>\n{"text":"二"}\n{"text":"三"}\n{"text":"四"}\n{"text":"五"}\n{"text":"六"}\n</recent-self>'))
  assert.ok(second?.startsWith('<wake reason="message" at="13:00">'))
  assert.ok(second?.includes('<mood>【你此刻】精神</mood>'))
  assert.ok(!second?.includes('喜欢茶'))
  const stable = h.state.bundle.stable
  assert.equal(buildSystemPrompt(stable), buildSystemPrompt(stable), 'the same bytes every time')
  assert.equal(buildSystemPrompt(stable), `${KERNEL_RULES}\n\n${stable}`)
  for (const input of [first, second]) {
    assert.ok(!input?.includes(KERNEL_RULES))
    assert.ok(!input?.includes(stable))
  }
})

test('a mood that cannot be computed does not stop the turn', async (t) => {
  const h = await withHarness(t)
  h.state.moodError = new Error('no mood today')
  const result = await h.wake(PRIVATE, { messages: [msg('1', 'hi')] })
  assert.equal(result.acked, true)
  assert.ok(!textOf(h.runner.runs[0]?.input ?? '').includes('<mood>'))
  assert.ok(h.logs.some((line) => line.event === 'agent-runtime.mood_failed'))
})

test('the mood is asked once per turn, not once per attempt', async (t) => {
  const h = await withHarness(t)
  let asked = 0
  const deps = { ...h.deps, mood: async () => { asked += 1; return { line: '【你此刻】x' } } }
  const runtime = h.rebuild(deps)
  h.runner.script.push(() => { throw new TurnInterruptedError('crash', 'boom') })
  await runtime.wake(PRIVATE, { reason: 'message' })
  assert.equal(asked, 1)
  assert.equal(h.runner.runs.length, 2)
})

test('images in the snapshot go to the runner as blocks after the text', async (t) => {
  const h = await withHarness(t)
  await h.wake(PRIVATE, { messages: [msg('1', 'look', { images: [{ mediaType: 'image/png', base64: 'AAAA' }] })] })
  const input = h.runner.runs[0]?.input
  assert.ok(Array.isArray(input))
  assert.deepEqual((input as readonly { type: string }[]).map((block) => block.type), ['text', 'image'])
})

test('stable changing calls invalidate for that class; unchanged does not; the first time does not', async (t) => {
  const h = await withHarness(t)
  await h.wake(PRIVATE)
  await h.wake(PRIVATE)
  assert.deepEqual(h.runner.invalidated, [])
  h.state.bundle = bundleOf({ stable: 'STABLE-2' })
  await h.wake(PRIVATE)
  assert.deepEqual(h.runner.invalidated, ['chat'])
  await h.wake(GROUP)
  assert.deepEqual(h.runner.invalidated, ['chat'], 'the class already knows STABLE-2')
  await h.wake(FEED)
  assert.deepEqual(h.runner.invalidated, ['chat'], 'the first time for activity')
  h.state.bundle = bundleOf({ stable: 'STABLE-3' })
  await h.wake(FEED)
  assert.deepEqual(h.runner.invalidated, ['chat', 'activity'])
  await h.wake(FEED)
  assert.equal(h.runner.invalidated.length, 2)
})

test('invalidate comes before the run that needs the new prompt', async (t) => {
  const h = await withHarness(t)
  await h.wake(PRIVATE)
  h.state.bundle = bundleOf({ stable: 'STABLE-2' })
  const order: string[] = []
  const original = h.runner.invalidate.bind(h.runner)
  h.runner.invalidate = (agentClass) => { order.push('invalidate'); original(agentClass) }
  h.runner.script.push(() => { order.push('run'); return turn() })
  await h.wake(PRIVATE)
  assert.deepEqual(order, ['invalidate', 'run'])
})

test('an interrupted turn that sent nothing is run again once, with a fresh plan, and then it is acked', async (t) => {
  const h = await withHarness(t)
  h.runner.script.push(() => { throw new TurnInterruptedError('timeout', 'slow') })
  const result = await h.wake(PRIVATE, { messages: [msg('1', 'hi')] })
  assert.equal(result.acked, true)
  assert.equal(h.runner.runs.length, 2)
  assert.equal(h.gateway.plans.length, 2)
  assert.equal(h.gateway.ended.length, 2)
  assert.deepEqual(h.runner.runs[1]?.input, h.runner.runs[0]?.input)
  assert.equal(h.contexts.length, 1, 'recall is not asked again')
  assert.equal(h.metrics[0]?.outcome, 'acked')
})

test('an interrupted turn that fails again stops: acked false, the messages wait for the next wake, which is not triggered', async (t) => {
  const h = await withHarness(t)
  h.runner.script.push(() => { throw new TurnInterruptedError('crash', 'a') }, () => { throw new TurnInterruptedError('crash', 'b') })
  const result = await h.wake(PRIVATE, { messages: [msg('1', 'first')] })
  assert.deepEqual(result, { wakeId: result.wakeId, acked: false, profileVersion: 1, sent: 0, steps: 0 })
  assert.equal(h.runner.runs.length, 2)
  await settle()
  assert.equal(h.runner.runs.length, 2, 'nothing runs by itself')
  assert.equal(h.metrics[0]?.outcome, 'interrupted')
  assert.deepEqual(h.events.filter((event) => event.name === 'agent.turn').map((event) => (event.payload as { ok: boolean }).ok), [false])
  await h.wake(PRIVATE, { messages: [msg('2', 'second'), msg('1', 'first')] })
  assert.deepEqual(messagesIn(h, 2), ['first', 'second'], 'the earlier message comes first and is not repeated')
})

test('the extra evidence of a turn that did not finish is kept for the next wake', async (t) => {
  const h = await withHarness(t)
  h.runner.script.push(() => { throw new TurnInterruptedError('crash', 'a') }, () => { throw new TurnInterruptedError('crash', 'b') })
  await h.wake(PRIVATE, { messages: [msg('l0_1', 'first')], evidence: ['l0_extra'] })
  await h.wake(PRIVATE, { messages: [msg('l0_2', 'second')] })
  assert.deepEqual(h.gateway.plans.at(-1)?.evidence, ['l0_1', 'l0_2', 'l0_extra'])
})

test('an interrupted turn that already sent something is not run again; its messages wait', async (t) => {
  const h = await withHarness(t)
  h.runner.script.push(() => { h.gateway.sent = 1; throw new TurnInterruptedError('timeout', 'slow') })
  const result = await h.wake(PRIVATE, { messages: [msg('1', 'first')] })
  assert.equal(h.runner.runs.length, 1)
  assert.equal(result.acked, false)
  assert.equal(result.sent, 1)
  await h.wake(PRIVATE, { messages: [msg('2', 'second')] })
  assert.deepEqual(messagesIn(h, 1), ['first', 'second'])
  const state = await readState(h)
  assert.equal(typeof state.channels[PRIVATE]?.lastOutboundAt, 'number', 'what was sent still counts as sent')
})

test('messages put back after a failure join the wake that is already waiting, in front, and do not trigger it', async (t) => {
  const h = await withHarness(t)
  const first = h.runner.gate()
  const a = h.wake(PRIVATE, { messages: [msg('1', 'one')] })
  await until(() => h.runner.runs.length === 1)
  const b = h.wake(PRIVATE, { debounceMs: 500, messages: [msg('2', 'two')] })
  await until(() => h.timers.pending === 1)
  h.runner.script.push(() => { throw new TurnInterruptedError('crash', 'again') })
  first.fail(new TurnInterruptedError('crash', 'first'))
  assert.equal((await a).acked, false)
  assert.equal(h.runner.runs.length, 2, 'the rerun failed too')
  assert.equal(h.timers.pending, 1, 'the waiting batch is still waiting for its own timer')
  h.timers.fireAll()
  assert.equal((await b).acked, true)
  assert.equal(h.runner.runs.length, 3)
  assert.deepEqual(messagesIn(h, 2), ['one', 'two'])
})

test('no model or a stopped runner: UNAVAILABLE, and the messages are not put back', async (t) => {
  const h = await withHarness(t)
  h.runner.script.push(() => { throw new SelectionMissingError('chat', 'model') })
  const missing = await rejection(h.wake(PRIVATE, { messages: [msg('1', 'one')] }))
  assert.equal(missing.code, 'UNAVAILABLE')
  h.runner.script.push(() => { throw new RunnerFailedError('chat', 'stopped') })
  const failed = await rejection(h.wake(PRIVATE, { messages: [msg('2', 'two')] }))
  assert.equal(failed.code, 'UNAVAILABLE')
  assert.deepEqual(h.metrics.map((entry) => entry.outcome), ['unavailable', 'unavailable'])
  assert.equal(h.gateway.ended.length, 2, 'the wake is ended')
  assert.equal(h.runner.runs.length, 2, 'no rerun')
  await h.wake(PRIVATE, { messages: [msg('3', 'three')] })
  assert.deepEqual(messagesIn(h, 2), ['three'])
})

test('an unexpected failure rejects the callers, ends the wake, and keeps the messages for the next one', async (t) => {
  const h = await withHarness(t)
  h.runner.script.push(() => { throw new Error('boom: 私密内容') })
  const error = await rejection(h.wake(PRIVATE, { messages: [msg('1', 'one')] }))
  assert.equal(error.code, 'INTERNAL')
  assert.ok(!error.message.includes('私密内容'))
  assert.ok(!JSON.stringify(h.logs).includes('私密内容'))
  assert.equal(h.gateway.ended.length, 1)
  await h.wake(PRIVATE, { messages: [msg('2', 'two')] })
  assert.deepEqual(messagesIn(h, 1), ['one', 'two'])
})

test('a recall that fails rejects the callers and keeps the messages', async (t) => {
  const h = await withHarness(t)
  h.state.contextError = new Error('index down')
  assert.equal((await rejection(h.wake(PRIVATE, { messages: [msg('1', 'one')] }))).code, 'INTERNAL')
  assert.equal(h.runner.runs.length, 0)
  h.state.contextError = undefined
  await h.wake(PRIVATE, { messages: [msg('2', 'two')] })
  assert.deepEqual(messagesIn(h, 0), ['one', 'two'])
})

test('after a success the input tokens of the last step, with the cache, are remembered, and the turn is counted', async (t) => {
  const h = await withHarness(t)
  h.runner.script.push(() => turn({ steps: [
    { inputTokens: 5, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 100 },
    { inputTokens: 7, outputTokens: 1, cacheReadTokens: 30, cacheWriteTokens: 4 },
  ] }))
  await h.wake(PRIVATE, { messages: [msg('1', 'hi')] })
  const entry = (await readState(h)).channels[PRIVATE]
  assert.equal(entry?.lastInputTokens, 41)
  assert.equal(entry?.turns, 1)
  assert.equal(entry?.generation, 0)
})

test('a compaction takes the session back to core: resetSession, and the groups are forgotten', async (t) => {
  const h = await withHarness(t)
  const session = encodeSessionId({ agentClass: 'chat', channel: PRIVATE, generation: 0 })
  h.gateway.groups.set(session, ['memory-tools'])
  await h.wake(PRIVATE)
  assert.deepEqual((await readState(h)).channels[PRIVATE]?.activated, ['memory-tools'])
  h.runner.script.push(() => turn({ compacted: true }))
  await h.wake(PRIVATE)
  assert.deepEqual(h.gateway.resets, [session])
  assert.deepEqual((await readState(h)).channels[PRIVATE]?.activated, [])
  assert.equal(decodeSessionId(h.runner.runs[1]?.sessionId ?? '')?.generation, 0, 'the generation does not change')
})

test('the groups the gateway reports are written to the pool after a turn', async (t) => {
  const h = await withHarness(t)
  await h.wake(PRIVATE)
  h.gateway.groups.set(h.runner.runs[0]?.sessionId as string, ['a', 'b'])
  await h.wake(PRIVATE)
  assert.deepEqual((await readState(h)).channels[PRIVATE]?.activated, ['a', 'b'])
})

test('message.in carries the channel, the count and the record ids, and no text; agent.turn the numbers', async (t) => {
  const h = await withHarness(t)
  h.runner.script.push(() => { h.gateway.sent = 1; return turn() })
  const result = await h.wake(PRIVATE, { messages: [msg('l0_a', '私密内容一'), msg('l0_b', '私密内容二')] })
  assert.deepEqual(h.events, [
    { name: 'message.in', payload: { channel: PRIVATE, count: 2, recordIds: ['l0_a', 'l0_b'] } },
    { name: 'agent.turn', payload: { channel: PRIVATE, wakeId: result.wakeId, ok: true, sent: 1, steps: 1, profileVersion: 1 } },
  ])
  assert.ok(!JSON.stringify(h.events).includes('私密内容'))
  await h.wake(PRIVATE, { reason: 'poke' })
  assert.equal(h.events.filter((event) => event.name === 'message.in').length, 1, 'no messages, no message.in')
})

test('a failing metrics sink or event handler does not fail the wake', async (t) => {
  const h = await withHarness(t)
  h.state.metricsError = new Error('disk full')
  const runtime = h.rebuild({ emit: () => { throw new Error('listener bug') } })
  const result = await runtime.wake(PRIVATE, { reason: 'message' })
  assert.equal(result.acked, true)
})

test('metrics: arrival is the earliest wake, first send from the gateway, debounce apart from the latency, steps and retries from the turn', async (t) => {
  const h = await withHarness(t)
  const start = h.clock.now()
  const a = h.wake(PRIVATE, { debounceMs: 400, messages: [msg('1', 'a')] })
  await until(() => h.timers.pending === 1)
  h.clock.advance(150)
  const b = h.wake(PRIVATE, { debounceMs: 400, messages: [msg('2', 'b')] })
  await until(() => h.timers.cleared.length === 1)
  await settle()
  h.clock.advance(400)
  h.runner.script.push(() => { h.gateway.sent = 1; h.clock.advance(250); return turn({ retries: 2, steps: [
    { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }, { inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 8 },
  ] }) })
  h.timers.fireAll()
  await Promise.all([a, b])
  assert.deepEqual(h.metrics, [{
    wakeId: h.metrics[0]?.wakeId, channel: PRIVATE, agentClass: 'chat', profileVersion: 1, arrivedAt: start, firstSendAt: start + 150 + 400 + 250,
    debounceMs: 400, retries: 2, outcome: 'acked',
    steps: [{ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }, { inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 8 }],
  }])
})

test('metrics: a turn that sent nothing has no firstSendAt, and the class and outcome are recorded for activity and interrupted turns', async (t) => {
  const h = await withHarness(t)
  await h.wake(FEED)
  assert.equal('firstSendAt' in (h.metrics[0] ?? {}), false)
  assert.equal(h.metrics[0]?.agentClass, 'activity')
  h.runner.script.push(() => { throw new TurnInterruptedError('crash', 'a') }, () => { throw new TurnInterruptedError('crash', 'b') })
  await h.wake(FEED)
  assert.equal(h.metrics[1]?.outcome, 'interrupted')
  assert.deepEqual(h.metrics[1]?.steps, [])
})

// ---- round 2: forgotten messages, members timeout, stable per class ----

const tombstone = (id: string): never => ({ id, status: 'tombstoned', content: {} }) as never

test('messages put back after an interruption are read again: a forgotten one is neither shown, cited, remembered nor put back', async (t) => {
  const h = await withHarness(t)
  h.runner.script.push(() => { throw new TurnInterruptedError('crash', 'a') }, () => { throw new TurnInterruptedError('crash', 'b') })
  await h.wake(PRIVATE, {
    messages: [msg('l0_1', 'keep me'), msg('l0_2', 'forget me please', { actor: 'mallory', forwarded: true })],
    evidence: ['l0_x', 'l0_gone'],
  })
  h.records$.set('l0_2', tombstone('l0_2'))
  h.records$.set('l0_gone', null)
  await h.wake(PRIVATE, { messages: [msg('l0_3', 'new one')] })
  const shown = textOf(h.runner.runs[2]?.input ?? '')
  assert.deepEqual(messagesIn(h, 2), ['keep me', 'new one'])
  assert.ok(!shown.includes('forget me please'))
  const plan = h.gateway.plans.at(-1)
  assert.deepEqual(plan?.evidence, ['l0_1', 'l0_3', 'l0_x'])
  assert.deepEqual(plan?.peerTexts, ['keep me', 'new one'])
  assert.deepEqual(plan?.participants, ['alice'])
  assert.equal(plan?.features.message.hasForward, false)
  assert.ok(!(h.contexts.at(-1)?.request.query ?? '').includes('forget'))
  assert.deepEqual(h.contexts.at(-1)?.viewer.participants, ['alice'])
  const saved = (await readState(h)).channels[PRIVATE]
  assert.deepEqual(saved?.people, ['alice'])
  assert.deepEqual(saved?.recentEvidence, ['l0_1', 'l0_3', 'l0_x'])
})

test('a message that is forgotten while the turn keeps being interrupted is not put back again', async (t) => {
  const h = await withHarness(t)
  const bad = () => { throw new TurnInterruptedError('crash', 'x') }
  h.runner.script.push(bad, bad, bad, bad)
  await h.wake(PRIVATE, { messages: [msg('l0_1', 'first'), msg('l0_2', 'second')] })
  h.records$.set('l0_1', tombstone('l0_1'))
  await h.wake(PRIVATE, { messages: [msg('l0_3', 'third')] })
  assert.deepEqual(messagesIn(h, 2), ['second', 'third'])
  h.records$.delete('l0_1') // readable again, so only the list that was put back can keep it out
  await h.wake(PRIVATE, { messages: [msg('l0_4', 'fourth')] })
  assert.deepEqual(messagesIn(h, 4), ['second', 'third', 'fourth'], 'the one dropped earlier was not put back')
})

test('messages forgotten during the debounce are all gone when the timer fires: nothing is recalled or run, and the callers are acked', async (t) => {
  const h = await withHarness(t)
  const waiting = h.wake(PRIVATE, { debounceMs: 500, messages: [msg('l0_1', 'gone')], evidence: ['l0_e'] })
  await until(() => h.timers.pending === 1)
  h.records$.set('l0_1', null)
  h.timers.fireAll()
  const result = await waiting
  assert.deepEqual(result, { wakeId: result.wakeId, acked: true, profileVersion: 1, sent: 0, steps: 0 })
  assert.equal(h.runner.runs.length, 0)
  assert.equal(h.contexts.length, 0)
  assert.equal(h.gateway.plans.length, 0)
  assert.equal(h.metrics.length, 1)
  assert.equal(h.metrics[0]?.outcome, 'acked')
  assert.deepEqual(h.metrics[0]?.steps, [])
  assert.deepEqual(h.events.filter((event) => event.name === 'agent.turn'), [], 'no agent.turn')
  assert.equal(h.events.filter((event) => event.name === 'message.in').length, 1, 'the arrival was still announced')
  await settle()
  assert.equal((await readState(h)).channels[PRIVATE]?.turns, 0, 'the turn is not counted')
})

test('when every message is gone but there is a note or a poke, the turn still runs, without messages', async (t) => {
  const h = await withHarness(t)
  h.records$.set('l0_1', null)
  await h.wake(PRIVATE, { messages: [msg('l0_1', 'gone')], note: '提醒一下' })
  assert.equal(h.runner.runs.length, 1)
  assert.ok(!textOf(h.runner.runs[0]?.input ?? '').includes('<messages>'))
  assert.ok(textOf(h.runner.runs[0]?.input ?? '').includes('提醒一下'))
  await h.wake(PRIVATE, { messages: [msg('l0_1', 'gone')], event: 'poke' })
  assert.equal(h.runner.runs.length, 2)
  assert.equal(h.gateway.plans[1]?.features.event.poke, true)
  assert.deepEqual(h.gateway.plans[1]?.evidence, [])
})

test('a wake without messages is not treated as forgotten: it runs as before', async (t) => {
  const h = await withHarness(t)
  const result = await h.wake(PRIVATE)
  assert.equal(h.runner.runs.length, 1)
  assert.equal(result.steps, 1)
})

test('a message whose record cannot be read, or is not active, is left out; the others stay', async (t) => {
  const h = await withHarness(t)
  const rt = h.rebuild({
    readRecord: async (id) => {
      if (id === 'l0_bad') throw new Error('store down')
      if (id === 'l0_ev') throw new Error('store down')
      return { id, status: id === 'l0_odd' ? 'invalid' : 'active', content: {} } as never
    },
  })
  await rt.wake(PRIVATE, {
    reason: 'message',
    messages: [msg('l0_ok', 'fine'), msg('l0_bad', 'unreadable'), msg('l0_odd', 'strange status')],
    evidence: ['l0_ev', 'l0_fine_ev'],
  })
  assert.deepEqual(messagesIn(h, 0), ['fine'])
  assert.deepEqual(h.gateway.plans[0]?.evidence, ['l0_ok', 'l0_fine_ev'])
  assert.ok(!JSON.stringify(h.logs).includes('store down'))
})

test('a message id that two parts of the snapshot share is read once', async (t) => {
  const h = await withHarness(t)
  const reads: string[] = []
  const rt = h.rebuild({ readRecord: async (id) => { reads.push(id); return { id, status: 'active', content: {} } as never } })
  await rt.wake(PRIVATE, { reason: 'message', messages: [msg('l0_1', 'a')], evidence: ['l0_1'] })
  assert.deepEqual(reads, ['l0_1'])
  assert.deepEqual(h.gateway.plans[0]?.evidence, ['l0_1'])
})

test('members that never answer are given up after five seconds: setMembers(null), the turn goes on, a late answer is ignored', async (t) => {
  const h = await withHarness(t)
  let answer!: (people: readonly string[]) => void
  h.providers.set(PRIVATE, {
    send: async () => ({}),
    members: () => new Promise<readonly string[]>((resolve) => { answer = resolve }),
    resolveIdentity: async () => null,
  })
  const waiting = h.wake(PRIVATE, { messages: [msg('l0_1', 'hi')] })
  await until(() => h.timers.pending === 1)
  assert.equal([...h.timers.timers.values()][0]?.ms, 5_000)
  h.timers.advance(4_900)
  await settle()
  assert.deepEqual(h.members, [])
  assert.equal(h.runner.runs.length, 0, 'the turn is still waiting for them')
  h.timers.advance(100)
  const result = await waiting
  assert.equal(result.acked, true)
  assert.deepEqual(h.members, [{ channel: PRIVATE, people: null }])
  assert.equal(h.runner.runs.length, 1)
  assert.ok(h.logs.some((line) => line.event === 'agent-runtime.members_failed'))
  answer(['late'])
  await settle()
  assert.deepEqual(h.members, [{ channel: PRIVATE, people: null }], 'the late answer changes nothing')
})

test('members that fail late, after the timeout, are ignored and raise nothing', async (t) => {
  const h = await withHarness(t)
  let fail!: (error: Error) => void
  h.providers.set(PRIVATE, {
    send: async () => ({}),
    members: () => new Promise<readonly string[]>((_resolve, reject) => { fail = reject }),
    resolveIdentity: async () => null,
  })
  const waiting = h.wake(PRIVATE)
  await until(() => h.timers.pending === 1)
  h.timers.advance(5_000)
  await waiting
  fail(new Error('too late'))
  await settle()
  assert.equal(h.members.length, 1)
  assert.equal(h.logs.filter((line) => line.event === 'agent-runtime.members_failed').length, 1)
})

test('members that answer in time stop the timer, so it never reports a failure afterwards', async (t) => {
  const h = await withHarness(t)
  h.providers.set(PRIVATE, { send: async () => ({}), members: async () => ['alice'], resolveIdentity: async () => null })
  await h.wake(PRIVATE)
  assert.equal(h.timers.pending, 0, 'the timer was cleared')
  h.timers.advance(60_000)
  await settle()
  assert.deepEqual(h.members, [{ channel: PRIVATE, people: ['alice'] }])
  assert.ok(!h.logs.some((line) => line.event === 'agent-runtime.members_failed'))
})

test('members that fail at once clear the timer too', async (t) => {
  const h = await withHarness(t)
  h.providers.set(PRIVATE, { send: async () => ({}), members: async () => { throw new Error('offline') }, resolveIdentity: async () => null })
  await h.wake(PRIVATE)
  assert.equal(h.timers.pending, 0)
  assert.deepEqual(h.members, [{ channel: PRIVATE, people: null }])
})

test('a hung members call holds only its own channel: another channel runs meanwhile', async (t) => {
  const h = await withHarness(t)
  h.providers.set(PRIVATE, { send: async () => ({}), members: () => new Promise<readonly string[]>(() => undefined), resolveIdentity: async () => null })
  const stuck = h.wake(PRIVATE)
  await until(() => h.timers.pending === 1)
  await h.wake(FEED)
  assert.equal(h.runner.runs.length, 1)
  h.timers.advance(5_000)
  await stuck
  assert.equal(h.runner.runs.length, 2)
})

test('stable is remembered per class, not per channel: a second chat channel sees the change; the first activity turn does not invalidate', async (t) => {
  const h = await withHarness(t)
  h.state.bundle = bundleOf({ stable: 'STABLE-A' })
  await h.wake(PRIVATE)
  h.state.bundle = bundleOf({ stable: 'STABLE-B' })
  await h.wake(GROUP)
  assert.deepEqual(h.runner.invalidated, ['chat'], 'the group channel is chat too, and the stable changed since the private one')
  h.state.bundle = bundleOf({ stable: 'STABLE-C' })
  await h.wake(FEED)
  assert.deepEqual(h.runner.invalidated, ['chat'], 'activity had never run, so nothing to invalidate')
})

test('WakeMessage.hasMedia sets features.message.hasMedia and exposes message.hasMedia context tools without pre-attaching images', async (t) => {
  const h = await withHarness(t)
  const realGateway = createToolGateway({
    memory: h.deps.memory,
    audit: { sent: async () => undefined },
    clock: h.clock,
    log: h.deps.log,
    ownerChannels: () => new Set(),
    style: () => ({ enabled: false, openers: [] }),
  })
  realGateway.register({
    pluginId: 'qq',
    manifest: {
      name: 'get_message_images',
      effect: 'read',
      load: 'context',
      group: 'media',
      when: 'message.hasMedia',
      summary: '获取图片',
    },
    description: '获取消息中的图片',
    parameters: { type: 'object', properties: {} },
    channels: ['qq:*'],
    invoke: async () => 'ok',
  })

  const runtime = h.rebuild({ gateway: realGateway })
  let surfaceDuringMediaTurn: ReadonlySet<string> | undefined
  let surfaceDuringPlainTurn: ReadonlySet<string> | undefined

  // 1. hasMedia: false -> false, context tool NOT exposed
  h.runner.script.push((call) => {
    surfaceDuringPlainTurn = realGateway.surfaceOf(call.sessionId)
    return turn()
  })
  await runtime.wake(PRIVATE, { reason: 'message', messages: [msg('m1', 'just text', { hasMedia: false })] })
  assert.equal(surfaceDuringPlainTurn?.has('qq__get_message_images'), false)

  // 2. hasMedia omitted and no images -> false
  await h.wake(PRIVATE, { messages: [msg('m2', 'plain text')] })
  assert.equal(h.gateway.plans[0]?.features.message.hasMedia, false)

  // 3. images: [...] without hasMedia -> true
  await h.wake(PRIVATE, { messages: [msg('m3', 'with image', { images: [{ mediaType: 'image/png', base64: 'AAAA' }] })] })
  assert.equal(h.gateway.plans[1]?.features.message.hasMedia, true)

  // 4. hasMedia: true without images -> true AND context tool IS exposed in planWake
  h.runner.script.push((call) => {
    surfaceDuringMediaTurn = realGateway.surfaceOf(call.sessionId)
    return turn()
  })
  await runtime.wake(PRIVATE, { reason: 'message', messages: [msg('m4', '[图片#1]', { hasMedia: true })] })
  assert.equal(surfaceDuringMediaTurn?.has('qq__get_message_images'), true)

  await h.wake(PRIVATE, { messages: [msg('m5', '[图片#2]', { hasMedia: true })] })
  assert.equal(h.gateway.plans[2]?.features.message.hasMedia, true)
})
