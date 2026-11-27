import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { BrainError } from '@dsh-brain-core/sdk'
import type { MemoryRecord, SearchHit, Viewer, WakeSkip } from '@dsh-brain-core/sdk'
import { writeFileAtomic } from '@dsh-brain-core/shared'
import { dayOf, zonedParts } from './agent-runtime/index.ts'
import type {
  AgentRuntime, ChannelFacts, ChannelRegistry, Clock, CrossChannelMode, MemoryDecay, MemoryService,
  ProactiveOwnLifeSettings, RuntimeSettings,
} from './contracts/index.ts'
import type { Logger } from './log/index.ts'
import type { Memory } from './memory-api/index.ts'
import { createMemoryDecay } from './memory-decay/index.ts'
import { createPolicy } from './memory-policy/index.ts'

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000
const ACTIVITY_LOOKBACK_MS = 30 * DAY_MS
const MEMBERS_TIMEOUT_MS = 3_000
const MAX_HISTORY = 30

const DEFAULT_STARTUP_DELAY_MS = 90_000
const DEFAULT_INTERVAL_MS = 9_000_000
const MIN_INTERVAL_MS = 60_000
const DEFAULT_MAX_PER_DAY = 6
const DEFAULT_MIDNIGHT_MINUTE = 23 * 60 + 30
const DEFAULT_RECALL_PER_DAY = 2
const DEFAULT_COOLDOWN_DAYS = 7
const DEFAULT_ASSOCIATE_TIMEOUT_MS = 1_500
const DEFAULT_MIN_AGE_DAYS = 2
const MIN_L0_AGE_DAYS = 3
const MAX_L0_AGE_DAYS = 365
const MIN_L0_CODEPOINTS = 12
const MIN_L12_RETRIEVABILITY = 0.15
const DEFAULT_QUIET_HOURS: readonly [number, number] = [3, 8]

const DEFAULT_CHANNELS = new Set(['qq', 'telegram', 'tg', 'feishu'])
const ALLOWED_L1_KINDS = new Set(['l1.fact', 'l1.event', 'l1.note', 'l1.relation', 'l1.self', 'l1.knowledge'])

const BASE_DAYTIME_NOTE =
  '现在是你的时间，没人找你。想干自己的事、写点感触或什么都不干都可以；'
  + '如果有想跟对方说的话，可以用主动发消息工具自然地聊一句，不想聊就保持安静，不用回我也不用汇报。'

const MIDNIGHT_NOTE =
  '半夜了，没人打扰，这段时间别主动给主人发消息。可以把今天的事安静地想一想、记下来，或者直接休息，不用回复。'

interface RecallCooldown {
  lastAt: number
  count: number
}

interface HistoryEntry {
  readonly at: number
  readonly kind: 'own-life' | 'recall' | 'associate' | 'midnight'
  readonly source: string
  readonly recordId: string
  readonly fromId?: string
}

interface OwnLifeState {
  version: 1
  lastFiredAt?: number
  lastDay: string
  firedToday: number
  lastMidnightDay?: string
  recallDay: string
  recallToday: number
  recall: Record<string, RecallCooldown>
  history: HistoryEntry[]
}

interface ResolvedConfig {
  readonly enabled: boolean
  readonly intervalMs: number
  readonly maxPerDay: number
  readonly midnightMinute: number | undefined
  readonly recallPerDay: number
  readonly cooldownDays: number
  readonly associateEnabled: boolean
  readonly associateTimeoutMs: number
  readonly minAgeDays: number
}

interface ChannelActivity {
  readonly channel: string
  readonly isDefault: boolean
  readonly bidirectionalCount: number
  readonly lastInboundAt: number
}

interface ScoredCandidate {
  readonly record: MemoryRecord
  readonly label: string
  readonly text: string
  readonly weight: number
}

export interface ProactiveOwnLifeDeps {
  readonly memory: Pick<Memory, 'store' | 'channels' | 'audit'> & {
    readonly service: Pick<MemoryService, 'search'> & {
      readonly searchWithoutAudit?: Memory['service']['searchWithoutAudit']
    }
    readonly decay?: MemoryDecay
  }
  readonly agent: AgentRuntime
  readonly providers: ChannelRegistry
  readonly ownerChannels: ReadonlySet<string>
  readonly settings: () => Promise<RuntimeSettings>
  readonly crossChannelMode: () => CrossChannelMode
  readonly clock: Clock
  readonly log: Logger
  readonly stateFile: string
  readonly startupDelayMs?: number
  readonly rng?: () => number
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function clamp01(value: number, fallback: number): number {
  return Number.isFinite(value) ? clamp(value, 0, 1) : fallback
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function parseMidnightMinute(raw: string | undefined): number | undefined {
  if (raw === undefined) return DEFAULT_MIDNIGHT_MINUTE
  const value = raw.trim()
  if (value === '') return undefined
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value)
  if (match === null) return DEFAULT_MIDNIGHT_MINUTE
  return Number(match[1]) * 60 + Number(match[2])
}

function resolveConfig(raw: ProactiveOwnLifeSettings | undefined): ResolvedConfig {
  return {
    enabled: raw?.enabled ?? true,
    intervalMs: Math.max(MIN_INTERVAL_MS, finiteOr(raw?.intervalMs, DEFAULT_INTERVAL_MS)),
    maxPerDay: Math.max(0, Math.floor(finiteOr(raw?.maxPerDay, DEFAULT_MAX_PER_DAY))),
    midnightMinute: parseMidnightMinute(raw?.midnightAt),
    recallPerDay: Math.max(0, Math.floor(finiteOr(raw?.recallPerDay, DEFAULT_RECALL_PER_DAY))),
    cooldownDays: Math.max(0, finiteOr(raw?.cooldownDays, DEFAULT_COOLDOWN_DAYS)),
    associateEnabled: raw?.associateEnabled ?? true,
    associateTimeoutMs: Math.max(1, finiteOr(raw?.associateTimeoutMs, DEFAULT_ASSOCIATE_TIMEOUT_MS)),
    minAgeDays: Math.max(0, finiteOr(raw?.minAgeDays, DEFAULT_MIN_AGE_DAYS)),
  }
}

function emptyState(): OwnLifeState {
  return {
    version: 1,
    lastDay: '',
    firedToday: 0,
    recallDay: '',
    recallToday: 0,
    recall: {},
    history: [],
  }
}

function parseState(raw: unknown): OwnLifeState {
  if (!isPlainRecord(raw)) return emptyState()
  const recall: Record<string, RecallCooldown> = {}
  if (isPlainRecord(raw.recall)) {
    for (const [id, entry] of Object.entries(raw.recall)) {
      if (!isPlainRecord(entry)) continue
      if (typeof entry.lastAt === 'number' && Number.isFinite(entry.lastAt)
        && typeof entry.count === 'number' && Number.isInteger(entry.count) && entry.count >= 0) {
        recall[id] = { lastAt: entry.lastAt, count: entry.count }
      }
    }
  }
  const history: HistoryEntry[] = []
  if (Array.isArray(raw.history)) {
    for (const item of raw.history) {
      if (!isPlainRecord(item)) continue
      if (typeof item.at !== 'number' || !Number.isFinite(item.at)) continue
      if (item.kind !== 'own-life' && item.kind !== 'recall' && item.kind !== 'associate' && item.kind !== 'midnight') continue
      if (typeof item.source !== 'string' || typeof item.recordId !== 'string') continue
      history.push({
        at: item.at,
        kind: item.kind,
        source: item.source,
        recordId: item.recordId,
        ...(typeof item.fromId === 'string' ? { fromId: item.fromId } : {}),
      })
    }
  }
  return {
    version: 1,
    ...(typeof raw.lastFiredAt === 'number' && Number.isFinite(raw.lastFiredAt) ? { lastFiredAt: raw.lastFiredAt } : {}),
    lastDay: typeof raw.lastDay === 'string' ? raw.lastDay : '',
    firedToday: typeof raw.firedToday === 'number' && Number.isInteger(raw.firedToday) && raw.firedToday >= 0 ? raw.firedToday : 0,
    ...(typeof raw.lastMidnightDay === 'string' && raw.lastMidnightDay !== '' ? { lastMidnightDay: raw.lastMidnightDay } : {}),
    recallDay: typeof raw.recallDay === 'string' ? raw.recallDay : '',
    recallToday: typeof raw.recallToday === 'number' && Number.isInteger(raw.recallToday) && raw.recallToday >= 0 ? raw.recallToday : 0,
    recall,
    history: history.slice(-MAX_HISTORY),
  }
}

async function readState(file: string): Promise<OwnLifeState> {
  try {
    return parseState(JSON.parse(await readFile(file, 'utf8')) as unknown)
  } catch {
    return emptyState()
  }
}

async function writeState(file: string, state: OwnLifeState): Promise<void> {
  const trimmed: OwnLifeState = {
    ...state,
    history: state.history.slice(-MAX_HISTORY),
  }
  await mkdir(path.dirname(file), { recursive: true })
  await writeFileAtomic(file, JSON.stringify(trimmed))
}

function inQuietHours(hour: number, range: readonly [number, number]): boolean {
  const [start, end] = range
  if (start === end) return false
  return start < end ? hour >= start && hour < end : hour >= start || hour < end
}

function activityDayOf(now: number, timezone: string | undefined, quiet: readonly [number, number]): string {
  if (quiet[0] >= 0 && quiet[0] < quiet[1] && quiet[1] <= 24) {
    return dayOf(now - quiet[0] * HOUR_MS, timezone)
  }
  return dayOf(now, timezone)
}

interface RhythmWindow {
  readonly midnightActive: boolean
  readonly daytimeInside: boolean
  readonly remainingMinutes: number
}

function evaluateRhythmWindow(
  minuteOfDay: number,
  midnightMinute: number | undefined,
  quiet: readonly [number, number],
): RhythmWindow {
  const [qStart, qEnd] = quiet
  if (qStart === qEnd) {
    const dayEnd = midnightMinute ?? 1440
    const midnightActive = midnightMinute !== undefined && minuteOfDay >= midnightMinute
    const daytimeInside = minuteOfDay < dayEnd
    return {
      midnightActive,
      daytimeInside,
      remainingMinutes: daytimeInside ? dayEnd - minuteOfDay : 0,
    }
  }

  const qStartMin = Math.round(qStart * 60)
  const qEndMin = Math.round(qEnd * 60)

  if (qStart < qEnd) {
    const midnightInQuiet = midnightMinute === undefined || (midnightMinute >= qStartMin && midnightMinute < qEndMin)
    if (midnightInQuiet) {
      const daytimeInside = minuteOfDay >= qEndMin || minuteOfDay < qStartMin
      const remainingMinutes = daytimeInside
        ? (minuteOfDay >= qEndMin ? 1440 - minuteOfDay + qStartMin : qStartMin - minuteOfDay)
        : 0
      return { midnightActive: false, daytimeInside, remainingMinutes }
    }
    if (midnightMinute >= qEndMin) {
      const midnightActive = minuteOfDay >= midnightMinute || minuteOfDay < qStartMin
      const daytimeInside = minuteOfDay >= qEndMin && minuteOfDay < midnightMinute
      return {
        midnightActive,
        daytimeInside,
        remainingMinutes: daytimeInside ? midnightMinute - minuteOfDay : 0,
      }
    }
    // midnightMinute < qStartMin (e.g. 01:00 before 03:00..08:00)
    const midnightActive = minuteOfDay >= midnightMinute && minuteOfDay < qStartMin
    const daytimeInside = minuteOfDay >= qEndMin || minuteOfDay < midnightMinute
    const remainingMinutes = daytimeInside
      ? (minuteOfDay >= qEndMin ? 1440 - minuteOfDay + midnightMinute : midnightMinute - minuteOfDay)
      : 0
    return { midnightActive, daytimeInside, remainingMinutes }
  }

  // Cross-midnight quiet hours (qStart > qEnd, e.g. [22, 6]): awake interval is strictly [qEndMin, qStartMin).
  const midnightInAwake = midnightMinute !== undefined && midnightMinute >= qEndMin && midnightMinute < qStartMin
  if (!midnightInAwake) {
    const daytimeInside = minuteOfDay >= qEndMin && minuteOfDay < qStartMin
    return {
      midnightActive: false,
      daytimeInside,
      remainingMinutes: daytimeInside ? qStartMin - minuteOfDay : 0,
    }
  }
  const midnightActive = minuteOfDay >= midnightMinute && minuteOfDay < qStartMin
  const daytimeInside = minuteOfDay >= qEndMin && minuteOfDay < midnightMinute
  return {
    midnightActive,
    daytimeInside,
    remainingMinutes: daytimeInside ? midnightMinute - minuteOfDay : 0,
  }
}

/** Races an underlying promise against a timeout while catching any late rejection on the underlying promise. */
async function raceWithTimeout<T>(pending: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  pending.catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new Error(label)) }, timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function cleanL0Text(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/\[[^\]\r\n]*\]/g, '').trim()
}

function recordTextOf(record: MemoryRecord): string {
  if (record.layer === 'L0') return cleanL0Text(record.content.text)
  return typeof record.content.text === 'string' ? record.content.text.trim() : ''
}

function isRecallEligibleRecord(record: MemoryRecord, viewerChannel: string, crossChannel: boolean, now: number, minAgeDays: number): boolean {
  if (record.status !== 'active') return false
  if (record.validTo !== undefined && record.validTo <= now) return false
  if (record.layer === 'L0') {
    if (record.channel !== viewerChannel) return false
    const age = now - record.tEvent
    if (age < MIN_L0_AGE_DAYS * DAY_MS || age > MAX_L0_AGE_DAYS * DAY_MS) return false
    return [...cleanL0Text(record.content.text)].length >= MIN_L0_CODEPOINTS
  }
  if (record.channel !== viewerChannel && !crossChannel) return false
  if (record.layer === 'L1') {
    if (!ALLOWED_L1_KINDS.has(record.kind)) return false
    return now - record.tEvent >= minAgeDays * DAY_MS && recordTextOf(record) !== ''
  }
  if (record.layer === 'L2') {
    return now - record.tEvent >= minAgeDays * DAY_MS && recordTextOf(record) !== ''
  }
  return false
}

function pickWeighted<T extends { readonly weight: number }>(items: readonly T[], rng: () => number): T | undefined {
  let total = 0
  for (const item of items) {
    if (item.weight > 0) total += item.weight
  }
  if (total <= 0) return undefined
  let cursor = rng() * total
  for (const item of items) {
    if (item.weight <= 0) continue
    cursor -= item.weight
    if (cursor <= 0) return item
  }
  return items[items.length - 1]
}

function compareChannelActivity(a: ChannelActivity, b: ChannelActivity): number {
  if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
  if (a.bidirectionalCount !== b.bidirectionalCount) return b.bidirectionalCount - a.bidirectionalCount
  if (a.lastInboundAt !== b.lastInboundAt) return b.lastInboundAt - a.lastInboundAt
  return a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0
}

function formatRecallLine(record: MemoryRecord, viewerChannel: string, label: string, text: string, timezone?: string): string {
  const date = dayOf(record.tEvent, timezone)
  const prefix = record.channel !== viewerChannel && label.trim() !== '' ? `[${label}] ` : ''
  return `${prefix}${date}：${text}`
}

/** Creates the kernel's own-life periodic runner (daytime rhythm, FSRS recall, 1-hop association, midnight wind-down). */
export function createProactiveOwnLife(deps: ProactiveOwnLifeDeps): () => Promise<void> {
  const policy = createPolicy()
  const decay = deps.memory.decay ?? createMemoryDecay()
  const startedAt = deps.clock.now()
  const startupDelayMs = Math.max(0, finiteOr(deps.startupDelayMs, DEFAULT_STARTUP_DELAY_MS))
  const rng = deps.rng ?? Math.random
  let inFlight = false

  async function canProactive(channel: string, hourFloat: number, quiet: readonly [number, number]): Promise<WakeSkip | undefined> {
    if (deps.agent.canProactive !== undefined) {
      return await deps.agent.canProactive(channel)
    }
    return inQuietHours(hourFloat, quiet) ? 'quiet' : undefined
  }

  async function eligibleChannels(now: number): Promise<ChannelActivity[]> {
    const candidates = [...deps.ownerChannels].filter((channel) => deps.providers.proactiveProviderOf(channel) !== undefined)
    if (candidates.length === 0) return []
    if (candidates.length === 1 && DEFAULT_CHANNELS.has(candidates[0]!.split(':')[0] ?? '')) {
      return [{ channel: candidates[0]!, isDefault: true, bidirectionalCount: 0, lastInboundAt: 0 }]
    }

    const stats = new Map<string, { inbound: number; outbound: number; lastInboundAt: number }>()
    for (const channel of candidates) stats.set(channel, { inbound: 0, outbound: 0, lastInboundAt: 0 })

    const windowStart = now - ACTIVITY_LOOKBACK_MS
    const accumulate = (record: MemoryRecord): void => {
      if (record.status !== 'active' || record.tEvent < windowStart || record.tEvent > now) return
      const entry = stats.get(record.channel)
      if (entry === undefined) return
      if (record.actor === 'self' || record.content.direction === 'outbound') {
        entry.outbound += 1
      } else {
        entry.inbound += 1
        if (record.tEvent > entry.lastInboundAt) entry.lastInboundAt = record.tEvent
      }
    }

    if (typeof deps.memory.store.list === 'function') {
      let cursor: string | undefined
      for (;;) {
        const page = await deps.memory.store.list(
          { layers: ['L0'], channels: candidates, statuses: ['active'], from: windowStart, to: now },
          { limit: 1000, ...(cursor === undefined ? {} : { cursor }) },
        )
        for (const record of page.items) accumulate(record)
        if (page.nextCursor === undefined) break
        cursor = page.nextCursor
      }
    } else {
      for await (const record of deps.memory.store.scan(['L0'])) {
        accumulate(record)
      }
    }

    const active: ChannelActivity[] = []
    for (const channel of candidates) {
      const source = channel.split(':')[0] ?? ''
      const isDefault = DEFAULT_CHANNELS.has(source)
      const entry = stats.get(channel)!
      const bidirectionalCount = Math.min(entry.inbound, entry.outbound)
      // Third-party channels require real 30-day bidirectional interaction before participating in own-life delivery.
      if (!isDefault && bidirectionalCount === 0) continue
      active.push({ channel, isDefault, bidirectionalCount, lastInboundAt: entry.lastInboundAt })
    }
    return active.sort(compareChannelActivity)
  }

  async function resolveViewer(channel: string): Promise<{ readonly viewer: Viewer; readonly facts: ChannelFacts }> {
    const base: Viewer = { caller: 'agent', channel, participants: [] }
    let facts = await deps.memory.channels.forViewer(base)
    let participants = [...(facts.members.get(channel) ?? [])].filter((person) => person !== 'self')
    if (participants.length === 0) {
      const provider = deps.providers.proactiveProviderOf(channel)
      if (provider !== undefined) {
        try {
          const members = await raceWithTimeout(provider.members(channel), MEMBERS_TIMEOUT_MS, 'members timed out')
          if (Array.isArray(members) && members.length > 0) {
            deps.memory.channels.setMembers(channel, members)
            facts = await deps.memory.channels.forViewer(base)
            participants = [...(facts.members.get(channel) ?? [])].filter((person) => person !== 'self')
          }
        } catch {
          deps.log.warn('proactive.own_life_members_failed', { channel })
        }
      }
    }
    return { viewer: { ...base, participants }, facts }
  }

  async function pickSeedCandidate(
    channel: string,
    viewer: Viewer,
    facts: ChannelFacts,
    state: OwnLifeState,
    config: ResolvedConfig,
    crossChannel: boolean,
    now: number,
  ): Promise<ScoredCandidate | undefined> {
    const candidates: ScoredCandidate[] = []
    const cooldownMs = config.cooldownDays * DAY_MS

    for await (const record of deps.memory.store.scan(['L0', 'L1', 'L2'])) {
      if (!isRecallEligibleRecord(record, channel, crossChannel, now, config.minAgeDays)) continue
      const prev = state.recall[record.id]
      if (prev !== undefined && now - prev.lastAt < cooldownMs) continue
      const decision = policy.decide(record, viewer, facts)
      if (!decision.visible || decision.injection !== 'verbatim' || decision.disclosure.speakable !== 'yes') continue

      let weight: number
      if (record.layer === 'L0') {
        weight = clamp((now - record.tEvent) / (14 * DAY_MS), 0.2, 1)
      } else {
        const retrievability = decay.retrievabilityOf(record, now)
        if (retrievability < MIN_L12_RETRIEVABILITY) continue
        const forgetting = clamp((1 - retrievability) / 0.85, 0.05, 1)
        weight = clamp01(record.importance, 0.5) * forgetting
      }
      if (weight <= 0) continue
      candidates.push({ record, label: decision.disclosure.label, text: recordTextOf(record), weight })
    }

    return pickWeighted(candidates, rng)
  }

  async function findAssociated(
    seed: ScoredCandidate,
    channel: string,
    viewer: Viewer,
    facts: ChannelFacts,
    state: OwnLifeState,
    config: ResolvedConfig,
    crossChannel: boolean,
    now: number,
  ): Promise<ScoredCandidate | undefined> {
    if (!config.associateEnabled) return undefined
    const query = Array.from(seed.text).slice(0, 200).join('')
    if (query === '') return undefined

    const searchFn = deps.memory.service.searchWithoutAudit ?? deps.memory.service.search
    try {
      const pending = crossChannel
        ? Promise.all([
            searchFn({
              query,
              scope: 'all',
              layers: ['L1', 'L2'],
              to: now - config.minAgeDays * DAY_MS,
              limit: 10,
            }, viewer),
            searchFn({
              query,
              scope: 'here',
              layers: ['L0'],
              from: now - MAX_L0_AGE_DAYS * DAY_MS,
              to: now - MIN_L0_AGE_DAYS * DAY_MS,
              limit: 10,
            }, viewer),
          ]).then(([l12, l0]) => [...l12.items, ...l0.items])
        : searchFn({
            query,
            scope: 'here',
            layers: ['L0', 'L1', 'L2'],
            to: now - Math.min(config.minAgeDays, MIN_L0_AGE_DAYS) * DAY_MS,
            limit: 10,
          }, viewer).then((res) => res.items)

      const mergedItems = await raceWithTimeout(pending, config.associateTimeoutMs, 'associate search timed out')
      const deduped = new Map<string, SearchHit>()
      for (const hit of mergedItems) {
        const prev = deduped.get(hit.record.id)
        if (prev === undefined || hit.score > prev.score) deduped.set(hit.record.id, hit)
      }

      const cooldownMs = config.cooldownDays * DAY_MS
      const related: ScoredCandidate[] = []
      for (const hit of deduped.values()) {
        const record = hit.record
        if (record.id === seed.record.id) continue
        if (!isRecallEligibleRecord(record, channel, crossChannel, now, config.minAgeDays)) continue
        const prev = state.recall[record.id]
        if (prev !== undefined && now - prev.lastAt < cooldownMs) continue
        const decision = policy.decide(record, viewer, facts)
        if (!decision.visible || decision.injection !== 'verbatim' || decision.disclosure.speakable !== 'yes') continue
        related.push({
          record,
          label: decision.disclosure.label,
          text: recordTextOf(record),
          weight: Number.isFinite(hit.score) && hit.score > 0 ? hit.score : 1,
        })
      }
      return pickWeighted(related, rng)
    } catch {
      return undefined
    }
  }

  async function reinforceRecord(record: MemoryRecord, now: number): Promise<void> {
    if (record.layer !== 'L1' && record.layer !== 'L2') return
    try {
      const nextDecay = decay.reinforce(record, now, 3)
      await deps.memory.store.patch(
        record.id,
        { content: { ...record.content, decay: nextDecay } },
        record.version,
      )
    } catch {
      deps.log.warn('proactive.own_life_reinforce_failed', { recordId: record.id })
    }
  }

  async function runMidnight(
    channels: readonly ChannelActivity[],
    activityDay: string,
    hourFloat: number,
    quiet: readonly [number, number],
    state: OwnLifeState,
    now: number,
  ): Promise<void> {
    if (state.lastMidnightDay === activityDay) return
    let target: string | undefined
    for (const candidate of channels) {
      const skip = await canProactive(candidate.channel, hourFloat, quiet)
      if (skip !== 'quiet' && skip !== 'foreground') {
        target = candidate.channel
        break
      }
    }
    if (target === undefined) return

    try {
      const result = await deps.agent.wake(target, {
        reason: 'own-life-midnight',
        silent: true,
        note: MIDNIGHT_NOTE,
      })
      if (result.skipped !== undefined) {
        deps.log.info('proactive.own_life_skipped', { channel: target, code: result.skipped })
        return
      }
      state.lastMidnightDay = activityDay
      state.history.push({ at: now, kind: 'midnight', source: 'none', recordId: '' })
      await writeState(deps.stateFile, state)
      deps.log.info('proactive.own_life_midnight', { channel: target })
    } catch {
      deps.log.warn('proactive.own_life_wake_failed', { channel: target })
    }
  }

  async function runOnce(): Promise<void> {
    const now = deps.clock.now()
    if (now - startedAt < startupDelayMs) return
    if (deps.ownerChannels.size === 0) return

    const settings = await deps.settings()
    const config = resolveConfig(settings.proactive?.ownLife)
    if (!config.enabled) return

    const quiet = settings.quietHours ?? DEFAULT_QUIET_HOURS
    const parts = zonedParts(now, settings.timezone)
    const minuteOfDay = parts.hour * 60 + parts.minute
    const hourFloat = parts.hour + parts.minute / 60
    const activityDay = activityDayOf(now, settings.timezone, quiet)

    const rhythm = evaluateRhythmWindow(minuteOfDay, config.midnightMinute, quiet)
    if (!rhythm.midnightActive && !rhythm.daytimeInside) return

    const state = await readState(deps.stateFile)
    const firedToday = state.lastDay === activityDay ? state.firedToday : 0
    const recallToday = state.recallDay === activityDay ? state.recallToday : 0

    if (rhythm.midnightActive) {
      if (state.lastMidnightDay !== activityDay) {
        const channels = await eligibleChannels(now)
        if (channels.length > 0) {
          await runMidnight(channels, activityDay, hourFloat, quiet, state, now)
        }
      }
      return
    }

    if (firedToday >= config.maxPerDay) return
    if (state.lastFiredAt !== undefined && now - state.lastFiredAt < config.intervalMs) return

    const channels = await eligibleChannels(now)
    if (channels.length === 0) return

    let selectedChannel: string | undefined
    let lastSkip: WakeSkip | undefined
    for (const candidate of channels) {
      const skip = await canProactive(candidate.channel, hourFloat, quiet)
      if (skip === undefined) {
        selectedChannel = candidate.channel
        break
      }
      lastSkip = skip
    }
    if (selectedChannel === undefined) {
      deps.log.info('proactive.own_life_skipped', { channel: channels[0]!.channel, code: lastSkip })
      return
    }

    const crossChannel = deps.crossChannelMode() === 'on'
    const { viewer, facts } = await resolveViewer(selectedChannel)

    const remainingByCap = Math.max(1, config.maxPerDay - firedToday)
    const remainingByTime = 1 + Math.floor((rhythm.remainingMinutes * MINUTE_MS) / config.intervalMs)
    const remainingSlots = Math.max(1, Math.min(remainingByCap, remainingByTime))
    const recallQuota = config.recallPerDay - recallToday

    let seed: ScoredCandidate | undefined
    let associated: ScoredCandidate | undefined

    if (recallQuota > 0 && rng() < recallQuota / remainingSlots) {
      seed = await pickSeedCandidate(selectedChannel, viewer, facts, state, config, crossChannel, now)
      if (seed !== undefined) {
        associated = await findAssociated(seed, selectedChannel, viewer, facts, state, config, crossChannel, now)
      }
    }

    const notes = [BASE_DAYTIME_NOTE]
    const evidence: string[] = []
    if (seed !== undefined) {
      evidence.push(seed.record.id)
      const seedLine = formatRecallLine(seed.record, selectedChannel, seed.label, seed.text, settings.timezone)
      notes.push(`只是脑子里忽然冒出来的旧事（${seedLine}）：想提就自然地提一句，不想就当自己想想，绝不要说「我想起了一条记忆」这种话。`)
      if (associated !== undefined) {
        evidence.push(associated.record.id)
        const assocLine = formatRecallLine(associated.record, selectedChannel, associated.label, associated.text, settings.timezone)
        notes.push(`说起这个顺带想到的（${assocLine}），不一定要提。`)
      }
    }

    try {
      const result = await deps.agent.wakeProactiveMessage(selectedChannel, {
        reason: 'own-life',
        evidence,
        note: notes.join('\n'),
      }, async (text) => {
        const provider = deps.providers.proactiveProviderOf(selectedChannel)
        if (provider === undefined || !deps.ownerChannels.has(selectedChannel)) {
          throw new BrainError('UNAVAILABLE', '当前投递通道不可用。')
        }
        if (evidence.length > 0) {
          const sendingAt = deps.clock.now()
          const currentCrossChannel = deps.crossChannelMode() === 'on'
          const currentFacts = await deps.memory.channels.forViewer(viewer)
          const currentParticipants = [...(currentFacts.members.get(selectedChannel) ?? [])].filter((person) => person !== 'self')
          const currentViewer: Viewer = { caller: 'agent', channel: selectedChannel, participants: currentParticipants }
          const loadedRecords = await Promise.all(evidence.map((id) => deps.memory.store.get(id)))
          for (const record of loadedRecords) {
            if (record === null || record.status !== 'active' || (record.validTo !== undefined && record.validTo <= sendingAt)) {
              throw new BrainError('UNAVAILABLE', '相关记忆已失效或不可见。')
            }
            if (record.channel !== selectedChannel && (record.layer === 'L0' || !currentCrossChannel)) {
              throw new BrainError('UNAVAILABLE', '相关记忆已不允许跨通道使用。')
            }
            const decision = policy.decide(record, currentViewer, currentFacts)
            if (!decision.visible || decision.injection !== 'verbatim' || decision.disclosure.speakable !== 'yes') {
              throw new BrainError('UNAVAILABLE', '相关记忆当前不可披露。')
            }
          }
        }
        if (deps.providers.proactiveProviderOf(selectedChannel) !== provider) {
          throw new BrainError('UNAVAILABLE', '投递通道已变更。')
        }
        const response = await provider.send(selectedChannel, { text })
        if (typeof response?.messageId !== 'string' || response.messageId.trim() === '') {
          throw new BrainError('UNAVAILABLE', '通道未返回可确认的消息 ID。')
        }
        return response.messageId
      })

      if (result.skipped !== undefined) {
        deps.log.info('proactive.own_life_skipped', { channel: selectedChannel, code: result.skipped })
        return
      }

      state.lastDay = activityDay
      state.firedToday = firedToday + 1
      state.lastFiredAt = now
      state.recallDay = activityDay
      state.recallToday = seed === undefined ? recallToday : recallToday + 1

      if (seed !== undefined) {
        const prevSeed = state.recall[seed.record.id]
        state.recall[seed.record.id] = { lastAt: now, count: (prevSeed?.count ?? 0) + 1 }
        state.history.push({ at: now, kind: 'recall', source: seed.record.layer, recordId: seed.record.id })
        await reinforceRecord(seed.record, now)
        if (associated !== undefined) {
          const prevAssoc = state.recall[associated.record.id]
          state.recall[associated.record.id] = { lastAt: now, count: (prevAssoc?.count ?? 0) + 1 }
          state.history.push({
            at: now,
            kind: 'associate',
            source: associated.record.layer,
            recordId: associated.record.id,
            fromId: seed.record.id,
          })
          await reinforceRecord(associated.record, now)
        }

        if (crossChannel) {
          const auditedIds = new Set<string>()
          for (const rec of [seed.record, associated?.record]) {
            if (rec !== undefined && rec.channel !== selectedChannel && !auditedIds.has(rec.id)) {
              auditedIds.add(rec.id)
              await deps.memory.audit.crossChannelUse({
                recordId: rec.id,
                viewerChannel: selectedChannel,
                mode: 'on',
                tAt: now,
              })
            }
          }
        }
      } else {
        state.history.push({ at: now, kind: 'own-life', source: 'none', recordId: '' })
      }

      await writeState(deps.stateFile, state)
      deps.log.info('proactive.own_life_fired', {
        channel: selectedChannel,
        count: result.sent,
        ...(seed === undefined ? {} : { recordId: seed.record.id, layer: seed.record.layer }),
      })
    } catch {
      deps.log.warn('proactive.own_life_wake_failed', { channel: selectedChannel })
    }
  }

  return async () => {
    if (inFlight) return
    inFlight = true
    try {
      await runOnce()
    } finally {
      inFlight = false
    }
  }
}
