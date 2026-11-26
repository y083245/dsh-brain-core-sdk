import { BrainError } from '@brain-core/sdk'
import type { Clock } from './contracts/index.ts'
import type { Logger } from './log/index.ts'
import type { JobRunner } from './memory-api/index.ts'

/**
 * FR-M09: extraction runs on a fixed clock instead of the scheduler, because the scheduler
 * stays quiet during quiet hours and extraction sends nothing outward.
 */
export interface ExtractionTimer {
  /** One look: start an extract job unless the previous one from this timer is still queued or running. */
  runOnce(): void
  start(): void
  stop(): void
}

export function createExtractionTimer(deps: {
  readonly jobs: JobRunner
  readonly clock: Clock
  readonly log: Logger
  readonly intervalMs: number
  readonly settleMs: number
  readonly lookbackMs: number
}): ExtractionTimer {
  let lastJobId: string | undefined
  let interval: ReturnType<typeof setInterval> | undefined

  function codeOf(error: unknown): string | undefined {
    if (error instanceof BrainError) return error.code
    if (error instanceof Error && 'code' in error && typeof (error as { readonly code?: unknown }).code === 'string') {
      return (error as { readonly code: string }).code
    }
    return undefined
  }

  function stillRunning(id: string): boolean {
    try {
      const status = deps.jobs.get(id).status
      return status === 'queued' || status === 'running'
    } catch {
      // Dropped from the runner's short history: nothing of this timer's is running any more.
      return false
    }
  }

  function runOnce(): void {
    if (lastJobId !== undefined && stillRunning(lastJobId)) return
    const now = deps.clock.now()
    try {
      const job = deps.jobs.start({ type: 'extract', from: now - deps.lookbackMs, to: now - deps.settleMs })
      lastJobId = job.id
      // The log carries the job id, never a record or its text.
      deps.log.info('extraction_timer.started', { requestId: job.id })
    } catch (error) {
      const code = codeOf(error)
      deps.log.warn('extraction_timer.start_failed', code === undefined ? {} : { code })
    }
  }

  return {
    runOnce,

    start(): void {
      if (interval !== undefined) return
      interval = setInterval(runOnce, deps.intervalMs)
      interval.unref()
    },

    stop(): void {
      if (interval === undefined) return
      clearInterval(interval)
      interval = undefined
    },
  }
}
