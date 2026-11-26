import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { isHardened } from '@brain-core/shared'
import type { MemoryRecord } from '@brain-core/sdk'
import type { IndexQuery, KeywordIndex } from '../../src/contracts/index.ts'
import { createKeywordIndex, expandScope } from '../../src/memory-search/index.ts'
import { makeRecord } from './helpers.ts'

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'brain-memory-search-'))
}

async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 })
}

async function ids(index: KeywordIndex, text: string, extra: Partial<IndexQuery> = {}): Promise<string[]> {
  const hits = await index.search({ text, limit: 100, ...extra })
  return hits.map((hit) => hit.id)
}

async function* iterable(records: readonly MemoryRecord[]): AsyncIterable<MemoryRecord> {
  for (const record of records) yield record
}

test('Chinese bigrams, Latin words and mixed queries follow AND semantics', async () => {
  const dir = await tempDir()
  const index = await createKeywordIndex({ path: path.join(dir, 'index.db') })
  try {
    await index.add(makeRecord({ id: 'l1_a', content: { text: '我的记忆很好' } }))
    await index.add(makeRecord({ id: 'l1_b', content: { text: 'Hello 咖啡' } }))
    await index.add(makeRecord({ id: 'l1_c', content: { text: 'hello only' } }))

    assert.deepEqual(await ids(index, '记忆'), ['l1_a'])
    assert.deepEqual(await ids(index, '忆记'), [])
    assert.deepEqual(await ids(index, 'hello'), ['l1_b', 'l1_c'])
    assert.deepEqual(await ids(index, 'HELLO'), ['l1_b', 'l1_c'])
    assert.deepEqual(await ids(index, 'hello 咖啡'), ['l1_b'])
    assert.deepEqual(await ids(index, '咖啡 记忆'), [])
  } finally {
    await index.close()
    await removeDir(dir)
  }
})

test('FTS5 syntax characters are searched as text, never interpreted', async () => {
  const dir = await tempDir()
  const index = await createKeywordIndex({ path: path.join(dir, 'index.db') })
  try {
    await index.add(makeRecord({ id: 'l1_memory', content: { text: '我的记忆很好' } }))
    await index.add(makeRecord({ id: 'l1_hello', content: { text: 'hello world' } }))

    for (const text of ['"', 'AND', 'OR', '*', '(x)', 'NEAR(', 'col:hello', 'hello OR 记忆']) {
      await assert.doesNotReject(async () => { await index.search({ text, limit: 10 }) }, `query ${text} threw`)
    }
    assert.deepEqual(await ids(index, '记忆 "'), ['l1_memory'])
    assert.deepEqual(await ids(index, 'hello !'), ['l1_hello'])
    assert.deepEqual(await ids(index, '!!!'), [])
    assert.deepEqual(await ids(index, '""""'), [])
    assert.deepEqual(await ids(index, '*'), [])
  } finally {
    await index.close()
    await removeDir(dir)
  }
})

test('layer, channel, subject and inclusive time filters narrow the result', async () => {
  const dir = await tempDir()
  const index = await createKeywordIndex({ path: path.join(dir, 'index.db') })
  try {
    await index.add(makeRecord({ id: 'l1_a', layer: 'L1', channel: 'c1', subjects: ['alice'], tEvent: 100, content: { text: 'shared keyword' } }))
    await index.add(makeRecord({ id: 'l2_b', layer: 'L2', channel: 'c2', subjects: ['bob'], tEvent: 200, content: { text: 'shared keyword' } }))
    await index.add(makeRecord({ id: 'l1_c', layer: 'L1', channel: 'c1', subjects: ['bob'], tEvent: 300, content: { text: 'shared keyword' } }))

    assert.deepEqual(await ids(index, 'shared'), ['l1_a', 'l1_c', 'l2_b'])
    assert.deepEqual(await ids(index, 'shared', { layers: ['L2'] }), ['l2_b'])
    assert.deepEqual(await ids(index, 'shared', { channels: ['c1'] }), ['l1_a', 'l1_c'])
    assert.deepEqual(await ids(index, 'shared', { subjects: ['alice'] }), ['l1_a'])
    assert.deepEqual(await ids(index, 'shared', { subjects: ['alice', 'bob'] }), ['l1_a', 'l1_c', 'l2_b'])
    assert.deepEqual(await ids(index, 'shared', { from: 200 }), ['l1_c', 'l2_b'])
    assert.deepEqual(await ids(index, 'shared', { to: 100 }), ['l1_a'])
    assert.deepEqual(await ids(index, 'shared', { from: 100, to: 200 }), ['l1_a', 'l2_b'])
    assert.deepEqual(await ids(index, 'shared', { layers: ['L1'], channels: ['c1'], subjects: ['bob'] }), ['l1_c'])

    assert.deepEqual(await ids(index, 'shared', { layers: [] }), [])
    assert.deepEqual(await ids(index, 'shared', { channels: [] }), [])
    assert.deepEqual(await ids(index, 'shared', { subjects: [] }), [])
    assert.deepEqual(await ids(index, '   '), [])
  } finally {
    await index.close()
    await removeDir(dir)
  }
})

test('hits come best first, ties by id, and limit applies', async () => {
  const dir = await tempDir()
  const index = await createKeywordIndex({ path: path.join(dir, 'index.db') })
  try {
    await index.add(makeRecord({ id: 'l1_dense', content: { text: 'coffee coffee coffee coffee' } }))
    await index.add(makeRecord({ id: 'l1_sparse', content: { text: 'coffee and a longer sentence with other words' } }))
    await index.add(makeRecord({ id: 'l1_tie_b', content: { text: 'tied word' } }))
    await index.add(makeRecord({ id: 'l1_tie_a', content: { text: 'tied word' } }))

    const coffee = await index.search({ text: 'coffee', limit: 10 })
    assert.deepEqual(coffee.map((hit) => hit.id), ['l1_dense', 'l1_sparse'])
    for (let at = 1; at < coffee.length; at += 1) assert.ok(coffee[at - 1]!.score >= coffee[at]!.score)
    assert.deepEqual(await ids(index, 'tied'), ['l1_tie_a', 'l1_tie_b'])
    assert.equal((await index.search({ text: 'coffee', limit: 1 })).length, 1)
  } finally {
    await index.close()
    await removeDir(dir)
  }
})

test('add replaces an id and drops entries that are no longer active', async () => {
  const dir = await tempDir()
  const index = await createKeywordIndex({ path: path.join(dir, 'index.db') })
  try {
    await index.add(makeRecord({ id: 'l1_same', content: { text: 'firstword' } }))
    await index.add(makeRecord({ id: 'l1_same', content: { text: 'secondword' } }))
    assert.deepEqual(await ids(index, 'firstword'), [])
    assert.deepEqual(await ids(index, 'secondword'), ['l1_same'])
    assert.equal((await index.search({ text: 'secondword', limit: 10 })).length, 1)

    await index.add(makeRecord({ id: 'l1_same', status: 'outdated', content: { text: 'secondword' } }))
    assert.deepEqual(await ids(index, 'secondword'), [])

    await index.add(makeRecord({ id: 'l1_never', status: 'archived', content: { text: 'archivedword' } }))
    assert.deepEqual(await ids(index, 'archivedword'), [])

    await index.remove('l1_absent')
  } finally {
    await index.close()
    await removeDir(dir)
  }
})

test('rebuild from the same records reproduces the same searches after the files are gone', async () => {
  const dir = await tempDir()
  const indexPath = path.join(dir, 'index.db')
  const records = Array.from({ length: 200 }, (_, at) => makeRecord({
    id: `l1_r${String(at).padStart(4, '0')}`,
    layer: at % 2 === 0 ? 'L1' : 'L2',
    channel: `chan-${at % 3}`,
    subjects: [`user-${at % 5}`],
    tEvent: at,
    status: at % 10 === 0 ? 'outdated' : 'active',
    content: { text: `标记 主题${at % 10} 内容${at}` },
  }))

  let index = await createKeywordIndex({ path: indexPath })
  const before: Record<string, readonly unknown[]> = {}
  try {
    for (const record of records) await index.add(record)
    for (const [name, query] of Object.entries({
      plain: { text: '标记', limit: 500 },
      filtered: { text: '主题3', limit: 500, layers: ['L1' as const] },
      narrowed: { text: '内容1', limit: 500, channels: ['chan-1'], subjects: ['user-1'] },
    })) before[name] = await index.search(query)
  } finally {
    await index.close()
  }

  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${indexPath}${suffix}`
    if (existsSync(file)) rmSync(file)
  }

  index = await createKeywordIndex({ path: indexPath })
  try {
    const active = records.filter((record) => record.status === 'active').length
    assert.equal(await index.rebuild(iterable(records)), active)
    const after = {
      plain: await index.search({ text: '标记', limit: 500 }),
      filtered: await index.search({ text: '主题3', limit: 500, layers: ['L1'] }),
      narrowed: await index.search({ text: '内容1', limit: 500, channels: ['chan-1'], subjects: ['user-1'] }),
    }
    assert.deepEqual(after, before)
  } finally {
    await index.close()
    await removeDir(dir)
  }
})

test('remove leaves neither English nor Chinese plaintext in the index or the WAL', async () => {
  const dir = await tempDir()
  const indexPath = path.join(dir, 'index.db')
  const marker = 'zqxjwordunique'
  const index = await createKeywordIndex({ path: indexPath })
  try {
    for (let at = 0; at < 200; at += 1) {
      await index.add(makeRecord({ id: `l1_f${String(at).padStart(4, '0')}`, content: { text: `filler number ${at}` } }))
    }
    const marked = makeRecord({ id: 'l1_secret', content: { text: `${marker} 鹦鹉螺号` } })
    await index.add(marked)
    assert.deepEqual(await ids(index, marker), ['l1_secret'])
    assert.deepEqual(await ids(index, '鹦鹉'), ['l1_secret'])

    await index.remove(marked.id)
    assert.deepEqual(await ids(index, marker), [])

    const needles = [Buffer.from(marker, 'utf8'), Buffer.from('鹦鹉', 'utf8')]
    const assertClean = (): void => {
      for (const file of [indexPath, `${indexPath}-wal`]) {
        if (!existsSync(file)) continue
        const bytes = readFileSync(file)
        for (const needle of needles) assert.equal(bytes.includes(needle), false, `${path.basename(file)} still holds ${needle.toString('utf8')}`)
      }
    }
    assertClean()
    await index.close()
    assertClean()
  } finally {
    await index.close()
    await removeDir(dir)
  }
})

test('the index file is private', async () => {
  const dir = await tempDir()
  const indexPath = path.join(dir, 'index.db')
  const index = await createKeywordIndex({ path: indexPath })
  try {
    await index.add(makeRecord({ content: { text: 'private' } }))
    if (process.platform === 'win32') assert.ok(isHardened(indexPath))
    else assert.equal(statSync(indexPath).mode & 0o777, 0o600)
  } finally {
    await index.close()
    await removeDir(dir)
  }
})

test('scope=here only returns records from the viewer channel', async () => {
  const dir = await tempDir()
  const index = await createKeywordIndex({ path: path.join(dir, 'index.db') })
  try {
    await index.add(makeRecord({ id: 'l1_here', channel: 'chan-1', content: { text: 'shared topic' } }))
    await index.add(makeRecord({ id: 'l1_elsewhere', channel: 'chan-2', content: { text: 'shared topic' } }))
    const viewer = { caller: 'agent', channel: 'chan-1', participants: ['alice'] }
    assert.deepEqual(await ids(index, 'shared', expandScope('here', viewer)), ['l1_here'])
    assert.deepEqual(await ids(index, 'shared', expandScope('all', viewer)), ['l1_elsewhere', 'l1_here'])
  } finally {
    await index.close()
    await removeDir(dir)
  }
})

test('PERF: 100k records stay searchable within the latency budget', async () => {
  const dir = await tempDir()
  const index = await createKeywordIndex({ path: path.join(dir, 'index.db') })
  try {
    const records = Array.from({ length: 100_000 }, (_, at) => makeRecord({
      id: `l1_p${String(at).padStart(6, '0')}`,
      layer: at % 2 === 0 ? 'L1' : 'L2',
      channel: `chan-${at % 10}`,
      subjects: [`user-${at % 10}`],
      tEvent: at,
      content: { text: `第${at}条消息，今天聊到了编号${at % 997}的话题和一些别的内容` },
    }))
    const started = performance.now()
    const active = await index.rebuild(iterable(records))
    const inserted = performance.now()
    assert.equal(active, records.length)

    const percentile95 = (samples: number[]): number => {
      samples.sort((a, b) => a - b)
      return samples[Math.floor(samples.length * 0.95) - 1] as number
    }
    const unfiltered: number[] = []
    for (let at = 0; at < 200; at += 1) {
      const before = performance.now()
      const hits = await index.search({ text: `编号${at % 997}的话题`, limit: 20 })
      assert.ok(hits.length > 0)
      unfiltered.push(performance.now() - before)
    }
    const filtered: number[] = []
    for (let at = 0; at < 200; at += 1) {
      const before = performance.now()
      const hits = await index.search({
        text: `编号${at % 997}的话题`,
        layers: ['L2'],
        channels: ['chan-3'],
        subjects: ['user-3'],
        from: 0,
        to: 100_000,
        limit: 20,
      })
      assert.ok(hits.length > 0)
      filtered.push(performance.now() - before)
    }
    const p95Unfiltered = percentile95(unfiltered)
    const p95Filtered = percentile95(filtered)
    console.log(`node:sqlite ${process.version}: rebuild 100k = ${(inserted - started).toFixed(0)} ms, p95 unfiltered = ${p95Unfiltered.toFixed(2)} ms, p95 filtered = ${p95Filtered.toFixed(2)} ms`)
    assert.ok(p95Unfiltered < 300)
    assert.ok(p95Filtered < 300)
  } finally {
    await index.close()
    await removeDir(dir)
  }
})
