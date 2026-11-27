import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test, { afterEach } from 'node:test'
import { fileURLToPath } from 'node:url'
import { BrainError, type BrainManifest, type MemoryRecord, type ReadL0Request, type ReadL0Result } from '@dsh-brain-core/sdk'
import { createMemoryProviderRegistry } from '../../src/memory-provider/index.ts'
import { createExternalApply } from '../../src/plugin-external/index.ts'
import { createPluginRuntime } from '../../src/plugin-runtime/index.ts'
import { setup as setupRuntime, stored } from '../plugin-runtime/helpers.ts'
import { harness, waitUntil, type Harness, type HarnessOptions } from './helpers.ts'

const SAMPLE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'plugins', 'memory-provider-sample')

const live = new Set<Harness>()
async function setup(options: HarnessOptions): Promise<Harness> {
  const h = await harness(options)
  live.add(h)
  return h
}

afterEach(async () => {
  await Promise.all([...live].map(async (h) => { await h.stop() }))
  live.clear()
})

test('memory.readL0, memory.writeDerived, and memory.provide forward across JSON-RPC', async () => {
  const sampleL0 = stored('l0_10', { layer: 'L0', kind: 'qq.message', content: { text: 'hello' } })
  const h = await setup({
    manifest: {
      id: 'mp-ext',
      kinds: ['memory-provider'],
      permissions: ['memory.readL0', 'memory.writeDerived'],
      source: undefined,
    },
    script: {
      calls: [
        { method: 'memory.readL0', params: { request: { limit: 25 } }, key: 'readL0' },
        {
          method: 'memory.writeDerived',
          params: {
            input: {
              channel: 'qq:private:1',
              subjects: ['self'],
              content: { text: 'derived' },
              evidence: [{ id: 'l0_10' }],
            },
          },
          key: 'writeDerived',
        },
        { method: 'memory.provide', params: {}, key: 'provide' },
      ],
      respond: {
        'memoryProvider.search': [{ id: 'l0_10', score: 0.92 }],
        'memoryProvider.onRecord': null,
        'memoryProvider.onForgotten': null,
        'memoryProvider.health': { status: 'ok', model: 'sample', dimension: 16 },
      },
    },
  })
  h.ctx.state.memoryReadL0Result = { items: [sampleL0], nextCursor: 'l0_10' }
  await h.apply(h.ctx.ctx, {})
  await h.waitFor((entries) => entries.some((entry) => entry.event === 'response' && entry.key === 'provide'))

  assert.deepEqual(h.ctx.state.calls.memoryReadL0, [[{ limit: 25 }]])
  assert.equal(h.ctx.state.calls.memoryWriteDerived.length, 1)
  assert.equal(h.ctx.state.memoryProviders.length, 1)

  const provider = h.ctx.state.memoryProviders[0]!
  const hits = await provider.search({ query: 'hello', limit: 5 })
  assert.deepEqual(hits, [{ id: 'l0_10', score: 0.92 }])

  await provider.onRecord?.(sampleL0)
  await provider.onForgotten(['l0_10'])
  assert.deepEqual(await provider.health?.(), { status: 'ok', model: 'sample', dimension: 16 })

  await h.waitFor((entries) => entries.some((entry) => entry.event === 'request' && entry.method === 'memoryProvider.health'))
  const entries = h.entries()
  const readResp = entries.find((e) => e.event === 'response' && e.key === 'readL0')
  assert.equal((readResp?.result as ReadL0Result | undefined)?.items[0]?.id, 'l0_10')
  assert.ok(entries.some((e) => e.event === 'request' && e.method === 'memoryProvider.onRecord'))
  assert.ok(entries.some((e) => e.event === 'request' && e.method === 'memoryProvider.onForgotten'))

  await h.stop()
  assert.equal(h.ctx.state.memoryProviders.length, 0)
  assert.equal(h.ctx.state.disposed.includes('memoryProvider'), true)
})

test('EMBEDDING_MISMATCH from child memoryProvider.search propagates as BrainError', async () => {
  const h = await setup({
    manifest: {
      id: 'mp-mismatch',
      kinds: ['memory-provider'],
      permissions: ['memory.readL0'],
      source: undefined,
    },
    script: {
      calls: [{ method: 'memory.provide', params: {}, key: 'provide' }],
      respond: {
        'memoryProvider.search': {
          error: {
            code: -32000,
            message: 'dimension mismatch',
            data: { code: 'EMBEDDING_MISMATCH', details: {} },
          },
        },
      },
    },
  })
  await h.apply(h.ctx.ctx, {})
  await h.waitFor((entries) => entries.some((entry) => entry.event === 'response' && entry.key === 'provide'))
  const provider = h.ctx.state.memoryProviders[0]!
  await assert.rejects(
    () => provider.search({ query: 'test', limit: 5 }),
    (err: unknown) => err instanceof BrainError && err.code === 'EMBEDDING_MISMATCH',
  )
})

test('crash of external memory provider revokes registration, degrades in-flight search, and restarts cleanly', async () => {
  const generationFile = path.join((await setup({
    manifest: { id: 'mp-prep', kinds: ['memory-provider'], permissions: ['memory.readL0'], source: undefined },
    script: { calls: [] },
  })).dir, 'gen')

  const h = await setup({
    manifest: {
      id: 'mp-crash',
      kinds: ['memory-provider'],
      permissions: ['memory.readL0'],
      source: undefined,
    },
    script: {
      generationFile,
      exitAfterReadyMs: 500,
      exitAfterReadyGenerations: [1],
      delay: { 'memoryProvider.search': 3000 },
      calls: [{ method: 'memory.provide', params: {}, key: 'provide' }],
      respond: {
        'memoryProvider.search': [{ id: 'recovered_1', score: 0.9 }],
      },
    },
  })

  await h.apply(h.ctx.ctx, {})
  await h.waitFor((entries) => entries.some((entry) => entry.event === 'response' && entry.key === 'provide'))
  const first = h.ctx.state.memoryProviders[0]!
  const pendingSearch = first.search({ query: 'hello', limit: 5 }).then(
    () => null,
    (err: unknown) => err,
  )

  await h.waitFor((entries) => entries.filter((e) => e.event === 'start').length >= 2, 10_000)
  assert.equal(h.ctx.state.disposed.includes('memoryProvider'), true)
  const caught = await pendingSearch
  assert.ok(caught instanceof BrainError && caught.code === 'UNAVAILABLE', String(caught))

  await waitUntil(() => h.ctx.state.memoryProviders.length === 1, 5000)
  const second = h.ctx.state.memoryProviders[0]!
  assert.notEqual(second, first)
  assert.deepEqual(await second.search({ query: 'hello', limit: 5 }), [{ id: 'recovered_1', score: 0.9 }])
})

test('real plugins/memory-provider-sample child runs end-to-end with createExternalApply, PluginRuntime, and MemoryProviderRegistry', async () => {
  const pkg = JSON.parse(await readFile(path.join(SAMPLE_ROOT, 'package.json'), 'utf8')) as {
    readonly version: string
    readonly brain: BrainManifest
  }
  const registry = createMemoryProviderRegistry({ timeoutMs: 3000 })
  const l0Store = new Map<string, MemoryRecord>([
    ['l0_01', stored('l0_01', { layer: 'L0', kind: 'qq.message', channel: 'qq:private:1', subjects: ['alice'], content: { text: '喜欢喝乌龙茶和拿铁' }, tEvent: 100 })],
    ['l0_02', stored('l0_02', { layer: 'L0', kind: 'qq.message', channel: 'qq:group:9', subjects: ['bob'], content: { text: '周末去爬香山' }, tEvent: 200 })],
  ])
  const writtenDerived: { pluginId: string; input: unknown }[] = []

  const rt = await setupRuntime({
    deps: {
      applyTimeoutMs: 8000,
      memoryProviders: registry,
      listL0: async (req?: ReadL0Request): Promise<ReadL0Result> => {
        const limit = req?.limit ?? 100
        const items = [...l0Store.values()]
          .filter((r) => r.status === 'active' && (req?.afterId === undefined || r.id > req.afterId))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        const page = items.slice(0, limit)
        const nextCursor = items.length > limit ? page[page.length - 1]!.id : undefined
        return { items: page, ...(nextCursor === undefined ? {} : { nextCursor }) }
      },
      writeDerived: async (pluginId, input) => {
        writtenDerived.push({ pluginId, input })
        return stored('l1_derived_1', {
          layer: 'L1',
          kind: 'l1.candidate',
          source: pluginId,
          channel: input.channel,
          subjects: [...input.subjects],
          content: input.content,
          evidence: [...input.evidence],
          trust: 'external',
        })
      },
      loadEntry: async (plugin) => createExternalApply(plugin, {
        pluginsDir: rt.dir,
        log: rt.deps.log,
        now: () => Date.now(),
        onFailed: () => undefined,
        parentEnv: {
          ...process.env,
          PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
        },
      }),
    },
  })

  const plugin = {
    manifest: pkg.brain,
    version: pkg.version,
    dir: SAMPLE_ROOT,
    granted: pkg.brain.permissions,
    config: { triggerPrefix: '记住：' },
  }

  // Re-create runtime cleanly since loadEntry references rt.dir
  const runtime = createPluginRuntime({
    ...rt.deps,
    loadEntry: async (p) => createExternalApply(p, {
      pluginsDir: rt.dir,
      log: rt.deps.log,
      now: () => Date.now(),
      onFailed: () => undefined,
      parentEnv: {
        ...process.env,
        PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    }),
  })

  try {
    await runtime.enable(plugin)
    assert.equal(registry.hasProviders(), true)
    assert.equal(await registry.health(), 'ok')

    const initialSearch = await registry.search({ query: '乌龙茶', limit: 5 })
    assert.equal(initialSearch.active, true)
    assert.equal(initialSearch.degraded, false)
    assert.equal(initialSearch.hits[0]?.id, 'l0_01')

    // Incremental record with trigger prefix writes derived l1.candidate
    const newL0 = stored('l0_03', {
      layer: 'L0',
      kind: 'qq.message',
      channel: 'qq:private:1',
      subjects: ['alice'],
      content: { text: '记住：周六上午十点看牙医' },
      tEvent: 300,
    })
    l0Store.set(newL0.id, newL0)
    await registry.notifyRecorded(newL0)

    assert.equal(writtenDerived.length, 1)
    assert.equal(writtenDerived[0]!.pluginId, 'memory-provider-sample')
    const derivedInput = writtenDerived[0]!.input as { content: { text: string }; evidence: { id: string }[] }
    assert.equal(derivedInput.content.text, '周六上午十点看牙医')
    assert.deepEqual(derivedInput.evidence, [{ id: 'l0_03' }])

    const afterRecord = await registry.search({ query: '牙医', limit: 5 })
    assert.equal(afterRecord.hits[0]?.id, 'l0_03')

    // Forget erases l0_03 from sample provider
    await registry.notifyForgotten(['l0_03'])
    l0Store.delete('l0_03')
    const afterForget = await registry.search({ query: '牙医', limit: 5 })
    assert.deepEqual(afterForget.hits, [])

    // Disable cleanly shuts down the process and unregisters provider
    await runtime.disable('memory-provider-sample')
    assert.equal(registry.hasProviders(), false)
    assert.equal(await registry.health(), undefined)

    // Re-enable recovers provider and re-indexes remaining L0 records via readL0
    await runtime.enable(plugin)
    assert.equal(registry.hasProviders(), true)
    const recovered = await registry.search({ query: '香山', limit: 5 })
    assert.equal(recovered.hits[0]?.id, 'l0_02')

    await runtime.disable('memory-provider-sample')
    assert.equal(registry.hasProviders(), false)
  } finally {
    await runtime.disable('memory-provider-sample').catch(() => {})
  }
})
