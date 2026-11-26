export const LAYERS = ['L0', 'L1', 'L2', 'L3'] as const
export type Layer = (typeof LAYERS)[number]
export const VISIBILITIES = ['open', 'subject', 'origin', 'owner', 'internal'] as const
export type Visibility = (typeof VISIBILITIES)[number]
export const TRUST_LEVELS = ['self', 'owner', 'member', 'external'] as const
export type Trust = (typeof TRUST_LEVELS)[number]
export const RECORD_STATUSES = ['active', 'outdated', 'archived', 'tombstoned'] as const
export type RecordStatus = (typeof RECORD_STATUSES)[number]

export interface EvidenceRef { readonly id: string }

/** The one envelope shared by L0–L3 (RFC 6.3). */
export interface MemoryRecord {
  readonly id: string            // layer prefix + ULID, e.g. l1_01J...
  readonly layer: Layer
  readonly kind: string          // e.g. l1.fact
  readonly source: string        // plugin id, always set by the kernel
  readonly channel: string       // <source>:<kind>:<id>
  readonly subjects: readonly string[]
  readonly actor: string
  readonly content: Readonly<Record<string, unknown>>
  readonly evidence: readonly EvidenceRef[]
  readonly visibility: Visibility
  readonly trust: Trust          // always set by the kernel
  readonly confidence: number    // 0–1
  readonly importance: number    // 0–1
  readonly tEvent: number        // ms
  readonly tIngest: number       // ms
  readonly status: RecordStatus
  readonly validFrom?: number
  readonly validTo?: number
  readonly version: number
}

/** Filled by the kernel from trusted identity; caller input is ignored (RFC P1). */
export interface Viewer {
  readonly caller: string        // plugin id, 'agent' or 'owner-console'
  readonly channel: string | null
  readonly participants: readonly string[]
}

export interface IngestEvent {
  readonly kind: string
  readonly channel: string
  readonly subjects: readonly string[]
  readonly actor: string
  readonly content: Readonly<Record<string, unknown>>
  readonly tEvent: number
  readonly idempotencyKey: string
  readonly visibility?: Visibility
}

export interface RecordInput {
  readonly layer: 'L1' | 'L2'
  readonly kind: string
  readonly channel: string
  readonly subjects: readonly string[]
  readonly actor: string
  readonly content: Readonly<Record<string, unknown>>
  readonly evidence: readonly EvidenceRef[]
  readonly visibility?: Visibility
  readonly confidence?: number
  readonly importance?: number
  readonly tEvent?: number
  readonly validFrom?: number
  readonly idempotencyKey?: string
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
  /** Number of adjacent same-channel active L0 records before and after an L0 hit (0..10, FR-M19). */
  readonly neighbors?: number
  /** When true, attach superseded/archived historical values for matched attributes (FR-M19). */
  readonly history?: boolean
}

/** What the model is told about a memory it may use (RFC P2). */
export interface Disclosure {
  readonly speakable: 'yes' | 'if-subject-raises' | 'never'
  readonly label: string         // never holds an account or group number
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

export interface ContextRequest {
  readonly channel: string
  readonly query?: string
  readonly budgetChars?: number
}

export interface ContextItem {
  readonly id: string
  readonly text: string
  readonly disclosure: Disclosure
  /** Her own judgement rather than something said to her (added for S3). */
  readonly inferred?: boolean
}

export const CONTEXT_BLOCK_NAMES = [
  'profile', 'working', 'topics', 'facts', 'lessons', 'recall', 'elsewhere', 'promises',
] as const
export type ContextBlockName = (typeof CONTEXT_BLOCK_NAMES)[number]

export interface ContextBlock {
  readonly name: ContextBlockName
  readonly items: readonly ContextItem[]
}

export interface ContextBundle {
  readonly profileVersion: number
  /** Changes only on settlement or session rotation, so it can sit in the cached prefix (RFC 9.9). */
  readonly stable: string
  /** Appended at the tail of each wake. */
  readonly blocks: readonly ContextBlock[]
  readonly truncated: boolean
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

export const ERROR_CODES = {
  INVALID_ARGUMENT: 400, UNAUTHENTICATED: 401, PERMISSION_DENIED: 403, NOT_FOUND: 404, CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413, RATE_LIMITED: 429, EMBEDDING_MISMATCH: 503, UNAVAILABLE: 503, INTERNAL: 500,
} as const
export type ErrorCode = keyof typeof ERROR_CODES

export class BrainError extends Error {
  readonly code: ErrorCode
  readonly details: Readonly<Record<string, unknown>>
  constructor(code: ErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message)
    this.name = 'BrainError'
    this.code = code
    this.details = details
  }
}

export interface Meta {
  readonly requestId: string
  readonly apiVersion?: string
  readonly degraded?: boolean
  readonly nextCursor?: string
}
export type Envelope<T> =
  | { readonly ok: true; readonly data: T; readonly meta: Meta }
  | { readonly ok: false; readonly error: { readonly code: ErrorCode; readonly message: string; readonly details: Readonly<Record<string, unknown>> }; readonly meta: Meta }

/** Size and count caps shared by every binding (FR-A05). */
export const LIMITS = {
  /** A single record's `content`, after serialization, in bytes. */
  contentBytes: 64 * 1024,
  /** The whole HTTP request body, in bytes. */
  requestBytes: 1024 * 1024,
  /** Elements allowed in `subjects`. */
  subjects: 50,
  /** Elements allowed in `evidence`. */
  evidence: 100,
  /** Largest allowed `search.limit`. */
  searchLimit: 100,
  /** Characters allowed in a tool or group `summary`. */
  toolSummaryChars: 60,
  /** Characters allowed in one tool result. */
  toolResultChars: 64 * 1024,
  /** Images allowed in one tool result. */
  toolImages: 4,
  /** Bytes allowed in one tool image. */
  toolImageBytes: 8 * 1024 * 1024,
  /** Messages allowed in one wake. */
  wakeMessages: 50,
  /** Characters allowed in one wake message. */
  wakeMessageChars: 2000,
} as const
