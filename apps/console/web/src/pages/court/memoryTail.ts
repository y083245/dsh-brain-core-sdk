import { memoryApi } from '../../api/client.ts'
import type { Layer, MemoryRecord } from '../../api/types.ts'
import { inktideStore } from '../../data/store.ts'

export const DAY_MS = 24 * 60 * 60 * 1000

const TAIL_LAYERS: readonly Layer[] = ['L0', 'L1', 'L2', 'L3']
const PAGE_LIMIT = 200
const MAX_PAGES_PER_LAYER = 50
const RECENT_FLOW_LIMIT = 20

export interface RecentMemoryTail {
  readonly capturedAt: number
  /** Non-tombstoned records from the tail pages across all layers. */
  readonly tailRecords: readonly MemoryRecord[]
  /** Latest up to 20 non-tombstoned records within the last 24h, sorted ascending by tIngest. */
  readonly recentRecords: readonly MemoryRecord[]
  /** True when the store contains historical records even if none are in the last 24h. */
  readonly hasHistory: boolean
}

interface LayerTailResult {
  readonly items: readonly MemoryRecord[]
  readonly hasAnyRecords: boolean
}

/**
 * Memory records are ordered by `id` (`l0_<ulid>` < `l1_<ulid>` < `l2_<ulid>` < `l3_<ulid>`).
 * Caching each layer's penultimate page cursor ensures every 10s poll fetches at most 1-2 pages
 * per layer and never misses newly ingested lower-layer records (such as new L0 turns).
 */
const penultimateCursors = new Map<Layer, string | undefined>()

export function resetMemoryTailCache(): void {
  penultimateCursors.clear()
}

inktideStore.subscribe(() => {
  if (!inktideStore.getSnapshot().authenticated && penultimateCursors.size > 0) {
    resetMemoryTailCache()
  }
})

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }
}

async function fetchLayerTail(layer: Layer, signal?: AbortSignal): Promise<LayerTailResult> {
  const initialCachedCursor = penultimateCursors.get(layer)
  let cursor = initialCachedCursor
  let prevCursor: string | undefined
  let currCursor: string | undefined = cursor
  let prevItems: readonly MemoryRecord[] = []
  let currItems: readonly MemoryRecord[] = []
  let pagesFetched = 0
  let restartedFromStart = false

  while (pagesFetched < MAX_PAGES_PER_LAYER) {
    throwIfAborted(signal)
    const page = await memoryApi.browse({
      layer,
      limit: PAGE_LIMIT,
      ...(cursor === undefined ? {} : { cursor }),
    })
    pagesFetched += 1

    // If a cached cursor points past the end of a reset store, restart once from the beginning.
    if (
      pagesFetched === 1 &&
      cursor !== undefined &&
      page.items.length === 0 &&
      page.nextCursor === undefined &&
      !restartedFromStart
    ) {
      penultimateCursors.delete(layer)
      restartedFromStart = true
      cursor = undefined
      prevCursor = undefined
      currCursor = undefined
      prevItems = []
      currItems = []
      pagesFetched = 0
      continue
    }

    prevItems = currItems
    currItems = page.items

    if (page.nextCursor === undefined || page.nextCursor === cursor) {
      penultimateCursors.set(layer, pagesFetched >= 2 ? prevCursor : currCursor)
      break
    }

    prevCursor = currCursor
    currCursor = page.nextCursor
    cursor = page.nextCursor

    if (pagesFetched === MAX_PAGES_PER_LAYER) {
      penultimateCursors.set(layer, prevCursor)
    }
  }

  const deduped = new Map<string, MemoryRecord>()
  for (const item of prevItems) deduped.set(item.id, item)
  for (const item of currItems) deduped.set(item.id, item)

  const items = [...deduped.values()]
  const hasAnyRecords = items.length > 0 || (initialCachedCursor !== undefined && !restartedFromStart)
  return { items, hasAnyRecords }
}

export async function fetchRecentMemoryTail(signal?: AbortSignal): Promise<RecentMemoryTail> {
  const layerResults = await Promise.all(
    TAIL_LAYERS.map((layer) => fetchLayerTail(layer, signal)),
  )
  throwIfAborted(signal)

  const merged = new Map<string, MemoryRecord>()
  let hasAnyStored = false
  for (const result of layerResults) {
    if (result.hasAnyRecords) hasAnyStored = true
    for (const record of result.items) {
      if (record.status !== 'tombstoned') {
        merged.set(record.id, record)
      }
    }
  }

  const capturedAt = Date.now()
  const tailRecords = [...merged.values()]
  const cutoff = capturedAt - DAY_MS
  const recentRecords = tailRecords
    .filter((record) => record.tIngest >= cutoff)
    .sort((left, right) => right.tIngest - left.tIngest || right.id.localeCompare(left.id))
    .slice(0, RECENT_FLOW_LIMIT)
    .sort((left, right) => left.tIngest - right.tIngest || left.id.localeCompare(right.id))

  return {
    capturedAt,
    tailRecords,
    recentRecords,
    hasHistory: tailRecords.length > 0 || hasAnyStored,
  }
}
