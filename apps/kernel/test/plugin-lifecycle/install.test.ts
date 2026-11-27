import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, symlink, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { BrainError } from '@dsh-brain-core/sdk'
import { removeTree } from '@dsh-brain-core/satellite-host'
import { preparePackage } from '../../src/plugin-lifecycle/prepare.ts'
import { createLogger, createRunner, installedDirs, makePlugin, setup, throwsCode } from './helpers.ts'

test('a local plugin goes through install, confirm, enable, disable and uninstall', async (t) => {
  const h = await setup(t)
  h.warnings.push('core budget is tight')
  const permissions = ['memory.search', 'schedule.ownTime']
  const source = await makePlugin(path.join(h.root, 'src'), { permissions })

  const preview = await h.lifecycle.install(source)
  assert.deepEqual(preview, {
    id: 'demo', version: '1.0.0', permissions, newPermissions: permissions, warnings: ['core budget is tight'],
  })

  let [entry] = await h.lifecycle.list()
  assert.deepEqual(entry, { id: 'demo', version: '1.0.0', state: 'pending', permissions, granted: [] })

  let error: unknown
  try { await h.lifecycle.enable('demo') } catch (caught) { error = caught }
  throwsCode(error, 'PERMISSION_DENIED')

  await h.lifecycle.confirm('demo')
  ;[entry] = await h.lifecycle.list()
  assert.deepEqual(entry, { id: 'demo', version: '1.0.0', state: 'disabled', permissions, granted: permissions })

  await h.lifecycle.enable('demo')
  ;[entry] = await h.lifecycle.list()
  assert.equal(entry?.state, 'enabled')
  assert.deepEqual(h.activator.enabled.get('demo')?.config, {})

  await h.lifecycle.disable('demo')
  ;[entry] = await h.lifecycle.list()
  assert.equal(entry?.state, 'disabled')

  await h.lifecycle.uninstall('demo', { keepData: true })
  assert.deepEqual(await h.lifecycle.list(), [])
  assert.deepEqual(await installedDirs(h.pluginsDir), [])
  assert.deepEqual((await readdir(h.pluginsDir)).sort(), ['registry.json'])
})

test('the local copy skips node_modules and .git', async (t) => {
  const h = await setup(t)
  const source = await makePlugin(path.join(h.root, 'src'), {
    files: {
      'node_modules/marker.txt': 'copied',
      '.git/HEAD': 'ref: refs/heads/main',
      'lib/keep.txt': 'kept',
    },
  })
  await h.lifecycle.install(source)

  const [dir] = await installedDirs(h.pluginsDir)
  assert.ok(dir !== undefined)
  const installed = path.join(h.pluginsDir, '.installed', 'demo', dir)
  assert.equal(await readFile(path.join(installed, 'lib/keep.txt'), 'utf8'), 'kept')
  assert.deepEqual((await readdir(path.join(installed, 'node_modules'))).sort(), ['@dsh-brain-core'])
  await assert.rejects(readFile(path.join(installed, '.git/HEAD')), { code: 'ENOENT' })
})

test('different contents hash to different directories and two versions coexist', async (t) => {
  const h = await setup(t)
  const one = await makePlugin(path.join(h.root, 'one'), { mainSource: 'export function apply() {}\n' })
  await h.lifecycle.install(one)
  await h.lifecycle.confirm('demo')
  const two = await makePlugin(path.join(h.root, 'two'), { mainSource: 'export function apply() { /* changed */ }\n' })

  await h.lifecycle.upgrade('demo', two)
  const dirs = await installedDirs(h.pluginsDir)
  assert.equal(dirs.length, 2)
  const [first, second] = dirs
  assert.ok(first !== undefined && second !== undefined)
  assert.match(first, /^1\.0\.0-[0-9a-f]{8}$/)
  assert.match(second, /^1\.0\.0-[0-9a-f]{8}$/)
  assert.notEqual(first, second)
  const oldMain = await readFile(path.join(h.pluginsDir, '.installed', 'demo', first, 'main.js'), 'utf8')
  const newMain = await readFile(path.join(h.pluginsDir, '.installed', 'demo', second, 'main.js'), 'utf8')
  assert.deepEqual([oldMain, newMain].sort(), ['export function apply() { /* changed */ }\n', 'export function apply() {}\n'])
})

test('dependencies: @dsh-brain-core/* is stripped; npm runs only when other dependencies remain', async (t) => {
  const onlyKernel = await setup(t)
  const a = await makePlugin(path.join(onlyKernel.root, 'a'), {
    packageJson: { dependencies: { '@dsh-brain-core/sdk': 'workspace:*', '@dsh-brain-core/shared': 'workspace:*' } },
  })
  await onlyKernel.lifecycle.install(a)
  const [dirA] = await installedDirs(onlyKernel.pluginsDir)
  const pkgA = JSON.parse(await readFile(path.join(onlyKernel.pluginsDir, '.installed', 'demo', dirA ?? '', 'package.json'), 'utf8'))
  assert.equal(pkgA.dependencies, undefined)
  assert.equal(onlyKernel.runner.calls.filter((call) => call.command === 'npm').length, 0)

  const withOther = await setup(t)
  const b = await makePlugin(path.join(withOther.root, 'b'), {
    packageJson: { dependencies: { '@dsh-brain-core/sdk': 'workspace:*', lodash: '4.17.21' } },
  })
  await withOther.lifecycle.install(b)
  const [dirB] = await installedDirs(withOther.pluginsDir)
  const pkgB = JSON.parse(await readFile(path.join(withOther.pluginsDir, '.installed', 'demo', dirB ?? '', 'package.json'), 'utf8'))
  assert.deepEqual(pkgB.dependencies, { lodash: '4.17.21' })
  const install = withOther.runner.calls.find((call) => call.command === 'npm')
  assert.deepEqual(install?.args, ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'])
})

test('an npm or git address goes through npm pack --ignore-scripts and tar', async (t) => {
  const h = await setup(t)
  h.runner.packSource = await makePlugin(path.join(h.root, 'npm-src', 'package'))
  const preview = await h.lifecycle.install('github:someone/plugin')

  assert.equal(preview.id, 'demo')
  const pack = h.runner.calls.find((call) => call.command === 'npm')
  assert.equal(pack?.args[0], 'pack')
  assert.ok(pack?.args.includes('--ignore-scripts'))
  assert.ok(pack?.args.includes('--pack-destination'))
  assert.ok(pack?.args.includes('github:someone/plugin'))
  assert.deepEqual(h.runner.calls.filter((call) => call.command === 'tar').map((call) => call.args[0]), ['-xzf'])
  assert.equal((await installedDirs(h.pluginsDir)).length, 1)
})

test('a pyproject.toml triggers uv sync --no-dev', async (t) => {
  const python = await setup(t)
  const pythonSource = await makePlugin(path.join(python.root, 'python'), {
    files: { 'pyproject.toml': '[project]\nname = "demo"\n' },
  })
  await python.lifecycle.install(pythonSource)
  const uv = python.runner.calls.find((call) => call.command === 'uv')
  assert.deepEqual(uv?.args, ['sync', '--no-dev'])

  const plain = await setup(t)
  await plain.lifecycle.install(await makePlugin(path.join(plain.root, 'plain')))
  assert.equal(plain.runner.calls.filter((call) => call.command === 'uv').length, 0)
})

test('a manifest with several problems is rejected with every error and leaves nothing behind', async (t) => {
  const h = await setup(t)
  const source = await makePlugin(path.join(h.root, 'bad'), { packageJson: { brain: { id: 'Bad Id' } } })

  let error: unknown
  try { await h.lifecycle.install(source) } catch (caught) { error = caught }
  assert.ok(error instanceof BrainError)
  assert.equal(error.code, 'INVALID_ARGUMENT')
  const errors = error.details.errors as readonly { field: string }[]
  assert.ok(Array.isArray(errors))
  assert.ok(errors.length > 1, JSON.stringify(errors))
  assert.ok(errors.some((item) => item.field === 'id'))
  assert.ok(errors.some((item) => item.field === 'kinds'))
  assert.ok(errors.some((item) => item.field === 'api'))
  assert.deepEqual(await readdir(h.pluginsDir).catch(() => []), [])
  assert.deepEqual(await installedDirs(h.pluginsDir), [])
})

test('an incompatible api, a missing main field and a missing main file are rejected', async (t) => {
  const incompatible = await setup(t)
  await assert.rejects(
    incompatible.lifecycle.install(await makePlugin(path.join(incompatible.root, 'v2'), { api: '^2' })),
    (error: unknown) => { throwsCode(error, 'INVALID_ARGUMENT'); return true },
  )

  const previous = await setup(t)
  const accepted = await previous.lifecycle.install(await makePlugin(path.join(previous.root, 'v0'), { api: '^0' }))
  assert.equal(accepted.version, '1.0.0')

  const noMainField = await setup(t)
  await assert.rejects(
    noMainField.lifecycle.install(await makePlugin(path.join(noMainField.root, 'nomain'), { noMain: true })),
    (error: unknown) => { throwsCode(error, 'INVALID_ARGUMENT'); return true },
  )

  const noMainFile = await setup(t)
  const missing = await makePlugin(path.join(noMainFile.root, 'missing'))
  await unlink(path.join(missing, 'main.js'))
  await assert.rejects(
    noMainFile.lifecycle.install(missing),
    (error: unknown) => { throwsCode(error, 'INVALID_ARGUMENT'); return true },
  )

  const escapingMain = await setup(t)
  await assert.rejects(
    escapingMain.lifecycle.install(await makePlugin(path.join(escapingMain.root, 'escape'), { main: '../outside.js' })),
    (error: unknown) => {
      throwsCode(error, 'INVALID_ARGUMENT')
      assert.match((error as Error).message, /must point inside/)
      return true
    },
  )

  const escapingVersion = await setup(t)
  await assert.rejects(
    escapingVersion.lifecycle.install(await makePlugin(path.join(escapingVersion.root, 'version'), { version: '../evil' })),
    (error: unknown) => { throwsCode(error, 'INVALID_ARGUMENT'); return true },
  )
})

test('a process plugin needs no main entry', async (t) => {
  const h = await setup(t)
  const source = await makePlugin(path.join(h.root, 'py'), {
    runtime: 'process',
    noMain: true,
    manifest: { process: { command: 'python', args: ['plugin.py'] } },
  })
  const preview = await h.lifecycle.install(source)
  assert.equal(preview.id, 'demo')
  assert.equal((await installedDirs(h.pluginsDir)).length, 1)
})

test('installing the same id twice is a CONFLICT and keeps the first entry', async (t) => {
  const h = await setup(t)
  const first = await makePlugin(path.join(h.root, 'first'))
  await h.lifecycle.install(first)
  const second = await makePlugin(path.join(h.root, 'second'), { version: '2.0.0' })

  let error: unknown
  try { await h.lifecycle.install(second) } catch (caught) { error = caught }
  throwsCode(error, 'CONFLICT')
  const [entry] = await h.lifecycle.list()
  assert.equal(entry?.version, '1.0.0')
  assert.equal((await installedDirs(h.pluginsDir)).length, 1)
})

test('a main that points outside the package is rejected even when the target exists', async (t) => {
  const h = await setup(t)
  const outside = path.join(h.root, 'outside.js')
  await writeFile(outside, 'export function apply() {}\n')
  const source = await makePlugin(path.join(h.root, 'absolute'))
  const pkgFile = path.join(source, 'package.json')
  const pkg = JSON.parse(await readFile(pkgFile, 'utf8'))
  pkg.main = outside
  await writeFile(pkgFile, JSON.stringify(pkg))

  let error: unknown
  try { await h.lifecycle.install(source) } catch (caught) { error = caught }
  throwsCode(error, 'INVALID_ARGUMENT')
  assert.match((error as Error).message, /must point inside/)
  assert.deepEqual(await readdir(h.pluginsDir).catch(() => []), [])
})

test('a package containing a symlink is rejected and leaves nothing behind', async (t) => {
  const h = await setup(t)
  const outside = await makePlugin(path.join(h.root, 'outside'), { id: 'other' })
  const source = await makePlugin(path.join(h.root, 'linked'))
  await symlink(outside, path.join(source, 'link'), process.platform === 'win32' ? 'junction' : 'dir')

  let error: unknown
  try { await h.lifecycle.install(source) } catch (caught) { error = caught }
  throwsCode(error, 'INVALID_ARGUMENT')
  assert.equal((error as { details?: { file?: string } }).details?.file, 'link')
  assert.deepEqual(await readdir(h.pluginsDir).catch(() => []), [])
  assert.deepEqual(await installedDirs(h.pluginsDir), [])
})

test('a spec that starts with a dash is rejected before npm runs', async (t) => {
  const h = await setup(t)
  let error: unknown
  try { await h.lifecycle.install('--registry=http://example.test') } catch (caught) { error = caught }
  throwsCode(error, 'INVALID_ARGUMENT')
  assert.deepEqual(h.runner.calls, [])
  assert.deepEqual(await readdir(h.pluginsDir).catch(() => []), [])
})

test('npm pack that writes no archive fails as UNAVAILABLE and leaves nothing behind', async (t) => {
  const h = await setup(t)
  h.runner.packNoArchive = true
  let error: unknown
  try { await h.lifecycle.install('some-plugin@1.0.0') } catch (caught) { error = caught }
  throwsCode(error, 'UNAVAILABLE')
  assert.deepEqual(await readdir(h.pluginsDir).catch(() => []), [])
  assert.deepEqual(await installedDirs(h.pluginsDir), [])
})

test('a ./ path and a bare directory name are local and never call npm', async (t) => {
  const h = await setup(t)
  await makePlugin(path.join(h.root, 'local-plugin'), { id: 'local' })
  await makePlugin(path.join(h.root, 'bare-plugin'), { id: 'bare' })
  const cwd = process.cwd()
  process.chdir(h.root)
  try {
    await h.lifecycle.install('./local-plugin')
    await h.lifecycle.install('bare-plugin')
  } finally {
    process.chdir(cwd)
  }

  assert.deepEqual(h.runner.calls, [])
  assert.deepEqual((await h.lifecycle.list()).map((entry) => entry.id), ['bare', 'local'])
})

test('the same bytes under different file names hash to different directories', async (t) => {
  const h = await setup(t)
  await h.lifecycle.install(await makePlugin(path.join(h.root, 'one'), { files: { 'a.txt': 'same bytes' } }))
  await h.lifecycle.confirm('demo')
  await h.lifecycle.upgrade('demo', await makePlugin(path.join(h.root, 'two'), { files: { 'b.txt': 'same bytes' } }))

  const dirs = await installedDirs(h.pluginsDir)
  assert.equal(dirs.length, 2)
  assert.notEqual(dirs[0], dirs[1])
})

test('a failed post-install step removes the unpacked directory and the registry entry', async (t) => {
  const h = await setup(t)
  const source = await makePlugin(path.join(h.root, 'src'), {
    packageJson: { dependencies: { lodash: '4.17.21' } },
  })
  h.runner.before = (command, args) => {
    if (command === 'npm' && args[0] === 'install') throw new Error('network down')
  }
  await assert.rejects(h.lifecycle.install(source), /network down/)
  assert.deepEqual(await installedDirs(h.pluginsDir), [])
  assert.deepEqual(await readdir(h.pluginsDir).catch(() => []), [])
  assert.deepEqual(await h.lifecycle.list(), [])
})

test('links whitelisted @dsh-brain-core/chat-kit while stripping non-whitelisted internal @dsh-brain-core/* deps', async (t) => {
  const h = await setup(t)
  const source = await makePlugin(path.join(h.root, 'chatkit-plugin'), {
    packageJson: {
      dependencies: {
        '@dsh-brain-core/sdk': 'workspace:*',
        '@dsh-brain-core/chat-kit': 'workspace:*',
        '@dsh-brain-core/satellite-host': 'workspace:*',
        '@dsh-brain-core/shared': 'workspace:*',
      },
    },
  })

  await h.lifecycle.install(source)
  const [dir] = await installedDirs(h.pluginsDir)
  assert.ok(dir !== undefined)
  const installed = path.join(h.pluginsDir, '.installed', 'demo', dir)

  const pkg = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'))
  assert.equal(pkg.dependencies, undefined)

  const linkedPkgs = (await readdir(path.join(installed, 'node_modules', '@dsh-brain-core'))).sort()
  assert.deepEqual(linkedPkgs, ['chat-kit', 'sdk'])

  const chatKitLink = path.join(installed, 'node_modules', '@dsh-brain-core', 'chat-kit')
  assert.equal((await lstat(chatKitLink)).isSymbolicLink(), true)
  const expectedChatKit = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../packages/chat-kit'))
  assert.equal(await realpath(chatKitLink), expectedChatKit)
})

test('install and upgrade link chat-kit from an explicit package location outside the SDK tree', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-package-map-'))
  t.after(async () => { await removeTree(root) })
  const sdkDir = path.join(root, 'sdk-copy')
  const chatKitDir = path.join(root, 'separate-store', 'chat-kit')
  await mkdir(sdkDir, { recursive: true })
  await mkdir(chatKitDir, { recursive: true })
  const h = await setup(t, { sdkDir, brainPackages: { 'chat-kit': chatKitDir } })

  for (const version of ['1.0.0', '1.0.1']) {
    const source = await makePlugin(path.join(root, version), {
      version,
      packageJson: { dependencies: { '@dsh-brain-core/sdk': '^1', '@dsh-brain-core/chat-kit': '^1' } },
    })
    if (version === '1.0.0') {
      await h.lifecycle.install(source)
      await h.lifecycle.confirm('demo')
    } else {
      await h.lifecycle.upgrade('demo', source)
    }
    const dir = (await installedDirs(h.pluginsDir)).find((name) => name.startsWith(`${version}-`))
    assert.ok(dir !== undefined)
    const scope = path.join(h.pluginsDir, '.installed', 'demo', dir, 'node_modules', '@dsh-brain-core')
    assert.equal(await realpath(path.join(scope, 'sdk')), await realpath(sdkDir))
    assert.equal(await realpath(path.join(scope, 'chat-kit')), await realpath(chatKitDir))
  }
  assert.equal(h.runner.calls.length, 0, 'host-provided packages must not reach npm')
})

test('throws UNAVAILABLE and leaves no residue when whitelisted @dsh-brain-core/chat-kit target is missing', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-prepare-missing-'))
  t.after(async () => { await removeTree(root) })

  const customSdkDir = path.join(root, 'packages', 'sdk')
  await mkdir(customSdkDir, { recursive: true })
  const pluginsDir = path.join(root, 'plugins')
  const source = await makePlugin(path.join(root, 'src'), {
    packageJson: {
      dependencies: {
        '@dsh-brain-core/sdk': 'workspace:*',
        '@dsh-brain-core/chat-kit': 'workspace:*',
      },
    },
  })

  let error: unknown
  try {
    await preparePackage(
      {
        pluginsDir,
        sdkDir: customSdkDir,
        run: createRunner().run,
        log: createLogger(),
      },
      source,
    )
  } catch (caught) {
    error = caught
  }
  throwsCode(error, 'UNAVAILABLE')
  assert.deepEqual(await installedDirs(pluginsDir), [])
  assert.deepEqual((await readdir(pluginsDir).catch(() => [])).filter((n) => n.startsWith('.tmp-')), [])
})
