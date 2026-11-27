import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { BrainError } from '@dsh-brain-core/sdk'
import { isHardened } from '@dsh-brain-core/shared'
import type { NewRecord } from '../../src/contracts/index.ts'
import { createSqliteRecordStore, runMigrations, type Migration } from '../../src/memory-store/index.ts'
import { FakeClock } from '../fakes/index.ts'
import { recordStoreSuite } from './suite.ts'

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'brain-memory-sqlite-'))
}

async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 })
}

function recordInput(overrides: Partial<NewRecord> = {}): NewRecord {
  return {
    layer: 'L1',
    kind: 'l1.fact',
    source: 'plugin.test',
    channel: 'ch1',
    subjects: [],
    actor: 'owner',
    content: { text: 'hello' },
    evidence: [],
    visibility: 'open',
    trust: 'owner',
    confidence: 0.5,
    importance: 0.5,
    tEvent: 1000,
    ...overrides,
  }
}

function eventInput(overrides: Partial<NewRecord> = {}): NewRecord {
  return recordInput({ layer: 'L0', kind: 'l0.event', content: { text: 'raw' }, ...overrides })
}

function userVersion(dbPath: string): number {
  const db = new DatabaseSync(dbPath)
  try {
    return (db.prepare('PRAGMA user_version').get() as { readonly user_version: number }).user_version
  } finally {
    db.close()
  }
}

recordStoreSuite('sqlite record store', async (clock) => {
  const dir = await tempDir()
  const store = await createSqliteRecordStore({ path: path.join(dir, 'memory.db'), clock })
  return { store, cleanup: async () => removeDir(dir) }
})

test('tombstone leaves no plaintext in the database or the WAL', async () => {
  const dir = await tempDir()
  const dbPath = path.join(dir, 'memory.db')
  const clock = new FakeClock()
  const marker = 'ZQXJ-原文标记-鹦鹉螺号-'.repeat(20)
  try {
    let store = await createSqliteRecordStore({ path: dbPath, clock })
    for (let index = 0; index < 50; index += 1) {
      await store.insert(eventInput({ content: { text: `filler ${index}` } }))
    }
    const marked = await store.insert(eventInput({ content: { text: marker } }))
    await store.close()
    const originalSize = statSync(dbPath).size

    store = await createSqliteRecordStore({ path: dbPath, clock })
    await store.tombstone(marked.id)
    const needle = Buffer.from(marker, 'utf8')
    for (const file of [dbPath, `${dbPath}-wal`]) {
      if (!existsSync(file)) continue
      assert.equal(readFileSync(file).includes(needle), false, `${path.basename(file)} still contains the plaintext`)
    }
    await store.close()
    assert.equal(statSync(dbPath).size, originalSize)
  } finally {
    await removeDir(dir)
  }
})

test('the database, sidecars and version file stay private', async () => {
  const dir = await tempDir()
  const dbPath = path.join(dir, 'memory.db')
  const clock = new FakeClock()
  try {
    const store = await createSqliteRecordStore({ path: dbPath, clock })
    try {
      await store.insert(eventInput())
      const candidates = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, path.join(dir, 'schema-version')]
      const files = candidates.filter((file) => existsSync(file))
      assert.ok(files.includes(dbPath))
      assert.ok(files.includes(path.join(dir, 'schema-version')))
      for (const file of files) {
        if (process.platform === 'win32') assert.equal(isHardened(file), true, file)
        else assert.equal(statSync(file).mode & 0o777, 0o600, file)
      }
      if (process.platform === 'win32') assert.equal(isHardened(dir), true, dir)
      else assert.equal(statSync(dir).mode & 0o777, 0o700, dir)
    } finally {
      await store.close()
    }
  } finally {
    await removeDir(dir)
  }
})

test('data survives a reopen and ids keep increasing', async () => {
  const dir = await tempDir()
  const dbPath = path.join(dir, 'memory.db')
  const clock = new FakeClock()
  try {
    const firstStore = await createSqliteRecordStore({ path: dbPath, clock })
    const first = await firstStore.insert(eventInput())
    await firstStore.close()

    clock.advance(1000)
    const secondStore = await createSqliteRecordStore({ path: dbPath, clock })
    try {
      assert.deepEqual(await secondStore.get(first.id), first)
      const second = await secondStore.insert(eventInput())
      assert.ok(second.id > first.id)
    } finally {
      await secondStore.close()
    }
  } finally {
    await removeDir(dir)
  }
})

test('a new database runs migrations through v2 and reopening does not run them again', async () => {
  const dir = await tempDir()
  const dbPath = path.join(dir, 'memory.db')
  const clock = new FakeClock()
  try {
    const store = await createSqliteRecordStore({ path: dbPath, clock })
    const inserted = await store.insert(eventInput())
    await store.close()

    assert.equal(readFileSync(path.join(dir, 'schema-version'), 'utf8'), '2\n')
    assert.equal(userVersion(dbPath), 2)

    const reopened = await createSqliteRecordStore({ path: dbPath, clock })
    try {
      assert.equal((await reopened.get(inserted.id))?.id, inserted.id)
    } finally {
      await reopened.close()
    }
    assert.equal(readFileSync(path.join(dir, 'schema-version'), 'utf8'), '2\n')
    assert.equal(userVersion(dbPath), 2)
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.bak')), [])
  } finally {
    await removeDir(dir)
  }
})

test('a v1 database automatically backs up, upgrades to v2 with neighbors index, and serves neighborsOf', async () => {
  const dir = await tempDir()
  const dbPath = path.join(dir, 'memory.db')
  const clock = new FakeClock()
  const v1Sql = `
CREATE TABLE records (
  id TEXT PRIMARY KEY,
  layer TEXT NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  channel TEXT NOT NULL,
  actor TEXT NOT NULL,
  subjects TEXT NOT NULL,
  content TEXT NOT NULL,
  evidence TEXT NOT NULL,
  visibility TEXT NOT NULL,
  trust TEXT NOT NULL,
  confidence REAL NOT NULL,
  importance REAL NOT NULL,
  t_event INTEGER NOT NULL,
  t_ingest INTEGER NOT NULL,
  status TEXT NOT NULL,
  valid_from INTEGER,
  valid_to INTEGER,
  version INTEGER NOT NULL
) STRICT;
CREATE INDEX records_layer_t_event ON records (layer, t_event);
CREATE INDEX records_channel ON records (channel);
CREATE TABLE record_subjects (record_id TEXT NOT NULL, subject TEXT NOT NULL, PRIMARY KEY (record_id, subject)) STRICT;
CREATE INDEX record_subjects_subject ON record_subjects (subject);
CREATE TABLE evidence_edges (record_id TEXT NOT NULL, evidence_id TEXT NOT NULL, PRIMARY KEY (record_id, evidence_id)) STRICT;
CREATE INDEX evidence_edges_evidence_id ON evidence_edges (evidence_id);
CREATE TABLE idempotency (source TEXT NOT NULL, key TEXT NOT NULL, record_id TEXT NOT NULL, PRIMARY KEY (source, key)) STRICT;
`
  try {
    const db = new DatabaseSync(dbPath)
    try {
      db.exec('PRAGMA journal_mode=WAL')
      runMigrations(db, [{ version: 1, sql: v1Sql }], `${dbPath}.v0.bak`)
      db.prepare(`INSERT INTO records (id, layer, kind, source, channel, actor, subjects, content, evidence, visibility,
        trust, confidence, importance, t_event, t_ingest, status, valid_from, valid_to, version)
        VALUES (?, 'L0', 'chat.message', 'qq', 'qq:group:1', 'p_a', '[]', ?, '[]', 'open', 'member', 1, 0.5, ?, ?, 'active', NULL, NULL, 1)`)
        .run('l0_01', JSON.stringify({ text: 'first' }), 1000, 1000)
      db.prepare(`INSERT INTO records (id, layer, kind, source, channel, actor, subjects, content, evidence, visibility,
        trust, confidence, importance, t_event, t_ingest, status, valid_from, valid_to, version)
        VALUES (?, 'L0', 'chat.message', 'qq', 'qq:group:1', 'p_a', '[]', ?, '[]', 'open', 'member', 1, 0.5, ?, ?, 'active', NULL, NULL, 1)`)
        .run('l0_02', JSON.stringify({ text: 'second' }), 1000, 1000)
      db.prepare(`INSERT INTO records (id, layer, kind, source, channel, actor, subjects, content, evidence, visibility,
        trust, confidence, importance, t_event, t_ingest, status, valid_from, valid_to, version)
        VALUES (?, 'L0', 'chat.message', 'qq', 'qq:group:1', 'p_a', '[]', ?, '[]', 'open', 'member', 1, 0.5, ?, ?, 'active', NULL, NULL, 1)`)
        .run('l0_03', JSON.stringify({ text: 'third' }), 2000, 2000)
    } finally {
      db.close()
    }
    assert.equal(userVersion(dbPath), 1)

    const store = await createSqliteRecordStore({ path: dbPath, clock })
    try {
      assert.equal(userVersion(dbPath), 2)
      assert.equal(readFileSync(path.join(dir, 'schema-version'), 'utf8'), '2\n')
      assert.equal(existsSync(`${dbPath}.v1.bak`), true)

      const verifyDb = new DatabaseSync(dbPath)
      try {
        const idx = verifyDb
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'records_channel_layer_tevent_id'")
          .get() as { readonly name: string } | undefined
        assert.equal(idx?.name, 'records_channel_layer_tevent_id')
      } finally {
        verifyDb.close()
      }

      const res = await store.neighborsOf!('l0_02', 2)
      assert.deepEqual(res.before.map((r) => r.id), ['l0_01'])
      assert.deepEqual(res.after.map((r) => r.id), ['l0_03'])
    } finally {
      await store.close()
    }
  } finally {
    await removeDir(dir)
  }
})

test('a database newer than this kernel is refused', async () => {
  const dir = await tempDir()
  const dbPath = path.join(dir, 'memory.db')
  const clock = new FakeClock()
  try {
    const store = await createSqliteRecordStore({ path: dbPath, clock })
    await store.close()

    const db = new DatabaseSync(dbPath)
    try {
      db.exec('PRAGMA user_version = 99')
    } finally {
      db.close()
    }

    await assert.rejects(createSqliteRecordStore({ path: dbPath, clock }), (error: unknown) => {
      assert.ok(error instanceof BrainError, `expected BrainError, got ${String(error)}`)
      assert.equal(error.code, 'UNAVAILABLE')
      return true
    })
  } finally {
    await removeDir(dir)
  }
})

test('runMigrations upgrades v1 to v2 and backs up first', async () => {
  const dir = await tempDir()
  const dbPath = path.join(dir, 'memory.db')
  const backupPath = `${dbPath}.v1.bak`
  const v1: Migration = { version: 1, sql: 'CREATE TABLE one (a TEXT) STRICT' }
  const v2: Migration = { version: 2, sql: 'CREATE TABLE two (b TEXT) STRICT' }
  try {
    const first = new DatabaseSync(dbPath)
    try {
      first.exec('PRAGMA journal_mode=WAL')
      assert.equal(runMigrations(first, [v1], backupPath), 1)
    } finally {
      first.close()
    }
    assert.equal(existsSync(backupPath), false)

    const second = new DatabaseSync(dbPath)
    try {
      assert.equal(runMigrations(second, [v1, v2], backupPath), 2)
    } finally {
      second.close()
    }
    assert.equal(existsSync(backupPath), true)
    assert.equal(userVersion(dbPath), 2)
  } finally {
    await removeDir(dir)
  }
})

test('a failing migration rolls back and leaves the version unchanged', async () => {
  const dir = await tempDir()
  const dbPath = path.join(dir, 'memory.db')
  const backupPath = `${dbPath}.v1.bak`
  const v1: Migration = { version: 1, sql: 'CREATE TABLE one (a TEXT) STRICT' }
  const broken: Migration = { version: 2, sql: 'CREATE TABLE broken (' }
  try {
    const db = new DatabaseSync(dbPath)
    try {
      db.exec('PRAGMA journal_mode=WAL')
      assert.equal(runMigrations(db, [v1], backupPath), 1)
      assert.throws(() => runMigrations(db, [v1, broken], backupPath))
      assert.equal((db.prepare('PRAGMA user_version').get() as { readonly user_version: number }).user_version, 1)
      assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'broken'").get(), undefined)
    } finally {
      db.close()
    }
    assert.equal(userVersion(dbPath), 1)
  } finally {
    await removeDir(dir)
  }
})
