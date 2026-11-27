import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createConsoleServer, type ConsoleServer } from '@dsh-brain-core/console'
import { createKernel, type Kernel } from '@dsh-brain-core/kernel/assembly'
import type { CrossChannelMode, RuntimeSettings } from '@dsh-brain-core/kernel/contracts'
import { runDoctor } from '@dsh-brain-core/kernel/isolation-doctor'
import { removeTree, type AgentClass } from '@dsh-brain-core/satellite-host'
import { BrainError, type MemoryRecord } from '@dsh-brain-core/sdk'
import { FakeDeepSeek, type CapturedRequest, type FakeScript } from '@dsh-brain-core/testkit'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const CONSOLE_CHAT_DIR = path.join(REPO_ROOT, 'plugins', 'console-chat')
export const WEB_READER_DIR = path.join(REPO_ROOT, 'plugins', 'web-reader')
export const PYTHON_ECHO_DIR = path.join(REPO_ROOT, 'plugins', 'samples', 'python-echo')

export const FLASH_LOW = { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'low' } as const
export const TEST_TOKEN = 'acceptance-test-token-0123456789'

export interface LogEntry {
  readonly level: 'info' | 'warn' | 'error'
  readonly event: string
  readonly fields?: Readonly<Record<string, unknown>>
}

export function capturingLogger(logs: LogEntry[]) {
  const push = (level: LogEntry['level']) => (event: string, fields?: Readonly<Record<string, unknown>>) => {
    logs.push({ level, event, ...(fields === undefined ? {} : { fields }) })
  }
  return { info: push('info'), warn: push('warn'), error: push('error') }
}

/** Polls `look` until it returns a non-undefined value, without any fixed sleep assumptions. */
export async function waitFor<T>(
  look: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 30_000,
  label = 'condition',
  pollMs = 50,
): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = await look()
    if (value !== undefined) return value
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${label} after ${Date.now() - started}ms`)
    }
    await sleep(pollMs)
  }
}

export interface FakeMainDshHome {
  readonly dshHome: string
  readonly sentinelSecret: string
  readonly existingSessionFile: string
}

/** Builds a realistic isolated fake main DSH home (web + desktop profiles, credentials, sessions). */
export async function createFakeMainDshHome(rootDir: string): Promise<FakeMainDshHome> {
  const dshHome = path.join(rootDir, 'fake-main-dsh-home')
  const sentinelSecret = 'sk-sentinel-main-dsh-never-read-or-touch-0123456789'
  const existingSessionFile = path.join(dshHome, 'sessions', 'main-work', 'user-session-01', 'events.jsonl')

  await mkdir(path.join(dshHome, 'profiles', 'web'), { recursive: true })
  await mkdir(path.join(dshHome, 'profiles', 'desktop'), { recursive: true })
  await mkdir(path.dirname(existingSessionFile), { recursive: true })

  await writeFile(path.join(dshHome, 'cordis.patch.yml'), 'plugins:\n  main-helper: {}\n', 'utf8')
  await writeFile(
    path.join(dshHome, 'profiles', 'web', 'package.json'),
    JSON.stringify({ name: 'dsh-web-profile', version: '1.0.0', private: true }, null, 2) + '\n',
    'utf8',
  )
  await writeFile(path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), 'plugins:\n  web-ui: {}\n', 'utf8')
  await writeFile(
    path.join(dshHome, 'profiles', 'desktop', 'package.json'),
    JSON.stringify({ name: 'dsh-desktop-profile', version: '1.0.0', private: true }, null, 2) + '\n',
    'utf8',
  )
  await writeFile(path.join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml'), 'plugins:\n  desktop-ui: {}\n', 'utf8')
  await writeFile(path.join(dshHome, '.credentials.yaml'), `deepseek:\n  apiKey: "${sentinelSecret}"\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await writeFile(path.join(dshHome, '.env'), `DSH_SENTINEL=keep-untouched\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await writeFile(
    existingSessionFile,
    `${JSON.stringify({ type: 'user', text: 'main dsh user work session' })}\n`,
    'utf8',
  )

  return { dshHome, sentinelSecret, existingSessionFile }
}

export interface AcceptanceHarnessOptions {
  readonly script?: FakeScript
  readonly settings?: RuntimeSettings
  readonly apiKey?: string
  readonly roleCard?: string
  readonly crossChannel?: CrossChannelMode
  readonly ownerChannels?: readonly string[]
  readonly dshHome?: string
  readonly clock?: { now(): number }
  readonly token?: string
  readonly withConsole?: boolean
  readonly extraConsoleRoutes?: (kernel: Kernel) => (method: string, pathname: string, body: unknown) => Promise<unknown | undefined>
}

export interface AcceptanceHarness {
  readonly root: string
  readonly brainHome: string
  readonly dshHome: string
  readonly token: string
  readonly kernel: Kernel
  readonly fake: FakeDeepSeek
  readonly logs: LogEntry[]
  readonly consolePort?: number
  readonly consoleServer?: ConsoleServer
}

export async function setupAcceptanceKernel(
  t: { after(fn: () => Promise<void>): void },
  options: AcceptanceHarnessOptions = {},
): Promise<AcceptanceHarness> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brain-acceptance-'))
  const brainHome = path.join(root, 'brain-home')
  const dshHome = options.dshHome ?? path.join(root, 'fake-dsh-home')
  await mkdir(brainHome, { recursive: true })
  await mkdir(dshHome, { recursive: true })

  const fake = new FakeDeepSeek(options.script ?? (() => ({ text: '好。' })))
  await fake.listen()

  const token = options.token ?? TEST_TOKEN
  const logs: LogEntry[] = []
  let consoleServer: ConsoleServer | undefined

  t.after(async () => {
    if (consoleServer !== undefined) await consoleServer.close().catch(() => undefined)
    await kernel.close().catch(() => undefined)
    await fake.close().catch(() => undefined)
    await removeTree(root)
  })

  if (options.settings !== undefined) {
    await mkdir(path.join(brainHome, 'state'), { recursive: true })
    await writeFile(path.join(brainHome, 'state', 'settings.json'), JSON.stringify(options.settings), 'utf8')
  }

  const kernel = await createKernel({
    env: { ...process.env, BRAIN_HOME: brainHome, DSH_HOME: dshHome },
    userHome: brainHome,
    port: 0,
    crossChannel: options.crossChannel ?? 'shadow',
    ...(options.ownerChannels === undefined ? {} : { ownerChannels: options.ownerChannels }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    log: capturingLogger(logs),
    token,
    baseUrl: fake.url,
  })

  if (options.apiKey !== undefined) {
    await kernel.secrets.set('deepseek-api-key', options.apiKey)
  }

  if (options.roleCard !== undefined) {
    await kernel.memory.persona.saveRoleCard({ name: 'acceptance-persona', text: options.roleCard })
  }

  let consolePort: number | undefined
  if (options.withConsole === true) {
    const activeKernel = kernel
    consoleServer = createConsoleServer({
      token,
      port: 0,
      brainHome,
      onInvalidateRunner: (agentClass) => activeKernel.runner.invalidate(agentClass),
      extraRoutes: options.extraConsoleRoutes !== undefined
        ? options.extraConsoleRoutes(activeKernel)
        : createDefaultConsoleRoutes(activeKernel, brainHome, dshHome),
    })
    const listened = await consoleServer.listen()
    consolePort = listened.port
  }

  return {
    root,
    brainHome,
    dshHome,
    token,
    kernel,
    fake,
    logs,
    ...(consolePort === undefined ? {} : { consolePort }),
    ...(consoleServer === undefined ? {} : { consoleServer }),
  }
}

/** Provides console memory & satellite routes backed by the live Kernel for console HTTP integration tests. */
export function createDefaultConsoleRoutes(
  kernel: Kernel,
  brainHome: string,
  dshHome: string,
): (method: string, pathname: string, body: unknown) => Promise<unknown | undefined> {
  return async (method, pathname) => {
    if (method === 'GET' && pathname === '/api/v1/console/satellite') {
      const currentSettings = await kernel.settings.read()
      const secretNames = await kernel.secrets.names()
      const doctor = await runDoctor({ mode: 'check', dshHome })
      return {
        processes: {
          chat: {
            agentClass: 'chat',
            status: kernel.runner.status('chat'),
            activeSessions: 0,
            selection: currentSettings.agents.chat ?? null,
            deniedApprovals: 0,
          },
          activity: {
            agentClass: 'activity',
            status: kernel.runner.status('activity'),
            activeSessions: 0,
            selection: currentSettings.agents.activity ?? null,
            deniedApprovals: 0,
          },
        },
        sessions: [],
        isolation: {
          ok: doctor.kind === 'check' ? doctor.ok : false,
          checkedAt: Date.now(),
          problems: doctor.kind === 'check' ? doctor.problems : [],
        },
        metrics: [],
        sharedQuotaWarning: !secretNames.includes('deepseek-api-key'),
      }
    }

    if (method === 'GET' && pathname === '/api/v1/console/memory/audit') {
      const db = new DatabaseSync(path.join(brainHome, 'state', 'memory', 'audit.db'), { readOnly: true })
      try {
        const rows = db.prepare(
          'SELECT record_id, viewer_channel, mode, t_at FROM cross_channel_use ORDER BY t_at ASC',
        ).all() as unknown as readonly { readonly record_id: string; readonly viewer_channel: string; readonly mode: string; readonly t_at: number }[]
        return rows.map((row) => ({
          recordId: row.record_id,
          viewerChannel: row.viewer_channel,
          mode: row.mode,
          tAt: row.t_at,
        }))
      } finally {
        db.close()
      }
    }

    const depMatch = /^\/api\/v1\/console\/memory\/records\/([^/]+)\/dependents$/.exec(pathname)
    if (method === 'GET' && depMatch !== null) {
      const id = decodeURIComponent(depMatch[1]!)
      return await kernel.memory.store.dependentsOf(id)
    }

    const recordMatch = /^\/api\/v1\/console\/memory\/records\/([^/]+)$/.exec(pathname)
    if (method === 'GET' && recordMatch !== null) {
      const id = decodeURIComponent(recordMatch[1]!)
      const record: MemoryRecord | null = await kernel.memory.store.get(id)
      if (record === null) throw new BrainError('NOT_FOUND', 'record not found')
      return record
    }

    return undefined
  }
}

export async function installAndEnablePlugin(
  kernel: Kernel,
  dir: string,
  id: string,
  config?: unknown,
): Promise<void> {
  await kernel.plugins.install(dir)
  await kernel.plugins.confirm(id)
  if (config !== undefined) {
    await kernel.plugins.setConfig(id, config)
  }
  await kernel.plugins.enable(id)
}

export async function httpJson<T = unknown>(
  port: number,
  method: string,
  route: string,
  options: {
    readonly body?: unknown
    readonly token?: string
    readonly headers?: Record<string, string>
  } = {},
): Promise<{ readonly status: number; readonly body: T }> {
  const token = options.token ?? TEST_TOKEN
  const hasBody = options.body !== undefined
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
    ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
  })
  const text = await response.text()
  return {
    status: response.status,
    body: JSON.parse(text) as T,
  }
}

export async function readSatellitePid(brainHome: string, agentClass: AgentClass = 'chat'): Promise<number | undefined> {
  try {
    const raw = await readFile(path.join(brainHome, 'state', 'agent', 'satellites.json'), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const pid = parsed[agentClass]
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

export async function waitForSatellitePid(
  brainHome: string,
  agentClass: AgentClass = 'chat',
  excludePid?: number,
  timeoutMs = 30_000,
): Promise<number> {
  return await waitFor(async () => {
    const pid = await readSatellitePid(brainHome, agentClass)
    return pid !== undefined && pid !== excludePid ? pid : undefined
  }, timeoutMs, `${agentClass} satellite pid`)
}

/** Returns true if the last message in a captured FakeDeepSeek request carries a tool_result block. */
export function hasToolResultInLastMessage(request: CapturedRequest): boolean {
  const messages = JSON.parse(request.raw) as readonly { readonly role?: unknown; readonly content?: unknown }[]
  const last = messages.at(-1)
  if (last === undefined || !Array.isArray(last.content)) return false
  return last.content.some(
    (block) => typeof block === 'object' && block !== null && (block as { readonly type?: unknown }).type === 'tool_result',
  )
}

export function extractLatestWakeText(request: CapturedRequest): string {
  const messages = JSON.parse(request.raw) as readonly { readonly role?: unknown; readonly content?: unknown }[]
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (msg?.role !== 'user') continue
    if (typeof msg.content === 'string') return msg.content
    if (Array.isArray(msg.content)) {
      const texts = msg.content
        .filter((b): b is { readonly type: string; readonly text: string } =>
          typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string',
        )
        .map((b) => b.text)
      if (texts.length > 0) return texts.join('\n')
    }
  }
  return ''
}

export function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
}

export function assertUnwrappedOk<T>(envelope: { readonly ok: boolean; readonly data?: T; readonly error?: unknown }): T {
  assert.equal(envelope.ok, true, `expected ok envelope, got ${JSON.stringify(envelope)}`)
  return envelope.data as T
}
