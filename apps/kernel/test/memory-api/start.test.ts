import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { validate } from '@dsh-brain-core/sdk'

const cli = fileURLToPath(new URL('../../src/cli.ts', import.meta.url))

interface Started {
  readonly port: number
  readonly token: string
  readonly stdout: () => string
  readonly stderr: () => string
}

function waitForStart(child: ChildProcess): Promise<Started> {
  return new Promise((resolve, reject) => {
    let out = ''
    let err = ''
    let settled = false
    const finish = (): void => {
      const portMatch = /Brain memory API: http:\/\/127\.0\.0\.1:(\d+)\/api\/v1/.exec(out)
      const tokenMatch = /Token: (\S+)/.exec(out)
      if (portMatch === null || tokenMatch === null || settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        port: Number(portMatch[1]),
        token: tokenMatch[1] as string,
        stdout: () => out,
        stderr: () => err,
      })
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`brain start did not print its lines: ${out}${err}`))
    }, 20_000)
    child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString(); finish() })
    child.stderr?.on('data', (chunk: Buffer) => { err += chunk.toString() })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`brain start exited early with ${String(code)}: ${out}${err}`))
    })
  })
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('brain start did not exit')), 20_000)
    child.once('exit', (code) => { clearTimeout(timer); resolve(code) })
  })
}

test('brain start serves the API on a free port and stops on SIGTERM', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brain-start-'))
  const child = spawn(process.execPath, [cli, 'start', '--port', '0'], {
    env: { ...process.env, BRAIN_HOME: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    const started = await waitForStart(child)

    const response = await fetch(`http://127.0.0.1:${started.port}/api/v1/memory/health`, {
      headers: { Authorization: `Bearer ${started.token}` },
    })
    assert.equal(response.status, 200)
    const body = await response.json() as Record<string, unknown>
    validate('Envelope', body)
    assert.equal(body.ok, true)

    const exitedPromise = exited(child)
    if (process.platform === 'win32') child.kill()
    else child.kill('SIGTERM')
    const code = await exitedPromise
    // Windows has no SIGTERM: kill() terminates the process, so only the POSIX path can carry the
    // shutdown handler's exit code. Both platforms must still see the process exit.
    if (process.platform !== 'win32') assert.equal(code, 0)

    assert.equal(started.stderr().includes(started.token), false, 'the token must never reach the log')
    assert.equal((started.stdout().match(/Token:/g) ?? []).length, 1, 'the token is printed exactly once')
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await rm(dir, { recursive: true, force: true, maxRetries: 5 })
  }
})
