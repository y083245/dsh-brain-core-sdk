import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { computeHumanPauseMs, scheduleHumanPause } from '../src/index.ts'
import { createFakeEnv } from './fake-timers.ts'

describe('human-pause', () => {
  it('grows monotonically with text code-point length and shortens on bursts', () => {
    const shortMs = computeHumanPauseMs('好')
    const mediumMs = computeHumanPauseMs('今天晚上一起吃饭吧')
    const longMs = computeHumanPauseMs('这是一段比较长的回复内容，需要更多打字时间来模拟真人的输入节律')

    assert.ok(shortMs < mediumMs)
    assert.ok(mediumMs < longMs)

    const firstMsg = computeHumanPauseMs('我来想想看', { burstIndex: 0 })
    const burstMsg = computeHumanPauseMs('我来想想看', { burstIndex: 1 })
    assert.ok(burstMsg < firstMsg)
  })

  it('applies deterministic jitter with injected rng and clamps to [minMs, maxMs]', () => {
    const low = computeHumanPauseMs('测试一下随机抖动幅度', { jitterRatio: 0.2, rng: () => 0 })
    const mid = computeHumanPauseMs('测试一下随机抖动幅度', { jitterRatio: 0.2, rng: () => 0.5 })
    const high = computeHumanPauseMs('测试一下随机抖动幅度', { jitterRatio: 0.2, rng: () => 1 })
    const noJitter = computeHumanPauseMs('测试一下随机抖动幅度', { jitterRatio: 0, rng: () => 1 })

    assert.ok(low < mid)
    assert.ok(mid < high)
    assert.equal(noJitter, mid)

    const clampedMin = computeHumanPauseMs('', { baseMs: 50, minMs: 300, maxMs: 6_000 })
    const clampedMax = computeHumanPauseMs('a'.repeat(500), { minMs: 300, maxMs: 6_000 })
    assert.equal(clampedMin, 300)
    assert.equal(clampedMax, 6_000)

    assert.throws(() => computeHumanPauseMs('ok', { charsPerSec: 0 }), RangeError)
    assert.throws(() => computeHumanPauseMs('ok', { minMs: 500, maxMs: 100 }), RangeError)
    assert.throws(() => computeHumanPauseMs('ok', { baseMs: -1 }), RangeError)
  })

  it('schedules and cancels pause cleanly with fake timers', async () => {
    const env = createFakeEnv(0)
    let executed = false
    const handle = scheduleHumanPause(500, () => {
      executed = true
    }, env.timers)

    assert.equal(env.activeTimerCount(), 1)
    env.advanceBy(499)
    assert.equal(executed, false)
    env.advanceBy(1)
    await handle.done
    assert.equal(executed, true)
    assert.equal(env.activeTimerCount(), 0)

    // Cancel before firing never runs callback
    let cancelledRan = false
    const cancelledHandle = scheduleHumanPause(500, () => {
      cancelledRan = true
    }, env.timers)
    assert.equal(env.activeTimerCount(), 1)
    cancelledHandle.cancel()
    assert.equal(env.activeTimerCount(), 0)
    env.advanceBy(1_000)
    await cancelledHandle.done
    assert.equal(cancelledRan, false)
  })
})
