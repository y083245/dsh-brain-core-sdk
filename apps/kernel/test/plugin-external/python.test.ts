import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { validateManifest, type BrainManifest } from '@brain-core/sdk'
import type { InstalledPlugin } from '../../src/contracts/index.ts'
import { createExternalApply } from '../../src/plugin-external/index.ts'
import { fakeContext, type LogEntry } from './helpers.ts'

const run = promisify(execFile)
const SAMPLE = path.resolve(import.meta.dirname, '../../../../plugins/samples/python-echo')

test('the python sample installs, ingests and searches through the real protocol', { timeout: 180_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'python-echo-'))
  const pluginDir = path.join(dir, 'plugin')
  await cp(SAMPLE, pluginDir, { recursive: true })
  await run('uv', ['sync', '--no-dev'], { cwd: pluginDir, env: process.env })

  const pkg = JSON.parse(await readFile(path.join(pluginDir, 'package.json'), 'utf8')) as { version: string; brain: unknown }
  const parsed = validateManifest(pkg.brain)
  assert.equal(parsed.ok, true, JSON.stringify(parsed.ok ? {} : parsed.errors))
  const manifest = (parsed as { ok: true; manifest: BrainManifest }).manifest
  const pluginsDir = path.join(dir, 'state')
  const plugin: InstalledPlugin = { manifest, version: pkg.version, dir: pluginDir, granted: manifest.permissions, config: {} }
  const fake = fakeContext({ id: manifest.id })
  const logs: LogEntry[] = []
  const deps = {
    pluginsDir,
    log: {
      info: (event: string, fields?: LogEntry['fields']) => logs.push({ level: 'info' as const, event, fields }),
      warn: (event: string, fields?: LogEntry['fields']) => logs.push({ level: 'warn' as const, event, fields }),
      error: (event: string, fields?: LogEntry['fields']) => logs.push({ level: 'error' as const, event, fields }),
    },
    now: () => Date.now(),
    onFailed: () => undefined,
    parentEnv: process.env,
  }

  try {
    await createExternalApply(plugin, deps)(fake.ctx, {})
    const tool = fake.state.tools.get('echo')
    assert.ok(tool !== undefined, 'the python plugin registers echo')
    const output = await tool.handler({ text: 'hello' }, { channel: 'python-echo:private:echo', wakeId: 'w' })
    assert.equal(output, 'echo hello: 1 hit(s) r1')

    const [event] = fake.state.calls.memoryIngest[0] as [Record<string, unknown>]
    assert.equal(event.kind, 'python-echo.echo')
    assert.equal(event.channel, 'python-echo:private:echo')
    assert.equal(event.actor, 'python-echo')
    assert.deepEqual(event.content, { text: 'hello' })
    assert.deepEqual(fake.state.calls.memorySearch[0], [
      { query: 'hello', scope: 'here' },
      { channel: 'python-echo:private:echo' },
    ])
  } finally {
    fake.revoke()
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
})
