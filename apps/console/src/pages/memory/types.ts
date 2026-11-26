import {
  BrainError,
  type ForgetReport,
  type ForgetSelector,
  type Layer,
  type MemoryRecord,
  type RecordPatch,
  type SearchHit,
  type SearchRequest,
} from '@brain-core/sdk'
import { apiFetch, type ApiFetchOptions, type ApiResult } from '../../shell/api-fetch.ts'

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

export interface MemoryPageApi {
  browse(filter: MemoryBrowseFilter): Promise<{ readonly items: readonly MemoryRecord[]; readonly nextCursor?: string }>
  search(request: SearchRequest): Promise<{ readonly items: readonly SearchHit[]; readonly nextCursor?: string; readonly degraded: boolean }>
  getRecord(id: string): Promise<MemoryRecord | null>
  getDependents(id: string): Promise<readonly MemoryRecord[]>
  updateRecord(id: string, patch: RecordPatch, expectedVersion: number): Promise<MemoryRecord>
  forget(selector: ForgetSelector): Promise<ForgetReport>
  listAudit(recordId?: string): Promise<readonly CrossChannelAuditItem[]>
  getCrossChannelMode(): Promise<CrossChannelMode>
  setCrossChannelMode(mode: CrossChannelMode): Promise<void>
  listPersons(): Promise<readonly PersonSummary[]>
  mergePerson(from: string, into: string): Promise<void>
  splitPerson(personId: string, accounts: readonly string[]): Promise<string>
  listL3Versions?(): Promise<readonly L3ProfileVersionSummary[]>
  diffL3Versions?(from: number, to: number): Promise<L3ProfileDiffView>
  rollbackL3Version?(version: number): Promise<{ readonly version: number }>
  editL3ByOwner?(patch: {
    readonly stable?: string
    readonly data: Readonly<Record<string, unknown>>
    readonly lockedKeys?: readonly string[]
  }): Promise<{ readonly version: number }>
  listConsolidationProposals?(): Promise<readonly ConsolidationProposalView[]>
  getConsolidationBudget?(): Promise<ConsolidationBudgetView>
  runConsolidationShadow?(): Promise<ConsolidationProposalView>
  approveConsolidationProposal?(
    id: string,
    conflictKeepIds?: Readonly<Record<string, string>>,
  ): Promise<{ readonly newProfileVersion?: number; readonly l2Created: number }>
  rejectConsolidationProposal?(id: string): Promise<void>
}

function unwrap<T>(result: ApiResult<T>): { readonly data: T; readonly meta: Extract<ApiResult<T>, { readonly ok: true }>['meta'] } {
  if (!result.ok) {
    throw new BrainError(result.code, result.message, result.details)
  }
  return { data: result.data, meta: result.meta }
}

function extractItems<T>(data: unknown): readonly T[] {
  if (Array.isArray(data)) return data as readonly T[]
  if (typeof data === 'object' && data !== null && 'items' in data && Array.isArray((data as { items: unknown }).items)) {
    return (data as { items: readonly T[] }).items
  }
  return []
}

/**
 * HTTP client for the memory console page, wrapping `apiFetch` with envelope unwrapping
 * and `If-Match` optimistic locking on record updates.
 */
export function createHttpMemoryPageApi(
  baseUrl: string,
  token: string,
  fetchImpl?: typeof globalThis.fetch,
): MemoryPageApi {
  const root = baseUrl.replace(/\/+$/, '')

  async function call<T>(path: string, options: Omit<ApiFetchOptions, 'token' | 'fetchImpl'> = {}): Promise<ApiResult<T>> {
    return apiFetch<T>(`${root}${path}`, {
      ...options,
      token,
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    })
  }

  return {
    async browse(filter) {
      const params = new URLSearchParams()
      if (filter.layer !== undefined) params.set('layer', filter.layer)
      if (filter.personId !== undefined) params.set('personId', filter.personId)
      if (filter.channel !== undefined) params.set('channel', filter.channel)
      if (filter.cursor !== undefined) params.set('cursor', filter.cursor)
      if (filter.limit !== undefined) params.set('limit', String(filter.limit))
      const qs = params.toString()
      const path = qs === '' ? '/api/v1/console/memory/records' : `/api/v1/console/memory/records?${qs}`
      const { data, meta } = unwrap(await call<{ readonly items: readonly MemoryRecord[]; readonly nextCursor?: string }>(path))
      const nextCursor = data.nextCursor ?? meta.nextCursor
      return {
        items: data.items,
        ...(nextCursor === undefined ? {} : { nextCursor }),
      }
    },

    async search(request) {
      const { data, meta } = unwrap(
        await call<{ readonly items: readonly SearchHit[]; readonly nextCursor?: string; readonly degraded?: boolean }>(
          '/api/v1/memory/search',
          { method: 'POST', body: request },
        ),
      )
      const nextCursor = meta.nextCursor ?? data.nextCursor
      const degraded = meta.degraded ?? data.degraded ?? false
      return {
        items: data.items,
        degraded,
        ...(nextCursor === undefined ? {} : { nextCursor }),
      }
    },

    async getRecord(id) {
      const res = await call<MemoryRecord>(`/api/v1/console/memory/records/${encodeURIComponent(id)}`)
      if (!res.ok && res.code === 'NOT_FOUND') return null
      return unwrap(res).data
    },

    async getDependents(id) {
      const { data } = unwrap(
        await call<readonly MemoryRecord[] | { readonly items: readonly MemoryRecord[] }>(
          `/api/v1/console/memory/records/${encodeURIComponent(id)}/dependents`,
        ),
      )
      return extractItems<MemoryRecord>(data)
    },

    async updateRecord(id, patch, expectedVersion) {
      const { data } = unwrap(
        await call<MemoryRecord>(`/api/v1/memory/records/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: patch,
          ifMatch: expectedVersion,
        }),
      )
      return data
    },

    async forget(selector) {
      const { data } = unwrap(
        await call<ForgetReport>('/api/v1/memory/forget', {
          method: 'POST',
          body: selector,
        }),
      )
      return data
    },

    async listAudit(recordId) {
      const path = recordId === undefined
        ? '/api/v1/console/memory/audit'
        : `/api/v1/console/memory/audit?recordId=${encodeURIComponent(recordId)}`
      const { data } = unwrap(
        await call<readonly CrossChannelAuditItem[] | { readonly items: readonly CrossChannelAuditItem[] }>(path),
      )
      return extractItems<CrossChannelAuditItem>(data)
    },

    async getCrossChannelMode() {
      const { data } = unwrap(
        await call<CrossChannelMode | { readonly mode: CrossChannelMode }>('/api/v1/console/memory/cross-channel'),
      )
      return typeof data === 'string' ? data : data.mode
    },

    async setCrossChannelMode(mode) {
      unwrap(
        await call<unknown>('/api/v1/console/memory/cross-channel', {
          method: 'PUT',
          body: { mode },
        }),
      )
    },

    async listPersons() {
      const { data } = unwrap(
        await call<readonly PersonSummary[] | { readonly items: readonly PersonSummary[] }>('/api/v1/console/memory/persons'),
      )
      return extractItems<PersonSummary>(data)
    },

    async mergePerson(from, into) {
      unwrap(
        await call<unknown>('/api/v1/console/memory/persons/merge', {
          method: 'POST',
          body: { from, into },
        }),
      )
    },

    async splitPerson(personId, accounts) {
      const { data } = unwrap(
        await call<string | { readonly personId: string }>(
          `/api/v1/console/memory/persons/${encodeURIComponent(personId)}/split`,
          { method: 'POST', body: { accounts } },
        ),
      )
      return typeof data === 'string' ? data : data.personId
    },

    async listL3Versions() {
      const { data } = unwrap(
        await call<readonly L3ProfileVersionSummary[] | { readonly items: readonly L3ProfileVersionSummary[] }>(
          '/api/v1/console/memory/l3/versions',
        ),
      )
      return extractItems<L3ProfileVersionSummary>(data)
    },

    async diffL3Versions(from, to) {
      const { data } = unwrap(
        await call<L3ProfileDiffView>(
          `/api/v1/console/memory/l3/diff?from=${encodeURIComponent(String(from))}&to=${encodeURIComponent(String(to))}`,
        ),
      )
      return data
    },

    async rollbackL3Version(version) {
      const { data } = unwrap(
        await call<{ readonly version: number }>('/api/v1/console/memory/l3/rollback', {
          method: 'POST',
          body: { version },
        }),
      )
      return data
    },

    async editL3ByOwner(patch) {
      const { data } = unwrap(
        await call<{ readonly version: number }>(
          '/api/v1/console/memory/l3/owner',
          { method: 'PUT', body: patch },
        ),
      )
      return data
    },

    async listConsolidationProposals() {
      const { data } = unwrap(
        await call<readonly ConsolidationProposalView[] | { readonly items: readonly ConsolidationProposalView[] }>(
          '/api/v1/console/memory/consolidation/proposals',
        ),
      )
      return extractItems<ConsolidationProposalView>(data)
    },

    async getConsolidationBudget() {
      const { data } = unwrap(
        await call<ConsolidationBudgetView>('/api/v1/console/memory/consolidation/budget'),
      )
      return data
    },

    async runConsolidationShadow() {
      const { data } = unwrap(
        await call<ConsolidationProposalView>('/api/v1/console/memory/consolidation/run', {
          method: 'POST',
        }),
      )
      return data
    },

    async approveConsolidationProposal(id, conflictKeepIds) {
      const { data } = unwrap(
        await call<{ readonly newProfileVersion?: number; readonly l2Created: number }>(
          `/api/v1/console/memory/consolidation/proposals/${encodeURIComponent(id)}/approve`,
          {
            method: 'POST',
            body: conflictKeepIds === undefined ? {} : { conflictKeepIds },
          },
        ),
      )
      return data
    },

    async rejectConsolidationProposal(id) {
      unwrap(
        await call<unknown>(
          `/api/v1/console/memory/consolidation/proposals/${encodeURIComponent(id)}/reject`,
          { method: 'POST' },
        ),
      )
    },
  }
}
