import type {
  DerivedRecordInput,
  MemoryProviderHealth,
  MemoryProviderQuery,
  MemoryRecord,
  ReadL0Result,
} from '@brain-core/sdk'
import { createSampleIndex } from './indexer.ts'

const API_VERSION = '1.0.0'
const DEFAULT_TRIGGER_PREFIX = '记住：'
const PAGE_LIMIT = 100

interface RpcError {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

export function createStdioProviderProcess(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  onExit: (code: number) => void = (code) => process.exit(code),
): void {
  const index = createSampleIndex()
  const pending = new Map<number, PendingRequest>()
  let nextId = 1
  let triggerPrefix = DEFAULT_TRIGGER_PREFIX
  let closed = false

  function sendMessage(message: Record<string, unknown>): void {
    if (closed) return
    output.write(`${JSON.stringify(message)}\n`)
  }

  function sendNotification(method: string, params?: unknown): void {
    const message: Record<string, unknown> = { jsonrpc: '2.0', method }
    if (params !== undefined) message.params = params
    sendMessage(message)
  }

  function requestKernel(method: string, params?: unknown): Promise<unknown> {
    const id = nextId++
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      const message: Record<string, unknown> = { jsonrpc: '2.0', id, method }
      if (params !== undefined) message.params = params
      sendMessage(message)
    })
  }

  function reply(id: unknown, result: unknown): void {
    sendMessage({ jsonrpc: '2.0', id, result: result === undefined ? null : result })
  }

  function replyError(id: unknown, error: RpcError): void {
    sendMessage({ jsonrpc: '2.0', id, error })
  }

  async function bootstrap(): Promise<void> {
    let afterId: string | undefined
    for (;;) {
      const page = await requestKernel('memory.readL0', {
        request: {
          limit: PAGE_LIMIT,
          ...(afterId === undefined ? {} : { afterId }),
        },
      }) as ReadL0Result
      const items = Array.isArray(page?.items) ? page.items : []
      for (const record of items) {
        index.upsert(record)
      }
      if (page?.nextCursor === undefined || items.length === 0 || page.nextCursor === afterId) {
        break
      }
      afterId = page.nextCursor
    }
    await requestKernel('memory.provide', {})
    sendNotification('plugin.ready')
  }

  async function handleRecord(record: MemoryRecord): Promise<void> {
    index.upsert(record)
    if (record.layer !== 'L0' || record.status !== 'active') return
    const text = record.content?.text
    if (typeof text !== 'string') return
    const idx = text.indexOf(triggerPrefix)
    if (idx === -1) return
    const derivedText = text.slice(idx + triggerPrefix.length).trim()
    if (derivedText === '') return

    const derived: DerivedRecordInput = {
      channel: record.channel,
      subjects: record.subjects.length > 0 ? record.subjects : ['self'],
      content: { text: derivedText, derivedFrom: record.id },
      evidence: [{ id: record.id }],
      visibility: record.visibility,
      confidence: 0.7,
      importance: 0.6,
      tEvent: record.tEvent,
      idempotencyKey: `sample-derived:${record.id}`,
    }
    try {
      await requestKernel('memory.writeDerived', { input: derived })
    } catch {
      // If memory.writeDerived is not granted or unavailable, keep indexing intact.
    }
  }

  async function handleRequest(method: string, params: unknown): Promise<unknown> {
    const p = (params !== null && typeof params === 'object' && !Array.isArray(params))
      ? params as Record<string, unknown>
      : {}

    switch (method) {
      case 'initialize': {
        const config = (p.config !== null && typeof p.config === 'object' && !Array.isArray(p.config))
          ? p.config as Record<string, unknown>
          : {}
        if (typeof config.triggerPrefix === 'string' && config.triggerPrefix !== '') {
          triggerPrefix = config.triggerPrefix
        } else if (typeof config.derivedPrefix === 'string' && config.derivedPrefix !== '') {
          triggerPrefix = config.derivedPrefix
        }
        queueMicrotask(() => {
          void bootstrap().catch(() => {
            shutdown(1)
          })
        })
        return { apiVersion: API_VERSION }
      }
      case 'memoryProvider.search': {
        const query = p.query as MemoryProviderQuery
        return index.search(query)
      }
      case 'memoryProvider.onRecord': {
        const record = p.record as MemoryRecord
        await handleRecord(record)
        return null
      }
      case 'memoryProvider.onForgotten': {
        const ids = Array.isArray(p.ids) ? p.ids.filter((id): id is string => typeof id === 'string') : []
        index.forget(ids)
        return null
      }
      case 'memoryProvider.health': {
        const status: MemoryProviderHealth = { status: 'ok' }
        return status
      }
      default:
        throw Object.assign(new Error('Method not found'), { rpcCode: -32601 })
    }
  }

  function shutdown(code: number): void {
    if (closed) return
    closed = true
    for (const entry of pending.values()) {
      entry.reject(new Error('plugin shutting down'))
    }
    pending.clear()
    onExit(code)
  }

  function onLine(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) return
    const record = message as Record<string, unknown>

    if (typeof record.method === 'string') {
      if (record.id === undefined) {
        if (record.method === 'shutdown') {
          shutdown(0)
        }
        return
      }
      void handleRequest(record.method, record.params).then(
        (result) => reply(record.id, result),
        (error: unknown) => {
          const rpcCode = (error as { rpcCode?: unknown })?.rpcCode
          if (rpcCode === -32601) {
            replyError(record.id, { code: -32601, message: 'Method not found' })
          } else {
            replyError(record.id, {
              code: -32000,
              message: error instanceof Error ? error.message : 'internal error',
              data: { code: 'INTERNAL', details: {} },
            })
          }
        },
      )
      return
    }

    if (typeof record.id === 'number') {
      const entry = pending.get(record.id)
      if (entry === undefined) return
      pending.delete(record.id)
      if (record.error !== undefined && record.error !== null && typeof record.error === 'object') {
        const err = record.error as { message?: unknown }
        entry.reject(new Error(typeof err.message === 'string' ? err.message : 'rpc failed'))
      } else {
        entry.resolve(record.result)
      }
    }
  }

  let buffer = ''
  input.setEncoding('utf8')
  input.on('data', (chunk: string) => {
    buffer += chunk
    for (;;) {
      const idx = buffer.indexOf('\n')
      if (idx === -1) return
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (line !== '') onLine(line)
    }
  })
  input.on('end', () => {
    shutdown(0)
  })
}

const isEntrypoint = process.argv[1] !== undefined
  && (process.argv[1].endsWith('index.ts') || process.argv[1].endsWith('index.js'))

if (isEntrypoint) {
  createStdioProviderProcess()
}
