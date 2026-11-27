import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SQLInputValue, StatementSync } from 'node:sqlite'
import type { MemoryRecord, SearchScope, Viewer } from '@dsh-brain-core/sdk'
import { ensurePrivateDir, hardenFile } from '@dsh-brain-core/shared'
import type { IndexHit, IndexQuery, KeywordIndex } from '../contracts/index.ts'

/** FTS5's trigram tokenizer misses two-character Chinese words, so CJK runs are split into bigrams here. */

const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu

function splitRun(run: string): string[] {
  const chars = [...run]
  if (chars.length === 1) return chars
  return chars.slice(0, -1).map((char, index) => char + chars[index + 1])
}

/**
 * The text to store in a `tokenize='unicode61'` FTS5 column.
 *
 * Known limit: consecutive Han characters are stored two at a time, so a one-character query only finds that
 * character where it stands alone in a run (`猫` does not find `黑猫警长`).
 */
export function bigrams(text: string): string {
  return text.replace(CJK_RUN, run => ` ${splitRun(run).join(' ')} `).replace(/\s+/g, ' ').trim()
}

/** An FTS5 MATCH expression: every token of the term must be present, as a phrase within each run. */
export function bigramQuery(term: string): string {
  const phrases: string[] = []
  for (const part of term.split(/\s+/).filter(Boolean)) {
    // A part made only of punctuation matches nothing, and the parts are ANDed, so `记忆 "` would find nothing.
    if (!/[\p{L}\p{N}]/u.test(part)) continue
    const tokens = bigrams(part).split(' ').filter(Boolean)
    phrases.push(`"${tokens.join(' ').replaceAll('"', '""')}"`)
  }
  return phrases.join(' AND ')
}

function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === 'string') {
    into.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, into)
  }
}

/** Every string under content, in key and array order, joined by one space. Metadata is not indexed. */
export function indexText(record: MemoryRecord): string {
  const parts: string[] = []
  collectStrings(record.content, parts)
  return parts.join(' ')
}

/** The store filters a scope adds. `all` adds none: the policy decides what is visible. */
export function expandScope(scope: SearchScope, viewer: Viewer): Pick<IndexQuery, 'channels' | 'subjects'> {
  switch (scope) {
    case 'here':
      return { channels: viewer.channel === null ? [] : [viewer.channel] }
    case 'person':
      return { subjects: [...viewer.participants] }
    case 'all':
      return {}
  }
}

const SUBJECT_SEPARATOR = '\u001f'

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
}

/** Tightens the -wal and -shm files SQLite creates next to the index. */
function hardenSqliteSidecars(dbPath: string): void {
  for (const suffix of ['-wal', '-shm']) {
    const file = `${dbPath}${suffix}`
    if (!existsSync(file)) continue
    const hardened = hardenFile(file)
    if (!hardened.ok) throw new Error(`could not harden ${file}: ${hardened.detail}`)
  }
}

/** `\x1f` around every subject keeps `instr` from matching a subject that only shares a prefix. */
function subjectColumn(subjects: readonly string[]): string {
  return `${SUBJECT_SEPARATOR}${subjects.join(SUBJECT_SEPARATOR)}${SUBJECT_SEPARATOR}`
}

class SqliteKeywordIndex implements KeywordIndex {
  readonly #db: DatabaseSync
  readonly #insertFts: StatementSync
  readonly #insertDoc: StatementSync
  readonly #ridOf: StatementSync
  readonly #deleteFts: StatementSync
  readonly #deleteDoc: StatementSync
  #closed = false

  constructor(db: DatabaseSync) {
    this.#db = db
    this.#insertFts = db.prepare('INSERT INTO fts (text, layer, channel, t_event, subjects) VALUES (?, ?, ?, ?, ?)')
    this.#insertDoc = db.prepare('INSERT INTO docs (rid, id) VALUES (?, ?)')
    this.#ridOf = db.prepare('SELECT rid FROM docs WHERE id = ?')
    this.#deleteFts = db.prepare('DELETE FROM fts WHERE rowid = ?')
    this.#deleteDoc = db.prepare('DELETE FROM docs WHERE rid = ?')
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

  /** Deletes by rowid: deleting by an UNINDEXED column would scan the whole FTS table. */
  #dropEntry(id: string): void {
    const row = this.#ridOf.get(id) as { readonly rid: number } | undefined
    if (row === undefined) return
    this.#deleteFts.run(row.rid)
    this.#deleteDoc.run(row.rid)
  }

  #insert(record: MemoryRecord): void {
    const inserted = this.#insertFts.run(
      bigrams(indexText(record)),
      record.layer,
      record.channel,
      record.tEvent,
      subjectColumn(record.subjects),
    )
    this.#insertDoc.run(Number(inserted.lastInsertRowid), record.id)
  }

  async add(record: MemoryRecord): Promise<void> {
    this.#transaction(() => {
      this.#dropEntry(record.id)
      if (record.status === 'active') this.#insert(record)
    })
  }

  async remove(id: string): Promise<void> {
    this.#transaction(() => this.#dropEntry(id))
    // With secure_delete and a truncated WAL the removed text no longer survives anywhere in the files (M6).
    this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  }

  async search(query: IndexQuery): Promise<readonly IndexHit[]> {
    const text = query.text.trim()
    if (text === '') return []
    const match = bigramQuery(text)
    if (match === '') return []
    if ([query.layers, query.channels, query.subjects].some((values) => values !== undefined && values.length === 0)) {
      return []
    }

    const where: string[] = ['fts MATCH ?']
    const params: SQLInputValue[] = [match]
    const addIn = (column: string, values: readonly string[] | undefined): void => {
      if (values === undefined) return
      where.push(`${column} IN (${values.map(() => '?').join(', ')})`)
      params.push(...values)
    }
    addIn('fts.layer', query.layers)
    addIn('fts.channel', query.channels)
    if (query.subjects !== undefined) {
      where.push(`(${query.subjects.map(() => 'instr(fts.subjects, ?) > 0').join(' OR ')})`)
      for (const subject of query.subjects) params.push(`${SUBJECT_SEPARATOR}${subject}${SUBJECT_SEPARATOR}`)
    }
    if (query.from !== undefined) {
      where.push('fts.t_event >= ?')
      params.push(query.from)
    }
    if (query.to !== undefined) {
      where.push('fts.t_event <= ?')
      params.push(query.to)
    }
    params.push(query.limit)

    const rows = this.#db.prepare(`SELECT docs.id AS id, -bm25(fts) AS score
      FROM fts JOIN docs ON docs.rid = fts.rowid
      WHERE ${where.join(' AND ')}
      ORDER BY score DESC, docs.id ASC
      LIMIT ?`).all(...params) as Array<{ readonly id: string; readonly score: number }>
    return rows.map((row) => ({ id: row.id, score: Number(row.score) }))
  }

  async rebuild(records: AsyncIterable<MemoryRecord>): Promise<number> {
    // Read everything before the transaction: a transaction must not await (the index writes synchronously).
    const all: MemoryRecord[] = []
    for await (const record of records) all.push(record)
    let active = 0
    this.#transaction(() => {
      this.#db.exec('DELETE FROM docs')
      this.#db.exec('DELETE FROM fts')
      for (const record of all) {
        if (record.status !== 'active') continue
        active += 1
        this.#insert(record)
      }
    })
    this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    return active
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#db.close()
  }
}

/** Opens (or creates) the derived index. It can always be rebuilt from the store, so losing it costs only time. */
export async function createKeywordIndex(options: { readonly path: string }): Promise<KeywordIndex> {
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
    if (!hasTable(db, 'docs')) {
      db.exec('CREATE TABLE docs (rid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE)')
    }
    if (!hasTable(db, 'fts')) {
      db.exec(`CREATE VIRTUAL TABLE fts USING fts5(text, layer UNINDEXED, channel UNINDEXED, t_event UNINDEXED,
        subjects UNINDEXED, tokenize='unicode61');
        INSERT INTO fts(fts, rank) VALUES('secure-delete', 1);`)
    }
    hardenSqliteSidecars(options.path)
    return new SqliteKeywordIndex(db)
  } catch (error) {
    try { db.close() } catch { /* the original error wins */ }
    throw error
  }
}
