import type { ChatClock, ChatTimers } from '../src/index.ts'

interface ScheduledTask {
  readonly id: number
  readonly dueAt: number
  readonly fn: () => void
}

export interface FakeEnv {
  readonly clock: ChatClock
  readonly timers: ChatTimers
  advanceBy(ms: number): void
  setNow(ms: number): void
  activeTimerCount(): number
}

export function createFakeEnv(initialNow = 1_000_000): FakeEnv {
  let now = initialNow
  let nextId = 1
  const tasks = new Map<number, ScheduledTask>()

  const clock: ChatClock = {
    now: () => now,
  }

  const timers: ChatTimers = {
    setTimeout(fn: () => void, ms: number): unknown {
      const id = nextId
      nextId += 1
      const dueAt = now + Math.max(0, ms)
      tasks.set(id, { id, dueAt, fn })
      return id
    },
    clearTimeout(handle: unknown): void {
      if (typeof handle === 'number') {
        tasks.delete(handle)
      }
    },
  }

  const runDueTasks = (targetNow: number): void => {
    while (true) {
      let nextTask: ScheduledTask | undefined
      for (const task of tasks.values()) {
        if (task.dueAt <= targetNow) {
          if (
            nextTask === undefined
            || task.dueAt < nextTask.dueAt
            || (task.dueAt === nextTask.dueAt && task.id < nextTask.id)
          ) {
            nextTask = task
          }
        }
      }
      if (nextTask === undefined) break
      tasks.delete(nextTask.id)
      now = Math.max(now, nextTask.dueAt)
      nextTask.fn()
    }
    now = targetNow
  }

  return {
    clock,
    timers,
    advanceBy(ms: number): void {
      runDueTasks(now + ms)
    },
    setNow(ms: number): void {
      if (ms < now) {
        now = ms
        return
      }
      runDueTasks(ms)
    },
    activeTimerCount(): number {
      return tasks.size
    },
  }
}
