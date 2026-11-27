import assert from 'node:assert/strict'
import test from 'node:test'
import { LIMITS, validate, type SearchHit } from '@dsh-brain-core/sdk'
import { OWNER_IDENTITY, openTempBrain, startApi } from './helpers.ts'

function hitIds(body: Record<string, unknown>): string[] {
  validate('Envelope', body)
  assert.equal(body.ok, true)
  const data = body.data as { readonly items: readonly SearchHit[] }
  return data.items.map((item) => item.record.id).sort()
}

function errorCode(body: Record<string, unknown>): string {
  validate('Envelope', body)
  assert.equal(body.ok, false)
  return (body.error as { readonly code: string }).code
}

test('POST /api/v1/console/memory/search resolves all, here, person (with merged aliases), and subject intersection', async () => {
  const brain = await openTempBrain({ crossChannelMode: () => 'off' })
  const api = await startApi(brain.memory)
  const now = 1_700_000_000_000

  try {
    const p1 = await brain.memory.identity.resolve('qq:101')
    const p2 = await brain.memory.identity.resolve('wx:202')
    const p3 = await brain.memory.identity.resolve('qq:303')
    await brain.memory.identity.merge(p1, p2)

    const ch1 = 'console-chat:private:owner'
    const ch2 = 'qq:group:888'

    const l0a = await brain.memory.service.ingest({
      kind: 'chat.message',
      channel: ch1,
      subjects: [p1],
      actor: p1,
      content: { text: '龙井茶泡好了' },
      tEvent: now,
      idempotencyKey: 'cs-1',
    }, OWNER_IDENTITY)
    const l0b = await brain.memory.service.ingest({
      kind: 'chat.message',
      channel: ch2,
      subjects: [p2],
      actor: p2,
      content: { text: '龙井茶很香' },
      tEvent: now + 10,
      idempotencyKey: 'cs-2',
    }, OWNER_IDENTITY)
    const l0c = await brain.memory.service.ingest({
      kind: 'chat.message',
      channel: ch2,
      subjects: [p3],
      actor: p3,
      content: { text: '龙井茶在桌上' },
      tEvent: now + 20,
      idempotencyKey: 'cs-3',
    }, OWNER_IDENTITY)
    await brain.memory.service.flush()

    // 1. scope: 'all' hits every channel even when crossChannelMode is 'off'
    const allRes = await api.request('POST', '/console/memory/search', {
      query: '龙井茶',
      scope: 'all',
    })
    assert.equal(allRes.status, 200)
    assert.deepEqual(hitIds(allRes.body), [l0a.id, l0b.id, l0c.id].sort())

    // 2. scope: 'here' + channel hits only records in that channel
    const hereCh1 = await api.request('POST', '/console/memory/search', {
      query: '龙井茶',
      scope: 'here',
      channel: `  ${ch1}  `,
    })
    assert.equal(hereCh1.status, 200)
    assert.deepEqual(hitIds(hereCh1.body), [l0a.id])

    const hereCh2 = await api.request('POST', '/console/memory/search', {
      query: '龙井茶',
      scope: 'here',
      channel: ch2,
    })
    assert.equal(hereCh2.status, 200)
    assert.deepEqual(hitIds(hereCh2.body), [l0b.id, l0c.id].sort())

    // scope: 'here' without channel returns empty
    const hereEmpty = await api.request('POST', '/console/memory/search', {
      query: '龙井茶',
      scope: 'here',
    })
    assert.equal(hereEmpty.status, 200)
    assert.deepEqual(hitIds(hereEmpty.body), [])

    // 3. scope: 'person' + participants expands merged aliases in both directions
    const personCanonical = await api.request('POST', '/console/memory/search', {
      query: '龙井茶',
      scope: 'person',
      participants: [p2],
    })
    assert.equal(personCanonical.status, 200)
    assert.deepEqual(hitIds(personCanonical.body), [l0a.id, l0b.id].sort())

    const personAlias = await api.request('POST', '/console/memory/search', {
      query: '龙井茶',
      scope: 'person',
      participants: [p1],
    })
    assert.equal(personAlias.status, 200)
    assert.deepEqual(hitIds(personAlias.body), [l0a.id, l0b.id].sort())

    const personOther = await api.request('POST', '/console/memory/search', {
      query: '龙井茶',
      scope: 'person',
      participants: [p3],
    })
    assert.equal(personOther.status, 200)
    assert.deepEqual(hitIds(personOther.body), [l0c.id])

    // scope: 'person' without participants returns empty
    const personEmpty = await api.request('POST', '/console/memory/search', {
      query: '龙井茶',
      scope: 'person',
    })
    assert.equal(personEmpty.status, 200)
    assert.deepEqual(hitIds(personEmpty.body), [])

    // 4. scope: 'person' combined with subjects takes intersection
    const personIntersectMatch = await api.request('POST', '/console/memory/search', {
      query: '龙井茶',
      scope: 'person',
      participants: [p2, p3],
      subjects: [p1],
    })
    assert.equal(personIntersectMatch.status, 200)
    assert.deepEqual(hitIds(personIntersectMatch.body), [l0a.id, l0b.id].sort())

    const personIntersectNone = await api.request('POST', '/console/memory/search', {
      query: '龙井茶',
      scope: 'person',
      participants: [p2],
      subjects: [p3],
    })
    assert.equal(personIntersectNone.status, 200)
    assert.deepEqual(hitIds(personIntersectNone.body), [])

    // 5. Caller / viewer overrides in body are ignored (caller remains owner-console)
    const spoofedCaller = await api.request('POST', '/console/memory/search', {
      query: '龙井茶',
      scope: 'all',
      caller: 'agent',
      viewer: { caller: 'agent', channel: ch1, participants: [] },
    })
    assert.equal(spoofedCaller.status, 200)
    assert.deepEqual(hitIds(spoofedCaller.body), [l0a.id, l0b.id, l0c.id].sort())

    // 6. Public /memory/search contract remains unchanged (ignores channel/participants/viewer)
    const publicHere = await api.request('POST', '/memory/search', {
      query: '龙井茶',
      scope: 'here',
      channel: ch1,
      viewer: { caller: 'owner-console', channel: ch1, participants: [p2] },
    })
    assert.equal(publicHere.status, 200)
    assert.deepEqual(hitIds(publicHere.body), [])

    const publicAll = await api.request('POST', '/memory/search', {
      query: '龙井茶',
      scope: 'all',
    })
    assert.equal(publicAll.status, 200)
    assert.deepEqual(hitIds(publicAll.body), [l0a.id, l0b.id, l0c.id].sort())
  } finally {
    await api.close()
    await brain.close()
  }
})

test('POST /api/v1/console/memory/search validates body, channel, participants, and enforces Bearer auth', async () => {
  const brain = await openTempBrain()
  const api = await startApi(brain.memory, 'secret-token')

  try {
    // Unauthorized
    const unauth = await api.request(
      'POST',
      '/console/memory/search',
      { query: '龙井', scope: 'all' },
      { Authorization: 'Bearer wrong-token' },
    )
    assert.equal(unauth.status, 401)
    assert.equal(errorCode(unauth.body), 'UNAUTHENTICATED')

    // Missing or non-object bodies
    for (const badBody of [undefined, '[]', '"text"', '123', 'null']) {
      const res = await api.request('POST', '/console/memory/search', badBody)
      assert.equal(res.status, 400)
      assert.equal(errorCode(res.body), 'INVALID_ARGUMENT')
    }

    // Invalid channel values
    for (const badChannel of ['', '   ', 42, null, ['ch1'], { id: 'ch1' }]) {
      const res = await api.request('POST', '/console/memory/search', {
        query: '龙井',
        scope: 'here',
        channel: badChannel,
      })
      assert.equal(res.status, 400)
      assert.equal(errorCode(res.body), 'INVALID_ARGUMENT')
    }

    // Invalid participants values
    const tooMany = Array.from({ length: LIMITS.subjects + 1 }, (_, i) => `p_${String(i)}`)
    for (const badParticipants of ['p_1', null, 123, [''], ['   '], [123], ['p_1', ''], tooMany]) {
      const res = await api.request('POST', '/console/memory/search', {
        query: '龙井',
        scope: 'person',
        participants: badParticipants,
      })
      assert.equal(res.status, 400)
      assert.equal(errorCode(res.body), 'INVALID_ARGUMENT')
    }

    // Prototype-pollution keys are explicitly rejected with 400 INVALID_ARGUMENT
    for (const rawBody of [
      '{"query":"龙井","scope":"all","__proto__":{"polluted":true}}',
      '{"query":"龙井","scope":"all","constructor":{"prototype":{}}}',
      '{"query":"龙井","scope":"all","prototype":{}}',
    ]) {
      const res = await api.request('POST', '/console/memory/search', rawBody)
      assert.equal(res.status, 400)
      assert.equal(errorCode(res.body), 'INVALID_ARGUMENT')
    }

    // Invalid SearchRequest fields still rejected with 400 INVALID_ARGUMENT
    const badScope = await api.request('POST', '/console/memory/search', {
      query: '龙井',
      scope: 'unknown',
    })
    assert.equal(badScope.status, 400)
    assert.equal(errorCode(badScope.body), 'INVALID_ARGUMENT')
  } finally {
    await api.close()
    await brain.close()
  }
})
