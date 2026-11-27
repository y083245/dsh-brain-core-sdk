import { BrainError } from '@dsh-brain-core/sdk'
import type { Clock, RuntimeSettings, WriteIdentity } from './contracts/index.ts'
import type { Logger } from './log/index.ts'
import type { Memory } from './memory-api/index.ts'

export const DEFAULT_CONSOLIDATION_QUIET_HOURS: readonly [number, number] = [2, 6]
export const DEFAULT_CONSOLIDATION_INTERVAL_MS = 15 * 60_000

const KERNEL_PROMOTE_IDENTITY: WriteIdentity = {
  kind: 'kernel',
  source: 'kernel',
  trust: 'self',
  defaultVisibility: 'origin',
}

export interface ConsolidationTimer {
  runOnce(): Promise<void>
  start(): void
  stop(): void
}

interface ZonedParts {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timezone: string | undefined): Intl.DateTimeFormat {
  const key = timezone ?? ''
  const cached = formatters.get(key)
  if (cached !== undefined) return cached
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }
  let made: Intl.DateTimeFormat
  try {
    made = new Intl.DateTimeFormat('en-CA', key === '' ? options : { ...options, timeZone: key })
  } catch {
    made = new Intl.DateTimeFormat('en-CA', options)
  }
  formatters.set(key, made)
  return made
}

function zonedParts(ms: number, timezone?: string): ZonedParts {
  const fields: Record<string, string> = {}
  for (const part of formatterFor(timezone).formatToParts(ms)) fields[part.type] = part.value
  return {
    year: Number(fields.year ?? '1970'),
    month: Number(fields.month ?? '1'),
    day: Number(fields.day ?? '1'),
    hour: Number(fields.hour ?? '0') % 24,
    minute: Number(fields.minute ?? '0'),
  }
}

function inQuietHours(parts: ZonedParts, range: readonly [number, number]): boolean {
  const [from, to] = range
  if (from === to) return false
  const hour = parts.hour + parts.minute / 60
  return from < to ? hour >= from && hour < to : hour >= from || hour < to
}

function quietWindowStartMs(now: number, timezone: string | undefined, range: readonly [number, number]): number {
  const [fromHour, toHour] = range
  const current = zonedParts(now, timezone)
  const fractionalHour = current.hour + current.minute / 60
  const crossedMidnight = fromHour > toHour && fractionalHour < toHour
  const startCal = new Date(Date.UTC(current.year, current.month - 1, current.day - (crossedMidnight ? 1 : 0), 0, 0, 0, 0))
  const startWholeHour = Math.floor(fromHour)
  const startMinute = Math.round((fromHour - startWholeHour) * 60)
  const targetUtcAsLocal = Date.UTC(
    startCal.getUTCFullYear(),
    startCal.getUTCMonth(),
    startCal.getUTCDate(),
    startWholeHour,
    startMinute,
    0,
    0,
  )
  let guess = targetUtcAsLocal
  for (let i = 0; i < 2; i += 1) {
    const actual = zonedParts(guess, timezone)
    const actualUtcAsLocal = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0, 0)
    const diff = targetUtcAsLocal - actualUtcAsLocal
    if (diff === 0) break
    guess += diff
  }
  return guess
}

function codeOf(error: unknown): string | undefined {
  if (error instanceof BrainError) return error.code
  if (error instanceof Error && 'code' in error && typeof (error as { readonly code?: unknown }).code === 'string') {
    return (error as { readonly code: string }).code
  }
  return undefined
}

/**
 * Periodic timer for FR-M17 expired working-memory sweeping and FR-M11/M12 quiet-hours shadow consolidation.
 */
export function createConsolidationTimer(deps: {
  readonly memory: Pick<Memory, 'service' | 'jobs' | 'workingMemory' | 'consolidation'>
  readonly clock: Clock
  readonly log: Logger
  readonly settings: () => Promise<RuntimeSettings>
  readonly shouldConsolidate?: () => boolean
  readonly intervalMs?: number
}): ConsolidationTimer {
  const intervalMs = deps.intervalMs ?? DEFAULT_CONSOLIDATION_INTERVAL_MS
  let interval: ReturnType<typeof setInterval> | undefined
  let inFlight: Promise<void> | undefined
  let lastJobId: string | undefined
  let lastJobWindowStart: number | undefined

  function jobStatus(id: string): 'queued' | 'running' | 'done' | 'failed' | undefined {
    try {
      return deps.memory.jobs.get(id).status
    } catch {
      return undefined
    }
  }

  async function execute(): Promise<void> {
    const now = deps.clock.now()

    try {
      const swept = await deps.memory.workingMemory.sweep(now, async (item) => {
        await deps.memory.service.record({
          layer: 'L1',
          kind: 'l1.fact',
          channel: item.channel,
          subjects: [],
          actor: 'kernel',
          content: { key: item.key, text: item.text },
          evidence: item.evidence ?? [],
          visibility: 'origin',
          tEvent: item.updatedAt,
          idempotencyKey: `wm-promote:${item.id}`,
        }, KERNEL_PROMOTE_IDENTITY)
      })
      if (swept.dropped > 0 || swept.promoted > 0) {
        deps.log.info('consolidation_timer.swept', { count: swept.dropped })
      }
    } catch (error) {
      const code = codeOf(error)
      deps.log.warn('consolidation_timer.sweep_failed', code === undefined ? {} : { code })
    }

    const consolidation = deps.memory.consolidation
    if (consolidation === undefined || deps.shouldConsolidate?.() === false) return

    let currentSettings: RuntimeSettings
    try {
      currentSettings = await deps.settings()
    } catch (error) {
      const code = codeOf(error)
      deps.log.warn('consolidation_timer.settings_failed', code === undefined ? {} : { code })
      return
    }

    const quietHours = currentSettings.quietHours ?? DEFAULT_CONSOLIDATION_QUIET_HOURS
    const parts = zonedParts(now, currentSettings.timezone)
    if (!inQuietHours(parts, quietHours)) return

    if (lastJobId !== undefined) {
      const status = jobStatus(lastJobId)
      if (status === 'queued' || status === 'running') return
    }

    let budget: { readonly usedTokensToday: number; readonly dailyTokenCap: number; readonly lastConsolidatedTo: number }
    try {
      budget = await consolidation.budgetStatus()
    } catch (error) {
      const code = codeOf(error)
      deps.log.warn('consolidation_timer.budget_failed', code === undefined ? {} : { code })
      return
    }

    const windowStartMs = quietWindowStartMs(now, currentSettings.timezone, quietHours)
    if (budget.lastConsolidatedTo >= windowStartMs) return

    if (
      lastJobId !== undefined
      && lastJobWindowStart === windowStartMs
      && jobStatus(lastJobId) === 'done'
      && budget.usedTokensToday >= budget.dailyTokenCap
    ) {
      return
    }

    try {
      if (deps.shouldConsolidate?.() === false) return
      const job = deps.memory.jobs.start({
        type: 'consolidate',
        from: budget.lastConsolidatedTo,
        to: now,
      })
      lastJobId = job.id
      lastJobWindowStart = windowStartMs
      deps.log.info('consolidation_timer.started', { requestId: job.id })
    } catch (error) {
      const code = codeOf(error)
      if (code === 'CONFLICT') return
      deps.log.warn('consolidation_timer.start_failed', code === undefined ? {} : { code })
    }
  }

  function runOnce(): Promise<void> {
    if (inFlight !== undefined) return inFlight
    inFlight = execute().finally(() => {
      inFlight = undefined
    })
    return inFlight
  }

  return {
    runOnce,

    start(): void {
      if (interval !== undefined) return
      interval = setInterval(() => {
        void runOnce()
      }, intervalMs)
      interval.unref()
    },

    stop(): void {
      if (interval === undefined) return
      clearInterval(interval)
      interval = undefined
    },
  }
}
