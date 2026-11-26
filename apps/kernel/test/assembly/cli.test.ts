import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createSecretStore } from '../../src/secrets/index.ts'
import { createSettingsStore } from '../../src/runtime-stores/settings.ts'
import { OTHER_PLUGIN, SAMPLE_PLUGIN } from './helpers.ts'

const CLI = fileURLToPath(new URL('../../src/cli.ts', import.meta.url))
const SAMPLE_V2 = fileURLToPath(new URL('./fixtures/sample-plugin-v2', import.meta.url))
const SAMPLE_V3 = fileURLToPath(new URL('./fixtures/sample-plugin-v3', import.meta.url))

async function home(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brain-cli-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  return dir
}

/** Every CLI child resolves DSH_HOME inside its own temp dir, never the real ~/.dsh. */
function dshHomeOf(homeDir: string): string {
  const dir = path.join(homeDir, 'dsh')
  mkdirSync(dir, { recursive: true })
  return dir
}

interface Run { readonly status: number | null; readonly stdout: string; readonly stderr: string }

function run(homeDir: string, args: readonly string[], input?: string): Run {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    input,
    env: { ...process.env, BRAIN_HOME: homeDir, DSH_HOME: dshHomeOf(homeDir) },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

test('brain start serves HTTP, writes state/kernel.pid and removes it on a graceful stop', async (t) => {
  const dir = await home(t)
  const child = spawn(process.execPath, [CLI, 'start', '--port', '0'], {
    env: { ...process.env, BRAIN_HOME: dir, DSH_HOME: dshHomeOf(dir) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  t.after(() => { if (child.exitCode === null) child.kill() })

  const lines: string[] = []
  assert.ok(child.stdout !== null)
  const stdout = child.stdout
  stdout.setEncoding('utf8')
  const ready = new Promise<{ port: number; token: string }>((resolve, reject) => {
    let buffer = ''
    stdout.on('data', (chunk: string) => {
      buffer += chunk
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        lines.push(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
      }
      const address = /^Brain memory API: http:\/\/127\.0\.0\.1:(\d+)\/api\/v1$/.exec(lines[0] ?? '')
      const token = /^Token: (.+)$/.exec(lines[1] ?? '')
      if (address !== null && token !== null) resolve({ port: Number(address[1]), token: token[1] as string })
    })
    child.once('error', reject)
    child.once('exit', (code) => reject(new Error(`exited early with ${code}`)))
  })
  const { port, token } = await ready
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/memory/health`, { headers: { authorization: `Bearer ${token}` } })
  assert.equal(response.status, 200)

  const pidFile = path.join(dir, 'state', 'kernel.pid')
  assert.equal((await readFile(pidFile, 'utf8')).trim(), String(child.pid))

  const exited = new Promise<number | null>((resolve) => { child.once('exit', (code) => resolve(code)) })
  assert.equal(typeof child.disconnect, 'function')
  child.disconnect()
  assert.equal(await exited, 0)
  assert.equal(existsSync(pidFile), false)
})

test('plugin install previews without --yes, then installs, lists, enables, disables and uninstalls', async (t) => {
  const dir = await home(t)
  const preview = run(dir, ['plugin', 'install', SAMPLE_PLUGIN])
  assert.equal(preview.status, 0)
  assert.match(preview.stdout, /plugin: sample/)
  assert.match(preview.stdout, /run with --yes to confirm/)
  assert.match(preview.stdout, /new permissions: .*tools\.register/)

  const installed = run(dir, ['plugin', 'install', SAMPLE_PLUGIN, '--yes'])
  assert.equal(installed.status, 0, installed.stderr)
  assert.match(installed.stdout, /installed sample/)

  const listed = run(dir, ['plugin', 'list'])
  assert.equal(listed.status, 0)
  assert.match(listed.stdout, /^sample 1\.0\.0 disabled$/m)

  assert.equal(run(dir, ['plugin', 'enable', 'sample']).status, 0)
  assert.match(run(dir, ['plugin', 'list']).stdout, /^sample 1\.0\.0 enabled$/m)
  assert.equal(run(dir, ['plugin', 'disable', 'sample']).status, 0)
  assert.match(run(dir, ['plugin', 'list']).stdout, /^sample 1\.0\.0 disabled$/m)

  const upgraded = run(dir, ['plugin', 'upgrade', 'sample', SAMPLE_V2, '--yes'])
  assert.equal(upgraded.status, 0, upgraded.stderr)
  assert.match(upgraded.stdout, /version: 2\.0\.0/)
  assert.match(upgraded.stdout, /upgraded sample/)
  assert.match(run(dir, ['plugin', 'list']).stdout, /^sample 2\.0\.0 disabled$/m)

  // A version that asks for a new permission waits for the confirmation in `--yes`.
  const pending = run(dir, ['plugin', 'upgrade', 'sample', SAMPLE_V3])
  assert.equal(pending.status, 0, pending.stderr)
  assert.match(pending.stdout, /new permissions: memory\.forget/)
  assert.match(pending.stdout, /run with --yes to confirm/)
  assert.match(run(dir, ['plugin', 'list']).stdout, /^sample 2\.0\.0 disabled$/m)
  const confirmed = run(dir, ['plugin', 'upgrade', 'sample', SAMPLE_V3, '--yes'])
  assert.equal(confirmed.status, 0, confirmed.stderr)
  assert.match(confirmed.stdout, /upgraded sample/)
  assert.match(run(dir, ['plugin', 'list']).stdout, /^sample 3\.0\.0 disabled$/m)

  assert.equal(run(dir, ['plugin', 'uninstall', 'sample', '--keep-data']).status, 0)
  assert.equal(run(dir, ['plugin', 'list']).stdout, '')
})

test('plugin check needs no kernel and passes for the sample plugin', async (t) => {
  const dir = await home(t)
  const check = run(dir, ['plugin', 'check', SAMPLE_PLUGIN, '--json'])
  assert.equal(check.status, 0, check.stderr + check.stdout)
  const report = JSON.parse(check.stdout) as { ok: boolean; contract: readonly { ok: boolean }[] }
  assert.equal(report.ok, true)
  assert.ok(report.contract.length > 0)
  assert.ok(report.contract.every((item) => item.ok))
})

test('model set writes the choice, refuses a missing field and never invents a default', async (t) => {
  const dir = await home(t)
  const bad = run(dir, ['model', 'set', 'chat'])
  assert.equal(bad.status, 2)
  assert.equal(existsSync(path.join(dir, 'state', 'settings.json')), false)

  const badEffort = run(dir, ['model', 'set', 'chat', '--provider', 'deepseek-official', '--model', 'deepseek-flash', '--effort', 'turbo'])
  assert.equal(badEffort.status, 2)
  assert.equal(existsSync(path.join(dir, 'state', 'settings.json')), false)

  const ok = run(dir, ['model', 'set', 'chat', '--provider', 'deepseek-official', '--model', 'deepseek-flash', '--effort', 'low'])
  assert.equal(ok.status, 0, ok.stderr)
  const stored = await createSettingsStore(path.join(dir, 'state', 'settings.json')).read()
  assert.deepEqual(stored.agents.chat, { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'low' })
  assert.equal(stored.agents.activity, undefined)
})

test('secret set reads stdin, stores the value and prints only the name', async (t) => {
  const dir = await home(t)
  const result = run(dir, ['secret', 'set', 'deepseek-api-key'], 'top-secret-value\n')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.includes('top-secret-value'), false)
  assert.equal(result.stderr.includes('top-secret-value'), false)
  const stored = await createSecretStore({ file: path.join(dir, 'state', 'secrets.json') }).get('deepseek-api-key')
  assert.equal(stored, 'top-secret-value')
})

test('while a kernel is running plugin, model and secret changes are refused but plugin check still runs', async (t) => {
  const dir = await home(t)
  await mkdir(path.join(dir, 'state'), { recursive: true })
  const { writeFileAtomic } = await import('@brain-core/shared')
  await writeFileAtomic(path.join(dir, 'state', 'kernel.pid'), `${process.pid}\n`)

  for (const args of [
    ['plugin', 'enable', 'sample'],
    ['model', 'set', 'chat', '--provider', 'deepseek-official', '--model', 'deepseek-flash', '--effort', 'low'],
    ['secret', 'set', 'deepseek-api-key'],
  ]) {
    const result = run(dir, args, 'value\n')
    assert.notEqual(result.status, 0, args.join(' '))
    assert.match(result.stderr, /先停内核/, args.join(' '))
  }

  const check = run(dir, ['plugin', 'check', SAMPLE_PLUGIN])
  assert.equal(check.status, 0, check.stderr)
})

test('doctor snapshots and compares an isolation home', async (t) => {
  const dir = await home(t)
  const dsh = path.join(dir, 'dsh')
  await mkdir(path.join(dsh, 'profiles', 'web'), { recursive: true })
  await (await import('node:fs/promises')).writeFile(path.join(dsh, 'profiles', 'web', 'package.json'), '{}')
  const snapshotFile = path.join(dir, 'snapshot.json')

  const snap = run(dir, ['doctor', '--isolation', '--dsh-home', dsh, '--snapshot', snapshotFile])
  assert.equal(snap.status, 0, snap.stderr)
  assert.match(snap.stdout, /^snapshot: \d+ entries -> /m)

  const same = run(dir, ['doctor', '--isolation', '--dsh-home', dsh, '--compare', snapshotFile])
  assert.equal(same.status, 0, same.stderr)
  assert.match(same.stdout, /compare: unchanged/)

  await (await import('node:fs/promises')).writeFile(path.join(dsh, 'profiles', 'web', 'package.json'), '{"changed":true}')
  const changed = run(dir, ['doctor', '--isolation', '--dsh-home', dsh, '--compare', snapshotFile])
  assert.equal(changed.status, 1)
  assert.match(changed.stdout, /changed: profiles\/web\/package\.json/)
})

test('a CLI child without --dsh-home reads DSH_HOME from the test temp dir', async (t) => {
  const dir = await home(t)
  // run() points the child's DSH_HOME at <dir>/dsh; a marker there must be the only thing snapshotted.
  await writeFile(path.join(dshHomeOf(dir), 'probe.txt'), 'x')
  const snapshotFile = path.join(dir, 'isolated.json')

  const result = run(dir, ['doctor', '--isolation', '--snapshot', snapshotFile])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^snapshot: 1 entries -> /m)
  const entries = JSON.parse(await readFile(snapshotFile, 'utf8')) as readonly { readonly path: string }[]
  assert.deepEqual(entries.map((entry) => entry.path), ['probe.txt'])
})

test('argument errors exit 2 and print the usage', async (t) => {
  const dir = await home(t)
  for (const args of [
    ['plugin'],
    ['plugin', 'install'],
    ['plugin', 'uninstall'],
    ['model', 'set'],
    ['secret', 'set'],
    ['doctor'],
    ['doctor', '--isolation', '--snapshot', path.join(dir, 'a'), '--compare', path.join(dir, 'b')],
    ['start', '--port', 'nope'],
  ]) {
    const result = run(dir, args)
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`)
  }
})

test('install --yes confirms the plugin this command names, not an unrelated pending one', async (t) => {
  const dir = await home(t)
  const preview = run(dir, ['plugin', 'install', SAMPLE_PLUGIN])
  assert.equal(preview.status, 0, preview.stderr)
  assert.match(run(dir, ['plugin', 'list']).stdout, /^sample 1\.0\.0 pending$/m)

  const other = run(dir, ['plugin', 'install', OTHER_PLUGIN, '--yes'])
  assert.equal(other.status, 0, other.stderr)
  assert.match(other.stdout, /installed other/)

  const listed = run(dir, ['plugin', 'list']).stdout
  assert.match(listed, /^sample 1\.0\.0 pending$/m, 'the earlier preview stays pending')
  assert.match(listed, /^other 1\.0\.0 disabled$/m, 'the named plugin was installed and confirmed')
})

test('model set refuses an agent class other than chat and activity', async (t) => {
  const dir = await home(t)
  const result = run(dir, ['model', 'set', 'foo', '--provider', 'deepseek-official', '--model', 'deepseek-flash', '--effort', 'low'])
  assert.equal(result.status, 2)
  assert.equal(existsSync(path.join(dir, 'state', 'settings.json')), false)
})

test('uninstall keeps plugin data only with --keep-data', async (t) => {
  const dir = await home(t)
  const dataDir = path.join(dir, 'state', 'plugins', 'sample')

  assert.equal(run(dir, ['plugin', 'install', SAMPLE_PLUGIN, '--yes']).status, 0)
  await mkdir(dataDir, { recursive: true })
  await writeFile(path.join(dataDir, 'keep.txt'), 'x')
  assert.equal(run(dir, ['plugin', 'uninstall', 'sample', '--keep-data']).status, 0)
  assert.equal(existsSync(path.join(dataDir, 'keep.txt')), true)

  assert.equal(run(dir, ['plugin', 'install', SAMPLE_PLUGIN, '--yes']).status, 0)
  await mkdir(dataDir, { recursive: true })
  await writeFile(path.join(dataDir, 'keep.txt'), 'x')
  assert.equal(run(dir, ['plugin', 'uninstall', 'sample']).status, 0)
  assert.equal(existsSync(dataDir), false)
})
