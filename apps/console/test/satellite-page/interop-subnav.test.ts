import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import {
  createHttpSatellitePageApi,
  createSatellitePageController,
  renderSatellitePage,
  type InteropSnapshot,
  type SatellitePageApi,
  type SatelliteSnapshot,
} from '../../src/pages/satellite/index.ts'

function baseSnapshot(): SatelliteSnapshot {
  return {
    processes: {
      chat: { agentClass: 'chat', status: 'stopped', activeSessions: 0, selection: null, deniedApprovals: 0 },
      activity: { agentClass: 'activity', status: 'stopped', activeSessions: 0, selection: null, deniedApprovals: 0 },
    },
    sessions: [],
    isolation: { ok: true, checkedAt: 1700000000000, problems: [] },
    metrics: [],
    sharedQuotaWarning: false,
  }
}

function baseInterop(overrides: Partial<InteropSnapshot> = {}): InteropSnapshot {
  return {
    ampAliases: false,
    mcp: { enabled: false, running: false },
    debugView: { running: false },
    ...overrides,
  }
}

test('segmented subnav switches between runtime, accounting, and interop without NaN or undefined', async () => {
  let state = baseInterop({
    ampAliases: true,
    mcp: {
      enabled: true,
      running: true,
      url: 'http://127.0.0.1:43111/mcp',
      port: 43111,
      patchYaml: '- insert:\n  - id: brain-memory-readonly',
    },
    debugView: {
      running: true,
      pid: 8899,
      url: 'http://127.0.0.1:43222/?token=abc',
      port: 43222,
    },
  })

  const api: SatellitePageApi = {
    async getSnapshot() { return baseSnapshot() },
    async restart() {},
    async runIsolationDoctor() { return { ok: true, checkedAt: 0, problems: [] } },
    async getInterop() { return state },
    async setAmpAliases(enabled) {
      state = { ...state, ampAliases: enabled }
      return state
    },
    async setReadOnlyMcp(enabled) {
      state = { ...state, mcp: { ...state.mcp, enabled, running: enabled } }
      return state
    },
    async startDebugView() {
      state = { ...state, debugView: { running: true, pid: 9900, url: 'http://127.0.0.1:43333/', port: 43333 } }
      return state
    },
    async stopDebugView() {
      state = { ...state, debugView: { running: false } }
      return state
    },
  }

  const controller = createSatellitePageController(api)
  assert.equal(controller.state().activeSubView, 'runtime')
  assert.equal(controller.state().interop, null)

  await controller.refreshInterop()
  assert.deepEqual(controller.state().interop, state)

  // Accounting subview renders injected HTML or clean empty card
  controller.setSubView('accounting')
  let html = renderSatellitePage(controller.state())
  assert.match(html, /data-subview="accounting" aria-selected="true"/)
  assert.match(html, /data-section="accounting-empty"/)
  assert.equal(html.includes('NaN'), false)
  assert.equal(html.includes('undefined'), false)

  html = renderSatellitePage(controller.state(), {
    accountingHtml: '<section class="glass-card" data-section="accounting-live">今日花费 ¥0.12</section>',
  })
  assert.match(html, /今日花费 ¥0\.12/)

  // Interop subview renders all 3 Apple frosted glass cards + YAML + loopback URL
  controller.setSubView('interop')
  html = renderSatellitePage(controller.state())
  assert.match(html, /class="segmented satellite-subnav"/)
  assert.match(html, /data-subview="interop" aria-selected="true"/)
  assert.match(html, /data-section="interop-amp"/)
  assert.match(html, /data-section="interop-mcp"/)
  assert.match(html, /data-section="interop-debug-view"/)
  assert.match(html, /仅生成配置片段，Brain 绝不写主 DSH/)
  assert.match(html, /运行在专用隔离 home，主 DSH 看不到这里的会话/)
  assert.match(html, /data-role="mcp-patch-yaml"/)
  assert.match(html, /brain-memory-readonly/)
  assert.match(html, /data-role="debug-view-url" href="http:\/\/127\.0\.0\.1:43222\/\?token=abc"/)
  assert.equal(html.includes('NaN'), false)
  assert.equal(html.includes('undefined'), false)

  // Controller toggles update state cleanly
  await controller.toggleAmpAliases(false)
  assert.equal(controller.state().interop?.ampAliases, false)
  await controller.toggleReadOnlyMcp(false)
  assert.equal(controller.state().interop?.mcp.enabled, false)
  await controller.stopDebugView()
  assert.equal(controller.state().interop?.debugView.running, false)
  await controller.startDebugView()
  assert.equal(controller.state().interop?.debugView.pid, 9900)
})

test('interop view escapes XSS payloads and blocks non-loopback debugView href', async () => {
  const api: SatellitePageApi = {
    async getSnapshot() { return baseSnapshot() },
    async restart() {},
    async runIsolationDoctor() { return { ok: true, checkedAt: 0, problems: [] } },
    async getInterop() {
      return baseInterop({
        mcp: {
          enabled: true,
          running: true,
          url: 'http://127.0.0.1:4000/mcp"><script>alert(1)</script>',
          patchYaml: 'url: "<img src=x onerror=alert(2)>"',
        },
        debugView: {
          running: true,
          pid: 123,
          url: 'javascript:alert(3)//<svg onload=alert(4)>',
          port: 4001,
        },
      })
    },
  }

  const controller = createSatellitePageController(api)
  await controller.refreshInterop()
  controller.setSubView('interop')
  const html = renderSatellitePage(controller.state())

  assert.equal(html.includes('<script>'), false)
  assert.equal(html.includes('<img src=x'), false)
  assert.equal(html.includes('<svg onload'), false)
  assert.equal(html.includes('href="javascript:'), false)
  assert.match(html, /href="#"/)
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(html, /&lt;img src=x onerror=alert\(2\)&gt;/)
})

test('createHttpSatellitePageApi calls expected interop routes', async () => {
  const seen: { method: string; url: string; body: string }[] = []
  const snap = baseInterop({ ampAliases: true })
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', body: Buffer.concat(chunks).toString('utf8') })
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: true, data: snap, meta: { requestId: 'r-interop' } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  try {
    const api = createHttpSatellitePageApi(`http://127.0.0.1:${String(port)}`, 'tok')
    assert.deepEqual(await api.getInterop?.(), snap)
    await api.setAmpAliases?.(true)
    await api.setReadOnlyMcp?.(false)
    await api.startDebugView?.()
    await api.stopDebugView?.()
    assert.deepEqual(seen, [
      { method: 'GET', url: '/api/v1/console/interop', body: '' },
      { method: 'PUT', url: '/api/v1/console/interop/amp', body: '{"enabled":true}' },
      { method: 'PUT', url: '/api/v1/console/interop/mcp', body: '{"enabled":false}' },
      { method: 'POST', url: '/api/v1/console/interop/debug-view/start', body: '' },
      { method: 'POST', url: '/api/v1/console/interop/debug-view/stop', body: '' },
    ])
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('interop controller sets errorMessage on missing optional API or failure, renders banner, and clears on subsequent refresh', async () => {
  const minimalApi: SatellitePageApi = {
    async getSnapshot() { return baseSnapshot() },
    async restart() {},
    async runIsolationDoctor() { return { ok: true, checkedAt: 0, problems: [] } },
  }
  const minimalController = createSatellitePageController(minimalApi)
  // Missing getInterop stays silent for backwards compatibility
  await minimalController.refreshInterop()
  assert.equal(minimalController.state().errorMessage, null)

  // Missing optional mutators set errorMessage and render warning banner
  await minimalController.toggleAmpAliases(true)
  assert.equal(minimalController.state().errorMessage, '当前后端未启用外部互通接口')
  let html = renderSatellitePage(minimalController.state())
  assert.match(html, /data-role="page-error">当前后端未启用外部互通接口<\/div>/)

  // Subsequent successful refresh clears errorMessage and banner
  await minimalController.refresh()
  assert.equal(minimalController.state().errorMessage, null)
  html = renderSatellitePage(minimalController.state())
  assert.equal(html.includes('data-role="page-error"'), false)

  // Throwing interop API sets errorMessage, renders escaped banner, and clears on successful refreshInterop
  let shouldFail = true
  const failingApi: SatellitePageApi = {
    async getSnapshot() { return baseSnapshot() },
    async restart() {},
    async runIsolationDoctor() { return { ok: true, checkedAt: 0, problems: [] } },
    async getInterop() {
      if (shouldFail) throw new Error('互通查询失败 <bad>')
      return baseInterop({ ampAliases: true })
    },
    async setReadOnlyMcp() {
      throw new Error('MCP 启动超时')
    },
  }
  const controller = createSatellitePageController(failingApi)
  await controller.refreshInterop()
  assert.equal(controller.state().errorMessage, '互通查询失败 <bad>')
  html = renderSatellitePage(controller.state())
  assert.match(html, /data-role="page-error">互通查询失败 &lt;bad&gt;<\/div>/)

  await controller.toggleReadOnlyMcp(true)
  assert.equal(controller.state().errorMessage, 'MCP 启动超时')

  shouldFail = false
  await controller.refreshInterop()
  assert.equal(controller.state().errorMessage, null)
  assert.equal(controller.state().interop?.ampAliases, true)
  html = renderSatellitePage(controller.state())
  assert.equal(html.includes('data-role="page-error"'), false)
})
