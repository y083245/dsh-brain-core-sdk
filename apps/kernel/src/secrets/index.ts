import { readFile } from 'node:fs/promises'
import { BrainError } from '@dsh-brain-core/sdk'
import { writeFileAtomic } from '@dsh-brain-core/shared'

export interface SecretStore {
  get(name: string): Promise<string | undefined>
  set(name: string, value: string): Promise<void>
  delete(name: string): Promise<boolean>
  names(): Promise<readonly string[]>
}

const NAME_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/
const VALUE_MAX = 4096

function unreadable(): BrainError {
  return new BrainError('INTERNAL', 'secret store is unreadable')
}

function assertName(name: string): void {
  if (!NAME_PATTERN.test(name)) throw new BrainError('INVALID_ARGUMENT', 'invalid secret name', { field: 'name' })
}

function assertValue(value: string): void {
  // 消息和 details 都不能带上值本身。
  if (typeof value !== 'string' || value.length < 1 || value.length > VALUE_MAX) {
    throw new BrainError('INVALID_ARGUMENT', 'invalid secret value', { field: 'value' })
  }
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

async function writeSecrets(file: string, secrets: Record<string, string>): Promise<void> {
  const sorted: Record<string, string> = {}
  for (const name of Object.keys(secrets).sort()) sorted[name] = secrets[name] as string
  await writeFileAtomic(file, JSON.stringify({ version: 1, secrets: sorted }))
}

export function createSecretStore(options: { readonly file: string }): SecretStore {
  const file = options.file
  let tail: Promise<unknown> = Promise.resolve()
  /** Serializes operations so two concurrent writes cannot lose each other's update. */
  function run<T>(fn: () => Promise<T>): Promise<T> {
    const result = tail.then(fn, fn)
    tail = result.then(() => undefined, () => undefined)
    return result
  }

  return {
    get: (name) => run(async () => {
      assertName(name)
      return (await readSecrets(file))[name]
    }),
    set: (name, value) => run(async () => {
      assertName(name)
      assertValue(value)
      const secrets = await readSecrets(file)
      secrets[name] = value
      await writeSecrets(file, secrets)
    }),
    delete: (name) => run(async () => {
      assertName(name)
      const secrets = await readSecrets(file)
      if (!(name in secrets)) return false
      delete secrets[name]
      await writeSecrets(file, secrets)
      return true
    }),
    names: () => run(async () => Object.keys(await readSecrets(file)).sort()),
  }
}
