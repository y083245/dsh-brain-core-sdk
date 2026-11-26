import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { removeTree } from '@brain-core/satellite-host'
import { BrainError, type BrainContext, type Envelope } from '@brain-core/sdk'
import { checkPlugin, runPluginContractTests } from '@brain-core/testkit'
import {
  CONSOLE_CHAT_DIR, PYTHON_ECHO_DIR, WEB_READER_DIR,
  assertUnwrappedOk, httpJson, installAndEnablePlugin, setupAcceptanceKernel, waitFor,
} from './helpers.ts'

async function writeTempPlugin(
  root: string,
  name: string,
  pkg: Record<string, unknown>,
  code: string,
): Promise<string> {
  const dir = path.join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8')
  await writeFile(path.join(dir, 'index.ts'), code, 'utf8')
  return dir
}

test('AT-5: checkPlugin and runtime guards catch all 6 violation categories', async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'brain-at5-plugins-'))
  t.after(async () => { await removeTree(tempRoot) })

  // Violation 1: direct SQLite (R1)
  const v1Dir = await writeTempPlugin(
    tempRoot,
    'v1-sqlite',
    {
      name: 'v1-sqlite',
      version: '1.0.0',
      private: true,
      type: 'module',
      main: './index.ts',
      brain: { id: 'v1-sqlite', kinds: ['capability'], api: '^1.0.0', runtime: 'node', permissions: [] },
    },
    `import { DatabaseSync } from 'node:sqlite'\nexport function apply() { void DatabaseSync }\n`,
  )
  const v1Report = await checkPlugin(v1Dir)
  assert.equal(v1Report.ok, false)
  assert.ok(v1Report.findings.some((f) => f.rule === 'no-own-database' && f.level === 'must'))

  // Violation 2: reading ~/.dsh or DSH_HOME (R3)
  const v2Dir = await writeTempPlugin(
    tempRoot,
    'v2-dsh',
    {
      name: 'v2-dsh',
      version: '1.0.0',
      private: true,
      type: 'module',
      main: './index.ts',
      brain: { id: 'v2-dsh', kinds: ['capability'], api: '^1.0.0', runtime: 'node', permissions: [] },
    },
    `export function apply() {
  const p = '~/.dsh/credentials'
  const envHome = process.env.DSH_HOME
  return [p, envHome]
}\n`,
  )
  const v2Report = await checkPlugin(v2Dir)
  assert.equal(v2Report.ok, false)
  assert.ok(v2Report.findings.some((f) => f.rule === 'no-dsh-home' && f.level === 'must'))

  // Violation 3: writing L3 (R6) — caught by runPluginContractTests AND kernel runtime
  const v3Manifest = {
    id: 'v3-l3',
    kinds: ['capability'],
    api: '^1.0.0',
    runtime: 'node',
    permissions: ['memory.ingest', 'memory.record'],
    source: {
      channels: ['v3-l3:private:*'],
      eventKinds: ['v3-l3.note'],
      defaultVisibility: 'owner',
      trust: 'member',
    },
  }
  const v3Apply = async (ctx: BrainContext) => {
    try {
      await ctx.memory.record({
        layer: 'L3',
        kind: 'l3.person',
        channel: 'v3-l3:private:1',
        subjects: ['p1'],
        actor: 'p1',
        content: { text: 'bad l3 write' },
        evidence: [{ id: 'l0_01' }],
      } as never)
    } catch {
      // recorded in kernel.calls even when caught
    }
  }
  const v3Contract = await runPluginContractTests({ apply: v3Apply }, v3Manifest)
  const noInternal = v3Contract.find((c) => c.name === 'no-internal-writes')
  assert.ok(noInternal !== undefined)
  assert.equal(noInternal.ok, false)

  // Also verify real kernel rejects L3 write & L3 forget from plugin
  const h = await setupAcceptanceKernel(t, { crossChannel: 'shadow' })
  const v3Dir = await writeTempPlugin(
    tempRoot,
    'v3-l3-rt',
    {
      name: 'v3-l3-rt',
      version: '1.0.0',
      private: true,
      type: 'module',
      main: './index.ts',
      brain: {
        id: 'v3-l3-rt',
        kinds: ['capability'],
        api: '^1.0.0',
        runtime: 'node',
        permissions: ['memory.ingest', 'memory.record', 'memory.forget'],
        source: {
          channels: ['v3-l3-rt:private:*'],
          eventKinds: ['v3-l3-rt.note'],
          defaultVisibility: 'owner',
          trust: 'member',
        },
      },
    },
    `export function apply(ctx) {
  ctx.http.route('POST', '/try-l3', async () => {
    const l0 = await ctx.memory.ingest({
      kind: 'v3-l3-rt.note', channel: 'v3-l3-rt:private:1', subjects: ['p1'], actor: 'p1',
      content: { text: 'seed' }, tEvent: Date.now(), idempotencyKey: 'v3-seed',
    })
    try {
      await ctx.memory.record({
        layer: 'L3', kind: 'l3.person', channel: 'v3-l3-rt:private:1', subjects: ['p1'], actor: 'p1',
        content: { text: 'l3 attempt' }, evidence: [{ id: l0.id }],
      })
      return { ok: true }
    } catch (err) {
      return { ok: false, code: err.code }
    }
  })
}\n`,
  )
  await installAndEnablePlugin(h.kernel, v3Dir, 'v3-l3-rt')
  const v3Http = await httpJson<Envelope<{ readonly ok: boolean; readonly code?: string }>>(
    h.kernel.port,
    'POST',
    '/api/v1/plugins/v3-l3-rt/try-l3',
    { token: h.token, body: {} },
  )
  const v3Res = assertUnwrappedOk(v3Http.body)
  assert.equal(v3Res.ok, false)
  assert.ok(v3Res.code === 'PERMISSION_DENIED' || v3Res.code === 'INVALID_ARGUMENT')

  // Violation 4: unregistered domain & loopback fetch (R5)
  const v4Dir = await writeTempPlugin(
    tempRoot,
    'v4-net',
    {
      name: 'v4-net',
      version: '1.0.0',
      private: true,
      type: 'module',
      main: './index.ts',
      brain: {
        id: 'v4-net',
        kinds: ['capability'],
        api: '^1.0.0',
        runtime: 'node',
        permissions: ['network:allowed.example.com'],
      },
    },
    `export function apply(ctx) {
  ctx.http.route('POST', '/probe-net', async (req) => {
    try {
      await ctx.http.fetch(req.body.url)
      return { allowed: true }
    } catch (err) {
      return { allowed: false, code: err.code }
    }
  })
}\n`,
  )
  await installAndEnablePlugin(h.kernel, v4Dir, 'v4-net')
  for (const blockedUrl of ['https://unregistered.example.com/api', 'http://127.0.0.1:8080/']) {
    const res = await httpJson<Envelope<{ readonly allowed: boolean; readonly code?: string }>>(
      h.kernel.port,
      'POST',
      '/api/v1/plugins/v4-net/probe-net',
      { token: h.token, body: { url: blockedUrl } },
    )
    const data = assertUnwrappedOk(res.body)
    assert.equal(data.allowed, false, `expected ${blockedUrl} to be blocked`)
    assert.equal(data.code, 'PERMISSION_DENIED', `expected PERMISSION_DENIED for ${blockedUrl}`)
  }

  // Violation 5: raw text in logger (R8) — static check + runtime plugin logger stripping/redaction
  const v5Dir = await writeTempPlugin(
    tempRoot,
    'v5-log',
    {
      name: 'v5-log',
      version: '1.0.0',
      private: true,
      type: 'module',
      main: './index.ts',
      brain: {
        id: 'v5-log',
        kinds: ['capability'],
        api: '^1.0.0',
        runtime: 'node',
        permissions: ['secrets:api_tok'],
      },
    },
    `export function apply(ctx) {
  ctx.http.route('POST', '/log-test', async () => {
    const secret = await ctx.secrets.get('api_tok')
    ctx.logger.info('chat', { text: '敏感原文', prompt: '秘密', count: 1, detail: 'val=' + secret })
    return { logged: true }
  })
}\n`,
  )
  const v5Report = await checkPlugin(v5Dir)
  assert.equal(v5Report.ok, false)
  assert.ok(v5Report.findings.some((f) => f.rule === 'no-raw-log' && f.level === 'must'))

  // Also test runtime logger strips text/prompt & redacts secrets
  await h.kernel.secrets.set('plugin.v5-log.api_tok', 'secret-value-987654321')
  await installAndEnablePlugin(h.kernel, v5Dir, 'v5-log')
  await httpJson(h.kernel.port, 'POST', '/api/v1/plugins/v5-log/log-test', { token: h.token, body: {} })
  const logFile = path.join(h.brainHome, 'state', 'plugins', 'v5-log', 'plugin.log')
  const logContent = await waitFor(async () => {
    try {
      const content = await readFile(logFile, 'utf8')
      return content.includes('chat') ? content : undefined
    } catch {
      return undefined
    }
  }, 10_000, 'v5-log plugin.log entry')
  assert.equal(logContent.includes('敏感原文'), false)
  assert.equal(logContent.includes('秘密'), false)
  assert.equal(logContent.includes('secret-value-987654321'), false)
  assert.ok(logContent.includes('[redacted]'))

  // Violation 6: missing manifest fields (R4 / FR-T01)
  const badManifests: readonly { readonly name: string; readonly brain: Record<string, unknown> }[] = [
    {
      name: 'v6-no-perms',
      brain: { id: 'v6-no-perms', kinds: ['capability'], api: '^1.0.0', runtime: 'node' },
    },
    {
      name: 'v6-no-source',
      brain: { id: 'v6-no-source', kinds: ['capability'], api: '^1.0.0', runtime: 'node', permissions: ['memory.ingest'] },
    },
    {
      name: 'v6-bad-tool',
      brain: {
        id: 'v6-bad-tool',
        kinds: ['capability'],
        api: '^1.0.0',
        runtime: 'node',
        permissions: ['tools.register'],
        tools: [{ name: 'bad', effect: 'read' }],
      },
    },
  ]
  for (const item of badManifests) {
    const dir = await writeTempPlugin(
      tempRoot,
      item.name,
      { name: item.name, version: '1.0.0', private: true, type: 'module', main: './index.ts', brain: item.brain },
      'export function apply() {}\n',
    )
    const report = await checkPlugin(dir)
    assert.equal(report.ok, false, `checkPlugin must fail for ${item.name}`)
    assert.ok(report.findings.some((f) => f.rule === 'manifest' && f.level === 'must'))
    await assert.rejects(
      () => h.kernel.plugins.install(dir),
      (err: unknown) => err instanceof BrainError && err.code === 'INVALID_ARGUMENT',
      `kernel.plugins.install must reject ${item.name} with INVALID_ARGUMENT`,
    )
  }
})

test('AT-5: disabling a plugin revokes all tools, routes, timers, and listeners immediately (FR-P07)', async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'brain-at5-revoke-'))
  t.after(async () => { await removeTree(tempRoot) })

  const state = ((globalThis as { __at5Revoke?: { events: number; ticks: number } }).__at5Revoke = {
    events: 0,
    ticks: 0,
  })
  t.after(() => { delete (globalThis as { __at5Revoke?: unknown }).__at5Revoke })

  const revokerDir = await writeTempPlugin(
    tempRoot,
    'revoker',
    {
      name: 'revoker',
      version: '1.0.0',
      private: true,
      type: 'module',
      main: './index.ts',
      brain: {
        id: 'revoker',
        kinds: ['capability'],
        api: '^1.0.0',
        runtime: 'node',
        permissions: ['tools.register'],
        tools: [{ name: 'ping', effect: 'read', load: 'core', summary: 'Revoker ping' }],
      },
    },
    `export function apply(ctx) {
  const s = globalThis.__at5Revoke
  ctx.tools.register({
    name: 'ping',
    description: 'ping',
    parameters: { type: 'object' },
    handler: async () => 'pong',
  })
  ctx.http.route('GET', '/hello', async () => ({ hello: true }))
  ctx.scheduler.every(60_000, () => { s.ticks += 1 })
  ctx.events.on('memory.recorded', () => { s.events += 1 })
}\n`,
  )

  // Capture scheduler interval so we can check timer behavior deterministically
  const origSetInterval = globalThis.setInterval
  const origClearInterval = globalThis.clearInterval
  let schedulerTick: (() => void) | undefined
  globalThis.setInterval = ((cb: () => void, ms: number) => {
    if (ms === 30_000) schedulerTick = cb
    return { unref() {} } as unknown as ReturnType<typeof setInterval>
  }) as typeof setInterval
  globalThis.clearInterval = (() => {}) as typeof clearInterval

  let now = Date.UTC(2026, 10, 16, 12, 0, 0)
  let h: Awaited<ReturnType<typeof setupAcceptanceKernel>>
  try {
    h = await setupAcceptanceKernel(t, { clock: { now: () => now } })
  } finally {
    globalThis.setInterval = origSetInterval
    globalThis.clearInterval = origClearInterval
  }

  await installAndEnablePlugin(h.kernel, revokerDir, 'revoker')

  // All 4 registrations active while enabled
  assert.ok(h.kernel.gateway.catalog().some((tool) => tool.name === 'revoker__ping'))
  const routeEnabled = await httpJson<Envelope<{ readonly hello: boolean }>>(
    h.kernel.port,
    'GET',
    '/api/v1/plugins/revoker/hello',
    { token: h.token },
  )
  assert.equal(routeEnabled.status, 200)
  assert.equal(assertUnwrappedOk(routeEnabled.body).hello, true)

  // Trigger memory.recorded event
  const l0 = await h.kernel.memory.service.ingest({
    kind: 'test.msg',
    channel: 'test:private:1',
    subjects: ['p1'],
    actor: 'p1',
    content: { text: 'event check' },
    tEvent: now,
    idempotencyKey: 'at5-rev-1',
  }, { kind: 'kernel', source: 'test', trust: 'owner', defaultVisibility: 'open' })
  await h.kernel.memory.service.record({
    layer: 'L1',
    kind: 'l1.fact',
    channel: 'test:private:1',
    subjects: ['p1'],
    actor: 'p1',
    content: { text: 'before disable' },
    evidence: [{ id: l0.id }],
  }, { kind: 'kernel', source: 'test', trust: 'owner', defaultVisibility: 'open' })
  assert.equal(state.events, 1)

  // Trigger timer once
  now += 60_000
  schedulerTick?.()
  await waitFor(() => (state.ticks === 1 ? true : undefined), 5_000, 'revoker timer tick before disable')

  // Disable plugin -> all 4 must revoke immediately
  await h.kernel.plugins.disable('revoker')

  assert.equal(h.kernel.gateway.catalog().some((tool) => tool.name === 'revoker__ping'), false)
  const routeDisabled = await httpJson<Envelope<unknown>>(
    h.kernel.port,
    'GET',
    '/api/v1/plugins/revoker/hello',
    { token: h.token },
  )
  assert.equal(routeDisabled.status, 404)

  // Event listener must not fire after disable
  await h.kernel.memory.service.record({
    layer: 'L1',
    kind: 'l1.fact',
    channel: 'test:private:1',
    subjects: ['p1'],
    actor: 'p1',
    content: { text: 'after disable' },
    evidence: [{ id: l0.id }],
  }, { kind: 'kernel', source: 'test', trust: 'owner', defaultVisibility: 'open' })
  assert.equal(state.events, 1, 'event listener must be revoked immediately after disable')

  // Timer must not fire after disable
  now += 60_000
  schedulerTick?.()
  await waitFor(async () => {
    // Allow microtasks from tick() to settle by checking health round-trip
    const health = await httpJson(h.kernel.port, 'GET', '/api/v1/memory/health', { token: h.token })
    return health.status === 200 ? true : undefined
  }, 5_000, 'tick settle')
  assert.equal(state.ticks, 1, 'timer must be revoked immediately after disable')
})

test('AT-5: official plugins pass checkPlugin with 0 must findings', async () => {
  for (const pluginDir of [CONSOLE_CHAT_DIR, WEB_READER_DIR, PYTHON_ECHO_DIR]) {
    const report = await checkPlugin(pluginDir)
    const musts = report.findings.filter((f) => f.level === 'must')
    assert.equal(report.ok, true, `${pluginDir} failed checkPlugin: ${JSON.stringify(report.findings)}`)
    assert.equal(musts.length, 0, `${pluginDir} had must findings: ${JSON.stringify(musts)}`)
  }
})
