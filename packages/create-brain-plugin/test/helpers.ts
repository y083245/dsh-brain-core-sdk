import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

export const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const REPO_DIR = path.resolve(PACKAGE_DIR, '..', '..')

/** A temporary directory removed when the test ends, even on Windows. */
export async function tempDir(t: TestContext, label: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `brain-plugin-${label}-`))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
  return dir
}

/**
 * A generated plugin imports `@dsh-brain-core/*`, so the test links the workspace packages into the
 * generated directory. Junctions work without developer mode on Windows.
 */
export async function linkWorkspace(dir: string): Promise<void> {
  const scope = path.join(dir, 'node_modules', '@dsh-brain-core')
  await mkdir(scope, { recursive: true })
  for (const name of ['sdk', 'testkit']) {
    await symlink(path.join(REPO_DIR, 'packages', name), path.join(scope, name), 'junction')
  }
}

export interface RunResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Runs a command and returns its output; kills it when the timeout expires. */
export function run(command: string, args: readonly string[], cwd: string, timeoutMs = 120_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // A child `node --test` would otherwise see the parent runner's context and skip every file.
    const env = { ...process.env }
    delete env['NODE_TEST_CONTEXT']
    const child = spawn(command, [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${command} timed out after ${timeoutMs} ms\n${stdout}\n${stderr}`))
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

export interface RpcMessage {
  readonly jsonrpc?: string
  readonly id?: number
  readonly method?: string
  readonly params?: Record<string, unknown>
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string }
}

interface Waiter {
  readonly predicate: (message: RpcMessage) => boolean
  readonly resolve: (message: RpcMessage) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/** A process plugin driven over stdio, one JSON-RPC message per line. */
export class PluginProcess {
  readonly child: ChildProcessWithoutNullStreams
  readonly #queue: RpcMessage[] = []
  readonly #waiters: Waiter[] = []
  #buffer = ''
  #stderr = ''
  #exitCode: number | null = null

  constructor(command: string, args: readonly string[], cwd: string) {
    this.child = spawn(command, [...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => { this.#receive(chunk) })
    this.child.stderr.on('data', (chunk: string) => { this.#stderr = (this.#stderr + chunk).slice(-4000) })
    this.child.on('exit', (code) => {
      this.#exitCode = code ?? -1
      for (const waiter of this.#waiters.splice(0)) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error(`plugin exited with ${this.#exitCode}\n${this.#stderr}`))
      }
    })
  }

  get stderr(): string {
    return this.#stderr
  }

  send(message: RpcMessage): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  waitFor(predicate: (message: RpcMessage) => boolean, timeoutMs = 60_000): Promise<RpcMessage> {
    const index = this.#queue.findIndex(predicate)
    if (index >= 0) {
      const [message] = this.#queue.splice(index, 1)
      return Promise.resolve(message!)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const at = this.#waiters.findIndex((waiter) => waiter.timer === timer)
        if (at >= 0) this.#waiters.splice(at, 1)
        reject(new Error(`no matching message after ${timeoutMs} ms\n${this.#stderr}`))
      }, timeoutMs)
      this.#waiters.push({ predicate, resolve, reject, timer })
    })
  }

  /** Sends `shutdown` and waits for the process to leave. */
  async stop(timeoutMs = 15_000): Promise<number | null> {
    if (this.#exitCode !== null) return this.#exitCode
    const exited = new Promise<number | null>((resolve) => {
      this.child.on('exit', (code) => resolve(code))
    })
    try {
      this.send({ jsonrpc: '2.0', method: 'shutdown' })
      this.child.stdin.end()
    } catch {
      // The process may already be gone.
    }
    const timer = setTimeout(() => { this.child.kill() }, timeoutMs)
    const code = await exited
    clearTimeout(timer)
    return code
  }

  #receive(chunk: string): void {
    this.#buffer += chunk
    for (;;) {
      const newline = this.#buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.#buffer.slice(0, newline).trim()
      this.#buffer = this.#buffer.slice(newline + 1)
      if (line === '') continue
      const message = JSON.parse(line) as RpcMessage
      const index = this.#waiters.findIndex((waiter) => waiter.predicate(message))
      if (index >= 0) {
        const [waiter] = this.#waiters.splice(index, 1)
        clearTimeout(waiter!.timer)
        waiter!.resolve(message)
      } else {
        this.#queue.push(message)
      }
    }
  }
}
