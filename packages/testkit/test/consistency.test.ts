import assert from 'node:assert/strict'
import test from 'node:test'
import { createTestKernel } from '../src/index.ts'
import { runConsistencyCases } from '../src/consistency.ts'

test('runConsistencyCases passes against the fake kernel', async () => {
  const results = await runConsistencyCases(async () => createTestKernel())
  assert.deepEqual(results.map((result) => result.name), [
    'consistency:ungranted-permission',
    'consistency:foreign-channel',
    'consistency:l3-write',
    'consistency:route-success',
    'consistency:route-failure',
  ])
  for (const result of results) assert.equal(result.ok, true, `${result.name}: ${result.message}`)
})

test('a target that lets an ungranted call through fails its case', async () => {
  const kernel = createTestKernel()
  const permissive = {
    loadPlugin: async (plugin: { readonly apply: (ctx: never, config: Readonly<Record<string, unknown>>) => void | Promise<void> }, manifest: unknown) => {
      const target = kernel as unknown as { loadPlugin: (p: typeof plugin, m: unknown, o?: unknown) => Promise<void> }
      // Grant everything the manifest declares instead of the subset the cases ask for.
      return target.loadPlugin(plugin, manifest)
    },
    http: (method: string, path: string, body?: unknown) => kernel.http(method, path, body),
    unload: () => kernel.unload(),
  }
  const results = await runConsistencyCases(async () => permissive)
  const ungranted = results.find((result) => result.name === 'consistency:ungranted-permission')
  assert.ok(ungranted !== undefined)
  assert.equal(ungranted.ok, false)
})
