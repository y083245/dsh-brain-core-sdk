import assert from 'node:assert/strict'
import test from 'node:test'
import { BrainError } from '@brain-core/sdk'
import {
  createHttpMemoryPageApi,
  createMemoryPageController,
  renderL3ConsolidationWorkspace,
  renderMemoryPage,
  type ConsolidationBudgetView,
  type ConsolidationProposalView,
  type L3ProfileDiffView,
  type L3ProfileVersionSummary,
  type MemoryPageApi,
} from '../../src/pages/memory/index.ts'
import { renderAppleThemeCss } from '../../src/shell/theme.ts'

interface RecordedCall {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: unknown
}

function mockFetch(
  handler: (call: RecordedCall) => Response | Promise<Response>,
): { readonly fetchImpl: typeof globalThis.fetch; readonly calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: rawHeaders,
      body,
    }
    calls.push(call)
    return handler(call)
  }) as unknown as typeof globalThis.fetch
  return { fetchImpl, calls }
}

function okResponse(data: unknown, status = 200): Response {
  return new Response(
    JSON.stringify({ ok: true, data, meta: { requestId: 'req-l3', apiVersion: '1.0' } }),
    { status, headers: { 'Content-Type': 'application/json' } },
  )
}

function errResponse(code: string, message: string, status: number): Response {
  return new Response(
    JSON.stringify({ ok: false, error: { code, message, details: {} }, meta: { requestId: 'req-err' } }),
    { status, headers: { 'Content-Type': 'application/json' } },
  )
}

function makeBaseApiStub(): MemoryPageApi {
  return {
    async browse() { return { items: [] } },
    async search() { return { items: [], degraded: false } },
    async getRecord() { return null },
    async getDependents() { return [] },
    async updateRecord() { throw new BrainError('NOT_FOUND', 'unused') },
    async forget() { return { tombstoned: 0, invalidated: 0, l3Flagged: 0 } },
    async listAudit() { return [] },
    async getCrossChannelMode() { return 'off' },
    async setCrossChannelMode() {},
    async listPersons() { return [] },
    async mergePerson() {},
    async splitPerson() { return 'p_split' },
  }
}

function makeVersion(overrides: Partial<L3ProfileVersionSummary> = {}): L3ProfileVersionSummary {
  return {
    version: 1,
    tAt: 1000,
    status: 'active',
    current: true,
    author: 'settlement',
    evidenceCount: 4,
    stable: '温柔且细心',
    data: { hobbies: ['tea'] },
    ...overrides,
  }
}

function makeProposal(overrides: Partial<ConsolidationProposalView> = {}): ConsolidationProposalView {
  return {
    id: 'prop_01',
    status: 'pending',
    createdAt: 2000,
    window: { from: 1000, to: 2000 },
    tokensUsed: 320,
    l2Candidates: [
      {
        id: 'l2_cand_1',
        kind: 'l2.person_tip',
        channel: 'tg:dm:u1',
        subjects: ['p1'],
        content: { text: '喜欢乌龙茶', quote: '太喜欢乌龙茶啦' },
        evidenceIds: ['l1_ev_1', 'l1_ev_2'],
        confidence: 0.92,
        importance: 0.75,
      },
    ],
    corrections: [
      {
        id: 'corr_1',
        action: 'promote-candidate',
        targetId: 'l1_cand_9',
        reason: '两条独立非自身证据印证',
      },
      {
        id: 'corr_2',
        action: 'supersede-fact',
        targetId: 'l1_fact_old',
        reason: '更新的居住城市事实',
      },
    ],
    selfConflicts: [
      {
        id: 'conf_1',
        recordAId: 'l1_self_a',
        recordBId: 'l1_self_b',
        statementA: '我更喜欢安静看书',
        statementB: '我最喜欢每天去吵闹的集市',
        reason: '性格偏好描述冲突',
        recommendedKeepId: 'l1_self_a',
      },
    ],
    l3SelfPatch: {
      baseVersion: 1,
      stable: '温柔、爱喝乌龙茶',
      data: { hobbies: ['tea'], drink: 'oolong' },
      preservedOwnerKeys: ['tone'],
      added: ['drink'],
      removed: ['oldTag'],
      changed: ['hobbies'],
      stableChanged: true,
    },
    ...overrides,
  }
}

test('theme CSS includes all Apple frosted glass classes for L3 workspace across dark, light, and auto themes', () => {
  const css = renderAppleThemeCss()
  const requiredSelectors = [
    '.memory-subnav',
    '.badge-accent',
    '.consolidation-hero',
    '.token-budget-meter',
    '.shadow-proposal-deck',
    '.shadow-proposal-card',
    '.shadow-l2-grid',
    '.confidence-bar',
    '.quote-pill',
    '.self-conflict-card',
    '.owner-lock-shield',
    '.m4-guard-badge',
    '.l3-version-workspace',
    '.l3-version-timeline',
    '.l3-version-card',
    '.l3-diff-viewer',
    '.diff-row.diff-added',
    '.diff-row.diff-removed',
    '.diff-row.diff-changed',
    '.l3-owner-editor',
  ]
  for (const selector of requiredSelectors) {
    assert.ok(css.includes(selector), `expected theme CSS to include ${selector}`)
  }
  assert.match(css, /rgba\(48, 209, 88, 0\.14\)/)
  assert.match(css, /#30D158/)
  assert.match(css, /rgba\(255, 69, 58, 0\.14\)/)
  assert.match(css, /#FF453A/)
  assert.match(css, /rgba\(255, 159, 10, 0\.14\)/)
  assert.match(css, /#FF9F0A/)
  assert.match(css, /\.self-conflict-card \{[^}]*border: 1px solid rgba\(255, 159, 10, 0\.45\)[^}]*background: rgba\(255, 159, 10, 0\.10\)/s)
  assert.match(css, /\.owner-lock-shield \{[^}]*background: rgba\(10, 132, 255, 0\.18\)[^}]*border: 1px solid rgba\(10, 132, 255, 0\.42\)/s)
  assert.match(css, /\.badge-accent \{[^}]*background: rgba\(10, 132, 255, 0\.24\)[^}]*border: 1px solid rgba\(10, 132, 255, 0\.45\)/s)
  assert.match(css, /--glass-subsurface/)
})

test('1. HTTP API routes all 9 L3 & consolidation endpoints with Bearer token, URL encoding, bodies, and errors', async () => {
  const versions = [makeVersion({ version: 2 }), makeVersion({ version: 1, current: false, status: 'archived' })]
  const diff: L3ProfileDiffView = {
    from: 1,
    to: 2,
    stableChanged: true,
    added: ['drink'],
    removed: ['legacy'],
    changed: ['hobbies'],
  }
  const proposal = makeProposal({ id: 'prop/a?1' })
  const budget: ConsolidationBudgetView = {
    usedTokensToday: 450,
    dailyTokenCap: 2000,
    lastConsolidatedTo: 9000,
  }

  const { fetchImpl, calls } = mockFetch((call) => {
    if (call.url === 'http://127.0.0.1:9100/api/v1/console/memory/l3/versions' && call.method === 'GET') {
      return okResponse({ items: versions })
    }
    if (call.url === 'http://127.0.0.1:9100/api/v1/console/memory/l3/diff?from=1&to=2' && call.method === 'GET') {
      return okResponse(diff)
    }
    if (call.url === 'http://127.0.0.1:9100/api/v1/console/memory/l3/rollback' && call.method === 'POST') {
      return okResponse({ version: 3 })
    }
    if (call.url === 'http://127.0.0.1:9100/api/v1/console/memory/l3/owner' && call.method === 'PUT') {
      return okResponse({ version: 4 })
    }
    if (call.url === 'http://127.0.0.1:9100/api/v1/console/memory/consolidation/proposals' && call.method === 'GET') {
      return okResponse([proposal])
    }
    if (call.url === 'http://127.0.0.1:9100/api/v1/console/memory/consolidation/budget' && call.method === 'GET') {
      return okResponse(budget)
    }
    if (call.url === 'http://127.0.0.1:9100/api/v1/console/memory/consolidation/run' && call.method === 'POST') {
      return okResponse(proposal)
    }
    if (call.url === 'http://127.0.0.1:9100/api/v1/console/memory/consolidation/proposals/prop%2Fa%3F1/approve' && call.method === 'POST') {
      return okResponse({ newProfileVersion: 5, l2Created: 2 })
    }
    if (call.url === 'http://127.0.0.1:9100/api/v1/console/memory/consolidation/proposals/prop%2Fa%3F1/reject' && call.method === 'POST') {
      return okResponse({ ok: true })
    }
    return errResponse('NOT_FOUND', 'unexpected route', 404)
  })

  const api = createHttpMemoryPageApi('http://127.0.0.1:9100/', 'tok-l3-xyz', fetchImpl)

  const gotVersions = await api.listL3Versions?.()
  assert.equal(gotVersions?.length, 2)
  assert.equal(calls[0]?.headers.Authorization, 'Bearer tok-l3-xyz')

  const gotDiff = await api.diffL3Versions?.(1, 2)
  assert.deepEqual(gotDiff, diff)

  const rolled = await api.rollbackL3Version?.(1)
  assert.deepEqual(rolled, { version: 3 })
  assert.deepEqual(calls[2]?.body, { version: 1 })

  const ownerRes = await api.editL3ByOwner?.({ stable: 'new stable', data: { k: 'v' }, lockedKeys: ['k'] })
  assert.deepEqual(ownerRes, { version: 4 })
  assert.deepEqual(calls[3]?.body, { stable: 'new stable', data: { k: 'v' }, lockedKeys: ['k'] })

  const gotProposals = await api.listConsolidationProposals?.()
  assert.equal(gotProposals?.length, 1)

  const gotBudget = await api.getConsolidationBudget?.()
  assert.deepEqual(gotBudget, budget)

  const ran = await api.runConsolidationShadow?.()
  assert.equal(ran?.id, 'prop/a?1')

  const approved = await api.approveConsolidationProposal?.('prop/a?1', { conf_1: 'l1_self_a' })
  assert.deepEqual(approved, { newProfileVersion: 5, l2Created: 2 })
  assert.deepEqual(calls[7]?.body, { conflictKeepIds: { conf_1: 'l1_self_a' } })

  await api.approveConsolidationProposal?.('prop/a?1')
  assert.deepEqual(calls[8]?.body, {})

  await api.rejectConsolidationProposal?.('prop/a?1')
  assert.equal(calls[9]?.method, 'POST')

  // Error propagation
  const failing = createHttpMemoryPageApi(
    'http://127.0.0.1:9100',
    'tok',
    mockFetch(() => errResponse('RATE_LIMITED', 'daily token cap exceeded', 429)).fetchImpl,
  )
  await assert.rejects(
    () => failing.runConsolidationShadow!(),
    (err: unknown) => err instanceof BrainError && err.code === 'RATE_LIMITED',
  )
})

test('2. loadConsolidationWorkspace & switchSubView render Apple glass workspace, SVG meter, timeline, and proposal deck', async () => {
  const api: MemoryPageApi = {
    ...makeBaseApiStub(),
    async listL3Versions() {
      return [makeVersion({ version: 3, current: true, author: 'settlement', evidenceCount: 7 })]
    },
    async listConsolidationProposals() {
      return [
        makeProposal({ id: 'prop_p1', status: 'pending' }),
        makeProposal({ id: 'prop_a1', status: 'approved' }),
      ]
    },
    async getConsolidationBudget() {
      return { usedTokensToday: 600, dailyTokenCap: 1000, lastConsolidatedTo: 8888 }
    },
  }

  const ctrl = createMemoryPageController(api)
  assert.equal(ctrl.state().subView, 'browse')

  await ctrl.loadConsolidationWorkspace()
  const browseHtml = renderMemoryPage(ctrl.state())
  assert.match(browseHtml, /class="segmented memory-subnav"/)
  assert.match(browseHtml, /data-subview="browse" aria-selected="true"/)
  assert.match(browseHtml, /data-subview="consolidation" aria-selected="false"/)
  assert.match(browseHtml, /class="apple-badge badge-accent"[^>]*>1</)
  // Browse DOM stays in browse mode until switched
  assert.match(browseHtml, /memory-toolbar/)
  assert.ok(!browseHtml.includes('l3-consolidation-workspace'))

  ctrl.switchSubView('consolidation')
  assert.equal(ctrl.state().subView, 'consolidation')

  const html = renderMemoryPage(ctrl.state())
  assert.equal(html.includes('memory-toolbar'), false)
  assert.match(html, /class="consolidation-hero"|consolidation-hero/)
  assert.match(html, /class="token-budget-meter"/)
  assert.match(html, /<svg class="token-budget-svg"/)
  assert.match(html, /600 \/ 1000/)
  assert.match(html, /60%/)
  assert.match(html, /v3/)
  assert.match(html, /class="l3-version-timeline"/)
  assert.match(html, /class="shadow-proposal-deck"/)
  assert.match(html, /夜间结算/)
  assert.match(html, /证据数: 7/)

  // Standalone workspace renderer matches
  assert.equal(renderL3ConsolidationWorkspace(ctrl.state()).includes('token-budget-svg'), true)
})

test('3. compareL3Versions renders diff-added, diff-removed, diff-changed, stableChanged, and owner-lock-shield', async () => {
  const api: MemoryPageApi = {
    ...makeBaseApiStub(),
    async listL3Versions() {
      return [
        makeVersion({ version: 2, current: true, ownerLockedKeys: ['hobbies', 'voice'] }),
        makeVersion({ version: 1, current: false, status: 'archived' }),
      ]
    },
    async listConsolidationProposals() { return [] },
    async getConsolidationBudget() { return { usedTokensToday: 0, dailyTokenCap: 1000, lastConsolidatedTo: 0 } },
    async diffL3Versions(from, to) {
      return {
        from,
        to,
        stableChanged: true,
        added: ['newSkill'],
        removed: ['oldHabit'],
        changed: ['hobbies'],
      }
    },
  }

  const ctrl = createMemoryPageController(api)
  await ctrl.loadConsolidationWorkspace()
  ctrl.switchSubView('consolidation')
  await ctrl.compareL3Versions(1, 2)

  const html = renderL3ConsolidationWorkspace(ctrl.state())
  assert.match(html, /v1 → v2/)
  assert.match(html, /class="diff-row diff-added"[^>]*><span class="mono">\+ newSkill<\/span>/)
  assert.match(html, /class="diff-row diff-removed"[^>]*><span class="mono">- oldHabit<\/span>/)
  assert.match(html, /class="diff-row diff-changed"[^>]*><span class="mono">~ hobbies<\/span>/)
  assert.match(html, /stableChanged: 是/)
  assert.match(html, /class="apple-badge owner-lock-shield"/)
  assert.match(html, /主人锁定 · 自动结算保留：hobbies, voice/)
})

test('4 & 5. rollbackL3 sets rollbackNotice and refreshes versions; saveOwnerL3 refreshes and renders 主人钦定 badge', async () => {
  let versions: L3ProfileVersionSummary[] = [
    makeVersion({ version: 2, current: true, author: 'settlement' }),
    makeVersion({ version: 1, current: false, status: 'archived', author: 'settlement' }),
  ]
  const rollbackCalls: number[] = []
  const ownerEdits: unknown[] = []

  const api: MemoryPageApi = {
    ...makeBaseApiStub(),
    async listL3Versions() { return versions },
    async listConsolidationProposals() { return [] },
    async getConsolidationBudget() { return { usedTokensToday: 10, dailyTokenCap: 1000, lastConsolidatedTo: 100 } },
    async rollbackL3Version(version) {
      rollbackCalls.push(version)
      versions = [
        makeVersion({ version: 3, current: true, author: 'settlement' }),
        makeVersion({ version: 2, current: false, status: 'archived' }),
        makeVersion({ version: 1, current: false, status: 'archived' }),
      ]
      return { version: 3 }
    },
    async editL3ByOwner(patch) {
      ownerEdits.push(patch)
      versions = [
        makeVersion({
          version: 4,
          current: true,
          author: 'owner',
          ownerLockedKeys: patch.lockedKeys ?? [],
          ...(patch.stable === undefined ? {} : { stable: patch.stable }),
          data: patch.data,
        }),
        ...versions.map((v) => ({ ...v, current: false, status: 'archived' })),
      ]
      return { version: 4 }
    },
  }

  const ctrl = createMemoryPageController(api)
  await ctrl.loadConsolidationWorkspace()
  ctrl.switchSubView('consolidation')

  const rolled = await ctrl.rollbackL3(1)
  assert.equal(rolled, true)
  assert.deepEqual(rollbackCalls, [1])
  assert.equal(ctrl.state().rollbackNotice, '已回滚至 L3 版本 v1')
  assert.equal(ctrl.state().l3Versions[0]?.version, 3)

  const rolledHtml = renderMemoryPage(ctrl.state())
  assert.match(rolledHtml, /已回滚至 L3 版本 v1/)

  const saved = await ctrl.saveOwnerL3({
    stable: '主人设定的核心性格',
    data: { tone: 'warm' },
    lockedKeys: ['tone'],
  })
  assert.equal(saved, true)
  assert.equal(ownerEdits.length, 1)
  assert.equal(ctrl.state().rollbackNotice, null)
  assert.equal(ctrl.state().l3Versions[0]?.author, 'owner')

  const ownerHtml = renderL3ConsolidationWorkspace(ctrl.state())
  assert.match(ownerHtml, /class="apple-badge version-badge-owner">主人钦定</)
  assert.match(ownerHtml, /主人锁定 · 自动结算保留：tone/)
  assert.match(ownerHtml, /主人设定的核心性格/)
})

test('6 & 7. shadow proposal review: L2 cards, L1.6 self-conflicts, M4 external-evidence guard, approve/reject, and triggerShadowConsolidation', async () => {
  let proposals: ConsolidationProposalView[] = [
    makeProposal({
      id: 'prop_ext',
      l3SelfPatch: null,
      skippedL3Reason: 'only-external-evidence',
    }),
  ]
  const approveCalls: { id: string; conflictKeepIds: Readonly<Record<string, string>> | undefined }[] = []
  const rejectCalls: string[] = []

  const api: MemoryPageApi = {
    ...makeBaseApiStub(),
    async listL3Versions() { return [makeVersion({ version: 1 })] },
    async listConsolidationProposals() { return proposals },
    async getConsolidationBudget() { return { usedTokensToday: 200, dailyTokenCap: 2000, lastConsolidatedTo: 500 } },
    async runConsolidationShadow() {
      const next = makeProposal({ id: 'prop_new', tokensUsed: 180 })
      proposals = [next, ...proposals]
      return next
    },
    async approveConsolidationProposal(id, conflictKeepIds) {
      approveCalls.push({ id, conflictKeepIds })
      proposals = proposals.map((p) => (p.id === id ? { ...p, status: 'approved' as const } : p))
      return { newProfileVersion: 2, l2Created: 1 }
    },
    async rejectConsolidationProposal(id) {
      rejectCalls.push(id)
      proposals = proposals.map((p) => (p.id === id ? { ...p, status: 'rejected' as const } : p))
    },
  }

  const ctrl = createMemoryPageController(api)
  await ctrl.loadConsolidationWorkspace()
  ctrl.switchSubView('consolidation')

  const initialHtml = renderL3ConsolidationWorkspace(ctrl.state())
  assert.match(initialHtml, /class="confidence-bar"/)
  assert.match(initialHtml, /class="quote-pill"[^>]*>原话：太喜欢乌龙茶啦<\/span>/)
  assert.match(initialHtml, /l1_ev_1/)
  assert.match(initialHtml, /class="self-conflict-card"/)
  assert.match(initialHtml, /我更喜欢安静看书/)
  assert.match(initialHtml, /我最喜欢每天去吵闹的集市/)
  assert.match(initialHtml, /class="apple-badge m4-guard-badge" data-guard="only-external-evidence"/)
  assert.match(initialHtml, /only-external-evidence/)

  ctrl.chooseConflictKeep('conf_1', 'l1_self_b')
  assert.deepEqual(ctrl.state().conflictDecisions, { conf_1: 'l1_self_b' })
  assert.match(renderL3ConsolidationWorkspace(ctrl.state()), /已选保留/)

  assert.equal(await ctrl.approveProposal('prop_ext'), true)
  assert.deepEqual(approveCalls, [{ id: 'prop_ext', conflictKeepIds: { conf_1: 'l1_self_b' } }])
  assert.deepEqual(ctrl.state().conflictDecisions, {})
  assert.equal(ctrl.state().proposals[0]?.status, 'approved')

  await ctrl.triggerShadowConsolidation()
  assert.equal(ctrl.state().proposals.length, 2)
  assert.equal(ctrl.state().proposals[0]?.id, 'prop_new')

  assert.equal(await ctrl.rejectProposal('prop_new'), true)
  assert.deepEqual(rejectCalls, ['prop_new'])
  assert.equal(ctrl.state().proposals.find((p) => p.id === 'prop_new')?.status, 'rejected')
})

test('8. API failure handling sets errorMessage and all dynamic consolidation fields are strictly HTML-escaped against XSS', async () => {
  const failingApi: MemoryPageApi = {
    ...makeBaseApiStub(),
    async listL3Versions() { throw new Error('versions failed') },
    async diffL3Versions() { throw new Error('diff failed') },
    async rollbackL3Version() { throw new Error('rollback failed') },
    async editL3ByOwner() { throw new Error('owner edit failed') },
    async runConsolidationShadow() { throw 'non-error shadow failure' },
    async approveConsolidationProposal() { throw new Error('approve failed') },
    async rejectConsolidationProposal() { throw new Error('reject failed') },
  }

  const ctrl = createMemoryPageController(failingApi)
  await ctrl.loadConsolidationWorkspace()
  assert.equal(ctrl.state().errorMessage, 'versions failed')

  await ctrl.compareL3Versions(1, 2)
  assert.equal(ctrl.state().errorMessage, 'diff failed')

  assert.equal(await ctrl.rollbackL3(1), false)
  assert.equal(ctrl.state().errorMessage, 'rollback failed')

  assert.equal(await ctrl.saveOwnerL3({ data: {} }), false)
  assert.equal(ctrl.state().errorMessage, 'owner edit failed')

  await ctrl.triggerShadowConsolidation()
  assert.equal(ctrl.state().errorMessage, 'unknown error')

  assert.equal(await ctrl.approveProposal('p1'), false)
  assert.equal(ctrl.state().errorMessage, 'approve failed')

  assert.equal(await ctrl.rejectProposal('p1'), false)
  assert.equal(ctrl.state().errorMessage, 'reject failed')

  // Missing optional methods also fail gracefully into errorMessage
  const minimalCtrl = createMemoryPageController(makeBaseApiStub())
  assert.equal(await minimalCtrl.rollbackL3(1), false)
  assert.match(minimalCtrl.state().errorMessage ?? '', /does not implement rollbackL3Version/)

  // XSS payloads across proposals, conflicts, L3 diffs, and versions must all be escaped
  const xss = '<script>alert("xss")</script><img src=x onerror=alert(1)>'
  const xssCtrl = createMemoryPageController({
    ...makeBaseApiStub(),
    async listL3Versions() {
      return [
        makeVersion({
          version: 1,
          status: xss,
          ownerLockedKeys: [xss],
          stable: xss,
          data: { key: xss },
        }),
      ]
    },
    async listConsolidationProposals() {
      return [
        makeProposal({
          id: xss,
          l2Candidates: [
            {
              id: 'cand_xss',
              kind: xss,
              channel: xss,
              subjects: [xss],
              content: { text: xss, quote: xss },
              evidenceIds: [xss],
              confidence: 0.8,
              importance: 0.7,
            },
          ],
          corrections: [{ id: 'c_xss', action: 'promote-candidate', targetId: xss, reason: xss }],
          selfConflicts: [
            {
              id: 'sc_xss',
              recordAId: xss,
              recordBId: 'b_id',
              statementA: xss,
              statementB: '<img onerror=alert(2)>',
              reason: xss,
            },
          ],
          l3SelfPatch: {
            baseVersion: 1,
            stable: xss,
            data: { k: xss },
            preservedOwnerKeys: [xss],
            added: [xss],
            removed: [xss],
            changed: [xss],
            stableChanged: true,
          },
        }),
      ]
    },
    async getConsolidationBudget() { return { usedTokensToday: 100, dailyTokenCap: 1000, lastConsolidatedTo: 50 } },
    async diffL3Versions() {
      return { from: 1, to: 2, stableChanged: true, added: [xss], removed: [xss], changed: [xss] }
    },
  })

  await xssCtrl.loadConsolidationWorkspace()
  await xssCtrl.compareL3Versions(1, 2)
  xssCtrl.switchSubView('consolidation')

  const html = renderMemoryPage(xssCtrl.state())
  assert.ok(!html.includes('<script>alert("xss")</script>'))
  assert.ok(!html.includes('<img src=x onerror=alert(1)>'))
  assert.ok(!html.includes('<img onerror=alert(2)>'))
  assert.ok(html.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'))
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'))
})
