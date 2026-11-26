import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { BrainError, type BrainContext, type MemoryRecord } from '@brain-core/sdk'
import { checkPlugin, createTestKernel, runPluginContractTests } from '@brain-core/testkit'
import {
  apply,
  BvecStore,
  createHashEmbedder,
  createHttpEmbedder,
  createVectorProvider,
  type Embedder,
} from '../src/index.ts'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function readManifest(): Promise<{ readonly dependencies: Record<string, string>; readonly brain: unknown }> {
  const raw = await readFile(path.join(PLUGIN_ROOT, 'package.json'), 'utf8')
  return JSON.parse(raw) as { readonly dependencies: Record<string, string>; readonly brain: unknown }
}

function makeL0(id: string, text: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id,
    layer: 'L0',
    kind: 'qq.message',
    source: 'qq',
    channel: 'qq:private:1',
    subjects: ['alice'],
    actor: 'alice',
    content: { text },
    evidence: [],
    visibility: 'origin',
    trust: 'member',
    confidence: 1,
    importance: 0.5,
    tEvent: 1000,
    tIngest: 1000,
    status: 'active',
    version: 1,
    ...overrides,
  }
}

function float32Cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!
    normA += a[i]! * a[i]!
    normB += b[i]! * b[i]!
  }
  if (normA === 0 || normB === 0) return 0
  return dot / Math.sqrt(normA * normB)
}

test('contract tests, checkPlugin (0 must / 0 should), and SDK-only runtime dependency pass', async () => {
  const pkg = await readManifest()
  assert.deepEqual(Object.keys(pkg.dependencies), ['@brain-core/sdk'])

  const contractResults = await runPluginContractTests({ apply }, pkg.brain)
  for (const result of contractResults) {
    assert.equal(result.ok, true, `${result.name}: ${result.message}`)
  }

  const report = await checkPlugin(PLUGIN_ROOT)
  assert.equal(report.ok, true, JSON.stringify(report.findings, null, 2))
  assert.equal(report.findings.filter((f) => f.level === 'must').length, 0)
  assert.equal(report.findings.filter((f) => f.level === 'should').length, 0)
})

test('BVEC v1 encoding achieves ~25% of Float32 size and high Top-5 quantization recall parity', async () => {
  const dim = 1024
  const embedder = createHashEmbedder({ modelName: 'hash-1024', dimension: dim })
  const store = BvecStore.create({ modelName: 'hash-1024', dimension: dim, normalized: true })

  const docs: readonly [string, string][] = [
    ['d1', '周六早上在杭州西湖边喝龙井茶看日出'],
    ['d2', '西湖龙井茶清香回甘适合清晨饮用'],
    ['d3', '杭州的春天适合去西湖散步和品茶'],
    ['d4', '我最喜欢喝冰美式咖啡配牛角面包'],
    ['d5', '早晨一杯手冲咖啡让人精神焕发'],
    ['d6', '下午在图书馆学习线性代数与矩阵分解'],
    ['d7', '线性代数里的特征值和奇异值非常重要'],
    ['d8', '晚上去健身房跑五公里并做力量训练'],
    ['d9', '周末约朋友去海边露营看星空'],
    ['d10', '深夜写 TypeScript 代码和单元测试'],
  ]

  const floatVectors = new Map<string, Float32Array>()
  for (const [id, text] of docs) {
    const { vector } = await embedder.embed(text)
    floatVectors.set(id, vector)
    store.upsert(id, vector, { layer: 'L0', channel: 'qq:private:1', tEvent: 1000, subjects: ['alice'] })
  }

  const { vectors, metaJson } = store.encode()
  const float32TotalBytes = docs.length * dim * 4
  const ratio = vectors.byteLength / float32TotalBytes
  // At dim=1024, 10 rows * 1029B + small header is ~25.2% of Float32
  assert.ok(ratio >= 0.24 && ratio <= 0.28, `expected ~25-28% size ratio, got ${(ratio * 100).toFixed(2)}%`)
  assert.equal(metaJson.includes('龙井茶'), false)
  assert.equal(metaJson.includes('牛角面包'), false)

  const queryText = '杭州西湖清晨喝龙井茶'
  const { vector: qVec } = await embedder.embed(queryText)

  const floatTop5 = [...floatVectors.entries()]
    .map(([id, vec]) => ({ id, score: float32Cosine(qVec, vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((x) => x.id)

  const bvecTop5 = store.search(qVec, { limit: 5 }).map((x) => x.id)
  const overlap = bvecTop5.filter((id) => floatTop5.includes(id)).length
  assert.ok(overlap >= 4, `expected Top-5 overlap >= 4, got ${overlap} (float=${floatTop5}, bvec=${bvecTop5})`)
  assert.equal(bvecTop5[0], floatTop5[0])
})

test('BvecStore.load throws EMBEDDING_MISMATCH on same dimension with different modelName, and apply enters mismatch state', async () => {
  const embedderA = createHashEmbedder({ modelName: 'model-a', dimension: 256 })
  const storeA = BvecStore.create({ modelName: 'model-a', dimension: 256, normalized: true })
  const { vector } = await embedderA.embed('测试文本')
  storeA.upsert('r1', vector, { layer: 'L0', channel: 'qq:private:1', tEvent: 100, subjects: ['self'] })
  const encoded = storeA.encode()

  assert.throws(
    () => BvecStore.load(encoded.vectors, encoded.metaJson, { modelName: 'model-b', dimension: 256, normalized: true }),
    (err: unknown) => err instanceof BrainError && err.code === 'EMBEDDING_MISMATCH',
  )
  assert.throws(
    () => BvecStore.load(encoded.vectors, encoded.metaJson, { modelName: 'model-a', dimension: 128, normalized: true }),
    (err: unknown) => err instanceof BrainError && err.code === 'EMBEDDING_MISMATCH',
  )
  assert.throws(
    () => BvecStore.load(encoded.vectors, encoded.metaJson, { modelName: 'model-a', dimension: 256, normalized: false }),
    (err: unknown) => err instanceof BrainError && err.code === 'EMBEDDING_MISMATCH',
  )

  const pkg = await readManifest()
  const kernel = createTestKernel()
  await kernel.loadPlugin({
    apply: async (ctx) => {
      await ctx.storage.write('vectors.bvec', encoded.vectors)
      await ctx.storage.write('meta.json', encoded.metaJson)
      await apply(ctx, { modelName: 'model-b', dimension: 256 })
    },
  }, pkg.brain, { config: { modelName: 'model-b', dimension: 256 } })

  const provider = kernel.memoryProviders()[0]!
  assert.equal((await provider.health?.())?.status, 'down')
  await assert.rejects(
    () => provider.search({ query: '测试', limit: 5 }),
    (err: unknown) => err instanceof BrainError && err.code === 'EMBEDDING_MISMATCH',
  )
})

test('query-time embedder calibration change throws EMBEDDING_MISMATCH', async () => {
  let activeModel = 'model-v1'
  let activeDim = 64
  const dynamicEmbedder: Embedder = {
    get modelName() { return activeModel },
    get dimension() { return activeDim },
    normalized: true,
    async embed(text: string) {
      return createHashEmbedder({ modelName: activeModel, dimension: activeDim }).embed(text)
    },
  }

  const pkg = await readManifest()
  const kernel = createTestKernel()
  let capturedCtx: BrainContext | undefined
  await kernel.loadPlugin({
    apply: async (ctx) => {
      capturedCtx = ctx
      const provider = await createVectorProvider(ctx, {}, dynamicEmbedder)
      ctx.memory.provide(provider)
    },
  }, pkg.brain)

  const provider = kernel.memoryProviders()[0]!
  await provider.onRecord?.(makeL0('r1', '苹果和香蕉'))
  assert.equal((await provider.search({ query: '苹果', limit: 5 }))[0]?.id, 'r1')

  // Model name changes at query time while index header stays model-v1
  activeModel = 'model-v2'
  await assert.rejects(
    () => provider.search({ query: '苹果', limit: 5 }),
    (err: unknown) => err instanceof BrainError && err.code === 'EMBEDDING_MISMATCH',
  )

  // Dimension changes at query time
  activeModel = 'model-v1'
  activeDim = 128
  await assert.rejects(
    () => provider.search({ query: '苹果', limit: 5 }),
    (err: unknown) => err instanceof BrainError && err.code === 'EMBEDDING_MISMATCH',
  )
  assert.ok(capturedCtx !== undefined)
})

test('onForgotten zeroes every byte of the slot in vectors.bvec and removes metadata without storing raw text', async () => {
  const pkg = await readManifest()
  const kernel = createTestKernel()
  let storageRef: BrainContext['storage'] | undefined

  await kernel.loadPlugin({
    apply: async (ctx, config) => {
      storageRef = ctx.storage
      await apply(ctx, config)
    },
  }, pkg.brain, { config: { modelName: 'hash-64', dimension: 64 } })

  const provider = kernel.memoryProviders()[0]!
  const secretPhrase = '绝密暗号：蓝莓千层蛋糕'
  await provider.onRecord?.(makeL0('secret_1', secretPhrase))
  await provider.onRecord?.(makeL0('keep_2', '普通日常散步记录'))

  assert.equal((await provider.search({ query: '蓝莓千层蛋糕', limit: 5 }))[0]?.id, 'secret_1')

  const beforeMeta = new TextDecoder().decode(await storageRef!.read('meta.json'))
  assert.equal(beforeMeta.includes(secretPhrase), false)
  assert.equal(beforeMeta.includes('蓝莓'), false)
  assert.equal(beforeMeta.includes('secret_1'), true)

  // Forget secret_1
  await provider.onForgotten(['secret_1'])

  const afterForget = await provider.search({ query: '蓝莓千层蛋糕', limit: 5 })
  assert.equal(afterForget.some((hit) => hit.id === 'secret_1'), false)
  assert.equal((await provider.search({ query: '散步', limit: 5 }))[0]?.id, 'keep_2')

  const afterMeta = new TextDecoder().decode(await storageRef!.read('meta.json'))
  assert.equal(afterMeta.includes('secret_1'), false)
  assert.equal(afterMeta.includes(secretPhrase), false)

  // Inspect raw vectors.bvec bytes for slot 0: active(1B) + scale(4B) + Int8(64B) must all be 0x00!
  const rawBvec = (await storageRef!.read('vectors.bvec'))!
  const modelBytes = new TextEncoder().encode('hash-64')
  const headerSize = 18 + modelBytes.byteLength
  const rowStride = 1 + 4 + 64
  const slot0 = rawBvec.subarray(headerSize, headerSize + rowStride)
  assert.equal(slot0.every((byte) => byte === 0), true, 'forgotten slot must be completely zeroed')

  // Slot 1 (keep_2) remains active
  const slot1 = rawBvec.subarray(headerSize + rowStride, headerSize + rowStride * 2)
  assert.equal(slot1[0], 1)
})

test('createHttpEmbedder routes exclusively through ctx.http.fetch and validates returned model and dimension', async () => {
  const pkg = await readManifest()
  const kernel = createTestKernel()
  const endpoint = 'https://embed.example.com/v1/embeddings'

  let responseModel = 'embed-pro'
  let responseVec = [0.6, 0.8, 0, 0]
  kernel.setResponse(endpoint, {
    status: 200,
    body: JSON.stringify({ model: responseModel, data: [{ embedding: responseVec }] }),
  })

  await kernel.loadPlugin(
    { apply },
    pkg.brain,
    { config: { endpoint, modelName: 'embed-pro', dimension: 4 } },
  )

  const provider = kernel.memoryProviders()[0]!
  await provider.onRecord?.(makeL0('h1', 'hello http embedder'))
  const hits = await provider.search({ query: 'hello', limit: 5 })
  assert.equal(hits[0]?.id, 'h1')
  assert.ok(kernel.calls.some((c) => c.method === 'http.fetch' && c.args[0] === endpoint))

  // Mismatched model returned by server
  responseModel = 'other-model'
  kernel.setResponse(endpoint, {
    status: 200,
    body: JSON.stringify({ model: responseModel, data: [{ embedding: responseVec }] }),
  })
  await assert.rejects(
    () => provider.search({ query: 'hello', limit: 5 }),
    (err: unknown) => err instanceof BrainError && err.code === 'EMBEDDING_MISMATCH',
  )

  // Mismatched dimension returned by server
  responseModel = 'embed-pro'
  responseVec = [1, 0]
  kernel.setResponse(endpoint, {
    status: 200,
    body: JSON.stringify({ model: responseModel, data: [{ embedding: responseVec }] }),
  })
  await assert.rejects(
    () => provider.search({ query: 'hello', limit: 5 }),
    (err: unknown) => err instanceof BrainError && err.code === 'EMBEDDING_MISMATCH',
  )

  // Direct createHttpEmbedder rejection check for ungranted host
  const bareKernel = createTestKernel()
  let bareCtx: BrainContext | undefined
  await bareKernel.loadPlugin({ apply: (ctx) => { bareCtx = ctx } }, pkg.brain, { config: { endpoint: 'https://allowed.example.com' } })
  const badEmbedder = createHttpEmbedder({
    endpoint: 'https://evil.example.com/v1',
    modelName: 'embed-pro',
    dimension: 4,
    fetch: bareCtx!.http.fetch,
  })
  await assert.rejects(
    () => badEmbedder.embed('hi'),
    (err: unknown) => err instanceof BrainError && err.code === 'PERMISSION_DENIED',
  )
})

test('BvecStore.load validates binary header when metaJson is undefined and detects tampered metaJson calibration', async () => {
  const embedder = createHashEmbedder({ modelName: 'model-a', dimension: 64 })
  const store = BvecStore.create({ modelName: 'model-a', dimension: 64, normalized: true })
  const { vector } = await embedder.embed('头部与元数据校验')
  store.upsert('r1', vector, { layer: 'L0', channel: 'qq:private:1', tEvent: 100, subjects: ['alice'] })
  const encoded = store.encode()

  // metaJson === undefined: binary header mismatch on modelName, dimension, or normalized throws EMBEDDING_MISMATCH
  const reloaded = BvecStore.load(encoded.vectors, undefined, { modelName: 'model-a', dimension: 64, normalized: true })
  assert.equal(reloaded.header.modelName, 'model-a')
  assert.throws(
    () => BvecStore.load(encoded.vectors, undefined, { modelName: 'model-b', dimension: 64, normalized: true }),
    (err: unknown) => err instanceof BrainError && err.code === 'EMBEDDING_MISMATCH',
  )
  assert.throws(
    () => BvecStore.load(encoded.vectors, undefined, { modelName: 'model-a', dimension: 32, normalized: true }),
    (err: unknown) => err instanceof BrainError && err.code === 'EMBEDDING_MISMATCH',
  )
  assert.throws(
    () => BvecStore.load(encoded.vectors, undefined, { modelName: 'model-a', dimension: 64, normalized: false }),
    (err: unknown) => err instanceof BrainError && err.code === 'EMBEDDING_MISMATCH',
  )

  // Binary header matches expected, but metaJson fields are tampered
  const metaObj = JSON.parse(encoded.metaJson) as {
    version: number
    modelName: string
    dimension: number
    normalized: boolean
    entries: Record<string, unknown>
  }
  assert.throws(
    () => BvecStore.load(
      encoded.vectors,
      JSON.stringify({ ...metaObj, modelName: 'tampered-model' }),
      { modelName: 'model-a', dimension: 64, normalized: true },
    ),
    (err: unknown) => err instanceof BrainError && err.code === 'EMBEDDING_MISMATCH',
  )
  assert.throws(
    () => BvecStore.load(
      encoded.vectors,
      JSON.stringify({ ...metaObj, dimension: 128 }),
      { modelName: 'model-a', dimension: 64, normalized: true },
    ),
    (err: unknown) => err instanceof BrainError && err.code === 'EMBEDDING_MISMATCH',
  )
  assert.throws(
    () => BvecStore.load(
      encoded.vectors,
      JSON.stringify({ ...metaObj, normalized: false }),
      { modelName: 'model-a', dimension: 64, normalized: true },
    ),
    (err: unknown) => err instanceof BrainError && err.code === 'EMBEDDING_MISMATCH',
  )
})

test('createHttpEmbedder direct embed checks mismatched model and dimension (explicit and default 1024)', async () => {
  const makeFetch = (payload: () => { model: string; embedding: number[] }): BrainContext['http']['fetch'] => {
    return async () => {
      const { model, embedding } = payload()
      const raw = JSON.stringify({ model, data: [{ embedding }] })
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        text: () => raw,
        bytes: () => new TextEncoder().encode(raw),
      }
    }
  }

  let serverModel = 'embed-pro'
  let serverEmbedding = [1, 0, 0, 0]

  // 1. Explicit dimension: mismatched model throws EMBEDDING_MISMATCH
  const explicitEmbedder = createHttpEmbedder({
    endpoint: 'https://embed.example.com/v1',
    modelName: 'embed-pro',
    dimension: 4,
    fetch: makeFetch(() => ({ model: serverModel, embedding: serverEmbedding })),
  })
  const okExplicit = await explicitEmbedder.embed('ok')
  assert.equal(okExplicit.modelName, 'embed-pro')
  assert.equal(okExplicit.vector.length, 4)

  serverModel = 'wrong-model'
  await assert.rejects(
    () => explicitEmbedder.embed('mismatch model'),
    (err: unknown) => err instanceof BrainError && err.code === 'EMBEDDING_MISMATCH',
  )

  // 2. Explicit dimension: mismatched dimension throws EMBEDDING_MISMATCH
  serverModel = 'embed-pro'
  serverEmbedding = [1, 0]
  await assert.rejects(
    () => explicitEmbedder.embed('mismatch explicit dim'),
    (err: unknown) => err instanceof BrainError && err.code === 'EMBEDDING_MISMATCH',
  )

  // 3. Omitted dimension (defaults to 1024): 1024 succeeds, non-1024 throws EMBEDDING_MISMATCH
  let defaultVec = Array.from({ length: 1024 }, (_, idx) => (idx === 0 ? 1 : 0))
  const defaultDimEmbedder = createHttpEmbedder({
    endpoint: 'https://embed.example.com/v1',
    modelName: 'embed-default',
    fetch: makeFetch(() => ({ model: 'embed-default', embedding: defaultVec })),
  })
  assert.equal(defaultDimEmbedder.dimension, 1024)
  const okDefault = await defaultDimEmbedder.embed('ok 1024')
  assert.equal(okDefault.vector.length, 1024)

  defaultVec = [1, 0, 0, 0]
  await assert.rejects(
    () => defaultDimEmbedder.embed('mismatch default dim'),
    (err: unknown) => err instanceof BrainError && err.code === 'EMBEDDING_MISMATCH',
  )
})

test('onRecord erases outdated/archived records with zeroed bvec slots and skips L3 records', async () => {
  const pkg = await readManifest()
  const kernel = createTestKernel()
  let storageRef: BrainContext['storage'] | undefined

  await kernel.loadPlugin({
    apply: async (ctx, config) => {
      storageRef = ctx.storage
      await apply(ctx, config)
    },
  }, pkg.brain, { config: { modelName: 'hash-64', dimension: 64 } })

  const provider = kernel.memoryProviders()[0]!
  const headerSize = 18 + new TextEncoder().encode('hash-64').byteLength
  const rowStride = 1 + 4 + 64

  // L3 record must be skipped without writing to index or storage metadata
  await provider.onRecord?.(makeL0('rec_l3', '个人隐私性格画像档案', { layer: 'L3' }))
  assert.deepEqual(await provider.search({ query: '个人隐私性格画像档案', limit: 5 }), [])
  const metaAfterL3 = new TextDecoder().decode(await storageRef!.read('meta.json'))
  assert.equal(metaAfterL3.includes('rec_l3'), false)
  assert.equal((await storageRef!.read('vectors.bvec'))!.byteLength, headerSize)

  await provider.onRecord?.(makeL0('rec_outdated', '周末去植物园赏樱花'))
  await provider.onRecord?.(makeL0('rec_archived', '上周二买了一台咖啡机'))
  await provider.onRecord?.(makeL0('rec_keep', '每天早上喝一杯热牛奶'))

  assert.equal((await provider.search({ query: '植物园赏樱花', limit: 5 }))[0]?.id, 'rec_outdated')
  assert.equal((await provider.search({ query: '咖啡机', limit: 5 }))[0]?.id, 'rec_archived')

  // L3 record on non-empty store is also skipped without appearing in results or metadata
  await provider.onRecord?.(makeL0('rec_l3_late', '另一条 L3 隐私档案', { layer: 'L3' }))
  assert.equal((await provider.search({ query: '另一条 L3 隐私档案', limit: 5 })).some((h) => h.id === 'rec_l3_late'), false)
  assert.deepEqual(await provider.search({ query: '另一条 L3 隐私档案', layers: ['L3'], limit: 5 }), [])
  const metaWithL3Check = new TextDecoder().decode(await storageRef!.read('meta.json'))
  assert.equal(metaWithL3Check.includes('rec_l3_late'), false)

  // Status transitions to 'outdated': disappears from search and zeroes slot 0
  await provider.onRecord?.(makeL0('rec_outdated', '周末去植物园赏樱花', { status: 'outdated' }))
  assert.equal((await provider.search({ query: '植物园赏樱花', limit: 5 })).some((h) => h.id === 'rec_outdated'), false)
  const metaAfterOutdated = new TextDecoder().decode(await storageRef!.read('meta.json'))
  assert.equal(metaAfterOutdated.includes('rec_outdated'), false)
  const bvecAfterOutdated = (await storageRef!.read('vectors.bvec'))!
  assert.equal(bvecAfterOutdated.subarray(headerSize, headerSize + rowStride).every((b) => b === 0), true)

  // Status transitions to 'archived': disappears from search and zeroes slot 1
  await provider.onRecord?.(makeL0('rec_archived', '上周二买了一台咖啡机', { status: 'archived' }))
  assert.equal((await provider.search({ query: '咖啡机', limit: 5 })).some((h) => h.id === 'rec_archived'), false)
  const metaAfterArchived = new TextDecoder().decode(await storageRef!.read('meta.json'))
  assert.equal(metaAfterArchived.includes('rec_archived'), false)
  const bvecAfterArchived = (await storageRef!.read('vectors.bvec'))!
  assert.equal(
    bvecAfterArchived.subarray(headerSize + rowStride, headerSize + rowStride * 2).every((b) => b === 0),
    true,
  )

  // Slot 2 (rec_keep) stays intact and searchable
  assert.equal(bvecAfterArchived[headerSize + rowStride * 2], 1)
  assert.equal((await provider.search({ query: '热牛奶', limit: 5 }))[0]?.id, 'rec_keep')
})

test('BvecStore.search filters layers, channels, subjects, from, to independently and supports normalized=false cosine', () => {
  const filterStore = BvecStore.create({ modelName: 'filter-v1', dimension: 4, normalized: true })
  const vec = [1, 0, 0, 0]

  filterStore.upsert('base', vec, { layer: 'L0', channel: 'qq:private:1', subjects: ['alice'], tEvent: 500 })
  filterStore.upsert('only_layer', vec, { layer: 'L1', channel: 'qq:private:1', subjects: ['alice'], tEvent: 500 })
  filterStore.upsert('only_channel', vec, { layer: 'L0', channel: 'qq:group:2', subjects: ['alice'], tEvent: 500 })
  filterStore.upsert('only_subject', vec, { layer: 'L0', channel: 'qq:private:1', subjects: ['bob'], tEvent: 500 })
  filterStore.upsert('only_early', vec, { layer: 'L0', channel: 'qq:private:1', subjects: ['alice'], tEvent: 400 })
  filterStore.upsert('only_late', vec, { layer: 'L0', channel: 'qq:private:1', subjects: ['alice'], tEvent: 600 })

  assert.deepEqual(filterStore.search(vec, { layers: ['L1'], limit: 10 }).map((h) => h.id), ['only_layer'])
  const l0Ids = filterStore.search(vec, { layers: ['L0'], limit: 10 }).map((h) => h.id)
  assert.equal(l0Ids.includes('only_layer'), false)
  assert.equal(l0Ids.includes('base'), true)

  assert.deepEqual(filterStore.search(vec, { channels: ['qq:group:2'], limit: 10 }).map((h) => h.id), ['only_channel'])
  const privIds = filterStore.search(vec, { channels: ['qq:private:1'], limit: 10 }).map((h) => h.id)
  assert.equal(privIds.includes('only_channel'), false)
  assert.equal(privIds.includes('base'), true)

  assert.deepEqual(filterStore.search(vec, { subjects: ['bob'], limit: 10 }).map((h) => h.id), ['only_subject'])
  const aliceIds = filterStore.search(vec, { subjects: ['alice'], limit: 10 }).map((h) => h.id)
  assert.equal(aliceIds.includes('only_subject'), false)
  assert.equal(aliceIds.includes('base'), true)

  assert.deepEqual(filterStore.search(vec, { from: 600, limit: 10 }).map((h) => h.id), ['only_late'])
  const fromIds = filterStore.search(vec, { from: 500, limit: 10 }).map((h) => h.id)
  assert.equal(fromIds.includes('only_early'), false)
  assert.equal(fromIds.includes('base'), true)
  assert.equal(fromIds.includes('only_late'), true)

  assert.deepEqual(filterStore.search(vec, { to: 400, limit: 10 }).map((h) => h.id), ['only_early'])
  const toIds = filterStore.search(vec, { to: 500, limit: 10 }).map((h) => h.id)
  assert.equal(toIds.includes('only_late'), false)
  assert.equal(toIds.includes('base'), true)
  assert.equal(toIds.includes('only_early'), true)

  // Unnormalized cosine similarity branch (normalized: false)
  const cosStore = BvecStore.create({ modelName: 'unnorm-v1', dimension: 4, normalized: false })
  cosStore.upsert('exact_small', [0.1, 0, 0, 0], { layer: 'L0', channel: 'qq:private:1', subjects: ['alice'], tEvent: 100 })
  cosStore.upsert('angled_big', [100, 30, 0, 0], { layer: 'L0', channel: 'qq:private:1', subjects: ['alice'], tEvent: 100 })
  cosStore.upsert('ortho', [0, 100, 0, 0], { layer: 'L0', channel: 'qq:private:1', subjects: ['alice'], tEvent: 100 })

  const cosHits = cosStore.search([5, 0, 0, 0], { limit: 5 })
  assert.deepEqual(cosHits.map((h) => h.id), ['exact_small', 'angled_big'])
  assert.ok(Math.abs(cosHits[0]!.score - 1) < 0.01, `expected cosine ~1.0, got ${cosHits[0]!.score}`)
  assert.ok(cosHits[1]!.score < cosHits[0]!.score && cosHits[1]!.score > 0.9)

  const encoded = cosStore.encode()
  const reloadedCos = BvecStore.load(encoded.vectors, encoded.metaJson, { modelName: 'unnorm-v1', dimension: 4, normalized: false })
  assert.equal(reloadedCos.header.normalized, false)
  assert.deepEqual(reloadedCos.search([5, 0, 0, 0], { limit: 5 }), cosHits)
})
