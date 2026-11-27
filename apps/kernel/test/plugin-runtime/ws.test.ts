import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import net, { type AddressInfo, type Socket } from 'node:net'
import test from 'node:test'
import tls from 'node:tls'
import type { WebSocketEvent } from '@dsh-brain-core/sdk'
import { denial, installed, setup } from './helpers.ts'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

interface WsServerHandle {
  readonly port: number
  readonly requests: { url: string; headers: http.IncomingHttpHeaders }[]
  readonly sockets: Set<Socket>
  readonly clientFrames: { fin: boolean; opcode: number; payload: Buffer }[]
  sendFrame(socket: Socket, options: { fin?: boolean; rsv?: number; opcode: number; payload: Buffer; mask?: Buffer }): void
  sendText(socket: Socket, text: string): void
  close(): Promise<void>
}

function parseMaskedClientFrames(buffer: Buffer): { frames: { fin: boolean; opcode: number; payload: Buffer }[]; rest: Buffer } {
  const frames: { fin: boolean; opcode: number; payload: Buffer }[] = []
  let buf = buffer
  while (buf.length >= 2) {
    const b0 = buf[0]!
    const b1 = buf[1]!
    const fin = (b0 & 0x80) !== 0
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let offset = 2
    let len = b1 & 0x7f
    if (len === 126) {
      if (buf.length < 4) break
      len = buf.readUInt16BE(2)
      offset = 4
    } else if (len === 127) {
      if (buf.length < 10) break
      len = Number(buf.readBigUInt64BE(2))
      offset = 10
    }
    const maskLen = masked ? 4 : 0
    if (buf.length < offset + maskLen + len) break
    const payload = Buffer.from(buf.subarray(offset + maskLen, offset + maskLen + len))
    if (masked) {
      const mask = buf.subarray(offset, offset + 4)
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] = payload[i]! ^ mask[i & 3]!
      }
    }
    frames.push({ fin, opcode, payload })
    buf = buf.subarray(offset + maskLen + len)
  }
  return { frames, rest: buf }
}

function buildServerFrame(options: { fin?: boolean; rsv?: number; opcode: number; payload: Buffer; mask?: Buffer }): Buffer {
  const finBit = options.fin === false ? 0 : 0x80
  const rsvBits = (options.rsv ?? 0) & 0x70
  const opcode = options.opcode & 0x0f
  const len = options.payload.length
  const masked = options.mask !== undefined
  const maskBit = masked ? 0x80 : 0
  let headerLen = 2
  if (len >= 126 && len <= 65535) headerLen = 4
  else if (len > 65535) headerLen = 10
  const out = Buffer.allocUnsafe(headerLen + (masked ? 4 : 0) + len)
  out[0] = finBit | rsvBits | opcode
  if (len < 126) {
    out[1] = maskBit | len
  } else if (len <= 65535) {
    out[1] = maskBit | 126
    out.writeUInt16BE(len, 2)
  } else {
    out[1] = maskBit | 127
    out.writeBigUInt64BE(BigInt(len), 2)
  }
  let offset = headerLen
  if (masked && options.mask !== undefined) {
    options.mask.copy(out, offset)
    offset += 4
    for (let i = 0; i < len; i += 1) out[offset + i] = options.payload[i]! ^ options.mask[i & 3]!
  } else {
    options.payload.copy(out, offset)
  }
  return out
}

async function startWsServer(options: {
  onRequest?: (req: http.IncomingMessage, res: http.ServerResponse) => void
  onUpgrade?: (req: http.IncomingMessage, socket: Socket, head: Buffer, accept: () => void) => void
  tls?: { key: string; cert: string }
} = {}): Promise<WsServerHandle> {
  const requests: { url: string; headers: http.IncomingHttpHeaders }[] = []
  const sockets = new Set<Socket>()
  const clientFrames: { fin: boolean; opcode: number; payload: Buffer }[] = []

  const server = options.tls === undefined
    ? http.createServer((req, res) => {
        requests.push({ url: req.url ?? '', headers: req.headers })
        if (options.onRequest !== undefined) { options.onRequest(req, res); return }
        res.writeHead(404)
        res.end()
      })
    : https.createServer({ key: options.tls.key, cert: options.tls.cert }, (req, res) => {
        requests.push({ url: req.url ?? '', headers: req.headers })
        if (options.onRequest !== undefined) { options.onRequest(req, res); return }
        res.writeHead(404)
        res.end()
      })

  server.on('upgrade', (req, socket: Socket, head) => {
    requests.push({ url: req.url ?? '', headers: req.headers })
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('end', () => { if (!socket.destroyed) socket.end() })
    let rxBuf: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      rxBuf = rxBuf.length === 0 ? chunk : Buffer.concat([rxBuf, chunk])
      const parsed = parseMaskedClientFrames(rxBuf)
      clientFrames.push(...parsed.frames)
      rxBuf = parsed.rest
    })
    const accept = (): void => {
      const key = String(req.headers['sec-websocket-key'] ?? '')
      const digest = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + `Sec-WebSocket-Accept: ${digest}\r\n\r\n`,
      )
    }
    if (options.onUpgrade !== undefined) {
      options.onUpgrade(req, socket, head, accept)
    } else {
      accept()
    }
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    requests,
    sockets,
    clientFrames,
    sendFrame: (socket, frameOpts) => {
      socket.write(buildServerFrame(frameOpts))
    },
    sendText: (socket, text) => {
      socket.write(buildServerFrame({ opcode: 0x1, payload: Buffer.from(text, 'utf8') }))
    },
    async close() {
      for (const socket of [...sockets]) socket.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 15))
  }
}

function createCaAndLeafCert(dnsName: string): { caCertPem: string; leafKeyPem: string; leafCertPem: string } {
  const derLen = (len: number): Buffer => {
    if (len < 128) return Buffer.from([len])
    const bytes: number[] = []
    let n = len
    while (n > 0) { bytes.unshift(n & 0xff); n >>= 8 }
    return Buffer.from([0x80 | bytes.length, ...bytes])
  }
  const tlv = (tag: number, content: Buffer | Buffer[]): Buffer => {
    const buf = Buffer.isBuffer(content) ? content : Buffer.concat(content)
    return Buffer.concat([Buffer.from([tag]), derLen(buf.length), buf])
  }
  const seq = (items: Buffer[]): Buffer => tlv(0x30, items)
  const set = (items: Buffer[]): Buffer => tlv(0x31, items)
  const oid = (bytes: number[]): Buffer => tlv(0x06, Buffer.from(bytes))
  const intBuf = (n: number): Buffer => tlv(0x02, Buffer.from([n]))
  const utf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s, 'utf8'))
  const utc = (d: Date): Buffer => {
    const pad = (x: number) => String(x).padStart(2, '0')
    const s = `${String(d.getUTCFullYear()).slice(-2)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
    return tlv(0x17, Buffer.from(s, 'ascii'))
  }
  const bitString = (buf: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), buf]))
  const ecdsaSha256 = seq([oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02])])
  const validity = seq([utc(new Date(Date.now() - 60_000)), utc(new Date(Date.now() + 86_400_000))])
  const toPem = (der: Buffer): string =>
    `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`

  const caKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const caCn = seq([set([seq([oid([0x55, 0x04, 0x03]), utf8('Test Root CA')])])])
  const caExt = tlv(0xa3, [seq([
    seq([oid([0x55, 0x1d, 0x13]), Buffer.from([0x01, 0x01, 0xff]), tlv(0x04, seq([Buffer.from([0x01, 0x01, 0xff])]))]),
  ])])
  const caTbs = seq([tlv(0xa0, [intBuf(2)]), intBuf(1), ecdsaSha256, caCn, validity, caCn, caKeys.publicKey.export({ type: 'spki', format: 'der' }), caExt])
  const caCertPem = toPem(seq([caTbs, ecdsaSha256, bitString(sign('sha256', caTbs, caKeys.privateKey))]))

  const leafKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const leafCn = seq([set([seq([oid([0x55, 0x04, 0x03]), utf8(dnsName)])])])
  const leafExt = tlv(0xa3, [seq([
    seq([oid([0x55, 0x1d, 0x11]), tlv(0x04, seq([tlv(0x82, Buffer.from(dnsName, 'ascii'))]))]),
  ])])
  const leafTbs = seq([tlv(0xa0, [intBuf(2)]), intBuf(2), ecdsaSha256, caCn, validity, leafCn, leafKeys.publicKey.export({ type: 'spki', format: 'der' }), leafExt])
  const leafCertPem = toPem(seq([leafTbs, ecdsaSha256, bitString(sign('sha256', leafTbs, caKeys.privateKey))]))
  const leafKeyPem = String(leafKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }))
  return { caCertPem, leafKeyPem, leafCertPem }
}

test('ws: rejects ungranted configKey, invalid options, url mismatch, bad scheme, credentials, and auth query params', async () => {
  const s = await setup()
  await s.runtime.enable(installed(['lan:config:wsUrl', 'secrets:ws-token'], { config: { wsUrl: 'ws://127.0.0.1:3001/ws' } }))
  const ctx = s.ctx()

  await denial(ctx.http.subscribeWebSocket!(null as never, () => undefined), 'INVALID_ARGUMENT')
  await denial(ctx.http.subscribeWebSocket!({ configKey: '' }, () => undefined), 'INVALID_ARGUMENT')
  await denial(ctx.http.subscribeWebSocket!({ configKey: 'wsUrl' }, 'nope' as never), 'INVALID_ARGUMENT')
  await denial(ctx.http.subscribeWebSocket!({ configKey: 'wsUrl', timeoutMs: -1 }, () => undefined), 'INVALID_ARGUMENT')
  await denial(ctx.http.subscribeWebSocket!({ configKey: 'wsUrl', maxMessageBytes: 1.5 }, () => undefined), 'INVALID_ARGUMENT')
  await denial(ctx.http.subscribeWebSocket!({ configKey: 'wsUrl', maxQueueLength: 0 }, () => undefined), 'INVALID_ARGUMENT')
  await denial(ctx.http.subscribeWebSocket!({ configKey: 'wsUrl', auth: { secretNames: [] } }, () => undefined), 'INVALID_ARGUMENT')
  await denial(ctx.http.subscribeWebSocket!({ configKey: 'wsUrl', auth: { secretNames: ['ws-token'], transport: 'cookie' as never } }, () => undefined), 'INVALID_ARGUMENT')
  await denial(ctx.http.subscribeWebSocket!({ configKey: 'wsUrl', auth: { secretNames: ['ws-token'], paramName: 'x\r\ny' } }, () => undefined), 'INVALID_ARGUMENT')

  // Ungranted configKey
  await denial(ctx.http.subscribeWebSocket!({ configKey: 'otherUrl' }, () => undefined))

  // URL mismatch
  await denial(ctx.http.subscribeWebSocket!({ configKey: 'wsUrl', url: 'ws://127.0.0.1:3002/ws' }, () => undefined))
  await denial(ctx.http.subscribeWebSocket!({ configKey: 'wsUrl', url: 'ws://127.0.0.1:3001/other' }, () => undefined))
  await denial(ctx.http.subscribeWebSocket!({ configKey: 'wsUrl', url: 'ws://u:p@127.0.0.1:3001/ws' }, () => undefined))

  // Bad scheme, credentials, and auth query params in config
  for (const badUrl of [
    'http://127.0.0.1:3001/ws',
    'https://127.0.0.1:3001/ws',
    'ws://user:pass@127.0.0.1:3001/ws',
    'ws://user@127.0.0.1:3001/ws',
    'ws://127.0.0.1:3001/ws?token=abc',
    'ws://127.0.0.1:3001/ws?Access_Token=abc',
    'ws://127.0.0.1:3001/ws?apikey=abc',
    'ws://127.0.0.1:3001/ws?cookie=abc',
  ]) {
    const sBad = await setup()
    await sBad.runtime.enable(installed(['lan:config:wsUrl'], { config: { wsUrl: badUrl } }))
    await denial(sBad.ctx().http.subscribeWebSocket!({ configKey: 'wsUrl' }, () => undefined))
    await sBad.runtime.disable('qq')
  }

  // Custom paramName in config URL query is also rejected
  const sCustom = await setup()
  await sCustom.runtime.enable(installed(['lan:config:wsUrl', 'secrets:ws-token'], { config: { wsUrl: 'ws://127.0.0.1:3001/ws?MyAuth=123' } }))
  await denial(sCustom.ctx().http.subscribeWebSocket!({
    configKey: 'wsUrl',
    auth: { secretNames: ['ws-token'], transport: 'query', paramName: 'MyAuth' },
  }, () => undefined))
  await sCustom.runtime.disable('qq')
  await s.runtime.disable('qq')
})

test('ws: rejects ungranted secrets (including fallback) before reading any secret', async () => {
  const s = await setup()
  s.state.secrets.set('plugin.qq.primary', 'secret-primary-value')
  await s.runtime.enable(installed(['lan:config:wsUrl', 'secrets:primary'], { config: { wsUrl: 'ws://127.0.0.1:3001' } }))
  await denial(s.ctx().http.subscribeWebSocket!({
    configKey: 'wsUrl',
    auth: { secretNames: ['primary', 'fallback'] },
  }, () => undefined))
  assert.equal(s.calls['secrets.get'], undefined)
  await s.runtime.disable('qq')
})

test('ws: network:config blocks private IP, and ws: with secret blocks non-loopback LAN', async () => {
  const sNet = await setup({ deps: { lookup: async () => ['127.0.0.1'] } })
  await sNet.runtime.enable(installed(['network:config:wsUrl'], { config: { wsUrl: 'ws://ws.local:3001' } }))
  await denial(sNet.ctx().http.subscribeWebSocket!({ configKey: 'wsUrl' }, () => undefined))
  await sNet.runtime.disable('qq')

  const sLan = await setup({ deps: { lookup: async () => ['192.168.1.10'] } })
  sLan.state.secrets.set('plugin.qq.tok', 'secret-token-12345')
  await sLan.runtime.enable(installed(['lan:config:wsUrl', 'secrets:tok'], { config: { wsUrl: 'ws://192.168.1.10:3001' } }))
  await denial(sLan.ctx().http.subscribeWebSocket!({
    configKey: 'wsUrl',
    auth: { secretNames: ['tok'] },
  }, () => undefined))
  await sLan.runtime.disable('qq')

  // Mixed DNS resolution (loopback + LAN) with secret on plaintext ws: is rejected
  const sMixed = await setup({ deps: { lookup: async () => ['127.0.0.1', '192.168.1.10'] } })
  sMixed.state.secrets.set('plugin.qq.tok', 'secret-token-12345')
  await sMixed.runtime.enable(installed(['lan:config:wsUrl', 'secrets:tok'], { config: { wsUrl: 'ws://mixed.local:3001' } }))
  await denial(sMixed.ctx().http.subscribeWebSocket!({
    configKey: 'wsUrl',
    auth: { secretNames: ['tok'] },
  }, () => undefined))
  await sMixed.runtime.disable('qq')
})

test('ws: secret fallback, header & query injection, URL normalization, and redaction on close/logs', async () => {
  const srv = await startWsServer()
  try {
    const secretVal = 'super-secret-ws-token-9876'
    const s = await setup({ deps: { lookup: async () => ['127.0.0.1'] } })
    s.state.secrets.set('plugin.qq.primary', '')
    s.state.secrets.set('plugin.qq.fallback', secretVal)
    await s.runtime.enable(installed(
      ['lan:config:wsUrl', 'secrets:primary', 'secrets:fallback'],
      { config: { wsUrl: `ws://127.0.0.1:${srv.port}/onebot?role=bot` } },
    ))

    const events: WebSocketEvent[] = []
    const dispose1 = await s.ctx().http.subscribeWebSocket!({
      configKey: 'wsUrl',
      url: `ws://127.0.0.1:${srv.port}/onebot?role=bot`,
      auth: { secretNames: ['primary', 'fallback'], transport: 'header' },
    }, (ev) => { events.push(ev) })

    await waitFor(() => events.length >= 1)
    assert.deepEqual(events[0], { type: 'open' })
    assert.equal(srv.requests[0]!.headers.authorization, `Bearer ${secretVal}`)
    assert.equal(srv.requests[0]!.url, '/onebot?role=bot')

    // Server sends close frame leaking secret in reason -> must be redacted
    const sock1 = [...srv.sockets][0]!
    const closePayload = Buffer.concat([Buffer.from([0x03, 0xe8]), Buffer.from(`bye ${secretVal}`, 'utf8')])
    srv.sendFrame(sock1, { opcode: 0x8, payload: closePayload })
    await waitFor(() => events.some((e) => e.type === 'close'))
    const closeEvent = events.find((e) => e.type === 'close')
    assert.deepEqual(closeEvent, { type: 'close', code: 1000, reason: 'bye [redacted]' })
    dispose1()

    // Query transport injection (wire-only)
    const events2: WebSocketEvent[] = []
    const dispose2 = await s.ctx().http.subscribeWebSocket!({
      configKey: 'wsUrl',
      auth: { secretNames: ['fallback'], transport: 'query', paramName: 'access_token' },
    }, (ev) => { events2.push(ev) })

    await waitFor(() => events2.length >= 1 && srv.requests.length >= 2)
    assert.equal(srv.requests[1]!.url, `/onebot?role=bot&access_token=${secretVal}`)
    assert.equal(srv.requests[1]!.headers.authorization, undefined)
    // Config never mutated
    assert.equal((s.ctx().config as { wsUrl: string }).wsUrl, `ws://127.0.0.1:${srv.port}/onebot?role=bot`)
    dispose2()
    await s.runtime.disable('qq')
  } finally {
    await srv.close()
  }
})

test('ws: handshake 302 redirect, 401/403 auth failure, 500 failure, and timeout', async () => {
  const srv = await startWsServer({
    onUpgrade: (req, socket, _head, accept) => {
      if (req.url === '/redirect') {
        socket.end('HTTP/1.1 302 Found\r\nLocation: /other\r\n\r\n')
        return
      }
      if (req.url === '/unauth') {
        socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
        return
      }
      if (req.url === '/forbidden') {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
        return
      }
      if (req.url === '/bad-accept') {
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: wrong\r\n\r\n')
        return
      }
      if (req.url === '/hang') {
        return
      }
      accept()
    },
  })
  try {
    const check = async (p: string, expectedCode: string, timeoutMs?: number): Promise<void> => {
      const s = await setup()
      await s.runtime.enable(installed(['lan:config:wsUrl'], { config: { wsUrl: `ws://127.0.0.1:${srv.port}${p}` } }))
      await denial(s.ctx().http.subscribeWebSocket!({ configKey: 'wsUrl', ...(timeoutMs ? { timeoutMs } : {}) }, () => undefined), expectedCode)
      await s.runtime.disable('qq')
    }

    await check('/redirect', 'PERMISSION_DENIED')
    await check('/unauth', 'UNAUTHENTICATED')
    await check('/forbidden', 'UNAUTHENTICATED')
    await check('/bad-accept', 'UNAVAILABLE')
    await check('/hang', 'UNAVAILABLE', 100)
  } finally {
    await srv.close()
  }
})

test('ws: RFC 6455 fragmentation, interleaved ping/pong, TCP chunk splitting, and head frames', async () => {
  const srv = await startWsServer({
    onUpgrade: (_req, socket, _head, accept) => {
      accept()
      // Immediately push initial frame right behind 101 response to exercise `head` handling
      socket.write(buildServerFrame({ opcode: 0x1, payload: Buffer.from('from-head', 'utf8') }))
    },
  })
  try {
    const s = await setup()
    await s.runtime.enable(installed(['lan:config:wsUrl'], { config: { wsUrl: `ws://127.0.0.1:${srv.port}/` } }))
    const events: WebSocketEvent[] = []
    const dispose = await s.ctx().http.subscribeWebSocket!({ configKey: 'wsUrl' }, (ev) => { events.push(ev) })

    await waitFor(() => events.length >= 2)
    assert.deepEqual(events[0], { type: 'open' })
    assert.deepEqual(events[1], { type: 'message', data: 'from-head' })

    const sock = [...srv.sockets][0]!
    // Fragment 1 (UTF-8 multi-byte split across fragments!) + Ping + Fragment 2
    const full = Buffer.from('你好世界-hello', 'utf8')
    const part1 = full.subarray(0, 4)
    const part2 = full.subarray(4)
    const frame1 = buildServerFrame({ fin: false, opcode: 0x1, payload: part1 })
    const ping = buildServerFrame({ fin: true, opcode: 0x9, payload: Buffer.from('hb', 'utf8') })
    const frame2 = buildServerFrame({ fin: true, opcode: 0x0, payload: part2 })
    const combined = Buffer.concat([frame1, ping, frame2])
    // Drip byte-by-byte / small chunks to exercise arbitrary TCP chunk splitting
    for (let i = 0; i < combined.length; i += 3) {
      sock.write(combined.subarray(i, i + 3))
    }

    await waitFor(() => events.length >= 3 && srv.clientFrames.some((f) => f.opcode === 0xa))
    assert.deepEqual(events[2], { type: 'message', data: '你好世界-hello' })
    const pong = srv.clientFrames.find((f) => f.opcode === 0xa)!
    assert.equal(pong.payload.toString('utf8'), 'hb')

    dispose()
    await s.runtime.disable('qq')
  } finally {
    await srv.close()
  }
})

test('ws: enforces binary 1003, masked/rsv 1002, invalid UTF-8 1007, 1 MiB / maxMessageBytes 1009, and bounded queue 1008', async () => {
  const srv = await startWsServer()
  try {
    // 1. Binary frame -> close 1003
    {
      const s = await setup()
      await s.runtime.enable(installed(['lan:config:wsUrl'], { config: { wsUrl: `ws://127.0.0.1:${srv.port}/` } }))
      const events: WebSocketEvent[] = []
      await s.ctx().http.subscribeWebSocket!({ configKey: 'wsUrl' }, (ev) => { events.push(ev) })
      await waitFor(() => events.length >= 1 && srv.sockets.size >= 1)
      srv.sendFrame([...srv.sockets].at(-1)!, { opcode: 0x2, payload: Buffer.from([1, 2, 3]) })
      await waitFor(() => events.some((e) => e.type === 'close'))
      assert.equal((events.find((e) => e.type === 'close') as Extract<WebSocketEvent, { type: 'close' }>).code, 1003)
      assert.equal((events.find((e) => e.type === 'close') as Extract<WebSocketEvent, { type: 'close' }>).reason, 'unsupported_data')
      await s.runtime.disable('qq')
      await waitFor(() => srv.sockets.size === 0)
    }

    // 2. Masked server frame -> close 1002
    {
      const s = await setup()
      await s.runtime.enable(installed(['lan:config:wsUrl'], { config: { wsUrl: `ws://127.0.0.1:${srv.port}/` } }))
      const events: WebSocketEvent[] = []
      await s.ctx().http.subscribeWebSocket!({ configKey: 'wsUrl' }, (ev) => { events.push(ev) })
      await waitFor(() => events.length >= 1 && srv.sockets.size >= 1)
      srv.sendFrame([...srv.sockets].at(-1)!, { opcode: 0x1, payload: Buffer.from('hi'), mask: Buffer.from([1, 2, 3, 4]) })
      await waitFor(() => events.some((e) => e.type === 'close'))
      assert.equal((events.find((e) => e.type === 'close') as Extract<WebSocketEvent, { type: 'close' }>).code, 1002)
      await s.runtime.disable('qq')
      await waitFor(() => srv.sockets.size === 0)
    }

    // 3. Invalid UTF-8 -> close 1007
    {
      const s = await setup()
      await s.runtime.enable(installed(['lan:config:wsUrl'], { config: { wsUrl: `ws://127.0.0.1:${srv.port}/` } }))
      const events: WebSocketEvent[] = []
      await s.ctx().http.subscribeWebSocket!({ configKey: 'wsUrl' }, (ev) => { events.push(ev) })
      await waitFor(() => events.length >= 1 && srv.sockets.size >= 1)
      srv.sendFrame([...srv.sockets].at(-1)!, { opcode: 0x1, payload: Buffer.from([0xff, 0xfe]) })
      await waitFor(() => events.some((e) => e.type === 'close'))
      assert.equal((events.find((e) => e.type === 'close') as Extract<WebSocketEvent, { type: 'close' }>).code, 1007)
      await s.runtime.disable('qq')
      await waitFor(() => srv.sockets.size === 0)
    }

    // 4. Oversized frame header (> 1 MiB) rejected BEFORE buffering body -> close 1009 + PAYLOAD_TOO_LARGE
    {
      const s = await setup()
      await s.runtime.enable(installed(['lan:config:wsUrl'], { config: { wsUrl: `ws://127.0.0.1:${srv.port}/` } }))
      const events: WebSocketEvent[] = []
      await s.ctx().http.subscribeWebSocket!({ configKey: 'wsUrl', maxMessageBytes: 2 * 1024 * 1024 }, (ev) => { events.push(ev) })
      await waitFor(() => events.length >= 1 && srv.sockets.size >= 1)
      const sock = [...srv.sockets].at(-1)!
      // Send ONLY the 10-byte frame header claiming 1 MiB + 1 byte (without sending body!)
      const header = Buffer.allocUnsafe(10)
      header[0] = 0x81
      header[1] = 127
      header.writeBigUInt64BE(BigInt(1024 * 1024 + 1), 2)
      sock.write(header)
      await waitFor(() => events.some((e) => e.type === 'close'))
      assert.deepEqual(events.slice(1), [
        { type: 'error', code: 'PAYLOAD_TOO_LARGE', reason: 'websocket message exceeds limit' },
        { type: 'close', code: 1009, reason: 'message_too_large' },
      ])
      await s.runtime.disable('qq')
      await waitFor(() => srv.sockets.size === 0)
    }

    // 5. Bounded delivery queue overflow -> close 1008 + drops unread messages
    {
      const s = await setup()
      await s.runtime.enable(installed(['lan:config:wsUrl'], { config: { wsUrl: `ws://127.0.0.1:${srv.port}/` } }))
      const events: WebSocketEvent[] = []
      let releaseFirst!: () => void
      const firstGate = new Promise<void>((r) => { releaseFirst = r })
      await s.ctx().http.subscribeWebSocket!({ configKey: 'wsUrl', maxQueueLength: 2 }, async (ev) => {
        events.push(ev)
        if (ev.type === 'message' && ev.data === 'm1') {
          await firstGate
        }
      })
      await waitFor(() => events.length >= 1 && srv.sockets.size >= 1)
      const sock = [...srv.sockets].at(-1)!
      srv.sendText(sock, 'm1')
      await waitFor(() => events.some((e) => e.type === 'message' && e.data === 'm1'))
      // Now pendingMessages === 1 (m1 in-flight). Send m2 (pendingMessages -> 2), then m3 -> overflow!
      srv.sendText(sock, 'm2')
      srv.sendText(sock, 'm3')
      await waitFor(() => srv.clientFrames.some((f) => f.opcode === 0x8 && f.payload.readUInt16BE(0) === 1008))
      releaseFirst()
      await waitFor(() => events.some((e) => e.type === 'close'))
      assert.equal(events.some((e) => e.type === 'message' && e.data === 'm2'), false)
      assert.equal(events.some((e) => e.type === 'message' && e.data === 'm3'), false)
      assert.deepEqual(events.slice(-2), [
        { type: 'error', code: 'UNAVAILABLE', reason: 'websocket event queue overflow' },
        { type: 'close', code: 1008, reason: 'queue_overflow' },
      ])
      await s.runtime.disable('qq')
      await waitFor(() => srv.sockets.size === 0)
    }

    // 6. Fragmented message where each frame < 1 MiB but combined > 1 MiB -> close 1009 + PAYLOAD_TOO_LARGE
    {
      const s = await setup()
      await s.runtime.enable(installed(['lan:config:wsUrl'], { config: { wsUrl: `ws://127.0.0.1:${srv.port}/` } }))
      const events: WebSocketEvent[] = []
      await s.ctx().http.subscribeWebSocket!({ configKey: 'wsUrl' }, (ev) => { events.push(ev) })
      await waitFor(() => events.length >= 1 && srv.sockets.size >= 1)
      const sock = [...srv.sockets].at(-1)!
      srv.sendFrame(sock, { fin: false, opcode: 0x1, payload: Buffer.alloc(600 * 1024, 0x61) })
      srv.sendFrame(sock, { fin: true, opcode: 0x0, payload: Buffer.alloc(600 * 1024, 0x62) })
      await waitFor(() => events.some((e) => e.type === 'close'))
      assert.equal(events.some((e) => e.type === 'message'), false)
      assert.deepEqual(events.slice(1), [
        { type: 'error', code: 'PAYLOAD_TOO_LARGE', reason: 'websocket message exceeds limit' },
        { type: 'close', code: 1009, reason: 'message_too_large' },
      ])
      await s.runtime.disable('qq')
      await waitFor(() => srv.sockets.size === 0)
    }
  } finally {
    await srv.close()
  }
})

test('ws: plugin disable and mid-handshake disable immediately tear down socket', async () => {
  const srv = await startWsServer()
  try {
    const s = await setup()
    await s.runtime.enable(installed(['lan:config:wsUrl'], { config: { wsUrl: `ws://127.0.0.1:${srv.port}/` } }))
    const events: WebSocketEvent[] = []
    await s.ctx().http.subscribeWebSocket!({ configKey: 'wsUrl' }, (ev) => { events.push(ev) })
    await waitFor(() => events.length >= 1 && srv.sockets.size === 1)
    await s.runtime.disable('qq')
    await waitFor(() => srv.sockets.size === 0 && srv.clientFrames.some((f) => f.opcode === 0x8 && f.payload.readUInt16BE(0) === 1000))
  } finally {
    await srv.close()
  }

  // Disabled mid-handshake: upgrade arrives after plugin disable -> destroyed & rejected
  let releaseUpgrade!: () => void
  const upgradeGate = new Promise<void>((r) => { releaseUpgrade = r })
  const srvMid = await startWsServer({
    onUpgrade: (_req, socket, _head, accept) => {
      // Aborting before the upgrade can reset the server's TCP peer on macOS.
      socket.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ECONNRESET') throw error
      })
      void upgradeGate.then(() => { if (!socket.destroyed) accept() })
    },
  })
  try {
    const s = await setup()
    await s.runtime.enable(installed(['lan:config:wsUrl'], { config: { wsUrl: `ws://127.0.0.1:${srvMid.port}/` } }))
    const subPromise = s.ctx().http.subscribeWebSocket!({ configKey: 'wsUrl' }, () => undefined)
    await waitFor(() => srvMid.requests.length === 1)
    await s.runtime.disable('qq')
    releaseUpgrade()
    await denial(subPromise)
    await waitFor(() => srvMid.sockets.size === 0)
  } finally {
    await srvMid.close()
  }
})

test('ws: wss:// with secret on cross-host verifies TLS servername and succeeds when SAN matches, fails when SAN mismatches', async () => {
  const { caCertPem, leafKeyPem, leafCertPem } = createCaAndLeafCert('ws.example.local')
  const prevCAs = tls.getCACertificates('default')
  tls.setDefaultCACertificates([...prevCAs, caCertPem])
  const srv = await startWsServer({
    tls: { key: leafKeyPem, cert: leafCertPem },
    onUpgrade: (_req, socket, _head, accept) => {
      accept()
      socket.write(buildServerFrame({ opcode: 0x1, payload: Buffer.from('tls-ok', 'utf8') }))
    },
  })

  try {
    // Matching SAN ('ws.example.local') pinned to 127.0.0.1 succeeds (even with non-loopback LAN IP permission / network:config)
    const s = await setup({ deps: { lookup: async () => ['127.0.0.1'] } })
    s.state.secrets.set('plugin.qq.tok', 'cross-host-secret-token')
    await s.runtime.enable(installed(
      ['lan:config:wsUrl', 'secrets:tok'],
      { config: { wsUrl: `wss://ws.example.local:${srv.port}/onebot` } },
    ))
    const events: WebSocketEvent[] = []
    const dispose = await s.ctx().http.subscribeWebSocket!({
      configKey: 'wsUrl',
      auth: { secretNames: ['tok'], transport: 'header' },
    }, (ev) => { events.push(ev) })
    await waitFor(() => events.length >= 2)
    assert.deepEqual(events, [{ type: 'open' }, { type: 'message', data: 'tls-ok' }])
    assert.equal(srv.requests[0]!.headers.authorization, 'Bearer cross-host-secret-token')
    dispose()
    await s.runtime.disable('qq')

    // Mismatched SAN ('wrong.example.local') pinned to 127.0.0.1 fails TLS servername verification
    const sBad = await setup({ deps: { lookup: async () => ['127.0.0.1'] } })
    sBad.state.secrets.set('plugin.qq.tok', 'cross-host-secret-token')
    await sBad.runtime.enable(installed(
      ['lan:config:wsUrl', 'secrets:tok'],
      { config: { wsUrl: `wss://wrong.example.local:${srv.port}/onebot` } },
    ))
    await denial(
      sBad.ctx().http.subscribeWebSocket!({
        configKey: 'wsUrl',
        auth: { secretNames: ['tok'], transport: 'header' },
      }, () => undefined),
      'UNAVAILABLE',
    )
    await sBad.runtime.disable('qq')
  } finally {
    tls.setDefaultCACertificates(prevCAs)
    await srv.close()
  }
})

test('ws: runtime.disable eagerly aborts in-flight TCP/HTTP handshake without waiting for timeoutMs', async () => {
  const sockets = new Set<Socket>()
  const blackhole = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('data', () => undefined)
    socket.on('error', () => undefined)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => blackhole.listen(0, '127.0.0.1', resolve))
  const port = (blackhole.address() as AddressInfo).port
  try {
    const s = await setup()
    await s.runtime.enable(installed(['lan:config:wsUrl'], { config: { wsUrl: `ws://127.0.0.1:${port}/` } }))
    const started = Date.now()
    const subPromise = s.ctx().http.subscribeWebSocket!({ configKey: 'wsUrl', timeoutMs: 10_000 }, () => undefined)
    await waitFor(() => sockets.size === 1)
    await s.runtime.disable('qq')
    await denial(subPromise, 'PERMISSION_DENIED')
    const elapsedMs = Date.now() - started
    assert.ok(elapsedMs < 500, `expected eager abort < 500ms, took ${elapsedMs}ms`)
    await waitFor(() => sockets.size === 0)
  } finally {
    for (const sock of [...sockets]) sock.destroy()
    await new Promise<void>((resolve) => blackhole.close(() => resolve()))
  }
})
