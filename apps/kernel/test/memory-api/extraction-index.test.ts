import assert from 'node:assert/strict'
import test from 'node:test'
import { FakeLlm } from '../fakes/index.ts'
import { OWNER_IDENTITY, OWNER_VIEWER, openTempBrain } from './helpers.ts'

test('extracted records are searchable without a rebuild', async () => {
  // FakeLlm copies the array but keeps the reply objects, so this holder can be filled once the L0 id exists.
  const replyHolder: { text: string; tokens: number } = { text: '', tokens: 9 }
  const llm = new FakeLlm([replyHolder])
  const brain = await openTempBrain({
    extraction: { llm, dailyTokenCap: 1_000_000, maxOutputTokens: 512 },
  })
  try {
    const ingested = await brain.memory.service.ingest({
      kind: 'chat.message',
      channel: 'qq:group:42',
      subjects: [],
      actor: 'p_alice',
      content: { text: '你好呀' },
      tEvent: Date.now(),
      idempotencyKey: 'extraction-index-l0',
      visibility: 'open',
    }, OWNER_IDENTITY)

    replyHolder.text = JSON.stringify({
      facts: [{
        kind: 'l1.fact',
        text: 'p_alice 的生日是 5 月 20 日',
        subjects: ['p_alice'],
        evidence: [ingested.id],
        confidence: 0.95,
        key: '生日',
        value: '5月20日',
      }],
    })

    const job = brain.memory.jobs.start({ type: 'extract', from: 0, to: Date.now() + 1_000 })
    await brain.memory.jobs.idle()
    assert.equal(brain.memory.jobs.get(job.id).status, 'done')

    const hits = await brain.memory.service.search({ query: '生日', scope: 'all' }, OWNER_VIEWER)
    assert.equal(hits.items.length, 1)
    assert.equal(hits.items[0]?.record.kind, 'l1.fact')
    assert.equal(hits.items[0]?.record.content.text, 'p_alice 的生日是 5 月 20 日')
  } finally {
    await brain.close()
  }
})
