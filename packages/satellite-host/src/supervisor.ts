/** One DSH process per agent class: starts on demand, queues turns, restarts after failures, closes when idle. */
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isProcessAlive } from './platform.ts'
import { SelectionMissingError, type AgentClass } from './selection.ts'
import {
  RunnerFailedError,
  TurnInterruptedError,
  type ProcessConfig,
  type RunnerStatus,
  type SatelliteFactory,
  type SatelliteLike,
  type TurnInput,
  type TurnResult,
  type TurnRunner,
} from './turn.ts'

export interface SupervisorOptions {
  readonly factory: SatelliteFactory
  readonly config: (agentClass: AgentClass) => Promise<ProcessConfig>   // SelectionMissingError when nothing is chosen
  readonly purge: (sessionIds: readonly string[]) => Promise<readonly string[]>
  readonly now: () => number
  readonly maxConcurrentTurns: number                                   // 2
  readonly idleCloseMs: number                                          // 600_000
  readonly turnTimeoutMs: Readonly<Record<AgentClass, number>>          // chat 180_000, activity 600_000
  readonly restart: { readonly baseMs: number; readonly maxMs: number; readonly maxFailures: number; readonly windowMs: number }   // 1_000, 16_000, 5, 120_000
  readonly onDeniedApprovals?: (agentClass: AgentClass, count: number) => void
  /** Sessions still waiting to be deleted survive a kernel restart here (state/agent/purge.json). */
  readonly purgeFile: string
  /** Defaults to isProcessAlive; tests pass a fake. */
  readonly isAlive?: (pid: number) => boolean
  /** Defaults to the global timers; tests pass fakes. */
  readonly timers?: { readonly set: (run: () => void, ms: number) => unknown; readonly clear: (handle: unknown) => void }
}

/** Chat is looked at first whenever a slot frees up. */
const CLASSES: readonly AgentClass[] = ['chat', 'activity']

const GLOBAL_TIMERS = {
  set: (run: () => void, ms: number): unknown => setTimeout(run, ms),
  clear: (handle: unknown): void => clearTimeout(handle as NodeJS.Timeout),
}

interface QueuedTurn {
  readonly sessionId: string
  readonly input: TurnInput
  readonly options: { readonly timeoutMs?: number } | undefined
  readonly resolve: (result: TurnResult) => void
  readonly reject: (error: unknown) => void
}

/** One live satellite. Replaced, never reused, after a restart. */
interface Process {
  readonly satellite: SatelliteLike
  /** Sessions this process has opened, so each is opened once. Dropped on failure so the next turn tries again. */
  readonly opened: Map<string, Promise<void>>
  /** How many refused approvals were already handed to onDeniedApprovals. */
  reportedDenied: number
}

interface ClassState {
  readonly queue: QueuedTurn[]
  process: Process | undefined
  running: number
  starting: Promise<void> | undefined
  /** Closing the old process; nothing new starts until it is done. */
  closing: Promise<void> | undefined
  dirty: boolean
  failed: boolean
  /** Failure times inside the window. */
  failures: number[]
  /** No new process before this time. */
  notBefore: number
  restartTimer: unknown
  idleTimer: unknown
}

function loadPending(file: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

class Supervisor implements TurnRunner {
  readonly #options: SupervisorOptions
  readonly #isAlive: (pid: number) => boolean
  readonly #timers: NonNullable<SupervisorOptions['timers']>
  readonly #states: Readonly<Record<AgentClass, ClassState>> = { chat: this.#freshState(), activity: this.#freshState() }
  readonly #pendingPurge: Set<string>
  #purgeChain: Promise<unknown> = Promise.resolve()
  #running = 0
  #pumping = false
  #pumpAgain = false
  #closed = false
  #closing: Promise<void> | undefined
  /** One entry per turn waiting on an open, so a stuck open cannot hold a slot forever. */
  readonly #openWaits = new Map<unknown, { readonly agentClass: AgentClass; readonly cancel: (error: Error) => void }>()

  constructor(options: SupervisorOptions) {
    this.#options = options
    this.#isAlive = options.isAlive ?? isProcessAlive
    this.#timers = options.timers ?? GLOBAL_TIMERS
    this.#pendingPurge = loadPending(options.purgeFile)
  }

  run(agentClass: AgentClass, sessionId: string, input: TurnInput, options?: { readonly timeoutMs?: number }): Promise<TurnResult> {
    const state = this.#states[agentClass] as ClassState | undefined
    if (state === undefined) return Promise.reject(new RangeError(`unknown agent class "${String(agentClass)}"`))
    if (this.#closed) return Promise.reject(new RunnerFailedError(agentClass, 'the supervisor is closed'))
    return new Promise<TurnResult>((resolve, reject) => {
      state.queue.push({ sessionId, input, options, resolve, reject })
      this.#pump()
    })
  }

  invalidate(agentClass: AgentClass): void {
    this.#states[agentClass].dirty = true
    this.#pump()
  }

  status(agentClass: AgentClass): RunnerStatus {
    const state = this.#states[agentClass]
    if (state.failed) return 'failed'
    if (state.restartTimer !== undefined) return 'restarting'
    if (state.process !== undefined || state.starting !== undefined) return 'running'
    return 'stopped'
  }

  reset(agentClass: AgentClass): void {
    const state = this.#states[agentClass]
    state.failed = false
    state.failures = []
    state.notBefore = 0
    this.#clearRestartTimer(state)
    this.#pump()
  }

  purge(sessionIds: readonly string[]): Promise<void> {
    return this.#serialPurge(async () => {
      const ids = [...new Set(sessionIds)]
      if (ids.length === 0) return
      for (const id of ids) this.#pendingPurge.add(id)
      await this.#persistPurge()
      await this.#attemptPurge(ids)
    })
  }

  close(): Promise<void> {
    this.#closing ??= this.#shutdown()
    return this.#closing
  }

  #freshState(): ClassState {
    return { queue: [], process: undefined, running: 0, starting: undefined, closing: undefined, dirty: false, failed: false, failures: [], notBefore: 0, restartTimer: undefined, idleTimer: undefined }
  }

  async #shutdown(): Promise<void> {
    this.#closed = true
    for (const { agentClass, cancel } of [...this.#openWaits.values()]) {
      cancel(new RunnerFailedError(agentClass, 'the supervisor is closing'))
    }
    for (const agentClass of CLASSES) {
      const state = this.#states[agentClass]
      this.#clearRestartTimer(state)
      this.#rejectQueue(agentClass, new RunnerFailedError(agentClass, 'the supervisor is closing'))
    }
    await Promise.all(CLASSES.map(async agentClass => {
      const state = this.#states[agentClass]
      // A start in flight closes its own satellite once it sees the supervisor is closed.
      await state.starting
      await state.closing
      if (state.process !== undefined) this.#retire(agentClass, state.process)
      await state.closing
    }))
  }

  // ---- the scheduler ----

  /** Everything that can change what runs next calls this; it is safe to call from inside itself. */
  #pump(): void {
    if (this.#pumping) {
      this.#pumpAgain = true
      return
    }
    this.#pumping = true
    try {
      do {
        this.#pumpAgain = false
        if (this.#closed) break
        for (const agentClass of CLASSES) this.#prepare(agentClass)
        for (let next = this.#nextToDispatch(); next !== undefined; next = this.#nextToDispatch()) this.#dispatch(next)
        for (const agentClass of CLASSES) this.#updateIdleTimer(agentClass)
      } while (this.#pumpAgain)
    } finally {
      this.#pumping = false
    }
  }

  /** Moves a class towards "has a usable process" without starting any turn. */
  #prepare(agentClass: AgentClass): void {
    const state = this.#states[agentClass]
    if (state.failed) return this.#rejectQueue(agentClass, this.#failedError(agentClass))
    if (state.closing !== undefined || state.starting !== undefined) return
    if (state.process !== undefined && state.queue.length > 0 && this.#isDead(state.process)) {
      this.#retire(agentClass, state.process)
      this.#recordFailure(agentClass, false)
      return
    }
    if (state.dirty) {
      if (state.running > 0) return
      state.dirty = false
      if (state.process !== undefined) return this.#retire(agentClass, state.process)
    }
    if (state.queue.length === 0 || state.process !== undefined) return
    const wait = state.notBefore - this.#options.now()
    if (wait > 0) return this.#armRestartTimer(agentClass, wait)
    this.#startProcess(agentClass)
  }

  #isDead(process: Process): boolean {
    const { pid } = process.satellite
    return pid !== undefined && !this.#isAlive(pid)
  }

  /** Chat first; activity may hold fewer slots so its long turns cannot starve chat. */
  #nextToDispatch(): AgentClass | undefined {
    const max = this.#options.maxConcurrentTurns
    if (this.#running >= max) return undefined
    return CLASSES.find(agentClass => {
      const state = this.#states[agentClass]
      if (state.queue.length === 0 || state.process === undefined || state.dirty || state.closing !== undefined) return false
      return state.running < (agentClass === 'activity' ? Math.max(1, max - 1) : max)
    })
  }

  #dispatch(agentClass: AgentClass): void {
    const state = this.#states[agentClass]
    const process = state.process as Process
    const turn = state.queue.shift() as QueuedTurn
    state.running += 1
    this.#running += 1
    void this.#execute(agentClass, process, turn)
  }

  async #execute(agentClass: AgentClass, process: Process, turn: QueuedTurn): Promise<void> {
    const state = this.#states[agentClass]
    try {
      const timeoutMs = turn.options?.timeoutMs ?? this.#options.turnTimeoutMs[agentClass]
      // The open gets its own full timeout: the SDK's resume has none, and a stuck one would lose the wake-up.
      await this.#openWithTimeout(agentClass, process, turn.sessionId, timeoutMs)
      const result = await process.satellite.run(turn.sessionId, turn.input, { timeoutMs })
      state.failures = []
      turn.resolve(result)
    } catch (error) {
      // The turn is not re-run here: whether it may be run again is the caller's call.
      if (error instanceof TurnInterruptedError) this.#interrupted(agentClass, process)
      turn.reject(error)
    } finally {
      state.running -= 1
      this.#running -= 1
      this.#reportDenied(agentClass, process)
      this.#pump()
    }
  }

  /** Resolves once the session is open, or rejects with a timeout interruption if that takes too long. */
  #openWithTimeout(agentClass: AgentClass, process: Process, sessionId: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const handle: unknown = this.#timers.set(() => {
        settle(() => reject(new TurnInterruptedError('timeout', `opening ${sessionId} exceeded ${timeoutMs} ms`)))
      }, timeoutMs)
      const settle = (apply: () => void): void => {
        if (settled) return
        settled = true
        this.#openWaits.delete(handle)
        this.#timers.clear(handle)
        apply()
      }
      this.#openWaits.set(handle, { agentClass, cancel: error => settle(() => reject(error)) })
      this.#open(process, sessionId).then(() => settle(resolve), (error: unknown) => settle(() => reject(error)))
    })
  }

  #open(process: Process, sessionId: string): Promise<void> {
    let opening = process.opened.get(sessionId)
    if (opening === undefined) {
      opening = (async () => { await process.satellite.open(sessionId) })()
      process.opened.set(sessionId, opening)
      void opening.catch(() => process.opened.delete(sessionId))
    }
    return opening
  }

  // ---- starting, stopping, failing ----

  #startProcess(agentClass: AgentClass): void {
    const state = this.#states[agentClass]
    state.starting = this.#bringUp(agentClass).then(
      process => {
        state.starting = undefined
        if (process !== undefined) state.process = process
      },
      (error: unknown) => {
        state.starting = undefined
        if (error instanceof SelectionMissingError) this.#rejectQueue(agentClass, error)
        else this.#recordFailure(agentClass, true)
      },
    ).finally(() => this.#pump())
  }

  /** Resolves with nothing when the supervisor closed before the process was made; one made during a close is retired by it. */
  async #bringUp(agentClass: AgentClass): Promise<Process | undefined> {
    await this.#retryPurge()
    const config = await this.#options.config(agentClass)
    if (this.#closed) return undefined
    const satellite = await this.#options.factory(agentClass, config)
    try {
      await satellite.start()
    } catch (error) {
      await satellite.close().catch(() => {})
      throw error
    }
    return { satellite, opened: new Map(), reportedDenied: 0 }
  }

  /** Detaches the process at once so nothing new uses it, then closes it and retries the purge. */
  #retire(agentClass: AgentClass, process: Process): void {
    const state = this.#states[agentClass]
    this.#reportDenied(agentClass, process)
    if (state.process === process) state.process = undefined
    this.#clearIdleTimer(state)
    state.closing = (async () => {
      await process.satellite.close().catch(() => {})
      this.#reportDenied(agentClass, process)
      await this.#retryPurge()
    })().finally(() => {
      state.closing = undefined
      this.#pump()
    })
  }

  /** A turn's `run` threw TurnInterruptedError: the process is gone, whatever the reason. */
  #interrupted(agentClass: AgentClass, process: Process): void {
    // Turns caught up in the same crash arrive here too and must not count again.
    if (this.#states[agentClass].process !== process) return
    this.#retire(agentClass, process)
    this.#recordFailure(agentClass, true)
  }

  #recordFailure(agentClass: AgentClass, withBackoff: boolean): void {
    const state = this.#states[agentClass]
    const { baseMs, maxMs, maxFailures, windowMs } = this.#options.restart
    const now = this.#options.now()
    state.failures = [...state.failures.filter(at => now - at < windowMs), now]
    if (state.failures.length >= maxFailures) {
      state.failed = true
      state.notBefore = 0
      this.#rejectQueue(agentClass, this.#failedError(agentClass))
      return
    }
    state.notBefore = withBackoff ? now + Math.min(maxMs, baseMs * 2 ** (state.failures.length - 1)) : 0
  }

  #failedError(agentClass: AgentClass): RunnerFailedError {
    return new RunnerFailedError(agentClass, `agent class "${agentClass}" stopped after too many failures`)
  }

  #rejectQueue(agentClass: AgentClass, error: Error): void {
    for (const turn of this.#states[agentClass].queue.splice(0)) turn.reject(error)
  }

  #reportDenied(agentClass: AgentClass, process: Process): void {
    const total = process.satellite.deniedApprovals
    const extra = total - process.reportedDenied
    if (extra <= 0) return
    process.reportedDenied = total
    try {
      this.#options.onDeniedApprovals?.(agentClass, extra)
    } catch {
      // A broken listener must not take the scheduler down with it.
    }
  }

  // ---- timers ----

  #armRestartTimer(agentClass: AgentClass, delayMs: number): void {
    const state = this.#states[agentClass]
    if (state.restartTimer !== undefined) return
    state.restartTimer = this.#timers.set(() => {
      state.restartTimer = undefined
      this.#pump()
    }, delayMs)
  }

  #clearRestartTimer(state: ClassState): void {
    if (state.restartTimer === undefined) return
    this.#timers.clear(state.restartTimer)
    state.restartTimer = undefined
  }

  #updateIdleTimer(agentClass: AgentClass): void {
    const state = this.#states[agentClass]
    const idle = state.process !== undefined && state.closing === undefined && state.running === 0 && state.queue.length === 0
    if (!idle) return this.#clearIdleTimer(state)
    if (state.idleTimer !== undefined) return
    state.idleTimer = this.#timers.set(() => {
      state.idleTimer = undefined
      const process = state.process
      if (process !== undefined) this.#retire(agentClass, process)
    }, this.#options.idleCloseMs)
  }

  #clearIdleTimer(state: ClassState): void {
    if (state.idleTimer === undefined) return
    this.#timers.clear(state.idleTimer)
    state.idleTimer = undefined
  }

  // ---- purge ----

  #serialPurge<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#purgeChain.then(work)
    this.#purgeChain = result.catch(() => {})
    return result
  }

  /** Runs before a process starts and after one closes; failures here must never block a turn. */
  #retryPurge(): Promise<void> {
    return this.#serialPurge(async () => {
      if (this.#pendingPurge.size > 0) await this.#attemptPurge([...this.#pendingPurge])
    }).catch(() => {})
  }

  async #attemptPurge(ids: readonly string[]): Promise<void> {
    let locked: ReadonlySet<string>
    try {
      locked = new Set(await this.#options.purge(ids))
    } catch {
      // Treated like a locked file: the ids stay on the list and are tried again after the next close.
      locked = new Set(ids)
    }
    for (const id of ids) if (!locked.has(id)) this.#pendingPurge.delete(id)
    await this.#persistPurge()
  }

  async #persistPurge(): Promise<void> {
    const { purgeFile } = this.#options
    await mkdir(path.dirname(purgeFile), { recursive: true })
    const temporary = `${purgeFile}.tmp`
    await writeFile(temporary, JSON.stringify([...this.#pendingPurge]))
    await rename(temporary, purgeFile)
  }
}

export function createSupervisor(options: SupervisorOptions): TurnRunner {
  return new Supervisor(options)
}
