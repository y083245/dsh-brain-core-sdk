import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ensurePrivateDir, hardenFile } from '@dsh-brain-core/shared'

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
}

function hardenSidecars(dbPath: string): void {
  for (const suffix of ['-wal', '-shm']) {
    const file = `${dbPath}${suffix}`
    if (!existsSync(file)) continue
    const hardened = hardenFile(file)
    if (!hardened.ok) throw new Error(`could not harden ${file}: ${hardened.detail}`)
  }
}

/**
 * Opens one of the kernel's own small databases with the same permissions as memory-api's audit log:
 * the file is 600 before SQLite touches it, and its WAL sidecars are tightened as well.
 */
export async function openPrivateDb(dbPath: string, create: (db: DatabaseSync) => void): Promise<DatabaseSync> {
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
    create(db)
    hardenSidecars(dbPath)
  } catch (error) {
    try { db.close() } catch { /* the original error wins */ }
    throw error
  }
  return db
}

export function hasTable(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
}
