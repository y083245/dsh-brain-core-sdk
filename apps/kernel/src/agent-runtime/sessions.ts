import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { encodeSessionId } from '@dsh-brain-core/satellite-host'
import { writeFileAtomic } from '@dsh-brain-core/shared'

export const MAX_PEOPLE = 32
export const MAX_EVIDENCE = 20

/** One channel's session, as kept in state/agent/sessions.json. */
export interface SessionEntry {
  generation: number
  /** `YYYY-MM-DD` in the owner's time zone. */
  startedDay: string
  /** Tool groups loaded in this session. */
  activated: string[]
  lastInputTokens: number
  turns: number
  lastInboundAt?: number
  lastOutboundAt?: number
  lastProactiveAt?: number
  /** Who spoke here lately, newest first. */
  people: string[]
  /** The newest L0 ids, newest last. */
  recentEvidence: string[]
  /** Id of the handoff record the next first wake carries. */
  handoff?: string
  /** Set while a rotation forced by `forgotten()` waits for the running turn, so a crash cannot keep the old session. */
  rotatePending?: true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function strings(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string').slice(0, max)
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function time(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Anything that does not look like an entry gives undefined, so a damaged one is dropped rather than trusted. */
export function parseEntry(channel: string, value: unknown): SessionEntry | undefined {
  if (!isRecord(value)) return undefined
  const { generation, startedDay } = value
  if (typeof generation !== 'number') return undefined
  if (typeof startedDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(startedDay)) return undefined
  // The session id says whether the channel and the generation can be used at all.
  try {
    encodeSessionId({ agentClass: 'chat', channel, generation })
  } catch {
    return undefined
  }
  const entry: SessionEntry = {
    generation,
    startedDay,
    activated: strings(value.activated, 256),
    lastInputTokens: count(value.lastInputTokens),
    turns: count(value.turns),
    people: strings(value.people, MAX_PEOPLE),
    recentEvidence: strings(value.recentEvidence, MAX_EVIDENCE),
  }
  const inbound = time(value.lastInboundAt)
  const outbound = time(value.lastOutboundAt)
  const proactive = time(value.lastProactiveAt)
  if (inbound !== undefined) entry.lastInboundAt = inbound
  if (outbound !== undefined) entry.lastOutboundAt = outbound
  if (proactive !== undefined) entry.lastProactiveAt = proactive
  if (typeof value.handoff === 'string' && value.handoff !== '') entry.handoff = value.handoff
  if (value.rotatePending === true) entry.rotatePending = true
  return entry
}

/** A missing or damaged file is an empty pool. */
export async function readSessions(file: string): Promise<Map<string, SessionEntry>> {
  const pool = new Map<string, SessionEntry>()
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(file, 'utf8')) as unknown
  } catch {
    return pool
  }
  if (!isRecord(parsed) || !isRecord(parsed.channels)) return pool
  for (const [channel, value] of Object.entries(parsed.channels)) {
    const entry = parseEntry(channel, value)
    if (entry !== undefined) pool.set(channel, entry)
  }
  return pool
}

export async function writeSessions(file: string, pool: ReadonlyMap<string, SessionEntry>): Promise<void> {
  const channels: Record<string, SessionEntry> = {}
  for (const [channel, entry] of pool) channels[channel] = entry
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await writeFileAtomic(file, `${JSON.stringify({ version: 1, channels }, null, 2)}\n`)
}

/** Newest first, no repeats, never `self`, at most 32. */
export function rememberPeople(previous: readonly string[], speakers: readonly string[]): string[] {
  const result: string[] = []
  for (const person of [...[...speakers].reverse(), ...previous]) {
    if (person === 'self' || result.includes(person)) continue
    result.push(person)
    if (result.length >= MAX_PEOPLE) break
  }
  return result
}

/** Oldest first, newest last, at most 20. */
export function rememberEvidence(previous: readonly string[], ids: readonly string[]): string[] {
  const result = previous.filter((id) => !ids.includes(id))
  result.push(...ids)
  return result.slice(-MAX_EVIDENCE)
}
