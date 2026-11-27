export const ERROR_CODES = {
  INVALID_ARGUMENT: 400,
  UNAUTHENTICATED: 401,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  EMBEDDING_MISMATCH: 503,
  UNAVAILABLE: 503,
  INTERNAL: 500,
} as const

export type ErrorCode = keyof typeof ERROR_CODES

export interface Meta {
  readonly requestId: string
  readonly apiVersion?: string
  readonly degraded?: boolean
  readonly nextCursor?: string
}

export type Envelope<T> =
  | { readonly ok: true; readonly data: T; readonly meta: Meta }
  | {
      readonly ok: false
      readonly error: {
        readonly code: ErrorCode
        readonly message: string
        readonly details: Readonly<Record<string, unknown>>
      }
      readonly meta: Meta
    }

export type ApiResult<T> =
  | { readonly ok: true; readonly status: number; readonly data: T; readonly meta: Meta }
  | {
      readonly ok: false
      readonly status: number
      readonly code: ErrorCode
      readonly message: string
      readonly details: Readonly<Record<string, unknown>>
      readonly requestId?: string
    }

export class ApiError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly details: Readonly<Record<string, unknown>>
  readonly requestId?: string

  constructor(
    code: ErrorCode,
    status: number,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    requestId?: string,
  ) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.details = details
    if (requestId !== undefined) {
      this.requestId = requestId
    }
  }
}

export type ConsoleThemeMode = 'dark' | 'light' | 'auto'
export type ResolvedTheme = 'dark' | 'light'
export type OrbState = 'idle' | 'thinking' | 'igniting' | 'alert' | 'success'

export interface ConsolePageItem {
  readonly pluginId: string
  readonly id: string
  readonly title: string
  readonly entry: string
}

// ---- Settings & Agent Model Selection ----

export const THINKING_EFFORTS = ['off', 'low', 'high', 'max', 'model-default'] as const
export type ThinkingEffort = (typeof THINKING_EFFORTS)[number]
export type AgentClass = 'chat' | 'activity'

export interface ModelSelection {
  readonly provider: string
  readonly model: string
  readonly effort: ThinkingEffort
}

export interface ModelCatalogEntry {
  readonly provider: string
  readonly model: string
  readonly supportsImages: boolean
  readonly toolUpdate: 'addition-only' | 'fixed'
  readonly efforts: readonly ThinkingEffort[]
}

export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    supportsImages: true,
    toolUpdate: 'addition-only',
    efforts: ['off', 'low', 'high', 'max', 'model-default'],
  },
  {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    supportsImages: true,
    toolUpdate: 'fixed',
    efforts: ['off', 'low', 'high', 'max', 'model-default'],
  },
]

export const SHARED_QUOTA_SECRET = 'brain-deepseek-api-key'

export const AGENT_LABELS: Readonly<Record<AgentClass, string>> = {
  chat: '聊天类',
  activity: '活动类',
}

export const EFFORT_LABELS: Readonly<Record<ThinkingEffort, string>> = {
  off: '关闭',
  low: '低',
  high: '高',
  max: '最大',
  'model-default': '跟随模型默认（适配器当前默认实际发送 high）',
}

export const TOOL_UPDATE_WARNING =
  '该模型不支持增量工具更新（fixed），工具面在会话开始时一次定好，tools__load 需换会话才生效，会影响缓存与首条时延'

export interface RoleTraitInterview {
  readonly trait: string
  readonly manifestation: string
}

export interface RoleCardInterviewInput {
  readonly name: string
  readonly summary: string
  readonly tone: string
  readonly traits: readonly RoleTraitInterview[]
}

export type RoleCardOrigin = 'factory' | 'user' | 'modified'

export interface RoleCardPreview {
  readonly name: string
  readonly text: string
  readonly origin: RoleCardOrigin
}

export interface ConsoleSettingsView {
  readonly agents: {
    readonly chat?: Partial<ModelSelection>
    readonly activity?: Partial<ModelSelection>
  }
  readonly secretNames: readonly string[]
  readonly sharedQuotaWarning: boolean
  readonly roleCard: { readonly name: string; readonly text: string } | null
  readonly availableRoleCards: readonly string[]
}

export interface MemoryAutomation {
  readonly enabled: boolean
  readonly activityConfigured: boolean
  readonly modelKeyConfigured: boolean
}

export interface SaveModelSelectionInput {
  readonly agentClass: AgentClass
  readonly provider: string
  readonly model: string
  readonly effort: ThinkingEffort | string
}

export interface SaveSecretInput {
  readonly name: string
  readonly value: string
}

export type SaveRoleCardInput =
  | { readonly mode: 'select'; readonly name: string }
  | { readonly mode: 'interview'; readonly interview: RoleCardInterviewInput }
  | { readonly mode: 'raw'; readonly name: string; readonly text: string }

// ---- Memory & Consolidation ----

export const LAYERS = ['L0', 'L1', 'L2', 'L3'] as const
export type Layer = (typeof LAYERS)[number]

export const VISIBILITIES = ['open', 'subject', 'origin', 'owner', 'internal'] as const
export type Visibility = (typeof VISIBILITIES)[number]

export const TRUST_LEVELS = ['self', 'owner', 'member', 'external'] as const
export type Trust = (typeof TRUST_LEVELS)[number]

export const RECORD_STATUSES = ['active', 'outdated', 'archived', 'tombstoned'] as const
export type RecordStatus = (typeof RECORD_STATUSES)[number]

export interface EvidenceRef {
  readonly id: string
}

export interface MemoryRecord {
  readonly id: string
  readonly layer: Layer
  readonly kind: string
  readonly source: string
  readonly channel: string
  readonly subjects: readonly string[]
  readonly actor: string
  readonly content: Readonly<Record<string, unknown>>
  readonly evidence: readonly EvidenceRef[]
  readonly visibility: Visibility
  readonly trust: Trust
  readonly confidence: number
  readonly importance: number
  readonly tEvent: number
  readonly tIngest: number
  readonly status: RecordStatus
  readonly validFrom?: number
  readonly validTo?: number
  readonly version: number
}

export interface RecordPatch {
  readonly content?: Readonly<Record<string, unknown>>
  readonly subjects?: readonly string[]
  readonly visibility?: Visibility
  readonly confidence?: number
  readonly importance?: number
  readonly status?: RecordStatus
  readonly validTo?: number
}

export type SearchScope = 'here' | 'person' | 'all'

export interface SearchRequest {
  readonly query: string
  readonly scope: SearchScope
  readonly layers?: readonly Layer[]
  readonly from?: number
  readonly to?: number
  readonly subjects?: readonly string[]
  readonly limit?: number
  readonly cursor?: string
  readonly neighbors?: number
  readonly history?: boolean
}

export interface ConsoleSearchRequest extends SearchRequest {
  readonly channel?: string
  readonly participants?: readonly string[]
}

export interface Disclosure {
  readonly speakable: 'yes' | 'if-subject-raises' | 'never'
  readonly label: string
}

export interface SearchNeighbor {
  readonly record: MemoryRecord
  readonly disclosure: Disclosure
  readonly position: 'before' | 'after'
}

export interface SearchHistoryItem {
  readonly id?: string
  readonly key: string
  readonly value: unknown
  readonly text: string
  readonly changedAt: number
  readonly status: 'outdated' | 'archived'
  readonly label: string
}

export interface SearchHit {
  readonly record: MemoryRecord
  readonly disclosure: Disclosure
  readonly score: number
  readonly neighbors?: readonly SearchNeighbor[]
  readonly history?: readonly SearchHistoryItem[]
}

export type ForgetSelector =
  | { readonly by: 'record'; readonly id: string }
  | { readonly by: 'channel'; readonly channel: string }
  | { readonly by: 'person'; readonly personId: string }
  | { readonly by: 'time'; readonly from: number; readonly to: number; readonly channel?: string }

export interface ForgetReport {
  readonly tombstoned: number
  readonly invalidated: number
  readonly l3Flagged: number
}

export type CrossChannelMode = 'off' | 'shadow' | 'on'

export interface MemoryBrowseFilter {
  readonly layer?: Layer
  readonly personId?: string
  readonly channel?: string
  readonly cursor?: string
  readonly limit?: number
}

export interface EvidenceNode {
  readonly record: MemoryRecord
  readonly children: readonly EvidenceNode[]
}

export interface CrossChannelAuditItem {
  readonly recordId: string
  readonly viewerChannel: string
  readonly mode: CrossChannelMode
  readonly tAt: number
}

export interface ForgetCascadePreview {
  readonly targetId: string
  readonly affectedIds: readonly string[]
  readonly byLayer: Readonly<Record<Layer, readonly string[]>>
}

export interface PersonSummary {
  readonly personId: string
  readonly accounts: readonly string[]
  readonly aliases: readonly string[]
}

export type MemorySubView = 'browse' | 'consolidation'

export interface L3ProfileVersionSummary {
  readonly version: number
  readonly tAt: number
  readonly status: string
  readonly current: boolean
  readonly author?: 'settlement' | 'owner'
  readonly evidenceCount?: number
  readonly ownerLockedKeys?: readonly string[]
  readonly stable?: string
  readonly data?: Readonly<Record<string, unknown>>
}

export interface L3ProfileDiffView {
  readonly from: number
  readonly to: number
  readonly stableChanged: boolean
  readonly added: readonly string[]
  readonly removed: readonly string[]
  readonly changed: readonly string[]
}

export interface ShadowL2CandidateView {
  readonly id: string
  readonly kind: string
  readonly channel: string
  readonly subjects: readonly string[]
  readonly content: Readonly<Record<string, unknown>>
  readonly evidenceIds: readonly string[]
  readonly confidence: number
  readonly importance: number
}

export interface ShadowCorrectionView {
  readonly id: string
  readonly action: 'promote-candidate' | 'supersede-fact' | 'close-topic'
  readonly targetId: string
  readonly reason: string
}

export interface SelfConflictView {
  readonly id: string
  readonly recordAId: string
  readonly recordBId: string
  readonly statementA: string
  readonly statementB: string
  readonly reason: string
  readonly recommendedKeepId?: string
}

export interface ShadowL3PatchView {
  readonly baseVersion: number
  readonly stable: string
  readonly data: Readonly<Record<string, unknown>>
  readonly preservedOwnerKeys: readonly string[]
  readonly added: readonly string[]
  readonly removed: readonly string[]
  readonly changed: readonly string[]
  readonly stableChanged: boolean
}

export interface ConsolidationProposalView {
  readonly id: string
  readonly status: 'pending' | 'approved' | 'rejected'
  readonly createdAt: number
  readonly window: { readonly from: number; readonly to: number }
  readonly tokensUsed: number
  readonly l2Candidates: readonly ShadowL2CandidateView[]
  readonly corrections: readonly ShadowCorrectionView[]
  readonly selfConflicts: readonly SelfConflictView[]
  readonly l3SelfPatch: ShadowL3PatchView | null
  readonly skippedL3Reason?: 'only-external-evidence' | 'insufficient-new-evidence'
}

export interface ConsolidationBudgetView {
  readonly usedTokensToday: number
  readonly dailyTokenCap: number
  readonly lastConsolidatedTo: number
}

// ---- Satellite & Interop ----

export type RunnerStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'crashed' | 'failed'
export type SatelliteRecoveryPhase = 'idle' | 'running' | 'crashing' | 'restarting' | 'recovered' | 'failed'
export type SatelliteSubView = 'runtime' | 'accounting' | 'interop'

export interface InteropSnapshot {
  readonly ampAliases: boolean
  readonly mcp: {
    readonly enabled: boolean
    readonly running: boolean
    readonly url?: string
    readonly port?: number
    readonly patchYaml?: string
  }
  readonly debugView: {
    readonly running: boolean
    readonly pid?: number
    readonly url?: string
    readonly port?: number
  }
}

export interface AgentProcessStatus {
  readonly agentClass: AgentClass
  readonly status: RunnerStatus
  readonly recoveryPhase?: SatelliteRecoveryPhase
  readonly pid?: number
  readonly activeSessions: number
  readonly selection: ModelSelection | null
  readonly lastError?: string
  readonly deniedApprovals: number
}

export interface SessionSurfaceInfo {
  readonly sessionId: string
  readonly channel: string
  readonly agentClass: AgentClass
  readonly toolCount: number
}

export interface IsolationDoctorStatus {
  readonly ok: boolean
  readonly checkedAt: number
  readonly problems: readonly string[]
}

export interface WakeMetricSample {
  readonly wakeId: string
  readonly channel: string
  readonly agentClass: AgentClass
  readonly profileVersion: number
  readonly arrivedAt: number
  readonly firstSendAt?: number
  readonly debounceMs: number
  readonly steps: readonly {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheReadTokens: number
    readonly cacheWriteTokens: number
  }[]
  readonly retries: number
  readonly outcome: 'acked' | 'interrupted' | 'unavailable'
}

export interface SatelliteSnapshot {
  readonly processes: Readonly<Record<AgentClass, AgentProcessStatus>>
  readonly sessions: readonly SessionSurfaceInfo[]
  readonly isolation: IsolationDoctorStatus
  readonly metrics: readonly WakeMetricSample[]
  readonly sharedQuotaWarning: boolean
}

// ---- Accounting ----

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

export interface PluginAccountingLimit {
  readonly dailyTokenLimit?: number
  readonly dailyCallsLimit?: number
  readonly maxOutputTokens?: number
}

export interface AccountingBudgetConfig {
  readonly dailyTokenLimit?: number
  readonly dailyCostMicrosLimit?: number
  readonly pluginDailyTokenLimit?: number
  readonly pluginLimits?: Readonly<Record<string, PluginAccountingLimit>>
}

// ---- Plugins ----

export const PLUGIN_KINDS = ['channel', 'activity', 'capability', 'memory-provider'] as const
export type PluginKind = (typeof PLUGIN_KINDS)[number]

export const TOOL_EFFECTS = ['read', 'write', 'send'] as const
export type ToolEffect = (typeof TOOL_EFFECTS)[number]

export const TOOL_LOADS = ['core', 'context', 'onDemand'] as const
export type ToolLoad = (typeof TOOL_LOADS)[number]

export interface ManifestTool {
  readonly name: string
  readonly effect: ToolEffect
  readonly load: ToolLoad
  readonly group?: string
  readonly summary: string
  readonly keywords?: readonly string[]
  readonly when?: string
  readonly channels?: readonly string[]
  readonly sendPerMinute?: number
  readonly textArg?: string
  readonly audience?: 'owner'
  readonly mcpName?: string
}

export interface ManifestGroup {
  readonly summary: string
  readonly usage?: string
}

export interface ManifestSource {
  readonly channels: readonly string[]
  readonly eventKinds: readonly string[]
  readonly defaultVisibility: Visibility
  readonly trust: Trust
  readonly retentionDays?: number
  readonly rateLimitPerHour?: number
}

export type ManifestMcp =
  | { readonly command: string; readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>> }
  | { readonly url: string; readonly headers?: Readonly<Record<string, string>> }

export interface BrainManifest {
  readonly id: string
  readonly kinds: readonly PluginKind[]
  readonly api: string
  readonly runtime: 'node' | 'process'
  readonly process?: { readonly command: string; readonly args?: readonly string[] }
  readonly permissions: readonly string[]
  readonly source?: ManifestSource
  readonly tools?: readonly ManifestTool[]
  readonly groups?: Readonly<Record<string, ManifestGroup>>
  readonly config?: string
  readonly migrations?: string
  readonly mcp?: ManifestMcp
}

export interface ManifestError {
  readonly field: string
  readonly message: string
}

export type ManifestResult =
  | { readonly ok: true; readonly manifest: BrainManifest }
  | { readonly ok: false; readonly errors: readonly ManifestError[] }

export interface ContractResult {
  readonly name: string
  readonly ok: boolean
  readonly message: string
}

export interface CheckFinding {
  readonly rule: string
  readonly level: 'must' | 'should'
  readonly message: string
  readonly file?: string
  readonly line?: number
}

export interface CheckReport {
  readonly ok: boolean
  readonly manifest: ManifestResult
  readonly contract: readonly ContractResult[]
  readonly findings: readonly CheckFinding[]
  readonly notes: readonly string[]
}

export type PluginLifecycleState = 'discovered' | 'pending' | 'enabled' | 'disabled' | 'failed'

export interface ConsolePluginUpdateInfo {
  readonly version: string
  readonly sha8: string
  readonly permissions: readonly string[]
  readonly newPermissions: readonly string[]
  readonly warnings: readonly string[]
}

export interface ConsolePluginItem {
  readonly id: string
  readonly version: string
  readonly kinds: readonly PluginKind[]
  readonly runtime: 'node' | 'process'
  readonly state: PluginLifecycleState
  readonly permissions: readonly string[]
  readonly granted: readonly string[]
  readonly checkPassed: boolean
  readonly tools: readonly ManifestTool[]
  readonly source?: 'workspace' | 'installed'
  readonly warnings?: readonly string[]
  readonly updateAvailable?: ConsolePluginUpdateInfo
}

export interface ConsoleInstallPreview {
  readonly id: string
  readonly version: string
  readonly permissions: readonly string[]
  readonly newPermissions: readonly string[]
  readonly warnings: readonly string[]
}

export interface ConsoleLocalApplyResult extends ConsoleInstallPreview {
  readonly applied: boolean
  readonly state: PluginLifecycleState
}

export interface ChannelCoreBudget {
  readonly pattern: string
  readonly count: number
  readonly tokens: number
  readonly over: boolean
}

export interface PluginsListResponse {
  readonly plugins: readonly ConsolePluginItem[]
  readonly coreBudgets: readonly ChannelCoreBudget[]
}

// ---- Console Chat ----

export interface ChatHistoryEntry {
  readonly messageId: string
  readonly channel: string
  readonly direction: 'inbound' | 'outbound'
  readonly actor: string
  readonly displayName: string
  readonly text: string
  readonly replyTo?: string
  readonly recordId: string
  readonly tEvent: number
}

export interface FormattedSnapshotItem {
  readonly id: string
  readonly line: string
}

export interface ChatMessagesResponse {
  readonly channel: string
  readonly items: readonly ChatHistoryEntry[]
  readonly unreadCount: number
  readonly lastReadMessageId?: string
  readonly lastReadAt?: number
  readonly snapshot?: readonly FormattedSnapshotItem[]
}

export interface SendChatMessageInput {
  readonly channel?: string
  readonly account?: string
  readonly displayName?: string
  readonly text: string
  readonly tEvent?: number
  readonly messageId?: string
  readonly debounceMs?: number
}

export interface WakeResult {
  readonly wakeId: string
  readonly outcome: 'acked' | 'interrupted' | 'unavailable'
  readonly replies?: readonly string[]
  readonly error?: string
}

export interface SendChatMessageResponse {
  readonly recordId: string
  readonly personId: string
  readonly messageId: string
  readonly wake: WakeResult
}
