import type { Readable, Writable } from 'node:stream'
import { BrainError, ERROR_CODES, type ErrorCode } from '@dsh-brain-core/sdk'

/** One JSON-RPC 2.0 message per line; a single line may not exceed 8 MiB. */
export const MAX_LINE_BYTES = 8 * 1024 * 1024

export class MethodNotFound extends Error {
  constructor() {
    super('Method not found')
    this.name = 'MethodNotFound'
  }
}

interface RpcError {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly method: string
}

export interface ConnectionHandlers {
  request(method: string, params: unknown): Promise<unknown>
  notification(method: string, params: unknown): void
  log(event: string): void
}

function isRpcError(value: unknown): value is RpcError {
  return value !== null && typeof value === 'object' && typeof (value as { code?: unknown }).code === 'number'
}

/** BrainError keeps its code and details; anything else becomes INTERNAL without its text. */
export function toRpcError(error: unknown): RpcError {
  if (error instanceof MethodNotFound) return { code: -32601, message: 'Method not found' }
  if (error instanceof BrainError) return { code: -32000, message: error.message, data: { code: error.code, details: error.details } }
  return { code: -32000, message: 'internal error', data: { code: 'INTERNAL', details: {} } }
}

function fromRpcError(error: RpcError): Error {
  const message = typeof error.message === 'string' ? error.message : 'plugin request failed'
  const data = error.data !== null && typeof error.data === 'object' ? error.data as { code?: unknown; details?: unknown } : undefined
  if (data !== undefined && typeof data.code === 'string' && Object.hasOwn(ERROR_CODES, data.code)) {
    return new BrainError(data.code as ErrorCode, message, (data.details ?? {}) as Readonly<Record<string, unknown>>)
  }
  return new Error(message)
}

/** A newline-delimited JSON-RPC peer over the child's stdin/stdout. */
export class LineConnection {
  readonly #input: Writable
  readonly #handlers: ConnectionHandlers
  readonly #pending = new Map<number | string, Pending>()
  #nextId = 1
  #buffer = ''
  #bufferedBytes = 0
  #overflow = false
  #closed = false

  constructor(input: Writable, output: Readable, handlers: ConnectionHandlers) {
    this.#input = input
    this.#handlers = handlers
    output.setEncoding('utf8')
    output.on('data', (chunk: string) => { this.#consume(chunk) })
    output.on('error', () => { /* the exit handler reports the failure */ })
  }

  get closed(): boolean {
    return this.#closed
  }

  /** Bytes waiting in the line buffer; exposed so tests can prove an overflowing line is discarded. */
  get bufferedBytes(): number {
    return this.#bufferedBytes
  }

  #consume(chunk: string): void {
    if (this.#overflow) {
      // The rest of a line that was already too long is dropped as it arrives, never buffered.
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
          this.#handlers.log('plugin.line_too_long')
        }
        return
      }
      const line = this.#buffer.slice(0, index)
      this.#buffer = this.#buffer.slice(index + 1)
      this.#bufferedBytes -= Buffer.byteLength(line, 'utf8') + 1
      if (this.#overflow) { this.#overflow = false; continue }
      if (line.trim() === '') continue
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) { this.#handlers.log('plugin.line_too_long'); continue }
      this.#handle(line)
    }
  }

  #handle(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      this.#handlers.log('plugin.bad_message')
      return
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      this.#handlers.log('plugin.bad_message')
      return
    }
    const record = message as Record<string, unknown>
    if (typeof record.method === 'string') {
      if (record.id === undefined) {
        try { this.#handlers.notification(record.method, record.params) } catch { this.#handlers.log('plugin.notification_failed') }
        return
      }
      this.#dispatch(record.id as number | string, record.method, record.params)
      return
    }
    if (!('id' in record)) return
    const pending = this.#pending.get(record.id as number | string)
    if (pending === undefined) return
    this.#pending.delete(record.id as number | string)
    if (record.error !== undefined && isRpcError(record.error)) pending.reject(fromRpcError(record.error))
    else pending.resolve(record.result)
  }

  #dispatch(id: number | string, method: string, params: unknown): void {
    void Promise.resolve().then(() => this.#handlers.request(method, params)).then(
      (result) => {
        if (!this.#send({ jsonrpc: '2.0', id, result: result === undefined ? null : result })) {
          this.#send({ jsonrpc: '2.0', id, error: toRpcError(new BrainError('INTERNAL', 'result is not serializable')) })
        }
      },
      (error: unknown) => { this.#send({ jsonrpc: '2.0', id, error: toRpcError(error) }) },
    )
  }

  #send(message: Record<string, unknown>): boolean {
    if (this.#closed) return false
    let text: string
    try {
      text = JSON.stringify(message)
    } catch {
      return false
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_LINE_BYTES) return false
    try { this.#input.write(`${text}\n`); return true } catch { return false }
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.#closed) return Promise.reject(new BrainError('UNAVAILABLE', 'plugin process is not running'))
    const id = this.#nextId++
    let text: string
    try {
      text = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    } catch {
      return Promise.reject(new BrainError('INVALID_ARGUMENT', 'request is not serializable'))
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_LINE_BYTES) {
      return Promise.reject(new BrainError('PAYLOAD_TOO_LARGE', 'request exceeds 8 MiB'))
    }
    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method })
      try {
        this.#input.write(`${text}\n`)
      } catch {
        this.#pending.delete(id)
        reject(new BrainError('UNAVAILABLE', 'plugin process is not running'))
      }
    })
  }

  notify(method: string, params?: unknown): void {
    const message: Record<string, unknown> = { jsonrpc: '2.0', method }
    if (params !== undefined) message.params = params
    this.#send(message)
  }

  /** Rejects every in-flight request; called when the process exits or is torn down. */
  close(reason: Error = new BrainError('UNAVAILABLE', 'plugin process is not running')): void {
    if (this.#closed) return
    this.#closed = true
    for (const pending of this.#pending.values()) pending.reject(reason)
    this.#pending.clear()
  }
}
