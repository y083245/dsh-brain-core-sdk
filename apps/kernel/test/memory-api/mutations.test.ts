import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { BrainError, LIMITS, type ContextBundle, type MemoryRecord } from '@brain-core/sdk'
import type { Clock, CrossChannelMode, KeywordIndex, MemoryService, RecordStore, WriteIdentity } from '../../src/contracts/index.ts'
import { prepareBrainHome } from '../../src/home/index.ts'
import type { Logger } from '../../src/log/index.ts'
import { createMemoryApiServer, openMemory, type Memory } from '../../src/memory-api/index.ts'
import { createJobRunner, type JobRunner } from '../../src/memory-api/jobs.ts'
import {
  agentViewer, facadeOf, openParts, openTempBrain, OWNER_IDENTITY, OWNER_VIEWER, silentLog, startApi,
} from './helpers.ts'

const clock: Clock = { now: () => Date.now() }
const GROUP = 'qq:group:20001'

interface IngestOptions {
  readonly key: string
  readonly channel?: string
  readonly actor?: string
  readonly text?: string
  readonly tEvent?: number
  readonly visibility?: 'open' | 'subject' | 'owner' | 'origin' | 'internal'
}

async function ingest(service: MemoryService, options: IngestOptions): Promise<string> {
  const result = await service.ingest({
    kind: 'chat.message',
    channel: options.channel ?? GROUP,
    subjects: [],
    actor: options.actor ?? 'p_bob',
    content: { text: options.text ?? '群聊' },
    tEvent: options.tEvent ?? clock.now(),
    idempotencyKey: options.key,
    ...(options.visibility === undefined ? {} : { visibility: options.visibility }),
  }, OWNER_IDENTITY)
  return result.id
}

interface WriteOptions {
  readonly text?: string
  readonly content?: Readonly<Record<string, unknown>>
  readonly subjects?: readonly string[]
  readonly channel?: string
  readonly actor?: string
  readonly visibility?: 'open' | 'subject' | 'owner' | 'origin' | 'internal'
}

async function write(service: MemoryService, evidence: string, options: WriteOptions = {}): Promise<MemoryRecord> {
  return service.record({
    layer: 'L1',
    kind: 'l1.fact',
    channel: options.channel ?? GROUP,
    subjects: options.subjects ?? [],
    actor: options.actor ?? 'p_bob',
    content: options.content ?? { text: options.text ?? '事实' },
    evidence: [{ id: evidence }],
    visibility: options.visibility ?? 'open',
  }, OWNER_IDENTITY)
}

function hitIds(hits: readonly { readonly record: { readonly id: string } }[]): string[] {
  return hits.map((hit) => hit.record.id)
}

async function capture(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
    return undefined
  } catch (error) {
    return error
  }
}

function codeOf(error: unknown): string | undefined {
  return error instanceof BrainError ? error.code : undefined
}

function countRows(memoryDir: string, layer: string): number {
  const db = new DatabaseSync(path.join(memoryDir, 'records.db'))
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM records WHERE layer = ?').get(layer) as { n: number }
    return Number(row.n)
  } finally {
    db.close()
  }
}

function storeWith(real: RecordStore, overrides: Partial<RecordStore>): RecordStore {
  return {
    insert: (record, key) => real.insert(record, key),
    get: (id) => real.get(id),
    patch: (id, patch, version) => real.patch(id, patch, version),
    tombstone: (id) => real.tombstone(id),
    list: (filter, page) => real.list(filter, page),
    dependentsOf: (id) => real.dependentsOf(id),
    scan: (layers) => real.scan(layers),
    close: () => real.close(),
    ...overrides,
  }
}

function indexWith(real: KeywordIndex, overrides: Partial<KeywordIndex>): KeywordIndex {
  return {
    add: (record) => real.add(record),
    remove: (id) => real.remove(id),
    search: (query) => real.search(query),
    rebuild: (records) => real.rebuild(records),
    close: () => real.close(),
    ...overrides,
  }
}

/** An index whose next `add` waits for `release`, so a test can see whether its caller waited. */
function gatedIndex(real: KeywordIndex): { readonly index: KeywordIndex; arm(): () => void } {
  let hold: Promise<void> | undefined
  let releaseHold: (() => void) | undefined
  return {
    index: indexWith(real, {
      add: async (record) => {
        if (hold !== undefined) await hold
        await real.add(record)
      },
    }),
    arm() {
      hold = new Promise((resolve) => { releaseHold = resolve })
      return () => {
        const release = releaseHold
        hold = undefined
        releaseHold = undefined
        release?.()
      }
    },
  }
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

test('mut-01: person scope intersects the requested subjects instead of unioning them', async () => {
  const parts = await openParts()
  const service = facadeOf(parts, { crossChannelMode: () => 'on' })
  try {
    const aliceEvidence = await ingest(service, { key: 'm01-a', actor: 'p_alice' })
    await write(service, aliceEvidence, { text: '咖啡给 alice', subjects: ['p_alice'] })
    const bobEvidence = await ingest(service, { key: 'm01-b', actor: 'p_bob' })
    await write(service, bobEvidence, { text: '咖啡给 bob', subjects: ['p_bob'] })

    const hits = await service.search(
      { query: '咖啡', scope: 'person', subjects: ['p_bob'] },
      agentViewer('qq:group:9', ['p_alice']),
    )
    assert.deepEqual(hitIds(hits.items), [])
  } finally {
    await parts.close()
  }
})

test('mut-02: a conclusion-only record without a conclusion is not returned', async () => {
  const parts = await openParts()
  const service = facadeOf(parts)
  try {
    const first = await ingest(service, { key: 'm02-a' })
    await write(service, first, { content: { text: '内部记录有咖啡但没有结论' }, visibility: 'internal' })
    const second = await ingest(service, { key: 'm02-b' })
    await write(service, second, { content: { text: '内部记录有咖啡空结论', conclusion: '' }, visibility: 'internal' })

    const hits = await service.search({ query: '咖啡', scope: 'all' }, agentViewer(GROUP))
    assert.deepEqual(hitIds(hits.items), [])
  } finally {
    await parts.close()
  }
})

test('mut-03: search paginates with a cursor and defaults to 20', async () => {
  const brain = await openTempBrain()
  const api = await startApi(brain.memory)
  try {
    for (let index = 0; index < 25; index += 1) {
      await ingest(brain.memory.service, { key: `m03-${index}`, text: `分页记录 ${index}` })
    }
    await brain.memory.service.flush()

    const first = await brain.memory.service.search({ query: '分页', scope: 'all' }, OWNER_VIEWER)
    assert.equal(first.items.length, 20)
    assert.ok(first.nextCursor !== undefined)

    const second = await brain.memory.service.search(
      { query: '分页', scope: 'all', cursor: first.nextCursor },
      OWNER_VIEWER,
    )
    assert.equal(second.items.length, 5)
    assert.equal(second.nextCursor, undefined)
    const firstIds = new Set(hitIds(first.items))
    assert.equal(hitIds(second.items).some((id) => firstIds.has(id)), false)

    const limited = await brain.memory.service.search({ query: '分页', scope: 'all', limit: 10 }, OWNER_VIEWER)
    assert.equal(limited.items.length, 10)

    for (const cursor of ['abc', Buffer.from(JSON.stringify({ offset: -1 }), 'utf8').toString('base64url')]) {
      const error = await capture(() => brain.memory.service.search({ query: '分页', scope: 'all', cursor }, OWNER_VIEWER))
      assert.equal(codeOf(error), 'INVALID_ARGUMENT')
    }

    const http = await api.request('POST', '/memory/search', { query: '分页', scope: 'all' })
    assert.equal(http.status, 200)
    const meta = (http.body as { meta: { nextCursor?: string } }).meta
    assert.equal(typeof meta.nextCursor, 'string')
  } finally {
    await api.close()
    await brain.close()
  }
})

test('mut-04: a record that is no longer active is not returned', async () => {
  const parts = await openParts()
  const service = facadeOf(parts)
  try {
    const evidence = await ingest(service, { key: 'm04' })
    const record = await write(service, evidence, { text: '咖啡被归档' })
    // Patch the store directly so the index still holds an entry for this id.
    await parts.store.patch(record.id, { status: 'archived' }, 1)

    const hits = await service.search({ query: '咖啡', scope: 'all' }, OWNER_VIEWER)
    assert.deepEqual(hitIds(hits.items), [])
  } finally {
    await parts.close()
  }
})

test('mut-05: update waits for the index write before it returns', async () => {
  const parts = await openParts()
  const gate = gatedIndex(parts.index)
  const service = facadeOf(parts, { index: gate.index })
  try {
    const evidence = await ingest(service, { key: 'm05' })
    await service.flush()
    const record = await write(service, evidence, { text: '旧词' })

    const release = gate.arm()
    let settled = false
    const updating = service.update(record.id, { content: { text: '新词' } }, 1, OWNER_IDENTITY, OWNER_VIEWER)
    void updating.then(() => { settled = true }, () => { settled = true })
    await flushMicrotasks()
    assert.equal(settled, false, 'update returned before its index write finished')
    release()
    await updating

    const fresh = await service.search({ query: '新词', scope: 'all' }, OWNER_VIEWER)
    assert.deepEqual(hitIds(fresh.items), [record.id])
    const stale = await service.search({ query: '旧词', scope: 'all' }, OWNER_VIEWER)
    assert.deepEqual(hitIds(stale.items), [])
  } finally {
    await parts.close()
  }
})

test('mut-06: record waits for the index write before it returns', async () => {
  const parts = await openParts()
  const gate = gatedIndex(parts.index)
  const service = facadeOf(parts, { index: gate.index })
  try {
    const evidence = await ingest(service, { key: 'm06' })
    await service.flush()

    const release = gate.arm()
    let settled = false
    const creating = service.record({
      layer: 'L1',
      kind: 'l1.fact',
      channel: GROUP,
      subjects: [],
      actor: 'p_bob',
      content: { text: '索引已就绪' },
      evidence: [{ id: evidence }],
      visibility: 'open',
    }, OWNER_IDENTITY)
    void creating.then(() => { settled = true }, () => { settled = true })
    await flushMicrotasks()
    assert.equal(settled, false, 'record returned before its index write finished')
    release()
    const record = await creating

    const hits = await service.search({ query: '索引', scope: 'all' }, OWNER_VIEWER)
    assert.deepEqual(hitIds(hits.items), [record.id])
  } finally {
    await parts.close()
  }
})

test('mut-07: ingest rejects content over the cap and writes nothing', async () => {
  const brain = await openTempBrain()
  try {
    const before = countRows(brain.paths.memory, 'L0')
    const error = await capture(() => ingest(brain.memory.service, {
      key: 'm07',
      text: 'a'.repeat(LIMITS.contentBytes),
    }))
    assert.equal(codeOf(error), 'PAYLOAD_TOO_LARGE')
    assert.equal(countRows(brain.paths.memory, 'L0'), before)
  } finally {
    await brain.close()
  }
})

test('mut-08: a patch with content over the cap is rejected and changes no version', async () => {
  const parts = await openParts()
  const service = facadeOf(parts)
  try {
    const evidence = await ingest(service, { key: 'm08' })
    const record = await write(service, evidence, { text: '正常' })

    const error = await capture(() => service.update(
      record.id,
      { content: { text: 'a'.repeat(LIMITS.contentBytes) } },
      1,
      OWNER_IDENTITY,
      OWNER_VIEWER,
    ))
    assert.equal(codeOf(error), 'PAYLOAD_TOO_LARGE')
    const fresh = await parts.store.get(record.id)
    assert.equal(fresh?.version, 1)
  } finally {
    await parts.close()
  }
})

test('mut-09: a plugin may only update or remove its own records', async () => {
  const parts = await openParts()
  const service = facadeOf(parts)
  try {
    const evidence = await ingest(service, { key: 'm09' })
    const identityA: WriteIdentity = {
      kind: 'plugin', source: 'plugin.a', trust: 'member', defaultVisibility: 'open', channels: [GROUP],
    }
    const identityB: WriteIdentity = {
      kind: 'plugin', source: 'plugin.b', trust: 'member', defaultVisibility: 'open', channels: [GROUP],
    }
    const record = await service.record({
      layer: 'L1',
      kind: 'l1.fact',
      channel: GROUP,
      subjects: [],
      actor: 'p_bob',
      content: { text: '插件写的' },
      evidence: [{ id: evidence }],
      visibility: 'open',
    }, identityA)

    assert.equal(codeOf(await capture(() => service.update(record.id, {}, 1, identityB, OWNER_VIEWER))), 'PERMISSION_DENIED')
    assert.equal(codeOf(await capture(() => service.remove(record.id, identityB, OWNER_VIEWER))), 'PERMISSION_DENIED')

    const updated = await service.update(record.id, { importance: 0.9 }, 1, identityA, OWNER_VIEWER)
    assert.equal(updated.version, 2)
  } finally {
    await parts.close()
  }
})

test('mut-10: L3 records cannot be removed', async () => {
  const parts = await openParts()
  const service = facadeOf(parts)
  try {
    const evidence = await ingest(service, { key: 'm10' })
    const l1 = await write(service, evidence, { text: '画像证据' })
    await parts.profiles.commit({ stable: 's', data: { a: 1 }, evidence: [{ id: l1.id }] })
    const page = await parts.store.list({ layers: ['L3'] }, { limit: 1 })
    const l3 = page.items[0] as MemoryRecord

    const error = await capture(() => service.remove(l3.id, OWNER_IDENTITY, OWNER_VIEWER))
    assert.equal(codeOf(error), 'PERMISSION_DENIED')
    const fresh = await parts.store.get(l3.id)
    assert.equal(fresh?.status, 'active')
  } finally {
    await parts.close()
  }
})

test('mut-11: forgetting a time range still honours the channel', async () => {
  const parts = await openParts()
  const service = facadeOf(parts)
  try {
    const now = clock.now()
    const aEvidence = await ingest(service, { key: 'm11-a', channel: 'qq:group:1', text: '甲群闲聊', tEvent: now })
    await write(service, aEvidence, { channel: 'qq:group:1', text: '甲通道咖啡' })
    const bEvidence = await ingest(service, { key: 'm11-b', channel: 'qq:group:2', text: '乙群闲聊', tEvent: now })
    const b = await write(service, bEvidence, { channel: 'qq:group:2', text: '乙通道咖啡' })

    const report = await service.forget({
      by: 'time', from: now - 60_000, to: now + 60_000, channel: 'qq:group:1',
    })
    assert.equal(report.tombstoned, 2)

    const hits = await service.search({ query: '咖啡', scope: 'all' }, OWNER_VIEWER)
    assert.deepEqual(hitIds(hits.items), [b.id])
  } finally {
    await parts.close()
  }
})

test('mut-12: speaking in a channel makes you a member of it', async () => {
  const brain = await openTempBrain({ crossChannelMode: () => 'on' })
  try {
    await ingest(brain.memory.service, { key: 'm12-alice', actor: 'p_alice' })
    const bobEvidence = await ingest(brain.memory.service, { key: 'm12-bob', actor: 'p_bob' })
    const l1 = await write(brain.memory.service, bobEvidence, { text: '咖啡在群里' })

    const alice = await brain.memory.service.search(
      { query: '咖啡', scope: 'all' }, agentViewer('qq:private:30001', ['p_alice']),
    )
    assert.deepEqual(hitIds(alice.items), [l1.id])

    const carol = await brain.memory.service.search(
      { query: '咖啡', scope: 'all' }, agentViewer('qq:private:30001', ['p_carol']),
    )
    assert.deepEqual(hitIds(carol.items), [])
  } finally {
    await brain.close()
  }
})

test('mut-13: the membership table is rebuilt from the store on open', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brain-memory-api-'))
  const paths = await prepareBrainHome({ env: { BRAIN_HOME: dir }, userHome: os.homedir() })
  const options = {
    paths, clock, log: silentLog, crossChannelMode: () => 'on' as CrossChannelMode, ownerChannels: [],
  }
  try {
    let memory = await openMemory(options)
    await ingest(memory.service, { key: 'm13-alice', actor: 'p_alice' })
    const bobEvidence = await ingest(memory.service, { key: 'm13-bob', actor: 'p_bob' })
    const l1 = await write(memory.service, bobEvidence, { text: '咖啡在群里' })
    await memory.close()

    memory = await openMemory(options)
    const alice = await memory.service.search(
      { query: '咖啡', scope: 'all' }, agentViewer('qq:private:30001', ['p_alice']),
    )
    assert.deepEqual(hitIds(alice.items), [l1.id])
    await memory.close()
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('mut-14: a tombstoned message does not make its actor a member', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brain-memory-api-'))
  const paths = await prepareBrainHome({ env: { BRAIN_HOME: dir }, userHome: os.homedir() })
  const options = {
    paths, clock, log: silentLog, crossChannelMode: () => 'on' as CrossChannelMode, ownerChannels: [],
  }
  try {
    let memory = await openMemory(options)
    const aliceEvidence = await ingest(memory.service, { key: 'm14-alice', actor: 'p_alice' })
    const bobEvidence = await ingest(memory.service, { key: 'm14-bob', actor: 'p_bob' })
    const l1 = await write(memory.service, bobEvidence, { text: '咖啡在群里' })
    await memory.service.flush()
    await memory.service.forget({ by: 'record', id: aliceEvidence })
    await memory.close()

    memory = await openMemory(options)
    const alice = await memory.service.search(
      { query: '咖啡', scope: 'all' }, agentViewer('qq:private:30001', ['p_alice']),
    )
    assert.deepEqual(hitIds(alice.items), [])
    const bob = await memory.service.search(
      { query: '咖啡', scope: 'all' }, agentViewer('qq:private:30001', ['p_bob']),
    )
    assert.deepEqual(hitIds(bob.items), [l1.id])
    await memory.close()
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('mut-15: membership is expanded through merged identities', async () => {
  const brain = await openTempBrain({ crossChannelMode: () => 'on' })
  try {
    const oldId = await brain.memory.identity.resolve('qq:10001')
    const newId = await brain.memory.identity.resolve('qq:10002')
    await ingest(brain.memory.service, { key: 'm15-alice', actor: oldId })
    const bobEvidence = await ingest(brain.memory.service, { key: 'm15-bob', actor: 'p_bob' })
    const l1 = await write(brain.memory.service, bobEvidence, { text: '咖啡在群里' })
    await brain.memory.identity.merge(oldId, newId)

    const hits = await brain.memory.service.search(
      { query: '咖啡', scope: 'all' }, agentViewer('qq:private:30001', [newId]),
    )
    assert.deepEqual(hitIds(hits.items), [l1.id])
  } finally {
    await brain.close()
  }
})

test('mut-16: health reports a broken store or index as down', async () => {
  const parts = await openParts()
  try {
    const downStore = storeWith(parts.store, { list: async () => { throw new Error('store down') } })
    const storeHealth = await facadeOf(parts, { store: downStore }).health()
    assert.equal(storeHealth.store, 'down')
    assert.equal(storeHealth.index, 'ok')

    const downIndex = indexWith(parts.index, { search: async () => { throw new Error('index down') } })
    const indexHealth = await facadeOf(parts, { index: downIndex }).health()
    assert.equal(indexHealth.store, 'ok')
    assert.equal(indexHealth.index, 'down')
  } finally {
    await parts.close()
  }
})

test('mut-17: a failed job degrades job health until a later job succeeds', async () => {
  const parts = await openParts()
  try {
    let fail = true
    const flaky = indexWith(parts.index, {
      rebuild: async (records) => {
        if (fail) throw new Error('boom')
        return parts.index.rebuild(records)
      },
    })
    const holder: { jobs?: JobRunner } = {}
    const service = facadeOf(parts, { index: flaky, jobsHealth: () => holder.jobs?.health() ?? 'ok' })
    const jobs = createJobRunner({
      index: flaky, store: parts.store, clock, onRebuildSuccess: () => service.markIndexHealthy(),
    })
    holder.jobs = jobs

    const failed = jobs.start({ type: 'rebuildIndex' })
    await jobs.idle()
    assert.equal(jobs.get(failed.id).status, 'failed')
    assert.equal(jobs.health(), 'degraded')
    assert.equal((await service.health()).jobs, 'degraded')

    fail = false
    jobs.start({ type: 'rebuildIndex' })
    await jobs.idle()
    assert.equal(jobs.health(), 'ok')
    assert.equal((await service.health()).jobs, 'ok')
  } finally {
    await parts.close()
  }
})

test('mut-18: a failed job never carries the original message', async () => {
  const parts = await openParts()
  try {
    const boom = indexWith(parts.index, {
      rebuild: async () => { throw new Error('secret detail') },
    })
    const jobs = createJobRunner({ index: boom, store: parts.store, clock })
    const job = jobs.start({ type: 'rebuildIndex' })
    await jobs.idle()

    const failed = jobs.get(job.id)
    assert.deepEqual(failed.error, { code: 'INTERNAL', message: 'job failed' })
    assert.equal(JSON.stringify(failed).includes('secret detail'), false)
  } finally {
    await parts.close()
  }
})

test('mut-19: only the most recent 100 jobs are kept', async () => {
  const brain = await openTempBrain()
  try {
    let firstId = ''
    let lastId = ''
    for (let index = 0; index < 101; index += 1) {
      const job = brain.memory.jobs.start({ type: 'rebuildIndex' })
      if (index === 0) firstId = job.id
      lastId = job.id
      await brain.memory.jobs.idle()
    }

    const first = await capture(() => Promise.resolve(brain.memory.jobs.get(firstId)))
    assert.equal(codeOf(first), 'NOT_FOUND')
    assert.equal(brain.memory.jobs.get(lastId).status, 'done')
  } finally {
    await brain.close()
  }
})

test('mut-20: the wrong HTTP method on a known path is 404', async () => {
  const brain = await openTempBrain()
  const api = await startApi(brain.memory)
  try {
    const evidence = await ingest(brain.memory.service, { key: 'm20' })
    const record = await write(brain.memory.service, evidence, { text: '方法测试' })

    for (const [method, route] of [
      ['GET', '/memory/search'],
      ['PUT', `/memory/records/${record.id}`],
      ['POST', '/memory/health'],
    ] as const) {
      const response = await api.request(method, route)
      assert.equal(response.status, 404, `${method} ${route}`)
      assert.equal((response.body as { error: { code: string } }).error.code, 'NOT_FOUND')
    }
  } finally {
    await api.close()
    await brain.close()
  }
})

test('mut-21: a percent-encoded record id is decoded before lookup', async () => {
  const brain = await openTempBrain()
  const api = await startApi(brain.memory)
  try {
    const evidence = await ingest(brain.memory.service, { key: 'm21' })
    const first = await write(brain.memory.service, evidence, { text: '编码前' })
    const second = await write(brain.memory.service, evidence, { text: '编码前二' })

    const encoded = `%6C${first.id.slice(1)}`
    const encodedResponse = await api.request('PATCH', `/memory/records/${encoded}`, { content: { text: '编码后' } }, { 'If-Match': '1' })
    assert.equal(encodedResponse.status, 200)
    const plainResponse = await api.request('PATCH', `/memory/records/${second.id}`, { content: { text: '编码后二' } }, { 'If-Match': '1' })
    assert.equal(plainResponse.status, 200)

    const invalid = await api.request('PATCH', '/memory/records/%E0%A4%A', { content: { text: 'x' } }, { 'If-Match': '1' })
    assert.equal(invalid.status, 400)
    assert.equal((invalid.body as { error: { code: string } }).error.code, 'INVALID_ARGUMENT')
  } finally {
    await api.close()
    await brain.close()
  }
})

test('mut-22: the context viewer uses the channel from the request', async () => {
  const brain = await openTempBrain()
  const api = await startApi(brain.memory)
  try {
    const evidence = await ingest(brain.memory.service, { key: 'm22', channel: 'qq:group:1', text: '群聊' })
    const record = await write(brain.memory.service, evidence, { channel: 'qq:group:1', text: '咖啡在甲通道' })

    const here = await api.request('POST', '/memory/context', { channel: 'qq:group:1' })
    const hereFacts = (here.body as { data: ContextBundle }).data.blocks.find((block) => block.name === 'facts')
    assert.deepEqual(hereFacts?.items.map((item) => item.id), [record.id])

    const elsewhere = await api.request('POST', '/memory/context', { channel: 'qq:group:2' })
    const elsewhereFacts = (elsewhere.body as { data: ContextBundle }).data.blocks.find((block) => block.name === 'facts')
    assert.deepEqual(elsewhereFacts?.items, [])
  } finally {
    await api.close()
    await brain.close()
  }
})

test('mut-23: HTTP logs never carry the error message, the token or the body', async () => {
  const brain = await openTempBrain()
  const lines: string[] = []
  const capturing: Logger = {
    info: (event, fields) => { lines.push(JSON.stringify({ event, fields })) },
    warn: (event, fields) => { lines.push(JSON.stringify({ event, fields })) },
    error: (event, fields) => { lines.push(JSON.stringify({ event, fields })) },
  }
  const token = `tok_${'x'.repeat(40)}`
  const broken: Memory = {
    ...brain.memory,
    service: {
      ...brain.memory.service,
      record: async () => { throw new Error('secret detail') },
    },
  }
  const server = createMemoryApiServer(broken, { token, port: 0, log: capturing })
  const { port } = await server.listen()
  try {
    const healthy = await fetch(`http://127.0.0.1:${port}/api/v1/memory/health`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    await healthy.text()

    const failing = await fetch(`http://127.0.0.1:${port}/api/v1/memory/records`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        layer: 'L1', kind: 'l1.fact', channel: 'qq:group:1', subjects: [], actor: 'p_alice',
        content: { text: '秘密正文' }, evidence: [],
      }),
    })
    assert.equal(failing.status, 500)
    await failing.text()
  } finally {
    await server.close()
    await brain.close()
  }

  const joined = lines.join('\n')
  assert.equal(joined.includes('secret detail'), false)
  assert.equal(joined.includes(token), false)
  assert.equal(joined.includes('秘密正文'), false)
  assert.equal(lines.filter((line) => line.includes('"event":"http.request"')).length, 2)
})
