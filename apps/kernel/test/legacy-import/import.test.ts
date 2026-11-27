import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { BrainError, type MemoryRecord } from '@dsh-brain-core/sdk'
import { createIdentityService, createProfileStore } from '../../src/identity-persona/index.ts'
import { createLegacyImporter } from '../../src/legacy-import/index.ts'
import { createKeywordIndex } from '../../src/memory-search/index.ts'
import { createSqliteRecordStore } from '../../src/memory-store/index.ts'
import { FakeClock } from '../fakes/index.ts'

async function collectFileHashes(rootDir: string, currentDir = rootDir, out = new Map<string, string>()): Promise<Map<string, string>> {
  const entries = await readdir(currentDir, { withFileTypes: true })
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      await collectFileHashes(rootDir, fullPath, out)
    } else if (entry.isFile()) {
      const content = await readFile(fullPath)
      const relPath = path.relative(rootDir, fullPath).split(path.sep).join('/')
      out.set(relPath, createHash('sha256').update(content).digest('hex'))
    }
  }
  return out
}

async function expectBrainError(fn: () => Promise<unknown>, expectedCode: string): Promise<void> {
  await assert.rejects(fn, (error: unknown) => {
    assert.ok(error instanceof BrainError, `expected BrainError, got ${String(error)}`)
    assert.equal(error.code, expectedCode)
    return true
  })
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf8')
}

async function tryFileSymlink(target: string, linkPath: string): Promise<boolean> {
  try {
    await symlink(target, linkPath, 'file')
    return true
  } catch (error) {
    if (process.platform === 'win32' && error instanceof Error && 'code' in error && error.code === 'EPERM') {
      return false
    }
    throw error
  }
}

async function createRichLegacyFixture(fromDir: string): Promise<void> {
  // 1. Chat archives (private_10001 and group_20002)
  const privateArchive = path.join(fromDir, 'long-memory', 'archive', 'private_10001', '2026-01.jsonl')
  await mkdir(path.dirname(privateArchive), { recursive: true })
  const privateLines = [
    JSON.stringify({ t: '2026-01-10T10:00:00.000Z', dir: 'in', userId: '10001', name: 'Alice', text: '我喜欢喝乌龙茶', msgId: 'm1' }),
    '',
    JSON.stringify({ t: '2026-01-10T10:05:00.000Z', dir: 'out', userId: null, text: '记住啦，下次请你喝乌龙茶', msgId: 102 }),
    JSON.stringify({ t: '2026-01-10T10:06:00.000Z', dir: 'in', userId: null, text: '已删除的消息', tombstoned: true }),
    JSON.stringify({ t: '2026-01-10T10:07:00.000Z', dir: 'in', userId: null, text: '   ' }),
    '{bad json line',
    JSON.stringify({ t: 'not-a-date', dir: 'in', userId: '10001', text: 'bad timestamp' }),
    JSON.stringify({ t: '2026-01-10T10:10:00.000Z', dir: 'in', userId: null, text: '私聊无userId也应解析到对方' }),
  ]
  await writeFile(privateArchive, privateLines.join('\n') + '\n', 'utf8')

  const groupArchive = path.join(fromDir, 'long-memory', 'archive', 'group_20002', '2026-01.jsonl')
  await mkdir(path.dirname(groupArchive), { recursive: true })
  const groupLines = [
    // Two messages near 2026-01-12T12:00:00Z: one from qq:30003 (closer in time), one from qq:10001 (same actor!)
    JSON.stringify({ t: '2026-01-12T12:00:00.000Z', dir: 'in', userId: '30003', name: 'Bob', text: '群里大家中午好' }),
    JSON.stringify({ t: '2026-01-12T11:30:00.000Z', dir: 'in', userId: '10001', name: 'Alice', text: '周末去爬香山' }),
    JSON.stringify({ t: '2026-01-12T12:05:00.000Z', dir: 'in', userId: null, text: '群聊匿名消息' }),
    JSON.stringify({ t: '2026-01-12T12:06:00.000Z', dir: 'out', userId: null, text: '好的大家周末见' }),
  ]
  await writeFile(groupArchive, groupLines.join('\n') + '\n', 'utf8')

  // 2. People ledger with 20 diverse items across categories/scopes/statuses
  const aliceItems = [
    { id: 'a1', cat: 'trait', text: '性格开朗且准时', at: '2026-01-10T10:02:00.000Z', sourceKey: 'private:10001', scope: 'private', core: true },
    { id: 'a2', cat: 'fact', text: '喜欢乌龙茶', at: '2026-01-10T10:01:00.000Z', sourceKey: 'private:10001', scope: 'public' },
    { id: 'a3', cat: 'event', text: '约定周末爬香山', at: '2026-01-12T12:00:00.000Z', sourceKey: 'group:20002', scope: 'public' },
    { id: 'a4', cat: 'pending', text: '借给她的书下周归还', at: '2026-01-15T09:00:00.000Z', sourceKey: 'private:10001', scope: 'private', due: '2026-01-22', by: 'them', status: 'open' },
    { id: 'a5', cat: 'note', text: '旧住址在海淀区', at: '2025-05-01T00:00:00.000Z', sourceKey: 'private:10001', scope: 'private', outdatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'a6', cat: 'fact', text: '曾经参加过吉他社', at: '2025-06-01T00:00:00.000Z', sourceKey: 'private:99999', scope: 'public', archivedAt: '2025-12-01T00:00:00.000Z' },
    { id: 'a7', cat: 'trait', text: '对猫毛轻微过敏', at: '2026-01-10T11:00:00.000Z', sourceKey: 'private:10001', scope: 'private', core: true },
    { id: 'a8', cat: 'event', text: '去年冬天去过哈尔滨', at: '2025-12-20T00:00:00.000Z', scope: 'public' },
    { id: 'a9', cat: 'pending', text: '帮忙整理照片集', at: '2026-01-10T12:00:00.000Z', sourceKey: 'private:10001', scope: 'public', due: '2026-02-01', by: 'me', status: 'pending' },
    { id: 'a10', cat: 'note', text: '无 id 的便签条目测试', at: '2026-01-10T12:30:00.000Z', sourceKey: 'private:10001', scope: 'private' },
    { id: 'a11', cat: 'fact', text: '   ' }, // should be skipped
  ]
  const bobItems = [
    { id: 'b1', cat: 'trait', text: '回复消息很快', at: '2026-01-12T12:01:00.000Z', sourceKey: 'group:20002', scope: 'public' },
    { id: 'b2', cat: 'fact', text: '在杭州工作', at: '2025-08-01T00:00:00.000Z', sourceKey: 'group:20002', scope: 'public' },
    { id: 'b3', cat: 'event', text: '参加技术分享会', at: '2026-01-12T13:00:00.000Z', sourceKey: 'group:20002', scope: 'private' },
    { id: 'b4', cat: 'pending', text: '发开源项目链接给我', at: '2026-01-12T14:00:00.000Z', sourceKey: 'group:20002', scope: 'public', by: 'them', status: 'open' },
    { id: 'b5', cat: 'note', text: '偏好深色主题编辑器', at: '2025-09-10T08:00:00.000Z', sourceKey: 'private:30003', scope: 'private', core: true },
    { id: 'b6', cat: 'fact', text: '养了一只柯基犬', at: '2025-10-01T08:00:00.000Z', sourceKey: 'private:30003', scope: 'public' },
    { id: 'b7', cat: 'event', text: '旧公司团建去青岛', at: '2024-07-01T00:00:00.000Z', sourceKey: 'group:20002', scope: 'public', archivedAt: '2025-01-01T00:00:00.000Z' },
    { id: 'b8', cat: 'trait', text: '喜欢研究咖啡手冲', at: '2025-11-11T10:00:00.000Z', sourceKey: 'private:30003', scope: 'public' },
    { id: 'b9', cat: 'pending', text: '月底一起吃火锅', at: '2025-12-01T10:00:00.000Z', sourceKey: 'group:88888', scope: 'private', outdatedAt: '2026-01-05T00:00:00.000Z' },
    { id: 'b10', cat: 'note', text: '周三晚上固定踢球', at: '2026-01-12T15:00:00.000Z', sourceKey: 'group:20002', scope: 'public' },
  ]
  await writeJson(path.join(fromDir, 'long-memory', 'people.json'), {
    version: 2,
    people: {
      '10001': { name: 'Alice', items: aliceItems },
      '30003': { name: 'Bob', items: bobItems },
    },
  })

  // 3. Persona directory (single role `sakura`)
  await writeJson(path.join(fromDir, 'persona', 'sakura', 'core.json'), {
    version: 2,
    character: { name: 'Sakura', tone: 'warm' },
    traits: ['curious', 'gentle'],
    manifests: { greeting: '早安呀' },
    prefs: { tea: 'oolong' },
    beliefs: [
      { id: 'bel-1', text: '真诚交流最重要', status: 'accepted' },
      { id: 'bel-2', text: '待确认的不成熟想法', status: 'pending' },
      { id: 'bel-3', text: '已否决的信念', status: 'rejected' },
    ],
  })
  await writeJson(path.join(fromDir, 'persona', 'sakura', 'people.json'), {
    '10001': {
      name: 'Alice',
      nickname: '小艾',
      intimacy: 0.85,
      trust: 0.9,
      familiarity: 0.8,
      offsets: { formality: -0.2 },
      beliefs: ['值得信赖的朋友'],
      jokes: ['乌龙茶梗'],
    },
    '40004': {
      name: 'Charlie',
      nickname: '小查',
      intimacy: 0.4,
      trust: 0.5,
      familiarity: 0.3,
      offsets: { humor: 0.1 },
      beliefs: [],
      jokes: [],
    },
  })
}

async function setupEnv(baseDir: string, nowMs = 1_768_500_000_000) {
  const clock = new FakeClock(nowMs)
  const store = await createSqliteRecordStore({ path: path.join(baseDir, 'memory.db'), clock })
  const index = await createKeywordIndex({ path: path.join(baseDir, 'search.db') })
  const identity = await createIdentityService({ path: path.join(baseDir, 'identity.json'), clock })
  const profiles = createProfileStore({ store, clock })
  const choiceFile = path.join(baseDir, 'memory', 'import-choice.json')
  const importer = createLegacyImporter({ store, index, identity, profiles, clock, choiceFile })
  return { clock, store, index, identity, profiles, choiceFile, importer }
}

test('parameter validation and fresh mode behavior', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'brain-legacy-fresh-'))
  try {
    const fromDir = path.join(workDir, 'legacy')
    await mkdir(fromDir, { recursive: true })
    const stateDir = path.join(workDir, 'state')
    const env = await setupEnv(stateDir)
    try {
      await expectBrainError(
        () => env.importer.importFrom({ fromDir, mode: undefined as unknown as 'all' }),
        'INVALID_ARGUMENT',
      )
      await expectBrainError(
        () => env.importer.importFrom({ fromDir, mode: 'invalid' as 'all' }),
        'INVALID_ARGUMENT',
      )
      await expectBrainError(
        () => env.importer.importFrom({ fromDir: '   ', mode: 'fresh' }),
        'INVALID_ARGUMENT',
      )
      await expectBrainError(
        () => env.importer.importFrom({ fromDir: path.join(workDir, 'missing'), mode: 'all' }),
        'NOT_FOUND',
      )

      const fileAsFromDir = path.join(workDir, 'not-a-dir.txt')
      await writeFile(fileAsFromDir, 'hello', 'utf8')
      await expectBrainError(
        () => env.importer.importFrom({ fromDir: fileAsFromDir, mode: 'memory' }),
        'INVALID_ARGUMENT',
      )

      // fresh dryRun should not write choiceFile
      const dryReport = await env.importer.importFrom({ fromDir, mode: 'fresh', dryRun: true })
      assert.equal(dryReport.mode, 'fresh')
      assert.equal(dryReport.dryRun, true)
      assert.equal(existsSync(env.choiceFile), false)

      // fresh real run writes choiceFile (0600) and zero memory records
      const report = await env.importer.importFrom({ fromDir, mode: 'fresh' })
      assert.deepEqual(report, {
        mode: 'fresh',
        dryRun: false,
        l0Imported: 0,
        l0Skipped: 0,
        l1Imported: 0,
        l1Skipped: 0,
        l3SelfCommitted: false,
        l3PersonsImported: 0,
        anchorRecordsCreated: 0,
      })

      const choiceRaw = await readFile(env.choiceFile, 'utf8')
      const choiceJson = JSON.parse(choiceRaw) as Record<string, unknown>
      assert.equal(choiceJson.version, 1)
      assert.equal(choiceJson.mode, 'fresh')
      assert.equal(choiceJson.fromDir, fromDir)
      assert.equal(choiceJson.chosenAt, env.clock.now())
      if (process.platform !== 'win32') {
        const st = await stat(env.choiceFile)
        assert.equal(st.mode & 0o777, 0o600)
      }

      const allRecords: MemoryRecord[] = []
      for await (const rec of env.store.scan()) allRecords.push(rec)
      assert.equal(allRecords.length, 0)
    } finally {
      await env.index.close()
      await env.store.close()
    }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
})

test('memory mode imports L0 and L1 without touching L3, and leaves source SHA-256 identical', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'brain-legacy-memory-'))
  try {
    const fromDir = path.join(workDir, 'legacy')
    await createRichLegacyFixture(fromDir)
    const beforeHashes = await collectFileHashes(fromDir)

    const env = await setupEnv(path.join(workDir, 'state'))
    try {
      // Dry run first: zero writes anywhere
      const dryReport = await env.importer.importFrom({ fromDir, mode: 'memory', dryRun: true })
      assert.equal(dryReport.mode, 'memory')
      assert.equal(dryReport.dryRun, true)
      assert.equal(dryReport.l0Imported, 7) // 3 valid private + 4 valid group
      assert.equal(dryReport.l0Skipped, 4) // tombstone, blank text, bad json, bad timestamp
      assert.equal(dryReport.l1Imported, 20)
      assert.equal(dryReport.l1Skipped, 1)
      assert.equal(dryReport.l3SelfCommitted, false)
      assert.equal(dryReport.l3PersonsImported, 0)
      assert.ok(dryReport.anchorRecordsCreated >= 3)

      const emptyAfterDry: MemoryRecord[] = []
      for await (const rec of env.store.scan()) emptyAfterDry.push(rec)
      assert.equal(emptyAfterDry.length, 0)
      assert.equal(existsSync(path.join(workDir, 'state', 'identity.json')), false)

      // Real memory mode import
      const report = await env.importer.importFrom({ fromDir, mode: 'memory' })
      assert.equal(report.mode, 'memory')
      assert.equal(report.dryRun, false)
      assert.equal(report.l0Imported, 7)
      assert.equal(report.l0Skipped, 4)
      assert.equal(report.l1Imported, 20)
      assert.equal(report.l1Skipped, 1)
      assert.equal(report.l3SelfCommitted, false)
      assert.equal(report.l3PersonsImported, 0)
      assert.equal(report.anchorRecordsCreated, dryReport.anchorRecordsCreated)

      assert.equal((await env.profiles.list()).length, 0)
      const l3Records: MemoryRecord[] = []
      for await (const rec of env.store.scan(['L3'])) l3Records.push(rec)
      assert.equal(l3Records.length, 0)

      const afterHashes = await collectFileHashes(fromDir)
      assert.deepEqual(afterHashes, beforeHashes)
    } finally {
      await env.index.close()
      await env.store.close()
    }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
})

test('all mode: full L0/L1/L3.1/L3.2 import, M1 evidence chain, 20 ledger spot-checks, idempotency & SHA-256 invariance', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'brain-legacy-all-'))
  try {
    const fromDir = path.join(workDir, 'legacy')
    await createRichLegacyFixture(fromDir)
    const beforeHashes = await collectFileHashes(fromDir)

    const env = await setupEnv(path.join(workDir, 'state'))
    try {
      const report1 = await env.importer.importFrom({ fromDir, mode: 'all' })
      assert.equal(report1.mode, 'all')
      assert.equal(report1.dryRun, false)
      assert.equal(report1.l0Imported, 7)
      assert.equal(report1.l0Skipped, 4)
      assert.equal(report1.l1Imported, 20)
      assert.equal(report1.l1Skipped, 1)
      assert.equal(report1.l3SelfCommitted, true)
      assert.equal(report1.l3PersonsImported, 2)
      assert.ok(report1.anchorRecordsCreated >= 4) // ledger channel anchors + persona anchor

      // Verify L3.1 profile: accepted beliefs only!
      const versions = await env.profiles.list()
      assert.equal(versions.length, 1)
      assert.equal(versions[0]!.author, 'owner')
      const detail = await env.profiles.getVersion(1)
      assert.ok(detail.stable.includes('真诚交流最重要'))
      assert.equal(detail.stable.includes('待确认的不成熟想法'), false)
      assert.equal(detail.stable.includes('已否决的信念'), false)
      assert.deepEqual(
        (detail.data.beliefs as Array<{ readonly text: string }>).map((b) => b.text),
        ['真诚交流最重要'],
      )
      assert.ok(typeof detail.data.legacyImportHash === 'string' && detail.data.legacyImportHash.length === 64)

      // Verify L3.2 l3.person records
      const l3Persons: MemoryRecord[] = []
      for await (const rec of env.store.scan(['L3'])) {
        if (rec.kind === 'l3.person') l3Persons.push(rec)
      }
      assert.equal(l3Persons.length, 2)
      const aliceId = await env.identity.resolve('qq:10001')
      const charlieId = await env.identity.resolve('qq:40004')
      const aliceL3 = l3Persons.find((r) => r.subjects.includes(aliceId))
      const charlieL3 = l3Persons.find((r) => r.subjects.includes(charlieId))
      assert.ok(aliceL3 !== undefined)
      assert.ok(charlieL3 !== undefined)
      assert.equal((aliceL3.content.identity as Record<string, { value: unknown }>).nickname?.value, '小艾')
      assert.equal((aliceL3.content.relationships as Record<string, { value: unknown }>).intimacy?.value, 0.85)
      assert.deepEqual((aliceL3.content.preferences as Record<string, { value: unknown }>).jokes?.value, ['乌龙茶梗'])
      // Alice has L1 records, so her l3.person evidence must prefer her L1 records over the L0 anchor!
      assert.ok(aliceL3.evidence.length >= 1)
      for (const ref of aliceL3.evidence) {
        const ev = await env.store.get(ref.id)
        assert.equal(ev?.layer, 'L1')
        assert.ok(ev?.subjects.includes(aliceId))
      }
      // Charlie had no L1 items, so his evidence must point to the persona L0 anchor!
      const charlieEvidence = await env.store.get(charlieL3.evidence[0]!.id)
      assert.equal(charlieEvidence?.kind, 'legacy.persona_snapshot')

      // Collect all L0 and L1 records for M1 & 20-item spot checks
      const allL0 = new Map<string, MemoryRecord>()
      const allL1: MemoryRecord[] = []
      for await (const rec of env.store.scan(['L0', 'L1'])) {
        if (rec.layer === 'L0') allL0.set(rec.id, rec)
        else allL1.push(rec)
      }
      assert.equal(allL1.length, 20)

      // M1 invariant check on every L1 & L3 record
      const allRecords: MemoryRecord[] = []
      for await (const rec of env.store.scan()) allRecords.push(rec)
      for (const rec of allRecords) {
        if (rec.layer === 'L0') {
          assert.equal(rec.evidence.length, 0)
        } else {
          assert.ok(rec.evidence.length >= 1, `record ${rec.id} missing M1 evidence`)
          for (const ref of rec.evidence) {
            const target = await env.store.get(ref.id)
            assert.ok(target !== null && target.status !== 'tombstoned')
            assert.notEqual(target.layer, rec.layer)
          }
        }
      }

      // Check M1 matching logic specifically:
      // `a3` (group:20002 at 12:00 for Alice qq:10001) must prefer Alice's 11:30 L0 over Bob's 12:00 L0!
      const byLegacyId = new Map<string, MemoryRecord>()
      for (const rec of allL1) {
        const lid = rec.content.legacyId
        if (typeof lid === 'string') byLegacyId.set(lid, rec)
      }
      const a3 = byLegacyId.get('a3')!
      const a3Evidence = allL0.get(a3.evidence[0]!.id)!
      assert.equal(a3Evidence.kind, 'qq.message')
      assert.equal(a3Evidence.actor, aliceId)

      // `a5` (2025-05-01, far outside 24h) must point to legacy.ledger_snapshot anchor
      const a5 = byLegacyId.get('a5')!
      const a5Evidence = allL0.get(a5.evidence[0]!.id)!
      assert.equal(a5Evidence.kind, 'legacy.ledger_snapshot')
      assert.equal(a5Evidence.visibility, 'owner')
      assert.equal(a5Evidence.trust, 'owner')

      // Spot-check all 20 ledger items: kind, visibility, status, channel, content, importance
      const expectedSpecs: ReadonlyArray<{
        readonly legacyId?: string
        readonly text: string
        readonly kind: string
        readonly visibility: string
        readonly status: string
        readonly channel: string
        readonly importance: number
      }> = [
        { legacyId: 'a1', text: '性格开朗且准时', kind: 'l1.fact', visibility: 'origin', status: 'active', channel: 'qq:private:10001', importance: 0.9 },
        { legacyId: 'a2', text: '喜欢乌龙茶', kind: 'l1.fact', visibility: 'open', status: 'active', channel: 'qq:private:10001', importance: 0.6 },
        { legacyId: 'a3', text: '约定周末爬香山', kind: 'l1.event', visibility: 'open', status: 'active', channel: 'qq:group:20002', importance: 0.6 },
        { legacyId: 'a4', text: '借给她的书下周归还', kind: 'l1.promise', visibility: 'origin', status: 'active', channel: 'qq:private:10001', importance: 0.6 },
        { legacyId: 'a5', text: '旧住址在海淀区', kind: 'l1.fact', visibility: 'origin', status: 'outdated', channel: 'qq:private:10001', importance: 0.6 },
        { legacyId: 'a6', text: '曾经参加过吉他社', kind: 'l1.fact', visibility: 'open', status: 'archived', channel: 'qq:private:99999', importance: 0.6 },
        { legacyId: 'a7', text: '对猫毛轻微过敏', kind: 'l1.fact', visibility: 'origin', status: 'active', channel: 'qq:private:10001', importance: 0.9 },
        { legacyId: 'a8', text: '去年冬天去过哈尔滨', kind: 'l1.event', visibility: 'open', status: 'active', channel: 'qq:private:10001', importance: 0.6 },
        { legacyId: 'a9', text: '帮忙整理照片集', kind: 'l1.promise', visibility: 'open', status: 'active', channel: 'qq:private:10001', importance: 0.6 },
        { text: '无 id 的便签条目测试', kind: 'l1.fact', visibility: 'origin', status: 'active', channel: 'qq:private:10001', importance: 0.6 },
        { legacyId: 'b1', text: '回复消息很快', kind: 'l1.fact', visibility: 'open', status: 'active', channel: 'qq:group:20002', importance: 0.6 },
        { legacyId: 'b2', text: '在杭州工作', kind: 'l1.fact', visibility: 'open', status: 'active', channel: 'qq:group:20002', importance: 0.6 },
        { legacyId: 'b3', text: '参加技术分享会', kind: 'l1.event', visibility: 'origin', status: 'active', channel: 'qq:group:20002', importance: 0.6 },
        { legacyId: 'b4', text: '发开源项目链接给我', kind: 'l1.promise', visibility: 'open', status: 'active', channel: 'qq:group:20002', importance: 0.6 },
        { legacyId: 'b5', text: '偏好深色主题编辑器', kind: 'l1.fact', visibility: 'origin', status: 'active', channel: 'qq:private:30003', importance: 0.9 },
        { legacyId: 'b6', text: '养了一只柯基犬', kind: 'l1.fact', visibility: 'open', status: 'active', channel: 'qq:private:30003', importance: 0.6 },
        { legacyId: 'b7', text: '旧公司团建去青岛', kind: 'l1.event', visibility: 'open', status: 'archived', channel: 'qq:group:20002', importance: 0.6 },
        { legacyId: 'b8', text: '喜欢研究咖啡手冲', kind: 'l1.fact', visibility: 'open', status: 'active', channel: 'qq:private:30003', importance: 0.6 },
        { legacyId: 'b9', text: '月底一起吃火锅', kind: 'l1.promise', visibility: 'origin', status: 'outdated', channel: 'qq:group:88888', importance: 0.6 },
        { legacyId: 'b10', text: '周三晚上固定踢球', kind: 'l1.fact', visibility: 'open', status: 'active', channel: 'qq:group:20002', importance: 0.6 },
      ]
      assert.equal(expectedSpecs.length, 20)
      for (const spec of expectedSpecs) {
        const matched = spec.legacyId !== undefined
          ? byLegacyId.get(spec.legacyId)
          : allL1.find((r) => r.content.text === spec.text)
        assert.ok(matched !== undefined, `missing L1 item ${spec.legacyId ?? spec.text}`)
        assert.equal(matched.content.text, spec.text)
        assert.equal(matched.content.legacy, true)
        assert.equal(matched.kind, spec.kind)
        assert.equal(matched.visibility, spec.visibility)
        assert.equal(matched.status, spec.status)
        assert.equal(matched.channel, spec.channel)
        assert.equal(matched.importance, spec.importance)
      }

      // Outdated/archived L1 items must NOT remain in KeywordIndex
      const outdatedHits = await env.index.search({ text: '旧住址在海淀区', limit: 5 })
      assert.equal(outdatedHits.length, 0)
      const activeHits = await env.index.search({ text: '喜欢乌龙茶', limit: 5 })
      assert.ok(activeHits.length >= 1)

      // Check L0 metadata & legacy flags
      const groupMsgs = [...allL0.values()].filter((r) => r.kind === 'qq.message' && r.channel === 'qq:group:20002')
      assert.equal(groupMsgs.length, 4)
      assert.ok(groupMsgs.some((r) => r.actor === 'qq:unknown' && r.visibility === 'open'))
      assert.ok(groupMsgs.some((r) => r.actor === 'self' && r.trust === 'self' && r.content.direction === 'outbound'))
      const privateMsgs = [...allL0.values()].filter((r) => r.kind === 'qq.message' && r.channel === 'qq:private:10001')
      assert.equal(privateMsgs.length, 3)
      for (const rec of privateMsgs) {
        assert.equal(rec.visibility, 'subject')
        assert.equal(rec.content.legacy, true)
        assert.ok(rec.subjects.includes(aliceId))
      }

      // Idempotent second run (with frozen clock AND fresh importer instance!)
      const countBefore = allRecords.length
      const secondImporter = createLegacyImporter({
        store: env.store,
        index: env.index,
        identity: env.identity,
        profiles: env.profiles,
        clock: env.clock,
        choiceFile: env.choiceFile,
      })
      const report2 = await secondImporter.importFrom({ fromDir, mode: 'all' })
      assert.equal(report2.l0Imported, 0)
      assert.equal(report2.l1Imported, 0)
      assert.equal(report2.l3SelfCommitted, false)
      assert.equal(report2.l3PersonsImported, 0)
      assert.equal(report2.anchorRecordsCreated, 0)

      const recordsAfter: MemoryRecord[] = []
      for await (const rec of env.store.scan()) recordsAfter.push(rec)
      assert.equal(recordsAfter.length, countBefore)
      assert.equal((await env.profiles.list()).length, 1)

      const afterHashes = await collectFileHashes(fromDir)
      assert.deepEqual(afterHashes, beforeHashes)
    } finally {
      await env.index.close()
      await env.store.close()
    }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
})

test('multi-role selection, malformed JSON errors, and symlink escape protection', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'brain-legacy-roles-'))
  try {
    const fromDir = path.join(workDir, 'legacy')
    await writeJson(path.join(fromDir, 'persona', 'alpha', 'core.json'), {
      character: { name: 'Alpha' },
      beliefs: [{ text: 'Alpha belief', status: 'accepted' }],
    })
    await writeJson(path.join(fromDir, 'persona', 'beta', 'core.json'), {
      character: { name: 'Beta' },
      beliefs: [{ text: 'Beta belief', status: 'accepted' }],
    })

    // Add a symlink inside archive attempting to escape to an outside file
    const outsideFile = path.join(workDir, 'secret.jsonl')
    await writeFile(outsideFile, JSON.stringify({ t: '2026-01-01T00:00:00Z', dir: 'in', userId: '1', text: 'secret' }) + '\n', 'utf8')
    const symlinkChannelDir = path.join(fromDir, 'long-memory', 'archive', 'private_55555')
    await mkdir(symlinkChannelDir, { recursive: true })
    await tryFileSymlink(outsideFile, path.join(symlinkChannelDir, '2026-01.jsonl'))

    const env = await setupEnv(path.join(workDir, 'state'))
    try {
      // Multiple roles without --role -> INVALID_ARGUMENT
      await expectBrainError(
        () => env.importer.importFrom({ fromDir, mode: 'all' }),
        'INVALID_ARGUMENT',
      )
      // Non-existent --role -> NOT_FOUND
      await expectBrainError(
        () => env.importer.importFrom({ fromDir, mode: 'all', role: 'gamma' }),
        'NOT_FOUND',
      )
      // Path traversal --role -> INVALID_ARGUMENT
      await expectBrainError(
        () => env.importer.importFrom({ fromDir, mode: 'all', role: '../alpha' }),
        'INVALID_ARGUMENT',
      )

      // Explicit role 'beta' succeeds and ignores symlinked archive file
      const report = await env.importer.importFrom({ fromDir, mode: 'all', role: 'beta' })
      assert.equal(report.l0Imported, 0)
      assert.equal(report.l3SelfCommitted, true)
      const detail = await env.profiles.getVersion(1)
      assert.ok(detail.stable.includes('Beta'))
      assert.equal(detail.stable.includes('Alpha'), false)

      // Malformed people.json -> INVALID_ARGUMENT
      const badDir = path.join(workDir, 'bad-legacy')
      await mkdir(path.join(badDir, 'long-memory'), { recursive: true })
      await writeFile(path.join(badDir, 'long-memory', 'people.json'), '{not valid json', 'utf8')
      await expectBrainError(
        () => env.importer.importFrom({ fromDir: badDir, mode: 'memory' }),
        'INVALID_ARGUMENT',
      )
    } finally {
      await env.index.close()
      await env.store.close()
    }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
})

test('24h M1 boundary, pre-existing store L0 matching, people-only persona, and dryRun all-mode', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'brain-legacy-edge-'))
  try {
    const fromDir = path.join(workDir, 'legacy')
    const baseMs = Date.UTC(2026, 2, 1, 12, 0, 0)
    const env = await setupEnv(path.join(workDir, 'state'), baseMs + 5_000)

    try {
      // Invalid options object
      await expectBrainError(
        () => env.importer.importFrom(null as unknown as { fromDir: string; mode: 'fresh' }),
        'INVALID_ARGUMENT',
      )

      // fresh mode succeeds even if fromDir does not exist on disk
      const freshNoDir = await env.importer.importFrom({
        fromDir: path.join(workDir, 'non-existent-for-fresh'),
        mode: 'fresh',
      })
      assert.equal(freshNoDir.mode, 'fresh')

      // Pre-populate an L0 record in store on qq:private:70007
      const peer70007 = await env.identity.resolve('qq:70007')
      const preL0 = await env.store.insert({
        layer: 'L0',
        kind: 'qq.message',
        source: 'qq',
        channel: 'qq:private:70007',
        subjects: [peer70007],
        actor: peer70007,
        content: { text: '预先存在的L0消息' },
        evidence: [],
        visibility: 'subject',
        trust: 'member',
        confidence: 1,
        importance: 0.5,
        tEvent: baseMs,
      })

      // Invalid subdir + non-jsonl + array JSON line in archive
      await mkdir(path.join(fromDir, 'long-memory', 'archive', 'ignored_dir'), { recursive: true })
      await mkdir(path.join(fromDir, 'long-memory', 'archive', 'private_70007'), { recursive: true })
      await writeFile(path.join(fromDir, 'long-memory', 'archive', 'private_70007', 'readme.txt'), 'skip', 'utf8')
      await writeFile(
        path.join(fromDir, 'long-memory', 'archive', 'private_70007', '2026-03.jsonl'),
        [
          JSON.stringify(['not-an-object']),
          JSON.stringify({ t: new Date(baseMs + 1000).toISOString(), dir: 'out', text: '私聊回复', msgId: 'out-1' }),
        ].join('\n'),
        'utf8',
      )

      // Ledger items testing exact 24h boundary (86_400_000ms matches preL0/new L0; 86_400_001ms forces anchor),
      // numeric `at`, missing `at` fallback to clock.now(), invalid sourceKey fallback, outdated+archived precedence.
      await writeJson(path.join(fromDir, 'long-memory', 'people.json'), {
        version: 1,
        people: {
          '70007': {
            items: [
              { id: 'exact-24h', cat: 'fact', text: '恰好24小时内', at: baseMs - 86_400_000, sourceKey: 'private:70007' },
              { id: 'over-24h', cat: 'fact', text: '超过24小时1毫秒', at: baseMs - 86_400_001, sourceKey: 'bad:key', outdatedAt: baseMs - 1000, archivedAt: baseMs - 500 },
              { id: 'no-at', cat: 'note', text: '缺少时间戳回退到clock' },
            ],
          },
        },
      })

      // Persona with ONLY people.json (no core.json) and nested { people: { ... } } shape
      await writeJson(path.join(fromDir, 'persona', 'solo', 'people.json'), {
        people: {
          '70007': { name: 'Seven', intimacy: 0.7 },
          '80008': { name: 'Eight', intimacy: 0.2 },
        },
      })

      // Dry-run in `all` mode writes nothing
      const dryAll = await env.importer.importFrom({ fromDir, mode: 'all', dryRun: true })
      assert.equal(dryAll.l0Imported, 1)
      assert.equal(dryAll.l0Skipped, 1)
      assert.equal(dryAll.l1Imported, 3)
      assert.equal(dryAll.l3SelfCommitted, false)
      assert.equal(dryAll.l3PersonsImported, 2)
      assert.equal((await env.store.list({ layers: ['L1', 'L3'] }, { limit: 100 })).items.length, 0)

      // Real run in `all` mode
      const realAll = await env.importer.importFrom({ fromDir, mode: 'all' })
      assert.equal(realAll.l0Imported, 1)
      assert.equal(realAll.l0Skipped, 1)
      assert.equal(realAll.l1Imported, 3)
      assert.equal(realAll.l3SelfCommitted, false)
      assert.equal(realAll.l3PersonsImported, 2)
      // 1 ledger anchor (for over-24h) + 1 persona anchor (for 80008 who has no L1)
      assert.equal(realAll.anchorRecordsCreated, 2)

      const l1Items = (await env.store.list({ layers: ['L1'] }, { limit: 100 })).items
      const exact24 = l1Items.find((r) => r.content.legacyId === 'exact-24h')!
      assert.equal(exact24.evidence[0]!.id, preL0.id)
      const over24 = l1Items.find((r) => r.content.legacyId === 'over-24h')!
      assert.equal(over24.channel, 'qq:private:70007')
      assert.equal(over24.status, 'outdated')
      assert.equal(over24.validTo, baseMs - 1000)
      assert.equal((await env.store.get(over24.evidence[0]!.id))?.kind, 'legacy.ledger_snapshot')
      const noAt = l1Items.find((r) => r.content.legacyId === 'no-at')!
      assert.equal(noAt.tEvent, env.clock.now())

      // Verify private outbound L0 subjects include ['self', peer70007]
      const l0Items = (await env.store.list({ layers: ['L0'], kinds: ['qq.message'] }, { limit: 100 })).items
      const outbound = l0Items.find((r) => r.actor === 'self')!
      assert.deepEqual(outbound.subjects, ['self', peer70007])
      assert.equal(outbound.content.msgId, 'out-1')
    } finally {
      await env.index.close()
      await env.store.close()
    }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
})

test('readRegularFileIfExists rejects symlinked ledger/persona files and L1 evidence ignores pre-existing anchor L0s', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'brain-legacy-anchor-symlink-'))
  try {
    const baseMs = Date.UTC(2026, 3, 1, 10, 0, 0)
    const env = await setupEnv(path.join(workDir, 'state'), baseMs + 1000)

    try {
      // 1. Direct file symlinks (people.json and core.json) must be safely ignored by readRegularFileIfExists
      const outsidePeople = path.join(workDir, 'outside-people.json')
      await writeJson(outsidePeople, {
        version: 1,
        people: { '90009': { items: [{ id: 'ext-1', cat: 'fact', text: '外部泄漏账本', at: baseMs }] } },
      })
      const outsideCore = path.join(workDir, 'outside-core.json')
      await writeJson(outsideCore, {
        character: { name: 'OutsideSecret' },
        beliefs: [{ text: '外部泄漏人格', status: 'accepted' }],
      })

      const symlinkFromDir = path.join(workDir, 'legacy-symlink')
      await mkdir(path.join(symlinkFromDir, 'long-memory'), { recursive: true })
      await mkdir(path.join(symlinkFromDir, 'persona', 'masked'), { recursive: true })
      await tryFileSymlink(outsidePeople, path.join(symlinkFromDir, 'long-memory', 'people.json'))
      await tryFileSymlink(outsideCore, path.join(symlinkFromDir, 'persona', 'masked', 'core.json'))
      await writeJson(path.join(symlinkFromDir, 'persona', 'masked', 'people.json'), {
        '90009': { name: 'Masked' },
      })

      const symReport = await env.importer.importFrom({ fromDir: symlinkFromDir, mode: 'all' })
      assert.equal(symReport.l1Imported, 0)
      assert.equal(symReport.l3SelfCommitted, false)
      assert.equal((await env.profiles.list()).length, 0)
      assert.equal((await env.store.list({ layers: ['L1'] }, { limit: 100 })).items.length, 0)

      // 2. Pre-existing anchor L0 records (legacy.ledger_snapshot & legacy.persona_snapshot) on qq:private:91001
      //    must NOT be matched as chat archive L0s for new L1 ledger items even when tEvent is within 24h.
      const preLedgerAnchor = await env.store.insert({
        layer: 'L0',
        kind: 'legacy.ledger_snapshot',
        source: 'legacy-import',
        channel: 'qq:private:91001',
        subjects: ['self'],
        actor: 'owner',
        content: { text: '旧锚点-账本', legacy: true },
        evidence: [],
        visibility: 'owner',
        trust: 'owner',
        confidence: 1,
        importance: 0.5,
        tEvent: baseMs,
      })
      const prePersonaAnchor = await env.store.insert({
        layer: 'L0',
        kind: 'legacy.persona_snapshot',
        source: 'legacy-import',
        channel: 'qq:private:91001',
        subjects: ['self'],
        actor: 'owner',
        content: { text: '旧锚点-人格', legacy: true },
        evidence: [],
        visibility: 'owner',
        trust: 'owner',
        confidence: 1,
        importance: 0.5,
        tEvent: baseMs,
      })

      const anchorTestDir = path.join(workDir, 'legacy-anchor-check')
      await writeJson(path.join(anchorTestDir, 'long-memory', 'people.json'), {
        version: 1,
        people: {
          '91001': {
            items: [
              { id: 'n1', cat: 'fact', text: '不应匹配预置锚点L0', at: baseMs + 500, sourceKey: 'private:91001' },
            ],
          },
        },
      })

      const anchorReport = await env.importer.importFrom({ fromDir: anchorTestDir, mode: 'memory' })
      assert.equal(anchorReport.l1Imported, 1)
      assert.equal(anchorReport.anchorRecordsCreated, 1)

      const l1Items = (await env.store.list({ layers: ['L1'], channels: ['qq:private:91001'] }, { limit: 10 })).items
      assert.equal(l1Items.length, 1)
      const n1 = l1Items[0]!
      assert.notEqual(n1.evidence[0]!.id, preLedgerAnchor.id)
      assert.notEqual(n1.evidence[0]!.id, prePersonaAnchor.id)
      const createdAnchor = await env.store.get(n1.evidence[0]!.id)
      assert.equal(createdAnchor?.kind, 'legacy.ledger_snapshot')
    } finally {
      await env.index.close()
      await env.store.close()
    }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
})
