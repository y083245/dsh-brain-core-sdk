/** Backup, apply and restore. This is the only module that writes into a DSH home. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fromPosixRelative, isPathInside } from './paths.ts'
import type { ApplyResult, CleanupPlan, FileChange, SymlinkChange } from './types.ts'

export interface BackupFileItem {
  readonly kind: 'file'
  readonly path: string
  readonly mode: number
}

export interface BackupSymlinkItem {
  readonly kind: 'symlink'
  readonly path: string
  readonly target: string
}

export type BackupItem = BackupFileItem | BackupSymlinkItem

export interface BackupManifest {
  readonly version: 1
  readonly createdAt: string
  readonly dshHome: string
  readonly items: readonly BackupItem[]
}

function timestampDirectory(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

async function createBackupDirectory(root: string, stamp: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const target = path.join(root, attempt === 0 ? stamp : `${stamp}-${attempt}`)
    try {
      await fs.mkdir(target)
      return target
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}

async function writeAtomic(target: string, text: string, mode: number | null): Promise<void> {
  const temporary = `${target}.legacy-cleanup-${process.pid}.tmp`
  await fs.writeFile(temporary, text, 'utf8')
  try {
    await fs.rename(temporary, target)
  } catch (error) {
    await fs.rm(temporary, { force: true })
    throw error
  }
  if (mode !== null) await fs.chmod(target, mode).catch(() => undefined)
}

/** Unlink a link or junction; Windows needs rmdir for junctions it refuses to unlink. */
async function unlinkLink(target: string): Promise<void> {
  try {
    await fs.unlink(target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (process.platform === 'win32' && (code === 'EPERM' || code === 'EISDIR' || code === 'EACCES')) {
      await fs.rmdir(target)
      return
    }
    throw error
  }
}

/** Remove a symlink or Windows junction without ever following it. */
async function removeLink(target: string): Promise<void> {
  let info
  try {
    info = await fs.lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!info.isSymbolicLink()) throw new Error(`refusing to remove a non-link: ${target}`)
  await unlinkLink(target)
}

async function backupFile(change: FileChange, backupDir: string): Promise<BackupManifest['items'][number]> {
  const current = await fs.readFile(change.path, 'utf8')
  if (current !== change.originalText) {
    throw new Error(`${change.relativePath} changed after the plan was made; run plan again`)
  }
  const info = await fs.stat(change.path)
  const destination = path.join(backupDir, 'files', ...change.relativePath.split('/'))
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.copyFile(change.path, destination)
  return { kind: 'file', path: change.relativePath, mode: info.mode & 0o7777 }
}

async function backupSymlink(change: SymlinkChange): Promise<BackupManifest['items'][number]> {
  const info = await fs.lstat(change.path)
  if (!info.isSymbolicLink()) throw new Error(`${change.relativePath} is no longer a link; run plan again`)
  const current = await fs.readlink(change.path)
  if (current !== change.target) {
    throw new Error(`${change.relativePath} changed after the plan was made; run plan again`)
  }
  // Nothing to copy: the manifest itself is the backup for a link.
  return { kind: 'symlink', path: change.relativePath, target: change.target }
}

/** Apply a plan. Returns null as the backup directory when there is nothing to do. */
export async function applyPlan(plan: CleanupPlan, options: {
  readonly brainHome: string
  readonly now?: Date
}): Promise<ApplyResult> {
  const brainHome = path.resolve(options.brainHome)
  if (isPathInside(brainHome, plan.dshHome)) {
    throw new Error(`BRAIN_HOME (${brainHome}) must not be inside the DSH home (${plan.dshHome})`)
  }
  if (plan.changes.length === 0) return { backupDir: null, applied: 0 }

  const root = path.join(brainHome, 'state', 'legacy-cleanup')
  await fs.mkdir(root, { recursive: true })
  const backupDir = await createBackupDirectory(root, timestampDirectory(options.now ?? new Date()))

  const items: BackupManifest['items'][number][] = []
  for (const change of plan.changes) {
    items.push(change.kind === 'file-edit'
      ? await backupFile(change, backupDir)
      : await backupSymlink(change))
  }
  const manifest: BackupManifest = {
    version: 1,
    createdAt: (options.now ?? new Date()).toISOString(),
    dshHome: plan.dshHome,
    items,
  }
  await fs.writeFile(path.join(backupDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  for (const change of plan.changes) {
    if (change.kind === 'file-edit') {
      const mode = items.find(item => item.kind === 'file' && item.path === change.relativePath)
      await writeAtomic(change.path, change.nextText, mode?.kind === 'file' ? mode.mode : null)
    } else {
      await removeLink(change.path)
    }
  }

  return { backupDir, applied: plan.changes.length }
}

function assertManifest(value: unknown): BackupManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('backup manifest is not an object')
  const manifest = value as Partial<BackupManifest>
  if (manifest.version !== 1) throw new Error(`unsupported backup manifest version: ${String(manifest.version)}`)
  if (typeof manifest.createdAt !== 'string' || typeof manifest.dshHome !== 'string' || !Array.isArray(manifest.items)) {
    throw new Error('backup manifest is incomplete')
  }
  for (const item of manifest.items) {
    if (item === null || typeof item !== 'object' || typeof item.path !== 'string') {
      throw new Error('backup manifest has an invalid item')
    }
    if (item.kind === 'file') {
      if (typeof item.mode !== 'number') throw new Error(`backup item ${item.path} has no mode`)
    } else if (item.kind === 'symlink') {
      if (typeof item.target !== 'string') throw new Error(`backup item ${item.path} has no target`)
    } else {
      throw new Error(`backup item ${item.path} has an unknown kind`)
    }
  }
  return manifest as BackupManifest
}

export async function readManifest(backupDirInput: string): Promise<BackupManifest> {
  const backupDir = path.resolve(backupDirInput)
  const text = await fs.readFile(path.join(backupDir, 'manifest.json'), 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`cannot parse ${path.join(backupDir, 'manifest.json')}: ${(error as Error).message}`, { cause: error })
  }
  return assertManifest(parsed)
}

/** Restore every file and link recorded in a backup. */
export async function restoreBackup(backupDirInput: string, dshHomeInput: string): Promise<{ restored: string[] }> {
  const backupDir = path.resolve(backupDirInput)
  const dshHome = path.resolve(dshHomeInput)
  const manifest = await readManifest(backupDir)
  const restored: string[] = []

  // Restore shallower links first: a profile's node_modules link points at
  // plugins/<bundle>, and Windows junctions are happiest when the target exists.
  const items = [...manifest.items].sort((left, right) => left.path.split('/').length - right.path.split('/').length)
  for (const item of items) {
    const target = fromPosixRelative(dshHome, item.path)
    if (item.kind === 'file') {
      const source = path.join(backupDir, 'files', ...item.path.split('/'))
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.copyFile(source, target)
      await fs.chmod(target, item.mode).catch(() => undefined)
    } else {
      let existing
      try {
        existing = await fs.lstat(target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        existing = null
      }
      if (existing !== null) {
        if (!existing.isSymbolicLink()) {
          throw new Error(`refusing to overwrite ${item.path}: it is no longer a symlink`)
        }
        await unlinkLink(target)
      }
      await fs.mkdir(path.dirname(target), { recursive: true })
      const junctionTarget = process.platform === 'win32' ? item.target.replace(/^\\\\\?\\/, '') : item.target
      await fs.symlink(junctionTarget, target, process.platform === 'win32' ? 'junction' : 'dir')
    }
    restored.push(item.path)
  }

  return { restored }
}
