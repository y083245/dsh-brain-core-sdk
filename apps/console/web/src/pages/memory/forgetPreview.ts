import type { Layer, MemoryRecord } from '../../api/types.ts'

export interface ForgetPreviewState {
  readonly rootIds: ReadonlySet<string>
  /** Affected recordId -> minimum dependency depth from forgotten root (0 for root, 1+ for cascade). */
  readonly depthById: ReadonlyMap<string, number>
  /** Affected directed edge key (`${from}->${to}`) -> depth of target node. */
  readonly edgeDepthByKey: ReadonlyMap<string, number>
  /** performance.now() timestamp when preview started, used for 120ms/depth stagger. */
  readonly startedAtMs: number
}

export interface ForgetDissolveState {
  readonly id: number
  /** Records erased (tombstoned root + cascade invalidated L1/L2) -> dependency depth (140ms/depth stagger). */
  readonly erasedDepthById: ReadonlyMap<string, number>
  /** Records NOT erased that transition to outdated (e.g. flagged active L3). */
  readonly outdatedIds: ReadonlySet<string>
  /** performance.now() timestamp when dissolve started. */
  readonly startedAtMs: number
}

export interface RecordForgetCascadeResult {
  readonly target: MemoryRecord
  readonly tombstonedRecords: readonly MemoryRecord[]
  readonly invalidatedRecords: readonly MemoryRecord[]
  readonly l3FlaggedRecords: readonly MemoryRecord[]
  readonly byLayer: Readonly<Record<Layer, readonly MemoryRecord[]>>
  readonly depthById: ReadonlyMap<string, number>
  readonly erasedDepthById: ReadonlyMap<string, number>
  readonly outdatedIds: ReadonlySet<string>
  readonly edgeDepthByKey: ReadonlyMap<string, number>
}

export interface CascadeLookupDeps {
  readonly getDependents: (id: string) => Promise<readonly MemoryRecord[]>
  readonly getRecord: (id: string) => Promise<MemoryRecord | null>
  readonly knownRecords?: ReadonlyMap<string, MemoryRecord>
  readonly isCancelled?: () => boolean
}

export function edgeKey(fromId: string, toId: string): string {
  return `${fromId}->${toId}`
}

/**
 * Simulates the exact backend cascade semantics from `apps/kernel/src/memory-forget/index.ts`:
 * - L3 cannot be directly selected for forget.
 * - Selected record enters `queued` (tombstoned).
 * - BFS walks `dependentsOf(sourceId)` with cycle protection.
 * - A dependent remains alive if it still has ANY evidence ref whose record exists and is neither
 *   already tombstoned nor in `queued`.
 * - L1/L2 dependents with no valid evidence left are cascade-tombstoned (`invalidated`) and enqueued.
 * - Active L3 dependents with no valid evidence left are marked `outdated` (`l3Flagged`) and never enqueued.
 * - Kept dependents are re-checked whenever another of their evidence refs enters `queued`.
 */
export async function computeRecordForgetCascade(
  target: MemoryRecord,
  deps: CascadeLookupDeps,
): Promise<RecordForgetCascadeResult> {
  const emptyByLayer: Record<Layer, MemoryRecord[]> = { L0: [], L1: [], L2: [], L3: [] }
  if (target.layer === 'L3') {
    return {
      target,
      tombstonedRecords: [],
      invalidatedRecords: [],
      l3FlaggedRecords: [],
      byLayer: emptyByLayer,
      depthById: new Map(),
      erasedDepthById: new Map(),
      outdatedIds: new Set(),
      edgeDepthByKey: new Map(),
    }
  }

  // Only cache records loaded fresh within this cascade computation so stale
  // external caches (e.g. from prior forgets) can never mask tombstoned evidence.
  const freshRecordCache = new Map<string, MemoryRecord | null>([[target.id, target]])

  const dependentsCache = new Map<string, readonly MemoryRecord[]>()

  async function readFreshRecord(id: string): Promise<MemoryRecord | null> {
    if (freshRecordCache.has(id)) return freshRecordCache.get(id) ?? null
    const rec = await deps.getRecord(id)
    freshRecordCache.set(id, rec)
    return rec
  }

  async function readDependents(id: string): Promise<readonly MemoryRecord[]> {
    const cached = dependentsCache.get(id)
    if (cached !== undefined) return cached
    const items = await deps.getDependents(id)
    for (const item of items) {
      freshRecordCache.set(item.id, item)
    }
    dependentsCache.set(id, items)
    return items
  }

  const queued = new Set<string>([target.id])
  const queue: string[] = [target.id]
  const depthById = new Map<string, number>([[target.id, 0]])
  const erasedDepthById = new Map<string, number>([[target.id, 0]])
  const affectedRecords = new Map<string, MemoryRecord>([[target.id, target]])
  const tombstonedRecords: MemoryRecord[] = target.status !== 'tombstoned' ? [target] : []
  const invalidatedRecords: MemoryRecord[] = []
  const l3FlaggedSet = new Set<string>()
  const l3FlaggedRecords: MemoryRecord[] = []

  async function hasValidEvidence(record: MemoryRecord): Promise<boolean> {
    for (const ref of record.evidence) {
      if (queued.has(ref.id)) continue
      if (deps.isCancelled?.()) return false
      const targetRec = await readFreshRecord(ref.id)
      if (targetRec !== null && targetRec.status !== 'tombstoned') return true
    }
    return false
  }

  for (let pos = 0; pos < queue.length; pos += 1) {
    if (deps.isCancelled?.()) break
    const sourceId = queue[pos]!
    const sourceDepth = depthById.get(sourceId) ?? 0
    const dependents = await readDependents(sourceId)
    if (deps.isCancelled?.()) break

    for (const dependent of dependents) {
      if (deps.isCancelled?.()) break
      if (queued.has(dependent.id)) continue

      const valid = await hasValidEvidence(dependent)
      if (deps.isCancelled?.()) break

      const nextDepth = sourceDepth + 1
      if (dependent.layer === 'L3') {
        if (!valid && dependent.status === 'active' && !l3FlaggedSet.has(dependent.id)) {
          l3FlaggedSet.add(dependent.id)
          l3FlaggedRecords.push(dependent)
          affectedRecords.set(dependent.id, dependent)
          const existingDepth = depthById.get(dependent.id)
          depthById.set(dependent.id, existingDepth === undefined ? nextDepth : Math.min(existingDepth, nextDepth))
        }
        continue
      }

      if (dependent.layer !== 'L1' && dependent.layer !== 'L2') continue
      if (valid) continue

      if (dependent.status !== 'tombstoned') {
        invalidatedRecords.push(dependent)
      }
      queued.add(dependent.id)
      queue.push(dependent.id)
      affectedRecords.set(dependent.id, dependent)
      depthById.set(dependent.id, nextDepth)
      erasedDepthById.set(dependent.id, nextDepth)
    }
  }

  // Build affected directed edges from any erased source into any affected dependent
  const edgeDepthByKey = new Map<string, number>()
  for (const [depId, depRecord] of affectedRecords) {
    if (depId === target.id) continue
    const depDepth = depthById.get(depId) ?? 1
    for (const ref of depRecord.evidence) {
      if (queued.has(ref.id)) {
        edgeDepthByKey.set(edgeKey(ref.id, depId), depDepth)
      }
    }
  }

  const byLayer: Record<Layer, MemoryRecord[]> = { L0: [], L1: [], L2: [], L3: [] }
  for (const record of [...tombstonedRecords, ...invalidatedRecords, ...l3FlaggedRecords]) {
    byLayer[record.layer].push(record)
  }

  return {
    target,
    tombstonedRecords,
    invalidatedRecords,
    l3FlaggedRecords,
    byLayer,
    depthById,
    erasedDepthById,
    outdatedIds: l3FlaggedSet,
    edgeDepthByKey,
  }
}

export const MAX_PAGINATION_PAGES = 50
export const BROWSE_BATCH_LIMIT = 200
export const GRAPH_L1_CAP = 500
export const GRAPH_L0_CAP = 1500
export const GRAPH_TOTAL_CAP = 5000

export interface BrowsePageResponse {
  readonly items: readonly MemoryRecord[]
  readonly nextCursor?: string
}

export interface PaginatedLayerResult {
  readonly items: readonly MemoryRecord[]
  /** Cursor that fetched the final page, allowing incremental tail polling without re-scanning from page 1. */
  readonly tailCursor: string | undefined
  readonly reachedPageCap: boolean
}

/**
 * Walks ascending cursor pages for a single browse query up to `maxPages` (default 50 = 10,000 items).
 * Remembers `tailCursor` (cursor passed to the last page request) so subsequent 10s polls only read the tail.
 */
export async function fetchAllBrowsePages(
  fetchPage: (cursor?: string) => Promise<BrowsePageResponse>,
  options: { readonly maxPages?: number; readonly isCancelled?: () => boolean } = {},
): Promise<PaginatedLayerResult> {
  const maxPages = options.maxPages ?? MAX_PAGINATION_PAGES
  const items: MemoryRecord[] = []
  let cursor: string | undefined
  let tailCursor: string | undefined
  let reachedPageCap = false

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    if (options.isCancelled?.()) break
    tailCursor = cursor
    const page = await fetchPage(cursor)
    if (options.isCancelled?.()) break
    items.push(...page.items)
    if (page.nextCursor === undefined || page.nextCursor === cursor) {
      return { items, tailCursor, reachedPageCap: false }
    }
    cursor = page.nextCursor
    if (pageIndex === maxPages - 1) {
      reachedPageCap = true
    }
  }

  return { items, tailCursor, reachedPageCap }
}

function recordRecency(record: MemoryRecord): number {
  return record.tEvent || record.tIngest
}

export function sortNewestFirst(records: readonly MemoryRecord[]): MemoryRecord[] {
  return [...records].sort((a, b) => recordRecency(b) - recordRecency(a) || b.id.localeCompare(a.id))
}

export interface GraphSliceResult {
  readonly records: readonly MemoryRecord[]
  readonly truncated: boolean
}

/**
 * Selects graph records according to §8.4.3:
 * - L3: all non-tombstoned, non-archived L3 records (matching currentVersion for l3.self when known)
 * - L2: all non-tombstoned records
 * - L1: latest 500 non-tombstoned records by tEvent/tIngest descending
 * - L0: latest 1500 non-tombstoned records by tEvent/tIngest descending
 * - Total cap: 5000 nodes; `truncated` is true when L0 > 1500, L0 hit page cap, or total > 5000.
 */
export function selectGraphRecords(input: {
  readonly l3: readonly MemoryRecord[]
  readonly l2: readonly MemoryRecord[]
  readonly l1: readonly MemoryRecord[]
  readonly l0: readonly MemoryRecord[]
  readonly l0ReachedPageCap?: boolean
  readonly currentL3Version?: number
}): GraphSliceResult {
  const l3 = input.l3.filter((record) => {
    if (record.status === 'tombstoned' || record.status === 'archived') return false
    if (record.kind !== 'l3.self') return true
    return input.currentL3Version === undefined
      ? record.status === 'active'
      : record.content.profileVersion === input.currentL3Version
  })
  const l2 = input.l2.filter((record) => record.status !== 'tombstoned')
  const l1All = sortNewestFirst(input.l1.filter((record) => record.status !== 'tombstoned'))
  const l0All = sortNewestFirst(input.l0.filter((record) => record.status !== 'tombstoned'))

  const l1 = l1All.slice(0, GRAPH_L1_CAP)
  const l0 = l0All.slice(0, GRAPH_L0_CAP)
  let truncated = l0All.length > GRAPH_L0_CAP || Boolean(input.l0ReachedPageCap)

  const combined = [...l3, ...l2, ...l1, ...l0]
  if (combined.length > GRAPH_TOTAL_CAP) {
    truncated = true
    return { records: combined.slice(0, GRAPH_TOTAL_CAP), truncated }
  }
  return { records: combined, truncated }
}
