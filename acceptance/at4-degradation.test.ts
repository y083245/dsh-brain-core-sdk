import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { killProcessTree } from '@brain-core/satellite-host'
import type { Envelope, SearchHit, WakeResult } from '@brain-core/sdk'
import {
  CONSOLE_CHAT_DIR, FLASH_LOW, assertUnwrappedOk, extractLatestWakeText,
  hasToolResultInLastMessage, httpJson, installAndEnablePlugin, setupAcceptanceKernel,
  waitFor, waitForSatellitePid,
} from './helpers.ts'

async function createMemoryEnhancerFixture(rootDir: string): Promise<string> {
  const dir = path.join(rootDir, 'memory-enhancer-fixture')
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'brain-plugin-memory-enhancer',
      version: '1.0.0',
      private: true,
      type: 'module',
      main: 'index.js',
      brain: {
        id: 'memory-enhancer',
        kinds: ['memory-provider'],
        api: '^1.0.0',
        runtime: 'node',
        permissions: ['memory.search'],
      },
    }, null, 2),
    'utf8',
  )
  await writeFile(path.join(dir, 'index.js'), 'export async function apply() {}\n', 'utf8')
  return dir
}

async function createExternalProbeFixture(rootDir: string): Promise<string> {
  const dir = path.join(rootDir, 'extprobe-fixture')
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'brain-plugin-extprobe',
      version: '1.0.0',
      private: true,
      type: 'module',
      main: 'index.js',
      brain: {
        id: 'extprobe',
        kinds: ['capability'],
        api: '^1.0.0',
        runtime: 'process',
        process: { command: process.execPath, args: ['index.js'] },
        permissions: ['tools.register'],
        tools: [
          {
            name: 'ping',
            effect: 'read',
            load: 'core',
            summary: 'Check external plugin liveness',
          },
        ],
      },
    }, null, 2),
    'utf8',
  )
  await writeFile(
    path.join(dir, 'index.js'),
    `import { writeFileSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

writeFileSync(path.join(process.env.HOME ?? process.cwd(), 'pid'), String(process.pid))

const rl = readline.createInterface({ input: process.stdin })
function write(msg) { process.stdout.write(JSON.stringify(msg) + '\\n') }

rl.on('line', (line) => {
  if (line.trim() === '') return
  const msg = JSON.parse(line)
  if (msg.id === undefined) {
    if (msg.method === 'shutdown') process.exit(0)
    return
  }
  if (msg.method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id: 'reg-1',
      method: 'tools.register',
      params: { name: 'ping', description: 'External ping', parameters: { type: 'object' } },
    })
    write({ jsonrpc: '2.0', id: msg.id, result: { apiVersion: '1.0.0' } })
    write({ jsonrpc: '2.0', method: 'plugin.ready' })
    return
  }
  if (msg.method === 'tool.invoke') {
    write({ jsonrpc: '2.0', id: msg.id, result: 'pong-from-extprobe-' + process.pid })
    return
  }
  write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } })
})
rl.on('close', () => process.exit(0))
`,
    'utf8',
  )
  return dir
}

async function readExtProbePid(brainHome: string): Promise<number | undefined> {
  try {
    const raw = await readFile(path.join(brainHome, 'state', 'plugins', 'extprobe', 'home', 'pid'), 'utf8')
    const pid = Number(raw.trim())
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

test('AT-4: degradation and 30s crash recovery for memory-enhancer, satellite, and external process plugin', async (t) => {
  let hangFirst = true
  const h = await setupAcceptanceKernel(t, {
    crossChannel: 'on',
    settings: { agents: { chat: { ...FLASH_LOW } }, timezone: 'UTC' },
    apiKey: 'fake-at4-key',
    roleCard: '你是小满。',
    withConsole: true,
    script: (request) => {
      const wakeText = extractLatestWakeText(request)
      if (wakeText.includes('被挂起') && hangFirst) {
        hangFirst = false
        return { hang: true }
      }
      if (wakeText.includes('调用外置探针') && !hasToolResultInLastMessage(request)) {
        return { tool: 'extprobe__ping', input: {} }
      }
      if (hasToolResultInLastMessage(request)) {
        return { text: '收到工具结果。' }
      }
      return { text: '好。' }
    },
  })

  const enhancerDir = await createMemoryEnhancerFixture(h.root)
  const extProbeDir = await createExternalProbeFixture(h.root)

  await installAndEnablePlugin(h.kernel, CONSOLE_CHAT_DIR, 'console-chat')
  await installAndEnablePlugin(h.kernel, enhancerDir, 'memory-enhancer')
  await installAndEnablePlugin(h.kernel, extProbeDir, 'extprobe')

  const oldExtPid = await waitFor(() => readExtProbePid(h.brainHome), 30_000, 'initial extprobe pid')

  // 1. Disable memory-enhancer -> health & console status return 200, search falls back to SQLite FTS5
  await h.kernel.memory.service.ingest({
    kind: 'console-chat.message',
    channel: 'console-chat:private:owner',
    subjects: ['self'],
    actor: 'owner',
    content: { text: '今天我们讨论了记忆检索退回二元切分索引的方案' },
    tEvent: Date.now(),
    idempotencyKey: 'at4-fts-1',
  }, { kind: 'kernel', source: 'test', trust: 'owner', defaultVisibility: 'open' })
  await h.kernel.memory.service.flush()

  await h.kernel.plugins.disable('memory-enhancer')
  assert.equal(h.kernel.runtime.state('memory-enhancer'), 'disabled')

  const healthAfterEnhancerDisable = await httpJson<Envelope<Record<string, string>>>(
    h.kernel.port,
    'GET',
    '/api/v1/memory/health',
    { token: h.token },
  )
  assert.equal(healthAfterEnhancerDisable.status, 200)
  assert.equal(assertUnwrappedOk(healthAfterEnhancerDisable.body).store, 'ok')

  const consoleAfterEnhancerDisable = await httpJson<Envelope<unknown>>(
    h.consolePort!,
    'GET',
    '/api/v1/console/satellite',
    { token: h.token },
  )
  assert.equal(consoleAfterEnhancerDisable.status, 200)

  const ftsSearch = await httpJson<Envelope<{ readonly items: readonly SearchHit[] }>>(
    h.kernel.port,
    'POST',
    '/api/v1/memory/search',
    { token: h.token, body: { query: '二元', scope: 'all' } },
  )
  assert.equal(ftsSearch.status, 200)
  const hits = assertUnwrappedOk(ftsSearch.body).items
  assert.ok(hits.some((hit) => String(hit.record.content.text).includes('二元切分')))

  // 2. Kill DSH satellite while w1 is hanging and w2, w3 are queued
  const postChat = (channel: string, id: string, text: string) =>
    httpJson<Envelope<{ readonly wake: WakeResult }>>(
      h.kernel.port,
      'POST',
      '/api/v1/plugins/console-chat/messages',
      {
        token: h.token,
        body: { channel, account: 'owner', displayName: '主人', text, messageId: id, debounceMs: 0 },
      },
    )

  const warm = await postChat('console-chat:private:owner', 'at4-warm', '预热一下')
  assert.equal(assertUnwrappedOk(warm.body).wake.acked, true)
  const oldSatPid = await waitForSatellitePid(h.brainHome, 'chat')

  const reqBefore = h.fake.requests.length
  const w1Promise = postChat('console-chat:private:owner', 'at4-w1', '这是被挂起的第一条消息')
  await waitFor(
    () => (h.fake.requests.length > reqBefore ? true : undefined),
    30_000,
    'hanging wake w1 to reach FakeDeepSeek',
  )
  const w2Promise = postChat('console-chat:private:u2', 'at4-w2', '排队消息二')
  const w3Promise = postChat('console-chat:private:u3', 'at4-w3', '排队消息三')

  const satKillStarted = Date.now()
  await killProcessTree(oldSatPid)

  // Kernel & console stay healthy during recovery
  const [midHealth, midConsole] = await Promise.all([
    httpJson<Envelope<unknown>>(h.kernel.port, 'GET', '/api/v1/memory/health', { token: h.token }),
    httpJson<Envelope<unknown>>(h.consolePort!, 'GET', '/api/v1/console/satellite', { token: h.token }),
  ])
  assert.equal(midHealth.status, 200)
  assert.equal(midConsole.status, 200)

  const [r1, r2, r3] = await Promise.all([w1Promise, w2Promise, w3Promise])
  const satRecoveryMs = Date.now() - satKillStarted
  assert.equal(assertUnwrappedOk(r1.body).wake.acked, true, 'w1 must recover and ack')
  assert.equal(assertUnwrappedOk(r2.body).wake.acked, true, 'w2 must ack')
  assert.equal(assertUnwrappedOk(r3.body).wake.acked, true, 'w3 must ack')
  assert.ok(satRecoveryMs < 30_000, `satellite recovery took ${satRecoveryMs}ms (>= 30000ms)`)

  const newSatPid = await waitForSatellitePid(h.brainHome, 'chat', oldSatPid, 30_000)
  assert.notEqual(newSatPid, oldSatPid)

  // 3. Kill external process plugin -> restarts within 30s with new PID, stays enabled, tool works
  const extKillStarted = Date.now()
  await killProcessTree(oldExtPid)

  const newExtPid = await waitFor(async () => {
    const pid = await readExtProbePid(h.brainHome)
    return pid !== undefined && pid !== oldExtPid ? pid : undefined
  }, 30_000, 'restarted extprobe pid')
  const extRecoveryMs = Date.now() - extKillStarted
  assert.notEqual(newExtPid, oldExtPid)
  assert.ok(extRecoveryMs < 30_000, `external plugin recovery took ${extRecoveryMs}ms (>= 30000ms)`)
  assert.equal(h.kernel.runtime.state('extprobe'), 'enabled')

  // Verify kernel + console still 200 and external tool works after restart
  const afterHealth = await httpJson<Envelope<unknown>>(h.kernel.port, 'GET', '/api/v1/memory/health', { token: h.token })
  const afterConsole = await httpJson<Envelope<unknown>>(h.consolePort!, 'GET', '/api/v1/console/satellite', { token: h.token })
  assert.equal(afterHealth.status, 200)
  assert.equal(afterConsole.status, 200)

  const toolWake = await postChat('console-chat:private:owner', 'at4-ext', '请调用外置探针测试')
  assert.equal(assertUnwrappedOk(toolWake.body).wake.acked, true)
  assert.ok(
    h.fake.requests.some((req) => req.raw.includes(`pong-from-extprobe-${newExtPid}`)),
    `expected restarted external tool result containing pong-from-extprobe-${newExtPid}`,
  )
})
