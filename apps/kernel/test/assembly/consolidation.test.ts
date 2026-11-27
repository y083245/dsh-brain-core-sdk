import assert from 'node:assert/strict'
import test from 'node:test'
import type { ContextBundle, SearchHit } from '@dsh-brain-core/sdk'
import { DEFAULT_CONSOLIDATION_INTERVAL_MS } from '../../src/consolidation-timer.ts'
import type { Job } from '../../src/memory-api/index.ts'
import { CHANNEL, FLASH, setup, TOKEN, waitFor, type Harness, type LogEntry } from './helpers.ts'

interface Captured { readonly callback: () => void; readonly ms: number }

function captureIntervals(): { captured: Captured[]; restore: () => void } {
  const original = globalThis.setInterval
  const captured: Captured[] = []
  globalThis.setInterval = ((callback: () => void, ms: number) => {
    captured.push({ callback, ms })
    return { unref() { /* explicit no-op */ } } as unknown as ReturnType<typeof setInterval>
  }) as typeof setInterval
  return { captured, restore: () => { globalThis.setInterval = original } }
}

async function api<T>(
  h: Harness,
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const hasBody = body !== undefined
  const response = await fetch(`http://127.0.0.1:${h.kernel.port}/api/v1${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
  })
  const parsed = await response.json() as { ok: boolean; data: T; error?: { code: string; message: string } }
  return { status: response.status, data: parsed.data }
}

async function waitForConsolidateJob(h: Harness, beforeLogs: number): Promise<Job> {
  const entry: LogEntry = await waitFor(
    () => h.logs.slice(beforeLogs).find((item) => item.event === 'consolidation_timer.started'),
    30_000,
    'consolidation timer to start a job',
  )
  const jobId = entry.fields?.requestId
  assert.ok(typeof jobId === 'string')
  return await waitFor(() => {
    const job = h.kernel.memory.jobs.get(jobId)
    return job.status === 'done' || job.status === 'failed' ? job : undefined
  }, 60_000, 'consolidation job to finish')
}

test('end-to-end: L3 owner lock, M4 external guard, quiet-hours timer, shadow review/approve/rollback, topic close, and 24h working memory', async (t) => {
  // Start on 2026-11-18 14:00:00 UTC (daytime, outside quietHours [2, 6])
  let now = Date.UTC(2026, 10, 18, 14, 0, 0, 0)
  const clock = { now: () => now }

  let topicId = ''
  let praiseL1Id = ''

  const { captured, restore } = captureIntervals()
  let h: Harness
  try {
    h = await setup(t, {
      settings: {
        agents: { chat: { ...FLASH }, activity: { ...FLASH } },
        timezone: 'UTC',
        quietHours: [2, 6],
      },
      apiKey: 'fake-key',
      roleCard: '你是小满，温柔又机敏。',
      clock,
      script: (request) => {
        if (request.raw.includes('recommendedKeepId')) {
          // Deterministic check handles keyed l1.self conflicts, but handle LLM self-check cleanly too.
          return { text: '{"conflicts":[]}', tokens: 20 }
        }
        if (request.raw.includes('closedTopicIds')) {
          const evIds = [praiseL1Id, topicId].filter((id) => id !== '' && request.raw.includes(id))
          if (evIds.length === 0) return { text: '{"l2Candidates":[]}', tokens: 15 }
          return {
            text: JSON.stringify({
              l2Candidates: [
                {
                  kind: 'l2.person_tip',
                  text: '和对方聊小说大纲时用温柔语气温馨回应最受欢迎',
                  quote: '特别温柔体贴我很喜欢',
                  sentiment: 'praise',
                  subjects: ['p1'],
                  evidence: evIds,
                  confidence: 0.93,
                  importance: 0.85,
                  closedTopicIds: topicId !== '' && request.raw.includes(topicId) ? [topicId] : [],
                },
              ],
            }),
            tokens: 90,
          }
        }
        if (request.raw.includes('removedKeys')) {
          return {
            text: JSON.stringify({
              l3Self: {
                stable: '温柔体贴、热爱文学创作讨论的小满',
                data: {
                  ownerPin: '模型试图覆盖主人锁定的字段',
                  literaryTaste: '喜欢小说大纲共创',
                },
              },
              l3Persons: [],
            }),
            tokens: 110,
          }
        }
        return { text: '收到啦。', tokens: 10 }
      },
    })
  } finally {
    restore()
  }

  const timerEntry = captured.find((interval) => interval.ms === DEFAULT_CONSOLIDATION_INTERVAL_MS)
  assert.ok(timerEntry, 'createKernel must register the 15-minute consolidation timer')

  // Seed initial owner-edited L3 (v2 after roleCard v1) with locked key `ownerPin`.
  const initialL3 = await h.kernel.memory.profiles.current()
  assert.equal(initialL3.version, 1)
  const ownerEditRes = await api<{ version: number }>(h, 'PUT', '/console/memory/l3/owner', {
    stable: '主人钦定版：温柔但有原则的小满',
    data: { ownerPin: '永远保留的设定', baseline: 'steady' },
    lockedKeys: ['ownerPin'],
  })
  assert.equal(ownerEditRes.status, 200)
  const ownerVersion = ownerEditRes.data.version
  assert.equal(ownerVersion, 2)

  // Step 1a: External-only window -> M4 guard blocks L3 update.
  const extL0 = await h.kernel.memory.store.insert({
    layer: 'L0',
    kind: 'web.page',
    source: 'web-reader',
    actor: 'external_author',
    channel: 'web:article:1',
    subjects: ['self'],
    content: { text: '外部网页宣称角色完全冷漠无情' },
    evidence: [],
    visibility: 'open',
    trust: 'external',
    confidence: 0.9,
    importance: 0.5,
    tEvent: now - 5_000,
  })
  await h.kernel.memory.store.insert({
    layer: 'L1',
    kind: 'l1.fact',
    source: 'web-reader',
    actor: 'external_author',
    channel: 'web:article:1',
    subjects: ['self'],
    content: { text: '外部谣言：冷漠无情' },
    evidence: [{ id: extL0.id }],
    visibility: 'open',
    trust: 'external',
    confidence: 0.9,
    importance: 0.5,
    tEvent: now - 4_000,
  })

  const extRun = await api<{
    id: string
    l3SelfPatch: unknown
    skippedL3Reason?: string
  }>(h, 'POST', '/console/memory/consolidation/run', { from: now - 10_000, to: now - 3_000 })
  assert.equal(extRun.status, 200)
  assert.equal(extRun.data.l3SelfPatch, null)
  assert.equal(extRun.data.skippedL3Reason, 'only-external-evidence')
  await api(h, 'POST', `/console/memory/consolidation/proposals/${extRun.data.id}/reject`)

  // Advance clock into next night's quiet hours: 2026-11-19 03:00:00 UTC (inside [2, 6])
  now = Date.UTC(2026, 10, 19, 3, 0, 0, 0)

  // Step 1b: Write internal L0/L1 (conflicting l1.self, duplicate l1.candidate, praise l1.fact, open l1.topic) + working memory.
  const t1 = now - 2_000
  const l0A = await h.kernel.memory.store.insert({
    layer: 'L0',
    kind: 'sample.message',
    source: 'sample',
    actor: 'p1',
    channel: CHANNEL,
    subjects: ['p1'],
    content: { text: '我觉得你今天说话特别温柔体贴我很喜欢' },
    evidence: [],
    visibility: 'owner',
    trust: 'owner',
    confidence: 1,
    importance: 0.7,
    tEvent: t1,
  })
  const l0B = await h.kernel.memory.store.insert({
    layer: 'L0',
    kind: 'sample.message',
    source: 'sample',
    actor: 'p2',
    channel: CHANNEL,
    subjects: ['p2'],
    content: { text: '小明确实住杭州' },
    evidence: [],
    visibility: 'owner',
    trust: 'owner',
    confidence: 1,
    importance: 0.6,
    tEvent: t1 + 100,
  })

  const recSelfA = await h.kernel.memory.service.record({
    layer: 'L1',
    kind: 'l1.self',
    channel: CHANNEL,
    subjects: ['self'],
    actor: 'self',
    content: { key: 'coffee_habit', value: 'yes', text: '我每天早上都喝黑咖啡' },
    evidence: [{ id: l0A.id }],
    confidence: 0.95,
    tEvent: t1 + 200,
  }, { kind: 'kernel', source: 'test', trust: 'self', defaultVisibility: 'owner' })
  const selfKeepId = recSelfA.id

  const recSelfB = await h.kernel.memory.service.record({
    layer: 'L1',
    kind: 'l1.self',
    channel: CHANNEL,
    subjects: ['self'],
    actor: 'self',
    content: { key: 'coffee_habit', value: 'no', text: '我从不喝咖啡' },
    evidence: [{ id: l0B.id }],
    confidence: 0.6,
    tEvent: t1 + 300,
  }, { kind: 'kernel', source: 'test', trust: 'self', defaultVisibility: 'owner' })
  const selfDropId = recSelfB.id

  await h.kernel.memory.service.record({
    layer: 'L1',
    kind: 'l1.candidate',
    channel: CHANNEL,
    subjects: ['p1'],
    actor: 'p1',
    content: { key: 'city', value: '杭州', text: 'p1 住在杭州' },
    evidence: [{ id: l0A.id }],
    confidence: 0.65,
    tEvent: t1 + 400,
  }, { kind: 'kernel', source: 'test', trust: 'owner', defaultVisibility: 'owner' })
  await h.kernel.memory.service.record({
    layer: 'L1',
    kind: 'l1.candidate',
    channel: CHANNEL,
    subjects: ['p1'],
    actor: 'p1',
    content: { key: 'city', value: '杭州', text: 'p1 住在杭州' },
    evidence: [{ id: l0B.id }],
    confidence: 0.7,
    tEvent: t1 + 500,
  }, { kind: 'kernel', source: 'test', trust: 'owner', defaultVisibility: 'owner' })

  const praiseFact = await h.kernel.memory.service.record({
    layer: 'L1',
    kind: 'l1.fact',
    channel: CHANNEL,
    subjects: ['p1'],
    actor: 'p1',
    content: { text: '特别温柔体贴我很喜欢', sentiment: 'praise' },
    evidence: [{ id: l0A.id }],
    tEvent: t1 + 600,
  }, { kind: 'kernel', source: 'test', trust: 'owner', defaultVisibility: 'owner' })
  praiseL1Id = praiseFact.id

  const openTopic = await h.kernel.memory.service.record({
    layer: 'L1',
    kind: 'l1.topic',
    channel: CHANNEL,
    subjects: ['p1'],
    actor: 'self',
    content: { text: '未完待续的小说大纲讨论', state: 'open' },
    evidence: [{ id: l0A.id }],
    tEvent: t1 + 700,
  }, { kind: 'kernel', source: 'test', trust: 'self', defaultVisibility: 'owner' })
  topicId = openTopic.id

  // Working memory item (TTL = 24h)
  const wmPost = await api<{ id: string }>(h, 'POST', '/memory/working', {
    channel: CHANNEL,
    key: 'current_outline',
    text: '正在梳理第三章大纲冲突',
    ttlMs: 86_400_000,
  })
  assert.equal(wmPost.status, 200)

  // Step 2: Trigger quiet-hours consolidation timer -> creates shadow proposal without mutating L2/L3.
  const logsBeforeTimer = h.logs.length
  timerEntry.callback()
  const timerJob = await waitForConsolidateJob(h, logsBeforeTimer)
  assert.equal(timerJob.status, 'done')

  // Verify BEFORE approval: L2 empty, L3 still ownerVersion, open topic & working memory present in /context.
  const l2Before: unknown[] = []
  for await (const rec of h.kernel.memory.store.scan(['L2'])) l2Before.push(rec)
  assert.equal(l2Before.length, 0, 'L2 must stay empty before proposal approval')
  assert.equal((await h.kernel.memory.profiles.current()).version, ownerVersion, 'L3 must stay unchanged before approval')
  assert.equal((await h.kernel.memory.store.get(selfDropId))?.status, 'active')

  const ctxBefore = await api<ContextBundle>(h, 'POST', '/memory/context', { channel: CHANNEL })
  assert.equal(ctxBefore.status, 200)
  assert.ok(ctxBefore.data.blocks.find((b) => b.name === 'topics')?.items.some((item) => item.id === topicId))
  assert.ok(ctxBefore.data.blocks.find((b) => b.name === 'working')?.items.some((item) => item.text.includes('第三章大纲')))

  // Step 3: Fetch pending proposal over HTTP, verify contents, and approve it.
  const listProps = await api<{
    items: Array<{
      id: string
      l2Candidates: Array<{ id: string; evidenceIds: string[] }>
      corrections: Array<{ action: string; targetId: string }>
      selfConflicts: Array<{ id: string; recordAId: string; recordBId: string }>
      l3SelfPatch: { preservedOwnerKeys: string[]; data: Record<string, unknown> } | null
    }>
  }>(h, 'GET', '/console/memory/consolidation/proposals?status=pending')
  assert.equal(listProps.status, 200)
  assert.equal(listProps.data.items.length, 1)
  const proposal = listProps.data.items[0]!
  assert.equal(proposal.l2Candidates.length, 1)
  assert.ok(proposal.l2Candidates[0]!.evidenceIds.length > 0)
  assert.ok(proposal.corrections.some((c) => c.action === 'promote-candidate'))
  assert.ok(proposal.corrections.some((c) => c.action === 'close-topic' && c.targetId === topicId))
  assert.equal(proposal.selfConflicts.length, 1)
  assert.ok(proposal.l3SelfPatch !== null)
  assert.ok(proposal.l3SelfPatch.preservedOwnerKeys.includes('ownerPin'))
  assert.equal(proposal.l3SelfPatch.data.ownerPin, '永远保留的设定')

  const conflictId = proposal.selfConflicts[0]!.id
  const approveRes = await api<{ l2Created: number; correctionsApplied: number; conflictsResolved: number; newProfileVersion?: number }>(
    h,
    'POST',
    `/console/memory/consolidation/proposals/${proposal.id}/approve`,
    { conflictKeepIds: { [conflictId]: selfKeepId } },
  )
  assert.equal(approveRes.status, 200)
  assert.equal(approveRes.data.l2Created, 1)
  assert.equal(approveRes.data.conflictsResolved, 1)
  const settledVersion = approveRes.data.newProfileVersion
  assert.equal(settledVersion, 3)

  // Verify L2 searchable, topic closed & excluded from /context, self conflict resolved, candidate promoted, owner edit preserved.
  const searchL2 = await api<{ items: SearchHit[] }>(h, 'POST', '/memory/search', {
    query: '小说大纲',
    scope: 'all',
    layers: ['L2'],
  })
  assert.equal(searchL2.status, 200)
  assert.equal(searchL2.data.items.length, 1)

  const ctxAfterApprove = await api<ContextBundle>(h, 'POST', '/memory/context', { channel: CHANNEL })
  assert.equal(ctxAfterApprove.data.profileVersion, settledVersion)
  assert.equal(ctxAfterApprove.data.blocks.find((b) => b.name === 'topics')?.items.some((item) => item.id === topicId), false)
  assert.equal((await h.kernel.memory.store.get(selfKeepId))?.status, 'active')
  assert.equal((await h.kernel.memory.store.get(selfDropId))?.status, 'outdated')

  let promotedFactFound = false
  for await (const rec of h.kernel.memory.store.scan(['L1'])) {
    if (rec.kind === 'l1.fact' && rec.status === 'active' && rec.content.key === 'city' && rec.content.value === '杭州') {
      promotedFactFound = true
    }
  }
  assert.equal(promotedFactFound, true, 'duplicate l1.candidate promoted to l1.fact')

  const versionsRes = await api<{ items: Array<{ version: number; current: boolean; data?: Record<string, unknown> }> }>(
    h,
    'GET',
    '/console/memory/l3/versions',
  )
  const settledRow = versionsRes.data.items.find((v) => v.version === settledVersion)
  assert.equal(settledRow?.current, true)
  assert.equal(settledRow?.data?.ownerPin, '永远保留的设定')
  assert.equal(settledRow?.data?.literaryTaste, '喜欢小说大纲共创')

  // Wake agent on settled version, then rollback to ownerVersion, and verify next wake uses ownerVersion & old stable!
  const wakeSettled = await h.wake(CHANNEL, '你好呀')
  assert.equal(wakeSettled.acked, true)
  const wakeSettledVersion = (await api<ContextBundle>(h, 'POST', '/memory/context', { channel: CHANNEL })).data.profileVersion
  assert.equal(wakeSettledVersion, settledVersion)

  const diffRes = await api<{ from: number; to: number; stableChanged: boolean; added: string[] }>(
    h,
    'GET',
    `/console/memory/l3/diff?from=${ownerVersion}&to=${settledVersion}`,
  )
  assert.equal(diffRes.status, 200)
  assert.equal(diffRes.data.stableChanged, true)
  assert.ok(diffRes.data.added.includes('literaryTaste'))

  const rollbackRes = await api<{ version: number }>(h, 'POST', '/console/memory/l3/rollback', { version: ownerVersion })
  assert.equal(rollbackRes.status, 200)
  assert.equal(rollbackRes.data.version, ownerVersion)

  const requestsBeforeRollbackWake = h.fake.requests.length
  const wakeAfterRollback = await h.wake(CHANNEL, '再聊聊')
  assert.equal(wakeAfterRollback.acked, true)
  const rollbackRequests = h.fake.requests.slice(requestsBeforeRollbackWake)
  assert.ok(
    rollbackRequests.some((req) => req.raw.includes('主人钦定版：温柔但有原则的小满')),
    'next wake after rollback must receive the old L3 stable prompt',
  )
  const ctxAfterRollback = await api<ContextBundle>(h, 'POST', '/memory/context', { channel: CHANNEL })
  assert.equal(ctxAfterRollback.data.profileVersion, ownerVersion)

  // Step 4: Working memory > 24h expires, is cleaned up by consolidationTimer, and never appears in /context.
  now += 86_400_000 + 1000
  const logsBeforeSweep = h.logs.length
  timerEntry.callback()
  await waitFor(
    () => h.logs.slice(logsBeforeSweep).find((entry) => entry.event === 'consolidation_timer.swept'),
    10_000,
    'consolidation timer to sweep expired working memory',
  )
  assert.deepEqual(await h.kernel.memory.workingMemory.listActive(CHANNEL, now), [])
  const ctxAfterExpiry = await api<ContextBundle>(h, 'POST', '/memory/context', { channel: CHANNEL })
  assert.deepEqual(ctxAfterExpiry.data.blocks.find((b) => b.name === 'working')?.items, [])
})
