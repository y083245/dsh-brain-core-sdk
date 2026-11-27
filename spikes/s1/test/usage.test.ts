import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeSessionId } from '@dsh-brain-core/satellite-host'
import { scriptedTools } from '../src/fake-deepseek.ts'
import { withRig } from '../src/rig.ts'
import { TokenMeter } from '../src/usage.ts'

const message = (usage: Record<string, number>) => ({ type: 'assistant/message', data: { usage } })

test('the meter adds every kind of token and trips above the ceiling', () => {
  const meter = new TokenMeter(100)
  assert.equal(meter.add([message({ inputTokens: 10, cacheReadTokens: 80 })]), false)
  assert.equal(meter.add([{ type: 'something/else' }]), false)
  assert.equal(meter.add([message({ outputTokens: 11 })]), true)
  assert.equal(meter.spent, 101)
})

test('usage arrives through notifications while the turn is still running', async () => {
  const session = encodeSessionId({ agentClass: 'chat', channel: 'test:chat:meter', generation: 0 })
  const meter = new TokenMeter(1_000_000)
  let calls = 0
  let spentAtSecondCall = 0
  const handler = async () => {
    calls += 1
    if (calls === 2) spentAtSecondCall = meter.spent
    return 'ok'
  }
  await withRig({ script: scriptedTools('demo__a', 'demo__a'), handler }, async ({ bridge, satellite }) => {
    bridge.setSurface(session, ['demo__a'])
    await satellite.run(session, 'hello', {
      onNotification: ({ params }) => {
        const event = params.event as unknown
        if (event !== undefined) meter.add([event])
      },
    })
  })
  assert.equal(calls, 2)
  assert.ok(spentAtSecondCall > 0, 'a looping turn must be visible to the meter before it ends')
})
