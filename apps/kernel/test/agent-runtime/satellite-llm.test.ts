import assert from 'node:assert/strict'
import test from 'node:test'
import { RunnerFailedError, SelectionMissingError, TurnInterruptedError, decodeSessionId } from '@brain-core/satellite-host'
import { createSatelliteLlm } from '../../src/agent-runtime/index.ts'
import { FakeRunner, rejection, turn } from './helpers.ts'

function make(): { runner: FakeRunner; llm: ReturnType<typeof createSatelliteLlm>; ids: string[] } {
  const runner = new FakeRunner()
  let n = 0
  const ids: string[] = []
  const llm = createSatelliteLlm({ runner, newId: () => { n += 1; const id = `JOB${n}`; ids.push(id); return id } })
  return { runner, llm, ids }
}

test('each call is a new empty-surface session on the activity process, with system and user joined by a blank line', async () => {
  const { runner, llm } = make()
  runner.script.push(() => turn({ finalResponse: '结果一' }), () => turn({ finalResponse: '结果二' }))
  assert.equal((await llm.complete({ system: '系统', user: '用户', maxOutputTokens: 100 })).text, '结果一')
  assert.equal((await llm.complete({ system: 'S2', user: 'U2', maxOutputTokens: 100 })).text, '结果二')
  assert.deepEqual(runner.runs.map((run) => run.agentClass), ['activity', 'activity'])
  assert.deepEqual(runner.runs.map((run) => decodeSessionId(run.sessionId)), [
    { agentClass: 'activity', channel: 'kernel:job:JOB1', generation: 0 },
    { agentClass: 'activity', channel: 'kernel:job:JOB2', generation: 0 },
  ])
  assert.deepEqual(runner.runs.map((run) => run.input), ['系统\n\n用户', 'S2\n\nU2'])
  assert.deepEqual(runner.runs.map((run) => run.options), [undefined, undefined])
})

test('tokens add up the four fields of every step', async () => {
  const { runner, llm } = make()
  runner.script.push(() => turn({ steps: [
    { inputTokens: 1, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 8 },
    { inputTokens: 16, outputTokens: 32, cacheReadTokens: 64, cacheWriteTokens: 128 },
  ] }), () => turn({ steps: [] }))
  assert.equal((await llm.complete({ system: 's', user: 'u', maxOutputTokens: 1 })).tokens, 255)
  assert.equal((await llm.complete({ system: 's', user: 'u', maxOutputTokens: 1 })).tokens, 0)
})

test('the session is purged after a success', async () => {
  const { runner, llm } = make()
  await llm.complete({ system: 's', user: 'u', maxOutputTokens: 1 })
  assert.deepEqual(runner.purged, [[runner.runs[0]?.sessionId]])
})

test('no model or a stopped runner becomes UNAVAILABLE, and the session is purged either way', async () => {
  const { runner, llm } = make()
  runner.script.push(() => { throw new SelectionMissingError('activity', 'model') })
  const missing = await rejection(llm.complete({ system: 's', user: 'u', maxOutputTokens: 1 }))
  assert.equal(missing.code, 'UNAVAILABLE')
  runner.script.push(() => { throw new RunnerFailedError('activity', 'stopped') })
  const failed = await rejection(llm.complete({ system: 's', user: 'u', maxOutputTokens: 1 }))
  assert.equal(failed.code, 'UNAVAILABLE')
  assert.deepEqual(runner.purged.map((ids) => decodeSessionId(ids[0] ?? '')?.channel), ['kernel:job:JOB1', 'kernel:job:JOB2'])
})

test('any other error passes through unchanged, and the session is still purged', async () => {
  const { runner, llm } = make()
  const boom = new TurnInterruptedError('timeout', 'slow')
  runner.script.push(() => { throw boom })
  assert.equal(await rejection(llm.complete({ system: 's', user: 'u', maxOutputTokens: 1 })), boom)
  assert.equal(runner.purged.length, 1)
})

test('a purge that fails changes neither the result nor the error', async () => {
  const { runner, llm } = make()
  runner.purgeError = new Error('locked')
  assert.equal((await llm.complete({ system: 's', user: 'u', maxOutputTokens: 1 })).text, '')
  const boom = new Error('model said no')
  runner.script.push(() => { throw boom })
  assert.equal(await rejection(llm.complete({ system: 's', user: 'u', maxOutputTokens: 1 })), boom)
})
