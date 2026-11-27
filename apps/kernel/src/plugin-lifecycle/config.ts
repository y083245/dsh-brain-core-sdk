import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrainError, type BrainManifest } from '@dsh-brain-core/sdk'
import { writeFileAtomic } from '@dsh-brain-core/shared'
import { ensureDir, invalidArgument, isRecord, pathExists, resolveInside } from './fs-utils.ts'

type ConfigSchema = (value: unknown) => unknown

async function loadSchema(dir: string, manifest: BrainManifest): Promise<ConfigSchema | undefined> {
  if (manifest.config === undefined) return undefined
  const file = resolveInside(dir, manifest.config, 'config')
  let module: unknown
  try {
    module = await import(pathToFileURL(file).href)
  } catch (error) {
    throw invalidArgument('the config module cannot be imported', { field: 'config', reason: messageOf(error) })
  }
  const candidate = isRecord(module) ? module.default : undefined
  if (typeof candidate !== 'function') {
    throw invalidArgument('the config module default export must be a Schemastery schema', { field: 'config' })
  }
  return candidate as ConfigSchema
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Schemastery fills defaults and throws on a bad value; the value itself never goes into the error. */
export async function validateConfig(dir: string, manifest: BrainManifest, value: unknown): Promise<unknown> {
  const schema = await loadSchema(dir, manifest)
  if (schema === undefined) return {}
  try {
    return schema(value)
  } catch (error) {
    throw new BrainError('INVALID_ARGUMENT', 'plugin config does not match its schema', { field: 'config', reason: messageOf(error) })
  }
}

async function readConfigFile(dataDir: string): Promise<unknown> {
  const file = path.join(dataDir, 'config.json')
  if (!(await pathExists(file))) return {}
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    throw invalidArgument('config.json cannot be read', { field: 'config', reason: messageOf(error) })
  }
  try {
    return JSON.parse(text)
  } catch {
    throw invalidArgument('config.json is not valid JSON', { field: 'config' })
  }
}

/** The config handed to `apply`: the file, or `{}`, passed through the schema so defaults appear. */
export async function readConfig(dir: string, manifest: BrainManifest, dataDir: string): Promise<unknown> {
  return validateConfig(dir, manifest, await readConfigFile(dataDir))
}

export async function writeConfig(dataDir: string, value: unknown): Promise<void> {
  await ensureDir(dataDir)
  await writeFileAtomic(path.join(dataDir, 'config.json'), JSON.stringify(value))
}
