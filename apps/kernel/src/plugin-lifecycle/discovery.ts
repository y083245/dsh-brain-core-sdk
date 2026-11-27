import type { Dirent } from 'node:fs'
import { lstat, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { apiMajor, PLUGIN_API_VERSION, type BrainManifest } from '@brain-core/sdk'
import type { Logger } from '../log/index.ts'
import {
  contentHash8, invalidArgument, isRecord, mainOf, manifestOf, pathExists, resolveInside, versionOf,
} from './fs-utils.ts'

export const WORKSPACE_SKIP_NAMES: ReadonlySet<string> = new Set(['node_modules', '.git'])

export interface DiscoveredPlugin {
  readonly id: string
  readonly dir: string
  readonly dirName: string
  readonly version: string
  readonly sha8: string
  readonly manifest: BrainManifest
}

const CURRENT_MAJOR = Number(PLUGIN_API_VERSION.split('.')[0])

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function defaultWorkspacePluginsDir(sdkDir: string): string {
  return path.resolve(sdkDir, '..', '..', 'plugins')
}

export function resolveWorkspacePluginsDir(options: {
  readonly workspacePluginsDir?: string | null
  readonly env: NodeJS.ProcessEnv
  readonly sdkDir: string
}): string | undefined {
  if (options.workspacePluginsDir === null) return undefined
  if (typeof options.workspacePluginsDir === 'string') {
    const trimmed = options.workspacePluginsDir.trim()
    return trimmed === '' ? undefined : path.resolve(trimmed)
  }
  if (typeof options.env.BRAIN_PLUGINS_DIR === 'string') {
    const trimmed = options.env.BRAIN_PLUGINS_DIR.trim()
    return trimmed === '' ? undefined : path.resolve(trimmed)
  }
  return defaultWorkspacePluginsDir(options.sdkDir)
}

async function assertNoWorkspaceSymlinks(root: string): Promise<void> {
  async function walk(dir: string, prefix: string): Promise<void> {
    const names = (await readdir(dir)).sort(byName)
    for (const name of names) {
      if (WORKSPACE_SKIP_NAMES.has(name)) continue
      const full = path.join(dir, name)
      const relative = prefix === '' ? name : `${prefix}/${name}`
      const info = await lstat(full)
      if (info.isSymbolicLink()) {
        throw invalidArgument('plugin packages must not contain symbolic links', { file: relative })
      }
      if (info.isDirectory()) {
        await walk(full, relative)
      }
    }
  }
  await walk(root, '')
}

async function readCandidatePackage(dir: string): Promise<Record<string, unknown> | undefined> {
  let text: string
  try {
    text = await readFile(path.join(dir, 'package.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw invalidArgument('package.json is not valid JSON', { file: 'package.json' })
  }
  if (!isRecord(parsed)) throw invalidArgument('package.json must be an object', { file: 'package.json' })
  if (parsed.brain === undefined) return undefined
  return parsed
}

async function inspectCandidate(entryName: string, dir: string): Promise<DiscoveredPlugin | undefined> {
  const pkg = await readCandidatePackage(dir)
  if (pkg === undefined) return undefined

  await assertNoWorkspaceSymlinks(dir)

  const manifest = manifestOf(pkg)
  const major = apiMajor(manifest.api)
  if (major === null || (major !== CURRENT_MAJOR && major !== CURRENT_MAJOR - 1)) {
    throw invalidArgument(`plugin api ${manifest.api} is not compatible with kernel api ${PLUGIN_API_VERSION}`, { field: 'api' })
  }
  const version = versionOf(pkg)
  if (manifest.runtime === 'node') {
    const main = mainOf(pkg)
    if (main === undefined) throw invalidArgument('runtime node needs a main entry', { field: 'main' })
    const entryFile = resolveInside(dir, main, 'main')
    if (!(await pathExists(entryFile))) {
      throw invalidArgument('runtime node main entry does not exist', { field: 'main' })
    }
  }

  const sha8 = await contentHash8(dir, WORKSPACE_SKIP_NAMES)
  return {
    id: manifest.id,
    dir,
    dirName: entryName,
    version,
    sha8,
    manifest,
  }
}

export async function discoverWorkspacePlugins(
  rootDir: string,
  options?: { readonly log?: Logger },
): Promise<readonly DiscoveredPlugin[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(rootDir, { withFileTypes: true })
  } catch {
    return []
  }
  entries.sort((a, b) => byName(a.name, b.name))

  const seenIds = new Set<string>()
  const discovered: DiscoveredPlugin[] = []

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue

    const dir = path.join(rootDir, entry.name)
    try {
      const item = await inspectCandidate(entry.name, dir)
      if (item === undefined) continue
      if (seenIds.has(item.id)) {
        options?.log?.warn('plugin.discovery.duplicate_id', { plugin: item.id })
        continue
      }
      seenIds.add(item.id)
      discovered.push(item)
    } catch {
      options?.log?.warn('plugin.discovery.invalid', { plugin: entry.name })
    }
  }

  discovered.sort((a, b) => byName(a.id, b.id))
  return discovered
}
