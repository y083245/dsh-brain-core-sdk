import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import type { Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { removeTree } from '@brain-core/satellite-host'
import { FakeDeepSeek, type FakeScript } from '@brain-core/testkit'
import { createKernel, type Kernel } from '../../src/assembly.ts'
import type { Clock, CrossChannelMode, RuntimeSettings } from '../../src/contracts/index.ts'
import type { LogFields, Logger } from '../../src/log/index.ts'
import { createSecretStore } from '../../src/secrets/index.ts'
import { createSettingsStore } from '../../src/runtime-stores/settings.ts'

export const TOKEN = 'test-token-0123456789'
export const CHANNEL = 'sample:private:u1'
export const SAMPLE_PLUGIN = fileURLToPath(new URL('./fixtures/sample-plugin', import.meta.url))
export const EXTERNAL_PLUGIN = fileURLToPath(new URL('./fixtures/external-plugin', import.meta.url))
export const BROKEN_PLUGIN = fileURLToPath(new URL('./fixtures/broken-plugin', import.meta.url))
export const OTHER_PLUGIN = fileURLToPath(new URL('./fixtures/other', import.meta.url))
export const EVENTS_PLUGIN = fileURLToPath(new URL('./fixtures/evt', import.meta.url))
export const OWNER_PLUGIN = fileURLToPath(new URL('./fixtures/ownerish', import.meta.url))
export const BIG_CORE_PLUGIN = fileURLToPath(new URL('./fixtures/bigcore', import.meta.url))
export const TICKER_PLUGIN = fileURLToPath(new URL('./fixtures/ticker', import.meta.url))
export const FLAKY_MEMBERS_PLUGIN = fileURLToPath(new URL('./fixtures/flaky', import.meta.url))
export const CRASHING_PLUGIN = fileURLToPath(new URL('./fixtures/crashy', import.meta.url))
export const MCP_PLUGIN = fileURLToPath(new URL('./fixtures/mcpdemo', import.meta.url))

export const FLASH = { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'low' } as const

export interface LogEntry { readonly level: 'info' | 'warn' | 'error'; readonly event: string; readonly fields?: LogFields }

export interface SetupOptions {
  readonly script?: FakeScript
  readonly settings?: RuntimeSettings
  readonly roleCard?: string
  readonly apiKey?: string
  readonly plugin?: boolean
  readonly clock?: Clock
  readonly crossChannel?: CrossChannelMode
  /** The `--owner-channel` startup argument; undefined leaves it to the settings file. */
  readonly ownerChannels?: readonly string[]
  /** Route the fake gateway through a proxy that counts GET /models requests. */
  readonly countModels?: boolean
  /** Runs before createKernel, so startup sees these files. */
  readonly beforeCreate?: (home: string) => Promise<void>
}

export interface Harness {
  readonly kernel: Kernel
  readonly fake: FakeDeepSeek
  readonly home: string
  readonly logs: LogEntry[]
  /** GET /models requests the kernel itself made; only meaningful with `countModels: true`. */
  models(): number
  wake(channel?: string, text?: string): Promise<{ readonly wakeId: string; readonly acked: boolean; readonly steps: number; readonly sent: number }>
  ingest(channel?: string, text?: string, actor?: string): Promise<string>
}

interface CountingGateway {
  readonly server: Server
  /** Only the kernel's own probe: the DSH adapter also asks /models and marks it with accept: application/json. */
  models(): number
}

function countingGateway(target: string): Promise<CountingGateway> {
  let models = 0
  const server = createServer((req, res) => {
    const accept = req.headers.accept
    if (req.method === 'GET' && req.url?.split('?')[0]?.endsWith('/models') === true && accept !== 'application/json') models += 1
    const upstream = httpRequest(`${target}${req.url ?? '/'}`, { method: req.method, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 500, answer.headers)
      answer.pipe(res)
    })
    upstream.on('error', () => { res.destroy() })
    req.pipe(upstream)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, models: () => models }))
  })
}

export function capturingLogger(logs: LogEntry[]): Logger {
  const push = (level: LogEntry['level']) => (event: string, fields?: LogFields) => { logs.push({ level, event, fields }) }
  return { info: push('info'), warn: push('warn'), error: push('error') }
}

export async function setup(t: { after(fn: () => Promise<void>): void }, options: SetupOptions = {}): Promise<Harness> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'brain-assembly-'))
  const fake = new FakeDeepSeek(options.script ?? (() => ({ text: '好。' })))
  await fake.listen()
  const proxy = options.countModels === true ? await countingGateway(fake.url) : undefined
  const baseUrl = proxy === undefined
    ? fake.url
    : `http://127.0.0.1:${(proxy.server.address() as { port: number }).port}`
  const holder: { kernel?: Kernel } = {}
  t.after(async () => {
    if (holder.kernel !== undefined) await holder.kernel.close()
    if (proxy !== undefined) {
      proxy.server.closeAllConnections()
      await new Promise<void>((resolve) => { proxy.server.close(() => resolve()) })
    }
    await fake.close()
    // Windows may still hold SQLite or session files for a moment; removeTree retries EBUSY.
    await removeTree(home)
  })

  if (options.settings !== undefined || options.apiKey !== undefined) await mkdir(path.join(home, 'state'), { recursive: true })
  if (options.settings !== undefined) {
    await createSettingsStore(path.join(home, 'state', 'settings.json')).write(options.settings)
  }
  if (options.apiKey !== undefined) {
    await createSecretStore({ file: path.join(home, 'state', 'secrets.json') }).set('deepseek-api-key', options.apiKey)
  }
  if (options.beforeCreate !== undefined) await options.beforeCreate(home)

  const logs: LogEntry[] = []
  const kernel = await createKernel({
    env: { ...process.env, BRAIN_HOME: home },
    userHome: home,
    port: 0,
    crossChannel: options.crossChannel ?? 'shadow',
    log: capturingLogger(logs),
    token: TOKEN,
    baseUrl,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.ownerChannels === undefined ? {} : { ownerChannels: options.ownerChannels }),
  })
  holder.kernel = kernel
  if (options.roleCard !== undefined) {
    await kernel.memory.persona.saveRoleCard({ name: 'assembly-persona', text: options.roleCard })
  }
  if (options.plugin === true) await installPlugin(kernel, SAMPLE_PLUGIN, 'sample')

  const harness: Harness = {
    kernel,
    fake,
    home,
    logs,
    models: () => proxy?.models() ?? 0,
    async wake(channel = CHANNEL, text = '在吗') {
      const id = await harness.ingest(channel, text)
      return await kernel.agent.wake(channel, {
        reason: 'message',
        messages: [{ id, actor: 'p1', name: '小明', text, tEvent: Date.now() }],
      })
    },
    async ingest(channel = CHANNEL, text = '在吗', actor = 'p1') {
      const { id } = await kernel.memory.service.ingest(
        { kind: 'sample.message', channel, subjects: [], actor, content: { text }, tEvent: Date.now(), idempotencyKey: `m-${Math.random()}` },
        { kind: 'kernel', source: 'test', trust: 'owner', defaultVisibility: 'owner' },
      )
      return id
    },
  }
  return harness
}

export async function installPlugin(kernel: Kernel, dir: string, id: string): Promise<void> {
  await kernel.plugins.install(dir)
  await kernel.plugins.confirm(id)
  await kernel.plugins.enable(id)
}

export async function canUseModel(kernel: Kernel): Promise<void> {
  await kernel.settings.write({ agents: { chat: { ...FLASH }, activity: { ...FLASH } } })
  await kernel.secrets.set('deepseek-api-key', 'fake-key')
  await kernel.memory.persona.saveRoleCard({ name: 'assembly-persona', text: '你是小满，说话简短，不寒暄。' })
}

export async function waitFor<T>(look: () => Promise<T | undefined> | T | undefined, timeoutMs = 30_000, label = 'condition', pollMs = 100): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = await look()
    if (value !== undefined) return value
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await sleep(pollMs)
  }
}

/** The kernel records every DSH pid it starts; reading it beats a process scan, especially on Windows. */
export async function readSatellitePid(home: string, agentClass = 'chat'): Promise<number | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path.join(home, 'state', 'agent', 'satellites.json'), 'utf8')) as Record<string, unknown>
    const pid = parsed[agentClass]
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

export async function waitForSatellitePid(home: string, agentClass = 'chat', exclude?: number, timeoutMs = 60_000): Promise<number> {
  return await waitFor(async () => {
    const pid = await readSatellitePid(home, agentClass)
    return pid !== undefined && pid !== exclude ? pid : undefined
  }, timeoutMs, `a ${agentClass} DSH satellite`, 100)
}

/** The external fixture writes its pid here; unlike a process scan this works the same on every platform. */
export function externalPidFile(home: string): string {
  return path.join(home, 'state', 'plugins', 'external', 'home', 'pid')
}

export async function readExternalPid(home: string): Promise<number | undefined> {
  try {
    const pid = Number((await readFile(externalPidFile(home), 'utf8')).trim())
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

export async function waitForExternalPid(home: string, timeoutMs = 30_000): Promise<number> {
  return await waitFor(() => readExternalPid(home), timeoutMs, 'the external plugin process', 200)
}

/** Session directories on disk for one id; DSH nests them under a working-directory directory. */
export async function sessionDirs(home: string, sessionId: string): Promise<readonly string[]> {
  const root = path.join(home, 'state', 'satellite', 'dsh-home', 'sessions')
  let cwds: string[]
  try {
    cwds = await readdir(root)
  } catch {
    return []
  }
  const found: string[] = []
  for (const cwd of cwds) {
    let children: string[]
    try {
      children = await readdir(path.join(root, cwd))
    } catch {
      continue
    }
    for (const child of children) if (child === sessionId) found.push(path.join(root, cwd, child))
  }
  return found
}

export function httpGet(kernel: Kernel, route: string, token = TOKEN): Promise<Response> {
  return fetch(`http://127.0.0.1:${kernel.port}${route}`, { headers: { authorization: `Bearer ${token}` } })
}
