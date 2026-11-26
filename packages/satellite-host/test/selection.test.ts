import assert from 'node:assert/strict'
import test from 'node:test'
import { requireSelection, SelectionMissingError } from '../src/selection.ts'

test('a complete selection passes through unchanged', () => {
  const selection = { provider: 'deepseek-official', model: 'any-id-the-owner-typed', effort: 'low' }
  assert.deepEqual(requireSelection(selection, 'chat'), selection)
})

test('nothing is defaulted when the owner has not chosen', () => {
  assert.throws(() => requireSelection(undefined, 'chat'), SelectionMissingError)
  assert.throws(() => requireSelection({ provider: 'deepseek-official', effort: 'low' }, 'activity'), /no model/)
  assert.throws(() => requireSelection({ provider: 'deepseek-official', model: 'm' }, 'chat'), /no effort/)
  assert.throws(() => requireSelection({ provider: ' ', model: 'm', effort: 'low' }, 'chat'), /no provider/)
})

test('an effort outside the known list is rejected', () => {
  assert.throws(() => requireSelection({ provider: 'p', model: 'm', effort: 'extreme' }, 'chat'), RangeError)
})
