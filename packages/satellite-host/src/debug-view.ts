/** Isolated DSH Web debug view controller (FR-S11). */
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { killProcessTree } from './platform.ts'
import { assertOutsideDshHome } from './satellite.ts'

export interface DebugViewStatus {
  readonly running: boolean
  readonly pid?: number
  readonly url?: string
  readonly port?: number
}

export interface DebugViewControllerOptions {
  readonly brainHome: string
  readonly parentEnv?: NodeJS.ProcessEnv
  readonly apiKey?: string
  readonly baseUrl?: string
  readonly spawnImpl?: typeof spawn
  readonly killImpl?: (pid: number, platform?: NodeJS.Platform) => Promise<void>
  readonly startTimeoutMs?: number
  readonly platform?: NodeJS.Platform
}

export interface DebugViewController {
  start(): Promise<DebugViewStatus>
  stop(): Promise<void>
  status(): DebugViewStatus
}

const require = createRequire(import.meta.url)

const INHERITED = ['PATH', 'LANG', 'LC_ALL', 'TZ'] as const
const INHERITED_ON_WINDOWS = ['SystemRoot', 'ComSpec', 'PATHEXT', 'WINDIR'] as const
const DEFAULT_START_TIMEOUT_MS = 30_000
const MAX_STDERR_TAIL = 2_000

export function debugHardeningPatchPath(): string {
  return require.resolve('@dsh-brain-core/satellite-bundle/patches/debug-hardening.yml')
}

export function dshBinPath(): string {
  return require.resolve('@deepseek-ai/dsh/lib/bin.js')
}

/**
 * Extracts and validates a loopback `dsh web: http://127.0.0.1:<port>...` URL.
 * Rejects `0.0.0.0`, `localhost`, public hosts, and non-HTTP schemes.
 */
export function parseDebugViewUrl(line: string): string | null {
  const match = /\bdsh web:\s*(https?:\/\/\S+)/.exec(line)
  if (match === null) return null
  const candidate = match[1] as string
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.port === '') {
    return null
  }
  const port = Number(parsed.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null
  }
  return parsed.toString()
}

function lookupEnv(parent: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return parent[name]
  const key = Object.keys(parent).find((candidate) => candidate.toUpperCase() === name.toUpperCase())
  return key === undefined ? undefined : parent[key]
}

export function buildDebugViewEnv(input: {
  readonly parent: NodeJS.ProcessEnv
  readonly platform: NodeJS.Platform
  readonly dshHome: string
  readonly osHome: string
  readonly tmpDir: string
  readonly apiKey?: string
  readonly baseUrl?: string
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  const names = input.platform === 'win32' ? [...INHERITED, ...INHERITED_ON_WINDOWS] : [...INHERITED]
  for (const name of names) {
    const value = lookupEnv(input.parent, name, input.platform)
    if (value !== undefined) env[name] = value
  }
  env.DSH_HOME = input.dshHome
  env.HOME = input.osHome
  env.USERPROFILE = input.osHome
  env.TMPDIR = input.tmpDir
  env.TEMP = input.tmpDir
  env.TMP = input.tmpDir
  if (input.apiKey !== undefined && input.apiKey !== '') {
    env.DEEPSEEK_API_KEY = input.apiKey
  }
  if (input.baseUrl !== undefined) {
    env.DEEPSEEK_BASE_URL = input.baseUrl
  }
  return env
}

export function createDebugViewController(options: DebugViewControllerOptions): DebugViewController {
  const spawnFn = options.spawnImpl ?? spawn
  const killFn = options.killImpl ?? killProcessTree
  const platform = options.platform ?? process.platform
  const timeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS

  let current: DebugViewStatus = { running: false }
  let activePid: number | undefined
  let inflightStart: Promise<DebugViewStatus> | undefined
  let stopRequested = false

  function reset(): void {
    activePid = undefined
    current = { running: false }
  }

  async function launch(): Promise<DebugViewStatus> {
    const parentEnv = options.parentEnv ?? process.env
    assertOutsideDshHome(options.brainHome, parentEnv, os.homedir())

    const root = path.join(options.brainHome, 'state', 'satellite')
    const dshHome = path.join(root, 'dsh-home')
    const osHome = path.join(root, 'os-home')
    const tmpDir = path.join(root, 'tmp')
    const workspace = path.join(root, 'workspace', 'debug')
    for (const dir of [dshHome, osHome, tmpDir, workspace]) {
      await mkdir(dir, { recursive: true })
    }

    if (stopRequested) {
      throw new Error('debug view stopped before launch')
    }

    const env = buildDebugViewEnv({
      parent: parentEnv,
      platform,
      dshHome,
      osHome,
      tmpDir,
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    })

    const args = [
      dshBinPath(),
      '--profile',
      'web',
      '--patch',
      debugHardeningPatchPath(),
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--no-open',
    ]

    const child = spawnFn(process.execPath, args, {
      cwd: workspace,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    if (child.pid === undefined) {
      throw new Error('failed to spawn isolated debug view process (missing pid)')
    }
    const pid = child.pid
    activePid = pid

    return new Promise<DebugViewStatus>((resolve, reject) => {
      let settled = false
      let stdoutBuf = ''
      let stderrTail = ''

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        void killFn(pid, platform).catch(() => {})
        reset()
        reject(new Error(`debug view startup timed out after ${String(timeoutMs)} ms`))
      }, timeoutMs)
      timer.unref?.()

      const fail = (reason: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        void killFn(pid, platform).catch(() => {})
        reset()
        reject(new Error(reason))
      }

      const succeed = (url: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const port = Number(new URL(url).port)
        current = { running: true, pid, url, port }
        resolve(current)
      }

      child.stdout?.on('data', (chunk: Buffer | string) => {
        if (settled) return
        stdoutBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        const lines = stdoutBuf.split(/\r?\n/)
        stdoutBuf = lines.pop() ?? ''
        for (const line of lines) {
          const url = parseDebugViewUrl(line)
          if (url !== null) {
            succeed(url)
            return
          }
        }
        const trailingUrl = parseDebugViewUrl(stdoutBuf)
        if (trailingUrl !== null) {
          succeed(trailingUrl)
        }
      })

      child.stderr?.on('data', (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        stderrTail = (stderrTail + text).slice(-MAX_STDERR_TAIL)
      })

      child.once('error', (error: Error) => {
        fail(`debug view process error: ${error.message}`)
      })

      child.once('exit', (code, signal) => {
        if (!settled) {
          const detail = stderrTail.trim() !== '' ? `: ${stderrTail.trim()}` : ''
          fail(`debug view exited before listening (code=${String(code)}, signal=${String(signal)})${detail}`)
          return
        }
        if (activePid === pid) {
          reset()
        }
      })
    })
  }

  return {
    start(): Promise<DebugViewStatus> {
      if (current.running) return Promise.resolve(current)
      if (inflightStart !== undefined) return inflightStart
      stopRequested = false
      inflightStart = launch().finally(() => {
        inflightStart = undefined
      })
      return inflightStart
    },

    async stop(): Promise<void> {
      stopRequested = true
      const pid = activePid ?? current.pid
      reset()
      if (pid !== undefined) {
        await killFn(pid, platform)
      }
    },

    status(): DebugViewStatus {
      return current
    },
  }
}
