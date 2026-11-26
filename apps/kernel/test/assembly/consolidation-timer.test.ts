import assert from 'node:assert/strict'
import test from 'node:test'
import { BrainError } from '@brain-core/sdk'
import { createConsolidationTimer, DEFAULT_CONSOLIDATION_INTERVAL_MS } from '../../src/consolidation-timer.ts'
import type {
  Clock, ConsolidationApplyReport, ConsolidationEngine, ConsolidationProposal, RuntimeSettings,
} from '../../src/contracts/index.ts'
import type { LogFields } from '../../src/log/index.ts'
import type { Job, JobRunner } from '../../src/memory-api/index.ts'
import { createWorkingMemoryStore } from '../../src/working-memory/index.ts'

function utcMs(year: number, month: number, day: number, hour: number, minute = 0): number {
  return Date.UTC(year, month - 1, day, hour, minute, 0, 0)
}

function makeFakeSetup(options: {
  initialNow: number
  settings?: () => Promise<RuntimeSettings>
  hasConsolidation?: boolean
  initialWatermark?: number
  dailyTokenCap?: number
  usedTokensToday?: number
  jobStartsThrow?: BrainError
  initialJobStatus?: Job['status']
} ) {
  let now = options.initialNow
  const clock: Clock = { now: () => now }
  const events: { readonly level: string; readonly event: string; readonly fields?: LogFields }[] = []
  const log = {
    info: (event: string, fields?: LogFields) => { events.push({ level: 'info', event, fields }) },
    warn: (event: string, fields?: LogFields) => { events.push({ level: 'warn', event, fields }) },
    error: (event: string, fields?: LogFields) => { events.push({ level: 'error', event, fields }) },
  }

  const workingMemory = createWorkingMemoryStore({ clock })
  const recorded: unknown[] = []
  const startedJobs: unknown[] = []
  let watermark = options.initialWatermark ?? 0
  let usedTokensToday = options.usedTokensToday ?? 0
  const dailyTokenCap = options.dailyTokenCap ?? 200_000
  let currentJobStatus: Job['status'] = options.initialJobStatus ?? 'done'

  const jobs: JobRunner = {
    start(request) {
      if (options.jobStartsThrow !== undefined) throw options.jobStartsThrow
      startedJobs.push(request)
      currentJobStatus = 'queued'
      return { id: `job_${startedJobs.length}`, type: 'consolidate', status: 'queued', createdAt: now }
    },
    get(id) {
      return { id, type: 'consolidate', status: currentJobStatus, createdAt: now }
    },
    health: () => 'ok',
    idle: async () => undefined,
  }

  const consolidation: ConsolidationEngine | undefined = options.hasConsolidation === false
    ? undefined
    : {
        async runShadow(): Promise<ConsolidationProposal> {
          throw new Error('unused')
        },
        async listProposals() { return [] },
        async getProposal() { return null },
        async approveProposal(): Promise<ConsolidationApplyReport> {
          return { proposalId: 'p', l2Created: 0, correctionsApplied: 0, conflictsResolved: 0, personsUpdated: 0 }
        },
        async rejectProposal(): Promise<ConsolidationProposal> {
          throw new Error('unused')
        },
        async budgetStatus() {
          return { usedTokensToday, dailyTokenCap, lastConsolidatedTo: watermark }
        },
      }

  const memory = {
    service: {
      async ingest() { return { id: 'l0_1' } },
      async record(input: unknown) {
        recorded.push(input)
        return {} as never
      },
      async update() { return {} as never },
      async remove() {},
      async search() { return { items: [], degraded: false } },
      async context() { return { profileVersion: 0, stable: '', blocks: [], truncated: false } },
      async forget() { return { tombstoned: 0, invalidated: 0, l3Flagged: 0 } },
      async health() { return { store: 'ok' } as const },
      async flush() {},
    },
    jobs,
    workingMemory,
    ...(consolidation === undefined ? {} : { consolidation }),
  }

  const timer = createConsolidationTimer({
    memory,
    clock,
    log,
    settings: options.settings ?? (async () => ({ agents: {}, timezone: 'UTC', quietHours: [2, 6] })),
  })

  return {
    timer,
    workingMemory,
    recorded,
    startedJobs,
    events,
    setNow(next: number) { now = next },
    setWatermark(next: number) { watermark = next },
    setUsedTokens(next: number) { usedTokensToday = next },
    setJobStatus(next: Job['status']) { currentJobStatus = next },
  }
}

test('runOnce sweeps expired working memory and promotes flagged items to L1 outside quiet hours', async () => {
  const f = makeFakeSetup({
    initialNow: utcMs(2026, 11, 19, 14, 0),
  })
  await f.workingMemory.put({
    channel: 'qq:private:u1',
    key: 'temp_note',
    text: '一会儿记得确认快递',
    ttlMs: 60_000,
  })
  await f.workingMemory.put({
    channel: 'qq:private:u1',
    key: 'long_fact',
    text: '对花生过敏',
    ttlMs: 60_000,
    promoteToL1: true,
    evidence: [{ id: 'l0_01JAAAAAAAAAAAAAAAAAAAAAAA' }],
  })
  await f.workingMemory.put({
    channel: 'qq:private:u1',
    key: 'still_active',
    text: '正在聊电影',
    ttlMs: 3_600_000,
  })

  f.setNow(utcMs(2026, 11, 19, 14, 5))
  await f.timer.runOnce()

  assert.equal(f.recorded.length, 1)
  const rec = f.recorded[0] as { kind: string; content: { key: string; text: string }; evidence: Array<{ id: string }> }
  assert.equal(rec.kind, 'l1.fact')
  assert.deepEqual(rec.content, { key: 'long_fact', text: '对花生过敏' })
  assert.deepEqual(rec.evidence, [{ id: 'l0_01JAAAAAAAAAAAAAAAAAAAAAAA' }])

  const active = await f.workingMemory.listActive('qq:private:u1')
  assert.deepEqual(active.map((item) => item.key), ['still_active'])
  assert.equal(f.startedJobs.length, 0, 'outside quiet hours, no consolidation job starts')
})

test('runOnce triggers consolidation once per quiet-hours window using owner timezone and advances next day', async () => {
  // 2026-11-18 18:30Z = 2026-11-19 02:30 Asia/Shanghai (inside [2, 6])
  const f = makeFakeSetup({
    initialNow: utcMs(2026, 11, 18, 18, 30),
    settings: async () => ({ agents: {}, timezone: 'Asia/Shanghai', quietHours: [2, 6] }),
  })

  await f.timer.runOnce()
  assert.deepEqual(f.startedJobs, [{ type: 'consolidate', from: 0, to: utcMs(2026, 11, 18, 18, 30) }])

  // Same night while still running: skipped
  f.setNow(utcMs(2026, 11, 18, 18, 45))
  await f.timer.runOnce()
  assert.equal(f.startedJobs.length, 1)

  // Finished and watermark advanced to 18:30Z (>= 18:00Z = 02:00 Shanghai): skipped on same night
  f.setJobStatus('done')
  f.setWatermark(utcMs(2026, 11, 18, 18, 30))
  f.setNow(utcMs(2026, 11, 18, 19, 0))
  await f.timer.runOnce()
  assert.equal(f.startedJobs.length, 1)

  // Next night at 02:15 Shanghai (2026-11-19 18:15Z): watermark < 18:00Z -> starts again
  f.setNow(utcMs(2026, 11, 19, 18, 15))
  await f.timer.runOnce()
  assert.equal(f.startedJobs.length, 2)
  assert.deepEqual(f.startedJobs[1], {
    type: 'consolidate',
    from: utcMs(2026, 11, 18, 18, 30),
    to: utcMs(2026, 11, 19, 18, 15),
  })
})

test('midnight-crossing quietHours [23, 5] treats pre- and post-midnight as one nightly window', async () => {
  const f = makeFakeSetup({
    initialNow: utcMs(2026, 11, 19, 23, 30),
    settings: async () => ({ agents: {}, timezone: 'UTC', quietHours: [23, 5] }),
  })

  await f.timer.runOnce()
  assert.equal(f.startedJobs.length, 1)

  f.setJobStatus('done')
  f.setWatermark(utcMs(2026, 11, 19, 23, 30))
  // After midnight: 2026-11-20 02:00 UTC belongs to the 2026-11-19 23:00 window
  f.setNow(utcMs(2026, 11, 20, 2, 0))
  await f.timer.runOnce()
  assert.equal(f.startedJobs.length, 1)
})

test('equal quietHours [3, 3] disables quiet-hours consolidation', async () => {
  const f = makeFakeSetup({
    initialNow: utcMs(2026, 11, 19, 3, 0),
    settings: async () => ({ agents: {}, timezone: 'UTC', quietHours: [3, 3] }),
  })

  await f.timer.runOnce()
  assert.equal(f.startedJobs.length, 0)
})

test('retries when previous run failed, and avoids spamming when capped in the same window', async () => {
  const f = makeFakeSetup({
    initialNow: utcMs(2026, 11, 19, 2, 10),
    dailyTokenCap: 1000,
  })

  await f.timer.runOnce()
  assert.equal(f.startedJobs.length, 1)

  // Simulate job failure without advancing watermark -> retries on next tick
  f.setJobStatus('failed')
  f.setNow(utcMs(2026, 11, 19, 2, 25))
  await f.timer.runOnce()
  assert.equal(f.startedJobs.length, 2)

  // Simulate run finishing capped (watermark didn't advance and usedTokensToday >= dailyTokenCap) -> does not spam same night
  f.setJobStatus('done')
  f.setUsedTokens(1000)
  f.setNow(utcMs(2026, 11, 19, 2, 40))
  await f.timer.runOnce()
  assert.equal(f.startedJobs.length, 2)

  // Next day (token budget reset to 0, watermark still 0) -> catches up
  f.setUsedTokens(0)
  f.setNow(utcMs(2026, 11, 20, 2, 10))
  await f.timer.runOnce()
  assert.equal(f.startedJobs.length, 3)
  assert.deepEqual(f.startedJobs[2], { type: 'consolidate', from: 0, to: utcMs(2026, 11, 20, 2, 10) })
})

test('handles missing consolidation engine and CONFLICT silently', async () => {
  const noEngine = makeFakeSetup({
    initialNow: utcMs(2026, 11, 19, 3, 0),
    hasConsolidation: false,
  })
  await assert.doesNotReject(() => noEngine.timer.runOnce())
  assert.equal(noEngine.startedJobs.length, 0)

  const conflict = makeFakeSetup({
    initialNow: utcMs(2026, 11, 19, 3, 0),
    jobStartsThrow: new BrainError('CONFLICT', 'a consolidate job is already running'),
  })
  await assert.doesNotReject(() => conflict.timer.runOnce())
  assert.equal(conflict.events.some((e) => e.event === 'consolidation_timer.start_failed'), false)
})

test('start creates one unrefd interval and stop clears it idempotently', () => {
  const originalSet = globalThis.setInterval
  const originalClear = globalThis.clearInterval
  let createdCount = 0
  let capturedMs = 0
  let unrefCalled = false
  let clearedCount = 0
  try {
    globalThis.setInterval = ((_callback: () => void, ms: number) => {
      createdCount += 1
      capturedMs = ms
      return { unref() { unrefCalled = true } } as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval
    globalThis.clearInterval = (() => {
      clearedCount += 1
    }) as typeof clearInterval

    const f = makeFakeSetup({ initialNow: utcMs(2026, 11, 19, 12, 0) })
    f.timer.start()
    f.timer.start()
    assert.equal(createdCount, 1)
    assert.equal(capturedMs, DEFAULT_CONSOLIDATION_INTERVAL_MS)
    assert.equal(unrefCalled, true)

    f.timer.stop()
    f.timer.stop()
    assert.equal(clearedCount, 1)
  } finally {
    globalThis.setInterval = originalSet
    globalThis.clearInterval = originalClear
  }
})
