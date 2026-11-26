import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createPollingController,
  POLL_INTERVALS,
  type PollingTimers,
} from '../../web/src/data/polling.ts'

interface ScheduledTask {
  readonly id: number
  readonly runAt: number
  readonly callback: () => void
  cancelled: boolean
}

function createFakeClock(startMs = 1_000): {
  readonly timers: PollingTimers
  readonly now: () => number
  readonly pendingCount: () => number
  advanceBy: (ms: number) => Promise<void>
} {
  let currentTime = startMs
  let nextId = 1
  const tasks: ScheduledTask[] = []

  const timers: PollingTimers = {
    setTimeout(callback, ms) {
      const id = nextId++
      tasks.push({ id, runAt: currentTime + ms, callback, cancelled: false })
      return id
    },
    clearTimeout(handle) {
      const target = tasks.find((t) => t.id === handle)
      if (target !== undefined) {
        target.cancelled = true
      }
    },
  }

  async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 6; i += 1) {
      await Promise.resolve()
    }
  }

  async function advanceBy(ms: number): Promise<void> {
    const targetTime = currentTime + ms
    while (true) {
      let earliestIndex = -1
      let earliestTime = Number.POSITIVE_INFINITY
      for (let i = 0; i < tasks.length; i += 1) {
        const task = tasks[i]
        if (task !== undefined && !task.cancelled && task.runAt <= targetTime && task.runAt < earliestTime) {
          earliestTime = task.runAt
          earliestIndex = i
        }
      }
      if (earliestIndex === -1) break
      const [task] = tasks.splice(earliestIndex, 1)
      if (task === undefined || task.cancelled) continue
      currentTime = task.runAt
      task.callback()
      await flushMicrotasks()
    }
    currentTime = targetTime
    await flushMicrotasks()
  }

  return {
    timers,
    now: () => currentTime,
    pendingCount: () => tasks.filter((t) => !t.cancelled).length,
    advanceBy,
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason?: unknown) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createFakeVisibility(initialVisible = true): {
  readonly isVisible: () => boolean
  readonly subscribeVisibility: (listener: () => void) => () => void
  readonly listenerCount: () => number
  setVisible: (visible: boolean) => void
} {
  let visible = initialVisible
  const listeners = new Set<() => void>()
  return {
    isVisible: () => visible,
    subscribeVisibility(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    listenerCount: () => listeners.size,
    setVisible(next) {
      visible = next
      for (const listener of [...listeners]) {
        listener()
      }
    },
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve()
  }
}

test('POLL_INTERVALS matches §9.2 specification values verbatim', () => {
  assert.deepEqual(POLL_INTERVALS, {
    satelliteActivePulseMs: 2_000,
    satelliteActiveOtherMs: 5_000,
    satelliteBackgroundMs: 10_000,
    accountingActiveMs: 30_000,
    accountingBackgroundMs: 60_000,
    chatActiveMs: 2_000,
    memoryActiveMs: 10_000,
    proposalsActiveMs: 30_000,
    proposalsBackgroundMs: 120_000,
    pluginsActiveMs: 15_000,
    pluginsBackgroundMs: 120_000,
  })
})

test('monotonic sequence race protection: out-of-order stale response #1 resolving after #2 is discarded', async () => {
  const clock = createFakeClock()
  const vis = createFakeVisibility(true)
  const req1 = createDeferred<string>()
  const req2 = createDeferred<string>()
  let callIndex = 0
  const received: string[] = []

  const controller = createPollingController<string>({
    fetcher: () => {
      callIndex += 1
      return callIndex === 1 ? req1.promise : req2.promise
    },
    intervalMs: 5_000,
    onData: (data) => received.push(data),
    isVisible: vis.isVisible,
    subscribeVisibility: vis.subscribeVisibility,
    timers: clock.timers,
    now: clock.now,
  })

  controller.start()
  assert.equal(callIndex, 1)
  assert.equal(controller.getState().loading, true)

  // Trigger a second request while request #1 is still in flight
  const refreshPromise = controller.refresh()
  assert.equal(callIndex, 2)

  // Request #2 resolves first
  req2.resolve('fresh-2')
  const refreshResult = await refreshPromise
  assert.equal(refreshResult, 'fresh-2')
  assert.deepEqual(received, ['fresh-2'])
  assert.equal(controller.getState().data, 'fresh-2')
  assert.equal(controller.getState().loading, false)
  assert.equal(clock.pendingCount(), 1)

  // Now stale request #1 finally resolves — must be silently discarded
  req1.resolve('stale-1')
  await flushMicrotasks()
  assert.deepEqual(received, ['fresh-2'])
  assert.equal(controller.getState().data, 'fresh-2')
  assert.equal(clock.pendingCount(), 1)

  controller.dispose()
})

test('monotonic sequence race protection: stale error from #1 after #2 succeeds is discarded', async () => {
  const clock = createFakeClock()
  const vis = createFakeVisibility(true)
  const req1 = createDeferred<string>()
  const req2 = createDeferred<string>()
  let callIndex = 0
  const errors: unknown[] = []

  const controller = createPollingController<string>({
    fetcher: () => {
      callIndex += 1
      return callIndex === 1 ? req1.promise : req2.promise
    },
    intervalMs: 5_000,
    onError: (err) => errors.push(err),
    isVisible: vis.isVisible,
    subscribeVisibility: vis.subscribeVisibility,
    timers: clock.timers,
    now: clock.now,
  })

  controller.start()
  const p2 = controller.refresh()
  req2.resolve('ok-2')
  await p2

  req1.reject(new Error('stale failure'))
  await flushMicrotasks()

  assert.equal(errors.length, 0)
  assert.equal(controller.getState().data, 'ok-2')
  assert.equal(controller.getState().error, undefined)

  controller.dispose()
})

test('pauses timers while hidden and immediately refreshes + resumes on becoming visible', async () => {
  const clock = createFakeClock()
  const vis = createFakeVisibility(true)
  let fetchCount = 0
  const received: number[] = []

  const controller = createPollingController<number>({
    fetcher: async () => {
      fetchCount += 1
      return fetchCount
    },
    intervalMs: 2_000,
    onData: (n) => received.push(n),
    isVisible: vis.isVisible,
    subscribeVisibility: vis.subscribeVisibility,
    timers: clock.timers,
    now: clock.now,
  })

  controller.start()
  await flushMicrotasks()
  assert.deepEqual(received, [1])
  assert.equal(clock.pendingCount(), 1)

  // Normal interval tick while visible
  await clock.advanceBy(2_000)
  assert.deepEqual(received, [1, 2])

  // Hide page — pending timer cleared, advancing time triggers zero fetches
  vis.setVisible(false)
  assert.equal(clock.pendingCount(), 0)
  await clock.advanceBy(20_000)
  assert.deepEqual(received, [1, 2])
  assert.equal(fetchCount, 2)

  // Become visible again — immediately refreshes and resumes periodic timer
  vis.setVisible(true)
  await flushMicrotasks()
  assert.deepEqual(received, [1, 2, 3])
  assert.equal(clock.pendingCount(), 1)

  await clock.advanceBy(2_000)
  assert.deepEqual(received, [1, 2, 3, 4])

  controller.dispose()
})

test('skips initial fetch if started while hidden and fetches when becoming visible', async () => {
  const clock = createFakeClock()
  const vis = createFakeVisibility(false)
  let fetchCount = 0

  const controller = createPollingController<number>({
    fetcher: async () => {
      fetchCount += 1
      return fetchCount
    },
    intervalMs: 2_000,
    isVisible: vis.isVisible,
    subscribeVisibility: vis.subscribeVisibility,
    timers: clock.timers,
    now: clock.now,
  })

  controller.start()
  await flushMicrotasks()
  assert.equal(fetchCount, 0)
  assert.equal(clock.pendingCount(), 0)

  await clock.advanceBy(10_000)
  assert.equal(fetchCount, 0)

  vis.setVisible(true)
  await flushMicrotasks()
  assert.equal(fetchCount, 1)
  assert.equal(controller.getState().data, 1)

  controller.dispose()
})

test('enabled: false suppresses polling until re-enabled, and disabling stops pending polls', async () => {
  const clock = createFakeClock()
  const vis = createFakeVisibility(true)
  let fetchCount = 0

  const controller = createPollingController<number>({
    fetcher: async () => {
      fetchCount += 1
      return fetchCount
    },
    intervalMs: 3_000,
    enabled: false,
    isVisible: vis.isVisible,
    subscribeVisibility: vis.subscribeVisibility,
    timers: clock.timers,
    now: clock.now,
  })

  controller.start()
  await flushMicrotasks()
  await clock.advanceBy(10_000)
  assert.equal(fetchCount, 0)
  assert.equal(clock.pendingCount(), 0)

  // Visibility toggle while disabled must NOT trigger fetch
  vis.setVisible(false)
  vis.setVisible(true)
  await flushMicrotasks()
  assert.equal(fetchCount, 0)

  // Enable — starts fetching immediately and polls on interval
  controller.setEnabled(true)
  await flushMicrotasks()
  assert.equal(fetchCount, 1)
  await clock.advanceBy(3_000)
  assert.equal(fetchCount, 2)

  // Disable again — clears timers and prevents future polls
  controller.setEnabled(false)
  assert.equal(clock.pendingCount(), 0)
  await clock.advanceBy(15_000)
  assert.equal(fetchCount, 2)

  controller.dispose()
})

test('manual refresh() fetches on demand and resets interval timer without starting background loop when disabled', async () => {
  const clock = createFakeClock()
  const vis = createFakeVisibility(true)
  let fetchCount = 0

  const controller = createPollingController<number>({
    fetcher: async () => {
      fetchCount += 1
      return fetchCount
    },
    intervalMs: 5_000,
    enabled: false,
    isVisible: vis.isVisible,
    subscribeVisibility: vis.subscribeVisibility,
    timers: clock.timers,
    now: clock.now,
  })

  controller.start()
  const val = await controller.refresh()
  assert.equal(val, 1)
  assert.equal(controller.getState().data, 1)
  assert.equal(clock.pendingCount(), 0)

  // Now enable and verify manual refresh resets the periodic timer
  controller.setEnabled(true)
  await flushMicrotasks()
  assert.equal(fetchCount, 2)

  await clock.advanceBy(3_000)
  assert.equal(fetchCount, 2)
  await controller.refresh()
  assert.equal(fetchCount, 3)

  // 3s after manual refresh is still before the reset 5s interval
  await clock.advanceBy(3_000)
  assert.equal(fetchCount, 3)
  await clock.advanceBy(2_000)
  assert.equal(fetchCount, 4)

  controller.dispose()
})

test('errors propagate cleanly via onError without killing future polls, and subsequent success clears error', async () => {
  const clock = createFakeClock()
  const vis = createFakeVisibility(true)
  const errors: unknown[] = []
  const values: string[] = []
  let attempt = 0

  const err401 = Object.assign(new Error('UNAUTHENTICATED'), { status: 401, code: 'UNAUTHENTICATED' })

  const controller = createPollingController<string>({
    fetcher: async () => {
      attempt += 1
      if (attempt === 1) return 'initial-ok'
      if (attempt === 2) throw err401
      return 'recovered-ok'
    },
    intervalMs: 2_000,
    onData: (v) => values.push(v),
    onError: (e) => errors.push(e),
    isVisible: vis.isVisible,
    subscribeVisibility: vis.subscribeVisibility,
    timers: clock.timers,
    now: clock.now,
  })

  controller.start()
  await flushMicrotasks()
  assert.deepEqual(values, ['initial-ok'])
  assert.equal(errors.length, 0)

  // Second poll fails with 401 error
  await clock.advanceBy(2_000)
  assert.equal(errors.length, 1)
  assert.equal(errors[0], err401)
  assert.equal(controller.getState().error, err401)
  // Last good data is preserved on transient error
  assert.equal(controller.getState().data, 'initial-ok')
  assert.equal(controller.getState().loading, false)
  // Future poll is STILL scheduled
  assert.equal(clock.pendingCount(), 1)

  // Third poll succeeds and clears error
  await clock.advanceBy(2_000)
  assert.deepEqual(values, ['initial-ok', 'recovered-ok'])
  assert.equal(controller.getState().data, 'recovered-ok')
  assert.equal(controller.getState().error, undefined)

  controller.dispose()
})

test('dispose() clears timers, unsubscribes visibility, aborts in-flight fetch, and suppresses all post-dispose updates', async () => {
  const clock = createFakeClock()
  const vis = createFakeVisibility(true)
  const pending = createDeferred<string>()
  const received: string[] = []
  const errors: unknown[] = []
  const stateChanges: number[] = []
  let aborted = false

  const controller = createPollingController<string>({
    fetcher: (signal) => {
      signal?.addEventListener('abort', () => {
        aborted = true
      })
      return pending.promise
    },
    intervalMs: 2_000,
    onData: (v) => received.push(v),
    onError: (e) => errors.push(e),
    onStateChange: () => stateChanges.push(1),
    isVisible: vis.isVisible,
    subscribeVisibility: vis.subscribeVisibility,
    timers: clock.timers,
    now: clock.now,
  })

  controller.start()
  assert.equal(vis.listenerCount(), 1)
  const changesBeforeDispose = stateChanges.length

  controller.dispose()
  assert.equal(aborted, true)
  assert.equal(vis.listenerCount(), 0)
  assert.equal(clock.pendingCount(), 0)

  // Resolving in-flight promise after dispose must NOT deliver data or state changes
  pending.resolve('late-after-dispose')
  await flushMicrotasks()
  assert.deepEqual(received, [])
  assert.deepEqual(errors, [])
  assert.equal(stateChanges.length, changesBeforeDispose)

  // Subsequent refresh/start/visibility changes are safe no-ops
  const res = await controller.refresh()
  assert.equal(res, undefined)
  controller.start()
  vis.setVisible(false)
  vis.setVisible(true)
  await clock.advanceBy(10_000)
  assert.deepEqual(received, [])
  assert.equal(clock.pendingCount(), 0)
})
