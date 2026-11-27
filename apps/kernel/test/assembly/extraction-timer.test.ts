import assert from 'node:assert/strict'
import test from 'node:test'
import { BrainError } from '@dsh-brain-core/sdk'
import { createExtractionTimer } from '../../src/extraction-timer.ts'
import type { Job, JobRunner } from '../../src/memory-api/index.ts'
import type { LogFields } from '../../src/log/index.ts'

const LOOKBACK = 7 * 86_400_000
const SETTLE = 600_000

function fakeJobs(initial: Job['status'] = 'done') {
  const started: unknown[] = []
  let status: Job['status'] = initial
  let nextThrows: unknown
  const jobs: JobRunner = {
    start(request) {
      if (nextThrows !== undefined) throw nextThrows
      started.push(request)
      const job: Job = { id: `job-${started.length}`, type: 'extract', status: 'queued', createdAt: 0 }
      status = 'queued'
      return job
    },
    get(id) {
      if (id !== `job-${started.length}` && started.length === 0) throw new BrainError('NOT_FOUND', 'no job')
      return { id, type: 'extract', status, createdAt: 0 } as Job
    },
    health: () => 'ok',
    idle: async () => undefined,
  }
  return { jobs, started, setStatus: (next: Job['status']) => { status = next }, failWith: (error: unknown) => { nextThrows = error } }
}

function setup(overrides: Partial<Parameters<typeof createExtractionTimer>[0]> = {}) {
  const events: { level: string; event: string; fields?: LogFields }[] = []
  const log = {
    info: (event: string, fields?: LogFields) => events.push({ level: 'info', event, fields }),
    warn: (event: string, fields?: LogFields) => events.push({ level: 'warn', event, fields }),
    error: (event: string, fields?: LogFields) => events.push({ level: 'error', event, fields }),
  }
  const clock = { now: () => 1_700_000_000_000 }
  const fake = fakeJobs()
  const timer = createExtractionTimer({
    jobs: overrides.jobs ?? fake.jobs,
    clock: overrides.clock ?? clock,
    log: overrides.log ?? log,
    intervalMs: 600_000,
    settleMs: SETTLE,
    lookbackMs: LOOKBACK,
  })
  return { timer, events, fake, clock }
}

test('runOnce starts one extract for [now - lookback, now - settle] with no channel', () => {
  const { timer, fake, clock } = setup()
  timer.runOnce()
  assert.deepEqual(fake.started, [{ type: 'extract', from: clock.now() - LOOKBACK, to: clock.now() - SETTLE }])
})

test('a queued or running job from this timer keeps the next look quiet; done and failed start again', () => {
  const { timer, fake } = setup()
  fake.setStatus('done')
  timer.runOnce()
  assert.equal(fake.started.length, 1)

  fake.setStatus('queued')
  timer.runOnce()
  assert.equal(fake.started.length, 1)

  fake.setStatus('running')
  timer.runOnce()
  assert.equal(fake.started.length, 1)

  fake.setStatus('done')
  timer.runOnce()
  assert.equal(fake.started.length, 2)

  fake.setStatus('failed')
  timer.runOnce()
  assert.equal(fake.started.length, 3)
})

test('a synchronous start failure is logged by code and never thrown', () => {
  const { timer, fake, events } = setup()
  fake.failWith(new BrainError('UNAVAILABLE', 'extraction is not available'))
  assert.doesNotThrow(() => timer.runOnce())
  const failure = events.find((event) => event.event === 'extraction_timer.start_failed')
  assert.ok(failure)
  assert.equal(failure.fields?.code, 'UNAVAILABLE')
  assert.equal(fake.started.length, 0)
})

test('start creates one interval, unrefs it, and stop clears it twice without an error', () => {
  const originalSet = globalThis.setInterval
  const originalClear = globalThis.clearInterval
  let created: { callback: () => void; ms: number; unrefCalled: boolean } | undefined
  let cleared = 0
  try {
    globalThis.setInterval = ((callback: () => void, ms: number) => {
      created = { callback, ms, unrefCalled: false }
      return { unref() { (created as { unrefCalled: boolean }).unrefCalled = true } } as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval
    globalThis.clearInterval = (() => { cleared += 1 }) as typeof clearInterval

    const { timer, fake } = setup()
    timer.start()
    timer.start()
    assert.ok(created)
    assert.equal(created.ms, 600_000)
    assert.equal(created.unrefCalled, true)

    created.callback()
    assert.equal(fake.started.length, 1)

    const fakeOld = fake.started.length
    timer.stop()
    timer.stop()
    assert.equal(cleared, 1)
    assert.equal(fake.started.length, fakeOld)
  } finally {
    globalThis.setInterval = originalSet
    globalThis.clearInterval = originalClear
  }
})

test('start called twice still creates exactly one interval', () => {
  const originalSet = globalThis.setInterval
  let created = 0
  try {
    globalThis.setInterval = (() => {
      created += 1
      return { unref() { /* nothing to release */ } } as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval
    const { timer } = setup()
    timer.start()
    timer.start()
    assert.equal(created, 1)
    timer.stop()
  } finally {
    globalThis.setInterval = originalSet
  }
})
