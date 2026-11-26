import assert from 'node:assert/strict'
import test from 'node:test'
import { FLASH, TICKER_PLUGIN, installPlugin, setup, waitFor } from './helpers.ts'

const SCHEDULER_TICK_MS = 30_000

interface TimerCapture {
  run(ms: number): void
  has(ms: number): boolean
  restore(): void
}

/** Owns setInterval/clearInterval so a test can move time without waiting for real minutes. */
function captureTimers(): TimerCapture {
  const originalSet = globalThis.setInterval
  const originalClear = globalThis.clearInterval
  const active = new Map<object, { readonly callback: () => void; readonly ms: number }>()
  globalThis.setInterval = ((callback: () => void, ms: number) => {
    const handle = { unref() { /* the test drives the timers */ } }
    active.set(handle, { callback, ms })
    return handle as unknown as ReturnType<typeof setInterval>
  }) as typeof setInterval
  globalThis.clearInterval = ((handle: object) => { active.delete(handle) }) as typeof clearInterval
  return {
    run(ms) {
      for (const timer of [...active.values()]) if (timer.ms === ms) timer.callback()
    },
    has(ms) {
      return [...active.values()].some((timer) => timer.ms === ms)
    },
    restore() {
      globalThis.setInterval = originalSet
      globalThis.clearInterval = originalClear
    },
  }
}

test('the kernel starts the scheduler: a plugin every-task runs once its interval is due', async (t) => {
  let now = Date.UTC(2026, 0, 1, 12, 0, 0)
  const clock = { now: () => now }
  const timers = captureTimers()
  let h: Awaited<ReturnType<typeof setup>>
  try {
    h = await setup(t, {
      settings: { agents: { chat: { ...FLASH } }, timezone: 'UTC' },
      apiKey: 'fake-key',
      clock,
    })
    await installPlugin(h.kernel, TICKER_PLUGIN, 'ticker')
  } finally {
    timers.restore()
  }

  assert.equal(timers.has(SCHEDULER_TICK_MS), true, 'the kernel created the scheduler timer')
  const state = (globalThis as { __brainTicker?: { runs: number } }).__brainTicker as { runs: number }
  state.runs = 0

  now += 60_000
  timers.run(SCHEDULER_TICK_MS)
  await waitFor(() => (state.runs >= 1 ? true : undefined), 5_000, 'the scheduled task')
  assert.equal(state.runs, 1)
})
