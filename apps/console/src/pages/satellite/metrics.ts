import type { SessionSurfaceInfo, WakeMetricSample } from './types.ts'

export interface Percentiles {
  readonly p50: number
  readonly p95: number
  readonly samples: readonly number[]
}

export interface StepCachePoint {
  readonly wakeId: string
  readonly stepIndex: number
  readonly inputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly hitRatio: number
}

export interface SessionSurfaceWarning extends SessionSurfaceInfo {
  readonly overThreshold: boolean
}

export interface SatelliteMetricsSummary {
  readonly empty: boolean
  readonly totalWakes: number
  readonly totalRetries: number
  /** First-send latency WITHOUT intentional debounce pause: Math.max(0, firstSendAt - arrivedAt - debounceMs). */
  readonly firstSendLatencyMs: Percentiles | null
  /** Intentional debounce pause tracked separately (FR-T10). */
  readonly debouncePauseMs: Percentiles | null
  /** Model steps per reply (steps.length). */
  readonly stepsPerReply: Percentiles | null
  /** Overall and post-first-wake (index >= 1) cache hit ratios in 0..1. */
  readonly overallCacheHitRatio: number | null
  readonly warmCacheHitRatio: number | null
  readonly stepCachePoints: readonly StepCachePoint[]
  readonly sessionWarnings: readonly SessionSurfaceWarning[]
}

export const DEFAULT_SESSION_TOOL_THRESHOLD = 16

export function percentile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[index] ?? null
}

function computePercentiles(samples: readonly number[]): Percentiles | null {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a - b)
  const p50 = percentile(sorted, 0.5)
  const p95 = percentile(sorted, 0.95)
  if (p50 === null || p95 === null) return null
  return { p50, p95, samples: [...samples] }
}

export function computeSatelliteMetricsSummary(
  metrics: readonly WakeMetricSample[],
  sessions: readonly SessionSurfaceInfo[],
  toolThreshold?: number,
): SatelliteMetricsSummary {
  const threshold = toolThreshold ?? DEFAULT_SESSION_TOOL_THRESHOLD
  const sessionWarnings: SessionSurfaceWarning[] = sessions.map((session) => ({
    ...session,
    overThreshold: session.toolCount > threshold,
  }))

  if (metrics.length === 0) {
    return {
      empty: true,
      totalWakes: 0,
      totalRetries: 0,
      firstSendLatencyMs: null,
      debouncePauseMs: null,
      stepsPerReply: null,
      overallCacheHitRatio: null,
      warmCacheHitRatio: null,
      stepCachePoints: [],
      sessionWarnings,
    }
  }

  let totalRetries = 0
  const firstSendSamples: number[] = []
  const debounceSamples: number[] = []
  const stepsSamples: number[] = []
  const stepCachePoints: StepCachePoint[] = []

  let overallTotalTokens = 0
  let overallCacheRead = 0
  let overallStepCount = 0

  let warmTotalTokens = 0
  let warmCacheRead = 0
  let warmStepCount = 0

  for (let wakeIndex = 0; wakeIndex < metrics.length; wakeIndex++) {
    const entry = metrics[wakeIndex]!
    totalRetries += entry.retries
    debounceSamples.push(entry.debounceMs)
    stepsSamples.push(entry.steps.length)

    if (entry.firstSendAt !== undefined) {
      firstSendSamples.push(Math.max(0, entry.firstSendAt - entry.arrivedAt - entry.debounceMs))
    }

    for (let stepIndex = 0; stepIndex < entry.steps.length; stepIndex++) {
      const step = entry.steps[stepIndex]!
      const total = step.inputTokens + step.cacheReadTokens + step.cacheWriteTokens
      const hitRatio = total > 0 ? step.cacheReadTokens / total : 0

      stepCachePoints.push({
        wakeId: entry.wakeId,
        stepIndex,
        inputTokens: step.inputTokens,
        cacheReadTokens: step.cacheReadTokens,
        cacheWriteTokens: step.cacheWriteTokens,
        hitRatio,
      })

      overallTotalTokens += total
      overallCacheRead += step.cacheReadTokens
      overallStepCount += 1

      if (wakeIndex >= 1) {
        warmTotalTokens += total
        warmCacheRead += step.cacheReadTokens
        warmStepCount += 1
      }
    }
  }

  const overallCacheHitRatio = overallStepCount === 0
    ? null
    : (overallTotalTokens > 0 ? overallCacheRead / overallTotalTokens : 0)

  const warmCacheHitRatio = warmStepCount === 0
    ? null
    : (warmTotalTokens > 0 ? warmCacheRead / warmTotalTokens : 0)

  return {
    empty: false,
    totalWakes: metrics.length,
    totalRetries,
    firstSendLatencyMs: computePercentiles(firstSendSamples),
    debouncePauseMs: computePercentiles(debounceSamples),
    stepsPerReply: computePercentiles(stepsSamples),
    overallCacheHitRatio,
    warmCacheHitRatio,
    stepCachePoints,
    sessionWarnings,
  }
}
