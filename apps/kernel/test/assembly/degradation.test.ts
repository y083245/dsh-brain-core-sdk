import assert from 'node:assert/strict'
import test from 'node:test'
import { killProcessTree } from '@dsh-brain-core/satellite-host'
import {
  BROKEN_PLUGIN, CHANNEL, CRASHING_PLUGIN, EXTERNAL_PLUGIN, FLASH, httpGet, installPlugin, readExternalPid, setup, waitFor,
  waitForExternalPid, waitForSatellitePid,
} from './helpers.ts'

const MODEL = { agents: { chat: { ...FLASH } } }
const ROLE = '你是小满。'

test('NFR-04: killing the satellite lets the queued wake run in a fresh process', async (t) => {
  let hangCut = true
  const h = await setup(t, {
    settings: MODEL,
    apiKey: 'fake-key',
    roleCard: ROLE,
    script: (request) => {
      if (request.raw.includes('被切断') && hangCut) {
        hangCut = false
        return { hang: true }
      }
      return { text: '好。' }
    },
  })
  await h.wake(CHANNEL, '预热')
  const oldPid = await waitForSatellitePid(h.home)

  const cut = h.wake(CHANNEL, '被切断的一句话')
  const before = h.fake.requests.length
  await waitFor(() => (h.fake.requests.length > before ? true : undefined), 30_000, 'the hanging turn to reach the gateway')

  const queued = h.wake('sample:private:u2', '排在后面的一句话')
  const startedAt = Date.now()
  await killProcessTree(oldPid)

  // A turn cut with nothing sent is retried once, so it may complete on the new process.
  await cut
  const result = await queued
  assert.equal(result.acked, true)
  assert.ok(Date.now() - startedAt < 30_000, 'recovered within 30 seconds')

  const newPid = await waitForSatellitePid(h.home, 'chat', oldPid)
  assert.notEqual(newPid, oldPid)
  assert.equal(await (await httpGet(h.kernel, '/api/v1/memory/health')).status, 200)
})

test('A5: a crashed process plugin is replaced and the kernel keeps serving', async (t) => {
  const h = await setup(t)
  await installPlugin(h.kernel, EXTERNAL_PLUGIN, 'external')
  const first = await waitForExternalPid(h.home)
  await killProcessTree(first)
  const second = await waitFor(async () => {
    const pid = await readExternalPid(h.home)
    return pid !== undefined && pid !== first ? pid : undefined
  }, 30_000, 'the external plugin to be restarted')
  assert.notEqual(second, first)
  assert.equal(await (await httpGet(h.kernel, '/api/v1/memory/health')).status, 200)
  assert.equal(h.kernel.runtime.state('external'), 'enabled')
})

test('A5: one plugin failing to start leaves the others and the kernel running', async (t) => {
  const h = await setup(t, {
    settings: MODEL,
    apiKey: 'fake-key',
    roleCard: ROLE,
    plugin: true,
  })
  await h.kernel.plugins.install(BROKEN_PLUGIN)
  await h.kernel.plugins.confirm('broken')
  await assert.rejects(h.kernel.plugins.enable('broken'))

  assert.equal(h.kernel.runtime.state('broken'), 'failed')
  assert.equal(h.kernel.runtime.state('sample'), 'enabled')
  assert.ok(h.kernel.gateway.catalog().some((tool) => tool.name === 'sample__remember'))
  assert.equal(await (await httpGet(h.kernel, '/api/v1/memory/health')).status, 200)

  // The healthy plugin still answers a wake after the failure.
  const result = await h.wake(CHANNEL, '还在吗')
  assert.equal(result.acked, true)
})

test('A5: a process plugin that keeps crashing is turned off by onFailed', async (t) => {
  const h = await setup(t)
  await installPlugin(h.kernel, CRASHING_PLUGIN, 'crashy')
  await waitFor(() => (h.kernel.runtime.state('crashy') === 'enabled' ? true : undefined), 10_000, 'the plugin to come up')

  // Four crashes inside the sixty second window: the restart delays are 1, 2 and 4 seconds.
  await waitFor(() => (h.kernel.runtime.state('crashy') !== 'enabled' ? true : undefined), 30_000, 'onFailed to disable it')
  assert.equal(h.kernel.runtime.state('crashy'), 'disabled')
  assert.ok(h.logs.some((entry) => entry.event === 'plugin.external.failed'))
  assert.equal((await httpGet(h.kernel, '/api/v1/memory/health')).status, 200)
})
