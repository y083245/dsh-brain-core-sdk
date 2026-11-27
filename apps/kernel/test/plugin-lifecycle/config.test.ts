import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { makePlugin, setup, throwsCode } from './helpers.ts'

const CONFIG_MODULE = [
  "import { Schema } from '@dsh-brain-core/sdk'",
  'export default Schema.object({',
  "  name: Schema.string().default('anon'),",
  '  count: Schema.number().default(1),',
  '})',
  '',
].join('\n')

async function withConfig(t: Parameters<typeof setup>[0]) {
  const h = await setup(t)
  const source = await makePlugin(path.join(h.root, 'src'), {
    manifest: { config: './config.mjs' },
    files: { 'config.mjs': CONFIG_MODULE },
  })
  await h.lifecycle.install(source)
  await h.lifecycle.confirm('demo')
  return h
}

test('a missing config.json validates to the schema defaults', async (t) => {
  const h = await withConfig(t)
  await h.lifecycle.enable('demo')
  assert.deepEqual(h.activator.enabled.get('demo')?.config, { name: 'anon', count: 1 })
})

test('an existing config.json is completed with defaults', async (t) => {
  const h = await withConfig(t)
  await mkdir(path.join(h.pluginsDir, 'demo'), { recursive: true })
  await writeFile(path.join(h.pluginsDir, 'demo', 'config.json'), '{"name":"bob"}')
  await h.lifecycle.enable('demo')
  assert.deepEqual(h.activator.enabled.get('demo')?.config, { name: 'bob', count: 1 })
})

test('an invalid config.json stops enable and marks the plugin failed', async (t) => {
  const h = await withConfig(t)
  await mkdir(path.join(h.pluginsDir, 'demo'), { recursive: true })
  await writeFile(path.join(h.pluginsDir, 'demo', 'config.json'), '{"count":"many"}')

  let error: unknown
  try { await h.lifecycle.enable('demo') } catch (caught) { error = caught }
  throwsCode(error, 'INVALID_ARGUMENT')
  assert.equal((await h.lifecycle.list())[0]?.state, 'failed')
  assert.equal(h.activator.enabled.has('demo'), false)
})

test('config.json that is not JSON is rejected', async (t) => {
  const h = await withConfig(t)
  await mkdir(path.join(h.pluginsDir, 'demo'), { recursive: true })
  await writeFile(path.join(h.pluginsDir, 'demo', 'config.json'), 'not json')
  let error: unknown
  try { await h.lifecycle.enable('demo') } catch (caught) { error = caught }
  throwsCode(error, 'INVALID_ARGUMENT')
})

test('a config module that cannot be imported is rejected', async (t) => {
  const h = await setup(t)
  await h.lifecycle.install(await makePlugin(path.join(h.root, 'src'), { manifest: { config: './config.mjs' } }))
  await h.lifecycle.confirm('demo')
  let error: unknown
  try { await h.lifecycle.enable('demo') } catch (caught) { error = caught }
  throwsCode(error, 'INVALID_ARGUMENT')
})

test('setConfig validates, writes and restarts an enabled plugin once', async (t) => {
  const h = await withConfig(t)
  await h.lifecycle.enable('demo')
  h.activator.calls.length = 0

  await h.lifecycle.setConfig('demo', { name: 'bob' })

  assert.deepEqual(h.activator.calls.map((call) => call.op), ['disable', 'enable'])
  assert.deepEqual(h.activator.enabled.get('demo')?.config, { name: 'bob', count: 1 })
  const stored = JSON.parse(await readFile(path.join(h.pluginsDir, 'demo', 'config.json'), 'utf8'))
  assert.deepEqual(stored, { name: 'bob', count: 1 })
})

test('setConfig validates and does not restart a disabled plugin', async (t) => {
  const h = await withConfig(t)
  await h.lifecycle.setConfig('demo', { name: 'bob' })
  assert.deepEqual(h.activator.calls, [])
  const stored = JSON.parse(await readFile(path.join(h.pluginsDir, 'demo', 'config.json'), 'utf8'))
  assert.deepEqual(stored, { name: 'bob', count: 1 })
})

test('setConfig on a pending plugin is denied before the config module runs', async (t) => {
  const h = await setup(t)
  const marker = path.join(h.root, 'config-imported')
  const configModule = [
    "import { writeFileSync } from 'node:fs'",
    "import { Schema } from '@dsh-brain-core/sdk'",
    `writeFileSync(${JSON.stringify(marker)}, 'ran')`,
    "export default Schema.object({ name: Schema.string().default('anon') })",
    '',
  ].join('\n')
  await h.lifecycle.install(await makePlugin(path.join(h.root, 'src'), {
    manifest: { config: './config.mjs' },
    files: { 'config.mjs': configModule },
  }))

  let error: unknown
  try { await h.lifecycle.setConfig('demo', { name: 'bob' }) } catch (caught) { error = caught }
  throwsCode(error, 'PERMISSION_DENIED')
  await assert.rejects(readFile(marker), { code: 'ENOENT' })
  await assert.rejects(readFile(path.join(h.pluginsDir, 'demo', 'config.json')), { code: 'ENOENT' })
})

test('a config module whose default export is not a function is rejected', async (t) => {
  const h = await setup(t)
  await h.lifecycle.install(await makePlugin(path.join(h.root, 'src'), {
    manifest: { config: './config.mjs' },
    files: { 'config.mjs': 'export default 42\n' },
  }))
  await h.lifecycle.confirm('demo')

  let error: unknown
  try { await h.lifecycle.enable('demo') } catch (caught) { error = caught }
  throwsCode(error, 'INVALID_ARGUMENT')

  error = undefined
  try { await h.lifecycle.setConfig('demo', {}) } catch (caught) { error = caught }
  throwsCode(error, 'INVALID_ARGUMENT')
})

test('an invalid setConfig value changes neither the file nor the running plugin', async (t) => {
  const h = await withConfig(t)
  await h.lifecycle.enable('demo')
  h.activator.calls.length = 0

  let error: unknown
  try { await h.lifecycle.setConfig('demo', { count: 'many' }) } catch (caught) { error = caught }
  throwsCode(error, 'INVALID_ARGUMENT')
  assert.deepEqual(h.activator.calls, [])
  await assert.rejects(readFile(path.join(h.pluginsDir, 'demo', 'config.json')), { code: 'ENOENT' })
})

test('a manifest without config always gets an empty object', async (t) => {
  const h = await setup(t)
  await h.lifecycle.install(await makePlugin(path.join(h.root, 'src')))
  await h.lifecycle.confirm('demo')
  await h.lifecycle.setConfig('demo', { ignored: true })
  assert.deepEqual(JSON.parse(await readFile(path.join(h.pluginsDir, 'demo', 'config.json'), 'utf8')), {})
  await h.lifecycle.enable('demo')
  assert.deepEqual(h.activator.enabled.get('demo')?.config, {})
})
