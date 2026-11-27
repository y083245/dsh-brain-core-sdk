import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { BrainError, type BrainContext, type BrainManifest, type MemoryRecord, type PluginApply } from '@dsh-brain-core/sdk'
import type { InstalledPlugin } from '../../src/contracts/index.ts'
import { createPluginRuntime, type PluginRuntime, type PluginRuntimeDeps } from '../../src/plugin-runtime/index.ts'
import { FakeClock } from '../fakes/index.ts'

export const ALL_PERMISSIONS = [
  'memory.ingest', 'memory.record', 'memory.search', 'memory.context', 'memory.forget', 'agent.session', 'tools.register',
  'channel.provide', 'channel.send', 'identity.link', 'schedule.ownTime', 'llm.invoke', 'secrets:token',
] as const

export function manifest(overrides: Partial<BrainManifest> = {}): BrainManifest {
  return {
    id: 'qq', kinds: ['channel'], api: '^1', runtime: 'node', permissions: [...ALL_PERMISSIONS],
    source: {
      channels: ['qq:group:*', 'qq:private:1'], eventKinds: ['qq.message'], defaultVisibility: 'origin', trust: 'member',
    },
    tools: [
      { name: 'say', effect: 'send', load: 'core', summary: 'say', group: 'g' },
      { name: 'look', effect: 'read', load: 'core', summary: 'look', channels: ['qq:private'] },
    ],
    groups: { g: { summary: 'group g' } },
    ...overrides,
  }
}

export function installed(granted: readonly string[] = ALL_PERMISSIONS, overrides: Partial<InstalledPlugin> = {}, m: BrainManifest = manifest()): InstalledPlugin {
  return { manifest: m, version: '1.0.0', dir: '/nowhere', granted, config: {}, ...overrides }
}

export interface Calls { readonly [name: string]: unknown[][] }

/** Records every call and returns canned answers. */
export async function setup(options: { apply?: PluginApply; deps?: Partial<PluginRuntimeDeps> } = {}) {
  const calls: Record<string, unknown[][]> = {}
  const record = (name: string, args: unknown[]): void => { (calls[name] ??= []).push(args) }
  const clock = new FakeClock()
  const dir = await mkdtemp(path.join(os.tmpdir(), 'plugin-runtime-'))
  const undone: string[] = []
  const state = { outbound: null as string | null, admit: true, provider: undefined as unknown, secrets: new Map<string, string>(), records: new Map<string, MemoryRecord>() }
  let ctx: BrainContext | undefined
  const deps: PluginRuntimeDeps = {
    memory: {
      ingest: async (...a: unknown[]) => { record('memory.ingest', a); return { id: 'r1' } },
      record: async (...a: unknown[]) => { record('memory.record', a); return { id: 'r2' } as never },
      update: async (...a: unknown[]) => { record('memory.update', a); return { id: 'r2' } as never },
      remove: async (...a: unknown[]) => { record('memory.remove', a) },
      search: async (...a: unknown[]) => { record('memory.search', a); return { items: [], degraded: false } },
      context: async (...a: unknown[]) => { record('memory.context', a); return {} as never },
      forget: async (...a: unknown[]) => { record('memory.forget', a); return { tombstoned: 0, invalidated: 0, l3Flagged: 0 } },
      health: async () => ({}),
    } as never,
    identity: {
      resolve: async (...a: unknown[]) => { record('identity.resolve', a); return 'p1' },
      link: async (...a: unknown[]) => { record('identity.link', a) },
    },
    gateway: {
      register: (tool) => { record('gateway.register', [tool]); return () => { undone.push(`tool:${tool.manifest.name}`) } },
      checkOutbound: (...a: unknown[]) => { record('gateway.checkOutbound', a); return state.outbound },
      noteOutbound: (...a: unknown[]) => { record('gateway.noteOutbound', a) },
      admitSend: (...a: unknown[]) => { record('gateway.admitSend', a); return state.admit },
    },
    agent: {
      wakeProactiveMessage: async () => { throw new Error('not used by plugin runtime') },
      wake: async (...a: unknown[]) => { record('agent.wake', a); return { wakeId: 'w' } as never },
      rotate: async (...a: unknown[]) => { record('agent.rotate', a) },
      forgotten: async () => undefined,
      close: async () => undefined,
    },
    scheduler: {
      every: (...a: unknown[]) => { record('scheduler.every', a); return () => { undone.push('every') } },
      at: (...a: unknown[]) => { record('scheduler.at', a); return () => { undone.push('at') } },
      ownTime: (...a: unknown[]) => { record('scheduler.ownTime', a); return () => { undone.push('ownTime') } },
    },
    channels: {
      provide: (...a: unknown[]) => { record('channels.provide', a); return () => { undone.push('provider') } },
      providerOf: () => state.provider as never,
      proactiveProviderOf: () => undefined,
    },
    audit: { sent: async (...a: unknown[]) => { record('audit.sent', a) } },
    secrets: { get: async (name) => { record('secrets.get', [name]); return state.secrets.get(name) } },
    clock,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    pluginsDir: dir,
    participantsOf: async (channel) => { record('participantsOf', [channel]); return ['p1', 'p2'] },
    readRecord: async (id) => { record('readRecord', [id]); return state.records.get(id) ?? null },
    loadEntry: async () => options.apply ?? ((c) => { ctx = c }),
    applyTimeoutMs: 200,
    lookup: async () => ['93.184.216.34'],
    ...options.deps,
  }
  const runtime: PluginRuntime = createPluginRuntime(deps)
  return { runtime, calls, clock, dir, undone, state, deps, ctx: () => ctx as BrainContext }
}

export async function denial(promise: unknown, code = 'PERMISSION_DENIED'): Promise<void> {
  let caught: unknown
  try { await (typeof promise === 'function' ? (promise as () => unknown)() : promise) } catch (error) { caught = error }
  if (!(caught instanceof BrainError) || caught.code !== code) {
    throw new Error(`expected ${code}, got ${caught instanceof BrainError ? caught.code : String(caught)}`)
  }
}

/** A record as the store would hand it back; only what the plugin runtime looks at matters. */
export function stored(id: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return { id, layer: 'L1', kind: 'l1.fact', source: 'qq', channel: 'qq:private:1', subjects: [], actor: 'a', content: {}, evidence: [],
    visibility: 'origin', trust: 'member', confidence: 1, importance: 0.5, tEvent: 0, tIngest: 0, status: 'active', version: 1, ...overrides }
}
