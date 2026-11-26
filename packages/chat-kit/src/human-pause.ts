import type { ChatTimers } from './types.ts'
import { assertFiniteNumber, assertNonNegativeFinite } from './validate.ts'

export interface HumanPauseOptions {
  readonly baseMs?: number
  readonly charsPerSec?: number
  readonly burstIndex?: number
  readonly minMs?: number
  readonly maxMs?: number
  readonly jitterRatio?: number
  readonly rng?: () => number
}

export interface HumanPauseHandle {
  readonly cancel: () => void
  readonly done: Promise<void>
}

export function computeHumanPauseMs(text: string, options?: HumanPauseOptions): number {
  if (typeof text !== 'string') {
    throw new TypeError('text must be a string')
  }
  const baseMs = options?.baseMs === undefined
    ? 400
    : assertNonNegativeFinite(options.baseMs, 'baseMs')
  const charsPerSec = options?.charsPerSec === undefined
    ? 6
    : assertFiniteNumber(options.charsPerSec, 'charsPerSec')
  if (charsPerSec <= 0) {
    throw new RangeError('charsPerSec must be a positive finite number')
  }
  const burstIndex = options?.burstIndex === undefined
    ? 0
    : assertNonNegativeFinite(options.burstIndex, 'burstIndex')
  const minMs = options?.minMs === undefined
    ? 300
    : assertNonNegativeFinite(options.minMs, 'minMs')
  const maxMs = options?.maxMs === undefined
    ? 6000
    : assertNonNegativeFinite(options.maxMs, 'maxMs')
  if (maxMs < minMs) {
    throw new RangeError('maxMs must be greater than or equal to minMs')
  }
  const jitterRatio = options?.jitterRatio === undefined
    ? 0.15
    : assertNonNegativeFinite(options.jitterRatio, 'jitterRatio')
  const rng = options?.rng ?? (() => 0.5)

  const codePoints = [...text].length
  const effectiveBaseMs = burstIndex > 0 ? baseMs * 0.4 : baseMs
  const typingMs = (codePoints / charsPerSec) * 1000
  const raw = effectiveBaseMs + typingMs

  let withJitter = raw
  if (jitterRatio > 0) {
    const sample = assertFiniteNumber(rng(), 'rng()')
    const clampedSample = Math.min(1, Math.max(0, sample))
    const factor = 1 + (clampedSample * 2 - 1) * jitterRatio
    withJitter = raw * factor
  }

  const clamped = Math.min(maxMs, Math.max(minMs, withJitter))
  return Math.max(0, Math.round(clamped))
}

export function scheduleHumanPause(
  delayMs: number,
  run: () => Promise<void> | void,
  timers: ChatTimers,
): HumanPauseHandle {
  const delay = assertNonNegativeFinite(delayMs, 'delayMs')
  let settled = false
  let cancelled = false
  let resolveDone!: () => void
  let rejectDone!: (error: unknown) => void
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })

  const handle = timers.setTimeout(() => {
    if (cancelled || settled) return
    settled = true
    Promise.resolve()
      .then(() => run())
      .then(resolveDone, rejectDone)
  }, delay)

  const cancel = (): void => {
    if (cancelled || settled) return
    cancelled = true
    settled = true
    timers.clearTimeout(handle)
    resolveDone()
  }

  return { cancel, done }
}
