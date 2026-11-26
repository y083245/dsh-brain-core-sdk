import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setImmediate as nextTick, setTimeout as sleep } from 'node:timers/promises'
import test from 'node:test'
import { TransportClosedError, type RunResult } from '@deepseek-ai/dsh-sdk-client'
import { createRealSatelliteFactory, wrapSatellite, type BridgeHandle, type SatelliteHandle } from '../src/real-satellite.ts'
import { TurnTimeoutError } from '../src/satellite.ts'
import { SelectionMissingError, type AgentClass } from '../src/selection.ts'
import { createSupervisor } from '../src/supervisor.ts'
import {
  RunnerFailedError,
  TurnInterruptedError,
  type ProcessConfig,
  type SatelliteLike,
  type TurnInput,
  type TurnResult,
  type TurnRunner,
} from '../src/turn.ts'

// ---- fakes ----

/** A clock and timer set that only moves when the test says so. */
class FakeClock {
  now = 0
  readonly timers = new Map<number, { at: number; run: () => void }>()
  #next = 1
  readonly api = {
    set: (run: () => void, ms: number): unknown => {
      const id = this.#next++
      this.timers.set(id, { at: this.now + ms, run })
      return id
    },
    clear: (handle: unknown): void => {
      this.timers.delete(handle as number)
    },
  }

  /** Milliseconds until the earliest pending timer. */
  get nextDelay(): number | undefined {
    const times = [...this.timers.values()].map(timer => timer.at - this.now)
    return times.length === 0 ? undefined : Math.min(...times)
  }

  async advance(ms: number): Promise<void> {
    const target = this.now + ms
    for (;;) {
      await settle()
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= target).sort(([, a], [, b]) => a.at - b.at)[0]
      if (due === undefined) break
      this.timers.delete(due[0])
      this.now = Math.max(this.now, due[1].at)
      due[1].run()
    }
    this.now = target
    await settle()
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await nextTick()
}

/** Waits on real I/O (the purge file) with a bound, so a missing event fails instead of hanging. */
async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (await condition()) return
    await sleep(10)
  }
  assert.fail('condition was not met in time')
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function reply(finalResponse: string): TurnResult {
  return { finalResponse, steps: [], retries: 0, compacted: false }
}

const crash = (): TurnInterruptedError => new TurnInterruptedError('crash', 'the process died')
const timeout = (): TurnInterruptedError => new TurnInterruptedError('timeout', 'the turn took too long')

interface RunCall {
  readonly sessionId: string
  readonly input: TurnInput
  readonly options: { readonly timeoutMs?: number } | undefined
  readonly done: Deferred<TurnResult>
}

class FakeSatellite implements SatelliteLike {
  readonly calls: RunCall[] = []
  readonly opened: string[] = []
  closed = 0
  /** Holds close() open until the test lets it finish. */
  closeGate: Promise<void> | undefined
  denied = 0
  openResult: 'resumed' | 'new' = 'new'
  openError: Error | undefined
  readonly agentClass: AgentClass
  readonly config: ProcessConfig
  readonly pid: number
  readonly #harness: Harness

  constructor(harness: Harness, agentClass: AgentClass, config: ProcessConfig, pid: number) {
    this.#harness = harness
    this.agentClass = agentClass
    this.config = config
    this.pid = pid
  }

  get deniedApprovals(): number {
    return this.denied
  }

  async start(): Promise<void> {
    this.#harness.events.push(`start:${this.agentClass}`)
    await this.#harness.startBehavior(this)
  }

  async open(sessionId: string): Promise<'resumed' | 'new'> {
    this.opened.push(sessionId)
    await this.#harness.openGate
    if (this.openError !== undefined) throw this.openError
    return this.openResult
  }

  run(sessionId: string, input: TurnInput, options?: { readonly timeoutMs?: number }): Promise<TurnResult> {
    const done = deferred<TurnResult>()
    this.calls.push({ sessionId, input, options, done })
    this.#harness.inFlight += 1
    this.#harness.maxInFlight = Math.max(this.#harness.maxInFlight, this.#harness.inFlight)
    const finish = (): void => {
      this.#harness.inFlight -= 1
    }
    done.promise.then(finish, finish)
    if (this.#harness.auto) done.resolve(reply(`done ${sessionId}`))
    return done.promise
  }

  async close(): Promise<void> {
    this.closed += 1
    await this.closeGate
    this.#harness.events.push(`close:${this.agentClass}`)
  }

  /** Settles the nth turn this satellite was given. */
  finish(index: number, text = 'ok'): void {
    this.calls[index]?.done.resolve(reply(text))
  }

  fail(index: number, error: Error): void {
    this.calls[index]?.done.reject(error)
  }
}

interface HarnessOptions {
  readonly maxConcurrentTurns?: number
  readonly idleCloseMs?: number
  readonly restart?: { readonly baseMs: number; readonly maxMs: number; readonly maxFailures: number; readonly windowMs: number }
  readonly auto?: boolean
  readonly purgeFile?: string
}

class Harness {
  readonly clock = new FakeClock()
  readonly sats: FakeSatellite[] = []
  readonly events: string[] = []
  readonly denied: [AgentClass, number][] = []
  readonly purgeCalls: (readonly string[])[] = []
  readonly locked = new Set<string>()
  readonly dead = new Set<number>()
  readonly turnTimeoutMs = { chat: 180, activity: 600 }
  auto: boolean
  inFlight = 0
  maxInFlight = 0
  configCalls = 0
  configError: Error | undefined
  purgeError: Error | undefined
  /** Runs as the purge function is called, before it answers. */
  onPurge: (() => void) | undefined
  configGate: Promise<void> | undefined
  /** Holds every open() until released; a promise that never settles is a resume that is stuck. */
  openGate: Promise<void> | undefined
  startBehavior: (satellite: FakeSatellite) => Promise<void> = async () => {}
  readonly dir: string
  readonly purgeFile: string
  readonly runner: TurnRunner
  #pid = 1000

  constructor(dir: string, options: HarnessOptions) {
    this.dir = dir
    this.auto = options.auto ?? false
    this.purgeFile = options.purgeFile ?? path.join(dir, 'state', 'agent', 'purge.json')
    this.runner = createSupervisor({
      factory: async (agentClass, config) => {
        const satellite = new FakeSatellite(this, agentClass, config, (this.#pid += 1))
        this.sats.push(satellite)
        return satellite
      },
      config: async agentClass => {
        this.configCalls += 1
        await this.configGate
        if (this.configError !== undefined) throw this.configError
        return { selection: { provider: 'p', model: `m-${agentClass}`, effort: 'low' }, apiKey: 'key', systemPrompt: 'prompt', catalog: [] }
      },
      purge: async ids => {
        this.events.push('purge')
        this.onPurge?.()
        this.purgeCalls.push([...ids])
        if (this.purgeError !== undefined) throw this.purgeError
        return ids.filter(id => this.locked.has(id))
      },
      now: () => this.clock.now,
      maxConcurrentTurns: options.maxConcurrentTurns ?? 2,
      idleCloseMs: options.idleCloseMs ?? 1000,
      turnTimeoutMs: this.turnTimeoutMs,
      restart: options.restart ?? { baseMs: 1000, maxMs: 16_000, maxFailures: 5, windowMs: 120_000 },
      onDeniedApprovals: (agentClass, count) => {
        this.events.push(`denied:${agentClass}:${count}`)
        this.denied.push([agentClass, count])
      },
      purgeFile: this.purgeFile,
      isAlive: pid => !this.dead.has(pid),
      timers: this.clock.api,
    })
  }

  sat(agentClass: AgentClass, index = 0): FakeSatellite {
    const found = this.sats.filter(satellite => satellite.agentClass === agentClass)[index]
    assert.ok(found, `no ${agentClass} satellite #${index}`)
    return found
  }
}

async function withHarness(options: HarnessOptions, body: (h: Harness) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brain-supervisor-'))
  const h = new Harness(dir, options)
  try {
    await body(h)
  } finally {
    await h.runner.close()
    await rm(dir, { recursive: true, force: true, maxRetries: 5 })
  }
}

/** Follows a promise so a test can look at it without awaiting it. */
function watch<T>(promise: Promise<T>): { state: 'pending' | 'resolved' | 'rejected'; value?: T; error?: unknown } {
  const seen: { state: 'pending' | 'resolved' | 'rejected'; value?: T; error?: unknown } = { state: 'pending' }
  promise.then(
    value => { seen.state = 'resolved'; seen.value = value },
    (error: unknown) => { seen.state = 'rejected'; seen.error = error },
  )
  return seen
}

// ---- concurrency ----

test('turns in flight never pass the limit, and queued turns run in the order they arrived', async () => {
  await withHarness({ maxConcurrentTurns: 2 }, async h => {
    const turns = ['s0', 's1', 's2', 's3', 's4'].map(id => h.runner.run('chat', id, `hi ${id}`))
    await settle()
    const chat = h.sat('chat')
    assert.deepEqual(chat.calls.map(call => call.sessionId), ['s0', 's1'])
    chat.finish(0)
    await settle()
    assert.deepEqual(chat.calls.map(call => call.sessionId), ['s0', 's1', 's2'])
    chat.finish(1)
    chat.finish(2)
    await settle()
    assert.deepEqual(chat.calls.map(call => call.sessionId), ['s0', 's1', 's2', 's3', 's4'])
    chat.finish(3)
    chat.finish(4)
    await Promise.all(turns)
    assert.equal(h.maxInFlight, 2)
    assert.equal(h.inFlight, 0)
  })
})

test('the limit is shared by both classes', async () => {
  await withHarness({ maxConcurrentTurns: 2 }, async h => {
    const turns = [h.runner.run('chat', 'c0', 'x'), h.runner.run('chat', 'c1', 'x'), h.runner.run('activity', 'a0', 'x')]
    await settle()
    assert.equal(h.inFlight, 2)
    assert.equal(h.sat('chat').calls.length, 2)
    assert.equal(h.sats.filter(satellite => satellite.agentClass === 'activity').flatMap(satellite => satellite.calls).length, 0)
    h.sat('chat').finish(0)
    await settle()
    assert.equal(h.sat('activity').calls.length, 1)
    h.sat('chat').finish(1)
    h.sat('activity').finish(0)
    await Promise.all(turns)
    assert.equal(h.maxInFlight, 2)
  })
})

test('a full activity allowance still leaves room for chat', async () => {
  await withHarness({ maxConcurrentTurns: 2 }, async h => {
    const turns = [h.runner.run('activity', 'a0', 'x'), h.runner.run('activity', 'a1', 'x'), h.runner.run('chat', 'c0', 'x')]
    await settle()
    assert.deepEqual(h.sat('activity').calls.map(call => call.sessionId), ['a0'])
    assert.deepEqual(h.sat('chat').calls.map(call => call.sessionId), ['c0'])
    h.sat('chat').finish(0)
    h.sat('activity').finish(0)
    await settle()
    assert.deepEqual(h.sat('activity').calls.map(call => call.sessionId), ['a0', 'a1'])
    h.sat('activity').finish(1)
    await Promise.all(turns)
  })
})

test('with three slots activity may hold two, with one slot still one', async () => {
  await withHarness({ maxConcurrentTurns: 3 }, async h => {
    const turns = ['a0', 'a1', 'a2'].map(id => h.runner.run('activity', id, 'x'))
    await settle()
    assert.deepEqual(h.sat('activity').calls.map(call => call.sessionId), ['a0', 'a1'])
    h.sat('activity').finish(0)
    h.sat('activity').finish(1)
    await settle()
    h.sat('activity').finish(2)
    await Promise.all(turns)
  })
})

test('when a slot frees up, chat goes first even if an activity turn has waited longer', async () => {
  await withHarness({ maxConcurrentTurns: 2 }, async h => {
    const turns = [h.runner.run('chat', 'c0', 'x'), h.runner.run('chat', 'c1', 'x')]
    await settle()
    turns.push(h.runner.run('activity', 'a0', 'x'), h.runner.run('chat', 'c2', 'x'))
    await settle()
    h.sat('chat').finish(0)
    await settle()
    assert.deepEqual(h.sat('chat').calls.map(call => call.sessionId), ['c0', 'c1', 'c2'])
    assert.equal(h.sats.filter(satellite => satellite.agentClass === 'activity').flatMap(satellite => satellite.calls).length, 0)
    h.sat('chat').finish(1)
    await settle()
    assert.deepEqual(h.sat('activity').calls.map(call => call.sessionId), ['a0'])
    h.sat('chat').finish(2)
    h.sat('activity').finish(0)
    await Promise.all(turns)
  })
})

test('with one slot, activity turns still run, and the two classes never run together', async () => {
  await withHarness({ maxConcurrentTurns: 1, auto: true }, async h => {
    const first = await h.runner.run('activity', 'a0', 'x')
    assert.equal(first.finalResponse, 'done a0')
    h.auto = false
    const turns = [h.runner.run('activity', 'a1', 'x'), h.runner.run('chat', 'c0', 'x')]
    await settle()
    assert.equal(h.inFlight, 1)
    assert.equal(h.sat('activity').calls.length, 2)
    assert.equal(h.sats.filter(satellite => satellite.agentClass === 'chat').flatMap(satellite => satellite.calls).length, 0, 'chat waits for the only slot')
    h.sat('activity').finish(1)
    await settle()
    assert.equal(h.sat('chat').calls.length, 1)
    h.sat('chat').finish(0)
    await Promise.all(turns)
    assert.equal(h.maxInFlight, 1)
  })
})

// ---- starting a process ----

test('no process starts until a turn needs one', async () => {
  await withHarness({}, async h => {
    await settle()
    assert.equal(h.sats.length, 0)
    assert.equal(h.configCalls, 0)
    assert.equal(h.runner.status('chat'), 'stopped')
    assert.equal(h.runner.status('activity'), 'stopped')
  })
})

test('two turns arriving together start one process, configured once for its class', async () => {
  await withHarness({}, async h => {
    const gate = deferred<void>()
    h.startBehavior = () => gate.promise
    const turns = [h.runner.run('chat', 's0', 'x'), h.runner.run('chat', 's1', 'x')]
    await settle()
    assert.equal(h.runner.status('chat'), 'running')
    assert.equal(h.sat('chat').calls.length, 0, 'no turn starts before start() finishes')
    gate.resolve()
    await settle()
    assert.equal(h.sats.length, 1)
    assert.equal(h.configCalls, 1)
    assert.equal(h.sat('chat').config.selection.model, 'm-chat')
    assert.equal(h.sat('chat').calls.length, 2)
    h.sat('chat').finish(0)
    h.sat('chat').finish(1)
    await Promise.all(turns)
  })
})

test('each class gets its own process and its own config', async () => {
  await withHarness({ auto: true }, async h => {
    await h.runner.run('chat', 's0', 'x')
    await h.runner.run('activity', 's1', 'x')
    assert.equal(h.sats.length, 2)
    assert.equal(h.sat('chat').config.selection.model, 'm-chat')
    assert.equal(h.sat('activity').config.selection.model, 'm-activity')
  })
})

test('with no model chosen, the turns are refused, no process starts, and a later choice works', async () => {
  await withHarness({ auto: true }, async h => {
    h.configError = new SelectionMissingError('chat', 'model')
    const first = h.runner.run('chat', 's0', 'x')
    const second = h.runner.run('chat', 's1', 'x')
    await assert.rejects(first, SelectionMissingError)
    await assert.rejects(second, SelectionMissingError)
    assert.equal(h.sats.length, 0)
    assert.equal(h.runner.status('chat'), 'stopped')
    h.configError = undefined
    assert.equal((await h.runner.run('chat', 's2', 'x')).finalResponse, 'done s2')
  })
})

test('a turn passes the class timeout unless the caller gives one', async () => {
  await withHarness({ auto: true }, async h => {
    await h.runner.run('chat', 's0', 'x')
    await h.runner.run('chat', 's0', 'x', { timeoutMs: 7 })
    await h.runner.run('activity', 's1', 'x')
    assert.deepEqual(h.sat('chat').calls.map(call => call.options), [{ timeoutMs: 180 }, { timeoutMs: 7 }])
    assert.deepEqual(h.sat('activity').calls.map(call => call.options), [{ timeoutMs: 600 }])
  })
})

test('the turn input reaches the process unchanged', async () => {
  await withHarness({ auto: true }, async h => {
    const blocks: TurnInput = [{ type: 'text', text: 'look' }, { type: 'image', mediaType: 'image/png', base64: 'AAAA' }]
    await h.runner.run('chat', 's0', blocks)
    assert.deepEqual(h.sat('chat').calls[0]?.input, blocks)
  })
})

test('an unknown agent class is refused', async () => {
  await withHarness({}, async h => {
    await assert.rejects(h.runner.run('nonsense' as AgentClass, 's0', 'x'), RangeError)
  })
})

// ---- a process that will not start ----

test('a process that fails to start is retried after the backoff and the queue waits', async () => {
  await withHarness({}, async h => {
    let failures = 2
    h.startBehavior = async () => {
      if (failures > 0) {
        failures -= 1
        throw new Error('cannot start')
      }
    }
    h.auto = true
    const turn = h.runner.run('chat', 's0', 'x')
    const seen = watch(turn)
    await settle()
    assert.equal(h.sats.length, 1)
    assert.equal(h.sat('chat', 0).closed, 1, 'the half-started process is closed')
    assert.equal(h.runner.status('chat'), 'restarting')
    await h.clock.advance(999)
    assert.equal(h.sats.length, 1)
    await h.clock.advance(1)
    assert.equal(h.sats.length, 2)
    assert.equal(seen.state, 'pending')
    await h.clock.advance(1999)
    assert.equal(h.sats.length, 2)
    await h.clock.advance(1)
    assert.equal((await turn).finalResponse, 'done s0')
    assert.equal(h.runner.status('chat'), 'running')
  })
})

test('a config failure other than a missing selection counts as a failed start', async () => {
  await withHarness({ auto: true }, async h => {
    h.configError = new Error('keychain is locked')
    const turn = h.runner.run('chat', 's0', 'x')
    await settle()
    assert.equal(h.runner.status('chat'), 'restarting')
    h.configError = undefined
    await h.clock.advance(1000)
    assert.equal((await turn).finalResponse, 'done s0')
  })
})

test('too many failed starts stop the class: the queue is refused until a reset', async () => {
  await withHarness({}, async h => {
    h.startBehavior = async () => {
      throw new Error('cannot start')
    }
    const first = watch(h.runner.run('chat', 's0', 'x'))
    const second = watch(h.runner.run('chat', 's1', 'x'))
    await settle()
    // Failures land at 0, 1000, 3000, 7000, and the fifth at 15000.
    for (const wait of [1000, 2000, 4000, 8000]) {
      assert.equal(h.runner.status('chat'), 'restarting')
      await h.clock.advance(wait)
    }
    assert.equal(h.sats.length, 5)
    assert.equal(h.runner.status('chat'), 'failed')
    assert.equal(first.state, 'rejected')
    assert.ok(first.error instanceof RunnerFailedError)
    assert.equal((first.error as RunnerFailedError).agentClass, 'chat')
    assert.equal(second.state, 'rejected')
    assert.equal(h.clock.timers.size, 0, 'no restart is scheduled once the class has failed')
    await assert.rejects(h.runner.run('chat', 's2', 'x'), RunnerFailedError)
    assert.equal(h.sats.length, 5)
    assert.equal(h.runner.status('activity'), 'stopped', 'the other class is not affected')

    h.runner.reset('chat')
    assert.equal(h.runner.status('chat'), 'stopped')
    h.startBehavior = async () => {}
    h.auto = true
    assert.equal((await h.runner.run('chat', 's3', 'x')).finalResponse, 'done s3')
  })
})

test('reset drops the restart that was waiting, so the class is not left looking like it is restarting', async () => {
  await withHarness({ auto: true, idleCloseMs: 1000 }, async h => {
    let broken = true
    h.startBehavior = async () => {
      if (broken) throw new Error('cannot start')
    }
    const turn = h.runner.run('chat', 's0', 'x')
    await settle()
    assert.equal(h.runner.status('chat'), 'restarting')
    broken = false
    h.runner.reset('chat')
    assert.equal((await turn).finalResponse, 'done s0')
    assert.equal(h.runner.status('chat'), 'running')
    assert.equal(h.clock.timers.size, 1, 'only the idle countdown is left')
  })
})

test('reset also forgets earlier failures and the backoff in progress', async () => {
  await withHarness({}, async h => {
    h.startBehavior = async () => {
      throw new Error('cannot start')
    }
    const turn = watch(h.runner.run('chat', 's0', 'x'))
    await settle()
    assert.equal(h.runner.status('chat'), 'restarting')
    h.runner.reset('chat')
    await settle()
    assert.equal(h.sats.length, 2, 'the backoff is dropped and the queue tries again at once')
    assert.equal(turn.state, 'pending')
    assert.equal(h.clock.nextDelay, 1000, 'the failure count starts over, so the delay is the first one again')
  })
})

test('the restart delays double up to the cap', async () => {
  await withHarness({ restart: { baseMs: 1000, maxMs: 16_000, maxFailures: 9, windowMs: 1e9 } }, async h => {
    h.startBehavior = async () => {
      throw new Error('cannot start')
    }
    const turn = watch(h.runner.run('chat', 's0', 'x'))
    const delays: (number | undefined)[] = []
    for (let i = 0; i < 7; i += 1) {
      await settle()
      delays.push(h.clock.nextDelay)
      await h.clock.advance(h.clock.nextDelay ?? 0)
    }
    assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16_000, 16_000, 16_000])
    assert.equal(turn.state, 'pending')
  })
})

test('failures older than the window are not counted, exactly at the window included', async () => {
  await withHarness({ restart: { baseMs: 1000, maxMs: 16_000, maxFailures: 3, windowMs: 3000 } }, async h => {
    h.startBehavior = async () => {
      throw new Error('cannot start')
    }
    const turn = watch(h.runner.run('chat', 's0', 'x'))
    await settle()
    await h.clock.advance(1000)
    await h.clock.advance(2000)
    // The third failure is at 3000: the first (age 3000 = window) is out, so only two count.
    assert.equal(h.sats.length, 3)
    assert.equal(h.runner.status('chat'), 'restarting')
    assert.equal(h.clock.nextDelay, 2000)
    assert.equal(turn.state, 'pending')
    await h.clock.advance(2000)
    // The fourth, at 5000, sees failures at 1000 (out: age 4000), 3000 and 5000 -> still only two inside 3000.
    assert.equal(h.sats.length, 4)
    assert.equal(h.runner.status('chat'), 'restarting')
  })
})

// ---- a process that dies ----

test('a crash rejects the running turns, keeps the queued ones, and runs them after the restart', async () => {
  await withHarness({ maxConcurrentTurns: 2 }, async h => {
    const turns = ['s0', 's1', 's2', 's3'].map(id => watch(h.runner.run('chat', id, `hi ${id}`)))
    await settle()
    const old = h.sat('chat', 0)
    assert.equal(old.calls.length, 2)
    old.fail(0, crash())
    old.fail(1, crash())
    await settle()
    assert.equal(turns[0]?.state, 'rejected')
    assert.ok(turns[0]?.error instanceof TurnInterruptedError)
    assert.equal(turns[1]?.state, 'rejected')
    assert.equal(turns[2]?.state, 'pending')
    assert.equal(turns[3]?.state, 'pending')
    assert.equal(old.closed, 1)
    assert.equal(h.runner.status('chat'), 'restarting')
    assert.equal(h.sats.length, 1, 'the restart waits for the backoff')

    await h.clock.advance(1000)
    assert.equal(h.sats.length, 2)
    const fresh = h.sat('chat', 1)
    assert.deepEqual(fresh.calls.map(call => call.sessionId), ['s2', 's3'])
    assert.deepEqual(fresh.calls.map(call => call.input), ['hi s2', 'hi s3'])
    fresh.finish(0, 'two')
    fresh.finish(1, 'three')
    await settle()
    assert.equal(turns[2]?.value?.finalResponse, 'two')
    assert.equal(turns[3]?.value?.finalResponse, 'three')
    assert.equal(h.runner.status('chat'), 'running')
  })
})

test('turns caught up in one crash count as one failure, and the interrupted turn is not run again', async () => {
  await withHarness({ maxConcurrentTurns: 2 }, async h => {
    const first = watch(h.runner.run('chat', 's0', 'x'))
    const second = watch(h.runner.run('chat', 's1', 'x'))
    await settle()
    h.sat('chat').fail(0, crash())
    h.sat('chat').fail(1, crash())
    await settle()
    assert.equal(first.state, 'rejected')
    assert.equal(second.state, 'rejected')
    assert.equal(h.clock.nextDelay, undefined, 'nothing is queued, so nothing restarts')
    assert.equal(h.sats.length, 1)
    // A second crash straight after is the second failure (delay 2000), not the third (4000).
    const retry = h.runner.run('chat', 's2', 'x')
    await settle()
    assert.equal(h.clock.nextDelay, 1000, 'a turn arriving during the backoff waits for it')
    await h.clock.advance(1000)
    h.sat('chat', 1).fail(0, crash())
    await assert.rejects(retry, TurnInterruptedError)
    const again = h.runner.run('chat', 's3', 'x')
    await settle()
    assert.equal(h.clock.nextDelay, 2000)
    h.runner.reset('chat')
    h.auto = true
    await again
  })
})

test('a turn arriving after the backoff has passed starts a process at once', async () => {
  await withHarness({ auto: false }, async h => {
    const first = watch(h.runner.run('chat', 's0', 'x'))
    await settle()
    h.sat('chat').fail(0, crash())
    await settle()
    assert.equal(first.state, 'rejected')
    await h.clock.advance(5000)
    assert.equal(h.sats.length, 1)
    h.auto = true
    assert.equal((await h.runner.run('chat', 's1', 'x')).finalResponse, 'done s1')
    assert.equal(h.sats.length, 2)
  })
})

test('a timeout rejects its turn, the turns caught up in it, and the queue carries on', async () => {
  await withHarness({ maxConcurrentTurns: 2 }, async h => {
    const turns = ['s0', 's1', 's2'].map(id => watch(h.runner.run('chat', id, 'x')))
    await settle()
    h.sat('chat').fail(0, timeout())
    h.sat('chat').fail(1, crash())
    await settle()
    assert.equal((turns[0]?.error as TurnInterruptedError).reason, 'timeout')
    assert.equal((turns[1]?.error as TurnInterruptedError).reason, 'crash')
    assert.equal(turns[2]?.state, 'pending')
    assert.equal(h.sat('chat').closed, 1)
    await h.clock.advance(1000)
    assert.deepEqual(h.sat('chat', 1).calls.map(call => call.sessionId), ['s2'])
    h.sat('chat', 1).finish(0)
    await settle()
    assert.equal(turns[2]?.state, 'resolved')
  })
})

test('five interrupted turns in the window stop the class and refuse what is queued', async () => {
  await withHarness({ maxConcurrentTurns: 1 }, async h => {
    const turns = Array.from({ length: 7 }, (_, i) => watch(h.runner.run('chat', `s${i}`, 'x')))
    for (const wait of [1000, 2000, 4000, 8000]) {
      await settle()
      h.sat('chat', h.sats.length - 1).fail(0, crash())
      await settle()
      assert.equal(h.runner.status('chat'), 'restarting')
      await h.clock.advance(wait)
    }
    h.sat('chat', 4).fail(0, crash())
    await settle()
    assert.equal(h.runner.status('chat'), 'failed')
    assert.equal(turns.filter(turn => turn.state === 'rejected').length, 7)
    assert.equal(turns.filter(turn => turn.error instanceof RunnerFailedError).length, 2)
    assert.equal(h.clock.timers.size, 0)
  })
})

test('one success wipes the failure record', async () => {
  await withHarness({}, async h => {
    const first = watch(h.runner.run('chat', 's0', 'x'))
    await settle()
    h.sat('chat', 0).fail(0, crash())
    await settle()
    const second = watch(h.runner.run('chat', 's1', 'x'))
    await settle()
    assert.equal(h.clock.nextDelay, 1000)
    await h.clock.advance(1000)
    h.sat('chat', 1).fail(0, crash())
    await settle()
    const third = h.runner.run('chat', 's2', 'x')
    await settle()
    assert.equal(h.clock.nextDelay, 2000, 'two failures in a row')
    await h.clock.advance(2000)
    h.sat('chat', 2).finish(0)
    await third
    h.sat('chat', 2).calls[0]?.done.promise.catch(() => {})
    const fourth = watch(h.runner.run('chat', 's3', 'x'))
    await settle()
    h.sat('chat', 2).fail(1, crash())
    await settle()
    assert.equal(fourth.state, 'rejected')
    const fifth = h.runner.run('chat', 's4', 'x')
    await settle()
    assert.equal(h.clock.nextDelay, 1000, 'the count started again after the success')
    assert.equal(first.state, 'rejected')
    assert.equal(second.state, 'rejected')
    h.runner.reset('chat')
    h.auto = true
    await fifth
  })
})

test('an error that is not an interruption leaves the process and the failure record alone', async () => {
  await withHarness({}, async h => {
    const first = watch(h.runner.run('chat', 's0', 'x'))
    await settle()
    h.sat('chat').fail(0, new Error('the model refused'))
    await settle()
    assert.equal(first.state, 'rejected')
    assert.equal((first.error as Error).message, 'the model refused')
    assert.equal(h.sat('chat').closed, 0)
    assert.equal(h.runner.status('chat'), 'running')
    const second = h.runner.run('chat', 's1', 'x')
    await settle()
    assert.equal(h.sats.length, 1)
    h.sat('chat').finish(1)
    await second
  })
})

test('a process found dead before a turn is replaced and the turn runs', async () => {
  await withHarness({ auto: true }, async h => {
    await h.runner.run('chat', 's0', 'x')
    const old = h.sat('chat')
    h.dead.add(old.pid)
    const result = await h.runner.run('chat', 's0', 'again')
    assert.equal(result.finalResponse, 'done s0')
    assert.equal(h.sats.length, 2)
    assert.equal(old.closed, 1)
    assert.deepEqual(h.sat('chat', 1).opened, ['s0'], 'the new process opens the session again')
    assert.equal(h.sat('chat', 1).calls.length, 1)
    assert.equal(old.calls.length, 1)
  })
})

test('finding a process dead counts as a failure, with no wait before the restart', async () => {
  await withHarness({ auto: true, restart: { baseMs: 1000, maxMs: 16_000, maxFailures: 2, windowMs: 120_000 } }, async h => {
    await h.runner.run('chat', 's0', 'x')
    h.dead.add(h.sat('chat', 0).pid)
    h.startBehavior = async () => {
      throw new Error('cannot start')
    }
    // The dead process is failure one; the failed start is failure two.
    await assert.rejects(h.runner.run('chat', 's1', 'x'), RunnerFailedError)
    assert.equal(h.runner.status('chat'), 'failed')
    assert.equal(h.sats.length, 2, 'the replacement was tried at once')
  })
})

// ---- opening sessions ----

test('a session is opened once per process, and again after a restart', async () => {
  await withHarness({ auto: true }, async h => {
    await h.runner.run('chat', 's0', 'x')
    await h.runner.run('chat', 's0', 'y')
    await h.runner.run('chat', 's1', 'x')
    await h.runner.run('chat', 's0', 'z')
    assert.deepEqual(h.sat('chat').opened, ['s0', 's1'])
    h.runner.invalidate('chat')
    await settle()
    await h.runner.run('chat', 's0', 'x')
    assert.deepEqual(h.sat('chat', 1).opened, ['s0'])
  })
})

test('two turns on a new session at the same moment open it once', async () => {
  await withHarness({ maxConcurrentTurns: 2 }, async h => {
    const turns = [h.runner.run('chat', 's0', 'x'), h.runner.run('chat', 's0', 'y')]
    await settle()
    assert.deepEqual(h.sat('chat').opened, ['s0'])
    assert.equal(h.sat('chat').calls.length, 2)
    h.sat('chat').finish(0)
    h.sat('chat').finish(1)
    await Promise.all(turns)
  })
})

test('a session that fails to open fails its turn and is opened again next time', async () => {
  await withHarness({ auto: true }, async h => {
    await h.runner.run('chat', 'warm', 'x')
    h.sat('chat').openError = new Error('disk is full')
    await assert.rejects(h.runner.run('chat', 's0', 'x'), /disk is full/)
    assert.equal(h.sat('chat').calls.length, 1, 'the turn did not run')
    h.sat('chat').openError = undefined
    await h.runner.run('chat', 's0', 'x')
    assert.deepEqual(h.sat('chat').opened, ['warm', 's0', 's0'])
    assert.equal(h.runner.status('chat'), 'running')
  })
})

test('an open that never returns times out the turn, retires the process, and the queue runs after the restart', async () => {
  await withHarness({ maxConcurrentTurns: 1 }, async h => {
    h.openGate = new Promise<void>(() => {})
    const stuck = watch(h.runner.run('chat', 's0', 'x'))
    const queued = watch(h.runner.run('chat', 's1', 'y'))
    await settle()
    assert.equal(h.sat('chat').opened.length, 1)
    await h.clock.advance(179)
    assert.equal(stuck.state, 'pending')
    await h.clock.advance(1)
    assert.equal(stuck.state, 'rejected')
    assert.ok(stuck.error instanceof TurnInterruptedError)
    assert.equal((stuck.error as TurnInterruptedError).reason, 'timeout')
    assert.equal(h.sat('chat').closed, 1, 'the process the open was stuck on is closed')
    assert.equal(h.sat('chat').calls.length, 0, 'run was never reached')
    assert.equal(h.runner.status('chat'), 'restarting')
    assert.equal(h.clock.nextDelay, 1000, 'one failure was recorded')
    assert.equal(queued.state, 'pending')

    h.openGate = undefined
    await h.clock.advance(1000)
    assert.equal(h.sats.length, 2)
    assert.deepEqual(h.sat('chat', 1).calls.map(call => call.sessionId), ['s1'])
    h.sat('chat', 1).finish(0)
    await settle()
    assert.equal(queued.state, 'resolved')
  })
})

test('the open timeout is the caller\'s timeoutMs, or the class default, and run still gets the whole of it', async () => {
  await withHarness({}, async h => {
    h.openGate = new Promise<void>(() => {})
    const given = watch(h.runner.run('chat', 's0', 'x', { timeoutMs: 50 }))
    await settle()
    await h.clock.advance(49)
    assert.equal(given.state, 'pending')
    await h.clock.advance(1)
    assert.equal(given.state, 'rejected')
    h.runner.reset('chat')

    const activity = watch(h.runner.run('activity', 's1', 'x'))
    await settle()
    await h.clock.advance(599)
    assert.equal(activity.state, 'pending')
    await h.clock.advance(1)
    assert.equal((activity.error as TurnInterruptedError).reason, 'timeout')
  })
  await withHarness({}, async h => {
    const gate = deferred<void>()
    h.openGate = gate.promise
    const turn = watch(h.runner.run('chat', 's0', 'x'))
    await settle()
    await h.clock.advance(100)
    gate.resolve()
    await settle()
    assert.deepEqual(h.sat('chat').calls.map(call => call.options), [{ timeoutMs: 180 }], 'the time spent opening is not taken off')
    h.sat('chat').finish(0)
    await settle()
    assert.equal(turn.state, 'resolved')
  })
})

test('no open timer is left behind after an open that finished or failed', async () => {
  await withHarness({ auto: true, idleCloseMs: 1000 }, async h => {
    await h.runner.run('chat', 's0', 'x')
    assert.equal(h.clock.timers.size, 1)
    assert.equal(h.clock.nextDelay, 1000, 'only the idle countdown is left')

    h.sat('chat').openError = new Error('disk is full')
    await assert.rejects(h.runner.run('chat', 's1', 'x'), /disk is full/)
    assert.equal(h.clock.timers.size, 1)
    assert.equal(h.clock.nextDelay, 1000, 'a failed open leaves only the idle countdown too')
    await h.clock.advance(179)
    assert.equal(h.sats.length, 1, 'no late timeout interrupted anything')
  })
})

test('two turns waiting on the same open both time out, the process is retired once and one failure is recorded', async () => {
  await withHarness({ maxConcurrentTurns: 2 }, async h => {
    h.openGate = new Promise<void>(() => {})
    const turns = [watch(h.runner.run('chat', 's0', 'x')), watch(h.runner.run('chat', 's0', 'y'))]
    await settle()
    assert.deepEqual(h.sat('chat').opened, ['s0'], 'one open, two waiters')
    await h.clock.advance(180)
    assert.deepEqual(turns.map(turn => turn.state), ['rejected', 'rejected'])
    assert.deepEqual(turns.map(turn => (turn.error as TurnInterruptedError).reason), ['timeout', 'timeout'])
    assert.equal(h.sat('chat').closed, 1)
    h.openGate = undefined
    const next = h.runner.run('chat', 's2', 'x')
    await settle()
    assert.equal(h.clock.nextDelay, 1000, 'the first failure, not the second')
    h.runner.reset('chat')
    h.auto = true
    await next
  })
})

test('close while an open is stuck refuses the turn and leaves no timer', async () => {
  await withHarness({}, async h => {
    h.openGate = new Promise<void>(() => {})
    const turn = watch(h.runner.run('chat', 's0', 'x'))
    await settle()
    assert.equal(h.clock.timers.size, 1, 'the open timer')
    await h.runner.close()
    assert.equal(turn.state, 'rejected')
    assert.ok(turn.error instanceof RunnerFailedError)
    assert.equal((turn.error as RunnerFailedError).agentClass, 'chat')
    assert.equal(h.clock.timers.size, 0)
    assert.equal(h.sat('chat').closed, 1)
  })
})


// ---- invalidate ----

test('invalidate lets running turns finish, holds new ones, restarts when idle, then runs them', async () => {
  await withHarness({ maxConcurrentTurns: 2 }, async h => {
    const running = watch(h.runner.run('chat', 's0', 'x'))
    await settle()
    h.runner.invalidate('chat')
    const waiting = watch(h.runner.run('chat', 's1', 'x'))
    await settle()
    const old = h.sat('chat')
    assert.equal(old.closed, 0, 'a running turn is not interrupted')
    assert.equal(old.calls.length, 1, 'the new turn waits')
    assert.equal(h.sats.length, 1)
    assert.equal(waiting.state, 'pending')

    old.finish(0)
    await settle()
    assert.equal(running.state, 'resolved')
    assert.equal(old.closed, 1)
    assert.equal(h.sats.length, 2)
    assert.equal(h.configCalls, 2, 'the new process reads the config again')
    assert.deepEqual(h.sat('chat', 1).calls.map(call => call.sessionId), ['s1'])
    assert.deepEqual(h.sat('chat', 1).opened, ['s1'])
    h.sat('chat', 1).finish(0)
    await settle()
    assert.equal(waiting.state, 'resolved')
    assert.equal(h.runner.status('chat'), 'running')
  })
})

test('invalidate waits for every running turn and does not count as a failure', async () => {
  await withHarness({ maxConcurrentTurns: 2 }, async h => {
    const turns = [watch(h.runner.run('chat', 's0', 'x')), watch(h.runner.run('chat', 's1', 'x'))]
    await settle()
    h.runner.invalidate('chat')
    h.sat('chat').finish(0)
    await settle()
    assert.equal(h.sat('chat').closed, 0, 'one turn is still running')
    h.sat('chat').finish(1)
    await settle()
    assert.equal(h.sat('chat').closed, 1)
    assert.equal(turns.every(turn => turn.state === 'resolved'), true)
    h.auto = true
    await h.runner.run('chat', 's2', 'x')
    assert.equal(h.sats.length, 2, 'it restarted straight away, with no backoff')
  })
})

test('invalidate on an idle class closes the process and the next turn starts a new one', async () => {
  await withHarness({ auto: true }, async h => {
    await h.runner.run('chat', 's0', 'x')
    await h.runner.run('activity', 's1', 'x')
    h.runner.invalidate('chat')
    await settle()
    assert.equal(h.sat('chat').closed, 1)
    assert.equal(h.sat('activity').closed, 0, 'the other class is untouched')
    assert.equal(h.runner.status('chat'), 'stopped')
    await h.runner.run('chat', 's0', 'x')
    assert.equal(h.sats.length, 3)
  })
})

test('a new process waits for the old one to finish closing', async () => {
  await withHarness({ maxConcurrentTurns: 1 }, async h => {
    const first = h.runner.run('chat', 's0', 'x')
    await settle()
    const gate = deferred<void>()
    h.sat('chat').closeGate = gate.promise
    h.runner.invalidate('chat')
    h.sat('chat').finish(0)
    await first
    const second = watch(h.runner.run('chat', 's1', 'x'))
    await settle()
    assert.equal(h.sat('chat').closed, 1)
    assert.equal(h.sats.length, 1, 'no second process while the first is still closing')
    gate.resolve()
    await settle()
    assert.equal(h.sats.length, 2)
    h.sat('chat', 1).finish(0)
    await settle()
    assert.equal(second.state, 'resolved')
  })
})

test('a listener that starts a turn from inside the scheduler does not upset it', async () => {
  await withHarness({ auto: true }, async h => {
    await h.runner.run('chat', 's0', 'x')
    h.sat('chat').denied = 1
    h.dead.add(h.sat('chat').pid)
    // The dead process is retired while the scheduler is deciding what to do, and the report reaches here.
    let nested: Promise<TurnResult> | undefined
    const original = h.denied.push.bind(h.denied)
    h.denied.push = (...items) => {
      nested ??= h.runner.run('chat', 's9', 'from the listener')
      return original(...items)
    }
    const outer = h.runner.run('chat', 's0', 'again')
    assert.equal((await outer).finalResponse, 'done s0')
    assert.equal((await (nested as Promise<TurnResult>)).finalResponse, 'done s9')
    assert.equal(h.sats.length, 2, 'both turns ran on one new process')
    assert.deepEqual(h.sat('chat', 1).calls.map(call => call.sessionId).sort(), ['s0', 's9'])
  })
})

test('invalidate while the process is still starting restarts it once it is up', async () => {
  await withHarness({}, async h => {
    const gate = deferred<void>()
    h.startBehavior = () => gate.promise
    const turn = watch(h.runner.run('chat', 's0', 'x'))
    await settle()
    h.runner.invalidate('chat')
    h.startBehavior = async () => {}
    gate.resolve()
    await settle()
    assert.equal(h.sat('chat', 0).closed, 1)
    assert.equal(h.sats.length, 2)
    assert.equal(h.sat('chat', 0).calls.length, 0)
    assert.equal(h.sat('chat', 1).calls.length, 1)
    h.sat('chat', 1).finish(0)
    await settle()
    assert.equal(turn.state, 'resolved')
  })
})

// ---- idle ----

test('an idle process closes after idleCloseMs, and the next turn starts a new one and opens again', async () => {
  await withHarness({ auto: true, idleCloseMs: 1000 }, async h => {
    await h.runner.run('chat', 's0', 'x')
    await h.clock.advance(999)
    assert.equal(h.sat('chat').closed, 0)
    assert.equal(h.runner.status('chat'), 'running')
    await h.clock.advance(1)
    assert.equal(h.sat('chat').closed, 1)
    assert.equal(h.runner.status('chat'), 'stopped')
    await h.runner.run('chat', 's0', 'x')
    assert.equal(h.sats.length, 2)
    assert.deepEqual(h.sat('chat', 1).opened, ['s0'])
  })
})

test('a turn arriving while the process is idle cancels the countdown', async () => {
  await withHarness({ auto: true, idleCloseMs: 1000 }, async h => {
    await h.runner.run('chat', 's0', 'x')
    await h.clock.advance(600)
    await h.runner.run('chat', 's0', 'y')
    await h.clock.advance(600)
    assert.equal(h.sat('chat').closed, 0, 'the countdown started again after the second turn')
    await h.clock.advance(400)
    assert.equal(h.sat('chat').closed, 1)
  })
})

test('a process is not closed for idleness while a turn runs or is queued', async () => {
  await withHarness({ idleCloseMs: 1000, maxConcurrentTurns: 1 }, async h => {
    const turns = [h.runner.run('chat', 's0', 'x'), h.runner.run('chat', 's1', 'x')]
    await h.clock.advance(5000)
    assert.equal(h.sat('chat').closed, 0)
    h.sat('chat').finish(0)
    await settle()
    await h.clock.advance(5000)
    assert.equal(h.sat('chat').closed, 0)
    h.sat('chat').finish(1)
    await Promise.all(turns)
    await h.clock.advance(999)
    assert.equal(h.sat('chat').closed, 0)
    await h.clock.advance(1)
    assert.equal(h.sat('chat').closed, 1)
  })
})

test('each class counts its own idle time', async () => {
  await withHarness({ auto: true, idleCloseMs: 1000 }, async h => {
    await h.runner.run('chat', 's0', 'x')
    await h.clock.advance(500)
    await h.runner.run('activity', 's1', 'x')
    await h.clock.advance(500)
    assert.equal(h.sat('chat').closed, 1)
    assert.equal(h.sat('activity').closed, 0)
    await h.clock.advance(500)
    assert.equal(h.sat('activity').closed, 1)
  })
})

// ---- purge ----

async function pendingOnDisk(file: string): Promise<string[]> {
  return JSON.parse(await readFile(file, 'utf8')) as string[]
}

test('purge deletes at once, keeps what is locked on the list and on disk, and retries after a close', async () => {
  await withHarness({ auto: true, idleCloseMs: 1000 }, async h => {
    h.locked.add('b')
    await h.runner.purge(['a', 'b'])
    assert.deepEqual(h.purgeCalls, [['a', 'b']])
    assert.deepEqual(await pendingOnDisk(h.purgeFile), ['b'])
    assert.deepEqual(await readdir(path.dirname(h.purgeFile)), ['purge.json'], 'the temporary file is gone')

    await h.runner.run('chat', 's0', 'x')
    assert.deepEqual(h.purgeCalls, [['a', 'b'], ['b']], 'retried before the process starts')
    h.locked.delete('b')
    await h.clock.advance(1000)
    await until(() => h.purgeCalls.length === 3)
    assert.deepEqual(h.purgeCalls[2], ['b'], 'retried after the process closed')
    await until(async () => (await pendingOnDisk(h.purgeFile)).length === 0)
  })
})

test('the list is on disk before the purge function runs, so a crash in the middle loses nothing', async () => {
  await withHarness({}, async h => {
    let onDisk: string[] = []
    h.onPurge = () => {
      onDisk = JSON.parse(readFileSync(h.purgeFile, 'utf8')) as string[]
    }
    await h.runner.purge(['a', 'b'])
    assert.deepEqual(onDisk, ['a', 'b'])
    assert.deepEqual(await pendingOnDisk(h.purgeFile), [])
  })
})

test('the list is written to a temporary file and moved into place', async () => {
  await withHarness({}, async h => {
    await h.runner.purge([])
    await mkdir(path.dirname(h.purgeFile), { recursive: true })
    await writeFile(h.purgeFile, '["old"]')
    // A directory in the temporary file's place makes the write fail; the real file must stay as it was.
    await mkdir(`${h.purgeFile}.tmp`)
    await assert.rejects(h.runner.purge(['a']))
    assert.equal(await readFile(h.purgeFile, 'utf8'), '["old"]')
  })
})

test('a purge that is still locked after the close stays on the list', async () => {
  await withHarness({ auto: true, idleCloseMs: 1000 }, async h => {
    await h.runner.run('chat', 's0', 'x')
    h.locked.add('b')
    await h.runner.purge(['b'])
    await h.clock.advance(1000)
    await until(() => h.purgeCalls.length === 2)
    await until(async () => (await pendingOnDisk(h.purgeFile)).length === 1)
    assert.deepEqual(await pendingOnDisk(h.purgeFile), ['b'])
  })
})

test('the purge retry comes after the process has closed, not before', async () => {
  await withHarness({ auto: true, idleCloseMs: 1000 }, async h => {
    await h.runner.run('chat', 's0', 'x')
    h.events.length = 0
    h.locked.add('b')
    await h.runner.purge(['b'])
    await h.clock.advance(1000)
    await until(() => h.events.filter(event => event === 'purge').length === 2)
    assert.deepEqual(h.events, ['purge', 'close:chat', 'purge'])
  })
})

test('the pending list survives a new supervisor and is retried before its first process starts', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brain-supervisor-persist-'))
  const purgeFile = path.join(dir, 'purge.json')
  try {
    await withHarness({ purgeFile }, async h => {
      h.locked.add('b')
      h.locked.add('c')
      await h.runner.purge(['b', 'c'])
    })
    assert.deepEqual(await pendingOnDisk(purgeFile), ['b', 'c'])
    await withHarness({ purgeFile, auto: true }, async h => {
      assert.deepEqual(h.purgeCalls, [], 'nothing runs when the supervisor is built')
      await h.runner.run('chat', 's0', 'x')
      assert.deepEqual(h.purgeCalls, [['b', 'c']])
      assert.deepEqual(h.events.slice(0, 2), ['purge', 'start:chat'], 'the retry comes before the start')
      await until(async () => (await pendingOnDisk(purgeFile)).length === 0)
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a missing or broken purge file counts as empty', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brain-supervisor-broken-'))
  try {
    for (const content of [undefined, '{not json', '{"a":1}', '["x",3,null]']) {
      const purgeFile = path.join(dir, `purge-${String(content).length}.json`)
      if (content !== undefined) await writeFile(purgeFile, content)
      await withHarness({ purgeFile, auto: true }, async h => {
        await h.runner.run('chat', 's0', 'x')
        assert.deepEqual(h.purgeCalls, content === '["x",3,null]' ? [['x']] : [], `content: ${String(content)}`)
      })
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a purge function that throws leaves the ids on the list and does not fail the caller', async () => {
  await withHarness({}, async h => {
    h.purgeError = new Error('EACCES')
    await h.runner.purge(['a'])
    assert.deepEqual(await pendingOnDisk(h.purgeFile), ['a'])
  })
})

test('purging nothing does nothing, and the same id twice is purged once', async () => {
  await withHarness({}, async h => {
    await h.runner.purge([])
    assert.deepEqual(h.purgeCalls, [])
    await h.runner.purge(['a', 'a'])
    assert.deepEqual(h.purgeCalls, [['a']])
  })
})

test('a purge that is retried does not stop a turn from starting', async () => {
  await withHarness({ auto: true }, async h => {
    h.locked.add('a')
    h.purgeError = new Error('EACCES')
    await h.runner.purge(['a'])
    assert.equal((await h.runner.run('chat', 's0', 'x')).finalResponse, 'done s0')
  })
})

// ---- approvals ----

test('refused approvals are reported as the increase since the last report', async () => {
  await withHarness({ idleCloseMs: 1000 }, async h => {
    const first = h.runner.run('chat', 's0', 'x')
    await settle()
    h.sat('chat').denied = 2
    h.sat('chat').finish(0)
    await first
    assert.deepEqual(h.denied, [['chat', 2]])
    const second = h.runner.run('chat', 's0', 'x')
    await settle()
    h.sat('chat').finish(1)
    await second
    assert.deepEqual(h.denied, [['chat', 2]], 'nothing new, nothing reported')
    const third = h.runner.run('chat', 's0', 'x')
    await settle()
    h.sat('chat').denied = 5
    h.sat('chat').finish(2)
    await third
    assert.deepEqual(h.denied, [['chat', 2], ['chat', 3]])
    h.sat('chat').denied = 6
    await h.clock.advance(1000)
    assert.deepEqual(h.denied, [['chat', 2], ['chat', 3], ['chat', 1]], 'the close reports what the last turn did not')
  })
})

test('a new process starts counting from zero', async () => {
  await withHarness({ auto: true }, async h => {
    await h.runner.run('chat', 's0', 'x')
    h.sat('chat').denied = 4
    h.runner.invalidate('chat')
    await settle()
    assert.deepEqual(h.denied, [['chat', 4]])
    const next = h.runner.run('chat', 's0', 'x')
    await settle()
    h.sat('chat', 1).denied = 1
    await next
    h.runner.invalidate('chat')
    await settle()
    assert.deepEqual(h.denied, [['chat', 4], ['chat', 1]])
  })
})

test('a crash reports the refused approvals before the process is dropped', async () => {
  await withHarness({}, async h => {
    const turn = watch(h.runner.run('activity', 's0', 'x'))
    await settle()
    h.sat('activity').denied = 3
    h.sat('activity').fail(0, crash())
    await settle()
    assert.equal(turn.state, 'rejected')
    assert.deepEqual(h.denied, [['activity', 3]])
    assert.ok(h.events.indexOf('denied:activity:3') < h.events.indexOf('close:activity'))
  })
})

test('a listener that throws does not stop the turn or the scheduler', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brain-supervisor-listener-'))
  try {
    const satellite = new Map<string, number>()
    const runner = createSupervisor({
      factory: async () => ({
        pid: undefined,
        get deniedApprovals() {
          return 1
        },
        start: async () => {},
        open: async () => 'new' as const,
        run: async () => reply('fine'),
        close: async () => {},
      }),
      config: async () => ({ selection: { provider: 'p', model: 'm', effort: 'low' }, apiKey: 'k', systemPrompt: 's', catalog: [] }),
      purge: async () => [],
      now: () => 0,
      maxConcurrentTurns: 1,
      idleCloseMs: 1000,
      turnTimeoutMs: { chat: 1, activity: 1 },
      restart: { baseMs: 1, maxMs: 1, maxFailures: 5, windowMs: 1 },
      onDeniedApprovals: () => {
        satellite.set('called', 1)
        throw new Error('listener bug')
      },
      purgeFile: path.join(dir, 'purge.json'),
    })
    assert.equal((await runner.run('chat', 's0', 'x')).finalResponse, 'fine')
    assert.equal((await runner.run('chat', 's0', 'x')).finalResponse, 'fine')
    assert.equal(satellite.get('called'), 1)
    await runner.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---- close ----

test('close refuses the queue, closes every process, clears every timer, and later turns are refused', async () => {
  await withHarness({ maxConcurrentTurns: 1, idleCloseMs: 1000 }, async h => {
    const running = watch(h.runner.run('chat', 's0', 'x'))
    const queued = watch(h.runner.run('chat', 's1', 'x'))
    const other = watch(h.runner.run('activity', 's2', 'x'))
    await settle()
    h.sat('chat').fail(0, crash())
    await settle()
    assert.equal(running.state, 'rejected')
    assert.equal(h.sat('activity').calls.length, 1, 'the freed slot went to activity while chat waits to restart')
    assert.equal(h.clock.timers.size, 1, 'a restart is waiting')
    await h.runner.close()
    assert.equal(queued.state, 'rejected')
    assert.ok(queued.error instanceof RunnerFailedError)
    assert.equal(h.clock.timers.size, 0)
    for (const satellite of h.sats) assert.equal(satellite.closed >= 1, true)
    assert.equal(other.state, 'pending', 'a turn already running is ended by its process closing, not by the supervisor')
    h.sat('activity').fail(0, crash())
    await settle()
    assert.equal(other.state, 'rejected')
    await assert.rejects(h.runner.run('chat', 's3', 'x'), RunnerFailedError)
    await assert.rejects(h.runner.run('activity', 's3', 'x'), RunnerFailedError)
    await h.clock.advance(100_000)
    assert.equal(h.sats.length, 2, 'nothing restarts after close')
    assert.equal(h.clock.timers.size, 0)
  })
})

test('close closes the idle timer and live processes of both classes', async () => {
  await withHarness({ auto: true, idleCloseMs: 1000 }, async h => {
    await h.runner.run('chat', 's0', 'x')
    await h.runner.run('activity', 's1', 'x')
    assert.equal(h.clock.timers.size, 2)
    await h.runner.close()
    assert.equal(h.clock.timers.size, 0)
    assert.equal(h.sat('chat').closed, 1)
    assert.equal(h.sat('activity').closed, 1)
    await h.runner.close()
    assert.equal(h.sat('chat').closed, 1, 'closing twice closes the process once')
  })
})

test('close during a start closes the process that was coming up and uses none', async () => {
  await withHarness({}, async h => {
    const gate = deferred<void>()
    h.startBehavior = () => gate.promise
    const turn = watch(h.runner.run('chat', 's0', 'x'))
    await settle()
    const closing = h.runner.close()
    gate.resolve()
    await closing
    assert.equal(turn.state, 'rejected')
    assert.equal(h.sat('chat').closed, 1)
    assert.equal(h.sat('chat').calls.length, 0)
    assert.equal(h.runner.status('chat'), 'stopped')
  })
})

test('close while the config is being read starts no process at all', async () => {
  await withHarness({}, async h => {
    const gate = deferred<void>()
    h.configGate = gate.promise
    const turn = watch(h.runner.run('chat', 's0', 'x'))
    await settle()
    const closing = h.runner.close()
    gate.resolve()
    await closing
    assert.equal(turn.state, 'rejected')
    assert.equal(h.sats.length, 0)
  })
})

test('close during a restart backoff drops the timer', async () => {
  await withHarness({}, async h => {
    h.startBehavior = async () => {
      throw new Error('cannot start')
    }
    const turn = watch(h.runner.run('chat', 's0', 'x'))
    await settle()
    assert.equal(h.runner.status('chat'), 'restarting')
    await h.runner.close()
    assert.equal(turn.state, 'rejected')
    assert.equal(h.clock.timers.size, 0)
  })
})

test('turns arriving during the backoff share the one restart timer, and close clears it', async () => {
  await withHarness({}, async h => {
    h.startBehavior = async () => {
      throw new Error('cannot start')
    }
    const first = watch(h.runner.run('chat', 's0', 'x'))
    await settle()
    assert.equal(h.runner.status('chat'), 'restarting')
    const second = watch(h.runner.run('chat', 's1', 'x'))
    const third = watch(h.runner.run('chat', 's2', 'x'))
    await settle()
    assert.equal(h.clock.timers.size, 1, 'the restart is armed once, however many turns queue up')
    await h.runner.close()
    assert.equal(h.clock.timers.size, 0, 'and the one handle is the one close can clear')
    for (const turn of [first, second, third]) assert.equal(turn.state, 'rejected')
  })
})

// ---- the real satellite ----

function runResult(events: readonly object[], finalResponse = 'final'): RunResult {
  return { sessionId: 's', finalResponse, finishReason: 'stop', events: events as RunResult['events'], notifications: [] }
}

class FakeHandle implements SatelliteHandle {
  readonly log: string[] = []
  readonly runs: { sessionId: string; input: unknown; options: unknown }[] = []
  deniedApprovals = 0
  resume: (sessionId: string) => Promise<void> = async () => {}
  result: RunResult = runResult([])
  runError: Error | undefined
  closeError: Error | undefined

  async start(): Promise<void> {
    this.log.push('satellite.start')
  }

  async run(sessionId: string, input: unknown, options?: unknown): Promise<RunResult> {
    this.runs.push({ sessionId, input, options })
    if (this.runError !== undefined) throw this.runError
    return this.result
  }

  async close(): Promise<void> {
    this.log.push('satellite.close')
    if (this.closeError !== undefined) throw this.closeError
  }
}

class FakeBridge implements BridgeHandle {
  childPid: number | undefined = 4242
  surfaceCheck: BridgeHandle['surfaceCheck']
  closed = 0
  readonly #log: string[]

  constructor(log: string[]) {
    this.#log = log
  }

  async close(): Promise<void> {
    this.closed += 1
    this.#log.push('bridge.close')
  }
}

function wrapped(options: Parameters<typeof wrapSatellite>[2] = { setPriority: () => {} }) {
  const handle = new FakeHandle()
  const bridge = new FakeBridge(handle.log)
  return { handle, bridge, satellite: wrapSatellite(handle, bridge, options) }
}

test('a result is turned into per-step usage, a retry count and a compaction flag', async () => {
  const { handle, satellite } = wrapped()
  handle.result = runResult([
    { type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 7, cacheWriteTokens: 1 } } },
    { type: 'llm/retry' },
    { type: 'assistant/message', data: { usage: { inputTokens: 5 } } },
    { type: 'assistant/message', data: {} },
    { type: 'assistant/message' },
    { type: 'tool/call', data: { usage: { inputTokens: 99 } } },
    { type: 'llm/retry' },
    { type: 'compaction/end' },
    { type: 'compaction/start' },
  ], 'the answer')
  assert.deepEqual(await satellite.run('s', 'hi'), {
    finalResponse: 'the answer',
    steps: [
      { inputTokens: 10, outputTokens: 2, cacheReadTokens: 7, cacheWriteTokens: 1 },
      { inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ],
    retries: 2,
    compacted: true,
  })
})

test('a result with no retries and no compaction says so', async () => {
  const { handle, satellite } = wrapped()
  handle.result = runResult([{ type: 'compaction/start' }, { type: 'assistant/message', data: { usage: {} } }])
  assert.deepEqual(await satellite.run('s', 'hi'), {
    finalResponse: 'final',
    steps: [{ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }],
    retries: 0,
    compacted: false,
  })
})

test('text goes through as it is and images become DSH image blocks, with the timeout passed on', async () => {
  const { handle, satellite } = wrapped()
  await satellite.run('s0', 'plain text', { timeoutMs: 50 })
  await satellite.run('s1', [{ type: 'text', text: 'look at this' }, { type: 'image', mediaType: 'image/jpeg', base64: 'QUJD' }])
  assert.deepEqual(handle.runs[0], { sessionId: 's0', input: 'plain text', options: { timeoutMs: 50 } })
  assert.deepEqual(handle.runs[1]?.input, [
    { type: 'text', text: 'look at this' },
    { type: 'image', data: 'QUJD', mimeType: 'image/jpeg' },
  ])
  assert.equal(handle.runs[1]?.options, undefined)
})

test('open says resumed when the session is on disk, new when it is not, and fails on anything else', async () => {
  const { handle, satellite } = wrapped()
  const seen: string[] = []
  handle.resume = async id => {
    seen.push(id)
  }
  assert.equal(await satellite.open('s0'), 'resumed')
  assert.deepEqual(seen, ['s0'])
  handle.resume = async () => {
    throw new Error('session s1 not found')
  }
  assert.equal(await satellite.open('s1'), 'new')
  handle.resume = async () => {
    throw new Error('permission denied')
  }
  await assert.rejects(satellite.open('s2'), /permission denied/)
})

test('a child that dies while a session is being opened is a crash interruption', async () => {
  const { handle, satellite } = wrapped()
  handle.resume = async () => {
    throw new TransportClosedError('the child exited')
  }
  await assert.rejects(satellite.open('s0'), (error: unknown) => {
    assert.ok(error instanceof TurnInterruptedError)
    assert.equal(error.reason, 'crash')
    return true
  })
})

test('a satellite timeout becomes a timeout interruption', async () => {
  const { handle, satellite } = wrapped()
  handle.runError = new TurnTimeoutError('s0', 1500)
  await assert.rejects(satellite.run('s0', 'x'), (error: unknown) => {
    assert.ok(error instanceof TurnInterruptedError)
    assert.equal(error.reason, 'timeout')
    assert.match(error.message, /1500/)
    return true
  })
})

test('a closed transport, or any error named Transport, becomes a crash interruption', async () => {
  const { handle, satellite } = wrapped()
  const renamed = Object.assign(new TransportClosedError('the child exited'), { name: 'SomethingElse' })
  for (const error of [new TransportClosedError('the child exited'), renamed, Object.assign(new Error('pipe broke'), { name: 'TransportWriteError' })]) {
    handle.runError = error
    await assert.rejects(satellite.run('s0', 'x'), (caught: unknown) => {
      assert.ok(caught instanceof TurnInterruptedError)
      assert.equal(caught.reason, 'crash')
      assert.equal(caught.message, error.message)
      return true
    })
  }
})

test('any other error from the satellite passes through unchanged', async () => {
  const { handle, satellite } = wrapped()
  const failure = new Error('the model said no')
  handle.runError = failure
  await assert.rejects(satellite.run('s0', 'x'), (caught: unknown) => caught === failure)
})

test('a tool surface that differs from the catalog closes the process and refuses the turn', async () => {
  const { handle, bridge, satellite } = wrapped()
  bridge.surfaceCheck = { ok: false, unexpected: ['bash'], missing: [] }
  await assert.rejects(satellite.run('s0', 'x'), (error: unknown) => {
    assert.ok(error instanceof TurnInterruptedError)
    assert.equal(error.reason, 'crash')
    assert.equal(error.message, 'tool surface differs from the catalog')
    return true
  })
  assert.equal(handle.runs.length, 0)
  assert.deepEqual(handle.log, ['satellite.close', 'bridge.close'])
  bridge.surfaceCheck = { ok: true, unexpected: [], missing: [] }
})

test('a matching tool surface lets the turn run', async () => {
  const { handle, bridge, satellite } = wrapped()
  bridge.surfaceCheck = { ok: true, unexpected: [], missing: [] }
  await satellite.run('s0', 'x')
  assert.equal(handle.runs.length, 1)
  assert.equal(bridge.closed, 0)
})

test('the child runs at a lower priority once started, and a refusal is ignored', async () => {
  const calls: [number, number][] = []
  const first = wrapped({ setPriority: (pid, priority) => { calls.push([pid, priority]) } })
  await first.satellite.start()
  assert.deepEqual(calls, [[4242, 10]])
  assert.deepEqual(first.handle.log, ['satellite.start'])

  const unknownPid = wrapped({ setPriority: () => assert.fail('no pid to lower') })
  unknownPid.bridge.childPid = undefined
  await unknownPid.satellite.start()

  const refused = wrapped({ setPriority: () => { throw new Error('EPERM') } })
  await refused.satellite.start()
})

test('a child whose pid is not known yet is left at its priority instead of being passed undefined', async () => {
  const calls: number[] = []
  const { bridge, satellite } = wrapped({ setPriority: pid => { calls.push(pid) } })
  bridge.childPid = undefined
  await satellite.start()
  assert.deepEqual(calls, [], 'setPriority is not called without a pid')
  bridge.childPid = 99
  await satellite.start()
  assert.deepEqual(calls, [99], 'a later start with a pid does lower it')
})

test('close closes the satellite then the bridge, once, even when the satellite fails to close', async () => {
  const { handle, bridge, satellite } = wrapped()
  handle.closeError = new Error('already gone')
  await assert.rejects(satellite.close(), /already gone/)
  await assert.rejects(satellite.close(), /already gone/)
  assert.deepEqual(handle.log, ['satellite.close', 'bridge.close'])
  assert.equal(bridge.closed, 1)
})

test('pid and approvals are read live from the bridge and the satellite', () => {
  const { handle, bridge, satellite } = wrapped()
  assert.equal(satellite.pid, 4242)
  bridge.childPid = undefined
  assert.equal(satellite.pid, undefined)
  handle.deniedApprovals = 3
  assert.equal(satellite.deniedApprovals, 3)
})

test('the real factory gives each call its own bridge and a satellite that can be closed before it starts', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brain-factory-'))
  try {
    const factory = createRealSatelliteFactory({
      brainHome: dir,
      surfaceOf: () => new Set(),
      dispatch: async () => 'ok',
      parentEnv: {},
      maxOldSpaceMb: 256,
      proxy: { http: 'http://127.0.0.1:1' },
    })
    const config: ProcessConfig = { selection: { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'low' }, apiKey: 'fake', systemPrompt: 'p', catalog: [] }
    const first = await factory('chat', config)
    const second = await factory('activity', config)
    assert.equal(first.pid, undefined)
    assert.equal(first.deniedApprovals, 0)
    await first.close()
    await second.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
