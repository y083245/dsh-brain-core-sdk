import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { writeFileAtomic } from '@brain-core/shared'

const CLI = fileURLToPath(new URL('../../src/cli.ts', import.meta.url))

function runCli(homeDir: string, dshDir: string, args: readonly string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, BRAIN_HOME: homeDir, DSH_HOME: dshDir },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

async function hashTree(rootDir: string, currentDir = rootDir, out = new Map<string, string>()): Promise<Map<string, string>> {
  const entries = await readdir(currentDir, { withFileTypes: true })
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name)
    if (entry.isDirectory()) {
      await hashTree(rootDir, fullPath, out)
    } else if (entry.isFile()) {
      const content = await readFile(fullPath)
      const relPath = path.relative(rootDir, fullPath).split(path.sep).join('/')
      out.set(relPath, createHash('sha256').update(content).digest('hex'))
    }
  }
  return out
}

async function createLegacySample(fromDir: string): Promise<void> {
  const privateArchive = path.join(fromDir, 'long-memory', 'archive', 'private_10001', '2026-01.jsonl')
  await mkdir(path.dirname(privateArchive), { recursive: true })
  await writeFile(privateArchive, [
    JSON.stringify({ t: '2026-01-10T10:00:00.000Z', dir: 'in', userId: '10001', name: 'Alice', text: '喜欢手冲乌龙茶', msgId: 'm1' }),
    JSON.stringify({ t: '2026-01-10T10:05:00.000Z', dir: 'out', userId: null, text: '记住啦，下次请你喝' }),
  ].join('\n') + '\n', 'utf8')

  await writeFile(path.join(fromDir, 'long-memory', 'people.json'), JSON.stringify({
    version: 2,
    people: {
      '10001': {
        name: 'Alice',
        items: [
          { id: 'a1', cat: 'fact', text: '喜欢乌龙茶', at: '2026-01-10T10:01:00.000Z', sourceKey: 'private:10001', scope: 'public' },
          // Item with no matching archive channel triggers anchor L0 creation
          { id: 'a2', cat: 'note', text: '以前住在成都', at: '2025-11-01T00:00:00.000Z', sourceKey: 'private:99999', scope: 'private' },
        ],
      },
    },
  }, null, 2), 'utf8')

  const personaDir = path.join(fromDir, 'persona', 'sakura')
  await mkdir(personaDir, { recursive: true })
  await writeFile(path.join(personaDir, 'core.json'), JSON.stringify({
    version: 2,
    character: { name: 'Sakura', tone: 'warm' },
    traits: ['gentle'],
    manifests: { greeting: '早安' },
    prefs: { tea: 'oolong' },
    beliefs: [{ id: 'b1', text: '真诚交流最重要', status: 'accepted' }],
  }, null, 2), 'utf8')
  await writeFile(path.join(personaDir, 'people.json'), JSON.stringify({
    '10001': {
      name: 'Alice',
      nickname: '小艾',
      intimacy: 0.8,
      trust: 0.9,
      familiarity: 0.7,
      offsets: {},
      beliefs: ['好朋友'],
      jokes: [],
    },
  }, null, 2), 'utf8')
}

function recordCountsByLayer(homeDir: string): Record<string, number> {
  const dbPath = path.join(homeDir, 'state', 'memory', 'records.db')
  if (!existsSync(dbPath)) return {}
  const db = new DatabaseSync(dbPath)
  try {
    const rows = db.prepare('SELECT layer, COUNT(*) AS cnt FROM records GROUP BY layer').all() as { layer: string; cnt: number }[]
    const out: Record<string, number> = {}
    for (const row of rows) out[row.layer] = Number(row.cnt)
    return out
  } finally {
    db.close()
  }
}

test('brain import CLI enforces required args, runs fresh/memory/all/dry-run idempotently, preserves source hash, and refuses running kernel', async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'brain-cli-import-'))
  t.after(async () => { await rm(tmp, { recursive: true, force: true }) })

  const fromDir = path.join(tmp, 'legacy')
  const dshDir = path.join(tmp, 'dsh')
  mkdirSync(dshDir, { recursive: true })
  await createLegacySample(fromDir)
  const beforeHashes = await hashTree(fromDir)

  // 1. Missing --mode or --from or invalid --mode -> exit code 2
  const homeBad = path.join(tmp, 'home-bad')
  for (const args of [
    ['import'],
    ['import', '--from', fromDir],
    ['import', '--mode', 'all'],
    ['import', '--from', fromDir, '--mode', 'unknown'],
  ]) {
    const res = runCli(homeBad, dshDir, args)
    assert.equal(res.status, 2, `${args.join(' ')}: ${res.stderr}`)
    assert.match(res.stderr, /brain import --from <dir> --mode <all\|memory\|fresh>/)
  }

  // 2. --mode fresh -> writes import-choice.json and zero memory records
  const homeFresh = path.join(tmp, 'home-fresh')
  const freshRes = runCli(homeFresh, dshDir, ['import', '--from', fromDir, '--mode', 'fresh'])
  assert.equal(freshRes.status, 0, freshRes.stderr)
  assert.match(freshRes.stdout, /导入完成（模式: fresh）/)
  const choice = JSON.parse(await readFile(path.join(homeFresh, 'state', 'memory', 'import-choice.json'), 'utf8')) as { mode: string }
  assert.equal(choice.mode, 'fresh')
  assert.deepEqual(recordCountsByLayer(homeFresh), {})

  // 3. --dry-run does not mutate records.db
  const homeDry = path.join(tmp, 'home-dry')
  const dryRes = runCli(homeDry, dshDir, ['import', '--from', fromDir, '--mode', 'all', '--dry-run'])
  assert.equal(dryRes.status, 0, dryRes.stderr)
  assert.match(dryRes.stdout, /\[预演\]/)
  assert.match(dryRes.stdout, /L0 导入 2/)
  assert.match(dryRes.stdout, /L1 导入 2/)
  assert.deepEqual(recordCountsByLayer(homeDry), {})
  assert.equal(existsSync(path.join(homeDry, 'state', 'memory', 'import-choice.json')), false)

  // 4. --mode memory -> imports L0 & L1 (plus anchor L0), does NOT commit L3
  const homeMem = path.join(tmp, 'home-mem')
  const memRes = runCli(homeMem, dshDir, ['import', '--from', fromDir, '--mode', 'memory'])
  assert.equal(memRes.status, 0, memRes.stderr)
  assert.match(memRes.stdout, /L3 自我画像 未提交/)
  const memCounts = recordCountsByLayer(homeMem)
  assert.equal(memCounts.L0, 3) // 2 archive + 1 anchor
  assert.equal(memCounts.L1, 2)
  assert.equal(memCounts.L3 ?? 0, 0)

  // 5. --mode all -> imports L0, L1, L3, and rerun is idempotent
  const homeAll = path.join(tmp, 'home-all')
  const allFirst = runCli(homeAll, dshDir, ['import', '--from', fromDir, '--mode', 'all'])
  assert.equal(allFirst.status, 0, allFirst.stderr)
  assert.match(allFirst.stdout, /L3 自我画像 已提交/)
  assert.match(allFirst.stdout, /L3 人物 1/)
  const firstCounts = recordCountsByLayer(homeAll)
  assert.equal(firstCounts.L0, 4) // 2 archive + 1 ledger anchor + 1 persona anchor
  assert.equal(firstCounts.L1, 2)
  assert.equal(firstCounts.L3, 2) // 1 l3.self + 1 l3.person

  const allSecond = runCli(homeAll, dshDir, ['import', '--from', fromDir, '--mode', 'all'])
  assert.equal(allSecond.status, 0, allSecond.stderr)
  assert.match(allSecond.stdout, /L0 导入 0（跳过 0）/)
  assert.match(allSecond.stdout, /L1 导入 0（跳过 0）/)
  assert.match(allSecond.stdout, /L3 自我画像 未提交/)
  assert.match(allSecond.stdout, /L3 人物 0/)
  assert.match(allSecond.stdout, /溯源锚点 0/)
  assert.deepEqual(recordCountsByLayer(homeAll), firstCounts)

  // 6. Running kernel refuses import
  await writeFileAtomic(path.join(homeAll, 'state', 'kernel.pid'), `${process.pid}\n`)
  const blocked = runCli(homeAll, dshDir, ['import', '--from', fromDir, '--mode', 'all'])
  assert.notEqual(blocked.status, 0)
  assert.match(blocked.stderr, /先停内核/)

  // 7. Source directory hashes remain 100% unchanged
  const afterHashes = await hashTree(fromDir)
  assert.deepEqual(afterHashes, beforeHashes)
})
