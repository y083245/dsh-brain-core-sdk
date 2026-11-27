import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import test from 'node:test'
import { encodeSessionId, isProcessAlive, killProcessTree, TurnTimeoutError, type ThinkingEffort } from '@dsh-brain-core/satellite-host'
import { FLASH_LOW, withRig } from '../src/rig.ts'

const session = encodeSessionId({ agentClass: 'chat', channel: 'test:chat:e7', generation: 0 })

async function waitForExit(pid: number): Promise<void> {
  for (let i = 0; i < 100 && isProcessAlive(pid); i += 1) await sleep(100)
  assert.equal(isProcessAlive(pid), false, `process ${pid} is still alive`)
}

test('close leaves no child behind', async () => {
  await withRig({ script: () => ({ text: 'done' }) }, async ({ bridge, satellite }) => {
    bridge.setSurface(session, ['demo__a'])
    await satellite.run(session, 'hello')
    const pid = satellite.pid as number
    assert.equal(isProcessAlive(pid), true)
    await satellite.close()
    await waitForExit(pid)
  })
})

test('after the child is killed, a new one resumes the conversation', async () => {
  await withRig({ script: () => ({ text: 'done' }) }, async ({ bridge, satellite, gateway, restart }) => {
    bridge.setSurface(session, ['demo__a'])
    await satellite.run(session, 'first message')
    await killProcessTree(satellite.pid as number)
    await satellite.close().catch(() => {})

    const next = await restart()
    next.bridge.setSurface(session, ['demo__a'])
    await next.satellite.resume(session)
    const result = await next.satellite.run(session, 'second message')
    assert.equal(result.finalResponse, 'done')
    const last = gateway.requests.at(-1)
    assert.match(last?.raw ?? '', /first message/)
    assert.match(last?.raw ?? '', /second message/)
  })
})

test('changing the model and effort takes effect after a restart and keeps the history', async () => {
  await withRig({ script: () => ({ text: 'done' }) }, async ({ bridge, satellite, gateway, restart }) => {
    bridge.setSurface(session, ['demo__a'])
    await satellite.run(session, 'before the change')
    await satellite.close()

    const next = await restart({ selection: { provider: 'deepseek-official', model: 'deepseek-v4-pro', effort: 'max' } })
    next.bridge.setSurface(session, ['demo__a'])
    await next.satellite.resume(session)
    await next.satellite.run(session, 'after the change')
    const last = gateway.requests.at(-1)
    assert.equal(last?.model, 'deepseek-v4-pro')
    assert.equal(last?.effort, 'max')
    assert.match(last?.raw ?? '', /before the change/)
  })
})

test('two processes share a home while using different models', async () => {
  const activity = encodeSessionId({ agentClass: 'activity', channel: 'test:feed:e7', generation: 0 })
  await withRig({ script: () => ({ text: 'done' }) }, async ({ bridge, satellite, gateway, restart }) => {
    const other = await restart({ agentClass: 'activity', selection: { provider: 'deepseek-official', model: 'deepseek-v4-pro', effort: 'high' } })
    bridge.setSurface(session, ['demo__a'])
    other.bridge.setSurface(activity, ['demo__b'])
    assert.notEqual(satellite.pid, other.satellite.pid)
    await Promise.all([satellite.run(session, 'chat turn'), other.satellite.run(activity, 'activity turn')])
    const byModel = new Map(gateway.requests.map(request => [request.model, request]))
    assert.equal(byModel.get('deepseek-flash')?.effort, 'low')
    assert.deepEqual(byModel.get('deepseek-flash')?.tools, ['demo__a'])
    assert.equal(byModel.get('deepseek-v4-pro')?.effort, 'high')
    assert.deepEqual(byModel.get('deepseek-v4-pro')?.tools, ['demo__b'])
  })
})

test('an effort the model does not support is refused, not swapped for another', async () => {
  const selection = { ...FLASH_LOW, effort: 'nonsense' as ThinkingEffort }
  await withRig({ script: () => ({ text: 'done' }), satellite: { selection }, autoStart: false }, async ({ satellite, gateway }) => {
    await assert.rejects(satellite.start(), /does not support reasoning effort "nonsense"/)
    assert.equal(gateway.requests.length, 0)
  })
})

test('a stuck turn times out, closes the child, and the session can carry on', async () => {
  let hang = true
  const script = () => (hang ? { hang: true as const } : { text: 'recovered' })
  await withRig({ script }, async ({ bridge, satellite, restart }) => {
    bridge.setSurface(session, ['demo__a'])
    await assert.rejects(satellite.run(session, 'this will hang', { timeoutMs: 1500 }), TurnTimeoutError)
    hang = false
    const next = await restart()
    next.bridge.setSurface(session, ['demo__a'])
    await next.satellite.resume(session)
    const result = await next.satellite.run(session, 'try again')
    assert.equal(result.finalResponse, 'recovered')
  })
})
