import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import {
  BrainError, parsePermission,
  type Disposable, type WebSocketAuthOptions, type WebSocketEvent, type WebSocketSubscribeOptions,
} from '@brain-core/sdk'
import type { InstalledPlugin } from '../contracts/index.ts'
import { redact, type Logger } from '../log/index.ts'
import { bareHost, isLoopbackIp, REDIRECTS, resolveAll, type Lookup } from './network.ts'
import { isPrivateIp } from './safe-fetch.ts'

const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024
const DEFAULT_MAX_QUEUE_LENGTH = 128
const MAX_QUEUE_LENGTH_CAP = 512
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

const AUTH_QUERY_PARAMS = new Set([
  'access_token',
  'token',
  'auth',
  'authorization',
  'api_key',
  'apikey',
  'key',
  'secret',
  'password',
  'passwd',
  'pwd',
  'bearer',
  'jwt',
  'session',
  'cookie',
])

export interface SubscribeWebSocketDeps {
  readonly plugin: InstalledPlugin
  readonly options: WebSocketSubscribeOptions
  readonly listener: (event: WebSocketEvent) => void | Promise<void>
  readonly lookup?: Lookup
  readonly readSecret: (name: string) => Promise<string | undefined>
  readonly knownSecrets: () => Iterable<string>
  readonly isActive: () => boolean
  readonly registerEffect: (register: () => () => void, label: string) => Disposable
  readonly log: Logger
}

function denied(message: string): BrainError {
  return new BrainError('PERMISSION_DENIED', message)
}

function invalid(message: string): BrainError {
  return new BrainError('INVALID_ARGUMENT', message)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface ValidatedAuth {
  readonly secretNames: readonly string[]
  readonly transport: 'header' | 'query'
  readonly paramName?: string
}

function validateAuth(raw: unknown): ValidatedAuth {
  if (!isPlainObject(raw)) throw invalid('auth must be an object')
  const { secretNames, transport, paramName } = raw as Partial<WebSocketAuthOptions> & Record<string, unknown>
  if (!Array.isArray(secretNames) || secretNames.length === 0 || secretNames.some((n) => typeof n !== 'string' || n.trim() === '')) {
    throw invalid('auth.secretNames must be a non-empty array of non-empty strings')
  }
  if (transport !== undefined && transport !== 'header' && transport !== 'query') {
    throw invalid('auth.transport must be header or query')
  }
  if (paramName !== undefined) {
    if (typeof paramName !== 'string' || paramName.trim() === '' || /[\r\n\0]/.test(paramName)) {
      throw invalid('auth.paramName must be a non-empty string without newlines')
    }
  }
  return {
    secretNames: [...secretNames],
    transport: transport ?? 'header',
    ...(paramName === undefined ? {} : { paramName }),
  }
}

function buildClientFrame(opcode: number, payload: Uint8Array): Buffer {
  const len = payload.length
  const mask = randomBytes(4)
  let headerLen = 2
  if (len >= 126 && len <= 65535) headerLen = 4
  else if (len > 65535) headerLen = 10

  const frame = Buffer.allocUnsafe(headerLen + 4 + len)
  frame[0] = 0x80 | (opcode & 0x0f)
  if (len < 126) {
    frame[1] = 0x80 | len
  } else if (len <= 65535) {
    frame[1] = 0x80 | 126
    frame.writeUInt16BE(len, 2)
  } else {
    frame[1] = 0x80 | 127
    frame.writeBigUInt64BE(BigInt(len), 2)
  }
  mask.copy(frame, headerLen)
  const dataOffset = headerLen + 4
  for (let i = 0; i < len; i += 1) {
    frame[dataOffset + i] = payload[i]! ^ mask[i & 3]!
  }
  return frame
}

function buildClosePayload(code: number, reason = ''): Buffer {
  const reasonBuf = Buffer.from(reason, 'utf8').subarray(0, 123)
  const payload = Buffer.allocUnsafe(2 + reasonBuf.length)
  payload.writeUInt16BE(code, 0)
  reasonBuf.copy(payload, 2)
  return payload
}

function isValidWireCloseCode(code: number): boolean {
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1011) || (code >= 3000 && code <= 4999)
}

export async function subscribePluginWebSocket(deps: SubscribeWebSocketDeps): Promise<Disposable> {
  const { plugin, options, listener } = deps
  if (!isPlainObject(options)) throw invalid('websocket options must be an object')
  if (typeof options.configKey !== 'string' || options.configKey === '') {
    throw invalid('configKey must be a non-empty string')
  }
  if (typeof listener !== 'function') {
    throw invalid('websocket listener must be a function')
  }
  if (options.timeoutMs !== undefined && (typeof options.timeoutMs !== 'number' || !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw invalid('timeoutMs must be a positive finite number')
  }
  if (options.maxMessageBytes !== undefined && (typeof options.maxMessageBytes !== 'number' || !Number.isInteger(options.maxMessageBytes) || options.maxMessageBytes <= 0)) {
    throw invalid('maxMessageBytes must be a positive integer')
  }
  if (options.maxQueueLength !== undefined && (typeof options.maxQueueLength !== 'number' || !Number.isInteger(options.maxQueueLength) || options.maxQueueLength <= 0)) {
    throw invalid('maxQueueLength must be a positive integer')
  }

  const auth = options.auth === undefined ? undefined : validateAuth(options.auth)
  const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
  const maxMessageBytes = Math.min(options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES, DEFAULT_MAX_MESSAGE_BYTES)
  const maxQueueLength = Math.min(options.maxQueueLength ?? DEFAULT_MAX_QUEUE_LENGTH, MAX_QUEUE_LENGTH_CAP)

  let hasLanConfig = false
  let hasNetworkConfig = false
  const grantedSecrets = new Set<string>()
  for (const entry of plugin.granted) {
    try {
      const parsed = parsePermission(entry)
      if (parsed.kind === 'lan-config' && parsed.key === options.configKey) hasLanConfig = true
      else if (parsed.kind === 'network-config' && parsed.key === options.configKey) hasNetworkConfig = true
      else if (parsed.kind === 'secret') grantedSecrets.add(parsed.name)
    } catch {
      /* ignore non-standard entries */
    }
  }
  if (!hasLanConfig && !hasNetworkConfig) {
    throw denied(`network access for config key ${options.configKey} is not granted`)
  }

  const configuredRaw = isPlainObject(plugin.config) ? plugin.config[options.configKey] : undefined
  if (typeof configuredRaw !== 'string' || configuredRaw.trim() === '') {
    throw invalid(`config.${options.configKey} must be a non-empty string`)
  }
  let configured: URL
  try {
    configured = new URL(configuredRaw)
  } catch {
    throw invalid(`config.${options.configKey} must be a valid URL`)
  }

  if (options.url !== undefined) {
    if (typeof options.url !== 'string') throw invalid('url must be a string')
    let expected: URL
    try {
      expected = new URL(options.url)
    } catch {
      throw invalid('url must be a valid URL')
    }
    if (
      expected.protocol !== configured.protocol
      || expected.hostname !== configured.hostname
      || expected.port !== configured.port
      || expected.pathname !== configured.pathname
      || expected.search !== configured.search
      || expected.username !== ''
      || expected.password !== ''
    ) {
      throw denied('websocket URL does not match configured address')
    }
  }

  if (configured.protocol !== 'ws:' && configured.protocol !== 'wss:') {
    throw denied('only ws and wss are allowed')
  }
  if (configured.username !== '' || configured.password !== '') {
    throw denied('a URL must not carry credentials')
  }

  const forbiddenParams = new Set(AUTH_QUERY_PARAMS)
  if (auth?.paramName !== undefined) forbiddenParams.add(auth.paramName.toLowerCase())
  for (const [paramKey] of configured.searchParams) {
    if (forbiddenParams.has(paramKey.toLowerCase())) {
      throw denied('a WebSocket URL must not carry authentication query parameters')
    }
  }

  let secret: string | undefined
  if (auth !== undefined) {
    for (const secretName of auth.secretNames) {
      if (!grantedSecrets.has(secretName)) {
        throw denied(`permission secrets:${secretName} is not granted`)
      }
    }
    for (const secretName of auth.secretNames) {
      const candidate = await deps.readSecret(secretName)
      if (typeof candidate === 'string' && candidate !== '') {
        secret = candidate
        break
      }
    }
  }

  const host = bareHost(configured)
  const lookup: Lookup = deps.lookup ?? (async (h) => (await (await import('node:dns')).default.promises.lookup(h, { all: true, verbatim: true })).map((e) => e.address))
  const addresses = await resolveAll(host, lookup)

  if (!hasLanConfig && addresses.some((addr) => isPrivateIp(addr))) {
    throw denied(`network access to ${host} is not granted`)
  }
  if (secret !== undefined && configured.protocol === 'ws:' && !addresses.every((addr) => isLoopbackIp(addr))) {
    throw denied('plaintext WebSocket with credentials is only allowed on loopback addresses')
  }
  if (!deps.isActive()) {
    throw denied('plugin is not enabled')
  }

  const dialUrl = new URL(configured.toString())
  dialUrl.protocol = configured.protocol === 'wss:' ? 'https:' : 'http:'
  const wsKey = randomBytes(16).toString('base64')
  const expectedAccept = createHash('sha1').update(`${wsKey}${WS_GUID}`).digest('base64')
  const headers: Record<string, string> = {
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': wsKey,
  }
  if (secret !== undefined && auth !== undefined) {
    if (auth.transport === 'query') {
      dialUrl.searchParams.set(auth.paramName ?? 'access_token', secret)
    } else if (auth.paramName === undefined || auth.paramName.toLowerCase() === 'authorization') {
      headers.Authorization = `Bearer ${secret}`
    } else {
      headers[auth.paramName] = secret
    }
  }

  const address = addresses[0] as string
  const client = configured.protocol === 'wss:' ? https : http
  const currentSecrets = (): string[] => {
    const out = new Set(deps.knownSecrets())
    if (secret !== undefined) out.add(secret)
    return [...out]
  }

  return new Promise<Disposable>((resolve, reject) => {
    let handshakeSettled = false
    let req: ReturnType<typeof http.request> | undefined
    let activeCleanup: (() => void) | undefined
    let effectDisposed = false
    let effectDispose: Disposable = () => undefined

    const disposeEffect = (): void => {
      if (effectDisposed) return
      effectDisposed = true
      effectDispose()
    }

    const timer = setTimeout(() => {
      if (handshakeSettled) return
      handshakeSettled = true
      activeCleanup = undefined
      req?.destroy()
      disposeEffect()
      reject(new BrainError('UNAVAILABLE', 'websocket handshake timed out'))
    }, timeoutMs)

    const rejectHandshake = (error: BrainError): void => {
      if (handshakeSettled) return
      handshakeSettled = true
      activeCleanup = undefined
      clearTimeout(timer)
      req?.destroy()
      disposeEffect()
      reject(error)
    }

    activeCleanup = () => {
      rejectHandshake(denied('plugin is not enabled'))
    }

    try {
      effectDispose = deps.registerEffect(() => () => {
        effectDisposed = true
        activeCleanup?.()
      }, 'http.subscribeWebSocket')
    } catch (error) {
      clearTimeout(timer)
      reject(error instanceof BrainError ? error : denied('plugin is not enabled'))
      return
    }

    try {
      req = client.request(dialUrl, {
        method: 'GET',
        agent: false,
        headers,
        lookup: ((_host: string, lookupOptions: { all?: boolean }, callback: (error: Error | null, address: unknown, family?: number) => void) => {
          const family = net.isIP(address)
          if (lookupOptions?.all === true) callback(null, [{ address, family }])
          else callback(null, address, family)
        }) as never,
        servername: net.isIP(host) ? undefined : host,
      })
    } catch {
      rejectHandshake(invalid('invalid websocket request'))
      return
    }

    req.on('response', (res) => {
      res.resume()
      const status = res.statusCode ?? 0
      if (REDIRECTS.has(status)) {
        rejectHandshake(denied('redirects are not allowed'))
      } else if (status === 401 || status === 403) {
        rejectHandshake(new BrainError('UNAUTHENTICATED', 'websocket authentication failed'))
      } else {
        rejectHandshake(new BrainError('UNAVAILABLE', 'websocket handshake failed'))
      }
    })

    req.on('error', () => {
      rejectHandshake(new BrainError('UNAVAILABLE', 'websocket handshake failed'))
    })

    req.on('upgrade', (res, socket, head) => {
      if (handshakeSettled) {
        socket.destroy()
        return
      }
      const upgradeHeader = String(res.headers.upgrade ?? '').toLowerCase()
      const acceptHeader = res.headers['sec-websocket-accept']
      if (res.statusCode !== 101 || upgradeHeader !== 'websocket' || acceptHeader !== expectedAccept) {
        socket.destroy()
        rejectHandshake(new BrainError('UNAVAILABLE', 'websocket handshake failed'))
        return
      }
      if (!deps.isActive()) {
        socket.destroy()
        rejectHandshake(denied('plugin is not enabled'))
        return
      }

      handshakeSettled = true
      activeCleanup = undefined
      clearTimeout(timer)
      socket.pause()

      let disposed = false
      let terminated = false
      let delivering = false
      let pendingMessages = 0
      let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0)
      let fragments: Buffer[] = []
      let accumulatedBytes = 0
      let inFragmented = false
      const queue: WebSocketEvent[] = [{ type: 'open' }]
      const utf8 = new TextDecoder('utf-8', { fatal: true })

      const sendControl = (opcode: number, payload: Uint8Array): void => {
        try {
          if (!socket.destroyed && socket.writable) {
            socket.write(buildClientFrame(opcode, payload))
          }
        } catch {
          /* ignore socket write errors during teardown */
        }
      }

      const closeSocketGracefully = (): void => {
        socket.pause()
        socket.removeAllListeners('data')
        try {
          if (!socket.destroyed) socket.end()
        } catch {
          socket.destroy()
        }
        const destroyTimer = setTimeout(() => {
          if (!socket.destroyed) socket.destroy()
        }, 50)
        destroyTimer.unref()
      }

      const drainQueue = async (): Promise<void> => {
        if (delivering) return
        delivering = true
        try {
          while (!disposed && deps.isActive() && queue.length > 0) {
            const event = queue.shift()!
            try {
              await listener(event)
            } catch {
              deps.log.warn('plugin.ws_listener_failed', { plugin: plugin.manifest.id })
            } finally {
              if (event.type === 'message') pendingMessages = Math.max(0, pendingMessages - 1)
            }
          }
        } finally {
          delivering = false
          if (!disposed && deps.isActive() && queue.length > 0) void drainQueue()
        }
      }

      const enqueue = (event: WebSocketEvent): void => {
        if (disposed) return
        queue.push(event)
        void drainQueue()
      }

      const failAndClose = (
        closeCode: number,
        closeReason: string,
        errorCode?: 'PAYLOAD_TOO_LARGE' | 'INVALID_ARGUMENT' | 'UNAVAILABLE',
        errorReason?: string,
      ): void => {
        if (terminated) return
        terminated = true
        fragments = []
        accumulatedBytes = 0
        buf = Buffer.alloc(0)
        sendControl(0x8, buildClosePayload(closeCode, closeReason))
        closeSocketGracefully()
        if (errorCode !== undefined && errorReason !== undefined) {
          enqueue({ type: 'error', code: errorCode, reason: redact(errorReason, currentSecrets()) })
        }
        enqueue({ type: 'close', code: closeCode, reason: redact(closeReason, currentSecrets()) })
        disposeEffect()
      }

      const shutdownConnection = (): void => {
        if (disposed) return
        if (terminated) {
          closeSocketGracefully()
          return
        }
        disposed = true
        terminated = true
        queue.length = 0
        pendingMessages = 0
        fragments = []
        accumulatedBytes = 0
        buf = Buffer.alloc(0)
        sendControl(0x8, buildClosePayload(1000, 'client_closed'))
        closeSocketGracefully()
      }

      if (effectDisposed || !deps.isActive()) {
        socket.destroy()
        disposeEffect()
        reject(denied('plugin is not enabled'))
        return
      }
      activeCleanup = shutdownConnection

      const onData = (chunk: Buffer): void => {
        if (terminated || disposed) return
        buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk])

        while (!terminated && !disposed && buf.length >= 2) {
          const b0 = buf[0]!
          const b1 = buf[1]!
          const fin = (b0 & 0x80) !== 0
          const rsv = b0 & 0x70
          const opcode = b0 & 0x0f
          const masked = (b1 & 0x80) !== 0
          const len7 = b1 & 0x7f

          if (rsv !== 0 || masked) {
            failAndClose(1002, 'protocol_error', 'UNAVAILABLE', 'websocket protocol error')
            return
          }

          let offset = 2
          let payloadLen = len7
          if (len7 === 126) {
            if (buf.length < 4) return
            payloadLen = buf.readUInt16BE(2)
            offset = 4
          } else if (len7 === 127) {
            if (buf.length < 10) return
            if ((buf[2]! & 0x80) !== 0) {
              failAndClose(1002, 'protocol_error', 'UNAVAILABLE', 'websocket protocol error')
              return
            }
            const bigLen = buf.readBigUInt64BE(2)
            if (bigLen > BigInt(maxMessageBytes)) {
              failAndClose(1009, 'message_too_large', 'PAYLOAD_TOO_LARGE', 'websocket message exceeds limit')
              return
            }
            payloadLen = Number(bigLen)
            offset = 10
          }

          if (opcode >= 0x8) {
            if (!fin || payloadLen > 125 || (opcode !== 0x8 && opcode !== 0x9 && opcode !== 0xa)) {
              failAndClose(1002, 'protocol_error', 'UNAVAILABLE', 'websocket protocol error')
              return
            }
          } else {
            if (opcode === 0x2) {
              failAndClose(1003, 'unsupported_data', 'INVALID_ARGUMENT', 'unsupported binary websocket frame')
              return
            }
            if (opcode !== 0x0 && opcode !== 0x1) {
              failAndClose(1002, 'protocol_error', 'UNAVAILABLE', 'websocket protocol error')
              return
            }
            if ((opcode === 0x1 && inFragmented) || (opcode === 0x0 && !inFragmented)) {
              failAndClose(1002, 'protocol_error', 'UNAVAILABLE', 'websocket protocol error')
              return
            }
            if (payloadLen > maxMessageBytes || accumulatedBytes + payloadLen > maxMessageBytes) {
              failAndClose(1009, 'message_too_large', 'PAYLOAD_TOO_LARGE', 'websocket message exceeds limit')
              return
            }
          }

          if (buf.length < offset + payloadLen) return

          const payload = buf.subarray(offset, offset + payloadLen)
          buf = buf.subarray(offset + payloadLen)

          if (opcode === 0x9) {
            sendControl(0xA, payload)
            continue
          }
          if (opcode === 0xa) {
            continue
          }
          if (opcode === 0x8) {
            if (payload.length === 1) {
              failAndClose(1002, 'protocol_error', 'UNAVAILABLE', 'websocket protocol error')
              return
            }
            const closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
            let rawReason = ''
            if (payload.length > 2) {
              try {
                rawReason = new TextDecoder('utf-8', { fatal: true }).decode(payload.subarray(2))
              } catch {
                failAndClose(1007, 'invalid_utf8', 'INVALID_ARGUMENT', 'invalid utf-8 close reason')
                return
              }
            }
            const safeReason = redact(rawReason, currentSecrets())
            const replyPayload = isValidWireCloseCode(closeCode) ? buildClosePayload(closeCode) : Buffer.alloc(0)
            terminated = true
            fragments = []
            accumulatedBytes = 0
            buf = Buffer.alloc(0)
            sendControl(0x8, replyPayload)
            socket.end()
            enqueue({ type: 'close', code: closeCode, reason: safeReason })
            disposeEffect()
            return
          }

          fragments.push(Buffer.from(payload))
          accumulatedBytes += payload.length
          if (!fin) {
            inFragmented = true
            continue
          }

          const combined = fragments.length === 1 ? fragments[0]! : Buffer.concat(fragments, accumulatedBytes)
          fragments = []
          accumulatedBytes = 0
          inFragmented = false

          let text: string
          try {
            text = utf8.decode(combined)
          } catch {
            failAndClose(1007, 'invalid_utf8', 'INVALID_ARGUMENT', 'invalid utf-8 websocket message')
            return
          }

          if (pendingMessages >= maxQueueLength) {
            terminated = true
            fragments = []
            accumulatedBytes = 0
            buf = Buffer.alloc(0)
            for (let i = queue.length - 1; i >= 0; i -= 1) {
              if (queue[i]!.type === 'message') queue.splice(i, 1)
            }
            pendingMessages = 0
            sendControl(0x8, buildClosePayload(1008, 'queue_overflow'))
            closeSocketGracefully()
            enqueue({ type: 'error', code: 'UNAVAILABLE', reason: 'websocket event queue overflow' })
            enqueue({ type: 'close', code: 1008, reason: 'queue_overflow' })
            disposeEffect()
            return
          }

          pendingMessages += 1
          enqueue({ type: 'message', data: text })
        }
      }

      socket.on('error', () => {
        if (terminated || disposed) return
        enqueue({ type: 'error', code: 'UNAVAILABLE', reason: 'websocket connection error' })
      })

      socket.on('close', () => {
        if (terminated || disposed) return
        terminated = true
        fragments = []
        accumulatedBytes = 0
        buf = Buffer.alloc(0)
        enqueue({ type: 'close', code: 1006, reason: 'connection_closed' })
        disposeEffect()
      })

      resolve(() => {
        disposeEffect()
      })

      queueMicrotask(() => {
        if (disposed || terminated) return
        void drainQueue()
        socket.on('data', onData)
        if (head.length > 0) onData(head)
        if (!disposed && !terminated && !socket.destroyed) socket.resume()
      })
    })

    req.end()
  })
}
