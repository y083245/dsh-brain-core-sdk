import { BrainError, type ErrorCode } from '@brain-core/sdk'
import { createUlid } from '@brain-core/shared'
import type { Clock, ConsolidationEngine, KeywordIndex, RecordStore } from '../contracts/index.ts'
import type { ExtractionReport } from '../memory-extraction/index.ts'

export type JobRequest =
  | { readonly type: 'rebuildIndex' }
  | { readonly type: 'extract'; readonly from: number; readonly to: number; readonly channel?: string }
  | { readonly type: 'consolidate'; readonly from?: number; readonly to?: number; readonly force?: boolean }

export interface Job {
  readonly id: string
  readonly type: JobRequest['type']
  readonly status: 'queued' | 'running' | 'done' | 'failed'
  readonly createdAt: number
  readonly finishedAt?: number
  readonly result?: Readonly<Record<string, unknown>>
  readonly error?: { readonly code: ErrorCode; readonly message: string }
}

export interface JobRunner {
  start(request: unknown): Job
  get(id: string): Job
  health(): 'ok' | 'degraded'
  idle(): Promise<void>
}

/** The part of the extractor a job needs; S2 has none unless the owner configured a model. */
export interface Extractor {
  runOnce(window: { readonly from: number; readonly to: number; readonly channel?: string }): Promise<ExtractionReport>
}

interface MutableJob {
  id: string
  type: JobRequest['type']
  status: Job['status']
  createdAt: number
  finishedAt?: number
  result?: Readonly<Record<string, unknown>>
  error?: Job['error']
}

const KEEP_JOBS = 100

function invalidArgument(message: string): BrainError {
  return new BrainError('INVALID_ARGUMENT', message)
}

/** OpenAPI types `jobs` as an arbitrary object, so the shape is checked here. */
function parseRequest(request: unknown): JobRequest {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    throw invalidArgument('job request must be an object')
  }
  const raw = request as Record<string, unknown>
  if (raw.type === 'rebuildIndex') return { type: 'rebuildIndex' }
  if (raw.type === 'extract') {
    const { from, to, channel } = raw
    if (typeof from !== 'number' || !Number.isFinite(from) || typeof to !== 'number' || !Number.isFinite(to)) {
      throw invalidArgument('extract needs numeric from and to')
    }
    if (channel !== undefined && typeof channel !== 'string') throw invalidArgument('extract channel must be a string')
    return { type: 'extract', from, to, ...(channel === undefined ? {} : { channel }) }
  }
  if (raw.type === 'consolidate') {
    const { from, to, force } = raw
    if (from !== undefined && (typeof from !== 'number' || !Number.isFinite(from))) {
      throw invalidArgument('consolidate from must be a finite number')
    }
    if (to !== undefined && (typeof to !== 'number' || !Number.isFinite(to))) {
      throw invalidArgument('consolidate to must be a finite number')
    }
    if (force !== undefined && typeof force !== 'boolean') {
      throw invalidArgument('consolidate force must be a boolean')
    }
    return {
      type: 'consolidate',
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      ...(force === undefined ? {} : { force }),
    }
  }
  throw invalidArgument('unknown job type')
}

export function createJobRunner(deps: {
  readonly index: KeywordIndex
  readonly store: RecordStore
  readonly clock: Clock
  readonly extractor?: Extractor
  readonly consolidation?: ConsolidationEngine
  readonly activityConfigured?: () => boolean
  /** Clears the facade's index-degraded mark after a successful rebuild. */
  readonly onRebuildSuccess?: () => void
}): JobRunner {
  const nextId = createUlid({ now: () => deps.clock.now() })
  const jobs = new Map<string, MutableJob>()
  const order: string[] = []
  const active = new Set<Promise<void>>()
  let lastFailed = false

  function trim(): void {
    while (order.length > KEEP_JOBS) {
      const oldest = order[0]
      if (oldest === undefined) return
      const job = jobs.get(oldest)
      if (job !== undefined && (job.status === 'queued' || job.status === 'running')) return
      order.shift()
      jobs.delete(oldest)
    }
  }

  async function run(job: MutableJob, request: JobRequest): Promise<void> {
    job.status = 'running'
    try {
      if (request.type === 'rebuildIndex') {
        const indexed = await deps.index.rebuild(deps.store.scan(['L0', 'L1', 'L2']))
        job.result = { indexed }
        deps.onRebuildSuccess?.()
      } else if (request.type === 'extract') {
        if (deps.extractor === undefined) throw new BrainError('UNAVAILABLE', 'extraction is not available')
        const report = await deps.extractor.runOnce({
          from: request.from,
          to: request.to,
          ...(request.channel === undefined ? {} : { channel: request.channel }),
        })
        job.result = { ...report }
      } else {
        if (deps.consolidation === undefined) throw new BrainError('UNAVAILABLE', 'consolidation is not available')
        const proposal = await deps.consolidation.runShadow({
          ...(request.from === undefined ? {} : { from: request.from }),
          ...(request.to === undefined ? {} : { to: request.to }),
          ...(request.force === undefined ? {} : { force: request.force }),
        })
        job.result = {
          proposalId: proposal.id,
          status: proposal.status,
          tokensUsed: proposal.tokensUsed,
          l2Candidates: proposal.l2Candidates.length,
          corrections: proposal.corrections.length,
          selfConflicts: proposal.selfConflicts.length,
        }
      }
      job.status = 'done'
      lastFailed = false
    } catch (error) {
      job.status = 'failed'
      job.error = error instanceof BrainError
        ? { code: error.code, message: error.message }
        : { code: 'INTERNAL', message: 'job failed' }
      lastFailed = true
    } finally {
      job.finishedAt = deps.clock.now()
    }
  }

  function schedule(job: MutableJob, request: JobRequest): void {
    const promise = new Promise<void>((resolve) => setImmediate(resolve)).then(() => run(job, request))
    active.add(promise)
    void promise.finally(() => { active.delete(promise) })
  }

  return {
    start(request: unknown): Job {
      const parsed = parseRequest(request)
      for (const job of jobs.values()) {
        if (job.type === parsed.type && (job.status === 'queued' || job.status === 'running')) {
          throw new BrainError('CONFLICT', `a ${parsed.type} job is already running`)
        }
      }
      if (parsed.type === 'extract' && (deps.extractor === undefined || deps.activityConfigured?.() === false)) {
        throw new BrainError('UNAVAILABLE', 'extraction is not available')
      }
      if (parsed.type === 'consolidate' && (deps.consolidation === undefined || deps.activityConfigured?.() === false)) {
        throw new BrainError('UNAVAILABLE', 'consolidation is not available')
      }

      const job: MutableJob = {
        id: nextId(),
        type: parsed.type,
        status: 'queued',
        createdAt: deps.clock.now(),
      }
      jobs.set(job.id, job)
      order.push(job.id)
      trim()
      schedule(job, parsed)
      return job
    },

    get(id: string): Job {
      const job = jobs.get(id)
      if (job === undefined) throw new BrainError('NOT_FOUND', `job ${id} not found`)
      return job
    },

    health(): 'ok' | 'degraded' {
      return lastFailed ? 'degraded' : 'ok'
    },

    async idle(): Promise<void> {
      while (active.size > 0) await Promise.all([...active])
    },
  }
}
