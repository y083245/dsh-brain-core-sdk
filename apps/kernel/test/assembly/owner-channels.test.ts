import assert from 'node:assert/strict'
import test from 'node:test'
import { FLASH, OWNER_PLUGIN, installPlugin, setup, type Harness } from './helpers.ts'

const MODEL = { agents: { chat: { ...FLASH } } }
const ROLE = '你是小满。'
const OWNER_TOOL = 'ownerish__ping'

async function toolsSeen(h: Harness, channel: string): Promise<readonly string[]> {
  const before = h.fake.requests.length
  const result = await h.wake(channel, '在吗')
  assert.equal(result.acked, true)
  const requests = h.fake.requests.slice(before)
  assert.ok(requests.length >= 1)
  return requests[0]!.tools
}

test('an owner-only tool is visible in the channel given on the command line', async (t) => {
  const h = await setup(t, {
    settings: { ...MODEL },
    apiKey: 'fake-key',
    roleCard: ROLE,
    ownerChannels: ['ownerish:private:u1'],
  })
  await installPlugin(h.kernel, OWNER_PLUGIN, 'ownerish')
  assert.ok((await toolsSeen(h, 'ownerish:private:u1')).includes(OWNER_TOOL))
})

test('without the argument the owner channels come from settings', async (t) => {
  const h = await setup(t, {
    settings: { ...MODEL, ownerChannels: ['ownerish:private:u1'] },
    apiKey: 'fake-key',
    roleCard: ROLE,
  })
  await installPlugin(h.kernel, OWNER_PLUGIN, 'ownerish')
  assert.ok((await toolsSeen(h, 'ownerish:private:u1')).includes(OWNER_TOOL))
})

test('when both are given the command-line channels win over settings', async (t) => {
  const h = await setup(t, {
    settings: { ...MODEL, ownerChannels: ['ownerish:private:u2'] },
    apiKey: 'fake-key',
    roleCard: ROLE,
    ownerChannels: ['ownerish:private:u1'],
  })
  await installPlugin(h.kernel, OWNER_PLUGIN, 'ownerish')
  assert.ok((await toolsSeen(h, 'ownerish:private:u1')).includes(OWNER_TOOL), 'the argument channel')
  assert.equal((await toolsSeen(h, 'ownerish:private:u2')).includes(OWNER_TOOL), false, 'the settings channel is overridden')
})
