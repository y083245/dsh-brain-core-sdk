import assert from 'node:assert/strict'
import test from 'node:test'
import { diffStableText } from '../../web/src/pages/heart/diff.ts'

test('compares individual Han characters and entire English words', () => {
  assert.deepEqual(diffStableText('她喜欢 cats。', '她爱 dogs。'), [
    { kind: 'same', text: '她' },
    { kind: 'removed', text: '喜欢' },
    { kind: 'added', text: '爱' },
    { kind: 'same', text: ' ' },
    { kind: 'removed', text: 'cats' },
    { kind: 'added', text: 'dogs' },
    { kind: 'same', text: '。' },
  ])
})

test('preserves whitespace, repeated tokens, punctuation and Unicode in both versions', () => {
  const before = '旧版\r\none, one two 🎈'
  const after = '新版\none two, one ✦'
  const spans = diffStableText(before, after)
  assert.equal(spans.filter(({ kind }) => kind !== 'added').map(({ text }) => text).join(''), before)
  assert.equal(spans.filter(({ kind }) => kind !== 'removed').map(({ text }) => text).join(''), after)
})

test('handles identical and empty values', () => {
  assert.deepEqual(diffStableText('', ''), [])
  assert.deepEqual(diffStableText('', '新墨'), [{ kind: 'added', text: '新墨' }])
  assert.deepEqual(diffStableText('旧墨', ''), [{ kind: 'removed', text: '旧墨' }])
  assert.deepEqual(diffStableText('手卷 unchanged', '手卷 unchanged'), [{ kind: 'same', text: '手卷 unchanged' }])
})
