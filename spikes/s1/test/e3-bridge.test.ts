import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeSessionId, encodeSessionId, type ToolCall } from '@brain-core/satellite-host'
import { withRig } from '../src/rig.ts'

const channel = 'test:chat:bound'
const sessionId = encodeSessionId({ agentClass: 'chat', channel, generation: 0 })

test('the viewer comes from the session id; a channel in the arguments changes nothing', async () => {
  const calls: ToolCall[] = []
  const script = (_request: unknown, index: number) => (index === 0
    ? { tool: 'demo__a', input: { text: 'hi', channel: 'test:chat:someone-else' } }
    : { text: 'done' })
  await withRig({ script, handler: async call => { calls.push(call); return 'ok' } }, async ({ bridge, satellite }) => {
    bridge.setSurface(sessionId, ['demo__a'])
    const result = await satellite.run(sessionId, 'hello')
    assert.equal(result.finalResponse, 'done')
  })
  assert.equal(calls.length, 1)
  assert.equal(decodeSessionId(calls[0]?.sessionId ?? '')?.channel, channel)
})

test('the tool result reaches the model', async () => {
  const script = (_request: unknown, index: number) => (index === 0 ? { tool: 'demo__a' } : { text: 'done' })
  await withRig({ script, handler: async () => 'tool-output-marker' }, async ({ bridge, satellite, gateway }) => {
    bridge.setSurface(sessionId, ['demo__a'])
    await satellite.run(sessionId, 'hello')
    assert.match(gateway.requests[1]?.raw ?? '', /tool-output-marker/)
  })
})

test('a tool error is reported to the model instead of crashing the turn', async () => {
  const script = (_request: unknown, index: number) => (index === 0 ? { tool: 'demo__a' } : { text: 'done' })
  await withRig({ script, handler: async () => { throw new Error('tool-failure-marker') } }, async ({ bridge, satellite, gateway }) => {
    bridge.setSurface(sessionId, ['demo__a'])
    const result = await satellite.run(sessionId, 'hello')
    assert.equal(result.finalResponse, 'done')
    assert.match(gateway.requests[1]?.raw ?? '', /tool-failure-marker/)
  })
})

test('the bundle reports the child pid', async () => {
  await withRig({ script: () => ({ text: 'done' }) }, async ({ bridge, satellite }) => {
    bridge.setSurface(sessionId, [])
    assert.equal(typeof satellite.pid, 'number')
    assert.notEqual(satellite.pid, process.pid)
    assert.equal(bridge.childPid, satellite.pid)
  })
})

test('PERF: a bridge round trip adds at most 10 ms at p95', async () => {
  await withRig({ script: () => ({ text: 'done' }), handler: async () => 'ok', autoStart: false }, async ({ bridge }) => {
    bridge.setSurface(sessionId, ['demo__a'])
    const headers = { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' }
    const body = JSON.stringify({ sessionId, toolName: 'demo__a', args: {} })
    const samples: number[] = []
    for (let i = 0; i < 300; i += 1) {
      const started = performance.now()
      await (await fetch(`${bridge.url}/bridge/v1/calls`, { method: 'POST', headers, body })).json()
      if (i >= 50) samples.push(performance.now() - started)
    }
    samples.sort((a, b) => a - b)
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? Infinity
    console.log(`bridge round trip p95 = ${p95.toFixed(2)} ms`)
    assert.ok(p95 <= 10, `p95 was ${p95} ms`)
  })
})

test('an inline image reaches the model with every local file tool switched off', async () => {
  const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg=='
  await withRig({ script: () => ({ text: 'done' }) }, async ({ bridge, satellite, gateway }) => {
    bridge.setSurface(sessionId, ['demo__a'])
    const result = await satellite.run(sessionId, [
      { type: 'text', text: 'what is this?' },
      { type: 'image', data: pixel, mimeType: 'image/png' },
    ])
    assert.equal(result.finalResponse, 'done')
    assert.match(gateway.requests[0]?.raw ?? '', /"type":"image"/)
    assert.equal(gateway.uploads, 1)
  })
})
