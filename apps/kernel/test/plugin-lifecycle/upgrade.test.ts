import assert from 'node:assert/strict'
import { cp, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import type { BrainManifest } from '@dsh-brain-core/sdk'
import { backupDirs, installedDirs, makePlugin, setup, throwsCode } from './helpers.ts'

const SOURCE = {
  channels: ['demo:private:1'],
  eventKinds: ['demo.message'],
  defaultVisibility: 'origin' as const,
  trust: 'member' as const,
}

interface InstalledOptions {
  readonly permissions?: readonly string[]
  readonly files?: Readonly<Record<string, string>>
  readonly manifest?: Partial<BrainManifest>
}

/** Installs, confirms and enables version 1.0.0 of the demo plugin. */
async function installed(t: TestContext, options: InstalledOptions = {}) {
  const h = await setup(t)
  const source = await makePlugin(path.join(h.root, 'v1'), {
    version: '1.0.0',
    permissions: options.permissions ?? ['memory.search'],
    manifest: { source: SOURCE, ...options.manifest },
    files: options.files,
  })
  await h.lifecycle.install(source)
  await h.lifecycle.confirm('demo')
  await h.lifecycle.enable('demo')
  return h
}

function nextPlugin(
  h: Awaited<ReturnType<typeof setup>>,
  options: InstalledOptions & { version?: string; name?: string; id?: string; api?: string } = {},
): Promise<string> {
  const id = options.id ?? 'demo'
  return makePlugin(path.join(h.root, options.name ?? `v-${options.version ?? '2.0.0'}`), {
    id,
    version: options.version ?? '2.0.0',
    api: options.api ?? '^1',
    permissions: options.permissions ?? ['memory.search'],
    manifest: { source: { ...SOURCE, channels: [`${id}:private:1`] }, ...options.manifest },
    files: options.files,
  })
}

test('permissions growing leave the old version running until confirm', async (t) => {
  const h = await installed(t)
  const source = await nextPlugin(h, { permissions: ['memory.search', 'memory.record'] })

  const preview = await h.lifecycle.upgrade('demo', source)
  assert.deepEqual(preview.permissions, ['memory.search', 'memory.record'])
  assert.deepEqual(preview.newPermissions, ['memory.record'])
  assert.equal(h.activator.enabled.get('demo')?.version, '1.0.0')
  let [entry] = await h.lifecycle.list()
  assert.deepEqual(entry, {
    id: 'demo', version: '1.0.0', state: 'enabled', permissions: ['memory.search'], granted: ['memory.search'],
  })
  assert.equal((await installedDirs(h.pluginsDir)).length, 2)

  await h.lifecycle.confirm('demo')
  assert.equal(h.activator.enabled.get('demo')?.version, '2.0.0')
  ;[entry] = await h.lifecycle.list()
  assert.deepEqual(entry, {
    id: 'demo', version: '2.0.0', state: 'enabled', permissions: ['memory.search', 'memory.record'],
    granted: ['memory.search', 'memory.record'],
  })
})

test('permissions unchanged upgrade straight away', async (t) => {
  const h = await installed(t)
  h.activator.calls.length = 0
  const preview = await h.lifecycle.upgrade('demo', await nextPlugin(h))

  assert.deepEqual(preview.newPermissions, [])
  assert.equal(preview.version, '2.0.0')
  assert.equal(h.activator.enabled.get('demo')?.version, '2.0.0')
  assert.deepEqual(h.activator.calls.map((call) => call.op), ['disable', 'enable'])
  const [entry] = await h.lifecycle.list()
  assert.equal(entry?.version, '2.0.0')
  assert.deepEqual(entry?.granted, ['memory.search'])
  assert.equal((await installedDirs(h.pluginsDir)).length, 2)
})

test('a migration failure restores the data directory, schema-version and the old version', async (t) => {
  const h = await installed(t)
  const data = path.join(h.pluginsDir, 'demo')
  await mkdir(data, { recursive: true })
  await writeFile(path.join(data, 'config.json'), '{"name":"old"}')
  await writeFile(path.join(data, 'schema-version'), '1\n')
  await writeFile(path.join(data, 'note.txt'), 'keep me')

  const brokenMigration = [
    "import { writeFile } from 'node:fs/promises'",
    'export async function up() {',
    "  const data = new URL('../../../../demo/', import.meta.url)",
    "  await writeFile(new URL('config.json', data), '{\"name\":\"mutated\"}')",
    "  await writeFile(new URL('schema-version', data), '2\\n')",
    "  await writeFile(new URL('created-by-migration.txt', data), 'x')",
    "  throw new Error('migration failed')",
    '}',
    '',
  ].join('\n')
  const source = await nextPlugin(h, {
    manifest: { migrations: './migrations' },
    files: { 'migrations/002-broken.mjs': brokenMigration },
  })
  await assert.rejects(h.lifecycle.upgrade('demo', source), /migration failed/)

  assert.equal(await readFile(path.join(data, 'schema-version'), 'utf8'), '1\n')
  assert.equal(await readFile(path.join(data, 'config.json'), 'utf8'), '{"name":"old"}')
  assert.equal(await readFile(path.join(data, 'note.txt'), 'utf8'), 'keep me')
  await assert.rejects(readFile(path.join(data, 'created-by-migration.txt')), { code: 'ENOENT' })
  const [entry] = await h.lifecycle.list()
  assert.equal(entry?.version, '1.0.0')
  assert.equal(entry?.state, 'enabled')
  assert.deepEqual(entry?.granted, ['memory.search'])
  assert.equal(h.activator.enabled.get('demo')?.version, '1.0.0')
  assert.equal((await installedDirs(h.pluginsDir)).length, 1)
  assert.deepEqual((await backupDirs(h.pluginsDir)).length, 1)
})

test('a new version that fails to enable rolls back and re-enables the old version', async (t) => {
  const h = await installed(t)
  const data = path.join(h.pluginsDir, 'demo')
  await mkdir(data, { recursive: true })
  await writeFile(path.join(data, 'config.json'), '{"name":"old"}')
  h.activator.failEnable = (plugin) => plugin.version === '2.0.0' ? new Error('apply exploded') : undefined

  await assert.rejects(h.lifecycle.upgrade('demo', await nextPlugin(h)), /apply exploded/)

  assert.equal(await readFile(path.join(data, 'config.json'), 'utf8'), '{"name":"old"}')
  const [entry] = await h.lifecycle.list()
  assert.equal(entry?.version, '1.0.0')
  assert.equal(entry?.state, 'enabled')
  assert.equal(h.activator.enabled.get('demo')?.version, '1.0.0')
  const enables = h.activator.calls.filter((call) => call.op === 'enable').map((call) => call.version)
  assert.deepEqual(enables, ['1.0.0', '2.0.0', '1.0.0'])
})

test('at most three backups are kept, and they are the newest', async (t) => {
  const h = await installed(t)
  const names: string[] = []
  for (let major = 2; major <= 5; major += 1) {
    h.clock.advance(1000)
    names.push(String(h.clock.now()))
    await h.lifecycle.upgrade('demo', await nextPlugin(h, { version: `${major}.0.0` }))
  }
  assert.deepEqual(await backupDirs(h.pluginsDir), names.slice(-3))
  assert.equal((await installedDirs(h.pluginsDir)).length, 5)
})

test('confirm grants exactly the permissions the preview showed', async (t) => {
  const h = await installed(t)
  await h.lifecycle.upgrade('demo', await nextPlugin(h, { permissions: ['memory.search', 'memory.record'] }))

  // The version is already unpacked; changing its manifest later must not widen what the owner approved.
  const [dir] = (await installedDirs(h.pluginsDir)).filter((name) => name.startsWith('2.0.0-'))
  assert.ok(dir !== undefined)
  const file = path.join(h.pluginsDir, '.installed', 'demo', dir, 'package.json')
  const pkg = JSON.parse(await readFile(file, 'utf8'))
  pkg.brain.permissions = ['memory.search', 'memory.record', 'agent.session']
  await writeFile(file, JSON.stringify(pkg))

  await h.lifecycle.confirm('demo')
  const [entry] = await h.lifecycle.list()
  assert.deepEqual(entry?.granted, ['memory.search', 'memory.record'])
})

test('a package whose id differs from the plugin being upgraded is rejected', async (t) => {
  const h = await installed(t)
  const source = await nextPlugin(h, { id: 'other' })
  let error: unknown
  try { await h.lifecycle.upgrade('demo', source) } catch (caught) { error = caught }
  throwsCode(error, 'INVALID_ARGUMENT')
  const [entry] = await h.lifecycle.list()
  assert.equal(entry?.version, '1.0.0')
  assert.equal((await installedDirs(h.pluginsDir)).length, 1)
  assert.deepEqual(await readdir(path.join(h.pluginsDir, '.installed')).catch(() => []), ['demo'])
})

test('a failed prepare leaves the running version untouched', async (t) => {
  const h = await installed(t)
  const source = await nextPlugin(h, { api: '^9' })
  await assert.rejects(h.lifecycle.upgrade('demo', source), /not compatible/)
  assert.equal(h.activator.enabled.get('demo')?.version, '1.0.0')
  assert.deepEqual(h.activator.calls.map((call) => call.op), ['enable'])
  assert.equal((await installedDirs(h.pluginsDir)).length, 1)
})

test('upgrading a disabled plugin leaves it disabled and never calls the activator', async (t) => {
  const h = await installed(t)
  await h.lifecycle.disable('demo')
  h.activator.calls.length = 0

  const preview = await h.lifecycle.upgrade('demo', await nextPlugin(h))
  assert.deepEqual(preview.newPermissions, [])
  assert.deepEqual(h.activator.calls, [])
  const [entry] = await h.lifecycle.list()
  assert.equal(entry?.version, '2.0.0')
  assert.equal(entry?.state, 'disabled')
  assert.equal(h.activator.enabled.has('demo'), false)
})

test('upgrading a failed plugin leaves it disabled and never calls the activator', async (t) => {
  const h = await installed(t)
  h.activator.failEnable = () => new Error('apply exploded')
  await assert.rejects(h.lifecycle.enable('demo'), /apply exploded/)
  assert.equal((await h.lifecycle.list())[0]?.state, 'failed')

  h.activator.failEnable = undefined
  h.activator.calls.length = 0
  await h.lifecycle.upgrade('demo', await nextPlugin(h))
  assert.deepEqual(h.activator.calls, [])
  const [entry] = await h.lifecycle.list()
  assert.equal(entry?.version, '2.0.0')
  assert.equal(entry?.state, 'disabled')
})

test('a pending plugin cannot be upgraded, and nothing changes', async (t) => {
  const h = await setup(t)
  const v1 = await makePlugin(path.join(h.root, 'v1'), { version: '1.0.0', permissions: ['memory.search'], manifest: { source: SOURCE } })
  await h.lifecycle.install(v1)
  h.activator.calls.length = 0

  let error: unknown
  try { await h.lifecycle.upgrade('demo', await nextPlugin(h)) } catch (caught) { error = caught }
  throwsCode(error, 'INVALID_ARGUMENT')
  const [entry] = await h.lifecycle.list()
  assert.deepEqual(entry, { id: 'demo', version: '1.0.0', state: 'pending', permissions: ['memory.search'], granted: [] })
  assert.equal((await installedDirs(h.pluginsDir)).length, 1)
  assert.deepEqual(h.activator.calls, [])
  const stored = JSON.parse(await readFile(path.join(h.pluginsDir, 'registry.json'), 'utf8'))
  assert.equal(stored.plugins.demo.pendingUpgrade, undefined)
})

test('a successful upgrade records the old version and clears the pending upgrade', async (t) => {
  const h = await installed(t)
  await h.lifecycle.upgrade('demo', await nextPlugin(h, { permissions: ['memory.search', 'memory.record'] }))
  let stored = JSON.parse(await readFile(path.join(h.pluginsDir, 'registry.json'), 'utf8'))
  assert.equal(stored.plugins.demo.pendingUpgrade.version, '2.0.0')

  await h.lifecycle.confirm('demo')
  stored = JSON.parse(await readFile(path.join(h.pluginsDir, 'registry.json'), 'utf8'))
  assert.equal(stored.plugins.demo.previous.version, '1.0.0')
  assert.match(String(stored.plugins.demo.previous.sha8), /^[0-9a-f]{8}$/)
  assert.equal(stored.plugins.demo.pendingUpgrade, undefined)
  const oldDir = (await installedDirs(h.pluginsDir)).find((name) => name.startsWith('1.0.0-'))
  assert.equal(`${stored.plugins.demo.previous.version}-${stored.plugins.demo.previous.sha8}`, oldDir)
})

test('a confirmed permission-growing upgrade that fails to enable restores granted and the old version', async (t) => {
  const h = await installed(t)
  await h.lifecycle.upgrade('demo', await nextPlugin(h, { permissions: ['memory.search', 'memory.record'] }))
  h.activator.failEnable = (plugin) => plugin.version === '2.0.0' ? new Error('apply exploded') : undefined
  h.activator.calls.length = 0

  await assert.rejects(h.lifecycle.confirm('demo'), /apply exploded/)

  const [entry] = await h.lifecycle.list()
  assert.deepEqual(entry, {
    id: 'demo', version: '1.0.0', state: 'enabled', permissions: ['memory.search'], granted: ['memory.search'],
  })
  assert.equal(h.activator.enabled.get('demo')?.version, '1.0.0')
  // disable the old, try the new, disable it, re-enable the old.
  assert.deepEqual(
    h.activator.calls.map((call) => `${call.op}:${call.version ?? call.id}`),
    ['disable:demo', 'enable:2.0.0', 'disable:demo', 'enable:1.0.0'],
  )
})

test('a failed upgrade of a disabled plugin rolls back without enabling it', async (t) => {
  const h = await installed(t)
  await h.lifecycle.disable('demo')
  h.activator.calls.length = 0
  const source = await nextPlugin(h, {
    manifest: { migrations: './migrations' },
    files: { 'migrations/001-broken.mjs': "export async function up() { throw new Error('migration failed') }\n" },
  })

  await assert.rejects(h.lifecycle.upgrade('demo', source), /migration failed/)

  assert.deepEqual(h.activator.calls, [])
  const [entry] = await h.lifecycle.list()
  assert.equal(entry?.version, '1.0.0')
  assert.equal(entry?.state, 'disabled')
})

test('reinstalling the same package during a pending upgrade keeps the unpacked copy', async (t) => {
  const h = await installed(t)
  const source = await nextPlugin(h, { permissions: ['memory.search', 'memory.record'] })
  await h.lifecycle.upgrade('demo', source)
  assert.equal((await installedDirs(h.pluginsDir)).length, 2)

  let error: unknown
  try { await h.lifecycle.install(source) } catch (caught) { error = caught }
  throwsCode(error, 'CONFLICT')
  assert.equal((await installedDirs(h.pluginsDir)).length, 2)

  await h.lifecycle.confirm('demo')
  const [entry] = await h.lifecycle.list()
  assert.equal(entry?.version, '2.0.0')
  assert.equal(entry?.state, 'enabled')
})

test('a failed downgrade keeps the reused previous version directory', async (t) => {
  const h = await installed(t)
  await h.lifecycle.upgrade('demo', await nextPlugin(h, { version: '2.0.0' }))
  let stored = JSON.parse(await readFile(path.join(h.pluginsDir, 'registry.json'), 'utf8'))
  assert.equal(stored.plugins.demo.previous.version, '1.0.0')
  const previousDir = `${stored.plugins.demo.previous.version}-${stored.plugins.demo.previous.sha8}`

  // Upgrading back to the contents of 1.0.0 reuses the directory `previous` points at.
  h.activator.failEnable = (plugin) => plugin.version === '1.0.0' ? new Error('downgrade failed') : undefined
  await assert.rejects(h.lifecycle.upgrade('demo', path.join(h.root, 'v1')), /downgrade failed/)

  assert.equal((await installedDirs(h.pluginsDir)).length, 2)
  await readFile(path.join(h.pluginsDir, '.installed', 'demo', previousDir, 'package.json'))
  const [entry] = await h.lifecycle.list()
  assert.equal(entry?.version, '2.0.0')
  assert.equal(entry?.state, 'enabled')
  stored = JSON.parse(await readFile(path.join(h.pluginsDir, 'registry.json'), 'utf8'))
  assert.equal(stored.plugins.demo.previous.version, '1.0.0')
})

test('a failed upgrade keeps a reused directory it did not create', async (t) => {
  const h = await installed(t)
  const source = await nextPlugin(h, {
    version: '2.0.0',
    manifest: { migrations: './migrations' },
    files: { 'migrations/001-broken.mjs': "export async function up() { throw new Error('migration failed') }\n" },
  })
  // Unpack the same contents ahead of time, as an earlier interrupted run would have.
  const other = await setup(t)
  await other.lifecycle.install(source)
  const [dir] = await installedDirs(other.pluginsDir)
  assert.ok(dir !== undefined)
  await cp(
    path.join(other.pluginsDir, '.installed', 'demo', dir),
    path.join(h.pluginsDir, '.installed', 'demo', dir),
    { recursive: true },
  )

  await assert.rejects(h.lifecycle.upgrade('demo', source), /migration failed/)

  assert.ok((await installedDirs(h.pluginsDir)).includes(dir))
  assert.equal((await h.lifecycle.list())[0]?.version, '1.0.0')
})

test('a migration file is imported again when the same upgrade is retried', async (t) => {
  const h = await installed(t)
  const marker = path.join(h.root, 'imports.log')
  const boom = path.join(h.root, 'boom')
  const previousMarker = process.env.PLUGIN_MARKER
  process.env.PLUGIN_MARKER = marker
  t.after(() => {
    if (previousMarker === undefined) delete process.env.PLUGIN_MARKER
    else process.env.PLUGIN_MARKER = previousMarker
  })
  await writeFile(boom, 'x')

  const migration = [
    "import { appendFileSync, existsSync } from 'node:fs'",
    'appendFileSync(process.env.PLUGIN_MARKER, "import\\n")',
    'export async function up() {',
    `  if (existsSync(${JSON.stringify(boom)})) throw new Error('boom')`,
    '}',
    '',
  ].join('\n')
  const source = await nextPlugin(h, {
    manifest: { migrations: './migrations' },
    files: { 'migrations/001-retry.mjs': migration },
  })

  await assert.rejects(h.lifecycle.upgrade('demo', source), /boom/)
  await unlink(boom)
  await h.lifecycle.upgrade('demo', source)

  // A failed rollback removes the unpacked copy, so the retry lands on the same path. The module body must run again.
  assert.deepEqual((await readFile(marker, 'utf8')).trim().split('\n'), ['import', 'import'])
  assert.equal((await h.lifecycle.list())[0]?.version, '2.0.0')
})

test('upgrading to the same contents twice reuses the directory without rebuilding it', async (t) => {
  const h = await installed(t)
  const source = await nextPlugin(h, { version: '2.0.0' })
  await h.lifecycle.upgrade('demo', source)
  const dir = (await installedDirs(h.pluginsDir)).find((name) => name.startsWith('2.0.0-'))
  assert.ok(dir !== undefined)
  const marker = path.join(h.pluginsDir, '.installed', 'demo', dir, 'marker.txt')
  await writeFile(marker, 'kept')

  await h.lifecycle.upgrade('demo', source)

  assert.equal(await readFile(marker, 'utf8'), 'kept')
  assert.equal((await installedDirs(h.pluginsDir)).length, 2)
  const [entry] = await h.lifecycle.list()
  assert.equal(entry?.version, '2.0.0')
})
