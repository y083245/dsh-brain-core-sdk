import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test, { afterEach } from 'node:test'
import { BrainError, type BrainContext, type BrainManifest, type ManifestMcp, type ManifestTool } from '@dsh-brain-core/sdk'
import type { InstalledPlugin } from '../../src/contracts/index.ts'
import type { ExternalDeps } from '../../src/plugin-external/index.ts'
import {
  MCP_CHILD, FIXTURE_DIR, fakeContext, isAlive, readEntries, waitUntil, type FakeContext, type LogEntry,
} from './helpers.ts'

async function waitUntilAsync(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - started > timeoutMs) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

interface McpHarness {
  readonly plugin: InstalledPlugin
  readonly deps: ExternalDeps
  readonly ctx: FakeContext
  readonly dir: string
  readonly logPath: string
  readonly scriptPath: string
  readonly envPath: string
  readonly logs: LogEntry[]
  attach: () => Promise<void>
  stop: () => Promise<void>
}

async function mcpHarness(options: {
  script?: Record<string, unknown>
  mcp: ManifestMcp | 'stdio'
  mcpEnv?: Record<string, string>
  tools?: ManifestTool[]
  granted?: readonly string[]
  config?: Record<string, unknown>
  fake?: Parameters<typeof fakeContext>[0]
  deps?: Partial<ExternalDeps>
}): Promise<McpHarness> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'plugin-mcp-'))
  const logPath = path.join(dir, 'mcp.log')
  const scriptPath = path.join(dir, 'script.json')
  const envPath = path.join(dir, 'env.json')
  const script = { envFile: envPath, tools: [], ...(options.script ?? {}) }
  await writeFile(scriptPath, JSON.stringify(script))
  const tools = options.tools ?? [{ name: 'hass_on', effect: 'read', load: 'core', summary: 'turn on' }]
  const manifest: BrainManifest = {
    id: 'hass', kinds: ['capability'], api: '^1', runtime: 'node',
    permissions: [...(options.granted ?? ['tools.register'])],
    tools,
    mcp: options.mcp === 'stdio' ? stdio(scriptPath, logPath, options.mcpEnv ?? {}) : options.mcp,
  }
  const plugin: InstalledPlugin = {
    manifest, version: '1.0.0', dir: FIXTURE_DIR, granted: manifest.permissions, config: options.config ?? {},
  }
  const fake = fakeContext({ id: 'hass', config: options.config ?? {}, ...options.fake })
  const logs: LogEntry[] = []
  const deps: ExternalDeps = {
    pluginsDir: dir,
    log: {
      info: (event, fields) => logs.push({ level: 'info', event, fields }),
      warn: (event, fields) => logs.push({ level: 'warn', event, fields }),
      error: (event, fields) => logs.push({ level: 'error', event, fields }),
    },
    now: () => Date.now(),
    onFailed: () => undefined,
    parentEnv: { PATH: process.env.PATH, SENTINEL: 'must-not-leak', HOME: '/parent-home' },
    ...options.deps,
  }
  return {
    plugin, deps, ctx: fake, dir, logPath, scriptPath, envPath, logs,
    async attach() {
      const { attachMcp } = await import('../../src/plugin-external/index.ts')
      await attachMcp(fake.ctx as BrainContext, plugin, deps)
    },
    async stop() {
      fake.revoke()
      const pid = readEntries(logPath).find((entry) => entry.event === 'start')?.pid
      if (typeof pid === 'number') await waitUntil(() => !isAlive(pid), 7000)
    },
  }
}

function stdio(scriptPath: string, logPath: string, extra: Record<string, string> = {}): ManifestMcp {
  return { command: process.execPath, args: [MCP_CHILD, scriptPath, logPath], env: extra }
}

const live = new Set<McpHarness>()
async function setup(options: Parameters<typeof mcpHarness>[0]): Promise<McpHarness> {
  const h = await mcpHarness(options)
  live.add(h)
  return h
}
afterEach(async () => {
  await Promise.all([...live].map(async (h) => { await h.stop() }))
  live.clear()
})

const schema = { type: 'object' as const, properties: { on: { type: 'boolean' } } }

test('MCP tools are mapped by manifest name and mcpName; extras are ignored; text, images and isError map through', async () => {
  const h = await setup({
    script: {
      tools: [
        { name: 'HassTurnOn', description: 'Turn it on', inputSchema: schema },
        { name: 'off', inputSchema: { type: 'object' } },
        { name: 'boom', inputSchema: { type: 'object' } },
        { name: 'blank', description: '', inputSchema: { type: 'object' } },
        { name: 'extra', description: 'not registered', inputSchema: { type: 'object' } },
      ],
      calls: {
        HassTurnOn: { content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] },
        off: { content: [{ type: 'text', text: 'hi' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] },
        boom: { isError: true, content: [{ type: 'text', text: 'bad thing' }] },
      },
    },
    mcp: 'stdio',
    tools: [
      { name: 'hass_on', effect: 'read', load: 'core', summary: 'summary on', mcpName: 'HassTurnOn' },
      { name: 'hass_off', effect: 'read', load: 'core', summary: 'summary off', mcpName: 'off' },
      { name: 'hass_boom', effect: 'read', load: 'core', summary: 'summary boom', mcpName: 'boom' },
      { name: 'hass_blank', effect: 'read', load: 'core', summary: 'blank summary', mcpName: 'blank' },
    ],
  })
  await h.attach()
  const state = h.ctx.state
  assert.deepEqual([...state.tools.keys()].sort(), ['hass_blank', 'hass_boom', 'hass_off', 'hass_on'])
  assert.equal(state.tools.get('hass_on')?.description, 'Turn it on')
  assert.equal(state.tools.get('hass_off')?.description, 'summary off')
  assert.equal(state.tools.get('hass_blank')?.description, 'blank summary')
  assert.deepEqual(state.tools.get('hass_on')?.parameters, schema)

  assert.equal(await state.tools.get('hass_on')?.handler({ on: true }, { channel: 'c', wakeId: 'w' }), 'hello\nworld')
  assert.deepEqual(await state.tools.get('hass_off')?.handler({}, { channel: 'c', wakeId: 'w' }),
    { text: 'hi', images: [{ mediaType: 'image/png', base64: 'AAAA' }] })
  await assert.rejects(async () => state.tools.get('hass_boom')?.handler({}, { channel: 'c', wakeId: 'w' }), /bad thing/)

  const calls = readEntries(h.logPath).filter((entry) => entry.event === 'request' && entry.method === 'tools/call')
  assert.deepEqual(calls.map((entry) => (entry.params as { name: string }).name), ['HassTurnOn', 'off', 'boom'])
  assert.deepEqual((calls[0]?.params as { arguments: unknown }).arguments, { on: true })
})

test('a manifest tool the MCP server does not provide fails the enable', async () => {
  const h = await setup({
    script: { tools: [{ name: 'other', inputSchema: { type: 'object' } }] },
    mcp: 'stdio',
    tools: [{ name: 'hass_on', effect: 'read', load: 'core', summary: 's' }],
  })
  let caught: unknown
  try { await h.attach() } catch (error) { caught = error }
  assert.ok(caught instanceof BrainError && caught.code === 'INVALID_ARGUMENT', String(caught))
})

test('env values resolve config: and secret:; the MCP child inherits nothing else; stderr goes to its own file', async () => {
  const h = await setup({
    script: { tools: [{ name: 'hass_on', inputSchema: { type: 'object' } }], stderr: 'mcp stderr\n' },
    mcp: 'stdio',
    mcpEnv: { TOKEN: 'secret:token', GREETING: 'config:greeting', LITERAL: 'yes' },
    config: { greeting: 'hello' },
    fake: { secrets: { token: 's3cret' } },
  })
  await h.attach()
  const env = JSON.parse(await readFile(h.envPath, 'utf8')) as Record<string, string>
  assert.equal(env.TOKEN, 's3cret')
  assert.equal(env.GREETING, 'hello')
  assert.equal(env.LITERAL, 'yes')
  assert.equal(env.SENTINEL, undefined)
  assert.equal(env.HOME, path.join(h.dir, 'hass', 'home'))

  const stderr = path.join(h.dir, 'hass', 'stderr.log')
  await waitUntilAsync(async () => {
    try { return (await readFile(stderr, 'utf8')).includes('mcp stderr') } catch { return false }
  }, 2000)
  if (process.platform !== 'win32') assert.equal((await stat(stderr)).mode & 0o777, 0o600)
})

test('an unset secret fails with UNAVAILABLE and leaves no MCP process', async () => {
  const h = await setup({
    script: { tools: [{ name: 'hass_on', inputSchema: { type: 'object' } }] },
    mcp: 'stdio',
    mcpEnv: { TOKEN: 'secret:token' },
  })
  let caught: unknown
  try { await h.attach() } catch (error) { caught = error }
  assert.ok(caught instanceof BrainError && caught.code === 'UNAVAILABLE', String(caught))
})

test('a url MCP server is refused by guardUrl without a lan permission and receives nothing', async () => {
  const seen: string[] = []
  const server = http.createServer((request, response) => { seen.push(String(request.url)); response.writeHead(500); response.end() })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    const h = await setup({ mcp: { url: `http://127.0.0.1:${port}/mcp` } })
    let caught: unknown
    try { await h.attach() } catch (error) { caught = error }
    assert.ok(caught instanceof BrainError && caught.code === 'PERMISSION_DENIED', String(caught))
    assert.deepEqual(seen, [])
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('a url MCP server gets the resolved headers and its tools are registered', async () => {
  const seen: { headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[] = []
  const tools = [{ name: 'HassTurnOn', description: 'on', inputSchema: schema }]
  const server = http.createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      if (request.method === 'GET') { response.writeHead(405); response.end(); return }
      const message = body === '' ? {} : JSON.parse(body) as Record<string, unknown>
      seen.push({ headers: request.headers, body: message })
      if (message.method === 'initialize') {
        response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
          protocolVersion: (message.params as { protocolVersion?: string }).protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' },
        } }))
        return
      }
      if (message.method === 'tools/list') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools } }))
        return
      }
      if (message.method === 'tools/call') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'from http' }] } }))
        return
      }
      response.writeHead(202)
      response.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    const h = await setup({
      mcp: { url: 'config:hassUrl', headers: { Authorization: 'secret:token', 'X-Greeting': 'config:greeting' } },
      granted: ['tools.register', 'lan:127.0.0.1'],
      config: { greeting: 'hello', hassUrl: `http://127.0.0.1:${port}/mcp` },
      fake: { secrets: { token: 's3cret' } },
      tools: [{ name: 'hass_on', effect: 'read', load: 'core', summary: 's', mcpName: 'HassTurnOn' }],
    })
    await h.attach()
    const initialize = seen.find((entry) => entry.body.method === 'initialize')
    assert.equal(initialize?.headers.authorization, 's3cret')
    assert.equal(initialize?.headers['x-greeting'], 'hello')
    assert.equal(await h.ctx.state.tools.get('hass_on')?.handler({}, { channel: 'c', wakeId: 'w' }), 'from http')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('nothing writes any DSH or BRAIN_HOME configuration file', async () => {
  const brainHome = await mkdtemp(path.join(os.tmpdir(), 'brain-home-'))
  const saved = process.env.BRAIN_HOME
  process.env.BRAIN_HOME = brainHome
  try {
    const h = await setup({
      script: { tools: [{ name: 'hass_on', inputSchema: { type: 'object' } }] },
      mcp: 'stdio',
    })
      await h.attach()
    assert.deepEqual(await readdir(brainHome), [])
  } finally {
    if (saved === undefined) delete process.env.BRAIN_HOME
    else process.env.BRAIN_HOME = saved
  }
})


test('a config: URL with no configured value fails with INVALID_ARGUMENT', async () => {
  const h = await setup({ mcp: { url: 'config:missing' } })
  let caught: unknown
  try { await h.attach() } catch (error) { caught = error }
  assert.ok(caught instanceof BrainError && caught.code === 'INVALID_ARGUMENT', String(caught))
})

test('ctx revocation closes the MCP client and its process', async () => {
  const h = await setup({ script: { tools: [{ name: 'hass_on', inputSchema: { type: 'object' } }] }, mcp: 'stdio' })
  await h.attach()
  const pid = readEntries(h.logPath).find((entry) => entry.event === 'start')?.pid
  assert.equal(typeof pid, 'number')
  h.ctx.revoke()
  await waitUntil(() => !isAlive(pid as number), 6000)
})

test('a config: reference whose value is not a string fails with INVALID_ARGUMENT', async () => {
  const h = await setup({
    script: { tools: [{ name: 'hass_on', inputSchema: { type: 'object' } }] },
    mcp: 'stdio',
    mcpEnv: { PORT: 'config:port' },
    config: { port: 8080 },
  })
  let caught: unknown
  try { await h.attach() } catch (error) { caught = error }
  assert.ok(caught instanceof BrainError && caught.code === 'INVALID_ARGUMENT', String(caught))
})
