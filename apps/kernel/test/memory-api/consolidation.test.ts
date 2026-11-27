import assert from 'node:assert/strict'
import test from 'node:test'
import { BrainError, validate, type ContextBundle, type SearchHit } from '@dsh-brain-core/sdk'
import type { LlmClient } from '../../src/contracts/index.ts'
import { createJobRunner } from '../../src/memory-api/jobs.ts'
import { openTempBrain, openParts, OWNER_IDENTITY, startApi } from './helpers.ts'

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

function scriptLlm(handler: (system: string, user: string) => { readonly text: string; readonly tokens: number }): LlmClient {
  return {
    async complete(request) {
      return handler(request.system, request.user)
    },
  }
}

async function seedEvidence(brain: Awaited<ReturnType<typeof openTempBrain>>, key: string, text: string, actor = 'p_alice'): Promise<string> {
  const { id } = await brain.memory.service.ingest({
    kind: 'chat.message',
    channel: 'qq:private:u1',
    subjects: ['p_alice'],
    actor,
    content: { text },
    tEvent: 1_700_000_000_000,
    idempotencyKey: key,
  }, OWNER_IDENTITY)
  return id
}

test('openMemory wires decay, workingMemory, and optional consolidation engine', async () => {
  const withoutModel = await openTempBrain()
  try {
    assert.equal(typeof withoutModel.memory.decay.priorityOf, 'function')
    assert.equal(typeof withoutModel.memory.workingMemory.put, 'function')
    assert.equal(withoutModel.memory.consolidation, undefined)
  } finally {
    await withoutModel.close()
  }

  let now = 1_700_000_000_000
  const withModel = await openTempBrain({
    clock: { now: () => now },
    consolidation: {
      llm: scriptLlm(() => ({ text: '{}', tokens: 10 })),
      dailyTokenCap: 50_000,
      minNewEvidence: 1,
    },
  })
  try {
    assert.ok(withModel.memory.consolidation !== undefined)
    await withModel.memory.workingMemory.put({
      channel: 'qq:private:u1',
      key: 'step',
      text: '正在查资料',
      ttlMs: 60_000,
    })

    const beforeExpiry = await withModel.memory.service.context(
      { channel: 'qq:private:u1' },
      { caller: 'agent', channel: 'qq:private:u1', participants: ['p_alice'] },
    )
    const workingBefore = beforeExpiry.blocks.find((block) => block.name === 'working')
    assert.equal(workingBefore?.items.length, 1)
    assert.ok(workingBefore?.items[0]?.text.includes('正在查资料'))

    now += 120_000
    const afterExpiry = await withModel.memory.service.context(
      { channel: 'qq:private:u1' },
      { caller: 'agent', channel: 'qq:private:u1', participants: ['p_alice'] },
    )
    const workingAfter = afterExpiry.blocks.find((block) => block.name === 'working')
    assert.deepEqual(workingAfter?.items, [])
  } finally {
    await withModel.close()
  }
})

test('openMemory falls back to options.extraction for consolidation when options.consolidation is omitted', async () => {
  const brain = await openTempBrain({
    extraction: {
      llm: scriptLlm(() => ({ text: '{"l2Candidates":[]}', tokens: 15 })),
      dailyTokenCap: 12_345,
      maxOutputTokens: 2_000,
    },
  })
  try {
    assert.ok(brain.memory.consolidation !== undefined)
    const budget = await brain.memory.consolidation.budgetStatus()
    assert.equal(budget.dailyTokenCap, 12_345)
  } finally {
    await brain.close()
  }
})

test('consolidate job validates requests, enforces UNAVAILABLE/CONFLICT, and records proposal summary', async () => {
  const parts = await openParts()
  try {
    const noConsolidationJobs = createJobRunner({
      index: parts.index,
      store: parts.store,
      clock: { now: () => 1_700_000_000_000 },
    })
    assert.equal(codeOf(await capture(async () => noConsolidationJobs.start({ type: 'consolidate' }))), 'UNAVAILABLE')
    assert.equal(codeOf(await capture(async () => noConsolidationJobs.start({ type: 'consolidate', from: 'bad' }))), 'INVALID_ARGUMENT')
    assert.equal(codeOf(await capture(async () => noConsolidationJobs.start({ type: 'consolidate', to: Number.NaN }))), 'INVALID_ARGUMENT')
    assert.equal(codeOf(await capture(async () => noConsolidationJobs.start({ type: 'consolidate', force: 'yes' }))), 'INVALID_ARGUMENT')
  } finally {
    await parts.close()
  }

  let now = 1_700_000_000_000
  const brain = await openTempBrain({
    clock: { now: () => now },
    consolidation: {
      llm: scriptLlm((system) => {
        if (system.includes('L1→L2')) {
          return { text: '{"l2Candidates":[]}', tokens: 25 }
        }
        return { text: '{}', tokens: 10 }
      }),
      minNewEvidence: 1,
    },
  })
  try {
    const l0Id = await seedEvidence(brain, 'job-e1', '我今天喝了乌龙茶')
    await brain.memory.service.record({
      layer: 'L1',
      kind: 'l1.fact',
      channel: 'qq:private:u1',
      subjects: ['p_alice'],
      actor: 'p_alice',
      content: { key: 'tea', value: 'oolong', text: '喜欢乌龙茶' },
      evidence: [{ id: l0Id }],
      tEvent: now,
    }, OWNER_IDENTITY)

    now += 1000
    const job = brain.memory.jobs.start({ type: 'consolidate', from: 0, to: now, force: true })
    assert.equal(job.type, 'consolidate')
    assert.equal(codeOf(await capture(async () => brain.memory.jobs.start({ type: 'consolidate' }))), 'CONFLICT')

    await brain.memory.jobs.idle()
    const done = brain.memory.jobs.get(job.id)
    assert.equal(done.status, 'done')
    assert.equal(typeof done.result?.proposalId, 'string')
    assert.equal(done.result?.status, 'pending')
    assert.equal(typeof done.result?.tokensUsed, 'number')
    assert.equal(typeof done.result?.l2Candidates, 'number')
    assert.equal(typeof done.result?.corrections, 'number')
    assert.equal(typeof done.result?.selfConflicts, 'number')
  } finally {
    await brain.close()
  }
})

test('HTTP routes return safe defaults or UNAVAILABLE when consolidation is not configured', async () => {
  const brain = await openTempBrain()
  const api = await startApi(brain.memory)
  try {
    const proposals = await api.request('GET', '/console/memory/consolidation/proposals')
    assert.equal(proposals.status, 200)
    validate('Envelope', proposals.body)
    assert.deepEqual((proposals.body.data as { items: unknown[] }).items, [])

    const budget = await api.request('GET', '/console/memory/consolidation/budget')
    assert.equal(budget.status, 200)
    assert.deepEqual(budget.body.data, { usedTokensToday: 0, dailyTokenCap: 0, lastConsolidatedTo: 0 })

    assert.equal((await api.request('POST', '/console/memory/consolidation/run')).status, 503)
    assert.equal((await api.request('POST', '/console/memory/consolidation/proposals/prop_1/approve', {})).status, 503)
    assert.equal((await api.request('POST', '/console/memory/consolidation/proposals/prop_1/reject')).status, 503)
  } finally {
    await api.close()
    await brain.close()
  }
})

test('HTTP L3, consolidation, and working memory routes work end-to-end with validation', async () => {
  let now = 1_700_000_000_000
  const brain = await openTempBrain({
    clock: { now: () => now },
    consolidation: {
      llm: scriptLlm((system, user) => {
        if (system.includes('一致性检查器')) {
          return { text: '{"conflicts":[]}', tokens: 20 }
        }
        if (system.includes('L1→L2')) {
          const match = /l1_[0-9A-Z]{26}/.exec(user)
          if (match === null) return { text: '{"l2Candidates":[]}', tokens: 20 }
          return {
            text: JSON.stringify({
              l2Candidates: [{
                kind: 'l2.person_tip',
                text: '喜欢喝清香乌龙茶',
                quote: '最爱清香乌龙茶',
                sentiment: 'praise',
                subjects: ['p_alice'],
                evidence: [match[0]],
                confidence: 0.91,
                importance: 0.75,
              }],
            }),
            tokens: 80,
          }
        }
        return {
          text: JSON.stringify({
            l3Self: {
              stable: '温柔且记性好',
              data: { ownerNote: '会被主人锁定覆盖', moodStyle: 'calm' },
            },
            l3Persons: [],
          }),
          tokens: 120,
        }
      }),
      dailyTokenCap: 100_000,
      minNewEvidence: 1,
    },
  })
  const api = await startApi(brain.memory)

  try {
    const l0Id = await seedEvidence(brain, 'http-e1', '我最爱清香乌龙茶')
    await brain.memory.service.record({
      layer: 'L1',
      kind: 'l1.fact',
      channel: 'qq:private:u1',
      subjects: ['p_alice'],
      actor: 'p_alice',
      content: { text: '最爱清香乌龙茶', sentiment: 'praise' },
      evidence: [{ id: l0Id }],
      tEvent: now,
    }, OWNER_IDENTITY)

    // L3 owner edit validation & creation
    assert.equal((await api.request('PUT', '/console/memory/l3/owner', { stable: 123, data: {} })).status, 400)
    assert.equal((await api.request('PUT', '/console/memory/l3/owner', { data: [] })).status, 400)
    assert.equal((await api.request('PUT', '/console/memory/l3/owner', { data: { ownerNote: 'v1' } })).status, 400)

    const ownerV1 = await api.request('PUT', '/console/memory/l3/owner', {
      stable: '主人设定初始性格',
      data: { ownerNote: '主人亲笔备注', hobby: '茶道' },
      lockedKeys: ['ownerNote'],
      evidence: [{ id: l0Id }],
    })
    assert.equal(ownerV1.status, 200)
    assert.deepEqual(ownerV1.body.data, { version: 1 })
    assert.equal((await api.request('PUT', '/console/memory/l3/owner', { data: [] })).status, 400)

    const versionsRes = await api.request('GET', '/console/memory/l3/versions')
    assert.equal(versionsRes.status, 200)
    const versions = (versionsRes.body.data as { items: Array<Record<string, unknown>> }).items
    assert.equal(versions.length, 1)
    assert.equal(versions[0]?.version, 1)
    assert.equal(versions[0]?.author, 'owner')
    assert.equal(versions[0]?.stable, '主人设定初始性格')
    assert.deepEqual(versions[0]?.data, { ownerNote: '主人亲笔备注', hobby: '茶道' })
    assert.deepEqual(versions[0]?.ownerLockedKeys, ['hobby', 'ownerNote'])

    // Consolidation run -> shadow proposal with evidenceIds on l2Candidates
    now += 1000
    assert.equal((await api.request('POST', '/console/memory/consolidation/run', { from: 'bad' })).status, 400)
    const runRes = await api.request('POST', '/console/memory/consolidation/run', { from: 0, to: now, force: true })
    assert.equal(runRes.status, 200)
    const proposal = runRes.body.data as {
      id: string
      status: string
      l2Candidates: Array<{ evidenceIds: string[]; evidence: Array<{ id: string }> }>
      l3SelfPatch: { data: Record<string, unknown>; preservedOwnerKeys: string[] } | null
    }
    assert.equal(proposal.status, 'pending')
    assert.equal(proposal.l2Candidates.length, 1)
    assert.ok(proposal.l2Candidates[0]!.evidenceIds.length > 0)
    assert.equal(proposal.l3SelfPatch?.data.ownerNote, '主人亲笔备注')
    assert.equal(proposal.l3SelfPatch?.data.moodStyle, 'calm')

    // List proposals & filter validation
    assert.equal((await api.request('GET', '/console/memory/consolidation/proposals?status=invalid')).status, 400)
    const listedRes = await api.request('GET', '/console/memory/consolidation/proposals?status=pending')
    assert.equal(listedRes.status, 200)
    const listedItems = (listedRes.body.data as { items: unknown[] }).items
    assert.equal(listedItems.length, 1)

    const budgetRes = await api.request('GET', '/console/memory/consolidation/budget')
    assert.equal(budgetRes.status, 200)
    const budget = budgetRes.body.data as { usedTokensToday: number; dailyTokenCap: number; lastConsolidatedTo: number }
    assert.equal(budget.usedTokensToday, 200)
    assert.equal(budget.dailyTokenCap, 100_000)
    assert.equal(budget.lastConsolidatedTo, now)

    // Approve proposal
    assert.equal((await api.request('POST', '/console/memory/consolidation/proposals/missing/approve', {})).status, 404)
    assert.equal((await api.request('POST', `/console/memory/consolidation/proposals/${proposal.id}/approve`, { conflictKeepIds: { c1: 123 } })).status, 400)

    const approveRes = await api.request('POST', `/console/memory/consolidation/proposals/${proposal.id}/approve`, {})
    assert.equal(approveRes.status, 200)
    const report = approveRes.body.data as { l2Created: number; newProfileVersion?: number }
    assert.equal(report.l2Created, 1)
    assert.equal(report.newProfileVersion, 2)

    // Already approved -> CONFLICT on approve or reject
    assert.equal((await api.request('POST', `/console/memory/consolidation/proposals/${proposal.id}/reject`)).status, 409)

    // Reject flow on a second forced run
    now += 1000
    const run2 = await api.request('POST', '/console/memory/consolidation/run', { from: now - 500, to: now, force: true })
    assert.equal(run2.status, 200)
    const prop2Id = (run2.body.data as { id: string }).id
    const rejRes = await api.request('POST', `/console/memory/consolidation/proposals/${prop2Id}/reject`)
    assert.equal(rejRes.status, 200)
    assert.equal((rejRes.body.data as { status: string }).status, 'rejected')

    // Diff & Rollback routes
    assert.equal((await api.request('GET', '/console/memory/l3/diff?from=abc&to=2')).status, 400)
    assert.equal((await api.request('GET', '/console/memory/l3/diff?from=&to=1')).status, 400)
    assert.equal((await api.request('GET', '/console/memory/l3/diff?from=1&to=99')).status, 404)
    const diffRes = await api.request('GET', '/console/memory/l3/diff?from=1&to=2')
    assert.equal(diffRes.status, 200)
    assert.deepEqual(diffRes.body.data, {
      from: 1,
      to: 2,
      stableChanged: true,
      added: ['moodStyle'],
      removed: [],
      changed: [],
    })

    assert.equal((await api.request('POST', '/console/memory/l3/rollback', { version: '1' })).status, 400)
    assert.equal((await api.request('POST', '/console/memory/l3/rollback', { version: 99 })).status, 404)
    const rollbackRes = await api.request('POST', '/console/memory/l3/rollback', { version: 1 })
    assert.equal(rollbackRes.status, 200)
    assert.deepEqual(rollbackRes.body.data, { version: 1 })
    assert.equal((await brain.memory.profiles.current()).version, 1)

    // L2 searchable after approval
    const searchRes = await api.request('POST', '/memory/search', { query: '乌龙茶', scope: 'all', layers: ['L2'] })
    assert.equal(searchRes.status, 200)
    const hits = (searchRes.body.data as { items: SearchHit[] }).items
    assert.equal(hits.length, 1)

    // Working memory HTTP routes
    assert.equal((await api.request('POST', '/memory/working', 'not-an-object')).status, 400)
    assert.equal((await api.request('POST', '/memory/working', { channel: 'qq:private:u1', key: 'k', text: 'v', ttlMs: 86_400_001 })).status, 400)
    assert.equal((await api.request('GET', '/memory/working')).status, 400)

    const putWm = await api.request('POST', '/memory/working', {
      channel: 'qq:private:u1',
      key: 'topic_note',
      text: '待会核对日程',
      ttlMs: 3600_000,
    })
    assert.equal(putWm.status, 200)
    const wmItem = putWm.body.data as { id: string; key: string; text: string }
    assert.equal(wmItem.key, 'topic_note')

    const listWm = await api.request('GET', `/memory/working?channel=${encodeURIComponent('qq:private:u1')}`)
    assert.equal(listWm.status, 200)
    assert.equal((listWm.body.data as { items: Array<{ id: string }> }).items[0]?.id, wmItem.id)

    const ctxWm = await api.request('POST', '/memory/context', { channel: 'qq:private:u1' })
    const workingBlock = (ctxWm.body.data as ContextBundle).blocks.find((block) => block.name === 'working')
    assert.equal(workingBlock?.items.length, 1)

    assert.equal((await api.request('GET', `/memory/working/${wmItem.id}`)).status, 404)
    const delWm = await api.request('DELETE', `/memory/working/${wmItem.id}`)
    assert.equal(delWm.status, 200)
    assert.deepEqual(delWm.body.data, { removed: true })

    const delAgain = await api.request('DELETE', `/memory/working/${wmItem.id}`)
    assert.equal(delAgain.status, 200)
    assert.deepEqual(delAgain.body.data, { removed: false })

    const listAfterDel = await api.request('GET', `/memory/working?channel=${encodeURIComponent('qq:private:u1')}`)
    assert.deepEqual((listAfterDel.body.data as { items: unknown[] }).items, [])
  } finally {
    await api.close()
    await brain.close()
  }
})
