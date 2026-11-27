import { BrainError } from '@dsh-brain-core/sdk'
import type { MemoryRecord } from '@dsh-brain-core/sdk'
import type { DecayState, MemoryDecay } from '../contracts/index.ts'

const DAY_MS = 86_400_000
const FSRS_FACTOR = 19 / 81
const FSRS_DECAY = -0.5
const EVENT_RETRIEVABILITY_FLOOR = 0.35
const MIN_GRADE1_STABILITY_DAYS = 0.5
const MAX_STABILITY_DAYS = 3650

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function clamp01(value: number, fallback = 0.5): number {
  return Number.isFinite(value) ? clamp(value, 0, 1) : fallback
}

function isValidDecayState(value: unknown): value is DecayState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.stabilityDays === 'number'
    && Number.isFinite(candidate.stabilityDays)
    && candidate.stabilityDays > 0
    && typeof candidate.difficulty === 'number'
    && Number.isFinite(candidate.difficulty)
    && candidate.difficulty >= 1
    && candidate.difficulty <= 10
    && typeof candidate.lastReviewedAt === 'number'
    && Number.isFinite(candidate.lastReviewedAt)
    && typeof candidate.reps === 'number'
    && Number.isInteger(candidate.reps)
    && candidate.reps >= 0
  )
}

/** Reads valid FSRS decay metadata from `record.content.decay`, or derives the initial state. */
export function parseDecayState(record: MemoryRecord): DecayState {
  const existing = record.content.decay
  if (isValidDecayState(existing)) {
    return {
      stabilityDays: existing.stabilityDays,
      difficulty: existing.difficulty,
      lastReviewedAt: existing.lastReviewedAt,
      reps: existing.reps,
    }
  }
  const importance = clamp01(record.importance, 0.5)
  const confidence = clamp01(record.confidence, 0.5)
  return {
    stabilityDays: Math.max(1, 1 + 14 * importance * confidence),
    difficulty: clamp(5 - 3 * importance, 1, 10),
    lastReviewedAt: Number.isFinite(record.tEvent) ? record.tEvent : 0,
    reps: 0,
  }
}

/** Creates a pure Clean-Room FSRS memory decay evaluator (FR-M14, RFC M8/M10). */
export function createMemoryDecay(): MemoryDecay {
  function retrievabilityOf(record: MemoryRecord, now: number): number {
    // L0 never decays and L3 drifts only via explicit settlement (RFC M8).
    if (record.layer !== 'L1' && record.layer !== 'L2') return 1
    const state = parseDecayState(record)
    const elapsedDays = Math.max(0, (now - state.lastReviewedAt) / DAY_MS)
    const r = Math.pow(1 + FSRS_FACTOR * (elapsedDays / state.stabilityDays), FSRS_DECAY)
    // Historical events keep a floor retrievability and never expire by decay (RFC M10).
    if (record.kind === 'l1.event') return Math.max(EVENT_RETRIEVABILITY_FLOOR, r)
    return r
  }

  function priorityOf(record: MemoryRecord, now: number): number {
    return record.importance * retrievabilityOf(record, now)
  }

  function reinforce(record: MemoryRecord, now: number, grade: 1 | 2 | 3 | 4 = 3): DecayState {
    if (!([1, 2, 3, 4] as const).includes(grade)) {
      throw new BrainError('INVALID_ARGUMENT', 'grade must be 1, 2, 3 or 4')
    }
    const state = parseDecayState(record)
    const r = retrievabilityOf(record, now)
    const difficulty = clamp(state.difficulty - 0.4 * (grade - 3), 1, 10)
    let stabilityDays: number
    if (grade === 1) {
      stabilityDays = Math.max(MIN_GRADE1_STABILITY_DAYS, state.stabilityDays * 0.5)
    } else {
      const gradeWeight = grade === 2 ? 0.15 : grade === 3 ? 0.35 : 0.55
      const gain = Math.exp(1.2) * (11 - difficulty) * Math.pow(state.stabilityDays, -0.2) * ((1 + (1 - r)) * gradeWeight)
      stabilityDays = Math.min(MAX_STABILITY_DAYS, state.stabilityDays * (1 + gain))
    }
    return {
      stabilityDays,
      difficulty,
      lastReviewedAt: Math.max(now, state.lastReviewedAt),
      reps: state.reps + 1,
    }
  }

  return {
    retrievabilityOf,
    priorityOf,
    reinforce,
  }
}
