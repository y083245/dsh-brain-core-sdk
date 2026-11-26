import assert from 'node:assert/strict'
import test from 'node:test'
import { BridgeServer, type BridgeTool } from '../src/index.ts'

const tools: readonly BridgeTool[] = [
  { name: 'a__tool', description: 'A', parameters: {} },
  { name: 'b__tool', description: 'B', parameters: {} },
]

function call(server: BridgeServer, path: string, body?: unknown, token: string | null = server.token): Promise<Response> {
  const headers: Record<string, string> = token === null ? {} : { authorization: `Bearer ${token}` }
  return fetch(server.url + path, body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) })
}

test('a supplied surfaceOf decides both the surface pull and the call filter', async t => {
  let surface: ReadonlySet<string> = new Set(['a__tool'])
  const server = new BridgeServer({
    catalog: tools,
    handler: async ({ toolName }) => `ran ${toolName}`,
    surfaceOf: sessionId => sessionId === 's1' ? surface : new Set<string>(),
  })
  await server.listen()
  t.after(() => server.close())
  // The internal map is ignored once surfaceOf is supplied.
  server.setSurface('s1', ['b__tool'])
  server.addToSurface('s1', ['b__tool'])

  const pull = async (id: string) => (await (await call(server, `/bridge/v1/sessions/${id}/surface`)).json() as { tools: string[] }).tools
  assert.deepEqual(await pull('s1'), ['a__tool'])
  assert.deepEqual(await pull('other'), [])

  const send = async (sessionId: string, toolName: string) => (await call(server, '/bridge/v1/calls', { sessionId, toolName, args: {} })).json()
  assert.deepEqual(await send('s1', 'a__tool'), { ok: true, content: 'ran a__tool' })
  assert.deepEqual(await send('s1', 'b__tool'), { ok: false, error: 'session unavailable' })

  surface = new Set(['b__tool'])
  assert.deepEqual(await send('s1', 'b__tool'), { ok: true, content: 'ran b__tool' })
  assert.deepEqual(await send('s1', 'a__tool'), { ok: false, error: 'session unavailable' })
})

test('without surfaceOf the S1 surface map still decides', async t => {
  const server = new BridgeServer({ catalog: tools, handler: async ({ toolName }) => `ran ${toolName}` })
  await server.listen()
  t.after(() => server.close())
  server.setSurface('s1', ['a__tool'])
  server.addToSurface('s1', ['b__tool'])
  const pull = await (await call(server, '/bridge/v1/sessions/s1/surface')).json() as { tools: string[] }
  assert.deepEqual(pull.tools.sort(), ['a__tool', 'b__tool'])
})

test('a tool result with images reports them beside the text', async t => {
  const images = [{ mediaType: 'image/png', base64: 'iVBORw0KGgo=' }]
  const server = new BridgeServer({
    catalog: tools,
    handler: async () => ({ text: 'look at this', images }),
  })
  await server.listen()
  t.after(() => server.close())
  server.setSurface('s1', ['a__tool'])
  const reply = await (await call(server, '/bridge/v1/calls', { sessionId: 's1', toolName: 'a__tool', args: {} })).json()
  assert.deepEqual(reply, { ok: true, content: 'look at this', images })
})

test('a plain string result keeps the old reply shape exactly', async t => {
  const server = new BridgeServer({ catalog: tools, handler: async () => 'plain' })
  await server.listen()
  t.after(() => server.close())
  server.setSurface('s1', ['a__tool'])
  const reply = await (await call(server, '/bridge/v1/calls', { sessionId: 's1', toolName: 'a__tool', args: {} })).json()
  assert.deepEqual(reply, { ok: true, content: 'plain' })
})
