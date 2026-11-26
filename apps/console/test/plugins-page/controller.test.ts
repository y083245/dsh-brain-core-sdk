import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createPluginsPageController,
  type ChannelCoreBudget,
  type CheckReport,
  type ConsoleInstallPreview,
  type ConsolePluginItem,
  type PluginsPageApi,
} from '../../src/pages/plugins/index.ts'

function makePlugin(overrides: Partial<ConsolePluginItem> = {}): ConsolePluginItem {
  return {
    id: 'demo-plugin',
    version: '1.0.0',
    kinds: ['capability'],
    runtime: 'node',
    state: 'enabled',
    permissions: ['memory.search'],
    granted: ['memory.search'],
    checkPassed: true,
    tools: [
      {
        name: 'lookup',
        effect: 'read',
        load: 'core',
        group: 'search',
        when: 'channel == "private"',
        audience: 'owner',
        summary: 'Search memory',
      },
    ],
    ...overrides,
  }
}

function makePreview(overrides: Partial<ConsoleInstallPreview> = {}): ConsoleInstallPreview {
  return {
    id: 'demo-plugin',
    version: '1.1.0',
    permissions: ['memory.search', 'lan:192.168.1.10'],
    newPermissions: ['lan:192.168.1.10'],
    warnings: ['core tools near budget'],
    ...overrides,
  }
}

function makeCheckReport(overrides: Partial<CheckReport> = {}): CheckReport {
  return {
    ok: true,
    manifest: {
      ok: true,
      manifest: {
        id: 'demo-plugin',
        kinds: ['capability'],
        api: '^1.0.0',
        runtime: 'node',
        permissions: ['memory.search'],
      },
    },
    contract: [
      { name: 'manifest', ok: true, message: 'the manifest is valid' },
      { name: 'apply', ok: true, message: 'apply finished without throwing' },
    ],
    findings: [],
    notes: ['all good'],
    ...overrides,
  }
}

function createFakeApi(overrides: Partial<PluginsPageApi> = {}): {
  readonly api: PluginsPageApi
  readonly calls: string[]
  readonly uninstallPayloads: { readonly id: string; readonly keepData: boolean }[]
} {
  const calls: string[] = []
  const uninstallPayloads: { readonly id: string; readonly keepData: boolean }[] = []
  let plugins: ConsolePluginItem[] = [makePlugin()]
  const coreBudgets: ChannelCoreBudget[] = [{ pattern: 'console:*', count: 2, tokens: 300, over: false }]

  const api: PluginsPageApi = {
    async list() {
      calls.push('list')
      return { plugins, coreBudgets }
    },
    async install(spec) {
      calls.push(`install:${spec}`)
      return makePreview()
    },
    async confirm(id) {
      calls.push(`confirm:${id}`)
    },
    async enable(id) {
      calls.push(`enable:${id}`)
      plugins = plugins.map((p) => (p.id === id ? { ...p, state: 'enabled' } : p))
    },
    async disable(id) {
      calls.push(`disable:${id}`)
      plugins = plugins.map((p) => (p.id === id ? { ...p, state: 'disabled' } : p))
    },
    async upgrade(id, spec) {
      calls.push(`upgrade:${id}:${spec}`)
      return { ...makePreview({ id, newPermissions: [], warnings: [] }), applied: true }
    },
    async uninstall(id, options) {
      calls.push(`uninstall:${id}:${String(options.keepData)}`)
      uninstallPayloads.push({ id, keepData: options.keepData })
      plugins = plugins.filter((p) => p.id !== id)
    },
    async check(dir) {
      calls.push(`check:${dir}`)
      return makeCheckReport()
    },
    ...overrides,
  }

  return { api, calls, uninstallPayloads }
}

test('two-step install: startInstall never calls confirm or enable, cancelInstall clears, confirmInstall runs confirm -> enable -> list', async () => {
  const { api, calls } = createFakeApi()
  const controller = createPluginsPageController(api)

  assert.deepEqual(controller.state(), {
    plugins: [],
    coreBudgets: [],
    pendingInstall: null,
    pendingUpgrade: null,
    lastCheckReport: null,
    rollbackNotice: null,
    errorMessage: null,
  })

  const preview = await controller.startInstall('./plugins/demo')
  assert.equal(preview.id, 'demo-plugin')
  assert.deepEqual(calls, ['install:./plugins/demo'])
  assert.equal(controller.state().pendingInstall?.id, 'demo-plugin')

  controller.cancelInstall()
  assert.equal(controller.state().pendingInstall, null)
  assert.deepEqual(calls, ['install:./plugins/demo'])

  await controller.startInstall('./plugins/demo')
  await controller.confirmInstall()
  assert.equal(controller.state().pendingInstall, null)
  assert.deepEqual(calls, [
    'install:./plugins/demo',
    'install:./plugins/demo',
    'confirm:demo-plugin',
    'enable:demo-plugin',
    'list',
  ])
  assert.equal(controller.state().plugins.length, 1)
})

test('confirmInstall without pendingInstall throws and sets errorMessage', async () => {
  const { api } = createFakeApi()
  const controller = createPluginsPageController(api)
  await assert.rejects(() => controller.confirmInstall(), /no pending install/)
  assert.equal(controller.state().errorMessage, 'no pending install to confirm')
})

test('startInstall and confirmInstall propagate errors and set errorMessage', async () => {
  const { api: failInstallApi } = createFakeApi({
    async install() {
      throw new Error('bad tarball')
    },
  })
  const c1 = createPluginsPageController(failInstallApi)
  await assert.rejects(() => c1.startInstall('bad'), /bad tarball/)
  assert.equal(c1.state().errorMessage, 'bad tarball')
  assert.equal(c1.state().pendingInstall, null)

  const { api: failEnableApi } = createFakeApi({
    async enable() {
      throw 'enable string error'
    },
  })
  const c2 = createPluginsPageController(failEnableApi)
  await c2.startInstall('./ok')
  await assert.rejects(() => c2.confirmInstall())
  assert.equal(c2.state().errorMessage, 'enable string error')
})

test('enable and disable update plugin state and handle errors', async () => {
  const { api, calls } = createFakeApi()
  const controller = createPluginsPageController(api)

  await controller.disable('demo-plugin')
  assert.equal(controller.state().plugins[0]?.state, 'disabled')

  await controller.enable('demo-plugin')
  assert.equal(controller.state().plugins[0]?.state, 'enabled')
  assert.deepEqual(calls, ['disable:demo-plugin', 'list', 'enable:demo-plugin', 'list'])

  const { api: failApi } = createFakeApi({
    async enable() {
      throw new Error('cannot enable')
    },
    async disable() {
      throw new Error('cannot disable')
    },
  })
  const failCtrl = createPluginsPageController(failApi)
  await assert.rejects(() => failCtrl.enable('demo-plugin'), /cannot enable/)
  assert.equal(failCtrl.state().errorMessage, 'cannot enable')
  await assert.rejects(() => failCtrl.disable('demo-plugin'), /cannot disable/)
  assert.equal(failCtrl.state().errorMessage, 'cannot disable')
})

test('upgrade completes directly when no newPermissions and applied=true, or waits for confirmUpgrade when newPermissions or applied=false', async () => {
  const { api: directApi, calls: directCalls } = createFakeApi()
  const directCtrl = createPluginsPageController(directApi)
  await directCtrl.startUpgrade('demo-plugin', '1.1.0')
  assert.equal(directCtrl.state().pendingUpgrade, null)
  assert.deepEqual(directCalls, ['upgrade:demo-plugin:1.1.0', 'list'])

  const { api: promptApi, calls: promptCalls } = createFakeApi({
    async upgrade(id, spec) {
      promptCalls.push(`upgrade:${id}:${spec}`)
      return { ...makePreview({ id, newPermissions: ['lan:10.0.0.1'] }), applied: false }
    },
  })
  const promptCtrl = createPluginsPageController(promptApi)
  await promptCtrl.startUpgrade('demo-plugin', '1.2.0')
  assert.equal(promptCtrl.state().pendingUpgrade?.id, 'demo-plugin')
  assert.deepEqual(promptCalls, ['upgrade:demo-plugin:1.2.0'])

  promptCtrl.cancelUpgrade()
  assert.equal(promptCtrl.state().pendingUpgrade, null)
  assert.deepEqual(promptCalls, ['upgrade:demo-plugin:1.2.0'])

  await promptCtrl.startUpgrade('demo-plugin', '1.2.0')
  await promptCtrl.confirmUpgrade()
  assert.equal(promptCtrl.state().pendingUpgrade, null)
  assert.deepEqual(promptCalls, [
    'upgrade:demo-plugin:1.2.0',
    'upgrade:demo-plugin:1.2.0',
    'confirm:demo-plugin',
    'list',
  ])
})

test('upgrade with applied=false and empty newPermissions still enters pendingUpgrade', async () => {
  const { api } = createFakeApi({
    async upgrade(id) {
      return { ...makePreview({ id, newPermissions: [] }), applied: false }
    },
  })
  const controller = createPluginsPageController(api)
  await controller.startUpgrade('demo-plugin', '1.3.0')
  assert.equal(controller.state().pendingUpgrade?.id, 'demo-plugin')
})

test('confirmUpgrade without pendingUpgrade throws and sets errorMessage', async () => {
  const { api } = createFakeApi()
  const controller = createPluginsPageController(api)
  await assert.rejects(() => controller.confirmUpgrade(), /no pending upgrade/)
  assert.equal(controller.state().errorMessage, 'no pending upgrade to confirm')
})

test('upgrade failure during upgrade or confirmUpgrade sets rollbackNotice without throwing and refreshes list', async () => {
  const { api: failUpgradeApi, calls: calls1 } = createFakeApi({
    async upgrade() {
      throw new Error('migration 2 failed')
    },
  })
  const c1 = createPluginsPageController(failUpgradeApi)
  await c1.startUpgrade('demo-plugin', '2.0.0')
  assert.match(c1.state().rollbackNotice ?? '', /demo-plugin/)
  assert.match(c1.state().rollbackNotice ?? '', /已自动回滚至旧版，数据与 schema-version 已恢复/)
  assert.match(c1.state().rollbackNotice ?? '', /migration 2 failed/)
  assert.equal(c1.state().pendingUpgrade, null)
  assert.deepEqual(calls1, ['list'])

  const { api: failConfirmApi, calls: calls2 } = createFakeApi({
    async upgrade(id) {
      calls2.push(`upgrade:${id}`)
      return { ...makePreview({ id, newPermissions: ['network:example.com'] }), applied: false }
    },
    async confirm() {
      throw new Error('enable failed after confirm')
    },
    async list() {
      calls2.push('list')
      throw new Error('list temporarily unavailable')
    },
  })
  const c2 = createPluginsPageController(failConfirmApi)
  await c2.startUpgrade('demo-plugin', '2.0.0')
  await c2.confirmUpgrade()
  assert.match(c2.state().rollbackNotice ?? '', /demo-plugin/)
  assert.match(c2.state().rollbackNotice ?? '', /已自动回滚至旧版，数据与 schema-version 已恢复/)
  assert.equal(c2.state().pendingUpgrade, null)
  assert.deepEqual(calls2, ['upgrade:demo-plugin', 'list'])
})

test('uninstall passes keepData: true and keepData: false explicitly and clears matching pendingUpgrade', async () => {
  const { api, uninstallPayloads } = createFakeApi({
    async upgrade(id) {
      return { ...makePreview({ id }), applied: false }
    },
  })
  const controller = createPluginsPageController(api)

  await controller.startUpgrade('demo-plugin', '2.0.0')
  assert.ok(controller.state().pendingUpgrade !== null)

  await controller.uninstall('demo-plugin', { keepData: true })
  assert.equal(controller.state().pendingUpgrade, null)

  await controller.uninstall('other-plugin', { keepData: false })
  assert.deepEqual(uninstallPayloads, [
    { id: 'demo-plugin', keepData: true },
    { id: 'other-plugin', keepData: false },
  ])

  const { api: failApi } = createFakeApi({
    async uninstall() {
      throw new Error('uninstall denied')
    },
  })
  const failCtrl = createPluginsPageController(failApi)
  await assert.rejects(() => failCtrl.uninstall('demo-plugin', { keepData: true }), /uninstall denied/)
  assert.equal(failCtrl.state().errorMessage, 'uninstall denied')
})

test('runCheck stores lastCheckReport and refresh/runCheck propagate errors', async () => {
  const { api } = createFakeApi()
  const controller = createPluginsPageController(api)

  const report = await controller.runCheck('/tmp/my-plugin')
  assert.equal(report.ok, true)
  assert.equal(controller.state().lastCheckReport?.target, '/tmp/my-plugin')
  assert.equal(controller.state().lastCheckReport?.report.ok, true)

  const { api: failApi } = createFakeApi({
    async list() {
      throw new Error('list failed')
    },
    async check() {
      throw new Error('check failed')
    },
  })
  const failCtrl = createPluginsPageController(failApi)
  await assert.rejects(() => failCtrl.refresh(), /list failed/)
  assert.equal(failCtrl.state().errorMessage, 'list failed')
  await assert.rejects(() => failCtrl.runCheck('/bad'), /check failed/)
  assert.equal(failCtrl.state().errorMessage, 'check failed')
})

test('refresh updates coreBudgets and clears previous errorMessage', async () => {
  let shouldFail = true
  const { api } = createFakeApi({
    async check() {
      if (shouldFail) throw new Error('temporary check error')
      return makeCheckReport()
    },
  })
  const controller = createPluginsPageController(api)

  await assert.rejects(() => controller.runCheck('/tmp/p'), /temporary check error/)
  assert.equal(controller.state().errorMessage, 'temporary check error')

  shouldFail = false
  await controller.refresh()
  assert.equal(controller.state().errorMessage, null)
  assert.deepEqual(controller.state().coreBudgets, [{ pattern: 'console:*', count: 2, tokens: 300, over: false }])
})

test('upgrade with non-empty newPermissions and applied=true still enters pendingUpgrade without calling confirm', async () => {
  const calls: string[] = []
  const { api } = createFakeApi({
    async upgrade(id, spec) {
      calls.push(`upgrade:${id}:${spec}`)
      return { ...makePreview({ id, newPermissions: ['lan:192.168.1.9'] }), applied: true }
    },
    async confirm(id) {
      calls.push(`confirm:${id}`)
    },
  })
  const controller = createPluginsPageController(api)
  await controller.startUpgrade('demo-plugin', '1.4.0')
  assert.equal(controller.state().pendingUpgrade?.id, 'demo-plugin')
  assert.deepEqual(controller.state().pendingUpgrade?.preview.newPermissions, ['lan:192.168.1.9'])
  assert.deepEqual(calls, ['upgrade:demo-plugin:1.4.0'])
})
