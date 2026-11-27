import type {
  ContextBundle, ContextRequest, Disclosure, EvidenceRef, ForgetReport, ForgetSelector, IngestEvent, Layer, MemoryRecord,
  RecordInput, RecordPatch, RecordStatus, SearchHit, SearchRequest, Trust, Viewer, Visibility,
} from '@dsh-brain-core/sdk'

export interface Clock { now(): number }

/** The only L1–L3 kinds (RFC 6.1). Plugins may register their own L0 event kinds, never new L1–L3 kinds. */
export const KINDS = {
  L1: ['l1.fact', 'l1.event', 'l1.promise', 'l1.topic', 'l1.relation', 'l1.self', 'l1.knowledge', 'l1.candidate'],
  L2: ['l2.scene', 'l2.person_tip', 'l2.expression', 'l2.interest', 'l2.reflection', 'l2.autobiography'],
  L3: ['l3.self', 'l3.person', 'l3.group', 'l3.graph', 'l3.mood'],
} as const

/** Who is writing. Built by the kernel from the plugin's manifest; never taken from the request (RFC M5). */
export interface WriteIdentity {
  readonly kind: 'kernel' | 'plugin'
  readonly source: string
  readonly trust: Trust
  readonly defaultVisibility: Visibility
  /** Plugin writes must stay inside what the manifest registered; undefined means the kernel. */
  readonly channels?: readonly string[]
  readonly eventKinds?: readonly string[]
}

export * from './runtime.ts'

export type NewRecord = Omit<MemoryRecord, 'id' | 'tIngest' | 'status' | 'version'>

/**
 * A record matches when it matches every field given. An array field matches any of its values (for
 * subjects: shares at least one); a missing field does not filter; an empty array matches nothing.
 * from and to bound tEvent, both inclusive.
 */
export interface RecordFilter {
  readonly layers?: readonly Layer[]
  readonly channels?: readonly string[]
  readonly subjects?: readonly string[]
  readonly actors?: readonly string[]
  readonly kinds?: readonly string[]
  readonly statuses?: readonly RecordStatus[]
  readonly from?: number
  readonly to?: number
}

export interface Page<T> { readonly items: readonly T[]; readonly nextCursor?: string }

/** Errors are BrainError from @dsh-brain-core/sdk. */
export interface RecordStore {
  /**
   * Fills id, tIngest, status 'active' and version 1. L0 takes no evidence; L1–L3 need at least one, each an
   * existing, untombstoned record of a lower layer; otherwise INVALID_ARGUMENT. The same idempotencyKey from
   * the same source returns the first record and writes nothing.
   */
  insert(record: NewRecord, idempotencyKey?: string): Promise<MemoryRecord>
  /** Tombstoned records are still returned, with content {}. */
  get(id: string): Promise<MemoryRecord | null>
  /**
   * NOT_FOUND when missing or tombstoned, PERMISSION_DENIED on L0, CONFLICT on a stale version,
   * INVALID_ARGUMENT when the patch sets status 'tombstoned'. Adds 1 to version.
   */
  patch(id: string, patch: RecordPatch, expectedVersion: number): Promise<MemoryRecord>
  /**
   * Overwrites content with an equal-length filler, sets status to tombstoned and adds 1 to version.
   * NOT_FOUND when missing; an already tombstoned record is returned unchanged.
   */
  tombstone(id: string): Promise<MemoryRecord>
  /** Sorted by id; the cursor is opaque. */
  list(filter: RecordFilter, page: { readonly limit: number; readonly cursor?: string }): Promise<Page<MemoryRecord>>
  /** Records whose evidence points at this id, in any status, sorted by id. */
  dependentsOf(id: string): Promise<readonly MemoryRecord[]>
  /** Every record of these layers (all layers when omitted), in any status, sorted by id. */
  scan(layers?: readonly Layer[]): AsyncIterable<MemoryRecord>
  /** Active L0 neighbors immediately before and after `id` in the same channel, ordered by (tEvent ASC, id ASC). */
  neighborsOf?(id: string, window: number): Promise<{
    readonly before: readonly MemoryRecord[]
    readonly after: readonly MemoryRecord[]
  }>
  close(): Promise<void>
}

/** Filters work as in RecordFilter. text is what the user typed; the index escapes it. */
export interface IndexQuery {
  readonly text: string
  readonly layers?: readonly Layer[]
  readonly channels?: readonly string[]
  readonly subjects?: readonly string[]
  readonly from?: number
  readonly to?: number
  readonly limit: number
}

export interface IndexHit { readonly id: string; readonly score: number }

/** A derived index: it can always be rebuilt from the store (RFC M6). */
export interface KeywordIndex {
  /** Replaces any entry for this id; a record that is not active is only removed. */
  add(record: MemoryRecord): Promise<void>
  remove(id: string): Promise<void>
  /** Best first: score descending, then id ascending. Blank text finds nothing. */
  search(query: IndexQuery): Promise<readonly IndexHit[]>
  /** Drops every entry, then adds these records; returns how many active records were indexed. */
  rebuild(records: AsyncIterable<MemoryRecord>): Promise<number>
  close(): Promise<void>
}

/** Plain data gathered beforehand, which keeps the policy a pure function. */
export interface ChannelFacts {
  readonly ownerChannels: ReadonlySet<string>
  /** Members of each channel; falls back to who has spoken there (RFC P4). */
  readonly members: ReadonlyMap<string, ReadonlySet<string>>
  readonly kindOf: (channel: string) => 'private' | 'group' | 'other'
}

export interface PolicyDecision {
  readonly visible: boolean
  readonly injection: 'verbatim' | 'conclusion-only' | 'none'
  readonly disclosure: Disclosure
}

/** A pure function: the same arguments give the same decision, and nothing is changed. */
export interface Policy {
  decide(record: MemoryRecord, viewer: Viewer, facts: ChannelFacts): PolicyDecision
}

export type CrossChannelMode = 'off' | 'shadow' | 'on'

export interface ProfileSnapshot { readonly version: number; readonly stable: string }
/** Version 0 with an empty stable until the first commit. */
export interface ProfileReader { current(): Promise<ProfileSnapshot> }

export interface MemoryAudit {
  /** One row per cross-channel use, or per would-be use in shadow mode (RFC S6). */
  crossChannelUse(entry: { readonly recordId: string; readonly viewerChannel: string; readonly mode: CrossChannelMode; readonly tAt: number }): Promise<void>
}

export interface ContextAssembler {
  assemble(request: ContextRequest, viewer: Viewer): Promise<ContextBundle>
}

export interface ForgetService {
  forget(selector: ForgetSelector): Promise<ForgetReport>
}

/** Implemented by adapters later; S2 only ever uses FakeLlm. The caller supplies the model through the owner's selection. */
export interface LlmClient {
  complete(request: { readonly system: string; readonly user: string; readonly maxOutputTokens: number }): Promise<{ readonly text: string; readonly tokens: number }>
}

/** The eight actions of RFC 7.1 behind one facade: ctx.memory, HTTP and agent tools all bind to this. */
export interface MemoryService {
  ingest(event: IngestEvent, identity: WriteIdentity): Promise<{ readonly id: string }>
  record(input: RecordInput, identity: WriteIdentity): Promise<MemoryRecord>
  update(id: string, patch: RecordPatch, expectedVersion: number, identity: WriteIdentity, viewer: Viewer): Promise<MemoryRecord>
  remove(id: string, identity: WriteIdentity, viewer: Viewer): Promise<void>
  search(request: SearchRequest, viewer: Viewer): Promise<{ readonly items: readonly SearchHit[]; readonly nextCursor?: string; readonly degraded: boolean }>
  context(request: ContextRequest, viewer: Viewer): Promise<ContextBundle>
  forget(selector: ForgetSelector): Promise<ForgetReport>
  health(): Promise<Readonly<Record<string, 'ok' | 'degraded' | 'down'>>>
}

// ---------------------------------------------------------------------------
// v1.x memory-consolidation contracts (FR-M11..M14, FR-M17..M18, FR-C06)
// ---------------------------------------------------------------------------

export interface DecayState {
  readonly stabilityDays: number
  readonly difficulty: number
  readonly lastReviewedAt: number
  readonly reps: number
}

export interface MemoryDecay {
  /** Retrievability R in (0, 1]. L0/L3 return 1; l1.event never drops below 0.35 (RFC M8, M10). */
  retrievabilityOf(record: MemoryRecord, now: number): number
  /** Automatic recall priority = importance * retrievabilityOf(record, now). Never mutates record.status. */
  priorityOf(record: MemoryRecord, now: number): number
  /** FSRS review reinforcement (grade 1..4, default 3). Returns the updated decay metadata. */
  reinforce(record: MemoryRecord, now: number, grade?: 1 | 2 | 3 | 4): DecayState
}

export interface WorkingMemoryItem {
  readonly id: string
  readonly channel: string
  readonly key: string
  readonly text: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly expiresAt: number
  readonly promoteToL1?: boolean
  readonly evidence?: readonly EvidenceRef[]
}

export interface WorkingMemoryInput {
  readonly channel: string
  readonly key: string
  readonly text: string
  /** Must be in (0, 86_400_000] (<= 24h, RFC M7). Defaults to 86_400_000. */
  readonly ttlMs?: number
  readonly promoteToL1?: boolean
  readonly evidence?: readonly EvidenceRef[]
}

export interface WorkingMemoryStore {
  put(input: WorkingMemoryInput): Promise<WorkingMemoryItem>
  /** Only items for this channel with expiresAt > now, sorted by updatedAt desc then id asc. */
  listActive(channel: string, now?: number): Promise<readonly WorkingMemoryItem[]>
  remove(id: string): Promise<boolean>
  /** Drops expired items (expiresAt <= now); optionally promotes flagged items to L1 first. */
  sweep(now?: number, promote?: (item: WorkingMemoryItem) => Promise<void>): Promise<{
    readonly dropped: number
    readonly promoted: number
  }>
}

export type TopicState = 'open' | 'suspended' | 'closed'

export interface ShadowL2Candidate {
  readonly id: string
  readonly kind: (typeof KINDS.L2)[number]
  readonly channel: string
  readonly subjects: readonly string[]
  readonly content: Readonly<Record<string, unknown>>
  readonly evidence: readonly EvidenceRef[]
  readonly confidence: number
  readonly importance: number
  readonly visibility: Visibility
}

export interface ShadowCorrection {
  readonly id: string
  readonly action: 'promote-candidate' | 'supersede-fact' | 'close-topic'
  readonly targetId: string
  readonly reason: string
  readonly replacementContent?: Readonly<Record<string, unknown>>
  readonly evidence: readonly EvidenceRef[]
}

export interface SelfConflictCandidate {
  readonly id: string
  readonly recordAId: string
  readonly recordBId: string
  readonly statementA: string
  readonly statementB: string
  readonly reason: string
  readonly recommendedKeepId?: string
}

export interface ShadowL3SelfPatch {
  readonly baseVersion: number
  readonly stable: string
  readonly data: Readonly<Record<string, unknown>>
  readonly evidence: readonly EvidenceRef[]
  readonly preservedOwnerKeys: readonly string[]
  readonly added: readonly string[]
  readonly removed: readonly string[]
  readonly changed: readonly string[]
  readonly stableChanged: boolean
}

export interface ShadowL3PersonPatch {
  readonly personId: string
  readonly existingRecordId?: string
  readonly data: Readonly<Record<string, unknown>>
  readonly evidence: readonly EvidenceRef[]
  readonly preservedOwnerKeys: readonly string[]
}

export interface ConsolidationProposal {
  readonly id: string
  readonly status: 'pending' | 'approved' | 'rejected'
  readonly createdAt: number
  readonly resolvedAt?: number
  readonly window: { readonly from: number; readonly to: number }
  readonly tokensUsed: number
  readonly l2Candidates: readonly ShadowL2Candidate[]
  readonly corrections: readonly ShadowCorrection[]
  readonly selfConflicts: readonly SelfConflictCandidate[]
  readonly l3SelfPatch: ShadowL3SelfPatch | null
  readonly l3PersonPatches: readonly ShadowL3PersonPatch[]
  readonly skippedL3Reason?: 'only-external-evidence' | 'insufficient-new-evidence'
}

export interface ConsolidationApproveOptions {
  /** Optional conflict resolutions: map from conflict.id to the recordId to keep active (the other is marked outdated). */
  readonly conflictKeepIds?: Readonly<Record<string, string>>
}

export interface ConsolidationApplyReport {
  readonly proposalId: string
  readonly l2Created: number
  readonly correctionsApplied: number
  readonly conflictsResolved: number
  readonly newProfileVersion?: number
  readonly personsUpdated: number
}

export interface ConsolidationEngine {
  /** Runs L1->L2 induction, L1.6 self-conflict check, and L3 settlement in shadow mode. */
  runShadow(options?: { readonly from?: number; readonly to?: number; readonly force?: boolean }): Promise<ConsolidationProposal>
  listProposals(status?: ConsolidationProposal['status']): Promise<readonly ConsolidationProposal[]>
  getProposal(id: string): Promise<ConsolidationProposal | null>
  approveProposal(id: string, options?: ConsolidationApproveOptions): Promise<ConsolidationApplyReport>
  rejectProposal(id: string): Promise<ConsolidationProposal>
  budgetStatus(): Promise<{ readonly usedTokensToday: number; readonly dailyTokenCap: number; readonly lastConsolidatedTo: number }>
}

// ---------------------------------------------------------------------------
// v1.x phase 2 contracts (FR-M19, FR-X02, FR-P10, FR-G06, FR-D07, FR-A06/07, FR-S11)
// ---------------------------------------------------------------------------

export interface TokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

export interface ModelPriceEntry {
  readonly inputPerMillion: number
  readonly outputPerMillion: number
  readonly cacheReadPerMillion: number
  readonly cacheWritePerMillion: number
}

export interface ModelPriceBook {
  readonly version: 1
  readonly currency: string
  readonly models: Readonly<Record<string, ModelPriceEntry>>
}

export interface AccountingEntryInput {
  readonly tAt: number
  readonly day: string
  readonly owner: string
  readonly pluginId?: string
  readonly agentClass: 'chat' | 'activity' | 'kernel'
  readonly provider: string
  readonly model: string
  readonly usage: TokenUsage
  readonly channel?: string
  readonly wakeId?: string
}

export interface AccountingEntry extends AccountingEntryInput {
  readonly id: string
  readonly costMicros: number
  readonly currency: string
  readonly priced: boolean
}

export interface PluginCostBreakdown {
  readonly owner: string
  readonly pluginId?: string
  readonly calls: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly totalTokens: number
  readonly costMicros: number
  readonly currency: string
  readonly unpricedCalls: number
}

export interface DailyCostPoint {
  readonly day: string
  readonly calls: number
  readonly totalTokens: number
  readonly costMicros: number
  readonly currency: string
}

export interface AccountingSummary {
  readonly day: string
  readonly currency: string
  readonly todayTokens: number
  readonly todayCostMicros: number
  readonly todayCacheHitRatio: number
  readonly dailyTokenLimit?: number
  readonly dailyCostMicrosLimit?: number
  readonly sharedQuotaWarning: boolean
  readonly byPlugin: readonly PluginCostBreakdown[]
  readonly dailyTrend: readonly DailyCostPoint[]
}

export interface ModelAccountingStore {
  record(entry: AccountingEntryInput): Promise<AccountingEntry>
  todayUsage(day: string, pluginId?: string): Promise<{ readonly tokens: number; readonly costMicros: number; readonly calls: number }>
  summary(options: { readonly day: string; readonly days?: number; readonly sharedQuotaWarning?: boolean; readonly dailyTokenLimit?: number; readonly dailyCostMicrosLimit?: number }): Promise<AccountingSummary>
  prices(): Promise<ModelPriceBook>
  setPrices(next: ModelPriceBook): Promise<ModelPriceBook>
  close(): Promise<void>
}

export interface PluginLlmExecutor {
  complete(pluginId: string, request: {
    readonly system: string
    readonly user: string
    readonly maxOutputTokens: number
  }): Promise<{ readonly text: string; readonly tokens: number }>
}

export interface MemoryProviderSearchResult {
  readonly hits: readonly { readonly id: string; readonly score: number }[]
  readonly degraded: boolean
  readonly active: boolean
}

export interface MemoryProviderRegistry {
  register(pluginId: string, provider: import('@dsh-brain-core/sdk').MemoryProvider): () => void
  hasProviders(): boolean
  listIds(): readonly string[]
  search(query: import('@dsh-brain-core/sdk').MemoryProviderQuery): Promise<MemoryProviderSearchResult>
  notifyRecorded(record: MemoryRecord): Promise<void>
  notifyForgotten(ids: readonly string[]): Promise<void>
  health(): Promise<'ok' | 'degraded' | 'down' | undefined>
}

export type LegacyImportMode = 'all' | 'memory' | 'fresh'

export interface LegacyImportOptions {
  readonly fromDir: string
  readonly mode: LegacyImportMode
  readonly role?: string
  readonly dryRun?: boolean
}

export interface LegacyImportReport {
  readonly mode: LegacyImportMode
  readonly dryRun: boolean
  readonly l0Imported: number
  readonly l0Skipped: number
  readonly l1Imported: number
  readonly l1Skipped: number
  readonly l3SelfCommitted: boolean
  readonly l3PersonsImported: number
  readonly anchorRecordsCreated: number
}

export interface ReadOnlyMcpStatus {
  readonly enabled: boolean
  readonly running: boolean
  readonly url?: string
  readonly port?: number
  readonly patchYaml?: string
}

export interface DebugViewStatus {
  readonly running: boolean
  readonly pid?: number
  readonly url?: string
  readonly port?: number
}
