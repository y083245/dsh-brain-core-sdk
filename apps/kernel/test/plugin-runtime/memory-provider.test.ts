import assert from 'node:assert/strict'
import test from 'node:test'
import type { MemoryProvider, MemoryRecord } from '@dsh-brain-core/sdk'
import { createMemoryProviderRegistry } from '../../src/memory-provider/index.ts'
import { denial, installed, manifest, setup, stored } from './helpers.ts'

test('non-memory-provider plugins cannot call readL0, writeDerived, or provide even with permissions granted', async () => {
  const registry = createMemoryProviderRegistry()
  const s = await setup({
    deps: {
      listL0: async () => ({ items: [] }),
      writeDerived: async () => stored('l1_1'),
      memoryProviders: registry,
    },
  })
  const m = manifest({
    kinds: ['channel'],
    permissions: ['memory.readL0', 'memory.writeDerived'],
  })
  await s.runtime.enable(installed(['memory.readL0', 'memory.writeDerived'], {}, m))

  await denial(s.ctx().memory.readL0())
  await denial(s.ctx().memory.writeDerived({
    channel: 'qq:private:1',
    subjects: ['p1'],
    content: { text: 'x' },
    evidence: [{ id: 'l0_1' }],
  }))
  await denial(async () => s.ctx().memory.provide({
    search: async () => [],
    onForgotten: async () => undefined,
  }))
  assert.equal(registry.hasProviders(), false)
})

test('memory-provider plugin enforces permissions, unconfigured UNAVAILABLE, and forwards readL0/writeDerived/provide', async () => {
  const bare = await setup()
  const mpManifest = manifest({
    id: 'mp',
    kinds: ['memory-provider'],
    permissions: ['memory.readL0', 'memory.writeDerived', 'llm.invoke'],
    source: undefined,
    tools: undefined,
    groups: undefined,
  })
  await bare.runtime.enable(installed([], {}, mpManifest))
  await denial(bare.ctx().memory.readL0())
  await denial(bare.ctx().memory.writeDerived({
    channel: 'qq:private:1',
    subjects: ['self'],
    content: { text: 'x' },
    evidence: [{ id: 'l0_1' }],
  }))
  await denial(async () => bare.ctx().memory.provide({
    search: async () => [],
    onForgotten: async () => undefined,
  }))

  await bare.runtime.disable('mp')
  await bare.runtime.enable(installed(['memory.readL0', 'memory.writeDerived'], {}, mpManifest))
  await denial(bare.ctx().memory.readL0(), 'UNAVAILABLE')
  await denial(bare.ctx().memory.writeDerived({
    channel: 'qq:private:1',
    subjects: ['self'],
    content: { text: 'x' },
    evidence: [{ id: 'l0_1' }],
  }), 'UNAVAILABLE')
  await denial(async () => bare.ctx().memory.provide({
    search: async () => [],
    onForgotten: async () => undefined,
  }), 'UNAVAILABLE')
  await bare.runtime.disable('mp')

  const registry = createMemoryProviderRegistry()
  const l0Record = stored('l0_1', { layer: 'L0', kind: 'qq.message' })
  const derivedCalls: unknown[][] = []
  const readCalls: unknown[][] = []
  const llmCalls: unknown[][] = []

  const wired = await setup({
    deps: {
      listL0: async (request) => {
        readCalls.push([request])
        return { items: [l0Record] }
      },
      writeDerived: async (pluginId, input) => {
        derivedCalls.push([pluginId, input])
        return stored('l1_derived', { source: pluginId, kind: 'l1.candidate', evidence: input.evidence })
      },
      memoryProviders: registry,
      llm: {
        complete: async (pluginId, req) => {
          llmCalls.push([pluginId, req])
          return { text: 'llm-ok', tokens: 7 }
        },
      },
    },
  })

  await wired.runtime.enable(installed(['memory.readL0', 'memory.writeDerived', 'llm.invoke'], {}, mpManifest))
  const ctx = wired.ctx()

  const page = await ctx.memory.readL0({ limit: 10 })
  assert.equal(page.items.length, 1)
  assert.equal(page.items[0]!.id, 'l0_1')
  assert.deepEqual(readCalls, [[{ limit: 10 }]])

  const derived = await ctx.memory.writeDerived({
    channel: 'qq:private:1',
    subjects: ['self'],
    content: { text: 'derived fact' },
    evidence: [{ id: 'l0_1' }],
  })
  assert.equal(derived.source, 'mp')
  assert.equal(derived.kind, 'l1.candidate')
  assert.equal(derivedCalls.length, 1)

  const llmRes = await ctx.llm.complete({ system: 'sys', user: 'hi', maxOutputTokens: 32 })
  assert.deepEqual(llmRes, { text: 'llm-ok', tokens: 7 })
  assert.deepEqual(llmCalls, [['mp', { system: 'sys', user: 'hi', maxOutputTokens: 32 }]])

  await denial(async () => ctx.memory.provide({} as MemoryProvider), 'INVALID_ARGUMENT')

  const provider: MemoryProvider = {
    search: async () => [{ id: 'l0_1', score: 0.9 }],
    onForgotten: async () => undefined,
  }
  ctx.memory.provide(provider)
  assert.deepEqual(registry.listIds(), ['mp'])
  assert.equal((await registry.search({ query: 'test', limit: 5 })).hits[0]?.id, 'l0_1')

  // Disabling the plugin disposes its Cordis effect and unregisters the provider automatically
  await wired.runtime.disable('mp')
  assert.equal(registry.hasProviders(), false)
  assert.deepEqual(registry.listIds(), [])

  // Late calls after disable are refused
  await denial(ctx.memory.readL0())
  await denial(async () => ctx.memory.provide(provider))
  await denial(async () => {
    const rec: MemoryRecord = l0Record
    await ctx.memory.writeDerived({ channel: rec.channel, subjects: rec.subjects, content: {}, evidence: [{ id: rec.id }] })
  })
})
