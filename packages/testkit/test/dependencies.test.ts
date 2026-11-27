import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIR = path.join(PACKAGE_DIR, 'src')

async function sources(dir: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await sources(full))
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(full)
  }
  return files
}

test('the package depends only on the SDK inside the workspace and imports no forbidden code', async () => {
  const manifest = JSON.parse(await readFile(path.join(PACKAGE_DIR, 'package.json'), 'utf8')) as {
    readonly dependencies?: Readonly<Record<string, string>>
  }
  const dependencies = Object.keys(manifest.dependencies ?? {})
  const workspace = dependencies.filter((name) => name.startsWith('@dsh-brain-core/'))
  assert.deepEqual(workspace, ['@dsh-brain-core/sdk'])

  const files = await sources(SRC_DIR)
  assert.ok(files.length > 0)
  const forbidden = ['@deepseek-ai/', 'cordis', 'apps/kernel']
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    for (const needle of forbidden) {
      assert.equal(text.includes(needle), false, `${path.relative(PACKAGE_DIR, file)} mentions ${needle}`)
    }
  }
})

test('the package exports the documented surface', async () => {
  const kit = await import('../src/index.ts')
  for (const name of [
    'createTestKernel', 'createFakeChannel', 'FakeDeepSeek', 'scriptedTools',
    'runPluginContractTests', 'runConsistencyCases',
  ]) {
    assert.equal(typeof (kit as Record<string, unknown>)[name], 'function', `missing ${name}`)
  }
})
