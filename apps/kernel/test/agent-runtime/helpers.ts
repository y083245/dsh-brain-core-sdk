import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AgentClass, ToolUpdateMode, TurnInput, TurnResult, TurnRunner } from '@dsh-brain-core/satellite-host'
import type {
  BrainEvents, ChannelProvider, ContextBundle, ContextRequest, MemoryRecord, RecordInput, Viewer, WakeInput, WakeMessage, WakeResult,
} from '@dsh-brain-core/sdk'
import type { AgentRuntime, ChannelRegistry, MemoryService, RuntimeSettings, ToolGateway, WakeMetrics, WakePlan, WriteIdentity } from '../../src/contracts/index.ts'
import { createAgentRuntime } from '../../src/agent-runtime/index.ts'
import type { AgentRuntimeDeps } from '../../src/agent-runtime/index.ts'
import { FakeClock, FakeProfiles } from '../fakes/index.ts'

export const PRIVATE = 'qq:private:alice'
export const OTHER = 'qq:private:bob'
export const GROUP = 'qq:group:g1'
export const FEED = 'qq:feed:f1'

export const SELECTION = { provider: 'p', model: 'm', effort: 'high' } as const

export function turn(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    finalResponse: '',
    steps: [{ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }],
    retries: 0,
    compacted: false,
    ...overrides,
  }
}

export interface RunCall {
  readonly agentClass: AgentClass
  readonly sessionId: string
  readonly input: TurnInput
  readonly options: { readonly timeoutMs?: number } | undefined
}

export class FakeRunner implements TurnRunner {
  readonly runs: RunCall[] = []
  readonly invalidated: AgentClass[] = []
  readonly purged: (readonly string[])[] = []
  /** Consumed one per run; when empty a plain success is returned. */
  readonly script: ((call: RunCall) => TurnResult | Promise<TurnResult>)[] = []
  purgeError: Error | undefined
  active = 0
  maxActive = 0

  async run(agentClass: AgentClass, sessionId: string, input: TurnInput, options?: { readonly timeoutMs?: number }): Promise<TurnResult> {
    const call: RunCall = { agentClass, sessionId, input, options }
    this.runs.push(call)
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    try {
      const handler = this.script.shift()
      await Promise.resolve()
      return handler === undefined ? turn() : await handler(call)
    } finally {
      this.active -= 1
    }
  }

  /** The next run waits until released or failed. */
  gate(): { release(result?: Partial<TurnResult>): void; fail(error: Error): void } {
    let release!: (result: TurnResult) => void
    let fail!: (error: Error) => void
    const promise = new Promise<TurnResult>((resolve, reject) => { release = resolve; fail = reject })
    this.script.push(() => promise)
    return { release: (result) => { release(turn(result)) }, fail: (error) => { fail(error) } }
  }

  invalidate(agentClass: AgentClass): void { this.invalidated.push(agentClass) }
  status(): 'running' { return 'running' }
  reset(): void {}
  async purge(sessionIds: readonly string[]): Promise<void> {
    this.purged.push([...sessionIds])
    if (this.purgeError !== undefined) throw this.purgeError
  }
  async close(): Promise<void> {}
}

export class FakeGateway {
  readonly plans: WakePlan[] = []
  readonly ended: string[] = []
  readonly restored: { readonly sessionId: string; readonly groups: readonly string[] }[] = []
  readonly resets: string[] = []
  readonly forgotten: (readonly string[])[] = []
  readonly groups = new Map<string, readonly string[]>()
  recent: string[] = []
  /** How many sends the model "made" since the wake was planned; endWake reports and clears it. */
  sent = 0
  blocked = 0
  planError: Error | undefined
  readonly #clock: FakeClock

  constructor(clock: FakeClock) { this.#clock = clock }

  planWake(plan: WakePlan): readonly string[] {
    if (this.planError !== undefined) throw this.planError
    this.plans.push(plan)
    return []
  }
  endWake(sessionId: string): { readonly sent: number; readonly firstSendAt?: number; readonly blocked?: number } {
    this.ended.push(sessionId)
    const sent = this.sent
    const blocked = this.blocked
    this.sent = 0
    this.blocked = 0
    return {
      sent,
      ...(sent > 0 ? { firstSendAt: this.#clock.now() } : {}),
      ...(blocked > 0 ? { blocked } : {}),
    }
  }
  activatedGroups(sessionId: string): readonly string[] { return this.groups.get(sessionId) ?? [] }
  restoreSession(sessionId: string, groups: readonly string[]): void {
    this.restored.push({ sessionId, groups: [...groups] })
    this.groups.set(sessionId, [...groups])
  }
  resetSession(sessionId: string): void {
    this.resets.push(sessionId)
    this.groups.delete(sessionId)
  }
  recentSent(_channel: string, limit: number): readonly string[] { return this.recent.slice(-limit) }
  forgetSent(channels: readonly string[]): void { this.forgotten.push([...channels]) }
}

export class FakeTimers {
  readonly timers = new Map<number, { readonly run: () => void; readonly ms: number; readonly due: number }>()
  readonly cleared: number[] = []
  #next = 1
  #now = 0

  set = (run: () => void, ms: number): unknown => {
    const handle = this.#next++
    this.timers.set(handle, { run, ms, due: this.#now + ms })
    return handle
  }
  clear = (handle: unknown): void => {
    this.cleared.push(handle as number)
    this.timers.delete(handle as number)
  }
  get pending(): number { return this.timers.size }
  /** Fires everything set so far, oldest first. */
  fireAll(): void {
    for (const [handle, timer] of [...this.timers]) {
      this.timers.delete(handle)
      timer.run()
    }
  }
  /** Moves this clock forward and fires the timers that have come due, earliest first. */
  advance(ms: number): void {
    this.#now += ms
    const due = [...this.timers].filter(([, timer]) => timer.due <= this.#now).sort((a, b) => a[1].due - b[1].due)
    for (const [handle, timer] of due) {
      this.timers.delete(handle)
      timer.run()
    }
  }
}

export interface LogLine { readonly level: string; readonly event: string; readonly fields: unknown }

export function msg(id: string, text: string, extra: Partial<WakeMessage> = {}): WakeMessage {
  return { id, actor: 'alice', name: '小明', text, tEvent: 0, ...extra }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/** Lets queued promise work and small file writes finish; only used where nothing can be awaited. */
export function settle(): Promise<void> { return sleep(30) }

export interface SavedState { readonly version?: number; readonly channels: Record<string, Record<string, unknown>> }

/**
 * Polls sessions.json every 10 ms until the parsed file satisfies `ok`, so a test waits for the write it needs
 * instead of guessing how long a slow disk takes. A missing or half-written file is just "not yet".
 */
export async function stateWhen(h: { readonly stateFile: string }, ok: (state: SavedState) => boolean, timeoutMs = 2_000): Promise<SavedState> {
  const deadline = Date.now() + timeoutMs
  let last = '(no file read)'
  for (;;) {
    try {
      const text = await readFile(h.stateFile, 'utf8')
      last = text
      const parsed = JSON.parse(text) as SavedState
      if (ok(parsed)) return parsed
    } catch (error) {
      if (!(error instanceof Error) || last === '(no file read)') last = `(unreadable: ${String(error)})`
    }
    if (Date.now() >= deadline) throw new Error(`sessions.json did not reach the expected state within ${timeoutMs} ms; last content: ${last}`)
    await sleep(10)
  }
}

export function bundleOf(overrides: Partial<ContextBundle> = {}): ContextBundle {
  return { profileVersion: 1, stable: 'STABLE-1', blocks: [], truncated: false, ...overrides }
}

export interface Harness {
  readonly runtime: AgentRuntime
  readonly deps: AgentRuntimeDeps
  readonly dir: string
  readonly stateFile: string
  readonly runner: FakeRunner
  readonly gateway: FakeGateway
  readonly clock: FakeClock
  readonly timers: FakeTimers
  readonly profiles: FakeProfiles
  readonly events: { readonly name: string; readonly payload: unknown }[]
  readonly metrics: Parameters<WakeMetrics['record']>[0][]
  readonly logs: LogLine[]
  readonly contexts: { readonly request: ContextRequest; readonly viewer: Viewer }[]
  readonly records: { readonly input: RecordInput; readonly identity: WriteIdentity }[]
  readonly members: { readonly channel: string; readonly people: readonly string[] | null }[]
  readonly providers: Map<string, ChannelProvider>
  readonly records$: Map<string, MemoryRecord | null>
  state: {
    settings: RuntimeSettings
    bundle: ContextBundle
    mode: ToolUpdateMode
    mood: string
    moodError: Error | undefined
    recordError: Error | undefined
    contextError: Error | undefined
    metricsError: Error | undefined
  }
  wake(channel: string, input?: Partial<WakeInput>): Promise<WakeResult>
  /** Another runtime over the same state file, sharing every fake. */
  rebuild(extra?: Partial<AgentRuntimeDeps>): AgentRuntime
  cleanup(): Promise<void>
}

export interface HarnessOptions {
  readonly start?: number
  readonly settings?: RuntimeSettings
  readonly profileVersion?: number
  readonly rotateInputTokens?: number
}

export async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-runtime-'))
  const stateFile = path.join(dir, 'state', 'agent', 'sessions.json')
  const clock = new FakeClock(options.start ?? Date.UTC(2026, 10, 9, 12, 0, 0))
  const runner = new FakeRunner()
  const gateway = new FakeGateway(clock)
  const timers = new FakeTimers()
  const profiles = new FakeProfiles({ version: options.profileVersion ?? 1, stable: 'STABLE-1' })
  const events: Harness['events'] = []
  const metrics: Harness['metrics'] = []
  const logs: LogLine[] = []
  const contexts: Harness['contexts'] = []
  const records: Harness['records'] = []
  const members: Harness['members'] = []
  const providers = new Map<string, ChannelProvider>()
  const records$ = new Map<string, MemoryRecord | null>()
  const state: Harness['state'] = {
    settings: options.settings ?? { agents: { chat: SELECTION, activity: SELECTION }, timezone: 'UTC' },
    bundle: bundleOf(),
    mode: 'addition-only',
    mood: '【你此刻】平静',
    moodError: undefined,
    recordError: undefined,
    contextError: undefined,
    metricsError: undefined,
  }

  const memory = {
    async context(request: ContextRequest, viewer: Viewer): Promise<ContextBundle> {
      contexts.push({ request, viewer })
      if (state.contextError !== undefined) throw state.contextError
      return state.bundle
    },
    async record(input: RecordInput, identity: WriteIdentity): Promise<MemoryRecord> {
      records.push({ input, identity })
      if (state.recordError !== undefined) throw state.recordError
      const record = { id: `l1_handoff${records.length}`, layer: 'L1', kind: input.kind, status: 'active', content: input.content } as unknown as MemoryRecord
      records$.set(record.id, record)
      return record
    },
  } as unknown as MemoryService
  const channels: ChannelRegistry = {
    provide: () => () => undefined,
    providerOf: (channel) => providers.get(channel),
    proactiveProviderOf: () => undefined,
  }
  const at = (level: string) => (event: string, fields?: unknown): void => { logs.push({ level, event, fields }) }

  const deps: AgentRuntimeDeps = {
    runner,
    gateway: gateway as unknown as ToolGateway,
    memory,
    profiles,
    mood: async () => {
      if (state.moodError !== undefined) throw state.moodError
      return { line: state.mood }
    },
    // A message id is the L0 id ingest returned, so an id nobody planted reads as an active record; plant null or a tombstone to forget it.
    readRecord: async (id) => records$.has(id) ? records$.get(id) ?? null : ({ id, status: 'active', content: {} } as unknown as MemoryRecord),
    channels,
    setMembers: (channel, people) => { members.push({ channel, people }) },
    settings: async () => state.settings,
    toolUpdateMode: async () => state.mode,
    metrics: {
      async record(entry) {
        if (state.metricsError !== undefined) throw state.metricsError
        metrics.push(entry)
      },
    },
    emit: <K extends keyof BrainEvents>(name: K, payload: BrainEvents[K]): void => { events.push({ name, payload }) },
    clock,
    log: { info: at('info'), warn: at('warn'), error: at('error') },
    stateFile,
    timers,
    ...(options.rotateInputTokens === undefined ? {} : { rotateInputTokens: options.rotateInputTokens }),
  }

  const runtimes: AgentRuntime[] = []
  const runtime = createAgentRuntime(deps)
  runtimes.push(runtime)

  return {
    runtime, deps, dir, stateFile, runner, gateway, clock, timers, profiles, events, metrics, logs, contexts, records, members,
    providers, records$, state,
    wake: (channel, input = {}) => runtime.wake(channel, { reason: 'message', ...input }),
    rebuild(extra = {}) {
      const next = createAgentRuntime({ ...deps, ...extra })
      runtimes.push(next)
      return next
    },
    async cleanup() {
      for (const each of runtimes) await each.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

export async function rejection(promise: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string }
  }
  throw new Error('expected a rejection')
}

export function textOf(input: TurnInput): string {
  if (typeof input === 'string') return input
  const first = input[0]
  return first !== undefined && first.type === 'text' ? first.text : ''
}

/** Polls until the condition holds, so a test does not depend on how many ticks the runtime needs. */
export async function until(condition: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 2000; i += 1) {
    if (condition()) return
    await sleep(1)
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** The next turn sends once, and takes a second doing it, so her message is later than the one it answers. */
export function sends(h: { readonly runner: FakeRunner; readonly gateway: FakeGateway; readonly clock: FakeClock }): void {
  h.runner.script.push(() => {
    h.gateway.sent = 1
    h.clock.advance(1_000)
    return turn()
  })
}
