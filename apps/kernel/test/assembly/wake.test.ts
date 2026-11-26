import assert from 'node:assert/strict'
import test from 'node:test'
import { BrainError } from '@brain-core/sdk'
import { CHANNEL, FLASH, SAMPLE_PLUGIN, installPlugin, readSatellitePid, setup } from './helpers.ts'

const MODEL_SETTINGS = { agents: { chat: { ...FLASH } } }
const ROLE = '你是小满，说话简短，不寒暄。'

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return 'ok'
  } catch (error) {
    return error instanceof BrainError ? error.code : 'other'
  }
}

test('FR-T06: a plain answer takes at most two model steps and no waiting tool is offered', async (t) => {
  const h = await setup(t, { settings: MODEL_SETTINGS, apiKey: 'fake-key', roleCard: ROLE })
  const result = await h.wake()
  assert.equal(result.acked, true)
  assert.ok(result.steps <= 2, `took ${result.steps} steps`)
  assert.equal(result.sent, 0)
  for (const request of h.fake.requests) {
    assert.equal(request.tools.some((name) => /wait|sleep|delay/i.test(name)), false)
  }
})

test('FR-T05: ten wakes send the same system, tool list and history prefix byte for byte', async (t) => {
  const h = await setup(t, { settings: MODEL_SETTINGS, apiKey: 'fake-key', roleCard: ROLE })
  for (let index = 0; index < 10; index += 1) await h.wake(CHANNEL, `第${index + 1}句话`)
  const requests = h.fake.requests
  assert.equal(requests.length, 10)
  const first = requests[0]!
  for (const request of requests.slice(1)) {
    assert.equal(request.system, first.system, 'system prompt')
    assert.deepEqual(request.tools, first.tools, 'tool definitions')
    assert.deepEqual(request.deferred, first.deferred, 'deferred tools')
  }
  // The history each turn sees begins with exactly the bytes of the first turn's messages.
  const prefix = first.raw.endsWith(']') ? first.raw.slice(0, -1) : first.raw
  for (const request of requests.slice(1)) {
    assert.ok(request.raw.startsWith(prefix), 'history prefix')
  }
})

test('without a model, a key or a role card a wake is UNAVAILABLE, the message is stored and no process starts', async (t) => {
  const cases = [
    { name: 'no selection', options: { roleCard: ROLE, apiKey: 'fake-key' } },
    { name: 'no key', options: { settings: MODEL_SETTINGS, roleCard: ROLE } },
    { name: 'no role card', options: { settings: MODEL_SETTINGS, apiKey: 'fake-key' } },
  ] as const
  for (const item of cases) {
    const h = await setup(t, item.options)
    const id = await h.ingest(CHANNEL, `消息：${item.name}`)
    assert.equal(await codeOf(h.kernel.agent.wake(CHANNEL, {
      reason: 'message',
      messages: [{ id, actor: 'p1', name: '小明', text: `消息：${item.name}`, tEvent: Date.now() }],
    })), 'UNAVAILABLE', item.name)
    const stored = await h.kernel.memory.store.get(id)
    assert.notEqual(stored, null, item.name)
    assert.equal(stored?.status, 'active')
    assert.equal(await readSatellitePid(h.home), undefined, item.name)
    await h.kernel.close()
  }
})

test('tools__search and tools__load put an onDemand send tool on the next step of deepseek-flash', async (t) => {
  ;(globalThis as { __brainSampleSent?: unknown[] }).__brainSampleSent = []
  const h = await setup(t, {
    settings: MODEL_SETTINGS,
    apiKey: 'fake-key',
    roleCard: ROLE,
    plugin: true,
    script: (_request, index) => {
      if (index === 0) return { tool: 'tools__search', input: { query: '发消息' } }
      if (index === 1) return { tool: 'tools__load', input: { group: 'messaging' } }
      if (index === 2) return { tool: 'sample__say', input: { text: '你好呀，今天过得怎么样' } }
      return { text: '好。' }
    },
  })
  const result = await h.wake(CHANNEL, '跟我说一句话')
  assert.equal(result.acked, true)
  assert.equal(result.sent, 1)

  const requests = h.fake.requests
  const visible = (request: typeof requests[number]): boolean => request.tools.includes('sample__say') || request.deferred.includes('sample__say')
  // Before the load the adapter is not told about the onDemand tool at all; the step after the load result carries it.
  assert.equal(visible(requests[0]!), false)
  assert.equal(visible(requests[1]!), false)
  assert.ok(requests.some((request) => request.raw.includes('已加载，下一步可用')))
  assert.equal(visible(requests[2]!), true, 'the send tool reaches the adapter one step after tools__load')

  const sent = (globalThis as { __brainSampleSent?: { channel: string; text?: string }[] }).__brainSampleSent ?? []
  assert.deepEqual(sent, [{ channel: CHANNEL, text: '你好呀，今天过得怎么样' }])
})

test('T4: an onDemand send tool is audited and rate limited; the plugin is not called past the limit', async (t) => {
  ;(globalThis as { __brainSampleSent?: unknown[] }).__brainSampleSent = []
  const h = await setup(t, {
    settings: MODEL_SETTINGS,
    apiKey: 'fake-key',
    roleCard: ROLE,
    plugin: true,
    script: (_request, index) => {
      if (index === 0) return { tool: 'tools__load', input: { group: 'messaging' } }
      if (index === 1) return { tool: 'sample__say', input: { text: '第一句话，今天过得怎么样' } }
      if (index === 2) return { tool: 'sample__say', input: { text: '第二句话，午饭吃了什么' } }
      if (index === 3) return { tool: 'sample__say', input: { text: '第三句话，晚上早点休息' } }
      return { text: '好。' }
    },
  })
  const result = await h.wake(CHANNEL, '聊聊天')
  assert.equal(result.acked, true)
  assert.equal(result.sent, 1)

  const sent = (globalThis as { __brainSampleSent?: { channel: string; text?: string }[] }).__brainSampleSent ?? []
  assert.equal(sent.length, 1, 'the plugin send runs once; the later calls are refused before the plugin')

  const limited = h.fake.requests.filter((request) => request.raw.includes('发得太频繁了'))
  assert.ok(limited.length >= 2, 'the model is told the send was rate limited')

  const { createOutboundAudit } = await import('../../src/runtime-stores/index.ts')
  const audit = await createOutboundAudit(`${h.home}/state/agent/outbound.db`)
  const rows = await audit.list()
  await audit.close()
  assert.ok(rows.some((row) => row.tool === 'sample__say' && row.pluginId === 'sample' && row.ok === true))
  assert.ok(rows.some((row) => row.tool === 'channel.send' && row.pluginId === 'sample' && row.ok === true))
})

test('a new role card restarts the chat process, resumes the session and reaches the model', async (t) => {
  const h = await setup(t, { settings: MODEL_SETTINGS, apiKey: 'fake-key', roleCard: '旧人设：你是小满。' })
  await h.wake(CHANNEL, '第一句话')
  const { waitForSatellitePid } = await import('./helpers.ts')
  const oldPid = await waitForSatellitePid(h.home)

  await h.kernel.memory.persona.saveRoleCard({ name: 'assembly-persona', text: '新人设：你是阿灯。' })
  await h.wake(CHANNEL, '第二句话')
  await h.wake(CHANNEL, '第三句话')

  const newPid = await waitForSatellitePid(h.home, 'chat', oldPid)
  assert.notEqual(newPid, oldPid, 'the chat process was restarted')
  const last = h.fake.requests.at(-1)!
  // deepseek-flash takes a changed system prompt in history, not in the system field (S1's models probe).
  assert.ok(last.raw.includes('新人设'), 'the new persona reaches the model in history')
  assert.ok(last.raw.includes('第一句话'), 'the old session was resumed, not replaced')
})

test('enabling a plugin puts its tools on the next wake through the catalog listener', async (t) => {
  const h = await setup(t, { settings: MODEL_SETTINGS, apiKey: 'fake-key', roleCard: ROLE })
  await h.wake(CHANNEL, '第一句话')
  assert.equal(h.fake.requests.at(-1)!.raw.includes('sample__remember'), false)

  await installPlugin(h.kernel, SAMPLE_PLUGIN, 'sample')
  await h.wake(CHANNEL, '第二句话')
  // deepseek-flash takes tool additions in the history as `tool_addition` blocks, not in the tools array.
  const last = h.fake.requests.at(-1)!
  assert.ok(last.additions >= 1, 'the adapter was told about an addition')
  assert.ok(last.raw.includes('sample__remember'), 'the new tool reached the next wake')
})
