import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { bigrams, bigramQuery } from '../src/bigram.ts'

test('trigram tokenizing cannot find a two-character Chinese word, which is why we do not use it', () => {
  const db = new DatabaseSync(':memory:')
  db.exec("create virtual table t using fts5(c, tokenize='trigram')")
  db.prepare('insert into t values (?)').run('她今天读了一篇关于记忆的文章')
  const count = (term: string) => (db.prepare('select count(*) n from t where t match ?').get(`"${term}"`) as { n: number }).n
  assert.equal(count('关于记'), 1)
  assert.equal(count('记忆'), 0)
})

test('application-level bigrams find two-character Chinese words and keep Latin words whole', () => {
  const db = new DatabaseSync(':memory:')
  db.exec("create virtual table t using fts5(c, tokenize='unicode61')")
  const insert = db.prepare('insert into t values (?)')
  insert.run(bigrams('她今天读了一篇关于记忆的文章'))
  insert.run(bigrams('The Brain SDK 发布了'))
  const count = (term: string) => (db.prepare('select count(*) n from t where t match ?').get(bigramQuery(term)) as { n: number }).n
  assert.equal(count('记忆'), 1)
  assert.equal(count('关于记忆'), 1)
  assert.equal(count('忆记'), 0)
  assert.equal(count('brain'), 1)
  assert.equal(count('发布'), 1)
  assert.equal(count('sdk 发布'), 1)
})

test('PERF: search stays usable at 100k records', () => {
  const db = new DatabaseSync(':memory:')
  db.exec("create virtual table t using fts5(c, tokenize='unicode61')")
  const started = performance.now()
  const insert = db.prepare('insert into t values (?)')
  db.exec('begin')
  for (let i = 0; i < 100_000; i += 1) insert.run(bigrams(`第${i}条消息，今天聊到了编号${i % 997}的话题和一些别的内容`))
  db.exec('commit')
  const inserted = performance.now()
  const search = db.prepare('select rowid from t where t match ? limit 20')
  const samples: number[] = []
  for (let i = 0; i < 50; i += 1) {
    const before = performance.now()
    assert.ok(search.all(bigramQuery(`编号${i}的话题`)).length > 0)
    samples.push(performance.now() - before)
  }
  samples.sort((a, b) => a - b)
  console.log(`node:sqlite ${process.version}: insert 100k = ${(inserted - started).toFixed(0)} ms, search p95 = ${samples[47]?.toFixed(2)} ms`)
  assert.ok((samples[47] ?? Infinity) < 300)
})
