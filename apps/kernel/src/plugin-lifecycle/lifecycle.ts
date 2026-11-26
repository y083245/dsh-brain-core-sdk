import { cp, readdir, rmdir } from 'node:fs/promises'
import path from 'node:path'
import { BrainError, type BrainManifest } from '@brain-core/sdk'
import { removeTree } from '@brain-core/satellite-host'
import type { InstalledPlugin } from '../contracts/index.ts'
import { readConfig, validateConfig, writeConfig } from './config.ts'
import { ensureDir, invalidArgument, manifestOf, notFound, pathExists, readPackageJson } from './fs-utils.ts'
import { runMigrations } from './migrations.ts'
import { preparePackage } from './prepare.ts'
import { readRegistry, writeRegistry, type InstalledRef, type Registry, type RegistryEntry } from './registry.ts'
import type { InstallPreview, PluginEntry, PluginLifecycle, PluginLifecycleDeps } from './types.ts'

function requireEntry(registry: Registry, id: string): RegistryEntry {
  const entry = registry.plugins[id]
  if (entry === undefined) throw notFound(`plugin ${id} is not installed`)
  return entry
}

function byId(a: RegistryEntry, b: RegistryEntry): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function timeOf(name: string): number {
  const match = /^(\d+)/.exec(name)
  return match === null ? -1 : Number(match[1])
}

function sameRef(a: InstalledRef, b: InstalledRef): boolean {
  return a.version === b.version && a.sha8 === b.sha8
}

/** Whether any plugin still uses this unpacked copy. */
function isReferenced(registry: Registry, ref: InstalledRef): boolean {
  return Object.values(registry.plugins).some((entry) => sameRef(entry.current, ref)
    || (entry.previous !== undefined && sameRef(entry.previous, ref))
    || (entry.pendingUpgrade !== undefined && sameRef(entry.pendingUpgrade, ref)))
}

export function createPluginLifecycle(deps: PluginLifecycleDeps): PluginLifecycle {
  const pluginsDir = path.resolve(deps.pluginsDir)
  const sdkDir = path.resolve(deps.sdkDir)
  const prepareDeps = { pluginsDir, sdkDir, brainPackages: deps.brainPackages, run: deps.run, log: deps.log }
  const registryFile = path.join(pluginsDir, 'registry.json')

  function installedDir(id: string, ref: InstalledRef): string {
    return path.join(pluginsDir, '.installed', id, `${ref.version}-${ref.sha8}`)
  }

  function dataDir(id: string): string {
    return path.join(pluginsDir, id)
  }

  /** Removes an unpacked copy, but only one no registry entry points at any more. */
  async function removeIfUnreferenced(registry: Registry, id: string, ref: InstalledRef): Promise<void> {
    if (isReferenced(registry, ref)) return
    const dir = installedDir(id, ref)
    try {
      await removeTree(dir)
      try { await rmdir(path.dirname(dir)) } catch { /* another version is still there */ }
      try { await rmdir(path.dirname(path.dirname(dir))) } catch { /* another plugin is still there */ }
    } catch {
      /* leave the unused copy behind; it is harmless */
    }
  }

  function backupRoot(id: string): string {
    return path.join(pluginsDir, '.backups', id)
  }

  async function manifestIn(dir: string): Promise<BrainManifest> {
    return manifestOf(await readPackageJson(dir))
  }

  async function installedPlugin(id: string, entry: RegistryEntry, manifest: BrainManifest): Promise<InstalledPlugin> {
    const dir = installedDir(id, entry.current)
    const config = await readConfig(dir, manifest, dataDir(id))
    return { manifest, version: entry.current.version, dir, granted: [...entry.granted], config }
  }

  function previewOf(manifest: BrainManifest, version: string, granted: readonly string[]): InstallPreview {
    const permissions = [...manifest.permissions]
    return {
      id: manifest.id,
      version,
      permissions,
      newPermissions: permissions.filter((permission) => !granted.includes(permission)),
      warnings: [...deps.coreWarnings(manifest)],
    }
  }

  async function pruneBackups(id: string): Promise<void> {
    const root = backupRoot(id)
    let names: string[]
    try {
      names = (await readdir(root)).sort((a, b) => timeOf(a) - timeOf(b) || (a < b ? -1 : a > b ? 1 : 0))
    } catch {
      return
    }
    while (names.length > 3) {
      const oldest = names.shift()
      if (oldest === undefined) break
      await removeTree(path.join(root, oldest))
    }
  }

  /** One timestamped copy of the plugin's private directory; at most three are kept. */
  async function backupData(id: string): Promise<string> {
    const root = backupRoot(id)
    await ensureDir(root)
    const base = String(deps.clock.now())
    let name = base
    for (let counter = 1; ; counter += 1) {
      if (!(await pathExists(path.join(root, name)))) break
      name = `${base}-${counter}`
    }
    const dest = path.join(root, name)
    const source = dataDir(id)
    if (await pathExists(source)) await cp(source, dest, { recursive: true, force: true })
    else await ensureDir(dest)
    await pruneBackups(id)
    return dest
  }

  async function restoreData(id: string, backup: string): Promise<void> {
    await removeTree(dataDir(id))
    await cp(backup, dataDir(id), { recursive: true, force: true })
  }

  async function migrate(id: string, dir: string, manifest: BrainManifest): Promise<void> {
    await runMigrations({
      id,
      dir,
      manifest,
      dataDir: dataDir(id),
      deps: { storage: deps.storageFor(id), logger: deps.loggerFor(id) },
    })
  }

  /**
   * disable → backup → point at the new version → migrate → enable.
   * Only a plugin that was enabled is disabled and enabled again; any other state ends at `disabled`.
   * Any failure puts the old directory and the old registry entry back, re-enabling the old version
   * only when it was enabled before. A directory this call created is removed if nothing points at it.
   */
  async function completeUpgrade(
    registry: Registry,
    entry: RegistryEntry,
    ref: InstalledRef,
    manifest: BrainManifest,
    newDir: string,
    created: boolean,
    approved: readonly string[] = manifest.permissions,
  ): Promise<void> {
    const id = entry.id
    const wasEnabled = entry.state === 'enabled'
    const oldEntry: RegistryEntry = structuredClone(entry)
    const oldDir = installedDir(id, oldEntry.current)
    const oldManifest = await manifestIn(oldDir)
    const oldPlugin = await installedPlugin(id, oldEntry, oldManifest)

    if (wasEnabled) await deps.activator.disable(id)
    entry.state = 'disabled'
    await writeRegistry(registryFile, registry)

    let backup: string | undefined
    try {
      backup = await backupData(id)
      entry.current = { version: ref.version, sha8: ref.sha8 }
      entry.previous = oldEntry.current
      entry.granted = [...approved]
      delete entry.pendingUpgrade
      await writeRegistry(registryFile, registry)

      await migrate(id, newDir, manifest)
      if (wasEnabled) {
        const next = await installedPlugin(id, entry, manifest)
        await deps.activator.enable(next)
        entry.state = 'enabled'
      }
      await writeRegistry(registryFile, registry)
    } catch (error) {
      if (wasEnabled) {
        try { await deps.activator.disable(id) } catch { /* not enabled */ }
      }
      if (backup !== undefined) {
        try {
          await restoreData(id, backup)
        } catch {
          deps.log.error('plugin.rollback.restore-failed', { plugin: id })
        }
      }
      entry.state = oldEntry.state
      entry.current = oldEntry.current
      entry.previous = oldEntry.previous
      entry.granted = [...oldEntry.granted]
      if (oldEntry.pendingUpgrade === undefined) delete entry.pendingUpgrade
      else entry.pendingUpgrade = oldEntry.pendingUpgrade
      let persisted = false
      try {
        await writeRegistry(registryFile, registry)
        persisted = true
      } catch {
        /* the original error wins */
      }
      if (wasEnabled) {
        try {
          await deps.activator.enable(oldPlugin)
        } catch {
          deps.log.error('plugin.rollback.enable-failed', { plugin: id })
        }
      }
      // A reused directory may belong to `previous`; only a copy this call created and nothing points at goes away.
      if (created && persisted) await removeIfUnreferenced(registry, id, ref)
      throw error
    }

    // A pending upgrade this one superseded no longer needs its unpacked copy.
    if (oldEntry.pendingUpgrade !== undefined) {
      await removeIfUnreferenced(registry, id, oldEntry.pendingUpgrade)
    }
  }

  async function install(spec: string): Promise<InstallPreview> {
    // Fail before unpacking anything when the registry is malformed; it must never be overwritten.
    await readRegistry(registryFile)
    const prepared = await preparePackage(prepareDeps, spec)
    const registry = await readRegistry(registryFile)
    const existing = registry.plugins[prepared.id]
    if (existing !== undefined) {
      // A reused directory may belong to the installed entry or a pending upgrade; only a fresh copy goes away.
      if (prepared.created) {
        await removeIfUnreferenced(registry, prepared.id, { version: prepared.version, sha8: prepared.sha8 })
      }
      throw new BrainError('CONFLICT', `plugin ${prepared.id} is already installed; use upgrade or uninstall`)
    }
    registry.plugins[prepared.id] = {
      id: prepared.id,
      state: 'pending',
      current: { version: prepared.version, sha8: prepared.sha8 },
      granted: [],
    }
    await writeRegistry(registryFile, registry)
    deps.log.info('plugin.installed', { plugin: prepared.id })
    return previewOf(prepared.manifest, prepared.version, [])
  }

  async function confirm(id: string): Promise<void> {
    const registry = await readRegistry(registryFile)
    const entry = requireEntry(registry, id)
    const pending = entry.pendingUpgrade
    if (pending !== undefined) {
      const dir = installedDir(id, pending)
      const manifest = await manifestIn(dir)
      // The directory was unpacked by the earlier upgrade() call, so this call must never delete it.
      await completeUpgrade(registry, entry, { version: pending.version, sha8: pending.sha8 }, manifest, dir, false, pending.permissions)
      deps.log.info('plugin.upgrade.confirmed', { plugin: id })
      return
    }
    if (entry.state !== 'pending') throw invalidArgument(`plugin ${id} is not waiting for confirmation`)
    const dir = installedDir(id, entry.current)
    const manifest = await manifestIn(dir)
    entry.granted = [...manifest.permissions]
    entry.state = 'disabled'
    await migrate(id, dir, manifest)
    await writeRegistry(registryFile, registry)
    deps.log.info('plugin.confirmed', { plugin: id })
  }

  async function enable(id: string): Promise<void> {
    const registry = await readRegistry(registryFile)
    const entry = requireEntry(registry, id)
    if (entry.state === 'pending') throw new BrainError('PERMISSION_DENIED', `plugin ${id} has not been confirmed`)
    try {
      const manifest = await manifestIn(installedDir(id, entry.current))
      await deps.activator.enable(await installedPlugin(id, entry, manifest))
      entry.state = 'enabled'
    } catch (error) {
      entry.state = 'failed'
      await writeRegistry(registryFile, registry)
      throw error
    }
    await writeRegistry(registryFile, registry)
  }

  async function disable(id: string): Promise<void> {
    const registry = await readRegistry(registryFile)
    const entry = requireEntry(registry, id)
    await deps.activator.disable(id)
    entry.state = 'disabled'
    await writeRegistry(registryFile, registry)
  }

  async function upgrade(id: string, spec: string): Promise<InstallPreview> {
    const registry = await readRegistry(registryFile)
    const entry = requireEntry(registry, id)
    // An unconfirmed plugin has not been granted anything yet; running its migration or entry would bypass confirm.
    if (entry.state === 'pending') throw invalidArgument(`plugin ${id} has not been confirmed`)
    const granted = [...entry.granted]
    const prepared = await preparePackage(prepareDeps, spec, id)
    const upgradePreview = previewOf(prepared.manifest, prepared.version, granted)

    if (upgradePreview.newPermissions.length > 0) {
      const superseded = entry.pendingUpgrade
      entry.pendingUpgrade = {
        version: prepared.version,
        sha8: prepared.sha8,
        permissions: [...prepared.manifest.permissions],
      }
      await writeRegistry(registryFile, registry)
      if (superseded !== undefined && !sameRef(superseded, prepared)) {
        await removeIfUnreferenced(registry, id, superseded)
      }
      deps.log.info('plugin.upgrade.pending', { plugin: id })
      return upgradePreview
    }

    await completeUpgrade(
      registry, entry, { version: prepared.version, sha8: prepared.sha8 }, prepared.manifest, prepared.dir, prepared.created,
    )
    deps.log.info('plugin.upgraded', { plugin: id })
    return upgradePreview
  }

  async function uninstall(id: string, options: { readonly keepData: boolean }): Promise<void> {
    const registry = await readRegistry(registryFile)
    const entry = requireEntry(registry, id)
    if (entry.state === 'enabled') await disable(id)
    if (!options.keepData) {
      await removeTree(dataDir(id))
      await removeTree(backupRoot(id))
    }
    await removeTree(path.join(pluginsDir, '.installed', id))
    try { await rmdir(path.join(pluginsDir, '.installed')) } catch { /* other plugins remain */ }
    try { await rmdir(path.join(pluginsDir, '.backups')) } catch { /* other backups remain */ }
    const latest = await readRegistry(registryFile)
    delete latest.plugins[id]
    await writeRegistry(registryFile, latest)
    deps.log.info('plugin.uninstalled', { plugin: id })
  }

  async function setConfig(id: string, value: unknown): Promise<void> {
    const registry = await readRegistry(registryFile)
    const entry = requireEntry(registry, id)
    // Validating a config imports the plugin's config module; an unconfirmed plugin must not run any code.
    if (entry.state === 'pending') throw new BrainError('PERMISSION_DENIED', `plugin ${id} has not been confirmed`)
    const dir = installedDir(id, entry.current)
    const manifest = await manifestIn(dir)
    await writeConfig(dataDir(id), await validateConfig(dir, manifest, value))
    if (entry.state === 'enabled') {
      await disable(id)
      await enable(id)
    }
    deps.log.info('plugin.config', { plugin: id })
  }

  async function list(): Promise<readonly PluginEntry[]> {
    const registry = await readRegistry(registryFile)
    const entries: PluginEntry[] = []
    for (const entry of Object.values(registry.plugins).sort(byId)) {
      let permissions: readonly string[]
      try {
        permissions = (await manifestIn(installedDir(entry.id, entry.current))).permissions
      } catch {
        permissions = []
      }
      entries.push({
        id: entry.id,
        version: entry.current.version,
        state: entry.state,
        permissions,
        granted: [...entry.granted],
      })
    }
    return entries
  }

  return { install, confirm, enable, disable, upgrade, uninstall, setConfig, list }
}
