import {
  BrainError,
  type MemoryProvider,
  type MemoryProviderHit,
  type MemoryProviderQuery,
  type MemoryRecord,
} from '@brain-core/sdk'
import type { MemoryProviderRegistry, MemoryProviderSearchResult } from '../contracts/index.ts'
import type { Logger } from '../log/index.ts'

const DEFAULT_TIMEOUT_MS = 1500
const DEFAULT_RRF_K = 60

export interface MemoryProviderRegistryOptions {
  readonly timeoutMs?: number
  readonly log?: Logger
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function errorCodeOf(error: unknown): string {
  return error instanceof BrainError ? error.code : 'INTERNAL'
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new BrainError('UNAVAILABLE', message))
    }, ms)
    timer.unref?.()
  })
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/**
 * Merges ranked hit lists using Reciprocal Rank Fusion (`1 / (k + rank + 1)`),
 * returning deduplicated hits sorted by fused score descending, then `id` ascending.
 */
export function fuseRankings(
  lists: readonly (readonly MemoryProviderHit[])[],
  k = DEFAULT_RRF_K,
): readonly MemoryProviderHit[] {
  const scores = new Map<string, number>()
  for (const list of lists) {
    if (list.length === 0) continue
    for (let rank = 0; rank < list.length; rank += 1) {
      const hit = list[rank]
      if (hit === undefined || typeof hit.id !== 'string' || hit.id === '') continue
      const increment = 1 / (k + rank + 1)
      scores.set(hit.id, (scores.get(hit.id) ?? 0) + increment)
    }
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      return compareIds(left.id, right.id)
    })
}

/**
 * Creates the kernel registry coordinating external and in-process memory providers
 * with timeout isolation, RRF fusion, and strict EMBEDDING_MISMATCH passthrough.
 */
export function createMemoryProviderRegistry(options: MemoryProviderRegistryOptions = {}): MemoryProviderRegistry {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const log = options.log
  const providers = new Map<string, MemoryProvider>()

  return {
    register(pluginId, provider) {
      if (providers.has(pluginId)) {
        throw new BrainError('CONFLICT', `memory provider "${pluginId}" is already registered`)
      }
      providers.set(pluginId, provider)
      let active = true
      return () => {
        if (!active) return
        active = false
        if (providers.get(pluginId) === provider) {
          providers.delete(pluginId)
        }
      }
    },

    hasProviders() {
      return providers.size > 0
    },

    listIds() {
      return [...providers.keys()].sort(compareIds)
    },

    async search(query: MemoryProviderQuery): Promise<MemoryProviderSearchResult> {
      if (providers.size === 0) {
        return { hits: [], degraded: false, active: false }
      }
      let degraded = false
      const entries = [...providers.entries()]
      const lists = await Promise.all(
        entries.map(async ([pluginId, provider]): Promise<readonly MemoryProviderHit[]> => {
          try {
            const raw = await withTimeout(
              Promise.resolve().then(() => provider.search(query)),
              timeoutMs,
              `memory provider "${pluginId}" search timed out`,
            )
            return Array.isArray(raw) ? raw : []
          } catch (error) {
            if (error instanceof BrainError && error.code === 'EMBEDDING_MISMATCH') {
              throw error
            }
            degraded = true
            log?.warn('memory_provider.search_failed', { plugin: pluginId, code: errorCodeOf(error) })
            return []
          }
        }),
      )
      return {
        hits: fuseRankings(lists),
        degraded,
        active: true,
      }
    },

    async notifyRecorded(record: MemoryRecord): Promise<void> {
      if (record.status !== 'active' || record.layer === 'L3' || providers.size === 0) {
        return
      }
      const entries = [...providers.entries()]
      await Promise.all(
        entries.map(async ([pluginId, provider]) => {
          if (typeof provider.onRecord !== 'function') return
          try {
            await withTimeout(
              Promise.resolve().then(() => provider.onRecord!(record)),
              timeoutMs,
              `memory provider "${pluginId}" onRecord timed out`,
            )
          } catch (error) {
            log?.warn('memory_provider.record_failed', {
              plugin: pluginId,
              recordId: record.id,
              code: errorCodeOf(error),
            })
          }
        }),
      )
    },

    async notifyForgotten(ids: readonly string[]): Promise<void> {
      if (ids.length === 0 || providers.size === 0) return
      const frozenIds = [...ids]
      const entries = [...providers.entries()]
      await Promise.all(
        entries.map(async ([pluginId, provider]) => {
          try {
            await withTimeout(
              Promise.resolve().then(() => provider.onForgotten(frozenIds)),
              timeoutMs,
              `memory provider "${pluginId}" onForgotten timed out`,
            )
          } catch (error) {
            log?.warn('memory_provider.forget_failed', {
              plugin: pluginId,
              count: frozenIds.length,
              code: errorCodeOf(error),
            })
          }
        }),
      )
    },

    async health(): Promise<'ok' | 'degraded' | 'down' | undefined> {
      if (providers.size === 0) return undefined
      const entries = [...providers.entries()]
      const statuses = await Promise.all(
        entries.map(async ([pluginId, provider]): Promise<'ok' | 'degraded' | 'down'> => {
          if (typeof provider.health !== 'function') return 'ok'
          try {
            const report = await withTimeout(
              Promise.resolve().then(() => provider.health!()),
              timeoutMs,
              `memory provider "${pluginId}" health timed out`,
            )
            if (report?.status === 'ok' || report?.status === 'degraded' || report?.status === 'down') {
              return report.status
            }
            return 'degraded'
          } catch (error) {
            log?.warn('memory_provider.health_failed', { plugin: pluginId, code: errorCodeOf(error) })
            return 'degraded'
          }
        }),
      )
      if (statuses.every((status) => status === 'ok')) return 'ok'
      if (statuses.includes('down') && !statuses.includes('ok')) return 'down'
      return 'degraded'
    },
  }
}
