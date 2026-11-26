import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { MemoryRecord } from '@brain-core/sdk'
import { checkPlugin } from '@brain-core/testkit'
import { createSampleIndex } from '../src/indexer.ts'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function makeRecord(id: string, text: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id,
    layer: 'L0',
    kind: 'qq.message',
    source: 'qq',
    channel: 'qq:private:1',
    subjects: ['alice'],
    actor: 'alice',
    content: { text },
    evidence: [],
    visibility: 'origin',
    trust: 'member',
    confidence: 1,
    importance: 0.5,
    tEvent: 1000,
    tIngest: 1000,
    status: 'active',
    version: 1,
    ...overrides,
  }
}

test('manifest passes checkPlugin and zero runtime third-party dependencies', async () => {
  const pkg = JSON.parse(await readFile(path.join(PLUGIN_ROOT, 'package.json'), 'utf8')) as {
    readonly dependencies?: Record<string, string>
  }
  assert.equal(pkg.dependencies, undefined)

  const report = await checkPlugin(PLUGIN_ROOT)
  assert.equal(report.ok, true, JSON.stringify(report.findings))
  assert.equal(report.findings.filter((f) => f.level === 'must').length, 0)
  assert.equal(report.findings.filter((f) => f.level === 'should').length, 0)
})

test('createSampleIndex indexes tokens, applies filters, and erases on forget without storing raw text', () => {
  const index = createSampleIndex()
  index.upsert(makeRecord('r1', '喜欢喝乌龙茶', { channel: 'qq:private:1', subjects: ['alice'], tEvent: 100 }))
  index.upsert(makeRecord('r2', '喜欢喝咖啡', { channel: 'qq:group:9', subjects: ['bob'], tEvent: 200 }))
  index.upsert(makeRecord('r3', 'outdated text', { status: 'outdated' }))
  index.upsert(makeRecord('r4', 'self profile', { layer: 'L3' }))

  assert.equal(index.size(), 2)
  assert.equal(index.has('r3'), false)
  assert.equal(index.has('r4'), false)

  const hits = index.search({ query: '乌龙茶', limit: 5 })
  assert.equal(hits[0]?.id, 'r1')

  const filtered = index.search({
    query: '喜欢',
    channels: ['qq:group:9'],
    subjects: ['bob'],
    from: 150,
    to: 250,
    limit: 5,
  })
  assert.deepEqual(filtered.map((h) => h.id), ['r2'])

  index.forget(['r1'])
  assert.equal(index.has('r1'), false)
  assert.deepEqual(index.search({ query: '乌龙茶', limit: 5 }), [])
})

test('child process speaks JSON-RPC 2.0 over stdio: readL0 pagination, search, writeDerived, forget, shutdown', async () => {
  const child = spawn(process.execPath, ['src/index.ts'], {
    cwd: PLUGIN_ROOT,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const messages: Record<string, unknown>[] = []
  const waiters: ((msg: Record<string, unknown>) => boolean)[] = []
  let buffer = ''

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    for (;;) {
      const idx = buffer.indexOf('\n')
      if (idx === -1) break
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (line === '') continue
      const parsed = JSON.parse(line) as Record<string, unknown>
      messages.push(parsed)
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        if (waiters[i]!(parsed)) waiters.splice(i, 1)
      }
    }
  })

  const waitForMessage = (predicate: (msg: Record<string, unknown>) => boolean, timeoutMs = 5000): Promise<Record<string, unknown>> => {
    const existing = messages.find(predicate)
    if (existing !== undefined) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for child message')), timeoutMs)
      waiters.push((msg) => {
        if (!predicate(msg)) return false
        clearTimeout(timer)
        resolve(msg)
        return true
      })
    })
  }

  const send = (msg: Record<string, unknown>): void => {
    child.stdin.write(`${JSON.stringify(msg)}\n`)
  }

  const exitPromise = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code))
  })

  try {
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { apiVersion: '1.0.0', pluginId: 'memory-provider-sample', version: '0.0.0', config: {}, permissions: ['memory.readL0', 'memory.writeDerived'] },
    })
    const initResp = await waitForMessage((m) => m.id === 1 && !('method' in m))
    assert.deepEqual(initResp.result, { apiVersion: '1.0.0' })

    const readReq1 = await waitForMessage((m) => m.method === 'memory.readL0')
    send({
      jsonrpc: '2.0',
      id: readReq1.id,
      result: {
        items: [makeRecord('l0_1', '周末去看电影')],
        nextCursor: 'l0_1',
      },
    })

    const readReq2 = await waitForMessage((m) => m.method === 'memory.readL0' && m.id !== readReq1.id)
    assert.equal((readReq2.params as { request: { afterId: string } }).request.afterId, 'l0_1')
    send({
      jsonrpc: '2.0',
      id: readReq2.id,
      result: {
        items: [makeRecord('l0_2', '平时喜欢写代码')],
      },
    })

    const provideReq = await waitForMessage((m) => m.method === 'memory.provide')
    send({ jsonrpc: '2.0', id: provideReq.id, result: null })

    await waitForMessage((m) => m.method === 'plugin.ready')

    // Search initial records
    send({ jsonrpc: '2.0', id: 2, method: 'memoryProvider.search', params: { query: { query: '电影', limit: 5 } } })
    const searchResp = await waitForMessage((m) => m.id === 2 && !('method' in m))
    assert.equal((searchResp.result as { id: string }[])[0]?.id, 'l0_1')

    // Record with trigger prefix -> triggers memory.writeDerived
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'memoryProvider.onRecord',
      params: { record: makeRecord('l0_3', '记住：明天下午三点开会') },
    })
    const derivedReq = await waitForMessage((m) => m.method === 'memory.writeDerived')
    const derivedInput = (derivedReq.params as { input: { content: { text: string }; evidence: { id: string }[] } }).input
    assert.equal(derivedInput.content.text, '明天下午三点开会')
    assert.deepEqual(derivedInput.evidence, [{ id: 'l0_3' }])
    send({ jsonrpc: '2.0', id: derivedReq.id, result: makeRecord('l1_1', '明天下午三点开会', { layer: 'L1', kind: 'l1.candidate' }) })
    await waitForMessage((m) => m.id === 3 && !('method' in m))

    // Forget l0_3
    send({ jsonrpc: '2.0', id: 4, method: 'memoryProvider.onForgotten', params: { ids: ['l0_3'] } })
    await waitForMessage((m) => m.id === 4 && !('method' in m))

    send({ jsonrpc: '2.0', id: 5, method: 'memoryProvider.search', params: { query: { query: '开会', limit: 5 } } })
    const searchAfterForget = await waitForMessage((m) => m.id === 5 && !('method' in m))
    assert.deepEqual(searchAfterForget.result, [])

    send({ jsonrpc: '2.0', id: 6, method: 'memoryProvider.health', params: {} })
    const healthResp = await waitForMessage((m) => m.id === 6 && !('method' in m))
    assert.deepEqual(healthResp.result, { status: 'ok' })

    send({ jsonrpc: '2.0', method: 'shutdown' })
    const code = await exitPromise
    assert.equal(code, 0)
  } finally {
    if (child.exitCode === null) child.kill()
  }
})

test('createSampleIndex filters layers, channels, subjects, from, and to independently without cross-masking', () => {
  const index = createSampleIndex()
  const sharedText = '共同关键词苹果派'

  index.upsert(makeRecord('base', sharedText, { layer: 'L0', channel: 'qq:private:1', subjects: ['alice'], tEvent: 500 }))
  index.upsert(makeRecord('only_layer', sharedText, { layer: 'L1', channel: 'qq:private:1', subjects: ['alice'], tEvent: 500 }))
  index.upsert(makeRecord('only_channel', sharedText, { layer: 'L0', channel: 'qq:group:2', subjects: ['alice'], tEvent: 500 }))
  index.upsert(makeRecord('only_subject', sharedText, { layer: 'L0', channel: 'qq:private:1', subjects: ['bob'], tEvent: 500 }))
  index.upsert(makeRecord('only_early', sharedText, { layer: 'L0', channel: 'qq:private:1', subjects: ['alice'], tEvent: 400 }))
  index.upsert(makeRecord('only_late', sharedText, { layer: 'L0', channel: 'qq:private:1', subjects: ['alice'], tEvent: 600 }))

  const byLayer = index.search({ query: '苹果派', layers: ['L1'], limit: 10 }).map((h) => h.id)
  assert.deepEqual(byLayer, ['only_layer'])
  const excludeLayer = index.search({ query: '苹果派', layers: ['L0'], limit: 10 }).map((h) => h.id)
  assert.equal(excludeLayer.includes('only_layer'), false)
  assert.equal(excludeLayer.includes('base'), true)

  const byChannel = index.search({ query: '苹果派', channels: ['qq:group:2'], limit: 10 }).map((h) => h.id)
  assert.deepEqual(byChannel, ['only_channel'])
  const excludeChannel = index.search({ query: '苹果派', channels: ['qq:private:1'], limit: 10 }).map((h) => h.id)
  assert.equal(excludeChannel.includes('only_channel'), false)
  assert.equal(excludeChannel.includes('base'), true)

  const bySubject = index.search({ query: '苹果派', subjects: ['bob'], limit: 10 }).map((h) => h.id)
  assert.deepEqual(bySubject, ['only_subject'])
  const excludeSubject = index.search({ query: '苹果派', subjects: ['alice'], limit: 10 }).map((h) => h.id)
  assert.equal(excludeSubject.includes('only_subject'), false)
  assert.equal(excludeSubject.includes('base'), true)

  const byFromExact = index.search({ query: '苹果派', from: 600, limit: 10 }).map((h) => h.id)
  assert.deepEqual(byFromExact, ['only_late'])
  const byFromBoundary = index.search({ query: '苹果派', from: 500, limit: 10 }).map((h) => h.id)
  assert.equal(byFromBoundary.includes('only_early'), false)
  assert.equal(byFromBoundary.includes('base'), true)
  assert.equal(byFromBoundary.includes('only_late'), true)

  const byToExact = index.search({ query: '苹果派', to: 400, limit: 10 }).map((h) => h.id)
  assert.deepEqual(byToExact, ['only_early'])
  const byToBoundary = index.search({ query: '苹果派', to: 500, limit: 10 }).map((h) => h.id)
  assert.equal(byToBoundary.includes('only_late'), false)
  assert.equal(byToBoundary.includes('base'), true)
  assert.equal(byToBoundary.includes('only_early'), true)
})
