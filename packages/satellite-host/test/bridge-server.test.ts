import assert from 'node:assert/strict'
import test from 'node:test'
import { BridgeServer } from '../src/bridge-server.ts'

const tools = [
  { name: 'b__tool', description: 'B', parameters: { z: { type: 'string' }, a: { type: 'number' } } },
  { name: 'a__tool', description: 'A', parameters: {} },
]

async function start(t: test.TestContext): Promise<BridgeServer> {
  const server = new BridgeServer({ catalog: tools, handler: async ({ toolName }) => `ran ${toolName}` })
  await server.listen()
  t.after(() => server.close())
  return server
}

function call(server: BridgeServer, path: string, body?: unknown, token: string | null = server.token): Promise<Response> {
  const headers: Record<string, string> = token === null ? {} : { authorization: `Bearer ${token}` }
  return fetch(server.url + path, body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) })
}

test('it only listens on loopback', async t => {
  const server = await start(t)
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/)
})

test('a missing or wrong token gets 401 on every route', async t => {
  const server = await start(t)
  assert.equal((await call(server, '/bridge/v1/catalog', undefined, null)).status, 401)
  assert.equal((await call(server, '/bridge/v1/catalog', undefined, 'wrong')).status, 401)
  assert.equal((await call(server, '/bridge/v1/calls', { sessionId: 's', toolName: 'a__tool', args: {} }, null)).status, 401)
})

test('each server gets its own token', async t => {
  const [a, b] = [await start(t), await start(t)]
  assert.notEqual(a.token, b.token)
  assert.equal(a.token.length, 64)
})

test('the catalog is sorted with sorted keys, so its bytes are stable', async t => {
  const server = await start(t)
  const { tools: listed } = await (await call(server, '/bridge/v1/catalog')).json() as { tools: { name: string; parameters: object }[] }
  assert.deepEqual(listed.map(tool => tool.name), ['a__tool', 'b__tool'])
  assert.deepEqual(Object.keys(listed[1]?.parameters ?? {}), ['a', 'z'])
})

test('surface is per session and additions show up on the next pull', async t => {
  const server = await start(t)
  server.setSurface('s1', ['a__tool'])
  const pull = async (id: string) => (await (await call(server, `/bridge/v1/sessions/${id}/surface`)).json() as { tools: string[] }).tools
  assert.deepEqual(await pull('s1'), ['a__tool'])
  assert.deepEqual(await pull('unknown'), [])
  server.addToSurface('s1', ['b__tool'])
  assert.deepEqual((await pull('s1')).sort(), ['a__tool', 'b__tool'])
  assert.equal(server.surfacePulls.get('s1'), 2)
})

test('calls outside the surface are refused with one indistinguishable message', async t => {
  const server = await start(t)
  server.setSurface('s1', ['a__tool'])
  const send = async (sessionId: string, toolName: string) => (await call(server, '/bridge/v1/calls', { sessionId, toolName, args: {} })).json()
  assert.deepEqual(await send('s1', 'a__tool'), { ok: true, content: 'ran a__tool' })
  const refusals = [await send('s1', 'b__tool'), await send('nobody', 'a__tool'), await send('s1', 'no__such')]
  for (const refusal of refusals) assert.deepEqual(refusal, { ok: false, error: 'session unavailable' })
})

test('handler failures come back as tool errors', async t => {
  const server = new BridgeServer({ catalog: tools, handler: async () => { throw new Error('boom') } })
  await server.listen()
  t.after(() => server.close())
  server.setSurface('s1', ['a__tool'])
  const reply = await (await call(server, '/bridge/v1/calls', { sessionId: 's1', toolName: 'a__tool', args: {} })).json()
  assert.deepEqual(reply, { ok: false, error: 'boom' })
})

test('ready passes only when the real tools equal the catalog', async t => {
  const server = await start(t)
  const report = async (list: string[]) => call(server, '/bridge/v1/ready', { tools: list })
  assert.equal((await report(['a__tool', 'b__tool'])).status, 200)
  assert.equal(server.surfaceCheck?.ok, true)
  const reply = await report(['a__tool', 'b__tool', 'bash'])
  assert.equal(reply.status, 409)
  assert.deepEqual(await reply.json(), { ok: false, unexpected: ['bash'], missing: [] })
  assert.equal((await report(['a__tool'])).status, 409)
  assert.deepEqual(server.surfaceCheck?.missing, ['b__tool'])
})

test('the bundle can report its pid', async t => {
  const server = await start(t)
  await call(server, '/bridge/v1/hello', { pid: 4242 })
  assert.equal(server.childPid, 4242)
})

test('oversized bodies are rejected without running the handler', async t => {
  let ran = false
  const server = new BridgeServer({ catalog: tools, handler: async () => { ran = true; return '' } })
  await server.listen()
  t.after(() => server.close())
  server.setSurface('s1', ['a__tool'])
  const reply = await call(server, '/bridge/v1/calls', { sessionId: 's1', toolName: 'a__tool', args: 'x'.repeat(2 * 1024 * 1024) })
  assert.equal(reply.status, 500)
  assert.equal(ran, false)
})
