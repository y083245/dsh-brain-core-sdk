import assert from 'node:assert/strict'
import test from 'node:test'
import { channelKind, channelMatches, patternsOverlap } from '../../src/tool-gateway/channels.ts'

test('channelMatches compares the first two segments and honours * on either', () => {
  assert.equal(channelMatches(['qq:group'], 'qq:group:123'), true)
  assert.equal(channelMatches(['qq:group'], 'qq:private:123'), false)
  assert.equal(channelMatches(['qq:group'], 'tg:group:123'), false)
  assert.equal(channelMatches(['qq:*'], 'qq:private:9'), true)
  assert.equal(channelMatches(['*:group'], 'tg:group:9'), true)
  assert.equal(channelMatches(['*:group'], 'tg:private:9'), false)
  assert.equal(channelMatches(['*:*'], 'anything:else:1'), true)
  assert.equal(channelMatches(['a:b', 'qq:group'], 'qq:group:1'), true)
})

test('channelMatches ignores the id segment and malformed patterns', () => {
  assert.equal(channelMatches(['qq:group:123'], 'qq:group:123'), false)
  assert.equal(channelMatches(['qq'], 'qq:group:1'), false)
  assert.equal(channelMatches([], 'qq:group:1'), false)
  assert.equal(channelMatches(['*:*'], 'qq'), false)
})

test('channelKind is the second segment', () => {
  assert.equal(channelKind('qq:private:1'), 'private')
  assert.equal(channelKind('qq:group:1'), 'group')
})

test('patternsOverlap treats * on either side as a match and rejects malformed patterns', () => {
  assert.equal(patternsOverlap(['qq:*'], 'qq:group'), true)
  assert.equal(patternsOverlap(['qq:private'], 'qq:group'), false)
  assert.equal(patternsOverlap(['*:*'], 'qq:group'), true)
  assert.equal(patternsOverlap(['qq:group'], '*:*'), true)
  assert.equal(patternsOverlap(['tg:*'], 'qq:*'), false)
  assert.throws(() => patternsOverlap(['*:*'], 'qq'), RangeError)
})

// Review round 1 (PR #28)

test('a channel id with only two segments matches no pattern, not even *:*', () => {
  assert.equal(channelMatches(['*:*'], 'a:b'), false)
  assert.equal(channelMatches(['a:b'], 'a:b'), false)
  assert.equal(channelMatches(['a:*', '*:b', '*:*'], 'a:b'), false)
  assert.equal(channelKind('a:b'), '')
  assert.equal(channelMatches(['*:*'], 'a:b:c'), true, 'three segments is the smallest channel id')
})
