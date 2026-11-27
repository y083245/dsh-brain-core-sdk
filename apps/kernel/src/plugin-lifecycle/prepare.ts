import { lstat, mkdtemp, readdir, rename, rmdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { apiMajor, BrainError, PLUGIN_API_VERSION, type BrainManifest } from '@dsh-brain-core/sdk'
import { removeTree } from '@dsh-brain-core/satellite-host'
import type { Logger } from '../log/index.ts'
import type { RunCommand } from './types.ts'
import {
  contentHash8, copyPackage, ensureDir, invalidArgument, isDirectory, isRecord, mainOf, manifestOf, pathExists,
  readPackageJson, resolveInside, versionOf,
} from './fs-utils.ts'

export interface PrepareDeps {
  readonly pluginsDir: string
  readonly sdkDir: string
  readonly brainPackages?: Readonly<Record<string, string>>
  readonly run: RunCommand
  readonly log: Logger
}

export interface PreparedPackage {
  readonly id: string
  readonly version: string
  readonly sha8: string
  readonly dir: string
  readonly manifest: BrainManifest
  /** True only when this call created `dir`; a reused directory must never be deleted by the caller. */
  readonly created: boolean
}

const CURRENT_MAJOR = Number(PLUGIN_API_VERSION.split('.')[0])
const BRAIN_SCOPE_PREFIX = '@dsh-brain-core/'
const PUBLIC_BRAIN_PACKAGES: ReadonlySet<string> = new Set(['chat-kit'])

/** A path on disk: relative, absolute, a drive letter, or an existing directory. Anything else is an npm/git spec. */
async function isLocalSpec(spec: string): Promise<boolean> {
  if (spec.startsWith('.')) return true
  if (path.isAbsolute(spec)) return true
  if (path.win32.isAbsolute(spec)) return true
  return isDirectory(spec)
}

async function packArchive(deps: PrepareDeps, spec: string, tmp: string): Promise<void> {
  await deps.run('npm', ['pack', '--ignore-scripts', spec, '--pack-destination', tmp], { cwd: tmp })
  const archives = (await readdir(tmp)).filter((name) => name.endsWith('.tgz')).sort()
  const archive = archives[0]
  if (archive === undefined) throw new BrainError('UNAVAILABLE', 'npm pack produced no archive')
  await deps.run('tar', ['-xzf', path.join(tmp, archive), '-C', tmp], { cwd: tmp })
}

async function assertCompatible(manifest: BrainManifest, pkg: Record<string, unknown>): Promise<void> {
  const major = apiMajor(manifest.api)
  if (major === null || (major !== CURRENT_MAJOR && major !== CURRENT_MAJOR - 1)) {
    throw invalidArgument(`plugin api ${manifest.api} is not compatible with kernel api ${PLUGIN_API_VERSION}`, { field: 'api' })
  }
  if (manifest.runtime === 'node') {
    const main = mainOf(pkg)
    if (main === undefined) throw invalidArgument('runtime node needs a main entry', { field: 'main' })
  }
}

/** Removes the kernel's own packages from the dependency list before npm touches the tree. */
async function installDependencies(deps: PrepareDeps, dir: string): Promise<void> {
  const pkg = await readPackageJson(dir)
  const dependencies = isRecord(pkg.dependencies) ? pkg.dependencies : undefined
  const strippedBrainPackages: string[] = []
  let remaining = 0
  if (dependencies !== undefined) {
    const kept: Record<string, unknown> = {}
    for (const [name, range] of Object.entries(dependencies)) {
      if (name.startsWith(BRAIN_SCOPE_PREFIX)) {
        const shortName = name.slice(BRAIN_SCOPE_PREFIX.length)
        if (shortName.length > 0) strippedBrainPackages.push(shortName)
        continue
      }
      kept[name] = range
    }
    remaining = Object.keys(kept).length
    if (remaining === 0) delete pkg.dependencies
    else pkg.dependencies = kept
    await writeFile(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  }
  if (remaining > 0) {
    await deps.run('npm', ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], { cwd: dir })
  }

  // A junction needs no administrator on Windows and resolves to the kernel's own SDK on every platform.
  const linkParent = path.join(dir, 'node_modules', '@dsh-brain-core')
  await ensureDir(linkParent)
  await symlink(path.resolve(deps.sdkDir), path.join(linkParent, 'sdk'), 'junction')

  for (const pkgName of strippedBrainPackages) {
    if (!PUBLIC_BRAIN_PACKAGES.has(pkgName)) continue
    const target = deps.brainPackages?.[pkgName] ?? path.join(path.dirname(path.resolve(deps.sdkDir)), pkgName)
    if (!(await isDirectory(target))) {
      throw new BrainError('UNAVAILABLE', `public brain package @dsh-brain-core/${pkgName} directory is unavailable`)
    }
    await symlink(path.resolve(target), path.join(linkParent, pkgName), 'junction')
  }
}

async function installPython(deps: PrepareDeps, dir: string): Promise<void> {
  if (await pathExists(path.join(dir, 'pyproject.toml'))) {
    await deps.run('uv', ['sync', '--no-dev'], { cwd: dir })
  }
}

/**
 * A symlink could point outside the package, making `resolveInside` approve a main that lives elsewhere.
 * Our own `node_modules/@dsh-brain-core/sdk` link is created later, so a genuine package has none.
 */
async function assertNoSymlinks(root: string): Promise<void> {
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const name of (await readdir(dir)).sort()) {
      const full = path.join(dir, name)
      const relative = prefix === '' ? name : `${prefix}/${name}`
      const info = await lstat(full)
      if (info.isSymbolicLink()) {
        throw invalidArgument('plugin packages must not contain symbolic links', { file: relative })
      }
      if (info.isDirectory()) await walk(full, relative)
    }
  }
  await walk(root, '')
}

/**
 * Steps 1–7 of install: unpack (or copy), validate, hash, move into .installed, install dependencies and link the SDK.
 * A new directory is only left behind on success.
 */
export async function preparePackage(deps: PrepareDeps, spec: string, expectedId?: string): Promise<PreparedPackage> {
  // Otherwise npm would read it as an option such as --registry=...
  if (spec.startsWith('-')) throw invalidArgument('the package spec must not start with a dash', { field: 'spec' })
  await ensureDir(deps.pluginsDir)
  const tmp = await mkdtemp(path.join(deps.pluginsDir, '.tmp-'))
  let destination: string | undefined
  try {
    const packageDir = path.join(tmp, 'package')
    if (await isLocalSpec(spec)) {
      const source = path.resolve(spec)
      if (!(await isDirectory(source))) throw invalidArgument('the local plugin path is not a directory', { field: 'spec' })
      await copyPackage(source, packageDir)
    } else {
      await packArchive(deps, spec, tmp)
    }
    if (!(await isDirectory(packageDir))) throw invalidArgument('the plugin package has no package/ directory', { field: 'spec' })
    await assertNoSymlinks(packageDir)

    const pkg = await readPackageJson(packageDir)
    const manifest = manifestOf(pkg)
    await assertCompatible(manifest, pkg)
    if (manifest.runtime === 'node') {
      const main = resolveInside(packageDir, mainOf(pkg) ?? '', 'main')
      if (!(await pathExists(main))) throw invalidArgument('runtime node main entry does not exist', { field: 'main' })
    }
    if (expectedId !== undefined && manifest.id !== expectedId) {
      throw invalidArgument(`package id ${manifest.id} is not ${expectedId}`, { field: 'id' })
    }

    const version = versionOf(pkg)
    const sha8 = await contentHash8(packageDir)
    const dir = path.join(deps.pluginsDir, '.installed', manifest.id, `${version}-${sha8}`)
    if (await pathExists(dir)) {
      // Identical contents were prepared before; reuse that tree instead of replacing a possibly running copy.
      deps.log.info('plugin.unpacked', { plugin: manifest.id })
      return { id: manifest.id, version, sha8, dir, manifest, created: false }
    }
    await ensureDir(path.dirname(dir))
    await rename(packageDir, dir)
    destination = dir

    await installDependencies(deps, dir)
    await installPython(deps, dir)

    deps.log.info('plugin.unpacked', { plugin: manifest.id })
    return { id: manifest.id, version, sha8, dir, manifest, created: true }
  } catch (error) {
    if (destination !== undefined) {
      try { await removeTree(destination) } catch { /* the original error wins */ }
      try { await rmdir(path.dirname(destination)) } catch { /* another version is still there */ }
      try { await rmdir(path.dirname(path.dirname(destination))) } catch { /* another plugin is still there */ }
    }
    throw error
  } finally {
    try { await removeTree(tmp) } catch { /* already renamed, or nothing to remove */ }
  }
}
