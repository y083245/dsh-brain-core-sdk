import assert from 'node:assert/strict'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { validate } from '@dsh-brain-core/sdk'
import { makeBrainHome, modeOf, startConsole, TOKEN } from './helpers.ts'

const KERNEL_TOKEN = 'kernel-secret-token-9f4e'

interface MockKernelRecorder {
  readonly baseUrl: string
  readonly requests: {
    readonly method: string
    readonly path: string
    readonly query: string
    readonly auth?: string
    readonly ifMatch?: string
    readonly body?: unknown
  }[]
  close(): Promise<void>
}

async function startMockKernel(): Promise<MockKernelRecorder> {
  const requests: MockKernelRecorder['requests'] = []
  let crossChannelMode: 'off' | 'shadow' | 'on' = 'shadow'
  let ampAliases = false
  let mcpEnabled = false
  let debugRunning = false
  let l3Version = 2
  let recordVersion = 3
  let installed = false
  let pluginState: 'enabled' | 'disabled' = 'enabled'
  const chatMessages: {
    messageId: string
    channel: string
    direction: 'inbound' | 'outbound'
    actor: string
    displayName: string
    text: string
    recordId: string
    tEvent: number
  }[] = [
    {
      messageId: 'msg_1',
      channel: 'console-chat:private:owner',
      direction: 'outbound',
      actor: 'self',
      displayName: '她',
      text: '今天天气不错',
      recordId: 'l0_chat_1',
      tEvent: Date.now() - 120_000,
    },
  ]
  const records = new Map<string, Record<string, unknown>>([
    ['l0_chat_1', {
      id: 'l0_chat_1',
      layer: 'L0',
      kind: 'console-chat.message',
      source: 'console-chat',
      channel: 'console-chat:private:owner',
      subjects: ['p_owner'],
      actor: 'self',
      content: { text: '今天天气不错' },
      evidence: [],
      visibility: 'owner',
      trust: 'owner',
      confidence: 1,
      importance: 0.7,
      tEvent: 1000,
      tIngest: 1001,
      status: 'active',
      version: 1,
    }],
    ['l1_fact_1', {
      id: 'l1_fact_1',
      layer: 'L1',
      kind: 'l1.fact',
      source: 'consolidation',
      channel: 'console-chat:private:owner',
      subjects: ['p_owner'],
      actor: 'p_owner',
      content: { text: '喜欢乌龙茶' },
      evidence: [{ id: 'l0_chat_1' }],
      visibility: 'owner',
      trust: 'owner',
      confidence: 0.9,
      importance: 0.8,
      tEvent: 2000,
      tIngest: 2001,
      status: 'active',
      version: 3,
    }],
  ])

  const sendJson = (res: ServerResponse, status: number, data: unknown, ok = true): void => {
    const payload = ok
      ? { ok: true, data, meta: { requestId: 'req_k_1', apiVersion: '1.0' } }
      : { ok: false, error: data, meta: { requestId: 'req_k_1' } }
    const text = JSON.stringify(payload)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) })
    res.end(text)
  }

  const readJson = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
    }
    if (chunks.length === 0) return undefined
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  }

  const server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? 'GET'
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const body = method === 'POST' || method === 'PUT' || method === 'PATCH' ? await readJson(req) : undefined
      if (body === undefined) req.resume()

      requests.push({
        method,
        path: url.pathname,
        query: url.search,
        ...(typeof req.headers.authorization === 'string' ? { auth: req.headers.authorization } : {}),
        ...(typeof req.headers['if-match'] === 'string' ? { ifMatch: req.headers['if-match'] } : {}),
        ...(body === undefined ? {} : { body }),
      })

      if (req.headers.authorization !== `Bearer ${KERNEL_TOKEN}`) {
        sendJson(res, 401, { code: 'UNAUTHENTICATED', message: 'invalid kernel token', details: {} }, false)
        return
      }

      if (method === 'GET' && url.pathname === '/api/v1/console/pages') {
        sendJson(res, 200, {
          items: [
            { pluginId: 'console-chat', id: 'chat', title: '与她对话', entry: '/api/v1/plugins/console-chat/ui' },
            { pluginId: 'demo-ext', id: 'panel', title: '扩展<script>alert(1)</script>', entry: '/api/v1/plugins/demo-ext/ui' },
          ],
        })
        return
      }
      if (method === 'GET' && url.pathname === '/api/v1/plugins/demo-ext/ui') {
        const html = '<html><body><h1>Demo Panel</h1></body></html>'
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) })
        res.end(html)
        return
      }
      if (method === 'GET' && url.pathname === '/api/v1/plugins/console-chat/messages') {
        const channel = url.searchParams.get('channel') ?? 'console-chat:private:owner'
        sendJson(res, 200, {
          channel,
          items: chatMessages.filter((m) => m.channel === channel),
          unreadCount: 0,
        })
        return
      }
      if (method === 'POST' && url.pathname === '/api/v1/plugins/console-chat/messages') {
        const b = (body ?? {}) as { channel?: string; text?: string }
        const channel = b.channel ?? 'console-chat:private:owner'
        const inboundId = `l0_in_${String(chatMessages.length + 1)}`
        const replyId = `l0_out_${String(chatMessages.length + 2)}`
        chatMessages.push({
          messageId: `msg_in_${String(chatMessages.length + 1)}`,
          channel,
          direction: 'inbound',
          actor: 'p_owner',
          displayName: '主人',
          text: String(b.text ?? ''),
          recordId: inboundId,
          tEvent: Date.now(),
        })
        chatMessages.push({
          messageId: `msg_out_${String(chatMessages.length + 2)}`,
          channel,
          direction: 'outbound',
          actor: 'self',
          displayName: '她',
          text: `收到：${String(b.text ?? '')}`,
          recordId: replyId,
          tEvent: Date.now(),
        })
        sendJson(res, 200, {
          recordId: inboundId,
          personId: 'p_owner',
          messageId: `msg_in_${String(chatMessages.length)}`,
          wake: { wakeId: 'wake_42', outcome: 'acked' },
        })
        return
      }

      if (method === 'GET' && url.pathname === '/api/v1/memory/health') {
        sendJson(res, 200, { healthy: true, probe: url.searchParams.get('probe') })
        return
      }
      if (method === 'PATCH' && url.pathname === '/api/v1/memory/records/l1_fact_1') {
        const ifMatch = Number(req.headers['if-match'])
        if (ifMatch !== recordVersion) {
          sendJson(res, 409, { code: 'CONFLICT', message: 'version mismatch', details: { expected: recordVersion } }, false)
          return
        }
        recordVersion += 1
        const existing = records.get('l1_fact_1')!
        const updated = { ...existing, ...(body as Record<string, unknown>), version: recordVersion }
        records.set('l1_fact_1', updated)
        sendJson(res, 200, updated)
        return
      }
      if (method === 'GET' && url.pathname === '/api/v1/console/memory/records') {
        const layer = url.searchParams.get('layer')
        const items = [...records.values()].filter((r) => layer === null || r.layer === layer)
        sendJson(res, 200, { items })
        return
      }
      if (method === 'GET' && url.pathname.startsWith('/api/v1/console/memory/records/')) {
        const rest = url.pathname.slice('/api/v1/console/memory/records/'.length)
        if (rest.endsWith('/dependents')) {
          const id = decodeURIComponent(rest.slice(0, -'/dependents'.length))
          const deps = id === 'l0_chat_1' ? [records.get('l1_fact_1')!] : []
          sendJson(res, 200, { items: deps })
          return
        }
        const id = decodeURIComponent(rest)
        const rec = records.get(id)
        if (rec === undefined) {
          sendJson(res, 404, { code: 'NOT_FOUND', message: 'missing', details: {} }, false)
          return
        }
        sendJson(res, 200, rec)
        return
      }
      if (method === 'POST' && url.pathname === '/api/v1/memory/forget') {
        const b = body as { id?: string }
        if (b.id && records.has(b.id)) {
          const rec = records.get(b.id)!
          records.set(b.id, { ...rec, status: 'tombstoned', content: {} })
        }
        sendJson(res, 200, { tombstoned: 1, invalidated: 1, l3Flagged: 0 })
        return
      }
      if (method === 'GET' && url.pathname === '/api/v1/console/memory/audit') {
        sendJson(res, 200, { items: [{ recordId: 'l1_fact_1', viewerChannel: 'tg:1', mode: 'shadow', tAt: 3000 }] })
        return
      }
      if (method === 'GET' && url.pathname === '/api/v1/console/memory/cross-channel') {
        sendJson(res, 200, { mode: crossChannelMode })
        return
      }
      if (method === 'PUT' && url.pathname === '/api/v1/console/memory/cross-channel') {
        crossChannelMode = (body as { mode: 'off' | 'shadow' | 'on' }).mode
        sendJson(res, 200, { mode: crossChannelMode })
        return
      }
      if (method === 'GET' && url.pathname === '/api/v1/console/memory/persons') {
        sendJson(res, 200, { items: [{ personId: 'p_owner', accounts: ['console-chat:owner'], aliases: [] }] })
        return
      }
      if (method === 'GET' && url.pathname === '/api/v1/console/memory/l3/versions') {
        sendJson(res, 200, {
          items: [
            { version: 1, tAt: 1000, status: 'superseded', current: false, author: 'settlement', stable: 'v1' },
            { version: l3Version, tAt: 2000, status: 'active', current: true, author: 'owner', ownerLockedKeys: ['tone'], stable: 'v2', data: { tone: 'warm' } },
          ],
        })
        return
      }
      if (method === 'GET' && url.pathname === '/api/v1/console/memory/l3/diff') {
        const from = Number(url.searchParams.get('from') ?? '1')
        const to = Number(url.searchParams.get('to') ?? '2')
        sendJson(res, 200, { from, to, stableChanged: true, added: ['tone'], removed: [], changed: [] })
        return
      }
      if (method === 'POST' && url.pathname === '/api/v1/console/memory/persons/p_owner/split') {
        sendJson(res, 200, { personId: 'p_split_1' })
        return
      }
      if (method === 'POST' && url.pathname === '/api/v1/console/memory/l3/rollback') {
        l3Version = (body as { version: number }).version
        sendJson(res, 200, { version: l3Version })
        return
      }
      if (method === 'PUT' && url.pathname === '/api/v1/console/memory/l3/owner') {
        l3Version += 1
        sendJson(res, 200, { version: l3Version })
        return
      }
      if (method === 'GET' && url.pathname === '/api/v1/console/memory/consolidation/proposals') {
        sendJson(res, 200, { items: [] })
        return
      }
      if (method === 'GET' && url.pathname === '/api/v1/console/memory/consolidation/budget') {
        sendJson(res, 200, { usedTokensToday: 120, dailyTokenCap: 10000, lastConsolidatedTo: 2000 })
        return
      }

      if (method === 'GET' && url.pathname === '/api/v1/console/satellite') {
        sendJson(res, 200, {
          processes: {
            chat: { agentClass: 'chat', status: 'running', pid: 4321, activeSessions: 1, selection: null, deniedApprovals: 0 },
            activity: { agentClass: 'activity', status: 'idle', activeSessions: 0, selection: null, deniedApprovals: 0 },
          },
          sessions: [],
          isolation: { ok: true, checkedAt: 5000, problems: [] },
          metrics: [],
          sharedQuotaWarning: false,
        })
        return
      }
      if (method === 'POST' && url.pathname === '/api/v1/console/satellite/chat/restart') {
        sendJson(res, 200, { ok: true })
        return
      }
      if (method === 'POST' && url.pathname === '/api/v1/console/satellite/doctor') {
        sendJson(res, 200, { ok: true, checkedAt: 6000, problems: [] })
        return
      }
      if (method === 'GET' && url.pathname === '/api/v1/console/accounting/summary') {
        const days = Number(url.searchParams.get('days') ?? '7')
        sendJson(res, 200, {
          day: '2026-11-21',
          currency: 'CNY',
          todayTokens: days === 30 ? 900 : 300,
          todayCostMicros: 15000,
          todayCacheHitRatio: 0.75,
          sharedQuotaWarning: false,
          byPlugin: [],
          dailyTrend: [],
        })
        return
      }
      if (method === 'GET' && url.pathname === '/api/v1/console/accounting/prices') {
        sendJson(res, 200, { version: 1, currency: 'CNY', models: { 'deepseek-flash': { inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.1, cacheWritePerMillion: 0.5 } } })
        return
      }
      if (method === 'PUT' && url.pathname === '/api/v1/console/accounting/prices') {
        sendJson(res, 200, body)
        return
      }
      if (method === 'PUT' && url.pathname === '/api/v1/console/accounting/budget') {
        sendJson(res, 200, body)
        return
      }
      if (method === 'GET' && url.pathname === '/api/v1/console/interop') {
        sendJson(res, 200, {
          ampAliases,
          mcp: { enabled: mcpEnabled, running: mcpEnabled, port: 4100, patchYaml: mcpEnabled ? 'plugins:\n  mcp: true' : undefined },
          debugView: { running: debugRunning, ...(debugRunning ? { pid: 9001, port: 5140, url: 'http://127.0.0.1:5140' } : {}) },
        })
        return
      }
      if (method === 'PUT' && url.pathname === '/api/v1/console/interop/amp') {
        ampAliases = Boolean((body as { enabled?: boolean }).enabled)
        sendJson(res, 200, { ampAliases, mcp: { enabled: mcpEnabled, running: mcpEnabled }, debugView: { running: debugRunning } })
        return
      }
      if (method === 'PUT' && url.pathname === '/api/v1/console/interop/mcp') {
        mcpEnabled = Boolean((body as { enabled?: boolean }).enabled)
        sendJson(res, 200, { ampAliases, mcp: { enabled: mcpEnabled, running: mcpEnabled, patchYaml: 'plugins:\n  mcp: true' }, debugView: { running: debugRunning } })
        return
      }
      if (method === 'POST' && url.pathname === '/api/v1/console/interop/debug-view/start') {
        debugRunning = true
        sendJson(res, 200, { ampAliases, mcp: { enabled: mcpEnabled, running: mcpEnabled }, debugView: { running: true, pid: 9001, port: 5140, url: 'http://127.0.0.1:5140' } })
        return
      }
      if (method === 'POST' && url.pathname === '/api/v1/console/interop/debug-view/stop') {
        debugRunning = false
        sendJson(res, 200, { ampAliases, mcp: { enabled: mcpEnabled, running: mcpEnabled }, debugView: { running: false } })
        return
      }

      if (method === 'GET' && url.pathname === '/api/v1/console/plugins') {
        const plugins = installed
          ? [{
              id: 'sample-plugin',
              version: '1.0.0',
              kinds: ['capability'],
              runtime: 'node',
              state: pluginState,
              permissions: ['memory.search'],
              granted: ['memory.search'],
              checkPassed: true,
              tools: [],
            }]
          : []
        sendJson(res, 200, { plugins, coreBudgets: [] })
        return
      }
      if (method === 'POST' && url.pathname === '/api/v1/console/plugins/install') {
        sendJson(res, 200, { id: 'sample-plugin', version: '1.0.0', permissions: ['memory.search'], newPermissions: ['memory.search'], warnings: [] })
        return
      }
      if (method === 'POST' && url.pathname === '/api/v1/console/plugins/sample-plugin/confirm') {
        installed = true
        sendJson(res, 200, { ok: true })
        return
      }
      if (method === 'POST' && url.pathname === '/api/v1/console/plugins/sample-plugin/enable') {
        pluginState = 'enabled'
        sendJson(res, 200, { ok: true })
        return
      }
      if (method === 'POST' && url.pathname === '/api/v1/console/plugins/sample-plugin/disable') {
        pluginState = 'disabled'
        sendJson(res, 200, { ok: true })
        return
      }
      if (method === 'POST' && url.pathname === '/api/v1/console/plugins/sample-plugin/uninstall') {
        installed = false
        sendJson(res, 200, { ok: true })
        return
      }
      if (method === 'POST' && url.pathname === '/api/v1/console/plugins/check') {
        sendJson(res, 200, { ok: true, manifest: { ok: true, manifest: { id: 'sample-plugin', kinds: ['capability'], api: '^1.0.0', runtime: 'node', permissions: [] } }, contract: [], findings: [], notes: [] })
        return
      }

      sendJson(res, 404, { code: 'NOT_FOUND', message: `mock kernel unknown: ${method} ${url.pathname}`, details: {} }, false)
    })()
  })

  await new Promise<void>((resolve) => { server.listen({ host: '127.0.0.1', port: 0 }, () => resolve()) })
  const addr = server.address() as { port: number }
  return {
    baseUrl: `http://127.0.0.1:${String(addr.port)}`,
    requests,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    },
  }
}

test('FR-C01: unauthenticated UI routes, proxy routes, and /assets/console-client.js security checks', async () => {
  const home = await makeBrainHome()
  const kernel = await startMockKernel()
  const consoleServer = await startConsole(home, {
    kernelApi: { baseUrl: kernel.baseUrl, token: KERNEL_TOKEN },
  })
  try {
    // 1. Protected UI & proxied routes return 401 UNAUTHENTICATED without token
    for (const [method, route, body] of [
      ['GET', '/api/v1/console/ui/state?page=settings', undefined],
      ['POST', '/api/v1/console/ui/action', { page: 'settings', action: 'save-model' }],
      ['GET', '/api/v1/memory/health', undefined],
    ] as const) {
      const res = await consoleServer.request(method, route, { token: null, ...(body ? { body } : {}) })
      assert.equal(res.status, 401, `${method} ${route}`)
      validate('Envelope', res.body)
      assert.equal((res.body.error as { code?: string }).code, 'UNAUTHENTICATED')
    }
    assert.equal(kernel.requests.length, 0, 'unauthenticated proxy requests must never reach kernel')

    // 2. GET / includes module script link and leaks zero business data
    const html = await consoleServer.html('/')
    assert.match(html, /<script type="module"[^>]+src="\/synapse\/assets\/[^"]+\.js"><\/script>/)
    assert.ok(!html.includes('settings-panel'))
    assert.ok(!html.includes('data-agent-class'))
    assert.ok(!html.includes('与她对话'))

    const authedHtml = await consoleServer.html('/', TOKEN)
    assert.match(authedHtml, /<script type="module"[^>]+src="\/synapse\/assets\/[^"]+\.js"><\/script>/)
    assert.ok(!authedHtml.includes('settings-panel'))

    // 3. GET /assets/console-client.js returns valid syntax JS with zero token persistence
    const jsRes = await fetch(`http://127.0.0.1:${String(consoleServer.port)}/assets/console-client.js`)
    assert.equal(jsRes.status, 200)
    assert.match(jsRes.headers.get('content-type') ?? '', /^application\/javascript/)
    assert.equal(jsRes.headers.get('cache-control'), 'no-store')
    const scriptText = await jsRes.text()
    new vm.Script(scriptText)
    assert.ok(!/localStorage\.setItem\([^)]*token/i.test(scriptText))
    assert.ok(!/sessionStorage/i.test(scriptText))
    assert.ok(!/document\.cookie/i.test(scriptText))
    assert.ok(scriptText.includes('let authToken'))
  } finally {
    await consoleServer.close()
    await kernel.close()
    await home.close()
  }
})

test('PUT /api/v1/console/settings/role-card supports mode: select with validation and runner invalidation', async () => {
  const home = await makeBrainHome()
  const consoleServer = await startConsole(home)
  try {
    await mkdir(path.join(home.state, 'roles'), { recursive: true })
    await writeFile(path.join(home.state, 'roles', '阿澜.md'), '# 阿澜\n\n安静的人\n', 'utf8')

    // Missing card -> 404 NOT_FOUND
    const missing = await consoleServer.request('PUT', '/api/v1/console/settings/role-card', {
      body: { mode: 'select', name: '不存在' },
    })
    assert.equal(missing.status, 404)
    assert.equal((missing.body.error as { code?: string }).code, 'NOT_FOUND')

    // Invalid name -> 400 INVALID_ARGUMENT
    const invalid = await consoleServer.request('PUT', '/api/v1/console/settings/role-card', {
      body: { mode: 'select', name: '../escape' },
    })
    assert.equal(invalid.status, 400)
    assert.equal((invalid.body.error as { code?: string }).code, 'INVALID_ARGUMENT')

    // Existing card -> 200 { name }, writes active.json, invalidates both classes
    const ok = await consoleServer.request('PUT', '/api/v1/console/settings/role-card', {
      body: { mode: 'select', name: '阿澜' },
    })
    assert.equal(ok.status, 200)
    assert.deepEqual(ok.body.data, { name: '阿澜' })
    assert.deepEqual(consoleServer.invalidated, ['chat', 'activity'])
    const active = JSON.parse(await readFile(path.join(home.state, 'persona', 'active.json'), 'utf8')) as { version: number; name: string }
    assert.deepEqual(active, { version: 1, name: '阿澜' })
    if (process.platform !== 'win32') {
      assert.equal(await modeOf(path.join(home.state, 'persona', 'active.json')), 0o600)
    }
  } finally {
    await consoleServer.close()
    await home.close()
  }
})

test('isomorphic UI router switches across all 4 core pages + dynamic plugin pages and handles actions', async () => {
  const home = await makeBrainHome()
  const kernel = await startMockKernel()
  const consoleServer = await startConsole(home, {
    kernelApi: { baseUrl: kernel.baseUrl, token: KERNEL_TOKEN },
  })
  try {
    await mkdir(path.join(home.state, 'roles'), { recursive: true })
    await writeFile(path.join(home.state, 'roles', '小满.md'), '# 小满\n', 'utf8')

    // 1. Settings page + dynamic navItems + actions
    const settingsState = await consoleServer.request('GET', '/api/v1/console/ui/state?page=settings')
    assert.equal(settingsState.status, 200)
    const sData = settingsState.body.data as {
      activePageId: string
      navItems: readonly { id: string; title: string; group?: string }[]
      mainHtml: string
    }
    assert.equal(sData.activePageId, 'settings')
    assert.ok(sData.navItems.some((n) => n.id === 'plugin:console-chat:chat' && n.title === '与她对话' && n.group === 'plugin'))
    assert.ok(sData.mainHtml.includes('data-action="save-model"'))
    assert.ok(sData.mainHtml.includes('data-action="select-role-card"'))
    assert.ok(sData.mainHtml.includes('data-action="add-trait-row"'))

    const selectCardAction = await consoleServer.request('POST', '/api/v1/console/ui/action', {
      body: { page: 'settings', action: 'select-role-card', payload: { name: '小满' } },
    })
    assert.equal(selectCardAction.status, 200)
    assert.equal((selectCardAction.body.data as { roleCardName: string }).roleCardName, '小满')

    // 2. Memory page: filter, select, mark-outdated, two-step forget, L3 subview
    const memState = await consoleServer.request('GET', '/api/v1/console/ui/state?page=memory')
    assert.equal(memState.status, 200)
    const mHtml = (memState.body.data as { mainHtml: string }).mainHtml
    assert.ok(mHtml.includes('l1_fact_1'))
    assert.ok(mHtml.includes('data-action="apply-memory-filter"'))

    const selectRec = await consoleServer.request('POST', '/api/v1/console/ui/action', {
      body: { page: 'memory', action: 'select-record', payload: { recordId: 'l1_fact_1' } },
    })
    assert.ok((selectRec.body.data as { mainHtml: string }).mainHtml.includes('data-action="mark-outdated"'))
    assert.ok((selectRec.body.data as { mainHtml: string }).mainHtml.includes('data-action="request-forget"'))

    const markOutdated = await consoleServer.request('POST', '/api/v1/console/ui/action', {
      body: { page: 'memory', action: 'mark-outdated', payload: { recordId: 'l1_fact_1', version: 3 } },
    })
    assert.equal((markOutdated.body.data as { toast?: { tone: string } }).toast?.tone, 'ok')

    const reqForget = await consoleServer.request('POST', '/api/v1/console/ui/action', {
      body: { page: 'memory', action: 'request-forget', payload: { recordId: 'l0_chat_1' } },
    })
    assert.ok((reqForget.body.data as { mainHtml: string }).mainHtml.includes('确认遗忘'))

    const confForget = await consoleServer.request('POST', '/api/v1/console/ui/action', {
      body: { page: 'memory', action: 'confirm-forget', payload: {} },
    })
    assert.ok((confForget.body.data as { mainHtml: string }).mainHtml.includes('tombstoned=1'))

    await consoleServer.request('POST', '/api/v1/console/ui/action', {
      body: { page: 'memory', action: 'switch-memory-subview', payload: { subView: 'consolidation' } },
    })
    const compareL3 = await consoleServer.request('POST', '/api/v1/console/ui/action', {
      body: { page: 'memory', action: 'compare-l3', payload: { version: 1 } },
    })
    assert.ok((compareL3.body.data as { mainHtml: string }).mainHtml.includes('v1 → v2'))

    // 3. Satellite + Accounting + Interop subviews
    const satState = await consoleServer.request('GET', '/api/v1/console/ui/state?page=satellite')
    assert.ok((satState.body.data as { mainHtml: string }).mainHtml.includes('4321'))

    const accSub = await consoleServer.request('POST', '/api/v1/console/ui/action', {
      body: { page: 'satellite', action: 'switch-satellite-subview', payload: { subView: 'accounting' } },
    })
    assert.ok((accSub.body.data as { mainHtml: string }).mainHtml.includes('今日总花费'))

    const days30 = await consoleServer.request('POST', '/api/v1/console/ui/action', {
      body: { page: 'satellite', action: 'set-accounting-days', payload: { days: 30 } },
    })
    assert.ok((days30.body.data as { mainHtml: string }).mainHtml.includes('900'))

    const interopSub = await consoleServer.request('POST', '/api/v1/console/ui/action', {
      body: { page: 'satellite', action: 'switch-satellite-subview', payload: { subView: 'interop' } },
    })
    assert.ok((interopSub.body.data as { mainHtml: string }).mainHtml.includes('AMP 6 动词别名'))

    const toggleMcp = await consoleServer.request('POST', '/api/v1/console/ui/action', {
      body: { page: 'satellite', action: 'toggle-mcp', payload: { enabled: true } },
    })
    assert.ok((toggleMcp.body.data as { mainHtml: string }).mainHtml.includes('plugins:\n  mcp: true'))

    // 4. Plugins page: install preview -> confirm -> disable -> enable
    const plugState = await consoleServer.request('GET', '/api/v1/console/ui/state?page=plugins')
    assert.ok((plugState.body.data as { mainHtml: string }).mainHtml.includes('data-form="plugin-install"'))

    const previewInstall = await consoleServer.request('POST', '/api/v1/console/ui/action', {
      body: { page: 'plugins', action: 'start-install', payload: { spec: './plugins/sample' } },
    })
    assert.ok((previewInstall.body.data as { mainHtml: string }).mainHtml.includes('安装权限确认'))

    const confirmInstall = await consoleServer.request('POST', '/api/v1/console/ui/action', {
      body: { page: 'plugins', action: 'confirm-install', payload: {} },
    })
    assert.ok((confirmInstall.body.data as { mainHtml: string }).mainHtml.includes('sample-plugin'))

    // 5. Dynamic plugin pages: console-chat + generic sandbox iframe + jump-to-memory-record
    const chatState = await consoleServer.request('GET', '/api/v1/console/ui/state?page=plugin%3Aconsole-chat%3Achat')
    assert.ok((chatState.body.data as { mainHtml: string }).mainHtml.includes('今天天气不错'))
    assert.ok((chatState.body.data as { mainHtml: string }).mainHtml.includes('data-form="plugin-chat-send"'))

    const chatSend = await consoleServer.request('POST', '/api/v1/console/ui/action', {
      body: { page: 'plugin:console-chat:chat', action: 'chat-send', payload: { text: '你好小满' } },
    })
    const chatHtml = (chatSend.body.data as { mainHtml: string }).mainHtml
    assert.ok(chatHtml.includes('你好小满'))
    assert.ok(chatHtml.includes('收到：你好小满'))
    assert.ok(chatHtml.includes('wake_42'))

    const jumpRes = await consoleServer.request('POST', '/api/v1/console/ui/action', {
      body: { page: 'plugin:console-chat:chat', action: 'jump-to-memory-record', payload: { recordId: 'l0_chat_1' } },
    })
    const jumpData = jumpRes.body.data as { activePageId: string; mainHtml: string }
    assert.equal(jumpData.activePageId, 'memory')
    assert.ok(jumpData.mainHtml.includes('l0_chat_1'))

    const genericPlugin = await consoleServer.request('GET', '/api/v1/console/ui/state?page=plugin%3Ademo-ext%3Apanel')
    const genericHtml = (genericPlugin.body.data as { mainHtml: string }).mainHtml
    assert.ok(genericHtml.includes('<iframe class="plugin-iframe" sandbox="" srcdoc="'))
    assert.ok(!genericHtml.includes('<script>alert(1)</script>'))
    assert.ok(genericHtml.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))

    // 6. Same-origin kernel proxy preserves query string, If-Match header, and upstream error status
    const healthProxy = await consoleServer.request('GET', '/api/v1/memory/health?probe=1')
    assert.equal(healthProxy.status, 200)
    assert.deepEqual(healthProxy.body.data, { healthy: true, probe: '1' })
    const proxiedHealthReq = kernel.requests.find((r) => r.path === '/api/v1/memory/health')
    assert.equal(proxiedHealthReq?.auth, `Bearer ${KERNEL_TOKEN}`)
    assert.equal(proxiedHealthReq?.query, '?probe=1')

    const conflictPatch = await consoleServer.request('PATCH', '/api/v1/memory/records/l1_fact_1', {
      headers: { 'If-Match': '1' },
      body: { status: 'outdated' },
    })
    assert.equal(conflictPatch.status, 409)
    assert.equal((conflictPatch.body.error as { code?: string }).code, 'CONFLICT')

    const okPatch = await consoleServer.request('PATCH', '/api/v1/memory/records/l1_fact_1', {
      headers: { 'If-Match': '4' },
      body: { status: 'active' },
    })
    assert.equal(okPatch.status, 200)
  } finally {
    await consoleServer.close()
    await kernel.close()
    await home.close()
  }
})

test('UI router degrades gracefully when kernelApi is not configured', async () => {
  const home = await makeBrainHome()
  const consoleServer = await startConsole(home)
  try {
    const res = await consoleServer.request('GET', '/api/v1/console/ui/state?page=memory')
    assert.equal(res.status, 200)
    assert.ok((res.body.data as { mainHtml: string }).mainHtml.includes('kernelApi'))
  } finally {
    await consoleServer.close()
    await home.close()
  }
})

function sendRawHttp(
  port: number,
  method: string,
  rawPath: string,
  token: string,
): Promise<{ readonly status: number; readonly json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path: rawPath,
        headers: { Authorization: `Bearer ${token}` },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({
            status: res.statusCode ?? 0,
            json: JSON.parse(text) as Record<string, unknown>,
          })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

test('client script fixes: article[data-plugin-id] upgrade lookup and replaceState/pendingPageId nav dedup', async () => {
  const home = await makeBrainHome()
  const consoleServer = await startConsole(home)
  try {
    const jsRes = await fetch(`http://127.0.0.1:${String(consoleServer.port)}/assets/console-client.js`)
    assert.equal(jsRes.status, 200)
    const scriptText = await jsRes.text()

    assert.match(scriptText, /actionBtn\.closest\(['"]article\[data-plugin-id\]['"]\)/)
    assert.match(scriptText, /window\.history\.replaceState\(null,\s*'',\s*['"]#['"]\s*\+\s*navId\)/)

    // Execute client script with lightweight DOM/window/fetch stubs to verify runtime behavior.
    const windowListeners = new Map<string, ((event: unknown) => void)[]>()
    const documentListeners = new Map<string, ((event: unknown) => void)[]>()
    const fetchCalls: { readonly url: string; readonly method: string; readonly body?: unknown }[] = []
    const replaceStateCalls: string[] = []
    let promptCalled = false
    let pendingStateResolve: ((value: unknown) => void) | null = null

    class StubElement {
      readonly tagName: string
      readonly dataset: Record<string, string>
      readonly classList = { add: () => {}, remove: () => {} }
      readonly children: StubElement[] = []
      parentNode: StubElement | null = null
      textContent = ''
      innerHTML = ''
      value = ''
      disabled = false
      constructor(tagName: string, dataset: Record<string, string> = {}) {
        this.tagName = tagName.toUpperCase()
        this.dataset = dataset
      }
      setAttribute() {}
      appendChild(child: StubElement) {
        child.parentNode = this
        this.children.push(child)
        return child
      }
      insertBefore(child: StubElement) { return this.appendChild(child) }
      removeChild(child: StubElement) {
        const idx = this.children.indexOf(child)
        if (idx >= 0) this.children.splice(idx, 1)
      }
      remove() {}
      querySelector(selector: string): StubElement | null {
        if (selector === '[data-upgrade-spec-for]') {
          return this.find((el) => 'upgradeSpecFor' in el.dataset)
        }
        return null
      }
      querySelectorAll() { return [] }
      find(pred: (el: StubElement) => boolean): StubElement | null {
        for (const child of this.children) {
          if (pred(child)) return child
          const nested = child.find(pred)
          if (nested) return nested
        }
        return null
      }
      closest(selector: string): StubElement | null {
        const matches =
          (selector === '[data-plugin-id]' && 'pluginId' in this.dataset)
          || (selector === 'article[data-plugin-id]' && this.tagName === 'ARTICLE' && 'pluginId' in this.dataset)
          || (selector === '[data-action]' && 'action' in this.dataset)
          || (selector === 'a[data-nav-id]' && this.tagName === 'A' && 'navId' in this.dataset)
        if (matches) return this
        return this.parentNode === null ? null : this.parentNode.closest(selector)
      }
    }

    const articleCard = new StubElement('article', { pluginId: 'sample-plugin' })
    const specInput = new StubElement('input', { upgradeSpecFor: 'sample-plugin' })
    specInput.value = './plugins/sample-v2'
    const upgradeBtn = new StubElement('button', { action: 'upgrade', pluginId: 'sample-plugin' })
    articleCard.appendChild(specInput)
    articleCard.appendChild(upgradeBtn)
    const navMemoryLink = new StubElement('a', { navId: 'memory' })

    const mainArea = new StubElement('div')
    const contentEl = new StubElement('div')
    const stubDoc = {
      documentElement: { dataset: {} },
      body: contentEl,
      contains: () => true,
      getElementById: () => null,
      createElement: (tag: string) => new StubElement(tag),
      querySelector: (selector: string) => {
        if (selector === '.main-area') return mainArea
        if (selector === '.content') return contentEl
        return null
      },
      querySelectorAll: () => [],
      addEventListener: (type: string, fn: (event: unknown) => void) => {
        const list = documentListeners.get(type) ?? []
        list.push(fn)
        documentListeners.set(type, list)
      },
    }

    const stubWindow: Record<string, unknown> = {
      location: { hash: '#settings' },
      history: {
        replaceState: (_state: unknown, _title: string, url: string) => {
          replaceStateCalls.push(url)
          ;(stubWindow.location as { hash: string }).hash = url
        },
      },
      localStorage: { getItem: () => null, setItem: () => {} },
      prompt: () => {
        promptCalled = true
        return ''
      },
      addEventListener: (type: string, fn: (event: unknown) => void) => {
        const list = windowListeners.get(type) ?? []
        list.push(fn)
        windowListeners.set(type, list)
      },
    }

    const stubFetch = async (url: string, init: { method?: string; body?: string } = {}) => {
      const parsedBody = init.body ? JSON.parse(init.body) as unknown : undefined
      fetchCalls.push({ url, method: init.method ?? 'GET', ...(parsedBody === undefined ? {} : { body: parsedBody }) })
      if (url === '/api/v1/console/session') {
        return { status: 200, ok: true, text: async () => JSON.stringify({ ok: true, data: { authenticated: true } }) }
      }
      if (url === '/api/v1/console/ui/state?page=memory' && pendingStateResolve === null) {
        const payload = await new Promise<unknown>((resolve) => { pendingStateResolve = resolve })
        return { status: 200, ok: true, text: async () => JSON.stringify(payload) }
      }
      const page = url.includes('page=satellite') ? 'satellite' : 'settings'
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify({
          ok: true,
          data: { activePageId: page, navItems: [], roleCardName: null, sharedQuotaWarning: false, mainHtml: '' },
        }),
      }
    }

    const context = {
      window: stubWindow,
      document: stubDoc,
      Element: StubElement,
      HTMLFormElement: class {},
      fetch: stubFetch,
      navigator: {},
      setTimeout,
      clearTimeout,
      encodeURIComponent,
      JSON,
      Set,
      Number,
      Boolean,
      String,
      Array,
    }
    vm.runInNewContext(scriptText, context)

    // Login first so authToken is set in closure.
    for (const fn of windowListeners.get('brain-console-token') ?? []) {
      await fn({ detail: TOKEN })
    }
    fetchCalls.length = 0
    replaceStateCalls.length = 0

    // 1. Click sidebar link twice while first request is still pending -> only 1 ui/state fetch + replaceState used.
    const clickHandlers = documentListeners.get('click') ?? []
    for (const fn of clickHandlers) {
      fn({ target: navMemoryLink, preventDefault: () => {} })
      fn({ target: navMemoryLink, preventDefault: () => {} })
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(replaceStateCalls, ['#memory', '#memory'])
    assert.equal(fetchCalls.filter((c) => c.url === '/api/v1/console/ui/state?page=memory').length, 1)

    ;(pendingStateResolve as ((value: unknown) => void) | null)?.({
      ok: true,
      data: { activePageId: 'memory', navItems: [], roleCardName: null, sharedQuotaWarning: false, mainHtml: '' },
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    // 2. Real browser hashchange (back/forward) still navigates once.
    ;(stubWindow.location as { hash: string }).hash = '#satellite'
    for (const fn of windowListeners.get('hashchange') ?? []) {
      fn({})
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(fetchCalls.filter((c) => c.url === '/api/v1/console/ui/state?page=satellite').length, 1)

    // 3. Upgrade button reads input inside article[data-plugin-id] rather than button itself.
    fetchCalls.length = 0
    for (const fn of clickHandlers) {
      fn({ target: upgradeBtn, preventDefault: () => {} })
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(promptCalled, false)
    assert.equal(fetchCalls.length, 1)
    assert.deepEqual(fetchCalls[0], {
      url: '/api/v1/console/ui/action',
      method: 'POST',
      body: {
        page: 'satellite',
        action: 'start-upgrade',
        payload: { id: 'sample-plugin', spec: './plugins/sample-v2' },
      },
    })
  } finally {
    await consoleServer.close()
    await home.close()
  }
})

test('M30: proxyKernel rejects non-/api/v1/ and traversal paths with 404 without forwarding', async () => {
  const home = await makeBrainHome()
  const kernel = await startMockKernel()
  const consoleServer = await startConsole(home, {
    kernelApi: { baseUrl: kernel.baseUrl, token: KERNEL_TOKEN },
  })
  try {
    for (const rawPath of [
      '/health',
      '/api/v1/../health',
      '/api/v1/memory/../health',
      '/api/v1/%2e%2e/health',
      '//evil.com/api/v1/memory/health',
    ]) {
      const res = await sendRawHttp(consoleServer.port, 'GET', rawPath, TOKEN)
      assert.equal(res.status, 404, `expected 404 for ${rawPath}`)
      assert.equal((res.json.error as { code?: string }).code, 'NOT_FOUND')
    }
    assert.equal(kernel.requests.length, 0, 'rejected proxy paths must never reach kernelApi')
  } finally {
    await consoleServer.close()
    await kernel.close()
    await home.close()
  }
})

test('M35: generic plugin entry rejects unsafe paths without upstream fetch and normalizes safe relative entry', async () => {
  const home = await makeBrainHome()
  const kernelRequests: { readonly path: string; readonly auth?: string }[] = []
  const kernelServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    kernelRequests.push({
      path: url.pathname,
      ...(typeof req.headers.authorization === 'string' ? { auth: req.headers.authorization } : {}),
    })
    req.resume()
    if (url.pathname === '/api/v1/console/pages') {
      const body = JSON.stringify({
        ok: true,
        data: {
          items: [
            { pluginId: 'rel-ext', id: 'main', title: 'Relative Ext', entry: 'ui/index.html' },
            { pluginId: 'bad-proto', id: 'p1', title: 'Bad Proto', entry: 'http://127.0.0.1/x' },
            { pluginId: 'bad-js', id: 'p2', title: 'Bad JS', entry: 'javascript:alert(1)' },
            { pluginId: 'bad-slash', id: 'p3', title: 'Bad Slash', entry: '//evil.com/x' },
            { pluginId: 'bad-api', id: 'p4', title: 'Bad Api', entry: '/api/v1/memory/health' },
            { pluginId: 'bad-rel', id: 'p5', title: 'Bad Rel', entry: '../secret' },
            { pluginId: 'bad-trav', id: 'p6', title: 'Bad Trav', entry: '/api/v1/plugins/bad-trav/../secret' },
            { pluginId: 'bad-etc', id: 'p7', title: 'Bad Etc', entry: '/etc/passwd' },
          ],
        },
        meta: { requestId: 'req_m35', apiVersion: '1.0' },
      })
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
      res.end(body)
      return
    }
    if (url.pathname === '/api/v1/plugins/rel-ext/ui/index.html') {
      const html = '<html><body><p>Relative Panel</p></body></html>'
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) })
      res.end(html)
      return
    }
    res.writeHead(404).end('unexpected upstream path')
  })
  await new Promise<void>((resolve) => { kernelServer.listen({ host: '127.0.0.1', port: 0 }, () => resolve()) })
  const addr = kernelServer.address() as { port: number }
  const consoleServer = await startConsole(home, {
    kernelApi: { baseUrl: `http://127.0.0.1:${String(addr.port)}`, token: KERNEL_TOKEN },
  })
  try {
    for (const badPage of [
      'plugin:bad-proto:p1',
      'plugin:bad-js:p2',
      'plugin:bad-slash:p3',
      'plugin:bad-api:p4',
      'plugin:bad-rel:p5',
      'plugin:bad-trav:p6',
      'plugin:bad-etc:p7',
    ]) {
      const res = await consoleServer.request('GET', `/api/v1/console/ui/state?page=${encodeURIComponent(badPage)}`)
      assert.equal(res.status, 200)
      const html = (res.body.data as { mainHtml: string }).mainHtml
      assert.ok(html.includes('data-tone="warning"'), `${badPage} should render warning banner`)
      assert.equal(html.includes('<iframe'), false, `${badPage} must not render iframe`)
    }
    assert.ok(
      kernelRequests.every((r) => r.path === '/api/v1/console/pages'),
      `illegal plugin entry triggered upstream request: ${JSON.stringify(kernelRequests)}`,
    )

    const relRes = await consoleServer.request('GET', '/api/v1/console/ui/state?page=plugin%3Arel-ext%3Amain')
    assert.equal(relRes.status, 200)
    const relHtml = (relRes.body.data as { mainHtml: string }).mainHtml
    assert.ok(relHtml.includes('<iframe class="plugin-iframe" sandbox="" srcdoc="'))
    assert.ok(relHtml.includes('Relative Panel'))
    assert.ok(kernelRequests.some((r) => r.path === '/api/v1/plugins/rel-ext/ui/index.html' && r.auth === `Bearer ${KERNEL_TOKEN}`))
  } finally {
    await consoleServer.close()
    await new Promise<void>((resolve) => {
      kernelServer.close(() => resolve())
      kernelServer.closeAllConnections()
    })
    await home.close()
  }
})

test('M38-M48: action validation, role card preservation, memory filter/split/compare, mcp toggle, uninstall keepData', async () => {
  const home = await makeBrainHome()
  const kernel = await startMockKernel()
  const consoleServer = await startConsole(home, {
    kernelApi: { baseUrl: kernel.baseUrl, token: KERNEL_TOKEN },
  })
  try {
    // M38 & M39: empty / whitespace / unknown action returns 400 INVALID_ARGUMENT
    for (const badAction of ['', '   ']) {
      const res = await consoleServer.request('POST', '/api/v1/console/ui/action', {
        body: { page: 'settings', action: badAction, payload: {} },
      })
      assert.equal(res.status, 400, `action=${JSON.stringify(badAction)}`)
      const err = res.body.error as { code?: string; message?: string }
      assert.equal(err.code, 'INVALID_ARGUMENT')
      assert.equal(err.message, 'action is required')
    }
    const unknownRes = await consoleServer.request('POST', '/api/v1/console/ui/action', {
      body: { page: 'settings', action: 'does-not-exist', payload: {} },
    })
    assert.equal(unknownRes.status, 400)
    const unknownErr = unknownRes.body.error as { code?: string; message?: string }
    assert.equal(unknownErr.code, 'INVALID_ARGUMENT')
    assert.match(unknownErr.message ?? '', /unknown action/)

    // M40: select-role-card switches active card without modifying roles/<name>.md on disk
    const originalCardText = '# 阿澜\n\n安静且敏锐的观察者。\n'
    await mkdir(path.join(home.state, 'roles'), { recursive: true })
    await writeFile(path.join(home.state, 'roles', '阿澜.md'), originalCardText, 'utf8')
    const selectRes = await consoleServer.request('POST', '/api/v1/console/ui/action', {
      body: { page: 'settings', action: 'select-role-card', payload: { name: '阿澜' } },
    })
    assert.equal(selectRes.status, 200)
    assert.equal((selectRes.body.data as { roleCardName: string }).roleCardName, '阿澜')
    assert.equal(await readFile(path.join(home.state, 'roles', '阿澜.md'), 'utf8'), originalCardText)

    // M41: filter-memory sends layer=L1 and renders only L1 records
    kernel.requests.length = 0
    const filterRes = await consoleServer.request('POST', '/api/v1/console/ui/action', {
      body: { page: 'memory', action: 'filter-memory', payload: { layer: 'L1' } },
    })
    assert.equal(filterRes.status, 200)
    const browseReq = kernel.requests.find((r) => r.method === 'GET' && r.path === '/api/v1/console/memory/records')
    assert.equal(browseReq?.query, '?layer=L1')
    const filterHtml = (filterRes.body.data as { mainHtml: string }).mainHtml
    assert.ok(filterHtml.includes('l1_fact_1'))
    assert.equal(filterHtml.includes('l0_chat_1'), false)

    // M44: set-cross-channel rejects invalid mode without calling kernel PUT
    kernel.requests.length = 0
    const badCross = await consoleServer.request('POST', '/api/v1/console/ui/action', {
      body: { page: 'memory', action: 'set-cross-channel', payload: { mode: 'invalid' } },
    })
    assert.equal(badCross.status, 200)
    assert.equal((badCross.body.data as { toast?: { tone: string } }).toast?.tone, 'warning')
    assert.equal(
      kernel.requests.some((r) => r.method === 'PUT' && r.path === '/api/v1/console/memory/cross-channel'),
      false,
    )

    // M45: split-person splits comma-separated accounts string into trimmed array
    kernel.requests.length = 0
    const splitRes = await consoleServer.request('POST', '/api/v1/console/ui/action', {
      body: { page: 'memory', action: 'split-person', payload: { personId: 'p_owner', accounts: 'qq:2, qq:3' } },
    })
    assert.equal(splitRes.status, 200)
    const splitReq = kernel.requests.find((r) => r.method === 'POST' && r.path === '/api/v1/console/memory/persons/p_owner/split')
    assert.deepEqual(splitReq?.body, { accounts: ['qq:2', 'qq:3'] })

    // M46: compare-l3 sends ordered from < to query parameters
    kernel.requests.length = 0
    await consoleServer.request('POST', '/api/v1/console/ui/action', {
      body: { page: 'memory', action: 'switch-memory-subview', payload: { subView: 'consolidation' } },
    })
    const cmpRes = await consoleServer.request('POST', '/api/v1/console/ui/action', {
      body: { page: 'memory', action: 'compare-l3', payload: { version: 1 } },
    })
    assert.equal(cmpRes.status, 200)
    const diffReq = kernel.requests.find((r) => r.method === 'GET' && r.path === '/api/v1/console/memory/l3/diff')
    assert.equal(diffReq?.query, '?from=1&to=2')
    assert.ok((cmpRes.body.data as { mainHtml: string }).mainHtml.includes('v1 → v2'))

    // M47: toggle-mcp sends exact { enabled: true } then { enabled: false }
    kernel.requests.length = 0
    await consoleServer.request('POST', '/api/v1/console/ui/action', {
      body: { page: 'satellite', action: 'toggle-mcp', payload: { enabled: true } },
    })
    await consoleServer.request('POST', '/api/v1/console/ui/action', {
      body: { page: 'satellite', action: 'toggle-mcp', payload: { enabled: false } },
    })
    const mcpReqs = kernel.requests.filter((r) => r.method === 'PUT' && r.path === '/api/v1/console/interop/mcp')
    assert.equal(mcpReqs.length, 2)
    assert.deepEqual(mcpReqs[0]?.body, { enabled: true })
    assert.deepEqual(mcpReqs[1]?.body, { enabled: false })

    // M48: uninstall-plugin passes exact keepData: true and keepData: false
    await consoleServer.request('POST', '/api/v1/console/ui/action', {
      body: { page: 'plugins', action: 'start-install', payload: { spec: './plugins/sample' } },
    })
    await consoleServer.request('POST', '/api/v1/console/ui/action', {
      body: { page: 'plugins', action: 'confirm-install', payload: {} },
    })
    kernel.requests.length = 0
    await consoleServer.request('POST', '/api/v1/console/ui/action', {
      body: { page: 'plugins', action: 'uninstall-plugin', payload: { id: 'sample-plugin', keepData: true } },
    })
    await consoleServer.request('POST', '/api/v1/console/ui/action', {
      body: { page: 'plugins', action: 'uninstall-plugin', payload: { id: 'sample-plugin', keepData: false } },
    })
    const uninstallReqs = kernel.requests.filter(
      (r) => r.method === 'POST' && r.path === '/api/v1/console/plugins/sample-plugin/uninstall',
    )
    assert.equal(uninstallReqs.length, 2)
    assert.deepEqual(uninstallReqs[0]?.body, { keepData: true })
    assert.deepEqual(uninstallReqs[1]?.body, { keepData: false })
  } finally {
    await consoleServer.close()
    await kernel.close()
    await home.close()
  }
})
