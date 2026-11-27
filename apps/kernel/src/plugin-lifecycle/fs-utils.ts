import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readdir, readFile, readlink, stat } from 'node:fs/promises'
import path from 'node:path'
import { BrainError, validateManifest, type BrainManifest } from '@brain-core/sdk'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function invalidArgument(message: string, details: Readonly<Record<string, unknown>> = {}): BrainError {
  return new BrainError('INVALID_ARGUMENT', message, details)
}

export function notFound(message: string): BrainError {
  return new BrainError('NOT_FOUND', message)
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** `target` must stay inside `root`; returns the absolute path. */
export function resolveInside(root: string, target: string, field: string): string {
  const absoluteRoot = path.resolve(root)
  const resolved = path.resolve(absoluteRoot, target)
  const relative = path.relative(absoluteRoot, resolved)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw invalidArgument(`${field} must point inside the plugin directory`, { field })
  }
  return resolved
}

/** Copies a package directory, leaving build caches and VCS data behind. */
export async function copyPackage(src: string, dest: string): Promise<void> {
  const skip = new Set(['node_modules', '.git'])
  await cp(src, dest, {
    recursive: true,
    force: true,
    filter: (source) => source === src || !skip.has(path.basename(source)),
  })
}

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

const EMPTY_SKIP: ReadonlySet<string> = new Set()

/** SHA-256 over sorted relative paths and file bytes, so identical trees give identical hashes. */
export async function contentHash8(root: string, skipNames: ReadonlySet<string> = EMPTY_SKIP): Promise<string> {
  const hash = createHash('sha256')
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => byName(a.name, b.name))
    for (const entry of entries) {
      if (skipNames.has(entry.name)) continue
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        hash.update(`d:${relative}\0`)
        await walk(full, relative)
      } else if (entry.isSymbolicLink()) {
        hash.update(`l:${relative}\0${await readlink(full)}\0`)
      } else {
        hash.update(`f:${relative}\0`)
        hash.update(await readFile(full))
        hash.update('\0')
      }
    }
  }
  await walk(root, '')
  return hash.digest('hex').slice(0, 8)
}

export interface PackageJson {
  readonly raw: Record<string, unknown>
  readonly manifest: BrainManifest
  readonly version: string
  readonly main?: string
}

/** Reads package.json and its `brain` manifest; the manifest may still be absent, callers say why. */
export async function readPackageJson(dir: string): Promise<Record<string, unknown>> {
  const file = path.join(dir, 'package.json')
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    throw invalidArgument('package.json is missing', { file: 'package.json' })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw invalidArgument('package.json is not valid JSON', { file: 'package.json' })
  }
  if (!isRecord(parsed)) throw invalidArgument('package.json must be an object', { file: 'package.json' })
  return parsed
}

export function manifestOf(pkg: Record<string, unknown>): BrainManifest {
  const result = validateManifest(pkg.brain)
  if (!result.ok) throw invalidArgument('invalid plugin manifest', { errors: result.errors })
  return result.manifest
}

/** The version must be safe to use as one path segment. */
export function versionOf(pkg: Record<string, unknown>): string {
  const version = pkg.version
  if (typeof version !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) {
    throw invalidArgument('package.json version must be a simple version string', { field: 'version' })
  }
  return version
}

export function mainOf(pkg: Record<string, unknown>): string | undefined {
  return typeof pkg.main === 'string' && pkg.main !== '' ? pkg.main : undefined
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}
