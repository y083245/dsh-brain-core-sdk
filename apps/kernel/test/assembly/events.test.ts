import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import type { Kernel } from '../../src/assembly.ts'
import { CHANNEL, EVENTS_PLUGIN, FLASH, TOKEN, installPlugin, setup, waitFor } from './helpers.ts'

interface EventsSeen {
  recorded: { id: string; layer: string; kind: string; source: string }[]
  forgotten: { ids: readonly string[]; sessions: { channels?: Record<string, { generation?: number }> } | null }[]
}

const seen = (): EventsSeen => (globalThis as { __brainEventsPlugin?: EventsSeen }).__brainEventsPlugin as EventsSeen

function post(kernel: Kernel, route: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${kernel.port}${route}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('memory.recorded reaches plugins for an L1 written over HTTP, and an L0 ingest does not', async (t) => {
  const h = await setup(t)
  await installPlugin(h.kernel, EVENTS_PLUGIN, 'evt')
  const events = seen()
  assert.deepEqual(events.recorded, [])

  const ingested = await post(h.kernel, '/api/v1/memory/events', {
    kind: 'sample.message', channel: CHANNEL, subjects: [], actor: 'p1',
    content: { text: '我喜欢苹果' }, tEvent: Date.now(), idempotencyKey: 'events-l0',
  })
  assert.equal(ingested.status, 202)
  const l0 = (await ingested.json() as { data: { id: string } }).data
  assert.deepEqual(events.recorded, [], 'an L0 write is not announced')

  const recorded = await post(h.kernel, '/api/v1/memory/records', {
    layer: 'L1', kind: 'l1.fact', channel: CHANNEL, subjects: ['p1'], actor: 'p1',
    content: { text: '她喜欢苹果' }, evidence: [{ id: l0.id }], idempotencyKey: 'events-l1',
  })
  assert.equal(recorded.status, 200)
  const l1 = (await recorded.json() as { data: { id: string } }).data

  await waitFor(() => events.recorded.find((event) => event.id === l1.id), 5_000, 'the memory.recorded event')
  assert.deepEqual(events.recorded, [
    { id: l1.id, layer: 'L1', kind: 'l1.fact', source: 'owner-console' },
  ])
})

test('memory.forgotten is emitted after the agent has already rotated the channel session', async (t) => {
  const h = await setup(t, {
    settings: { agents: { chat: { ...FLASH } }, timezone: 'UTC' },
    apiKey: 'fake-key',
    roleCard: '你是小满。',
  })
  await installPlugin(h.kernel, EVENTS_PLUGIN, 'evt')
  process.env.BRAIN_ASSEMBLY_TEST_HOME = h.home
  t.after(() => { delete process.env.BRAIN_ASSEMBLY_TEST_HOME })

  await h.wake(CHANNEL, '记住：暗号是蓝鲸')

  const sessionsFile = path.join(h.home, 'state', 'agent', 'sessions.json')
  const before = await waitFor(async () => {
    try {
      const parsed = JSON.parse(await readFile(sessionsFile, 'utf8')) as { channels?: Record<string, { generation?: number }> }
      const generation = parsed.channels?.[CHANNEL]?.generation
      return typeof generation === 'number' ? generation : undefined
    } catch {
      return undefined
    }
  }, 30_000, 'the first session entry')
  const events = seen()
  events.forgotten.length = 0

  await h.kernel.memory.service.forget({ by: 'channel', channel: CHANNEL })

  const forgotten = events.forgotten.at(-1)
  assert.ok(forgotten, 'the plugin saw memory.forgotten')
  const generationAtEvent = forgotten.sessions?.channels?.[CHANNEL]?.generation
  assert.equal(typeof generationAtEvent, 'number', 'the handler could read the session pool')
  assert.ok((generationAtEvent as number) > before, 'the session was already rotated when the event arrived')
})
