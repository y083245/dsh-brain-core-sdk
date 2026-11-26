import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { removeTree } from '@brain-core/satellite-host'
import { FakeDeepSeek } from '@brain-core/testkit'
import { createKernel, type Kernel } from '../../src/assembly.ts'
import { createSettingsStore } from '../../src/runtime-stores/settings.ts'
import { createSecretStore } from '../../src/secrets/index.ts'
import { capturingLogger, FLASH, setup, TOKEN, waitFor, type LogEntry } from './helpers.ts'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../')
const QQ_PLUGIN_DIR = path.join(REPO_ROOT, 'plugins', 'qq-channel')

const HTTP_TOKEN = 'e2e-onebot-http-token-xyz'
const WS_TOKEN = 'e2e-onebot-ws-token-abc'
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function buildServerTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  if (len < 126) {
    return Buffer.concat([Buffer.from([0x81, len]), payload])
  }
  if (len <= 65535) {
    return Buffer.concat([Buffer.from([0x81, 126, (len >> 8) & 0xff, len & 0xff]), payload])
  }
  const header = Buffer.alloc(10)
  header[0] = 0x81
  header[1] = 127
  header.writeBigUInt64BE(BigInt(len), 2)
  return Buffer.concat([header, payload])
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw === '') return {}
  return JSON.parse(raw) as Record<string, unknown>
}

interface RecordedOneBotAction {
  readonly action: string
  readonly body: Record<string, unknown>
}

interface MockOneBotServer {
  readonly httpUrl: string
  readonly wsUrl: string
  readonly httpOrigin: string
  readonly wsOrigin: string
  readonly actions: RecordedOneBotAction[]
  readonly wsSockets: Set<Socket>
  sendWsEvent(payload: unknown): void
  close(): Promise<void>
}

async function startMockOneBot(httpToken: string, wsToken: string): Promise<MockOneBotServer> {
  const actions: RecordedOneBotAction[] = []
  const wsSockets = new Set<Socket>()
  let privateMsgSeq = 5000
  let groupMsgSeq = 0

  const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(text),
    })
    res.end(text)
  }

  const httpServer: Server = createServer((req, res) => {
    void (async () => {
      if (req.headers.authorization !== `Bearer ${httpToken}`) {
        req.resume()
        sendJson(res, 401, { status: 'failed', retcode: 1401, data: null })
        return
      }
      const action = (req.url ?? '/').split('?')[0]!.replace(/^\/+/, '')
      const body = await readJsonBody(req)
      actions.push({ action, body })

      switch (action) {
        case 'get_login_info':
          sendJson(res, 200, { status: 'ok', retcode: 0, data: { user_id: 999888, nickname: '小鲸鱼' } })
          return
        case 'get_status':
          sendJson(res, 200, { status: 'ok', retcode: 0, data: { online: true, good: true } })
          return
        case 'send_private_msg': {
          privateMsgSeq += 1
          sendJson(res, 200, { status: 'ok', retcode: 0, data: { message_id: privateMsgSeq } })
          return
        }
        case 'send_group_msg': {
          groupMsgSeq -= 1
          sendJson(res, 200, { status: 'ok', retcode: 0, data: { message_id: groupMsgSeq } })
          return
        }
        case 'get_group_member_list':
          sendJson(res, 200, {
            status: 'ok',
            retcode: 0,
            data: [
              { user_id: 123456, nickname: '主人', card: '群主', role: 'owner', last_sent_time: 1_700_000_000 },
            ],
          })
          return
        case 'get_forward_msg':
          sendJson(res, 200, { status: 'ok', retcode: 0, data: { messages: [] } })
          return
        case 'fetch_custom_face':
          sendJson(res, 200, { status: 'ok', retcode: 0, data: [] })
          return
        default:
          sendJson(res, 404, { status: 'failed', retcode: 1404, data: null })
      }
    })()
  })

  const wsServer: Server = createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })

  wsServer.on('upgrade', (req, socket: Socket) => {
    if (req.headers.authorization !== `Bearer ${wsToken}`) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wsSockets.add(socket)
    socket.on('error', () => undefined)
    socket.on('data', () => undefined)
    socket.on('close', () => { wsSockets.delete(socket) })
    socket.on('end', () => { if (!socket.destroyed) socket.end() })

    const key = String(req.headers['sec-websocket-key'] ?? '')
    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
  })

  await Promise.all([
    new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve)),
    new Promise<void>((resolve) => wsServer.listen(0, '127.0.0.1', resolve)),
  ])

  const httpPort = (httpServer.address() as AddressInfo).port
  const wsPort = (wsServer.address() as AddressInfo).port

  return {
    httpUrl: `http://127.0.0.1:${httpPort}`,
    wsUrl: `ws://127.0.0.1:${wsPort}/ws`,
    httpOrigin: `http://127.0.0.1:${httpPort}`,
    wsOrigin: `ws://127.0.0.1:${wsPort}`,
    actions,
    wsSockets,
    sendWsEvent(payload: unknown): void {
      const frame = buildServerTextFrame(JSON.stringify(payload))
      for (const socket of wsSockets) {
        if (!socket.destroyed) {
          socket.write(frame)
        }
      }
    },
    async close(): Promise<void> {
      for (const socket of [...wsSockets]) {
        socket.destroy()
      }
      wsSockets.clear()
      httpServer.closeAllConnections()
      wsServer.closeAllConnections()
      await Promise.all([
        new Promise<void>((resolve) => httpServer.close(() => resolve())),
        new Promise<void>((resolve) => wsServer.close(() => resolve())),
      ])
    },
  }
}

async function hashTree(rootDir: string, currentDir = rootDir, out = new Map<string, string>()): Promise<Map<string, string>> {
  const entries = await readdir(currentDir, { withFileTypes: true })
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name)
    if (entry.isDirectory()) {
      await hashTree(rootDir, fullPath, out)
    } else if (entry.isFile()) {
      const content = await readFile(fullPath)
      const rel = path.relative(rootDir, fullPath).split(path.sep).join('/')
      out.set(rel, createHash('sha256').update(content).digest('hex'))
    }
  }
  return out
}

async function copyPluginTree(src: string, dest: string): Promise<void> {
  const skip = new Set(['node_modules', 'dist', '.git', 'tsconfig.tsbuildinfo'])
  await cp(src, dest, {
    recursive: true,
    force: true,
    filter: (source) => source === src || !skip.has(path.basename(source)),
  })
}

async function apiRequest(
  kernel: Kernel,
  method: string,
  route: string,
  body?: unknown,
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${kernel.port}/api/v1${route}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  }
}

test('QQ provider delivers a scheduled promise without an inbound OneBot event', async (t) => {
  const channel = 'qq:private:123456'
  const reminder = '今天一起去看展，记得留时间。'
  let now = Date.UTC(2026, 10, 26, 10)
  let tick: (() => void) | undefined
  const originalInterval = globalThis.setInterval
  globalThis.setInterval = ((callback: () => void, ms?: number) => {
    if (ms === 30_000) tick = callback
    return originalInterval(callback, ms)
  }) as typeof globalThis.setInterval
  let h: Awaited<ReturnType<typeof setup>>
  try {
    h = await setup(t, {
      settings: { agents: { chat: { ...FLASH } }, timezone: 'UTC' },
      apiKey: 'fake-key',
      roleCard: '你是小满，说话简短。',
      ownerChannels: [channel],
      clock: { now: () => now },
      script: (_request, index) => index === 0
        ? { tool: 'notify__send', input: { text: reminder } }
        : { text: '清楚了。' },
    })
  } finally {
    globalThis.setInterval = originalInterval
  }
  const onebot = await startMockOneBot(HTTP_TOKEN, WS_TOKEN)
  t.after(async () => { await onebot.close() })
  await h.kernel.plugins.install(QQ_PLUGIN_DIR)
  await h.kernel.plugins.confirm('qq')
  await h.kernel.secrets.set('plugin.qq.onebot-http-token', HTTP_TOKEN)
  await h.kernel.secrets.set('plugin.qq.onebot-ws-token', WS_TOKEN)
  await h.kernel.plugins.setConfig('qq', {
    onebotHttpUrl: onebot.httpUrl,
    onebotWsUrl: onebot.wsUrl,
    ownerQQ: '123456',
    allowPrivate: ['123456'],
  })
  await h.kernel.plugins.enable('qq')
  await waitFor(() => onebot.wsSockets.size === 1 ? true : undefined, 10_000, 'the mock OneBot WebSocket')
  onebot.sendWsEvent({
    post_type: 'meta_event',
    meta_event_type: 'heartbeat',
    status: { online: true, good: true },
  })
  await waitFor(async () => {
    const res = await apiRequest(h.kernel, 'GET', '/plugins/qq/status')
    const data = res.body.data as { health?: { state: string } } | undefined
    return data?.health?.state === 'healthy' ? true : undefined
  }, 10_000, 'the QQ provider to become healthy')

  const person = await h.kernel.memory.identity.resolve('qq:123456')
  const source = await h.ingest(channel, '2026-11-26 一起去看展，已经约好了。', person)
  await h.kernel.memory.service.record({
    layer: 'L1',
    kind: 'l1.promise',
    channel,
    actor: 'kernel',
    subjects: [person],
    evidence: [{ id: source }],
    content: { text: '一起去看展', due: '2026-11-26', promiseStatus: 'pending' },
  }, { kind: 'kernel', source: 'test', trust: 'owner', defaultVisibility: 'origin' })

  assert.ok(tick)
  now += 60_000
  tick()
  const action = await waitFor(
    () => onebot.actions.find((item) => item.action === 'send_private_msg'),
    15_000,
    'the scheduled send_private_msg',
  )
  assert.equal(String(action.body.user_id), '123456')
  assert.ok(JSON.stringify(action.body.message).includes(reminder))
  assert.ok(h.fake.requests.some(({ tools, deferred }) => [...tools, ...deferred].includes('notify__send')))
  const outbound = await waitFor(async () => (await h.kernel.memory.readL0({ limit: 100 })).items.find(
    (item) => item.source === 'qq' && item.content.direction === 'outbound' && item.content.text === reminder,
  ), 10_000, 'the outbound QQ memory record')
  assert.equal(outbound.channel, channel)
  const stateFile = path.join(h.home, 'state', 'agent', 'proactive-promises.json')
  assert.match(await waitFor(async () => {
    const value = await readFile(stateFile, 'utf8')
    return value.includes('"status":"sent"') ? value : undefined
  }, 10_000, 'the confirmed delivery'), /"messageId":"5001"/)
})

test('qq-channel full assembly E2E: install, migrate, bidirectional OneBot loop, console UI, upgrade & rollback', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brain-qq-e2e-'))
  const home = path.join(root, 'brain-home')
  const dshHome = path.join(root, 'dsh-home')
  await mkdir(path.join(home, 'state'), { recursive: true })
  await mkdir(dshHome, { recursive: true })
  await writeFile(path.join(dshHome, 'sentinel.json'), '{"owner":"main-dsh"}\n', 'utf8')
  const dshBefore = await hashTree(dshHome)

  const onebot = await startMockOneBot(HTTP_TOKEN, WS_TOKEN)
  const fake = new FakeDeepSeek((req) => {
    if (req.raw.includes('"type":"tool_result"')) {
      return { text: '已经回复给主人了。' }
    }
    return {
      tool: 'qq__send_message',
      input: { messages: ['收到，这就来！'] },
    }
  })
  await fake.listen()

  const holder: { kernel?: Kernel } = {}
  t.after(async () => {
    // Close kernel (subprocesses, HTTP server, SQLite DBs) first to avoid EBUSY on Windows.
    if (holder.kernel !== undefined) {
      await holder.kernel.close()
    }
    await onebot.close()
    await fake.close()
    await removeTree(root)
  })

  await createSettingsStore(path.join(home, 'state', 'settings.json')).write({
    agents: { chat: { ...FLASH } },
  })
  await createSecretStore({ file: path.join(home, 'state', 'secrets.json') }).set('deepseek-api-key', 'fake-key')

  const logs: LogEntry[] = []
  const kernel = await createKernel({
    env: { ...process.env, BRAIN_HOME: home, DSH_HOME: dshHome },
    userHome: home,
    port: 0,
    crossChannel: 'shadow',
    ownerChannels: ['qq:private:123456'],
    log: capturingLogger(logs),
    token: TOKEN,
    baseUrl: fake.url,
  })
  holder.kernel = kernel
  await kernel.memory.persona.saveRoleCard({ name: 'qq-e2e-persona', text: '你是小满，说话简洁明了。' })

  // 1. Install + confirm + 001-init.mjs migration
  const preview1 = await kernel.plugins.install(QQ_PLUGIN_DIR)
  assert.equal(preview1.id, 'qq')
  assert.equal(preview1.version, '0.1.0')
  assert.equal(preview1.permissions.length, 17)

  await kernel.plugins.confirm('qq')

  const qqDataDir = path.join(home, 'state', 'plugins', 'qq')
  assert.equal(await readFile(path.join(qqDataDir, 'schema-version'), 'utf8'), '1\n')
  const stateV1 = JSON.parse(await readFile(path.join(qqDataDir, 'qq-state.json'), 'utf8')) as { schemaVersion: number }
  assert.equal(stateV1.schemaVersion, 1)

  const listAfterConfirm = await kernel.plugins.list()
  const entryAfterConfirm = listAfterConfirm.find((item) => item.id === 'qq')
  assert.ok(entryAfterConfirm !== undefined)
  assert.equal(entryAfterConfirm.state, 'disabled')
  assert.equal(entryAfterConfirm.version, '0.1.0')
  assert.equal(entryAfterConfirm.granted.length, 17)

  // 2. Secrets + config + real process enable + end-to-end inbound/outbound loop
  await kernel.secrets.set('plugin.qq.onebot-http-token', HTTP_TOKEN)
  await kernel.secrets.set('plugin.qq.onebot-ws-token', WS_TOKEN)
  await kernel.plugins.setConfig('qq', {
    onebotHttpUrl: onebot.httpUrl,
    onebotWsUrl: onebot.wsUrl,
    ownerQQ: '123456',
    allowPrivate: ['123456'],
    allowGroups: ['654321'],
    wake: { batchWindowMs: 30, quietDebounceMs: 10, minWakeIntervalMs: 0 },
  })

  await kernel.plugins.enable('qq')

  await waitFor(
    () => (onebot.wsSockets.size === 1 && onebot.actions.some((a) => a.action === 'get_login_info') ? true : undefined),
    15_000,
    'qq plugin WS connect and get_login_info',
  )

  onebot.sendWsEvent({
    post_type: 'meta_event',
    meta_event_type: 'heartbeat',
    status: { online: true, good: true },
  })

  await waitFor(async () => {
    const res = await apiRequest(kernel, 'GET', '/plugins/qq/status')
    if (res.status !== 200) return undefined
    const data = res.body.data as { health: { state: string }; identity: { selfId: string | null } }
    return data.health.state === 'healthy' && data.identity.selfId === '999888' ? data : undefined
  }, 10_000, 'qq plugin healthy status after heartbeat')

  onebot.sendWsEvent({
    post_type: 'message',
    message_type: 'private',
    user_id: 123456,
    message_id: 4001,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: 123456, nickname: '主人' },
    message: [{ type: 'text', data: { text: '小鲸鱼，帮我回复一条消息' } }],
  })

  // Wait for inbound L0, FakeDeepSeek wake, qq__send_message -> OneBot HTTP, and outbound L0.
  const inboundL0 = await waitFor(async () => {
    const l0 = await kernel.memory.readL0({ limit: 100 })
    return l0.items.find(
      (item) => item.channel === 'qq:private:123456' && item.content.direction === 'inbound',
    )
  }, 15_000, 'inbound L0 ingested by qq plugin')
  assert.equal(inboundL0.source, 'qq')
  assert.equal(inboundL0.trust, 'external')
  assert.equal(inboundL0.visibility, 'origin')

  const sendAction = await waitFor(
    () => onebot.actions.find((item) => item.action === 'send_private_msg'),
    30_000,
    'send_private_msg called on mock OneBot',
  )
  assert.equal(String(sendAction.body.user_id), '123456')
  assert.ok(JSON.stringify(sendAction.body.message).includes('收到，这就来！'))
  assert.ok(fake.requests.some((req) => req.tools.includes('qq__send_message')))

  const outboundL0 = await waitFor(async () => {
    const l0 = await kernel.memory.readL0({ limit: 100 })
    return l0.items.find(
      (item) => item.channel === 'qq:private:123456' && item.actor === 'self' && item.content.direction === 'outbound',
    )
  }, 10_000, 'outbound L0 ingested after send_message')
  assert.equal(outboundL0.source, 'qq')
  assert.equal(outboundL0.trust, 'external')
  assert.equal(outboundL0.visibility, 'origin')

  // 3. Console HTTP API & read-only status UI routes
  const pagesRes = await apiRequest(kernel, 'GET', '/console/pages')
  assert.equal(pagesRes.status, 200)
  const pageItems = (pagesRes.body.data as { items: Array<{ pluginId: string; id: string; entry: string }> }).items
  assert.ok(
    pageItems.some((page) => page.pluginId === 'qq' && page.id === 'qq-status' && page.entry === '/api/v1/plugins/qq/ui'),
    `unexpected console pages: ${JSON.stringify(pageItems)}`,
  )

  const uiRes = await apiRequest(kernel, 'GET', '/plugins/qq/ui')
  assert.equal(uiRes.status, 200)
  const uiHtml = String(uiRes.body.data)
  assert.equal(uiHtml.includes('healthy'), true)
  assert.equal(uiHtml.includes(onebot.httpOrigin), true)
  assert.equal(uiHtml.includes(onebot.wsOrigin), true)
  assert.equal(/<script\b/i.test(uiHtml), false)
  assert.equal(/<form\b/i.test(uiHtml), false)
  assert.equal(uiHtml.includes(HTTP_TOKEN), false)
  assert.equal(uiHtml.includes(WS_TOKEN), false)

  const statusRes = await apiRequest(kernel, 'GET', '/plugins/qq/status')
  assert.equal(statusRes.status, 200)
  const statusData = statusRes.body.data as {
    health: { state: string }
    endpoints: { httpOrigin: string; wsOrigin: string }
  }
  assert.equal(statusData.health.state, 'healthy')
  assert.equal(statusData.endpoints.httpOrigin, onebot.httpOrigin)
  assert.equal(statusData.endpoints.wsOrigin, onebot.wsOrigin)

  const channelsRes = await apiRequest(kernel, 'GET', '/plugins/qq/channels')
  assert.equal(channelsRes.status, 200)
  const channelItems = (channelsRes.body.data as { items: Array<{ channel: string }> }).items
  assert.ok(channelItems.some((c) => c.channel === 'qq:private:123456'))
  assert.ok(channelItems.some((c) => c.channel === 'qq:group:654321'))

  const stickersRes = await apiRequest(kernel, 'GET', '/plugins/qq/stickers')
  assert.equal(stickersRes.status, 200)
  assert.equal((stickersRes.body.data as { enabled: boolean }).enabled, true)

  const probeRes = await apiRequest(kernel, 'POST', '/plugins/qq/probe')
  assert.equal(probeRes.status, 200)
  const probeData = probeRes.body.data as {
    ok: boolean
    loginInfo: { ok: boolean; userId: string | null }
    status: { ok: boolean; online: boolean; good: boolean }
  }
  assert.equal(probeData.ok, true)
  assert.equal(probeData.loginInfo.ok, true)
  assert.equal(probeData.loginInfo.userId, '999888')
  assert.equal(probeData.status.ok, true)
  assert.equal(probeData.status.online, true)
  assert.equal(probeData.status.good, true)

  // 4a. Upgrade to v2 (0.2.0 + 002-upgrade.mjs) with no new permissions
  const v2Dir = path.join(root, 'qq-v2')
  await copyPluginTree(QQ_PLUGIN_DIR, v2Dir)
  const v2Pkg = JSON.parse(await readFile(path.join(v2Dir, 'package.json'), 'utf8')) as Record<string, unknown>
  v2Pkg.version = '0.2.0'
  await writeFile(path.join(v2Dir, 'package.json'), `${JSON.stringify(v2Pkg, null, 2)}\n`, 'utf8')
  await writeFile(
    path.join(v2Dir, 'migrations', '002-upgrade.mjs'),
    [
      "const STATE_FILE = 'qq-state.json'",
      'export async function up({ storage, logger }) {',
      "  await storage.write(STATE_FILE, `${JSON.stringify({ schemaVersion: 2 }, null, 2)}\\n`)",
      "  logger.info('qq.migration.upgrade', { version: 2 })",
      '}',
      '',
    ].join('\n'),
    'utf8',
  )

  const v2Preview = await kernel.plugins.upgrade('qq', v2Dir)
  assert.equal(v2Preview.version, '0.2.0')
  assert.deepEqual(v2Preview.newPermissions, [])

  const listAfterV2 = (await kernel.plugins.list()).find((item) => item.id === 'qq')
  assert.ok(listAfterV2 !== undefined)
  assert.equal(listAfterV2.version, '0.2.0')
  assert.equal(listAfterV2.state, 'enabled')
  assert.equal(listAfterV2.granted.length, 17)

  assert.equal(await readFile(path.join(qqDataDir, 'schema-version'), 'utf8'), '2\n')
  const stateV2 = JSON.parse(await readFile(path.join(qqDataDir, 'qq-state.json'), 'utf8')) as { schemaVersion: number }
  assert.equal(stateV2.schemaVersion, 2)

  const storedConfig = JSON.parse(await readFile(path.join(qqDataDir, 'config.json'), 'utf8')) as { ownerQQ: string }
  assert.equal(storedConfig.ownerQQ, '123456')
  assert.equal(await kernel.secrets.get('plugin.qq.onebot-http-token'), HTTP_TOKEN)
  assert.equal(await kernel.secrets.get('plugin.qq.onebot-ws-token'), WS_TOKEN)

  const statusAfterV2 = await apiRequest(kernel, 'GET', '/plugins/qq/status')
  assert.equal(statusAfterV2.status, 200)

  // 4b. Upgrade to v3 (0.3.0 + 003-broken.mjs) fails during migration and rolls back completely to v2
  const v3Dir = path.join(root, 'qq-v3')
  await copyPluginTree(v2Dir, v3Dir)
  const v3Pkg = JSON.parse(await readFile(path.join(v3Dir, 'package.json'), 'utf8')) as Record<string, unknown>
  v3Pkg.version = '0.3.0'
  await writeFile(path.join(v3Dir, 'package.json'), `${JSON.stringify(v3Pkg, null, 2)}\n`, 'utf8')
  await writeFile(
    path.join(v3Dir, 'migrations', '003-broken.mjs'),
    [
      "const STATE_FILE = 'qq-state.json'",
      'export async function up({ storage }) {',
      "  await storage.write(STATE_FILE, `${JSON.stringify({ schemaVersion: 3, corrupted: true }, null, 2)}\\n`)",
      "  throw new Error('simulated 003 migration failure')",
      '}',
      '',
    ].join('\n'),
    'utf8',
  )

  await assert.rejects(
    () => kernel.plugins.upgrade('qq', v3Dir),
    /simulated 003 migration failure/,
  )

  const listAfterRollback = (await kernel.plugins.list()).find((item) => item.id === 'qq')
  assert.ok(listAfterRollback !== undefined)
  assert.equal(listAfterRollback.version, '0.2.0')
  assert.equal(listAfterRollback.state, 'enabled')
  assert.equal(listAfterRollback.granted.length, 17)

  assert.equal(await readFile(path.join(qqDataDir, 'schema-version'), 'utf8'), '2\n')
  const stateAfterRollback = JSON.parse(await readFile(path.join(qqDataDir, 'qq-state.json'), 'utf8')) as {
    schemaVersion: number
    corrupted?: boolean
  }
  assert.equal(stateAfterRollback.schemaVersion, 2)
  assert.equal(stateAfterRollback.corrupted, undefined)

  const configAfterRollback = JSON.parse(await readFile(path.join(qqDataDir, 'config.json'), 'utf8')) as { ownerQQ: string }
  assert.equal(configAfterRollback.ownerQQ, '123456')
  assert.equal(await kernel.secrets.get('plugin.qq.onebot-http-token'), HTTP_TOKEN)
  assert.equal(await kernel.secrets.get('plugin.qq.onebot-ws-token'), WS_TOKEN)

  const statusAfterRollback = await apiRequest(kernel, 'GET', '/plugins/qq/status')
  assert.equal(statusAfterRollback.status, 200)

  // 5. DSH_HOME sentinel remains completely untouched
  const dshAfter = await hashTree(dshHome)
  assert.deepEqual(dshAfter, dshBefore)
})
