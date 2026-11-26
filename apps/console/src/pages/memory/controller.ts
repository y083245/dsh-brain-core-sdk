import {
  BrainError,
  type ForgetReport,
  type ForgetSelector,
  type Layer,
  type MemoryRecord,
  type RecordPatch,
  type SearchHit,
} from '@brain-core/sdk'
import type {
  ConsolidationBudgetView,
  ConsolidationProposalView,
  CrossChannelAuditItem,
  CrossChannelMode,
  EvidenceNode,
  ForgetCascadePreview,
  L3ProfileDiffView,
  L3ProfileVersionSummary,
  MemoryBrowseFilter,
  MemoryPageApi,
  MemorySubView,
  PersonSummary,
} from './types.ts'

export interface MemoryPageState {
  readonly subView: MemorySubView
  readonly filter: MemoryBrowseFilter
  readonly items: readonly MemoryRecord[]
  readonly nextCursor?: string
  readonly searchQuery: string | null
  readonly searchHits: readonly SearchHit[] | null
  readonly degraded: boolean
  readonly selectedRecord: MemoryRecord | null
  readonly evidenceChain: EvidenceNode | null
  readonly recordAudit: readonly CrossChannelAuditItem[]
  readonly pendingForget: { readonly selector: ForgetSelector; readonly preview: ForgetCascadePreview } | null
  readonly lastForgetReport: ForgetReport | null
  readonly conflictWarning: string | null
  readonly crossChannelMode: CrossChannelMode
  readonly shadowAudit: readonly CrossChannelAuditItem[]
  readonly persons: readonly PersonSummary[]
  readonly l3Versions: readonly L3ProfileVersionSummary[]
  readonly l3Diff: L3ProfileDiffView | null
  readonly proposals: readonly ConsolidationProposalView[]
  readonly consolidationBudget: ConsolidationBudgetView | null
  readonly conflictDecisions: Readonly<Record<string, string>>
  readonly rollbackNotice: string | null
  readonly errorMessage: string | null
}

export interface MemoryPageController {
  state(): MemoryPageState
  browse(filter?: MemoryBrowseFilter): Promise<void>
  loadNextPage(): Promise<void>
  search(query: string, options?: { readonly layers?: readonly Layer[]; readonly subjects?: readonly string[] }): Promise<void>
  /** Loads the record, builds its full evidence chain down to L0, and fetches its cross-channel audit rows (S6). */
  selectRecord(id: string): Promise<void>
  /**
   * Patches a record with If-Match optimistic locking. On CONFLICT (409), sets conflictWarning
   * ("版本冲突：该记录已被更新，请刷新后重试") and does NOT overwrite or retry silently.
   */
  editRecord(id: string, patch: RecordPatch, expectedVersion: number): Promise<boolean>
  markOutdated(id: string, expectedVersion: number): Promise<boolean>
  /**
   * Step 1 of forget: computes cascade preview via getDependents (recursively) and sets pendingForget.
   * NEVER calls api.forget() before confirmForget() is called!
   */
  requestForgetRecord(id: string): Promise<ForgetCascadePreview>
  confirmForget(): Promise<ForgetReport>
  cancelForget(): void
  loadCrossChannelPanel(): Promise<void>
  changeCrossChannelMode(mode: CrossChannelMode): Promise<void>
  loadPersons(): Promise<void>
  mergePerson(from: string, into: string): Promise<void>
  splitPerson(personId: string, accounts: readonly string[]): Promise<string>
  switchSubView(view: MemorySubView): void
  loadConsolidationWorkspace(): Promise<void>
  compareL3Versions(from: number, to: number): Promise<void>
  rollbackL3(version: number): Promise<boolean>
  saveOwnerL3(patch: {
    readonly stable?: string
    readonly data: Readonly<Record<string, unknown>>
    readonly lockedKeys?: readonly string[]
  }): Promise<boolean>
  chooseConflictKeep(conflictId: string, keepRecordId: string): void
  triggerShadowConsolidation(): Promise<void>
  approveProposal(proposalId: string): Promise<boolean>
  rejectProposal(proposalId: string): Promise<boolean>
}

const CONFLICT_WARNING = '版本冲突：该记录已被更新，请刷新后重试'

function errorMessageOf(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'unknown error'
}

function isConflictError(error: unknown): boolean {
  if (error instanceof BrainError) return error.code === 'CONFLICT'
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'CONFLICT'
}

async function buildEvidenceChain(
  api: MemoryPageApi,
  record: MemoryRecord,
  visited: ReadonlySet<string>,
): Promise<EvidenceNode> {
  const pathVisited = new Set(visited)
  pathVisited.add(record.id)

  if (record.layer === 'L0' || record.evidence.length === 0) {
    return { record, children: [] }
  }

  const children: EvidenceNode[] = []
  for (const ref of record.evidence) {
    if (pathVisited.has(ref.id)) continue
    const child = await api.getRecord(ref.id)
    if (child === null) continue
    children.push(await buildEvidenceChain(api, child, pathVisited))
  }

  return { record, children }
}

async function collectForgetPreview(api: MemoryPageApi, targetId: string): Promise<ForgetCascadePreview> {
  const visited = new Set<string>([targetId])
  const queue: string[] = [targetId]
  const affectedIds: string[] = []
  const byLayer: Record<Layer, string[]> = { L0: [], L1: [], L2: [], L3: [] }

  while (queue.length > 0) {
    const currentId = queue.shift() as string
    const dependents = await api.getDependents(currentId)
    for (const dep of dependents) {
      if (visited.has(dep.id)) continue
      visited.add(dep.id)
      affectedIds.push(dep.id)
      byLayer[dep.layer].push(dep.id)
      queue.push(dep.id)
    }
  }

  return { targetId, affectedIds, byLayer }
}

function withOptionalCursor(state: Omit<MemoryPageState, 'nextCursor'>, nextCursor: string | undefined): MemoryPageState {
  return nextCursor === undefined ? state : { ...state, nextCursor }
}

function requireApiMethod<T extends (...args: never[]) => unknown>(fn: T | undefined, name: string): T {
  if (fn === undefined) {
    throw new BrainError('UNAVAILABLE', `memory api does not implement ${name}`)
  }
  return fn
}

/**
 * Stateful controller for the console memory browser, evidence chain viewer,
 * optimistic-locking editor, two-step forget confirmation, cross-channel panel,
 * person identity management, and L3 consolidation review workspace.
 */
export function createMemoryPageController(api: MemoryPageApi): MemoryPageController {
  let current: MemoryPageState = {
    subView: 'browse',
    filter: {},
    items: [],
    searchQuery: null,
    searchHits: null,
    degraded: false,
    selectedRecord: null,
    evidenceChain: null,
    recordAudit: [],
    pendingForget: null,
    lastForgetReport: null,
    conflictWarning: null,
    crossChannelMode: 'off',
    shadowAudit: [],
    persons: [],
    l3Versions: [],
    l3Diff: null,
    proposals: [],
    consolidationBudget: null,
    conflictDecisions: {},
    rollbackNotice: null,
    errorMessage: null,
  }

  function setState(next: MemoryPageState): void {
    current = next
  }

  function stripCursor(state: MemoryPageState): Omit<MemoryPageState, 'nextCursor'> {
    const copy = { ...state }
    delete (copy as { nextCursor?: string }).nextCursor
    return copy
  }

  async function refreshCrossChannelPanel(): Promise<void> {
    const [crossChannelMode, audit] = await Promise.all([
      api.getCrossChannelMode(),
      api.listAudit(),
    ])
    setState({
      ...current,
      crossChannelMode,
      shadowAudit: audit.filter((item) => item.mode === 'shadow'),
      errorMessage: null,
    })
  }

  return {
    state() {
      return current
    },

    async browse(filter = {}) {
      try {
        const res = await api.browse(filter)
        setState(
          withOptionalCursor(
            {
              ...stripCursor(current),
              filter,
              items: res.items,
              searchQuery: null,
              searchHits: null,
              degraded: false,
              errorMessage: null,
            },
            res.nextCursor,
          ),
        )
      } catch (error) {
        setState({ ...current, errorMessage: errorMessageOf(error) })
      }
    },

    async loadNextPage() {
      if (current.nextCursor === undefined) return
      try {
        const res = await api.browse({ ...current.filter, cursor: current.nextCursor })
        setState(
          withOptionalCursor(
            {
              ...stripCursor(current),
              items: [...current.items, ...res.items],
              errorMessage: null,
            },
            res.nextCursor,
          ),
        )
      } catch (error) {
        setState({ ...current, errorMessage: errorMessageOf(error) })
      }
    },

    async search(query, options) {
      try {
        const res = await api.search({
          query,
          scope: 'all',
          ...(options?.layers === undefined ? {} : { layers: options.layers }),
          ...(options?.subjects === undefined ? {} : { subjects: options.subjects }),
        })
        setState(
          withOptionalCursor(
            {
              ...stripCursor(current),
              searchQuery: query,
              searchHits: res.items,
              degraded: res.degraded,
              errorMessage: null,
            },
            res.nextCursor,
          ),
        )
      } catch (error) {
        setState({ ...current, errorMessage: errorMessageOf(error) })
      }
    },

    async selectRecord(id) {
      try {
        const record = await api.getRecord(id)
        if (record === null) {
          setState({
            ...current,
            selectedRecord: null,
            evidenceChain: null,
            recordAudit: [],
            conflictWarning: null,
            errorMessage: null,
          })
          return
        }
        const [evidenceChain, recordAudit] = await Promise.all([
          buildEvidenceChain(api, record, new Set<string>()),
          api.listAudit(id),
        ])
        setState({
          ...current,
          selectedRecord: record,
          evidenceChain,
          recordAudit,
          conflictWarning: null,
          errorMessage: null,
        })
      } catch (error) {
        setState({ ...current, errorMessage: errorMessageOf(error) })
      }
    },

    async editRecord(id, patch, expectedVersion) {
      try {
        const updated = await api.updateRecord(id, patch, expectedVersion)
        setState({
          ...current,
          items: current.items.map((item) => (item.id === id ? updated : item)),
          selectedRecord: current.selectedRecord?.id === id ? updated : current.selectedRecord,
          conflictWarning: null,
          errorMessage: null,
        })
        return true
      } catch (error) {
        if (isConflictError(error)) {
          setState({ ...current, conflictWarning: CONFLICT_WARNING })
          return false
        }
        setState({ ...current, errorMessage: errorMessageOf(error) })
        return false
      }
    },

    async markOutdated(id, expectedVersion) {
      return this.editRecord(id, { status: 'outdated' }, expectedVersion)
    },

    async requestForgetRecord(id) {
      try {
        const preview = await collectForgetPreview(api, id)
        setState({
          ...current,
          pendingForget: { selector: { by: 'record', id }, preview },
          errorMessage: null,
        })
        return preview
      } catch (error) {
        setState({ ...current, errorMessage: errorMessageOf(error) })
        throw error
      }
    },

    async confirmForget() {
      if (current.pendingForget === null) {
        setState({ ...current, errorMessage: '没有待确认的遗忘操作' })
        throw new BrainError('INVALID_ARGUMENT', 'no pending forget request')
      }
      try {
        const report = await api.forget(current.pendingForget.selector)
        setState({
          ...current,
          pendingForget: null,
          lastForgetReport: report,
          errorMessage: null,
        })
        return report
      } catch (error) {
        setState({ ...current, errorMessage: errorMessageOf(error) })
        throw error
      }
    },

    cancelForget() {
      setState({ ...current, pendingForget: null })
    },

    async loadCrossChannelPanel() {
      try {
        await refreshCrossChannelPanel()
      } catch (error) {
        setState({ ...current, errorMessage: errorMessageOf(error) })
      }
    },

    async changeCrossChannelMode(mode) {
      try {
        await api.setCrossChannelMode(mode)
        await refreshCrossChannelPanel()
      } catch (error) {
        setState({ ...current, errorMessage: errorMessageOf(error) })
      }
    },

    async loadPersons() {
      try {
        const persons = await api.listPersons()
        setState({ ...current, persons, errorMessage: null })
      } catch (error) {
        setState({ ...current, errorMessage: errorMessageOf(error) })
      }
    },

    async mergePerson(from, into) {
      try {
        await api.mergePerson(from, into)
        const persons = await api.listPersons()
        setState({ ...current, persons, errorMessage: null })
      } catch (error) {
        setState({ ...current, errorMessage: errorMessageOf(error) })
      }
    },

    async splitPerson(personId, accounts) {
      try {
        const createdId = await api.splitPerson(personId, accounts)
        const persons = await api.listPersons()
        setState({ ...current, persons, errorMessage: null })
        return createdId
      } catch (error) {
        setState({ ...current, errorMessage: errorMessageOf(error) })
        throw error
      }
    },

    switchSubView(view) {
      setState({ ...current, subView: view })
    },

    async loadConsolidationWorkspace() {
      try {
        const [l3Versions, proposals, consolidationBudget] = await Promise.all([
          api.listL3Versions ? api.listL3Versions() : Promise.resolve(current.l3Versions),
          api.listConsolidationProposals ? api.listConsolidationProposals() : Promise.resolve(current.proposals),
          api.getConsolidationBudget ? api.getConsolidationBudget() : Promise.resolve(current.consolidationBudget),
        ])
        setState({
          ...current,
          l3Versions,
          proposals,
          consolidationBudget,
          errorMessage: null,
        })
      } catch (error) {
        setState({ ...current, errorMessage: errorMessageOf(error) })
      }
    },

    async compareL3Versions(from, to) {
      try {
        const diffFn = requireApiMethod(api.diffL3Versions, 'diffL3Versions')
        const l3Diff = await diffFn(from, to)
        setState({ ...current, l3Diff, errorMessage: null })
      } catch (error) {
        setState({ ...current, errorMessage: errorMessageOf(error) })
      }
    },

    async rollbackL3(version) {
      try {
        const rollbackFn = requireApiMethod(api.rollbackL3Version, 'rollbackL3Version')
        await rollbackFn(version)
        const l3Versions = api.listL3Versions ? await api.listL3Versions() : current.l3Versions
        setState({
          ...current,
          l3Versions,
          rollbackNotice: `已回滚至 L3 版本 v${String(version)}`,
          errorMessage: null,
        })
        return true
      } catch (error) {
        setState({ ...current, errorMessage: errorMessageOf(error) })
        return false
      }
    },

    async saveOwnerL3(patch) {
      try {
        const editFn = requireApiMethod(api.editL3ByOwner, 'editL3ByOwner')
        await editFn(patch)
        const l3Versions = api.listL3Versions ? await api.listL3Versions() : current.l3Versions
        setState({
          ...current,
          l3Versions,
          rollbackNotice: null,
          errorMessage: null,
        })
        return true
      } catch (error) {
        setState({ ...current, errorMessage: errorMessageOf(error) })
        return false
      }
    },

    chooseConflictKeep(conflictId, keepRecordId) {
      setState({
        ...current,
        conflictDecisions: { ...current.conflictDecisions, [conflictId]: keepRecordId },
      })
    },

    async triggerShadowConsolidation() {
      try {
        const runFn = requireApiMethod(api.runConsolidationShadow, 'runConsolidationShadow')
        const created = await runFn()
        const proposals = [created, ...current.proposals.filter((item) => item.id !== created.id)]
        setState({ ...current, proposals, errorMessage: null })
      } catch (error) {
        setState({ ...current, errorMessage: errorMessageOf(error) })
      }
    },

    async approveProposal(proposalId) {
      try {
        const approveFn = requireApiMethod(api.approveConsolidationProposal, 'approveConsolidationProposal')
        await approveFn(proposalId, current.conflictDecisions)
        const [l3Versions, proposals] = await Promise.all([
          api.listL3Versions ? api.listL3Versions() : Promise.resolve(current.l3Versions),
          api.listConsolidationProposals ? api.listConsolidationProposals() : Promise.resolve(current.proposals),
        ])
        setState({
          ...current,
          l3Versions,
          proposals,
          conflictDecisions: {},
          errorMessage: null,
        })
        return true
      } catch (error) {
        setState({ ...current, errorMessage: errorMessageOf(error) })
        return false
      }
    },

    async rejectProposal(proposalId) {
      try {
        const rejectFn = requireApiMethod(api.rejectConsolidationProposal, 'rejectConsolidationProposal')
        await rejectFn(proposalId)
        const proposals = api.listConsolidationProposals
          ? await api.listConsolidationProposals()
          : current.proposals
        setState({
          ...current,
          proposals,
          errorMessage: null,
        })
        return true
      } catch (error) {
        setState({ ...current, errorMessage: errorMessageOf(error) })
        return false
      }
    },
  }
}
