import { INK, QUALITY, type QualityTier } from '../motion/tokens.ts'

export type { QualityTier }

export interface QualityParams {
  tier: QualityTier
  sim: number
  dye: number
  pressureIters: number
  curl: number
  dyeDissipation: number
  velocityDissipation: number
  pointerInkScale: number
}

export interface QualityControllerOptions {
  initialCeiling?: QualityTier
  floatSupported?: boolean
}

export interface QualityController {
  recordFrame(frameMs: number, nowMs: number): QualityTier
  getTier(): QualityTier
  getCeiling(): QualityTier
  setCeiling(tier: QualityTier): QualityTier
  setLockedQuality(tier: QualityTier | null): QualityTier
  getLockedQuality(): QualityTier | null
  isLocked(): boolean
  getParams(calm: boolean): QualityParams
  getLastAvgFrameMs(): number | null
  reset(): void
}

const TIER_ORDER: readonly QualityTier[] = ['static', 'low', 'medium', 'high']

function tierIndex(tier: QualityTier): number {
  return TIER_ORDER.indexOf(tier)
}

function stepDown(tier: QualityTier): QualityTier {
  const idx = tierIndex(tier)
  return TIER_ORDER[Math.max(0, idx - 1)]!
}

function stepUp(tier: QualityTier, ceiling: QualityTier): QualityTier {
  const nextIdx = Math.min(tierIndex(ceiling), tierIndex(tier) + 1)
  return TIER_ORDER[nextIdx]!
}

function capForFloatSupport(tier: QualityTier, floatSupported: boolean): QualityTier {
  if (floatSupported) {
    return tier
  }
  switch (tier) {
    case 'high':
      return 'medium'
    case 'medium':
      return 'low'
    case 'low':
      return 'low'
    case 'static':
      return 'static'
  }
}

export function createQualityController(options: QualityControllerOptions = {}): QualityController {
  const floatSupported = options.floatSupported ?? true
  let ceiling: QualityTier = capForFloatSupport(options.initialCeiling ?? 'high', floatSupported)
  let currentTier: QualityTier = ceiling
  let lockedQuality: QualityTier | null = null

  let windowStartMs: number | null = null
  let windowSumMs = 0
  let windowCount = 0
  let consecutiveSlowWindows = 0
  let fastAccumMs = 0
  let lastAvgFrameMs: number | null = null

  function resetSampling(): void {
    windowStartMs = null
    windowSumMs = 0
    windowCount = 0
    consecutiveSlowWindows = 0
    fastAccumMs = 0
  }

  function activeTier(): QualityTier {
    return lockedQuality ?? currentTier
  }

  function recordFrame(frameMs: number, nowMs: number): QualityTier {
    if (!Number.isFinite(frameMs) || !Number.isFinite(nowMs)) {
      return activeTier()
    }
    const clampedFrame = Math.max(0, frameMs)

    if (lockedQuality !== null) {
      return lockedQuality
    }

    if (windowStartMs === null) {
      windowStartMs = nowMs
      windowSumMs = clampedFrame
      windowCount = 1
      return currentTier
    }

    if (nowMs < windowStartMs) {
      // Clock went backwards; restart sampling cleanly.
      windowStartMs = nowMs
      windowSumMs = clampedFrame
      windowCount = 1
      return currentTier
    }

    windowSumMs += clampedFrame
    windowCount += 1

    const elapsedMs = nowMs - windowStartMs
    if (elapsedMs < INK.sampleEveryMs) {
      return currentTier
    }

    const avgFrameMs = windowSumMs / windowCount
    lastAvgFrameMs = avgFrameMs
    windowStartMs = nowMs
    windowSumMs = 0
    windowCount = 0

    if (avgFrameMs > INK.degradeFrameMs) {
      consecutiveSlowWindows += 1
      fastAccumMs = 0
      if (consecutiveSlowWindows >= 2) {
        currentTier = stepDown(currentTier)
        consecutiveSlowWindows = 0
      }
      return currentTier
    }

    consecutiveSlowWindows = 0

    const canUpgradeTier =
      (currentTier === 'low' || currentTier === 'medium')
      && tierIndex(currentTier) < tierIndex(ceiling)

    if (canUpgradeTier && avgFrameMs < INK.upgradeFrameMs) {
      fastAccumMs += elapsedMs
      if (fastAccumMs >= INK.upgradeAfterMs) {
        currentTier = stepUp(currentTier, ceiling)
        fastAccumMs = 0
      }
    } else {
      fastAccumMs = 0
    }

    return currentTier
  }

  function setCeiling(tier: QualityTier): QualityTier {
    ceiling = capForFloatSupport(tier, floatSupported)
    if (tierIndex(currentTier) > tierIndex(ceiling)) {
      currentTier = ceiling
      resetSampling()
    }
    return activeTier()
  }

  function setLockedQuality(tier: QualityTier | null): QualityTier {
    lockedQuality = tier
    resetSampling()
    if (tier === null && tierIndex(currentTier) > tierIndex(ceiling)) {
      currentTier = ceiling
    }
    return activeTier()
  }

  function getParams(calm: boolean): QualityParams {
    const tier = activeTier()
    const dyeDissipation = calm ? INK.dissipationDyeCalm : INK.dissipationDye
    const velocityDissipation = INK.dissipationVelocity

    if (tier === 'static') {
      return {
        tier: 'static',
        sim: 0,
        dye: 0,
        pressureIters: 0,
        curl: 0,
        dyeDissipation,
        velocityDissipation,
        pointerInkScale: 0,
      }
    }

    const spec = QUALITY[tier]
    return {
      tier,
      sim: spec.sim,
      dye: spec.dye,
      pressureIters: spec.pressureIters,
      curl: calm ? spec.curl / 3 : spec.curl,
      dyeDissipation,
      velocityDissipation,
      pointerInkScale: calm ? 0.3 : 1,
    }
  }

  function reset(): void {
    currentTier = ceiling
    lockedQuality = null
    lastAvgFrameMs = null
    resetSampling()
  }

  return {
    recordFrame,
    getTier: activeTier,
    getCeiling: () => ceiling,
    setCeiling,
    setLockedQuality,
    getLockedQuality: () => lockedQuality,
    isLocked: () => lockedQuality !== null,
    getParams,
    getLastAvgFrameMs: () => lastAvgFrameMs,
    reset,
  }
}
