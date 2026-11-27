import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { validateManifest, type Envelope } from '@dsh-brain-core/sdk'
import { runConsistencyCases, type ConsistencyTarget } from '@dsh-brain-core/testkit'
import { TOKEN, setup } from './helpers.ts'

const ID = 'consistency'
type InMemoryApply = Parameters<ConsistencyTarget['loadPlugin']>[0]['apply']

test('the real kernel answers the testkit consistency cases like the fake one', async (t) => {
  const h = await setup(t)
  const globalKey = '__brainAssemblyConsistencyApply'
  const target: ConsistencyTarget = {
    async loadPlugin(plugin: { readonly apply: InMemoryApply }, manifest: unknown, options) {
      const validated = validateManifest(manifest)
      assert.equal(validated.ok, true)
      const dir = path.join(h.home, 'consistency-package')
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'package.json'), JSON.stringify({
        name: 'brain-plugin-consistency', version: '1.0.0', type: 'module', main: 'index.js', brain: manifest,
      }))
      // The in-memory apply is handed to the module in this process; the kernel still loads it through
      // the same loadEntry path a real plugin takes.
      await writeFile(path.join(dir, 'index.js'), `export async function apply(ctx, config) {\n  return await globalThis.${globalKey}(ctx, config)\n}\n`)
      ;(globalThis as Record<string, unknown>)[globalKey] = plugin.apply
      await h.kernel.runtime.enable({
        manifest: validated.manifest,
        version: '1.0.0',
        dir,
        granted: [...(options?.granted ?? validated.manifest.permissions)],
        config: options?.config ?? {},
      })
    },
    async http(method: string, route: string, body?: unknown): Promise<Envelope<unknown>> {
      const response = await fetch(`http://127.0.0.1:${h.kernel.port}${route}`, {
        method,
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      return await response.json() as Envelope<unknown>
    },
    async unload() {
      await h.kernel.runtime.disable(ID)
      delete (globalThis as Record<string, unknown>)[globalKey]
    },
  }

  const results = await runConsistencyCases(async () => target)
  const failed = results.filter((result) => !result.ok)
  assert.deepEqual(failed, [], JSON.stringify(failed, null, 2))
})
