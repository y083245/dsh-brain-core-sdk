import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { encodeSessionId, removeTree } from '@dsh-brain-core/satellite-host'
import { scriptedTools } from '../src/fake-deepseek.ts'
import { DEMO_TOOLS, withRig } from '../src/rig.ts'

const sessionId = encodeSessionId({ agentClass: 'chat', channel: 'test:chat:e2', generation: 0 })
const catalogNames = DEMO_TOOLS.map(tool => tool.name).sort()

test('after hardening, DSH holds exactly the catalog and the model sees only the surface', async () => {
  await withRig({ script: scriptedTools() }, async ({ bridge, satellite, gateway }) => {
    bridge.setSurface(sessionId, ['demo__a'])
    await satellite.run(sessionId, 'hello')
    assert.deepEqual(bridge.surfaceCheck, { ok: true, unexpected: [], missing: [] })
    assert.deepEqual(gateway.requests[0]?.tools, ['demo__a'])
    assert.deepEqual(catalogNames, ['demo__a', 'demo__b', 'demo__c'])
  })
})

test('with the hardening removed, the check fails closed and the model is never called', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brain-unhardened-'))
  t.after(() => removeTree(dir))
  const require = createRequire(import.meta.url)
  const hardening = require.resolve('@dsh-brain-core/satellite-bundle/patches/hardening.yml')
  const bundle = pathToFileURL(path.join(path.dirname(hardening), '..', 'dist', 'index.js')).href
  const patch = path.join(dir, 'bridge-only.yml')
  await writeFile(patch, `- insert:\n    - id: brain-bridge\n      name: ${JSON.stringify(bundle)}\n`)

  await withRig({ script: scriptedTools(), satellite: { patches: [patch] } }, async ({ bridge, satellite, gateway }) => {
    bridge.setSurface(sessionId, ['demo__a'])
    const outcome = await satellite.run(sessionId, 'hello').then(result => result.finishReason, (error: Error) => error.message)
    assert.equal(gateway.requests.length, 0, 'no request may leave an unverified process')
    assert.notEqual(outcome, 'completed')
    assert.equal(bridge.surfaceCheck?.ok, false)
    assert.ok(bridge.surfaceCheck?.unexpected.includes('bash') || bridge.surfaceCheck?.unexpected.includes('pwsh'), `shell should be flagged: ${JSON.stringify(bridge.surfaceCheck)}`)
  })
})

test('hardening stops the session log and plugin list from being uploaded', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brain-uploads-'))
  t.after(() => removeTree(dir))
  const require = createRequire(import.meta.url)
  const hardening = require.resolve('@dsh-brain-core/satellite-bundle/patches/hardening.yml')
  const bundle = pathToFileURL(path.join(path.dirname(hardening), '..', 'dist', 'index.js')).href
  const uploads = ['dsh_session_log', 'dsh_plugin_packages']

  await withRig({ script: scriptedTools('demo__a') }, async ({ bridge, satellite, gateway }) => {
    bridge.setSurface(sessionId, ['demo__a'])
    await satellite.run(sessionId, 'hello')
    for (const request of gateway.requests) {
      for (const key of uploads) assert.equal(request.topLevelKeys.includes(key), false, `${key} was sent`)
    }
  })

  // Control: the same patch without those two rows shows whether this endpoint would get them at all.
  // The uploads may only run on the official endpoint, so this prints rather than asserts; s1-live checks the real one.
  const control = path.join(dir, 'control.yml')
  await writeFile(control, (await readFile(hardening, 'utf8'))
    .replace(/- id: session-log-deepseek\r?\n {2}disabled: true\r?\n/, '')
    .replace(/- id: plugin-package-inventory-deepseek\r?\n {2}disabled: true\r?\n/, '')
    .replace('name: ../dist/index.js', `name: ${JSON.stringify(bundle)}`))
  await withRig({ script: scriptedTools('demo__a'), satellite: { patches: [control] } }, async ({ bridge, satellite, gateway }) => {
    bridge.setSurface(sessionId, ['demo__a'])
    await satellite.run(sessionId, 'hello')
    console.log(`upload control, request fields: ${[...new Set(gateway.requests.flatMap(request => request.topLevelKeys))].sort().join(', ')}`)
  })
})
