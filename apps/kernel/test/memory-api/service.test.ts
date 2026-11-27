import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { BrainError, type Viewer } from '@dsh-brain-core/sdk'
import type { Clock, CrossChannelMode, KeywordIndex } from '../../src/contracts/index.ts'
import { prepareBrainHome } from '../../src/home/index.ts'
import { createIdentityService, createProfileStore } from '../../src/identity-persona/index.ts'
import { createAuditLog } from '../../src/memory-api/audit.ts'
import { createChannelFacts } from '../../src/memory-api/channel-facts.ts'
import { createJobRunner } from '../../src/memory-api/jobs.ts'
import { openMemory } from '../../src/memory-api/index.ts'
import { createMemoryService } from '../../src/memory-api/service.ts'
import { createContextAssembler } from '../../src/memory-context/index.ts'
import { createForgetService } from '../../src/memory-forget/index.ts'
import { createPolicy } from '../../src/memory-policy/index.ts'
import { createSqliteRecordStore } from '../../src/memory-store/index.ts'
import {
  agentViewer, openTempBrain, OWNER_IDENTITY, OWNER_VIEWER, silentLog,
} from './helpers.ts'

const clock: Clock = { now: () => Date.now() }

async function l0(
  brain: Awaited<ReturnType<typeof openTempBrain>>,
  key: string,
  channel: string,
  actor: string,
  text: string,
  visibility: 'open' | 'subject' | 'owner' | 'origin' | 'internal' = 'owner',
): Promise<string> {
  const result = await brain.memory.service.ingest({
    kind: 'chat.message', channel, subjects: [], actor, content: { text }, tEvent: Date.now(), idempotencyKey: key,
    visibility,
  }, OWNER_IDENTITY)
  return result.id
}

async function l1(
  brain: Awaited<ReturnType<typeof openTempBrain>>,
  evidence: string,
  channel: string,
  actor: string,
  subjects: readonly string[],
  text: string,
  visibility: 'open' | 'subject' | 'owner' | 'origin' | 'internal' = 'open',
): Promise<string> {
  const record = await brain.memory.service.record({
    layer: 'L1', kind: 'l1.fact', channel, subjects, actor,
    content: { text }, evidence: [{ id: evidence }], visibility,
  }, OWNER_IDENTITY)
  return record.id
}

function factIds(bundle: { readonly blocks: readonly { readonly name: string; readonly items: readonly { readonly id: string }[] }[] }): string[] {
  return bundle.blocks.find((block) => block.name === 'facts')?.items.map((item) => item.id) ?? []
}

function auditRows(brain: { readonly paths: { readonly memory: string } }): { recordId: string; viewerChannel: string; mode: string }[] {
  const db = new DatabaseSync(path.join(brain.paths.memory, 'audit.db'))
  try {
    const rows = db.prepare(
      'SELECT record_id, viewer_channel, mode FROM cross_channel_use ORDER BY t_at ASC',
    ).all() as { record_id: string; viewer_channel: string; mode: string }[]
    return rows.map((row) => ({ recordId: row.record_id, viewerChannel: row.viewer_channel, mode: row.mode }))
  } finally {
    db.close()
  }
}

test('two-character Chinese search works end to end', async () => {
  const brain = await openTempBrain()
  try {
    await l0(brain, 'cn-1', 'qq:group:42', 'p_alice', '我今天读了一篇关于记忆的文章', 'open')
    await brain.memory.service.flush()

    const here = await brain.memory.service.search({ query: '记忆', scope: 'here' }, agentViewer('qq:group:42'))
    assert.equal(here.items.length, 1)
    assert.equal(here.items[0]?.record.content.text, '我今天读了一篇关于记忆的文章')

    const elsewhere = await brain.memory.service.search({ query: '记忆', scope: 'here' }, agentViewer('qq:group:43'))
    assert.equal(elsewhere.items.length, 0)
  } finally {
    await brain.close()
  }
})

test('the cross-channel switch governs search, and `on` audits every cross-channel hit', async () => {
  let mode: CrossChannelMode = 'off'
  const brain = await openTempBrain({ crossChannelMode: () => mode })
  try {
    const a0 = await l0(brain, 'gate-a0', 'qq:group:1', 'p_alice', '甲群闲聊')
    const a = await l1(brain, a0, 'qq:group:1', 'p_alice', ['p_alice'], '咖啡不错')
    const b0 = await l0(brain, 'gate-b0', 'qq:group:2', 'p_alice', '乙群闲聊')
    const b = await l1(brain, b0, 'qq:group:2', 'p_alice', ['p_alice'], '咖啡也不错')
    await brain.memory.service.flush()

    const viewer = agentViewer('qq:group:1', ['p_alice'])
    const idSet = (hits: readonly { readonly record: { readonly id: string } }[]): string[] => hits.map((hit) => hit.record.id).sort()

    for (const off of ['off', 'shadow'] as const) {
      mode = off
      const all = await brain.memory.service.search({ query: '咖啡', scope: 'all' }, viewer)
      assert.deepEqual(idSet(all.items), [a])
      const person = await brain.memory.service.search({ query: '咖啡', scope: 'person' }, viewer)
      assert.deepEqual(idSet(person.items), [a])
    }
    assert.deepEqual(auditRows(brain), [])

    mode = 'on'
    const all = await brain.memory.service.search({ query: '咖啡', scope: 'all' }, viewer)
    assert.deepEqual(idSet(all.items), [a, b].sort())
    assert.deepEqual(auditRows(brain), [{ recordId: b, viewerChannel: 'qq:group:1', mode: 'on' }])

    const person = await brain.memory.service.search({ query: '咖啡', scope: 'person' }, viewer)
    assert.deepEqual(idSet(person.items), [a, b].sort())
    assert.equal(auditRows(brain).length, 2)
    assert.ok(auditRows(brain).every((row) => row.recordId === b))

    // The owner console is never bound by the switch.
    const owner: Viewer = { caller: 'owner-console', channel: 'qq:group:1', participants: [] }
    for (const each of ['off', 'shadow', 'on'] as const) {
      mode = each
      const hits = await brain.memory.service.search({ query: '咖啡', scope: 'all' }, owner)
      assert.deepEqual(idSet(hits.items), [a, b].sort())
    }
    assert.equal(auditRows(brain).length, 2)
  } finally {
    await brain.close()
  }
})

test('search by person follows merges (FR-M15)', async () => {
  const brain = await openTempBrain({ crossChannelMode: () => 'on' })
  try {
    const p1 = await brain.memory.identity.resolve('qq:10001')
    const p2 = await brain.memory.identity.resolve('qq:10002')
    const e1 = await l0(brain, 'person-1', 'qq:private:10001', p1, '一号的闲聊')
    const r1 = await l1(brain, e1, 'qq:private:10001', p1, [p1], '一号喜欢咖啡', 'subject')
    const e2 = await l0(brain, 'person-2', 'qq:private:10002', p2, '二号的闲聊')
    const r2 = await l1(brain, e2, 'qq:private:10002', p2, [p2], '二号喜欢咖啡', 'subject')
    await brain.memory.service.flush()

    await brain.memory.identity.merge(p1, p2)

    const owner = await brain.memory.service.search({ query: '咖啡', scope: 'all', subjects: [p2] }, OWNER_VIEWER)
    assert.deepEqual(owner.items.map((hit) => hit.record.id).sort(), [r1, r2].sort())

    const agent = await brain.memory.service.search({ query: '咖啡', scope: 'person' }, agentViewer('qq:group:9', [p2]))
    assert.deepEqual(agent.items.map((hit) => hit.record.id).sort(), [r1, r2].sort())
  } finally {
    await brain.close()
  }
})

test('forget by record hides it from search and context', async () => {
  const brain = await openTempBrain()
  try {
    const evidence = await l0(brain, 'forget-record-l0', 'qq:group:7', 'p_alice', '记得买猫粮')
    const record = await l1(brain, evidence, 'qq:group:7', 'p_alice', ['p_alice'], '猫粮买好了')
    await brain.memory.service.flush()

    assert.equal((await brain.memory.service.search({ query: '猫粮', scope: 'all' }, OWNER_VIEWER)).items.length, 2)
    assert.ok(factIds(await brain.memory.service.context({ channel: 'qq:group:7' }, { ...OWNER_VIEWER, channel: 'qq:group:7' })).includes(record))

    const report = await brain.memory.service.forget({ by: 'record', id: record })
    assert.deepEqual(report, { tombstoned: 1, invalidated: 0, l3Flagged: 0 })

    const hits = await brain.memory.service.search({ query: '猫粮', scope: 'all' }, OWNER_VIEWER)
    assert.equal(hits.items.length, 1)
    assert.ok(!factIds(await brain.memory.service.context({ channel: 'qq:group:7' }, { ...OWNER_VIEWER, channel: 'qq:group:7' })).includes(record))
  } finally {
    await brain.close()
  }
})

test('forget by channel hides that channel everywhere', async () => {
  const brain = await openTempBrain()
  try {
    const e1 = await l0(brain, 'forget-channel-1', 'qq:group:8', 'p_alice', '群里闲聊')
    const r1 = await l1(brain, e1, 'qq:group:8', 'p_alice', ['p_alice'], '咖啡坏了')
    const e2 = await l0(brain, 'forget-channel-2', 'qq:group:9', 'p_alice', '另一个群闲聊')
    const r2 = await l1(brain, e2, 'qq:group:9', 'p_alice', ['p_alice'], '咖啡很好')
    await brain.memory.service.flush()

    const report = await brain.memory.service.forget({ by: 'channel', channel: 'qq:group:8' })
    assert.equal(report.tombstoned, 2)

    const hits = await brain.memory.service.search({ query: '咖啡', scope: 'all' }, OWNER_VIEWER)
    assert.deepEqual(hits.items.map((hit) => hit.record.id), [r2])
    assert.deepEqual(factIds(await brain.memory.service.context({ channel: 'qq:group:8' }, { ...OWNER_VIEWER, channel: 'qq:group:8' })), [])
    assert.deepEqual(factIds(await brain.memory.service.context({ channel: 'qq:group:9' }, { ...OWNER_VIEWER, channel: 'qq:group:9' })), [r2])
    assert.notEqual(r1, r2)
  } finally {
    await brain.close()
  }
})

test('forget by person covers every merged alias and sums the reports (FR-M08)', async () => {
  const brain = await openTempBrain()
  try {
    const p1 = await brain.memory.identity.resolve('qq:20001')
    const p2 = await brain.memory.identity.resolve('qq:20002')
    const e1 = await l0(brain, 'person-forget-1', 'qq:private:20001', p1, '甲喜欢猫')
    await l1(brain, e1, 'qq:private:20001', p1, [p1], '甲喜欢猫')
    const e2 = await l0(brain, 'person-forget-2', 'qq:private:20002', p2, '乙喜欢狗')
    await l1(brain, e2, 'qq:private:20002', p2, [p2], '乙喜欢狗')
    await brain.memory.service.flush()
    await brain.memory.identity.merge(p1, p2)

    const report = await brain.memory.service.forget({ by: 'person', personId: p2 })
    assert.deepEqual(report, { tombstoned: 4, invalidated: 0, l3Flagged: 0 })

    assert.equal((await brain.memory.service.search({ query: '猫', scope: 'all' }, OWNER_VIEWER)).items.length, 0)
    assert.equal((await brain.memory.service.search({ query: '狗', scope: 'all' }, OWNER_VIEWER)).items.length, 0)
    assert.deepEqual(factIds(await brain.memory.service.context({ channel: 'qq:private:20001' }, { ...OWNER_VIEWER, channel: 'qq:private:20001' })), [])
    assert.deepEqual(factIds(await brain.memory.service.context({ channel: 'qq:private:20002' }, { ...OWNER_VIEWER, channel: 'qq:private:20002' })), [])
  } finally {
    await brain.close()
  }
})

test('PERF: ingest stays inside the NFR-01 budget', async () => {
  const brain = await openTempBrain()
  try {
    const samples: number[] = []
    for (let index = 0; index < 200; index += 1) {
      const started = performance.now()
      await brain.memory.service.ingest({
        kind: 'chat.message',
        channel: 'qq:group:100',
        subjects: [],
        actor: 'p_alice',
        content: { text: `第 ${index} 条消息` },
        tEvent: Date.now(),
        idempotencyKey: `perf-${index}`,
      }, OWNER_IDENTITY)
      samples.push(performance.now() - started)
    }
    await brain.memory.service.flush()
    samples.sort((left, right) => left - right)
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1] as number
    // The NFR-01 budget is 5 ms. On Windows, real-machine p95 is ~1.8–2.0 ms, so per user decision
    // the Windows budget is set to 8 ms to allow headroom on slower CI disks; the real value is always printed.
    const budget = process.platform === 'win32' ? 8 : 5
    console.log(`ingest p95 = ${p95.toFixed(3)} ms over 200 calls (budget ${budget} ms on ${process.platform})`)
    assert.ok(p95 <= budget, `p95 ${p95.toFixed(3)} ms exceeds ${budget} ms`)
  } finally {
    await brain.close()
  }
})

test('a failing index degrades health until a rebuild succeeds', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brain-memory-api-'))
  const paths = await prepareBrainHome({ env: { BRAIN_HOME: dir }, userHome: os.homedir() })
  const store = await createSqliteRecordStore({ path: path.join(paths.memory, 'records.db'), clock })
  const audit = await createAuditLog({ path: path.join(paths.memory, 'audit.db') })
  const identity = await createIdentityService({ path: path.join(paths.memory, 'identity.json'), clock })
  const profiles = createProfileStore({ store, clock })
  const facts = createChannelFacts({ ownerChannels: [], identity })
  const policy = createPolicy()
  let healthy = false
  const brokenIndex: KeywordIndex = {
    async add() { throw new Error('index write failed') },
    async remove() {},
    async search() { return [] },
    async rebuild(records) {
      let active = 0
      for await (const record of records) if (record.status === 'active') active += 1
      healthy = true
      return active
    },
    async close() {},
  }
  const assembler = createContextAssembler({
    store,
    index: brokenIndex,
    policy,
    profiles,
    audit,
    clock,
    facts: (viewer) => facts.forViewer(viewer),
    crossChannelMode: () => 'shadow',
  })
  const forget = createForgetService({ store, index: brokenIndex, onForgotten: async () => {} })

  let jobs = undefined as unknown as ReturnType<typeof createJobRunner>
  const service = createMemoryService({
    store,
    index: brokenIndex,
    policy,
    assembler,
    forget,
    identity,
    facts,
    audit,
    crossChannelMode: () => 'shadow',
    jobsHealth: () => jobs.health(),
    clock,
    log: silentLog,
  })
  jobs = createJobRunner({ index: brokenIndex, store, clock, onRebuildSuccess: () => service.markIndexHealthy() })

  try {
    await service.ingest({
      kind: 'chat.message', channel: 'qq:group:1', subjects: [], actor: 'p_alice',
      content: { text: '索引会失败' }, tEvent: Date.now(), idempotencyKey: 'broken-1',
    }, OWNER_IDENTITY)
    await service.flush()
    const degraded = await service.health()
    assert.equal(degraded.store, 'ok')
    assert.equal(degraded.index, 'degraded')
    assert.equal(service.indexDegraded(), true)

    const job = jobs.start({ type: 'rebuildIndex' })
    await jobs.idle()
    assert.equal(healthy, true)
    assert.equal(jobs.get(job.id).status, 'done')
    assert.equal(jobs.get(job.id).result?.indexed, 1)
    const healthyAgain = await service.health()
    assert.equal(healthyAgain.index, 'ok')
    assert.equal(healthyAgain.jobs, 'ok')
  } finally {
    await audit.close()
    await store.close()
    await rm(dir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('a missing index file is rebuilt on open', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brain-memory-api-'))
  const paths = await prepareBrainHome({ env: { BRAIN_HOME: dir }, userHome: os.homedir() })
  const options = { paths, clock, log: silentLog, crossChannelMode: () => 'shadow' as CrossChannelMode, ownerChannels: [] }
  try {
    let memory = await openMemory(options)
    await memory.service.ingest({
      kind: 'chat.message', channel: 'qq:group:1', subjects: [], actor: 'p_alice',
      content: { text: '这条会被检索到' }, tEvent: Date.now(), idempotencyKey: 'rebuild-1',
    }, OWNER_IDENTITY)
    await memory.service.flush()
    const before = await memory.service.search({ query: '检索', scope: 'all' }, OWNER_VIEWER)
    assert.equal(before.items.length, 1)
    await memory.close()

    for (const suffix of ['', '-wal', '-shm']) {
      await rm(path.join(paths.memory, `index.db${suffix}`), { force: true })
    }
    memory = await openMemory(options)
    await memory.jobs.idle()
    const after = await memory.service.search({ query: '检索', scope: 'all' }, OWNER_VIEWER)
    assert.deepEqual(
      after.items.map((hit) => hit.record.id),
      before.items.map((hit) => hit.record.id),
    )
    await memory.close()
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('jobs reject a duplicate, an unknown id and extraction', async () => {
  const brain = await openTempBrain()
  try {
    const e = await l0(brain, 'jobs-l0', 'qq:group:1', 'p_alice', '任务测试')
    await l1(brain, e, 'qq:group:1', 'p_alice', ['p_alice'], '任务测试')

    const first = brain.memory.jobs.start({ type: 'rebuildIndex' })
    assert.throws(
      () => brain.memory.jobs.start({ type: 'rebuildIndex' }),
      (error: unknown) => error instanceof BrainError && error.code === 'CONFLICT',
    )
    assert.throws(
      () => brain.memory.jobs.get('unknown-job'),
      (error: unknown) => error instanceof BrainError && error.code === 'NOT_FOUND',
    )
    assert.throws(
      () => brain.memory.jobs.start({ type: 'extract', from: 0, to: Date.now() }),
      (error: unknown) => error instanceof BrainError && error.code === 'UNAVAILABLE',
    )
    assert.throws(
      () => brain.memory.jobs.start({ type: 'extract', from: 'yesterday', to: 1 }),
      (error: unknown) => error instanceof BrainError && error.code === 'INVALID_ARGUMENT',
    )

    await brain.memory.jobs.idle()
    const done = brain.memory.jobs.get(first.id)
    assert.equal(done.status, 'done')
    assert.equal(done.result?.indexed, 2)
    assert.equal(brain.memory.jobs.health(), 'ok')
    assert.equal(typeof done.finishedAt, 'number')
  } finally {
    await brain.close()
  }
})
