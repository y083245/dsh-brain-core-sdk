/** Deletes DSH session directories and the attachments only those sessions still use. */
import { readFile, readdir, unlink as unlinkFile } from 'node:fs/promises'
import path from 'node:path'
import { removeTree } from './platform.ts'

const SESSION_FILE = 'session.v4.jsonl'
const ATTACHMENT = /"attachmentId":"sha256:([0-9a-f]{64})"/g
const LOCKED = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY'])

export interface PurgeOptions {
  /** Replaces removeTree when removing a directory entry or the session directory itself. */
  readonly remove?: (target: string) => Promise<void>
  /** Replaces unlink when removing an attachment object. */
  readonly unlink?: (target: string) => Promise<void>
}

function codeOf(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? ''
}

async function directories(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => path.join(dir, entry.name))
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return []
    throw error
  }
}

/** A session lives at sessions/<cwd>/<sessionId>, never one level up or deeper. */
async function findSessionDirs(sessionsRoot: string, sessionId: string): Promise<string[]> {
  const found: string[] = []
  for (const cwd of await directories(sessionsRoot)) {
    for (const child of await directories(cwd)) {
      if (path.basename(child) === sessionId) found.push(child)
    }
  }
  return found
}

async function attachmentsIn(file: string): Promise<string[]> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return []
    throw error
  }
  return [...text.matchAll(ATTACHMENT)].map(match => match[1] as string)
}

/** References held by sessions that are staying, plus sessions locked earlier in this purge. */
async function attachmentsStillUsed(sessionsRoot: string, unlocked: ReadonlySet<string>): Promise<ReadonlySet<string>> {
  const used = new Set<string>()
  for (const cwd of await directories(sessionsRoot)) {
    for (const sessionDir of await directories(cwd)) {
      if (unlocked.has(path.basename(sessionDir))) continue
      for (const hash of await attachmentsIn(path.join(sessionDir, SESSION_FILE))) used.add(hash)
    }
  }
  return used
}

function attachmentPath(dshHome: string, hash: string): string {
  return path.join(dshHome, 'attachments', 'v1', 'objects', hash.slice(0, 2), hash)
}

/**
 * Deletes these sessions' directories and the attachments only they use. Returns the ids still locked.
 * `session.v4.jsonl` is always the last thing removed, so a retry can still read which attachments it owned.
 */
export async function purgeSessions(
  brainHome: string,
  sessionIds: readonly string[],
  options: PurgeOptions = {},
): Promise<readonly string[]> {
  const remove = options.remove ?? removeTree
  const unlink = options.unlink ?? unlinkFile
  const dshHome = path.join(brainHome, 'state', 'satellite', 'dsh-home')
  const sessionsRoot = path.join(dshHome, 'sessions')
  const ids = [...new Set(sessionIds)]
  const locked = new Set<string>()
  const dirsById = new Map<string, readonly string[]>()
  const refsById = new Map<string, ReadonlySet<string>>()

  // Phase 1: remove everything except the session log, which records the attachments it used.
  for (const sessionId of ids) {
    const dirs = await findSessionDirs(sessionsRoot, sessionId)
    dirsById.set(sessionId, dirs)
    const refs = new Set<string>()
    refsById.set(sessionId, refs)
    let held = false

    for (const dir of dirs) {
      for (const hash of await attachmentsIn(path.join(dir, SESSION_FILE))) refs.add(hash)
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (error) {
        if (codeOf(error) === 'ENOENT') continue
        throw error
      }
      for (const entry of entries) {
        if (entry.name === SESSION_FILE) continue
        try {
          await remove(path.join(dir, entry.name))
        } catch (error) {
          if (!LOCKED.has(codeOf(error))) throw error
          held = true
          break
        }
      }
      if (held) break
    }
    if (held) locked.add(sessionId)
  }

  // Phase 2: unlocked sessions no longer count as users; locked ones still do.
  const unlocked = new Set(ids.filter(id => !locked.has(id)))
  const stillUsed = await attachmentsStillUsed(sessionsRoot, unlocked)

  for (const sessionId of ids) {
    if (locked.has(sessionId)) continue
    let held = false

    for (const hash of refsById.get(sessionId) ?? []) {
      if (stillUsed.has(hash)) continue
      try {
        await unlink(attachmentPath(dshHome, hash))
      } catch (error) {
        if (codeOf(error) === 'ENOENT') continue
        if (LOCKED.has(codeOf(error))) {
          held = true
          break
        }
        throw error
      }
    }
    if (held) {
      locked.add(sessionId)
      continue
    }

    for (const dir of dirsById.get(sessionId) ?? []) {
      try {
        await remove(dir)
      } catch (error) {
        if (!LOCKED.has(codeOf(error))) throw error
        held = true
        break
      }
    }
    if (held) locked.add(sessionId)
  }

  return ids.filter(id => locked.has(id))
}
