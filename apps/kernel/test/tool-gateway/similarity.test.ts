import assert from 'node:assert/strict'
import test from 'node:test'
import { dice, significantLength, squash } from '../../src/tool-gateway/similarity.ts'

test('squash drops whitespace and punctuation of any script and lowercases', () => {
  assert.equal(squash('  Hello, 世界！ 今天…\n好 '), 'hello世界今天好')
  assert.equal(squash('，。！？ .,!?'), '')
})

test('significantLength counts characters, not UTF-16 units', () => {
  assert.equal(significantLength('你好，世界'), 4)
  assert.equal(significantLength('😀😀你好'), 4)
  assert.equal(significantLength(' ,. '), 0)
})

test('dice of identical text is 1 and of disjoint text is 0', () => {
  assert.equal(dice('今天天气很好', '今天天气很好'), 1)
  assert.equal(dice('今天天气很好', 'abcdef'), 0)
})

test('dice is the symmetric bigram overlap, ignoring punctuation and case', () => {
  // bigrams {ab, bc, cd} and {bc, cd, de}: 2 * 2 / 6
  assert.ok(Math.abs(dice('abcd', 'bcde') - 2 / 3) < 1e-9)
  assert.equal(dice('abcd', 'bcde'), dice('bcde', 'abcd'))
  assert.equal(dice('A, B C!D', 'abcd'), 1)
})

test('dice treats a one-character text as a single gram and an empty text as no match', () => {
  assert.equal(dice('猫', '猫'), 1)
  assert.equal(dice('猫', '狗'), 0)
  assert.equal(dice('', ''), 0)
  assert.equal(dice('', '猫'), 0)
  assert.equal(dice('，', '。'), 0)
})
