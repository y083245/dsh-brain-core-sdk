import assert from 'node:assert/strict'
import test from 'node:test'
import { createQualityController, type QualityController } from '../../web/src/ink/quality.ts'
import { INK, QUALITY } from '../../web/src/motion/tokens.ts'

/**
 * Feed a full 2-second sampling window (INK.sampleEveryMs) of frames at a constant frameMs.
 * Returns the next timestamp after the window completes.
 */
function feedWindow(
  ctrl: QualityController,
  frameMs: number,
  startNowMs: number,
  samples = 10,
): { tier: ReturnType<QualityController['getTier']>; nextNowMs: number } {
  const stepMs = INK.sampleEveryMs / samples
  let tier = ctrl.getTier()
  for (let i = 1; i <= samples; i += 1) {
    const nowMs = startNowMs + Math.round(stepMs * i)
    tier = ctrl.recordFrame(frameMs, nowMs)
  }
  return { tier, nextNowMs: startNowMs + INK.sampleEveryMs }
}

test('degrades high -> medium -> low -> static after 2 consecutive slow 2s windows each', () => {
  const ctrl = createQualityController({ initialCeiling: 'high', floatSupported: true })
  assert.equal(ctrl.getTier(), 'high')

  // Seed clock at t = 0
  ctrl.recordFrame(16, 0)
  let now = 0

  // Window 1 slow (> 18ms): still high
  let res = feedWindow(ctrl, 22, now)
  now = res.nextNowMs
  assert.equal(res.tier, 'high')

  // Window 2 slow (> 18ms): degrades high -> medium
  res = feedWindow(ctrl, 21, now)
  now = res.nextNowMs
  assert.equal(res.tier, 'medium')

  // Two more slow windows: degrades medium -> low
  res = feedWindow(ctrl, 20, now)
  now = res.nextNowMs
  assert.equal(res.tier, 'medium')
  res = feedWindow(ctrl, 20, now)
  now = res.nextNowMs
  assert.equal(res.tier, 'low')

  // Two more slow windows: degrades low -> static
  res = feedWindow(ctrl, 25, now)
  now = res.nextNowMs
  assert.equal(res.tier, 'low')
  res = feedWindow(ctrl, 25, now)
  now = res.nextNowMs
  assert.equal(res.tier, 'static')

  // Further slow windows stay at static
  res = feedWindow(ctrl, 30, now)
  now = res.nextNowMs
  res = feedWindow(ctrl, 30, now)
  assert.equal(res.tier, 'static')
})

test('single slow window followed by fast window resets counter and does NOT degrade', () => {
  const ctrl = createQualityController({ initialCeiling: 'high', floatSupported: true })
  ctrl.recordFrame(14, 0)
  let now = 0

  // Slow window 1
  let res = feedWindow(ctrl, 22, now)
  now = res.nextNowMs
  assert.equal(res.tier, 'high')

  // Fast/normal window resets consecutive slow streak
  res = feedWindow(ctrl, 15, now)
  now = res.nextNowMs
  assert.equal(res.tier, 'high')

  // Another single slow window still must NOT degrade
  res = feedWindow(ctrl, 23, now)
  now = res.nextNowMs
  assert.equal(res.tier, 'high')

  // Another normal window keeps it at high
  res = feedWindow(ctrl, 16, now)
  assert.equal(res.tier, 'high')
})

test('20s continuous < 11ms upgrades low -> medium -> high and never exceeds ceiling', () => {
  const ctrl = createQualityController({ initialCeiling: 'high', floatSupported: true })
  ctrl.recordFrame(22, 0)
  let now = 0

  // Degrade high -> medium -> low (4 slow windows)
  for (let i = 0; i < 4; i += 1) {
    const r = feedWindow(ctrl, 22, now)
    now = r.nextNowMs
  }
  assert.equal(ctrl.getTier(), 'low')

  // 9 fast windows (18s < 20s): still low
  for (let i = 0; i < 9; i += 1) {
    const r = feedWindow(ctrl, 8, now)
    now = r.nextNowMs
    assert.equal(r.tier, 'low')
  }

  // 10th fast window (20s reached): upgrades low -> medium
  let res = feedWindow(ctrl, 8, now)
  now = res.nextNowMs
  assert.equal(res.tier, 'medium')

  // Interruption at 12ms resets fast accumulation timer
  for (let i = 0; i < 5; i += 1) {
    const r = feedWindow(ctrl, 9, now)
    now = r.nextNowMs
  }
  res = feedWindow(ctrl, 12, now) // >= 11ms breaks fast streak
  now = res.nextNowMs
  assert.equal(res.tier, 'medium')

  // Need full 10 consecutive fast windows (20s) again to upgrade medium -> high
  for (let i = 0; i < 9; i += 1) {
    const r = feedWindow(ctrl, 9, now)
    now = r.nextNowMs
    assert.equal(r.tier, 'medium')
  }
  res = feedWindow(ctrl, 9, now)
  now = res.nextNowMs
  assert.equal(res.tier, 'high')

  // Additional fast windows never exceed ceiling
  for (let i = 0; i < 12; i += 1) {
    const r = feedWindow(ctrl, 5, now)
    now = r.nextNowMs
    assert.equal(r.tier, 'high')
  }

  // Respects lower ceiling (e.g. medium)
  const capped = createQualityController({ initialCeiling: 'medium', floatSupported: true })
  capped.recordFrame(22, 0)
  let cNow = 0
  cNow = feedWindow(capped, 22, cNow).nextNowMs
  cNow = feedWindow(capped, 22, cNow).nextNowMs
  assert.equal(capped.getTier(), 'low')

  for (let i = 0; i < 10; i += 1) {
    cNow = feedWindow(capped, 7, cNow).nextNowMs
  }
  assert.equal(capped.getTier(), 'medium')

  for (let i = 0; i < 15; i += 1) {
    cNow = feedWindow(capped, 5, cNow).nextNowMs
  }
  assert.equal(capped.getTier(), 'medium')
})

test('floatSupported: false caps effective ceiling one tier lower (high->medium, medium->low, low->low)', () => {
  const fromHigh = createQualityController({ initialCeiling: 'high', floatSupported: false })
  assert.equal(fromHigh.getCeiling(), 'medium')
  assert.equal(fromHigh.getTier(), 'medium')

  const fromMedium = createQualityController({ initialCeiling: 'medium', floatSupported: false })
  assert.equal(fromMedium.getCeiling(), 'low')
  assert.equal(fromMedium.getTier(), 'low')

  const fromLow = createQualityController({ initialCeiling: 'low', floatSupported: false })
  assert.equal(fromLow.getCeiling(), 'low')
  assert.equal(fromLow.getTier(), 'low')

  // Upgrading from low with floatSupported=false and initialCeiling=high stops at medium
  fromHigh.recordFrame(24, 0)
  let now = 0
  now = feedWindow(fromHigh, 24, now).nextNowMs
  now = feedWindow(fromHigh, 24, now).nextNowMs
  assert.equal(fromHigh.getTier(), 'low')

  for (let i = 0; i < 20; i += 1) {
    now = feedWindow(fromHigh, 6, now).nextNowMs
  }
  assert.equal(fromHigh.getTier(), 'medium')
})

test('manual lock prevents both auto-degrade and auto-upgrade until unlocked', () => {
  const ctrl = createQualityController({ initialCeiling: 'high', floatSupported: true })
  ctrl.setLockedQuality('medium')
  assert.equal(ctrl.isLocked(), true)
  assert.equal(ctrl.getTier(), 'medium')

  // Slow windows must NOT degrade while locked
  ctrl.recordFrame(30, 0)
  let now = 0
  for (let i = 0; i < 6; i += 1) {
    const r = feedWindow(ctrl, 30, now)
    now = r.nextNowMs
    assert.equal(r.tier, 'medium')
  }

  // Fast windows must NOT upgrade while locked
  for (let i = 0; i < 15; i += 1) {
    const r = feedWindow(ctrl, 5, now)
    now = r.nextNowMs
    assert.equal(r.tier, 'medium')
  }

  // Unlocking resumes automatic transitions cleanly without stale slow/fast history
  ctrl.setLockedQuality(null)
  assert.equal(ctrl.isLocked(), false)
  assert.equal(ctrl.getTier(), 'high')

  ctrl.recordFrame(25, now)
  now = feedWindow(ctrl, 25, now).nextNowMs
  assert.equal(ctrl.getTier(), 'high')
  feedWindow(ctrl, 25, now)
  assert.equal(ctrl.getTier(), 'medium')
})

test('getParams(calm) returns exact Appendix B params and calm adjustments (curl/3, 0.955, pointerInkScale 0.3)', () => {
  const ctrl = createQualityController({ initialCeiling: 'high', floatSupported: true })

  const highNormal = ctrl.getParams(false)
  assert.deepEqual(highNormal, {
    tier: 'high',
    sim: QUALITY.high.sim,
    dye: QUALITY.high.dye,
    pressureIters: QUALITY.high.pressureIters,
    curl: QUALITY.high.curl,
    dyeDissipation: INK.dissipationDye,
    velocityDissipation: INK.dissipationVelocity,
    pointerInkScale: 1,
  })

  const highCalm = ctrl.getParams(true)
  assert.equal(highCalm.tier, 'high')
  assert.equal(highCalm.sim, QUALITY.high.sim)
  assert.equal(highCalm.dye, QUALITY.high.dye)
  assert.equal(highCalm.pressureIters, QUALITY.high.pressureIters)
  assert.equal(highCalm.curl, QUALITY.high.curl / 3)
  assert.equal(highCalm.dyeDissipation, INK.dissipationDyeCalm)
  assert.equal(highCalm.dyeDissipation, 0.955)
  assert.equal(highCalm.velocityDissipation, INK.dissipationVelocity)
  assert.equal(highCalm.pointerInkScale, 0.3)

  ctrl.setLockedQuality('low')
  const lowCalm = ctrl.getParams(true)
  assert.equal(lowCalm.sim, 96)
  assert.equal(lowCalm.dye, 512)
  assert.equal(lowCalm.pressureIters, 10)
  assert.equal(lowCalm.curl, 16 / 3)
  assert.equal(lowCalm.dyeDissipation, 0.955)
  assert.equal(lowCalm.pointerInkScale, 0.3)

  ctrl.setLockedQuality('static')
  const staticParams = ctrl.getParams(false)
  assert.equal(staticParams.tier, 'static')
  assert.equal(staticParams.sim, 0)
  assert.equal(staticParams.dye, 0)
  assert.equal(staticParams.pressureIters, 0)
  assert.equal(staticParams.curl, 0)
  assert.equal(staticParams.pointerInkScale, 0)
})
