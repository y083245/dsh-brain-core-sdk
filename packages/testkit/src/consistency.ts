import { BrainError, type BrainContext, type Envelope } from '@brain-core/sdk'
import type { ContractResult } from './contract.ts'
import type { LoadOptions } from './kernel.ts'

/** The same checks run against the fake here and the real kernel in kernel-assembly. */
export interface ConsistencyTarget {
  loadPlugin(plugin: { readonly apply: (ctx: BrainContext, config: Readonly<Record<string, unknown>>) => void | Promise<void> }, manifest: unknown, options?: LoadOptions): Promise<void>
  http(method: string, path: string, body?: unknown): Promise<Envelope<unknown>>
  unload(): Promise<void>
}

const MANIFEST = {
  id: 'consistency',
  kinds: ['capability'],
  api: '^1.0.0',
  runtime: 'node',
  // memory.search is declared but not granted in the cases below.
  permissions: ['memory.ingest', 'memory.record', 'memory.search'],
  source: {
    channels: ['consistency:test:here'],
    eventKinds: ['consistency.poke'],
    defaultVisibility: 'open',
    trust: 'external',
  },
} as const

interface Outcome { readonly name: string; code: string }

function codeOf(error: unknown): string {
  return error instanceof BrainError ? error.code : error instanceof Error ? error.name : 'unknown'
}

function result(name: string, ok: boolean, message: string): ContractResult {
  return { name: `consistency:${name}`, ok, message }
}

/**
 * A deliberately small plugin with only part of its manifest granted. Both kernels must answer
 * the same way to an ungranted call, another plugin's channel, an L3 write and both route envelopes.
 */
export async function runConsistencyCases(makeTarget: () => Promise<ConsistencyTarget>): Promise<readonly ContractResult[]> {
  const target = await makeTarget()
  const outcomes: Outcome[] = []
  const attempt = async (name: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run()
      outcomes.push({ name, code: 'ok' })
    } catch (error) {
      outcomes.push({ name, code: codeOf(error) })
    }
  }
  const plugin = {
    apply: async (ctx: BrainContext): Promise<void> => {
      await attempt('ungranted-permission', () => ctx.memory.search({ query: 'x', scope: 'all' }))
      await attempt('foreign-channel', () => ctx.memory.ingest({
        kind: 'consistency.poke',
        channel: 'consistency:test:elsewhere',
        subjects: [],
        actor: 'person',
        content: {},
        tEvent: 0,
        idempotencyKey: 'foreign',
      }))
      await attempt('l3-write', () => ctx.memory.record({
        layer: 'L3',
        kind: 'l3.self',
        channel: 'consistency:test:here',
        subjects: [],
        actor: 'person',
        content: {},
        evidence: [{ id: 'l0_missing' }],
      } as never))
      await ctx.http.route('GET', '/ok', async () => ({ hello: 'world' }))
      await ctx.http.route('GET', '/boom', async () => {
        throw new BrainError('INVALID_ARGUMENT', 'bad input', { field: 'query' })
      })
    },
  }

  await target.loadPlugin(plugin, MANIFEST, { granted: ['memory.ingest', 'memory.record'] })
  const results: ContractResult[] = []
  const outcome = (name: string): string => outcomes.find((entry) => entry.name === name)?.code ?? 'missing'

  const ungranted = outcome('ungranted-permission')
  results.push(result('ungranted-permission', ungranted === 'PERMISSION_DENIED',
    `memory.search without its grant returned ${ungranted}`))

  const foreign = outcome('foreign-channel')
  results.push(result('foreign-channel', foreign === 'PERMISSION_DENIED',
    `a write to another plugin's channel returned ${foreign}`))

  const l3 = outcome('l3-write')
  results.push(result('l3-write', l3 === 'INVALID_ARGUMENT',
    `an L3 write returned ${l3} (the schema rejects it before the write guard, same as the real service)`))

  try {
    const success = await target.http('GET', '/api/v1/plugins/consistency/ok')
    const okShape = success.ok
      && typeof success.meta.requestId === 'string'
      && JSON.stringify(success.data) === JSON.stringify({ hello: 'world' })
    results.push(result('route-success', okShape,
      okShape ? 'a route result came back in a success envelope' : `unexpected success envelope: ${JSON.stringify(success)}`))
  } catch (error) {
    results.push(result('route-success', false, `route call threw: ${codeOf(error)}`))
  }

  try {
    const failure = await target.http('GET', '/api/v1/plugins/consistency/boom')
    const okShape = !failure.ok
      && failure.error.code === 'INVALID_ARGUMENT'
      && failure.error.message === 'bad input'
      && (failure.error.details as { readonly field?: unknown }).field === 'query'
      && typeof failure.meta.requestId === 'string'
    results.push(result('route-failure', okShape,
      okShape ? 'a BrainError became the documented failure envelope' : `unexpected failure envelope: ${JSON.stringify(failure)}`))
  } catch (error) {
    results.push(result('route-failure', false, `route call threw: ${codeOf(error)}`))
  }

  try {
    await target.unload()
  } catch {
    // the checks above are the contract; a failing teardown is the target's own problem
  }
  return results
}
