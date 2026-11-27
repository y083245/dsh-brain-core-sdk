import assert from 'node:assert/strict'
import test from 'node:test'
import { BrainError, type ForgetReport, type MemoryRecord } from '@dsh-brain-core/sdk'
import {
  createMemoryPageController,
  renderMemoryPage,
  type CrossChannelAuditItem,
  type CrossChannelMode,
  type MemoryBrowseFilter,
  type MemoryPageApi,
  type PersonSummary,
} from '../../src/pages/memory/index.ts'

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'l1_01',
    layer: 'L1',
    kind: 'l1.fact',
    source: 'plugin-a',
    channel: 'plugin-a:dm:u1',
    subjects: ['p1'],
    actor: 'u1',
    content: { text: 'default content' },
    evidence: [],
    visibility: 'owner',
    trust: 'owner',
    confidence: 0.9,
    importance: 0.6,
    tEvent: 1000,
    tIngest: 1001,
    status: 'active',
    version: 1,
    ...overrides,
  }
}

interface FakeApiHandles {
  readonly api: MemoryPageApi
  readonly records: Map<string, MemoryRecord>
  readonly dependents: Map<string, readonly MemoryRecord[]>
  readonly audits: CrossChannelAuditItem[]
  readonly browseCalls: MemoryBrowseFilter[]
  readonly forgetCalls: unknown[]
  readonly updateCalls: { id: string; expectedVersion: number }[]
  mode: CrossChannelMode
  persons: PersonSummary[]
}

function createFakeApi(): FakeApiHandles {
  const records = new Map<string, MemoryRecord>()
  const dependents = new Map<string, readonly MemoryRecord[]>()
  const audits: CrossChannelAuditItem[] = []
  const browseCalls: MemoryBrowseFilter[] = []
  const forgetCalls: unknown[] = []
  const updateCalls: { id: string; expectedVersion: number }[] = []

  const handles: FakeApiHandles = {
    records,
    dependents,
    audits,
    browseCalls,
    forgetCalls,
    updateCalls,
    mode: 'off',
    persons: [],
    api: {
      async browse(filter) {
        browseCalls.push(filter)
        const all = [...records.values()].filter((r) => {
          if (filter.layer !== undefined && r.layer !== filter.layer) return false
          if (filter.personId !== undefined && !r.subjects.includes(filter.personId)) return false
          if (filter.channel !== undefined && r.channel !== filter.channel) return false
          return true
        })
        if (filter.cursor === 'page-2') {
          return { items: all.slice(1) }
        }
        if (all.length > 1) {
          return { items: all.slice(0, 1), nextCursor: 'page-2' }
        }
        return { items: all }
      },
      async search(request) {
        const hits = [...records.values()]
          .filter((r) => JSON.stringify(r.content).includes(request.query))
          .map((record) => ({ record, disclosure: { speakable: 'yes' as const, label: 'owner' }, score: 0.95 }))
        return { items: hits, degraded: request.query.includes('degraded') }
      },
      async getRecord(id) {
        return records.get(id) ?? null
      },
      async getDependents(id) {
        return dependents.get(id) ?? []
      },
      async updateRecord(id, patch, expectedVersion) {
        updateCalls.push({ id, expectedVersion })
        const existing = records.get(id)
        if (!existing) throw new BrainError('NOT_FOUND', 'missing')
        if (existing.version !== expectedVersion) {
          throw new BrainError('CONFLICT', 'version mismatch')
        }
        const updated: MemoryRecord = { ...existing, ...patch, version: existing.version + 1 }
        records.set(id, updated)
        return updated
      },
      async forget(selector) {
        forgetCalls.push(selector)
        const report: ForgetReport = { tombstoned: 1, invalidated: 3, l3Flagged: 1 }
        return report
      },
      async listAudit(recordId) {
        return recordId === undefined ? [...audits] : audits.filter((a) => a.recordId === recordId)
      },
      async getCrossChannelMode() {
        return handles.mode
      },
      async setCrossChannelMode(mode) {
        handles.mode = mode
      },
      async listPersons() {
        return [...handles.persons]
      },
      async mergePerson(from, into) {
        const fromPerson = handles.persons.find((p) => p.personId === from)
        handles.persons = handles.persons
          .filter((p) => p.personId !== from)
          .map((p) => (p.personId === into && fromPerson
            ? { ...p, accounts: [...p.accounts, ...fromPerson.accounts], aliases: [...p.aliases, fromPerson.personId] }
            : p))
      },
      async splitPerson(personId, accounts) {
        handles.persons = handles.persons.map((p) => (
          p.personId === personId
            ? { ...p, accounts: p.accounts.filter((a) => !accounts.includes(a)) }
            : p
        ))
        const newId = `${personId}_split`
        handles.persons = [...handles.persons, { personId: newId, accounts: [...accounts], aliases: [] }]
        return newId
      },
    },
  }
  return handles
}

test('three-dimensional browse, cursor pagination, search, and degraded notice', async () => {
  const fake = createFakeApi()
  fake.records.set('l1_a', makeRecord({ id: 'l1_a', layer: 'L1', subjects: ['p1'], channel: 'ch:1', content: { text: 'alpha' } }))
  fake.records.set('l1_b', makeRecord({ id: 'l1_b', layer: 'L1', subjects: ['p1'], channel: 'ch:1', content: { text: 'beta' } }))
  fake.records.set('l2_c', makeRecord({ id: 'l2_c', layer: 'L2', subjects: ['p2'], channel: 'ch:2', content: { text: 'degraded gamma' } }))

  const ctrl = createMemoryPageController(fake.api)
  assert.ok(renderMemoryPage(ctrl.state()).includes('暂无匹配的记忆记录'))

  // loadNextPage before any nextCursor is a no-op
  await ctrl.loadNextPage()
  assert.equal(fake.browseCalls.length, 0)

  await ctrl.browse({ layer: 'L1', personId: 'p1', channel: 'ch:1' })
  assert.equal(ctrl.state().items.length, 1)
  assert.equal(ctrl.state().nextCursor, 'page-2')
  assert.ok(renderMemoryPage(ctrl.state()).includes('加载下一页'))

  await ctrl.loadNextPage()
  assert.equal(ctrl.state().items.length, 2)
  assert.equal(ctrl.state().nextCursor, undefined)
  assert.equal(fake.browseCalls[1]?.cursor, 'page-2')

  await ctrl.search('degraded', { layers: ['L2'], subjects: ['p2'] })
  assert.equal(ctrl.state().degraded, true)
  assert.equal(ctrl.state().searchHits?.length, 1)
  const searchHtml = renderMemoryPage(ctrl.state())
  assert.ok(searchHtml.includes('检索降级'))
  assert.ok(searchHtml.includes('degraded gamma'))
})

test('owner console renders full content of active visibility:internal records (UC-05)', async () => {
  const fake = createFakeApi()
  const internalRec = makeRecord({
    id: 'l1_internal',
    visibility: 'internal',
    content: { secretThought: 'owner private conclusion' },
  })
  fake.records.set(internalRec.id, internalRec)

  const ctrl = createMemoryPageController(fake.api)
  await ctrl.browse()
  await ctrl.selectRecord(internalRec.id)
  const html = renderMemoryPage(ctrl.state())
  assert.ok(html.includes('owner private conclusion'))
  assert.ok(html.includes('internal'))
})

test('evidence chain walks down to L0 with cycle protection and tombstoned nodes never leak content', async () => {
  const fake = createFakeApi()
  const secretLeak = 'TOP_SECRET_TOMBSTONE_TEXT_MUST_NOT_APPEAR'
  const l0 = makeRecord({
    id: 'l0_01',
    layer: 'L0',
    status: 'tombstoned',
    content: { raw: secretLeak },
    evidence: [],
  })
  const l1 = makeRecord({
    id: 'l1_01',
    layer: 'L1',
    evidence: [{ id: 'l0_01' }, { id: 'l0_missing' }],
    content: { fact: 'visible l1 fact' },
  })
  const l2 = makeRecord({
    id: 'l2_01',
    layer: 'L2',
    evidence: [{ id: 'l1_01' }, { id: 'l2_01' }], // includes self-cycle
    content: { summary: 'l2 summary' },
  })
  fake.records.set(l0.id, l0)
  fake.records.set(l1.id, l1)
  fake.records.set(l2.id, l2)
  fake.audits.push({ recordId: 'l2_01', viewerChannel: 'tg:group:9', mode: 'on', tAt: 4200 })

  const ctrl = createMemoryPageController(fake.api)
  await ctrl.browse()
  await ctrl.selectRecord('l2_01')

  const chain = ctrl.state().evidenceChain
  assert.ok(chain !== null)
  assert.equal(chain.record.id, 'l2_01')
  assert.equal(chain.children.length, 1)
  assert.equal(chain.children[0]?.record.id, 'l1_01')
  assert.equal(chain.children[0]?.children[0]?.record.id, 'l0_01')

  const html = renderMemoryPage(ctrl.state())
  assert.ok(html.includes('已遗忘（墓碑）'))
  assert.ok(!html.includes(secretLeak))
  assert.ok(html.includes('tg:group:9'))
  assert.ok(html.includes('4200'))

  // Selecting a tombstoned record directly also must not leak its content
  await ctrl.selectRecord('l0_01')
  const directHtml = renderMemoryPage(ctrl.state())
  assert.ok(!directHtml.includes(secretLeak))

  // Selecting a non-existent record clears selectedRecord
  await ctrl.selectRecord('does_not_exist')
  assert.equal(ctrl.state().selectedRecord, null)
  assert.equal(ctrl.state().evidenceChain, null)
})

test('optimistic locking editRecord & markOutdated handle CONFLICT without overwriting', async () => {
  const fake = createFakeApi()
  fake.records.set('l1_01', makeRecord({ id: 'l1_01', version: 3, content: { text: 'v3' } }))

  const ctrl = createMemoryPageController(fake.api)
  await ctrl.browse()
  await ctrl.selectRecord('l1_01')

  // Simulate concurrent update on server (version is now 4)
  fake.records.set('l1_01', makeRecord({ id: 'l1_01', version: 4, content: { text: 'v4' } }))

  const editOk = await ctrl.editRecord('l1_01', { content: { text: 'stale' } }, 3)
  assert.equal(editOk, false)
  assert.equal(ctrl.state().conflictWarning, '版本冲突：该记录已被更新，请刷新后重试')
  assert.equal(ctrl.state().selectedRecord?.version, 3)
  assert.ok(renderMemoryPage(ctrl.state()).includes('版本冲突：该记录已被更新，请刷新后重试'))

  const outdatedConflict = await ctrl.markOutdated('l1_01', 3)
  assert.equal(outdatedConflict, false)

  // Retry with fresh expectedVersion=4 succeeds and clears conflictWarning
  const ok = await ctrl.markOutdated('l1_01', 4)
  assert.equal(ok, true)
  assert.equal(ctrl.state().conflictWarning, null)
  assert.equal(ctrl.state().selectedRecord?.status, 'outdated')
  assert.equal(ctrl.state().selectedRecord?.version, 5)
  assert.equal(fake.updateCalls[2]?.expectedVersion, 4)
})

test('two-step forget computes recursive L1/L2/L3 cascade preview and requires confirmForget', async () => {
  const fake = createFakeApi()
  const l0 = makeRecord({ id: 'l0_1', layer: 'L0' })
  const l1 = makeRecord({ id: 'l1_1', layer: 'L1' })
  const l2 = makeRecord({ id: 'l2_1', layer: 'L2' })
  const l3 = makeRecord({ id: 'l3_1', layer: 'L3' })
  fake.dependents.set('l0_1', [l1])
  fake.dependents.set('l1_1', [l2])
  fake.dependents.set('l2_1', [l3, l0]) // cycle back to l0_1

  const ctrl = createMemoryPageController(fake.api)
  const preview = await ctrl.requestForgetRecord('l0_1')
  assert.equal(fake.forgetCalls.length, 0)
  assert.deepEqual(preview.affectedIds, ['l1_1', 'l2_1', 'l3_1'])
  assert.deepEqual(preview.byLayer.L1, ['l1_1'])
  assert.deepEqual(preview.byLayer.L2, ['l2_1'])
  assert.deepEqual(preview.byLayer.L3, ['l3_1'])

  const modalHtml = renderMemoryPage(ctrl.state())
  assert.ok(modalHtml.includes('确认遗忘'))
  assert.ok(modalHtml.includes('l1_1'))
  assert.ok(modalHtml.includes('l2_1'))
  assert.ok(modalHtml.includes('l3_1'))

  ctrl.cancelForget()
  assert.equal(ctrl.state().pendingForget, null)
  assert.equal(fake.forgetCalls.length, 0)

  await assert.rejects(() => ctrl.confirmForget(), (err: unknown) => err instanceof BrainError && err.code === 'INVALID_ARGUMENT')

  await ctrl.requestForgetRecord('l0_1')
  const report = await ctrl.confirmForget()
  assert.equal(fake.forgetCalls.length, 1)
  assert.deepEqual(fake.forgetCalls[0], { by: 'record', id: 'l0_1' })
  assert.equal(report.tombstoned, 1)
  assert.equal(ctrl.state().pendingForget, null)
  assert.ok(renderMemoryPage(ctrl.state()).includes('tombstoned=1'))
})

test('cross-channel panel and person merge/split + XSS escaping', async () => {
  const fake = createFakeApi()
  fake.mode = 'shadow'
  fake.audits.push(
    { recordId: 'l1_1', viewerChannel: 'tg:2', mode: 'shadow', tAt: 100 },
    { recordId: 'l1_2', viewerChannel: 'tg:3', mode: 'on', tAt: 200 },
  )
  fake.persons = [
    { personId: 'p1', accounts: ['tg:u1', 'wx:u1'], aliases: ['Alice'] },
    { personId: 'p2', accounts: ['tg:u2'], aliases: ['<script>alert(1)</script>'] },
  ]

  const ctrl = createMemoryPageController(fake.api)
  await ctrl.loadCrossChannelPanel()
  assert.equal(ctrl.state().crossChannelMode, 'shadow')
  assert.equal(ctrl.state().shadowAudit.length, 1)
  assert.equal(ctrl.state().shadowAudit[0]?.recordId, 'l1_1')

  await ctrl.changeCrossChannelMode('on')
  assert.equal(ctrl.state().crossChannelMode, 'on')

  await ctrl.loadPersons()
  assert.equal(ctrl.state().persons.length, 2)
  const xssHtml = renderMemoryPage(ctrl.state())
  assert.ok(!xssHtml.includes('<script>alert(1)</script>'))
  assert.ok(xssHtml.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))

  await ctrl.mergePerson('p2', 'p1')
  assert.equal(ctrl.state().persons.length, 1)
  assert.ok(ctrl.state().persons[0]?.accounts.includes('tg:u2'))

  const splitId = await ctrl.splitPerson('p1', ['wx:u1'])
  assert.equal(splitId, 'p1_split')
  assert.equal(ctrl.state().persons.length, 2)
})

test('controller surfaces API errors cleanly in errorMessage', async () => {
  const failingApi: MemoryPageApi = {
    async browse() { throw new Error('browse failed') },
    async search() { throw 'non-error rejection' },
    async getRecord() { throw new Error('get failed') },
    async getDependents() { throw new Error('deps failed') },
    async updateRecord() { throw new Error('update failed') },
    async forget() { throw new Error('forget failed') },
    async listAudit() { throw new Error('audit failed') },
    async getCrossChannelMode() { throw new Error('mode failed') },
    async setCrossChannelMode() { throw new Error('set mode failed') },
    async listPersons() { throw new Error('persons failed') },
    async mergePerson() { throw new Error('merge failed') },
    async splitPerson() { throw new Error('split failed') },
  }

  const ctrl = createMemoryPageController(failingApi)
  await ctrl.browse()
  assert.equal(ctrl.state().errorMessage, 'browse failed')
  assert.ok(renderMemoryPage(ctrl.state()).includes('browse failed'))

  await ctrl.search('x')
  assert.equal(ctrl.state().errorMessage, 'unknown error')

  await ctrl.selectRecord('1')
  assert.equal(ctrl.state().errorMessage, 'get failed')

  assert.equal(await ctrl.editRecord('1', {}, 1), false)
  assert.equal(ctrl.state().errorMessage, 'update failed')

  await assert.rejects(() => ctrl.requestForgetRecord('1'))
  assert.equal(ctrl.state().errorMessage, 'deps failed')

  await ctrl.loadCrossChannelPanel()
  assert.equal(ctrl.state().errorMessage, 'mode failed')

  await ctrl.changeCrossChannelMode('on')
  assert.equal(ctrl.state().errorMessage, 'set mode failed')

  await ctrl.loadPersons()
  assert.equal(ctrl.state().errorMessage, 'persons failed')

  await ctrl.mergePerson('a', 'b')
  assert.equal(ctrl.state().errorMessage, 'merge failed')

  await assert.rejects(() => ctrl.splitPerson('a', ['x']))
  assert.equal(ctrl.state().errorMessage, 'split failed')
})

test('mutation coverage: browse clears searchHits, XSS escaping in content/audit, tombstone metadata hiding, evidence children HTML, and shadowAudit table', async () => {
  const fake = createFakeApi()
  const tombstoned = makeRecord({
    id: 'l0_tomb',
    layer: 'L0',
    kind: 'l0.secret_kind',
    channel: 'tg:secret_channel',
    subjects: ['secret_subj'],
    actor: 'secret_actor',
    status: 'tombstoned',
    content: { raw: 'TOP_SECRET_RAW_PAYLOAD' },
    evidence: [],
  })
  const l1 = makeRecord({
    id: 'l1_child',
    layer: 'L1',
    evidence: [{ id: 'l0_tomb' }],
    content: { text: '<script>alert(2)</script>' },
  })
  const l2 = makeRecord({
    id: 'l2_parent',
    layer: 'L2',
    evidence: [{ id: 'l1_child' }],
    content: { summary: 'parent summary' },
  })
  fake.records.set(tombstoned.id, tombstoned)
  fake.records.set(l1.id, l1)
  fake.records.set(l2.id, l2)
  fake.mode = 'shadow'
  fake.audits.push(
    { recordId: 'l2_parent', viewerChannel: '<img src=x>', mode: 'on', tAt: 999 },
    { recordId: 'l1_child', viewerChannel: 'tg:shadow_chan', mode: 'shadow', tAt: 888 },
  )

  const ctrl = createMemoryPageController(fake.api)

  // search() followed by browse() must clear searchHits
  await ctrl.search('parent')
  assert.equal(ctrl.state().searchHits?.length, 1)
  await ctrl.browse()
  assert.equal(ctrl.state().searchHits, null)
  assert.equal(ctrl.state().searchQuery, null)
  assert.equal(ctrl.state().degraded, false)
  await ctrl.loadNextPage()

  // List rendering: tombstoned item hides kind/channel; active item escapes content XSS
  const listHtml = renderMemoryPage(ctrl.state())
  assert.ok(!listHtml.includes('l0.secret_kind'))
  assert.ok(!listHtml.includes('tg:secret_channel'))
  assert.ok(!listHtml.includes('<script>alert(2)</script>'))
  assert.ok(listHtml.includes('&lt;script&gt;alert(2)&lt;/script&gt;'))

  // Detail + evidence chain: recursive children rendered, audit viewerChannel XSS escaped
  await ctrl.selectRecord('l2_parent')
  await ctrl.loadCrossChannelPanel()
  const detailHtml = renderMemoryPage(ctrl.state())
  assert.ok(detailHtml.includes('evidence-children'))
  assert.ok(detailHtml.includes('l1_child'))
  assert.ok(detailHtml.includes('l0_tomb'))
  assert.ok(!detailHtml.includes('<img src=x>'))
  assert.ok(detailHtml.includes('&lt;img src=x&gt;'))
  // Shadow audit table renders shadowAudit rows
  assert.ok(detailHtml.includes('tg:shadow_chan'))
  assert.ok(detailHtml.includes('888'))

  // Tombstoned selectedRecord hides subjects/actor/content in detail
  await ctrl.selectRecord('l0_tomb')
  const tombDetailHtml = renderMemoryPage(ctrl.state())
  assert.ok(tombDetailHtml.includes('已遗忘（墓碑）'))
  assert.ok(!tombDetailHtml.includes('secret_subj'))
  assert.ok(!tombDetailHtml.includes('secret_actor'))
  assert.ok(!tombDetailHtml.includes('TOP_SECRET_RAW_PAYLOAD'))
})
