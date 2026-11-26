/** Read a DSH home and describe every legacy entry that should disappear. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { LEGACY_BUNDLES, planCordisPatch } from './cordis-patch.ts'
import { planPackageJson } from './package-json.ts'
import { displayPath, toPosixRelative } from './paths.ts'
import type { CleanupPlan, FileChange, ManualItem, SymlinkChange } from './types.ts'

/** Only the two DSH profiles the old bridge ever touched. */
export const LEGACY_PROFILES = ['web', 'desktop'] as const

async function lstatOrNull(target: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw error
  }
}

async function isDirectory(target: string): Promise<boolean> {
  const info = await lstatOrNull(target)
  return info?.isDirectory() === true
}

/**
 * Profile names other than web/desktop that still link to a legacy bundle.
 * Only the directory names and `node_modules/<bundle>` links are inspected;
 * other profiles' files are never read.
 */
async function profilesStillUsingBundles(dshHome: string): Promise<Map<string, string[]>> {
  const usage = new Map<string, string[]>()
  const profilesDir = path.join(dshHome, 'profiles')
  let entries
  try {
    entries = await fs.readdir(profilesDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return usage
    throw error
  }
  const known = new Set<string>(LEGACY_PROFILES)
  for (const entry of entries) {
    if (!entry.isDirectory() || known.has(entry.name)) continue
    for (const bundle of LEGACY_BUNDLES) {
      if (await lstatOrNull(path.join(profilesDir, entry.name, 'node_modules', bundle)) === null) continue
      const profiles = usage.get(bundle) ?? []
      profiles.push(entry.name)
      usage.set(bundle, profiles)
    }
  }
  return usage
}

function linkTarget(linkPath: string, target: string): string {
  return path.isAbsolute(target) ? target : path.resolve(path.dirname(linkPath), target)
}

function normalizedLinkPath(target: string): string {
  const withoutPrefix = target.replace(/^\\\\\?\\/, '')
  return process.platform === 'win32' ? withoutPrefix.toLowerCase() : withoutPrefix
}

/** Plan one `plugins/<bundle>` or `<profile>/node_modules/<bundle>` link. */
async function planBundleLink(options: {
  readonly linkPath: string
  readonly dshHome: string
  readonly expectTarget: string | null
  readonly label: string
}): Promise<{ change: SymlinkChange | null; manual: ManualItem | null }> {
  const info = await lstatOrNull(options.linkPath)
  if (info === null) return { change: null, manual: null }
  const relativePath = toPosixRelative(options.dshHome, options.linkPath)
  if (!info.isSymbolicLink()) {
    return {
      change: null,
      manual: {
        path: options.linkPath,
        relativePath,
        reason: `${options.label} exists but is not a symlink or junction; left untouched`,
      },
    }
  }
  const target = await fs.readlink(options.linkPath)
  if (options.expectTarget !== null
    && normalizedLinkPath(linkTarget(options.linkPath, target)) !== normalizedLinkPath(options.expectTarget)) {
    return {
      change: null,
      manual: {
        path: options.linkPath,
        relativePath,
        reason: `${options.label} points to ${displayPath(target)}, not ${displayPath(options.expectTarget)}; left untouched`,
      },
    }
  }
  return {
    change: {
      kind: 'symlink-remove',
      path: options.linkPath,
      relativePath,
      target,
      removals: [`${options.label} (${displayPath(target)})`],
    },
    manual: null,
  }
}

/** Build a read-only plan for one DSH home. */
export async function buildPlan(dshHomeInput: string): Promise<CleanupPlan> {
  const dshHome = path.resolve(dshHomeInput)
  let info
  try {
    info = await fs.stat(dshHome)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`DSH home does not exist: ${dshHome}`, { cause: error })
    throw error
  }
  if (!info.isDirectory()) throw new Error(`DSH home is not a directory: ${dshHome}`)

  const changes: Array<FileChange | SymlinkChange> = []
  const manual: ManualItem[] = []

  for (const profile of LEGACY_PROFILES) {
    const profileDir = path.join(dshHome, 'profiles', profile)
    if (!(await isDirectory(profileDir))) continue

    const packageFile = path.join(profileDir, 'package.json')
    const packageText = await fs.readFile(packageFile, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (packageText !== null) {
      const plan = planPackageJson(packageText, { dshHome, bundleNames: LEGACY_BUNDLES })
      const relativePath = toPosixRelative(dshHome, packageFile)
      for (const reason of plan.manual) {
        manual.push({ path: packageFile, relativePath, reason })
      }
      if (plan.nextText !== null) {
        changes.push({
          kind: 'file-edit',
          path: packageFile,
          relativePath,
          originalText: packageText,
          nextText: plan.nextText,
          removals: plan.removals,
        })
      }
    }

    const patchFile = path.join(profileDir, 'cordis.patch.yml')
    const patchText = await fs.readFile(patchFile, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (patchText !== null) {
      const plan = planCordisPatch(patchText)
      const relativePath = toPosixRelative(dshHome, patchFile)
      for (const reason of plan.manual) {
        manual.push({ path: patchFile, relativePath, reason })
      }
      if (plan.nextText !== null) {
        changes.push({
          kind: 'file-edit',
          path: patchFile,
          relativePath,
          originalText: patchText,
          nextText: plan.nextText,
          removals: plan.removals,
        })
      }
    }

    for (const bundle of LEGACY_BUNDLES) {
      const result = await planBundleLink({
        linkPath: path.join(profileDir, 'node_modules', bundle),
        dshHome,
        expectTarget: path.join(dshHome, 'plugins', bundle),
        label: `node_modules link "${bundle}" in profile ${profile}`,
      })
      if (result.change !== null) changes.push(result.change)
      if (result.manual !== null) manual.push(result.manual)
    }
  }

  const usage = await profilesStillUsingBundles(dshHome)
  for (const bundle of LEGACY_BUNDLES) {
    const pluginPath = path.join(dshHome, 'plugins', bundle)
    const users = usage.get(bundle) ?? []
    if (users.length > 0) {
      const relativePath = toPosixRelative(dshHome, pluginPath)
      const who = users.map(profile => `"${profile}"`).join(', ')
      const exists = (await lstatOrNull(pluginPath)) !== null
      manual.push({
        path: pluginPath,
        relativePath,
        reason: exists
          ? `profile ${who} still uses node_modules/${bundle}; plugins/${bundle} kept`
          : `profile ${who} still has node_modules/${bundle}, but plugins/${bundle} is already missing`,
      })
      continue
    }
    const result = await planBundleLink({
      linkPath: pluginPath,
      dshHome,
      expectTarget: null,
      label: `bundle link "${bundle}"`,
    })
    if (result.change !== null) changes.push(result.change)
    if (result.manual !== null) manual.push(result.manual)
  }

  return { dshHome, changes, manual }
}
