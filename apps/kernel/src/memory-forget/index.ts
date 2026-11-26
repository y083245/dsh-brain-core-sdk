import { BrainError, type ForgetReport, type ForgetSelector, type MemoryRecord } from '@brain-core/sdk'
import type { ForgetService, KeywordIndex, RecordFilter, RecordStore } from '../contracts/index.ts'

/** Forget never selects L3 directly: M3 keeps profiles out of edits and version rollback owns them. */
const FORGET_LAYERS = ['L0', 'L1', 'L2'] as const

const PAGE_LIMIT = 1000

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

/** Every status is selected: a retry has to see the tombstones left by the first attempt. */
async function selectRecords(store: RecordStore, selector: ForgetSelector): Promise<MemoryRecord[]> {
  switch (selector.by) {
    case 'record': {
      const record = await store.get(selector.id)
      return record === null || record.layer === 'L3' ? [] : [record]
    }
    case 'channel':
      return listAll(store, { layers: FORGET_LAYERS, channels: [selector.channel] })
    case 'person': {
      // The union of what is about this person and what this person said; aliases are expanded by memory-api.
      const merged = new Map<string, MemoryRecord>()
      const filters: readonly RecordFilter[] = [
        { layers: FORGET_LAYERS, subjects: [selector.personId] },
        { layers: FORGET_LAYERS, actors: [selector.personId] },
      ]
      for (const filter of filters) {
        for (const record of await listAll(store, filter)) {
          if (!merged.has(record.id)) merged.set(record.id, record)
        }
      }
      return [...merged.values()]
    }
    case 'time':
      return listAll(store, {
        layers: FORGET_LAYERS,
        from: selector.from,
        to: selector.to,
        ...(selector.channel === undefined ? {} : { channels: [selector.channel] }),
      })
  }
}

/** A tombstone is invisible in the store, so a reference to it does not keep the dependent alive. */
async function hasValidEvidence(store: RecordStore, record: MemoryRecord): Promise<boolean> {
  for (const reference of record.evidence) {
    const target = await store.get(reference.id)
    if (target !== null && target.status !== 'tombstoned') return true
  }
  return false
}

/** Marks an L3 profile outdated; a stale version is re-read and retried once (memory-api may race). */
async function flagL3(store: RecordStore, record: MemoryRecord): Promise<boolean> {
  try {
    await store.patch(record.id, { status: 'outdated' }, record.version)
    return true
  } catch (error) {
    if (!(error instanceof BrainError) || error.code !== 'CONFLICT') throw error
    const fresh = await store.get(record.id)
    if (fresh === null || fresh.status !== 'active') return false
    await store.patch(fresh.id, { status: 'outdated' }, fresh.version)
    return true
  }
}

function compareId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function createForgetService(deps: {
  readonly store: RecordStore
  readonly index: KeywordIndex
  /** Tells enhancement plugins to drop their copies (RFC S7). */
  readonly onForgotten: (ids: readonly string[]) => Promise<void>
}): ForgetService {
  return {
    async forget(selector: ForgetSelector): Promise<ForgetReport> {
      const selected = await selectRecords(deps.store, selector)

      let tombstoned = 0
      let invalidated = 0
      let l3Flagged = 0

      // Tombstones first: the cascade below sees the invalidated roots and can walk up from a retry's tombstones.
      // `queued` is also the notification set: selected records plus every L1/L2 the cascade had to tombstone.
      const queued = new Set<string>()
      for (const record of selected) {
        if (record.status !== 'tombstoned') {
          await deps.store.tombstone(record.id)
          tombstoned += 1
        }
        await deps.index.remove(record.id)
        queued.add(record.id)
      }

      const queue: string[] = [...queued]

      for (let position = 0; position < queue.length; position += 1) {
        const sourceId = queue[position] as string
        for (const dependent of await deps.store.dependentsOf(sourceId)) {
          // Selected records are pre-seeded here, so a selected record never enters the queue twice.
          if (queued.has(dependent.id)) continue

          const valid = await hasValidEvidence(deps.store, dependent)

          if (dependent.layer === 'L3') {
            // M3: L3 content is never rewritten, and L3 never enters the queue. Every sighting is re-checked,
            // because an earlier sighting may have found it alive only through a record tombstoned since.
            // A profile with no evidence left is only set aside for the next settlement; one that still has
            // evidence is left alone (FR-M12 rechecks it in v1.x). A flagged one is no longer active, so it
            // is never counted or patched twice.
            if (!valid && dependent.status === 'active' && await flagL3(deps.store, dependent)) l3Flagged += 1
            continue
          }

          if (dependent.layer !== 'L1' && dependent.layer !== 'L2') continue
          // A kept record is not remembered: another of its evidence refs may be tombstoned later in this same
          // cascade, and it must be re-checked then. It is not forgotten, so it stays out of the notification.
          if (valid) continue

          if (dependent.status !== 'tombstoned') {
            await deps.store.tombstone(dependent.id)
            invalidated += 1
          }
          await deps.index.remove(dependent.id)
          // Already tombstoned records are enqueued too, so a retry still reaches their dependents.
          queued.add(dependent.id)
          queue.push(dependent.id)
        }
      }

      const ids = [...queued].sort(compareId)
      if (ids.length > 0) await deps.onForgotten(ids)

      return { tombstoned, invalidated, l3Flagged }
    },
  }
}
