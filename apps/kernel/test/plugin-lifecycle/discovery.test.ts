import assert from 'node:assert/strict'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { removeTree } from '@dsh-brain-core/satellite-host'
import {
  defaultWorkspacePluginsDir,
  discoverWorkspacePlugins,
  resolveWorkspacePluginsDir,
} from '../../src/plugin-lifecycle/index.ts'
import { preparePackage } from '../../src/plugin-lifecycle/prepare.ts'
import { createLogger, createRunner, makePlugin, SDK_DIR } from './helpers.ts'

test('resolveWorkspacePluginsDir respects explicit null, explicit path, env, and default', () => {
  assert.equal(resolveWorkspacePluginsDir({ workspacePluginsDir: null, env: { BRAIN_PLUGINS_DIR: '/tmp/x' }, sdkDir: SDK_DIR }), undefined)
  assert.equal(resolveWorkspacePluginsDir({ workspacePluginsDir: '   ', env: { BRAIN_PLUGINS_DIR: '/tmp/x' }, sdkDir: SDK_DIR }), undefined)
  assert.equal(
    resolveWorkspacePluginsDir({ workspacePluginsDir: './custom-plugins', env: {}, sdkDir: SDK_DIR }),
    path.resolve('./custom-plugins'),
  )
  assert.equal(
    resolveWorkspacePluginsDir({ env: { BRAIN_PLUGINS_DIR: '/tmp/ws-plugins' }, sdkDir: SDK_DIR }),
    path.resolve('/tmp/ws-plugins'),
  )
  assert.equal(
    resolveWorkspacePluginsDir({ env: { BRAIN_PLUGINS_DIR: '  ' }, sdkDir: SDK_DIR }),
    undefined,
  )
  assert.equal(
    resolveWorkspacePluginsDir({ env: {}, sdkDir: SDK_DIR }),
    defaultWorkspacePluginsDir(SDK_DIR),
  )
})

test('discoverWorkspacePlugins returns empty array when rootDir does not exist', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brain-disc-missing-'))
  t.after(async () => { await removeTree(root) })

  const found = await discoverWorkspacePlugins(path.join(root, 'does-not-exist'))
  assert.deepEqual(found, [])
})

test('discoverWorkspacePlugins finds all 5 real workspace plugins and skips samples/', async () => {
  const realPluginsDir = defaultWorkspacePluginsDir(SDK_DIR)
  const warnings: { readonly event: string; readonly plugin?: string }[] = []
  const found = await discoverWorkspacePlugins(realPluginsDir, {
    log: {
      info: () => undefined,
      warn: (event, fields) => { warnings.push({ event, ...(fields?.plugin === undefined ? {} : { plugin: fields.plugin }) }) },
      error: () => undefined,
    },
  })

  assert.deepEqual(
    found.map((item) => item.id),
    ['console-chat', 'memory-provider-sample', 'memory-vector', 'qq', 'web-reader'],
  )
  assert.deepEqual(warnings, [])
})

test('discoverWorkspacePlugins validates node and process plugins, skips non-plugins/symlinks/invalid dirs, and deduplicates ids', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brain-disc-'))
  t.after(async () => { await removeTree(root) })
  const wsDir = path.join(root, 'plugins')
  await mkdir(wsDir, { recursive: true })

  // Valid node plugin with symlink inside node_modules (allowed, skipped like copyPackage)
  const nodeDir = await makePlugin(path.join(wsDir, 'alpha-node'), {
    id: 'alpha-node',
    version: '1.2.3',
    runtime: 'node',
  })
  await mkdir(path.join(nodeDir, 'node_modules', '@dsh-brain-core'), { recursive: true })
  await symlink(SDK_DIR, path.join(nodeDir, 'node_modules', '@dsh-brain-core', 'sdk'))

  // Valid process plugin (no main required)
  await makePlugin(path.join(wsDir, 'beta-proc'), {
    id: 'beta-proc',
    version: '0.2.0',
    runtime: 'process',
    noMain: true,
    manifest: { process: { command: 'node', args: ['worker.js'] } },
    files: { 'worker.js': 'console.log("ok")\n' },
  })

  // Ignored dirs: dotdir, node_modules, regular file, symlink dir, dir without package.json, dir without brain field
  await makePlugin(path.join(wsDir, '.hidden'), { id: 'hidden' })
  await makePlugin(path.join(wsDir, 'node_modules'), { id: 'nm' })
  await writeFile(path.join(wsDir, 'README.md'), '# hello\n')
  await symlink(nodeDir, path.join(wsDir, 'link-plugin'))
  await mkdir(path.join(wsDir, 'samples', 'python-echo'), { recursive: true })
  await mkdir(path.join(wsDir, 'plain-pkg'), { recursive: true })
  await writeFile(path.join(wsDir, 'plain-pkg', 'package.json'), JSON.stringify({ name: 'plain', version: '1.0.0' }))

  // Invalid dirs: symlink outside node_modules, malformed JSON, missing main, incompatible api
  const symPlugin = await makePlugin(path.join(wsDir, 'bad-symlink'), { id: 'bad-symlink' })
  await symlink(path.join(nodeDir, 'main.js'), path.join(symPlugin, 'evil.js'))

  await mkdir(path.join(wsDir, 'bad-json'), { recursive: true })
  await writeFile(path.join(wsDir, 'bad-json', 'package.json'), '{not-json')

  await makePlugin(path.join(wsDir, 'bad-missing-main'), {
    id: 'bad-missing-main',
    main: 'missing.js',
    noMain: true,
    packageJson: { main: 'missing.js' },
  })

  await makePlugin(path.join(wsDir, 'bad-api'), {
    id: 'bad-api',
    api: '^99.0.0',
  })

  // Duplicate id: sorted dirName order means 'dup-1' wins over 'dup-2'
  await makePlugin(path.join(wsDir, 'dup-1'), { id: 'dup-plugin', version: '1.0.0' })
  await makePlugin(path.join(wsDir, 'dup-2'), { id: 'dup-plugin', version: '2.0.0' })

  const warnings: { readonly event: string; readonly plugin?: string }[] = []
  const found = await discoverWorkspacePlugins(wsDir, {
    log: {
      info: () => undefined,
      warn: (event, fields) => { warnings.push({ event, ...(fields?.plugin === undefined ? {} : { plugin: fields.plugin }) }) },
      error: () => undefined,
    },
  })

  assert.deepEqual(
    found.map((item) => ({ id: item.id, dirName: item.dirName, version: item.version })),
    [
      { id: 'alpha-node', dirName: 'alpha-node', version: '1.2.3' },
      { id: 'beta-proc', dirName: 'beta-proc', version: '0.2.0' },
      { id: 'dup-plugin', dirName: 'dup-1', version: '1.0.0' },
    ],
  )
  assert.deepEqual(warnings, [
    { event: 'plugin.discovery.invalid', plugin: 'bad-api' },
    { event: 'plugin.discovery.invalid', plugin: 'bad-json' },
    { event: 'plugin.discovery.invalid', plugin: 'bad-missing-main' },
    { event: 'plugin.discovery.invalid', plugin: 'bad-symlink' },
    { event: 'plugin.discovery.duplicate_id', plugin: 'dup-plugin' },
  ])
})

test('discoverWorkspacePlugins sha8 matches preparePackage sha8 bit-for-bit', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brain-disc-hash-'))
  t.after(async () => { await removeTree(root) })

  const wsDir = path.join(root, 'plugins')
  const installDir = path.join(root, 'installed')
  const srcDir = await makePlugin(path.join(wsDir, 'parity'), {
    id: 'parity',
    version: '1.0.0',
    files: {
      'lib/helper.js': 'export const value = 42\n',
      'node_modules/ignored/index.js': 'export const ignored = true\n',
      '.git/HEAD': 'ref: refs/heads/main\n',
    },
  })

  const [discovered] = await discoverWorkspacePlugins(wsDir)
  assert.ok(discovered !== undefined)

  const runner = createRunner()
  const prepared = await preparePackage(
    { pluginsDir: installDir, sdkDir: SDK_DIR, run: runner.run, log: createLogger() },
    srcDir,
  )

  assert.equal(discovered.sha8, prepared.sha8)
  assert.equal(discovered.version, prepared.version)
})
