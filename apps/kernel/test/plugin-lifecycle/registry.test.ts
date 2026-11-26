import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { makePlugin, setup, throwsCode } from './helpers.ts'

async function prepareCorrupt(h: Awaited<ReturnType<typeof setup>>, contents: string): Promise<string> {
  const file = path.join(h.pluginsDir, 'registry.json')
  await mkdir(h.pluginsDir, { recursive: true })
  await writeFile(file, contents)
  return file
}

test('a registry that is not JSON throws UNAVAILABLE and is left untouched', async (t) => {
  const h = await setup(t)
  const file = await prepareCorrupt(h, '{not json')

  for (const call of [
    () => h.lifecycle.list(),
    () => h.lifecycle.install(path.join(h.root, 'src')),
    () => h.lifecycle.enable('demo'),
  ]) {
    let error: unknown
    try { await call() } catch (caught) { error = caught }
    throwsCode(error, 'UNAVAILABLE')
  }
  assert.equal(await readFile(file, 'utf8'), '{not json')
})

test('a registry with the wrong shape throws UNAVAILABLE and is left untouched', async (t) => {
  const h = await setup(t)
  const contents = '{"version":1,"plugins":{"demo":{"id":"demo","state":"enabled"}}}'
  const file = await prepareCorrupt(h, contents)

  let error: unknown
  try { await h.lifecycle.list() } catch (caught) { error = caught }
  throwsCode(error, 'UNAVAILABLE')
  assert.equal(await readFile(file, 'utf8'), contents)
})

test('a registry.json that cannot be read as a file throws instead of reading as empty', async (t) => {
  const h = await setup(t)
  const file = path.join(h.pluginsDir, 'registry.json')
  await mkdir(file, { recursive: true })

  await assert.rejects(h.lifecycle.list())
  await assert.rejects(h.lifecycle.install(path.join(h.root, 'src')))

  assert.equal((await stat(file)).isDirectory(), true)
  assert.deepEqual(await readdir(file), [])
})

test('an empty or missing registry reads as no plugins', async (t) => {
  const h = await setup(t)
  assert.deepEqual(await h.lifecycle.list(), [])
  await mkdir(h.pluginsDir, { recursive: true })
  await writeFile(path.join(h.pluginsDir, 'registry.json'), '{"version":1,"plugins":{}}')
  assert.deepEqual(await h.lifecycle.list(), [])
})

test('registry.json keeps entries sorted by id', async (t) => {
  const h = await setup(t)
  await h.lifecycle.install(await makePlugin(path.join(h.root, 'zulu'), { id: 'zulu' }))
  await h.lifecycle.install(await makePlugin(path.join(h.root, 'alpha'), { id: 'alpha' }))
  const stored = JSON.parse(await readFile(path.join(h.pluginsDir, 'registry.json'), 'utf8'))
  assert.deepEqual(Object.keys(stored.plugins), ['alpha', 'zulu'])
})
