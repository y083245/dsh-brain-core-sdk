/**
 * Real-model acceptance runner for AT-7 (requires BRAIN_S1_DEEPSEEK_API_KEY in caller's environment).
 *
 * Example:
 *   node --env-file=spikes/s1/.env.local acceptance/live.ts
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { computeSatelliteMetricsSummary, type SessionSurfaceInfo, type WakeMetricSample } from '@brain-core/console'
import { createKernel } from '@brain-core/kernel/assembly'
import { encodeSessionId, removeTree, type AgentClass } from '@brain-core/satellite-host'
import type { Envelope, WakeResult } from '@brain-core/sdk'
import { CONSOLE_CHAT_DIR, FLASH_LOW, TEST_TOKEN, capturingLogger, installAndEnablePlugin } from './helpers.ts'

const MAX_TOKENS = 500_000
const TURN_TIMEOUT_MS = 120_000

const apiKey = process.env.BRAIN_S1_DEEPSEEK_API_KEY
if (apiKey === undefined || apiKey === '') {
  throw new Error('set BRAIN_S1_DEEPSEEK_API_KEY before running acceptance/live.ts')
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

function sumTokens(metrics: readonly WakeMetricSample[]): number {
  let total = 0
  for (const entry of metrics) {
    for (const step of entry.steps) {
      total += step.inputTokens + step.outputTokens + step.cacheReadTokens + step.cacheWriteTokens
    }
  }
  return total
}

const root = await mkdtemp(path.join(os.tmpdir(), 'brain-at7-live-'))
const brainHome = path.join(root, 'brain-home')
const dshHome = path.join(root, 'fake-dsh-home')
await mkdir(path.join(brainHome, 'state'), { recursive: true })
await mkdir(dshHome, { recursive: true })
await writeFile(
  path.join(brainHome, 'state', 'settings.json'),
  JSON.stringify({ agents: { chat: { ...FLASH_LOW } }, timezone: 'UTC' }),
  'utf8',
)

const kernel = await createKernel({
  env: { ...process.env, BRAIN_HOME: brainHome, DSH_HOME: dshHome },
  userHome: brainHome,
  port: 0,
  crossChannel: 'shadow',
  log: capturingLogger([]),
  token: TEST_TOKEN,
})

try {
  await kernel.secrets.set('deepseek-api-key', apiKey)
  await kernel.memory.persona.saveRoleCard({
    name: 'live-persona',
    text: '你是小满，一个在控制台里陪伴主人的朋友。说话自然简短，直接用 console-chat__send_message 回复。',
  })
  await installAndEnablePlugin(kernel, CONSOLE_CHAT_DIR, 'console-chat')

  const prompts = [
    '你好呀，今天过得怎么样？',
    '用一句话告诉我你最喜欢什么季节。',
    '晚上想喝点热茶，推荐一种吧。',
    '明天出门要不要带伞？随便聊聊。',
    '最后说一句晚安吧。',
  ]
  const channel = 'console-chat:private:owner'

  for (let i = 0; i < prompts.length; i += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS)
    try {
      const res = await fetch(`http://127.0.0.1:${kernel.port}/api/v1/plugins/console-chat/messages`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          channel,
          account: 'owner',
          displayName: '主人',
          text: prompts[i],
          messageId: `live-${i + 1}`,
          debounceMs: 0,
        }),
      })
      const body = await res.json() as Envelope<{ readonly wake: WakeResult }>
      if (!body.ok) throw new Error(`turn ${i + 1} failed: ${body.error.code} ${body.error.message}`)
    } finally {
      clearTimeout(timer)
    }
    const spent = sumTokens(readWakeMetrics(brainHome))
    if (spent > MAX_TOKENS) {
      throw new Error(`token ceiling reached (${spent} > ${MAX_TOKENS})`)
    }
  }

  const metrics = readWakeMetrics(brainHome)
  const sessionId = encodeSessionId({ agentClass: 'chat', channel, generation: 0 })
  const sessions: readonly SessionSurfaceInfo[] = [
    { sessionId, channel, agentClass: 'chat', toolCount: kernel.gateway.surfaceOf(sessionId).size },
  ]
  const summary = computeSatelliteMetricsSummary(metrics, sessions)
  console.log(JSON.stringify({ spentTokens: sumTokens(metrics), summary }, null, 2))
} finally {
  await kernel.close()
  await removeTree(root)
}
