import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { BrainLogger, BrainManifest, PluginStorage } from '@dsh-brain-core/sdk'
import { removeTree } from '@dsh-brain-core/satellite-host'
import type { InstalledPlugin, PluginActivator } from '../../src/contracts/index.ts'
import { createPluginLifecycle, type PluginLifecycle, type PluginLifecycleDeps, type RunCommand } from '../../src/plugin-lifecycle/index.ts'
import type { Logger } from '../../src/log/index.ts'
import { FakeClock } from '../fakes/index.ts'

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))

/** The real SDK the install step links into before the entry is loaded. */
export const SDK_DIR = path.resolve(here, '../../../../packages/sdk')

export interface PluginFixtureOptions {
  readonly id?: string
  readonly version?: string
  readonly api?: string
  readonly runtime?: 'node' | 'process'
  readonly permissions?: readonly string[]
  readonly manifest?: Partial<BrainManifest>
  readonly packageJson?: Record<string, unknown>
  readonly noMain?: boolean
  readonly main?: string
  readonly mainSource?: string
  readonly files?: Readonly<Record<string, string>>
}

export function brainManifest(overrides: Partial<BrainManifest> = {}): BrainManifest {
  return { id: 'demo', kinds: ['activity'], api: '^1', runtime: 'node', permissions: [], ...overrides }
}

/** Writes a plugin package to `dir` and returns it. */
export async function makePlugin(dir: string, options: PluginFixtureOptions = {}): Promise<string> {
  const id = options.id ?? 'demo'
  const main = options.main ?? 'main.js'
  const pkg: Record<string, unknown> = {
    name: `@fixture/${id}`,
    version: options.version ?? '1.0.0',
    type: 'module',
    brain: brainManifest({ id, api: options.api ?? '^1', runtime: options.runtime ?? 'node', permissions: [...(options.permissions ?? [])], ...options.manifest }),
    ...(options.noMain === true ? {} : { main }),
    ...options.packageJson,
  }
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  if (options.noMain !== true) {
    await writeFile(path.join(dir, main), options.mainSource ?? 'export function apply() {}\n')
  }
  for (const [name, content] of Object.entries(options.files ?? {})) {
    const file = path.join(dir, name)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  return dir
}

export interface RunCall {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
}

export interface FakeRunner {
  readonly run: RunCommand
  readonly calls: RunCall[]
  /** Set before an install that uses an npm or git spec; the archive is built from this directory. */
  packSource?: string
  /** Simulates an npm pack that reports success but writes no archive. */
  packNoArchive?: boolean
  /** Runs before the built-in behaviour; throw here to simulate a failing command. */
  before?: (command: string, args: readonly string[], cwd: string) => void | Promise<void>
}

/** Records every command. npm pack builds a real tgz from `packSource` so tar can unpack it. */
export function createRunner(): FakeRunner {
  const calls: RunCall[] = []
  const runner: FakeRunner = {
    calls,
    run: async (command, args, opts) => {
      calls.push({ command, args: [...args], cwd: opts.cwd })
      await runner.before?.(command, args, opts.cwd)
      if (command === 'npm' && args[0] === 'pack') {
        const index = args.indexOf('--pack-destination')
        const destination = args[index + 1]
        if (destination === undefined) throw new Error('npm pack without --pack-destination')
        if (runner.packNoArchive === true) return
        const packSource = runner.packSource
        if (packSource === undefined) throw new Error('this test did not prepare a pack source')
        const parent = path.dirname(packSource)
        const leaf = path.basename(packSource)
        await execFileAsync('tar', ['-czf', path.join(destination, `${leaf}.tgz`), '-C', parent, leaf], { cwd: destination })
        return
      }
      if (command === 'tar') {
        await execFileAsync('tar', [...args], { cwd: opts.cwd })
      }
    },
  }
  return runner
}

export class FakeActivator implements PluginActivator {
  readonly calls: { readonly op: 'enable' | 'disable'; readonly id: string; readonly version?: string }[] = []
  readonly enabled = new Map<string, InstalledPlugin>()
  failEnable: ((plugin: InstalledPlugin) => Error | undefined) | undefined

  async enable(plugin: InstalledPlugin): Promise<void> {
    this.calls.push({ op: 'enable', id: plugin.manifest.id, version: plugin.version })
    const error = this.failEnable?.(plugin)
    if (error !== undefined) throw error
    this.enabled.set(plugin.manifest.id, plugin)
  }

  async disable(id: string): Promise<void> {
    this.calls.push({ op: 'disable', id })
    this.enabled.delete(id)
  }

  state(id: string): 'enabled' | 'failed' | 'disabled' {
    return this.enabled.has(id) ? 'enabled' : 'disabled'
  }
}

export interface WriteRecord {
  readonly path: string
  readonly data: string
}

export interface FakeStorage extends PluginStorage {
  readonly writes: WriteRecord[]
  readonly files: Map<string, string>
}

export function createStorage(): FakeStorage {
  const files = new Map<string, string>()
  const writes: WriteRecord[] = []
  return {
    files,
    writes,
    async read(file) {
      const value = files.get(file)
      return value === undefined ? undefined : new TextEncoder().encode(value)
    },
    async write(file, data) {
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
      files.set(file, text)
      writes.push({ path: file, data: text })
    },
    async remove(file) {
      files.delete(file)
    },
    async list(prefix) {
      return [...files.keys()].filter((file) => prefix === undefined || file.startsWith(prefix)).sort()
    },
  }
}

export function createLogger(): Logger {
  return { info: () => undefined, warn: () => undefined, error: () => undefined }
}

export function pluginLogger(): BrainLogger {
  return { info: () => undefined, warn: () => undefined, error: () => undefined }
}

export interface Harness {
  readonly lifecycle: PluginLifecycle
  readonly activator: FakeActivator
  readonly runner: FakeRunner
  readonly clock: FakeClock
  readonly pluginsDir: string
  readonly root: string
  readonly storages: Map<string, FakeStorage>
  readonly warnings: string[]
}

export async function setup(t: TestContext, options: Partial<Pick<PluginLifecycleDeps, 'sdkDir' | 'brainPackages'>> = {}): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-lifecycle-'))
  t.after(async () => { await removeTree(root) })
  const pluginsDir = path.join(root, 'plugins')
  const activator = new FakeActivator()
  const runner = createRunner()
  const clock = new FakeClock()
  const storages = new Map<string, FakeStorage>()
  const warnings: string[] = []
  const lifecycle = createPluginLifecycle({
    pluginsDir,
    sdkDir: options.sdkDir ?? SDK_DIR,
    brainPackages: options.brainPackages,
    activator,
    storageFor: (id) => {
      let storage = storages.get(id)
      if (storage === undefined) {
        storage = createStorage()
        storages.set(id, storage)
      }
      return storage
    },
    loggerFor: () => pluginLogger(),
    run: runner.run,
    coreWarnings: () => warnings,
    clock,
    log: createLogger(),
  })
  return { lifecycle, activator, runner, clock, pluginsDir, root, storages, warnings }
}

export function installedDirs(pluginsDir: string, id = 'demo'): Promise<string[]> {
  return readDirectory(path.join(pluginsDir, '.installed', id))
}

export function backupDirs(pluginsDir: string, id = 'demo'): Promise<string[]> {
  return readDirectory(path.join(pluginsDir, '.backups', id))
}

async function readDirectory(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort()
  } catch {
    return []
  }
}

/** Asserts an error is a BrainError with this code. */
export function throwsCode(error: unknown, code: string): void {
  if (!(error instanceof Error) || (error as { code?: unknown }).code !== code) {
    throw new Error(`expected ${code}, got ${error instanceof Error ? `${String((error as { code?: unknown }).code)}: ${error.message}` : String(error)}`)
  }
}
