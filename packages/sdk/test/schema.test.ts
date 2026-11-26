import assert from 'node:assert/strict'
import test from 'node:test'
import { BrainError, CONTEXT_BLOCK_NAMES, ERROR_CODES, LIMITS, validate } from '../src/index.ts'

const validRecord = {
  id: 'l1_01J',
  layer: 'L1',
  kind: 'l1.fact',
  source: 'test-plugin',
  channel: 'test-plugin:fact:1',
  subjects: ['self'],
  actor: 'owner',
  content: { text: 'hello' },
  evidence: [{ id: 'l0_01J' }],
  visibility: 'owner',
  trust: 'owner',
  confidence: 0.9,
  importance: 0.5,
  tEvent: 1,
  tIngest: 2,
  status: 'active',
  version: 1,
}

const validMeta = { requestId: 'req-1', apiVersion: '1.0' }

function invalidArgument(run: () => unknown): BrainError {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof BrainError, `expected BrainError, got ${String(error)}`)
    assert.equal(error.code, 'INVALID_ARGUMENT')
    return error
  }
  assert.fail('expected validate to throw')
}

test('valid MemoryRecord passes', () => {
  const result = validate('MemoryRecord', validRecord)
  assert.deepEqual(result, validRecord)
})

test('invalid MemoryRecord reports the offending field', () => {
  const error = invalidArgument(() => validate('MemoryRecord', { ...validRecord, confidence: 2 }))
  assert.equal(error.details.field, 'confidence')
  assert.match(error.message, /confidence/)
})

test('missing required MemoryRecord field reports that field', () => {
  const withoutSource: Record<string, unknown> = { ...validRecord }
  delete withoutSource.source
  const error = invalidArgument(() => validate('MemoryRecord', withoutSource))
  assert.equal(error.details.field, 'source')
})

test('valid Envelope passes in both branches', () => {
  assert.deepEqual(validate('Envelope', { ok: true, data: { id: 'l1_01J' }, meta: validMeta }), {
    ok: true,
    data: { id: 'l1_01J' },
    meta: validMeta,
  })
  const failure = {
    ok: false,
    error: { code: 'CONFLICT', message: 'version mismatch', details: {} },
    meta: validMeta,
  }
  assert.deepEqual(validate('Envelope', failure), failure)
})

test('invalid Envelope is rejected as INVALID_ARGUMENT', () => {
  const error = invalidArgument(() => validate('Envelope', { ok: true, meta: validMeta }))
  assert.equal(error.code, 'INVALID_ARGUMENT')
  assert.equal(error.details.field, '')

  const unknownCode = invalidArgument(() => validate('Envelope', {
    ok: false,
    error: { code: 'NOT_A_CODE', message: 'nope', details: {} },
    meta: validMeta,
  }))
  assert.equal(unknownCode.code, 'INVALID_ARGUMENT')
})

test('error codes match RFC 7.3', () => {
  assert.deepEqual({ ...ERROR_CODES }, {
    INVALID_ARGUMENT: 400,
    UNAUTHENTICATED: 401,
    PERMISSION_DENIED: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    PAYLOAD_TOO_LARGE: 413,
    RATE_LIMITED: 429,
    EMBEDDING_MISMATCH: 503,
    UNAVAILABLE: 503,
    INTERNAL: 500,
  })
  assert.equal(Object.keys(ERROR_CODES).length, 10)
})

test('limits have the agreed initial values', () => {
  assert.deepEqual({ ...LIMITS }, {
    contentBytes: 64 * 1024,
    requestBytes: 1024 * 1024,
    subjects: 50,
    evidence: 100,
    searchLimit: 100,
    toolSummaryChars: 60,
    toolResultChars: 64 * 1024,
    toolImages: 4,
    toolImageBytes: 8 * 1024 * 1024,
    wakeMessages: 50,
    wakeMessageChars: 2000,
  })
})

test('all boundary schemas validate their minimal legal shape', () => {
  assert.ok(validate('IngestEvent', {
    kind: 'chat.message', channel: 'qq:group:1', subjects: ['self'], actor: 'member',
    content: { text: 'hi' }, tEvent: 1, idempotencyKey: 'k1',
  }))
  assert.ok(validate('RecordInput', {
    layer: 'L1', kind: 'l1.fact', channel: 'qq:group:1', subjects: ['self'], actor: 'member',
    content: {}, evidence: [{ id: 'l0_01J' }],
  }))
  assert.ok(validate('RecordPatch', { confidence: 0.5 }))
  assert.ok(validate('SearchRequest', { query: 'tea', scope: 'here' }))
  assert.ok(validate('ContextRequest', { channel: 'qq:group:1' }))
  assert.ok(validate('ContextBundle', {
    profileVersion: 1,
    stable: 'stable prefix',
    blocks: [
      { name: 'working', items: [{ id: 'wm_01J', text: 'topic: tea', disclosure: { speakable: 'yes', label: '当前会话短期状态' } }] },
      { name: 'topics', items: [{ id: 'l1_01T', text: 'open topic', disclosure: { speakable: 'yes', label: '就在这里说过' } }] },
      { name: 'facts', items: [{ id: 'l1_01J', text: 'likes tea', disclosure: { speakable: 'yes', label: 'told you' } }] },
    ],
    truncated: false,
  }))
  assert.ok(validate('SearchHit', {
    record: validRecord,
    disclosure: { speakable: 'yes', label: 'told you' },
    score: 0.5,
  }))
  assert.ok(validate('ForgetReport', { tombstoned: 1, invalidated: 2, l3Flagged: 3 }))
  for (const selector of [
    { by: 'record', id: 'l1_01J' },
    { by: 'channel', channel: 'qq:group:1' },
    { by: 'person', personId: 'p1' },
    { by: 'time', from: 1, to: 2 },
  ]) {
    assert.ok(validate('ForgetSelector', selector))
  }
})

test('search limit above the cap is rejected', () => {
  const error = invalidArgument(() => validate('SearchRequest', { query: 'tea', scope: 'here', limit: 101 }))
  assert.equal(error.details.field, 'limit')
})

test('subjects over the cap are rejected', () => {
  const subjects = Array.from({ length: LIMITS.subjects + 1 }, (_, index) => `p${index}`)
  const error = invalidArgument(() => validate('RecordPatch', { subjects }))
  assert.equal(error.details.field, 'subjects')
})

test('ContextBundle accepts all 8 ContextBlockName values including working and topics', () => {
  assert.deepEqual([...CONTEXT_BLOCK_NAMES], [
    'profile', 'working', 'topics', 'facts', 'lessons', 'recall', 'elsewhere', 'promises',
  ])
  const bundle = validate('ContextBundle', {
    profileVersion: 2,
    stable: 'stable',
    blocks: CONTEXT_BLOCK_NAMES.map((name) => ({ name, items: [] })),
    truncated: false,
  })
  assert.ok(bundle)
  invalidArgument(() => validate('ContextBundle', {
    profileVersion: 2,
    stable: 'stable',
    blocks: [{ name: 'unknown_block', items: [] }],
    truncated: false,
  }))
})

test('SearchRequest accepts neighbors 0..10 and history boolean, and rejects out-of-range neighbors', () => {
  const zero = validate('SearchRequest', { query: 'tea', scope: 'here', neighbors: 0, history: false }) as Record<string, unknown>
  assert.equal(zero.neighbors, 0)
  assert.equal(zero.history, false)

  const ten = validate('SearchRequest', { query: 'tea', scope: 'all', neighbors: 10, history: true }) as Record<string, unknown>
  assert.equal(ten.neighbors, 10)
  assert.equal(ten.history, true)

  for (const badNeighbors of [-1, 11]) {
    const error = invalidArgument(() => validate('SearchRequest', { query: 'tea', scope: 'here', neighbors: badNeighbors }))
    assert.equal(error.details.field, 'neighbors')
  }
  const badHistory = invalidArgument(() => validate('SearchRequest', { query: 'tea', scope: 'here', history: 'yes' }))
  assert.equal(badHistory.details.field, 'history')
})

test('SearchHit passes with and without neighbors and history', () => {
  const baseHit = {
    record: validRecord,
    disclosure: { speakable: 'yes', label: 'told you' },
    score: 0.75,
  }
  assert.ok(validate('SearchHit', baseHit))

  const fullHit = {
    ...baseHit,
    neighbors: [
      {
        record: { ...validRecord, id: 'l0_01A', layer: 'L0', kind: 'chat.message', evidence: [] },
        disclosure: { speakable: 'yes', label: 'told you' },
        position: 'before',
      },
      {
        record: { ...validRecord, id: 'l0_01B', layer: 'L0', kind: 'chat.message', evidence: [] },
        disclosure: { speakable: 'if-subject-raises', label: 'mentioned elsewhere' },
        position: 'after',
      },
    ],
    history: [
      {
        id: 'l1_01OLD',
        key: 'drink',
        value: 'coffee',
        text: 'used to prefer coffee',
        changedAt: 1000,
        status: 'outdated',
        label: '已变更',
      },
      {
        key: 'profile.city',
        value: 'Shanghai',
        text: 'lived in Shanghai',
        changedAt: 2000,
        status: 'archived',
        label: '已变更',
      },
    ],
  }
  assert.deepEqual(validate('SearchHit', fullHit), fullHit)
  const badPosition = invalidArgument(() => validate('SearchNeighbor', {
    record: validRecord,
    disclosure: { speakable: 'yes', label: 'told you' },
    position: 'around',
  }))
  assert.equal(badPosition.details.field, 'position')
  const badStatus = invalidArgument(() => validate('SearchHistoryItem', {
    key: 'drink',
    value: 'coffee',
    text: 'old',
    changedAt: 1,
    status: 'tombstoned',
    label: '已变更',
  }))
  assert.equal(badStatus.details.field, 'status')
})
