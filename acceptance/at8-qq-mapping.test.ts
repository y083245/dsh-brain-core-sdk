import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createKernel } from '@dsh-brain-core/kernel/assembly'
import { runDoctor } from '@dsh-brain-core/kernel/isolation-doctor'
import { encodeSessionId, removeTree } from '@dsh-brain-core/satellite-host'
import { BrainError, type Envelope, type PluginApply, type WakeResult } from '@dsh-brain-core/sdk'
import {
  FakeDeepSeek, checkPlugin, createTestKernel, runPluginContractTests,
} from '@dsh-brain-core/testkit'
import { extractLatestWakeText, hasToolResultInLastMessage, waitFor } from './helpers.ts'
import { apply as qqApply } from './fixtures/qq-sample/src/index.ts'
import { apply as qzoneApply } from './fixtures/qzone-mcp/src/index.ts'

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url))
const QQ_SAMPLE_DIR = path.join(THIS_DIR, 'fixtures', 'qq-sample')
const QZONE_MCP_DIR = path.join(THIS_DIR, 'fixtures', 'qzone-mcp')
const FLASH_LOW = { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'low' } as const
const TOKEN = 'at8-test-token-0123456789'

async function readManifest(dir: string): Promise<{ readonly brain: unknown; readonly dependencies?: Record<string, string> }> {
  return JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as {
    readonly brain: unknown
    readonly dependencies?: Record<string, string>
  }
}

function extractImports(source: string): string[] {
  const specs: string[] = []
  const re = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g
  for (let m = re.exec(source); m !== null; m = re.exec(source)) {
    specs.push(m[1]!)
  }
  return specs
}

function readOutboundAuditRows(brainHome: string): readonly {
  readonly tool: string
  readonly pluginId: string
  readonly channel: string
  readonly ok: boolean
}[] {
  const db = new DatabaseSync(path.join(brainHome, 'state', 'agent', 'outbound.db'), { readOnly: true })
  try {
    const rows = db.prepare(
      'SELECT tool, plugin_id, channel, ok FROM outbound_audit ORDER BY t_at ASC',
    ).all() as unknown as readonly {
      readonly tool: string
      readonly plugin_id: string
      readonly channel: string
      readonly ok: number
    }[]
    return rows.map((r) => ({
      tool: r.tool,
      pluginId: r.plugin_id,
      channel: r.channel,
      ok: r.ok === 1,
    }))
  } finally {
    db.close()
  }
}

test('AT-8 part 1: qq-sample and qzone-mcp import ONLY @dsh-brain-core/sdk and pass contract + checkPlugin + TestKernel RFC 8.9 SDK rows', async () => {
  const qqPkg = await readManifest(QQ_SAMPLE_DIR)
  const qzonePkg = await readManifest(QZONE_MCP_DIR)
  assert.deepEqual(Object.keys(qqPkg.dependencies ?? {}), ['@dsh-brain-core/sdk'])
  assert.deepEqual(Object.keys(qzonePkg.dependencies ?? {}), ['@dsh-brain-core/sdk'])

  const qqSource = await readFile(path.join(QQ_SAMPLE_DIR, 'src', 'index.ts'), 'utf8')
  const qzoneSource = await readFile(path.join(QZONE_MCP_DIR, 'src', 'index.ts'), 'utf8')
  assert.deepEqual(extractImports(qqSource), ['@dsh-brain-core/sdk'])
  assert.deepEqual(extractImports(qzoneSource), ['@dsh-brain-core/sdk'])

  // Contract tests & checkPlugin
  for (const [dir, applyFn, pkg] of [
    [QQ_SAMPLE_DIR, qqApply as PluginApply, qqPkg],
    [QZONE_MCP_DIR, qzoneApply as PluginApply, qzonePkg],
  ] as const) {
    const contracts = await runPluginContractTests({ apply: applyFn }, pkg.brain)
    for (const item of contracts) {
      assert.equal(item.ok, true, `${dir} contract ${item.name}: ${item.message}`)
    }
    const check = await checkPlugin(dir)
    assert.equal(check.ok, true, `${dir} checkPlugin failed: ${JSON.stringify(check.findings)}`)
    assert.equal(check.findings.filter((f) => f.level === 'must').length, 0)
  }

  // TestKernel exercising RFC 8.9 SDK surface
  const tk = createTestKernel({ now: Date.UTC(2026, 10, 16, 12, 0, 0) })
  const wakes: { readonly channel: string; readonly reason: string; readonly proactive?: boolean }[] = []
  tk.useAgent(async (wake) => {
    wakes.push({
      channel: wake.channel,
      reason: wake.input.reason,
      ...(wake.input.proactive === undefined ? {} : { proactive: wake.input.proactive }),
    })
  })
  await tk.loadPlugin({ apply: qqApply }, qqPkg.brain, { config: { ownTimeChannel: 'qq:group:1001' } })

  // Row 1: inbound message -> L0.1
  const inboundRes = await tk.http('POST', '/api/v1/plugins/qq/inbound', {
    channel: 'qq:group:1001',
    account: '10001',
    displayName: '阿明',
    text: '群里好热闹，yyds！',
    messageId: 'in-1',
  })
  assert.equal(inboundRes.ok, true)
  const l0Id = (inboundRes.ok ? (inboundRes.data as { readonly recordId: string }).recordId : '')
  assert.ok(l0Id.startsWith('l0_'))

  // Row 2: core send_message, reply, send_burst -> L0.1
  await tk.callTool('qq__send_message', { text: '大家下午好' }, { channel: 'qq:group:1001' })
  await tk.callTool('qq__reply', { text: '我也觉得', replyTo: 'in-1' }, { channel: 'qq:group:1001' })
  await tk.callTool('qq__send_burst', { text: '等下一起打游戏' }, { channel: 'qq:group:1001' })

  // Row 3: context get_message_images & get_forward_msg -> L0.2
  await tk.callTool('qq__get_message_images', { messageId: 'in-1' }, { channel: 'qq:group:1001' })
  await tk.callTool('qq__get_forward_msg', { forwardId: 'fwd-1' }, { channel: 'qq:group:1001' })

  // Row 4: context send_poke -> L0.4
  await tk.callTool('qq__send_poke', { target: 'p_aming' }, { channel: 'qq:group:1001' })

  // Row 5: stickers onDemand -> L2.3 l2.expression
  const listOut = await tk.callTool('qq__list_stickers', {}, { channel: 'qq:group:1001' })
  assert.ok(String(listOut).includes('cat_wave'))
  await tk.callTool('qq__collect_sticker', { stickerId: 'doge', meaning: '滑稽赞同' }, { channel: 'qq:group:1001' })
  await tk.callTool('qq__send_sticker', { stickerId: 'doge' }, { channel: 'qq:group:1001' })
  await tk.callTool('qq__sticker_note', { stickerId: 'doge', meaning: '滑稽赞同', evidenceId: l0Id }, { channel: 'qq:group:1001' })

  // Row 6: voice onDemand -> L0.4
  const ttsOut = JSON.parse(String(await tk.callTool('qq__tts_voice', { text: '晚上好呀' }, { channel: 'qq:group:1001' }))) as {
    readonly audioRef: string
  }
  await tk.callTool('qq__send_voice', { audioRef: ttsOut.audioRef }, { channel: 'qq:group:1001' })

  // Row 8: ownTime -> L0.5 + proactive wake
  await tk.advance(60_000)
  assert.ok(wakes.some((w) => w.channel === 'qq:group:1001' && w.reason === 'own-time' && w.proactive === true))

  // Row 9: set_wake_config (and zero model wait tools)
  const cfgOut = String(await tk.callTool('qq__set_wake_config', { mode: 'always', minIntervalMs: 3000 }, { channel: 'qq:group:1001' }))
  assert.ok(cfgOut.includes('always'))
  assert.equal(tk.tools().some((name) => /wait|sleep|delay/i.test(name)), false)

  // Row 10: slang_note -> L1.7 l1.knowledge
  await tk.callTool('qq__slang_note', { term: 'yyds', meaning: '永远的神', evidenceId: l0Id }, { channel: 'qq:group:1001' })

  const allRecords = tk.records()
  assert.ok(allRecords.some((r) => r.layer === 'L0' && r.kind === 'qq.message'))
  for (const outboundText of ['大家下午好', '我也觉得', '等下一起打游戏']) {
    assert.ok(
      allRecords.some(
        (r) =>
          r.layer === 'L0' &&
          r.kind === 'qq.message' &&
          r.channel === 'qq:group:1001' &&
          r.content.direction === 'outbound' &&
          r.content.text === outboundText,
      ),
      `missing outbound L0.1 qq.message record for "${outboundText}"`,
    )
  }
  assert.ok(allRecords.some((r) => r.layer === 'L0' && r.kind === 'qq.vision'))
  assert.ok(allRecords.some((r) => r.layer === 'L0' && r.kind === 'qq.action'))
  assert.ok(allRecords.some((r) => r.layer === 'L0' && r.kind === 'qq.wake'))
  assert.ok(allRecords.some((r) => r.layer === 'L1' && r.kind === 'l1.knowledge'))
  assert.ok(allRecords.some((r) => r.layer === 'L2' && r.kind === 'l2.expression' && r.evidence.some((e) => e.id === l0Id)))
  await tk.unload()
})

test('AT-8 part 2: real kernel verifies RFC 8.9 rows 1-11, core budget, context rules, MCP T5, session binding, outbound audit, RATE_LIMITED, and DSH isolation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brain-at8-real-'))
  const brainHome = path.join(root, 'brain-home')
  const dshHome = path.join(root, 'fake-dsh-home')
  await mkdir(path.join(brainHome, 'state'), { recursive: true })
  await mkdir(path.join(dshHome, 'profiles', 'web'), { recursive: true })
  await writeFile(
    path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml'),
    'plugins:\n  main-only: {}\n',
    'utf8',
  )
  await writeFile(
    path.join(brainHome, 'state', 'settings.json'),
    JSON.stringify({ agents: { chat: { ...FLASH_LOW } }, timezone: 'UTC', quietHours: [3, 8], ownTimePerDay: 6 }),
    'utf8',
  )

  let now = Date.UTC(2026, 10, 16, 12, 0, 0)
  const clock = { now: () => now }

  let stepIndex = 0
  let lastWakeText = ''
  let inboundRecordId = ''

  const fake = new FakeDeepSeek((request) => {
    const wakeText = extractLatestWakeText(request)
    if (wakeText !== '' && wakeText !== lastWakeText && !hasToolResultInLastMessage(request)) {
      lastWakeText = wakeText
      stepIndex = 0
    } else {
      stepIndex += 1
    }

    if (lastWakeText.includes('全链路发送测试')) {
      if (stepIndex === 0) return { tool: 'qq__send_message', input: { text: '核心消息收到' } }
      if (stepIndex === 1) return { tool: 'qq__send_poke', input: { target: 'p_aming' } }
      if (stepIndex === 2) return { tool: 'tools__search', input: { query: '表情' } }
      if (stepIndex === 3) return { tool: 'tools__load', input: { group: 'stickers' } }
      if (stepIndex === 4) return { tool: 'qq__send_sticker', input: { stickerId: 'smile' } }
      if (stepIndex === 5) return { tool: 'tools__load', input: { group: 'voice' } }
      if (stepIndex === 6) return { tool: 'qq__send_voice', input: { audioRef: 'tts://demo-1' } }
      if (stepIndex === 7) return { tool: 'tools__load', input: { group: 'qzone' } }
      if (stepIndex === 8) return { tool: 'qzone__publish_post', input: { text: '今天天气真不错，在群里聊得很开心' } }
      return { text: '全部发完了。' }
    }

    if (lastWakeText.includes('会话绑定测试')) {
      if (stepIndex === 0) {
        return {
          tool: 'qq__send_message',
          input: { text: '只发到当前群1001', channel: 'qq:group:9999' },
        }
      }
      if (stepIndex === 1) {
        return { tool: 'tools__load', input: { group: 'slang' } }
      }
      if (stepIndex === 2) {
        return {
          tool: 'qq__slang_note',
          input: { term: '绝绝子', meaning: '非常厉害', evidenceId: inboundRecordId, channel: 'qq:group:9999' },
        }
      }
      return { text: '绑定检查完成。' }
    }

    return { text: '收到。' }
  })
  await fake.listen()

  // Capture scheduler 30_000 interval so we can test Row 8 ownTime deterministically
  const origSetInterval = globalThis.setInterval
  const origClearInterval = globalThis.clearInterval
  let schedulerTick: (() => void) | undefined
  globalThis.setInterval = ((cb: () => void, ms: number) => {
    if (ms === 30_000) schedulerTick = cb
    return { unref() {} } as unknown as ReturnType<typeof setInterval>
  }) as typeof setInterval
  globalThis.clearInterval = (() => {}) as typeof clearInterval

  let kernel: Awaited<ReturnType<typeof createKernel>>
  try {
    kernel = await createKernel({
      env: { ...process.env, BRAIN_HOME: brainHome, DSH_HOME: dshHome },
      userHome: brainHome,
      port: 0,
      crossChannel: 'on',
      clock,
      log: { info() {}, warn() {}, error() {} },
      token: TOKEN,
      baseUrl: fake.url,
    })
  } finally {
    globalThis.setInterval = origSetInterval
    globalThis.clearInterval = origClearInterval
  }

  t.after(async () => {
    await kernel.close().catch(() => undefined)
    await fake.close().catch(() => undefined)
    await removeTree(root)
  })

  await kernel.secrets.set('deepseek-api-key', 'fake-at8-key')
  await kernel.memory.persona.saveRoleCard({ name: 'at8-persona', text: '你是小满。' })

  await kernel.plugins.install(QQ_SAMPLE_DIR)
  await kernel.plugins.confirm('qq')
  await kernel.plugins.setConfig('qq', { ownTimeChannel: 'qq:group:1001' })
  await kernel.plugins.enable('qq')

  await kernel.plugins.install(QZONE_MCP_DIR)
  await kernel.plugins.confirm('qzone')
  await kernel.plugins.enable('qzone')

  // Core budget check: built-ins (3) + qq core (4) = 7 <= 8, tokens <= 2000, no wait tools
  const budget = kernel.gateway.coreBudget('qq:group')
  assert.equal(budget.count, 7, `expected 7 core tools on qq:group, got ${budget.count}`)
  assert.ok(budget.tokens <= 2_000, `core tokens ${budget.tokens} > 2000`)
  assert.equal(budget.over, false)
  const catalogNames = kernel.gateway.catalog().map((tool) => tool.name)
  assert.equal(catalogNames.some((n) => /wait|sleep|delay/i.test(n)), false)

  // T5: declared MCP tool is in catalog, undeclared secret_admin_tool is NOT
  assert.ok(catalogNames.includes('qzone__publish_post'))
  assert.equal(catalogNames.includes('qzone__secret_admin_tool'), false)

  // FR-T02: verify context rules on fresh sessions (plain, hasMedia, hasForward, poke)
  const plainSid = encodeSessionId({ agentClass: 'chat', channel: 'qq:group:plain', generation: 0 })
  const mediaSid = encodeSessionId({ agentClass: 'chat', channel: 'qq:group:media', generation: 0 })
  const fwdSid = encodeSessionId({ agentClass: 'chat', channel: 'qq:group:fwd', generation: 0 })
  const pokeSid = encodeSessionId({ agentClass: 'chat', channel: 'qq:group:poke', generation: 0 })

  const plainSurf = kernel.gateway.planWake({
    sessionId: plainSid,
    wakeId: 'w-plain',
    features: { message: { hasMedia: false, hasForward: false }, event: { poke: false }, channel: { kind: 'group' } },
    mode: 'addition-only',
    silent: false,
    participants: [],
    evidence: [],
    peerTexts: [],
  })
  assert.equal(plainSurf.includes('qq__get_message_images'), false)
  assert.equal(plainSurf.includes('qq__get_forward_msg'), false)
  assert.equal(plainSurf.includes('qq__send_poke'), false)
  kernel.gateway.endWake(plainSid)

  const mediaSurf = kernel.gateway.planWake({
    sessionId: mediaSid,
    wakeId: 'w-media',
    features: { message: { hasMedia: true, hasForward: false }, event: { poke: false }, channel: { kind: 'group' } },
    mode: 'addition-only',
    silent: false,
    participants: [],
    evidence: [],
    peerTexts: [],
  })
  assert.equal(mediaSurf.includes('qq__get_message_images'), true)
  assert.equal(mediaSurf.includes('qq__get_forward_msg'), false)
  assert.equal(mediaSurf.includes('qq__send_poke'), false)
  kernel.gateway.endWake(mediaSid)

  const fwdSurf = kernel.gateway.planWake({
    sessionId: fwdSid,
    wakeId: 'w-fwd',
    features: { message: { hasMedia: false, hasForward: true }, event: { poke: false }, channel: { kind: 'group' } },
    mode: 'addition-only',
    silent: false,
    participants: [],
    evidence: [],
    peerTexts: [],
  })
  assert.equal(fwdSurf.includes('qq__get_message_images'), false)
  assert.equal(fwdSurf.includes('qq__get_forward_msg'), true)
  assert.equal(fwdSurf.includes('qq__send_poke'), false)
  kernel.gateway.endWake(fwdSid)

  const pokeSurf = kernel.gateway.planWake({
    sessionId: pokeSid,
    wakeId: 'w-poke',
    features: { message: { hasMedia: false, hasForward: false }, event: { poke: true }, channel: { kind: 'group' } },
    mode: 'addition-only',
    silent: false,
    participants: [],
    evidence: [],
    peerTexts: [],
  })
  assert.equal(pokeSurf.includes('qq__get_message_images'), false)
  assert.equal(pokeSurf.includes('qq__get_forward_msg'), false)
  assert.equal(pokeSurf.includes('qq__send_poke'), true)
  kernel.gateway.endWake(pokeSid)

  // Full end-to-end wake on qq:group:1001 with poke=true so all 5 send tools run in real gateway + DSH
  const postInbound = async (body: Record<string, unknown>) => {
    const res = await fetch(`http://127.0.0.1:${kernel.port}/api/v1/plugins/qq/inbound`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return (await res.json()) as Envelope<{ readonly recordId: string; readonly personId: string; readonly wake: WakeResult }>
  }

  const rFull = await postInbound({
    channel: 'qq:group:1001',
    account: '10001',
    displayName: '阿明',
    text: '全链路发送测试',
    poke: true,
    messageId: 'at8-full-1',
    tEvent: now,
  })
  assert.equal(rFull.ok, true)
  if (!rFull.ok) throw new Error('unreachable')
  inboundRecordId = rFull.data.recordId
  assert.equal(rFull.data.wake.acked, true)
  const fullAudits = readOutboundAuditRows(brainHome)
  assert.equal(
    rFull.data.wake.sent,
    5,
    `all 5 send tools must be counted; audits=${JSON.stringify(fullAudits)}, steps=${rFull.data.wake.steps}, lastRaw=${fake.requests.at(-1)?.raw.slice(-400)}`,
  )

  // Row 11: session binding check — model passes channel: 'qq:group:9999' in tool args, must stay on qq:group:1001
  now += 20_000
  const rBind = await postInbound({
    channel: 'qq:group:1001',
    account: '10001',
    displayName: '阿明',
    text: '会话绑定测试',
    messageId: 'at8-bind-1',
    tEvent: now,
  })
  assert.equal(rBind.ok, true)
  const sentRes = await fetch(`http://127.0.0.1:${kernel.port}/api/v1/plugins/qq/sent`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  const sentEnv = await sentRes.json() as Envelope<{ readonly items: readonly { readonly channel: string; readonly text?: string }[] }>
  assert.equal(sentEnv.ok, true)
  if (!sentEnv.ok) throw new Error('unreachable')
  assert.equal(sentEnv.data.items.some((item) => item.channel === 'qq:group:9999'), false, 'forged channel must never be used')
  for (const expectedText of ['核心消息收到', '[sticker:smile]', '[voice:tts://demo-1]', '只发到当前群1001']) {
    assert.ok(
      sentEnv.data.items.some((item) => item.channel === 'qq:group:1001' && item.text === expectedText),
      `missing channel delivery "${expectedText}" in /sent: ${JSON.stringify(sentEnv.data.items)}`,
    )
  }

  const groupL0Page = await kernel.memory.store.list(
    { layers: ['L0'], kinds: ['qq.message'], channels: ['qq:group:1001'] },
    { limit: 50 },
  )
  for (const outboundText of ['核心消息收到', '只发到当前群1001']) {
    assert.ok(
      groupL0Page.items.some(
        (rec) => rec.content.direction === 'outbound' && rec.content.text === outboundText,
      ),
      `missing outbound L0.1 qq.message "${outboundText}" in kernel memory store`,
    )
  }

  const slangHits = await kernel.memory.service.search(
    { query: '绝绝子', scope: 'here' },
    { caller: 'agent', channel: 'qq:group:1001', participants: ['self'] },
  )
  assert.equal(slangHits.items.length, 1)
  assert.equal(slangHits.items[0]!.record.channel, 'qq:group:1001')

  // Outbound audit check: all 5 send tools logged in outbound_audit
  const audits = readOutboundAuditRows(brainHome)
  for (const expectedTool of [
    'qq__send_message',
    'qq__send_poke',
    'qq__send_sticker',
    'qq__send_voice',
    'qzone__publish_post',
  ]) {
    assert.ok(
      audits.some((row) => row.tool === expectedTool && row.channel === 'qq:group:1001' && row.ok),
      `missing outbound audit entry for ${expectedTool}: ${JSON.stringify(audits)}`,
    )
  }

  // T4 Rate limiting: exceeding sendPerMinute=2 on qq__send_burst and qzone__publish_post raises RATE_LIMITED
  now += 70_000
  const rateSid = encodeSessionId({ agentClass: 'chat', channel: 'qq:group:ratelimit', generation: 0 })
  kernel.gateway.planWake({
    sessionId: rateSid,
    wakeId: 'w-rate',
    features: { message: { hasMedia: false, hasForward: false }, event: { poke: false }, channel: { kind: 'group' } },
    mode: 'addition-only',
    silent: false,
    participants: [],
    evidence: [],
    peerTexts: [],
  })
  await kernel.gateway.dispatch({ sessionId: rateSid, toolName: 'tools__load', args: { group: 'qzone' } })

  // Note: qq__send_burst invokes tool gateway admit + ctx.channel.send admit (2 admits on first call),
  // so the second call within 1 minute hits sendPerMinute=2 with RATE_LIMITED.
  await kernel.gateway.dispatch({ sessionId: rateSid, toolName: 'qq__send_burst', args: { text: '第一句限频测试' } })
  await assert.rejects(
    () => kernel.gateway.dispatch({ sessionId: rateSid, toolName: 'qq__send_burst', args: { text: '第二句触发限频' } }),
    (err: unknown) => err instanceof BrainError && err.code === 'RATE_LIMITED',
  )

  await kernel.gateway.dispatch({ sessionId: rateSid, toolName: 'qzone__publish_post', args: { text: '空间第一条动态' } })
  await kernel.gateway.dispatch({ sessionId: rateSid, toolName: 'qzone__publish_post', args: { text: '空间第二条完全不同' } })
  await assert.rejects(
    () => kernel.gateway.dispatch({ sessionId: rateSid, toolName: 'qzone__publish_post', args: { text: '空间第三条应触发限频' } }),
    (err: unknown) => err instanceof BrainError && err.code === 'RATE_LIMITED',
  )
  kernel.gateway.endWake(rateSid)

  // Row 8: ownTime quiet hours vs normal hours
  now = Date.UTC(2026, 10, 16, 4, 0, 0) // inside quietHours [3, 8]
  schedulerTick?.()
  await fetch(`http://127.0.0.1:${kernel.port}/api/v1/memory/health`, { headers: { authorization: `Bearer ${TOKEN}` } })
  const quietWakes = await kernel.memory.store.list({ layers: ['L0'], kinds: ['qq.wake'] }, { limit: 10 })
  assert.equal(quietWakes.items.length, 0, 'ownTime must not fire during quietHours')

  now = Date.UTC(2026, 10, 16, 13, 0, 0) // outside quietHours
  schedulerTick?.()
  const activeWake = await waitFor(async () => {
    const page = await kernel.memory.store.list({ layers: ['L0'], kinds: ['qq.wake'] }, { limit: 10 })
    return page.items.length >= 1 ? page.items[0] : undefined
  }, 10_000, 'ownTime L0.5 qq.wake record')
  assert.ok(activeWake !== undefined, 'ownTime must write L0.5 qq.wake outside quiet hours')

  // DSH isolation check
  const doctor = await runDoctor({ mode: 'check', dshHome })
  assert.equal(doctor.kind, 'check')
  assert.equal(doctor.ok, true)
  assert.deepEqual(doctor.problems, [])
})
