import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createConsoleServer, type ConsoleServer } from '../../src/shell/server.ts'

export const TOKEN = 'console-test-token-3f2a'

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export interface TempHome {
  readonly dir: string
  readonly state: string
  close(): Promise<void>
}

export async function makeBrainHome(): Promise<TempHome> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brain-console-'))
  return {
    dir,
    state: path.join(dir, 'state'),
    async close() {
      await rm(dir, { recursive: true, force: true, maxRetries: 5 })
    },
  }
}

export interface TestConsole {
  readonly port: number
  readonly invalidated: readonly string[]
  request(method: string, route: string, options?: { body?: unknown; token?: string | null; headers?: Record<string, string> }): Promise<{
    readonly status: number
    readonly text: string
    readonly body: Record<string, unknown>
  }>
  html(route: string, token?: string | null): Promise<string>
  close(): Promise<void>
}

export async function startConsole(
  home: TempHome,
  overrides: Partial<Parameters<typeof createConsoleServer>[0]> = {},
): Promise<TestConsole> {
  const invalidated: string[] = []
  const server: ConsoleServer = createConsoleServer({
    token: TOKEN,
    brainHome: home.dir,
    onInvalidateRunner: (agentClass) => { invalidated.push(agentClass) },
    ...overrides,
  })
  const { port } = await server.listen()
  return {
    port,
    invalidated,
    async request(method, route, options = {}) {
      const token = options.token === undefined ? TOKEN : options.token
      const hasBody = options.body !== undefined
      const response = await fetch(`http://127.0.0.1:${String(port)}${route}`, {
        method,
        headers: {
          ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
          ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
          ...options.headers,
        },
        ...(hasBody ? { body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body) } : {}),
      })
      const text = await response.text()
      const body = parseJsonObject(text)
      return { status: response.status, text, body }
    },
    async html(route, token = null) {
      const response = await fetch(`http://127.0.0.1:${String(port)}${route}`, {
        headers: token === null ? {} : { Authorization: `Bearer ${token}` },
      })
      return response.text()
    },
    async close() {
      await server.close()
    },
  }
}

export interface Snapshot {
  readonly entries: readonly string[]
  readonly hashes: Readonly<Record<string, string>>
}

/** Every path under `dir` with the SHA-256 of every file, so any write at all shows up as a difference. */
export async function snapshotDir(dir: string): Promise<Snapshot> {
  const entries: string[] = []
  const hashes: Record<string, string> = {}
  async function walk(current: string, prefix: string): Promise<void> {
    let names: string[]
    try {
      names = (await readdir(current)).sort()
    } catch {
      return
    }
    for (const name of names) {
      const full = path.join(current, name)
      const relative = prefix === '' ? name : `${prefix}/${name}`
      const info = await stat(full)
      if (info.isDirectory()) {
        entries.push(`${relative}/`)
        await walk(full, relative)
      } else {
        entries.push(relative)
        hashes[relative] = createHash('sha256').update(await readFile(full)).digest('hex')
      }
    }
  }
  await walk(dir, '')
  return { entries, hashes }
}

/** A fake main DSH home holding credentials, so a test can prove the console never writes into it (D17). */
export async function makeFakeDshHome(): Promise<TempHome> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brain-fake-dsh-'))
  const state = path.join(dir, 'state')
  await mkdir(path.join(dir, 'profiles'), { recursive: true })
  await mkdir(state, { recursive: true })
  await writeFile(path.join(dir, 'profiles', 'cordis.patch.yml'), 'patch: sentinel\n', 'utf8')
  await writeFile(path.join(state, 'secrets.json'), JSON.stringify({ version: 1, secrets: { 'deepseek-api-key': 'dsh-sentinel-value' } }), 'utf8')
  return {
    dir,
    state,
    async close() {
      await rm(dir, { recursive: true, force: true, maxRetries: 5 })
    },
  }
}

export async function modeOf(file: string): Promise<number> {
  return (await stat(file)).mode & 0o777
}
