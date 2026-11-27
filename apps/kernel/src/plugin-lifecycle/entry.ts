import { pathToFileURL } from 'node:url'
import type { PluginApply } from '@dsh-brain-core/sdk'
import type { InstalledPlugin } from '../contracts/index.ts'
import { invalidArgument, mainOf, pathExists, readPackageJson, resolveInside } from './fs-utils.ts'

/** Imports the plugin's main module and returns its `apply`; used for runtime: node. */
export async function loadNodeEntry(plugin: InstalledPlugin): Promise<PluginApply> {
  const pkg = await readPackageJson(plugin.dir)
  const main = mainOf(pkg)
  if (main === undefined) throw invalidArgument('runtime node needs a main entry', { field: 'main' })
  const file = resolveInside(plugin.dir, main, 'main')
  if (!(await pathExists(file))) throw invalidArgument('runtime node main entry does not exist', { field: 'main' })
  const module = await import(pathToFileURL(file).href)
  const apply = (module as { apply?: unknown }).apply
  if (typeof apply !== 'function') throw invalidArgument('the plugin main module must export apply()', { field: 'main' })
  return apply as PluginApply
}
