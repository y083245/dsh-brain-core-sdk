import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { availableOfficialPlugins, OFFICIAL_PLUGINS } from '../../web/src/pages/seals/officialPlugins.ts'

test('the four official plugins have unique IDs and documented npm next specs', async () => {
  assert.equal(OFFICIAL_PLUGINS.length, 4)
  assert.deepEqual(OFFICIAL_PLUGINS.map((plugin) => plugin.id), ['console-chat', 'qq', 'web-reader', 'memory-vector'])
  assert.equal(new Set(OFFICIAL_PLUGINS.map((plugin) => plugin.id)).size, 4)
  const readme = await readFile(new URL('../../../../README.md', import.meta.url), 'utf8')
  for (const plugin of OFFICIAL_PLUGINS) {
    assert.match(plugin.spec, /^@dsh-brain-core\/plugin-[a-z-]+@next$/)
    assert.equal(plugin.spec, `@dsh-brain-core/plugin-${plugin.id}@next`)
    assert.ok(readme.includes(`\`${plugin.spec}\``))
    assert.ok(plugin.title && plugin.kind && plugin.summary)
  }
})

test('official shortcuts exclude installed IDs, preserve order and leave the catalog intact', () => {
  assert.deepEqual(availableOfficialPlugins(), OFFICIAL_PLUGINS)
  assert.deepEqual(availableOfficialPlugins(new Set()), OFFICIAL_PLUGINS)
  const installed = new Set(['qq', 'console-chat', 'third-party'])
  assert.deepEqual(availableOfficialPlugins(installed).map((plugin) => plugin.id), ['web-reader', 'memory-vector'])
  assert.deepEqual([...installed], ['qq', 'console-chat', 'third-party'])
  assert.deepEqual(availableOfficialPlugins(new Set(OFFICIAL_PLUGINS.map((plugin) => plugin.id))), [])
  assert.equal(OFFICIAL_PLUGINS.length, 4)
})
