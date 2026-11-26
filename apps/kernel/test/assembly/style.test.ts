import assert from 'node:assert/strict'
import test from 'node:test'
import { CHANNEL, FLASH, setup } from './helpers.ts'

const ROLE = '你是小满。'
const OPENING = '作为一个AI，我想说今天天气不错'

interface Sent { readonly channel: string; readonly text?: string }

function sent(): Sent[] {
  return (globalThis as { __brainSampleSent?: Sent[] }).__brainSampleSent ?? []
}

function sendScript(text: string) {
  return (_request: unknown, index: number) => {
    if (index === 0) return { tool: 'tools__load', input: { group: 'messaging' } }
    if (index === 1) return { tool: 'sample__say', input: { text } }
    return { text: '好。' }
  }
}

test('with no style settings the built-in openers are refused', async (t) => {
  ;(globalThis as { __brainSampleSent?: Sent[] }).__brainSampleSent = []
  const h = await setup(t, {
    settings: { agents: { chat: { ...FLASH } } },
    apiKey: 'fake-key',
    roleCard: ROLE,
    plugin: true,
    script: sendScript(OPENING),
  })
  const result = await h.wake(CHANNEL, '说句话')
  assert.equal(result.acked, true)
  assert.equal(result.sent, 0)
  assert.deepEqual(sent(), [])
  assert.ok(h.fake.requests.some((request) => request.raw.includes('套话')), 'the model is told why')
})

test('an opener added in settings is refused as well', async (t) => {
  ;(globalThis as { __brainSampleSent?: Sent[] }).__brainSampleSent = []
  const h = await setup(t, {
    settings: { agents: { chat: { ...FLASH } }, style: { openers: ['让我来'] } },
    apiKey: 'fake-key',
    roleCard: ROLE,
    plugin: true,
    script: sendScript('让我来帮你处理这件事'),
  })
  const result = await h.wake(CHANNEL, '说句话')
  assert.equal(result.acked, true)
  assert.equal(result.sent, 0)
  assert.deepEqual(sent(), [])
  assert.ok(h.fake.requests.some((request) => request.raw.includes('「让我来」')))
})

test('style.enabled false turns every opener check off', async (t) => {
  ;(globalThis as { __brainSampleSent?: Sent[] }).__brainSampleSent = []
  const h = await setup(t, {
    settings: { agents: { chat: { ...FLASH } }, style: { enabled: false } },
    apiKey: 'fake-key',
    roleCard: ROLE,
    plugin: true,
    script: sendScript(OPENING),
  })
  const result = await h.wake(CHANNEL, '说句话')
  assert.equal(result.acked, true)
  assert.equal(result.sent, 1)
  assert.deepEqual(sent(), [{ channel: CHANNEL, text: OPENING }])
})
