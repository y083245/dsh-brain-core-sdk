// The console's own secret store: `state/secrets.json`, 600, values never leave this file.
//
// It is deliberately a copy of the kernel's store rather than an import: `apps/console` only depends on
// `@brain-core/sdk`, `satellite-host` and `shared`, and the console must never reach into the main DSH's home.
import { readFile } from 'node:fs/promises'
import { BrainError } from '@brain-core/sdk'
import { writeFileAtomic } from '@brain-core/shared'

export interface SecretStore {
  set(name: string, value: string): Promise<void>
  names(): Promise<readonly string[]>
}

const NAME_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/
const VALUE_MAX = 4096

function unreadable(): BrainError {
  return new BrainError('INTERNAL', 'secret store is unreadable')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readSecrets(file: string): Promise<Record<string, string>> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw unreadable()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw unreadable()
  }
  if (!isPlainObject(parsed) || parsed.version !== 1 || !isPlainObject(parsed.secrets)) throw unreadable()
  const secrets: Record<string, string> = {}
  for (const [name, value] of Object.entries(parsed.secrets)) {
    if (!NAME_PATTERN.test(name) || typeof value !== 'string' || value.length < 1 || value.length > VALUE_MAX) {
      throw unreadable()
    }
    secrets[name] = value
  }
  return secrets
}

export function createSecretStore(options: { readonly file: string }): SecretStore {
  const file = options.file
  let tail: Promise<unknown> = Promise.resolve()
  /** Serializes writes so two concurrent saves cannot lose each other's update. */
  function run<T>(fn: () => Promise<T>): Promise<T> {
    const result = tail.then(fn, fn)
    tail = result.then(() => undefined, () => undefined)
    return result
  }

  return {
    set: (name, value) => run(async () => {
      // 报错信息里不能带名字以外的任何东西，尤其不能带值本身。
      if (!NAME_PATTERN.test(name)) throw new BrainError('INVALID_ARGUMENT', 'invalid secret name', { field: 'name' })
      if (typeof value !== 'string' || value.length < 1 || value.length > VALUE_MAX) {
        throw new BrainError('INVALID_ARGUMENT', 'invalid secret value', { field: 'value' })
      }
      const secrets = await readSecrets(file)
      secrets[name] = value
      const sorted: Record<string, string> = {}
      for (const key of Object.keys(secrets).sort()) sorted[key] = secrets[key] as string
      await writeFileAtomic(file, JSON.stringify({ version: 1, secrets: sorted }))
    }),
    names: () => run(async () => Object.keys(await readSecrets(file)).sort()),
  }
}
