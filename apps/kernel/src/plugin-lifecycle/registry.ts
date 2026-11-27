import { readFile } from 'node:fs/promises'
import { BrainError } from '@dsh-brain-core/sdk'
import { writeFileAtomic } from '@dsh-brain-core/shared'

export interface InstalledRef {
  readonly version: string
  readonly sha8: string
}

export interface PendingUpgrade extends InstalledRef {
  readonly permissions: readonly string[]
}

export interface RegistryEntry {
  id: string
  state: 'pending' | 'enabled' | 'disabled' | 'failed'
  current: InstalledRef
  previous?: InstalledRef
  granted: string[]
  /** An upgrade that unpacked fine but waits for the owner to approve new permissions. */
  pendingUpgrade?: PendingUpgrade
}

export interface Registry {
  readonly version: 1
  plugins: Record<string, RegistryEntry>
}

const STATES = new Set(['pending', 'enabled', 'disabled', 'failed'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isRef(value: unknown): value is InstalledRef {
  if (!isRecord(value)) return false
  return typeof value.version === 'string' && value.version !== '' && typeof value.sha8 === 'string' && /^[0-9a-f]{8}$/.test(value.sha8)
}

function isEntry(id: string, value: unknown): value is RegistryEntry {
  if (!isRecord(value)) return false
  if (value.id !== id || typeof value.state !== 'string' || !STATES.has(value.state)) return false
  if (!isRef(value.current) || !isStringArray(value.granted)) return false
  if (value.previous !== undefined && !isRef(value.previous)) return false
  if (value.pendingUpgrade !== undefined) {
    if (!isRecord(value.pendingUpgrade) || !isStringArray(value.pendingUpgrade.permissions) || !isRef(value.pendingUpgrade)) return false
  }
  return true
}

function corrupt(file: string, reason: string): BrainError {
  return new BrainError('UNAVAILABLE', 'the plugin registry is unreadable; it was not overwritten', { file, reason })
}

/** A missing file is an empty registry; a malformed one is an error and is never replaced. */
export async function readRegistry(file: string): Promise<Registry> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, plugins: {} }
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw corrupt(file, 'not JSON')
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.plugins)) throw corrupt(file, 'wrong shape')
  const plugins: Record<string, RegistryEntry> = {}
  for (const [id, value] of Object.entries(parsed.plugins)) {
    if (!isEntry(id, value)) throw corrupt(file, `bad entry for ${id}`)
    plugins[id] = value
  }
  return { version: 1, plugins }
}

export async function writeRegistry(file: string, registry: Registry): Promise<void> {
  const plugins: Record<string, RegistryEntry> = {}
  for (const id of Object.keys(registry.plugins).sort()) {
    const entry = registry.plugins[id]
    if (entry !== undefined) plugins[id] = entry
  }
  await writeFileAtomic(file, `${JSON.stringify({ version: 1, plugins }, null, 2)}\n`)
}
