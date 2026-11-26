import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { DEFAULT_SCHEDULED_PER_DAY, DEFAULT_TICK_MS, MIN_INTERVAL_MS, createScheduler } from '../../src/scheduler/index.ts'
import { parseState } from '../../src/scheduler/state.ts'
import { FakeClock } from '../fakes/index.ts'
import { DAY, HOUR, MINUTE, SETTINGS, at, setup, settle, throwsCode, waitForStateFile } from './helpers.ts'

test('every runs when due, not before, and keeps its interval', async (t) => {
  const s = await setup(t)
  let runs = 0
  s.scheduler.every('plugin.poll', MIN_INTERVAL_MS, () => { runs += 1 })

  await s.scheduler.tick()
  assert.equal(runs, 0)
  s.clock.advance(MIN_INTERVAL_MS - 1)
  await s.scheduler.tick()
  assert.equal(runs, 0)
  s.clock.advance(1)
  await s.scheduler.tick()
  assert.equal(runs, 1)
  s.clock.advance(MIN_INTERVAL_MS)
  await s.scheduler.tick()
  assert.equal(runs, 2)
  s.clock.advance(MIN_INTERVAL_MS / 2)
  await s.scheduler.tick()
  assert.equal(runs, 2)
})

test('every runs once after quiet hours instead of catching up', async (t) => {
  const clock = new FakeClock(at(1, 59))
  const s = await setup(t, { clock })
  let runs = 0
  s.scheduler.every('plugin.poll', MINUTE, () => { runs += 1 })

  clock.set(at(2, 0))
  await s.scheduler.tick()
  assert.equal(runs, 1)
  clock.set(at(8, 0))
  await s.scheduler.tick()
  assert.equal(runs, 2, 'the missed intervals are not replayed')
  await s.scheduler.tick()
  assert.equal(runs, 2, 'the next run is a full interval after now, not the old due time')
  clock.advance(MINUTE / 2)
  await s.scheduler.tick()
  assert.equal(runs, 2)
  clock.advance(MINUTE / 2)
  await s.scheduler.tick()
  assert.equal(runs, 3)
})

test('every and ownTime reject an interval below 60 seconds', async (t) => {
  assert.equal(MIN_INTERVAL_MS, 60_000)
  const s = await setup(t)
  throwsCode(() => s.scheduler.every('p', MIN_INTERVAL_MS - 1, () => undefined), 'INVALID_ARGUMENT')
  throwsCode(() => s.scheduler.every('p', 59_999, () => undefined), 'INVALID_ARGUMENT')
  throwsCode(() => s.scheduler.every('p', 0, () => undefined), 'INVALID_ARGUMENT')
  throwsCode(() => s.scheduler.every('p', -1, () => undefined), 'INVALID_ARGUMENT')
  throwsCode(() => s.scheduler.every('p', Number.NaN, () => undefined), 'INVALID_ARGUMENT')
  throwsCode(() => s.scheduler.ownTime('p', { name: 'n', everyMs: MIN_INTERVAL_MS - 1, run: () => undefined }), 'INVALID_ARGUMENT')
  throwsCode(() => s.scheduler.ownTime('p', { name: 'n', everyMs: 59_999, run: () => undefined }), 'INVALID_ARGUMENT')
  // The boundary itself is allowed.
  s.scheduler.every('p', MIN_INTERVAL_MS, () => undefined)
  s.scheduler.every('q', 60_000, () => undefined)
  s.scheduler.ownTime('p', { name: 'n', everyMs: MIN_INTERVAL_MS, run: () => undefined })
  s.scheduler.ownTime('q', { name: 'boundary', everyMs: 60_000, run: () => undefined })
})

test('at runs once; a time already passed runs on the next tick', async (t) => {
  const s = await setup(t)
  throwsCode(() => s.scheduler.at('p', Number.NaN, () => undefined), 'INVALID_ARGUMENT')
  throwsCode(() => s.scheduler.at('p', Number.POSITIVE_INFINITY, () => undefined), 'INVALID_ARGUMENT')
  let runs = 0
  s.scheduler.at('plugin.poll', s.clock.now() + MINUTE, () => { runs += 1 })
  await s.scheduler.tick()
  assert.equal(runs, 0)
  s.clock.advance(MINUTE - 1)
  await s.scheduler.tick()
  assert.equal(runs, 0)
  s.clock.advance(1)
  await s.scheduler.tick()
  assert.equal(runs, 1)
  s.clock.advance(DAY)
  await s.scheduler.tick()
  assert.equal(runs, 1)

  s.scheduler.at('plugin.poll', s.clock.now() - HOUR, () => { runs += 1 })
  await s.scheduler.tick()
  assert.equal(runs, 2)
  await s.scheduler.tick()
  assert.equal(runs, 2)
})

test('ownTime does not fire in quiet hours and fires once after them', async (t) => {
  const fake = new FakeClock(at(3, 0))
  const real = await setup(t, { clock: fake, settings: { agents: {}, timezone: 'UTC', quietHours: [3, 8] } })
  let runs = 0
  real.scheduler.ownTime('plugin.own', { name: 'own', everyMs: MINUTE, run: () => { runs += 1 } })

  await real.scheduler.tick()
  assert.equal(runs, 0)
  fake.set(at(4, 0))
  await real.scheduler.tick()
  assert.equal(runs, 0)
  fake.set(at(7, 59))
  await real.scheduler.tick()
  assert.equal(runs, 0)
  fake.set(at(8, 0))
  await real.scheduler.tick()
  assert.equal(runs, 1)
  await real.scheduler.tick()
  assert.equal(runs, 1)

  // An `at` that came due during quiet hours also runs once, when the next tick leaves them.
  const other = await setup(t, { clock: fake, settings: { agents: {}, timezone: 'UTC', quietHours: [3, 8] } })
  let atRuns = 0
  other.scheduler.at('plugin.poll', at(3, 30), () => { atRuns += 1 })
  await other.scheduler.tick()
  assert.equal(atRuns, 1)

  // A quiet range that crosses midnight, and from === to meaning none.
  const cross = await setup(t, {
    clock: fake,
    settings: { agents: {}, timezone: 'UTC', quietHours: [22, 6] },
  })
  let crossRuns = 0
  cross.scheduler.ownTime('plugin.own', { name: 'own', everyMs: MINUTE, run: () => { crossRuns += 1 } })
  fake.set(at(23, 0))
  await cross.scheduler.tick()
  assert.equal(crossRuns, 0)
  fake.set(at(5, 59))
  await cross.scheduler.tick()
  assert.equal(crossRuns, 0)
  fake.set(at(6, 0))
  await cross.scheduler.tick()
  assert.equal(crossRuns, 1)

  const none = await setup(t, { clock: fake, settings: { agents: {}, timezone: 'UTC', quietHours: [3, 3] } })
  let noneRuns = 0
  none.scheduler.ownTime('plugin.own', { name: 'own', everyMs: MINUTE, run: () => { noneRuns += 1 } })
  fake.set(at(3, 30))
  await none.scheduler.tick()
  assert.equal(noneRuns, 1)
})

test('quiet hours default to 3:00-8:00', async (t) => {
  const clock = new FakeClock(at(4, 0))
  const s = await setup(t, { clock })
  let runs = 0
  s.scheduler.ownTime('plugin.own', { name: 'own', everyMs: MINUTE, run: () => { runs += 1 } })
  await s.scheduler.tick()
  assert.equal(runs, 0)
  clock.set(at(8, 0))
  await s.scheduler.tick()
  assert.equal(runs, 1)
})

test('the default quiet hours start at 3:00 and end at 8:00', async (t) => {
  const clock = new FakeClock(at(2, 59))
  const s = await setup(t, { clock })
  let runs = 0
  s.scheduler.ownTime('plugin.own', { name: 'own', everyMs: MINUTE, run: () => { runs += 1 } })

  await s.scheduler.tick()
  assert.equal(runs, 1, '2:59 is outside')
  clock.set(at(3, 0))
  await s.scheduler.tick()
  assert.equal(runs, 1, '3:00 is inside')
  clock.set(at(7, 59))
  await s.scheduler.tick()
  assert.equal(runs, 1)
  clock.set(at(8, 0))
  await s.scheduler.tick()
  assert.equal(runs, 2, '8:00 is outside again')
})

test('ownTime defaults to six runs a day', async (t) => {
  const s = await setup(t, { clock: new FakeClock(at(12, 0)) })
  let runs = 0
  s.scheduler.ownTime('plugin.own', { name: 'own', everyMs: MINUTE, run: () => { runs += 1 } })

  for (let index = 0; index < 7; index += 1) {
    await s.scheduler.tick()
    s.clock.advance(MINUTE)
  }
  assert.equal(runs, 6)
})

test('the time zone in settings decides the day and the quiet hour', async (t) => {
  const instant = Date.UTC(2026, 10, 7, 20, 0)
  const utc = await setup(t, { clock: new FakeClock(instant), settings: { agents: {}, timezone: 'UTC' } })
  const tokyo = await setup(t, { clock: new FakeClock(instant), settings: { agents: {}, timezone: 'Asia/Tokyo' } })
  let utcRuns = 0
  let tokyoRuns = 0
  utc.scheduler.ownTime('plugin.own', { name: 'own', everyMs: MINUTE, run: () => { utcRuns += 1 } })
  tokyo.scheduler.ownTime('plugin.own', { name: 'own', everyMs: MINUTE, run: () => { tokyoRuns += 1 } })

  // 20:00 UTC is 05:00 in Tokyo, inside the default quiet hours.
  await utc.scheduler.tick()
  await tokyo.scheduler.tick()
  assert.equal(utcRuns, 1)
  assert.equal(tokyoRuns, 0)

  tokyo.clock.advance(3 * HOUR)
  await tokyo.scheduler.tick()
  assert.equal(tokyoRuns, 1)

  const utcState = JSON.parse(await readFile(utc.stateFile, 'utf8')) as { ownTime: Record<string, { day?: string }> }
  const tokyoState = JSON.parse(await readFile(tokyo.stateFile, 'utf8')) as { ownTime: Record<string, { day?: string }> }
  assert.equal(utcState.ownTime['plugin.own/own']?.day, '2026-11-07')
  assert.equal(tokyoState.ownTime['plugin.own/own']?.day, '2026-11-08')
})

test('ownTime stops at its per-plugin daily quota and recovers the next day', async (t) => {
  const s = await setup(t, {
    clock: new FakeClock(at(12, 0)),
    settings: { agents: {}, timezone: 'UTC', ownTimePerDay: 2 },
  })
  let runs = 0
  s.scheduler.ownTime('plugin.own', { name: 'own', everyMs: MINUTE, run: () => { runs += 1 } })
  await s.scheduler.tick()
  assert.equal(runs, 1)
  s.clock.advance(MINUTE)
  await s.scheduler.tick()
  assert.equal(runs, 2)
  s.clock.advance(MINUTE)
  await s.scheduler.tick()
  assert.equal(runs, 2, 'over quota for the rest of the day')

  s.clock.set(at(12, 0, 8))
  await s.scheduler.tick()
  assert.equal(runs, 3, 'a new natural day restores the quota')
})

test('ownTime and every use separate quotas', async (t) => {
  const s = await setup(t, {
    clock: new FakeClock(at(12, 0)),
    settings: { agents: {}, timezone: 'UTC', ownTimePerDay: 1 },
  })
  let ownRuns = 0
  let everyRuns = 0
  s.scheduler.ownTime('plugin.a', { name: 'own', everyMs: MINUTE, run: () => { ownRuns += 1 } })
  s.scheduler.every('plugin.a', MINUTE, () => { everyRuns += 1 })

  await s.scheduler.tick()
  assert.equal(ownRuns, 1)
  assert.equal(everyRuns, 0)
  s.clock.advance(MINUTE)
  await s.scheduler.tick()
  assert.equal(ownRuns, 1, 'the ownTime quota is spent')
  assert.equal(everyRuns, 1, 'the every quota is untouched')
})

test('quotas are counted per plugin', async (t) => {
  const s = await setup(t, {
    clock: new FakeClock(at(12, 0)),
    settings: { agents: {}, timezone: 'UTC', ownTimePerDay: 1 },
  })
  let aRuns = 0
  let bRuns = 0
  s.scheduler.ownTime('plugin.a', { name: 'own', everyMs: MINUTE, run: () => { aRuns += 1 } })
  s.scheduler.ownTime('plugin.b', { name: 'own', everyMs: MINUTE, run: () => { bRuns += 1 } })

  await s.scheduler.tick()
  assert.equal(aRuns, 1)
  assert.equal(bRuns, 1)

  s.clock.advance(MINUTE)
  await s.scheduler.tick()
  assert.equal(aRuns, 1)
  assert.equal(bRuns, 1)
})

test('several ownTime tasks of one plugin share its quota', async (t) => {
  const s = await setup(t, {
    clock: new FakeClock(at(12, 0)),
    settings: { agents: {}, timezone: 'UTC', ownTimePerDay: 1 },
  })
  let runs = 0
  s.scheduler.ownTime('plugin.own', { name: 'read', everyMs: MINUTE, run: () => { runs += 1 } })
  s.scheduler.ownTime('plugin.own', { name: 'write', everyMs: MINUTE, run: () => { runs += 1 } })
  await s.scheduler.tick()
  assert.equal(runs, 1)
})

test('every and at share the 1,440-a-day cap', async (t) => {
  const s = await setup(t, { clock: new FakeClock(at(12, 0)) })
  let runs = 0
  for (let index = 0; index < 1_441; index += 1) {
    s.scheduler.at('plugin.poll', s.clock.now() - 1, () => { runs += 1 })
  }
  s.scheduler.every('plugin.poll', MINUTE, () => { runs += 1 })
  await s.scheduler.tick()
  assert.equal(runs, 1_440)

  s.clock.advance(MINUTE)
  await s.scheduler.tick()
  assert.equal(runs, 1_440, 'over the cap the every task is dropped, not queued')

  s.clock.set(at(12, 0, 8))
  await s.scheduler.tick()
  assert.equal(runs, 1_442, 'the leftover at and the every task run on the next day')
})

test('the every and at day count survives a restart', async (t) => {
  const s = await setup(t, { clock: new FakeClock(at(12, 0)) })
  let runs = 0
  for (let index = 0; index < DEFAULT_SCHEDULED_PER_DAY; index += 1) {
    s.scheduler.at('plugin.poll', s.clock.now() - 1, () => { runs += 1 })
  }
  await s.scheduler.tick()
  assert.equal(runs, DEFAULT_SCHEDULED_PER_DAY)

  const rebuilt = s.make()
  let more = 0
  rebuilt.at('plugin.poll', s.clock.now() - 1, () => { more += 1 })
  await rebuilt.tick()
  assert.equal(more, 0, 'the persisted count still holds the cap')

  s.clock.set(at(12, 0, 8))
  await rebuilt.tick()
  assert.equal(more, 1, 'a new natural day restores the cap')
})

test('cancelling a registration stops it firing', async (t) => {
  const s = await setup(t, { clock: new FakeClock(at(12, 0)) })
  let runs = 0
  const cancelEvery = s.scheduler.every('p', MINUTE, () => { runs += 1 })
  const cancelAt = s.scheduler.at('p', s.clock.now() - 1, () => { runs += 1 })
  const cancelOwn = s.scheduler.ownTime('p', { name: 'own', everyMs: MINUTE, run: () => { runs += 1 } })
  cancelEvery()
  cancelAt()
  cancelOwn()
  s.clock.advance(HOUR)
  await s.scheduler.tick()
  assert.equal(runs, 0)
  // Cancelling twice is harmless.
  cancelOwn()
  cancelEvery()
})

test('a run can cancel a task that was due in the same tick', async (t) => {
  const s = await setup(t, { clock: new FakeClock(at(12, 0)) })
  let secondRuns = 0
  let cancelSecond = (): void => {}
  s.scheduler.every('p', MINUTE, () => { cancelSecond() })
  cancelSecond = s.scheduler.every('p', MINUTE, () => { secondRuns += 1 })
  s.clock.advance(MINUTE)
  await s.scheduler.tick()
  assert.equal(secondRuns, 0)
})

test('a throwing run is logged, still counts, and leaves other tasks alone', async (t) => {
  const s = await setup(t, {
    clock: new FakeClock(at(12, 0)),
    settings: { agents: {}, timezone: 'UTC', ownTimePerDay: 1 },
  })
  let ownRuns = 0
  let everyRuns = 0
  s.scheduler.ownTime('plugin.own', {
    name: 'own',
    everyMs: MINUTE,
    run: () => { ownRuns += 1; throw new Error('boom') },
  })
  s.scheduler.every('plugin.poll', MINUTE, () => { everyRuns += 1 })

  await s.scheduler.tick()
  assert.equal(ownRuns, 1)
  const failed = s.log.named('scheduler.task_failed')
  assert.equal(failed.length, 1)
  assert.equal(failed[0]?.fields?.plugin, 'plugin.own')
  assert.equal(failed[0]?.level, 'error')

  s.clock.advance(MINUTE)
  await s.scheduler.tick()
  assert.equal(ownRuns, 1, 'the failed run spent the day quota')
  assert.equal(everyRuns, 1, 'the other task still ran')
})

test('a run that rejects asynchronously is logged and does not stop the tick', async (t) => {
  const s = await setup(t, {
    clock: new FakeClock(at(12, 0)),
    settings: { agents: {}, timezone: 'UTC', ownTimePerDay: 1 },
  })
  let everyRuns = 0
  s.scheduler.ownTime('plugin.own', {
    name: 'own',
    everyMs: MINUTE,
    run: async () => { throw new Error('boom') },
  })
  s.scheduler.every('plugin.poll', MINUTE, () => { everyRuns += 1 })

  await s.scheduler.tick()
  const failed = s.log.named('scheduler.task_failed')
  assert.equal(failed.length, 1)
  assert.equal(failed[0]?.fields?.plugin, 'plugin.own')

  s.clock.advance(MINUTE)
  await s.scheduler.tick()
  assert.equal(everyRuns, 1, 'the other task still ran')
  assert.equal(s.log.named('scheduler.task_failed').length, 1, 'the rejected run spent the day quota')
})

test('a still-running task is skipped without spending quota', async (t) => {
  const s = await setup(t, {
    clock: new FakeClock(at(12, 0)),
    settings: { agents: {}, timezone: 'UTC', ownTimePerDay: 2 },
  })
  let runs = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  s.scheduler.ownTime('plugin.own', {
    name: 'own',
    everyMs: MINUTE,
    run: async () => { runs += 1; await gate },
  })

  const first = s.scheduler.tick()
  await settle(() => runs === 1)
  s.clock.advance(MINUTE)
  await s.scheduler.tick()
  assert.equal(runs, 1, 'the overlapping occurrence is skipped')
  release()
  await first

  s.clock.advance(MINUTE)
  await s.scheduler.tick()
  assert.equal(runs, 2, 'the skip did not spend the second slot')
  s.clock.advance(MINUTE)
  await s.scheduler.tick()
  assert.equal(runs, 2, 'and the quota is now spent')
})

test('a slow run does not hold up the rest of its tick', async (t) => {
  const s = await setup(t, { clock: new FakeClock(at(12, 0)) })
  let aRuns = 0
  let bRuns = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  s.scheduler.every('plugin.a', MINUTE, async () => { aRuns += 1; await gate })
  s.scheduler.every('plugin.b', MINUTE, () => { bRuns += 1 })
  s.clock.advance(MINUTE)

  const ticking = s.scheduler.tick()
  await settle(() => bRuns === 1)
  assert.equal(aRuns, 1)
  assert.equal(bRuns, 1, 'the second plugin ran while the first run was still pending')

  // The accounting was written before the slow run finished, so a restart would not repeat it.
  await waitForStateFile(s.stateFile)
  const stored = JSON.parse(await readFile(s.stateFile, 'utf8')) as { scheduled: Record<string, { count?: number }> }
  assert.equal(stored.scheduled['plugin.a']?.count, 1)
  assert.equal(stored.scheduled['plugin.b']?.count, 1)

  release()
  await ticking
  s.clock.advance(MINUTE)
  await s.scheduler.tick()
  assert.equal(aRuns, 2, 'the next occurrence is due normally once the run finished')
})

test('a rebuilt scheduler keeps ownTime last-run and the day count', async (t) => {
  const s = await setup(t, {
    clock: new FakeClock(at(12, 0)),
    settings: { agents: {}, timezone: 'UTC', ownTimePerDay: 2 },
  })
  let runs = 0
  s.scheduler.ownTime('plugin.own', { name: 'own', everyMs: MINUTE, run: () => { runs += 1 } })
  await s.scheduler.tick()
  s.clock.advance(MINUTE)
  await s.scheduler.tick()
  assert.equal(runs, 2)

  const stored = JSON.parse(await readFile(s.stateFile, 'utf8')) as {
    ownTime: Record<string, { lastAt?: number; day?: string; count?: number }>
  }
  assert.equal(stored.ownTime['plugin.own/own']?.lastAt, at(12, 0, 7) + MINUTE)
  assert.equal(stored.ownTime['plugin.own/own']?.day, '2026-11-07')
  assert.equal(stored.ownTime['plugin.own/own']?.count, 2)

  const rebuilt = s.make()
  let rebuiltRuns = 0
  rebuilt.ownTime('plugin.own', { name: 'own', everyMs: MINUTE, run: () => { rebuiltRuns += 1 } })
  await rebuilt.tick()
  assert.equal(rebuiltRuns, 0, 'a fresh registration would be due at once; the file says it is not')

  s.clock.advance(MINUTE)
  await rebuilt.tick()
  assert.equal(rebuiltRuns, 0, 'the persisted count still blocks the third run')

  s.clock.set(at(12, 0, 8))
  await rebuilt.tick()
  assert.equal(rebuiltRuns, 1, 'the next day restores the quota')

  const restarted = JSON.parse(await readFile(s.stateFile, 'utf8')) as {
    ownTime: Record<string, { lastAt?: number; day?: string; count?: number }>
  }
  assert.equal(restarted.ownTime['plugin.own/own']?.day, '2026-11-08')
  assert.equal(restarted.ownTime['plugin.own/own']?.count, 1)
})

test('a rebuilt ownTime does not fire early while its quota is left', async (t) => {
  // The default quota is six; only one run is used, so `lastAt` alone has to hold the next run back.
  const s = await setup(t, { clock: new FakeClock(at(12, 0)) })
  let runs = 0
  s.scheduler.ownTime('plugin.own', { name: 'own', everyMs: MINUTE, run: () => { runs += 1 } })
  await s.scheduler.tick()
  assert.equal(runs, 1)

  s.clock.advance(MINUTE / 2)
  const rebuilt = s.make()
  let rebuiltRuns = 0
  rebuilt.ownTime('plugin.own', { name: 'own', everyMs: MINUTE, run: () => { rebuiltRuns += 1 } })
  await rebuilt.tick()
  assert.equal(rebuiltRuns, 0, 'the persisted last run still holds the next run back')

  s.clock.advance(MINUTE / 2)
  await rebuilt.tick()
  assert.equal(rebuiltRuns, 1, 'it fires once the interval from the persisted last run has passed')
})

test('a missing or damaged state file counts as empty', async (t) => {
  const s = await setup(t, { clock: new FakeClock(at(12, 0)) })
  await mkdir(path.dirname(s.stateFile), { recursive: true })
  await writeFile(s.stateFile, '{ this is not json')
  let runs = 0
  s.scheduler.ownTime('plugin.own', { name: 'own', everyMs: MINUTE, run: () => { runs += 1 } })
  await s.scheduler.tick()
  assert.equal(runs, 1)

  await writeFile(s.stateFile, JSON.stringify({ version: 1, ownTime: [], scheduled: 'nope' }))
  const again = s.make()
  let againRuns = 0
  again.ownTime('plugin.own', { name: 'own', everyMs: MINUTE, run: () => { againRuns += 1 } })
  await again.tick()
  assert.equal(againRuns, 1)
})

test('damaged state entries are dropped and sound ones kept', () => {
  const parsed = parseState({
    ownTime: {
      'p/negative': { lastAt: -1, day: '2026-11-07', count: 1 },
      'p/string': { lastAt: '120000', day: '2026-11-07', count: 1 },
      'p/badDay': { lastAt: 120_000, day: '11/07/2026', count: 2 },
      'p/fraction': { lastAt: 120_000, day: '2026-11-07', count: 1.5 },
      'p/good': { lastAt: 120_000, day: '2026-11-07', count: 2 },
      'p/notObject': 42,
    },
    scheduled: {
      p: { day: '2026-11-07', count: 7 },
      q: { day: 'x', count: 1.5 },
      r: [],
    },
  })
  assert.deepEqual(parsed.ownTime['p/negative'], { day: '2026-11-07', count: 1 })
  assert.deepEqual(parsed.ownTime['p/string'], { day: '2026-11-07', count: 1 })
  assert.deepEqual(parsed.ownTime['p/badDay'], { lastAt: 120_000, count: 2 })
  assert.deepEqual(parsed.ownTime['p/fraction'], { lastAt: 120_000, day: '2026-11-07' })
  assert.deepEqual(parsed.ownTime['p/good'], { lastAt: 120_000, day: '2026-11-07', count: 2 })
  assert.equal(parsed.ownTime['p/notObject'], undefined)
  assert.deepEqual(parsed.scheduled.p, { day: '2026-11-07', count: 7 })
  assert.deepEqual(parsed.scheduled.q, {})
  assert.equal(parsed.scheduled.r, undefined)
  assert.deepEqual(parseState({ ownTime: [] }).ownTime, {})
})

test('a failing settings read skips the tick and recovers', async (t) => {
  const s = await setup(t, { clock: new FakeClock(at(12, 0)) })
  let failing = true
  const scheduler = createScheduler({
    clock: s.clock,
    log: s.log,
    settings: async () => {
      if (failing) throw new Error('settings unavailable')
      return SETTINGS
    },
    stateFile: s.stateFile,
  })
  let runs = 0
  scheduler.every('plugin.poll', MINUTE, () => { runs += 1 })
  s.clock.advance(MINUTE)

  await scheduler.tick()
  assert.equal(runs, 0)
  const failed = s.log.named('scheduler.settings_failed')
  assert.equal(failed.length, 1)
  assert.equal(failed[0]?.level, 'warn')

  failing = false
  await scheduler.tick()
  assert.equal(runs, 1, 'the next tick with settings runs normally')
})

test('a failing state write is logged and the tick does not throw', async (t) => {
  const s = await setup(t, { clock: new FakeClock(at(12, 0)) })
  const blocked = path.join(s.root, 'blocked')
  await writeFile(blocked, 'a file where the state directory would go')
  const scheduler = createScheduler({
    clock: s.clock,
    log: s.log,
    settings: async () => SETTINGS,
    stateFile: path.join(blocked, 'scheduler.json'),
  })
  let runs = 0
  scheduler.every('plugin.poll', MINUTE, () => { runs += 1 })
  s.clock.advance(MINUTE)

  await assert.doesNotReject(scheduler.tick())
  assert.equal(runs, 1)
  const failed = s.log.named('scheduler.state_failed')
  assert.equal(failed.length, 1)
  assert.equal(failed[0]?.level, 'error')
})


test('ownTime names are validated and duplicates conflict', async (t) => {
  const s = await setup(t)
  for (const name of ['', 'UPPER', 'a b', 'a'.repeat(33), 'bad/name', '中文']) {
    throwsCode(() => s.scheduler.ownTime('p', { name, everyMs: MINUTE, run: () => undefined }), 'INVALID_ARGUMENT')
  }
  throwsCode(() => s.scheduler.ownTime('p', undefined as never), 'INVALID_ARGUMENT')
  throwsCode(() => s.scheduler.ownTime('p', { name: 'ok', everyMs: MINUTE } as never), 'INVALID_ARGUMENT')
  const cancel = s.scheduler.ownTime('p', { name: 'a'.repeat(32), everyMs: MINUTE, run: () => undefined })
  throwsCode(() => s.scheduler.ownTime('p', { name: 'a'.repeat(32), everyMs: MINUTE, run: () => undefined }), 'CONFLICT')
  // The same name belongs to different plugins.
  const other = s.scheduler.ownTime('q', { name: 'a'.repeat(32), everyMs: MINUTE, run: () => undefined })
  cancel()
  other()
  // After cancelling, the name is free again.
  s.scheduler.ownTime('p', { name: 'a'.repeat(32), everyMs: MINUTE, run: () => undefined })
})

test('start ticks every 30 seconds and stop clears the timer', async (t) => {
  assert.equal(DEFAULT_TICK_MS, 30_000)
  const s = await setup(t)
  const globalTimers = globalThis as unknown as { setInterval: typeof setInterval; clearInterval: typeof clearInterval }
  const originalSet = globalTimers.setInterval
  const originalClear = globalTimers.clearInterval
  let callback: (() => void) | undefined
  let cleared: unknown
  let setCalls = 0
  globalTimers.setInterval = ((fn: () => void, ms?: number) => {
    setCalls += 1
    assert.equal(ms, DEFAULT_TICK_MS)
    callback = fn
    return 1 as unknown as ReturnType<typeof setInterval>
  }) as unknown as typeof setInterval
  globalTimers.clearInterval = ((handle: unknown) => { cleared = handle }) as unknown as typeof clearInterval
  t.after(() => {
    globalTimers.setInterval = originalSet
    globalTimers.clearInterval = originalClear
  })

  let runs = 0
  s.scheduler.every('p', MINUTE, () => { runs += 1 })
  s.clock.advance(MINUTE)
  s.scheduler.start()
  s.scheduler.start()
  assert.equal(setCalls, 1, 'start is idempotent')
  assert.ok(callback !== undefined)
  callback()
  await settle(() => runs > 0)
  assert.equal(runs, 1)
  // The tick continues with its state write after the run returns; let it finish before cleanup.
  await waitForStateFile(s.stateFile)

  s.scheduler.stop()
  assert.equal(cleared, 1)
  s.scheduler.stop()
  assert.equal(cleared, 1, 'a second stop does not clear anything else')
})
