import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { BrainError } from '@dsh-brain-core/sdk'
import type { EvidenceRef } from '@dsh-brain-core/sdk'
import { createUlid, ensurePrivateDir, writeFileAtomic } from '@dsh-brain-core/shared'
import type { Clock, WorkingMemoryInput, WorkingMemoryItem, WorkingMemoryStore } from '../contracts/index.ts'

export const MAX_WORKING_MEMORY_TTL_MS = 86_400_000

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function cloneEvidence(evidence: readonly EvidenceRef[] | undefined): readonly EvidenceRef[] | undefined {
  return evidence === undefined ? undefined : evidence.map((ref) => ({ id: ref.id }))
}

function cloneItem(item: WorkingMemoryItem): WorkingMemoryItem {
  return {
    id: item.id,
    channel: item.channel,
    key: item.key,
    text: item.text,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    expiresAt: item.expiresAt,
    ...(item.promoteToL1 !== undefined ? { promoteToL1: item.promoteToL1 } : {}),
    ...(item.evidence !== undefined ? { evidence: cloneEvidence(item.evidence) } : {}),
  }
}

function isValidStoredItem(value: unknown): value is WorkingMemoryItem {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  if (
    !isNonEmptyString(item.id)
    || !isNonEmptyString(item.channel)
    || !isNonEmptyString(item.key)
    || !isNonEmptyString(item.text)
    || typeof item.createdAt !== 'number' || !Number.isFinite(item.createdAt)
    || typeof item.updatedAt !== 'number' || !Number.isFinite(item.updatedAt)
    || typeof item.expiresAt !== 'number' || !Number.isFinite(item.expiresAt)
  ) {
    return false
  }
  if (item.promoteToL1 !== undefined && typeof item.promoteToL1 !== 'boolean') return false
  if (item.evidence !== undefined) {
    if (!Array.isArray(item.evidence)) return false
    for (const ref of item.evidence) {
      if (typeof ref !== 'object' || ref === null || !isNonEmptyString((ref as Record<string, unknown>).id)) {
        return false
      }
    }
  }
  return true
}

function parsePersistedItems(raw: string): WorkingMemoryItem[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new BrainError('UNAVAILABLE', 'working memory file is unreadable')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BrainError('UNAVAILABLE', 'working memory file is unreadable')
  }
  const items = (parsed as Record<string, unknown>).items
  if (!Array.isArray(items)) {
    throw new BrainError('UNAVAILABLE', 'working memory file is unreadable')
  }
  const result: WorkingMemoryItem[] = []
  for (const item of items) {
    if (!isValidStoredItem(item)) {
      throw new BrainError('UNAVAILABLE', 'working memory file is unreadable')
    }
    result.push(cloneItem(item))
  }
  return result
}

function compareItems(left: WorkingMemoryItem, right: WorkingMemoryItem): number {
  if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

/** Creates a per-channel short-term working memory store with TTL <= 24h (FR-M17, RFC M7). */
export function createWorkingMemoryStore(deps: {
  readonly clock: Clock
  readonly filePath?: string
}): WorkingMemoryStore {
  const nextUlid = createUlid({ now: () => deps.clock.now() })
  const items = new Map<string, WorkingMemoryItem>()
  let loaded = deps.filePath === undefined
  let queue: Promise<unknown> = Promise.resolve()

  function serialized<T>(run: () => Promise<T>): Promise<T> {
    const next = queue.then(run, run)
    queue = next.catch(() => undefined)
    return next
  }

  async function ensureLoaded(): Promise<void> {
    if (loaded || deps.filePath === undefined) return
    let raw: string
    try {
      raw = await readFile(deps.filePath, 'utf8')
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        loaded = true
        return
      }
      throw new BrainError('UNAVAILABLE', 'working memory file is unreadable')
    }
    const parsed = parsePersistedItems(raw)
    items.clear()
    for (const item of parsed) {
      items.set(item.id, item)
    }
    loaded = true
  }

  async function persist(): Promise<void> {
    if (deps.filePath === undefined) return
    await ensurePrivateDir(path.dirname(deps.filePath))
    const payload = JSON.stringify({ items: [...items.values()] }, null, 2) + '\n'
    await writeFileAtomic(deps.filePath, payload)
  }

  function findActiveByChannelKey(channel: string, key: string, now: number): WorkingMemoryItem | undefined {
    for (const item of items.values()) {
      if (item.channel === channel && item.key === key && item.expiresAt > now) {
        return item
      }
    }
    return undefined
  }

  return {
    put(input: WorkingMemoryInput): Promise<WorkingMemoryItem> {
      return serialized(async () => {
        if (!isNonEmptyString(input.channel)) {
          throw new BrainError('INVALID_ARGUMENT', 'working memory channel must be a non-empty string')
        }
        if (!isNonEmptyString(input.key)) {
          throw new BrainError('INVALID_ARGUMENT', 'working memory key must be a non-empty string')
        }
        if (!isNonEmptyString(input.text)) {
          throw new BrainError('INVALID_ARGUMENT', 'working memory text must be a non-empty string')
        }
        const ttlMs = input.ttlMs ?? MAX_WORKING_MEMORY_TTL_MS
        if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_WORKING_MEMORY_TTL_MS) {
          throw new BrainError('INVALID_ARGUMENT', 'working memory ttlMs must be in (0, 86400000]')
        }
        if (input.promoteToL1 === true && (!Array.isArray(input.evidence) || input.evidence.length === 0)) {
          throw new BrainError('INVALID_ARGUMENT', 'promoteToL1 requires at least one evidence reference')
        }

        await ensureLoaded()
        const now = deps.clock.now()
        const existing = findActiveByChannelKey(input.channel, input.key, now)
        const evidence = cloneEvidence(input.evidence)
        const item: WorkingMemoryItem = {
          id: existing !== undefined ? existing.id : `wm_${nextUlid()}`,
          channel: input.channel,
          key: input.key,
          text: input.text,
          createdAt: existing !== undefined ? existing.createdAt : now,
          updatedAt: now,
          expiresAt: now + ttlMs,
          ...(input.promoteToL1 !== undefined ? { promoteToL1: input.promoteToL1 } : {}),
          ...(evidence !== undefined ? { evidence } : {}),
        }
        items.set(item.id, item)
        await persist()
        return cloneItem(item)
      })
    },

    listActive(channel: string, now?: number): Promise<readonly WorkingMemoryItem[]> {
      return serialized(async () => {
        await ensureLoaded()
        const effectiveNow = now ?? deps.clock.now()
        const active: WorkingMemoryItem[] = []
        for (const item of items.values()) {
          if (item.channel === channel && item.expiresAt > effectiveNow) {
            active.push(cloneItem(item))
          }
        }
        active.sort(compareItems)
        return active
      })
    },

    remove(id: string): Promise<boolean> {
      return serialized(async () => {
        await ensureLoaded()
        if (!items.delete(id)) return false
        await persist()
        return true
      })
    },

    sweep(now?: number, promote?: (item: WorkingMemoryItem) => Promise<void>): Promise<{
      readonly dropped: number
      readonly promoted: number
    }> {
      return serialized(async () => {
        await ensureLoaded()
        const effectiveNow = now ?? deps.clock.now()
        const expired = [...items.values()]
          .filter((item) => item.expiresAt <= effectiveNow)
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

        let dropped = 0
        let promoted = 0
        for (const item of expired) {
          if (
            item.promoteToL1 === true
            && item.evidence !== undefined
            && item.evidence.length > 0
            && promote !== undefined
          ) {
            try {
              await promote(cloneItem(item))
              promoted += 1
            } catch {
              // Promotion failure must not leave expired working memory behind.
            }
          }
          items.delete(item.id)
          dropped += 1
        }
        if (dropped > 0) await persist()
        return { dropped, promoted }
      })
    },
  }
}
