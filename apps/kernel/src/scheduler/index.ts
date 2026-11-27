import { BrainError, type OwnTimeRequest } from '@dsh-brain-core/sdk'
import type { Clock, RuntimeSettings, Scheduler } from '../contracts/index.ts'
import type { Logger } from '../log/index.ts'
import { readState, writeState, type SchedulerState } from './state.ts'

export const MIN_INTERVAL_MS = 60_000
/** The kernel calls `tick` this often while running. */
export const DEFAULT_TICK_MS = 30_000
export const DEFAULT_QUIET_HOURS: readonly [number, number] = [3, 8]
export const DEFAULT_OWN_TIME_PER_DAY = 6
export const DEFAULT_SCHEDULED_PER_DAY = 1_440
export const OWN_TIME_NAME_PATTERN = /^[a-z0-9_-]{1,32}$/

export interface SchedulerService extends Scheduler {
  /** Runs everything due at clock.now(). The kernel calls it every 30 seconds; tests call it directly. */
  tick(): Promise<void>
  start(): void
  stop(): void
}

type Run = () => Promise<void> | void

interface TaskBase {
  readonly id: string
  readonly owner: string
  readonly run: Run
  readonly kind: 'every' | 'at' | 'ownTime'
  /** Set while `run` is still pending; another tick skips this task instead of overlapping. */
  running: boolean
  /** The next wall-clock time this task is due; `every` and `ownTime` move it forward after each look. */
  nextAt: number
}

interface EveryTask extends TaskBase {
  readonly kind: 'every'
  readonly ms: number
}

interface AtTask extends TaskBase {
  readonly kind: 'at'
}

interface OwnTimeTask extends TaskBase {
  readonly kind: 'ownTime'
  readonly name: string
  readonly everyMs: number
}

type Task = EveryTask | AtTask | OwnTimeTask

interface ZonedParts {
  readonly day: string
  readonly hour: number
  readonly minute: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

/** A missing or unknown zone falls back to the system's, the same way agent-runtime does it. */
function formatterFor(timezone: string | undefined): Intl.DateTimeFormat {
  const key = timezone === undefined ? '' : timezone
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

/** The wall-clock fields in the configured time zone; the day is the natural day there. */
function zonedParts(ms: number, timezone?: string): ZonedParts {
  const fields: Record<string, string> = {}
  for (const part of formatterFor(timezone).formatToParts(ms)) fields[part.type] = part.value
  return {
    day: `${fields.year ?? '1970'}-${fields.month ?? '01'}-${fields.day ?? '01'}`,
    hour: Number(fields.hour ?? '0') % 24,
    minute: Number(fields.minute ?? '0'),
  }
}

/** from === to means no quiet hours; from > to crosses midnight. */
function inQuietHours(parts: ZonedParts, range: readonly [number, number]): boolean {
  const [from, to] = range
  if (from === to) return false
  const hour = parts.hour + parts.minute / 60
  return from < to ? hour >= from && hour < to : hour >= from || hour < to
}

function codeOf(error: unknown): string | undefined {
  if (error instanceof BrainError) return error.code
  if (error instanceof Error && 'code' in error && typeof (error as { readonly code?: unknown }).code === 'string') {
    return (error as { readonly code: string }).code
  }
  return undefined
}

function ownTimeKey(owner: string, name: string): string {
  return `${owner}/${name}`
}

/** The plugin's ownTime runs on this day, summed over all of its ownTime tasks (the quota is per plugin). */
function ownTimeUsed(state: SchedulerState, owner: string, day: string): number {
  const prefix = `${owner}/`
  let used = 0
  for (const [key, entry] of Object.entries(state.ownTime)) {
    if (!key.startsWith(prefix) || entry.day !== day) continue
    used += entry.count ?? 0
  }
  return used
}

/** `every` and `at` share one counter per plugin. */
function scheduledUsed(state: SchedulerState, owner: string, day: string): number {
  const entry = state.scheduled[owner]
  return entry !== undefined && entry.day === day ? entry.count ?? 0 : 0
}

function consumeOwnTime(state: SchedulerState, owner: string, name: string, now: number, day: string): void {
  const key = ownTimeKey(owner, name)
  const previous = state.ownTime[key]
  const count = previous !== undefined && previous.day === day ? previous.count ?? 0 : 0
  state.ownTime[key] = { lastAt: now, day, count: count + 1 }
}

function consumeScheduled(state: SchedulerState, owner: string, day: string): void {
  const previous = state.scheduled[owner]
  const count = previous !== undefined && previous.day === day ? previous.count ?? 0 : 0
  state.scheduled[owner] = { day, count: count + 1 }
}

export function createScheduler(deps: {
  readonly clock: Clock
  readonly log: Logger
  readonly settings: () => Promise<RuntimeSettings>
  readonly stateFile: string                 // state/agent/scheduler.json
}): SchedulerService {
  const { clock, log, settings, stateFile } = deps
  const tasks = new Map<string, Task>()
  /** ownTime is looked up by `<owner>/<name>` so a duplicate registration is CONFLICT. */
  const ownTimeTasks = new Map<string, OwnTimeTask>()
  /** Tasks whose nextAt has been reconciled with the state file. */
  const adopted = new Set<string>()
  let nextId = 0
  let state: SchedulerState | undefined
  let loading: Promise<SchedulerState> | undefined
  let timer: ReturnType<typeof setInterval> | undefined

  async function load(): Promise<SchedulerState> {
    if (state !== undefined) return state
    if (loading === undefined) {
      loading = readState(stateFile).then((loaded) => {
        state = loaded
        return loaded
      })
    }
    return loading
  }

  /** A task registered before the file was read picks up its persisted last run once the file is in. */
  function adopt(loaded: SchedulerState): void {
    for (const task of tasks.values()) {
      if (task.kind !== 'ownTime' || adopted.has(task.id)) continue
      adopted.add(task.id)
      const entry = loaded.ownTime[ownTimeKey(task.owner, task.name)]
      if (entry !== undefined && entry.lastAt !== undefined) task.nextAt = entry.lastAt + task.everyMs
    }
  }

  function cancel(task: Task): () => void {
    return () => {
      tasks.delete(task.id)
      if (task.kind === 'ownTime') {
        const key = ownTimeKey(task.owner, task.name)
        if (ownTimeTasks.get(key) === task) ownTimeTasks.delete(key)
      }
    }
  }

  /**
   * Starts `run` and returns a promise that settles when it does, without waiting for it inside the
   * tick loop: a plugin that waits on a model must not hold up the rest of the due tasks.
   */
  function beginRun(task: Task): Promise<void> {
    let result: Promise<void> | void
    try {
      result = task.run()
    } catch {
      log.error('scheduler.task_failed', { plugin: task.owner })
      task.running = false
      return Promise.resolve()
    }
    return Promise.resolve(result)
      .catch(() => {
        log.error('scheduler.task_failed', { plugin: task.owner })
      })
      .finally(() => {
        task.running = false
      })
  }

  function advance(task: Task, now: number): void {
    switch (task.kind) {
      case 'every':
        task.nextAt = now + task.ms
        return
      case 'ownTime':
        task.nextAt = now + task.everyMs
        return
      case 'at':
        return
    }
  }

  async function tick(): Promise<void> {
    let current: RuntimeSettings
    try {
      current = await settings()
    } catch (error) {
      log.warn('scheduler.settings_failed', codeOf(error) === undefined ? {} : { code: codeOf(error) })
      return
    }
    const now = clock.now()
    const parts = zonedParts(now, current.timezone)
    const loaded = await load()
    adopt(loaded)
    // Nothing triggers in quiet hours; a task that came due meanwhile runs once on the first tick after them.
    if (inQuietHours(parts, current.quietHours ?? DEFAULT_QUIET_HOURS)) return

    const ownTimeLimit = current.ownTimePerDay ?? DEFAULT_OWN_TIME_PER_DAY
    const ownTimeValue = (owner: string): number => ownTimeUsed(loaded, owner, parts.day)
    const scheduledValue = (owner: string): number => scheduledUsed(loaded, owner, parts.day)
    let dirty = false
    const pending: Promise<void>[] = []

    // A snapshot: a task registered by a run this tick waits for the next tick.
    for (const task of [...tasks.values()]) {
      // A run earlier in this tick may have cancelled it.
      if (!tasks.has(task.id)) continue
      if (task.nextAt > now) continue
      if (task.running) {
        // The previous run has not finished; drop this occurrence without spending quota.
        advance(task, now)
        continue
      }
      if (task.kind === 'ownTime') {
        if (ownTimeValue(task.owner) >= ownTimeLimit) continue
        consumeOwnTime(loaded, task.owner, task.name, now, parts.day)
      } else {
        if (scheduledValue(task.owner) >= DEFAULT_SCHEDULED_PER_DAY) {
          // Over the day's cap: the occurrence is gone, not queued for later.
          if (task.kind === 'every') task.nextAt = now + task.ms
          continue
        }
        consumeScheduled(loaded, task.owner, parts.day)
      }
      dirty = true
      task.running = true
      // An `at` never fires twice, and moving it out of the map keeps the tick loop cheap.
      if (task.kind === 'at') tasks.delete(task.id)
      advance(task, now)
      pending.push(beginRun(task))
    }

    // Write the accounted run before waiting for it: if the process restarts while a run is still
    // pending, the last run and the day's count must not be lost.
    if (dirty) {
      try {
        await writeState(stateFile, loaded)
      } catch (error) {
        log.error('scheduler.state_failed', codeOf(error) === undefined ? {} : { code: codeOf(error) })
      }
    }
    // `tick()` still returns only after this round's runs have finished; they just run concurrently.
    await Promise.allSettled(pending)
  }

  function every(owner: string, ms: number, run: Run): () => void {
    if (!Number.isFinite(ms) || ms < MIN_INTERVAL_MS) {
      throw new BrainError('INVALID_ARGUMENT', `every interval must be at least ${MIN_INTERVAL_MS} ms`)
    }
    const task: EveryTask = { id: `task:${nextId++}`, owner, run, kind: 'every', running: false, nextAt: clock.now() + ms, ms }
    tasks.set(task.id, task)
    return cancel(task)
  }

  function at(owner: string, timeMs: number, run: Run): () => void {
    if (!Number.isFinite(timeMs)) {
      throw new BrainError('INVALID_ARGUMENT', 'at time must be a finite epoch millisecond')
    }
    const task: AtTask = { id: `task:${nextId++}`, owner, run, kind: 'at', running: false, nextAt: timeMs }
    tasks.set(task.id, task)
    return cancel(task)
  }

  function ownTime(owner: string, request: OwnTimeRequest): () => void {
    const candidate = request as unknown as { readonly name?: unknown; readonly everyMs?: unknown; readonly run?: unknown } | null | undefined
    if (candidate === null || candidate === undefined || typeof candidate !== 'object') {
      throw new BrainError('INVALID_ARGUMENT', 'ownTime takes an object with name, everyMs and run')
    }
    if (typeof candidate.name !== 'string' || !OWN_TIME_NAME_PATTERN.test(candidate.name)) {
      throw new BrainError('INVALID_ARGUMENT', 'ownTime name must match ^[a-z0-9_-]{1,32}$')
    }
    if (typeof candidate.everyMs !== 'number' || !Number.isFinite(candidate.everyMs) || candidate.everyMs < MIN_INTERVAL_MS) {
      throw new BrainError('INVALID_ARGUMENT', `ownTime interval must be at least ${MIN_INTERVAL_MS} ms`)
    }
    if (typeof candidate.run !== 'function') {
      throw new BrainError('INVALID_ARGUMENT', 'ownTime run must be a function')
    }
    const key = ownTimeKey(owner, candidate.name)
    if (ownTimeTasks.has(key)) throw new BrainError('CONFLICT', `ownTime ${key} is already registered`)
    // Without a persisted last run a fresh ownTime is due immediately; after a restart the file decides.
    const task: OwnTimeTask = {
      id: `task:${nextId++}`, owner, run: request.run, kind: 'ownTime', running: false, nextAt: 0,
      name: candidate.name, everyMs: candidate.everyMs,
    }
    tasks.set(task.id, task)
    ownTimeTasks.set(key, task)
    return cancel(task)
  }

  function start(): void {
    if (timer !== undefined) return
    timer = setInterval(() => {
      void tick().catch((error: unknown) => {
        log.error('scheduler.tick_failed', codeOf(error) === undefined ? {} : { code: codeOf(error) })
      })
    }, DEFAULT_TICK_MS)
  }

  function stop(): void {
    if (timer === undefined) return
    clearInterval(timer)
    timer = undefined
  }

  return { every, at, ownTime, tick, start, stop }
}
