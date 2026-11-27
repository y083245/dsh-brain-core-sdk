import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { TurnInterruptedError, decodeSessionId, encodeSessionId } from '@dsh-brain-core/satellite-host'
import type { MemoryRecord } from '@dsh-brain-core/sdk'
import { HANDOFF_PROMPT } from '../../src/agent-runtime/index.ts'
import { FEED, GROUP, PRIVATE, harness, msg, settle, stateWhen, textOf, turn, until } from './helpers.ts'
import type { Harness } from './helpers.ts'

const DAY = 24 * 3_600_000

async function withHarness(t: { after(fn: () => Promise<void>): void }, options?: Parameters<typeof harness>[0]): Promise<Harness> {
  const h = await harness(options)
  t.after(() => h.cleanup())
  return h
}

async function readState(h: Harness): Promise<{ channels: Record<string, Record<string, unknown>> }> {
  return JSON.parse(await readFile(h.stateFile, 'utf8')) as { channels: Record<string, Record<string, unknown>> }
}

function generationOf(sessionId: string | undefined): number | undefined {
  return decodeSessionId(sessionId ?? '')?.generation
}

/** One turn on day one, so the channel has a session, people and evidence. */
async function firstDay(h: Harness, channel = PRIVATE): Promise<string> {
  await h.wake(channel, { messages: [msg('l0_1', '昨天的话', { actor: 'alice' })] })
  return h.runner.runs[0]?.sessionId as string
}

test('the first wake after midnight in the owner time zone writes a handoff, then moves to the next generation', async (t) => {
  const h = await withHarness(t)
  const old = await firstDay(h)
  h.runner.script.push(() => turn({ finalResponse: '  聊到周末去海边，还没定时间。  ' }))
  h.clock.advance(DAY)
  const result = await h.wake(PRIVATE, { messages: [msg('l0_2', '早')] })
  assert.equal(result.acked, true)
  assert.deepEqual(h.runner.runs.map((run) => [run.sessionId === old, run.input === HANDOFF_PROMPT]), [[true, false], [true, true], [false, false]])
  assert.deepEqual(h.runner.runs[1]?.options, { timeoutMs: 60_000 })
  assert.equal(h.runner.runs[1]?.agentClass, 'chat')
  assert.equal(generationOf(h.runner.runs[2]?.sessionId), 1)
  assert.deepEqual(h.runner.purged, [[old]])
  assert.deepEqual(h.gateway.resets, [old])
  const entry = (await readState(h)).channels[PRIVATE]
  assert.equal(entry?.generation, 1)
  assert.equal(entry?.startedDay, '2026-11-10')
  assert.equal(entry?.turns, 1, 'the new session has had one turn')
})

test('the day is the owner time zone’s day, not UTC’s', async (t) => {
  const h = await withHarness(t, { start: Date.UTC(2026, 10, 9, 15, 30), settings: { agents: { chat: { provider: 'p', model: 'm', effort: 'high' } }, timezone: 'Asia/Shanghai' } })
  await firstDay(h)
  h.clock.advance(3_600_000)
  await h.wake(PRIVATE, { messages: [msg('l0_2', 'x')] })
  assert.equal(generationOf(h.runner.runs.at(-1)?.sessionId), 1, 'it is already the next day in Shanghai')

  const g = await withHarness(t, { start: Date.UTC(2026, 10, 9, 23, 30), settings: { agents: { chat: { provider: 'p', model: 'm', effort: 'high' } }, timezone: 'Asia/Shanghai' } })
  await firstDay(g)
  g.clock.advance(3_600_000)
  await g.wake(PRIVATE, { messages: [msg('l0_2', 'x')] })
  assert.equal(generationOf(g.runner.runs.at(-1)?.sessionId), 0, 'midnight in UTC is the same day in Shanghai')
  assert.equal(g.runner.runs.length, 2)
})

test('the day follows the configured zone even when the machine is in another one', async (t) => {
  const h = await withHarness(t, { start: Date.UTC(2026, 10, 10, 7, 30), settings: { agents: { chat: { provider: 'p', model: 'm', effort: 'high' } }, timezone: 'America/Los_Angeles' } })
  await firstDay(h)
  h.clock.advance(3_600_000)
  await h.wake(PRIVATE, { messages: [msg('l0_2', 'x')] })
  assert.equal(generationOf(h.runner.runs.at(-1)?.sessionId), 1, '00:30 in Los Angeles is the next day there')
  assert.equal((await readState(h)).channels[PRIVATE]?.startedDay, '2026-11-10')
})

test('the same day never rotates, and a channel that has had no turn only has its day moved', async (t) => {
  const h = await withHarness(t)
  await firstDay(h)
  h.clock.advance(3_600_000)
  await h.wake(PRIVATE)
  assert.equal(h.runner.runs.length, 2)
  assert.deepEqual(h.runner.purged, [])

  const g = await withHarness(t, { profileVersion: 0 })
  await g.wake(PRIVATE, { messages: [msg('l0_1', 'x')] }).catch(() => undefined)
  g.profiles.set({ version: 1, stable: 'S' })
  g.clock.advance(2 * DAY)
  await g.wake(PRIVATE, { messages: [msg('l0_2', 'y')] })
  assert.equal(generationOf(g.runner.runs[0]?.sessionId), 0)
  assert.equal(g.runner.runs.length, 1, 'no handoff run and no new session for a session that never ran')
  assert.equal((await readState(g)).channels[PRIVATE]?.startedDay, '2026-11-11')
})

test('over the input token limit the next wake rotates with a handoff; the limit itself does not', async (t) => {
  const h = await withHarness(t)
  h.runner.script.push(() => turn({ steps: [{ inputTokens: 100_000, outputTokens: 1, cacheReadTokens: 50_000, cacheWriteTokens: 50_000 }] }))
  await firstDay(h)
  await h.wake(PRIVATE, { messages: [msg('l0_2', 'x')] })
  assert.equal(h.runner.runs.length, 2, 'exactly 200,000 is not over')
  h.runner.script.push(() => turn({ steps: [{ inputTokens: 1, outputTokens: 1, cacheReadTokens: 100_000, cacheWriteTokens: 100_000 }] }))
  await h.wake(PRIVATE, { messages: [msg('l0_3', 'y')] })
  assert.equal(h.runner.runs.length, 3)
  await h.wake(PRIVATE, { messages: [msg('l0_4', 'z')] })
  assert.equal(h.runner.runs.length, 5, 'a handoff turn and the new session’s turn')
  assert.equal(h.runner.runs[3]?.input, HANDOFF_PROMPT)
  assert.equal(generationOf(h.runner.runs[4]?.sessionId), 1)
  assert.equal((await readState(h)).channels[PRIVATE]?.lastInputTokens, 10)
})

test('the token limit can be set', async (t) => {
  const h = await withHarness(t, { rotateInputTokens: 50 })
  h.runner.script.push(() => turn({ steps: [{ inputTokens: 51, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }] }))
  await firstDay(h)
  await h.wake(PRIVATE, { messages: [msg('l0_2', 'x')] })
  assert.equal(h.runner.runs.length, 3)
})

test('the handoff is a l1.topic with the recent evidence, origin disclosure and an idempotency key, written as the agent', async (t) => {
  const h = await withHarness(t)
  const old = await firstDay(h)
  await h.wake(PRIVATE, { messages: [msg('l0_2', 'b', { actor: 'bob' })], evidence: ['l0_extra'] })
  h.runner.script.push(() => turn({ finalResponse: '聊到海边' }))
  h.clock.advance(DAY)
  await h.wake(PRIVATE, { reason: 'poke' })
  assert.deepEqual(h.records, [{
    input: {
      layer: 'L1', kind: 'l1.topic', channel: PRIVATE, subjects: ['bob', 'alice'], actor: 'self', content: { text: '聊到海边', state: 'open' },
      evidence: [{ id: 'l0_1' }, { id: 'l0_2' }, { id: 'l0_extra' }], visibility: 'origin', idempotencyKey: `handoff:${old}`,
    },
    identity: { kind: 'kernel', source: 'agent', trust: 'self', defaultVisibility: 'subject' },
  }])
  const plan = h.gateway.plans.find((entry) => entry.sessionId === old && entry.silent)
  assert.ok(plan, 'the handoff turn is planned as silent on the old session')
  assert.deepEqual(plan?.evidence, ['l0_1', 'l0_2', 'l0_extra'])
  assert.deepEqual(plan?.participants, ['bob', 'alice'])
  assert.deepEqual(plan?.peerTexts, [])
  assert.equal(h.gateway.ended.filter((id) => id === old).length, 3, 'two ordinary turns and the handoff')
})

test('the handoff of a group channel is open by default, of a feed uses the activity process, and with nobody it is about self', async (t) => {
  const h = await withHarness(t)
  await h.wake(GROUP, { evidence: ['l0_g'] })
  h.runner.script.push(() => turn({ finalResponse: '群里聊到了装修' }))
  h.clock.advance(DAY)
  await h.wake(GROUP, { reason: 'poke' })
  assert.equal(h.records[0]?.identity.defaultVisibility, 'open')
  assert.deepEqual(h.records[0]?.input.subjects, ['self'])
  await h.wake(FEED, { evidence: ['l0_f'] })
  h.runner.script.push(() => turn({ finalResponse: '订阅里有新文章' }))
  h.clock.advance(DAY)
  await h.wake(FEED, { reason: 'poke' })
  const feedHandoff = h.runner.runs.find((run) => run.input === HANDOFF_PROMPT && run.agentClass === 'activity')
  assert.ok(feedHandoff)
  assert.equal(h.records.length, 2)
})

test('the handoff text is trimmed and kept to 600 characters', async (t) => {
  const h = await withHarness(t)
  await firstDay(h)
  h.runner.script.push(() => turn({ finalResponse: `\n ${'长'.repeat(700)} \n` }))
  h.clock.advance(DAY)
  await h.wake(PRIVATE, { reason: 'poke' })
  const text = (h.records[0]?.input.content as { text: string }).text
  assert.equal(Array.from(text).length, 600)
  assert.ok(!text.includes(' '))
  const g = await withHarness(t)
  await firstDay(g)
  g.runner.script.push(() => turn({ finalResponse: '😀'.repeat(601) }))
  g.clock.advance(DAY)
  await g.wake(PRIVATE, { reason: 'poke' })
  assert.equal(Array.from((g.records[0]?.input.content as { text: string }).text).length, 600)
})

test('a handoff that cannot be written is skipped and the rotation goes on: timeout, empty reply, no evidence, a failing record, a failing plan', async (t) => {
  const cases: { name: string; arrange: (h: Harness) => void; evidence?: boolean; expectRun?: boolean }[] = [
    { name: 'timeout', arrange: (h) => { h.runner.script.push(() => { throw new TurnInterruptedError('timeout', 'slow') }) } },
    { name: 'empty reply', arrange: (h) => { h.runner.script.push(() => turn({ finalResponse: '   \n' })) } },
    { name: 'no evidence', arrange: () => undefined, evidence: false, expectRun: false },
    { name: 'record fails', arrange: (h) => { h.runner.script.push(() => turn({ finalResponse: '聊到' })); h.state.recordError = new Error('disk') } },
    {
      name: 'plan fails',
      arrange: (h) => {
        const original = h.gateway.planWake.bind(h.gateway)
        h.gateway.planWake = (plan) => { if (plan.silent) throw new Error('plan'); return original(plan) }
      },
      expectRun: false,
    },
  ]
  for (const item of cases) {
    const h = await withHarness(t)
    if (item.evidence === false) await h.wake(PRIVATE, { reason: 'poke' })
    else await firstDay(h)
    const runsBefore = h.runner.runs.length
    h.clock.advance(DAY)
    item.arrange(h)
    const result = await h.wake(PRIVATE, { messages: [msg('l0_9', 'morning')] })
    assert.equal(result.acked, true, item.name)
    const ran = h.runner.runs.slice(runsBefore).some((run) => run.input === HANDOFF_PROMPT)
    assert.equal(ran, item.expectRun ?? true, item.name)
    assert.equal(h.records.filter((record) => record.input.kind === 'l1.topic').length, item.name === 'record fails' ? 1 : 0, item.name)
    assert.equal(generationOf(h.runner.runs.at(-1)?.sessionId), 1, `${item.name}: still rotated`)
    assert.equal(h.runner.purged.length, 1, item.name)
    assert.ok(h.logs.every((line) => line.level !== 'error'), item.name)
    assert.equal(h.gateway.ended.length, h.gateway.plans.length, `${item.name}: every plan was ended`)
    const next = await h.wake(PRIVATE, { messages: [msg('l0_10', 'again')] })
    assert.equal(next.acked, true)
    assert.ok(!textOf(h.runner.runs.at(-1)?.input ?? '').includes('<handoff>'), `${item.name}: nothing to carry`)
  }
})

test('the new session carries the handoff on its first wake, and not on the second', async (t) => {
  const h = await withHarness(t)
  await firstDay(h)
  h.runner.script.push(() => turn({ finalResponse: '聊到海边，还没定时间' }))
  h.clock.advance(DAY)
  await h.wake(PRIVATE, { messages: [msg('l0_2', 'a')] })
  const first = textOf(h.runner.runs.at(-1)?.input ?? '')
  assert.ok(first.includes('<handoff>{"text":"聊到海边，还没定时间"}</handoff>'))
  assert.equal((await readState(h)).channels[PRIVATE]?.handoff, undefined)
  await h.wake(PRIVATE, { messages: [msg('l0_3', 'b')] })
  assert.ok(!textOf(h.runner.runs.at(-1)?.input ?? '').includes('<handoff>'))
})

test('a handoff whose record was forgotten, or is no longer active, or has no text, is left out', async (t) => {
  for (const change of [
    (h: Harness) => { h.records$.set('l1_handoff1', null) },
    (h: Harness) => { h.records$.set('l1_handoff1', { ...(h.records$.get('l1_handoff1') as MemoryRecord), status: 'tombstoned' }) },
    (h: Harness) => { h.records$.set('l1_handoff1', { ...(h.records$.get('l1_handoff1') as MemoryRecord), status: 'invalid' as never }) },
    (h: Harness) => { h.records$.set('l1_handoff1', { ...(h.records$.get('l1_handoff1') as MemoryRecord), content: { text: 5 } }) },
  ]) {
    const h = await withHarness(t)
    await firstDay(h)
    h.runner.script.push(() => turn({ finalResponse: '聊到海边' }))
    h.clock.advance(DAY)
    // the record is written during this wake, then forgotten before the model sees it: simulate with the read hook
    const runtime = h.rebuild({ readRecord: async (id) => { change(h); return h.records$.get(id) ?? null } })
    await runtime.wake(PRIVATE, { reason: 'message', messages: [msg('l0_2', 'a')] })
    assert.ok(!textOf(h.runner.runs.at(-1)?.input ?? '').includes('<handoff>'))
  }
})

test('a forgotten channel rotates at once when idle, without a handoff, and forgets what was sent', async (t) => {
  const h = await withHarness(t)
  h.runner.script.push(() => turn({ steps: [{ inputTokens: 500, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }] }))
  const old = await firstDay(h)
  assert.equal((await readState(h)).channels[PRIVATE]?.lastInputTokens, 500)
  await h.runtime.forgotten([PRIVATE, 'qq:private:never-seen'])
  assert.deepEqual(h.gateway.forgotten, [[PRIVATE, 'qq:private:never-seen']])
  assert.deepEqual(h.gateway.resets, [old], 'the channel that has no session is only forgetSent')
  assert.deepEqual(h.runner.purged, [[old]])
  assert.equal(h.runner.runs.length, 1, 'no handoff turn')
  assert.equal(h.records.length, 0)
  assert.equal((await readState(h)).channels[PRIVATE]?.generation, 1)
  assert.equal((await readState(h)).channels[PRIVATE]?.turns, 0)
  assert.equal((await readState(h)).channels[PRIVATE]?.lastInputTokens, 0)
  assert.equal((await readState(h)).channels['qq:private:never-seen'], undefined)
  assert.deepEqual(h.runner.purged, [[old]], 'the channel without a session was not purged')
  await h.wake(PRIVATE, { messages: [msg('l0_2', 'x')] })
  assert.equal(generationOf(h.runner.runs.at(-1)?.sessionId), 1)
  assert.ok(!textOf(h.runner.runs.at(-1)?.input ?? '').includes('<handoff>'))
})

test('forgetting while a turn is running waits for the turn to end, then rotates', async (t) => {
  const h = await withHarness(t)
  const gate = h.runner.gate()
  const running = h.wake(PRIVATE, { messages: [msg('l0_1', 'x')] })
  await until(() => h.runner.runs.length === 1)
  const old = h.runner.runs[0]?.sessionId as string
  await h.runtime.forgotten([PRIVATE])
  assert.deepEqual(h.gateway.forgotten, [[PRIVATE]], 'forgetSent is immediate')
  assert.deepEqual(h.gateway.resets, [])
  assert.deepEqual(h.runner.purged, [])
  gate.release()
  await running
  await until(() => h.runner.purged.length === 1)
  assert.deepEqual(h.gateway.resets, [old])
  assert.equal(h.runner.runs.length, 1)
  await h.wake(PRIVATE, { messages: [msg('l0_2', 'y')] })
  assert.equal(generationOf(h.runner.runs[1]?.sessionId), 1)
  assert.equal(h.records.length, 0)
  await h.wake(PRIVATE, { messages: [msg('l0_3', 'z')] })
  assert.equal(generationOf(h.runner.runs[2]?.sessionId), 1, 'one forget is one rotation, not one per later turn')
  assert.equal(h.runner.purged.length, 1)
})

test('a plugin’s rotate does the same without touching the sent texts', async (t) => {
  const h = await withHarness(t)
  const old = await firstDay(h)
  await h.runtime.rotate(PRIVATE)
  assert.deepEqual(h.gateway.forgotten, [])
  assert.deepEqual(h.gateway.resets, [old])
  assert.deepEqual(h.runner.purged, [[old]])
  assert.equal(h.runner.runs.length, 1)
  await h.runtime.rotate('qq:private:unknown')
  assert.deepEqual(h.runner.purged, [[old]], 'a channel without a session has nothing to rotate')
  const gate = h.runner.gate()
  const running = h.wake(PRIVATE, { messages: [msg('l0_2', 'x')] })
  await until(() => h.runner.runs.length === 2)
  await h.runtime.rotate(PRIVATE)
  assert.equal(h.runner.purged.length, 1)
  gate.release()
  await running
  await until(() => h.runner.purged.length === 2)
  assert.equal(h.records.length, 0)
})

test('rotating twice while a turn runs is one rotation', async (t) => {
  const h = await withHarness(t)
  const gate = h.runner.gate()
  const running = h.wake(PRIVATE, { messages: [msg('l0_1', 'x')] })
  await until(() => h.runner.runs.length === 1)
  await h.runtime.rotate(PRIVATE)
  await h.runtime.forgotten([PRIVATE])
  gate.release()
  await running
  await until(() => h.runner.purged.length === 1)
  await stateWhen(h, (s) => s.channels[PRIVATE]?.generation === 1)
  assert.equal(h.runner.purged.length, 1)
  assert.equal((await readState(h)).channels[PRIVATE]?.generation, 1)
})

test('a fixed model carries the loaded groups to the new session; an addition-only model starts from core', async (t) => {
  for (const mode of ['fixed', 'addition-only'] as const) {
    for (const how of ['day', 'forgotten'] as const) {
      const h = await withHarness(t)
      h.state.mode = mode
      const old = encodeSessionId({ agentClass: 'chat', channel: PRIVATE, generation: 0 })
      h.gateway.groups.set(old, ['calendar', 'weather'])
      await firstDay(h)
      assert.deepEqual((await readState(h)).channels[PRIVATE]?.activated, ['calendar', 'weather'])
      h.gateway.groups.set(old, ['calendar', 'weather', 'loaded-later'])
      const order: string[] = []
      const reset = h.gateway.resetSession.bind(h.gateway)
      const restore = h.gateway.restoreSession.bind(h.gateway)
      h.gateway.resetSession = (id) => { order.push('reset'); reset(id) }
      h.gateway.restoreSession = (id, groups) => { order.push('restore'); restore(id, groups) }
      if (how === 'day') {
        h.clock.advance(DAY)
        await h.wake(PRIVATE, { messages: [msg('l0_2', 'x')] })
      } else {
        await h.runtime.forgotten([PRIVATE])
      }
      const entry = (await readState(h)).channels[PRIVATE]
      if (mode === 'fixed') {
        assert.deepEqual(order, ['reset', 'restore'], `${mode}/${how}`)
        const last = h.gateway.restored.at(-1)
        assert.equal(generationOf(last?.sessionId), 1)
        assert.deepEqual(last?.groups, ['calendar', 'weather', 'loaded-later'])
        assert.deepEqual(entry?.activated, ['calendar', 'weather', 'loaded-later'])
      } else {
        assert.deepEqual(order, ['reset'], `${mode}/${how}`)
        assert.deepEqual(entry?.activated, [])
      }
    }
  }
})

test('a wake that comes while an idle channel is being rotated waits for the rotation, then runs in the new session', async (t) => {
  const h = await withHarness(t)
  await firstDay(h)
  let finish!: () => void
  h.runner.purge = async (ids) => { h.runner.purged.push([...ids]); await new Promise<void>((resolve) => { finish = resolve }) }
  const rotating = h.runtime.rotate(PRIVATE)
  await until(() => h.runner.purged.length === 1)
  const waking = h.wake(PRIVATE, { messages: [msg('l0_2', 'x')] })
  await settle()
  assert.equal(h.runner.runs.length, 1, 'not started during the rotation')
  finish()
  await rotating
  assert.equal((await waking).acked, true)
  assert.equal(generationOf(h.runner.runs[1]?.sessionId), 1)
})

test('a handoff whose record cannot be read is left out and the turn goes on', async (t) => {
  const h = await withHarness(t)
  await firstDay(h)
  h.runner.script.push(() => turn({ finalResponse: '聊到海边' }))
  h.clock.advance(DAY)
  const rt = h.rebuild({ readRecord: async () => { throw new Error('store down') } })
  assert.equal((await rt.wake(PRIVATE, { reason: 'message', messages: [msg('l0_2', 'a')] })).acked, true)
  assert.ok(!textOf(h.runner.runs.at(-1)?.input ?? '').includes('<handoff>'))
})

test('a purge that fails is only logged', async (t) => {
  const h = await withHarness(t)
  await firstDay(h)
  h.runner.purgeError = new Error('locked')
  await h.runtime.rotate(PRIVATE)
  assert.ok(h.logs.some((line) => line.event === 'agent-runtime.purge_failed'))
  assert.equal((await readState(h)).channels[PRIVATE]?.generation, 1)
})

// ---- round 2: evidence after forgetting, rotation that cannot stop, the pending mark ----

test('forgetting empties the saved evidence; a plugin’s rotate does too; a rotation for a new day does not', async (t) => {
  const forgotten = await withHarness(t)
  await firstDay(forgotten)
  assert.deepEqual((await readState(forgotten)).channels[PRIVATE]?.recentEvidence, ['l0_1'])
  await forgotten.runtime.forgotten([PRIVATE])
  assert.deepEqual((await readState(forgotten)).channels[PRIVATE]?.recentEvidence, [])

  const rotated = await withHarness(t)
  await firstDay(rotated)
  await rotated.runtime.rotate(PRIVATE)
  assert.deepEqual((await readState(rotated)).channels[PRIVATE]?.recentEvidence, [])

  const nextDay = await withHarness(t)
  await firstDay(nextDay)
  nextDay.runner.script.push(() => turn({ finalResponse: '聊到哪了' }))
  nextDay.clock.advance(DAY)
  await nextDay.wake(PRIVATE, { messages: [msg('l0_2', '早')] })
  assert.deepEqual((await readState(nextDay)).channels[PRIVATE]?.recentEvidence, ['l0_1', 'l0_2'], 'the handoff took its evidence and the list goes on')
})

test('forgotten evidence is not cited by a handoff written later', async (t) => {
  const h = await withHarness(t)
  await firstDay(h)
  await h.runtime.forgotten([PRIVATE])
  await h.wake(PRIVATE, { messages: [msg('l0_2', 'after the forgetting')] })
  h.runner.script.push(() => turn({ finalResponse: '聊到了新的话题' }))
  h.clock.advance(DAY)
  await h.wake(PRIVATE, { messages: [msg('l0_3', '早')] })
  assert.deepEqual(h.records[0]?.input.evidence, [{ id: 'l0_2' }], 'l0_1 was forgotten and is not cited')
})

test('forgetting still rotates when the tool update mode cannot be read: no handoff, no groups, everything else done', async (t) => {
  const h = await withHarness(t)
  await firstDay(h)
  const old = h.runner.runs[0]?.sessionId as string
  h.state.mode = 'fixed'
  h.gateway.groups.set(old, ['calendar'])
  const rt = h.rebuild({ toolUpdateMode: async () => { throw new Error('catalog down') } })
  await rt.forgotten([PRIVATE])
  assert.deepEqual(h.gateway.resets, [old])
  assert.deepEqual(h.runner.purged, [[old]])
  assert.deepEqual(h.gateway.restored.filter((entry) => generationOf(entry.sessionId) === 1), [], 'nothing is restored on the new session')
  const entry = (await readState(h)).channels[PRIVATE]
  assert.equal(entry?.generation, 1)
  assert.equal(entry?.turns, 0)
  assert.deepEqual(entry?.activated, [])
  assert.ok(h.logs.some((line) => line.event === 'agent-runtime.rotate_mode_failed' && JSON.stringify(line.fields) === JSON.stringify({ channel: PRIVATE })))
  assert.ok(!JSON.stringify(h.logs).includes('catalog down'))
})

test('a new-day rotation with an unreadable mode skips the handoff but still rotates', async (t) => {
  const h = await withHarness(t)
  await firstDay(h)
  h.clock.advance(DAY)
  // the rotation reads the mode first, and the turn after it; only the rotation's own read fails
  let calls = 0
  const flaky = h.rebuild({ toolUpdateMode: async () => { calls += 1; if (calls === 1) throw new Error('catalog down'); return 'addition-only' } })
  const result = await flaky.wake(PRIVATE, { reason: 'message', messages: [msg('l0_2', '早')] })
  assert.equal(result.acked, true)
  assert.equal(h.records.length, 0, 'no handoff')
  assert.ok(h.runner.runs.every((run) => run.input !== HANDOFF_PROMPT))
  assert.equal(generationOf(h.runner.runs.at(-1)?.sessionId), 1)
})

test('forgetting still rotates when the settings cannot be read, and the day falls back to the system zone', async (t) => {
  const h = await withHarness(t)
  await firstDay(h)
  const old = h.runner.runs[0]?.sessionId as string
  const rt = h.rebuild({ settings: async () => { throw new Error('settings down') } })
  await rt.forgotten([PRIVATE])
  assert.deepEqual(h.gateway.resets, [old])
  assert.deepEqual(h.runner.purged, [[old]])
  const entry = (await readState(h)).channels[PRIVATE]
  assert.equal(entry?.generation, 1)
  assert.match(String(entry?.startedDay), /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(h.logs.some((line) => line.event === 'agent-runtime.rotate_settings_failed' && JSON.stringify(line.fields) === JSON.stringify({ channel: PRIVATE })))
  assert.ok(!JSON.stringify(h.logs).includes('settings down'))
})

test('forgetting during a turn still rotates after it when the mode cannot be read then', async (t) => {
  const h = await withHarness(t)
  let broken = false
  const rt = h.rebuild({ toolUpdateMode: async () => { if (broken) throw new Error('catalog down'); return 'addition-only' } })
  const gate = h.runner.gate()
  const running = rt.wake(PRIVATE, { reason: 'message', messages: [msg('l0_1', 'x')] })
  await until(() => h.runner.runs.length === 1)
  const old = h.runner.runs[0]?.sessionId as string
  broken = true
  await rt.forgotten([PRIVATE])
  gate.release()
  await running
  await until(() => h.runner.purged.length === 1)
  assert.deepEqual(h.gateway.resets, [old])
  assert.deepEqual(h.runner.purged, [[old]])
  await stateWhen(h, (s) => s.channels[PRIVATE]?.generation === 1)
  assert.equal((await readState(h)).channels[PRIVATE]?.generation, 1)
  assert.equal((await readState(h)).channels[PRIVATE]?.rotatePending, undefined)
  assert.ok(!h.logs.some((line) => line.event === 'agent-runtime.rotate_failed'))
})

test('forgetting during a turn marks the entry on disk at once, and the mark is gone when the rotation is done', async (t) => {
  const h = await withHarness(t)
  const gate = h.runner.gate()
  const running = h.wake(PRIVATE, { messages: [msg('l0_1', 'x')] })
  await until(() => h.runner.runs.length === 1)
  await h.runtime.forgotten([PRIVATE])
  assert.equal((await readState(h)).channels[PRIVATE]?.rotatePending, true)
  gate.release()
  await running
  await until(() => h.runner.purged.length === 1)
  await stateWhen(h, (s) => s.channels[PRIVATE]?.generation === 1)
  const entry = (await readState(h)).channels[PRIVATE]
  assert.equal(entry?.generation, 1)
  assert.equal('rotatePending' in (entry ?? {}), false)
})

test('forgetting an idle channel and a plugin’s rotate leave no mark on disk', async (t) => {
  const h = await withHarness(t)
  const gate = h.runner.gate()
  const running = h.wake(PRIVATE, { messages: [msg('l0_1', 'x')] })
  await until(() => h.runner.runs.length === 1)
  await h.runtime.rotate(PRIVATE)
  await settle()
  assert.equal('rotatePending' in ((await readState(h)).channels[PRIVATE] ?? {}), false, 'rotate() does not need to survive a crash')
  gate.release()
  await running
  await until(() => h.runner.purged.length === 1)
  await settle()

  const idle = await withHarness(t)
  await firstDay(idle)
  await idle.runtime.forgotten([PRIVATE])
  assert.equal('rotatePending' in ((await readState(idle)).channels[PRIVATE] ?? {}), false)
})

test('a forgetting that comes in while the handoff is being written keeps the handoff out of memory, and the channel rotates again after the turn', async (t) => {
  const h = await withHarness(t)
  await firstDay(h)
  const gate = h.runner.gate()
  h.clock.advance(DAY)
  const running = h.wake(PRIVATE, { messages: [msg('l0_2', '早')] })
  await until(() => h.runner.runs.length === 2)
  assert.equal(h.runner.runs[1]?.input, HANDOFF_PROMPT, 'the handoff run is the one hanging')
  await h.runtime.forgotten([PRIVATE])
  gate.release({ finalResponse: '聊到海边，还没定时间' })
  const result = await running
  assert.equal(result.acked, true)
  assert.equal(h.records.filter((record) => record.input.kind === 'l1.topic').length, 0, 'nothing was written')
  assert.equal(h.runner.runs.length, 3)
  assert.ok(!textOf(h.runner.runs[2]?.input ?? '').includes('<handoff>'))
  assert.ok(!textOf(h.runner.runs[2]?.input ?? '').includes('聊到海边'))
  assert.ok(h.logs.some((line) => line.event === 'agent-runtime.handoff_skipped'))
  await until(() => h.runner.purged.length === 2)
  await stateWhen(h, (s) => s.channels[PRIVATE]?.generation === 2)
  const entry = (await readState(h)).channels[PRIVATE]
  assert.equal(entry?.generation, 2, 'one rotation for the new day, one for the forgetting')
  assert.equal(entry?.handoff, undefined)
  assert.equal('rotatePending' in (entry ?? {}), false)
})

test('a forgetting that comes in during a rotation does not cause a second rotation afterwards, nor one after a restart', async (t) => {
  const h = await withHarness(t)
  await firstDay(h)
  let release!: () => void
  const hanging = new Promise<void>((resolve) => { release = resolve })
  let purges = 0
  h.runner.purge = async (): Promise<void> => {
    purges += 1
    if (purges === 1) await hanging
  }
  const first = h.runtime.forgotten([PRIVATE])
  await until(() => purges === 1)
  await h.runtime.forgotten([PRIVATE])
  release()
  await first
  await stateWhen(h, (s) => s.channels[PRIVATE]?.generation === 1 && !('rotatePending' in (s.channels[PRIVATE] ?? {})))
  assert.equal('rotatePending' in ((await readState(h)).channels[PRIVATE] ?? {}), false)
  assert.equal((await readState(h)).channels[PRIVATE]?.generation, 1)

  await h.wake(PRIVATE, { messages: [msg('l0_2', 'y')] })
  assert.equal(generationOf(h.runner.runs.at(-1)?.sessionId), 1)
  await settle()
  assert.equal((await readState(h)).channels[PRIVATE]?.generation, 1, 'the whole thing added exactly one generation')
  assert.equal(purges, 1)
  assert.equal(h.gateway.resets.length, 1)
})

test('a handoff record that has been forgotten is left out even when it still has text', async (t) => {
  const h = await withHarness(t)
  await firstDay(h)
  h.runner.script.push(() => turn({ finalResponse: '旧的交接' }))
  h.clock.advance(DAY)
  // The record is written during this wake; forget it before the new session's first read, keeping its text.
  const runtime = h.rebuild({
    readRecord: async (id) => {
      if (id === 'l1_handoff1') {
        h.records$.set(id, { ...(h.records$.get(id) as MemoryRecord), status: 'tombstoned', content: { text: '旧的交接' } })
      }
      return h.records$.has(id) ? h.records$.get(id) ?? null : ({ id, status: 'active', content: {} } as unknown as MemoryRecord)
    },
  })
  await runtime.wake(PRIVATE, { reason: 'message', messages: [msg('l0_2', 'a')] })
  assert.equal(h.records$.get('l1_handoff1')?.status, 'tombstoned')
  const sent = textOf(h.runner.runs.at(-1)?.input ?? '')
  assert.ok(!sent.includes('<handoff>'))
  assert.ok(!sent.includes('旧的交接'))
})
