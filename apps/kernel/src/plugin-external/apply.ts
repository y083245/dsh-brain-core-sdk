import { spawn, type ChildProcess } from 'node:child_process'
import os from 'node:os'
import type { Readable, Writable } from 'node:stream'
import type {
  BrainContext, ChannelProvider, DerivedRecordInput, Disposable, FetchOptions, MemoryProvider,
  MemoryProviderHealth, MemoryProviderHit, OutboundMessage, PluginApply, ReadL0Request, ToolDefinition,
  ToolOutput, ToolParameters, ViewOptions,
} from '@dsh-brain-core/sdk'
import { BrainError, PLUGIN_API_VERSION } from '@dsh-brain-core/sdk'
import { killProcessTree } from '@dsh-brain-core/satellite-host'
import type { InstalledPlugin } from '../contracts/index.ts'
import type { LogFields } from '../log/index.ts'
import { createStderrSink, ensurePluginDirs, pluginEnvironment, stderrFile, type StderrSink } from './env.ts'
import { ALIVE_PROBE_MS, probeName } from './liveness.ts'
import { LineConnection, MethodNotFound } from './protocol.ts'
import type { ExternalDeps } from './types.ts'

const RESTART_DELAYS_MS = [1000, 2000, 4000] as const
const RESTART_WINDOW_MS = 60_000
const SHUTDOWN_GRACE_MS = 3000
const KILL_WAIT_MS = 5000

interface Ready extends Promise<void> {
  resolve(): void
  reject(error: Error): void
  readonly settled: boolean
}

interface Generation {
  readonly child: ChildProcess
  readonly rpc: LineConnection
  readonly stderr: StderrSink
  readonly ready: Ready
  readonly registrations: Disposable[]
  readonly wsSubscriptions: Map<string, Disposable>
  readonly pendingWsSubscriptions: Map<string, symbol>
  exited: Promise<void>
  done: boolean
}

function readySignal(): Ready {
  let resolveFn: () => void = () => undefined
  let rejectFn: (error: Error) => void = () => undefined
  const promise = new Promise<void>((resolve, reject) => { resolveFn = resolve; rejectFn = reject })
  const ready = promise as Ready
  let settled = false
  ready.resolve = () => { if (settled) return; settled = true; resolveFn() }
  ready.reject = (error) => { if (settled) return; settled = true; rejectFn(error) }
  Object.defineProperty(ready, 'settled', { get: () => settled })
  return ready
}

function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms)
    void work.then(
      (value) => { clearTimeout(timer); resolve(value) },
      () => { clearTimeout(timer); resolve(undefined) },
    )
  })
}

function invalid(message: string): BrainError {
  return new BrainError('INVALID_ARGUMENT', message)
}

function paramsObject(params: unknown): Record<string, unknown> {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) throw invalid('params must be an object')
  return params as Record<string, unknown>
}

function stringField(params: Record<string, unknown>, key: string, allowEmpty = false): string {
  const value = params[key]
  if (typeof value !== 'string' || (!allowEmpty && value === '')) throw invalid(`${key} must be a non-empty string`)
  return value
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw invalid(`${key} must be a string`)
  return value
}

function numberField(params: Record<string, unknown>, key: string): number {
  const value = params[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(`${key} must be a number`)
  return value
}

function objectField(params: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = params[key]
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${key} must be an object`)
  return value as Record<string, unknown>
}

function optionalObject(params: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid(`${key} must be an object`)
  return value as Record<string, unknown>
}

function apiMajor(version: string): number | null {
  const match = /^(\d+)(?:\.|$)/.exec(version)
  return match === null ? null : Number(match[1])
}

/**
 * Runs one plugin as a child process and mirrors its ctx use over JSON-RPC. The apply resolves once
 * plugin.ready arrives; crashes after that are restarted 1/2/4 seconds apart, at most three times in
 * a sixty second window.
 */
class ExternalPlugin {
  readonly #plugin: InstalledPlugin
  readonly #deps: ExternalDeps
  readonly #ctx: BrainContext
  readonly #config: unknown
  readonly #id: string
  #current: Generation | undefined
  #stopped = false
  #shuttingDown = false
  #everReady = false
  #watchdog: NodeJS.Timeout | undefined
  #restartTimer: NodeJS.Timeout | undefined
  #restarts: number[] = []

  constructor(plugin: InstalledPlugin, deps: ExternalDeps, ctx: BrainContext, config: unknown) {
    this.#plugin = plugin
    this.#deps = deps
    this.#ctx = ctx
    this.#config = config
    this.#id = plugin.manifest.id
  }

  async start(): Promise<void> {
    await ensurePluginDirs(this.#deps.pluginsDir, this.#id)
    this.#startWatchdog()
    try {
      await this.#spawn(true)
    } catch (error) {
      this.#stopped = true
      this.#stopWatchdog()
      throw error
    }
  }

  #startWatchdog(): void {
    if (this.#watchdog !== undefined) return
    this.#watchdog = setInterval(() => {
      if (this.#shuttingDown || this.#stopped) return
      try {
        // The runtime refuses every ctx call once the plugin's fiber is disposed; this is the one
        // observable signal that the kernel has disabled the plugin.
        this.#ctx.events.emit(probeName(this.#id), {})
      } catch {
        void this.shutdown()
      }
    }, ALIVE_PROBE_MS)
    this.#watchdog.unref()
  }

  #stopWatchdog(): void {
    if (this.#watchdog === undefined) return
    clearInterval(this.#watchdog)
    this.#watchdog = undefined
  }

  async #spawn(initial: boolean): Promise<void> {
    if (this.#stopped || this.#shuttingDown) throw new BrainError('UNAVAILABLE', 'plugin is not enabled')
    const processSpec = this.#plugin.manifest.process
    if (processSpec === undefined) throw invalid('runtime process needs process.command')
    const env = pluginEnvironment(this.#plugin, this.#deps.pluginsDir, this.#deps.parentEnv ?? process.env)
    const child = spawn(processSpec.command, [...(processSpec.args ?? [])], {
      cwd: this.#plugin.dir, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    child.once('error', () => undefined)
    if (child.pid !== undefined) {
      try { os.setPriority(child.pid, 10) } catch { /* lowering priority is best effort */ }
    }
    if (child.stdin === null || child.stdout === null) {
      try { child.kill() } catch { /* never started */ }
      throw new BrainError('UNAVAILABLE', 'plugin process did not start')
    }
    const stderr = createStderrSink(stderrFile(this.#deps.pluginsDir, this.#id))
    child.stderr?.on('data', (chunk: Buffer) => { stderr.write(chunk) })
    child.stderr?.on('error', () => undefined)
    child.stdin?.on('error', () => undefined)
    child.stdout?.on('error', () => undefined)

    const rpc = new LineConnection(child.stdin as Writable, child.stdout as Readable, {
      request: (method, params) => this.#handleRequest(gen, method, params),
      notification: (method) => { if (method === 'plugin.ready') gen.ready.resolve() },
      log: (event) => { this.#deps.log.warn(event, { plugin: this.#id }) },
    })
    const gen: Generation = {
      child, rpc, stderr, ready: readySignal(), registrations: [],
      wsSubscriptions: new Map(), pendingWsSubscriptions: new Map(),
      exited: Promise.resolve(), done: false,
    }
    gen.exited = new Promise<void>((resolve) => {
      let reported = false
      const finish = (code: number | null): void => {
        if (reported) return
        reported = true
        resolve()
        this.#onExit(gen, code)
      }
      child.once('exit', (code) => finish(code))
      child.once('error', () => finish(null))
    })
    this.#current = gen
    // The initialize failure below may win the race; keep the ready promise handled anyway.
    void gen.ready.catch(() => undefined)

    try {
      const result = await gen.rpc.request('initialize', {
        apiVersion: PLUGIN_API_VERSION,
        pluginId: this.#id,
        version: this.#plugin.version,
        config: this.#config ?? this.#plugin.config ?? {},
        permissions: [...this.#plugin.granted],
      })
      const returned = result !== null && typeof result === 'object' ? (result as { apiVersion?: unknown }).apiVersion : undefined
      if (typeof returned !== 'string' || apiMajor(returned) !== apiMajor(PLUGIN_API_VERSION)) {
        throw invalid('plugin API major version does not match')
      }
      await gen.ready
      if (gen.done) throw new BrainError('UNAVAILABLE', 'plugin process exited')
      if (initial) this.#everReady = true
    } catch (error) {
      await this.#kill(gen)
      if (error instanceof BrainError) throw error
      throw new BrainError('UNAVAILABLE', 'plugin failed to start')
    }
  }

  #onExit(gen: Generation, code: number | null): void {
    if (gen.done) return
    gen.done = true
    this.#revoke(gen)
    gen.rpc.close(new BrainError('UNAVAILABLE', 'plugin process exited'))
    gen.ready.reject(new BrainError('UNAVAILABLE', 'plugin process exited'))
    void gen.stderr.close()
    if (this.#current === gen) this.#current = undefined
    if (this.#shuttingDown || this.#stopped) return
    const fields: LogFields = code === null ? { plugin: this.#id } : { plugin: this.#id, code: String(code) }
    this.#deps.log.warn('plugin.exited', fields)
    if (!this.#everReady) return
    this.#scheduleRestart()
  }

  #scheduleRestart(): void {
    if (this.#shuttingDown || this.#stopped) return
    const now = this.#deps.now()
    this.#restarts = this.#restarts.filter((at) => now - at < RESTART_WINDOW_MS)
    if (this.#restarts.length >= RESTART_DELAYS_MS.length) {
      this.#stopped = true
      this.#stopWatchdog()
      this.#deps.log.error('plugin.failed', { plugin: this.#id })
      try { this.#deps.onFailed(this.#id) } catch { /* the callback turns the plugin off; it cannot undo the failure */ }
      return
    }
    const wait = RESTART_DELAYS_MS[this.#restarts.length] as number
    this.#deps.log.warn('plugin.restarting', { plugin: this.#id, count: this.#restarts.length + 1 })
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined
      if (this.#shuttingDown || this.#stopped) return
      this.#restarts.push(this.#deps.now())
      void this.#spawn(false).catch(() => {
        this.#deps.log.warn('plugin.restart_failed', { plugin: this.#id })
      })
    }, wait)
  }

  #revoke(gen: Generation): void {
    gen.pendingWsSubscriptions.clear()
    for (const dispose of gen.wsSubscriptions.values()) {
      try { dispose() } catch { /* a broken disposer must not block the rest */ }
    }
    gen.wsSubscriptions.clear()
    for (const dispose of gen.registrations.splice(0).reverse()) {
      try { dispose() } catch { /* a broken disposer must not block the rest */ }
    }
  }

  async #kill(gen: Generation): Promise<void> {
    if (gen.done) return
    try { gen.child.stdin?.end() } catch { /* already gone */ }
    if (gen.child.pid !== undefined) {
      try { await killProcessTree(gen.child.pid) } catch { /* taskkill may already see it gone */ }
    }
    await within(gen.exited, KILL_WAIT_MS)
  }

  async shutdown(): Promise<void> {
    if (this.#shuttingDown) return
    this.#shuttingDown = true
    this.#stopped = true
    this.#stopWatchdog()
    if (this.#restartTimer !== undefined) {
      clearTimeout(this.#restartTimer)
      this.#restartTimer = undefined
    }
    const gen = this.#current
    if (gen === undefined) return
    this.#revoke(gen)
    if (gen.done) { await gen.stderr.close(); return }
    gen.rpc.notify('shutdown')
    const gone = (await within(gen.exited.then(() => true), SHUTDOWN_GRACE_MS)) === true
    if (!gone && gen.child.pid !== undefined) {
      try { await killProcessTree(gen.child.pid) } catch { /* already gone */ }
      await within(gen.exited, KILL_WAIT_MS)
    }
    await gen.stderr.close()
  }

  async #fire(gen: Generation, id: string): Promise<void> {
    await gen.rpc.request('schedule.fire', { id }).then(
      () => undefined,
      () => { this.#deps.log.warn('plugin.schedule_failed', { plugin: this.#id }) },
    )
  }

  #handleRequest(gen: Generation, method: string, params: unknown): Promise<unknown> {
    const ctx = this.#ctx
    switch (method) {
      case 'memory.ingest': return Promise.resolve(ctx.memory.ingest(objectField(paramsObject(params), 'event') as never))
      case 'memory.record': return Promise.resolve(ctx.memory.record(objectField(paramsObject(params), 'input') as never))
      case 'memory.update': {
        const p = paramsObject(params)
        const view = optionalObject(p, 'view') as ViewOptions | undefined
        return Promise.resolve(ctx.memory.update(stringField(p, 'id'), objectField(p, 'patch') as never, numberField(p, 'expectedVersion'), view))
      }
      case 'memory.remove': {
        const p = paramsObject(params)
        return Promise.resolve(ctx.memory.remove(stringField(p, 'id'), optionalObject(p, 'view') as ViewOptions | undefined))
      }
      case 'memory.search': {
        const p = paramsObject(params)
        return Promise.resolve(ctx.memory.search(objectField(p, 'request') as never, optionalObject(p, 'view') as ViewOptions | undefined))
      }
      case 'memory.readChannelEvent': {
        const p = paramsObject(params)
        const recordId = stringField(p, 'recordId')
        const call = objectField(p, 'call')
        if (ctx.memory.readChannelEvent === undefined) {
          return Promise.reject(new BrainError('UNAVAILABLE', 'memory.readChannelEvent is not supported by this kernel'))
        }
        return Promise.resolve(ctx.memory.readChannelEvent(recordId, call as never))
      }
      case 'memory.context': return Promise.resolve(ctx.memory.context(objectField(paramsObject(params), 'request') as never))
      case 'memory.forget': return Promise.resolve(ctx.memory.forget(objectField(paramsObject(params), 'selector') as never))
      case 'memory.readL0': {
        const p = params === undefined || params === null ? {} : paramsObject(params)
        return Promise.resolve(ctx.memory.readL0(optionalObject(p, 'request') as ReadL0Request | undefined))
      }
      case 'memory.writeDerived':
        return Promise.resolve(ctx.memory.writeDerived(objectField(paramsObject(params), 'input') as unknown as DerivedRecordInput))
      case 'memory.provide': {
        const provider: MemoryProvider = {
          search: (query) => gen.rpc.request('memoryProvider.search', { query }) as Promise<readonly MemoryProviderHit[]>,
          onRecord: (record) => gen.rpc.request('memoryProvider.onRecord', { record }).then(() => undefined),
          onForgotten: (ids) => gen.rpc.request('memoryProvider.onForgotten', { ids }).then(() => undefined),
          health: () => gen.rpc.request('memoryProvider.health', {}) as Promise<MemoryProviderHealth>,
        }
        gen.registrations.push(ctx.memory.provide(provider))
        return Promise.resolve(null)
      }
      case 'agent.wake': {
        const p = paramsObject(params)
        return Promise.resolve(ctx.agent.wake(stringField(p, 'channel'), objectField(p, 'input') as never))
      }
      case 'agent.rotate': {
        const p = paramsObject(params)
        return Promise.resolve(ctx.agent.session(stringField(p, 'channel')).rotate())
      }
      case 'tools.register': {
        const p = paramsObject(params)
        const name = stringField(p, 'name')
        const description = stringField(p, 'description', true)
        const parameters = objectField(p, 'parameters') as ToolParameters
        const tool: ToolDefinition = {
          name,
          description,
          parameters,
          handler: (args, call) => gen.rpc.request('tool.invoke', { name, args, call }) as Promise<ToolOutput>,
        }
        gen.registrations.push(ctx.tools.register(tool))
        return Promise.resolve(null)
      }
      case 'channel.provide': {
        const provider: ChannelProvider = {
          send: (channel, message) => gen.rpc.request('channel.send', { channel, message }) as Promise<{ messageId?: string }>,
          members: (channel) => gen.rpc.request('channel.members', { channel }) as Promise<readonly string[]>,
          resolveIdentity: (account) => gen.rpc.request('channel.resolveIdentity', { account }) as Promise<{ displayName?: string } | null>,
        }
        gen.registrations.push(ctx.channel.provide(provider))
        return Promise.resolve(null)
      }
      case 'channel.send': {
        const p = paramsObject(params)
        return Promise.resolve(ctx.channel.send(stringField(p, 'channel'), objectField(p, 'message') as OutboundMessage))
      }
      case 'identity.resolve': return Promise.resolve(ctx.identity.resolve(stringField(paramsObject(params), 'account')))
      case 'identity.link': {
        const p = paramsObject(params)
        return Promise.resolve(ctx.identity.link(stringField(p, 'account'), stringField(p, 'personId')))
      }
      case 'scheduler.every': {
        const p = paramsObject(params)
        const id = stringField(p, 'id')
        gen.registrations.push(ctx.scheduler.every(numberField(p, 'ms'), () => this.#fire(gen, id)))
        return Promise.resolve(null)
      }
      case 'scheduler.at': {
        const p = paramsObject(params)
        const id = stringField(p, 'id')
        gen.registrations.push(ctx.scheduler.at(numberField(p, 'timeMs'), () => this.#fire(gen, id)))
        return Promise.resolve(null)
      }
      case 'scheduler.ownTime': {
        const p = paramsObject(params)
        const id = stringField(p, 'id')
        const name = stringField(p, 'name')
        const everyMs = numberField(p, 'everyMs')
        gen.registrations.push(ctx.scheduler.ownTime({ name, everyMs, run: () => this.#fire(gen, id) }))
        return Promise.resolve(null)
      }
      case 'events.on': {
        const name = stringField(paramsObject(params), 'name')
        gen.registrations.push(ctx.events.on(name, (payload) => { gen.rpc.notify('event', { name, payload }) }))
        return Promise.resolve(null)
      }
      case 'events.emit': {
        const p = paramsObject(params)
        ctx.events.emit(stringField(p, 'name'), objectField(p, 'payload'))
        return Promise.resolve(null)
      }
      case 'http.route': {
        const p = paramsObject(params)
        const routeId = stringField(p, 'routeId')
        gen.registrations.push(ctx.http.route(stringField(p, 'method'), stringField(p, 'path'), (request) =>
          gen.rpc.request('http.request', { routeId, request })))
        return Promise.resolve(null)
      }
      case 'http.fetch': {
        const p = paramsObject(params)
        const url = stringField(p, 'url')
        const raw = optionalObject(p, 'options')
        const options: Record<string, unknown> = raw === undefined ? {} : { ...raw }
        if (options.redirect !== undefined && options.redirect !== 'follow' && options.redirect !== 'error') {
          throw invalid('invalid redirect option')
        }
        if (options.body !== undefined) {
          if (typeof options.body !== 'string') throw invalid('options.body must be base64 text')
          options.body = new Uint8Array(Buffer.from(options.body, 'base64'))
        }
        return Promise.resolve(ctx.http.fetch(url, options as FetchOptions).then((response) => ({
          status: response.status,
          headers: response.headers,
          base64: Buffer.from(response.bytes()).toString('base64'),
        })))
      }
      case 'http.subscribeWebSocket': {
        const p = paramsObject(params)
        const subscriptionId = stringField(p, 'subscriptionId')
        const options = objectField(p, 'options')
        if (gen.wsSubscriptions.has(subscriptionId) || gen.pendingWsSubscriptions.has(subscriptionId)) {
          throw new BrainError('CONFLICT', `websocket subscription ${subscriptionId} already exists`)
        }
        if (ctx.http.subscribeWebSocket === undefined) {
          throw new BrainError('UNAVAILABLE', 'http.subscribeWebSocket is not supported by this kernel')
        }
        const attempt = Symbol(subscriptionId)
        gen.pendingWsSubscriptions.set(subscriptionId, attempt)
        let registeredDispose: Disposable | undefined
        return (async () => {
          try {
            const dispose = await ctx.http.subscribeWebSocket!(options as never, async (event) => {
              if (event.type === 'close' && registeredDispose !== undefined && gen.wsSubscriptions.get(subscriptionId) === registeredDispose) {
                gen.wsSubscriptions.delete(subscriptionId)
              }
              if (gen.done) return
              try {
                await gen.rpc.request('http.wsEvent', { subscriptionId, event })
              } catch {
                /* child closed */
              }
            })
            if (gen.done || gen.pendingWsSubscriptions.get(subscriptionId) !== attempt) {
              try { dispose() } catch { /* ignore */ }
              throw new BrainError(
                'UNAVAILABLE',
                gen.done ? 'plugin process exited' : 'websocket subscription cancelled',
              )
            }
            registeredDispose = dispose
            gen.wsSubscriptions.set(subscriptionId, dispose)
            return null
          } finally {
            if (gen.pendingWsSubscriptions.get(subscriptionId) === attempt) {
              gen.pendingWsSubscriptions.delete(subscriptionId)
            }
          }
        })()
      }
      case 'http.unsubscribeWebSocket': {
        const p = paramsObject(params)
        const subscriptionId = stringField(p, 'subscriptionId')
        gen.pendingWsSubscriptions.delete(subscriptionId)
        const dispose = gen.wsSubscriptions.get(subscriptionId)
        if (dispose !== undefined) {
          gen.wsSubscriptions.delete(subscriptionId)
          dispose()
        }
        return Promise.resolve(null)
      }
      case 'console.page': {
        const p = paramsObject(params)
        gen.registrations.push(ctx.console.page({
          id: stringField(p, 'id'), title: stringField(p, 'title'), entry: stringField(p, 'entry'),
        }))
        return Promise.resolve(null)
      }
      case 'secrets.get': {
        const name = stringField(paramsObject(params), 'name')
        return Promise.resolve(ctx.secrets.get(name).then((value) => value ?? null))
      }
      case 'storage.read': {
        const path = stringField(paramsObject(params), 'path')
        return Promise.resolve(ctx.storage.read(path).then((bytes) => bytes === undefined ? null : { base64: Buffer.from(bytes).toString('base64') }))
      }
      case 'storage.write': {
        const p = paramsObject(params)
        return Promise.resolve(ctx.storage.write(stringField(p, 'path'), new Uint8Array(Buffer.from(stringField(p, 'base64', true), 'base64'))).then(() => null))
      }
      case 'storage.remove': return Promise.resolve(ctx.storage.remove(stringField(paramsObject(params), 'path')).then(() => null))
      case 'storage.list': return Promise.resolve(ctx.storage.list(optionalString(paramsObject(params), 'prefix')))
      case 'logger.log': {
        const p = paramsObject(params)
        const level = stringField(p, 'level')
        if (level !== 'info' && level !== 'warn' && level !== 'error') throw invalid('level must be info, warn or error')
        const fields = optionalObject(p, 'fields')
        ctx.logger[level](stringField(p, 'event'), fields as Readonly<Record<string, string | number | boolean>> | undefined)
        return Promise.resolve(null)
      }
      case 'llm.complete': return Promise.resolve(ctx.llm.complete(objectField(paramsObject(params), 'request') as never))
      default: throw new MethodNotFound()
    }
  }
}

/** The apply function for runtime: 'process'. */
export function createExternalApply(plugin: InstalledPlugin, deps: ExternalDeps): PluginApply {
  return async (ctx, config) => {
    const manager = new ExternalPlugin(plugin, deps, ctx as BrainContext, config)
    await manager.start()
  }
}
