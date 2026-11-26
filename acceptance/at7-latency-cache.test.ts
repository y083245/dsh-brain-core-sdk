import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { computeSatelliteMetricsSummary, type SessionSurfaceInfo, type WakeMetricSample } from '@brain-core/console'
import { createKernel } from '@brain-core/kernel/assembly'
import { encodeSessionId, removeTree, type AgentClass } from '@brain-core/satellite-host'
import type { Envelope, WakeResult } from '@brain-core/sdk'
import type { CapturedRequest } from '@brain-core/testkit'
import {
  CONSOLE_CHAT_DIR, FLASH_LOW, TEST_TOKEN, assertUnwrappedOk, capturingLogger,
  hasToolResultInLastMessage, extractLatestWakeText, httpJson, installAndEnablePlugin,
} from './helpers.ts'

const PIXEL_1X1_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg=='

const LONG_PERSONA = [
  '你是小满，一个在控制台里陪伴主人的朋友。',
  ...Array.from({ length: 40 }, (_unused, idx) =>
    `性格细则 ${idx + 1}：说话简短自然、不套话、不反问过多、记住上下文里提到的细节并恰当地呼应。`,
  ),
].join('\n')

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 3))
}

class PrefixCacheFakeGateway {
  readonly requests: CapturedRequest[] = []
  uploads = 0
  readonly #server: Server
  readonly #cachedPrefixes = new Set<string>()
  readonly #script: (request: CapturedRequest, index: number) =>
    | { readonly tool: string; readonly input?: Record<string, unknown> }
    | { readonly text: string }

  constructor(
    script: (request: CapturedRequest, index: number) =>
      | { readonly tool: string; readonly input?: Record<string, unknown> }
      | { readonly text: string },
  ) {
    this.#script = script
    this.#server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(chunk as Buffer))
      req.on('end', () => {
        if (req.method === 'GET' && req.url?.split('?')[0]?.endsWith('/models') === true) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            data: [
              {
                id: 'deepseek-flash',
                api_capabilities: {
                  anthropic_messages: { tool_update: 'addition-only', system_prompt_update: 'in-history' },
                },
              },
            ],
          }))
          return
        }
        if (req.url?.endsWith('/files') === true) {
          this.uploads += 1
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            id: `file_${this.uploads}`,
            type: 'file',
            mime_type: 'image/png',
            size_bytes: 1,
            created_at: new Date().toISOString(),
            filename: 'upload.png',
          }))
          return
        }
        this.#handleMessages(Buffer.concat(chunks).toString('utf8'), res)
      })
    })
  }

  get url(): string {
    return `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.#server.listen(0, '127.0.0.1', () => resolve()))
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.#server.closeAllConnections()
      this.#server.close(() => resolve())
    })
  }

  #computeCacheUsage(body: {
    readonly system?: string
    readonly tools?: readonly { readonly name: string; readonly defer_loading?: true }[]
    readonly messages?: readonly unknown[]
  }): { readonly inputTokens: number; readonly cacheReadTokens: number; readonly cacheWriteTokens: number } {
    const coreToolSchemas = (body.tools ?? []).filter((t) => t.defer_loading !== true)
    const headerKey = JSON.stringify({ system: body.system ?? '', tools: coreToolSchemas })
    const headerTokens = estimateTokens(headerKey)
    const msgList = body.messages ?? []

    // Walk prefix chunks [header, msg0, msg1, ...] to find the longest already-cached prefix
    let matchedTokens = 0
    let uncachedTokens = 0
    let runningKey = headerKey
    const headerMatched = this.#cachedPrefixes.has(runningKey)
    if (headerMatched) {
      matchedTokens += headerTokens
    } else {
      uncachedTokens += headerTokens
      this.#cachedPrefixes.add(runningKey)
    }

    let prefixBroken = !headerMatched
    for (const msg of msgList) {
      const serialized = JSON.stringify(msg)
      const tokens = estimateTokens(serialized)
      runningKey = `${runningKey}\n${serialized}`
      if (!prefixBroken && this.#cachedPrefixes.has(runningKey)) {
        matchedTokens += tokens
      } else {
        prefixBroken = true
        uncachedTokens += tokens
        this.#cachedPrefixes.add(runningKey)
      }
    }

    const isColdStart = matchedTokens === 0
    return {
      inputTokens: isColdStart ? Math.max(1, Math.ceil(uncachedTokens * 0.2)) : uncachedTokens,
      cacheReadTokens: matchedTokens,
      cacheWriteTokens: isColdStart ? Math.max(0, uncachedTokens - Math.ceil(uncachedTokens * 0.2)) : 0,
    }
  }

  #handleMessages(rawBody: string, res: ServerResponse): void {
    const body = JSON.parse(rawBody) as {
      model: string
      system?: string
      tools?: { name: string; defer_loading?: true }[]
      messages?: unknown[]
      output_config?: { effort?: string }
      thinking?: { type?: string }
    }
    const messages = JSON.stringify(body.messages ?? [])
    const captured: CapturedRequest = {
      model: body.model,
      tools: (body.tools ?? []).filter((t) => t.defer_loading !== true).map((t) => t.name),
      deferred: (body.tools ?? []).filter((t) => t.defer_loading === true).map((t) => t.name),
      additions: messages.split('"tool_addition"').length - 1,
      removals: messages.split('"tool_removal"').length - 1,
      effort: body.output_config?.effort,
      thinking: body.thinking?.type,
      system: body.system ?? '',
      messageCount: (body.messages ?? []).length,
      raw: messages,
      topLevelKeys: Object.keys(body),
    }
    const index = this.requests.length
    this.requests.push(captured)
    const usage = this.#computeCacheUsage(body)
    const reply = this.#script(captured, index)

    const send = (event: { type: string } & Record<string, unknown>) =>
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    send({
      type: 'message_start',
      message: {
        id: `msg_${index}`,
        type: 'message',
        role: 'assistant',
        content: [],
        model: body.model,
        stop_reason: null,
        usage: {
          input_tokens: usage.inputTokens,
          output_tokens: 1,
          cache_read_input_tokens: usage.cacheReadTokens,
          cache_creation_input_tokens: usage.cacheWriteTokens,
        },
      },
    })
    if ('tool' in reply) {
      send({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: `call_${index}`, name: reply.tool, input: {} },
      })
      send({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(reply.input ?? {}) },
      })
      send({ type: 'content_block_stop', index: 0 })
      send({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } })
    } else {
      send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply.text } })
      send({ type: 'content_block_stop', index: 0 })
      send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } })
    }
    send({ type: 'message_stop' })
    res.end()
  }
}

async function createMediaAndStickerHelper(rootDir: string): Promise<string> {
  const dir = path.join(rootDir, 'media-sticker-helper')
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'brain-plugin-media-sticker-helper',
      version: '1.0.0',
      private: true,
      type: 'module',
      main: 'index.ts',
      brain: {
        id: 'helper',
        kinds: ['capability'],
        api: '^1.0.0',
        runtime: 'node',
        permissions: ['tools.register', 'channel.send'],
        tools: [
          {
            name: 'inspect_image',
            effect: 'read',
            load: 'context',
            group: 'vision',
            when: 'message.hasMedia',
            summary: '识别图片里的内容',
            keywords: ['看图', '图片'],
          },
          {
            name: 'send_sticker',
            effect: 'send',
            load: 'onDemand',
            group: 'stickers',
            summary: '发送一个表情包',
            keywords: ['表情', '斗图', 'sticker'],
            textArg: 'meaning',
          },
        ],
        groups: {
          vision: { summary: '看图与图片识别' },
          stickers: { summary: '表情包发送', usage: '每次只发一个最贴切的词。' },
        },
      },
    }, null, 2),
    'utf8',
  )
  await writeFile(
    path.join(dir, 'index.ts'),
    `const sent = (globalThis.__at7Stickers ??= [])
export function apply(ctx) {
  ctx.tools.register({
    name: 'inspect_image',
    description: '识别图片内容',
    parameters: { type: 'object', properties: { focus: { type: 'string' } } },
    handler: async () => '图片内容：一只橘猫在晒太阳',
  })
  ctx.tools.register({
    name: 'send_sticker',
    description: '发送一个表情包',
    parameters: {
      type: 'object',
      properties: { meaning: { type: 'string' } },
      required: ['meaning'],
    },
    handler: async (args, call) => {
      sent.push({ channel: call.channel, meaning: args.meaning })
      return 'sticker-sent:' + args.meaning
    },
  })
}\n`,
    'utf8',
  )
  return dir
}

function readWakeMetrics(brainHome: string): readonly WakeMetricSample[] {
  const db = new DatabaseSync(path.join(brainHome, 'state', 'agent', 'metrics.db'), { readOnly: true })
  try {
    const rows = db.prepare(
      'SELECT wake_id, channel, agent_class, profile_version, arrived_at, first_send_at, debounce_ms, steps, retries, outcome'
      + ' FROM wake_metrics ORDER BY arrived_at ASC, wake_id ASC',
    ).all() as unknown as readonly {
      readonly wake_id: string
      readonly channel: string
      readonly agent_class: string
      readonly profile_version: number
      readonly arrived_at: number
      readonly first_send_at: number | null
      readonly debounce_ms: number
      readonly steps: string
      readonly retries: number
      readonly outcome: string
    }[]
    return rows.map((r) => ({
      wakeId: r.wake_id,
      channel: r.channel,
      agentClass: r.agent_class as AgentClass,
      profileVersion: r.profile_version,
      arrivedAt: r.arrived_at,
      ...(r.first_send_at === null ? {} : { firstSendAt: r.first_send_at }),
      debounceMs: r.debounce_ms,
      steps: JSON.parse(r.steps) as WakeMetricSample['steps'],
      retries: r.retries,
      outcome: r.outcome as WakeMetricSample['outcome'],
    }))
  } finally {
    db.close()
  }
}

test('AT-7: 50 scripted turns meet NFR-12, NFR-13, FR-T02/04/05/10 latency, steps, surface, and cache hit targets', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brain-at7-'))
  const brainHome = path.join(root, 'brain-home')
  const dshHome = path.join(root, 'fake-dsh-home')
  await mkdir(brainHome, { recursive: true })
  await mkdir(dshHome, { recursive: true })
  await mkdir(path.join(brainHome, 'state'), { recursive: true })

  ;(globalThis as { __at7Stickers?: unknown[] }).__at7Stickers = []
  t.after(() => { delete (globalThis as { __at7Stickers?: unknown }).__at7Stickers })

  // Explicit deepseek-flash + low in settings.json (no default in kernel/SDK)
  await writeFile(
    path.join(brainHome, 'state', 'settings.json'),
    JSON.stringify({ agents: { chat: { ...FLASH_LOW } }, timezone: 'UTC' }),
    'utf8',
  )

  // Advance offsetMs between turns while letting wall-clock ms flow within each turn for FR-T10 latency
  let offsetMs = 0
  const clock = { now: () => Date.now() + offsetMs }

  let turnSeq = 0
  let stepWithinTurn = 0
  let sentStickerThisTurn = false
  let sentMsgThisTurn = false
  let lastWakeMarker = ''

  const gateway = new PrefixCacheFakeGateway((request) => {
    const wakeText = extractLatestWakeText(request)
    if (wakeText !== '' && wakeText !== lastWakeMarker && !hasToolResultInLastMessage(request)) {
      lastWakeMarker = wakeText
      stepWithinTurn = 0
      sentStickerThisTurn = false
      sentMsgThisTurn = false
      turnSeq += 1
    } else {
      stepWithinTurn += 1
    }

    if (wakeText.includes('发个表情')) {
      const stickerVisible = request.tools.includes('helper__send_sticker')
        || request.deferred.includes('helper__send_sticker')
      if (!stickerVisible) {
        if (stepWithinTurn === 0) return { tool: 'tools__search', input: { query: '表情' } }
        return { tool: 'tools__load', input: { group: 'stickers' } }
      }
      if (!sentStickerThisTurn) {
        sentStickerThisTurn = true
        return { tool: 'helper__send_sticker', input: { meaning: `开心${turnSeq}` } }
      }
      if (!sentMsgThisTurn) {
        sentMsgThisTurn = true
        return { tool: 'console-chat__send_message', input: { text: `表情${turnSeq}` } }
      }
      return { text: '好。' }
    }

    if (wakeText.includes('看图问答')) {
      if (stepWithinTurn === 0) return { tool: 'helper__inspect_image', input: { focus: 'cat' } }
      if (stepWithinTurn === 1) return { tool: 'console-chat__send_message', input: { text: `橘猫${turnSeq}` } }
      return { text: '好。' }
    }

    // Normal Q&A (40 turns): step 0 sends reply immediately, step 1 finishes (steps = 2)
    if (stepWithinTurn === 0) {
      return { tool: 'console-chat__send_message', input: { text: `答复${turnSeq}` } }
    }
    return { text: '好。' }
  })
  await gateway.listen()

  const kernel = await createKernel({
    env: { ...process.env, BRAIN_HOME: brainHome, DSH_HOME: dshHome },
    userHome: brainHome,
    port: 0,
    crossChannel: 'shadow',
    clock,
    log: capturingLogger([]),
    token: TEST_TOKEN,
    baseUrl: gateway.url,
  })

  t.after(async () => {
    await kernel.close().catch(() => undefined)
    await gateway.close().catch(() => undefined)
    await removeTree(root)
  })

  await kernel.secrets.set('deepseek-api-key', 'fake-at7-key')
  await kernel.memory.persona.saveRoleCard({ name: 'at7-persona', text: LONG_PERSONA })

  const helperDir = await createMediaAndStickerHelper(root)
  await installAndEnablePlugin(kernel, CONSOLE_CHAT_DIR, 'console-chat')
  await installAndEnablePlugin(kernel, helperDir, 'helper')

  // Core budget check (NFR-13, FR-T02)
  const coreBudget = kernel.gateway.coreBudget('console-chat:private')
  assert.ok(coreBudget.count <= 8, `core tool count ${coreBudget.count} > 8`)
  assert.ok(coreBudget.tokens <= 2_000, `core tool tokens ${coreBudget.tokens} > 2000`)
  assert.equal(coreBudget.over, false)

  const channel = 'console-chat:private:owner'
  const ownerPersonId = await kernel.memory.identity.resolve('console-chat:owner')

  // 1. 40 normal Q&A turns
  for (let i = 1; i <= 40; i += 1) {
    offsetMs += 7_000
    const res = await httpJson<Envelope<{ readonly wake: WakeResult }>>(
      kernel.port,
      'POST',
      '/api/v1/plugins/console-chat/messages',
      {
        token: TEST_TOKEN,
        body: {
          channel,
          account: 'owner',
          displayName: '主人',
          text: `普通问题第 ${i} 轮：今天天气怎么样？`,
          messageId: `at7-qa-${i}`,
          tEvent: clock.now(),
          debounceMs: 0,
        },
      },
    )
    const data = assertUnwrappedOk(res.body)
    assert.equal(data.wake.acked, true)
    assert.equal(data.wake.sent, 1)
    assert.equal(data.wake.steps, 2)
  }

  const reqCountAfterQa = gateway.requests.length
  // Verify none of the 40 normal Q&A turns received context or onDemand tools
  for (const req of gateway.requests.slice(0, reqCountAfterQa)) {
    assert.equal(req.tools.includes('helper__inspect_image'), false, 'normal Q&A must not include vision context tool')
    assert.equal(req.deferred.includes('helper__inspect_image'), false)
    assert.equal(req.tools.includes('helper__send_sticker'), false)
    assert.equal(req.deferred.includes('helper__send_sticker'), false)
  }

  // 2. 5 image turns (triggering message.hasMedia -> helper__inspect_image)
  for (let i = 1; i <= 5; i += 1) {
    offsetMs += 7_000
    const tEvent = clock.now()
    const { id } = await kernel.memory.service.ingest(
      {
        kind: 'console-chat.message',
        channel,
        subjects: [ownerPersonId],
        actor: ownerPersonId,
        content: { text: `看图问答第 ${i} 张` },
        tEvent,
        idempotencyKey: `at7-img-${i}`,
      },
      { kind: 'kernel', source: 'console-chat', trust: 'owner', defaultVisibility: 'subject' },
    )
    const wake = await kernel.agent.wake(channel, {
      reason: 'message',
      messages: [
        {
          id,
          actor: ownerPersonId,
          name: '主人',
          text: `看图问答第 ${i} 张`,
          images: [{ mediaType: 'image/png', base64: PIXEL_1X1_PNG }],
          tEvent,
        },
      ],
    })
    assert.equal(wake.acked, true)
    assert.equal(wake.sent, 1)
  }
  const reqCountAfterImages = gateway.requests.length
  assert.ok(
    gateway.requests.slice(reqCountAfterQa, reqCountAfterImages).some(
      (r) => r.tools.includes('helper__inspect_image') || r.deferred.includes('helper__inspect_image'),
    ),
    'image turns must surface helper__inspect_image via message.hasMedia',
  )

  // 3. 5 sticker turns ("发个表情" -> tools__search -> tools__load("stickers") -> helper__send_sticker)
  for (let i = 1; i <= 5; i += 1) {
    offsetMs += 14_000
    const res = await httpJson<Envelope<{ readonly wake: WakeResult }>>(
      kernel.port,
      'POST',
      '/api/v1/plugins/console-chat/messages',
      {
        token: TEST_TOKEN,
        body: {
          channel,
          account: 'owner',
          displayName: '主人',
          text: `发个表情第 ${i} 次`,
          messageId: `at7-stk-${i}`,
          tEvent: clock.now(),
          debounceMs: 0,
        },
      },
    )
    const data = assertUnwrappedOk(res.body)
    assert.equal(data.wake.acked, true)
    assert.ok(data.wake.sent >= 1)
  }

  const stickersSent = (globalThis as { __at7Stickers?: { meaning: string }[] }).__at7Stickers ?? []
  assert.equal(stickersSent.length, 5, 'all 5 sticker turns must send a sticker')
  assert.ok(gateway.requests.some((r) => r.raw.includes('已加载，下一步可用')))

  // Verify tool surface is monotonically non-decreasing inside the session (FR-T04, W3)
  let prevSurface: readonly string[] = []
  for (const req of gateway.requests) {
    const combined = new Set([...req.tools, ...req.deferred])
    for (const toolName of prevSurface) {
      assert.equal(combined.has(toolName), true, `tool ${toolName} disappeared from session surface`)
    }
    prevSurface = [...combined]
  }

  // Evaluate FR-T10 metrics via console computeSatelliteMetricsSummary
  const metrics = readWakeMetrics(brainHome)
  assert.equal(metrics.length, 50, `expected 50 wake metric entries, got ${metrics.length}`)

  const sessionId = encodeSessionId({ agentClass: 'chat', channel, generation: 0 })
  const sessions: readonly SessionSurfaceInfo[] = [
    {
      sessionId,
      channel,
      agentClass: 'chat',
      toolCount: kernel.gateway.surfaceOf(sessionId).size,
    },
  ]
  const summary = computeSatelliteMetricsSummary(metrics, sessions)
  assert.equal(summary.empty, false)
  assert.equal(summary.totalWakes, 50)
  assert.ok(summary.firstSendLatencyMs !== null)
  assert.ok(summary.stepsPerReply !== null)
  assert.ok(summary.warmCacheHitRatio !== null)

  console.log(
    `AT-7 (50 turns): core=${coreBudget.count} tools/${coreBudget.tokens} tok, `
    + `firstSend p50=${summary.firstSendLatencyMs.p50.toFixed(1)}ms p95=${summary.firstSendLatencyMs.p95.toFixed(1)}ms, `
    + `steps p50=${summary.stepsPerReply.p50} p95=${summary.stepsPerReply.p95}, `
    + `warmCacheHitRatio=${(summary.warmCacheHitRatio * 100).toFixed(1)}%`,
  )

  assert.ok(summary.firstSendLatencyMs.p50 <= 5_000, `firstSend p50 ${summary.firstSendLatencyMs.p50} > 5000ms`)
  assert.ok(summary.stepsPerReply.p50 <= 2, `steps p50 ${summary.stepsPerReply.p50} > 2`)
  assert.ok(summary.warmCacheHitRatio >= 0.8, `warmCacheHitRatio ${summary.warmCacheHitRatio} < 0.80`)
})
