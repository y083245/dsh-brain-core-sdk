import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { removeTree } from '@brain-core/satellite-host'
import { BrainError } from '@brain-core/sdk'
import { FakeDeepSeek, type FakeScript } from '@brain-core/testkit'
import { buildSystemPrompt } from '../../src/agent-runtime/index.ts'
import { createKernel, type Kernel } from '../../src/assembly.ts'
import type { RuntimeSettings } from '../../src/contracts/index.ts'
import { createSettingsStore } from '../../src/runtime-stores/settings.ts'
import { createSecretStore } from '../../src/secrets/index.ts'
import { capturingLogger, FLASH, installPlugin, TOKEN, waitFor, type LogEntry } from './helpers.ts'

/** Builds an empty BVEC v1 binary header with the specified model name and dimension. */
function encodeBvecHeader(modelName: string, dimension: number, normalized = true): Uint8Array {
  const modelBytes = Buffer.from(modelName, 'utf8')
  const buf = Buffer.alloc(18 + modelBytes.length)
  buf.write('BVEC', 0, 'ascii')
  buf.writeUInt16LE(1, 4) // version
  buf.writeUInt16LE(normalized ? 1 : 0, 6) // flags
  buf.writeUInt32LE(dimension, 8)
  buf.writeUInt16LE(modelBytes.length, 12)
  modelBytes.copy(buf, 14)
  buf.writeUInt32LE(0, 14 + modelBytes.length) // recordCount = 0
  return new Uint8Array(buf)
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../')
const SAMPLE_PROVIDER_DIR = path.join(REPO_ROOT, 'plugins', 'memory-provider-sample')
const VECTOR_PROVIDER_DIR = path.join(REPO_ROOT, 'plugins', 'memory-vector')

async function startAuthProxy(targetUrl: string): Promise<{
  readonly url: string
  readonly seenKeys: string[]
  close(): Promise<void>
}> {
  const seenKeys: string[] = []
  const server: Server = createServer((req, res) => {
    if (req.method === 'POST' && req.url?.includes('/messages')) {
      const apiKey = req.headers['x-api-key']
      const auth = req.headers.authorization
      if (typeof apiKey === 'string' && apiKey !== '') seenKeys.push(apiKey)
      else if (typeof auth === 'string' && auth.startsWith('Bearer ')) seenKeys.push(auth.slice('Bearer '.length))
    }
    const upstream = httpRequest(`${targetUrl}${req.url ?? '/'}`, { method: req.method, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 500, answer.headers)
      answer.pipe(res)
    })
    upstream.on('error', () => { res.destroy() })
    req.pipe(upstream)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()) })
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    seenKeys,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
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

async function apiJson(kernel: Kernel, method: string, route: string, body?: unknown, token = TOKEN) {
  const res = await fetch(`http://127.0.0.1:${kernel.port}/api/v1${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function setupWithProxy(
  t: { after(fn: () => Promise<void>): void },
  options: {
    readonly script?: FakeScript
    readonly settings?: RuntimeSettings
    readonly apiKey?: string
    readonly brainApiKey?: string
    readonly roleCard?: string
    readonly now?: () => number
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brain-v1x2-e2e-'))
  const home = path.join(root, 'brain-home')
  const dshHome = path.join(root, 'dsh-home')
  await mkdir(path.join(home, 'state'), { recursive: true })
  await mkdir(dshHome, { recursive: true })
  await writeFile(path.join(dshHome, 'sentinel.json'), '{"owner":"main-dsh"}\n', 'utf8')

  const fake = new FakeDeepSeek(options.script ?? (() => ({ text: '好。' })))
  await fake.listen()
  const proxy = await startAuthProxy(fake.url)
  const holder: { kernel?: Kernel } = {}

  t.after(async () => {
    if (holder.kernel !== undefined) await holder.kernel.close()
    await proxy.close()
    await fake.close()
    await removeTree(root)
  })

  if (options.settings !== undefined) {
    await createSettingsStore(path.join(home, 'state', 'settings.json')).write(options.settings)
  }
  const secrets = createSecretStore({ file: path.join(home, 'state', 'secrets.json') })
  if (options.apiKey !== undefined) await secrets.set('deepseek-api-key', options.apiKey)
  if (options.brainApiKey !== undefined) await secrets.set('brain-deepseek-api-key', options.brainApiKey)

  const logs: LogEntry[] = []
  const kernel = await createKernel({
    env: { ...process.env, BRAIN_HOME: home, DSH_HOME: dshHome },
    userHome: home,
    port: 0,
    crossChannel: 'shadow',
    ownerChannels: ['sample:private:owner'],
    log: capturingLogger(logs),
    token: TOKEN,
    baseUrl: proxy.url,
    ...(options.now === undefined ? {} : { clock: { now: options.now } }),
  })
  holder.kernel = kernel
  if (options.roleCard !== undefined) {
    await kernel.memory.persona.saveRoleCard({ name: 'e2e-persona', text: options.roleCard })
  }

  return { root, home, dshHome, kernel, fake, proxy, logs }
}

test('1. FR-M19 recall-extras loop: neighbors, history without tombstones, legacy label, and byte-stable catalog', async (t) => {
  let now = 1_700_000_000_000
  const searchToolCalls: string[] = []
  let stage: 'consolidate' | 'wake' = 'consolidate'

  const { kernel, fake } = await setupWithProxy(t, {
    now: () => now,
    settings: { agents: { chat: { ...FLASH }, activity: { ...FLASH } } },
    apiKey: 'sk-test-recall',
    roleCard: '你是小满，性格温柔克制。',
    script: (req) => {
      if (stage === 'consolidate') {
        if (req.system.includes('一致性检查器')) return { text: '{"conflicts":[]}' }
        if (req.system.includes('L1→L2')) return { text: '{"l2Candidates":[]}' }
        return {
          text: JSON.stringify({
            l3Self: { stable: '温柔且记性好', data: { personaStyle: 'calm' } },
            l3Persons: [],
          }),
        }
      }
      if (req.raw.includes('"type":"tool_result"')) {
        searchToolCalls.push(req.raw)
        return { text: '查到了，你喜欢喝乌龙茶。' }
      }
      return {
        tool: 'memory__search',
        input: { query: '乌龙茶', scope: 'here', neighbors: 1, history: true },
      }
    },
  })

  const channel = 'sample:private:owner'
  const iden = { kind: 'kernel' as const, source: 'test', trust: 'owner' as const, defaultVisibility: 'owner' as const }

  // Three consecutive L0 records (t2 marked as legacy archive)
  const l0Before = await kernel.memory.service.ingest({
    kind: 'sample.message', channel, subjects: ['p_alice'], actor: 'p_alice',
    content: { text: '今天下午有点渴' }, tEvent: now + 100, idempotencyKey: 'm-1', visibility: 'open',
  }, iden)
  const l0Target = await kernel.memory.service.ingest({
    kind: 'sample.message', channel, subjects: ['p_alice'], actor: 'p_alice',
    content: { text: '我最近最爱喝冻顶乌龙茶', legacy: true }, tEvent: now + 200, idempotencyKey: 'm-2', visibility: 'open',
  }, iden)
  const l0After = await kernel.memory.service.ingest({
    kind: 'sample.message', channel, subjects: ['p_alice'], actor: 'p_alice',
    content: { text: '明天还要买一罐' }, tEvent: now + 300, idempotencyKey: 'm-3', visibility: 'open',
  }, iden)

  // L1 records with same key: outdated, tombstoned, active
  const l1Outdated = await kernel.memory.service.record({
    layer: 'L1', kind: 'l1.fact', channel, subjects: ['p_alice'], actor: 'p_alice',
    content: { key: 'favorite_tea', value: '绿茶', text: '之前喝绿茶' },
    evidence: [{ id: l0Before.id }], visibility: 'open', tEvent: now + 150,
  }, iden)
  await kernel.memory.service.update(l1Outdated.id, { status: 'outdated', validTo: now + 180 }, l1Outdated.version, iden, {
    caller: 'owner-console', channel, participants: [],
  })

  const l1Tombstoned = await kernel.memory.service.record({
    layer: 'L1', kind: 'l1.fact', channel, subjects: ['p_alice'], actor: 'p_alice',
    content: { key: 'favorite_tea', value: '秘密红茶', text: '不可泄露红茶' },
    evidence: [{ id: l0Before.id }], visibility: 'open', tEvent: now + 160,
  }, iden)
  await kernel.memory.service.forget({ by: 'record', id: l1Tombstoned.id })

  await kernel.memory.service.record({
    layer: 'L1', kind: 'l1.fact', channel, subjects: ['p_alice'], actor: 'p_alice',
    content: { key: 'favorite_tea', value: '乌龙茶', text: '最爱喝冻顶乌龙茶' },
    evidence: [{ id: l0Target.id }], visibility: 'open', tEvent: now + 220,
  }, iden)
  await kernel.memory.service.flush()

  // Settle L3 so Memory Catalog enters stable prefix cache
  now += 1_000
  assert.ok(kernel.memory.consolidation !== undefined)
  const proposal = await kernel.memory.consolidation.runShadow({ from: 0, to: now, force: true })
  await kernel.memory.consolidation.approveProposal(proposal.id)

  const snap1 = await kernel.memory.profiles.current()
  const snap2 = await kernel.memory.profiles.current()
  assert.equal(snap1.stable, snap2.stable)
  assert.equal(buildSystemPrompt(snap1.stable), buildSystemPrompt(snap2.stable))
  assert.ok(snap1.stable.includes('[记忆目录]'))
  assert.ok(snap1.stable.includes('favorite_tea'))
  assert.equal(snap1.stable.includes('冻顶乌龙茶'), false, 'catalog must only list key names, never values')

  // Run wake calling memory__search
  stage = 'wake'
  const wakeRes = await kernel.agent.wake(channel, {
    reason: 'message',
    messages: [{ id: l0After.id, actor: 'p_alice', name: 'Alice', text: '查一下茶叶', tEvent: now + 500 }],
  })
  assert.equal(wakeRes.acked, true)
  assert.ok(searchToolCalls.length > 0)
  const toolPayload = searchToolCalls[0]!
  assert.ok(toolPayload.includes('今天下午有点渴'), 'before neighbor included')
  assert.ok(toolPayload.includes('明天还要买一罐'), 'after neighbor included')
  assert.ok(toolPayload.includes('之前喝绿茶'), 'outdated history included')
  assert.equal(toolPayload.includes('秘密红茶'), false, 'tombstoned history must never appear')
  assert.ok(toolPayload.includes('旧系统历史存档'), 'legacy L0 tone warning label appended')
  assert.ok(fake.requests.some((r) => r.system.includes('[记忆目录]')))
})

test('2. FR-P10, FR-G06, D17 loop: ctx.llm permissions, accounting ledger, D17 key priority, and HTTP routes', async (t) => {
  const { root, kernel, proxy, logs } = await setupWithProxy(t, {
    settings: { agents: { chat: { ...FLASH }, activity: { ...FLASH } } },
    apiKey: 'sk-shared-key-11111111',
    roleCard: '你是小满，说话简洁。',
    script: () => ({ text: '分析完成。' }),
  })

  // Build two temporary plugins: one with llm.invoke, one without.
  const pluginOkDir = path.join(root, 'plugin-llm-ok')
  const pluginNoDir = path.join(root, 'plugin-llm-no')
  await mkdir(pluginOkDir, { recursive: true })
  await mkdir(pluginNoDir, { recursive: true })

  await writeFile(path.join(pluginOkDir, 'package.json'), JSON.stringify({
    name: 'test-llm-ok',
    version: '1.0.0',
    private: true,
    type: 'module',
    main: 'index.js',
    brain: {
      id: 'llm-ok',
      kinds: ['capability'],
      api: '^1.0.0',
      runtime: 'node',
      permissions: ['llm.invoke'],
    },
  }))
  await writeFile(path.join(pluginOkDir, 'index.js'), `
    export async function apply(ctx) {
      ctx.http.route('POST', '/ask', async (req) => {
        const user = typeof req.body?.q === 'string' ? req.body.q : 'hello'
        return await ctx.llm.complete({ system: 'helper', user, maxOutputTokens: 64 })
      })
    }
  `)

  await writeFile(path.join(pluginNoDir, 'package.json'), JSON.stringify({
    name: 'test-llm-no',
    version: '1.0.0',
    private: true,
    type: 'module',
    main: 'index.js',
    brain: {
      id: 'llm-no',
      kinds: ['capability'],
      api: '^1.0.0',
      runtime: 'node',
      permissions: [],
    },
  }))
  await writeFile(path.join(pluginNoDir, 'index.js'), `
    export async function apply(ctx) {
      ctx.http.route('POST', '/ask', async () => {
        return await ctx.llm.complete({ system: 'helper', user: 'hi', maxOutputTokens: 64 })
      })
    }
  `)

  await installPlugin(kernel, pluginOkDir, 'llm-ok')
  await installPlugin(kernel, pluginNoDir, 'llm-no')

  // Unapproved plugin -> 403 PERMISSION_DENIED
  const denied = await apiJson(kernel, 'POST', '/plugins/llm-no/ask', {})
  assert.equal(denied.status, 403)
  assert.equal((denied.body.error as { code: string }).code, 'PERMISSION_DENIED')

  // Approved plugin -> 200, uses shared key first
  const ok1 = await apiJson(kernel, 'POST', '/plugins/llm-ok/ask', { q: '第一问' })
  assert.equal(ok1.status, 200)
  assert.equal((ok1.body.data as { text: string }).text, '分析完成。')
  assert.ok(proxy.seenKeys.includes('sk-shared-key-11111111'))

  // Summary shows sharedQuotaWarning: true and plugin:llm-ok attribution
  const sum1 = await apiJson(kernel, 'GET', '/console/accounting/summary?days=7')
  assert.equal(sum1.status, 200)
  const s1Data = sum1.body.data as {
    sharedQuotaWarning: boolean
    todayTokens: number
    byPlugin: Array<{ owner: string; pluginId?: string; calls: number; costMicros: number }>
  }
  assert.equal(s1Data.sharedQuotaWarning, true)
  assert.ok(s1Data.todayTokens > 0)
  const pluginRow = s1Data.byPlugin.find((row) => row.owner === 'plugin:llm-ok')
  assert.ok(pluginRow !== undefined)
  assert.equal(pluginRow.pluginId, 'llm-ok')
  assert.equal(pluginRow.calls, 1)

  // D17: setting brain-deepseek-api-key takes precedence over deepseek-api-key
  await kernel.secrets.set('brain-deepseek-api-key', 'sk-dedicated-key-22222222')
  kernel.runner.invalidate('activity')
  kernel.runner.invalidate('chat')

  const ok2 = await apiJson(kernel, 'POST', '/plugins/llm-ok/ask', { q: '第二问' })
  assert.equal(ok2.status, 200)
  assert.equal(proxy.seenKeys.at(-1), 'sk-dedicated-key-22222222')

  // Chat wake also records agent:chat usage into accounting
  const l0 = await kernel.memory.service.ingest({
    kind: 'sample.message', channel: 'sample:private:owner', subjects: ['p1'], actor: 'p1',
    content: { text: '你好呀' }, tEvent: Date.now(), idempotencyKey: 'acc-wake-1',
  }, { kind: 'kernel', source: 'test', trust: 'owner', defaultVisibility: 'owner' })
  await kernel.agent.wake('sample:private:owner', {
    reason: 'message',
    messages: [{ id: l0.id, actor: 'p1', name: '小明', text: '你好呀', tEvent: Date.now() }],
  })

  // Prices & Budget HTTP routes
  const pricesGet = await apiJson(kernel, 'GET', '/console/accounting/prices')
  assert.equal(pricesGet.status, 200)
  const pricesPut = await apiJson(kernel, 'PUT', '/console/accounting/prices', {
    version: 1,
    currency: 'CNY',
    models: {
      'deepseek-official/deepseek-flash': {
        inputPerMillion: 2,
        outputPerMillion: 4,
        cacheReadPerMillion: 0.2,
        cacheWritePerMillion: 2,
      },
    },
  })
  assert.equal(pricesPut.status, 200)

  const sum2 = await apiJson(kernel, 'GET', '/console/accounting/summary?days=30')
  assert.equal(sum2.status, 200)
  const s2Data = sum2.body.data as {
    sharedQuotaWarning: boolean
    byPlugin: Array<{ owner: string; calls: number }>
    dailyTrend: unknown[]
  }
  assert.equal(s2Data.sharedQuotaWarning, false)
  assert.ok(s2Data.byPlugin.some((r) => r.owner === 'plugin:llm-ok' && r.calls === 2))
  assert.ok(s2Data.byPlugin.some((r) => r.owner === 'agent:chat' && r.calls === 1))
  assert.ok(s2Data.dailyTrend.length >= 1)

  // Set per-plugin dailyCallsLimit to 2 -> 3rd call hits 429 RATE_LIMITED
  const budgetPut = await apiJson(kernel, 'PUT', '/console/accounting/budget', {
    pluginLimits: { 'llm-ok': { dailyCallsLimit: 2 } },
  })
  assert.equal(budgetPut.status, 200)

  const rateLimited = await apiJson(kernel, 'POST', '/plugins/llm-ok/ask', { q: '超限' })
  assert.equal(rateLimited.status, 429)
  assert.equal((rateLimited.body.error as { code: string }).code, 'RATE_LIMITED')

  // Verify no secret strings leaked in summary or logs
  const serializedAll = JSON.stringify(sum2.body) + JSON.stringify(logs)
  assert.equal(serializedAll.includes('sk-shared-key-11111111'), false)
  assert.equal(serializedAll.includes('sk-dedicated-key-22222222'), false)
})

test('3. FR-D07 loop: memory-provider-sample + memory-vector fusion, S7 forget, A5 degradation, and EMBEDDING_MISMATCH', async (t) => {
  const { home, kernel } = await setupWithProxy(t)

  // Install both real plugins: out-of-process sample + in-process quantized vector plugin
  await installPlugin(kernel, SAMPLE_PROVIDER_DIR, 'memory-provider-sample')
  await installPlugin(kernel, VECTOR_PROVIDER_DIR, 'memory-vector')

  const healthOk = await apiJson(kernel, 'GET', '/memory/health')
  assert.equal(healthOk.status, 200)
  assert.deepEqual(healthOk.body.data, { store: 'ok', index: 'ok', jobs: 'ok', provider: 'ok' })

  const l0 = await kernel.memory.service.ingest({
    kind: 'sample.message',
    channel: 'sample:private:u1',
    subjects: ['p_alice'],
    actor: 'p_alice',
    content: { text: '记住：最爱喝桂花乌龙' },
    tEvent: Date.now(),
    idempotencyKey: 'mp-e2e-1',
    visibility: 'open',
  }, { kind: 'kernel', source: 'test', trust: 'owner', defaultVisibility: 'owner' })

  // Wait for out-of-process memory-provider-sample to derive l1.candidate via writeDerived
  const derived = await waitFor(async () => {
    const page = await kernel.memory.store.list({ layers: ['L1'], kinds: ['l1.candidate'] }, { limit: 10 })
    return page.items.find((r) => r.source === 'memory-provider-sample')
  }, 10_000, 'derived l1.candidate from memory-provider-sample')

  assert.equal(derived.layer, 'L1')
  assert.equal(derived.kind, 'l1.candidate')
  assert.equal(derived.source, 'memory-provider-sample')
  assert.equal(derived.actor, 'memory-provider-sample')
  assert.equal(derived.trust, 'external')
  assert.equal(derived.content.text, '最爱喝桂花乌龙')

  // Wait until both providers have indexed l0.id and search returns it cleanly
  const search1 = await waitFor(async () => {
    const res = await apiJson(kernel, 'POST', '/memory/search', { query: '桂花乌龙', scope: 'all' })
    const items = (res.body.data as { items: Array<{ record: { id: string } }> }).items
    return items.some((hit) => hit.record.id === l0.id) ? res : undefined
  }, 10_000, 'fused search hit for L0')
  assert.equal(search1.status, 200)
  assert.equal((search1.body.meta as { degraded?: boolean }).degraded, false)

  // S7 forget sync: deleting L0 cascades to L1 and notifies both providers
  const forgetRes = await apiJson(kernel, 'POST', '/memory/forget', { by: 'record', id: l0.id })
  assert.equal(forgetRes.status, 200)
  const searchAfterForget = await apiJson(kernel, 'POST', '/memory/search', { query: '桂花乌龙', scope: 'all' })
  assert.equal((searchAfterForget.body.data as { items: unknown[] }).items.length, 0)

  // A5 graceful degradation: a failing provider degrades search without breaking keyword recall
  await kernel.memory.service.ingest({
    kind: 'sample.message',
    channel: 'sample:private:u1',
    subjects: ['p_alice'],
    actor: 'p_alice',
    content: { text: '关键字天文望远镜测试' },
    tEvent: Date.now(),
    idempotencyKey: 'mp-e2e-2',
    visibility: 'open',
  }, { kind: 'kernel', source: 'test', trust: 'owner', defaultVisibility: 'owner' })
  await kernel.memory.service.flush()

  const disposeBroken = kernel.providers.register('broken-probe', {
    async search() { throw new Error('provider offline') },
    async onForgotten() {},
  })
  const degradedRes = await apiJson(kernel, 'POST', '/memory/search', { query: '望远镜', scope: 'all' })
  assert.equal(degradedRes.status, 200)
  assert.equal((degradedRes.body.meta as { degraded?: boolean }).degraded, true)
  assert.ok((degradedRes.body.data as { items: unknown[] }).items.length >= 1)
  disposeBroken()

  // EMBEDDING_MISMATCH: replace stored vectors.bvec with mismatched dimension and re-enable memory-vector
  await kernel.plugins.disable('memory-vector')
  const vecStorageDir = path.join(home, 'state', 'plugins', 'memory-vector')
  await mkdir(vecStorageDir, { recursive: true })
  await writeFile(path.join(vecStorageDir, 'vectors.bvec'), encodeBvecHeader('other-model', 128, true))
  await writeFile(path.join(vecStorageDir, 'meta.json'), JSON.stringify({ version: 1, records: {} }), 'utf8')

  await kernel.plugins.enable('memory-vector')
  const mismatchSearch = await apiJson(kernel, 'POST', '/memory/search', { query: '望远镜', scope: 'all' })
  assert.equal(mismatchSearch.status, 503)
  assert.equal((mismatchSearch.body.error as { code: string }).code, 'EMBEDDING_MISMATCH')
  await assert.rejects(
    () => kernel.memory.service.search({ query: '望远镜', scope: 'all' }, { caller: 'owner-console', channel: null, participants: [] }),
    (e: unknown) => e instanceof BrainError && e.code === 'EMBEDDING_MISMATCH',
  )
})

test('4. FR-A06, FR-A07, FR-S11 loop: AMP aliases toggle, read-only MCP loopback, --patch YAML, and zero DSH_HOME writes', async (t) => {
  const { dshHome, kernel, fake } = await setupWithProxy(t, {
    settings: { agents: { chat: { ...FLASH }, activity: { ...FLASH } } },
    apiKey: 'sk-interop-key',
    roleCard: '你是小满，记忆清晰。',
    script: (req) => {
      if (req.raw.includes('"type":"tool_result"')) {
        return { text: 'AMP 检索完成。' }
      }
      return { tool: 'amp__recall', input: { query: '咖啡', scope: 'here' } }
    },
  })

  const dshBefore = await hashTree(dshHome)

  // Default off: 6 core/memory builtins, no AMP tools, MCP off
  assert.equal(kernel.gateway.catalog().some((tool) => tool.name.startsWith('amp__')), false)
  const initialInterop = await apiJson(kernel, 'GET', '/console/interop')
  assert.equal(initialInterop.status, 200)
  assert.deepEqual(initialInterop.body.data, {
    ampAliases: false,
    mcp: { enabled: false, running: false },
    debugView: { running: false },
  })

  // Enable AMP aliases
  const ampOn = await apiJson(kernel, 'PUT', '/console/interop/amp', { enabled: true })
  assert.equal(ampOn.status, 200)
  assert.equal((ampOn.body.data as { ampAliases: boolean }).ampAliases, true)
  for (const name of ['amp__recall', 'amp__encode', 'amp__forget', 'amp__pin', 'amp__consolidate', 'amp__stats']) {
    assert.ok(kernel.gateway.catalog().some((tool) => tool.name === name), `missing ${name}`)
  }

  // Seed record and run wake invoking amp__recall
  const l0 = await kernel.memory.service.ingest({
    kind: 'sample.message', channel: 'sample:private:owner', subjects: ['p1'], actor: 'p1',
    content: { text: '今天喝了一杯手冲咖啡' }, tEvent: Date.now(), idempotencyKey: 'amp-l0-1', visibility: 'open',
  }, { kind: 'kernel', source: 'test', trust: 'owner', defaultVisibility: 'owner' })
  await kernel.memory.service.flush()

  const wakeRes = await kernel.agent.wake('sample:private:owner', {
    reason: 'message',
    messages: [{ id: l0.id, actor: 'p1', name: '小明', text: '我刚才喝了什么', tEvent: Date.now() }],
  })
  assert.equal(wakeRes.acked, true)
  assert.ok(fake.requests.some((r) => r.tools.includes('amp__recall')))

  // Enable read-only MCP via console route
  const mcpOn = await apiJson(kernel, 'PUT', '/console/interop/mcp', { enabled: true })
  assert.equal(mcpOn.status, 200)
  const mcpStatus = (mcpOn.body.data as {
    mcp: { enabled: boolean; running: boolean; url?: string; port?: number; patchYaml?: string }
  }).mcp
  assert.equal(mcpStatus.enabled, true)
  assert.equal(mcpStatus.running, true)
  assert.ok(typeof mcpStatus.url === 'string' && mcpStatus.url.startsWith('http://127.0.0.1:'))
  assert.ok(typeof mcpStatus.patchYaml === 'string')
  assert.match(mcpStatus.patchYaml, /@deepseek-ai\/dsh-mcp-client/)
  assert.match(mcpStatus.patchYaml, /serverName: brain_memory/)

  const urlMatch = /url:\s*"([^"]+)"/.exec(mcpStatus.patchYaml)
  const authMatch = /Authorization:\s*"Bearer ([^"]+)"/.exec(mcpStatus.patchYaml)
  assert.ok(urlMatch !== null && authMatch !== null)
  const mcpUrl = urlMatch[1]!
  const mcpToken = authMatch[1]!

  // Exercise MCP JSON-RPC protocol over loopback
  const mcpCall = async (payload: Record<string, unknown>, tokenOverride = mcpToken) => {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenOverride}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    return { status: res.status, text: await res.text() }
  }

  assert.equal((await mcpCall({ jsonrpc: '2.0', id: 1, method: 'initialize' }, 'wrong-token')).status, 401)
  const init = await mcpCall({ jsonrpc: '2.0', id: 1, method: 'initialize' })
  assert.equal(init.status, 200)
  assert.equal(JSON.parse(init.text).result.serverInfo.name, 'brain-memory')

  const notif = await mcpCall({ jsonrpc: '2.0', method: 'notifications/initialized' })
  assert.equal(notif.status, 202)

  const listed = await mcpCall({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const toolNames = (JSON.parse(listed.text).result.tools as Array<{ name: string }>).map((x) => x.name)
  assert.deepEqual(toolNames, ['memory_search', 'memory_profile', 'memory_stats', 'amp_recall', 'amp_stats'])

  const called = await mcpCall({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'memory_search', arguments: { query: '咖啡', scope: 'all' } },
  })
  const calledJson = JSON.parse(called.text)
  assert.equal(calledJson.result.isError, undefined)
  assert.ok(calledJson.result.content[0].text.includes('手冲咖啡'))

  // Write tool is rejected as unknown
  const writeAttempt = await mcpCall({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'memory_forget', arguments: { id: l0.id } },
  })
  assert.equal(JSON.parse(writeAttempt.text).error.code, -32601)

  // Disable MCP -> stops cleanly
  const mcpOff = await apiJson(kernel, 'PUT', '/console/interop/mcp', { enabled: false })
  assert.equal(mcpOff.status, 200)
  assert.equal((mcpOff.body.data as { mcp: { running: boolean } }).mcp.running, false)

  // Fake DSH_HOME has zero modifications
  const dshAfter = await hashTree(dshHome)
  assert.deepEqual(dshAfter, dshBefore)
})
