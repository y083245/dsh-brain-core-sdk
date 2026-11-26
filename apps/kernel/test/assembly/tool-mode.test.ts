import assert from 'node:assert/strict'
import test from 'node:test'
import { CHANNEL, FLASH, setup } from './helpers.ts'

const ROLE = '你是小满。'

test('the tool-update mode is fetched once per selection and the provider is part of the cache key', async (t) => {
  const h = await setup(t, {
    settings: { agents: { chat: { ...FLASH } } },
    apiKey: 'fake-key',
    roleCard: ROLE,
    countModels: true,
  })

  // Two wakes under the same selection ask the gateway for /models once.
  await h.wake(CHANNEL, '第一句话')
  assert.equal(h.models(), 1, 'the first wake looked the mode up')
  await h.wake(CHANNEL, '第二句话')
  assert.equal(h.models(), 1, 'the second wake used the cache')

  // Rotation asks for the mode too. A non-official provider answers locally, under its own key.
  await h.kernel.settings.write({ agents: { chat: { provider: 'not-official', model: 'deepseek-v4-pro', effort: 'low' } } })
  await h.kernel.agent.rotate(CHANNEL)
  assert.equal(h.models(), 1, 'a non-official provider makes no request')

  // Same model, different provider: a cache keyed by model alone would answer from the 'fixed' entry above.
  await h.kernel.settings.write({ agents: { chat: { provider: 'deepseek-official', model: 'deepseek-v4-pro', effort: 'low' } } })
  await h.kernel.agent.rotate(CHANNEL)
  assert.equal(h.models(), 2, 'the provider change forced one lookup')
})
