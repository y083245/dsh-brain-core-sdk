import {
  BrainError,
  type BrainContext,
  type MemoryProvider,
  type MemoryProviderHealth,
  type MemoryProviderHit,
  type MemoryProviderQuery,
  type MemoryRecord,
  type PluginApply,
} from '@dsh-brain-core/sdk'
import { BvecStore } from './bvec.ts'
import { createHashEmbedder, createHttpEmbedder, type Embedder } from './embedder.ts'

export { BvecStore, quantizeVector, type BvecHeader, type BvecMeta, type BvecQueryFilter } from './bvec.ts'
export {
  createHashEmbedder,
  createHttpEmbedder,
  type Embedder,
  type EmbedResult,
  type HashEmbedderOptions,
  type HttpEmbedderOptions,
} from './embedder.ts'

const VECTORS_FILE = 'vectors.bvec'
const META_FILE = 'meta.json'
const PAGE_LIMIT = 100
const MAX_EXTRACT_DEPTH = 4

export interface MemoryVectorConfig {
  readonly endpoint?: string
  readonly modelName?: string
  readonly dimension?: number
  readonly normalized?: boolean
  readonly apiKeySecret?: string
  readonly apiKey?: string
  readonly timeoutMs?: number
}

function collectStrings(value: unknown, depth: number, out: string[]): void {
  if (depth > MAX_EXTRACT_DEPTH || value === null || value === undefined) return
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed !== '') out.push(trimmed)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, depth + 1, out)
    return
  }
  if (typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      collectStrings(entry, depth + 1, out)
    }
  }
}

function extractText(content: Readonly<Record<string, unknown>>): string {
  const parts: string[] = []
  collectStrings(content, 0, parts)
  return parts.join(' ')
}

function assertEmbedMatchesHeader(
  modelName: string,
  vectorLength: number,
  expectedModel: string,
  expectedDimension: number,
): void {
  if (modelName !== expectedModel || vectorLength !== expectedDimension) {
    throw new BrainError(
      'EMBEDDING_MISMATCH',
      `embedding mismatch: expected (${expectedModel}, dim=${expectedDimension}), got (${modelName}, dim=${vectorLength})`,
    )
  }
}

async function resolveEmbedder(
  ctx: BrainContext<MemoryVectorConfig>,
  config: MemoryVectorConfig,
): Promise<Embedder> {
  const hasEndpoint = typeof config.endpoint === 'string' && config.endpoint.trim() !== ''
  const normalized = config.normalized ?? true
  if (hasEndpoint) {
    let apiKey = typeof config.apiKey === 'string' && config.apiKey !== '' ? config.apiKey : undefined
    if (apiKey === undefined && typeof config.apiKeySecret === 'string' && config.apiKeySecret !== '') {
      apiKey = await ctx.secrets.get(config.apiKeySecret)
    }
    return createHttpEmbedder({
      endpoint: config.endpoint!,
      modelName: config.modelName ?? 'text-embedding-3-small',
      dimension: config.dimension ?? 1024,
      normalized,
      ...(apiKey === undefined ? {} : { apiKey }),
      fetch: ctx.http.fetch,
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    })
  }
  return createHashEmbedder({
    modelName: config.modelName ?? 'hash-ngram-v1',
    dimension: config.dimension ?? 256,
  })
}

export async function createVectorProvider(
  ctx: BrainContext<MemoryVectorConfig>,
  config: MemoryVectorConfig = ctx.config ?? {},
  customEmbedder?: Embedder,
): Promise<MemoryProvider> {
  const embedder = customEmbedder ?? await resolveEmbedder(ctx, config)
  const expected = {
    modelName: embedder.modelName,
    dimension: embedder.dimension,
    normalized: embedder.normalized,
  }

  let store: BvecStore | undefined
  let mismatchError: BrainError | undefined

  const rawVectors = await ctx.storage.read(VECTORS_FILE)
  const rawMeta = await ctx.storage.read(META_FILE)
  const metaText = rawMeta === undefined ? undefined : new TextDecoder().decode(rawMeta)

  if (rawVectors !== undefined) {
    try {
      store = BvecStore.load(rawVectors, metaText, expected)
    } catch (error) {
      if (error instanceof BrainError && error.code === 'EMBEDDING_MISMATCH') {
        mismatchError = error
        ctx.logger.error('memory_vector.embedding_mismatch', {
          model: expected.modelName,
          dimension: expected.dimension,
        })
      } else {
        throw error
      }
    }
  } else {
    store = BvecStore.create(expected)
  }

  let writeTail: Promise<void> = Promise.resolve()
  const serialized = <T>(task: () => Promise<T>): Promise<T> => {
    const run = writeTail.then(task)
    writeTail = run.then(() => undefined, () => undefined)
    return run
  }

  async function persist(activeStore: BvecStore): Promise<void> {
    const { vectors, metaJson } = activeStore.encode()
    await ctx.storage.write(VECTORS_FILE, vectors)
    await ctx.storage.write(META_FILE, metaJson)
  }

  async function indexRecord(activeStore: BvecStore, record: MemoryRecord): Promise<boolean> {
    if (record.status !== 'active' || record.layer === 'L3') return false
    const text = extractText(record.content)
    if (text === '') return false
    const result = await embedder.embed(text)
    assertEmbedMatchesHeader(result.modelName, result.vector.length, activeStore.header.modelName, activeStore.header.dimension)
    activeStore.upsert(record.id, result.vector, {
      layer: record.layer,
      channel: record.channel,
      tEvent: record.tEvent,
      subjects: record.subjects,
    })
    return true
  }

  if (store !== undefined) {
    let changed = rawVectors === undefined
    let afterId: string | undefined
    for (;;) {
      const page = await ctx.memory.readL0({
        limit: PAGE_LIMIT,
        ...(afterId === undefined ? {} : { afterId }),
      })
      for (const record of page.items) {
        if (store.has(record.id)) continue
        if (await indexRecord(store, record)) changed = true
      }
      if (page.nextCursor === undefined || page.items.length === 0 || page.nextCursor === afterId) {
        break
      }
      afterId = page.nextCursor
    }
    if (changed) {
      await serialized(() => persist(store!))
    }
  }

  return {
    async search(query: MemoryProviderQuery): Promise<readonly MemoryProviderHit[]> {
      if (mismatchError !== undefined) throw mismatchError
      const activeStore = store!
      const embedded = await embedder.embed(query.query)
      assertEmbedMatchesHeader(
        embedded.modelName,
        embedded.vector.length,
        activeStore.header.modelName,
        activeStore.header.dimension,
      )
      return activeStore.search(embedded.vector, {
        ...(query.layers === undefined ? {} : { layers: query.layers }),
        ...(query.channels === undefined ? {} : { channels: query.channels }),
        ...(query.subjects === undefined ? {} : { subjects: query.subjects }),
        ...(query.from === undefined ? {} : { from: query.from }),
        ...(query.to === undefined ? {} : { to: query.to }),
        limit: query.limit,
      })
    },

    async onRecord(record: MemoryRecord): Promise<void> {
      if (mismatchError !== undefined) throw mismatchError
      const activeStore = store!
      await serialized(async () => {
        if (record.status !== 'active') {
          if (activeStore.forget([record.id]) > 0) await persist(activeStore)
          return
        }
        if (await indexRecord(activeStore, record)) {
          await persist(activeStore)
        }
      })
    },

    async onForgotten(ids: readonly string[]): Promise<void> {
      if (ids.length === 0 || mismatchError !== undefined || store === undefined) return
      const activeStore = store
      await serialized(async () => {
        if (activeStore.forget(ids) > 0) {
          await persist(activeStore)
        }
      })
    },

    async health(): Promise<MemoryProviderHealth> {
      if (mismatchError !== undefined || store === undefined) {
        return {
          status: 'down',
          model: expected.modelName,
          dimension: expected.dimension,
        }
      }
      return {
        status: 'ok',
        model: store.header.modelName,
        dimension: store.header.dimension,
      }
    },
  }
}

export const apply: PluginApply<MemoryVectorConfig> = async (ctx, config) => {
  const provider = await createVectorProvider(ctx, config)
  ctx.memory.provide(provider)
}
