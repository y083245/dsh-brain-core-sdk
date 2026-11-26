import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import {
  buildDebugViewEnv,
  createDebugViewController,
  debugHardeningPatchPath,
  dshBinPath,
  parseDebugViewUrl,
} from '../src/index.ts'

interface FakeChildRecord {
  readonly command: string
  readonly args: readonly string[]
  readonly options: Readonly<{
    cwd?: string
    env?: NodeJS.ProcessEnv
    shell?: boolean
  }>
  readonly child: FakeChildProcess
}

class FakeChildProcess extends EventEmitter {
  readonly pid: number
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()

  constructor(pid: number) {
    super()
    this.pid = pid
  }
}

test('debugHardeningPatchPath disables session-log-deepseek and plugin-package-inventory-deepseek and dshBinPath resolves', async () => {
  const patchPath = debugHardeningPatchPath()
  assert.ok(patchPath.endsWith('debug-hardening.yml'))
  const content = await readFile(patchPath, 'utf8')
  assert.equal(content.includes('disabled: false'), false)
  const items: { id?: string; disabled?: string }[] = []
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    if (line.startsWith('- ')) items.push({})
    const current = items[items.length - 1]
    assert.ok(current !== undefined, 'unexpected YAML structure before list item')
    const idMatch = /^(?:-\s+)?id:\s*(\S+)$/.exec(line)
    if (idMatch !== null) current.id = idMatch[1]
    const disabledMatch = /^(?:-\s+)?disabled:\s*(\S+)$/.exec(line)
    if (disabledMatch !== null) current.disabled = disabledMatch[1]
  }
  assert.deepEqual(items, [
    { id: 'session-log-deepseek', disabled: 'true' },
    { id: 'plugin-package-inventory-deepseek', disabled: 'true' },
  ])

  const binPath = dshBinPath()
  assert.ok(binPath.endsWith(path.join('lib', 'bin.js')))
})

test('parseDebugViewUrl accepts only 127.0.0.1 HTTP URLs and rejects non-loopback or invalid URLs', () => {
  assert.equal(parseDebugViewUrl('dsh web: http://127.0.0.1:41234/'), 'http://127.0.0.1:41234/')
  assert.equal(
    parseDebugViewUrl('prefix dsh web: http://127.0.0.1:41234/?token=abc123'),
    'http://127.0.0.1:41234/?token=abc123',
  )
  assert.equal(parseDebugViewUrl('dsh web: http://0.0.0.0:41234/'), null)
  assert.equal(parseDebugViewUrl('dsh web: http://localhost:41234/'), null)
  assert.equal(parseDebugViewUrl('dsh web: http://192.168.1.20:41234/'), null)
  assert.equal(parseDebugViewUrl('dsh web: http://127.0.0.1.evil.com:41234/'), null)
  assert.equal(parseDebugViewUrl('dsh web: http://[::1]:41234/'), null)
  assert.equal(parseDebugViewUrl('dsh web: http://127.0.0.1:65536/'), null)
  assert.equal(parseDebugViewUrl('dsh web: https://127.0.0.1:41234/'), null)
  assert.equal(parseDebugViewUrl('dsh web: http://127.0.0.1/'), null)
  assert.equal(parseDebugViewUrl('unrelated output'), null)
})

test('createDebugViewController isolates env, passes hardening flags, and handles idempotent start/stop', async () => {
  const brainHome = await mkdtemp(path.join(os.tmpdir(), 'brain-debug-view-'))
  try {
    const spawned: FakeChildRecord[] = []
    const killedPids: number[] = []

    const controller = createDebugViewController({
      brainHome,
      platform: 'linux',
      parentEnv: {
        PATH: '/usr/bin',
        LANG: 'en_US.UTF-8',
        DSH_HOME: '/home/owner/.dsh',
        HOME: '/home/owner',
        USERPROFILE: '/home/owner',
        XDG_CONFIG_HOME: '/home/owner/.config',
        OPENAI_API_KEY: 'sk-leak',
        NODE_OPTIONS: '--require=/evil.js',
      },
      apiKey: 'sk-isolated-key',
      spawnImpl: ((command: string, args: readonly string[], options: Record<string, unknown>) => {
        const child = new FakeChildProcess(42420 + spawned.length)
        spawned.push({
          command,
          args,
          options: options as FakeChildRecord['options'],
          child,
        })
        queueMicrotask(() => {
          child.stdout.write('booting dsh...\ndsh web: http://127.0.0.1:51988/?token=t1\n')
        })
        return child as never
      }) as never,
      killImpl: async (pid) => {
        killedPids.push(pid)
      },
    })

    assert.deepEqual(controller.status(), { running: false })

    const started = await controller.start()
    assert.deepEqual(started, {
      running: true,
      pid: 42420,
      url: 'http://127.0.0.1:51988/?token=t1',
      port: 51988,
    })

    // Idempotent second start does not spawn another child
    const startedAgain = await controller.start()
    assert.deepEqual(startedAgain, started)
    assert.equal(spawned.length, 1)

    const rec = spawned[0]!
    assert.equal(rec.command, process.execPath)
    assert.equal(rec.options.shell, false)
    assert.deepEqual(rec.args, [
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
    ])

    const expectedRoot = path.join(brainHome, 'state', 'satellite')
    assert.equal(rec.options.env?.DSH_HOME, path.join(expectedRoot, 'dsh-home'))
    assert.equal(rec.options.env?.HOME, path.join(expectedRoot, 'os-home'))
    assert.equal(rec.options.env?.USERPROFILE, path.join(expectedRoot, 'os-home'))
    assert.equal(rec.options.env?.TMPDIR, path.join(expectedRoot, 'tmp'))
    assert.equal(rec.options.env?.TEMP, path.join(expectedRoot, 'tmp'))
    assert.equal(rec.options.env?.TMP, path.join(expectedRoot, 'tmp'))
    assert.equal(rec.options.env?.PATH, '/usr/bin')
    assert.equal(rec.options.env?.DEEPSEEK_API_KEY, 'sk-isolated-key')
    assert.equal(rec.options.env?.XDG_CONFIG_HOME, undefined)
    assert.equal(rec.options.env?.OPENAI_API_KEY, undefined)
    assert.equal(rec.options.env?.NODE_OPTIONS, undefined)

    await controller.stop()
    assert.deepEqual(killedPids, [42420])
    assert.deepEqual(controller.status(), { running: false })

    // Idempotent stop
    await controller.stop()
    assert.deepEqual(killedPids, [42420])
  } finally {
    await rm(brainHome, { recursive: true, force: true })
  }
})

test('createDebugViewController rejects brainHome inside DSH_HOME and cleans up on timeout or premature exit', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brain-debug-err-'))
  try {
    const insideController = createDebugViewController({
      brainHome: path.join(dir, 'real-dsh', 'sub'),
      parentEnv: { DSH_HOME: path.join(dir, 'real-dsh') },
    })
    await assert.rejects(() => insideController.start(), /must not be inside a DSH home/)

    const killedOnExit: number[] = []
    const exitController = createDebugViewController({
      brainHome: path.join(dir, 'bh-exit'),
      spawnImpl: (() => {
        const child = new FakeChildProcess(7771)
        queueMicrotask(() => {
          child.stderr.write('boom')
          child.emit('exit', 1, null)
        })
        return child as never
      }) as never,
      killImpl: async (pid) => { killedOnExit.push(pid) },
    })
    await assert.rejects(() => exitController.start(), /exited before listening.*boom/)
    assert.deepEqual(killedOnExit, [7771])
    assert.deepEqual(exitController.status(), { running: false })

    const killedOnTimeout: number[] = []
    const timeoutController = createDebugViewController({
      brainHome: path.join(dir, 'bh-timeout'),
      startTimeoutMs: 25,
      spawnImpl: (() => new FakeChildProcess(7772) as never) as never,
      killImpl: async (pid) => { killedOnTimeout.push(pid) },
    })
    await assert.rejects(() => timeoutController.start(), /timed out/)
    assert.deepEqual(killedOnTimeout, [7772])
    assert.deepEqual(timeoutController.status(), { running: false })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('buildDebugViewEnv preserves Windows system vars case-insensitively and drops parent DSH_HOME', () => {
  const env = buildDebugViewEnv({
    parent: {
      Path: 'C:\\Windows\\System32',
      SYSTEMROOT: 'C:\\Windows',
      comspec: 'C:\\Windows\\System32\\cmd.exe',
      DSH_HOME: 'C:\\Users\\owner\\.dsh',
      TEMP: 'C:\\Users\\owner\\AppData\\Local\\Temp',
    },
    platform: 'win32',
    dshHome: 'D:\\brain\\state\\satellite\\dsh-home',
    osHome: 'D:\\brain\\state\\satellite\\os-home',
    tmpDir: 'D:\\brain\\state\\satellite\\tmp',
  })
  assert.equal(env.PATH, 'C:\\Windows\\System32')
  assert.equal(env.SystemRoot, 'C:\\Windows')
  assert.equal(env.ComSpec, 'C:\\Windows\\System32\\cmd.exe')
  assert.equal(env.DSH_HOME, 'D:\\brain\\state\\satellite\\dsh-home')
  assert.equal(env.USERPROFILE, 'D:\\brain\\state\\satellite\\os-home')
  assert.equal(env.TEMP, 'D:\\brain\\state\\satellite\\tmp')
})
