import assert from 'node:assert/strict'
import test from 'node:test'
import type { Viewer } from '@brain-core/sdk'
import { expandScope, indexText } from '../../src/memory-search/index.ts'
import { makeRecord } from './helpers.ts'

test('indexText joins every string under content in key order, arrays by position', () => {
  const record = makeRecord({
    content: {
      second: 'two',
      first: 'one',
      nested: { z: 'three', a: ['four', { deep: 'five' }] },
      count: 7,
      flag: false,
      empty: null,
    },
  })
  assert.equal(indexText(record), 'two one three four five')
})

test('indexText ignores the record metadata', () => {
  const record = makeRecord({ channel: 'chan-meta', subjects: ['alice-meta'], content: { text: 'body' } })
  assert.equal(indexText(record), 'body')
})

function viewer(channel: string | null, participants: readonly string[] = []): Viewer {
  return { caller: 'agent', channel, participants }
}

test('expandScope here uses the viewer channel and finds nothing without one', () => {
  assert.deepEqual(expandScope('here', viewer('chan-1')), { channels: ['chan-1'] })
  assert.deepEqual(expandScope('here', viewer(null)), { channels: [] })
})

test('expandScope person uses everyone present and allows none', () => {
  assert.deepEqual(expandScope('person', viewer('chan-1', ['alice', 'bob'])), { subjects: ['alice', 'bob'] })
  assert.deepEqual(expandScope('person', viewer('chan-1')), { subjects: [] })
})

test('expandScope all adds no filter', () => {
  assert.deepEqual(expandScope('all', viewer('chan-1', ['alice'])), {})
})
