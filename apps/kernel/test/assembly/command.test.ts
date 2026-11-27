import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { BrainError } from '@dsh-brain-core/sdk'
import { runCommand } from '../../src/assembly.ts'
import { resolveCommand, type CommandResolutionOptions } from '../../src/plugin-lifecycle/index.ts'

const NODE = String.raw`C:\Program Files\nodejs\node.exe`
const NPM = String.raw`C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js`
const NPX = String.raw`C:\Program Files\nodejs\node_modules\npm\bin\npx-cli.js`
const SPEC = '@scope/plugin & echo injected | more ^ %PATH%'

function windows(files: readonly string[], overrides: Partial<CommandResolutionOptions> = {}): CommandResolutionOptions {
  const present = new Set(files.map((file) => path.win32.normalize(file).toLowerCase()))
  return {
    platform: 'win32', execPath: NODE, env: {},
    isFile: (file) => present.has(path.win32.normalize(file).toLowerCase()),
    ...overrides,
  }
}

function brainError(code: string, message: string): (error: unknown) => boolean {
  return (error) => error instanceof BrainError && error.code === code && error.message === message
}

test('Windows npm prefers a matching npm_execpath over the Node layout', () => {
  for (const ext of ['js', 'cjs', 'mjs']) {
    const cli = String.raw`D:\npm\npm-cli.${ext}`
    assert.deepEqual(resolveCommand('npm', ['pack', SPEC], windows([cli, NPM], { env: { npm_execpath: cli } })), {
      executable: NODE, args: [cli, 'pack', SPEC],
    })
  }
})

test('Windows rejects missing or unrelated npm_execpath entries and never uses it for npx', () => {
  for (const cli of [String.raw`D:\npm\pnpm.cjs`, String.raw`D:\missing\npm-cli.js`, String.raw`D:\npm\npm-cli.cmd`]) {
    assert.deepEqual(resolveCommand('npm', [], windows([NPM, String.raw`D:\npm\pnpm.cjs`, String.raw`D:\npm\npm-cli.cmd`], {
      env: { npm_execpath: cli },
    })), { executable: NODE, args: [NPM] })
  }
  assert.deepEqual(resolveCommand('npx', ['--version'], windows([NPM, NPX], { env: { npm_execpath: NPM } })), {
    executable: NODE, args: [NPX, '--version'],
  })
})

test('Windows npm and npx resolve the Node sibling and parent layouts in order', () => {
  for (const command of ['npm', 'npx']) {
    const sibling = path.win32.join(path.win32.dirname(NODE), 'node_modules', 'npm', 'bin', `${command}-cli.js`)
    const parent = path.win32.join(path.win32.dirname(NODE), '..', 'node_modules', 'npm', 'bin', `${command}-cli.js`)
    for (const files of [[sibling, parent], [parent]]) {
      assert.deepEqual(resolveCommand(command, ['--version'], windows(files)), {
        executable: NODE, args: [files[0], '--version'],
      })
    }
  }
})

test('Windows finds quoted npm.cmd / npx.cmd directories in PATH or Path without running the shim', () => {
  for (const command of ['npm', 'npx']) {
    for (const key of ['PATH', 'Path']) {
      const dir = String.raw`D:\npm tools`
      const cli = path.win32.join(dir, 'node_modules', 'npm', 'bin', `${command}-cli.js`)
      const options = windows([path.win32.join(dir, `${command}.cmd`), cli], {
        env: { [key]: `"D:\\missing";"${dir}";` },
      })
      assert.deepEqual(resolveCommand(command, [SPEC], options), { executable: NODE, args: [cli, SPEC] })
    }
  }
})

test('Windows checks PATH layouts even without a batch shim and respects PATH order', () => {
  const first = String.raw`D:\first\node_modules\npm\bin\npm-cli.js`
  const second = String.raw`D:\second\node_modules\npm\bin\npm-cli.js`
  assert.deepEqual(resolveCommand('npm', [], windows([first, second], { env: { PATH: String.raw`D:\first;D:\second` } })), {
    executable: NODE, args: [first],
  })
})

test('Windows fails UNAVAILABLE when only batch shims exist or no CLI is available', () => {
  for (const command of ['npm', 'npx']) {
    assert.throws(() => resolveCommand(command, [], windows([String.raw`D:\npm\${command}.cmd`], {
      env: { PATH: String.raw`D:\npm` },
    })), brainError('UNAVAILABLE', `${command} CLI is not available`))
  }
})

test('other Windows commands and every non-Windows command pass through unchanged', () => {
  for (const command of ['tar', 'uv']) {
    assert.deepEqual(resolveCommand(command, [SPEC], windows([])), { executable: command, args: [SPEC] })
  }
  for (const platform of ['darwin', 'linux'] as const) {
    for (const command of ['npm', 'npx', 'tar', 'uv']) {
      assert.deepEqual(resolveCommand(command, [SPEC], windows([], { platform })), { executable: command, args: [SPEC] })
    }
  }
})

test('real runCommand executes npm --version, preserves arguments, and maps missing / failing commands', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'brain-command-'))
  t.after(async () => { await rm(cwd, { recursive: true, force: true, maxRetries: 5 }) })
  await runCommand('npm', ['--version'], { cwd })
  await runCommand(process.execPath, ['-e', `require('node:assert/strict').equal(process.argv[1], ${JSON.stringify(SPEC)})`, SPEC], { cwd })
  await assert.rejects(runCommand('brain-command-does-not-exist-51b71', [], { cwd }),
    brainError('UNAVAILABLE', 'command not found: brain-command-does-not-exist-51b71'))
  await assert.rejects(runCommand(process.execPath, ['-e', 'console.error("private package info"); process.exit(7)'], { cwd }),
    brainError('INTERNAL', `command failed: ${process.execPath}`))
})

test('synchronous execFile exceptions are always mapped to safe BrainErrors', async (t) => {
  for (const code of ['EINVAL', 'ENOENT', 'ERR_INVALID_ARG_VALUE']) {
    const mock = t.mock.method(childProcess, 'execFile', () => { throw Object.assign(new Error('private path / secrets'), { code }) })
    try {
      await assert.rejects(runCommand('tar', [SPEC], { cwd: os.tmpdir() }), code === 'ENOENT'
        ? brainError('UNAVAILABLE', 'command not found: tar')
        : brainError('INTERNAL', 'command failed: tar'))
    } finally {
      mock.mock.restore()
    }
  }
})
