import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { createKernel } from '@dsh-brain-core/kernel/assembly'
import { runDoctor } from '@dsh-brain-core/kernel/isolation-doctor'
import { encodeSessionId, removeTree } from '@dsh-brain-core/satellite-host'
import type { Envelope, WakeResult } from '@dsh-brain-core/sdk'
import { createUlid } from '@dsh-brain-core/shared'
import { FakeDeepSeek } from '@dsh-brain-core/testkit'
import {
  CONSOLE_CHAT_DIR, FLASH_LOW, TEST_TOKEN, assertUnwrappedOk, capturingLogger,
  closeHttpServer, createFakeMainDshHome, hasToolResultInLastMessage, httpJson,
  installAndEnablePlugin, setupAcceptanceKernel,
} from './helpers.ts'

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0)
const DAY_MS = 86_400_000
const L0_COUNT = 100_000
const L1_COUNT = 10_000
const CHANNELS = 200
const PEOPLE = 500

function percentile(samples: readonly number[], q: number): number {
  const sorted = [...samples].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[index] ?? 0
}

function median(samples: readonly number[]): number {
  return percentile(samples, 0.5)
}

function channelOf(index: number): string {
  return `perf:group:${index % CHANNELS}`
}

function personOf(index: number): string {
  return `p_${String(index % PEOPLE).padStart(3, '0')}`
}

function seedBulkSqlite(dbPath: string): void {
  const nextId = createUlid({ now: () => NOW })
  const db = new DatabaseSync(dbPath)
  try {
    const insertRecord = db.prepare(`INSERT INTO records (
      id, layer, kind, source, channel, actor, subjects, content, evidence,
      visibility, trust, confidence, importance, t_event, t_ingest, status,
      valid_from, valid_to, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    const insertSubject = db.prepare('INSERT OR IGNORE INTO record_subjects (record_id, subject) VALUES (?, ?)')
    const insertEdge = db.prepare('INSERT OR IGNORE INTO evidence_edges (record_id, evidence_id) VALUES (?, ?)')

    db.exec('BEGIN IMMEDIATE')
    const l0Ids: string[] = []
    for (let i = 0; i < L0_COUNT; i += 1) {
      const id = `l0_${nextId()}`
      l0Ids.push(id)
      const ch = channelOf(i)
      const actor = i < 20 ? 'self' : 'p_peer'
      const tEvent = NOW - Math.floor((i / L0_COUNT) * 30 * DAY_MS)
      const content = JSON.stringify({ text: `第${i}条消息 walrus 编号${i % 997}` })
      insertRecord.run(
        id, 'L0', 'l0.message', 'plugin.perf', ch, actor, '[]', content, '[]',
        'open', 'owner', 1, 0.5, tEvent, NOW, 'active', null, null, 1,
      )
    }
    for (let i = 0; i < L1_COUNT; i += 1) {
      const id = `l1_${nextId()}`
      const ch = channelOf(i * 7)
      const subj = personOf(i)
      const evId = l0Ids[(i * 10) % l0Ids.length]!
      const tEvent = NOW - Math.floor((i / L1_COUNT) * 30 * DAY_MS)
      const subjectsJson = JSON.stringify([subj])
      const evidenceJson = JSON.stringify([{ id: evId }])
      const content = JSON.stringify({ text: `事实${i} walrus 编号${i % 997}` })
      insertRecord.run(
        id, 'L1', 'l1.fact', 'plugin.perf', ch, 'owner', subjectsJson, content, evidenceJson,
        'open', 'owner', 0.8, (i % 100) / 100, tEvent, NOW, 'active', null, null, 1,
      )
      insertSubject.run(id, subj)
      insertEdge.run(id, evId)
    }
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* ignore */ }
    throw error
  } finally {
    db.close()
  }
}

async function runMainDshStreamBenchmark(streamUrl: string, runs: number): Promise<readonly number[]> {
  const samples: number[] = []
  // 3 warmup runs
  for (let i = 0; i < 3; i += 1) {
    const res = await fetch(streamUrl)
    await res.text()
  }
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now()
    const res = await fetch(streamUrl)
    const reader = res.body?.getReader()
    assert.ok(reader !== undefined)
    const first = await reader.read()
    assert.equal(first.done, false)
    samples.push(performance.now() - started)
    while (!(await reader.read()).done) {
      // drain
    }
  }
  return samples
}

test('AT-6 smoke: real SQLite ingest, /context, gateway dispatch, and main DSH isolation stay fast', async (t) => {
  const dshRoot = await mkdtemp(path.join(os.tmpdir(), 'brain-at6-smoke-dsh-'))
  t.after(async () => { await removeTree(dshRoot) })
  const fakeMain = await createFakeMainDshHome(dshRoot)
  const snapshotFile = path.join(dshRoot, 'snapshot.json')
  await runDoctor({ mode: 'snapshot', dshHome: fakeMain.dshHome, file: snapshotFile })

  const h = await setupAcceptanceKernel(t, {
    dshHome: fakeMain.dshHome,
    crossChannel: 'on',
    clock: { now: () => NOW },
  })

  const writeId = { kind: 'kernel', source: 'perf', trust: 'owner', defaultVisibility: 'open' } as const
  const ingestSamples: number[] = []
  for (let i = 0; i < 30; i += 1) {
    const start = performance.now()
    await h.kernel.memory.service.ingest({
      kind: 'perf.msg',
      channel: 'perf:group:1',
      subjects: ['p_001'],
      actor: 'p_001',
      content: { text: `smoke message ${i} walrus` },
      tEvent: NOW - i * 1000,
      idempotencyKey: `smoke-${i}`,
    }, writeId)
    ingestSamples.push(performance.now() - start)
  }
  await h.kernel.memory.service.flush()

  const ctxStart = performance.now()
  const bundle = await h.kernel.memory.service.context(
    { channel: 'perf:group:1', query: 'walrus' },
    { caller: 'agent', channel: 'perf:group:1', participants: ['p_001'] },
  )
  const ctxMs = performance.now() - ctxStart
  assert.ok(bundle.blocks.length === 8)

  const sessionId = encodeSessionId({ agentClass: 'chat', channel: 'perf:group:1', generation: 0 })
  h.kernel.gateway.planWake({
    sessionId,
    wakeId: 'smoke-wake',
    features: { message: { hasMedia: false, hasForward: false }, event: { poke: false }, channel: { kind: 'group' } },
    mode: 'addition-only',
    silent: false,
    participants: ['p_001'],
    evidence: [],
    peerTexts: [],
  })
  const gwStart = performance.now()
  await h.kernel.gateway.dispatch({ sessionId, toolName: 'tools__search', args: { query: '记忆' } })
  const gwMs = performance.now() - gwStart
  h.kernel.gateway.endWake(sessionId)

  const check = await runDoctor({ mode: 'check', dshHome: fakeMain.dshHome })
  assert.equal(check.kind, 'check')
  assert.equal(check.ok, true)

  await h.kernel.close()
  await removeTree(path.join(h.brainHome, 'state', 'satellite'))
  const cmp = await runDoctor({ mode: 'compare', dshHome: fakeMain.dshHome, file: snapshotFile })
  assert.equal(cmp.kind, 'compare')
  assert.equal(cmp.unchanged, true)

  console.log(
    `AT-6 smoke: ingest p95=${percentile(ingestSamples, 0.95).toFixed(2)}ms, context=${ctxMs.toFixed(2)}ms, gateway=${gwMs.toFixed(2)}ms`,
  )
})

test('PERF: AT-6: NFR-01 and NFR-02 full benchmark', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brain-at6-perf-'))
  t.after(async () => { await removeTree(root) })

  const brainHome = path.join(root, 'brain-home')
  const fakeMain = await createFakeMainDshHome(root)
  const snapshotFile = path.join(root, 'dsh-snapshot.json')
  await runDoctor({ mode: 'snapshot', dshHome: fakeMain.dshHome, file: snapshotFile })

  // Mock main-DSH coding/streaming response server (15ms pre-processing + 2-chunk SSE stream)
  const dshMockServer = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    setTimeout(() => {
      res.write('data: {"token":"first"}\n\n')
      res.end('data: [DONE]\n\n')
    }, 15)
  })
  await new Promise<void>((resolve) => {
    dshMockServer.listen(0, '127.0.0.1', () => resolve())
  })
  const dshStreamUrl = `http://127.0.0.1:${(dshMockServer.address() as AddressInfo).port}/stream`
  t.after(async () => { await closeHttpServer(dshMockServer) })

  // NFR-02 baseline (Brain off)
  const baselineSamples = await runMainDshStreamBenchmark(dshStreamUrl, 20)
  const baselineMedian = median(baselineSamples)

  // Step 1: initialize SQLite schema via createKernel, close, bulk-load 100k L0 + 10k L1, then reopen
  const fake = new FakeDeepSeek((req) => (
    hasToolResultInLastMessage(req)
      ? { text: '好。' }
      : { tool: 'console-chat__send_message', input: { text: `压测回复${req.messageCount}` } }
  ))
  await fake.listen()
  t.after(async () => { await fake.close() })

  const env = { ...process.env, BRAIN_HOME: brainHome, DSH_HOME: fakeMain.dshHome }
  const initialKernel = await createKernel({
    env,
    userHome: brainHome,
    port: 0,
    crossChannel: 'on',
    clock: { now: () => NOW },
    log: capturingLogger([]),
    token: TEST_TOKEN,
    baseUrl: fake.url,
  })
  await initialKernel.close()

  const recordsDbPath = path.join(brainHome, 'state', 'memory', 'records.db')
  const indexDbPath = path.join(brainHome, 'state', 'memory', 'index.db')
  seedBulkSqlite(recordsDbPath)
  await removeTree(indexDbPath)
  await removeTree(`${indexDbPath}-wal`)
  await removeTree(`${indexDbPath}-shm`)

  const kernel = await createKernel({
    env,
    userHome: brainHome,
    port: 0,
    crossChannel: 'on',
    clock: { now: () => NOW },
    log: capturingLogger([]),
    token: TEST_TOKEN,
    baseUrl: fake.url,
  })
  t.after(async () => { await kernel.close() })

  // Wait for initial FTS5 index rebuild over 110,000 records
  await kernel.memory.jobs.idle()

  // Populate channel members for perf:group:3
  kernel.memory.channels.setMembers(channelOf(3), [personOf(0), personOf(1), personOf(2)])

  // NFR-01a: 200 ingest calls
  const writeIdentity = { kind: 'kernel', source: 'plugin.perf', trust: 'owner', defaultVisibility: 'open' } as const
  const ingestDurations: number[] = []
  for (let i = 0; i < 200; i += 1) {
    const started = performance.now()
    await kernel.memory.service.ingest({
      kind: 'l0.message',
      channel: channelOf(i),
      subjects: [personOf(i)],
      actor: 'p_peer',
      content: { text: `增量写入第 ${i} 条 walrus` },
      tEvent: NOW + i,
      idempotencyKey: `nfr01-ingest-${i}`,
    }, writeIdentity)
    ingestDurations.push(performance.now() - started)
  }
  await kernel.memory.service.flush()
  const ingestP95 = percentile(ingestDurations, 0.95)
  const ingestBudget = process.platform === 'win32' ? 8 : 5

  // NFR-01b: 50 /context calls
  const contextDurations: number[] = []
  const viewer = {
    caller: 'agent',
    channel: channelOf(3),
    participants: [personOf(0), personOf(1), personOf(2)],
  }
  for (let i = 0; i < 50; i += 1) {
    const started = performance.now()
    const bundle = await kernel.memory.service.context({ channel: channelOf(3), query: 'walrus' }, viewer)
    contextDurations.push(performance.now() - started)
    assert.equal(bundle.blocks.length, 8)
  }
  const contextP95 = percentile(contextDurations, 0.95)

  // NFR-01c: 200 gateway dispatch calls
  const gatewaySession = encodeSessionId({ agentClass: 'chat', channel: channelOf(3), generation: 0 })
  kernel.gateway.planWake({
    sessionId: gatewaySession,
    wakeId: 'nfr01-gw-wake',
    features: { message: { hasMedia: false, hasForward: false }, event: { poke: false }, channel: { kind: 'group' } },
    mode: 'addition-only',
    silent: false,
    participants: [personOf(0)],
    evidence: [],
    peerTexts: [],
  })
  const dispatchDurations: number[] = []
  for (let i = 0; i < 200; i += 1) {
    const started = performance.now()
    await kernel.gateway.dispatch({
      sessionId: gatewaySession,
      toolName: 'memory__search',
      args: { query: '编号1', scope: 'here', limit: 5 },
    })
    dispatchDurations.push(performance.now() - started)
  }
  kernel.gateway.endWake(gatewaySession)
  const dispatchP95 = percentile(dispatchDurations, 0.95)

  console.log(
    `AT-6 NFR-01 (100k L0 + 10k L1): ingest p95=${ingestP95.toFixed(3)}ms (budget ${ingestBudget}ms), `
    + `context p95=${contextP95.toFixed(2)}ms (budget 300ms), `
    + `gateway dispatch p95=${dispatchP95.toFixed(3)}ms (budget 10ms)`,
  )
  assert.ok(ingestP95 <= ingestBudget, `ingest p95 ${ingestP95.toFixed(3)}ms exceeded ${ingestBudget}ms`)
  assert.ok(contextP95 <= 300, `context p95 ${contextP95.toFixed(2)}ms exceeded 300ms`)
  assert.ok(dispatchP95 <= 10, `gateway dispatch p95 ${dispatchP95.toFixed(3)}ms exceeded 10ms`)

  // NFR-02 co-running benchmark: Brain running background console-chat wakes + memory searches
  await kernel.settings.write({ agents: { chat: { ...FLASH_LOW } }, timezone: 'UTC' })
  await kernel.secrets.set('deepseek-api-key', 'fake-at6-key')
  await kernel.memory.persona.saveRoleCard({ name: 'at6-persona', text: '你是小满。' })
  await installAndEnablePlugin(kernel, CONSOLE_CHAT_DIR, 'console-chat')

  let bgRunning = true
  const bgLoop = (async () => {
    let idx = 0
    while (bgRunning) {
      idx += 1
      await httpJson<Envelope<{ readonly wake: WakeResult }>>(
        kernel.port,
        'POST',
        '/api/v1/plugins/console-chat/messages',
        {
          token: TEST_TOKEN,
          body: {
            channel: `console-chat:private:u${(idx % 5) + 1}`,
            account: `u${(idx % 5) + 1}`,
            text: `并跑消息 ${idx} walrus`,
            messageId: `bg-${idx}`,
            debounceMs: 0,
          },
        },
      ).then((r) => assertUnwrappedOk(r.body))
      await kernel.memory.service.search({ query: 'walrus', scope: 'all', limit: 10 }, viewer)
    }
  })()

  let corunSamples: readonly number[]
  try {
    corunSamples = await runMainDshStreamBenchmark(dshStreamUrl, 20)
  } finally {
    bgRunning = false
    await bgLoop
  }

  const corunMedian = median(corunSamples)
  const overheadPct = ((corunMedian - baselineMedian) / baselineMedian) * 100
  console.log(
    `AT-6 NFR-02: main DSH first-token median baseline=${baselineMedian.toFixed(2)}ms, `
    + `co-running=${corunMedian.toFixed(2)}ms, delta=${overheadPct.toFixed(2)}%`,
  )

  const midCheck = await runDoctor({ mode: 'check', dshHome: fakeMain.dshHome })
  assert.equal(midCheck.kind, 'check')
  assert.equal(midCheck.ok, true)

  await kernel.close()
  await removeTree(path.join(brainHome, 'state', 'satellite'))
  const afterCompare = await runDoctor({ mode: 'compare', dshHome: fakeMain.dshHome, file: snapshotFile })
  assert.equal(afterCompare.kind, 'compare')
  assert.equal(afterCompare.unchanged, true)
})
