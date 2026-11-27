// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { Readable, Writable } from 'node:stream'
import {
  BrainError,
  ERROR_CODES,
  PLUGIN_API_VERSION,
  type BrainContext,
  type BrainLogger,
  type ChannelEventResult,
  type ChannelProvider,
  type ContextBundle,
  type Disposable,
  type ErrorCode,
  type FetchOptions,
  type FetchResponse,
  type ForgetReport,
  type MemoryProvider,
  type MemoryProviderHealth,
  type MemoryProviderHit,
  type MemoryProviderQuery,
  type MemoryRecord,
  type OutboundMessage,
  type PluginRequest,
  type ReadL0Result,
  type ToolCallContext,
  type ToolDefinition,
  type ToolOutput,
  type WebSocketEvent,
  type WebSocketSubscribeOptions,
} from '@dsh-brain-core/sdk'
import { HOST_UNSUPPORTED_MESSAGE } from '../apply.ts'

/** One JSON-RPC 2.0 message per line; a single line may not exceed 8 MiB. */
export const MAX_LINE_BYTES = 8 * 1024 * 1024

export class MethodNotFound extends Error {
  constructor() {
    super('Method not found')
    this.name = 'MethodNotFound'
  }
}

export interface RpcError {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

export interface StdioPluginHandle {
  readonly startBackground?: () => void
  readonly stop?: () => Promise<void> | void
}

export interface RunStdioPluginOptions {
  readonly input?: Readable
  readonly output?: Writable
  readonly apply: (
    ctx: BrainContext,
    config: Readonly<Record<string, unknown>>,
  ) => Promise<StdioPluginHandle | void> | StdioPluginHandle | void
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

interface ConnectionHandlers {
  request(method: string, params: unknown): Promise<unknown>
  notification(method: string, params: unknown): void
  afterResponse?(method: string, ok: boolean): void
}

interface TimerEntry {
  readonly once: boolean
  readonly run: () => Promise<void> | void
}

interface InitState {
  readonly pluginId: string
  readonly version: string
  readonly config: Readonly<Record<string, unknown>>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function invalid(message: string): BrainError {
  return new BrainError('INVALID_ARGUMENT', message)
}

function paramsObject(params: unknown): Record<string, unknown> {
  if (!isPlainObject(params)) throw invalid('params must be an object')
  return params
}

function stringField(params: Record<string, unknown>, key: string, allowEmpty = false): string {
  const value = params[key]
  if (typeof value !== 'string' || (!allowEmpty && value === '')) {
    throw invalid(`${key} must be a non-empty string`)
  }
  return value
}

function objectField(params: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = params[key]
  if (!isPlainObject(value)) throw invalid(`${key} must be an object`)
  return value
}

function arrayField(params: Record<string, unknown>, key: string): readonly unknown[] {
  const value = params[key]
  if (!Array.isArray(value)) throw invalid(`${key} must be an array`)
  return value
}

function apiMajor(version: string): number | null {
  const match = /^(\d+)(?:\.|$)/.exec(version)
  return match === null ? null : Number(match[1])
}

function isRpcError(value: unknown): value is RpcError {
  return value !== null && typeof value === 'object' && typeof (value as { code?: unknown }).code === 'number'
}

/** BrainError keeps its code and details; anything else becomes INTERNAL without its text. */
export function toRpcError(error: unknown): RpcError {
  if (error instanceof MethodNotFound) {
    return { code: -32601, message: 'Method not found' }
  }
  if (error instanceof BrainError) {
    return {
      code: -32000,
      message: error.message,
      data: { code: error.code, details: error.details },
    }
  }
  return {
    code: -32000,
    message: 'internal error',
    data: { code: 'INTERNAL', details: {} },
  }
}

export function fromRpcError(error: RpcError): Error {
  if (error.code === -32601) {
    return new MethodNotFound()
  }
  const message = typeof error.message === 'string' ? error.message : 'plugin request failed'
  const data = isPlainObject(error.data) ? error.data : undefined
  if (data !== undefined && typeof data.code === 'string' && Object.hasOwn(ERROR_CODES, data.code)) {
    const details = isPlainObject(data.details) ? data.details : {}
    return new BrainError(data.code as ErrorCode, message, details)
  }
  return new Error(message)
}

function encodeBase64(data: string | Uint8Array): string {
  if (typeof data === 'string') {
    return Buffer.from(data, 'utf8').toString('base64')
  }
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64')
}

function decodeBase64Bytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'))
}

function sanitizeLogFields(
  fields: Readonly<Record<string, string | number | boolean>> | undefined,
): Readonly<Record<string, string | number | boolean>> | undefined {
  if (fields === undefined) return undefined
  const clean: Record<string, string | number | boolean> = {}
  let hasEntry = false
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      clean[key] = value
      hasEntry = true
    }
  }
  return hasEntry ? clean : undefined
}

type SendResult = 'ok' | 'closed' | 'non_serializable' | 'too_large'

/**
 * Bidirectional newline-delimited JSON-RPC 2.0 transport over stdio streams.
 */
export class StdioRpcConnection {
  readonly #input: Readable
  readonly #output: Writable
  readonly #handlers: ConnectionHandlers
  readonly #pending = new Map<number | string, PendingRequest>()
  readonly #onData: (chunk: string) => void
  readonly #onInputError: () => void
  readonly #onOutputError: () => void
  #nextId = 1
  #buffer = ''
  #bufferedBytes = 0
  #overflow = false
  #closed = false

  constructor(input: Readable, output: Writable, handlers: ConnectionHandlers) {
    this.#input = input
    this.#output = output
    this.#handlers = handlers

    this.#onData = (chunk: string) => {
      this.#consume(chunk)
    }
    this.#onInputError = () => {
      this.close(new BrainError('UNAVAILABLE', 'stdio input failed'))
    }
    this.#onOutputError = () => {
      this.close(new BrainError('UNAVAILABLE', 'stdio output failed'))
    }

    input.setEncoding('utf8')
    input.on('data', this.#onData)
    input.on('error', this.#onInputError)
    output.on('error', this.#onOutputError)
  }

  get closed(): boolean {
    return this.#closed
  }

  /** Bytes currently buffered for the active inbound line. */
  get bufferedBytes(): number {
    return this.#bufferedBytes
  }

  #consume(chunk: string): void {
    if (this.#closed) return
    if (this.#overflow) {
      // Discard the rest of an over-limit line immediately without buffering.
      const newline = chunk.indexOf('\n')
      if (newline === -1) return
      this.#overflow = false
      chunk = chunk.slice(newline + 1)
    }
    this.#buffer += chunk
    this.#bufferedBytes += Buffer.byteLength(chunk, 'utf8')
    for (;;) {
      const index = this.#buffer.indexOf('\n')
      if (index === -1) {
        if (!this.#overflow && this.#bufferedBytes > MAX_LINE_BYTES) {
          this.#overflow = true
          this.#buffer = ''
          this.#bufferedBytes = 0
        }
        return
      }
      const line = this.#buffer.slice(0, index)
      this.#buffer = this.#buffer.slice(index + 1)
      this.#bufferedBytes -= Buffer.byteLength(line, 'utf8') + 1
      if (this.#overflow) {
        this.#overflow = false
        continue
      }
      if (line.trim() === '') continue
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) continue
      this.#handle(line)
    }
  }

  #handle(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (!isPlainObject(message)) return

    if (typeof message.method === 'string') {
      if (message.id === undefined) {
        try {
          this.#handlers.notification(message.method, message.params)
        } catch {
          // Notifications do not have an RPC response channel.
        }
        return
      }
      if (typeof message.id === 'number' || typeof message.id === 'string') {
        this.#dispatch(message.id, message.method, message.params)
      }
      return
    }

    if (!('id' in message)) return
    const id = message.id
    if (typeof id !== 'number' && typeof id !== 'string') return
    const pending = this.#pending.get(id)
    if (pending === undefined) return
    this.#pending.delete(id)
    if (message.error !== undefined && isRpcError(message.error)) {
      pending.reject(fromRpcError(message.error))
    } else {
      pending.resolve(message.result)
    }
  }

  #dispatch(id: number | string, method: string, params: unknown): void {
    void Promise.resolve()
      .then(() => this.#handlers.request(method, params))
      .then(
        (result) => {
          const sent = this.#send({
            jsonrpc: '2.0',
            id,
            result: result === undefined ? null : result,
          })
          if (sent === 'too_large') {
            this.#send({
              jsonrpc: '2.0',
              id,
              error: toRpcError(new BrainError('PAYLOAD_TOO_LARGE', 'response exceeds 8 MiB')),
            })
            this.#handlers.afterResponse?.(method, false)
            return
          }
          if (sent === 'non_serializable') {
            this.#send({
              jsonrpc: '2.0',
              id,
              error: toRpcError(new BrainError('INTERNAL', 'result is not serializable')),
            })
            this.#handlers.afterResponse?.(method, false)
            return
          }
          this.#handlers.afterResponse?.(method, sent === 'ok')
        },
        (error: unknown) => {
          this.#send({ jsonrpc: '2.0', id, error: toRpcError(error) })
          this.#handlers.afterResponse?.(method, false)
        },
      )
  }

  #send(message: Record<string, unknown>): SendResult {
    if (this.#closed) return 'closed'
    let text: string
    try {
      text = JSON.stringify(message)
    } catch {
      return 'non_serializable'
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_LINE_BYTES) return 'too_large'
    try {
      this.#output.write(`${text}\n`)
      return 'ok'
    } catch {
      return 'closed'
    }
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new BrainError('UNAVAILABLE', 'stdio connection is closed'))
    }
    const id = this.#nextId++
    let text: string
    try {
      text = JSON.stringify(params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params })
    } catch {
      return Promise.reject(new BrainError('INVALID_ARGUMENT', 'request is not serializable'))
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_LINE_BYTES) {
      return Promise.reject(new BrainError('PAYLOAD_TOO_LARGE', 'request exceeds 8 MiB'))
    }
    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      try {
        this.#output.write(`${text}\n`)
      } catch {
        this.#pending.delete(id)
        reject(new BrainError('UNAVAILABLE', 'stdio connection is closed'))
      }
    })
  }

  notify(method: string, params?: unknown): boolean {
    const message: Record<string, unknown> = { jsonrpc: '2.0', method }
    if (params !== undefined) message.params = params
    return this.#send(message) === 'ok'
  }

  close(reason: Error = new BrainError('UNAVAILABLE', 'stdio connection is closed')): void {
    if (this.#closed) return
    this.#closed = true
    this.#buffer = ''
    this.#bufferedBytes = 0
    this.#overflow = false
    this.#input.off('data', this.#onData)
    this.#input.off('error', this.#onInputError)
    this.#output.off('error', this.#onOutputError)
    if (typeof (this.#input as { pause?: unknown }).pause === 'function') {
      try {
        this.#input.pause()
      } catch {
        // Ignore streams that cannot be paused.
      }
    }
    for (const pending of this.#pending.values()) {
      pending.reject(reason)
    }
    this.#pending.clear()
  }
}

class StdioPluginRuntime {
  readonly #rpc: StdioRpcConnection
  readonly #input: Readable
  readonly #apply: RunStdioPluginOptions['apply']
  readonly #tools = new Map<string, ToolDefinition>()
  readonly #routes = new Map<string, (request: PluginRequest) => Promise<unknown>>()
  readonly #wsListeners = new Map<string, (event: WebSocketEvent) => void | Promise<void>>()
  readonly #timers = new Map<string, TimerEntry>()
  readonly #eventHandlers = new Map<string, Set<(payload: unknown) => void | Promise<void>>>()
  readonly #pendingRegistrations: Promise<unknown>[] = []

  #init: InitState | undefined
  #channelProvider: ChannelProvider | undefined
  #memoryProvider: MemoryProvider | undefined
  #registrationOpen = true
  #nextTimerId = 0
  #nextRouteId = 0
  #nextWsId = 0
  #handle: StdioPluginHandle | undefined
  #stopPromise: Promise<void> | undefined
  #applying = false
  #shuttingDown = false
  #lifecycleStarted = false
  #resolveDone!: () => void
  #rejectDone!: (error: unknown) => void
  readonly #done: Promise<void>

  readonly #onInputEnd = (): void => {
    void this.#gracefulExit(true)
  }

  readonly #onInputClose = (): void => {
    void this.#gracefulExit(true)
  }

  constructor(input: Readable, output: Writable, apply: RunStdioPluginOptions['apply']) {
    this.#input = input
    this.#apply = apply
    this.#done = new Promise<void>((resolve, reject) => {
      this.#resolveDone = resolve
      this.#rejectDone = reject
    })
    this.#rpc = new StdioRpcConnection(input, output, {
      request: (method, params) => this.#handleInboundRequest(method, params),
      notification: (method, params) => this.#handleInboundNotification(method, params),
      afterResponse: (method, ok) => {
        if (method === 'initialize' && ok && !this.#lifecycleStarted && !this.#shuttingDown) {
          this.#lifecycleStarted = true
          void this.#runLifecycle()
        }
      },
    })

    input.on('end', this.#onInputEnd)
    input.on('close', this.#onInputClose)
  }

  wait(): Promise<void> {
    return this.#done
  }

  #trackRegistration(promise: Promise<unknown>): void {
    // Attach a fallback rejection handler so failed registrations before await never trigger unhandledRejection.
    void promise.catch(() => undefined)
    if (this.#registrationOpen) {
      this.#pendingRegistrations.push(promise)
    }
  }

  #buildContext(init: InitState): BrainContext {
    const rpc = this.#rpc

    const logger: BrainLogger = {
      info: (event, fields) => {
        const clean = sanitizeLogFields(fields)
        void rpc.request('logger.log', clean === undefined ? { level: 'info', event } : { level: 'info', event, fields: clean }).catch(() => undefined)
      },
      warn: (event, fields) => {
        const clean = sanitizeLogFields(fields)
        void rpc.request('logger.log', clean === undefined ? { level: 'warn', event } : { level: 'warn', event, fields: clean }).catch(() => undefined)
      },
      error: (event, fields) => {
        const clean = sanitizeLogFields(fields)
        void rpc.request('logger.log', clean === undefined ? { level: 'error', event } : { level: 'error', event, fields: clean }).catch(() => undefined)
      },
    }

    const createSession = (channel: string) => ({
      channel,
      wake: (input: Parameters<BrainContext['agent']['wake']>[1]) =>
        rpc.request('agent.wake', { channel, input }) as ReturnType<BrainContext['agent']['wake']>,
      rotate: () =>
        rpc.request('agent.rotate', { channel }).then(() => undefined),
    })

    return {
      plugin: { id: init.pluginId, version: init.version },
      config: init.config,
      memory: {
        ingest: (event) => rpc.request('memory.ingest', { event }) as Promise<{ readonly id: string }>,
        record: (input) => rpc.request('memory.record', { input }) as Promise<MemoryRecord>,
        update: (id, patch, expectedVersion, view) =>
          rpc.request(
            'memory.update',
            view === undefined ? { id, patch, expectedVersion } : { id, patch, expectedVersion, view },
          ) as Promise<MemoryRecord>,
        remove: (id, view) =>
          rpc.request('memory.remove', view === undefined ? { id } : { id, view }).then(() => undefined),
        search: (request, view) =>
          rpc.request('memory.search', view === undefined ? { request } : { request, view }) as ReturnType<BrainContext['memory']['search']>,
        readChannelEvent: async (recordId: string, call: ToolCallContext) => {
          try {
            return (await rpc.request('memory.readChannelEvent', { recordId, call })) as ChannelEventResult
          } catch (error) {
            if (error instanceof MethodNotFound) {
              throw new BrainError('INVALID_ARGUMENT', HOST_UNSUPPORTED_MESSAGE)
            }
            throw error
          }
        },
        context: (request) => rpc.request('memory.context', { request }) as Promise<ContextBundle>,
        forget: (selector) => rpc.request('memory.forget', { selector }) as Promise<ForgetReport>,
        readL0: (request) =>
          rpc.request('memory.readL0', request === undefined ? {} : { request }) as Promise<ReadL0Result>,
        writeDerived: (input) => rpc.request('memory.writeDerived', { input }) as Promise<MemoryRecord>,
        provide: (provider): Disposable => {
          this.#memoryProvider = provider
          this.#trackRegistration(rpc.request('memory.provide', {}))
          return () => {
            if (this.#memoryProvider === provider) {
              this.#memoryProvider = undefined
            }
          }
        },
      },
      agent: {
        session: (channel) => createSession(channel),
        wake: (channel, input) =>
          rpc.request('agent.wake', { channel, input }) as ReturnType<BrainContext['agent']['wake']>,
      },
      tools: {
        register: (tool): Disposable => {
          this.#tools.set(tool.name, tool)
          this.#trackRegistration(
            rpc.request('tools.register', {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            }),
          )
          return () => {
            if (this.#tools.get(tool.name) === tool) {
              this.#tools.delete(tool.name)
            }
          }
        },
      },
      channel: {
        provide: (provider): Disposable => {
          this.#channelProvider = provider
          this.#trackRegistration(rpc.request('channel.provide', {}))
          return () => {
            if (this.#channelProvider === provider) {
              this.#channelProvider = undefined
            }
          }
        },
        send: (channel, message) =>
          rpc.request('channel.send', { channel, message }) as Promise<{ readonly messageId?: string }>,
      },
      identity: {
        resolve: (account) => rpc.request('identity.resolve', { account }) as Promise<string>,
        link: (account, personId) => rpc.request('identity.link', { account, personId }).then(() => undefined),
      },
      scheduler: {
        every: (ms, run): Disposable => {
          const id = `timer-${++this.#nextTimerId}`
          this.#timers.set(id, { once: false, run })
          this.#trackRegistration(rpc.request('scheduler.every', { id, ms }))
          return () => {
            this.#timers.delete(id)
          }
        },
        at: (timeMs, run): Disposable => {
          const id = `timer-${++this.#nextTimerId}`
          this.#timers.set(id, { once: true, run })
          this.#trackRegistration(rpc.request('scheduler.at', { id, timeMs }))
          return () => {
            this.#timers.delete(id)
          }
        },
        ownTime: (request): Disposable => {
          const id = `timer-${++this.#nextTimerId}`
          this.#timers.set(id, { once: false, run: () => request.run() })
          this.#trackRegistration(
            rpc.request('scheduler.ownTime', { id, name: request.name, everyMs: request.everyMs }),
          )
          return () => {
            this.#timers.delete(id)
          }
        },
      },
      events: {
        on: (name: string, handler: (payload: unknown) => void | Promise<void>): Disposable => {
          let handlers = this.#eventHandlers.get(name)
          const firstForName = handlers === undefined || handlers.size === 0
          if (handlers === undefined) {
            handlers = new Set()
            this.#eventHandlers.set(name, handlers)
          }
          handlers.add(handler)
          if (firstForName) {
            this.#trackRegistration(rpc.request('events.on', { name }))
          }
          return () => {
            const set = this.#eventHandlers.get(name)
            if (set === undefined) return
            set.delete(handler)
            if (set.size === 0) {
              this.#eventHandlers.delete(name)
            }
          }
        },
        emit: (name, payload) => {
          void rpc.request('events.emit', { name, payload }).catch(() => undefined)
        },
      },
      http: {
        route: (method, path, handler): Disposable => {
          const routeId = `route-${++this.#nextRouteId}`
          this.#routes.set(routeId, handler)
          this.#trackRegistration(rpc.request('http.route', { routeId, method, path }))
          return () => {
            this.#routes.delete(routeId)
          }
        },
        fetch: async (url: string, options?: FetchOptions): Promise<FetchResponse> => {
          const serializedOptions = options === undefined ? undefined : {
            ...options,
            ...(options.body !== undefined ? { body: encodeBase64(options.body) } : {}),
          }
          const result = (await rpc.request(
            'http.fetch',
            serializedOptions === undefined ? { url } : { url, options: serializedOptions },
          )) as {
            readonly status: number
            readonly headers: Readonly<Record<string, string>>
            readonly base64: string
          }
          const rawBytes = decodeBase64Bytes(result.base64)
          return {
            status: result.status,
            headers: result.headers,
            bytes: () => new Uint8Array(rawBytes),
            text: () => Buffer.from(rawBytes).toString('utf8'),
          }
        },
        subscribeWebSocket: async (
          options: WebSocketSubscribeOptions,
          listener: (event: WebSocketEvent) => void | Promise<void>,
        ): Promise<Disposable> => {
          const subscriptionId = `ws-${++this.#nextWsId}`
          // Register listener BEFORE sending RPC so an early `open` event cannot race and drop.
          this.#wsListeners.set(subscriptionId, listener)
          try {
            await rpc.request('http.subscribeWebSocket', { subscriptionId, options })
          } catch (error) {
            if (this.#wsListeners.get(subscriptionId) === listener) {
              this.#wsListeners.delete(subscriptionId)
            }
            if (error instanceof MethodNotFound) {
              throw new BrainError('INVALID_ARGUMENT', HOST_UNSUPPORTED_MESSAGE)
            }
            throw error
          }
          let disposed = false
          return () => {
            if (disposed) return
            disposed = true
            if (this.#wsListeners.get(subscriptionId) === listener) {
              this.#wsListeners.delete(subscriptionId)
            }
            void rpc.request('http.unsubscribeWebSocket', { subscriptionId }).catch(() => undefined)
          }
        },
      },
      console: {
        page: (descriptor): Disposable => {
          this.#trackRegistration(rpc.request('console.page', descriptor))
          return () => undefined
        },
      },
      secrets: {
        get: async (name) => {
          const value = (await rpc.request('secrets.get', { name })) as string | null | undefined
          return value ?? undefined
        },
      },
      storage: {
        read: async (path) => {
          const value = (await rpc.request('storage.read', { path })) as { readonly base64: string } | null | undefined
          return value === null || value === undefined ? undefined : decodeBase64Bytes(value.base64)
        },
        write: (path, data) =>
          rpc.request('storage.write', { path, base64: encodeBase64(data) }).then(() => undefined),
        remove: (path) => rpc.request('storage.remove', { path }).then(() => undefined),
        list: (prefix) =>
          rpc.request('storage.list', prefix === undefined ? {} : { prefix }) as Promise<readonly string[]>,
      },
      logger,
      llm: {
        complete: (request) =>
          rpc.request('llm.complete', { request }) as Promise<{ readonly text: string; readonly tokens: number }>,
      },
    }
  }

  async #handleInboundRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'initialize': {
        if (this.#init !== undefined) {
          throw new BrainError('CONFLICT', 'plugin is already initialized')
        }
        const p = paramsObject(params)
        const versionString = stringField(p, 'apiVersion')
        const expectedMajor = apiMajor(PLUGIN_API_VERSION)
        const actualMajor = apiMajor(versionString)
        if (actualMajor === null || actualMajor !== expectedMajor) {
          throw invalid(`unsupported apiVersion: ${versionString}`)
        }
        const pluginId = stringField(p, 'pluginId')
        const version = stringField(p, 'version', true)
        const rawConfig = p.config
        let config: Readonly<Record<string, unknown>>
        if (rawConfig === undefined || rawConfig === null) {
          config = {}
        } else if (isPlainObject(rawConfig)) {
          config = rawConfig
        } else {
          throw invalid('config must be an object')
        }
        this.#init = { pluginId, version, config }
        return { apiVersion: PLUGIN_API_VERSION }
      }
      case 'tool.invoke': {
        const p = paramsObject(params)
        const name = stringField(p, 'name')
        const args = p.args === undefined ? {} : objectField(p, 'args')
        const call = objectField(p, 'call') as unknown as ToolCallContext
        const tool = this.#tools.get(name)
        if (tool === undefined) {
          throw new BrainError('NOT_FOUND', `unknown tool: ${name}`)
        }
        return (await tool.handler(args, call)) as ToolOutput
      }
      case 'channel.send': {
        if (this.#channelProvider === undefined) {
          throw new BrainError('UNAVAILABLE', 'channel provider is not registered')
        }
        const p = paramsObject(params)
        return this.#channelProvider.send(stringField(p, 'channel'), objectField(p, 'message') as OutboundMessage)
      }
      case 'channel.members': {
        if (this.#channelProvider === undefined) {
          throw new BrainError('UNAVAILABLE', 'channel provider is not registered')
        }
        const p = paramsObject(params)
        return this.#channelProvider.members(stringField(p, 'channel'))
      }
      case 'channel.resolveIdentity': {
        if (this.#channelProvider === undefined) {
          throw new BrainError('UNAVAILABLE', 'channel provider is not registered')
        }
        const p = paramsObject(params)
        return this.#channelProvider.resolveIdentity(stringField(p, 'account'))
      }
      case 'http.request': {
        const p = paramsObject(params)
        const routeId = stringField(p, 'routeId')
        const handler = this.#routes.get(routeId)
        if (handler === undefined) {
          throw new BrainError('NOT_FOUND', `unknown route: ${routeId}`)
        }
        return handler(objectField(p, 'request') as unknown as PluginRequest)
      }
      case 'http.wsEvent': {
        const p = paramsObject(params)
        const subscriptionId = stringField(p, 'subscriptionId')
        const event = objectField(p, 'event') as unknown as WebSocketEvent
        const listener = this.#wsListeners.get(subscriptionId)
        if (listener === undefined) return null
        try {
          await listener(event)
        } finally {
          if (event.type === 'close' && this.#wsListeners.get(subscriptionId) === listener) {
            this.#wsListeners.delete(subscriptionId)
          }
        }
        return null
      }
      case 'schedule.fire': {
        const p = paramsObject(params)
        const id = stringField(p, 'id')
        const entry = this.#timers.get(id)
        if (entry === undefined) return null
        if (entry.once) {
          this.#timers.delete(id)
        }
        await entry.run()
        return null
      }
      case 'memoryProvider.search': {
        if (this.#memoryProvider === undefined) {
          throw new BrainError('UNAVAILABLE', 'memory provider is not registered')
        }
        const p = paramsObject(params)
        return this.#memoryProvider.search(objectField(p, 'query') as unknown as MemoryProviderQuery) as Promise<readonly MemoryProviderHit[]>
      }
      case 'memoryProvider.onRecord': {
        if (this.#memoryProvider === undefined) {
          throw new BrainError('UNAVAILABLE', 'memory provider is not registered')
        }
        const p = paramsObject(params)
        await this.#memoryProvider.onRecord?.(objectField(p, 'record') as unknown as MemoryRecord)
        return null
      }
      case 'memoryProvider.onForgotten': {
        if (this.#memoryProvider === undefined) {
          throw new BrainError('UNAVAILABLE', 'memory provider is not registered')
        }
        const p = paramsObject(params)
        await this.#memoryProvider.onForgotten(arrayField(p, 'ids') as readonly string[])
        return null
      }
      case 'memoryProvider.health': {
        if (this.#memoryProvider === undefined) {
          throw new BrainError('UNAVAILABLE', 'memory provider is not registered')
        }
        return (await this.#memoryProvider.health?.()) ?? ({ status: 'ok' } satisfies MemoryProviderHealth)
      }
      default:
        throw new MethodNotFound()
    }
  }

  #handleInboundNotification(method: string, params: unknown): void {
    if (method === 'shutdown') {
      void this.#gracefulExit(false)
      return
    }
    if (method === 'event') {
      if (!isPlainObject(params)) return
      const name = params.name
      if (typeof name !== 'string') return
      const handlers = this.#eventHandlers.get(name)
      if (handlers === undefined) return
      for (const handler of [...handlers]) {
        try {
          void Promise.resolve(handler(params.payload)).catch(() => undefined)
        } catch {
          // Keep dispatching remaining handlers even if one throws synchronously.
        }
      }
    }
  }

  async #runLifecycle(): Promise<void> {
    const init = this.#init
    if (init === undefined) return
    const ctx = this.#buildContext(init)
    this.#applying = true
    try {
      const result = await this.#apply(ctx, init.config)
      if (result !== undefined) {
        this.#handle = result
      }
      this.#applying = false
      if (this.#shuttingDown) {
        await this.#stopOnce()
        this.#cleanup()
        this.#resolveDone()
        return
      }
      await Promise.all(this.#pendingRegistrations)
      this.#registrationOpen = false
      if (this.#shuttingDown) {
        await this.#stopOnce()
        this.#cleanup()
        this.#resolveDone()
        return
      }
      this.#rpc.notify('plugin.ready')
      this.#handle?.startBackground?.()
    } catch (error: unknown) {
      this.#applying = false
      this.#registrationOpen = false
      await this.#stopOnce()
      this.#cleanup()
      if (this.#shuttingDown) {
        this.#resolveDone()
      } else {
        this.#rejectDone(error)
      }
    }
  }

  #stopOnce(): Promise<void> {
    if (this.#handle === undefined) {
      return Promise.resolve()
    }
    if (this.#stopPromise === undefined) {
      this.#stopPromise = Promise.resolve()
        .then(() => this.#handle?.stop?.())
        .catch(() => undefined)
    }
    return this.#stopPromise
  }

  #cleanup(): void {
    this.#input.off('end', this.#onInputEnd)
    this.#input.off('close', this.#onInputClose)
    this.#rpc.close(new BrainError('UNAVAILABLE', 'plugin process stopped'))
    this.#tools.clear()
    this.#routes.clear()
    this.#wsListeners.clear()
    this.#timers.clear()
    this.#eventHandlers.clear()
    this.#channelProvider = undefined
    this.#memoryProvider = undefined
  }

  async #gracefulExit(streamEnded: boolean): Promise<void> {
    if (this.#shuttingDown) return
    this.#shuttingDown = true
    this.#registrationOpen = false
    if (streamEnded) {
      // Unblock any pending RPC calls before awaiting stop() when stdin is already gone.
      this.#rpc.close(new BrainError('UNAVAILABLE', 'stdio input closed'))
    }
    if (this.#applying) {
      return
    }
    await this.#stopOnce()
    this.#cleanup()
    this.#resolveDone()
  }
}

/**
 * Runs a `runtime: "process"` plugin over newline-delimited JSON-RPC 2.0 stdio streams.
 */
export function runStdioPlugin(options: RunStdioPluginOptions): Promise<void> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const runtime = new StdioPluginRuntime(input, output, options.apply)
  return runtime.wait()
}
