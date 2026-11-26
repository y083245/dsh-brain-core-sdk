import type {
  ContextBlock, ContextBlockName, ContextBundle, ContextItem, ContextRequest, Disclosure, MemoryRecord, Viewer,
} from '@brain-core/sdk'
import {
  KINDS, type ChannelFacts, type Clock, type ContextAssembler, type CrossChannelMode, type KeywordIndex,
  type MemoryAudit, type MemoryDecay, type Policy, type ProfileReader, type RecordFilter, type RecordStore,
  type WorkingMemoryStore,
} from '../contracts/index.ts'
import { createMemoryDecay } from '../memory-decay/index.ts'
import { bigrams } from '../memory-search/index.ts'

export const DEFAULT_BUDGETS: Readonly<Record<ContextBlockName, number>> = Object.freeze({
  profile: 1500, working: 600, topics: 400, facts: 1500, lessons: 800, recall: 800, elsewhere: 600, promises: 300,
})

const BLOCK_ORDER: readonly ContextBlockName[] = [
  'profile', 'working', 'topics', 'facts', 'lessons', 'recall', 'elsewhere', 'promises',
]

/** Every L1 kind except the ones that belong to other blocks (or nowhere): candidates stay out of /context. */
const FACT_KINDS: readonly string[] = KINDS.L1.filter(
  (kind) => kind !== 'l1.candidate' && kind !== 'l1.promise' && kind !== 'l1.topic',
)

/** A day, in milliseconds: how far back "你最近在别处" looks. */
const ELSEWHERE_WINDOW_MS = 86_400_000

const PAGE_LIMIT = 1000
const RECALL_LIMIT = 50
const LEGACY_DISCLOSURE_SUFFIX = '（旧系统历史存档，仅作事实参考，不作为当前说话语气）'

function withLegacyDisclosure(record: MemoryRecord, disclosure: Disclosure): Disclosure {
  if (record.layer !== 'L0' || record.content.legacy !== true) return disclosure
  if (disclosure.label.includes(LEGACY_DISCLOSURE_SUFFIX)) return disclosure
  return { ...disclosure, label: `${disclosure.label}${LEGACY_DISCLOSURE_SUFFIX}` }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== 'object') return value
  const prototype = Object.getPrototypeOf(value)
  // Leave Dates, Maps and other non-plain objects to JSON.stringify; only plain objects differ by key order.
  if (prototype !== Object.prototype && prototype !== null) return value
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key])
  }
  return sorted
}

/** JSON.stringify with object keys sorted at every depth, so equal content always gives equal bytes. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

/** The text a record contributes when the policy says verbatim. */
export function renderText(record: MemoryRecord): string {
  const text = record.content.text
  return typeof text === 'string' ? text : stableStringify(record.content)
}

function codePointLength(text: string): number {
  return [...text].length
}

interface Chosen {
  readonly record: MemoryRecord
  readonly item: ContextItem
  readonly crossChannel: boolean
}

interface TrimmedEntry {
  readonly recordId?: string
  readonly item: ContextItem
  readonly crossChannel: boolean
}

function compareChosen(left: Chosen, right: Chosen, decay: MemoryDecay | undefined, now: number): number {
  if (decay !== undefined) {
    const diff = decay.priorityOf(right.record, now) - decay.priorityOf(left.record, now)
    if (Math.abs(diff) > 1e-12) return diff > 0 ? 1 : -1
  } else if (left.record.importance !== right.record.importance) {
    return right.record.importance - left.record.importance
  }
  if (left.record.tEvent !== right.record.tEvent) return right.record.tEvent - left.record.tEvent
  return left.record.id < right.record.id ? -1 : left.record.id > right.record.id ? 1 : 0
}

async function listAll(store: RecordStore, filter: RecordFilter): Promise<MemoryRecord[]> {
  const records: MemoryRecord[] = []
  let cursor: string | undefined
  for (;;) {
    const page = cursor === undefined
      ? await store.list(filter, { limit: PAGE_LIMIT })
      : await store.list(filter, { limit: PAGE_LIMIT, cursor })
    records.push(...page.items)
    if (page.nextCursor === undefined) return records
    cursor = page.nextCursor
  }
}

/** The union of several list filters, first sighting wins. */
async function listUnion(store: RecordStore, filters: readonly RecordFilter[]): Promise<MemoryRecord[]> {
  const merged = new Map<string, MemoryRecord>()
  for (const filter of filters) {
    for (const record of await listAll(store, filter)) {
      if (!merged.has(record.id)) merged.set(record.id, record)
    }
  }
  return [...merged.values()]
}

/** A null viewer channel can see no channel-scoped records; an empty channel list matches nothing. */
function channelsFor(channel: string | null): readonly string[] {
  return channel === null ? [] : [channel]
}

function textFor(record: MemoryRecord, injection: 'verbatim' | 'conclusion-only' | 'none'): string | null {
  if (injection === 'verbatim') return renderText(record)
  if (injection === 'conclusion-only') {
    const conclusion = record.content.conclusion
    return typeof conclusion === 'string' && conclusion.length > 0 ? conclusion : null
  }
  return null
}

function normalizeBudgets(
  custom: Partial<Readonly<Record<ContextBlockName, number>>> | undefined,
): Readonly<Record<ContextBlockName, number>> {
  if (custom === undefined) return DEFAULT_BUDGETS
  return Object.fromEntries(
    BLOCK_ORDER.map((name) => [name, custom[name] ?? 0]),
  ) as Record<ContextBlockName, number>
}

function budgetsFor(
  budgets: Readonly<Record<ContextBlockName, number>>,
  budgetChars: number | undefined,
): Readonly<Record<ContextBlockName, number>> {
  if (budgetChars === undefined) return budgets
  const total = BLOCK_ORDER.reduce((sum, name) => sum + budgets[name], 0)
  if (total === 0) return Object.fromEntries(BLOCK_ORDER.map((name) => [name, 0])) as Record<ContextBlockName, number>
  return Object.fromEntries(
    BLOCK_ORDER.map((name) => [name, Math.floor(budgets[name] * budgetChars / total)]),
  ) as Record<ContextBlockName, number>
}

function trimByBudget(
  entries: readonly TrimmedEntry[],
  limit: number,
): { readonly kept: readonly TrimmedEntry[]; readonly truncated: boolean } {
  let used = 0
  let truncated = false
  const kept: TrimmedEntry[] = []
  for (const entry of entries) {
    const length = codePointLength(entry.item.text)
    if (used + length > limit) {
      // Skip it whole; a later, shorter item may still fit (never truncate half an item).
      truncated = true
      continue
    }
    used += length
    kept.push(entry)
  }
  return { kept, truncated }
}

export function createContextAssembler(deps: {
  readonly store: RecordStore
  readonly index: KeywordIndex
  readonly policy: Policy
  readonly profiles: ProfileReader
  readonly audit: MemoryAudit
  readonly clock: Clock
  readonly facts: (viewer: Viewer) => Promise<ChannelFacts>
  readonly crossChannelMode: () => CrossChannelMode
  readonly budgets?: Partial<Readonly<Record<ContextBlockName, number>>>
  readonly workingMemory?: WorkingMemoryStore
  readonly decay?: MemoryDecay
  /** Optional recall filtering: a record needs this many shared bigrams, and this block keeps at most maxItems. */
  readonly recallGate?: {
    readonly maxItems: number
    readonly minMatched: (queryBigrams: number) => number
  }
}): ContextAssembler {
  const budgets = normalizeBudgets(deps.budgets)
  const decay = deps.decay ?? createMemoryDecay()

  return {
    async assemble(request: ContextRequest, viewer: Viewer): Promise<ContextBundle> {
      const snapshot = await deps.profiles.current()
      const facts = await deps.facts(viewer)
      const mode = deps.crossChannelMode()
      const now = deps.clock.now()
      // The viewer is the only trusted view: request.channel is ignored (RFC P1).
      const here = viewer.channel
      const participants = viewer.participants
      const limits = budgetsFor(budgets, request.budgetChars)

      const gather: Record<Exclude<ContextBlockName, 'working'>, () => Promise<MemoryRecord[]>> = {
        profile: () => listAll(deps.store, {
          layers: ['L3'], kinds: ['l3.person'], statuses: ['active'], subjects: participants,
        }),
        topics: async () => {
          const records = await listUnion(deps.store, [
            { layers: ['L1'], kinds: ['l1.topic'], statuses: ['active'], subjects: participants },
            { layers: ['L1'], kinds: ['l1.topic'], statuses: ['active'], channels: channelsFor(here) },
          ])
          return records.filter((record) => record.content.state !== 'closed')
        },
        facts: () => listUnion(deps.store, [
          { layers: ['L1'], kinds: FACT_KINDS, statuses: ['active'], subjects: participants },
          { layers: ['L1'], kinds: FACT_KINDS, statuses: ['active'], channels: channelsFor(here) },
        ]),
        lessons: () => listUnion(deps.store, [
          { layers: ['L2'], statuses: ['active'], subjects: participants },
          { layers: ['L2'], statuses: ['active'], channels: channelsFor(here) },
        ]),
        recall: async () => {
          const query = request.query
          if (query === undefined || query.trim() === '') return []
          const hits = await deps.index.search({ text: query, limit: RECALL_LIMIT })
          const records: MemoryRecord[] = []
          const taken = new Set<string>()
          for (const hit of hits) {
            if (taken.has(hit.id)) continue
            taken.add(hit.id)
            const record = await deps.store.get(hit.id)
            if (record === null || record.status !== 'active') continue
            if (record.layer !== 'L0' && record.layer !== 'L1' && record.layer !== 'L2') continue
            records.push(record)
          }
          const gate = deps.recallGate
          if (gate === undefined) return records
          const wanted = new Set(bigrams(query).split(' ').filter(Boolean))
          const kept = records.filter((record) => {
            const found = new Set(bigrams(renderText(record)).split(' ').filter(Boolean))
            let matched = 0
            for (const token of wanted) {
              if (found.has(token)) matched += 1
            }
            return matched >= gate.minMatched(wanted.size)
          })
          return kept.slice(0, gate.maxItems)
        },
        elsewhere: async () => {
          const records = await listAll(deps.store, {
            layers: ['L0', 'L1'],
            actors: ['self'],
            statuses: ['active'],
            from: now - ELSEWHERE_WINDOW_MS,
            to: now,
          })
          return records.filter((record) => record.channel !== here)
        },
        promises: async () => {
          const records = await listUnion(deps.store, [
            { layers: ['L1'], kinds: ['l1.promise'], statuses: ['active'], subjects: participants },
            { layers: ['L1'], kinds: ['l1.promise'], statuses: ['active'], channels: channelsFor(here) },
          ])
          return records.filter((record) => record.validTo === undefined || record.validTo > now)
        },
      }

      const seen = new Set<string>()
      const trimmed: { readonly name: ContextBlockName; readonly chosen: readonly TrimmedEntry[] }[] = []
      let truncated = false

      for (const name of BLOCK_ORDER) {
        if (name === 'working') {
          const active = deps.workingMemory === undefined || here === null
            ? []
            : await deps.workingMemory.listActive(here, now)
          const entries: TrimmedEntry[] = active.map((wm) => ({
            item: {
              id: wm.id,
              text: `${wm.key}: ${wm.text}`,
              disclosure: { speakable: 'yes', label: '当前会话短期状态' },
            },
            crossChannel: false,
          }))
          const result = trimByBudget(entries, limits.working)
          if (result.truncated) truncated = true
          trimmed.push({ name, chosen: result.kept })
          continue
        }

        const candidates: MemoryRecord[] = []
        for (const record of await gather[name]()) {
          if (seen.has(record.id)) continue
          seen.add(record.id)
          candidates.push(record)
        }

        const chosen: Chosen[] = []
        for (const record of candidates) {
          const decision = deps.policy.decide(record, viewer, facts)
          if (!decision.visible) continue
          const text = textFor(record, decision.injection)
          if (text === null) continue
          // L3 is the same view everywhere; only L0–L2 ever cross a channel.
          const crossChannel = record.layer !== 'L3' && record.channel !== here
          if (crossChannel && mode === 'off') continue
          const inferred = record.layer === 'L2'
            || (record.layer === 'L1' && (record.confidence < 0.8 || record.kind === 'l1.candidate'))
          chosen.push({
            record,
            item: {
              id: record.id,
              text,
              disclosure: withLegacyDisclosure(record, decision.disclosure),
              ...(inferred ? { inferred: true } : {}),
            },
            crossChannel,
          })
        }
        const blockDecay = name === 'facts' || name === 'lessons' ? decay : undefined
        chosen.sort((left, right) => compareChosen(left, right, blockDecay, now))

        const entries: TrimmedEntry[] = chosen.map((entry) => ({
          recordId: entry.record.id,
          item: entry.item,
          crossChannel: entry.crossChannel,
        }))
        const result = trimByBudget(entries, limits[name])
        if (result.truncated) truncated = true
        trimmed.push({ name, chosen: result.kept })
      }

      // Audit exactly what `on` would inject: in shadow the same entries are recorded and then withheld.
      for (const block of trimmed) {
        for (const entry of block.chosen) {
          if (!entry.crossChannel || entry.recordId === undefined) continue
          await deps.audit.crossChannelUse({
            recordId: entry.recordId, viewerChannel: here ?? '', mode, tAt: now,
          })
        }
      }

      const blocks: ContextBlock[] = trimmed.map((block) => ({
        name: block.name,
        items: block.chosen
          .filter((entry) => mode !== 'shadow' || !entry.crossChannel)
          .map((entry) => entry.item),
      }))

      return { profileVersion: snapshot.version, stable: snapshot.stable, blocks, truncated }
    },
  }
}
