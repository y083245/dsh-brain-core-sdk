import { Buffer } from 'node:buffer'
import {
  BrainError, LIMITS, validate,
  type ContextBundle, type ContextRequest, type Disclosure, type EvidenceRef, type ForgetReport,
  type IngestEvent, type Layer, type MemoryRecord, type RecordInput, type RecordPatch, type RecordStatus,
  type SearchHistoryItem, type SearchHit, type SearchNeighbor, type SearchRequest, type SearchScope,
  type Viewer, type Visibility,
} from '@brain-core/sdk'
import { scanInjection } from '@brain-core/shared'
import {
  type ChannelFacts, type Clock, type ContextAssembler, type CrossChannelMode, type ForgetService,
  type KeywordIndex, type MemoryAudit, type MemoryProviderRegistry, type MemoryService, type Policy, type PolicyDecision,
  type RecordFilter, type RecordStore, type WriteIdentity,
} from '../contracts/index.ts'
import type { IdentityService, IdentitySnapshot } from '../identity-persona/index.ts'
import type { Logger } from '../log/index.ts'
import { fuseRankings } from '../memory-provider/index.ts'
import { expandScope } from '../memory-search/index.ts'
import { applyWriteGuard } from '../memory-store/index.ts'
import type { ChannelFactsSource } from './channel-facts.ts'

/** The index looks at no more than this many hits before the policy filters them. */
const HIT_LIMIT = 1000
const LIST_PAGE_LIMIT = 1000
const LEGACY_DISCLOSURE_SUFFIX = '（旧系统历史存档，仅作事实参考，不作为当前说话语气）'

function withLegacyDisclosure(record: MemoryRecord, disclosure: Disclosure): Disclosure {
  if (record.layer !== 'L0' || record.content.legacy !== true) return disclosure
  if (disclosure.label.includes(LEGACY_DISCLOSURE_SUFFIX)) return disclosure
  return { ...disclosure, label: `${disclosure.label}${LEGACY_DISCLOSURE_SUFFIX}` }
}

function applyDecision(
  record: MemoryRecord,
  decision: PolicyDecision,
): { readonly record: MemoryRecord; readonly disclosure: Disclosure } | null {
  if (!decision.visible || decision.injection === 'none') return null
  let shown = record
  if (decision.injection === 'conclusion-only') {
    const conclusion = record.content.conclusion
    if (typeof conclusion !== 'string' || conclusion.length === 0) return null
    shown = { ...record, content: { conclusion } }
  }
  return { record: shown, disclosure: withLegacyDisclosure(record, decision.disclosure) }
}

async function listAll(store: RecordStore, filter: RecordFilter): Promise<MemoryRecord[]> {
  const records: MemoryRecord[] = []
  let cursor: string | undefined
  for (;;) {
    const page = cursor === undefined
      ? await store.list(filter, { limit: LIST_PAGE_LIMIT })
      : await store.list(filter, { limit: LIST_PAGE_LIMIT, cursor })
    records.push(...page.items)
    if (page.nextCursor === undefined) return records
    cursor = page.nextCursor
  }
}

function compareEventAscIdAsc(left: MemoryRecord, right: MemoryRecord): number {
  if (left.tEvent !== right.tEvent) return left.tEvent - right.tEvent
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

function compareEventDescIdAsc(left: MemoryRecord, right: MemoryRecord): number {
  if (left.tEvent !== right.tEvent) return right.tEvent - left.tEvent
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

async function fallbackNeighborsOf(
  store: RecordStore,
  id: string,
  window: number,
): Promise<{ readonly before: readonly MemoryRecord[]; readonly after: readonly MemoryRecord[] }> {
  if (window === 0) return { before: [], after: [] }
  const anchor = await store.get(id)
  if (anchor === null || anchor.layer !== 'L0' || anchor.status !== 'active') {
    return { before: [], after: [] }
  }
  const sameChannel = (await listAll(store, {
    layers: ['L0'],
    channels: [anchor.channel],
    statuses: ['active'],
  })).sort(compareEventAscIdAsc)
  const index = sameChannel.findIndex((record) => record.id === anchor.id)
  if (index === -1) return { before: [], after: [] }
  return {
    before: sameChannel.slice(Math.max(0, index - window), index),
    after: sameChannel.slice(index + 1, index + 1 + window),
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatValueText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/**
 * The eight actions of RFC 7.1, shared by ctx.memory, HTTP and the agent tools.
 * `markIndexHealthy` and `indexDegraded` are internal wiring for the rebuild job.
 */
export interface MemoryServiceImplementation extends MemoryService {
  searchWithoutAudit(
    request: SearchRequest,
    viewer: Viewer,
  ): Promise<{ readonly items: readonly SearchHit[]; readonly nextCursor?: string; readonly degraded: boolean }>
  flush(): Promise<void>
  markIndexHealthy(): void
  indexDegraded(): boolean
}

function invalidArgument(message: string): BrainError {
  return new BrainError('INVALID_ARGUMENT', message)
}

function notFound(): BrainError {
  return new BrainError('NOT_FOUND', 'record not found')
}

function permissionDenied(message: string): BrainError {
  return new BrainError('PERMISSION_DENIED', message)
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
}

/** FR-A05: `validate` does not check this one. */
function assertContentSize(content: Readonly<Record<string, unknown>>): void {
  const bytes = Buffer.byteLength(JSON.stringify(content) ?? '')
  if (bytes > LIMITS.contentBytes) {
    throw new BrainError('PAYLOAD_TOO_LARGE', 'record content is too large')
  }
}

/** Memory can reach later prompts, so injected instructions never get written. */
function assertNoInjection(content: Readonly<Record<string, unknown>>): void {
  const reason = scanInjection(JSON.stringify(content) ?? '')
  if (reason !== null) throw invalidArgument(`content looks like a prompt injection: ${reason}`)
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort()
}

/** Replaces every participant with every id it has been merged from; later checks see the same people as the store. */
function expandParticipants(viewer: Viewer, snapshot: IdentitySnapshot): Viewer {
  return {
    caller: viewer.caller,
    channel: viewer.channel,
    participants: uniqueSorted(viewer.participants.flatMap((person) => snapshot.idsOf(person))),
  }
}

function pickIngest(value: IngestEvent): IngestEvent {
  const raw = value as unknown as Record<string, unknown>
  return {
    kind: raw.kind as string,
    channel: raw.channel as string,
    subjects: raw.subjects as readonly string[],
    actor: raw.actor as string,
    content: raw.content as Readonly<Record<string, unknown>>,
    tEvent: raw.tEvent as number,
    idempotencyKey: raw.idempotencyKey as string,
    ...(raw.visibility === undefined ? {} : { visibility: raw.visibility as Visibility }),
  }
}

function pickRecordInput(value: RecordInput): RecordInput {
  const raw = value as unknown as Record<string, unknown>
  return {
    layer: raw.layer as 'L1' | 'L2',
    kind: raw.kind as string,
    channel: raw.channel as string,
    subjects: raw.subjects as readonly string[],
    actor: raw.actor as string,
    content: raw.content as Readonly<Record<string, unknown>>,
    evidence: (raw.evidence as readonly EvidenceRef[]).map((reference) => ({ id: reference.id })),
    ...(raw.visibility === undefined ? {} : { visibility: raw.visibility as Visibility }),
    ...(raw.confidence === undefined ? {} : { confidence: raw.confidence as number }),
    ...(raw.importance === undefined ? {} : { importance: raw.importance as number }),
    ...(raw.tEvent === undefined ? {} : { tEvent: raw.tEvent as number }),
    ...(raw.validFrom === undefined ? {} : { validFrom: raw.validFrom as number }),
    ...(raw.idempotencyKey === undefined ? {} : { idempotencyKey: raw.idempotencyKey as string }),
  }
}

function pickPatch(value: RecordPatch): RecordPatch {
  const raw = value as unknown as Record<string, unknown>
  return {
    ...(raw.content === undefined ? {} : { content: raw.content as Readonly<Record<string, unknown>> }),
    ...(raw.subjects === undefined ? {} : { subjects: raw.subjects as readonly string[] }),
    ...(raw.visibility === undefined ? {} : { visibility: raw.visibility as Visibility }),
    ...(raw.confidence === undefined ? {} : { confidence: raw.confidence as number }),
    ...(raw.importance === undefined ? {} : { importance: raw.importance as number }),
    ...(raw.status === undefined ? {} : { status: raw.status as RecordStatus }),
    ...(raw.validTo === undefined ? {} : { validTo: raw.validTo as number }),
  }
}

function pickSearchRequest(value: SearchRequest): SearchRequest {
  const raw = value as unknown as Record<string, unknown>
  if (raw.neighbors !== undefined) {
    if (typeof raw.neighbors !== 'number' || !Number.isInteger(raw.neighbors) || raw.neighbors < 0 || raw.neighbors > 10) {
      throw invalidArgument('neighbors must be an integer between 0 and 10')
    }
  }
  return {
    query: raw.query as string,
    scope: raw.scope as SearchScope,
    ...(raw.layers === undefined ? {} : { layers: [...(raw.layers as readonly Layer[])] }),
    ...(raw.from === undefined ? {} : { from: raw.from as number }),
    ...(raw.to === undefined ? {} : { to: raw.to as number }),
    ...(raw.subjects === undefined ? {} : { subjects: [...(raw.subjects as readonly string[])] }),
    ...(raw.limit === undefined ? {} : { limit: raw.limit as number }),
    ...(raw.cursor === undefined ? {} : { cursor: raw.cursor as string }),
    ...(raw.neighbors === undefined ? {} : { neighbors: raw.neighbors }),
    ...(raw.history === undefined ? {} : { history: raw.history as boolean }),
  }
}

function pickContextRequest(value: ContextRequest): ContextRequest {
  const raw = value as unknown as Record<string, unknown>
  return {
    channel: raw.channel as string,
    ...(raw.query === undefined ? {} : { query: raw.query as string }),
    ...(raw.budgetChars === undefined ? {} : { budgetChars: raw.budgetChars as number }),
  }
}

function decodeCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
    if (typeof parsed === 'object' && parsed !== null) {
      const offset = (parsed as { offset?: unknown }).offset
      if (typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0) return offset
    }
  } catch {
    // fall through to the same error as a well-formed but unusable cursor
  }
  throw invalidArgument('invalid cursor')
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url')
}

export function createMemoryService(deps: {
  readonly store: RecordStore
  readonly index: KeywordIndex
  readonly policy: Policy
  readonly assembler: ContextAssembler
  readonly forget: ForgetService
  readonly identity: IdentityService
  readonly facts: ChannelFactsSource
  readonly audit: MemoryAudit
  readonly crossChannelMode: () => CrossChannelMode
  readonly jobsHealth: () => 'ok' | 'degraded'
  readonly clock: Clock
  readonly log: Logger
  /** Optional memory-provider registry for search fusion and lifecycle notifications. */
  readonly providers?: MemoryProviderRegistry
  /** Called once after a record was written and indexed. */
  readonly onRecorded?: (record: MemoryRecord) => void | Promise<void>
}): MemoryServiceImplementation {
  let indexFailed = false
  let queue: Promise<void> = Promise.resolve()

  function notifyProviderRecorded(record: MemoryRecord): void {
    if (deps.providers === undefined) return
    void deps.providers.notifyRecorded(record).catch(() => {
      deps.log.warn('memory.provider_notify_recorded_failed', { recordId: record.id })
    })
  }

  function enqueueAdd(record: MemoryRecord): void {
    queue = queue.then(async () => {
      try {
        await deps.index.add(record)
      } catch (error) {
        indexFailed = true
        deps.log.error('memory.index_failed', { code: errorCode(error) })
      }
    })
  }

  async function expanded(viewer: Viewer): Promise<{ viewer: Viewer; snapshot: IdentitySnapshot }> {
    const snapshot = await deps.identity.snapshot()
    return { viewer: expandParticipants(viewer, snapshot), snapshot }
  }

  /** Missing and invisible must be indistinguishable (RFC S2), tombstones included. */
  async function visibleRecord(id: string, viewer: Viewer): Promise<MemoryRecord> {
    const record = await deps.store.get(id)
    if (record === null) throw notFound()
    const facts = await deps.facts.forViewer(viewer)
    if (!deps.policy.decide(record, viewer, facts).visible) throw notFound()
    return record
  }

  function assertWritableBy(record: MemoryRecord, identity: WriteIdentity): void {
    if (identity.kind === 'plugin' && record.source !== identity.source) {
      throw permissionDenied(`record ${record.id} belongs to ${record.source}`)
    }
  }

  async function runSearch(
    request: SearchRequest,
    viewer: Viewer,
    auditCrossChannel: boolean,
  ): Promise<{ readonly items: readonly SearchHit[]; readonly nextCursor?: string; readonly degraded: boolean }> {
    validate('SearchRequest', request)
    const value = pickSearchRequest(request)
    const limit = value.limit ?? 20
    const offset = value.cursor === undefined ? 0 : decodeCursor(value.cursor)

    const mode = deps.crossChannelMode()
    // The cross-channel switch also governs search (2026-11-07): an agent outside `on` only ever sees here.
    const scope: SearchScope = viewer.caller === 'owner-console' || mode === 'on' ? value.scope : 'here'

    const { viewer: expandedViewer, snapshot } = await expanded(viewer)
    const scopeFilter = expandScope(scope, expandedViewer)
    let subjects = scopeFilter.subjects
    if (value.subjects !== undefined) {
      const wanted = uniqueSorted(value.subjects.flatMap((person) => snapshot.idsOf(person)))
      subjects = subjects === undefined
        ? wanted
        : subjects.filter((person) => wanted.includes(person))
    }

    let keywordHits: readonly { readonly id: string; readonly score: number }[] = []
    let keywordDegraded = indexFailed
    try {
      keywordHits = await deps.index.search({
        text: value.query,
        layers: value.layers,
        from: value.from,
        to: value.to,
        channels: scopeFilter.channels,
        subjects,
        limit: HIT_LIMIT,
      })
    } catch (error) {
      keywordDegraded = true
      indexFailed = true
      deps.log.error('memory.index_search_failed', { code: errorCode(error) })
    }

    let providerDegraded = false
    let hits = keywordHits
    if (deps.providers !== undefined && deps.providers.hasProviders()) {
      try {
        const providerResult = await deps.providers.search({
          query: value.query,
          ...(value.layers === undefined ? {} : { layers: value.layers }),
          ...(scopeFilter.channels === undefined ? {} : { channels: scopeFilter.channels }),
          ...(subjects === undefined ? {} : { subjects }),
          ...(value.from === undefined ? {} : { from: value.from }),
          ...(value.to === undefined ? {} : { to: value.to }),
          limit: HIT_LIMIT,
        })
        providerDegraded = providerResult.degraded
        if (providerResult.hits.length > 0) {
          hits = fuseRankings([keywordHits, providerResult.hits])
        }
      } catch (error) {
        if (error instanceof BrainError && error.code === 'EMBEDDING_MISMATCH') {
          throw error
        }
        providerDegraded = true
        deps.log.warn('memory.provider_search_failed', { code: errorCode(error) })
      }
    }

    async function loadNeighbors(
      anchor: MemoryRecord,
      window: number,
      viewerForPolicy: Viewer,
      channelFacts: ChannelFacts,
    ): Promise<readonly SearchNeighbor[]> {
      const rawNeighbors = deps.store.neighborsOf !== undefined
        ? await deps.store.neighborsOf(anchor.id, window)
        : await fallbackNeighborsOf(deps.store, anchor.id, window)
      const result: SearchNeighbor[] = []
      const appendSide = (records: readonly MemoryRecord[], position: 'before' | 'after'): void => {
        for (const neighbor of records) {
          if (neighbor.status !== 'active') continue
          const decision = deps.policy.decide(neighbor, viewerForPolicy, channelFacts)
          const applied = applyDecision(neighbor, decision)
          if (applied === null) continue
          result.push({
            record: applied.record,
            disclosure: applied.disclosure,
            position,
          })
        }
      }
      appendSide(rawNeighbors.before, 'before')
      appendSide(rawNeighbors.after, 'after')
      return result
    }

    async function loadHistory(
      hitRecord: MemoryRecord,
      viewerForPolicy: Viewer,
      channelFacts: ChannelFacts,
      identitySnapshot: IdentitySnapshot,
      allowedChannels: readonly string[] | undefined,
    ): Promise<readonly SearchHistoryItem[]> {
      if (hitRecord.layer === 'L1' && typeof hitRecord.content.key === 'string' && hitRecord.content.key.trim() !== '') {
        const hitKey = hitRecord.content.key
        const expandedSubjects = uniqueSorted(hitRecord.subjects.flatMap((person) => identitySnapshot.idsOf(person)))
        const candidates = await listAll(deps.store, {
          layers: ['L1'],
          kinds: [hitRecord.kind],
          statuses: ['outdated', 'archived'],
          subjects: expandedSubjects,
          ...(allowedChannels === undefined ? {} : { channels: allowedChannels }),
        })
        const matching = candidates
          .filter((rec) =>
            rec.id !== hitRecord.id
            && (rec.status === 'outdated' || rec.status === 'archived')
            && rec.content.key === hitKey)
          .sort(compareEventDescIdAsc)

        const items: SearchHistoryItem[] = []
        for (const rec of matching) {
          const decision = deps.policy.decide(rec, viewerForPolicy, channelFacts)
          if (!decision.visible || decision.injection === 'none') continue
          if (decision.injection === 'conclusion-only') {
            const conclusion = rec.content.conclusion
            if (typeof conclusion !== 'string' || conclusion.length === 0) continue
            items.push({
              id: rec.id,
              key: hitKey,
              value: conclusion,
              text: conclusion,
              changedAt: rec.validTo ?? rec.tEvent,
              status: rec.status as 'outdated' | 'archived',
              label: '已变更',
            })
            continue
          }
          const rawValue = rec.content.value !== undefined ? rec.content.value : (rec.content.text ?? '')
          const text = typeof rec.content.text === 'string' ? rec.content.text : formatValueText(rawValue)
          items.push({
            id: rec.id,
            key: hitKey,
            value: rawValue,
            text,
            changedAt: rec.validTo ?? rec.tEvent,
            status: rec.status as 'outdated' | 'archived',
            label: '已变更',
          })
        }
        return items
      }

      if (hitRecord.layer === 'L3' && hitRecord.kind === 'l3.person' && Array.isArray(hitRecord.content.history)) {
        const items: SearchHistoryItem[] = []
        for (const entry of hitRecord.content.history) {
          if (!isPlainRecord(entry)) continue
          if (typeof entry.section !== 'string' || entry.section.trim() === '') continue
          if (typeof entry.key !== 'string' || entry.key.trim() === '') continue
          if (!Object.prototype.hasOwnProperty.call(entry, 'value') || entry.value === undefined) continue
          const changedAt = typeof entry.supersededAt === 'number' && Number.isFinite(entry.supersededAt)
            ? entry.supersededAt
            : typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt)
              ? entry.updatedAt
              : hitRecord.tEvent
          items.push({
            key: `${entry.section}.${entry.key}`,
            value: entry.value,
            text: formatValueText(entry.value),
            changedAt,
            status: 'outdated',
            label: '已变更',
          })
        }
        items.sort((left, right) => right.changedAt - left.changedAt || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
        return items
      }

      return []
    }

    const facts = await deps.facts.forViewer(expandedViewer)
    const kept: { readonly record: MemoryRecord; readonly disclosure: Disclosure; readonly score: number }[] = []
    for (const hit of hits) {
      const record = await deps.store.get(hit.id)
      if (record === null || record.status !== 'active') continue
      if (value.layers !== undefined && !value.layers.includes(record.layer)) continue
      if (scopeFilter.channels !== undefined && !scopeFilter.channels.includes(record.channel)) continue
      if (subjects !== undefined && !record.subjects.some((person) => subjects.includes(person))) continue
      if (value.from !== undefined && record.tEvent < value.from) continue
      if (value.to !== undefined && record.tEvent > value.to) continue
      const decision = deps.policy.decide(record, expandedViewer, facts)
      const applied = applyDecision(record, decision)
      if (applied === null) continue
      kept.push({ record: applied.record, disclosure: applied.disclosure, score: hit.score })
    }

    const page = kept.slice(offset, offset + limit)
    const nextCursor = kept.length > offset + limit ? encodeCursor(offset + limit) : undefined
    const neighborWindow = value.neighbors ?? 0
    const includeHistory = value.history === true

    const items: SearchHit[] = []
    for (const hit of page) {
      const neighbors = neighborWindow > 0 && hit.record.layer === 'L0'
        ? await loadNeighbors(hit.record, neighborWindow, expandedViewer, facts)
        : undefined
      const history = includeHistory
        ? await loadHistory(hit.record, expandedViewer, facts, snapshot, scopeFilter.channels)
        : undefined
      items.push({
        record: hit.record,
        disclosure: hit.disclosure,
        score: hit.score,
        ...(neighbors !== undefined && (neighbors.length > 0 || (neighborWindow > 0 && hit.record.layer === 'L0'))
          ? { neighbors }
          : {}),
        ...(history !== undefined && history.length > 0 ? { history } : {}),
      })
    }

    if (auditCrossChannel && mode === 'on' && viewer.caller !== 'owner-console') {
      const now = deps.clock.now()
      for (const item of items) {
        if (item.record.channel !== viewer.channel) {
          await deps.audit.crossChannelUse({
            recordId: item.record.id,
            viewerChannel: viewer.channel ?? '',
            mode,
            tAt: now,
          })
        }
        if (item.neighbors !== undefined) {
          for (const neighbor of item.neighbors) {
            if (neighbor.record.channel === viewer.channel) continue
            await deps.audit.crossChannelUse({
              recordId: neighbor.record.id,
              viewerChannel: viewer.channel ?? '',
              mode,
              tAt: now,
            })
          }
        }
      }
    }

    return {
      items,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      degraded: providerDegraded || keywordDegraded,
    }
  }

  return {
    async ingest(event, identity): Promise<{ readonly id: string }> {
      validate('IngestEvent', event)
      const input = pickIngest(event)
      assertContentSize(input.content)
      const record = applyWriteGuard(input, identity, deps.clock.now())
      const stored = await deps.store.insert(record, input.idempotencyKey)
      deps.facts.note(stored.channel, stored.actor)
      // The index is derived (RFC M6); the caller must not wait for it (NFR-01).
      enqueueAdd(stored)
      notifyProviderRecorded(stored)
      return { id: stored.id }
    },

    async record(input, identity): Promise<MemoryRecord> {
      validate('RecordInput', input)
      const value = pickRecordInput(input)
      assertContentSize(value.content)
      assertNoInjection(value.content)
      const record = applyWriteGuard(value, identity, deps.clock.now())
      const stored = await deps.store.insert(record, value.idempotencyKey)
      await deps.index.add(stored)
      try {
        await deps.onRecorded?.(stored)
      } catch {
        // The record is already stored and indexed; a failing listener must not look like a failed write.
        deps.log.warn('memory.on_recorded_failed', { recordId: stored.id })
      }
      notifyProviderRecorded(stored)
      return stored
    },

    async update(id, patch, expectedVersion, identity, viewer): Promise<MemoryRecord> {
      const { viewer: expandedViewer } = await expanded(viewer)
      const record = await visibleRecord(id, expandedViewer)
      assertWritableBy(record, identity)
      validate('RecordPatch', patch)
      const value = pickPatch(patch)
      if (value.content !== undefined) assertContentSize(value.content)
      if (value.content !== undefined) assertNoInjection(value.content)
      const updated = await deps.store.patch(id, value, expectedVersion)
      await deps.index.add(updated)
      return updated
    },

    async remove(id, identity, viewer): Promise<void> {
      const { viewer: expandedViewer } = await expanded(viewer)
      const record = await visibleRecord(id, expandedViewer)
      assertWritableBy(record, identity)
      if (record.layer === 'L3') throw permissionDenied('L3 records are versioned and cannot be removed')
      await deps.forget.forget({ by: 'record', id })
    },

    async search(request, viewer) {
      return runSearch(request, viewer, true)
    },

    async searchWithoutAudit(request, viewer) {
      return runSearch(request, viewer, false)
    },

    async context(request, viewer): Promise<ContextBundle> {
      validate('ContextRequest', request)
      const { viewer: expandedViewer } = await expanded(viewer)
      return deps.assembler.assemble(pickContextRequest(request), expandedViewer)
    },

    async forget(selector): Promise<ForgetReport> {
      validate('ForgetSelector', selector)
      const raw = selector as unknown as Record<string, unknown>
      if (raw.by !== 'person') {
        if (raw.by === 'record') return deps.forget.forget({ by: 'record', id: raw.id as string })
        if (raw.by === 'channel') return deps.forget.forget({ by: 'channel', channel: raw.channel as string })
        return deps.forget.forget({
          by: 'time',
          from: raw.from as number,
          to: raw.to as number,
          ...(raw.channel === undefined ? {} : { channel: raw.channel as string }),
        })
      }
      // Records keep the person id they were written with, so every alias is forgotten separately.
      const snapshot = await deps.identity.snapshot()
      const total = { tombstoned: 0, invalidated: 0, l3Flagged: 0 }
      for (const personId of snapshot.idsOf(raw.personId as string)) {
        const report = await deps.forget.forget({ by: 'person', personId })
        total.tombstoned += report.tombstoned
        total.invalidated += report.invalidated
        total.l3Flagged += report.l3Flagged
      }
      return total
    },

    async health(): Promise<Readonly<Record<string, 'ok' | 'degraded' | 'down'>>> {
      let store: 'ok' | 'down'
      try {
        await deps.store.list({}, { limit: 1 })
        store = 'ok'
      } catch {
        store = 'down'
      }
      let index: 'ok' | 'degraded' | 'down'
      try {
        // A query that is not blank exercises the whole FTS path.
        await deps.index.search({ text: 'health', limit: 1 })
        index = indexFailed ? 'degraded' : 'ok'
      } catch {
        index = 'down'
      }
      let provider: 'ok' | 'degraded' | 'down' | undefined
      if (deps.providers !== undefined) {
        try {
          provider = await deps.providers.health()
        } catch {
          provider = 'degraded'
        }
      }
      return {
        store,
        index,
        jobs: deps.jobsHealth(),
        ...(provider === undefined ? {} : { provider }),
      }
    },

    flush: () => queue,

    markIndexHealthy(): void {
      indexFailed = false
    },

    indexDegraded(): boolean {
      return indexFailed
    },
  }
}
