import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeFileAtomic } from '@brain-core/shared'

/** `state/agent/scheduler.json` carries only what restarts need: ownTime's last run and the day's counts. */

export interface OwnTimeEntry {
  /** When this task last ran; absent until the first run. */
  lastAt?: number
  /** The natural day `count` belongs to, `YYYY-MM-DD` in the configured time zone. */
  day?: string
  /** Runs on that day, across this task only; the plugin's quota sums its tasks. */
  count?: number
}

export interface ScheduledEntry {
  day?: string
  /** Runs of `every` and `at` together for this plugin on that day. */
  count?: number
}

export interface SchedulerState {
  /** Keyed `<owner>/<name>`. */
  ownTime: Record<string, OwnTimeEntry>
  /** Keyed by owner; `every` and `at` share the counter. */
  scheduled: Record<string, ScheduledEntry>
}

export function emptyState(): SchedulerState {
  return { ownTime: {}, scheduled: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function dayOf(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined
}

function countOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function parseOwnTime(value: unknown): OwnTimeEntry | undefined {
  if (!isRecord(value)) return undefined
  const entry: OwnTimeEntry = {}
  const lastAt = finite(value.lastAt)
  const day = dayOf(value.day)
  const count = countOf(value.count)
  if (lastAt !== undefined) entry.lastAt = lastAt
  if (day !== undefined) entry.day = day
  if (count !== undefined) entry.count = count
  return entry
}

function parseScheduled(value: unknown): ScheduledEntry | undefined {
  if (!isRecord(value)) return undefined
  const entry: ScheduledEntry = {}
  const day = dayOf(value.day)
  const count = countOf(value.count)
  if (day !== undefined) entry.day = day
  if (count !== undefined) entry.count = count
  return entry
}

/** Anything that does not look like our state gives an empty state: a damaged file is treated as absent. */
export function parseState(value: unknown): SchedulerState {
  const state = emptyState()
  if (!isRecord(value)) return state
  if (isRecord(value.ownTime)) {
    for (const [key, entry] of Object.entries(value.ownTime)) {
      const parsed = parseOwnTime(entry)
      if (parsed !== undefined) state.ownTime[key] = parsed
    }
  }
  if (isRecord(value.scheduled)) {
    for (const [owner, entry] of Object.entries(value.scheduled)) {
      const parsed = parseScheduled(entry)
      if (parsed !== undefined) state.scheduled[owner] = parsed
    }
  }
  return state
}

/** A missing, unreadable or malformed file counts as empty. */
export async function readState(file: string): Promise<SchedulerState> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return emptyState()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return emptyState()
  }
  return parseState(parsed)
}

export async function writeState(file: string, state: SchedulerState): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await writeFileAtomic(file, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`)
}
