import assert from 'node:assert/strict'
import test from 'node:test'
import { FakeDeepSeek, scriptedTools, type FakeScript } from '../src/index.ts'

async function withGateway(script: FakeScript, run: (gateway: FakeDeepSeek) => Promise<void>): Promise<void> {
  const gateway = new FakeDeepSeek(script)
  await gateway.listen()
  try {
    await run(gateway)
  } finally {
    await gateway.close()
  }
}

test('GET /models returns the two documented models', async () => {
  await withGateway(() => ({ text: 'unused' }), async (gateway) => {
    const response = await fetch(`${gateway.url}/models`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      data: [
        {
          id: 'deepseek-flash',
          api_capabilities: {
            anthropic_messages: { tool_update: 'addition-only', system_prompt_update: 'in-history' },
          },
        },
        {
          id: 'deepseek-v4-pro',
          api_capabilities: {
            anthropic_messages: { tool_update: 'leading-only', system_prompt_update: 'leading-only' },
          },
        },
      ],
    })
    assert.equal(gateway.requests.length, 0)
  })
})

test('scriptedTools answers with tool calls and then text, and captures the request', async () => {
  await withGateway(scriptedTools('look', 'tools__load'), async (gateway) => {
    const body = {
      model: 'deepseek-flash',
      system: 'sys',
      tools: [
        { name: 'look' },
        { name: 'later', defer_loading: true },
      ],
      messages: [
        { role: 'user', content: [{ type: 'tool_addition', name: 'look' }] },
        { role: 'user', content: [{ type: 'tool_removal', name: 'x' }] },
      ],
      output_config: { effort: 'high' },
      thinking: { type: 'enabled' },
    }
    const first = await fetch(`${gateway.url}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    assert.equal(first.status, 200)
    const firstText = await first.text()
    assert.match(firstText, /"type":"tool_use"/)
    assert.match(firstText, /look/)

    const second = await fetch(`${gateway.url}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    assert.match(await second.text(), /"type":"tool_use"/)
    const third = await fetch(`${gateway.url}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    const thirdText = await third.text()
    assert.match(thirdText, /"type":"text_delta"/)
    assert.match(thirdText, /done/)

    assert.equal(gateway.requests.length, 3)
    const captured = gateway.requests[0]
    assert.equal(captured?.model, 'deepseek-flash')
    assert.deepEqual(captured?.tools, ['look'])
    assert.deepEqual(captured?.deferred, ['later'])
    assert.equal(captured?.additions, 1)
    assert.equal(captured?.removals, 1)
    assert.equal(captured?.effort, 'high')
    assert.equal(captured?.thinking, 'enabled')
    assert.equal(captured?.system, 'sys')
    assert.equal(captured?.messageCount, 2)
    assert.deepEqual(captured?.topLevelKeys.sort(), ['messages', 'model', 'output_config', 'system', 'thinking', 'tools'])
  })
})

test('POST /files counts uploads', async () => {
  await withGateway(() => ({ text: 'unused' }), async (gateway) => {
    const response = await fetch(`${gateway.url}/files`, { method: 'POST', body: 'x' })
    assert.equal(response.status, 200)
    assert.equal(gateway.uploads, 1)
  })
})
