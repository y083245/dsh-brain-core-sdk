import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeSessionId } from '@dsh-brain-core/satellite-host'
import { CHANNEL, FLASH, sessionDirs, setup, waitFor } from './helpers.ts'

const MODEL = { agents: { chat: { ...FLASH } }, timezone: 'UTC' }
const ROLE = '你是小满，说话简短。'

function sessionId(generation: number): string {
  return encodeSessionId({ agentClass: 'chat', channel: CHANNEL, generation })
}

test('forgetting a channel deletes its session, emits memory.forgotten and the next wake has no forgotten text', async (t) => {
  ;(globalThis as { __brainSampleForgotten?: unknown[] }).__brainSampleForgotten = []
  const h = await setup(t, { settings: MODEL, apiKey: 'fake-key', roleCard: ROLE, plugin: true })
  await h.wake(CHANNEL, '记住：我的秘密暗号是蓝鲸')
  await waitFor(async () => (await sessionDirs(h.home, sessionId(0))).length > 0, 30_000, 'the first session directory')

  const report = await h.kernel.memory.service.forget({ by: 'channel', channel: CHANNEL })
  assert.ok(report.tombstoned >= 1)
  await waitFor(async () => (await sessionDirs(h.home, sessionId(0))).length === 0, 30_000, 'the old session to be deleted')

  const events = (globalThis as { __brainSampleForgotten?: readonly (readonly string[])[] }).__brainSampleForgotten ?? []
  assert.ok(events.length >= 1)
  assert.ok(events.flat().length >= 1)

  const before = h.fake.requests.length
  await h.wake(CHANNEL, '继续说')
  const fresh = h.fake.requests.slice(before)
  assert.ok(fresh.length >= 1)
  for (const request of fresh) {
    assert.equal(request.raw.includes('蓝鲸'), false, 'the forgotten words never reach the model again')
  }
  await waitFor(async () => (await sessionDirs(h.home, sessionId(1))).length > 0, 30_000, 'the new session directory')
})

test('crossing a day writes a handoff, starts a new session and the first wake carries <handoff>', async (t) => {
  let now = Date.UTC(2026, 0, 1, 12, 0, 0)
  const h = await setup(t, {
    settings: MODEL,
    apiKey: 'fake-key',
    roleCard: ROLE,
    clock: { now: () => now },
    script: (request) => request.raw.includes('这一段对话要收尾了')
      ? { text: '昨天聊到苹果，还没说完。' }
      : { text: '好。' },
  })
  await h.wake(CHANNEL, '昨天聊了苹果')
  await waitFor(async () => (await sessionDirs(h.home, sessionId(0))).length > 0, 30_000, 'the first session directory')

  now += 86_400_000
  await h.wake(CHANNEL, '新的一天')
  const requests = h.fake.requests
  const handoffTurn = requests.find((request) => request.raw.includes('这一段对话要收尾了'))
  assert.ok(handoffTurn, 'the old session was asked for a handoff')
  const withHandoff = requests.find((request, index) => index > requests.indexOf(handoffTurn!) && request.raw.includes('<handoff>'))
  assert.ok(withHandoff, 'the new session first wake carries <handoff>')
  assert.ok(withHandoff!.raw.includes('昨天聊到苹果，还没说完。'))
  await waitFor(async () => (await sessionDirs(h.home, sessionId(0))).length === 0, 30_000, 'the old session to be deleted')
  await waitFor(async () => (await sessionDirs(h.home, sessionId(1))).length > 0, 30_000, 'the new session directory')
})
