import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { makePlugin, setup, throwsCode } from './helpers.ts'

async function ready(t: Parameters<typeof setup>[0], files: Record<string, string> = {}) {
  const h = await setup(t)
  const source = await makePlugin(path.join(h.root, 'src'), { permissions: ['memory.search'], files })
  await h.lifecycle.install(source)
  await h.lifecycle.confirm('demo')
  await h.lifecycle.enable('demo')
  return { h, source }
}

test('uninstall with keepData keeps the private directory and backups', async (t) => {
  const { h } = await ready(t)
  await mkdir(path.join(h.pluginsDir, 'demo'), { recursive: true })
  await writeFile(path.join(h.pluginsDir, 'demo', 'note.txt'), 'keep me')
  await mkdir(path.join(h.pluginsDir, '.backups', 'demo', '1'), { recursive: true })

  await h.lifecycle.uninstall('demo', { keepData: true })
  assert.equal((await readdir(path.join(h.pluginsDir, 'demo'))).includes('note.txt'), true)
  assert.deepEqual(await readdir(path.join(h.pluginsDir, '.backups', 'demo')), ['1'])
  assert.deepEqual(await h.lifecycle.list(), [])
})

test('uninstall without keepData removes the private directory, backups and every installed version', async (t) => {
  const { h, source } = await ready(t)
  await mkdir(path.join(h.pluginsDir, 'demo'), { recursive: true })
  await writeFile(path.join(h.pluginsDir, 'demo', 'note.txt'), 'delete me')
  await h.lifecycle.upgrade('demo', await makePlugin(path.join(h.root, 'two'), { version: '2.0.0' }))
  void source
  assert.ok((await readdir(path.join(h.pluginsDir, '.backups', 'demo'))).length > 0)

  await h.lifecycle.uninstall('demo', { keepData: false })
  await assert.rejects(readdir(path.join(h.pluginsDir, 'demo')), { code: 'ENOENT' })
  await assert.rejects(readdir(path.join(h.pluginsDir, '.backups', 'demo')), { code: 'ENOENT' })
  await assert.rejects(readdir(path.join(h.pluginsDir, '.installed', 'demo')), { code: 'ENOENT' })
  assert.deepEqual(await h.lifecycle.list(), [])
})

test('uninstalling an enabled plugin disables it first', async (t) => {
  const { h } = await ready(t)
  h.activator.calls.length = 0
  await h.lifecycle.uninstall('demo', { keepData: false })
  assert.deepEqual(h.activator.calls.map((call) => call.op), ['disable'])
})

test('enable failures mark the plugin failed and a later enable can still succeed', async (t) => {
  const h = await setup(t)
  const source = await makePlugin(path.join(h.root, 'src'))
  await h.lifecycle.install(source)
  await h.lifecycle.confirm('demo')

  h.activator.failEnable = () => new Error('apply exploded')
  await assert.rejects(h.lifecycle.enable('demo'), /apply exploded/)
  const [failed] = await h.lifecycle.list()
  assert.equal(failed?.state, 'failed')

  h.activator.failEnable = undefined
  await h.lifecycle.enable('demo')
  const [enabled] = await h.lifecycle.list()
  assert.equal(enabled?.state, 'enabled')
})

test('a failed enable is persisted in registry.json', async (t) => {
  const h = await setup(t)
  const source = await makePlugin(path.join(h.root, 'src'))
  await h.lifecycle.install(source)
  await h.lifecycle.confirm('demo')
  h.activator.failEnable = () => new Error('nope')
  await assert.rejects(h.lifecycle.enable('demo'), /nope/)

  const stored = JSON.parse(await readFile(path.join(h.pluginsDir, 'registry.json'), 'utf8'))
  assert.equal(stored.plugins.demo.state, 'failed')
  const [entry] = await h.lifecycle.list()
  assert.equal(entry?.state, 'failed')
})

test('unknown ids and confirming twice are rejected', async (t) => {
  const h = await setup(t)
  for (const call of [
    () => h.lifecycle.confirm('ghost'),
    () => h.lifecycle.enable('ghost'),
    () => h.lifecycle.disable('ghost'),
    () => h.lifecycle.setConfig('ghost', {}),
    () => h.lifecycle.uninstall('ghost', { keepData: false }),
    () => h.lifecycle.upgrade('ghost', '/nowhere'),
  ]) {
    let error: unknown
    try { await call() } catch (caught) { error = caught }
    throwsCode(error, 'NOT_FOUND')
  }

  await h.lifecycle.install(await makePlugin(path.join(h.root, 'src')))
  await h.lifecycle.confirm('demo')
  let error: unknown
  try { await h.lifecycle.confirm('demo') } catch (caught) { error = caught }
  throwsCode(error, 'INVALID_ARGUMENT')
})

test('list is sorted by id and reports each plugin separately', async (t) => {
  const h = await setup(t)
  await h.lifecycle.install(await makePlugin(path.join(h.root, 'zulu'), { id: 'zulu' }))
  await h.lifecycle.install(await makePlugin(path.join(h.root, 'alpha'), { id: 'alpha' }))
  assert.deepEqual((await h.lifecycle.list()).map((entry) => entry.id), ['alpha', 'zulu'])
})
