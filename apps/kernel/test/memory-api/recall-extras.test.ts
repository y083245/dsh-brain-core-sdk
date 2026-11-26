import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import test from 'node:test'
import { BrainError, validate, type Viewer } from '@brain-core/sdk'
import type { RecordStore } from '../../src/contracts/index.ts'
import { agentViewer, facadeOf, openParts, openTempBrain, OWNER_IDENTITY, OWNER_VIEWER } from './helpers.ts'

const LEGACY_SUFFIX = '（旧系统历史存档，仅作事实参考，不作为当前说话语气）'

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

test('search neighbors returns same-channel before (asc) -> after (asc) for L0 hits only, and validates neighbors window', async () => {
  const brain = await openTempBrain()
  try {
    const ch = 'qq:group:neighbors'
    const ids: string[] = []
    for (let i = 0; i < 5; i += 1) {
      const res = await brain.memory.service.ingest({
        kind: 'chat.message',
        channel: ch,
        subjects: ['p_alice'],
        actor: 'p_alice',
        content: { text: i === 2 ? '锚点苹果派' : `周围消息${i}` },
        tEvent: 1000 + (i === 2 || i === 3 ? 20 : i * 10),
        idempotencyKey: `nbr-${i}`,
        visibility: 'open',
      }, OWNER_IDENTITY)
      ids.push(res.id)
    }
    const l1 = await brain.memory.service.record({
      layer: 'L1',
      kind: 'l1.fact',
      channel: ch,
      subjects: ['p_alice'],
      actor: 'p_alice',
      content: { text: '喜欢苹果派' },
      evidence: [{ id: ids[2]! }],
      visibility: 'open',
    }, OWNER_IDENTITY)
    await brain.memory.service.flush()

    const viewer = agentViewer(ch, ['p_alice'])
    const withNeighbors = await brain.memory.service.search({ query: '苹果派', scope: 'here', neighbors: 2 }, viewer)
    const l0Hit = withNeighbors.items.find((item) => item.record.id === ids[2])
    const l1Hit = withNeighbors.items.find((item) => item.record.id === l1.id)
    assert.ok(l0Hit !== undefined && l1Hit !== undefined)
    assert.deepEqual(
      l0Hit.neighbors?.map((n) => ({ position: n.position, id: n.record.id })),
      [
        { position: 'before', id: ids[0] },
        { position: 'before', id: ids[1] },
        { position: 'after', id: ids[3] },
        { position: 'after', id: ids[4] },
      ],
    )
    assert.equal(l1Hit.neighbors, undefined)
    for (const item of withNeighbors.items) validate('SearchHit', item)

    const zeroNeighbors = await brain.memory.service.search({ query: '苹果派', scope: 'here', neighbors: 0 }, viewer)
    assert.equal(zeroNeighbors.items.find((item) => item.record.id === ids[2])?.neighbors, undefined)

    const maxNeighbors = await brain.memory.service.search({ query: '苹果派', scope: 'here', neighbors: 10 }, viewer)
    assert.equal(maxNeighbors.items.find((item) => item.record.id === ids[2])?.neighbors?.length, 4)

    for (const bad of [-1, 11, 1.5]) {
      await assert.rejects(
        () => brain.memory.service.search({ query: '苹果派', scope: 'here', neighbors: bad }, viewer),
        (error: unknown) => error instanceof BrainError && error.code === 'INVALID_ARGUMENT',
      )
    }
  } finally {
    await brain.close()
  }
})

test('invisible or injection=none neighbors are dropped without backfilling and never written to crossChannelUse audit', async () => {
  const brain = await openTempBrain({
    ownerChannels: ['qq:private:owner'],
    crossChannelMode: () => 'on',
  })
  try {
    const chOrigin = 'qq:group:10'
    const chViewer = 'qq:group:20'

    const m0 = await brain.memory.service.ingest({
      kind: 'chat.message', channel: chOrigin, subjects: ['p_alice'], actor: 'p_alice',
      content: { text: '更早的公开消息不应补位' }, tEvent: 1000, idempotencyKey: 'sec-0', visibility: 'open',
    }, OWNER_IDENTITY)
    const m1 = await brain.memory.service.ingest({
      kind: 'chat.message', channel: chOrigin, subjects: ['p_alice'], actor: 'p_alice',
      content: { text: '前1可见' }, tEvent: 2000, idempotencyKey: 'sec-1', visibility: 'open',
    }, OWNER_IDENTITY)
    const m2Owner = await brain.memory.service.ingest({
      kind: 'chat.message', channel: chOrigin, subjects: ['p_alice'], actor: 'p_alice',
      content: { text: '前2主人机密' }, tEvent: 3000, idempotencyKey: 'sec-2', visibility: 'owner',
    }, OWNER_IDENTITY)
    const m3Hit = await brain.memory.service.ingest({
      kind: 'chat.message', channel: chOrigin, subjects: ['p_alice'], actor: 'p_alice',
      content: { text: '命中关键抹茶拿铁' }, tEvent: 4000, idempotencyKey: 'sec-3', visibility: 'open',
    }, OWNER_IDENTITY)
    const m4Origin = await brain.memory.service.ingest({
      kind: 'chat.message', channel: chOrigin, subjects: ['p_alice'], actor: 'p_alice',
      content: { text: '后1仅原通道' }, tEvent: 5000, idempotencyKey: 'sec-4', visibility: 'origin',
    }, OWNER_IDENTITY)
    const m5Subject = await brain.memory.service.ingest({
      kind: 'chat.message', channel: chOrigin, subjects: ['p_alice'], actor: 'p_alice',
      content: { text: '后2仅当事人不在场' }, tEvent: 6000, idempotencyKey: 'sec-5', visibility: 'subject',
    }, OWNER_IDENTITY)
    await brain.memory.service.flush()

    const viewer = agentViewer(chViewer, ['p_bob'])
    const res = await brain.memory.service.search({ query: '抹茶拿铁', scope: 'all', neighbors: 2 }, viewer)
    assert.equal(res.items.length, 1)
    assert.equal(res.items[0]?.record.id, m3Hit.id)
    assert.deepEqual(res.items[0]?.neighbors?.map((n) => n.record.id), [m1.id])
    assert.equal(res.items[0]?.neighbors?.some((n) => n.record.id === m0.id), false)

    const auditedIds = new Set(auditRows(brain).map((row) => row.recordId))
    assert.equal(auditedIds.has(m3Hit.id), true)
    assert.equal(auditedIds.has(m1.id), true)
    assert.equal(auditedIds.has(m2Owner.id), false)
    assert.equal(auditedIds.has(m4Origin.id), false)
    assert.equal(auditedIds.has(m5Subject.id), false)
  } finally {
    await brain.close()
  }
})

test('conclusion-only neighbors expose only conclusion and neighbors lacking conclusion are dropped without audit', async () => {
  const brain = await openTempBrain({ crossChannelMode: () => 'on' })
  try {
    const chOrigin = 'qq:group:11'
    const chViewer = 'qq:group:21'
    const intWithConc = await brain.memory.service.ingest({
      kind: 'chat.message', channel: chOrigin, subjects: ['p_alice'], actor: 'p_alice',
      content: { text: '秘密原话1', conclusion: '可见结论' }, tEvent: 1000, idempotencyKey: 'conc-1', visibility: 'internal',
    }, OWNER_IDENTITY)
    const hit = await brain.memory.service.ingest({
      kind: 'chat.message', channel: chOrigin, subjects: ['p_alice'], actor: 'p_alice',
      content: { text: '公开命中草莓蛋糕' }, tEvent: 2000, idempotencyKey: 'conc-2', visibility: 'open',
    }, OWNER_IDENTITY)
    const intNoConc = await brain.memory.service.ingest({
      kind: 'chat.message', channel: chOrigin, subjects: ['p_alice'], actor: 'p_alice',
      content: { text: '没有结论的内部记录' }, tEvent: 3000, idempotencyKey: 'conc-3', visibility: 'internal',
    }, OWNER_IDENTITY)
    await brain.memory.service.flush()

    const res = await brain.memory.service.search({ query: '草莓蛋糕', scope: 'all', neighbors: 1 }, agentViewer(chViewer, ['p_bob']))
    assert.equal(res.items.length, 1)
    assert.equal(res.items[0]?.neighbors?.length, 1)
    assert.deepEqual(res.items[0]?.neighbors?.[0]?.record.content, { conclusion: '可见结论' })
    assert.equal(res.items[0]?.neighbors?.[0]?.record.id, intWithConc.id)

    const auditedIds = new Set(auditRows(brain).map((row) => row.recordId))
    assert.equal(auditedIds.has(hit.id), true)
    assert.equal(auditedIds.has(intWithConc.id), true)
    assert.equal(auditedIds.has(intNoConc.id), false)
  } finally {
    await brain.close()
  }
})

test('neighbors fall back to store.list when store does not implement neighborsOf', async () => {
  const parts = await openParts()
  try {
    const storeWithoutNeighbors: RecordStore = {
      insert: (r, k) => parts.store.insert(r, k),
      get: (id) => parts.store.get(id),
      patch: (id, p, v) => parts.store.patch(id, p, v),
      tombstone: (id) => parts.store.tombstone(id),
      list: (f, p) => parts.store.list(f, p),
      dependentsOf: (id) => parts.store.dependentsOf(id),
      scan: (l) => parts.store.scan(l),
      close: () => parts.store.close(),
    }
    const service = facadeOf(parts, { store: storeWithoutNeighbors })

    const ch = 'qq:private:fallback'
    const a = await service.ingest({
      kind: 'chat.message', channel: ch, subjects: ['p_alice'], actor: 'p_alice',
      content: { text: '第一句' }, tEvent: 1000, idempotencyKey: 'fb-1', visibility: 'open',
    }, OWNER_IDENTITY)
    const b = await service.ingest({
      kind: 'chat.message', channel: ch, subjects: ['p_alice'], actor: 'p_alice',
      content: { text: '中间句菠萝包' }, tEvent: 1000, idempotencyKey: 'fb-2', visibility: 'open',
    }, OWNER_IDENTITY)
    const c = await service.ingest({
      kind: 'chat.message', channel: ch, subjects: ['p_alice'], actor: 'p_alice',
      content: { text: '第三句' }, tEvent: 2000, idempotencyKey: 'fb-3', visibility: 'open',
    }, OWNER_IDENTITY)
    await service.flush()

    const res = await service.search({ query: '菠萝包', scope: 'here', neighbors: 1 }, agentViewer(ch, ['p_alice']))
    assert.equal(res.items.length, 1)
    assert.equal(res.items[0]?.record.id, b.id)
    assert.deepEqual(res.items[0]?.neighbors?.map((n) => n.record.id), [a.id, c.id])
  } finally {
    await parts.close()
  }
})

test('history: true returns outdated/archived L1 values & l3.person history, excludes tombstoned/invisible, and /context stays active-only', async () => {
  const brain = await openTempBrain({
    ownerChannels: ['qq:private:owner'],
    crossChannelMode: () => 'on',
  })
  try {
    const ch = 'qq:group:history'
    const p1 = await brain.memory.identity.resolve('qq:1001')
    const p2 = await brain.memory.identity.resolve('qq:1002')
    await brain.memory.identity.merge(p1, p2)

    const ev = await brain.memory.service.ingest({
      kind: 'chat.message', channel: ch, subjects: [p2], actor: p2,
      content: { text: '换城市了' }, tEvent: 5000, idempotencyKey: 'hist-ev', visibility: 'open',
    }, OWNER_IDENTITY)

    const oldArchived = await brain.memory.service.record({
      layer: 'L1', kind: 'l1.fact', channel: ch, subjects: [p1], actor: p1,
      content: { key: 'city', value: '广州', text: '以前住在广州' }, evidence: [{ id: ev.id }],
      visibility: 'open', tEvent: 1000,
    }, OWNER_IDENTITY)
    await brain.memory.service.update(oldArchived.id, { status: 'archived', validTo: 2000 }, 1, OWNER_IDENTITY, OWNER_VIEWER)

    const oldOutdated = await brain.memory.service.record({
      layer: 'L1', kind: 'l1.fact', channel: ch, subjects: [p2], actor: p2,
      content: { key: 'city', value: '上海', text: '后来住在上海' }, evidence: [{ id: ev.id }],
      visibility: 'open', tEvent: 3000,
    }, OWNER_IDENTITY)
    await brain.memory.service.update(oldOutdated.id, { status: 'outdated', validTo: 4000 }, 1, OWNER_IDENTITY, OWNER_VIEWER)

    const oldSecretOwner = await brain.memory.service.record({
      layer: 'L1', kind: 'l1.fact', channel: ch, subjects: [p2], actor: p2,
      content: { key: 'city', value: '秘密地址', text: '主人私密旧址' }, evidence: [{ id: ev.id }],
      visibility: 'owner', tEvent: 3500,
    }, OWNER_IDENTITY)
    await brain.memory.service.update(oldSecretOwner.id, { status: 'outdated', validTo: 3600 }, 1, OWNER_IDENTITY, OWNER_VIEWER)

    const oldTombstoned = await brain.memory.service.record({
      layer: 'L1', kind: 'l1.fact', channel: ch, subjects: [p2], actor: p2,
      content: { key: 'city', value: '被遗忘城市', text: '彻底忘记的旧址' }, evidence: [{ id: ev.id }],
      visibility: 'open', tEvent: 2500,
    }, OWNER_IDENTITY)
    await brain.memory.service.update(oldTombstoned.id, { status: 'outdated', validTo: 2600 }, 1, OWNER_IDENTITY, OWNER_VIEWER)
    await brain.memory.service.forget({ by: 'record', id: oldTombstoned.id })

    const activeFact = await brain.memory.service.record({
      layer: 'L1', kind: 'l1.fact', channel: ch, subjects: [p2], actor: p2,
      content: { key: 'city', value: '杭州', text: '现在定居杭州' }, evidence: [{ id: ev.id }],
      visibility: 'open', tEvent: 5000,
    }, OWNER_IDENTITY)
    await brain.memory.service.flush()

    const groupViewer = agentViewer(ch, [p2])
    const noHistory = await brain.memory.service.search({ query: '定居杭州', scope: 'here' }, groupViewer)
    assert.equal(noHistory.items[0]?.history, undefined)

    const withHistory = await brain.memory.service.search({ query: '定居杭州', scope: 'here', history: true }, groupViewer)
    assert.equal(withHistory.items.length, 1)
    assert.equal(withHistory.items[0]?.record.id, activeFact.id)
    assert.deepEqual(
      withHistory.items[0]?.history,
      [
        { id: oldOutdated.id, key: 'city', value: '上海', text: '后来住在上海', changedAt: 4000, status: 'outdated', label: '已变更' },
        { id: oldArchived.id, key: 'city', value: '广州', text: '以前住在广州', changedAt: 2000, status: 'archived', label: '已变更' },
      ],
    )
    validate('SearchHit', withHistory.items[0])

    // /context only injects active records, never outdated/archived/tombstoned history.
    const ctx = await brain.memory.service.context({ channel: ch }, groupViewer)
    const factItems = ctx.blocks.find((b) => b.name === 'facts')?.items ?? []
    assert.deepEqual(factItems.map((i) => i.id), [activeFact.id])
  } finally {
    await brain.close()
  }
})

test('history: true maps l3.person content.history entries and respects internal/scope boundaries', async () => {
  const parts = await openParts()
  try {
    const service = facadeOf(parts, { crossChannelMode: () => 'on' })
    const ev = await service.ingest({
      kind: 'chat.message', channel: 'qq:group:1', subjects: ['p_alice'], actor: 'p_alice',
      content: { text: '聊咖啡' }, tEvent: 1000, idempotencyKey: 'l3p-ev', visibility: 'open',
    }, OWNER_IDENTITY)
    const personRecord = await parts.store.insert({
      layer: 'L3',
      kind: 'l3.person',
      source: 'kernel',
      actor: 'kernel',
      channel: 'kernel:person:p_alice',
      subjects: ['p_alice'],
      content: {
        personId: 'p_alice',
        text: '人物档案 小雪 咖啡',
        preferences: { drink: { value: '手冲黑咖啡', source: 'said', confidence: 0.95, updatedAt: 6000 } },
        history: [
          { section: 'preferences', key: 'drink', value: '冰拿铁', source: 'said', confidence: 0.8, updatedAt: 1000, supersededAt: 5500 },
          { section: 'identity', key: 'tags', value: ['猫奴', '早起'], source: 'inferred', confidence: 0.7, updatedAt: 500, supersededAt: 4000 },
        ],
      },
      evidence: [{ id: ev.id }],
      visibility: 'open',
      trust: 'self',
      confidence: 0.9,
      importance: 0.8,
      tEvent: 6000,
    })
    await parts.index.add(personRecord)

    const viewer = agentViewer('qq:group:1', ['p_alice'])
    const res = await service.search({ query: '小雪', scope: 'all', layers: ['L3'], history: true }, viewer)
    assert.equal(res.items.length, 1)
    assert.deepEqual(res.items[0]?.history, [
      { key: 'preferences.drink', value: '冰拿铁', text: '冰拿铁', changedAt: 5500, status: 'outdated', label: '已变更' },
      { key: 'identity.tags', value: ['猫奴', '早起'], text: '["猫奴","早起"]', changedAt: 4000, status: 'outdated', label: '已变更' },
    ])
    validate('SearchHit', res.items[0])

    // Scope 'here' does not pull outdated L1 history from another channel even if visibility is open.
    const l1OtherCh = await service.record({
      layer: 'L1', kind: 'l1.fact', channel: 'qq:group:2', subjects: ['p_alice'], actor: 'p_alice',
      content: { key: 'snack', value: '薯片', text: '以前吃薯片' }, evidence: [{ id: ev.id }], visibility: 'open', tEvent: 1000,
    }, OWNER_IDENTITY)
    await service.update(l1OtherCh.id, { status: 'outdated', validTo: 1500 }, 1, OWNER_IDENTITY, OWNER_VIEWER)
    const l1Here = await service.record({
      layer: 'L1', kind: 'l1.fact', channel: 'qq:group:1', subjects: ['p_alice'], actor: 'p_alice',
      content: { key: 'snack', value: '坚果', text: '现在吃坚果' }, evidence: [{ id: ev.id }], visibility: 'open', tEvent: 2000,
    }, OWNER_IDENTITY)
    await service.flush()

    const hereHist = await service.search({ query: '坚果', scope: 'here', history: true }, viewer)
    assert.equal(hereHist.items.length, 1)
    assert.equal(hereHist.items[0]?.record.id, l1Here.id)
    assert.equal(hereHist.items[0]?.history, undefined)
  } finally {
    await parts.close()
  }
})

test('legacy L0 records receive the archive tone suffix in search hits and neighbors, but not L1 or non-legacy L0', async () => {
  const brain = await openTempBrain()
  try {
    const ch = 'qq:private:legacy'
    const legNeighbor = await brain.memory.service.ingest({
      kind: 'chat.message', channel: ch, subjects: ['p_alice'], actor: 'p_alice',
      content: { text: '旧存档前一句', legacy: true }, tEvent: 1000, idempotencyKey: 'leg-0', visibility: 'open',
    }, OWNER_IDENTITY)
    const legHit = await brain.memory.service.ingest({
      kind: 'chat.message', channel: ch, subjects: ['p_alice'], actor: 'p_alice',
      content: { text: '旧存档铁观音', legacy: true }, tEvent: 2000, idempotencyKey: 'leg-1', visibility: 'open',
    }, OWNER_IDENTITY)
    const normalNeighbor = await brain.memory.service.ingest({
      kind: 'chat.message', channel: ch, subjects: ['p_alice'], actor: 'p_alice',
      content: { text: '新系统后一句' }, tEvent: 3000, idempotencyKey: 'leg-2', visibility: 'open',
    }, OWNER_IDENTITY)
    const l1WithLegacy = await brain.memory.service.record({
      layer: 'L1', kind: 'l1.fact', channel: ch, subjects: ['p_alice'], actor: 'p_alice',
      content: { text: '提取出的铁观音偏好', legacy: true }, evidence: [{ id: legHit.id }], visibility: 'open',
    }, OWNER_IDENTITY)
    await brain.memory.service.flush()

    const viewer: Viewer = agentViewer(ch, ['p_alice'])
    const res = await brain.memory.service.search({ query: '铁观音', scope: 'here', neighbors: 1 }, viewer)
    const l0Res = res.items.find((i) => i.record.id === legHit.id)
    const l1Res = res.items.find((i) => i.record.id === l1WithLegacy.id)
    assert.ok(l0Res !== undefined && l1Res !== undefined)

    assert.equal(l0Res.disclosure.label.endsWith(LEGACY_SUFFIX), true)
    assert.equal(l0Res.disclosure.label.split(LEGACY_SUFFIX).length - 1, 1)
    assert.equal(l1Res.disclosure.label.includes(LEGACY_SUFFIX), false)

    const prevNeighbor = l0Res.neighbors?.find((n) => n.record.id === legNeighbor.id)
    const nextNeighbor = l0Res.neighbors?.find((n) => n.record.id === normalNeighbor.id)
    assert.ok(prevNeighbor !== undefined && nextNeighbor !== undefined)
    assert.equal(prevNeighbor.disclosure.label.endsWith(LEGACY_SUFFIX), true)
    assert.equal(nextNeighbor.disclosure.label.includes(LEGACY_SUFFIX), false)
  } finally {
    await brain.close()
  }
})

test('pickSearchRequest validates neighbors=1.5 even with zero hits, withLegacyDisclosure is idempotent, and visible+injection=none is dropped without audit', async () => {
  const parts = await openParts()
  try {
    const baseService = facadeOf(parts)
    // 1. Non-integer neighbors rejected at pickSearchRequest before index/neighborsOf runs (zero hits).
    for (const bad of [1.5, -1, 11]) {
      await assert.rejects(
        () => baseService.search({ query: '完全不存在的关键词xyz', scope: 'here', neighbors: bad }, agentViewer('qq:group:1', ['p_alice'])),
        (error: unknown) => error instanceof BrainError && error.code === 'INVALID_ARGUMENT',
      )
    }

    // 2. withLegacyDisclosure does not duplicate suffix when policy label already carries it.
    const ch = 'qq:private:idemp'
    const legA = await baseService.ingest({
      kind: 'chat.message', channel: ch, subjects: ['p_alice'], actor: 'p_alice',
      content: { text: '旧系统邻居', legacy: true }, tEvent: 1000, idempotencyKey: 'idemp-1', visibility: 'open',
    }, OWNER_IDENTITY)
    const legB = await baseService.ingest({
      kind: 'chat.message', channel: ch, subjects: ['p_alice'], actor: 'p_alice',
      content: { text: '旧系统桂花糕', legacy: true }, tEvent: 2000, idempotencyKey: 'idemp-2', visibility: 'open',
    }, OWNER_IDENTITY)
    await baseService.flush()

    const preLabeledService = facadeOf(parts, {
      policy: {
        decide: () => ({
          visible: true,
          injection: 'verbatim',
          disclosure: { speakable: 'yes', label: `就在这里说过${LEGACY_SUFFIX}` },
        }),
      },
    })
    const preRes = await preLabeledService.search({ query: '桂花糕', scope: 'here', neighbors: 1 }, agentViewer(ch, ['p_alice']))
    assert.equal(preRes.items.length, 1)
    assert.equal(preRes.items[0]?.record.id, legB.id)
    assert.equal(preRes.items[0]?.disclosure.label, `就在这里说过${LEGACY_SUFFIX}`)
    assert.equal(preRes.items[0]?.neighbors?.length, 1)
    assert.equal(preRes.items[0]?.neighbors?.[0]?.record.id, legA.id)
    assert.equal(preRes.items[0]?.neighbors?.[0]?.disclosure.label, `就在这里说过${LEGACY_SUFFIX}`)

    // 3. visible: true with injection: 'none' is dropped for both main hits and neighbors, and never audited.
    const chOrigin = 'qq:group:none-origin'
    const chViewer = 'qq:group:none-viewer'
    const nVisible = await baseService.ingest({
      kind: 'chat.message', channel: chOrigin, subjects: ['p_alice'], actor: 'p_alice',
      content: { text: '可见前邻' }, tEvent: 1000, idempotencyKey: 'none-1', visibility: 'open',
    }, OWNER_IDENTITY)
    const hitVisible = await baseService.ingest({
      kind: 'chat.message', channel: chOrigin, subjects: ['p_alice'], actor: 'p_alice',
      content: { text: '可见黑芝麻糊' }, tEvent: 2000, idempotencyKey: 'none-2', visibility: 'open',
    }, OWNER_IDENTITY)
    const nNone = await baseService.ingest({
      kind: 'chat.message', channel: chOrigin, subjects: ['p_alice'], actor: 'p_alice',
      content: { text: '策略禁注后邻' }, tEvent: 3000, idempotencyKey: 'none-3', visibility: 'open',
    }, OWNER_IDENTITY)
    const hitNone = await baseService.ingest({
      kind: 'chat.message', channel: chOrigin, subjects: ['p_alice'], actor: 'p_alice',
      content: { text: '策略禁注黑芝麻糊' }, tEvent: 4000, idempotencyKey: 'none-4', visibility: 'open',
    }, OWNER_IDENTITY)
    await baseService.flush()

    const noneIds = new Set([nNone.id, hitNone.id])
    const nonePolicyService = facadeOf(parts, {
      crossChannelMode: () => 'on',
      policy: {
        decide: (rec) => noneIds.has(rec.id)
          ? { visible: true, injection: 'none', disclosure: { speakable: 'never', label: '禁止注入' } }
          : { visible: true, injection: 'verbatim', disclosure: { speakable: 'yes', label: '在群里听说的' } },
      },
    })
    const noneRes = await nonePolicyService.search({ query: '黑芝麻糊', scope: 'all', neighbors: 1 }, agentViewer(chViewer, ['p_alice']))
    assert.deepEqual(noneRes.items.map((item) => item.record.id), [hitVisible.id])
    assert.deepEqual(noneRes.items[0]?.neighbors?.map((n) => n.record.id), [nVisible.id])

    const audited = new Set((await parts.audit.list()).map((entry) => entry.recordId))
    assert.equal(audited.has(hitVisible.id), true)
    assert.equal(audited.has(nVisible.id), true)
    assert.equal(audited.has(hitNone.id), false)
    assert.equal(audited.has(nNone.id), false)
  } finally {
    await parts.close()
  }
})
