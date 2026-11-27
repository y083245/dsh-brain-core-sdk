import assert from 'node:assert/strict'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { BrainError } from '@dsh-brain-core/sdk'
import { loadNodeEntry } from '../../src/plugin-lifecycle/index.ts'
import { brainManifest, installedDirs, makePlugin, setup, throwsCode } from './helpers.ts'

async function entryDir(h: Awaited<ReturnType<typeof setup>>): Promise<string> {
  const [dir] = await installedDirs(h.pluginsDir)
  assert.ok(dir !== undefined)
  return path.join(h.pluginsDir, '.installed', 'demo', dir)
}

test('loadNodeEntry returns the plugin apply and the linked SDK is the kernel SDK', async (t) => {
  const h = await setup(t)
  const source = await makePlugin(path.join(h.root, 'src'), {
    mainSource: [
      "import { BrainError } from '@dsh-brain-core/sdk'",
      'export function apply() { return BrainError }',
      '',
    ].join('\n'),
  })
  await h.lifecycle.install(source)

  const apply = await loadNodeEntry({ manifest: brainManifest(), version: '1.0.0', dir: await entryDir(h), granted: [], config: {} })
  const fromPlugin = (apply as unknown as () => typeof BrainError)()
  assert.equal(fromPlugin, BrainError)
  assert.ok(new fromPlugin('INVALID_ARGUMENT', 'x') instanceof BrainError)
})

test('a main module without apply is rejected', async (t) => {
  const h = await setup(t)
  await h.lifecycle.install(await makePlugin(path.join(h.root, 'src'), { mainSource: 'export const nothing = 1\n' }))
  let error: unknown
  try {
    await loadNodeEntry({ manifest: brainManifest(), version: '1.0.0', dir: await entryDir(h), granted: [], config: {} })
  } catch (caught) { error = caught }
  throwsCode(error, 'INVALID_ARGUMENT')
})

test('a main outside the plugin directory is rejected even when the target exists', async (t) => {
  const h = await setup(t)
  await h.lifecycle.install(await makePlugin(path.join(h.root, 'src')))
  const dir = await entryDir(h)
  await writeFile(path.join(h.root, 'outside.js'), 'export function apply() {}\n')
  // Also place a real file just outside the version directory, at `<plugin dir>/outside.js`.
  await writeFile(path.join(dir, '..', 'outside.js'), 'export function apply() {}\n')
  const pkgFile = path.join(dir, 'package.json')
  const pkg = JSON.parse(await readFile(pkgFile, 'utf8'))

  for (const main of [path.join(h.root, 'outside.js'), '../outside.js']) {
    pkg.main = main
    await writeFile(pkgFile, JSON.stringify(pkg))
    let error: unknown
    try {
      await loadNodeEntry({ manifest: brainManifest(), version: '1.0.0', dir, granted: [], config: {} })
    } catch (caught) { error = caught }
    throwsCode(error, 'INVALID_ARGUMENT')
    assert.match((error as Error).message, /must point inside/)
  }
})

test('a plugin directory whose main file is gone is rejected', async (t) => {
  const h = await setup(t)
  await h.lifecycle.install(await makePlugin(path.join(h.root, 'src')))
  const dir = await entryDir(h)
  await unlink(path.join(dir, 'main.js'))
  let error: unknown
  try {
    await loadNodeEntry({ manifest: brainManifest(), version: '1.0.0', dir, granted: [], config: {} })
  } catch (caught) { error = caught }
  throwsCode(error, 'INVALID_ARGUMENT')
})
