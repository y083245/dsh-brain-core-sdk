import type { BrainContext } from '@brain-core/sdk'
import { createTestKernel, type LoadOptions, type TestKernel } from '../src/index.ts'

export const OWN = 'demo:group:1'
export const HERE = 'demo:private:1'
export const OTHER = 'other:group:1'

export const MANIFEST = {
  id: 'demo',
  kinds: ['activity', 'capability'],
  api: '^1.0.0',
  runtime: 'node',
  permissions: [
    'memory.ingest', 'memory.record', 'memory.search', 'memory.context', 'memory.forget',
    'agent.session', 'tools.register', 'channel.provide', 'channel.send', 'identity.link',
    'schedule.ownTime', 'llm.invoke', 'secrets:token',
    'network:api.example.com', 'lan:127.0.0.1',
  ],
  source: {
    channels: ['demo:group:*', 'demo:private:1'],
    eventKinds: ['demo.message'],
    defaultVisibility: 'open',
    trust: 'member',
  },
  tools: [
    { name: 'say', effect: 'send', load: 'core', summary: 'Say something', textArg: 'text', sendPerMinute: 5 },
    { name: 'look', effect: 'read', load: 'core', summary: 'Look around' },
    { name: 'door', effect: 'write', load: 'core', summary: 'Open the door', audience: 'owner' },
  ],
} as const

export type ManifestPatch = Record<string, unknown>

export function manifestWith(patch: ManifestPatch): Record<string, unknown> {
  return { ...structuredClone(MANIFEST), ...structuredClone(patch) }
}

export function sourceWith(patch: Record<string, unknown>): Record<string, unknown> {
  return manifestWith({ source: { ...structuredClone(MANIFEST.source), ...structuredClone(patch) } })
}

export function ingestEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'demo.message',
    channel: OWN,
    subjects: ['p1'],
    actor: 'p1',
    content: { text: 'hello' },
    tEvent: 100,
    idempotencyKey: 'ingest-1',
    ...overrides,
  }
}

export function recordInput(evidence: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    layer: 'L1',
    kind: 'l1.fact',
    channel: OWN,
    subjects: ['p1'],
    actor: 'p1',
    content: { text: 'a fact' },
    evidence: [{ id: evidence }],
    ...overrides,
  }
}

export interface Fixture {
  readonly kernel: TestKernel
  readonly ctx: BrainContext
}

/** Loads a plugin whose apply delegates here, so the test receives the exact context the kernel built. */
export async function loadWithApply(
  apply: (ctx: BrainContext, config: Readonly<Record<string, unknown>>) => void | Promise<void>,
  options: {
    readonly now?: number
    readonly ownerChannels?: readonly string[]
    readonly manifest?: unknown
    readonly load?: LoadOptions
  } = {},
): Promise<Fixture> {
  const kernel = createTestKernel({
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.ownerChannels === undefined ? {} : { ownerChannels: options.ownerChannels }),
  })
  let captured: BrainContext | undefined
  await kernel.loadPlugin({
    apply: async (ctx, config) => {
      captured = ctx
      return apply(ctx, config)
    },
  }, options.manifest ?? MANIFEST, options.load)
  if (captured === undefined) throw new Error('the kernel never called apply')
  return { kernel, ctx: captured }
}

/** A fixture with no behaviour beyond receiving the context. */
export function loadIdle(
  options: {
    readonly now?: number
    readonly ownerChannels?: readonly string[]
    readonly manifest?: unknown
    readonly load?: LoadOptions
  } = {},
): Promise<Fixture> {
  return loadWithApply(() => undefined, options)
}

export async function codeOf(work: () => Promise<unknown> | unknown): Promise<string> {
  try {
    await work()
    return 'ok'
  } catch (error) {
    if (error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string') {
      return (error as { code: string }).code
    }
    return error instanceof Error ? error.name : 'unknown'
  }
}
