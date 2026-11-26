import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { BrainError, type MemoryRecord, type Trust, type Visibility } from '@brain-core/sdk'
import type { ConsolidationEngine, NewRecord } from '../../src/contracts/index.ts'
import { createProfileStore, type ProfileStore } from '../../src/identity-persona/index.ts'
import {
  buildMemoryCatalog, CATALOG_END, CATALOG_START, createConsolidationEngine, MAX_CATALOG_CHARS,
  upsertCatalogInStable,
} from '../../src/memory-consolidation/index.ts'
import { createForgetService } from '../../src/memory-forget/index.ts'
import { FakeClock, FakeKeywordIndex, FakeLlm, FakeRecordStore } from '../fakes/index.ts'

const DAY_MS = 86_400_000

async function expectCode(token: string, operation: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof BrainError, `${token}: expected BrainError, got ${String(error)}`)
    assert.equal(error.code, code, `${token}: wrong error code`)
    return true
  })
}

class World {
  readonly clock: FakeClock
  readonly store: FakeRecordStore
  readonly index: FakeKeywordIndex
  readonly profiles: ProfileStore
  dir = ''
  stateFile = ''

  constructor(start = Date.UTC(2026, 10, 19, 2, 0, 0)) {
    this.clock = new FakeClock(start)
    this.store = new FakeRecordStore(this.clock)
    this.index = new FakeKeywordIndex()
    this.profiles = createProfileStore({ store: this.store, clock: this.clock })
  }

  async initDir(): Promise<void> {
    this.dir = await mkdtemp(path.join(os.tmpdir(), 'brain-consolidation-'))
    this.stateFile = path.join(this.dir, 'consolidation.json')
  }

  async cleanup(): Promise<void> {
    if (this.dir !== '') {
      await rm(this.dir, { recursive: true, force: true })
    }
  }

  engine(options: {
    readonly llm: FakeLlm
    readonly dailyTokenCap?: number
    readonly minNewEvidence?: number
  }): ConsolidationEngine {
    return createConsolidationEngine({
      store: this.store,
      index: this.index,
      profiles: this.profiles,
      llm: options.llm,
      clock: this.clock,
      ...(this.stateFile === '' ? {} : { stateFile: this.stateFile }),
      dailyTokenCap: options.dailyTokenCap ?? 200_000,
      ...(options.minNewEvidence === undefined ? {} : { minNewEvidence: options.minNewEvidence }),
    })
  }

  async l0(overrides: Partial<NewRecord> = {}): Promise<MemoryRecord> {
    const rec = await this.store.insert({
      layer: 'L0',
      kind: 'qq.message',
      source: 'qq',
      channel: 'qq:group:1',
      subjects: ['p_alice'],
      actor: 'p_alice',
      content: { text: '你好' },
      evidence: [],
      visibility: 'open',
      trust: 'member',
      confidence: 1,
      importance: 0.5,
      tEvent: this.clock.now(),
      ...overrides,
    })
    await this.index.add(rec)
    return rec
  }

  async l1(
    kind: string,
    content: Record<string, unknown>,
    evidence: readonly { readonly id: string }[],
    overrides: Partial<NewRecord> = {},
  ): Promise<MemoryRecord> {
    const rec = await this.store.insert({
      layer: 'L1',
      kind,
      source: 'kernel',
      channel: 'qq:group:1',
      subjects: ['p_alice'],
      actor: 'kernel',
      content,
      evidence,
      visibility: 'open' as Visibility,
      trust: 'member' as Trust,
      confidence: 0.9,
      importance: 0.6,
      tEvent: this.clock.now(),
      ...overrides,
    })
    await this.index.add(rec)
    return rec
  }
}

test('1. shadow isolation: runShadow produces pending proposal without mutating L1/L2/L3', async () => {
  const w = new World()
  await w.initDir()
  try {
    const e1 = await w.l0({ content: { text: '我住在上海' } })
    const e2 = await w.l0({ content: { text: '我最近搬去北京了' } })
    const oldFact = await w.l1('l1.fact', { text: 'Alice 住在上海', key: 'city', value: '上海' }, [{ id: e1.id }], {
      tEvent: w.clock.now() - 10_000,
    })
    const newFact = await w.l1('l1.fact', { text: 'Alice 住在上海改成北京', key: 'city', value: '北京' }, [{ id: e2.id }])
    const topic = await w.l1('l1.topic', { text: '搬家计划', state: 'open' }, [{ id: e2.id }])

    const llm = new FakeLlm([
      {
        text: JSON.stringify({
          l2Candidates: [{
            kind: 'l2.scene',
            text: 'Alice 已搬迁至北京',
            subjects: ['p_alice'],
            evidence: [newFact.id, topic.id],
            confidence: 0.9,
            importance: 0.7,
          }],
        }),
        tokens: 30,
      },
      {
        text: JSON.stringify({
          l3Self: { stable: '温柔体贴的伙伴', data: { mood: 'steady' } },
          l3Persons: [],
        }),
        tokens: 40,
      },
    ])

    const engine = w.engine({ llm })
    const proposal = await engine.runShadow()
    assert.equal(proposal.status, 'pending')
    assert.equal(proposal.tokensUsed, 70)
    assert.equal(proposal.l2Candidates.length, 1)
    assert.ok(proposal.corrections.some((c) => c.action === 'supersede-fact' && c.targetId === oldFact.id))
    const closeTopicCorr = proposal.corrections.find((c) => c.action === 'close-topic' && c.targetId === topic.id)
    assert.notEqual(closeTopicCorr, undefined)
    assert.equal(closeTopicCorr?.replacementContent?.state, 'closed')
    assert.equal(closeTopicCorr?.replacementContent?.promotedTo, proposal.l2Candidates[0]?.id)
    assert.notEqual(proposal.l3SelfPatch, null)

    // Before approval: zero L2 records, oldFact still active, topic still open, L3 version still 0.
    const l2Before = await w.store.list({ layers: ['L2'] }, { limit: 100 })
    assert.equal(l2Before.items.length, 0)
    assert.equal((await w.store.get(oldFact.id))?.status, 'active')
    assert.equal((await w.store.get(topic.id))?.content.state, 'open')
    assert.equal((await w.profiles.current()).version, 0)
  } finally {
    await w.cleanup()
  }
})

test('2. approveProposal applies changes, rejectProposal keeps store untouched, and duplicate resolution throws CONFLICT', async () => {
  const w = new World()
  await w.initDir()
  try {
    const e1 = await w.l0({ content: { text: '喜欢绿茶' } })
    const e2 = await w.l0({ content: { text: '现在改喝乌龙茶了' } })
    const oldFact = await w.l1('l1.fact', { text: '喜欢绿茶', key: 'tea', value: '绿茶' }, [{ id: e1.id }], {
      tEvent: w.clock.now() - 5000,
    })
    const newFact = await w.l1('l1.fact', { text: '改喝乌龙茶', key: 'tea', value: '乌龙茶' }, [{ id: e2.id }])
    const topic = await w.l1('l1.topic', { text: '选茶话题', state: 'open' }, [{ id: e2.id }])

    const llm = new FakeLlm([
      {
        text: JSON.stringify({
          l2Candidates: [{
            kind: 'l2.person_tip',
            text: 'Alice 偏好乌龙茶',
            subjects: ['p_alice'],
            evidence: [newFact.id, topic.id],
            confidence: 0.9,
          }],
        }),
        tokens: 25,
      },
      {
        text: JSON.stringify({
          l3Self: { stable: '记茶小助手', data: { specialty: 'tea' } },
          l3Persons: [{
            personId: 'p_alice',
            preferences: { tea: { value: '乌龙茶', source: 'said', confidence: 0.9 } },
          }],
        }),
        tokens: 35,
      },
    ])

    const engine = w.engine({ llm })
    const p1 = await engine.runShadow()

    // Reject path
    const rejected = await engine.rejectProposal(p1.id)
    assert.equal(rejected.status, 'rejected')
    assert.notEqual(rejected.resolvedAt, undefined)
    assert.equal((await w.store.list({ layers: ['L2'] }, { limit: 100 })).items.length, 0)
    assert.equal((await w.store.get(oldFact.id))?.status, 'active')
    assert.equal((await w.profiles.current()).version, 0)
    await expectCode('re-reject', engine.rejectProposal(p1.id), 'CONFLICT')
    await expectCode('approve-rejected', engine.approveProposal(p1.id), 'CONFLICT')

    // Run again with force and approve
    const llm2 = new FakeLlm([
      {
        text: JSON.stringify({
          l2Candidates: [{
            kind: 'l2.person_tip',
            text: 'Alice 偏好乌龙茶',
            subjects: ['p_alice'],
            evidence: [newFact.id, topic.id],
            confidence: 0.9,
          }],
        }),
        tokens: 25,
      },
      {
        text: JSON.stringify({
          l3Self: { stable: '记茶小助手', data: { specialty: 'tea' } },
          l3Persons: [{
            personId: 'p_alice',
            preferences: { tea: { value: '乌龙茶', source: 'said', confidence: 0.9 } },
          }],
        }),
        tokens: 35,
      },
    ])
    const engine2 = w.engine({ llm: llm2 })
    const p2 = await engine2.runShadow({ from: 0, to: w.clock.now(), force: true })
    const report = await engine2.approveProposal(p2.id)
    assert.equal(report.l2Created, 1)
    assert.equal(report.correctionsApplied, 2)
    assert.equal(report.newProfileVersion, 1)
    assert.equal(report.personsUpdated, 1)

    // Verify applied state
    const l2After = await w.store.list({ layers: ['L2'] }, { limit: 100 })
    assert.equal(l2After.items.length, 1)
    const searchHits = await w.index.search({ text: '乌龙茶', layers: ['L2'], limit: 10 })
    assert.equal(searchHits.length, 1)
    assert.equal(searchHits[0]?.id, l2After.items[0]?.id)

    assert.equal((await w.store.get(oldFact.id))?.status, 'outdated')
    const oldFactHits = await w.index.search({ text: '绿茶', layers: ['L1'], limit: 10 })
    assert.equal(oldFactHits.length, 0)

    const closedTopic = await w.store.get(topic.id)
    assert.equal(closedTopic?.content.state, 'closed')
    assert.equal(closedTopic?.content.promotedTo, l2After.items[0]?.id)

    assert.deepEqual(await w.profiles.current(), {
      version: 1,
      stable: '记茶小助手\n\n[记忆目录]\n已知属性名：p_alice: tea\n[/记忆目录]',
    })
    const persons = await w.store.list({ layers: ['L3'], kinds: ['l3.person'], statuses: ['active'] }, { limit: 10 })
    assert.equal(persons.items.length, 1)
    assert.equal((persons.items[0]?.content.preferences as Record<string, { value: unknown }>).tea?.value, '乌龙茶')

    await expectCode('re-approve', engine2.approveProposal(p2.id), 'CONFLICT')
    await expectCode('missing-approve', engine2.approveProposal('prop_missing'), 'NOT_FOUND')
    await expectCode('missing-reject', engine2.rejectProposal('prop_missing'), 'NOT_FOUND')
    assert.equal(await engine2.getProposal('prop_missing'), null)
    assert.equal((await engine2.listProposals('approved')).length, 1)
    assert.equal((await engine2.listProposals('rejected')).length, 1)
  } finally {
    await w.cleanup()
  }
})

test('3. RFC M4 external guard: only external evidence never changes L3 (even with force)', async () => {
  const w = new World()
  const ext0 = await w.l0({ source: 'web-reader', trust: 'external', actor: 'web:site', content: { text: '外网传闻' } })
  const ext1 = await w.l1('l1.fact', { text: '外网传闻1', key: 'rumor', value: 'A' }, [{ id: ext0.id }], {
    source: 'web-reader',
    trust: 'external',
  })
  const ext2 = await w.l1('l1.fact', { text: '外网传闻2', key: 'rumor2', value: 'B' }, [{ id: ext0.id }], {
    source: 'web-reader',
    trust: 'external',
  })

  // Only 1 LLM call for L2 induction; L3 settlement LLM must NOT be called.
  const llm = new FakeLlm([{ text: '{"l2Candidates":[]}', tokens: 10 }])
  const engine = w.engine({ llm })
  const proposal = await engine.runShadow({ force: true })

  assert.equal(proposal.l3SelfPatch, null)
  assert.deepEqual(proposal.l3PersonPatches, [])
  assert.equal(proposal.skippedL3Reason, 'only-external-evidence')
  assert.equal(llm.requests.length, 1)
  assert.equal((await w.profiles.current()).version, 0)
  assert.ok(ext1.id && ext2.id)
})

test('4. owner lock protection & l3.person history evolution across settlements', async () => {
  const w = new World()
  const ev0 = await w.l0({ content: { text: '初始证据' } })
  await w.profiles.commit({
    stable: '初始形象',
    data: { catchphrase: '旧口头禅', mood: 'calm' },
    evidence: [{ id: ev0.id }],
    author: 'settlement',
  })
  await w.profiles.editByOwner({
    data: { catchphrase: '主人定的口头禅', mood: 'calm' },
  })

  // Seed an existing l3.person with an owner-locked field and an unlocked preference.
  await w.store.insert({
    layer: 'L3',
    kind: 'l3.person',
    source: 'kernel',
    actor: 'kernel',
    channel: 'kernel:person:p_alice',
    subjects: ['p_alice'],
    content: {
      personId: 'p_alice',
      identity: { nickname: { value: '主人起的昵称', source: 'said', confidence: 1, updatedAt: 100 } },
      preferences: { drink: { value: '拿铁', source: 'said', confidence: 0.8, updatedAt: 100 } },
      relationships: {},
      history: [],
      ownerLockedKeys: ['identity.nickname'],
    },
    evidence: [{ id: ev0.id }],
    visibility: 'subject',
    trust: 'self',
    confidence: 1,
    importance: 0.8,
    tEvent: 100,
  })

  w.clock.advance(5000)
  const ev1 = await w.l0({ content: { text: '喜欢看书' } })
  const ev2 = await w.l0({ content: { text: '改喝手冲黑咖啡' } })
  await w.l1('l1.fact', { text: '喜欢看书', key: 'hobby', value: '看书' }, [{ id: ev1.id }])
  await w.l1('l1.fact', { text: '改喝黑咖啡', key: 'drink', value: '黑咖啡' }, [{ id: ev2.id }])

  const llm = new FakeLlm([
    { text: '{"l2Candidates":[]}', tokens: 15 },
    {
      text: JSON.stringify({
        l3Self: {
          stable: '更新后形象',
          data: { catchphrase: '模型改的值', hobby: '看书', mood: 'curious' },
        },
        l3Persons: [{
          personId: 'p_alice',
          identity: { nickname: { value: '模型篡改的昵称', source: 'inferred', confidence: 0.7 } },
          preferences: { drink: { value: '黑咖啡', source: 'said', confidence: 0.95 } },
        }],
      }),
      tokens: 45,
    },
  ])

  const engine = w.engine({ llm })
  const proposal = await engine.runShadow()
  assert.notEqual(proposal.l3SelfPatch, null)
  assert.equal(proposal.l3SelfPatch?.data.catchphrase, '主人定的口头禅')
  assert.equal(proposal.l3SelfPatch?.data.hobby, '看书')
  assert.deepEqual(proposal.l3SelfPatch?.preservedOwnerKeys, ['catchphrase'])

  // Even if owner locks another key while proposal is pending, approveProposal preserves both.
  await w.profiles.editByOwner({
    data: { catchphrase: '主人定的口头禅', mood: 'cheerful' },
  })

  await engine.approveProposal(proposal.id)
  const latest = await w.profiles.getVersion((await w.profiles.current()).version)
  assert.equal(latest.data.catchphrase, '主人定的口头禅')
  assert.equal(latest.data.mood, 'cheerful')
  assert.equal(latest.data.hobby, '看书')
  assert.deepEqual(latest.ownerLockedKeys, ['catchphrase', 'mood'])

  // Verify l3.person preserved owner-locked nickname and pushed old drink to history.
  const activePersons = await w.store.list(
    { layers: ['L3'], kinds: ['l3.person'], statuses: ['active'], subjects: ['p_alice'] },
    { limit: 10 },
  )
  assert.equal(activePersons.items.length, 1)
  const aliceContent = activePersons.items[0]?.content as {
    identity: Record<string, { value: unknown }>
    preferences: Record<string, { value: unknown }>
    history: Array<{ section: string; key: string; value: unknown }>
  }
  assert.equal(aliceContent.identity.nickname?.value, '主人起的昵称')
  assert.equal(aliceContent.preferences.drink?.value, '黑咖啡')
  assert.equal(aliceContent.history.length, 1)
  assert.equal(aliceContent.history[0]?.section, 'preferences')
  assert.equal(aliceContent.history[0]?.key, 'drink')
  assert.equal(aliceContent.history[0]?.value, '拿铁')
})

test('5. RFC M10 & M8: l1.event is never superseded and silent l1.fact is never marked outdated', async () => {
  const w = new World()
  const ev0 = await w.l0({ content: { text: '事件1' } })
  const ev1 = await w.l0({ content: { text: '事件2' } })
  const eventA = await w.l1('l1.event', { text: '去过杭州', key: 'trip', value: '杭州' }, [{ id: ev0.id }], {
    tEvent: w.clock.now() - 30 * DAY_MS,
  })
  const eventB = await w.l1('l1.event', { text: '去过成都', key: 'trip', value: '成都' }, [{ id: ev1.id }])
  const silentFact = await w.l1('l1.fact', { text: '会弹吉他', key: 'instrument', value: '吉他' }, [{ id: ev0.id }], {
    tEvent: w.clock.now() - 60 * DAY_MS,
  })

  const llm = new FakeLlm([
    { text: '{"l2Candidates":[]}', tokens: 10 },
    { text: '{"l3Self":null,"l3Persons":[]}', tokens: 10 },
  ])
  const engine = w.engine({ llm })
  const proposal = await engine.runShadow()

  assert.equal(proposal.corrections.filter((c) => c.action === 'supersede-fact').length, 0)
  await engine.approveProposal(proposal.id)
  assert.equal((await w.store.get(eventA.id))?.status, 'active')
  assert.equal((await w.store.get(eventB.id))?.status, 'active')
  assert.equal((await w.store.get(silentFact.id))?.status, 'active')
})

test('6. FR-M13 self-statement conflict check detects contradicting l1.self and marks loser outdated on approval', async () => {
  const w = new World()
  const ev0 = await w.l0({ actor: 'self', trust: 'self', content: { text: '自我陈述' } })
  const selfA = await w.l1('l1.self', { text: '我从不喝咖啡' }, [{ id: ev0.id }], {
    subjects: ['self'],
    trust: 'self',
    confidence: 0.7,
    tEvent: w.clock.now() - 1000,
  })
  const selfB = await w.l1('l1.self', { text: '我每天早上必喝冰美式' }, [{ id: ev0.id }], {
    subjects: ['self'],
    trust: 'self',
    confidence: 0.95,
  })

  const llm = new FakeLlm([
    // 1. self-check LLM call
    {
      text: JSON.stringify({
        conflicts: [{
          recordAId: selfA.id,
          recordBId: selfB.id,
          reason: '是否喝咖啡相互矛盾',
          recommendedKeepId: selfB.id,
        }],
      }),
      tokens: 20,
    },
    // 2. L2 induction
    { text: '{"l2Candidates":[]}', tokens: 10 },
    // 3. L3 settlement
    { text: '{"l3Self":null,"l3Persons":[]}', tokens: 10 },
  ])

  const engine = w.engine({ llm })
  const proposal = await engine.runShadow()
  assert.equal(proposal.tokensUsed, 40)
  assert.equal((await engine.budgetStatus()).usedTokensToday, 40)
  assert.equal(proposal.selfConflicts.length, 1)
  const conflict = proposal.selfConflicts[0]!
  assert.equal(conflict.recommendedKeepId, selfB.id)

  // Override decision to keep selfA instead of recommended selfB.
  const report = await engine.approveProposal(proposal.id, {
    conflictKeepIds: { [conflict.id]: selfA.id },
  })
  assert.equal(report.conflictsResolved, 1)
  assert.equal((await w.store.get(selfA.id))?.status, 'active')
  assert.equal((await w.store.get(selfB.id))?.status, 'outdated')
  assert.equal((await w.index.search({ text: '冰美式', layers: ['L1'], limit: 10 })).length, 0)
})

test('7. duplicate candidate promotion (M9 non-self >= 2) and sentiment quote truncated to <= 20 code points', async () => {
  const w = new World()
  const selfL0 = await w.l0({ actor: 'self', trust: 'self', content: { text: '我猜她喜欢猫' } })
  const aliceL0_1 = await w.l0({ actor: 'p_alice', content: { text: '我最喜欢布偶猫' } })
  const aliceL0_2 = await w.l0({ actor: 'p_alice', content: { text: '家里确实养了布偶猫' } })

  // Candidate backed only by self must NOT promote (M9).
  await w.l1('l1.candidate', { text: '只靠自己说的猜测', key: 'selfGuess', value: '猫' }, [{ id: selfL0.id }])

  // Two candidates with independent non-self L0 evidence MUST promote.
  const cand1 = await w.l1('l1.candidate', { text: 'Alice 喜欢布偶猫', key: 'pet', value: '布偶猫' }, [{ id: aliceL0_1.id }])
  const cand2 = await w.l1(
    'l1.candidate',
    { text: 'Alice 养了布偶猫', key: 'pet', value: '布偶猫', duplicateOf: cand1.id },
    [{ id: aliceL0_2.id }],
  )

  const longPraiseText = '你今天这个比喻简直太绝妙了哈哈哈哈哈哈真的超厉害👍🎉'
  const praiseL1 = await w.l1('l1.fact', { text: longPraiseText, sentiment: 'praise' }, [{ id: aliceL0_1.id }])

  const llm = new FakeLlm([
    {
      text: JSON.stringify({
        l2Candidates: [{
          kind: 'l2.expression',
          text: '对方喜欢生动有趣的比喻',
          quote: longPraiseText,
          sentiment: 'praise',
          subjects: ['p_alice'],
          evidence: [praiseL1.id],
          confidence: 0.9,
        }],
      }),
      tokens: 30,
    },
    { text: '{"l3Self":null,"l3Persons":[]}', tokens: 20 },
  ])

  const engine = w.engine({ llm })
  const proposal = await engine.runShadow()

  const promotions = proposal.corrections.filter((c) => c.action === 'promote-candidate')
  assert.equal(promotions.length, 1)
  assert.equal(promotions[0]?.evidence.length, 2)

  assert.equal(proposal.l2Candidates.length, 1)
  const quote = proposal.l2Candidates[0]?.content.quote as string
  assert.ok(quote.length > 0)
  assert.ok([...quote].length <= 20, `expected <= 20 code points, got ${[...quote].length}`)

  await engine.approveProposal(proposal.id)
  assert.equal((await w.store.get(cand1.id))?.status, 'archived')
  assert.equal((await w.store.get(cand2.id))?.status, 'archived')
  const facts = await w.store.list({ layers: ['L1'], kinds: ['l1.fact'], statuses: ['active'] }, { limit: 50 })
  assert.ok(facts.items.some((f) => f.content.key === 'pet' && f.content.value === '布偶猫'))
})

test('8. recalculates and recovers L3 when flagged outdated by memory-forget', async () => {
  const w = new World()
  const ev1 = await w.l0({ content: { text: '旧记忆' } })
  const ev2 = await w.l0({ content: { text: '保留的记忆：喜欢夜跑' } })
  const l1_1 = await w.l1('l1.fact', { text: '旧记忆', key: 'old', value: 'x' }, [{ id: ev1.id }])
  const l1_2 = await w.l1('l1.fact', { text: '喜欢夜跑', key: 'sport', value: '夜跑' }, [{ id: ev2.id }], {
    tEvent: w.clock.now() - 10_000,
  })

  await w.profiles.commit({
    stable: '基于旧记忆的画像',
    data: { old: 'x' },
    evidence: [{ id: l1_1.id }],
    author: 'settlement',
  })

  const forget = createForgetService({
    store: w.store,
    index: w.index,
    onForgotten: async () => {},
  })
  const forgetReport = await forget.forget({ by: 'record', id: ev1.id })
  assert.equal(forgetReport.l3Flagged, 1)
  assert.equal((await w.profiles.current()).version, 0)

  // Window has 0 new records, yet outdated L3 forces recalculation from remaining l1_2 (< minNewEvidence).
  const llm = new FakeLlm([
    {
      text: JSON.stringify({
        l3Self: { stable: '重算后的活跃画像', data: { sport: '夜跑' } },
        l3Persons: [],
      }),
      tokens: 30,
    },
  ])
  const engine = w.engine({ llm, minNewEvidence: 5 })
  const proposal = await engine.runShadow({ from: w.clock.now(), to: w.clock.now() })
  assert.notEqual(proposal.l3SelfPatch, null)
  assert.deepEqual(proposal.l3SelfPatch?.evidence, [{ id: l1_2.id }])

  const applied = await engine.approveProposal(proposal.id)
  assert.equal(applied.newProfileVersion, 2)
  assert.deepEqual(await w.profiles.current(), {
    version: 2,
    stable: '重算后的活跃画像\n\n[记忆目录]\n已知属性名：p_alice: sport\n[/记忆目录]',
  })
  assert.equal((await w.profiles.getVersion(1)).status, 'archived')
})

test('9. watermark does not advance on LLM error or dailyTokenCap, resets daily tokens next UTC day, and persists 0600 state', async () => {
  const w = new World()
  await w.initDir()
  try {
    const ev1 = await w.l0({ content: { text: '内容1' } })
    const ev2 = await w.l0({ content: { text: '内容2' } })
    await w.l1('l1.fact', { text: '事实1', key: 'k1', value: 'v1' }, [{ id: ev1.id }])
    await w.l1('l1.fact', { text: '事实2', key: 'k2', value: 'v2' }, [{ id: ev2.id }])

    // 9a: Error mid-run leaves watermark at 0.
    const failingLlm = new FakeLlm([new Error('upstream timeout')])
    const failingEngine = w.engine({ llm: failingLlm, dailyTokenCap: 100 })
    await assert.rejects(() => failingEngine.runShadow(), /upstream timeout/)
    assert.equal((await failingEngine.budgetStatus()).lastConsolidatedTo, 0)

    // 9b: Hitting dailyTokenCap during L2 stops L3 call and does NOT advance watermark.
    const cappedLlm = new FakeLlm([
      { text: '{"l2Candidates":[]}', tokens: 100 },
      { text: '{"l3Self":{"stable":"should not run","data":{}}}', tokens: 50 },
    ])
    const cappedEngine = w.engine({ llm: cappedLlm, dailyTokenCap: 100 })
    const cappedProposal = await cappedEngine.runShadow()
    assert.equal(cappedProposal.tokensUsed, 100)
    assert.equal(cappedLlm.requests.length, 1)
    assert.equal((await cappedEngine.budgetStatus()).usedTokensToday, 100)
    assert.equal((await cappedEngine.budgetStatus()).lastConsolidatedTo, 0)

    // Verify 0600 file permissions and state persistence across engine re-creation.
    const fileStat = await stat(w.stateFile)
    if (process.platform !== 'win32') {
      assert.equal(fileStat.mode & 0o777, 0o600)
    }

    // Same day retry makes 0 LLM calls because cap is already reached.
    const sameDayEngine = w.engine({ llm: cappedLlm, dailyTokenCap: 100 })
    await sameDayEngine.runShadow()
    assert.equal(cappedLlm.requests.length, 1)
    assert.equal((await sameDayEngine.budgetStatus()).lastConsolidatedTo, 0)

    // Advance to next UTC day: daily token counter resets, watermark still 0, run completes and advances watermark!
    w.clock.advance(DAY_MS)
    assert.equal((await sameDayEngine.budgetStatus()).usedTokensToday, 0)

    const nextDayLlm = new FakeLlm([
      { text: '{"l2Candidates":[]}', tokens: 20 },
      { text: '{"l3Self":{"stable":"完成","data":{"k1":"v1"}}}', tokens: 30 },
    ])
    const nextDayEngine = w.engine({ llm: nextDayLlm, dailyTokenCap: 100 })
    const completed = await nextDayEngine.runShadow()
    assert.equal(completed.window.from, 0)
    assert.equal(completed.window.to, w.clock.now())
    assert.equal((await nextDayEngine.budgetStatus()).lastConsolidatedTo, w.clock.now())
    assert.equal((await nextDayEngine.budgetStatus()).usedTokensToday, 50)

    // Invalid window throws INVALID_ARGUMENT.
    await expectCode('bad-window', nextDayEngine.runShadow({ from: 200, to: 100 }), 'INVALID_ARGUMENT')

    // Corrupted state file reports UNAVAILABLE.
    await writeFile(w.stateFile, '{corrupted-json')
    const brokenEngine = w.engine({ llm: nextDayLlm, dailyTokenCap: 100 })
    await expectCode('corrupt-state', brokenEngine.budgetStatus(), 'UNAVAILABLE')
  } finally {
    await w.cleanup()
  }
})

test('10. freshness gate, deterministic self-conflict, invalid conflictKeepIds, mixed M4 weighting, and sentiment fallback', async () => {
  const w = new World()
  const ev0 = await w.l0({ actor: 'p_alice', content: { text: '太啰嗦了少说废话别这么长篇大论了' } })
  const critL1 = await w.l1('l1.fact', { text: '太啰嗦了少说废话别这么长篇大论了，以后简短点', sentiment: 'criticism' }, [{ id: ev0.id }])

  // Two l1.self with same content.key and opposing values are detected deterministically without an LLM call.
  const selfEv = await w.l0({ actor: 'self', trust: 'self', content: { text: 'self' } })
  const self1 = await w.l1('l1.self', { text: '喜欢早睡', key: 'sleep', value: 'early' }, [{ id: selfEv.id }], {
    subjects: ['self'],
    trust: 'self',
    confidence: 0.6,
  })
  const self2 = await w.l1('l1.self', { text: '习惯熬夜', key: 'sleep', value: 'late' }, [{ id: selfEv.id }], {
    subjects: ['self'],
    trust: 'self',
    confidence: 0.9,
  })

  // Single external record about p_bob (< 2 independent external sources) must NOT update l3.person for p_bob.
  const bobExt0 = await w.l0({ source: 'web', trust: 'external', actor: 'web:1', subjects: ['p_bob'], content: { text: '传闻 Bob 喜欢滑雪' } })
  await w.l1('l1.fact', { text: '传闻 Bob 喜欢滑雪', key: 'sport', value: '滑雪' }, [{ id: bobExt0.id }], {
    source: 'web',
    trust: 'external',
    subjects: ['p_bob'],
  })

  // With minNewEvidence=5 and 3 internal L1 records, L3 LLM is skipped due to insufficient-new-evidence.
  const llm = new FakeLlm([
    { text: '{"l2Candidates":[]}', tokens: 12 },
  ])
  const engine = w.engine({ llm, minNewEvidence: 5 })
  const pSkipped = await engine.runShadow()
  assert.equal(pSkipped.skippedL3Reason, 'insufficient-new-evidence')
  assert.equal(pSkipped.l3SelfPatch, null)
  assert.equal(pSkipped.selfConflicts.length, 1)
  assert.equal(pSkipped.selfConflicts[0]?.recommendedKeepId, self2.id)
  // Sentiment fallback created an l2.expression candidate with <= 20 code points quote.
  assert.equal(pSkipped.l2Candidates.length, 1)
  assert.equal(pSkipped.l2Candidates[0]?.content.sentiment, 'criticism')
  assert.ok([...(pSkipped.l2Candidates[0]?.content.quote as string)].length <= 20)
  assert.equal(critL1.id !== '', true)

  // Invalid conflictKeepIds throws INVALID_ARGUMENT without changing proposal status or records.
  const conflictId = pSkipped.selfConflicts[0]!.id
  await expectCode(
    'bad-conflict-keep',
    engine.approveProposal(pSkipped.id, { conflictKeepIds: { [conflictId]: 'l1_nonexistent' } }),
    'INVALID_ARGUMENT',
  )
  assert.equal((await engine.getProposal(pSkipped.id))?.status, 'pending')
  assert.equal((await w.store.get(self1.id))?.status, 'active')

  // force: true runs L3 LLM; p_bob with only external evidence is rejected by M4 per-person guard.
  const llmForced = new FakeLlm([
    { text: '{"l2Candidates":[]}', tokens: 10 },
    {
      text: JSON.stringify({
        l3Self: { stable: '精简表达', data: { style: 'concise' } },
        l3Persons: [{
          personId: 'p_bob',
          preferences: { sport: { value: '滑雪', source: 'inferred', confidence: 0.5 } },
        }],
      }),
      tokens: 25,
    },
  ])
  const forcedEngine = w.engine({ llm: llmForced, minNewEvidence: 5 })
  const pForced = await forcedEngine.runShadow({ from: 0, to: w.clock.now(), force: true })
  assert.notEqual(pForced.l3SelfPatch, null)
  assert.deepEqual(pForced.l3PersonPatches, [])
})

test('11. self-check mutation guards: deterministic negation without value/polarity, budget cap, token accounting, and unknown IDs', async () => {
  // #13: deterministic negationConflict when content.key matches and value/polarity are absent.
  const w1 = new World()
  const ev = await w1.l0({ actor: 'self', trust: 'self', content: { text: 'self' } })
  const negA = await w1.l1('l1.self', { text: '我从不喝咖啡', key: 'coffee' }, [{ id: ev.id }], {
    subjects: ['self'],
    trust: 'self',
  })
  const negB = await w1.l1('l1.self', { text: '我每天都喝咖啡', key: 'coffee' }, [{ id: ev.id }], {
    subjects: ['self'],
    trust: 'self',
  })
  const llmDet = new FakeLlm([
    { text: '{"l2Candidates":[]}', tokens: 5 },
    { text: '{"l3Self":null,"l3Persons":[]}', tokens: 5 },
  ])
  const propDet = await w1.engine({ llm: llmDet }).runShadow()
  assert.equal(propDet.selfConflicts.length, 1)
  assert.equal(propDet.selfConflicts[0]?.recordAId, negA.id)
  assert.equal(propDet.selfConflicts[0]?.recordBId, negB.id)

  // #14: LLM self-check respects dailyTokenCap (budget.canCall()).
  const w2 = new World()
  const ev2 = await w2.l0({ actor: 'self', trust: 'self', content: { text: 'self' } })
  await w2.l1('l1.self', { text: '早睡早起' }, [{ id: ev2.id }], { subjects: ['self'], trust: 'self' })
  await w2.l1('l1.self', { text: '通宵熬夜' }, [{ id: ev2.id }], { subjects: ['self'], trust: 'self' })
  const cappedLlm = new FakeLlm([{ text: '{"conflicts":[]}', tokens: 10 }])
  const cappedProp = await w2.engine({ llm: cappedLlm, dailyTokenCap: 0 }).runShadow()
  assert.equal(cappedLlm.requests.length, 0)
  assert.equal(cappedProp.selfConflicts.length, 0)

  // #15 & #16: LLM self-check consumes tokens toward cap and rejects unknown record IDs.
  const w3 = new World()
  const ev3 = await w3.l0({ actor: 'self', trust: 'self', content: { text: 'self' } })
  const sA = await w3.l1('l1.self', { text: '喜欢晴天' }, [{ id: ev3.id }], { subjects: ['self'], trust: 'self' })
  await w3.l1('l1.self', { text: '讨厌晴天' }, [{ id: ev3.id }], { subjects: ['self'], trust: 'self' })
  const llmBadIds = new FakeLlm([
    {
      text: JSON.stringify({
        conflicts: [
          { recordAId: sA.id, recordBId: 'l1_unknown_id', reason: 'invalid' },
          { recordAId: 'l1_missing_id', recordBId: sA.id, reason: 'invalid' },
        ],
      }),
      tokens: 50,
    },
    // L2/L3 must NOT be called because self-check consumed 50 === dailyTokenCap.
    { text: '{"l2Candidates":[]}', tokens: 10 },
  ])
  const engine3 = w3.engine({ llm: llmBadIds, dailyTokenCap: 50 })
  const prop3 = await engine3.runShadow()
  assert.equal(prop3.selfConflicts.length, 0)
  assert.equal(prop3.tokensUsed, 50)
  assert.equal(llmBadIds.requests.length, 1)
  assert.equal((await engine3.budgetStatus()).usedTokensToday, 50)
  assert.equal((await engine3.budgetStatus()).lastConsolidatedTo, 0)
})

test('12. promote-candidate M9 thresholds and duplicateOf chain without shared key', async () => {
  const w = new World()
  const selfL0a = await w.l0({ actor: 'self', trust: 'self', content: { text: '自说1' } })
  const selfL0b = await w.l0({ actor: 'self', trust: 'self', content: { text: '自说2' } })
  const bobL0a = await w.l0({ actor: 'p_bob', content: { text: 'Bob 说过一次' } })
  const aliceL0a = await w.l0({ actor: 'p_alice', content: { text: 'Alice 说养橘猫' } })
  const aliceL0b = await w.l0({ actor: 'p_alice', content: { text: 'Alice 发了橘猫照片' } })

  // #17: 2 self L0 records must NOT promote; 1 self + 1 non-self must NOT promote.
  await w.l1('l1.candidate', { text: '全靠self的两条', key: 'selfTwo', value: 'x' }, [{ id: selfL0a.id }, { id: selfL0b.id }])
  await w.l1('l1.candidate', { text: '一self一他人的两条', key: 'mixedOne', value: 'y' }, [{ id: selfL0a.id }, { id: bobL0a.id }])

  // #18: single non-self L0 evidence must NOT promote.
  await w.l1('l1.candidate', { text: '仅1条非self证据', key: 'onlyOne', value: 'z' }, [{ id: bobL0a.id }])

  // #19: cand2 and cand3 have distinct text and NO key/value, linked ONLY via duplicateOf -> cand1 (which itself only has self evidence).
  const cand1 = await w.l1('l1.candidate', { text: 'Alice 喜欢橘猫', key: 'catColor', value: '橘猫' }, [{ id: selfL0a.id }])
  const cand2 = await w.l1('l1.candidate', { text: '家里养了一只小橘', duplicateOf: cand1.id }, [{ id: aliceL0a.id }])
  const cand3 = await w.l1('l1.candidate', { text: '还给橘猫买了猫爬架', duplicateOf: cand1.id }, [{ id: aliceL0b.id }])

  const llm = new FakeLlm([{ text: '{"l2Candidates":[]}', tokens: 10 }])
  const engine = w.engine({ llm })
  const proposal = await engine.runShadow()
  const promotions = proposal.corrections.filter((c) => c.action === 'promote-candidate')
  assert.equal(promotions.length, 1)
  assert.equal(promotions[0]?.targetId, cand3.id)
  assert.deepEqual(promotions[0]?.evidence.map((e) => e.id).sort(), [aliceL0a.id, aliceL0b.id].sort())
  await engine.approveProposal(proposal.id)
  assert.equal((await w.store.get(cand1.id))?.status, 'archived')
  assert.equal((await w.store.get(cand2.id))?.status, 'archived')
  assert.equal((await w.store.get(cand3.id))?.status, 'archived')
})

test('13. supersede-fact skips equal values and records without valid non-tombstoned evidence', async () => {
  const w = new World()
  const ev1 = await w.l0({ content: { text: '城市上海1' } })
  const ev2 = await w.l0({ content: { text: '城市上海2' } })
  const ev3 = await w.l0({ content: { text: '食物拉面' } })
  const ev4Tomb = await w.l0({ content: { text: '将被遗忘的新证据' } })

  // #21: same (subjects, key, value) at different tEvent must NOT supersede.
  await w.l1('l1.fact', { text: '住上海1', key: 'city', value: '上海' }, [{ id: ev1.id }], {
    tEvent: w.clock.now() - 5000,
  })
  await w.l1('l1.fact', { text: '住上海2', key: 'city', value: '上海' }, [{ id: ev2.id }])

  // #22: newer fact whose evidence is tombstoned must NOT supersede the older valid fact.
  await w.l1('l1.fact', { text: '喜欢拉面', key: 'food', value: '拉面' }, [{ id: ev3.id }], {
    tEvent: w.clock.now() - 5000,
  })
  await w.l1('l1.fact', { text: '改吃寿司', key: 'food', value: '寿司' }, [{ id: ev4Tomb.id }])
  await w.store.tombstone(ev4Tomb.id)

  const llm = new FakeLlm([
    { text: '{"l2Candidates":[]}', tokens: 10 },
    { text: '{"l3Self":null,"l3Persons":[]}', tokens: 10 },
  ])
  const proposal = await w.engine({ llm }).runShadow()
  assert.equal(proposal.corrections.filter((c) => c.action === 'supersede-fact').length, 0)
})

test('14. M4 transitive external L0 guard and mixed external weighting (0.4 vs 1.0, single external excluded)', async () => {
  // #29: L1 record with trust:'self' backed ONLY by external L0 must trigger only-external-evidence.
  const wTrans = new World()
  const extL0 = await wTrans.l0({ source: 'web', trust: 'external', actor: 'web:a', content: { text: '外网L0' } })
  await wTrans.l1('l1.fact', { text: '看似self但证据全external', key: 'k', value: 'v' }, [{ id: extL0.id }], {
    trust: 'self',
  })
  const llmTrans = new FakeLlm([{ text: '{"l2Candidates":[]}', tokens: 10 }])
  const propTrans = await wTrans.engine({ llm: llmTrans }).runShadow({ force: true })
  assert.equal(propTrans.skippedL3Reason, 'only-external-evidence')
  assert.equal(propTrans.l3SelfPatch, null)
  assert.equal(llmTrans.requests.length, 1)

  // #32: mixed internal (>=2) + single external (< 2 independent external sources) excludes single external from L3 prompt.
  const wSingle = new World()
  const intL0a = await wSingle.l0({ actor: 'p_alice', content: { text: '内部1' } })
  const intL0b = await wSingle.l0({ actor: 'p_alice', content: { text: '内部2' } })
  const extL0One = await wSingle.l0({ source: 'web', trust: 'external', actor: 'web:1', content: { text: '外部单条' } })
  const int1 = await wSingle.l1('l1.fact', { text: '内部事实1', key: 'a', value: '1' }, [{ id: intL0a.id }])
  const int2 = await wSingle.l1('l1.fact', { text: '内部事实2', key: 'b', value: '2' }, [{ id: intL0b.id }])
  const extSingle = await wSingle.l1('l1.fact', { text: '外部单条事实', key: 'c', value: '3' }, [{ id: extL0One.id }], {
    source: 'web',
    trust: 'external',
  })
  const llmSingle = new FakeLlm([
    { text: '{"l2Candidates":[]}', tokens: 10 },
    { text: '{"l3Self":null,"l3Persons":[]}', tokens: 15 },
  ])
  await wSingle.engine({ llm: llmSingle }).runShadow()
  assert.equal(llmSingle.requests.length, 2)
  const singlePrompt = llmSingle.requests[1]!.user
  const singleMatch = /<data>\n([\s\S]*?)\n<\/data>/.exec(singlePrompt)
  assert.notEqual(singleMatch, null)
  const singlePayload = JSON.parse(singleMatch![1]!) as {
    evidence: Array<{ id: string; external: boolean; weight: number }>
  }
  assert.deepEqual(singlePayload.evidence.map((e) => e.id).sort(), [int1.id, int2.id].sort())
  assert.equal(singlePayload.evidence.some((e) => e.id === extSingle.id), false)

  // #33: mixed internal + >= 2 independent external records keeps qualified external with weight 0.4 and internal with 1.0.
  const wMulti = new World()
  const mIntL0a = await wMulti.l0({ actor: 'p_alice', content: { text: '内部A' } })
  const mIntL0b = await wMulti.l0({ actor: 'p_alice', content: { text: '内部B' } })
  const mExtL0a = await wMulti.l0({ source: 'web1', channel: 'web:feed:1', trust: 'external', actor: 'web:1', content: { text: '外部1' } })
  const mExtL0b = await wMulti.l0({ source: 'web2', channel: 'web:feed:2', trust: 'external', actor: 'web:2', content: { text: '外部2' } })
  const mInt1 = await wMulti.l1('l1.fact', { text: '内部A', key: 'a', value: '1' }, [{ id: mIntL0a.id }])
  const mInt2 = await wMulti.l1('l1.fact', { text: '内部B', key: 'b', value: '2' }, [{ id: mIntL0b.id }])
  const mExt1 = await wMulti.l1('l1.fact', { text: '外部1', key: 'c', value: '3' }, [{ id: mExtL0a.id }], {
    source: 'web1',
    channel: 'web:feed:1',
    trust: 'external',
  })
  const mExt2 = await wMulti.l1('l1.fact', { text: '外部2', key: 'd', value: '4' }, [{ id: mExtL0b.id }], {
    source: 'web2',
    channel: 'web:feed:2',
    trust: 'external',
  })
  const llmMulti = new FakeLlm([
    { text: '{"l2Candidates":[]}', tokens: 10 },
    { text: '{"l3Self":null,"l3Persons":[]}', tokens: 15 },
  ])
  await wMulti.engine({ llm: llmMulti }).runShadow()
  const multiPrompt = llmMulti.requests[1]!.user
  const multiMatch = /<data>\n([\s\S]*?)\n<\/data>/.exec(multiPrompt)
  assert.notEqual(multiMatch, null)
  const multiPayload = JSON.parse(multiMatch![1]!) as {
    evidence: Array<{ id: string; external: boolean; weight: number }>
  }
  const byEvId = new Map(multiPayload.evidence.map((e) => [e.id, e]))
  assert.equal(byEvId.get(mInt1.id)?.weight, 1)
  assert.equal(byEvId.get(mInt1.id)?.external, false)
  assert.equal(byEvId.get(mInt2.id)?.weight, 1)
  assert.equal(byEvId.get(mExt1.id)?.weight, 0.4)
  assert.equal(byEvId.get(mExt1.id)?.external, true)
  assert.equal(byEvId.get(mExt2.id)?.weight, 0.4)
  assert.equal(byEvId.get(mExt2.id)?.external, true)
})

test('15. buildMemoryCatalog filters owner/origin/internal, excludes values, caps at 400 chars, and upserts cleanly', async () => {
  const w1 = new World()
  const w2 = new World()

  const emptyCatalog = await buildMemoryCatalog(w1.store)
  assert.deepEqual(emptyCatalog, { text: '', personKeys: {}, openTopics: [] })
  assert.equal(upsertCatalogInStable('基础设定\n\n[记忆目录]\n旧目录\n[/记忆目录]', ''), '基础设定')

  const ev1 = await w1.l0({ content: { text: 'e1' } })
  const ev2 = await w2.l0({ content: { text: 'e2' } })

  // Insert in opposite orders in w1 and w2 to verify byte-identical determinism.
  const entries: Array<Parameters<World['l1']>> = [
    ['l1.fact', { text: 'SECRET_VAL_OWNER', key: 'secretOwnerKey', value: 'SECRET_VAL_OWNER' }, [{ id: ev1.id }], { visibility: 'owner', subjects: ['p_alice'] }],
    ['l1.fact', { text: 'SECRET_VAL_ORIGIN', key: 'secretOriginKey', value: 'SECRET_VAL_ORIGIN' }, [{ id: ev1.id }], { visibility: 'origin', subjects: ['p_alice'] }],
    ['l1.fact', { text: 'SECRET_VAL_INTERNAL', key: 'secretInternalKey', value: 'SECRET_VAL_INTERNAL' }, [{ id: ev1.id }], { visibility: 'internal', subjects: ['p_alice'] }],
    ['l1.candidate', { text: 'candidate only', key: 'candKey', value: 'candVal' }, [{ id: ev1.id }], { visibility: 'open', subjects: ['p_alice'] }],
    ['l1.fact', { text: 'PRIVATE_VALUE_SHOULD_NOT_APPEAR', key: 'drink', value: '冰美式VALUE' }, [{ id: ev1.id }], { visibility: 'subject', subjects: ['p_bob'] }],
    ['l1.fact', { text: 'city value', key: 'city', value: '北京VALUE' }, [{ id: ev1.id }], { visibility: 'open', subjects: ['p_alice'] }],
    ['l1.fact', { text: 'hobby value', key: 'hobby', value: '攀岩VALUE' }, [{ id: ev1.id }], { visibility: 'open', subjects: ['p_alice'] }],
    ['l1.topic', { title: '周末露营计划超过二十四个码点应该在这里被截断掉啊', text: 'full text', state: 'open' }, [{ id: ev1.id }], { visibility: 'open' }],
    ['l1.topic', { text: '私密话题不得泄漏', state: 'open' }, [{ id: ev1.id }], { visibility: 'owner' }],
    ['l1.topic', { text: '已关闭话题不收录', state: 'closed' }, [{ id: ev1.id }], { visibility: 'open' }],
  ]
  for (const [kind, content, , overrides] of entries) {
    await w1.l1(kind, content, [{ id: ev1.id }], overrides)
  }
  for (const [kind, content, , overrides] of [...entries].reverse()) {
    await w2.l1(kind, content, [{ id: ev2.id }], overrides)
  }

  const cat1 = await buildMemoryCatalog(w1.store)
  const cat2 = await buildMemoryCatalog(w2.store)
  assert.equal(cat1.text, cat2.text)
  assert.deepEqual(cat1.personKeys, {
    p_alice: ['city', 'hobby'],
    p_bob: ['drink'],
  })
  assert.equal(cat1.openTopics.length, 1)
  assert.equal([...cat1.openTopics[0]!].length, 24)
  assert.ok(cat1.text.startsWith(CATALOG_START) && cat1.text.endsWith(CATALOG_END))
  assert.equal(cat1.text.includes('VALUE'), false)
  assert.equal(cat1.text.includes('secret'), false)
  assert.equal(cat1.text.includes('candKey'), false)
  assert.equal(cat1.text.includes('私密话题'), false)
  assert.equal(cat1.text.includes('已关闭话题'), false)

  // Upsert replaces old section without duplication and handles empty stable.
  const firstStable = upsertCatalogInStable('基础人设', cat1.text)
  const secondStable = upsertCatalogInStable(firstStable, cat1.text)
  assert.equal(firstStable, secondStable)
  assert.equal(upsertCatalogInStable('', cat1.text), cat1.text)
  assert.equal(upsertCatalogInStable(`前段\n\n${CATALOG_START}\n旧\n${CATALOG_END}\n\n后段`, ''), '前段\n\n后段')

  // Open topics are capped at 10 sorted lexicographically.
  const wTopics = new World()
  const evT = await wTopics.l0({ content: { text: 'topics' } })
  for (let i = 0; i < 12; i += 1) {
    await wTopics.l1('l1.topic', { title: `t${String(i).padStart(2, '0')}`, state: 'open' }, [{ id: evT.id }], { visibility: 'open' })
  }
  const catTopics = await buildMemoryCatalog(wTopics.store)
  assert.equal(catTopics.openTopics.length, 10)
  assert.deepEqual(catTopics.openTopics, ['t00', 't01', 't02', 't03', 't04', 't05', 't06', 't07', 't08', 't09'])

  // Enforce MAX_CATALOG_CHARS line-by-line without partial line truncation.
  const wBig = new World()
  const evBig = await wBig.l0({ content: { text: 'big' } })
  for (let i = 0; i < 30; i += 1) {
    await wBig.l1('l1.fact', { text: `v${i}`, key: `attribute_${String(i).padStart(2, '0')}`, value: 'x' }, [{ id: evBig.id }], {
      subjects: [`p_person_${String(i).padStart(2, '0')}`],
      visibility: 'open',
    })
  }
  const bigCat = await buildMemoryCatalog(wBig.store)
  assert.equal(MAX_CATALOG_CHARS, 400)
  assert.ok([...bigCat.text].length <= 400)
  assert.equal(bigCat.text.includes('p_person_29'), false)
  assert.ok(bigCat.text.endsWith(CATALOG_END))
  for (const line of bigCat.text.split('\n')) {
    if (line.startsWith('已知属性名：')) {
      assert.match(line, /^已知属性名：p_person_\d{2}: attribute_\d{2}$/)
    }
  }
})

test('16. stable remains byte-identical between settlements and updates only on approveProposal(l3.self)', async () => {
  const w = new World()
  const ev1 = await w.l0({ content: { text: '喜欢绿茶' } })
  const ev2 = await w.l0({ content: { text: '住在杭州' } })
  await w.l1('l1.fact', { text: '喜欢绿茶', key: 'tea', value: '绿茶' }, [{ id: ev1.id }], { visibility: 'open' })
  await w.l1('l1.fact', { text: '住在杭州', key: 'city', value: '杭州' }, [{ id: ev2.id }], { visibility: 'open' })

  const llm1 = new FakeLlm([
    { text: '{"l2Candidates":[]}', tokens: 10 },
    { text: JSON.stringify({ l3Self: { stable: '温柔伙伴', data: { tone: 'warm' } }, l3Persons: [] }), tokens: 20 },
  ])
  const engine1 = w.engine({ llm: llm1 })
  const prop1 = await engine1.runShadow()
  await engine1.approveProposal(prop1.id)

  const snapAfterV1 = await w.profiles.current()
  assert.ok(snapAfterV1.stable.includes('已知属性名：p_alice: city、tea'))

  // Add many L1 records and open topics between settlements; stable MUST stay byte-identical.
  w.clock.advance(5000)
  const ev3 = await w.l0({ content: { text: '新爱好摄影' } })
  const ev4 = await w.l0({ content: { text: '私人密码' } })
  await w.l1('l1.fact', { text: '喜欢摄影', key: 'camera', value: '徕卡' }, [{ id: ev3.id }], { visibility: 'open' })
  await w.l1('l1.topic', { title: '日本旅行', state: 'open' }, [{ id: ev3.id }], { visibility: 'open' })
  await w.l1('l1.fact', { text: '私密', key: 'pinCode', value: '1234' }, [{ id: ev4.id }], { visibility: 'owner' })

  const snapBetween = await w.profiles.current()
  assert.equal(snapBetween.version, snapAfterV1.version)
  assert.equal(snapBetween.stable, snapAfterV1.stable)

  // Next L3 settlement updates stable with the refreshed catalog (excluding owner items).
  w.clock.advance(5000)
  const llm2 = new FakeLlm([
    { text: '{"l2Candidates":[]}', tokens: 10 },
    { text: JSON.stringify({ l3Self: { stable: '温柔伙伴', data: { tone: 'warm', note: 'v2' } }, l3Persons: [] }), tokens: 20 },
  ])
  const engine2 = w.engine({ llm: llm2, minNewEvidence: 1 })
  const prop2 = await engine2.runShadow()
  await engine2.approveProposal(prop2.id)

  const snapAfterV2 = await w.profiles.current()
  assert.equal(snapAfterV2.version, 2)
  assert.ok(snapAfterV2.stable.includes('已知属性名：p_alice: camera、city、tea'))
  assert.ok(snapAfterV2.stable.includes('未闭合话题：日本旅行'))
  assert.equal(snapAfterV2.stable.includes('pinCode'), false)
  const v2Detail = await w.profiles.getVersion(2)
  assert.deepEqual(v2Detail.data.memoryCatalog, {
    personKeys: { p_alice: ['camera', 'city', 'tea'] },
    openTopics: ['日本旅行'],
  })
})
