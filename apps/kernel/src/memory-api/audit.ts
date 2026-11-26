import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { StatementSync } from 'node:sqlite'
import { ensurePrivateDir, hardenFile } from '@brain-core/shared'
import type { CrossChannelMode, MemoryAudit } from '../contracts/index.ts'

export interface AuditEntry {
  readonly recordId: string
  readonly viewerChannel: string
  readonly mode: string
  readonly tAt: number
}

/** S6: which memory was used outside its own channel, and which would have been in shadow mode. Ids only, never text. */
export interface AuditLog extends MemoryAudit {
  list(recordId?: string): Promise<readonly AuditEntry[]>
  close(): Promise<void>
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
}

function hardenSqliteSidecars(dbPath: string): void {
  for (const suffix of ['-wal', '-shm']) {
    const file = `${dbPath}${suffix}`
    if (!existsSync(file)) continue
    const hardened = hardenFile(file)
    if (!hardened.ok) throw new Error(`could not harden ${file}: ${hardened.detail}`)
  }
}

export async function createAuditLog(options: { readonly path: string }): Promise<AuditLog> {
  const dbPath = options.path
  await ensurePrivateDir(path.dirname(dbPath))

  if (!existsSync(dbPath)) {
    try {
      // Creating the empty file first makes SQLite give -wal and -shm the same 600 mode.
      writeFileSync(dbPath, '', { mode: 0o600, flag: 'wx' })
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
    }
    const hardened = hardenFile(dbPath)
    if (!hardened.ok) throw new Error(`could not harden ${dbPath}: ${hardened.detail}`)
  }

  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA journal_mode=WAL')
    if (!hasTable(db, 'cross_channel_use')) {
      db.exec(`CREATE TABLE cross_channel_use (
        record_id TEXT NOT NULL,
        viewer_channel TEXT NOT NULL,
        mode TEXT NOT NULL,
        t_at INTEGER NOT NULL
      ) STRICT`)
    }
    hardenSqliteSidecars(dbPath)
  } catch (error) {
    try { db.close() } catch { /* the original error wins */ }
    throw error
  }

  const insert: StatementSync = db.prepare(
    'INSERT INTO cross_channel_use (record_id, viewer_channel, mode, t_at) VALUES (?, ?, ?, ?)',
  )
  const selectAll: StatementSync = db.prepare(
    'SELECT record_id, viewer_channel, mode, t_at FROM cross_channel_use ORDER BY t_at ASC',
  )
  const selectOne: StatementSync = db.prepare(
    'SELECT record_id, viewer_channel, mode, t_at FROM cross_channel_use WHERE record_id = ? ORDER BY t_at ASC',
  )
  let closed = false

  type Row = { readonly record_id: string; readonly viewer_channel: string; readonly mode: string; readonly t_at: number }

  function toEntry(row: Row): AuditEntry {
    return { recordId: row.record_id, viewerChannel: row.viewer_channel, mode: row.mode, tAt: row.t_at }
  }

  return {
    async crossChannelUse(entry: {
      readonly recordId: string
      readonly viewerChannel: string
      readonly mode: CrossChannelMode
      readonly tAt: number
    }): Promise<void> {
      insert.run(entry.recordId, entry.viewerChannel, entry.mode, entry.tAt)
    },

    async list(recordId?: string): Promise<readonly AuditEntry[]> {
      const rows = (recordId === undefined ? selectAll.all() : selectOne.all(recordId)) as Row[]
      return rows.map(toEntry)
    },

    async close(): Promise<void> {
      if (closed) return
      closed = true
      db.close()
    },
  }
}
