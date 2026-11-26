import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BrainLogger, BrainManifest, PluginStorage } from '@brain-core/sdk'
import { writeFileAtomic } from '@brain-core/shared'
import { ensureDir, invalidArgument, pathExists, resolveInside } from './fs-utils.ts'

export interface MigrationDeps {
  readonly storage: PluginStorage
  readonly logger: BrainLogger
}

interface Migration {
  readonly number: number
  readonly file: string
}

const MIGRATION_NAME = /^(\d{3})-.+\.mjs$/

let imports = 0

function timestamp(name: string): number | undefined {
  const match = MIGRATION_NAME.exec(name)
  return match === null ? undefined : Number(match[1])
}

async function listMigrations(dir: string, manifest: BrainManifest): Promise<readonly Migration[]> {
  if (manifest.migrations === undefined) return []
  const migrationsDir = resolveInside(dir, manifest.migrations, 'migrations')
  if (!(await pathExists(migrationsDir))) throw invalidArgument('the migrations directory is missing', { field: 'migrations' })
  const names = (await readdir(migrationsDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort()
  const seen = new Set<number>()
  const migrations: Migration[] = []
  for (const name of names) {
    const number = timestamp(name)
    if (number === undefined) throw invalidArgument(`migration file name is invalid: ${name}`, { field: 'migrations' })
    if (seen.has(number)) throw invalidArgument(`duplicate migration number ${number}`, { field: 'migrations' })
    seen.add(number)
    migrations.push({ number, file: path.join(migrationsDir, name) })
  }
  return migrations.sort((a, b) => a.number - b.number)
}

async function schemaVersion(dataDir: string): Promise<number> {
  const file = path.join(dataDir, 'schema-version')
  if (!(await pathExists(file))) return 0
  const text = (await readFile(file, 'utf8')).trim()
  if (!/^\d+$/.test(text)) throw invalidArgument('schema-version is not an integer', { field: 'schema-version' })
  return Number(text)
}

/** Runs every migration above the stored version, writing the new version after each one. */
export async function runMigrations(input: {
  readonly id: string
  readonly dir: string
  readonly manifest: BrainManifest
  readonly dataDir: string
  readonly deps: MigrationDeps
}): Promise<void> {
  const migrations = await listMigrations(input.dir, input.manifest)
  if (migrations.length === 0) return
  await ensureDir(input.dataDir)
  let current = await schemaVersion(input.dataDir)
  for (const migration of migrations) {
    if (migration.number <= current) continue
    // A rollback restores schema-version, so the same file may be imported again; a fresh URL avoids the module cache.
    imports += 1
    const module = await import(`${pathToFileURL(migration.file).href}?m=${imports}`)
    const up = typeof module === 'object' && module !== null ? (module as { up?: unknown }).up : undefined
    if (typeof up !== 'function') throw invalidArgument(`migration ${path.basename(migration.file)} does not export up()`, { field: 'migrations' })
    await (up as (ctx: MigrationDeps) => unknown)({ storage: input.deps.storage, logger: input.deps.logger })
    current = migration.number
    await writeFileAtomic(path.join(input.dataDir, 'schema-version'), `${current}\n`)
  }
}
