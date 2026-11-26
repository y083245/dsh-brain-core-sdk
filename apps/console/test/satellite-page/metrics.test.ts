import assert from 'node:assert/strict'
import test from 'node:test'
import {
  computeSatelliteMetricsSummary,
  DEFAULT_SESSION_TOOL_THRESHOLD,
  percentile,
  type SessionSurfaceInfo,
  type WakeMetricSample,
} from '../../src/pages/satellite/index.ts'

test('percentile returns null for empty array and uses exact ceil-index formula', () => {
  assert.equal(percentile([], 0.5), null)
  assert.equal(percentile([42], 0.5), 42)
  assert.equal(percentile([42], 0.95), 42)

  const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
  assert.equal(percentile(sorted, 0.5), 50)
  assert.equal(percentile(sorted, 0.95), 100)
  assert.equal(percentile(sorted, 0), 10)
  assert.equal(percentile(sorted, 1), 100)
})

test('computeSatelliteMetricsSummary returns empty summary with nulls when metrics is empty', () => {
  const sessions: SessionSurfaceInfo[] = [
    { sessionId: 's1', channel: 'console-chat:private:u1', agentClass: 'chat', toolCount: 5 },
  ]
  const summary = computeSatelliteMetricsSummary([], sessions)

  assert.equal(summary.empty, true)
  assert.equal(summary.totalWakes, 0)
  assert.equal(summary.totalRetries, 0)
  assert.equal(summary.firstSendLatencyMs, null)
  assert.equal(summary.debouncePauseMs, null)
  assert.equal(summary.stepsPerReply, null)
  assert.equal(summary.overallCacheHitRatio, null)
  assert.equal(summary.warmCacheHitRatio, null)
  assert.deepEqual(summary.stepCachePoints, [])
  assert.equal(summary.sessionWarnings.length, 1)
  assert.equal(summary.sessionWarnings[0]?.overThreshold, false)
})

test('separates first-send latency from intentional debounce pause and clamps negative latency', () => {
  const samples: WakeMetricSample[] = [
    {
      wakeId: 'w1',
      channel: 'console-chat:private:u1',
      agentClass: 'chat',
      profileVersion: 1,
      arrivedAt: 1000,
      firstSendAt: 4300,
      debounceMs: 1500,
      steps: [
        { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 100 },
      ],
      retries: 1,
      outcome: 'acked',
    },
    {
      wakeId: 'w2',
      channel: 'console-chat:private:u1',
      agentClass: 'chat',
      profileVersion: 1,
      arrivedAt: 5000,
      firstSendAt: 5200,
      debounceMs: 1500,
      steps: [
        { inputTokens: 10, outputTokens: 15, cacheReadTokens: 90, cacheWriteTokens: 0 },
        { inputTokens: 20, outputTokens: 10, cacheReadTokens: 180, cacheWriteTokens: 0 },
      ],
      retries: 2,
      outcome: 'acked',
    },
  ]

  const summary = computeSatelliteMetricsSummary(samples, [])
  assert.equal(summary.empty, false)
  assert.equal(summary.totalWakes, 2)
  assert.equal(summary.totalRetries, 3)

  // w1: 4300 - 1000 - 1500 = 1800; w2: max(0, 5200 - 5000 - 1500) = 0
  assert.deepEqual(summary.firstSendLatencyMs, {
    p50: 0,
    p95: 1800,
    samples: [1800, 0],
  })
  assert.deepEqual(summary.debouncePauseMs, {
    p50: 1500,
    p95: 1500,
    samples: [1500, 1500],
  })
  assert.deepEqual(summary.stepsPerReply, {
    p50: 1,
    p95: 2,
    samples: [1, 2],
  })

  // Overall: read = 0 + 90 + 180 = 270; total = 200 + 100 + 200 = 500 -> 0.54
  assert.equal(summary.overallCacheHitRatio, 270 / 500)
  // Warm (wakeIndex >= 1): read = 90 + 180 = 270; total = 100 + 200 = 300 -> 0.9
  assert.equal(summary.warmCacheHitRatio, 270 / 300)
  assert.equal(summary.stepCachePoints.length, 3)
  assert.equal(summary.stepCachePoints[0]?.hitRatio, 0)
  assert.equal(summary.stepCachePoints[1]?.hitRatio, 0.9)
})

test('handles wakes without firstSendAt and zero-token steps without NaN', () => {
  const samples: WakeMetricSample[] = [
    {
      wakeId: 'w-only',
      channel: 'web-reader:feed:default',
      agentClass: 'activity',
      profileVersion: 1,
      arrivedAt: 1000,
      debounceMs: 0,
      steps: [
        { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      ],
      retries: 0,
      outcome: 'interrupted',
    },
  ]

  const summary = computeSatelliteMetricsSummary(samples, [])
  assert.equal(summary.empty, false)
  assert.equal(summary.firstSendLatencyMs, null)
  assert.equal(summary.overallCacheHitRatio, 0)
  assert.equal(summary.warmCacheHitRatio, null)
  assert.equal(summary.stepCachePoints[0]?.hitRatio, 0)
})

test('handles wakes with zero steps', () => {
  const samples: WakeMetricSample[] = [
    {
      wakeId: 'w-nostep',
      channel: 'console-chat:private:u1',
      agentClass: 'chat',
      profileVersion: 1,
      arrivedAt: 1000,
      debounceMs: 500,
      steps: [],
      retries: 1,
      outcome: 'unavailable',
    },
  ]
  const summary = computeSatelliteMetricsSummary(samples, [])
  assert.equal(summary.overallCacheHitRatio, null)
  assert.equal(summary.warmCacheHitRatio, null)
  assert.deepEqual(summary.stepsPerReply, { p50: 0, p95: 0, samples: [0] })
})

test('flags sessions exceeding tool threshold', () => {
  assert.equal(DEFAULT_SESSION_TOOL_THRESHOLD, 16)
  const sessions: SessionSurfaceInfo[] = [
    { sessionId: 's-ok', channel: 'c1', agentClass: 'chat', toolCount: 10 },
    { sessionId: 's-edge', channel: 'c2', agentClass: 'chat', toolCount: 16 },
    { sessionId: 's-over', channel: 'c3', agentClass: 'activity', toolCount: 20 },
  ]

  const summary = computeSatelliteMetricsSummary([], sessions)
  assert.equal(summary.sessionWarnings[0]?.overThreshold, false)
  assert.equal(summary.sessionWarnings[1]?.overThreshold, false)
  assert.equal(summary.sessionWarnings[2]?.overThreshold, true)

  const custom = computeSatelliteMetricsSummary([], sessions, 8)
  assert.equal(custom.sessionWarnings[0]?.overThreshold, true)
})
