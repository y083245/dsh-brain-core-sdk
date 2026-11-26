import assert from 'node:assert/strict'
import test from 'node:test'
import { createSatelliteLlm, type DetailedLlmResult } from '../../src/agent-runtime/index.ts'
import type { TokenUsage } from '../../src/contracts/index.ts'
import { FakeRunner, harness, msg, turn } from './helpers.ts'

test('createSatelliteLlm exposes completeDetailed with selection and onUsage isolation', async () => {
  const runner = new FakeRunner()
  let seq = 0
  const observed: DetailedLlmResult[] = []
  let throwInOnUsage = false

  const llm = createSatelliteLlm({
    runner,
    newId: () => `ID${++seq}`,
    selection: async () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
    onUsage: (info) => {
      observed.push(info)
      if (throwInOnUsage) throw new Error('onUsage boom')
    },
  })

  runner.script.push(() => turn({
    finalResponse: '精确回复',
    steps: [
      { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 10 },
      { inputTokens: 40, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ],
  }))

  const res = await llm.completeDetailed({ system: 'sys', user: 'usr', maxOutputTokens: 256 })
  assert.equal(res.text, '精确回复')
  assert.equal(res.tokens, 230)
  assert.deepEqual(res.usage, {
    inputTokens: 140,
    outputTokens: 30,
    cacheReadTokens: 50,
    cacheWriteTokens: 10,
  })
  assert.equal(res.provider, 'deepseek-official')
  assert.equal(res.model, 'deepseek-flash')
  assert.equal(observed.length, 1)

  throwInOnUsage = true
  runner.script.push(() => turn({ finalResponse: '依然成功', steps: [{ inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }] }))
  const res2 = await llm.complete({ system: 's', user: 'u', maxOutputTokens: 10 })
  assert.deepEqual(res2, { text: '依然成功', tokens: 7 })
})

test('createAgentRuntime invokes onTurnUsage with summed step tokens and isolates callback errors', async () => {
  const h = await harness()
  const recorded: {
    readonly wakeId: string
    readonly channel: string
    readonly agentClass: string
    readonly usage: TokenUsage
    readonly tAt: number
  }[] = []
  let shouldFail = false

  const runtime = h.rebuild({
    onTurnUsage: (info) => {
      recorded.push(info)
      if (shouldFail) throw new Error('accounting down')
    },
  })

  try {
    h.runner.script.push(() => turn({
      finalResponse: 'ok',
      steps: [
        { inputTokens: 10, outputTokens: 4, cacheReadTokens: 80, cacheWriteTokens: 5 },
        { inputTokens: 20, outputTokens: 6, cacheReadTokens: 40, cacheWriteTokens: 0 },
      ],
    }))

    const r1 = await runtime.wake('console-chat:private:owner', {
      reason: 'message',
      messages: [msg('l0_1', '你好')],
    })
    assert.equal(r1.acked, true)
    assert.equal(recorded.length, 1)
    assert.equal(recorded[0]!.wakeId, r1.wakeId)
    assert.equal(recorded[0]!.channel, 'console-chat:private:owner')
    assert.equal(recorded[0]!.agentClass, 'chat')
    assert.deepEqual(recorded[0]!.usage, {
      inputTokens: 30,
      outputTokens: 10,
      cacheReadTokens: 120,
      cacheWriteTokens: 5,
    })

    shouldFail = true
    h.runner.script.push(() => turn({
      finalResponse: 'still ok',
      steps: [{ inputTokens: 3, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }],
    }))
    const r2 = await runtime.wake('console-chat:private:owner', {
      reason: 'message',
      messages: [msg('l0_2', '还在吗')],
    })
    assert.equal(r2.acked, true)
    assert.ok(h.logs.some((entry) => entry.level === 'warn' && entry.event === 'agent-runtime.turn_usage_failed'))
  } finally {
    await runtime.close()
    await h.cleanup()
  }
})
