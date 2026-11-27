import assert from 'node:assert/strict'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import type { CrossChannelMode, WriteIdentity } from '@dsh-brain-core/kernel/contracts'
import { BrainError, type ContextBundle, type Envelope, type MemoryRecord, type SearchHit, type Viewer, type Visibility } from '@dsh-brain-core/sdk'
import { assertUnwrappedOk, httpJson, setupAcceptanceKernel } from './helpers.ts'

const GROUP_CHANNEL = 'qq:group:20001'
const PRIVATE_ALICE = 'qq:private:30001'
const OWNER_CHANNEL = 'qq:private:owner'
const MISSING_ID = 'l1_00000000000000000000000000'
const SECRET_RAW = '绝密原文：她昨晚失眠'
const CONCLUSION_TEXT = '今天别催她进度'

const KERNEL_WRITE: WriteIdentity = {
  kind: 'kernel',
  source: 'owner-console',
  trust: 'owner',
  defaultVisibility: 'owner',
}

interface FixtureIds {
  readonly open: string
  readonly subject: string
  readonly origin: string
  readonly owner: string
  readonly internal: string
}

async function seedRecords(
  kernel: Awaited<ReturnType<typeof setupAcceptanceKernel>>['kernel'],
): Promise<FixtureIds> {
  const l0 = await kernel.memory.service.ingest({
    kind: 'qq.message',
    channel: GROUP_CHANNEL,
    subjects: ['p_alice'],
    actor: 'p_alice',
    content: { text: '群里聊天记录' },
    tEvent: 1_760_000_000_000,
    idempotencyKey: 'at3-l0',
    visibility: 'open',
  }, KERNEL_WRITE)

  kernel.memory.channels.setMembers(GROUP_CHANNEL, ['p_alice', 'p_bob'])

  const makeL1 = async (
    visibility: Visibility,
    subjects: readonly string[],
    content: Record<string, unknown>,
  ): Promise<string> => {
    const rec = await kernel.memory.service.record({
      layer: 'L1',
      kind: 'l1.fact',
      channel: GROUP_CHANNEL,
      subjects,
      actor: 'owner',
      content,
      evidence: [{ id: l0.id }],
      visibility,
      tEvent: 1_760_000_001_000,
      idempotencyKey: `at3-${visibility}`,
    }, KERNEL_WRITE)
    return rec.id
  }

  const open = await makeL1('open', ['p_alice'], { text: '公开记录：她喜欢喝乌龙茶（披露矩阵）' })
  const subject = await makeL1('subject', ['p_alice'], { text: '当事人记录：她最近准备换键盘（披露矩阵）' })
  const origin = await makeL1('origin', ['p_alice'], { text: '本群限定：群活动周六下午开始（披露矩阵）' })
  const owner = await makeL1('owner', ['p_alice', 'self'], { text: '主人日记：今天帮她备一份热茶（披露矩阵）' })
  const internal = await makeL1('internal', ['p_alice', 'self'], {
    text: `${SECRET_RAW}（披露矩阵）`,
    conclusion: CONCLUSION_TEXT,
  })

  await kernel.memory.service.flush()
  return { open, subject, origin, owner, internal }
}

function readAuditRows(brainHome: string): readonly { readonly recordId: string; readonly viewerChannel: string; readonly mode: string }[] {
  const db = new DatabaseSync(path.join(brainHome, 'state', 'memory', 'audit.db'), { readOnly: true })
  try {
    const rows = db.prepare(
      'SELECT record_id, viewer_channel, mode FROM cross_channel_use ORDER BY t_at ASC',
    ).all() as unknown as readonly { readonly record_id: string; readonly viewer_channel: string; readonly mode: string }[]
    return rows.map((row) => ({ recordId: row.record_id, viewerChannel: row.viewer_channel, mode: row.mode }))
  } finally {
    db.close()
  }
}

function factsMap(bundle: ContextBundle): Map<string, { readonly text: string; readonly speakable: string }> {
  const block = bundle.blocks.find((b) => b.name === 'facts')
  const map = new Map<string, { readonly text: string; readonly speakable: string }>()
  for (const item of block?.items ?? []) {
    map.set(item.id, { text: item.text, speakable: item.disclosure.speakable })
  }
  return map
}

function searchMap(hits: readonly SearchHit[]): Map<string, { readonly content: Record<string, unknown>; readonly speakable: string }> {
  const map = new Map<string, { readonly content: Record<string, unknown>; readonly speakable: string }>()
  for (const hit of hits) {
    map.set(hit.record.id, { content: hit.record.content, speakable: hit.disclosure.speakable })
  }
  return map
}

function assertSpeakables(
  actual: ReadonlyMap<string, { readonly speakable: string }>,
  expected: Readonly<Record<string, 'yes' | 'if-subject-raises' | 'never'>>,
  label: string,
): void {
  const actualEntries = Object.fromEntries([...actual.entries()].map(([id, v]) => [id, v.speakable]))
  assert.deepEqual(actualEntries, expected, label)
}

function captureBrainError(fn: () => Promise<unknown>): Promise<{ readonly code: string; readonly message: string; readonly details: unknown }> {
  return fn().then(
    () => { throw new Error('expected BrainError, but succeeded') },
    (error: unknown) => {
      assert.ok(error instanceof BrainError, `expected BrainError, got ${String(error)}`)
      return { code: error.code, message: error.message, details: error.details }
    },
  )
}

for (const mode of ['off', 'shadow', 'on'] as readonly CrossChannelMode[]) {
  test(`AT-3: disclosure matrix (V1..V4) in crossChannel=${mode}`, async (t) => {
    const h = await setupAcceptanceKernel(t, {
      crossChannel: mode,
      ownerChannels: [OWNER_CHANNEL],
      withConsole: true,
    })
    const ids = await seedRecords(h.kernel)

    const viewers: Record<'V1' | 'V2' | 'V3' | 'V4', Viewer> = {
      V1: { caller: 'agent', channel: GROUP_CHANNEL, participants: ['p_alice', 'p_bob'] },
      V2: { caller: 'agent', channel: GROUP_CHANNEL, participants: ['p_bob'] },
      V3: { caller: 'agent', channel: PRIVATE_ALICE, participants: ['p_alice'] },
      V4: { caller: 'agent', channel: OWNER_CHANNEL, participants: ['self'] },
    }

    const expectedContext: Record<'V1' | 'V2' | 'V3' | 'V4', Record<string, 'yes' | 'if-subject-raises' | 'never'>> = {
      V1: { [ids.open]: 'yes', [ids.subject]: 'if-subject-raises', [ids.origin]: 'yes', [ids.internal]: 'never' },
      V2: { [ids.open]: 'yes', [ids.origin]: 'yes', [ids.internal]: 'never' },
      V3: mode === 'on'
        ? { [ids.open]: 'yes', [ids.subject]: 'yes', [ids.internal]: 'never' }
        : {},
      V4: mode === 'on'
        ? { [ids.owner]: 'yes', [ids.internal]: 'never' }
        : {},
    }

    const expectedSearch: Record<'V1' | 'V2' | 'V3' | 'V4', Record<string, 'yes' | 'if-subject-raises' | 'never'>> = {
      V1: { [ids.open]: 'yes', [ids.subject]: 'if-subject-raises', [ids.origin]: 'yes', [ids.internal]: 'never' },
      V2: { [ids.open]: 'yes', [ids.origin]: 'yes', [ids.internal]: 'never' },
      V3: mode === 'on'
        ? { [ids.open]: 'yes', [ids.subject]: 'yes', [ids.internal]: 'never' }
        : {},
      V4: mode === 'on'
        ? { [ids.owner]: 'yes', [ids.internal]: 'never' }
        : {},
    }

    for (const key of ['V1', 'V2', 'V3', 'V4'] as const) {
      const viewer = viewers[key]
      const bundle = await h.kernel.memory.service.context({ channel: viewer.channel! }, viewer)
      const fMap = factsMap(bundle)
      assertSpeakables(fMap, expectedContext[key], `${mode} ${key} /context facts`)
      assert.equal(JSON.stringify(bundle).includes(SECRET_RAW), false, `${mode} ${key} /context must never leak raw internal text`)
      if (fMap.has(ids.internal)) {
        assert.equal(fMap.get(ids.internal)!.text, CONCLUSION_TEXT)
      }

      const searchRes = await h.kernel.memory.service.search({ query: '披露矩阵', scope: 'all' }, viewer)
      const sMap = searchMap(searchRes.items)
      assertSpeakables(sMap, expectedSearch[key], `${mode} ${key} search`)
      assert.equal(JSON.stringify(searchRes).includes(SECRET_RAW), false, `${mode} ${key} search must never leak raw internal text`)
      if (sMap.has(ids.internal)) {
        assert.deepEqual(sMap.get(ids.internal)!.content, { conclusion: CONCLUSION_TEXT })
      }
    }

    // Verify audit rows for cross-channel context assembly
    const audits = readAuditRows(h.brainHome)
    if (mode === 'off') {
      assert.equal(audits.length, 0, 'off mode must write 0 audit rows')
    } else if (mode === 'shadow') {
      const v3Audits = audits.filter((a) => a.viewerChannel === PRIVATE_ALICE && a.mode === 'shadow').map((a) => a.recordId).sort()
      const v4Audits = audits.filter((a) => a.viewerChannel === OWNER_CHANNEL && a.mode === 'shadow').map((a) => a.recordId).sort()
      assert.deepEqual(v3Audits, [ids.open, ids.subject, ids.internal].sort())
      assert.deepEqual(v4Audits, [ids.owner, ids.internal].sort())
    } else {
      assert.ok(audits.some((a) => a.viewerChannel === PRIVATE_ALICE && a.recordId === ids.open && a.mode === 'on'))
      assert.ok(audits.some((a) => a.viewerChannel === PRIVATE_ALICE && a.recordId === ids.subject && a.mode === 'on'))
      assert.ok(audits.some((a) => a.viewerChannel === OWNER_CHANNEL && a.recordId === ids.owner && a.mode === 'on'))
    }

    // Owner console (UC-05) sees full internal text via both HTTP search and console record detail
    const ownerSearch = await httpJson<Envelope<{ readonly items: readonly SearchHit[] }>>(
      h.kernel.port,
      'POST',
      '/api/v1/memory/search',
      { token: h.token, body: { query: '披露矩阵', scope: 'all' } },
    )
    assert.equal(ownerSearch.status, 200)
    const ownerHits = assertUnwrappedOk(ownerSearch.body).items
    const ownerInternalHit = ownerHits.find((hit) => hit.record.id === ids.internal)
    assert.ok(ownerInternalHit !== undefined)
    assert.ok(String(ownerInternalHit.record.content.text).includes(SECRET_RAW))

    const consoleDetail = await httpJson<Envelope<MemoryRecord>>(
      h.consolePort!,
      'GET',
      `/api/v1/console/memory/records/${ids.internal}`,
      { token: h.token },
    )
    assert.equal(consoleDetail.status, 200)
    const detailData = assertUnwrappedOk(consoleDetail.body)
    assert.ok(String(detailData.content.text).includes(SECRET_RAW))
  })
}

test('AT-3: invisible records return byte-for-byte identical NOT_FOUND as missing IDs (RFC S2)', async (t) => {
  const h = await setupAcceptanceKernel(t, {
    crossChannel: 'on',
    ownerChannels: [OWNER_CHANNEL],
    withConsole: true,
  })
  const ids = await seedRecords(h.kernel)

  const v1Viewer: Viewer = { caller: 'agent', channel: GROUP_CHANNEL, participants: ['p_alice', 'p_bob'] }
  const v2Viewer: Viewer = { caller: 'agent', channel: GROUP_CHANNEL, participants: ['p_bob'] }

  // Service-level update & remove on missing ID vs invisible records
  const missingUpdateErr = await captureBrainError(() =>
    h.kernel.memory.service.update(MISSING_ID, { status: 'outdated' }, 1, KERNEL_WRITE, v1Viewer),
  )
  const missingRemoveErr = await captureBrainError(() =>
    h.kernel.memory.service.remove(MISSING_ID, KERNEL_WRITE, v1Viewer),
  )

  const ownerUpdateFromV1 = await captureBrainError(() =>
    h.kernel.memory.service.update(ids.owner, { status: 'outdated' }, 1, KERNEL_WRITE, v1Viewer),
  )
  const ownerRemoveFromV1 = await captureBrainError(() =>
    h.kernel.memory.service.remove(ids.owner, KERNEL_WRITE, v1Viewer),
  )
  assert.equal(missingUpdateErr.code, 'NOT_FOUND')
  assert.deepEqual(ownerUpdateFromV1, missingUpdateErr)
  assert.deepEqual(ownerRemoveFromV1, missingRemoveErr)

  const subjectUpdateFromV2 = await captureBrainError(() =>
    h.kernel.memory.service.update(ids.subject, { status: 'outdated' }, 1, KERNEL_WRITE, v2Viewer),
  )
  const subjectRemoveFromV2 = await captureBrainError(() =>
    h.kernel.memory.service.remove(ids.subject, KERNEL_WRITE, v2Viewer),
  )
  assert.deepEqual(subjectUpdateFromV2, missingUpdateErr)
  assert.deepEqual(subjectRemoveFromV2, missingRemoveErr)

  // Verify original records were not modified at all
  const ownerBefore = await h.kernel.memory.store.get(ids.owner)
  const subjectBefore = await h.kernel.memory.store.get(ids.subject)
  assert.equal(ownerBefore?.version, 1)
  assert.equal(ownerBefore?.status, 'active')
  assert.equal(subjectBefore?.version, 1)
  assert.equal(subjectBefore?.status, 'active')

  // HTTP PATCH / DELETE / Console GET: missing ID vs tombstoned (invisible) record must match byte-for-byte
  await h.kernel.memory.service.forget({ by: 'record', id: ids.origin })

  const normalizeErr = (env: Envelope<unknown>) => {
    assert.equal(env.ok, false)
    if (env.ok) throw new Error('unreachable')
    return env.error
  }

  const missingPatch = await httpJson<Envelope<unknown>>(h.kernel.port, 'PATCH', `/api/v1/memory/records/${MISSING_ID}`, {
    token: h.token,
    headers: { 'if-match': '1' },
    body: { status: 'outdated' },
  })
  const tombstonedPatch = await httpJson<Envelope<unknown>>(h.kernel.port, 'PATCH', `/api/v1/memory/records/${ids.origin}`, {
    token: h.token,
    headers: { 'if-match': '1' },
    body: { status: 'outdated' },
  })
  assert.equal(missingPatch.status, 404)
  assert.equal(tombstonedPatch.status, 404)
  assert.deepEqual(normalizeErr(tombstonedPatch.body), normalizeErr(missingPatch.body))

  const missingDelete = await httpJson<Envelope<unknown>>(h.kernel.port, 'DELETE', `/api/v1/memory/records/${MISSING_ID}`, {
    token: h.token,
  })
  const tombstonedDelete = await httpJson<Envelope<unknown>>(h.kernel.port, 'DELETE', `/api/v1/memory/records/${ids.origin}`, {
    token: h.token,
  })
  assert.equal(missingDelete.status, 404)
  assert.equal(tombstonedDelete.status, 404)
  assert.deepEqual(normalizeErr(tombstonedDelete.body), normalizeErr(missingDelete.body))

  const missingConsole = await httpJson<Envelope<unknown>>(h.consolePort!, 'GET', `/api/v1/console/memory/records/${MISSING_ID}`, {
    token: h.token,
  })
  assert.equal(missingConsole.status, 404)
  assert.equal(normalizeErr(missingConsole.body).code, 'NOT_FOUND')

  const tombstonedConsole = await httpJson<Envelope<MemoryRecord>>(h.consolePort!, 'GET', `/api/v1/console/memory/records/${ids.origin}`, {
    token: h.token,
  })
  assert.equal(tombstonedConsole.status, 200)
  const tombstonedRecord = assertUnwrappedOk(tombstonedConsole.body)
  assert.equal(tombstonedRecord.status, 'tombstoned')
  assert.deepEqual(tombstonedRecord.content, {})
})
