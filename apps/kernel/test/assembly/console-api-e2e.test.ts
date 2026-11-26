import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { removeTree } from '@brain-core/satellite-host'
import { validate, type ContextBundle } from '@brain-core/sdk'
import { createKernel, type Kernel } from '../../src/assembly.ts'
import { createSettingsStore } from '../../src/runtime-stores/settings.ts'
import { capturingLogger, FLASH, TOKEN, type LogEntry } from './helpers.ts'

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

async function apiJson(kernel: Kernel, method: string, route: string, body?: unknown, token = TOKEN) {
  const res = await fetch(`http://127.0.0.1:${kernel.port}/api/v1${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, json: await res.json() as Record<string, unknown> }
}

async function writeSampleConsolePlugin(dir: string, options: {
  readonly version: string
  readonly permissions: readonly string[]
  readonly includePage?: boolean
}): Promise<void> {
  await mkdir(dir, { recursive: true })
  const manifest = {
    id: 'console-e2e',
    kinds: ['channel', 'capability'],
    api: '^1.0.0',
    runtime: 'node',
    permissions: options.permissions,
    source: {
      channels: ['console-e2e:group:*'],
      eventKinds: ['console-e2e.message'],
      defaultVisibility: 'open',
      trust: 'member',
    },
    tools: [
      {
        name: 'echo',
        effect: 'read',
        load: 'core',
        summary: '回声工具',
      },
    ],
  }
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'brain-plugin-console-e2e',
      version: options.version,
      private: true,
      type: 'module',
      main: 'index.js',
      brain: manifest,
    }, null, 2),
    'utf8',
  )
  const pageCode = options.includePage === false
    ? ''
    : `ctx.console.page({ id: 'overview', title: '控制台测试页', entry: 'index.html' });\n`
  await writeFile(
    path.join(dir, 'index.js'),
    `export function apply(ctx) {\n`
      + `  ${pageCode}`
      + `  ctx.tools.register({\n`
      + `    name: 'echo',\n`
      + `    description: 'echo text',\n`
      + `    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },\n`
      + `    async handler(args) { return String(args.text ?? '') },\n`
      + `  });\n`
      + `}\n`,
    'utf8',
  )
}

test('createKernel exposes all 21 console APIs end-to-end with isolated DSH_HOME', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brain-console-e2e-'))
  const brainHome = path.join(root, 'brain-home')
  const dshHome = path.join(root, 'dsh-home')
  const pluginSrcV1 = path.join(root, 'plugin-v1')
  const pluginSrcV2 = path.join(root, 'plugin-v2')
  const pluginSrcV3 = path.join(root, 'plugin-v3')
  await mkdir(path.join(brainHome, 'state'), { recursive: true })
  await mkdir(dshHome, { recursive: true })
  await writeFile(path.join(dshHome, 'sentinel.json'), '{"owner":"main-dsh"}\n', 'utf8')
  const dshBefore = await hashTree(dshHome)

  let now = 1_700_000_000_000
  const logs: LogEntry[] = []
  await createSettingsStore(path.join(brainHome, 'state', 'settings.json')).write({
    agents: { chat: { ...FLASH } },
  })

  const kernel = await createKernel({
    env: { ...process.env, BRAIN_HOME: brainHome, DSH_HOME: dshHome },
    userHome: root,
    port: 0,
    crossChannel: 'off',
    ownerChannels: ['qq:private:owner'],
    clock: { now: () => now },
    log: capturingLogger(logs),
    token: TOKEN,
  })

  t.after(async () => {
    await kernel.close()
    await removeTree(root)
  })

  assert.equal(kernel.paths.home, path.resolve(brainHome))
  assert.equal(kernel.getCrossChannelMode(), 'off')

  // 1. Cross-channel runtime hot switch affects both context and search immediately
  const ownerIdentity = { kind: 'kernel', source: 'owner-console', trust: 'owner', defaultVisibility: 'open' } as const
  const l0 = await kernel.memory.service.ingest({
    kind: 'chat.message',
    channel: 'qq:group:alpha',
    subjects: ['self'],
    actor: 'self',
    content: { text: '手冲咖啡配方 15g 豆 225g 水' },
    tEvent: now,
    idempotencyKey: 'cc-l0',
    visibility: 'open',
  }, ownerIdentity)
  const l1 = await kernel.memory.service.record({
    layer: 'L1',
    kind: 'l1.fact',
    channel: 'qq:group:alpha',
    subjects: ['self'],
    actor: 'self',
    content: { text: '喜欢浅烘手冲咖啡' },
    evidence: [{ id: l0.id }],
    visibility: 'open',
  }, ownerIdentity)

  assert.deepEqual((await apiJson(kernel, 'GET', '/console/memory/cross-channel')).json.data, { mode: 'off' })

  const ctxOff = await apiJson(kernel, 'POST', '/memory/context', { channel: 'qq:group:beta' })
  assert.equal(ctxOff.status, 200)
  const offElsewhere = (ctxOff.json.data as ContextBundle).blocks.find((b) => b.name === 'elsewhere')?.items ?? []
  assert.equal(offElsewhere.length, 0)
  const agentSearchOff = await kernel.memory.service.search(
    { query: '手冲咖啡', scope: 'all' },
    { caller: 'agent', channel: 'qq:group:beta', participants: [] },
  )
  assert.equal(agentSearchOff.items.length, 0)

  // Switch to shadow -> withheld from blocks, audited in cross_channel_use
  const putShadow = await apiJson(kernel, 'PUT', '/console/memory/cross-channel', { mode: 'shadow' })
  assert.equal(putShadow.status, 200)
  assert.deepEqual(putShadow.json.data, { mode: 'shadow' })
  assert.equal(kernel.getCrossChannelMode(), 'shadow')

  const ctxShadow = await apiJson(kernel, 'POST', '/memory/context', { channel: 'qq:group:beta' })
  assert.equal(ctxShadow.status, 200)
  const shadowElsewhere = (ctxShadow.json.data as ContextBundle).blocks.find((b) => b.name === 'elsewhere')?.items ?? []
  assert.equal(shadowElsewhere.length, 0)

  const auditShadow = await apiJson(kernel, 'GET', `/console/memory/audit?recordId=${encodeURIComponent(l1.id)}`)
  assert.equal(auditShadow.status, 200)
  const shadowRows = (auditShadow.json.data as { items: { recordId: string; mode: string; viewerChannel: string }[] }).items
  assert.ok(shadowRows.some((row) => row.recordId === l1.id && row.mode === 'shadow' && row.viewerChannel === 'qq:group:beta'))

  // Switch to on -> immediately visible in context and agent search
  const putOn = await apiJson(kernel, 'PUT', '/console/memory/cross-channel', { mode: 'on' })
  assert.equal(putOn.status, 200)
  assert.equal(kernel.getCrossChannelMode(), 'on')

  const ctxOn = await apiJson(kernel, 'POST', '/memory/context', { channel: 'qq:group:beta' })
  assert.equal(ctxOn.status, 200)
  const onElsewhere = (ctxOn.json.data as ContextBundle).blocks.find((b) => b.name === 'elsewhere')?.items ?? []
  assert.ok(onElsewhere.some((item) => item.id === l1.id))

  const agentSearchOn = await kernel.memory.service.search(
    { query: '手冲咖啡', scope: 'all' },
    { caller: 'agent', channel: 'qq:group:beta', participants: [] },
  )
  assert.ok(agentSearchOn.items.some((hit) => hit.record.id === l1.id || hit.record.id === l0.id))

  // 2. Persons list / merge / split & memory records browse / detail / dependents
  const pA = await kernel.memory.identity.resolve('qq:1001')
  const pB = await kernel.memory.identity.resolve('qq:1002')
  const pL0 = await kernel.memory.service.ingest({
    kind: 'chat.message',
    channel: 'qq:group:alpha',
    subjects: [pA],
    actor: pA,
    content: { text: 'pA 原话' },
    tEvent: now + 10,
    idempotencyKey: 'p-l0',
    visibility: 'open',
  }, ownerIdentity)
  const pL1 = await kernel.memory.service.record({
    layer: 'L1',
    kind: 'l1.fact',
    channel: 'qq:group:alpha',
    subjects: [pA],
    actor: pA,
    content: { text: 'pA 喜欢抹茶' },
    evidence: [{ id: pL0.id }],
    visibility: 'open',
  }, ownerIdentity)

  assert.equal((await apiJson(kernel, 'POST', '/console/memory/persons/merge', { from: pA, into: pB })).status, 200)
  const personsRes = await apiJson(kernel, 'GET', '/console/memory/persons')
  assert.equal(personsRes.status, 200)
  const persons = (personsRes.json.data as { items: { personId: string; accounts: string[]; aliases: string[] }[] }).items
  assert.equal(persons.length, 1)
  assert.equal(persons[0]?.personId, pB)
  assert.deepEqual(persons[0]?.accounts, ['qq:1001', 'qq:1002'])
  assert.deepEqual(persons[0]?.aliases, [pA])

  const browseMerged = await apiJson(kernel, 'GET', `/console/memory/records?layer=L1&personId=${encodeURIComponent(pB)}`)
  assert.equal(browseMerged.status, 200)
  const browseItems = (browseMerged.json.data as { items: { id: string }[] }).items
  assert.deepEqual(browseItems.map((r) => r.id), [pL1.id])

  const detailRes = await apiJson(kernel, 'GET', `/console/memory/records/${encodeURIComponent(pL1.id)}`)
  assert.equal(detailRes.status, 200)
  assert.equal((detailRes.json.data as { id: string }).id, pL1.id)

  const depsRes = await apiJson(kernel, 'GET', `/console/memory/records/${encodeURIComponent(pL0.id)}/dependents`)
  assert.equal(depsRes.status, 200)
  assert.deepEqual((depsRes.json.data as { items: { id: string }[] }).items.map((r) => r.id), [pL1.id])

  const splitRes = await apiJson(kernel, 'POST', `/console/memory/persons/${encodeURIComponent(pB)}/split`, { accounts: ['qq:1001'] })
  assert.equal(splitRes.status, 200)
  assert.equal((await apiJson(kernel, 'GET', '/console/memory/persons')).json.data && ((await apiJson(kernel, 'GET', '/console/memory/persons')).json.data as { items: unknown[] }).items.length, 2)

  // 3. Plugins lifecycle + manifest enrichment + coreBudgets + pages + check
  await writeSampleConsolePlugin(pluginSrcV1, { version: '1.0.0', permissions: ['tools.register'] })
  await writeSampleConsolePlugin(pluginSrcV2, { version: '1.0.1', permissions: ['tools.register'] })
  await writeSampleConsolePlugin(pluginSrcV3, { version: '1.0.2', permissions: ['tools.register', 'memory.search'] })

  const checkRes = await apiJson(kernel, 'POST', '/console/plugins/check', { dir: pluginSrcV1 })
  assert.equal(checkRes.status, 200)
  assert.equal((checkRes.json.data as { ok: boolean }).ok, true)

  const installRes = await apiJson(kernel, 'POST', '/console/plugins/install', { spec: pluginSrcV1 })
  assert.equal(installRes.status, 200)
  assert.equal((installRes.json.data as { id: string }).id, 'console-e2e')

  const pendingList = await apiJson(kernel, 'GET', '/console/plugins')
  assert.equal(pendingList.status, 200)
  const pendingData = pendingList.json.data as {
    plugins: { id: string; state: string; kinds: string[]; runtime: string; checkPassed: boolean; tools: { name: string }[] }[]
    coreBudgets: { pattern: string }[]
  }
  assert.equal(pendingData.plugins.length, 1)
  assert.equal(pendingData.plugins[0]?.state, 'pending')
  assert.deepEqual(pendingData.plugins[0]?.kinds, ['channel', 'capability'])
  assert.equal(pendingData.plugins[0]?.runtime, 'node')
  assert.equal(pendingData.plugins[0]?.checkPassed, true)
  assert.deepEqual(pendingData.plugins[0]?.tools.map((tool) => tool.name), ['echo'])
  assert.deepEqual(pendingData.coreBudgets, [])

  assert.equal((await apiJson(kernel, 'POST', '/console/plugins/console-e2e/confirm')).status, 200)
  assert.equal((await apiJson(kernel, 'POST', '/console/plugins/console-e2e/enable')).status, 200)

  const enabledList = await apiJson(kernel, 'GET', '/console/plugins')
  assert.equal(enabledList.status, 200)
  const enabledData = enabledList.json.data as {
    plugins: { state: string }[]
    coreBudgets: { pattern: string; count: number; tokens: number; over: boolean }[]
  }
  assert.equal(enabledData.plugins[0]?.state, 'enabled')
  assert.equal(enabledData.coreBudgets.length, 1)
  assert.equal(enabledData.coreBudgets[0]?.pattern, 'console-e2e:group')
  assert.ok((enabledData.coreBudgets[0]?.count ?? 0) >= 1)

  const pagesRes = await apiJson(kernel, 'GET', '/console/pages')
  assert.equal(pagesRes.status, 200)
  assert.deepEqual(pagesRes.json.data, {
    items: [{ pluginId: 'console-e2e', id: 'overview', title: '控制台测试页', entry: 'index.html' }],
  })

  // Upgrade without new permissions -> applied: true
  const upgradeSame = await apiJson(kernel, 'POST', '/console/plugins/console-e2e/upgrade', { spec: pluginSrcV2 })
  assert.equal(upgradeSame.status, 200)
  assert.equal((upgradeSame.json.data as { applied: boolean; version: string }).applied, true)
  assert.equal((upgradeSame.json.data as { version: string }).version, '1.0.1')

  // Upgrade with new permissions -> applied: false, then confirm
  const upgradeNew = await apiJson(kernel, 'POST', '/console/plugins/console-e2e/upgrade', { spec: pluginSrcV3 })
  assert.equal(upgradeNew.status, 200)
  assert.equal((upgradeNew.json.data as { applied: boolean; newPermissions: string[] }).applied, false)
  assert.deepEqual((upgradeNew.json.data as { newPermissions: string[] }).newPermissions, ['memory.search'])
  assert.equal((await apiJson(kernel, 'POST', '/console/plugins/console-e2e/confirm')).status, 200)

  assert.equal((await apiJson(kernel, 'POST', '/console/plugins/console-e2e/disable')).status, 200)
  assert.deepEqual((await apiJson(kernel, 'GET', '/console/pages')).json.data, { items: [] })
  assert.equal((await apiJson(kernel, 'POST', '/console/plugins/console-e2e/uninstall', { keepData: false })).status, 200)
  assert.deepEqual((await apiJson(kernel, 'GET', '/console/plugins')).json.data, { plugins: [], coreBudgets: [] })

  // 4. Satellite snapshot, doctor, restart, metrics, sessions, sharedQuotaWarning
  await kernel.metrics.record({
    wakeId: 'w_e2e_1',
    channel: 'qq:group:alpha',
    agentClass: 'chat',
    profileVersion: 1,
    arrivedAt: now,
    firstSendAt: now + 50,
    debounceMs: 10,
    steps: [{ inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 0 }],
    retries: 0,
    outcome: 'acked',
  })
  await writeFile(
    path.join(brainHome, 'state', 'agent', 'sessions.json'),
    JSON.stringify({
      version: 1,
      channels: {
        'qq:group:alpha': {
          generation: 0,
          startedDay: '2026-11-21',
          activated: [],
          lastInputTokens: 100,
          turns: 1,
          people: [],
          recentEvidence: [],
        },
      },
    }),
    'utf8',
  )

  const sat1 = await apiJson(kernel, 'GET', '/console/satellite')
  assert.equal(sat1.status, 200)
  validate('Envelope', sat1.json)
  const snap1 = sat1.json.data as {
    processes: {
      chat: { status: string; selection: unknown; activeSessions: number; deniedApprovals: number }
      activity: { status: string; selection: unknown; activeSessions: number; deniedApprovals: number }
    }
    sessions: { channel: string; agentClass: string; toolCount: number }[]
    isolation: { ok: boolean; checkedAt: number; problems: string[] }
    metrics: { wakeId: string }[]
    sharedQuotaWarning: boolean
  }
  assert.equal(snap1.processes.chat.status, 'stopped')
  assert.deepEqual(snap1.processes.chat.selection, FLASH)
  assert.equal(snap1.processes.chat.activeSessions, 1)
  assert.equal(snap1.processes.activity.selection, null)
  assert.equal(snap1.processes.activity.activeSessions, 0)
  assert.equal(snap1.sessions.length, 1)
  assert.equal(snap1.sessions[0]?.channel, 'qq:group:alpha')
  assert.equal(snap1.sessions[0]?.agentClass, 'chat')
  assert.equal(snap1.isolation.ok, true)
  assert.equal(snap1.metrics.length, 1)
  assert.equal(snap1.metrics[0]?.wakeId, 'w_e2e_1')
  assert.equal(snap1.sharedQuotaWarning, true)

  // Setting dedicated API key clears sharedQuotaWarning
  await kernel.secrets.set('brain-deepseek-api-key', 'dedicated-secret')
  now += 5000
  const docRes = await apiJson(kernel, 'POST', '/console/satellite/doctor')
  assert.equal(docRes.status, 200)
  assert.deepEqual(docRes.json.data, { ok: true, checkedAt: now, problems: [] })

  const sat2 = await apiJson(kernel, 'GET', '/console/satellite')
  assert.equal(sat2.status, 200)
  const snap2 = sat2.json.data as { isolation: { checkedAt: number }; sharedQuotaWarning: boolean }
  assert.equal(snap2.isolation.checkedAt, now)
  assert.equal(snap2.sharedQuotaWarning, false)

  assert.equal((await apiJson(kernel, 'POST', '/console/satellite/chat/restart')).status, 200)
  assert.equal((await apiJson(kernel, 'POST', '/console/satellite/bad/restart')).status, 400)

  // Verify DSH_HOME remained untouched throughout all tests
  const dshAfter = await hashTree(dshHome)
  assert.deepEqual([...dshAfter.entries()], [...dshBefore.entries()])

  // 5. Fallback when installed plugin's package.json is missing/corrupt
  await writeFile(
    path.join(kernel.paths.plugins, 'registry.json'),
    JSON.stringify({
      version: 1,
      plugins: {
        broken: {
          id: 'broken',
          state: 'disabled',
          current: { version: '0.1.0', sha8: 'deadbeef' },
          granted: [],
        },
      },
    }),
    'utf8',
  )
  const fallbackList = await apiJson(kernel, 'GET', '/console/plugins')
  assert.equal(fallbackList.status, 200)
  const fallbackPlugins = (fallbackList.json.data as {
    plugins: { id: string; kinds: string[]; runtime: string; tools: unknown[]; checkPassed: boolean }[]
  }).plugins
  assert.deepEqual(fallbackPlugins, [
    {
      id: 'broken',
      version: '0.1.0',
      kinds: [],
      runtime: 'node',
      state: 'disabled',
      permissions: [],
      granted: [],
      checkPassed: false,
      tools: [],
    },
  ])
})
