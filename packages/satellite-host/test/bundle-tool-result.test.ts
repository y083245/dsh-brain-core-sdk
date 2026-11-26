import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { BridgeServer, Satellite, encodeSessionId, removeTree, type BridgeTool, type ModelSelection } from '../src/index.ts'
import { FakeGateway, scriptedTools } from './fake-gateway.ts'

const SELECTION: ModelSelection = { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'low' }
const TOOL: BridgeTool = { name: 'demo__a', description: 'Demo.', parameters: {} }
/** A valid one-pixel PNG. */
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg=='

async function withSatellite(
  script: ReturnType<typeof scriptedTools>,
  handler: ConstructorParameters<typeof BridgeServer>[0]['handler'],
  body: (context: { bridge: BridgeServer; satellite: Satellite; gateway: FakeGateway; sessionId: string }) => Promise<void>,
): Promise<void> {
  const brainHome = await mkdtemp(path.join(os.tmpdir(), 'brain-bundle-'))
  const gateway = new FakeGateway(script)
  await gateway.listen()
  const bridge = new BridgeServer({ catalog: [TOOL], handler })
  await bridge.listen()
  const satellite = new Satellite({
    brainHome,
    agentClass: 'chat',
    selection: SELECTION,
    apiKey: 'fake-key',
    systemPrompt: 'You are a test persona.',
    bridge,
    baseUrl: gateway.url,
  })
  try {
    await satellite.start()
    await body({
      bridge,
      satellite,
      gateway,
      sessionId: encodeSessionId({ agentClass: 'chat', channel: 'test:chat:bundle', generation: 0 }),
    })
  } finally {
    await satellite.close().catch(() => {})
    await bridge.close()
    await gateway.close()
    await removeTree(brainHome)
  }
}

test('an image returned by a tool reaches the model as an image block', async () => {
  await withSatellite(scriptedTools('demo__a'), async () => ({
    text: 'a picture',
    images: [{ mediaType: 'image/png', base64: PIXEL }],
  }), async ({ bridge, satellite, gateway, sessionId }) => {
    bridge.setSurface(sessionId, ['demo__a'])
    const result = await satellite.run(sessionId, 'hello')
    assert.equal(result.finalResponse, 'done')
    assert.match(gateway.requests[1]?.raw ?? '', /"type":"image"/)
    assert.match(gateway.requests[1]?.raw ?? '', /a picture/)
    assert.ok(gateway.uploads >= 1)
  })
})

test('calling a tool outside the surface tells the model to search and load it', async () => {
  await withSatellite(scriptedTools('demo__b'), async () => 'unused', async ({ bridge, satellite, gateway, sessionId }) => {
    bridge.setSurface(sessionId, ['demo__a'])
    const result = await satellite.run(sessionId, 'hello')
    assert.equal(result.finalResponse, 'done')
    const raw = gateway.requests[1]?.raw ?? ''
    assert.match(raw, /unknown tool/)
    assert.match(raw, /tools__search/)
    assert.match(raw, /tools__load/)
  })
})
