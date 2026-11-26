import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeSessionId, type BridgeServer } from '@brain-core/satellite-host'
import { scriptedTools } from '../src/fake-deepseek.ts'
import { FLASH_LOW, withRig } from '../src/rig.ts'

const idOf = (channel: string) => encodeSessionId({ agentClass: 'chat', channel, generation: 0 })

test('one process serves two sessions with different tools', async () => {
  const [left, right] = [idOf('test:chat:left'), idOf('test:chat:right')]
  await withRig({ script: () => ({ text: 'done' }) }, async ({ bridge, satellite, gateway }) => {
    bridge.setSurface(left, ['demo__a'])
    bridge.setSurface(right, ['demo__b', 'demo__c'])
    await Promise.all([satellite.run(left, 'hello left'), satellite.run(right, 'hello right')])
    const seen = gateway.requests.map(request => [...request.tools].sort().join(','))
    assert.deepEqual(seen.sort(), ['demo__a', 'demo__b,demo__c'])
  })
})

test('activation takes effect on the next step, as a deferred addition on flash', async () => {
  const session = idOf('test:chat:activate')
  let holder: BridgeServer | undefined
  const handler = async ({ toolName }: { toolName: string }) => {
    if (toolName === 'demo__a') holder?.addToSurface(session, ['demo__b'])
    return `ran ${toolName}`
  }
  await withRig({ script: scriptedTools('demo__a', 'demo__b'), handler }, async ({ bridge, satellite, gateway }) => {
    holder = bridge
    bridge.setSurface(session, ['demo__a'])
    const result = await satellite.run(session, 'hello')
    assert.equal(result.finalResponse, 'done')
    assert.deepEqual(gateway.requests[0]?.tools, ['demo__a'])
    assert.deepEqual(gateway.requests[0]?.deferred, [])
    assert.deepEqual(gateway.requests[1]?.tools, ['demo__a'])
    assert.deepEqual(gateway.requests[1]?.deferred, ['demo__b'])
    assert.equal(gateway.requests[1]?.additions, 1)
    assert.match(gateway.requests[2]?.raw ?? '', /ran demo__b/)
  })
})

test('the surface is fetched once per step, not once per tool or per turn', async () => {
  const session = idOf('test:chat:pulls')
  await withRig({ script: scriptedTools('demo__a', 'demo__a') }, async ({ bridge, satellite, gateway }) => {
    bridge.setSurface(session, ['demo__a'])
    await satellite.run(session, 'hello')
    assert.equal(gateway.requests.length, 3)
    assert.equal(bridge.surfacePulls.get(session), 3)
  })
})

test('a model without incremental updates still works, sending the full list each time', async () => {
  const session = idOf('test:chat:pro')
  let holder: BridgeServer | undefined
  const handler = async () => { holder?.addToSurface(session, ['demo__b']); return 'ok' }
  await withRig({
    script: scriptedTools('demo__a'),
    handler,
    satellite: { selection: { ...FLASH_LOW, model: 'deepseek-v4-pro' } },
  }, async ({ bridge, satellite, gateway }) => {
    holder = bridge
    bridge.setSurface(session, ['demo__a'])
    await satellite.run(session, 'hello')
    assert.deepEqual(gateway.requests[1]?.tools, ['demo__a', 'demo__b'])
    assert.deepEqual(gateway.requests[1]?.deferred, [])
    assert.equal(gateway.requests[1]?.additions, 0)
  })
})

test('a hidden tool is unknown to DSH, and the model is told so', async () => {
  const session = idOf('test:chat:hidden')
  await withRig({ script: scriptedTools('demo__b') }, async ({ bridge, satellite, gateway }) => {
    bridge.setSurface(session, ['demo__a'])
    const result = await satellite.run(session, 'hello')
    assert.equal(result.finalResponse, 'done')
    assert.match(gateway.requests[1]?.raw ?? '', /unknown tool/)
  })
})

test('an unbound session id sees no tools at all', async () => {
  await withRig({ script: () => ({ text: 'done' }) }, async ({ satellite, gateway }) => {
    await satellite.run('not-one-of-ours', 'hello')
    assert.deepEqual(gateway.requests[0]?.tools ?? [], [])
  })
})

test('the owner\'s effort choice reaches the request', async () => {
  const session = idOf('test:chat:effort')
  for (const [effort, wire, thinking] of [['low', 'low', 'enabled'], ['max', 'max', 'enabled'], ['off', undefined, 'disabled']] as const) {
    await withRig({ script: () => ({ text: 'done' }), satellite: { selection: { ...FLASH_LOW, effort } } }, async ({ bridge, satellite, gateway }) => {
      bridge.setSurface(session, ['demo__a'])
      await satellite.run(session, 'hello')
      assert.equal(gateway.requests[0]?.effort, wire)
      assert.equal(gateway.requests[0]?.thinking, thinking)
    })
  }
})

test('model-default leaves the choice to the adapter, which currently sends high', async () => {
  const session = idOf('test:chat:default')
  await withRig({ script: () => ({ text: 'done' }), satellite: { selection: { ...FLASH_LOW, effort: 'model-default' } } }, async ({ bridge, satellite, gateway }) => {
    bridge.setSurface(session, ['demo__a'])
    await satellite.run(session, 'hello')
    assert.equal(gateway.requests[0]?.effort, 'high')
  })
})
