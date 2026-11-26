import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  BrainError,
  type BrainContext, type BrainEvents, type ChannelEventResult, type ChannelProvider,
  type DerivedRecordInput, type Disposable, type ForgetSelector, type MemoryProvider, type MemoryRecord,
  type OutboundMessage, type PluginApply, type PluginRequest, type ReadL0Request, type ReadL0Result,
  type ToolDefinition, type Viewer, type ViewOptions,
} from '@brain-core/sdk'
import type {
  AgentRuntime, ChannelRegistry, Clock, GatewayTool, InstalledPlugin, MemoryProviderRegistry, MemoryService,
  OutboundAudit, PluginActivator, PluginLlmExecutor, Scheduler, ToolGateway, WriteIdentity,
} from '../contracts/index.ts'
import type { IdentityService } from '../identity-persona/index.ts'
import type { Logger } from '../log/index.ts'
import type { SecretStore } from '../secrets/index.ts'
import { guardedFetch, guardUrl as guard, type Lookup } from './network.ts'
import { createPluginLogger } from './plugin-logger.ts'
import { createPluginStorage } from './storage.ts'
import { subscribePluginWebSocket } from './ws.ts'

export { createPluginStorage }

export interface PluginRuntimeDeps {
  readonly memory: MemoryService
  readonly identity: Pick<IdentityService, 'resolve' | 'link'>
  readonly gateway: Pick<ToolGateway, 'register' | 'checkOutbound' | 'noteOutbound' | 'admitSend'>
  readonly agent: AgentRuntime
  readonly scheduler: Scheduler
  readonly channels: ChannelRegistry
  readonly audit: OutboundAudit
  readonly secrets: Pick<SecretStore, 'get'>
  readonly clock: Clock
  readonly log: Logger
  readonly pluginsDir: string                                            // state/plugins
  readonly participantsOf: (channel: string) => Promise<readonly string[]>
  readonly readRecord: (id: string) => Promise<MemoryRecord | null>
  readonly loadEntry: (plugin: InstalledPlugin) => Promise<PluginApply>
  readonly applyTimeoutMs?: number                                       // 30_000
  readonly lookup?: (host: string) => Promise<readonly string[]>         // DNS, tests pass a fake
  readonly listL0?: (request?: ReadL0Request) => Promise<ReadL0Result>
  readonly writeDerived?: (pluginId: string, input: DerivedRecordInput) => Promise<MemoryRecord>
  readonly readChannelEvent?: (recordId: string, sourcePluginId: string, viewer: Viewer) => Promise<ChannelEventResult>
  readonly memoryProviders?: MemoryProviderRegistry
  readonly llm?: PluginLlmExecutor
}
export interface PluginRuntime extends PluginActivator {
  /** The HTTP seam: throws NOT_FOUND when no route matches. */
  route(pluginId: string, request: PluginRequest): Promise<unknown>
  pages(): readonly { readonly pluginId: string; readonly id: string; readonly title: string; readonly entry: string }[]
  emit<K extends keyof BrainEvents>(name: K, payload: BrainEvents[K]): void
}

/** Throws PERMISSION_DENIED unless this plugin may reach the URL. Used by plugin-external for MCP addresses too. */
export function guardUrl(plugin: InstalledPlugin, url: URL, lookup?: PluginRuntimeDeps['lookup']): Promise<void> {
  return guard(plugin, url, lookup)
}

const HOUR_MS = 60 * 60 * 1000
const DEFAULT_APPLY_TIMEOUT_MS = 30_000

type Handler = (payload: unknown) => void | Promise<void>
type RouteHandler = (request: PluginRequest) => Promise<unknown>

interface Entry {
  readonly plugin: InstalledPlugin
  readonly fiber: ReturnType<Context['plugin']>
  active: boolean
  readonly routes: Map<string, RouteHandler>
  readonly pages: Map<string, { readonly id: string; readonly title: string; readonly entry: string }>
  readonly writes: number[]
  readonly activeCalls: Map<string, { readonly channel: string; readonly wakeId: string }>
}

function denied(message: string): BrainError {
  return new BrainError('PERMISSION_DENIED', message)
}

/** A fiber that already failed may hand back nothing instead of a promise. */
async function quietDispose(fiber: { dispose(): unknown }): Promise<void> {
  try { await fiber.dispose() } catch { /* the failure was already reported */ }
}

function raceWithTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BrainError('UNAVAILABLE', 'plugin apply timed out')), ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

/** `qq:group:*` matches `qq:group:123`; otherwise the channel must be equal. */
function channelMatches(pattern: string, channel: string): boolean {
  if (pattern === channel) return true
  const head = pattern.split(':')
  if (head.length < 3 || head[head.length - 1] !== '*') return false
  const prefix = head.slice(0, -1).join(':')
  return channel.startsWith(`${prefix}:`) && channel.length > prefix.length + 1 && channel.split(':').length >= 3
}

export function createPluginRuntime(deps: PluginRuntimeDeps): PluginRuntime {
  const root = new Context()
  const entries = new Map<string, Entry>()
  const states = new Map<string, 'enabled' | 'failed' | 'disabled'>()
  const listeners = new Map<string, Set<Handler>>()
  const applyTimeoutMs = deps.applyTimeoutMs ?? DEFAULT_APPLY_TIMEOUT_MS

  function dispatch(name: string, payload: unknown): void {
    for (const handler of [...(listeners.get(name) ?? [])]) {
      try {
        const result = handler(payload)
        if (result instanceof Promise) result.catch(() => deps.log.warn('plugin.event_handler_failed'))
      } catch {
        deps.log.warn('plugin.event_handler_failed')
      }
    }
  }

  function buildContext(entry: Entry): BrainContext {
    const { plugin } = entry
    const id = plugin.manifest.id
    const source = plugin.manifest.source

    const readSecrets = new Set<string>()
    const alive = (): void => {
      if (!entry.active || entries.get(id) !== entry) throw denied('plugin is not enabled')
    }
    const need = (permission: string): void => {
      alive()
      if (!plugin.granted.includes(permission)) throw denied(`permission ${permission} is not granted`)
    }
    const owns = (channel: unknown): channel is string =>
      typeof channel === 'string' && (source?.channels ?? []).some((pattern) => channelMatches(pattern, channel))
    const own = (channel: unknown): string => {
      if (!owns(channel)) throw denied('channel does not belong to this plugin')
      return channel
    }
    const limit = (): void => {
      const max = source?.rateLimitPerHour
      if (max === undefined) return
      const now = deps.clock.now()
      while (entry.writes.length > 0 && (entry.writes[0] as number) <= now - HOUR_MS) entry.writes.shift()
      if (entry.writes.length >= max) throw new BrainError('RATE_LIMITED', 'write rate limit reached')
      entry.writes.push(now)
    }
    const identityFor = (channels: readonly string[]): WriteIdentity => {
      if (source === undefined) throw denied('plugin has no source in its manifest')
      return {
        kind: 'plugin',
        source: id,
        trust: source.trust,
        defaultVisibility: source.defaultVisibility,
        channels,
        eventKinds: source.eventKinds,
      }
    }
    const viewerFor = async (view: ViewOptions | undefined): Promise<Viewer> => {
      const channel = view?.channel
      if (channel === undefined) return { caller: id, channel: null, participants: [] }
      own(channel)
      return { caller: id, channel, participants: await deps.participantsOf(channel) }
    }
    const effect = (register: () => () => void, label: string): Disposable => {
      alive()
      let dispose: () => unknown
      try {
        dispose = entry.fiber.ctx.effect(register, label)
      } catch (error) {
        if ((error as { code?: unknown }).code === 'INACTIVE_EFFECT') throw denied('plugin is not enabled')
        throw error
      }
      return () => { void Promise.resolve(dispose()).catch(() => undefined) }
    }

    const memory: BrainContext['memory'] = {
      async ingest(event) {
        need('memory.ingest')
        const channel = own((event as { channel?: unknown } | null)?.channel)
        limit()
        return deps.memory.ingest(event, identityFor([channel]))
      },
      async record(input) {
        need('memory.record')
        const channel = own((input as { channel?: unknown } | null)?.channel)
        limit()
        return deps.memory.record(input, identityFor([channel]))
      },
      async update(recordId, patch, expectedVersion, view) {
        need('memory.record')
        const viewer = await viewerFor(view)
        return deps.memory.update(recordId, patch, expectedVersion, identityFor(viewer.channel === null ? [] : [viewer.channel]), viewer)
      },
      async remove(recordId, view) {
        need('memory.record')
        const viewer = await viewerFor(view)
        return deps.memory.remove(recordId, identityFor(viewer.channel === null ? [] : [viewer.channel]), viewer)
      },
      async search(request, view) {
        need('memory.search')
        return deps.memory.search(request, await viewerFor(view))
      },
      async readChannelEvent(recordId, call) {
        need('memory.search')
        if (typeof recordId !== 'string' || recordId === '') {
          throw new BrainError('INVALID_ARGUMENT', 'a record id is required')
        }
        if (call === null || typeof call !== 'object' || Array.isArray(call)) {
          throw denied('readChannelEvent requires an active host-issued tool call')
        }
        const callToken = (call as { callToken?: unknown }).callToken
        if (typeof callToken !== 'string' || callToken === '') {
          throw denied('readChannelEvent requires an active host-issued tool call')
        }
        const active = entry.activeCalls.get(callToken)
        if (active === undefined || call.channel !== active.channel || call.wakeId !== active.wakeId) {
          throw denied('readChannelEvent requires an active host-issued tool call')
        }
        own(active.channel)
        if (deps.readChannelEvent === undefined) {
          throw new BrainError('UNAVAILABLE', 'memory readChannelEvent is not configured')
        }
        const viewer: Viewer = {
          caller: id,
          channel: active.channel,
          participants: await deps.participantsOf(active.channel),
        }
        return deps.readChannelEvent(recordId, id, viewer)
      },
      async context(request) {
        need('memory.context')
        const channel = own((request as { channel?: unknown } | null)?.channel)
        return deps.memory.context(request, await viewerFor({ channel }))
      },
      async forget(selector: ForgetSelector) {
        need('memory.forget')
        const raw = selector as unknown as Record<string, unknown>
        if (raw.by === 'record') {
          if (typeof raw.id !== 'string' || raw.id === '') throw new BrainError('INVALID_ARGUMENT', 'a record id is required')
          const record = await deps.readRecord(raw.id)
          // A record that is missing and one that belongs to someone else look the same.
          if (record === null || record.source !== id) throw new BrainError('NOT_FOUND', 'no such record')
          if (record.layer === 'L3') throw denied('L3 records cannot be forgotten by a plugin')
          return deps.memory.forget(selector)
        }
        if (raw.by === 'channel') {
          own(raw.channel)
          return deps.memory.forget(selector)
        }
        if (raw.by === 'time' && raw.channel !== undefined) {
          own(raw.channel)
          return deps.memory.forget(selector)
        }
        throw denied('this selector is for the owner only')
      },
      async readL0(request) {
        need('memory.readL0')
        if (!plugin.manifest.kinds.includes('memory-provider')) {
          throw denied('memory.readL0 requires plugin kind "memory-provider"')
        }
        if (deps.listL0 === undefined) {
          throw new BrainError('UNAVAILABLE', 'memory provider readL0 is not configured')
        }
        return deps.listL0(request)
      },
      async writeDerived(input) {
        need('memory.writeDerived')
        if (!plugin.manifest.kinds.includes('memory-provider')) {
          throw denied('memory.writeDerived requires plugin kind "memory-provider"')
        }
        if (deps.writeDerived === undefined) {
          throw new BrainError('UNAVAILABLE', 'memory provider writeDerived is not configured')
        }
        return deps.writeDerived(id, input)
      },
      provide(provider: MemoryProvider) {
        need('memory.readL0')
        if (!plugin.manifest.kinds.includes('memory-provider')) {
          throw denied('memory.provide requires plugin kind "memory-provider"')
        }
        if (
          typeof provider !== 'object' || provider === null
          || typeof provider.search !== 'function' || typeof provider.onForgotten !== 'function'
        ) {
          throw new BrainError('INVALID_ARGUMENT', 'memory provider must implement search and onForgotten')
        }
        const registry = deps.memoryProviders
        if (registry === undefined) {
          throw new BrainError('UNAVAILABLE', 'memory provider registry is not configured')
        }
        return effect(() => registry.register(id, provider), 'memory.provide')
      },
    }

    return {
      plugin: { id, version: plugin.version },
      memory,
      agent: {
        session(channel) {
          need('agent.session')
          const own_ = own(channel)
          return {
            channel: own_,
            wake: (input) => { alive(); return deps.agent.wake(own_, input) },
            rotate: () => { alive(); return deps.agent.rotate(own_) },
          }
        },
        async wake(channel, input) {
          need('agent.session')
          return deps.agent.wake(own(channel), input)
        },
      },
      tools: {
        register(tool: ToolDefinition) {
          need('tools.register')
          const declared = plugin.manifest.tools?.find((candidate) => candidate.name === tool.name)
          if (declared === undefined) throw denied(`tool ${tool.name} is not in the manifest`)
          const channels = declared.channels
            ?? (source === undefined ? ['*:*'] : source.channels.map((channel) => channel.split(':').slice(0, 2).join(':')))
          const group = declared.group === undefined ? undefined : plugin.manifest.groups?.[declared.group]
          const gatewayTool: GatewayTool = {
            pluginId: id,
            manifest: declared,
            ...(group === undefined ? {} : { group }),
            description: tool.description,
            parameters: tool.parameters,
            channels,
            invoke: async (args, call) => {
              alive()
              const callToken = randomBytes(24).toString('base64url')
              entry.activeCalls.set(callToken, { channel: call.channel, wakeId: call.wakeId })
              try {
                return await tool.handler(args, { channel: call.channel, wakeId: call.wakeId, callToken })
              } finally {
                entry.activeCalls.delete(callToken)
              }
            },
          }
          return effect(() => deps.gateway.register(gatewayTool), `tools.register(${tool.name})`)
        },
      },
      channel: {
        provide(provider: ChannelProvider) {
          need('channel.provide')
          const acceptsProactive = source?.proactiveMessaging === true && plugin.granted.includes('channel.send')
            ? owns : undefined
          return effect(() => acceptsProactive === undefined
            ? deps.channels.provide(id, provider)
            : deps.channels.provide(id, provider, acceptsProactive), 'channel.provide')
        },
        async send(channel: string, message: OutboundMessage) {
          need('channel.send')
          own(channel)
          const reason = deps.gateway.checkOutbound(channel, message.text ?? '')
          if (reason !== null) throw new BrainError('INVALID_ARGUMENT', reason)
          if (!deps.gateway.admitSend(id, channel)) throw new BrainError('RATE_LIMITED', 'send rate limit reached')
          const provider = deps.channels.providerOf(channel)
          let ok = false
          try {
            if (provider === undefined) throw new BrainError('UNAVAILABLE', 'no provider for this channel')
            const sent = await provider.send(channel, message)
            ok = true
            return sent
          } finally {
            try {
              await deps.audit.sent({ tool: 'channel.send', pluginId: id, channel, ok, tAt: deps.clock.now() })
            } catch {
              // a message that went out stays sent; the audit failure is only logged
              deps.log.warn('plugin.audit_failed', { plugin: id, channel })
            }
            if (ok) deps.gateway.noteOutbound(channel, message.text ?? '')
          }
        },
      },
      identity: {
        async resolve(account) {
          need('identity.link')
          if (typeof account !== 'string' || !account.startsWith(`${id}:`)) throw denied(`account must start with ${id}:`)
          return deps.identity.resolve(account)
        },
        async link(account, personId) {
          need('identity.link')
          if (typeof account !== 'string' || !account.startsWith(`${id}:`)) throw denied(`account must start with ${id}:`)
          return deps.identity.link(account, personId)
        },
      },
      scheduler: {
        every(ms, run) { alive(); return effect(() => deps.scheduler.every(id, ms, run), 'scheduler.every') },
        at(timeMs, run) { alive(); return effect(() => deps.scheduler.at(id, timeMs, run), 'scheduler.at') },
        ownTime(request) { need('schedule.ownTime'); return effect(() => deps.scheduler.ownTime(id, request), 'scheduler.ownTime') },
      },
      events: {
        on(name: string, handler: Handler) {
          alive()
          return effect(() => {
            const set = listeners.get(name) ?? new Set<Handler>()
            listeners.set(name, set)
            set.add(handler)
            return () => { set.delete(handler) }
          }, `events.on(${name})`)
        },
        emit(name, payload) {
          alive()
          if (typeof name !== 'string' || !name.startsWith(`${id}.`)) throw denied(`event names must start with ${id}.`)
          dispatch(name, payload)
        },
      } as BrainContext['events'],
      http: {
        route(method, routePath, handler) {
          alive()
          if (typeof routePath !== 'string' || !routePath.startsWith('/')) throw new BrainError('INVALID_ARGUMENT', 'a route path starts with /')
          const key = `${method.toUpperCase()} ${routePath}`
          if (entry.routes.has(key)) throw new BrainError('CONFLICT', `route ${key} is already registered`)
          return effect(() => {
            entry.routes.set(key, handler)
            return () => { entry.routes.delete(key) }
          }, `http.route(${key})`)
        },
        async fetch(url, options) {
          alive()
          return guardedFetch(plugin, url, options, deps.lookup)
        },
        async subscribeWebSocket(options, listener) {
          alive()
          return subscribePluginWebSocket({
            plugin,
            options,
            listener,
            lookup: deps.lookup,
            readSecret: async (name) => {
              need(`secrets:${name}`)
              const value = await deps.secrets.get(`plugin.${id}.${name}`)
              if (typeof value === 'string' && value !== '') readSecrets.add(value)
              return value
            },
            knownSecrets: () => readSecrets,
            isActive: () => entry.active && entries.get(id) === entry,
            registerEffect: (register, label) => effect(register, label),
            log: deps.log,
          })
        },
      },
      console: {
        page(descriptor) {
          alive()
          if (entry.pages.has(descriptor.id)) throw new BrainError('CONFLICT', `page ${descriptor.id} is already registered`)
          return effect(() => {
            entry.pages.set(descriptor.id, { id: descriptor.id, title: descriptor.title, entry: descriptor.entry })
            return () => { entry.pages.delete(descriptor.id) }
          }, `console.page(${descriptor.id})`)
        },
      },
      config: (plugin.config ?? {}) as Readonly<Record<string, unknown>>,
      secrets: {
        async get(name) {
          need(`secrets:${name}`)
          const value = await deps.secrets.get(`plugin.${id}.${name}`)
          if (typeof value === 'string' && value !== '') readSecrets.add(value)
          return value
        },
      },
      storage: (() => {
        const storage = createPluginStorage(path.join(deps.pluginsDir, id))
        return {
          read: (file: string) => { alive(); return storage.read(file) },
          write: (file: string, data: string | Uint8Array) => { alive(); return storage.write(file, data) },
          remove: (file: string) => { alive(); return storage.remove(file) },
          list: (prefix?: string) => { alive(); return storage.list(prefix) },
        }
      })(),
      logger: (() => {
        const logger = createPluginLogger({ dir: path.join(deps.pluginsDir, id), now: () => deps.clock.now(), secrets: () => readSecrets })
        return {
          info: (event, fields) => { alive(); logger.info(event, fields) },
          warn: (event, fields) => { alive(); logger.warn(event, fields) },
          error: (event, fields) => { alive(); logger.error(event, fields) },
        }
      })(),
      llm: {
        async complete(request) {
          need('llm.invoke')
          if (deps.llm === undefined) throw new BrainError('UNAVAILABLE', 'ctx.llm arrives after v1')
          return deps.llm.complete(id, request)
        },
      },
    }
  }

  /** One chain per plugin id: enable and disable of the same plugin run one after another, a failure never blocks the next. */
  const chains = new Map<string, Promise<void>>()
  function queued<T>(id: string, task: () => Promise<T>): Promise<T> {
    const result = (chains.get(id) ?? Promise.resolve()).then(task)
    const tail = result.then(() => undefined, () => undefined)
    chains.set(id, tail)
    void tail.then(() => { if (chains.get(id) === tail) chains.delete(id) })
    return result
  }

  async function enableNow(plugin: InstalledPlugin): Promise<void> {
    const id = plugin.manifest.id
    if (states.get(id) === 'enabled') throw new BrainError('CONFLICT', `plugin ${id} is already enabled`)
    const previous = entries.get(id)
    if (previous !== undefined) {
      previous.active = false
      previous.activeCalls.clear()
      await quietDispose(previous.fiber)
      entries.delete(id)
    }
    const holder: { entry?: Entry } = {}
    const fiber = root.plugin({
      name: id,
      apply: async () => {
        const entry = holder.entry as Entry
        const apply = await deps.loadEntry(plugin)
        await raceWithTimeout(Promise.resolve(apply(buildContext(entry), plugin.config as never)), applyTimeoutMs)
      },
    })
    const entry: Entry = { plugin, fiber, active: true, routes: new Map(), pages: new Map(), writes: [], activeCalls: new Map() }
    holder.entry = entry
    entries.set(id, entry)
    try {
      await fiber
      states.set(id, 'enabled')
    } catch (error) {
      entry.active = false
      entry.activeCalls.clear()
      await quietDispose(fiber)
      states.set(id, 'failed')
      deps.log.error('plugin.start_failed', { plugin: id })
      void error
      throw new BrainError('INTERNAL', '插件启动失败', { plugin: id })
    }
  }

  async function disableNow(id: string): Promise<void> {
    const entry = entries.get(id)
    if (entry === undefined || states.get(id) !== 'enabled') return
    entry.active = false
    entry.activeCalls.clear()
    await entry.fiber.dispose()
    entries.delete(id)
    states.set(id, 'disabled')
  }

  return {
    enable: (plugin) => queued(plugin.manifest.id, () => enableNow(plugin)),
    disable: (id) => queued(id, () => disableNow(id)),

    state: (id) => states.get(id) ?? 'disabled',

    async route(pluginId, request) {
      const entry = entries.get(pluginId)
      const handler = entry === undefined || !entry.active ? undefined : entry.routes.get(`${request.method.toUpperCase()} ${request.path}`)
      if (handler === undefined) throw new BrainError('NOT_FOUND', 'no such route')
      return handler(request)
    },

    pages: () => [...entries.values()].filter((entry) => entry.active).flatMap((entry) =>
      [...entry.pages.values()].map((page) => ({ pluginId: entry.plugin.manifest.id, ...page }))),

    emit(name, payload) {
      dispatch(name, payload)
    },
  }
}
export type { Lookup }
