import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { RunnerFailedError } from '@brain-core/satellite-host'
import type { RuntimeSettings } from '../../src/contracts/index.ts'
import { PRIVATE, SELECTION, harness, msg, sends, settle, until } from './helpers.ts'
import type { Harness } from './helpers.ts'

const MINUTE = 60_000
const AGENTS = { chat: SELECTION, activity: SELECTION }

async function withHarness(t: { after(fn: () => Promise<void>): void }, options?: Parameters<typeof harness>[0]): Promise<Harness> {
  const h = await harness(options)
  t.after(() => h.cleanup())
  return h
}

async function readState(h: Harness): Promise<{ channels: Record<string, Record<string, unknown>> }> {
  return JSON.parse(await readFile(h.stateFile, 'utf8')) as { channels: Record<string, Record<string, unknown>> }
}

const at = (hour: number, minute = 0): number => Date.UTC(2026, 10, 9, hour, minute)

test('quiet hours default to 3 to 8, the end is not included, and a skipped wake runs nothing and says nothing', async (t) => {
  const h = await withHarness(t, { start: at(4) })
  const result = await h.wake(PRIVATE, { proactive: true })
  assert.deepEqual(result, { wakeId: result.wakeId, acked: false, profileVersion: 0, sent: 0, steps: 0, skipped: 'quiet' })
  assert.ok(result.wakeId.length > 0)
  assert.equal(h.runner.runs.length, 0)
  assert.equal(h.contexts.length, 0)
  assert.deepEqual(h.events, [])
  assert.deepEqual(h.metrics, [])
  h.clock.set(at(3))
  assert.equal((await h.wake(PRIVATE, { proactive: true })).skipped, 'quiet')
  h.clock.set(at(7, 59))
  assert.equal((await h.wake(PRIVATE, { proactive: true })).skipped, 'quiet')
  h.clock.set(at(8))
  assert.equal((await h.wake(PRIVATE, { proactive: true })).acked, true)
})

test('the default quiet hours start at three, not before', async (t) => {
  const h = await withHarness(t, { start: at(2, 59) })
  assert.equal((await h.wake(PRIVATE, { proactive: true })).acked, true)
})

test('quiet hours can start and end on a half hour', async (t) => {
  const h = await withHarness(t, { settings: { agents: AGENTS, timezone: 'UTC', quietHours: [3.5, 7.5] } })
  for (const [hour, minute, quiet] of [[3, 29, false], [3, 30, true], [7, 29, true], [7, 30, false]] as const) {
    h.clock.set(at(hour, minute))
    assert.equal((await h.wake(PRIVATE, { proactive: true })).skipped === 'quiet', quiet, `${hour}:${minute}`)
  }
})

test('a wake that is not proactive ignores quiet hours', async (t) => {
  const h = await withHarness(t, { start: at(4) })
  assert.equal((await h.wake(PRIVATE, { messages: [msg('1', 'hi')] })).acked, true)
})

test('quiet hours can cross midnight, and equal numbers mean none', async (t) => {
  const settings = (quietHours: readonly [number, number]): RuntimeSettings => ({ agents: AGENTS, timezone: 'UTC', quietHours })
  const h = await withHarness(t, { settings: settings([22, 6]) })
  for (const [hour, quiet] of [[22, true], [23, true], [0, true], [5, true], [6, false], [12, false], [21, false]] as const) {
    h.clock.set(at(hour))
    assert.equal((await h.wake(PRIVATE, { proactive: true })).skipped === 'quiet', quiet, `hour ${hour}`)
  }
  h.state.settings = settings([5, 5])
  for (const hour of [4, 5, 6]) {
    h.clock.set(at(hour))
    assert.notEqual((await h.wake(PRIVATE, { proactive: true })).skipped, 'quiet', `hour ${hour}`)
  }
})

test('quiet hours are read in the owner time zone', async (t) => {
  const h = await withHarness(t, { start: at(20), settings: { agents: AGENTS, timezone: 'Asia/Shanghai' } })
  assert.equal((await h.wake(PRIVATE, { proactive: true })).skipped, 'quiet', '20:00 UTC is 04:00 in Shanghai')
  h.clock.set(at(2))
  assert.equal((await h.wake(PRIVATE, { proactive: true })).acked, true, '02:00 UTC is 10:00 in Shanghai')
})

test('foreground: someone spoke here in the last ten minutes, not exactly ten', async (t) => {
  const h = await withHarness(t)
  await h.wake(PRIVATE, { messages: [msg('1', 'hi')] })
  h.clock.advance(10 * MINUTE - 1)
  assert.equal((await h.wake(PRIVATE, { proactive: true })).skipped, 'foreground')
  h.clock.advance(1)
  assert.equal((await h.wake(PRIVATE, { proactive: true })).acked, true)
})

test('foreground uses the configured window, and the arrival time, not the end of the turn', async (t) => {
  const h = await withHarness(t, { settings: { agents: AGENTS, timezone: 'UTC', proactive: { activeWindowMs: 2 * MINUTE } } })
  const gate = h.runner.gate()
  const running = h.wake(PRIVATE, { messages: [msg('1', 'hi')] })
  await until(() => h.runner.runs.length === 1)
  h.clock.advance(5 * MINUTE)
  gate.release()
  await running
  assert.equal((await h.wake(PRIVATE, { proactive: true })).acked, true, 'the message arrived five minutes ago')
})

test('normal chat ending with agent reply does not lock out future proactive wakes (matrix row 1)', async (t) => {
  const h = await withHarness(t)
  sends(h)
  await h.wake(PRIVATE, { messages: [msg('1', 'hi')] })
  h.clock.advance(30 * MINUTE)
  assert.equal(await h.runtime.canProactive?.(PRIVATE), undefined)
  assert.equal((await h.wake(PRIVATE, { proactive: true })).acked, true)
})

test('unanswered: she spoke proactively and nobody has answered (matrix rows 2 and 3)', async (t) => {
  const h = await withHarness(t)
  sends(h)
  assert.equal((await h.wake(PRIVATE, { proactive: true })).sent, 1)
  h.clock.advance(70 * MINUTE)
  assert.equal(await h.runtime.canProactive?.(PRIVATE), 'unanswered')
  assert.equal((await h.wake(PRIVATE, { proactive: true })).skipped, 'unanswered', 'time does not clear proactive unanswered')
  sends(h)
  await h.wake(PRIVATE, { messages: [msg('2', 'sorry, I was out')] })
  h.clock.advance(70 * MINUTE)
  assert.equal(await h.runtime.canProactive?.(PRIVATE), undefined)
  assert.equal((await h.wake(PRIVATE, { proactive: true })).acked, true, 'outbound > inbound > proactive is allowed')
})

test('unanswered also holds when she spoke on her own and there has never been an answer', async (t) => {
  const h = await withHarness(t)
  sends(h)
  assert.equal((await h.wake(PRIVATE, { proactive: true })).sent, 1)
  h.clock.advance(3 * 60 * MINUTE)
  assert.equal((await h.wake(PRIVATE, { proactive: true })).skipped, 'unanswered')
})

test('cooldown: not again within an hour of the last time she started a talk herself', async (t) => {
  const h = await withHarness(t)
  sends(h)
  await h.wake(PRIVATE, { proactive: true })
  const started = h.clock.now()
  h.clock.advance(20 * MINUTE)
  await h.wake(PRIVATE, { messages: [msg('1', 'oh hi')] })
  h.clock.advance(5 * MINUTE)
  assert.equal((await h.wake(PRIVATE, { proactive: true })).skipped, 'foreground')
  h.clock.set(started + 40 * MINUTE)
  assert.equal((await h.wake(PRIVATE, { proactive: true })).skipped, 'cooldown')
  h.clock.set(started + 60 * MINUTE - 1)
  assert.equal((await h.wake(PRIVATE, { proactive: true })).skipped, 'cooldown', 'a millisecond short of an hour')
  h.clock.set(started + 60 * MINUTE)
  assert.equal((await h.wake(PRIVATE, { proactive: true })).acked, true, 'exactly an hour is over')
})

test('cooldown uses the configured time', async (t) => {
  const h = await withHarness(t, { settings: { agents: AGENTS, timezone: 'UTC', proactive: { activeWindowMs: 1, cooldownMs: 5 * MINUTE } } })
  sends(h)
  await h.wake(PRIVATE, { proactive: true })
  h.clock.advance(MINUTE)
  await h.wake(PRIVATE, { messages: [msg('1', 'hi')] })
  h.clock.advance(MINUTE)
  assert.equal((await h.wake(PRIVATE, { proactive: true })).skipped, 'cooldown')
  h.clock.advance(3 * MINUTE)
  assert.equal((await h.wake(PRIVATE, { proactive: true })).acked, true)
})

test('the checks go in order: quiet, foreground, unanswered, cooldown', async (t) => {
  const h = await withHarness(t, { start: at(12), settings: { agents: AGENTS, timezone: 'UTC', proactive: { cooldownMs: 120 * MINUTE } } })
  // Send a proactive message first so unanswered is armed, then inbound resets unanswered while foreground is active.
  sends(h)
  await h.wake(PRIVATE, { proactive: true })
  const proactiveAt = h.clock.now()
  assert.equal(await h.runtime.canProactive?.(PRIVATE), 'unanswered')

  // Inbound message puts channel into foreground; enable quietHours to verify quiet > foreground > unanswered > cooldown.
  await h.wake(PRIVATE, { messages: [msg('1', 'hi')] })
  h.state.settings = { agents: AGENTS, timezone: 'UTC', quietHours: [12, 13], proactive: { cooldownMs: 120 * MINUTE } }
  assert.equal(await h.runtime.canProactive?.(PRIVATE), 'quiet')
  assert.equal((await h.wake(PRIVATE, { proactive: true })).skipped, 'quiet', 'quiet before foreground, unanswered and cooldown')

  h.state.settings = { agents: AGENTS, timezone: 'UTC', proactive: { cooldownMs: 120 * MINUTE } }
  assert.equal(await h.runtime.canProactive?.(PRIVATE), 'foreground')
  assert.equal((await h.wake(PRIVATE, { proactive: true })).skipped, 'foreground', 'foreground before cooldown')

  // Advance past foreground window while still inside 120m cooldown -> cooldown hits.
  h.clock.set(proactiveAt + 30 * MINUTE)
  assert.equal(await h.runtime.canProactive?.(PRIVATE), 'cooldown')
  assert.equal((await h.wake(PRIVATE, { proactive: true })).skipped, 'cooldown')

  // Now send a new proactive message while keeping cooldown huge -> unanswered comes before cooldown.
  h.clock.set(proactiveAt + 121 * MINUTE)
  sends(h)
  await h.wake(PRIVATE, { proactive: true })
  assert.equal(await h.runtime.canProactive?.(PRIVATE), 'unanswered')
  assert.equal((await h.wake(PRIVATE, { proactive: true })).skipped, 'unanswered', 'unanswered before cooldown')
})

test('canProactive checks loaded state, busy/pending lane as foreground, and closed runtime', async (t) => {
  const h = await withHarness(t, { start: at(12) })
  const gate = h.runner.gate()
  const running = h.wake(PRIVATE, { messages: [msg('1', 'busy now')] })
  await until(() => h.runner.runs.length === 1)
  h.clock.advance(20 * MINUTE)
  // activeWindowMs expired, but the turn is still running on the lane -> foreground
  assert.equal(await h.runtime.canProactive?.(PRIVATE), 'foreground')
  gate.release()
  await running
  assert.equal(await h.runtime.canProactive?.(PRIVATE), undefined)

  // Pending debounced turn also reports foreground
  const debounced = h.wake(PRIVATE, { debounceMs: 5_000, note: 'wait' })
  assert.equal(await h.runtime.canProactive?.(PRIVATE), 'foreground')
  h.timers.fireAll()
  await debounced

  // Persisted proactive state is awaited via loaded on rebuild
  sends(h)
  await h.wake(PRIVATE, { proactive: true })
  const again = h.rebuild()
  assert.equal(await again.canProactive?.(PRIVATE), 'unanswered')

  await again.close()
  await assert.rejects(() => again.canProactive!(PRIVATE), (err: unknown) => err instanceof Error && (err as { code?: string }).code === 'UNAVAILABLE')
})

test('only a send counts as a proactive talk: a turn that stays silent leaves the cooldown alone', async (t) => {
  const h = await withHarness(t)
  const quiet = await h.wake(PRIVATE, { proactive: true })
  assert.equal(quiet.acked, true)
  assert.equal(quiet.sent, 0)
  const state = (await readState(h)).channels[PRIVATE]
  assert.equal(state?.lastProactiveAt, undefined)
  assert.equal(state?.lastOutboundAt, undefined)
  assert.equal((await h.wake(PRIVATE, { proactive: true })).acked, true, 'no cooldown after saying nothing')
  sends(h)
  await h.wake(PRIVATE, { proactive: true })
  const after = (await readState(h)).channels[PRIVATE]
  assert.equal(after?.lastProactiveAt, h.clock.now())
  assert.equal(after?.lastOutboundAt, h.clock.now())
})

test('a reply to a message counts as outbound, not as a proactive talk', async (t) => {
  const h = await withHarness(t)
  sends(h)
  await h.wake(PRIVATE, { messages: [msg('1', 'hi')] })
  const state = (await readState(h)).channels[PRIVATE]
  assert.equal(state?.lastOutboundAt, h.clock.now())
  assert.equal(state?.lastProactiveAt, undefined)
  assert.equal(state?.lastInboundAt, h.clock.now() - 1_000, 'the message arrived before her answer')
})

test('a proactive wake that was merged with a message is a reply, so it does not use up the cooldown', async (t) => {
  const h = await withHarness(t)
  const first = h.runner.gate()
  const a = h.wake(PRIVATE, { messages: [msg('1', 'one')] })
  await until(() => h.runner.runs.length === 1)
  h.clock.advance(11 * MINUTE)
  const b = h.wake(PRIVATE, { proactive: true })
  const c = h.wake(PRIVATE, { messages: [msg('2', 'two')] })
  await settle()
  sends(h)
  first.release()
  await Promise.all([a, b, c])
  assert.equal((await readState(h)).channels[PRIVATE]?.lastProactiveAt, undefined)
})

test('the times survive a restart', async (t) => {
  const h = await withHarness(t)
  sends(h)
  await h.wake(PRIVATE, { proactive: true })
  h.clock.advance(20 * MINUTE)
  await h.wake(PRIVATE, { messages: [msg('1', 'hi')] })
  h.clock.advance(30 * MINUTE)
  const again = h.rebuild()
  assert.equal((await again.wake(PRIVATE, { reason: 'own-time', proactive: true })).skipped, 'cooldown')
})

test('wakeProactiveMessage returns blocked: true when mid-turn checkProactive or gateway blocks without sending', async (t) => {
  const h = await withHarness(t)
  h.runner.script.push(async () => {
    const plan = h.gateway.plans.at(-1)
    h.state.settings = { agents: AGENTS, timezone: 'UTC', quietHours: [12, 13] }
    await assert.rejects(() => plan!.sendProactiveMessage!('hi'), /当前不适合主动发送消息/)
    return { finalResponse: '好。', steps: [{ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }], retries: 0, compacted: false }
  })
  const guarded = await h.runtime.wakeProactiveMessage(PRIVATE, { reason: 'promise-due' }, async () => 'm1')
  assert.equal(guarded.acked, true)
  assert.equal(guarded.sent, 0)
  assert.equal(guarded.blocked, true)

  h.state.settings = { agents: AGENTS, timezone: 'UTC' }
  h.runner.script.push(() => {
    h.gateway.blocked = 1
    return { finalResponse: '好。', steps: [{ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }], retries: 0, compacted: false }
  })
  const styleBlocked = await h.runtime.wakeProactiveMessage(PRIVATE, { reason: 'promise-due' }, async () => 'm2')
  assert.equal(styleBlocked.acked, true)
  assert.equal(styleBlocked.sent, 0)
  assert.equal(styleBlocked.blocked, true)

  const silent = await h.runtime.wakeProactiveMessage(PRIVATE, { reason: 'promise-due' }, async () => 'm3')
  assert.equal(silent.acked, true)
  assert.equal(silent.blocked, undefined)
})

test('wakeProactiveMessage persists lastOutboundAt and lastProactiveAt when a send succeeded before runner failure', async (t) => {
  const h = await withHarness(t)
  h.runner.script.push(() => {
    h.gateway.sent = 1
    throw new RunnerFailedError('chat', 'crashed after send')
  })
  await assert.rejects(
    () => h.runtime.wakeProactiveMessage(PRIVATE, { reason: 'promise-due', evidence: ['l0_1'] }, async () => 'm1'),
    (error: unknown) => error instanceof Error && 'code' in error && (error as { code: string }).code === 'UNAVAILABLE',
  )
  const state = (await readState(h)).channels[PRIVATE]
  assert.equal(state?.lastOutboundAt, h.clock.now())
  assert.equal(state?.lastProactiveAt, h.clock.now())
  assert.deepEqual(state?.recentEvidence, ['l0_1'])
  assert.equal((await h.runtime.wakeProactiveMessage(PRIVATE, { reason: 'promise-due' }, async () => 'm2')).skipped, 'unanswered')
})
