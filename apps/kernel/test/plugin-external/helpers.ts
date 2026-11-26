import { mkdtemp, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BrainError, type BrainContext, type BrainManifest, type ChannelEventResult, type MemoryProvider,
  type MemoryRecord, type ReadL0Result, type ToolCallContext, type ToolDefinition,
  type WebSocketEvent, type WebSocketSubscribeOptions,
} from '@brain-core/sdk'
import type { InstalledPlugin } from '../../src/contracts/index.ts'
import type { ExternalDeps } from '../../src/plugin-external/index.ts'
import type { Logger, LogFields } from '../../src/log/index.ts'

export const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
export const CHILD = path.join(FIXTURE_DIR, 'child.ts')
export const MCP_CHILD = path.join(FIXTURE_DIR, 'mcp-stdio.ts')

export interface LogEntry { readonly level: 'info' | 'warn' | 'error'; readonly event: string; readonly fields?: LogFields }

export interface FakeCalls {
  readonly memoryIngest: unknown[][]
  readonly memoryRecord: unknown[][]
  readonly memoryUpdate: unknown[][]
  readonly memoryRemove: unknown[][]
  readonly memorySearch: unknown[][]
  readonly memoryReadChannelEvent: unknown[][]
  readonly memoryContext: unknown[][]
  readonly memoryForget: unknown[][]
  readonly memoryReadL0: unknown[][]
  readonly memoryWriteDerived: unknown[][]
  readonly agentWake: unknown[][]
  readonly agentRotate: unknown[][]
  readonly identityResolve: unknown[][]
  readonly identityLink: unknown[][]
  readonly httpFetch: unknown[][]
  readonly httpSubscribeWebSocket: unknown[][]
  readonly secretsGet: unknown[][]
  readonly logger: { level: string; event: string; fields?: unknown }[]
  readonly llmComplete: unknown[][]
  readonly storage: { op: string; path?: string; base64?: string; prefix?: string }[]
  readonly emits: { name: string; payload: unknown }[]
}

function freshCalls(): FakeCalls {
  return {
    memoryIngest: [], memoryRecord: [], memoryUpdate: [], memoryRemove: [], memorySearch: [], memoryReadChannelEvent: [], memoryContext: [], memoryForget: [],
    memoryReadL0: [], memoryWriteDerived: [],
    agentWake: [], agentRotate: [], identityResolve: [], identityLink: [], httpFetch: [], httpSubscribeWebSocket: [], secretsGet: [], logger: [],
    llmComplete: [], storage: [], emits: [],
  }
}

export interface FakeContextState {
  active: boolean
  readonly id: string
  config: Record<string, unknown>
  readonly calls: FakeCalls
  readonly failures: Map<string, Error>
  readonly tools: Map<string, ToolDefinition>
  readonly providers: { send: (channel: string, message: unknown) => Promise<unknown>; members: (channel: string) => Promise<unknown>; resolveIdentity: (account: string) => Promise<unknown> }[]
  readonly memoryProviders: MemoryProvider[]
  readonly events: Map<string, Set<(payload: unknown) => unknown>>
  readonly every: { ms: number; run: () => unknown }[]
  readonly at: { timeMs: number; run: () => unknown }[]
  readonly ownTime: { request: { name: string; everyMs: number; run: () => unknown } }[]
  readonly routes: Map<string, (request: unknown) => unknown>
  readonly pages: Map<string, { id: string; title: string; entry: string }>
  readonly wsSubscriptions: { readonly options: WebSocketSubscribeOptions; readonly listener: (event: WebSocketEvent) => void | Promise<void>; disposed: boolean }[]
  readonly disposed: string[]
  readonly secrets: Map<string, string>
  readonly storage: Map<string, Uint8Array>
  fetchResponse: { status: number; headers: Record<string, string>; body: Uint8Array }
  memoryIngestResult: { id: string }
  memorySearchResult: unknown
  memoryReadChannelEventResult: ChannelEventResult
  memoryReadL0Result: ReadL0Result
  memoryWriteDerivedResult: MemoryRecord
}

export interface FakeContext { ctx: BrainContext; state: FakeContextState; revoke: () => void }

const ALIVE_SUFFIX = '.__brain_alive__'

function denied(): BrainError {
  return new BrainError('PERMISSION_DENIED', 'plugin is not enabled')
}

function check(state: FakeContextState, method: string): void {
  if (!state.active) throw denied()
  const failure = state.failures.get(method)
  if (failure !== undefined) throw failure
}

/** A BrainContext stand-in: records every call, can fail a method on demand, and throws after revoke like the runtime does. */
export function fakeContext(options: { id?: string; config?: Record<string, unknown>; secrets?: Record<string, string> } = {}): FakeContext {
  const id = options.id ?? 'echo'
  const state: FakeContextState = {
    active: true, id, config: options.config ?? {}, calls: freshCalls(), failures: new Map(), tools: new Map(), providers: [], memoryProviders: [],
    events: new Map(), every: [], at: [], ownTime: [], routes: new Map(), pages: new Map(), wsSubscriptions: [], disposed: [], secrets: new Map(Object.entries(options.secrets ?? {})),
    storage: new Map(), fetchResponse: { status: 200, headers: { 'content-type': 'text/plain' }, body: new TextEncoder().encode('fetched') },
    memoryIngestResult: { id: 'r1' }, memorySearchResult: { items: [{ record: { id: 'r1' }, disclosure: { speakable: 'yes', label: 'here' }, score: 1 }], degraded: false },
    memoryReadChannelEventResult: { record: { id: 'r1', layer: 'L0' } as unknown as MemoryRecord, disclosure: { speakable: 'yes', label: '就在这里说过' } },
    memoryReadL0Result: { items: [] }, memoryWriteDerivedResult: { id: 'r3', layer: 'L1', kind: 'l1.candidate' } as unknown as MemoryRecord,
  }
  const memory: BrainContext['memory'] = {
    async ingest(event) { check(state, 'memory.ingest'); state.calls.memoryIngest.push([event]); return state.memoryIngestResult },
    async record(input) { check(state, 'memory.record'); state.calls.memoryRecord.push([input]); return { id: 'r2' } as never },
    async update(...args: unknown[]) { check(state, 'memory.update'); state.calls.memoryUpdate.push(args); return { id: 'r2' } as never },
    async remove(...args: unknown[]) { check(state, 'memory.remove'); state.calls.memoryRemove.push(args) },
    async search(...args: unknown[]) { check(state, 'memory.search'); state.calls.memorySearch.push(args); return state.memorySearchResult as never },
    async readChannelEvent(recordId: string, call: ToolCallContext) {
      check(state, 'memory.readChannelEvent')
      state.calls.memoryReadChannelEvent.push([recordId, call])
      return state.memoryReadChannelEventResult
    },
    async context(...args: unknown[]) { check(state, 'memory.context'); state.calls.memoryContext.push(args); return {} as never },
    async forget(...args: unknown[]) { check(state, 'memory.forget'); state.calls.memoryForget.push(args); return { tombstoned: 0, invalidated: 0, l3Flagged: 0 } },
    async readL0(...args: unknown[]) { check(state, 'memory.readL0'); state.calls.memoryReadL0.push(args); return state.memoryReadL0Result },
    async writeDerived(...args: unknown[]) { check(state, 'memory.writeDerived'); state.calls.memoryWriteDerived.push(args); return state.memoryWriteDerivedResult },
    provide(provider: MemoryProvider) {
      check(state, 'memory.provide')
      state.memoryProviders.push(provider)
      return () => {
        state.disposed.push('memoryProvider')
        const idx = state.memoryProviders.indexOf(provider)
        if (idx !== -1) state.memoryProviders.splice(idx, 1)
      }
    },
  }
  const ctx = {
    plugin: { id, version: '1.0.0' },
    memory,
    agent: {
      session: (channel: string) => ({ channel, wake: async () => ({}), rotate: async () => { state.calls.agentRotate.push([channel]) } }),
      async wake(...args: unknown[]) { check(state, 'agent.wake'); state.calls.agentWake.push(args); return { wakeId: 'w' } as never },
    },
    tools: {
      register(tool: ToolDefinition) {
        check(state, 'tools.register')
        state.tools.set(tool.name, tool)
        return () => { state.disposed.push(`tool:${tool.name}`); state.tools.delete(tool.name) }
      },
    },
    channel: {
      provide(provider: FakeContextState['providers'][number]) {
        check(state, 'channel.provide')
        state.providers.push(provider)
        return () => { state.disposed.push('provider'); state.providers.splice(state.providers.indexOf(provider), 1) }
      },
      async send(...args: unknown[]) { check(state, 'channel.send'); return { messageId: 'm1', args } as never },
    },
    identity: {
      async resolve(...args: unknown[]) { check(state, 'identity.resolve'); state.calls.identityResolve.push(args); return 'p1' },
      async link(...args: unknown[]) { check(state, 'identity.link'); state.calls.identityLink.push(args) },
    },
    scheduler: {
      every(ms: number, run: () => unknown) {
        check(state, 'scheduler.every'); state.every.push({ ms, run }); return () => { state.disposed.push('every') }
      },
      at(timeMs: number, run: () => unknown) {
        check(state, 'scheduler.at'); state.at.push({ timeMs, run }); return () => { state.disposed.push('at') }
      },
      ownTime(request: { name: string; everyMs: number; run: () => unknown }) {
        check(state, 'scheduler.ownTime'); state.ownTime.push({ request }); return () => { state.disposed.push('ownTime') }
      },
    },
    events: {
      on(name: string, handler: (payload: unknown) => unknown) {
        check(state, 'events.on')
        const set = state.events.get(name) ?? new Set()
        state.events.set(name, set)
        set.add(handler)
        return () => { state.disposed.push(`event:${name}`); set.delete(handler) }
      },
      emit(name: string, payload: unknown) {
        check(state, 'events.emit')
        if (name.endsWith(ALIVE_SUFFIX)) return
        state.calls.emits.push({ name, payload })
        for (const handler of [...(state.events.get(name) ?? [])]) {
          try { void handler(payload) } catch { /* dispatch swallows handler failures */ }
        }
      },
    },
    http: {
      route(method: string, routePath: string, handler: (request: unknown) => unknown) {
        check(state, 'http.route'); state.routes.set(`${method.toUpperCase()} ${routePath}`, handler)
        return () => { state.disposed.push(`route:${method} ${routePath}`) }
      },
      async fetch(...args: unknown[]) {
        check(state, 'http.fetch'); state.calls.httpFetch.push(args)
        const { status, headers, body } = state.fetchResponse
        return { status, headers, text: () => new TextDecoder().decode(body), bytes: () => body } as never
      },
      async subscribeWebSocket(options: WebSocketSubscribeOptions, listener: (event: WebSocketEvent) => void | Promise<void>) {
        check(state, 'http.subscribeWebSocket')
        state.calls.httpSubscribeWebSocket.push([options])
        const sub = { options, listener, disposed: false }
        state.wsSubscriptions.push(sub)
        return () => {
          sub.disposed = true
          state.disposed.push('wsSubscription')
        }
      },
    },
    console: {
      page(descriptor: { id: string; title: string; entry: string }) {
        check(state, 'console.page'); state.pages.set(descriptor.id, descriptor)
        return () => { state.disposed.push(`page:${descriptor.id}`) }
      },
    },
    config: state.config,
    secrets: {
      async get(name: string) { check(state, 'secrets.get'); state.calls.secretsGet.push([name]); return state.secrets.get(name) },
    },
    storage: {
      async read(file: string) { check(state, 'storage.read'); state.calls.storage.push({ op: 'read', path: file }); return state.storage.get(file) },
      async write(file: string, data: string | Uint8Array) {
        check(state, 'storage.write')
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
        state.calls.storage.push({ op: 'write', path: file, base64: Buffer.from(bytes).toString('base64') })
        state.storage.set(file, bytes)
      },
      async remove(file: string) { check(state, 'storage.remove'); state.calls.storage.push({ op: 'remove', path: file }); state.storage.delete(file) },
      async list(prefix?: string) {
        check(state, 'storage.list'); state.calls.storage.push({ op: 'list', prefix })
        return [...state.storage.keys()].filter((key) => prefix === undefined || key.startsWith(prefix)).sort()
      },
    },
    logger: {
      info(event: string, fields?: unknown) { check(state, 'logger.info'); state.calls.logger.push({ level: 'info', event, fields }) },
      warn(event: string, fields?: unknown) { check(state, 'logger.warn'); state.calls.logger.push({ level: 'warn', event, fields }) },
      error(event: string, fields?: unknown) { check(state, 'logger.error'); state.calls.logger.push({ level: 'error', event, fields }) },
    },
    llm: {
      async complete(...args: unknown[]) { check(state, 'llm.complete'); state.calls.llmComplete.push(args); return { text: 'ok', tokens: 1 } },
    },
  } as unknown as BrainContext
  return { ctx, state, revoke: () => { state.active = false } }
}

export interface HarnessOptions {
  readonly script: Record<string, unknown>
  readonly captureEnv?: boolean
  readonly config?: Record<string, unknown>
  readonly deps?: Partial<ExternalDeps>
  readonly fake?: Parameters<typeof fakeContext>[0]
  readonly manifest?: Partial<BrainManifest>
  readonly plugin?: Partial<InstalledPlugin>
  readonly processArgs?: readonly string[]
}

export interface Harness {
  readonly apply: (ctx: BrainContext, config: Record<string, unknown>) => void | Promise<void>
  readonly plugin: InstalledPlugin
  readonly deps: ExternalDeps
  readonly dir: string
  readonly logPath: string
  readonly scriptPath: string
  readonly envPath: string
  readonly ctx: FakeContext
  readonly logs: LogEntry[]
  readonly failed: string[]
  readonly entries: () => Record<string, unknown>[]
  readonly waitFor: (predicate: (entries: Record<string, unknown>[]) => boolean, timeoutMs?: number) => Promise<void>
  readonly stop: () => Promise<void>
}

export function manifest(overrides: Partial<BrainManifest> = {}): BrainManifest {
  return {
    id: 'echo', kinds: ['capability'], api: '^1', runtime: 'process',
    process: { command: process.execPath, args: [] },
    permissions: ['memory.ingest', 'memory.search', 'tools.register', 'channel.provide', 'channel.send', 'identity.link', 'schedule.ownTime'],
    source: { channels: ['echo:private:*'], eventKinds: ['echo.message'], defaultVisibility: 'origin', trust: 'member' },
    ...overrides,
  }
}

export async function harness(options: HarnessOptions): Promise<Harness> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'plugin-external-'))
  const logPath = path.join(dir, 'fixture.log')
  const scriptPath = path.join(dir, 'script.json')
  const envPath = path.join(dir, 'env.json')
  const script = { ...options.script, log: logPath, ...(options.captureEnv === true ? { envFile: envPath } : {}) }
  await writeFile(scriptPath, JSON.stringify(script))
  const base = manifest(options.manifest)
  const plugin: InstalledPlugin = {
    manifest: { ...base, process: { command: process.execPath, args: [CHILD, scriptPath, logPath, ...(options.processArgs ?? [])] } },
    version: '1.0.0', dir: FIXTURE_DIR, granted: base.permissions, config: options.config ?? {},
    ...options.plugin,
  }
  const fake = fakeContext(options.fake)
  const logs: LogEntry[] = []
  const failed: string[] = []
  const logger: Logger = {
    info: (event, fields) => logs.push({ level: 'info', event, fields }),
    warn: (event, fields) => logs.push({ level: 'warn', event, fields }),
    error: (event, fields) => logs.push({ level: 'error', event, fields }),
  }
  const deps: ExternalDeps = {
    pluginsDir: dir,
    log: logger,
    now: () => Date.now(),
    onFailed: (id) => { failed.push(id) },
    parentEnv: { PATH: process.env.PATH, SENTINEL: 'must-not-leak', HOME: '/parent-home', USERPROFILE: '/parent-home', LANG: process.env.LANG, TZ: 'UTC' },
    ...options.deps,
  }
  const { createExternalApply } = await import('../../src/plugin-external/index.ts')
  const apply = createExternalApply(plugin, deps)
  return {
    apply, plugin, deps, dir, logPath, scriptPath, envPath, ctx: fake, logs, failed,
    entries: () => readEntries(logPath),
    waitFor: (predicate, timeoutMs = 8000) => waitForEntries(logPath, predicate, timeoutMs),
    async stop() {
      fake.revoke()
      const pids = readEntries(logPath)
        .filter((entry) => entry.event === 'start')
        .map((entry) => entry.pid)
        .filter((pid): pid is number => typeof pid === 'number')
      await Promise.all(pids.map((pid) => waitUntil(() => !isAlive(pid), 7000)))
    },
  }
}

export function readEntries(logPath: string): Record<string, unknown>[] {
  if (!existsSync(logPath)) return []
  const text = readFileSync(logPath, 'utf8')
  const out: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try { out.push(JSON.parse(line) as Record<string, unknown>) } catch { /* partial last line */ }
  }
  return out
}

export async function waitForEntries(logPath: string, predicate: (entries: Record<string, unknown>[]) => boolean, timeoutMs = 8000): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (predicate(readEntries(logPath))) return
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for fixture log; entries: ${JSON.stringify(readEntries(logPath).slice(-5))}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - started > timeoutMs) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

export async function rejectsWithCode(promise: unknown, code: string): Promise<void> {
  let caught: unknown
  try { await (typeof promise === 'function' ? (promise as () => unknown)() : promise) } catch (error) { caught = error }
  if (!(caught instanceof BrainError) || caught.code !== code) {
    throw new Error(`expected ${code}, got ${caught instanceof BrainError ? caught.code : String(caught)}`)
  }
}
