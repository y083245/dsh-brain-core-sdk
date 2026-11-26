import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createMessageDebouncer } from '../src/index.ts'
import { createFakeEnv } from './fake-timers.ts'

describe('debounce', () => {
  it('resets quiet timer on consecutive messages and flushes after silence', async () => {
    const env = createFakeEnv(1_000)
    const flushed: { channel: string; items: readonly string[]; at: number }[] = []
    const debouncer = createMessageDebouncer<string>({
      clock: env.clock,
      timers: env.timers,
      minQuietMs: 1_000,
      maxWaitMs: 5_000,
      onFlush: (channel, items) => {
        flushed.push({ channel, items, at: env.clock.now() })
      },
    })

    await debouncer.push('c1', 'a')
    assert.equal(debouncer.pendingCount('c1'), 1)
    assert.equal(env.activeTimerCount(), 1)

    env.advanceBy(700)
    assert.equal(flushed.length, 0)
    await debouncer.push('c1', 'b')
    assert.equal(debouncer.pendingCount('c1'), 2)

    // Still waiting at +700ms since second push (total 1400ms)
    env.advanceBy(700)
    assert.equal(flushed.length, 0)

    // Fires at +300ms (total 2000ms = 1000ms after second push)
    env.advanceBy(300)
    assert.equal(flushed.length, 1)
    assert.deepEqual(flushed[0], { channel: 'c1', items: ['a', 'b'], at: 2_700 })
    assert.equal(debouncer.pendingCount('c1'), 0)
    assert.equal(env.activeTimerCount(), 0)
  })

  it('forces flush at maxWaitMs without starvation', async () => {
    const env = createFakeEnv(0)
    const flushed: { items: readonly number[]; at: number }[] = []
    const debouncer = createMessageDebouncer<number>({
      clock: env.clock,
      timers: env.timers,
      minQuietMs: 1_000,
      maxWaitMs: 2_500,
      onFlush: (_ch, items) => {
        flushed.push({ items, at: env.clock.now() })
      },
    })

    await debouncer.push('g1', 1) // t=0
    env.advanceBy(800)
    await debouncer.push('g1', 2) // t=800
    env.advanceBy(800)
    await debouncer.push('g1', 3) // t=1600, remaining maxWait is 900ms
    env.advanceBy(899)
    assert.equal(flushed.length, 0)

    env.advanceBy(1) // t=2500 -> maxWaitMs hit
    assert.equal(flushed.length, 1)
    assert.deepEqual(flushed[0], { items: [1, 2, 3], at: 2_500 })

    // If push happens when elapsed >= maxWaitMs already, flushes immediately
    await debouncer.push('g1', 4) // t=2500
    env.setNow(5_000) // simulate delayed push without timer firing first? Test direct push check:
    const env2 = createFakeEnv(0)
    let flushCount2 = 0
    const d2 = createMessageDebouncer<number>({
      clock: env2.clock,
      timers: env2.timers,
      minQuietMs: 1_000,
      maxWaitMs: 2_000,
      onFlush: () => {
        flushCount2 += 1
      },
    })
    await d2.push('g2', 1)
    // Jump clock directly past maxWaitMs (testing push branch now - firstPushAt >= maxWaitMs)
    const customClockNow = { now: () => t }
    let t = 0
    let flushCount3 = 0
    const d3 = createMessageDebouncer<number>({
      clock: customClockNow,
      timers: env2.timers,
      minQuietMs: 1_000,
      maxWaitMs: 2_000,
      onFlush: () => {
        flushCount3 += 1
      },
    })
    await d3.push('g3', 1)
    t = 2_000
    await d3.push('g3', 2)
    assert.equal(flushCount3, 1)
    assert.equal(d3.pendingCount('g3'), 0)
    assert.equal(flushCount2, 0)
    d2.dispose()
    d3.dispose()
    debouncer.dispose()
  })

  it('supports quietMs: 0 pass-through, privateMinQuietMs, and multi-channel isolation', async () => {
    const env = createFakeEnv(100)
    const flushed: { channel: string; items: readonly string[] }[] = []
    const debouncer = createMessageDebouncer<string>({
      clock: env.clock,
      timers: env.timers,
      minQuietMs: 1_500,
      maxWaitMs: 5_000,
      privateMinQuietMs: 400,
      onFlush: (channel, items) => {
        flushed.push({ channel, items })
      },
    })

    // quietMs: 0 flushes synchronously without scheduling a timer
    await debouncer.push('direct', 'now', { quietMs: 0 })
    assert.deepEqual(flushed, [{ channel: 'direct', items: ['now'] }])
    assert.equal(env.activeTimerCount(), 0)

    await debouncer.push('priv', 'p1', { channelKind: 'private' })
    await debouncer.push('grp', 'g1', { channelKind: 'group' })

    env.advanceBy(400)
    assert.deepEqual(flushed, [
      { channel: 'direct', items: ['now'] },
      { channel: 'priv', items: ['p1'] },
    ])
    assert.equal(debouncer.pendingCount('grp'), 1)

    env.advanceBy(1_100)
    assert.deepEqual(flushed, [
      { channel: 'direct', items: ['now'] },
      { channel: 'priv', items: ['p1'] },
      { channel: 'grp', items: ['g1'] },
    ])
  })

  it('clears timers cleanly on flushNow, cancel, and dispose', async () => {
    const env = createFakeEnv(0)
    const flushed: { channel: string; items: readonly string[] }[] = []
    const debouncer = createMessageDebouncer<string>({
      clock: env.clock,
      timers: env.timers,
      minQuietMs: 1_000,
      maxWaitMs: 3_000,
      onFlush: (channel, items) => {
        flushed.push({ channel, items })
      },
    })

    await debouncer.push('a', '1')
    await debouncer.push('b', '2')
    await debouncer.push('c', '3')
    assert.equal(env.activeTimerCount(), 3)

    await debouncer.flushNow('a')
    assert.deepEqual(flushed, [{ channel: 'a', items: ['1'] }])
    assert.equal(env.activeTimerCount(), 2)

    debouncer.cancel('b')
    assert.equal(debouncer.pendingCount('b'), 0)
    assert.equal(env.activeTimerCount(), 1)

    debouncer.dispose()
    assert.equal(env.activeTimerCount(), 0)
    assert.equal(debouncer.pendingCount('c'), 0)

    // Pushing after dispose is a safe no-op with zero leaked timers
    await debouncer.push('c', '4')
    assert.equal(env.activeTimerCount(), 0)

    env.advanceBy(10_000)
    assert.deepEqual(flushed, [{ channel: 'a', items: ['1'] }])
  })

  it('validates configuration bounds', () => {
    const env = createFakeEnv(0)
    assert.throws(
      () => createMessageDebouncer({ clock: env.clock, timers: env.timers, minQuietMs: -1, maxWaitMs: 10, onFlush: () => {} }),
      RangeError,
    )
    assert.throws(
      () => createMessageDebouncer({ clock: env.clock, timers: env.timers, minQuietMs: 500, maxWaitMs: 400, onFlush: () => {} }),
      RangeError,
    )
    assert.throws(
      () => createMessageDebouncer({ clock: env.clock, timers: env.timers, minQuietMs: 100, maxWaitMs: 500, privateMinQuietMs: -5, onFlush: () => {} }),
      RangeError,
    )
  })
})
