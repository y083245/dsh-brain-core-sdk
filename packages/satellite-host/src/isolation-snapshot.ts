/** Fingerprints a directory tree so a test can prove it did not change. */
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

export interface FileFingerprint {
  readonly path: string
  readonly size: number
  readonly mtimeMs: number
  /** Absent for files the caller marked metadata-only, whose content is never read. */
  readonly sha256?: string
}

export interface SnapshotOptions {
  /** Paths are POSIX-style and relative to the root. */
  readonly metadataOnly?: (relativePath: string) => boolean
}

export async function snapshotTree(root: string, options: SnapshotOptions = {}): Promise<FileFingerprint[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  const files: FileFingerprint[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const absolute = path.join(entry.parentPath, entry.name)
    const relative = path.relative(root, absolute).split(path.sep).join('/')
    const info = await stat(absolute)
    const base = { path: relative, size: info.size, mtimeMs: info.mtimeMs }
    files.push(options.metadataOnly?.(relative) === true
      ? base
      : { ...base, sha256: createHash('sha256').update(await readFile(absolute)).digest('hex') })
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

/** Lists relative paths that were added, removed or changed. */
export function diffSnapshots(before: readonly FileFingerprint[], after: readonly FileFingerprint[]): string[] {
  const earlier = new Map(before.map(file => [file.path, file]))
  const later = new Map(after.map(file => [file.path, file]))
  const changes: string[] = []
  for (const [file, was] of earlier) {
    const now = later.get(file)
    if (now === undefined) changes.push(`removed ${file}`)
    else if (now.size !== was.size || now.mtimeMs !== was.mtimeMs || now.sha256 !== was.sha256) changes.push(`changed ${file}`)
  }
  for (const file of later.keys()) if (!earlier.has(file)) changes.push(`added ${file}`)
  return changes.sort()
}
