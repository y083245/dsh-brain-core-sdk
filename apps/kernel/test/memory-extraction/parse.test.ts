import assert from 'node:assert/strict'
import test from 'node:test'
import type { MemoryRecord } from '@dsh-brain-core/sdk'
import { parseExtraction } from '../../src/memory-extraction/index.ts'
import { World } from './helpers.ts'

async function fixture(): Promise<MemoryRecord> {
  const w = new World()
  return w.l0({ subjects: ['p_alice'], content: { text: '我的生日是5月20日' } })
}

function fact(record: MemoryRecord, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'l1.fact',
    text: 'p_alice 的生日是 5 月 20 日',
    subjects: ['p_alice'],
    evidence: [record.id],
    confidence: 0.9,
    ...overrides,
  }
}

function output(facts: readonly unknown[]): string {
  return JSON.stringify({ facts })
}

test('accepts a compliant reply, with or without a fence', async () => {
  const record = await fixture()
  const body = output([fact(record, { key: '生日', value: '5月20日' })])

  const parsed = parseExtraction(body, [record])
  assert.deepEqual(parsed, [{
    kind: 'l1.fact',
    text: 'p_alice 的生日是 5 月 20 日',
    subjects: ['p_alice'],
    evidence: [record.id],
    confidence: 0.9,
    key: '生日',
    value: '5月20日',
  }])
  assert.deepEqual(parseExtraction(`\`\`\`json\n${body}\n\`\`\``, [record]), parsed)
  assert.deepEqual(parseExtraction(`\`\`\`\n${body}\n\`\`\``, [record]), parsed)
  assert.deepEqual(parseExtraction('  \n{"facts":[]}\n  ', [record]), [])
  assert.deepEqual(parseExtraction(output(Array.from({ length: 50 }, () => fact(record))), [record])?.length, 50)
})

test('rejects the whole reply when any single rule breaks', async (t) => {
  const record = await fixture()
  const cases: Array<[string, string]> = [
    ['not JSON', '抱歉，我做不到'],
    ['a top-level array', '[]'],
    ['a missing facts key', JSON.stringify({ data: [] })],
    ['an extra top-level key', JSON.stringify({ facts: [], note: 'x' })],
    ['an extra fact key', output([fact(record, { extra: 1 })])],
    ['an L2 kind', output([fact(record, { kind: 'l2.scene' })])],
    ['an empty text', output([fact(record, { text: '' })])],
    ['a 501-character text', output([fact(record, { text: 'x'.repeat(501) })])],
    ['no subjects', output([fact(record, { subjects: [] })])],
    ['eleven subjects', output([fact(record, { subjects: Array.from({ length: 11 }, () => 'p_alice') })])],
    ['a subject never seen', output([fact(record, { subjects: ['p_bob'] })])],
    ['no evidence', output([fact(record, { evidence: [] })])],
    ['twenty-one evidence ids', output([fact(record, { evidence: Array.from({ length: 21 }, () => record.id) })])],
    ['evidence outside the batch', output([fact(record, { evidence: ['l0_01ZZZZZZZZZZZZZZZZZZZZZZZZ'] })])],
    ['confidence above one', output([fact(record, { confidence: 1.5 })])],
    ['confidence below zero', output([fact(record, { confidence: -0.1 })])],
    ['an empty key', output([fact(record, { key: '' })])],
    ['a 51-character key', output([fact(record, { key: 'x'.repeat(51) })])],
    ['an empty value', output([fact(record, { value: '' })])],
    ['a 201-character value', output([fact(record, { value: 'x'.repeat(201) })])],
    ['more than 50 facts', output(Array.from({ length: 51 }, () => fact(record)))],
  ]

  for (const [name, body] of cases) {
    await t.test(name, () => {
      assert.equal(parseExtraction(body, [record]), null)
    })
  }
})

test('self and the actor are valid subjects', async () => {
  const record = await fixture()
  const parsed = parseExtraction(output([fact(record, { subjects: ['self', 'p_alice'] })]), [record])
  assert.deepEqual(parsed?.[0]?.subjects, ['self', 'p_alice'])
})

test('the actor of an L0 record is a valid subject', async () => {
  const w = new World()
  const record = await w.l0({ actor: 'p_bob', subjects: ['p_alice'], content: { text: 'bob 说' } })

  const parsed = parseExtraction(output([fact(record, { subjects: ['p_bob'] })]), [record])
  assert.deepEqual(parsed?.[0]?.subjects, ['p_bob'])
})
