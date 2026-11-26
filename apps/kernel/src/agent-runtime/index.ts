import { RunnerFailedError, SelectionMissingError, TurnInterruptedError, encodeSessionId, requireSelection } from '@brain-core/satellite-host'
import type { AgentClass, TurnInput, TurnResult } from '@brain-core/satellite-host'
import { BrainError, LIMITS } from '@brain-core/sdk'
import type { MemoryRecord, Viewer, WakeFeatures, WakeInput, WakeMessage, WakeResult, WakeSkip } from '@brain-core/sdk'
import { createUlid } from '@brain-core/shared'
import type { AgentRuntime, WriteIdentity } from '../contracts/index.ts'
import type {
  Clock, ChannelRegistry, MemoryService, ProactiveMessageSend, ProfileReader, RuntimeSettings, TokenUsage, ToolGateway, WakeMetrics,
} from '../contracts/index.ts'
import type { Logger } from '../log/index.ts'
import type { BrainEvents } from '@brain-core/sdk'
import type { ToolUpdateMode, TurnRunner } from '@brain-core/satellite-host'
import { dayOf, recallQuery, renderWake, zonedParts } from './prompt.ts'
import { MAX_PEOPLE, readSessions, rememberEvidence, rememberPeople, writeSessions } from './sessions.ts'
import type { SessionEntry } from './sessions.ts'

export { KERNEL_RULES, agoText, buildSystemPrompt, dayOf, escapeForWake, recallQuery, renderWake, zonedParts } from './prompt.ts'
export type { RenderWakeInput } from './prompt.ts'
export { createSatelliteLlm } from './satellite-llm.ts'
export type { DetailedLlmClient, DetailedLlmResult, SatelliteLlmDeps } from './satellite-llm.ts'
export { readSessions, type SessionEntry } from './sessions.ts'

export interface AgentRuntimeDeps {
  readonly runner: TurnRunner
  readonly gateway: ToolGateway
  readonly memory: MemoryService
  readonly profiles: ProfileReader
  readonly mood: () => Promise<{ readonly line: string }>
  readonly readRecord: (id: string) => Promise<MemoryRecord | null>
  readonly channels: ChannelRegistry
  readonly setMembers: (channel: string, people: readonly string[] | null) => void
  readonly settings: () => Promise<RuntimeSettings>
  readonly toolUpdateMode: (agentClass: AgentClass) => Promise<ToolUpdateMode>
  readonly metrics: WakeMetrics
  readonly emit: <K extends keyof BrainEvents>(name: K, payload: BrainEvents[K]) => void
  readonly clock: Clock
  readonly log: Logger
  /** state/agent/sessions.json */
  readonly stateFile: string
  readonly timers?: { readonly set: (run: () => void, ms: number) => unknown; readonly clear: (handle: unknown) => void }
  /** Default 200_000. */
  readonly rotateInputTokens?: number
  readonly onTurnUsage?: (info: {
    readonly wakeId: string
    readonly channel: string
    readonly agentClass: AgentClass
    readonly usage: TokenUsage
    readonly tAt: number
  }) => Promise<void> | void
}

const REASON_PATTERN = /^[a-z0-9_-]{1,32}$/
const CHANNEL_PATTERN = /^[a-z0-9-]+:[a-z0-9-]+:\S+$/
const MEMBERS_TTL_MS = 5 * 60_000
const MEMBERS_TIMEOUT_MS = 5_000
const HANDOFF_TIMEOUT_MS = 60_000
const HANDOFF_MAX_CHARS = 600
const DEFAULT_ROTATE_INPUT_TOKENS = 200_000
const DEFAULT_QUIET_HOURS: readonly [number, number] = [3, 8]
const DEFAULT_ACTIVE_WINDOW_MS = 10 * 60_000
const DEFAULT_COOLDOWN_MS = 60 * 60_000
const MAX_TIMER_MS = 2_147_483_647

export const HANDOFF_PROMPT = '这一段对话要收尾了，下次会换一个新会话。请用三句话以内写下：刚才聊到哪了、有什么事还没说完。只写给以后的自己看，不要调用任何工具，不要发消息。'

/** Everything waiting for a channel's next turn. A pending with no callers is leftover from an unfinished turn. */
interface Pending {
  messages: WakeMessage[]
  evidence: string[]
  event?: 'poke'
  note?: string
  reason?: string
  /** True only while every merged wake was silent. */
  silent: boolean
  /** True only while every merged wake was proactive. */
  proactive: boolean
  sendProactiveMessage?: ProactiveMessageSend
  arrivedAt?: number
  debounceMs: number
  ready: boolean
  timer?: unknown
  callers: { readonly resolve: (result: RuntimeWakeResult) => void; readonly reject: (error: unknown) => void }[]
}

interface Lane {
  busy: boolean
  pending?: Pending
  /** A rotation that has to wait for the running turn: `forgotten()` or a plugin's `rotate()`. */
  rotateAfter: boolean
}

type RuntimeWakeResult = WakeResult & { readonly blocked?: boolean }

type Outcome =
  | { readonly kind: 'result'; readonly result: RuntimeWakeResult }
  | { readonly kind: 'reject'; readonly error: unknown }

function classOf(channel: string): AgentClass {
  const kind = channel.split(':')[1]
  return kind === 'private' || kind === 'group' ? 'chat' : 'activity'
}

function unavailable(message: string): BrainError {
  return new BrainError('UNAVAILABLE', message)
}

function addUnique(target: string[], values: readonly string[]): void {
  for (const value of values) {
    if (!target.includes(value)) target.push(value)
  }
}

function newPending(): Pending {
  return { messages: [], evidence: [], silent: true, proactive: true, debounceMs: 0, ready: false, callers: [] }
}

function mergeMessages(target: WakeMessage[], incoming: readonly WakeMessage[]): WakeMessage[] {
  const seen = new Set(target.map((message) => message.id))
  const merged = [...target]
  for (const message of incoming) {
    if (seen.has(message.id)) continue
    seen.add(message.id)
    merged.push(message)
  }
  return merged.length > LIMITS.wakeMessages ? merged.slice(-LIMITS.wakeMessages) : merged
}

function truncateWords(text: string, limit: number): string {
  const points = Array.from(text)
  return points.length <= limit ? text : points.slice(0, limit).join('')
}

function inQuietHours(hour: number, range: readonly [number, number]): boolean {
  const [start, end] = range
  if (start === end) return false
  return start < end ? hour >= start && hour < end : hour >= start || hour < end
}

function lastInputTokens(result: TurnResult): number | undefined {
  const last = result.steps[result.steps.length - 1]
  return last === undefined ? undefined : last.inputTokens + last.cacheReadTokens + last.cacheWriteTokens
}

function sumStepsUsage(steps: TurnResult['steps']): TokenUsage {
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  for (const step of steps) {
    inputTokens += step.inputTokens
    outputTokens += step.outputTokens
    cacheReadTokens += step.cacheReadTokens
    cacheWriteTokens += step.cacheWriteTokens
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
}

export function createAgentRuntime(deps: AgentRuntimeDeps): AgentRuntime {
  const { runner, gateway, memory, clock, log } = deps
  const rotateInputTokens = deps.rotateInputTokens ?? DEFAULT_ROTATE_INPUT_TOKENS
  const timers = deps.timers ?? {
    set: (run: () => void, ms: number): unknown => setTimeout(run, ms),
    clear: (handle: unknown): void => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
  }
  const newId = createUlid({ now: () => clock.now() })
  const pool = new Map<string, SessionEntry>()
  const lanes = new Map<string, Lane>()
  const membersAt = new Map<string, number>()
  const lastStable = new Map<AgentClass, string>()
  let closed = false

  // ---- the session pool on disk ----

  let writing: Promise<void> | undefined
  let dirty = false

  /** Writes the pool; calls made while a write is running share the one write that follows it. */
  function flush(): Promise<void> {
    dirty = true
    writing ??= (async () => {
      try {
        while (dirty) {
          dirty = false
          await writeSessions(deps.stateFile, pool)
        }
      } catch {
        log.error('agent-runtime.state_write_failed')
      } finally {
        writing = undefined
      }
    })()
    return writing
  }

  const loaded: Promise<void> = (async () => {
    try {
      const stored = await readSessions(deps.stateFile)
      let moved = false
      for (const [channel, entry] of stored) {
        pool.set(channel, entry)
        if (entry.rotatePending === true) {
          // A forgetting was waiting for a running turn when the kernel stopped: the old session still holds what was forgotten.
          await rotateAfterCrash(channel, entry)
          moved = true
        }
        try {
          gateway.restoreSession(encodeSessionId({ agentClass: classOf(channel), channel, generation: entry.generation }), entry.activated)
        } catch {
          log.warn('agent-runtime.restore_failed', { channel })
        }
      }
      if (moved) await flush()
    } catch {
      log.error('agent-runtime.state_read_failed')
    }
  })()

  function sessionIdOf(channel: string, entry: SessionEntry): string {
    return encodeSessionId({ agentClass: classOf(channel), channel, generation: entry.generation })
  }

  function entryFor(channel: string, settings?: RuntimeSettings): SessionEntry {
    let entry = pool.get(channel)
    if (entry === undefined) {
      entry = {
        generation: 0, startedDay: dayOf(clock.now(), settings?.timezone), activated: [], lastInputTokens: 0, turns: 0,
        people: [], recentEvidence: [],
      }
      pool.set(channel, entry)
    }
    return entry
  }

  function laneOf(channel: string): Lane {
    let lane = lanes.get(channel)
    if (lane === undefined) {
      lane = { busy: false, rotateAfter: false }
      lanes.set(channel, lane)
    }
    return lane
  }

  function featuresFor(channel: string, messages: readonly WakeMessage[], event: 'poke' | undefined): WakeFeatures {
    return {
      message: {
        hasMedia: messages.some((message) => message.hasMedia === true || (message.images !== undefined && message.images.length > 0)),
        hasForward: messages.some((message) => message.forwarded === true),
      },
      event: { poke: event === 'poke' },
      channel: { kind: channel.split(':')[1] ?? '' },
    }
  }

  // ---- waking ----

  function wake(channel: string, input: WakeInput): Promise<WakeResult> {
    const promise = accept(channel, input)
    // A plugin that does not await still must not crash the process with an unhandled rejection.
    promise.catch(() => undefined)
    return promise
  }

  async function checkProactive(channel: string, settings: RuntimeSettings): Promise<WakeSkip | undefined> {
    const now = clock.now()
    const entry = pool.get(channel)
    const [start, end] = settings.quietHours ?? DEFAULT_QUIET_HOURS
    const parts = zonedParts(now, settings.timezone)
    if (inQuietHours(parts.hour + parts.minute / 60, [start, end])) return 'quiet'
    const activeWindowMs = settings.proactive?.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS
    if (entry?.lastInboundAt !== undefined && now - entry.lastInboundAt < activeWindowMs) return 'foreground'
    if (entry?.lastProactiveAt !== undefined && entry.lastProactiveAt > (entry.lastInboundAt ?? 0)) return 'unanswered'
    const cooldownMs = settings.proactive?.cooldownMs ?? DEFAULT_COOLDOWN_MS
    if (entry?.lastProactiveAt !== undefined && now - entry.lastProactiveAt < cooldownMs) return 'cooldown'
    return undefined
  }

  async function accept(channel: string, input: WakeInput, sendProactiveMessage?: ProactiveMessageSend): Promise<RuntimeWakeResult> {
    if (typeof channel !== 'string' || !CHANNEL_PATTERN.test(channel)) throw new BrainError('INVALID_ARGUMENT', '通道 id 格式不对。')
    if (typeof input?.reason !== 'string' || !REASON_PATTERN.test(input.reason)) {
      throw new BrainError('INVALID_ARGUMENT', 'reason 只能是 1 到 32 个小写字母、数字、下划线或连字符。')
    }
    const debounceMs = input.debounceMs ?? 0
    if (typeof debounceMs !== 'number' || !Number.isFinite(debounceMs) || debounceMs < 0) {
      throw new BrainError('INVALID_ARGUMENT', 'debounceMs 要是不小于 0 的数字。')
    }
    await loaded
    const settings = await deps.settings()
    if (input.proactive === true) {
      const skipped = await checkProactive(channel, settings)
      if (skipped !== undefined) return { wakeId: newId(), acked: false, profileVersion: 0, sent: 0, steps: 0, skipped }
    }
    if (closed) throw unavailable('内核正在关闭。')

    const lane = laneOf(channel)
    if (sendProactiveMessage !== undefined && (lane.busy || lane.pending !== undefined)) {
      return { wakeId: newId(), acked: false, profileVersion: 0, sent: 0, steps: 0, skipped: 'foreground' }
    }
    const now = clock.now()
    const messages = Array.isArray(input.messages) ? input.messages : []
    const entry = entryFor(channel, settings)
    if (messages.length > 0) {
      entry.lastInboundAt = now
      deps.emit('message.in', { channel, count: messages.length, recordIds: messages.map((message) => message.id) })
      void flush()
    }

    return new Promise<RuntimeWakeResult>((resolve, reject) => {
      const pending = lane.pending ?? newPending()
      lane.pending = pending
      pending.callers.push({ resolve, reject })
      pending.messages = mergeMessages(pending.messages, messages)
      if (Array.isArray(input.evidence)) addUnique(pending.evidence, input.evidence)
      if (input.event === 'poke') pending.event = 'poke'
      if (input.note !== undefined) pending.note = input.note
      pending.reason = input.reason
      pending.silent = pending.silent && input.silent === true
      pending.proactive = pending.proactive && input.proactive === true
      if (sendProactiveMessage !== undefined) pending.sendProactiveMessage = sendProactiveMessage
      pending.arrivedAt = pending.arrivedAt === undefined ? now : Math.min(pending.arrivedAt, now)
      pending.debounceMs = debounceMs
      if (pending.timer !== undefined) {
        timers.clear(pending.timer)
        pending.timer = undefined
      }
      if (debounceMs > 0) {
        pending.ready = false
        pending.timer = timers.set(() => {
          pending.timer = undefined
          pending.ready = true
          start(channel)
        }, Math.min(debounceMs, MAX_TIMER_MS))
      } else {
        pending.ready = true
      }
      start(channel)
    })
  }

  /** Starts the waiting turn when the channel is free and the debounce is over. */
  function start(channel: string): void {
    const lane = lanes.get(channel)
    if (lane === undefined || closed || lane.busy) return
    const pending = lane.pending
    if (pending === undefined || !pending.ready) return
    lane.pending = undefined
    lane.busy = true
    void execute(channel, lane, pending)
  }

  async function execute(channel: string, lane: Lane, snapshot: Pending): Promise<void> {
    let outcome: Outcome
    try {
      outcome = await runTurn(channel, snapshot)
    } catch (error) {
      // Not a model problem: log it, give the callers an error and keep the messages for the next wake.
      log.error('agent-runtime.turn_failed', { channel })
      requeue(lane, snapshot)
      outcome = { kind: 'reject', error: error instanceof BrainError ? error : new BrainError('INTERNAL', '这一轮出错了。') }
    }
    for (const caller of snapshot.callers) {
      if (outcome.kind === 'result') caller.resolve(outcome.result)
      else caller.reject(outcome.error)
    }
    try {
      if (lane.rotateAfter) {
        lane.rotateAfter = false
        await rotateSession(channel, false)
        await settleForgetting(channel, lane)
      }
    } catch {
      log.error('agent-runtime.rotate_failed', { channel })
    }
    lane.busy = false
    start(channel)
  }

  /** Puts the messages of a turn that did not finish back into the waiting batch, without triggering a run. */
  function requeue(lane: Lane, snapshot: Pending): void {
    if (snapshot.messages.length === 0) return
    const target = lane.pending ?? newPending()
    target.messages = mergeMessages(snapshot.messages, target.messages)
    addUnique(target.evidence, snapshot.evidence)
    lane.pending = target
  }

  // ---- one turn ----

  async function refreshMembers(channel: string): Promise<void> {
    const provider = deps.channels.providerOf(channel)
    if (provider === undefined) return
    const now = clock.now()
    const last = membersAt.get(channel)
    if (last !== undefined && now - last <= MEMBERS_TTL_MS) return
    membersAt.set(channel, now)
    // A plugin that never answers must not hold the turn, and with it the whole channel.
    let timer: unknown
    try {
      const people = await new Promise<readonly string[]>((resolve, reject) => {
        timer = timers.set(() => { reject(new Error('members timed out')) }, MEMBERS_TIMEOUT_MS)
        provider.members(channel).then(resolve, reject)
      })
      deps.setMembers(channel, people)
    } catch {
      deps.setMembers(channel, null)
      log.warn('agent-runtime.members_failed', { channel })
    } finally {
      if (timer !== undefined) timers.clear(timer)
    }
  }

  /** Keeps only the messages and evidence ids that can still be read as active records; a failed read counts as gone. */
  async function dropForgotten(snapshot: Pending): Promise<void> {
    const known = new Map<string, Promise<boolean>>()
    const alive = (id: string): Promise<boolean> => {
      let result = known.get(id)
      if (result === undefined) {
        result = (async () => {
          try {
            const record = await deps.readRecord(id)
            return record !== null && record.status === 'active'
          } catch {
            return false
          }
        })()
        known.set(id, result)
      }
      return result
    }
    const messageKept = await Promise.all(snapshot.messages.map((message) => alive(message.id)))
    const evidenceKept = await Promise.all(snapshot.evidence.map((id) => alive(id)))
    snapshot.messages = snapshot.messages.filter((_, index) => messageKept[index])
    snapshot.evidence = snapshot.evidence.filter((_, index) => evidenceKept[index])
  }

  function participantsOf(entry: SessionEntry, messages: readonly WakeMessage[]): string[] {
    const people: string[] = []
    for (const person of [...messages.map((message) => message.actor), ...entry.people]) {
      if (person === 'self' || people.includes(person)) continue
      people.push(person)
      if (people.length >= MAX_PEOPLE) break
    }
    return people
  }

  async function readHandoff(entry: SessionEntry): Promise<string | undefined> {
    if (entry.handoff === undefined) return undefined
    try {
      const record = await deps.readRecord(entry.handoff)
      const text = record?.content.text
      return record !== null && record.status === 'active' && typeof text === 'string' ? text : undefined
    } catch {
      return undefined
    }
  }

  function writeIdentity(channel: string): WriteIdentity {
    return { kind: 'kernel', source: 'agent', trust: 'self', defaultVisibility: channel.split(':')[1] === 'private' ? 'subject' : 'open' }
  }

  /** A silent turn in the old session asks her where the talk stopped; every failure just skips it. */
  async function writeHandoff(channel: string, agentClass: AgentClass, entry: SessionEntry, oldId: string, mode: ToolUpdateMode): Promise<void> {
    if (entry.recentEvidence.length === 0) return
    let planned = false
    try {
      gateway.planWake({
        sessionId: oldId, wakeId: newId(), features: featuresFor(channel, [], undefined), mode, silent: true,
        participants: entry.people, evidence: entry.recentEvidence, peerTexts: [],
      })
      planned = true
      const result = await runner.run(agentClass, oldId, HANDOFF_PROMPT, { timeoutMs: HANDOFF_TIMEOUT_MS })
      gateway.endWake(oldId)
      planned = false
      if (laneOf(channel).rotateAfter) {
        // A forgetting came in while she was writing: the summary was made from a session that still held what was forgotten,
        // and the cascade has already run, so a record written now would outlive it.
        log.warn('agent-runtime.handoff_skipped', { channel })
        return
      }
      const text = truncateWords(result.finalResponse.trim(), HANDOFF_MAX_CHARS)
      if (text === '') return
      const record = await memory.record({
        layer: 'L1', kind: 'l1.topic', channel,
        subjects: entry.people.length > 0 ? [...entry.people] : ['self'],
        actor: 'self', content: { text, state: 'open' },
        evidence: entry.recentEvidence.map((id) => ({ id })),
        visibility: 'origin', idempotencyKey: `handoff:${oldId}`,
      }, writeIdentity(channel))
      entry.handoff = record.id
    } catch {
      log.warn('agent-runtime.handoff_skipped', { channel })
    } finally {
      if (planned) gateway.endWake(oldId)
    }
  }

  /** A rotation must not stop halfway because a setting cannot be read: it falls back to the system zone. */
  async function timezoneForRotation(channel: string): Promise<string | undefined> {
    try {
      return (await deps.settings()).timezone
    } catch {
      log.warn('agent-runtime.rotate_settings_failed', { channel })
      return undefined
    }
  }

  /** At start-up: a forgetting that was waiting for a running turn is carried out at once, with nothing handed over. */
  async function rotateAfterCrash(channel: string, entry: SessionEntry): Promise<void> {
    const timezone = await timezoneForRotation(channel)
    try {
      await runner.purge([sessionIdOf(channel, entry)])
    } catch {
      log.warn('agent-runtime.purge_failed', { channel })
    }
    entry.generation += 1
    entry.startedDay = dayOf(clock.now(), timezone)
    entry.turns = 0
    entry.lastInputTokens = 0
    entry.activated = []
    entry.recentEvidence = []
    delete entry.rotatePending
  }

  /** Moves the channel to the next generation, and takes the old session's files away. */
  async function rotateSession(channel: string, withHandoff: boolean): Promise<void> {
    const entry = pool.get(channel)
    if (entry === undefined) return
    const timezone = await timezoneForRotation(channel)
    const agentClass = classOf(channel)
    // Without the tool update mode there is no safe handoff and no groups to carry, but the old session must still go.
    let mode: ToolUpdateMode | undefined
    try {
      mode = await deps.toolUpdateMode(agentClass)
    } catch {
      log.warn('agent-runtime.rotate_mode_failed', { channel })
    }
    const oldId = sessionIdOf(channel, entry)
    if (withHandoff && mode !== undefined) await writeHandoff(channel, agentClass, entry, oldId, mode)
    const groups = gateway.activatedGroups(oldId)
    gateway.resetSession(oldId)
    entry.generation += 1
    entry.startedDay = dayOf(clock.now(), timezone)
    entry.turns = 0
    entry.lastInputTokens = 0
    delete entry.rotatePending
    // Without a handoff the evidence is only what she was shown before the forgetting, and must not be cited later.
    if (!withHandoff) entry.recentEvidence = []
    if (mode === 'fixed') {
      // Only a new session lets a group loaded with tools__load take effect on this kind of model (W6).
      gateway.restoreSession(sessionIdOf(channel, entry), groups)
      entry.activated = [...groups]
    } else {
      entry.activated = []
    }
    try {
      await runner.purge([oldId])
    } catch {
      log.warn('agent-runtime.purge_failed', { channel })
    }
    await flush()
  }

  async function runTurn(channel: string, snapshot: Pending): Promise<Outcome> {
    const agentClass = classOf(channel)
    const wakeId = newId()
    const arrivedAt = snapshot.arrivedAt ?? clock.now()
    const reason = snapshot.reason ?? 'message'
    let profileVersion = 0

    const finish = async (outcome: 'acked' | 'interrupted' | 'unavailable', extra: {
      readonly steps?: TurnResult['steps']; readonly retries?: number; readonly firstSendAt?: number
    } = {}): Promise<void> => {
      try {
        await deps.metrics.record({
          wakeId, channel, agentClass, profileVersion, arrivedAt,
          ...(extra.firstSendAt === undefined ? {} : { firstSendAt: extra.firstSendAt }),
          debounceMs: snapshot.debounceMs, steps: extra.steps ?? [], retries: extra.retries ?? 0, outcome,
        })
      } catch {
        log.warn('agent-runtime.metrics_failed', { channel })
      }
    }

    const settings = await deps.settings()
    try {
      requireSelection(settings.agents[agentClass], agentClass)
    } catch (error) {
      await finish('unavailable')
      return { kind: 'reject', error: unavailable(error instanceof SelectionMissingError ? '还没选模型' : '模型设置不对') }
    }
    const profile = await deps.profiles.current()
    if (profile.version === 0) {
      await finish('unavailable')
      return { kind: 'reject', error: unavailable('还没有角色卡') }
    }

    let entry = entryFor(channel, settings)
    const today = dayOf(clock.now(), settings.timezone)
    if (entry.turns === 0) {
      // Nothing has run in this session yet, so there is nothing to hand over; it only starts today.
      entry.startedDay = today
    } else if (entry.startedDay !== today || entry.lastInputTokens > rotateInputTokens) {
      await rotateSession(channel, true)
      entry = entryFor(channel, settings)
    }
    const sessionId = sessionIdOf(channel, entry)

    // Messages can wait a long time (a debounce, or an interrupted turn); whatever was forgotten meanwhile must not reach the model.
    const hadMessages = snapshot.messages.length > 0
    await dropForgotten(snapshot)
    const messages = snapshot.messages
    if (hadMessages && messages.length === 0 && snapshot.note === undefined && snapshot.event === undefined) {
      profileVersion = profile.version
      await finish('acked')
      return { kind: 'result', result: { wakeId, acked: true, profileVersion, sent: 0, steps: 0 } }
    }

    await refreshMembers(channel)
    const participants = participantsOf(entry, messages)
    const viewer: Viewer = { caller: 'agent', channel, participants }
    const query = recallQuery(messages)
    const bundle = await memory.context({ channel, ...(query === undefined ? {} : { query }) }, viewer)
    profileVersion = bundle.profileVersion
    const previousStable = lastStable.get(agentClass)
    lastStable.set(agentClass, bundle.stable)
    if (previousStable !== undefined && previousStable !== bundle.stable) runner.invalidate(agentClass)

    let mood: string | undefined
    try {
      mood = (await deps.mood()).line
    } catch {
      log.warn('agent-runtime.mood_failed', { channel })
    }
    const handoff = await readHandoff(entry)
    const input: TurnInput = renderWake({
      reason, now: clock.now(), ...(settings.timezone === undefined ? {} : { timezone: settings.timezone }),
      blocks: bundle.blocks, ...(mood === undefined ? {} : { mood }), ...(handoff === undefined ? {} : { handoff }),
      recentSelf: gateway.recentSent(channel, 5), messages, ...(snapshot.note === undefined ? {} : { note: snapshot.note }),
    })

    const mode = await deps.toolUpdateMode(agentClass)
    const evidence: string[] = []
    addUnique(evidence, messages.map((message) => message.id))
    addUnique(evidence, snapshot.evidence)
    const sendProactiveMessage = snapshot.sendProactiveMessage
    let proactiveBlocked = false
    const plan = {
      sessionId, wakeId, features: featuresFor(channel, messages, snapshot.event), mode, silent: snapshot.silent,
      participants, evidence, peerTexts: messages.map((message) => message.text),
      ...(sendProactiveMessage === undefined ? {} : {
        sendProactiveMessage: async (text: string) => {
          const skipped = await checkProactive(channel, await deps.settings())
          if (skipped !== undefined || closed) {
            proactiveBlocked = true
            throw unavailable('当前不适合主动发送消息。')
          }
          return sendProactiveMessage(text)
        },
      }),
    }

    let result: TurnResult | undefined
    let stats: { readonly sent: number; readonly firstSendAt?: number; readonly blocked?: number }
    let attempt = 0
    for (;;) {
      gateway.planWake(plan)
      try {
        result = await runner.run(agentClass, sessionId, input)
        stats = gateway.endWake(sessionId)
        if ((stats.blocked ?? 0) > 0) proactiveBlocked = true
        break
      } catch (error) {
        stats = gateway.endWake(sessionId)
        if ((stats.blocked ?? 0) > 0) proactiveBlocked = true
        if (error instanceof TurnInterruptedError) {
          // Nothing has gone out yet, so running it again cannot say anything twice.
          if (stats.sent === 0 && attempt === 0) {
            attempt += 1
            continue
          }
          break
        }
        if (stats.sent > 0) {
          const sentAt = clock.now()
          entry.lastOutboundAt = sentAt
          if (snapshot.proactive) entry.lastProactiveAt = sentAt
          entry.recentEvidence = rememberEvidence(entry.recentEvidence, evidence)
          await flush()
        }
        if (error instanceof SelectionMissingError || error instanceof RunnerFailedError) {
          await finish('unavailable', stats.firstSendAt === undefined ? {} : { firstSendAt: stats.firstSendAt })
          return { kind: 'reject', error: unavailable(error instanceof SelectionMissingError ? '还没选模型' : '模型现在用不了') }
        }
        throw error
      }
    }

    const now = clock.now()
    if (stats.sent > 0) {
      entry.lastOutboundAt = now
      if (snapshot.proactive) entry.lastProactiveAt = now
    }
    if (result === undefined) {
      // Interrupted: the messages wait for the next wake, which this does not trigger.
      if (stats.sent > 0) entry.recentEvidence = rememberEvidence(entry.recentEvidence, evidence)
      requeueFor(channel, snapshot)
      await flush()
      await finish('interrupted', { ...(stats.firstSendAt === undefined ? {} : { firstSendAt: stats.firstSendAt }) })
      emitTurn(channel, wakeId, false, stats.sent, 0, profileVersion)
      return {
        kind: 'result',
        result: {
          wakeId, acked: false, profileVersion, sent: stats.sent, steps: 0,
          ...(proactiveBlocked ? { blocked: true } : {}),
        },
      }
    }

    const tokens = lastInputTokens(result)
    if (tokens !== undefined) entry.lastInputTokens = tokens
    entry.turns += 1
    entry.people = rememberPeople(entry.people, messages.map((message) => message.actor))
    entry.recentEvidence = rememberEvidence(entry.recentEvidence, evidence)
    delete entry.handoff
    if (result.compacted) {
      gateway.resetSession(sessionId)
      entry.activated = []
    } else {
      entry.activated = [...gateway.activatedGroups(sessionId)]
    }
    await flush()
    await finish('acked', {
      steps: result.steps, retries: result.retries, ...(stats.firstSendAt === undefined ? {} : { firstSendAt: stats.firstSendAt }),
    })
    if (deps.onTurnUsage !== undefined) {
      try {
        await deps.onTurnUsage({
          wakeId,
          channel,
          agentClass,
          usage: sumStepsUsage(result.steps),
          tAt: now,
        })
      } catch {
        log.warn('agent-runtime.turn_usage_failed', { channel })
      }
    }
    emitTurn(channel, wakeId, true, stats.sent, result.steps.length, profileVersion)
    return {
      kind: 'result',
      result: {
        wakeId, acked: true, profileVersion, sent: stats.sent, steps: result.steps.length,
        ...(proactiveBlocked ? { blocked: true } : {}),
      },
    }
  }

  function requeueFor(channel: string, snapshot: Pending): void {
    requeue(laneOf(channel), snapshot)
  }

  function emitTurn(channel: string, wakeId: string, ok: boolean, sent: number, steps: number, profileVersion: number): void {
    try {
      deps.emit('agent.turn', { channel, wakeId, ok, sent, steps, profileVersion })
    } catch {
      log.warn('agent-runtime.emit_failed', { channel })
    }
  }

  // ---- rotating and forgetting ----

  /**
   * Called when a rotation that ran with no turn in it is over. A `forgotten()` that came in meanwhile asked for a rotation of
   * the session that has just been deleted, so it must not rotate the new one again, now or after a restart.
   */
  async function settleForgetting(channel: string, lane: Lane): Promise<void> {
    lane.rotateAfter = false
    const entry = pool.get(channel)
    if (entry?.rotatePending === true) {
      delete entry.rotatePending
      await flush()
    }
  }

  /** Rotates now when the channel is idle, otherwise right after the running turn. */
  async function rotateWhenFree(channel: string, persist: boolean): Promise<void> {
    // A channel with no session has nothing to rotate, and must not get a lane just for being named.
    const entry = pool.get(channel)
    if (entry === undefined) return
    const lane = laneOf(channel)
    if (lane.busy) {
      lane.rotateAfter = true
      if (persist) {
        // A crash before the turn ends must not bring the old session back.
        entry.rotatePending = true
        await flush()
      }
      return
    }
    lane.busy = true
    try {
      await rotateSession(channel, false)
      await settleForgetting(channel, lane)
    } finally {
      lane.busy = false
      start(channel)
    }
  }

  return {
    wake,
    wakeProactiveMessage(channel, input, send) {
      return accept(channel, { ...input, proactive: true, debounceMs: 0, silent: false }, send)
    },
    async canProactive(channel) {
      if (typeof channel !== 'string' || !CHANNEL_PATTERN.test(channel)) throw new BrainError('INVALID_ARGUMENT', '通道 id 格式不对。')
      await loaded
      if (closed) throw unavailable('内核正在关闭。')
      const settings = await deps.settings()
      const skipped = await checkProactive(channel, settings)
      if (skipped !== undefined) return skipped
      const lane = lanes.get(channel)
      if (lane !== undefined && (lane.busy || lane.pending !== undefined)) return 'foreground'
      return undefined
    },
    async rotate(channel) {
      await loaded
      await rotateWhenFree(channel, false)
    },
    async forgotten(channels) {
      await loaded
      gateway.forgetSent(channels)
      await Promise.all(channels.map((channel) => rotateWhenFree(channel, true)))
    },
    async close() {
      closed = true
      for (const lane of lanes.values()) {
        const pending = lane.pending
        if (pending === undefined) continue
        if (pending.timer !== undefined) timers.clear(pending.timer)
        lane.pending = undefined
        for (const caller of pending.callers) caller.reject(unavailable('内核正在关闭。'))
      }
      await loaded
      await flush()
    },
  }
}
