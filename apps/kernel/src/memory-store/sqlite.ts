import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SQLInputValue } from 'node:sqlite'
import { BrainError } from '@dsh-brain-core/sdk'
import type {
  EvidenceRef, Layer, MemoryRecord, RecordPatch, RecordStatus, Trust, Visibility,
} from '@dsh-brain-core/sdk'
import { createUlid, ensurePrivateDir, hardenFile, writeFileAtomic } from '@dsh-brain-core/shared'
import type { Clock, NewRecord, Page, RecordFilter, RecordStore } from '../contracts/index.ts'

const LAYER_ORDER: Record<Layer, number> = { L0: 0, L1: 1, L2: 2, L3: 3 }

const SELECT_RECORD_COLUMNS = `id, layer, kind, source, channel, actor, subjects, content, evidence, visibility,
  trust, confidence, importance, t_event, t_ingest, status, valid_from, valid_to, version`

export interface Migration {
  readonly version: number
  readonly sql: string
}

/** The kernel's own migrations. Migration 1 is the L0–L3 schema (RFC 11: numbered, in-package). */
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
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
`,
  },
  {
    version: 2,
    sql: `
CREATE INDEX IF NOT EXISTS records_channel_layer_tevent_id ON records (channel, layer, t_event, id);
`,
  },
]

type Row = Record<string, unknown>

function invalidArgument(message: string): BrainError {
  return new BrainError('INVALID_ARGUMENT', message)
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
}

function userVersionOf(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { readonly user_version: number } | undefined
  return row?.user_version ?? 0
}

function rowToRecord(row: Row): MemoryRecord {
  return {
    id: row.id as string,
    layer: row.layer as Layer,
    kind: row.kind as string,
    source: row.source as string,
    channel: row.channel as string,
    subjects: JSON.parse(row.subjects as string) as string[],
    actor: row.actor as string,
    content: JSON.parse(row.content as string) as Record<string, unknown>,
    evidence: JSON.parse(row.evidence as string) as EvidenceRef[],
    visibility: row.visibility as Visibility,
    trust: row.trust as Trust,
    confidence: Number(row.confidence),
    importance: Number(row.importance),
    tEvent: Number(row.t_event),
    tIngest: Number(row.t_ingest),
    status: row.status as RecordStatus,
    version: Number(row.version),
    ...(row.valid_from === null || row.valid_from === undefined ? {} : { validFrom: Number(row.valid_from) }),
    ...(row.valid_to === null || row.valid_to === undefined ? {} : { validTo: Number(row.valid_to) }),
  }
}

/**
 * Applies the migrations above user_version in one transaction. Backs up first when the database already has
 * data. Returns the final version; a database newer than the newest migration is refused without opening it.
 */
export function runMigrations(db: DatabaseSync, migrations: readonly Migration[], backupPath: string): number {
  const current = userVersionOf(db)
  const latest = migrations.reduce((max, migration) => Math.max(max, migration.version), 0)
  if (current > latest) throw new BrainError('UNAVAILABLE', 'the memory database is newer than this kernel')

  const pending = migrations
    .filter((migration) => migration.version > current)
    .slice()
    .sort((a, b) => a.version - b.version)
  if (pending.length === 0) return current

  if (current > 0) {
    if (existsSync(backupPath)) unlinkSync(backupPath)
    db.prepare('VACUUM INTO ?').run(backupPath)
    const hardened = hardenFile(backupPath)
    if (!hardened.ok) throw new Error(`could not harden ${backupPath}: ${hardened.detail}`)
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    for (const migration of pending) db.exec(migration.sql)
    db.exec(`PRAGMA user_version = ${latest}`)
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* the original error wins */ }
    throw error
  }
  return latest
}

class SqliteRecordStore implements RecordStore {
  readonly #db: DatabaseSync
  readonly #clock: Clock
  readonly #nextId: () => string
  #closed = false

  constructor(db: DatabaseSync, clock: Clock) {
    this.#db = db
    this.#clock = clock
    this.#nextId = createUlid({ now: () => clock.now() })
  }

  #transaction<T>(work: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.#db.exec('COMMIT')
      return result
    } catch (error) {
      try { this.#db.exec('ROLLBACK') } catch { /* the original error wins */ }
      throw error
    }
  }

  #getById(id: string): MemoryRecord | null {
    const row = this.#db.prepare(`SELECT ${SELECT_RECORD_COLUMNS} FROM records WHERE id = ?`).get(id)
    return row === undefined ? null : rowToRecord(row as Row)
  }

  #assertEvidence(record: NewRecord): void {
    if (record.layer === 'L0') {
      if (record.evidence.length !== 0) throw invalidArgument('L0 records take no evidence')
      return
    }
    if (record.evidence.length === 0) throw invalidArgument(`${record.layer} records need at least one evidence reference`)
    const find = this.#db.prepare('SELECT layer, status FROM records WHERE id = ?')
    for (const reference of record.evidence) {
      const target = find.get(reference.id) as { readonly layer: Layer; readonly status: RecordStatus } | undefined
      if (target === undefined) throw invalidArgument(`evidence ${reference.id} does not exist`)
      if (target.status === 'tombstoned') throw invalidArgument(`evidence ${reference.id} is tombstoned`)
      if (LAYER_ORDER[target.layer] >= LAYER_ORDER[record.layer]) throw invalidArgument(`evidence ${reference.id} is not from a lower layer`)
    }
  }

  #findIdempotent(source: string, key: string): MemoryRecord | null {
    const row = this.#db.prepare('SELECT record_id FROM idempotency WHERE source = ? AND "key" = ?').get(source, key) as
      | { readonly record_id: string }
      | undefined
    return row === undefined ? null : this.#getById(row.record_id)
  }

  async insert(record: NewRecord, idempotencyKey?: string): Promise<MemoryRecord> {
    if (idempotencyKey !== undefined) {
      const existing = this.#findIdempotent(record.source, idempotencyKey)
      if (existing !== null) return existing
    }
    this.#assertEvidence(record)

    const id = `${record.layer.toLowerCase()}_${this.#nextId()}`
    const tIngest = this.#clock.now()
    this.#transaction(() => {
      this.#db.prepare(`INSERT INTO records (${SELECT_RECORD_COLUMNS}) VALUES (${Array.from({ length: 19 }, () => '?').join(', ')})`).run(
        id,
        record.layer,
        record.kind,
        record.source,
        record.channel,
        record.actor,
        JSON.stringify(record.subjects),
        JSON.stringify(record.content),
        JSON.stringify(record.evidence),
        record.visibility,
        record.trust,
        record.confidence,
        record.importance,
        record.tEvent,
        tIngest,
        'active',
        record.validFrom ?? null,
        record.validTo ?? null,
        1,
      )
      const addSubject = this.#db.prepare('INSERT OR IGNORE INTO record_subjects (record_id, subject) VALUES (?, ?)')
      for (const subject of record.subjects) addSubject.run(id, subject)
      const addEdge = this.#db.prepare('INSERT OR IGNORE INTO evidence_edges (record_id, evidence_id) VALUES (?, ?)')
      for (const reference of record.evidence) addEdge.run(id, reference.id)
      if (idempotencyKey !== undefined) {
        this.#db.prepare('INSERT INTO idempotency (source, "key", record_id) VALUES (?, ?, ?)').run(record.source, idempotencyKey, id)
      }
    })
    return this.#getById(id) as MemoryRecord
  }

  async get(id: string): Promise<MemoryRecord | null> {
    return this.#getById(id)
  }

  async patch(id: string, patch: RecordPatch, expectedVersion: number): Promise<MemoryRecord> {
    const current = this.#getById(id)
    if (current === null || current.status === 'tombstoned') throw new BrainError('NOT_FOUND', `record ${id} not found`)
    if (current.layer === 'L0') throw new BrainError('PERMISSION_DENIED', 'L0 records cannot be patched')
    if (expectedVersion !== current.version) throw new BrainError('CONFLICT', `record ${id} is at version ${current.version}`)
    if (patch.status === 'tombstoned') throw invalidArgument("use tombstone() instead of patch({ status: 'tombstoned' })")

    const next: MemoryRecord = {
      ...current,
      ...(patch.content === undefined ? {} : { content: patch.content }),
      ...(patch.subjects === undefined ? {} : { subjects: patch.subjects }),
      ...(patch.visibility === undefined ? {} : { visibility: patch.visibility }),
      ...(patch.confidence === undefined ? {} : { confidence: patch.confidence }),
      ...(patch.importance === undefined ? {} : { importance: patch.importance }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.validTo === undefined ? {} : { validTo: patch.validTo }),
      version: current.version + 1,
    }
    this.#transaction(() => {
      this.#db.prepare(`UPDATE records SET subjects = ?, content = ?, visibility = ?, confidence = ?, importance = ?,
        status = ?, valid_to = ?, version = ? WHERE id = ?`).run(
        JSON.stringify(next.subjects),
        JSON.stringify(next.content),
        next.visibility,
        next.confidence,
        next.importance,
        next.status,
        next.validTo ?? null,
        next.version,
        id,
      )
      if (patch.subjects !== undefined) {
        this.#db.prepare('DELETE FROM record_subjects WHERE record_id = ?').run(id)
        const addSubject = this.#db.prepare('INSERT OR IGNORE INTO record_subjects (record_id, subject) VALUES (?, ?)')
        for (const subject of next.subjects) addSubject.run(id, subject)
      }
    })
    return this.#getById(id) as MemoryRecord
  }

  async tombstone(id: string): Promise<MemoryRecord> {
    const current = this.#getById(id)
    if (current === null) throw new BrainError('NOT_FOUND', `record ${id} not found`)
    if (current.status === 'tombstoned') return current

    const stored = (this.#db.prepare('SELECT content FROM records WHERE id = ?').get(id) as { readonly content: string }).content
    // Equal byte length keeps the file size unchanged; content {} is all a reader may see afterwards.
    const filler = '{}' + ' '.repeat(Math.max(0, Buffer.byteLength(stored) - 2))
    this.#transaction(() => {
      this.#db.prepare("UPDATE records SET content = ?, status = 'tombstoned', version = version + 1 WHERE id = ?").run(filler, id)
    })
    // With secure_delete and a truncated WAL the old bytes no longer survive anywhere in the file (FR-M02).
    this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    return this.#getById(id) as MemoryRecord
  }

  async list(filter: RecordFilter, page: { readonly limit: number; readonly cursor?: string }): Promise<Page<MemoryRecord>> {
    if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 1000) {
      throw invalidArgument('page.limit must be an integer from 1 to 1000')
    }
    const arrays = [filter.layers, filter.channels, filter.subjects, filter.actors, filter.kinds, filter.statuses]
    if (arrays.some((values) => values !== undefined && values.length === 0)) return { items: [] }

    const where: string[] = []
    const params: SQLInputValue[] = []
    const addIn = (column: string, values: readonly string[] | undefined): void => {
      if (values === undefined) return
      where.push(`${column} IN (${values.map(() => '?').join(', ')})`)
      params.push(...values)
    }
    addIn('layer', filter.layers)
    addIn('channel', filter.channels)
    addIn('actor', filter.actors)
    addIn('kind', filter.kinds)
    addIn('status', filter.statuses)
    if (filter.subjects !== undefined) {
      where.push(`id IN (SELECT record_id FROM record_subjects WHERE subject IN (${filter.subjects.map(() => '?').join(', ')}))`)
      params.push(...filter.subjects)
    }
    if (filter.from !== undefined) {
      where.push('t_event >= ?')
      params.push(filter.from)
    }
    if (filter.to !== undefined) {
      where.push('t_event <= ?')
      params.push(filter.to)
    }
    if (page.cursor !== undefined) {
      where.push('id > ?')
      params.push(page.cursor)
    }

    const sql = `SELECT ${SELECT_RECORD_COLUMNS} FROM records${where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`}
      ORDER BY id LIMIT ?`
    params.push(page.limit + 1)
    const rows = this.#db.prepare(sql).all(...params) as Row[]
    const items = rows.slice(0, page.limit).map(rowToRecord)
    if (rows.length > page.limit) return { items, nextCursor: (items[items.length - 1] as MemoryRecord).id }
    return { items }
  }

  async dependentsOf(id: string): Promise<readonly MemoryRecord[]> {
    const rows = this.#db
      .prepare(`SELECT ${SELECT_RECORD_COLUMNS} FROM records
        WHERE id IN (SELECT record_id FROM evidence_edges WHERE evidence_id = ?) ORDER BY id`)
      .all(id) as Row[]
    return rows.map(rowToRecord)
  }

  async *scan(layers?: readonly Layer[]): AsyncIterable<MemoryRecord> {
    if (layers !== undefined && layers.length === 0) return
    let cursor: string | undefined
    for (;;) {
      const where: string[] = []
      const params: SQLInputValue[] = []
      if (layers !== undefined) {
        where.push(`layer IN (${layers.map(() => '?').join(', ')})`)
        params.push(...layers)
      }
      if (cursor !== undefined) {
        where.push('id > ?')
        params.push(cursor)
      }
      const sql = `SELECT ${SELECT_RECORD_COLUMNS} FROM records${where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`}
        ORDER BY id LIMIT 500`
      const rows = this.#db.prepare(sql).all(...params) as Row[]
      for (const row of rows) yield rowToRecord(row)
      if (rows.length < 500) return
      cursor = (rows[rows.length - 1] as Row).id as string
    }
  }

  async neighborsOf(id: string, window: number): Promise<{
    readonly before: readonly MemoryRecord[]
    readonly after: readonly MemoryRecord[]
  }> {
    if (!Number.isInteger(window) || window < 0 || window > 10) {
      throw invalidArgument('neighbors window must be an integer in 0..10')
    }
    if (window === 0) return { before: [], after: [] }
    const anchor = this.#getById(id)
    if (anchor === null || anchor.layer !== 'L0' || anchor.status !== 'active') {
      return { before: [], after: [] }
    }
    const beforeRows = this.#db
      .prepare(`SELECT ${SELECT_RECORD_COLUMNS} FROM records
        WHERE channel = ? AND layer = 'L0' AND status = 'active'
          AND (t_event < ? OR (t_event = ? AND id < ?))
        ORDER BY t_event DESC, id DESC LIMIT ?`)
      .all(anchor.channel, anchor.tEvent, anchor.tEvent, anchor.id, window) as Row[]
    const afterRows = this.#db
      .prepare(`SELECT ${SELECT_RECORD_COLUMNS} FROM records
        WHERE channel = ? AND layer = 'L0' AND status = 'active'
          AND (t_event > ? OR (t_event = ? AND id > ?))
        ORDER BY t_event ASC, id ASC LIMIT ?`)
      .all(anchor.channel, anchor.tEvent, anchor.tEvent, anchor.id, window) as Row[]
    return {
      before: beforeRows.map(rowToRecord).reverse(),
      after: afterRows.map(rowToRecord),
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#db.close()
  }
}

/** Tightens the -wal and -shm files that SQLite creates next to the database. */
function hardenSqliteSidecars(dbPath: string): void {
  for (const suffix of ['-wal', '-shm']) {
    const file = `${dbPath}${suffix}`
    if (!existsSync(file)) continue
    const hardened = hardenFile(file)
    if (!hardened.ok) throw new Error(`could not harden ${file}: ${hardened.detail}`)
  }
}

export async function createSqliteRecordStore(options: { readonly path: string; readonly clock: Clock }): Promise<RecordStore> {
  await ensurePrivateDir(path.dirname(options.path))

  if (!existsSync(options.path)) {
    try {
      // Creating the empty file first makes SQLite give -wal and -shm the same 600 mode.
      writeFileSync(options.path, '', { mode: 0o600, flag: 'wx' })
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
    }
    const hardened = hardenFile(options.path)
    if (!hardened.ok) throw new Error(`could not harden ${options.path}: ${hardened.detail}`)
  }

  const db = new DatabaseSync(options.path)
  try {
    db.exec('PRAGMA journal_mode=WAL')
    db.exec('PRAGMA secure_delete=ON')
    const before = userVersionOf(db)
    const version = runMigrations(db, MIGRATIONS, `${options.path}.v${before}.bak`)
    await writeFileAtomic(path.join(path.dirname(options.path), 'schema-version'), `${version}\n`)
    hardenSqliteSidecars(options.path)
    return new SqliteRecordStore(db, options.clock)
  } catch (error) {
    try { db.close() } catch { /* the original error wins */ }
    throw error
  }
}
