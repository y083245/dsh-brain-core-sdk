import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { decodeSessionId, encodeSessionId } from '@brain-core/satellite-host'
import { HANDOFF_PROMPT } from '../../src/agent-runtime/index.ts'
import { FEED, GROUP, PRIVATE, harness, msg, textOf, turn } from './helpers.ts'
import type { Harness } from './helpers.ts'

const DAY = 24 * 3_600_000

async function withHarness(t: { after(fn: () => Promise<void>): void }, options?: Parameters<typeof harness>[0]): Promise<Harness> {
  const h = await harness(options)
  t.after(() => h.cleanup())
  return h
}

async function readState(h: Harness): Promise<{ version: number; channels: Record<string, Record<string, unknown>> }> {
  return JSON.parse(await readFile(h.stateFile, 'utf8')) as { version: number; channels: Record<string, Record<string, unknown>> }
}

async function plant(h: Harness, content: string): Promise<void> {
  await mkdir(path.dirname(h.stateFile), { recursive: true })
  await writeFile(h.stateFile, content)
}

const entry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  generation: 3, startedDay: '2026-11-09', activated: ['calendar'], lastInputTokens: 1234, turns: 7,
  lastInboundAt: 1000, lastOutboundAt: 2000, lastProactiveAt: 1500, people: ['bob', 'alice'], recentEvidence: ['l0_a', 'l0_b'], handoff: 'l1_h',
  ...overrides,
})

test('after a turn the pool on disk has every field of the channel', async (t) => {
  const h = await withHarness(t)
  h.runner.script.push(() => { h.gateway.sent = 1; return turn({ steps: [{ inputTokens: 3, outputTokens: 1, cacheReadTokens: 4, cacheWriteTokens: 5 }] }) })
  h.gateway.groups.set(encodeSessionId({ agentClass: 'chat', channel: PRIVATE, generation: 0 }), [])
  await h.wake(PRIVATE, { messages: [msg('l0_1', 'a', { actor: 'alice' }), msg('l0_2', 'b', { actor: 'bob' })], evidence: ['l0_x'] })
  const state = await readState(h)
  assert.equal(state.version, 1)
  assert.deepEqual(state.channels[PRIVATE], {
    generation: 0, startedDay: '2026-11-09', activated: [], lastInputTokens: 12, turns: 1,
    lastInboundAt: h.clock.now(), lastOutboundAt: h.clock.now(),
    people: ['bob', 'alice'], recentEvidence: ['l0_1', 'l0_2', 'l0_x'],
  })
})

test('people keep the newest 32, recent evidence the newest 20', async (t) => {
  const h = await withHarness(t)
  for (let i = 0; i < 5; i += 1) {
    await h.wake(PRIVATE, { messages: Array.from({ length: 10 }, (_, j) => msg(`l0_${i}_${j}`, 't', { actor: `p${i}_${j}` })) })
  }
  const state = (await readState(h)).channels[PRIVATE]
  const people = state?.people as string[]
  const evidence = state?.recentEvidence as string[]
  assert.equal(people.length, 32)
  assert.equal(people[0], 'p4_9')
  assert.equal(people[31], 'p1_8')
  assert.equal(evidence.length, 20)
  assert.equal(evidence[19], 'l0_4_9')
  assert.equal(evidence[0], 'l0_3_0')
})

test('a new runtime over the same file continues the session: generation, groups, times, people', async (t) => {
  const h = await withHarness(t)
  await plant(h, JSON.stringify({ version: 1, channels: { [PRIVATE]: entry(), [FEED]: entry({ generation: 0, activated: [] }) } }))
  h.records$.set('l1_h', { id: 'l1_h', status: 'active', content: { text: '聊到了猫' } } as never)
  const rt = h.rebuild()
  await rt.rotate('qq:private:nobody')
  const group = (id: string) => decodeSessionId(id)
  assert.deepEqual(h.gateway.restored.map((r) => [group(r.sessionId), r.groups]), [
    [{ agentClass: 'chat', channel: PRIVATE, generation: 3 }, ['calendar']],
    [{ agentClass: 'activity', channel: FEED, generation: 0 }, []],
  ])
  await rt.wake(PRIVATE, { reason: 'message', messages: [msg('l0_c', 'x', { actor: 'carol' })] })
  assert.equal(h.runner.runs[0]?.sessionId, encodeSessionId({ agentClass: 'chat', channel: PRIVATE, generation: 3 }))
  assert.deepEqual(h.gateway.plans[0]?.participants, ['carol', 'bob', 'alice'])
  assert.ok(textOf(h.runner.runs[0]?.input ?? '').includes('<handoff>'), 'the unread handoff is still waiting')
  const saved = (await readState(h)).channels[PRIVATE]
  assert.equal(saved?.generation, 3)
  assert.equal(saved?.turns, 8)
  assert.equal(saved?.lastProactiveAt, 1500)
  assert.equal(saved?.lastOutboundAt, 2000)
  assert.deepEqual(saved?.recentEvidence, ['l0_a', 'l0_b', 'l0_c'])
})

test('a rotation after a restart writes its handoff from the evidence that was saved', async (t) => {
  const h = await withHarness(t)
  await plant(h, JSON.stringify({ version: 1, channels: { [PRIVATE]: entry({ startedDay: '2026-11-08', handoff: undefined }) } }))
  const rt = h.rebuild()
  h.runner.script.push(() => turn({ finalResponse: '聊到了猫' }))
  await rt.wake(PRIVATE, { reason: 'message', messages: [msg('l0_n', 'x')] })
  assert.equal(h.runner.runs[0]?.input, HANDOFF_PROMPT)
  assert.deepEqual(h.records[0]?.input.evidence, [{ id: 'l0_a' }, { id: 'l0_b' }])
  assert.deepEqual(h.records[0]?.input.subjects, ['bob', 'alice'])
  assert.equal(decodeSessionId(h.runner.runs[1]?.sessionId ?? '')?.generation, 4)
})

for (const [name, content] of [
  ['text that is not JSON', '{"channels": {'],
  ['an empty file', ''],
  ['an array', '[]'],
  ['no channels', '{"version":1}'],
  ['channels that is not an object', '{"channels":[1,2]}'],
  ['null', 'null'],
] as const) {
  test(`a damaged pool file (${name}) is an empty pool, and the next write replaces it`, async (t) => {
    const h = await withHarness(t)
    await plant(h, content)
    const rt = h.rebuild()
    await rt.rotate('qq:private:nobody')
    assert.deepEqual(h.gateway.restored, [])
    const result = await rt.wake(PRIVATE, { reason: 'message', messages: [msg('l0_1', 'a')] })
    assert.equal(result.acked, true)
    assert.equal(decodeSessionId(h.runner.runs[0]?.sessionId ?? '')?.generation, 0)
    assert.equal((await readState(h)).channels[PRIVATE]?.generation, 0)
  })
}

test('a missing file is an empty pool', async (t) => {
  const h = await withHarness(t)
  assert.equal((await h.wake(PRIVATE)).acked, true)
})

test('what is dropped on reading is gone from the file after the next write', async (t) => {
  const h = await withHarness(t)
  await plant(h, JSON.stringify({ version: 1, channels: { [PRIVATE]: entry(), 'not a channel': entry(), 'qq:private:b': entry({ generation: 1.5 }), 'qq:private:c': entry({ generation: 1_000_000 }) } }))
  const rt = h.rebuild()
  await rt.wake(PRIVATE, { reason: 'message' })
  assert.deepEqual(Object.keys((await readState(h)).channels), [PRIVATE])
})

test('a pool file with more than 32 people is cut to 32 when it is read', async (t) => {
  const h = await withHarness(t)
  const crowd = Array.from({ length: 40 }, (_, i) => `p${i}`)
  await plant(h, JSON.stringify({ version: 1, channels: { [PRIVATE]: entry({ startedDay: '2026-11-08', people: crowd, handoff: undefined }) } }))
  h.runner.script.push(() => turn({ finalResponse: '聊到了猫' }))
  await h.rebuild().wake(PRIVATE, { reason: 'message', messages: [msg('l0_n', 'x')] })
  assert.deepEqual(h.records[0]?.input.subjects, crowd.slice(0, 32))
})

test('self is never remembered as a person, and evidence is not remembered twice', async (t) => {
  const h = await withHarness(t)
  await h.wake(PRIVATE, { messages: [msg('l0_1', 'a', { actor: 'self' }), msg('l0_2', 'b', { actor: 'alice' })], evidence: ['l0_1'] })
  await h.wake(PRIVATE, { messages: [msg('l0_3', 'c', { actor: 'alice' })], evidence: ['l0_1', 'l0_2'] })
  const state = (await readState(h)).channels[PRIVATE]
  assert.deepEqual(state?.people, ['alice'])
  assert.deepEqual(state?.recentEvidence, ['l0_3', 'l0_1', 'l0_2'])
})

test('one damaged entry is dropped and the others are kept; bad fields fall back', async (t) => {
  const h = await withHarness(t)
  await plant(h, JSON.stringify({ version: 1, channels: {
    [PRIVATE]: entry(),
    [GROUP]: entry({ generation: -1 }),
    'qq:private:b': entry({ generation: 1.5 }),
    'qq:private:c': entry({ startedDay: 'yesterday' }),
    'qq:private:d': 'text',
    'qq:private:e': entry({ generation: 1_000_000 }),
    'not a channel': entry(),
    'qq:private:f': entry({ activated: 'calendar', lastInputTokens: 'many', turns: -2, people: [1, 'ok'], recentEvidence: null, handoff: 5, lastInboundAt: 'now' }),
  } }))
  const rt = h.rebuild()
  await rt.rotate('qq:private:nobody')
  const kept = h.gateway.restored.map((r) => decodeSessionId(r.sessionId)?.channel)
  assert.deepEqual(kept, [PRIVATE, 'qq:private:f'])
  await rt.wake('qq:private:f', { reason: 'message' })
  const saved = (await readState(h)).channels['qq:private:f']
  assert.deepEqual(saved?.activated, [])
  assert.equal(saved?.lastInputTokens, 10)
  assert.equal(saved?.turns, 1)
  assert.deepEqual(saved?.people, ['ok'])
  assert.equal(saved?.handoff, undefined)
  assert.equal(saved?.lastInboundAt, undefined)
})

test('the pool is written under the state directory, which is created when missing, and close writes the last changes', async (t) => {
  const h = await withHarness(t)
  await h.wake(PRIVATE, { messages: [msg('l0_1', 'a')] })
  assert.ok((await readFile(h.stateFile, 'utf8')).endsWith('\n'))
  h.runner.script.push(() => turn())
  await h.runtime.close()
  assert.equal((await readState(h)).channels[PRIVATE]?.turns, 1)
})

test('a pool file that cannot be written is logged and the wake still works', async (t) => {
  const h = await withHarness(t)
  await mkdir(h.stateFile, { recursive: true })
  const result = await h.wake(PRIVATE, { messages: [msg('l0_1', 'a')] })
  assert.equal(result.acked, true)
  assert.ok(h.logs.some((line) => line.event === 'agent-runtime.state_write_failed'))
  assert.ok(!JSON.stringify(h.logs).includes(h.dir))
})

test('the first wake of a day on a restored session rotates it, with the day taken from the file', async (t) => {
  const h = await withHarness(t)
  await plant(h, JSON.stringify({ version: 1, channels: { [PRIVATE]: entry({ startedDay: '2026-11-09', turns: 1 }) } }))
  h.clock.advance(DAY)
  const rt = h.rebuild()
  await rt.wake(PRIVATE, { reason: 'message', messages: [msg('l0_1', 'a')] })
  assert.equal(decodeSessionId(h.runner.runs.at(-1)?.sessionId ?? '')?.generation, 4)
})

// ---- round 2: a forgetting that was waiting for a turn when the kernel stopped ----

test('an entry marked rotatePending is rotated at start: old session purged, next generation, no handoff, nothing carried', async (t) => {
  const h = await withHarness(t)
  await plant(h, JSON.stringify({ version: 1, channels: { [PRIVATE]: entry({ rotatePending: true }), [FEED]: entry({ generation: 1 }) } }))
  const rt = h.rebuild()
  await rt.rotate('qq:private:nobody')
  const old = encodeSessionId({ agentClass: 'chat', channel: PRIVATE, generation: 3 })
  assert.deepEqual(h.runner.purged, [[old]], 'before any wake, and only the marked channel')
  assert.deepEqual(h.gateway.restored.map((r) => [decodeSessionId(r.sessionId), r.groups]), [
    [{ agentClass: 'chat', channel: PRIVATE, generation: 4 }, []],
    [{ agentClass: 'activity', channel: FEED, generation: 1 }, ['calendar']],
  ])
  await rt.wake(PRIVATE, { reason: 'message', messages: [msg('l0_n', 'hello')] })
  assert.equal(decodeSessionId(h.runner.runs[0]?.sessionId ?? '')?.generation, 4)
  assert.equal(h.runner.runs.length, 1, 'no handoff turn')
  assert.equal(h.records.length, 0)
  const saved = (await readState(h)).channels[PRIVATE]
  assert.equal(saved?.generation, 4)
  assert.equal(saved?.startedDay, '2026-11-09', 'today, which the test clock says is the 9th')
  assert.equal(saved?.turns, 1)
  assert.deepEqual(saved?.activated, [])
  assert.deepEqual(saved?.recentEvidence, ['l0_n'])
  assert.equal('rotatePending' in (saved ?? {}), false)
  const other = (await readState(h)).channels[FEED]
  assert.equal(other?.generation, 1)
})

test('the start-up rotation is on disk before the first wake, and its start day is today', async (t) => {
  const h = await withHarness(t)
  await plant(h, JSON.stringify({ version: 1, channels: { [PRIVATE]: entry({ rotatePending: true, startedDay: '2026-01-01', turns: 9, lastInputTokens: 99 }) } }))
  const rt = h.rebuild()
  await rt.rotate('qq:private:nobody')
  const saved = (await readState(h)).channels[PRIVATE]
  assert.equal(saved?.generation, 4)
  assert.equal(saved?.startedDay, '2026-11-09')
  assert.equal(saved?.turns, 0)
  assert.equal(saved?.lastInputTokens, 0)
  assert.deepEqual(saved?.recentEvidence, [])
  assert.equal('rotatePending' in (saved ?? {}), false)
})

test('a purge that fails at start-up is only logged; the channel still moves on', async (t) => {
  const h = await withHarness(t)
  await plant(h, JSON.stringify({ version: 1, channels: { [PRIVATE]: entry({ rotatePending: true }) } }))
  h.runner.purgeError = new Error('disk')
  const rt = h.rebuild()
  await rt.rotate('qq:private:nobody')
  assert.equal((await readState(h)).channels[PRIVATE]?.generation, 4)
  assert.ok(h.logs.some((line) => line.event === 'agent-runtime.purge_failed'))
})

test('start-up rotation falls back to the system zone when the settings cannot be read', async (t) => {
  const h = await withHarness(t)
  await plant(h, JSON.stringify({ version: 1, channels: { [PRIVATE]: entry({ rotatePending: true }) } }))
  const rt = h.rebuild({ settings: async () => { throw new Error('settings down') } })
  await rt.rotate('qq:private:nobody')
  const saved = (await readState(h)).channels[PRIVATE]
  assert.equal(saved?.generation, 4)
  assert.match(String(saved?.startedDay), /^\d{4}-\d{2}-\d{2}$/)
})

test('only rotatePending: true counts; false, a string or a number are ignored', async (t) => {
  for (const mark of [false, 'true', 1, null]) {
    const h = await withHarness(t)
    await plant(h, JSON.stringify({ version: 1, channels: { [PRIVATE]: entry({ rotatePending: mark }) } }))
    const rt = h.rebuild()
    await rt.rotate('qq:private:nobody')
    assert.deepEqual(h.runner.purged, [], `${JSON.stringify(mark)} does not rotate`)
    assert.equal(h.gateway.restored[0]?.sessionId, encodeSessionId({ agentClass: 'chat', channel: PRIVATE, generation: 3 }))
  }
})
