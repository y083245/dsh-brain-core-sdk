import assert from 'node:assert/strict'
import test from 'node:test'
import type { ContextBundle, MemoryRecord, SearchHit, Viewer } from '@dsh-brain-core/sdk'
import { openTempBrain, OWNER_IDENTITY } from './helpers.ts'

const GROUP = 'qq:group:20001'
const OWNER_CHANNEL = 'qq:private:10001'

interface Fixture {
  readonly subject: string
  readonly origin: string
  readonly owner: string
  readonly internal: string
}

async function fixture(brain: Awaited<ReturnType<typeof openTempBrain>>): Promise<Fixture> {
  async function write(
    key: string,
    text: string,
    visibility: 'subject' | 'origin' | 'owner' | 'internal',
    conclusion?: string,
  ): Promise<string> {
    const evidence = await brain.memory.service.ingest({
      kind: 'chat.message',
      channel: GROUP,
      subjects: [],
      actor: 'p_alice',
      // The evidence must not match the search term, or the L0 would show up in the hits.
      content: { text: `第 ${key} 条原话` },
      tEvent: Date.now(),
      idempotencyKey: key,
    }, OWNER_IDENTITY)
    const record = await brain.memory.service.record({
      layer: 'L1',
      kind: 'l1.fact',
      channel: GROUP,
      subjects: ['p_alice'],
      actor: 'p_alice',
      content: conclusion === undefined ? { text } : { text, conclusion },
      evidence: [{ id: evidence.id }],
      visibility,
    }, OWNER_IDENTITY)
    return record.id
  }

  return {
    subject: await write('at3-subject', '她喜欢咖啡', 'subject'),
    origin: await write('at3-origin', '她说咖啡很好喝', 'origin'),
    owner: await write('at3-owner', '我猜她喜欢咖啡', 'owner'),
    internal: await write('at3-internal', '原文：她不太靠谱，咖啡', 'internal', '和她打交道要谨慎'),
  }
}

function hitIds(hits: readonly SearchHit[]): string[] {
  return hits.map((hit) => hit.record.id).sort()
}

function disclosureOf(hits: readonly SearchHit[], id: string): string | undefined {
  return hits.find((hit) => hit.record.id === id)?.disclosure.speakable
}

function factsIds(bundle: ContextBundle): string[] {
  return (bundle.blocks.find((block) => block.name === 'facts')?.items ?? []).map((item) => item.id).sort()
}

const V1: Viewer = { caller: 'agent', channel: GROUP, participants: ['p_alice'] }
const V2: Viewer = { caller: 'agent', channel: GROUP, participants: ['p_bob'] }
const V3: Viewer = { caller: 'agent', channel: 'qq:private:30001', participants: ['p_alice'] }
const V4: Viewer = { caller: 'agent', channel: OWNER_CHANNEL, participants: ['self'] }

test('AT-3 disclosure matrix: search and the facts block', async () => {
  const brain = await openTempBrain({
    ownerChannels: [OWNER_CHANNEL],
    crossChannelMode: () => 'on',
  })
  try {
    const ids = await fixture(brain)
    await brain.memory.service.flush()

    const cases: readonly {
      readonly name: string
      readonly viewer: Viewer
      readonly search: readonly string[]
      readonly facts: readonly string[]
      readonly subjectSpeakable?: string
    }[] = [
      { name: 'V1', viewer: V1, search: [ids.subject, ids.origin, ids.internal], facts: [ids.subject, ids.origin, ids.internal], subjectSpeakable: 'if-subject-raises' },
      { name: 'V2', viewer: V2, search: [ids.origin, ids.internal], facts: [ids.origin, ids.internal] },
      { name: 'V3', viewer: V3, search: [ids.subject, ids.internal], facts: [ids.subject, ids.internal], subjectSpeakable: 'yes' },
      { name: 'V4', viewer: V4, search: [ids.owner, ids.internal], facts: [] },
    ]

    for (const item of cases) {
      const hits = await brain.memory.service.search({ query: '咖啡', scope: 'all' }, item.viewer)
      assert.deepEqual(hitIds(hits.items), [...item.search].sort(), `${item.name} search`)
      if (item.subjectSpeakable !== undefined) {
        assert.equal(disclosureOf(hits.items, ids.subject), item.subjectSpeakable, `${item.name} subject speakable`)
      }
      assert.equal(disclosureOf(hits.items, ids.internal), 'never', `${item.name} internal speakable`)

      const context = await brain.memory.service.context({ channel: item.viewer.channel as string }, item.viewer)
      assert.deepEqual(factsIds(context), [...item.facts].sort(), `${item.name} facts`)
    }
  } finally {
    await brain.close()
  }
})

test('AT-3: an internal record only ever exposes its conclusion', async () => {
  const brain = await openTempBrain({
    ownerChannels: [OWNER_CHANNEL],
    crossChannelMode: () => 'on',
  })
  try {
    const ids = await fixture(brain)
    await brain.memory.service.flush()

    for (const viewer of [V1, V2, V3, V4]) {
      const hits = await brain.memory.service.search({ query: '咖啡', scope: 'all' }, viewer)
      const hit = hits.items.find((item) => item.record.id === ids.internal) as SearchHit
      assert.deepEqual(hit.record.content, { conclusion: '和她打交道要谨慎' })
      assert.equal(JSON.stringify(hits).includes('原文'), false)

      const context = await brain.memory.service.context({ channel: viewer.channel as string }, viewer)
      const item = context.blocks.flatMap((block) => block.items).find((entry) => entry.id === ids.internal)
      if (viewer !== V4) {
        assert.ok(item !== undefined)
        assert.equal(item.text, '和她打交道要谨慎')
      }
      assert.equal(JSON.stringify(context).includes('原文'), false)
    }
  } finally {
    await brain.close()
  }
})

test('AT-3: updating an invisible record looks exactly like a missing one', async () => {
  const brain = await openTempBrain({
    ownerChannels: [OWNER_CHANNEL],
    crossChannelMode: () => 'on',
  })
  try {
    const ids = await fixture(brain)
    const missing = 'l1_00000000000000000000000000'

    let invisibleError: unknown
    try {
      await brain.memory.service.update(ids.owner, { content: { text: 'x' } }, 1, OWNER_IDENTITY, V1)
    } catch (error) {
      invisibleError = error
    }
    let missingError: unknown
    try {
      await brain.memory.service.update(missing, { content: { text: 'x' } }, 1, OWNER_IDENTITY, V1)
    } catch (error) {
      missingError = error
    }

    assert.ok(invisibleError instanceof Error && missingError instanceof Error)
    assert.equal((invisibleError as { code?: string }).code, 'NOT_FOUND')
    assert.equal((invisibleError as { code?: string }).code, (missingError as { code?: string }).code)
    assert.equal((invisibleError as { message: string }).message, (missingError as { message: string }).message)
    assert.deepEqual(
      (invisibleError as { details?: unknown }).details,
      (missingError as { details?: unknown }).details,
    )

    // The owner record still exists and is untouched.
    const search = await brain.memory.service.search({ query: '咖啡', scope: 'all' }, V1)
    assert.equal(hitIds(search.items).includes(ids.owner as string), false)
    const ownerSearch = await brain.memory.service.search({ query: '咖啡', scope: 'all' }, { caller: 'owner-console', channel: null, participants: [] })
    const ownerHit = ownerSearch.items.find((hit) => hit.record.id === ids.owner) as SearchHit
    assert.equal((ownerHit.record as MemoryRecord).version, 1)
  } finally {
    await brain.close()
  }
})
