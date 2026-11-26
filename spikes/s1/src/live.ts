/**
 * Real-model experiments E5 and E6. Costs money, so it needs a key from the owner's own
 * terminal and stops at a token ceiling. Model and effort are always passed explicitly.
 *
 *   node spikes/s1/src/live.ts models  --provider P --model M --effort E   (free; reads the official listing)
 *   node spikes/s1/src/live.ts probe   --provider P --model M --effort E
 *   node spikes/s1/src/live.ts cache   --provider P --model M --effort E --steps 20 [--add-at 10] [--remove-at 10]
 *   node spikes/s1/src/live.ts latency --provider P --model M --effort E --n 20
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { BridgeServer, encodeSessionId, killProcessTree, requireSelection, Satellite, type BridgeTool, type ToolHandler } from '@brain-core/satellite-host'
import { hitRatio, stepUsages, TokenMeter, type StepUsage } from './usage.ts'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    provider: { type: 'string' },
    model: { type: 'string' },
    effort: { type: 'string' },
    steps: { type: 'string', default: '20' },
    'add-at': { type: 'string' },
    'remove-at': { type: 'string' },
    n: { type: 'string', default: '20' },
    'max-tokens': { type: 'string', default: '500000' },
  },
})
const scenario = positionals[0]
const selection = requireSelection({ provider: values.provider, model: values.model, effort: values.effort }, 'chat')
const apiKey = process.env.BRAIN_S1_DEEPSEEK_API_KEY
if (apiKey === undefined || apiKey === '') throw new Error('set BRAIN_S1_DEEPSEEK_API_KEY in your own terminal first')

const runsDir = path.join(import.meta.dirname, '..', 'runs')
const brainHome = path.join(runsDir, 'home')
const stamp = new Date().toISOString().replaceAll(':', '-')
const meter = new TokenMeter(Number(values['max-tokens']))
const TURN_TIMEOUT_MS = 20 * 60_000

/** Counts tokens as each step finishes. At the ceiling it kills the child and exits, because a looping model never ends its turn. */
function guard(satellite: Satellite): (notification: { readonly params: { readonly event?: unknown } }) => void {
  return ({ params }) => {
    if (params.event === undefined || !meter.add([params.event])) return
    console.error(`token ceiling reached: ${meter.spent} > ${meter.max}`)
    void killProcessTree(satellite.pid as number).finally(() => process.exit(2))
  }
}

function percentile(samples: readonly number[], share: number): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0
}

async function save(result: unknown): Promise<void> {
  await mkdir(runsDir, { recursive: true })
  const file = path.join(runsDir, `${stamp}-${scenario}-${selection.model}-${selection.effort}.json`)
  await writeFile(file, JSON.stringify({ scenario, selection, spent: meter.spent, result }, null, 2))
  console.log(`saved ${file}`)
}

/** A long, fixed persona: the prompt cache only matters when there is a real prefix to reuse. */
const PERSONA = Array.from({ length: 60 }, (_unused, index) =>
  `Rule ${index + 1}: stay calm, answer plainly, and follow the instructions in the most recent tool result exactly.`).join('\n')

const param = { note: { type: 'string', description: 'Optional note.' } }
const CATALOG: BridgeTool[] = [
  { name: 'demo__next', description: 'Advance to the next step. Call it whenever a tool result tells you to.', parameters: param },
  { name: 'demo__spare', description: 'A spare tool. Do not call it.', parameters: param },
  { name: 'demo__extra', description: 'An extra tool. Do not call it.', parameters: param },
]

async function withSatellite<T>(handler: (bridge: () => BridgeServer) => ToolHandler, body: (satellite: Satellite, bridge: BridgeServer) => Promise<T>): Promise<T> {
  const bridgeRef: { current?: BridgeServer } = {}
  const bridge = new BridgeServer({ catalog: CATALOG, handler: handler(() => bridgeRef.current as BridgeServer) })
  bridgeRef.current = bridge
  await bridge.listen()
  const satellite = new Satellite({ brainHome, agentClass: 'chat', selection, apiKey: apiKey as string, systemPrompt: PERSONA, bridge })
  try {
    await satellite.start()
    return await body(satellite, bridge)
  } finally {
    await satellite.close().catch(() => {})
    await bridge.close()
  }
}

const sessionId = encodeSessionId({ agentClass: 'chat', channel: `live:s1:${stamp.replace(/[^0-9]/g, '')}`, generation: 0 })

/** On the official endpoint the adapter takes model capabilities from this listing, so it answers D20 directly and uses no tokens. */
async function models(): Promise<void> {
  const reply = await fetch('https://api.deepseek.com/models', { headers: { 'x-api-key': apiKey as string } })
  const body = await reply.json() as {
    data?: { id: string; api_capabilities?: { anthropic_messages?: { tool_update?: string | null; system_prompt_update?: string | null } } }[]
  }
  const listed = (body.data ?? []).map(entry => ({
    id: entry.id,
    toolUpdate: entry.api_capabilities?.anthropic_messages?.tool_update ?? null,
    systemPromptUpdate: entry.api_capabilities?.anthropic_messages?.system_prompt_update ?? null,
  }))
  console.log({ status: reply.status })
  console.table(listed)
  await save({ status: reply.status, listed })
}

async function probe(): Promise<void> {
  await withSatellite(() => async () => 'ok', async (satellite, bridge) => {
    bridge.setSurface(sessionId, ['demo__next'])
    const result = await satellite.run(sessionId, 'Reply with exactly: ok', { timeoutMs: TURN_TIMEOUT_MS, onNotification: guard(satellite) })
    const usages = stepUsages(result.events)
    console.log({ finalResponse: result.finalResponse, finishReason: result.finishReason, usages })
    await save({ finalResponse: result.finalResponse, finishReason: result.finishReason, usages })
  })
}

async function cache(): Promise<void> {
  const steps = Number(values.steps)
  const addAt = values['add-at'] === undefined ? undefined : Number(values['add-at'])
  const removeAt = values['remove-at'] === undefined ? undefined : Number(values['remove-at'])
  let done = 0
  const handler = (bridge: () => BridgeServer): ToolHandler => async ({ sessionId: id, toolName }) => {
    if (toolName !== 'demo__next') return 'Do not call this tool. Call demo__next.'
    done += 1
    if (done === addAt) bridge().addToSurface(id, ['demo__extra'])
    if (done === removeAt) bridge().setSurface(id, ['demo__next'])
    return done >= steps ? 'All steps are done. Reply with exactly: ok' : `Step ${done} of ${steps} is done. Call demo__next again.`
  }
  await withSatellite(handler, async (satellite, bridge) => {
    bridge.setSurface(sessionId, ['demo__next', 'demo__spare'])
    const result = await satellite.run(sessionId, 'Start now: call demo__next.', { timeoutMs: TURN_TIMEOUT_MS, onNotification: guard(satellite) })
    const usages = stepUsages(result.events)
    const ratios = usages.map(hitRatio)
    const fromSecond = ratios.slice(1)
    const mean = fromSecond.reduce((sum, ratio) => sum + ratio, 0) / Math.max(1, fromSecond.length)
    ratios.forEach((ratio, index) => console.log(`step ${index + 1}: hit ${(ratio * 100).toFixed(1)}%  ${JSON.stringify(usages[index])}`))
    console.log({ steps: usages.length, meanHitFromStep2: mean, minHitFromStep2: Math.min(...fromSecond), finishReason: result.finishReason })
    await save({ addAt, removeAt, usages, ratios, meanHitFromStep2: mean, finishReason: result.finishReason })
  })
}

async function latency(): Promise<void> {
  const prompts = ['你好，今天过得怎么样？', '用一句话介绍一下你自己。', '推荐一本适合周末读的书。', '明天该穿什么？随便说说。', '你喜欢下雨天吗？']
  const n = Number(values.n)
  const samples: { firstMs: number; totalMs: number; steps: number }[] = []
  await withSatellite(() => async () => 'ok', async (satellite, bridge) => {
    bridge.setSurface(sessionId, ['demo__spare'])
    for (let i = 0; i < n; i += 1) {
      const started = performance.now()
      let firstMs: number | undefined
      const metered = guard(satellite)
      const result = await satellite.run(sessionId, prompts[i % prompts.length] as string, {
        timeoutMs: TURN_TIMEOUT_MS,
        onNotification: ({ params }) => {
          metered({ params })
          const event = params.event as { type?: string } | undefined
          if (event?.type === 'assistant/message') firstMs ??= performance.now() - started
        },
      })
      const usages = stepUsages(result.events)
      samples.push({ firstMs: firstMs ?? -1, totalMs: performance.now() - started, steps: usages.length })
      console.log(`turn ${i + 1}: first ${firstMs?.toFixed(0)} ms, steps ${usages.length}, hit ${(hitRatio(usages[0] as StepUsage) * 100).toFixed(1)}%`)
    }
  })
  const first = samples.map(sample => sample.firstMs)
  const steps = samples.map(sample => sample.steps)
  const summary = { firstP50: percentile(first, 0.5), firstP95: percentile(first, 0.95), stepsP50: percentile(steps, 0.5) }
  console.log(summary)
  await save({ samples, summary })
}

const scenarios: Record<string, () => Promise<void>> = { models, probe, cache, latency }
const run = scenario === undefined ? undefined : scenarios[scenario]
if (run === undefined) throw new Error(`unknown scenario "${scenario}"; expected models, probe, cache or latency`)
await run()
console.log(`tokens spent: ${meter.spent}`)
