import assert from 'node:assert/strict'
import test from 'node:test'
import { BrainError, validate } from '@brain-core/sdk'
import type { CheckReport } from '@brain-core/testkit'
import type { CrossChannelMode } from '../../src/contracts/index.ts'
import {
  createMemoryApiServer,
  type ConsoleIsolationDoctorStatus,
  type ConsolePluginItem,
  type ConsoleSatelliteSnapshot,
} from '../../src/memory-api/index.ts'
import { OWNER_IDENTITY, openTempBrain, silentLog } from './helpers.ts'

async function req(port: number, token: string, method: string, route: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, json: await res.json() as Record<string, unknown> }
}

test('IdentityService.listPersons excludes self, sorts accounts and chained aliases, and reflects split', async () => {
  const brain = await openTempBrain()
  try {
    const { identity } = brain.memory
    await identity.link('qq:999', 'self')
    const p1 = await identity.resolve('qq:200')
    const p2 = await identity.resolve('qq:100')
    const p3 = await identity.resolve('wx:300')

    await identity.merge(p1, p2)
    await identity.merge(p2, p3)
    await identity.link('wx:050', p3)

    const listed = await identity.listPersons()
    assert.equal(listed.length, 1)
    assert.equal(listed[0]?.personId, p3)
    assert.deepEqual(listed[0]?.accounts, ['qq:100', 'qq:200', 'wx:050', 'wx:300'])
    assert.deepEqual(listed[0]?.aliases, [p1, p2].sort())

    const splitId = await identity.split(p3, ['qq:100', 'wx:050'])
    const afterSplit = await identity.listPersons()
    assert.deepEqual(
      afterSplit.map((p) => p.personId),
      [p3, splitId].sort(),
    )
    const splitEntry = afterSplit.find((p) => p.personId === splitId)
    assert.deepEqual(splitEntry?.accounts, ['qq:100', 'wx:050'])
    assert.deepEqual(splitEntry?.aliases, [])
  } finally {
    await brain.close()
  }
})

test('console routes enforce Bearer auth and 503 UNAVAILABLE when console deps are unconfigured', async () => {
  const brain = await openTempBrain()
  const server = createMemoryApiServer(brain.memory, { token: 'secret-token', port: 0, log: silentLog })
  const { port } = await server.listen()
  try {
    for (const [method, route, body] of [
      ['GET', '/console/plugins'],
      ['POST', '/console/plugins/install', { spec: '/tmp/p' }],
      ['POST', '/console/plugins/demo/confirm'],
      ['POST', '/console/plugins/demo/enable'],
      ['POST', '/console/plugins/demo/disable'],
      ['POST', '/console/plugins/demo/upgrade', { spec: '/tmp/p' }],
      ['POST', '/console/plugins/demo/uninstall', { keepData: false }],
      ['POST', '/console/plugins/check', { dir: '/tmp/p' }],
      ['POST', '/console/memory/search', { query: 'hello', scope: 'all' }],
      ['GET', '/console/memory/records'],
      ['GET', '/console/memory/records/missing'],
      ['GET', '/console/memory/records/missing/dependents'],
      ['GET', '/console/memory/audit'],
      ['GET', '/console/memory/cross-channel'],
      ['PUT', '/console/memory/cross-channel', { mode: 'on' }],
      ['GET', '/console/memory/persons'],
      ['POST', '/console/memory/persons/merge', { from: 'a', into: 'b' }],
      ['POST', '/console/memory/persons/a/split', { accounts: ['qq:1'] }],
      ['GET', '/console/satellite'],
      ['POST', '/console/satellite/chat/restart'],
      ['POST', '/console/satellite/doctor'],
      ['GET', '/console/pages'],
    ] as const) {
      const unauth = await req(port, 'wrong-token', method, route, body)
      assert.equal(unauth.status, 401, `${method} ${route} should require valid Bearer token`)
      validate('Envelope', unauth.json)
    }

    for (const [method, route, body] of [
      ['GET', '/console/plugins'],
      ['POST', '/console/plugins/install', { spec: '/tmp/p' }],
      ['POST', '/console/plugins/check', { dir: '/tmp/p' }],
      ['GET', '/console/memory/cross-channel'],
      ['PUT', '/console/memory/cross-channel', { mode: 'on' }],
      ['GET', '/console/satellite'],
      ['POST', '/console/satellite/chat/restart'],
      ['POST', '/console/satellite/doctor'],
      ['GET', '/console/pages'],
    ] as const) {
      const unconfigured = await req(port, 'secret-token', method, route, body)
      assert.equal(unconfigured.status, 503, `${method} ${route} should return 503 when unconfigured`)
      validate('Envelope', unconfigured.json)
    }
  } finally {
    await server.close()
    await brain.close()
  }
})

test('all 21 console routes validate parameters, decode segments, and return expected envelopes', async () => {
  const brain = await openTempBrain()
  const now = 1_700_000_000_000
  let crossChannelMode: CrossChannelMode = 'shadow'
  const pluginCalls: string[] = []
  const restarted: string[] = []
  let doctorCalls = 0

  const samplePlugin: ConsolePluginItem = {
    id: 'demo/plugin',
    version: '1.0.0',
    kinds: ['capability'],
    runtime: 'node',
    state: 'enabled',
    permissions: ['tools.register'],
    granted: ['tools.register'],
    checkPassed: true,
    tools: [{ name: 'ping', effect: 'read', load: 'core', summary: 'ping' }],
  }

  const fakeCheck: CheckReport = {
    ok: true,
    manifest: {
      ok: true,
      manifest: {
        id: 'demo',
        kinds: ['capability'],
        api: '^1.0.0',
        runtime: 'node',
        permissions: [],
      },
    },
    contract: [{ name: 'apply', ok: true, message: 'ok' }],
    findings: [],
    notes: [],
  }

  const fakeSnapshot: ConsoleSatelliteSnapshot = {
    processes: {
      chat: { agentClass: 'chat', status: 'running', pid: 1234, activeSessions: 1, selection: null, deniedApprovals: 0 },
      activity: { agentClass: 'activity', status: 'stopped', activeSessions: 0, selection: null, deniedApprovals: 2 },
    },
    sessions: [{ sessionId: 'brn-chat-abc-0', channel: 'qq:group:1', agentClass: 'chat', toolCount: 4 }],
    isolation: { ok: true, checkedAt: now, problems: [] },
    metrics: [],
    sharedQuotaWarning: true,
  }

  const server = createMemoryApiServer(brain.memory, {
    token: 'tok',
    port: 0,
    log: silentLog,
    console: {
      plugins: {
        async list() {
          return {
            plugins: [samplePlugin],
            coreBudgets: [{ pattern: 'qq:group', count: 1, tokens: 120, over: false }],
          }
        },
        async install(spec) {
          pluginCalls.push(`install:${spec}`)
          return { id: 'demo/plugin', version: '1.0.0', permissions: ['tools.register'], newPermissions: ['tools.register'], warnings: [] }
        },
        async confirm(id) {
          pluginCalls.push(`confirm:${id}`)
        },
        async enable(id) {
          pluginCalls.push(`enable:${id}`)
        },
        async disable(id) {
          pluginCalls.push(`disable:${id}`)
        },
        async upgrade(id, spec) {
          pluginCalls.push(`upgrade:${id}:${spec}`)
          const hasNew = spec.includes('new-perm')
          return {
            id,
            version: '1.1.0',
            permissions: ['tools.register'],
            newPermissions: hasNew ? ['channel.send'] : [],
            warnings: [],
            applied: !hasNew,
          }
        },
        async uninstall(id, options) {
          pluginCalls.push(`uninstall:${id}:${String(options.keepData)}`)
        },
        async check(dir) {
          pluginCalls.push(`check:${dir}`)
          return fakeCheck
        },
      },
      memoryConsole: {
        crossChannel: {
          getMode: () => crossChannelMode,
          setMode: (next) => { crossChannelMode = next },
        },
      },
      satellite: {
        snapshot: async () => fakeSnapshot,
        restart: (agentClass) => { restarted.push(agentClass) },
        runDoctor: async (): Promise<ConsoleIsolationDoctorStatus> => {
          doctorCalls += 1
          return { ok: true, checkedAt: now + doctorCalls, problems: [] }
        },
      },
      pages: {
        list: () => [{ pluginId: 'demo', id: 'main', title: 'Demo Page', entry: 'page.html' }],
      },
    },
  })
  const { port } = await server.listen()

  try {
    // Seed identity, records (with dependents), and audit entries
    const p1 = await brain.memory.identity.resolve('qq:111')
    const p2 = await brain.memory.identity.resolve('qq:222')
    await brain.memory.identity.merge(p1, p2)

    const l0a = await brain.memory.service.ingest({
      kind: 'chat.message', channel: 'qq:group:1', subjects: [p1], actor: p1,
      content: { text: 'hello' }, tEvent: now, idempotencyKey: 'cr-1',
    }, OWNER_IDENTITY)
    const l0b = await brain.memory.service.ingest({
      kind: 'chat.message', channel: 'qq:group:2', subjects: [p2], actor: p2,
      content: { text: 'world' }, tEvent: now + 1, idempotencyKey: 'cr-2',
    }, OWNER_IDENTITY)
    const l1 = await brain.memory.service.record({
      layer: 'L1', kind: 'l1.fact', channel: 'qq:group:1', subjects: [p1], actor: p1,
      content: { text: 'fact about p1' }, evidence: [{ id: l0a.id }],
    }, OWNER_IDENTITY)
    await brain.memory.audit.crossChannelUse({ recordId: l0a.id, viewerChannel: 'qq:group:2', mode: 'shadow', tAt: now + 5 })
    await brain.memory.audit.crossChannelUse({ recordId: l0b.id, viewerChannel: 'qq:group:1', mode: 'on', tAt: now + 6 })

    // (a) Plugins validation & happy paths
    assert.equal((await req(port, 'tok', 'POST', '/console/plugins/install', {})).status, 400)
    assert.equal((await req(port, 'tok', 'POST', '/console/plugins/install', { spec: '   ' })).status, 400)
    assert.equal((await req(port, 'tok', 'POST', '/console/plugins/check', { dir: '' })).status, 400)
    assert.equal((await req(port, 'tok', 'POST', '/console/plugins/%ZZ/confirm')).status, 400)
    assert.equal((await req(port, 'tok', 'POST', '/console/plugins/demo/upgrade', {})).status, 400)
    assert.equal((await req(port, 'tok', 'POST', '/console/plugins/demo/uninstall', { keepData: 'yes' })).status, 400)
    assert.equal((await req(port, 'tok', 'POST', '/console/plugins/demo/uninstall', 'bad-array' as unknown)).status, 400)

    const plist = await req(port, 'tok', 'GET', '/console/plugins')
    assert.equal(plist.status, 200)
    validate('Envelope', plist.json)
    assert.equal((plist.json.data as { plugins: ConsolePluginItem[] }).plugins.length, 1)

    assert.equal((await req(port, 'tok', 'POST', '/console/plugins/install', { spec: '/abs/demo' })).status, 200)
    const encodedId = encodeURIComponent('demo/plugin')
    assert.equal((await req(port, 'tok', 'POST', `/console/plugins/${encodedId}/confirm`)).status, 200)
    assert.equal((await req(port, 'tok', 'POST', `/console/plugins/${encodedId}/enable`)).status, 200)
    assert.equal((await req(port, 'tok', 'POST', `/console/plugins/${encodedId}/disable`)).status, 200)

    const up1 = await req(port, 'tok', 'POST', `/console/plugins/${encodedId}/upgrade`, { spec: '/abs/v2' })
    assert.equal(up1.status, 200)
    assert.equal((up1.json.data as { applied: boolean }).applied, true)

    const up2 = await req(port, 'tok', 'POST', `/console/plugins/${encodedId}/upgrade`, { spec: '/abs/new-perm' })
    assert.equal(up2.status, 200)
    assert.equal((up2.json.data as { applied: boolean }).applied, false)

    assert.equal((await req(port, 'tok', 'POST', `/console/plugins/${encodedId}/uninstall`, { keepData: true })).status, 200)
    assert.equal((await req(port, 'tok', 'POST', `/console/plugins/${encodedId}/uninstall`)).status, 200)
    assert.equal((await req(port, 'tok', 'POST', '/console/plugins/check', { dir: '/abs/demo' })).status, 200)
    assert.deepEqual(pluginCalls, [
      'install:/abs/demo',
      'confirm:demo/plugin',
      'enable:demo/plugin',
      'disable:demo/plugin',
      'upgrade:demo/plugin:/abs/v2',
      'upgrade:demo/plugin:/abs/new-perm',
      'uninstall:demo/plugin:true',
      'uninstall:demo/plugin:false',
      'check:/abs/demo',
    ])

    // (b) Memory validation & happy paths
    assert.equal((await req(port, 'tok', 'GET', '/console/memory/records?layer=L9')).status, 400)
    assert.equal((await req(port, 'tok', 'GET', '/console/memory/records?limit=0')).status, 400)
    assert.equal((await req(port, 'tok', 'GET', '/console/memory/records?limit=201')).status, 400)
    assert.equal((await req(port, 'tok', 'GET', '/console/memory/records?limit=abc')).status, 400)
    assert.equal((await req(port, 'tok', 'GET', '/console/memory/records/%ZZ')).status, 400)
    assert.equal((await req(port, 'tok', 'GET', '/console/memory/records/does-not-exist')).status, 404)
    assert.equal((await req(port, 'tok', 'PUT', '/console/memory/cross-channel', { mode: 'invalid' })).status, 400)
    assert.equal((await req(port, 'tok', 'POST', '/console/memory/persons/merge', { from: '', into: p2 })).status, 400)
    assert.equal((await req(port, 'tok', 'POST', `/console/memory/persons/${p2}/split`, { accounts: [] })).status, 400)
    assert.equal((await req(port, 'tok', 'POST', `/console/memory/persons/${p2}/split`, { accounts: [''] })).status, 400)
    assert.equal((await req(port, 'tok', 'POST', '/console/memory/persons/%ZZ/split', { accounts: ['qq:111'] })).status, 400)

    // Pagination + filter by merged canonical personId expands to alias p1
    const page1 = await req(port, 'tok', 'GET', `/console/memory/records?personId=${encodeURIComponent(p2)}&limit=1`)
    assert.equal(page1.status, 200)
    const d1 = page1.json.data as { items: { id: string }[]; nextCursor?: string }
    assert.equal(d1.items.length, 1)
    assert.ok(d1.nextCursor !== undefined)
    const page2 = await req(
      port,
      'tok',
      'GET',
      `/console/memory/records?personId=${encodeURIComponent(p2)}&limit=10&cursor=${encodeURIComponent(d1.nextCursor!)}`,
    )
    assert.equal(page2.status, 200)
    const allIds = [...d1.items, ...(page2.json.data as { items: { id: string }[] }).items].map((r) => r.id)
    assert.deepEqual(allIds.sort(), [l0a.id, l0b.id, l1.id].sort())

    // Layer + channel filter
    const l1Only = await req(port, 'tok', 'GET', '/console/memory/records?layer=L1&channel=qq%3Agroup%3A1')
    assert.equal(l1Only.status, 200)
    assert.deepEqual((l1Only.json.data as { items: { id: string }[] }).items.map((r) => r.id), [l1.id])

    // Single record & dependents
    const recRes = await req(port, 'tok', 'GET', `/console/memory/records/${encodeURIComponent(l1.id)}`)
    assert.equal(recRes.status, 200)
    assert.equal((recRes.json.data as { id: string }).id, l1.id)

    const depRes = await req(port, 'tok', 'GET', `/console/memory/records/${encodeURIComponent(l0a.id)}/dependents`)
    assert.equal(depRes.status, 200)
    assert.deepEqual((depRes.json.data as { items: { id: string }[] }).items.map((r) => r.id), [l1.id])

    // Audit all & filtered
    const auditAll = await req(port, 'tok', 'GET', '/console/memory/audit')
    assert.equal(auditAll.status, 200)
    assert.equal((auditAll.json.data as { items: unknown[] }).items.length, 2)
    const auditOne = await req(port, 'tok', 'GET', `/console/memory/audit?recordId=${encodeURIComponent(l0a.id)}`)
    assert.equal(auditOne.status, 200)
    assert.equal((auditOne.json.data as { items: { recordId: string }[] }).items.length, 1)

    // Cross-channel get/put
    assert.deepEqual((await req(port, 'tok', 'GET', '/console/memory/cross-channel')).json.data, { mode: 'shadow' })
    const putMode = await req(port, 'tok', 'PUT', '/console/memory/cross-channel', { mode: 'on' })
    assert.equal(putMode.status, 200)
    assert.deepEqual(putMode.json.data, { mode: 'on' })
    assert.equal(crossChannelMode, 'on')

    // Persons list / merge / split
    const p3 = await brain.memory.identity.resolve('qq:333')
    const mergeRes = await req(port, 'tok', 'POST', '/console/memory/persons/merge', { from: p3, into: p2 })
    assert.equal(mergeRes.status, 200)
    assert.deepEqual(mergeRes.json.data, { ok: true })

    const personsList = await req(port, 'tok', 'GET', '/console/memory/persons')
    assert.equal(personsList.status, 200)
    const personsData = (personsList.json.data as { items: { personId: string; accounts: string[]; aliases: string[] }[] }).items
    assert.equal(personsData.length, 1)
    assert.equal(personsData[0]?.personId, p2)
    assert.deepEqual(personsData[0]?.accounts, ['qq:111', 'qq:222', 'qq:333'])
    assert.deepEqual(personsData[0]?.aliases, [p1, p3].sort())

    const splitRes = await req(port, 'tok', 'POST', `/console/memory/persons/${encodeURIComponent(p2)}/split`, { accounts: ['qq:333'] })
    assert.equal(splitRes.status, 200)
    const newId = (splitRes.json.data as { personId: string }).personId
    assert.ok(newId.startsWith('p_'))
    assert.notEqual(newId, p2)

    // (c) Satellite & pages
    const satSnap = await req(port, 'tok', 'GET', '/console/satellite')
    assert.equal(satSnap.status, 200)
    assert.deepEqual(satSnap.json.data, fakeSnapshot)

    assert.equal((await req(port, 'tok', 'POST', '/console/satellite/unknown/restart')).status, 400)
    assert.equal((await req(port, 'tok', 'POST', '/console/satellite/chat/restart')).status, 200)
    assert.equal((await req(port, 'tok', 'POST', '/console/satellite/activity/restart')).status, 200)
    assert.deepEqual(restarted, ['chat', 'activity'])

    const docRes = await req(port, 'tok', 'POST', '/console/satellite/doctor')
    assert.equal(docRes.status, 200)
    assert.deepEqual(docRes.json.data, { ok: true, checkedAt: now + 1, problems: [] })

    const pagesRes = await req(port, 'tok', 'GET', '/console/pages')
    assert.equal(pagesRes.status, 200)
    assert.deepEqual(pagesRes.json.data, { items: [{ pluginId: 'demo', id: 'main', title: 'Demo Page', entry: 'page.html' }] })
  } finally {
    await server.close()
    await brain.close()
  }
})

test('BrainError propagation check', () => {
  assert.ok(new BrainError('INVALID_ARGUMENT', 'x') instanceof BrainError)
})
