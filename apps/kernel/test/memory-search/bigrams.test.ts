import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { bigramQuery, bigrams } from '../../src/memory-search/index.ts'

test('CJK runs split into overlapping bigrams while Latin words stay whole', () => {
  assert.equal(bigrams('她今天读了一篇关于记忆的文章'), '她今 今天 天读 读了 了一 一篇 篇关 关于 于记 记忆 忆的 的文 文章')
  assert.equal(bigrams('The Brain SDK 发布了'), 'The Brain SDK 发布 布了')
  assert.equal(bigrams('猫'), '猫')
  assert.equal(bigrams('  hello   咖啡  '), 'hello 咖啡')
})

test('bigramQuery drops parts that hold no letter or digit', () => {
  assert.equal(bigramQuery('hello 咖啡'), '"hello" AND "咖啡"')
  assert.equal(bigramQuery('记忆 "'), '"记忆"')
  assert.equal(bigramQuery('hello !'), '"hello"')
  assert.equal(bigramQuery('!!!'), '')
  assert.equal(bigramQuery('   '), '')
  assert.equal(bigramQuery('""""'), '')
})

test('application-level bigrams find two-character Chinese words and keep Latin words whole', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec("create virtual table t using fts5(c, tokenize='unicode61')")
    const insert = db.prepare('insert into t values (?)')
    insert.run(bigrams('她今天读了一篇关于记忆的文章'))
    insert.run(bigrams('The Brain SDK 发布了'))
    const count = (term: string) =>
      (db.prepare('select count(*) n from t where t match ?').get(bigramQuery(term)) as { readonly n: number }).n
    assert.equal(count('记忆'), 1)
    assert.equal(count('关于记忆'), 1)
    assert.equal(count('忆记'), 0)
    assert.equal(count('brain'), 1)
    assert.equal(count('发布'), 1)
    assert.equal(count('sdk 发布'), 1)
  } finally {
    db.close()
  }
})
