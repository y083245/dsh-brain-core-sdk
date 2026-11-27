import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrainContext } from '@dsh-brain-core/sdk'
import {
  evaluateLateRegister, evaluateNoExtraTools, evaluateUnloadClean, runPluginContractTests,
} from '../src/contract.ts'
import { createTestKernel, type ContractResult } from '../src/index.ts'

const MANIFEST = {
  id: 'compliant',
  kinds: ['capability'],
  api: '^1.0.0',
  runtime: 'node',
  permissions: ['tools.register', 'memory.ingest', 'memory.record'],
  source: {
    channels: ['compliant:test:here'],
    eventKinds: ['compliant.event'],
    defaultVisibility: 'open',
    trust: 'member',
  },
  tools: [
    { name: 'look', effect: 'read', load: 'core', summary: 'Look around' },
    { name: 'peek', effect: 'read', load: 'core', summary: 'Peek around' },
  ],
} as const

const NAMES = ['manifest', 'apply', 'tools-registered', 'no-extra-tools', 'no-internal-writes', 'unload-clean', 'no-late-register']

function find(results: readonly ContractResult[], name: string): ContractResult {
  const found = results.find((result) => result.name === name)
  assert.ok(found !== undefined, `missing ${name}`)
  return found
}

const compliant = {
  apply: (ctx: BrainContext) => {
    ctx.tools.register({ name: 'look', description: 'Look around', parameters: { type: 'object' }, handler: async () => 'ok' })
    ctx.tools.register({ name: 'peek', description: 'Peek around', parameters: { type: 'object' }, handler: async () => 'ok' })
  },
}

test('a compliant plugin passes all seven checks', async () => {
  const results = await runPluginContractTests(compliant, MANIFEST)
  assert.deepEqual(results.map((result) => result.name), NAMES)
  for (const result of results) assert.equal(result.ok, true, `${result.name}: ${result.message}`)
})

test('an invalid manifest fails the manifest check and skips the rest', async () => {
  const results = await runPluginContractTests(compliant, { id: 'Bad' })
  assert.deepEqual(results.map((result) => result.name), NAMES)
  assert.equal(find(results, 'manifest').ok, false)
  for (const name of NAMES.slice(1)) assert.equal(find(results, name).ok, false)
})

test('an apply that throws fails the apply check', async () => {
  const results = await runPluginContractTests({ apply: () => { throw new Error('boom') } }, MANIFEST)
  assert.equal(find(results, 'apply').ok, false)
  assert.match(find(results, 'apply').message, /boom/)
})

test('a declared tool that is never registered fails tools-registered', async () => {
  const partial = {
    apply: (ctx: BrainContext) => {
      ctx.tools.register({ name: 'look', description: 'Look around', parameters: { type: 'object' }, handler: async () => 'ok' })
    },
  }
  const results = await runPluginContractTests(partial, MANIFEST)
  assert.equal(find(results, 'tools-registered').ok, false)
  assert.match(find(results, 'tools-registered').message, /peek/)
  assert.equal(find(results, 'no-extra-tools').ok, true)
})

test('a disabled L3 write during apply fails no-internal-writes', async () => {
  const l3Writer = {
    apply: async (ctx: BrainContext): Promise<void> => {
      for (const name of ['look', 'peek']) {
        ctx.tools.register({ name, description: name, parameters: { type: 'object' }, handler: async () => 'ok' })
      }
      try {
        await ctx.memory.record({
          layer: 'L3',
          kind: 'l3.self',
          channel: 'compliant:test:here',
          subjects: [],
          actor: 'p1',
          content: {},
          evidence: [{ id: 'l0_missing' }],
        } as never)
      } catch {
        // the refusal is expected; the attempt itself is the violation
      }
    },
  }
  const results = await runPluginContractTests(l3Writer, MANIFEST)
  assert.equal(find(results, 'no-internal-writes').ok, false)
  assert.equal(find(results, 'tools-registered').ok, true)
})

test('no-extra-tools fails when a registered name is outside the manifest', () => {
  const result = evaluateNoExtraTools(['demo__look'], ['demo__look', 'demo__extra'])
  assert.equal(result.ok, false)
  assert.match(result.message, /demo__extra/)
})

test('unload-clean fails when a registration survives', () => {
  const kernel = createTestKernel()
  const leaky = {
    tools: () => ['demo__look'],
    routes: () => [],
    timers: () => 0,
  }
  const result = evaluateUnloadClean(leaky)
  assert.equal(result.ok, false)
  assert.match(result.message, /1 tool/)
  assert.equal(evaluateUnloadClean({ tools: () => [], routes: () => [], timers: () => 0 }).ok, true)
  void kernel
})

test('no-late-register fails when an unloaded context still accepts registrations', async () => {
  const noop = (): (() => void) => () => undefined
  const accepting = {
    tools: { register: noop },
    http: { route: noop },
    scheduler: { every: noop },
    events: { on: noop },
    channel: { provide: noop },
  } as unknown as BrainContext
  const result = await evaluateLateRegister(accepting)
  assert.equal(result.ok, false)
  assert.match(result.message, /tools\.register/)
})
