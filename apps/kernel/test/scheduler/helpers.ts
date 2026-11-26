import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { TestContext } from 'node:test'
import { BrainError } from '@brain-core/sdk'
import type { RuntimeSettings } from '../../src/contracts/index.ts'
import type { Logger, LogFields } from '../../src/log/index.ts'
import { createScheduler, type SchedulerService } from '../../src/scheduler/index.ts'
import { FakeClock } from '../fakes/index.ts'

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** 2026-11-07, 00:00 UTC by default, which is outside the default quiet hours. */
export function at(hour: number, minute = 0, day = 7): number {
  return Date.UTC(2026, 10, day, hour, minute)
}

export interface LogEntry {
  readonly level: 'info' | 'warn' | 'error'
  readonly event: string
  readonly fields?: LogFields
}

export class RecordingLog implements Logger {
  readonly entries: LogEntry[] = []

  info(event: string, fields?: LogFields): void {
    this.entries.push({ level: 'info', event, fields })
  }

  warn(event: string, fields?: LogFields): void {
    this.entries.push({ level: 'warn', event, fields })
  }

  error(event: string, fields?: LogFields): void {
    this.entries.push({ level: 'error', event, fields })
  }

  named(event: string): readonly LogEntry[] {
    return this.entries.filter((entry) => entry.event === event)
  }
}

export const SETTINGS: RuntimeSettings = { agents: {}, timezone: 'UTC' }

export interface Setup {
  readonly root: string
  readonly stateFile: string
  readonly clock: FakeClock
  readonly log: RecordingLog
  readonly settings: { value: RuntimeSettings }
  readonly scheduler: SchedulerService
  /** Another scheduler over the same file and clock, as a restart would create. */
  make(): SchedulerService
}

export async function setup(
  t: TestContext,
  options: { readonly settings?: RuntimeSettings; readonly clock?: FakeClock; readonly root?: string } = {},
): Promise<Setup> {
  let root = options.root
  if (root === undefined) {
    root = await mkdtemp(path.join(tmpdir(), 'brain-scheduler-'))
    // A tick started by the interval writes its state asynchronously; on Windows the rename can
    // still be in flight when the test ends, so let rm retry instead of racing it.
    t.after(() => rm(root as string, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }))
  }
  const clock = options.clock ?? new FakeClock()
  const log = new RecordingLog()
  const settings = { value: options.settings ?? SETTINGS }
  const stateFile = path.join(root, 'state', 'agent', 'scheduler.json')
  const make = (): SchedulerService => createScheduler({ clock, log, settings: async () => settings.value, stateFile })
  return { root, stateFile, clock, log, settings, scheduler: make(), make }
}

/** Polls with real timers so a `void tick()` started by the interval can finish. */
export async function settle(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500 && !check(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

/** Waits until an interval-driven tick has finished writing its state file. */
export async function waitForStateFile(file: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    try {
      JSON.parse(await readFile(file, 'utf8'))
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
  }
  throw new Error(`the state file was not written: ${file}`)
}

export function throwsCode(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof BrainError, `expected BrainError, got ${String(error)}`)
    assert.equal(error.code, code)
    return true
  })
}
