import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { makePlugin, setup, throwsCode } from './helpers.ts'

function migrations(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([name, body]) => [`migrations/${name}`, body]))
}

function migration(body: string): string {
  return `export async function up({ storage }) { ${body} }\n`
}

async function install(h: Awaited<ReturnType<typeof setup>>, files: Record<string, string>) {
  const source = await makePlugin(path.join(h.root, 'src'), { manifest: { migrations: './migrations' }, files })
  await h.lifecycle.install(source)
}

test('confirm runs migrations in order and writes schema-version after each', async (t) => {
  const h = await setup(t)
  await install(h, migrations({
    '001-first.mjs': migration("await storage.write('log', '1')"),
    '002-second.mjs': migration("await storage.write('log', '2')"),
    '003-third.mjs': migration("await storage.write('log', '3')"),
  }))
  await h.lifecycle.confirm('demo')

  assert.deepEqual(h.storages.get('demo')?.writes.map((write) => write.data), ['1', '2', '3'])
  assert.equal(await readFile(path.join(h.pluginsDir, 'demo', 'schema-version'), 'utf8'), '3\n')
})

test('only migrations above the stored schema-version run', async (t) => {
  const h = await setup(t)
  await install(h, migrations({
    '001-first.mjs': migration("await storage.write('log', '1')"),
    '002-second.mjs': migration("await storage.write('log', '2')"),
    '003-third.mjs': migration("await storage.write('log', '3')"),
  }))
  await mkdir(path.join(h.pluginsDir, 'demo'), { recursive: true })
  await writeFile(path.join(h.pluginsDir, 'demo', 'schema-version'), '1\n')
  await h.lifecycle.confirm('demo')

  assert.deepEqual(h.storages.get('demo')?.writes.map((write) => write.data), ['2', '3'])
  assert.equal(await readFile(path.join(h.pluginsDir, 'demo', 'schema-version'), 'utf8'), '3\n')
})

test('every migration that finishes bumps schema-version, even when a later one fails', async (t) => {
  const h = await setup(t)
  await install(h, migrations({
    '001-first.mjs': migration("await storage.write('log', '1')"),
    '002-broken.mjs': "export async function up() { throw new Error('boom') }\n",
  }))
  await assert.rejects(h.lifecycle.confirm('demo'), /boom/)
  assert.equal(await readFile(path.join(h.pluginsDir, 'demo', 'schema-version'), 'utf8'), '1\n')
})

test('a malformed migration file name is rejected', async (t) => {
  const h = await setup(t)
  await install(h, migrations({ '1-short.mjs': migration('') }))
  let error: unknown
  try { await h.lifecycle.confirm('demo') } catch (caught) { error = caught }
  throwsCode(error, 'INVALID_ARGUMENT')
})

test('two migration files with the same number are rejected', async (t) => {
  const h = await setup(t)
  await install(h, migrations({ '001-a.mjs': migration(''), '001-b.mjs': migration('') }))
  let error: unknown
  try { await h.lifecycle.confirm('demo') } catch (caught) { error = caught }
  throwsCode(error, 'INVALID_ARGUMENT')
})

test('a migration without an up export is rejected', async (t) => {
  const h = await setup(t)
  await install(h, migrations({ '001-empty.mjs': 'export const nothing = 1\n' }))
  let error: unknown
  try { await h.lifecycle.confirm('demo') } catch (caught) { error = caught }
  throwsCode(error, 'INVALID_ARGUMENT')
})

test('a declared migrations directory that is missing is rejected', async (t) => {
  const h = await setup(t)
  const source = await makePlugin(path.join(h.root, 'src'), { manifest: { migrations: './migrations' } })
  await h.lifecycle.install(source)
  let error: unknown
  try { await h.lifecycle.confirm('demo') } catch (caught) { error = caught }
  throwsCode(error, 'INVALID_ARGUMENT')
})

test('a schema-version file that is not an integer is rejected', async (t) => {
  const h = await setup(t)
  await install(h, migrations({ '001-first.mjs': migration('') }))
  await mkdir(path.join(h.pluginsDir, 'demo'), { recursive: true })
  await writeFile(path.join(h.pluginsDir, 'demo', 'schema-version'), 'one\n')
  let error: unknown
  try { await h.lifecycle.confirm('demo') } catch (caught) { error = caught }
  throwsCode(error, 'INVALID_ARGUMENT')
})
