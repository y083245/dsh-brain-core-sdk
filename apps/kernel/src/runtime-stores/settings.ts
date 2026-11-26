import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { BrainError } from '@brain-core/sdk'
import { ensurePrivateDir, writeFileAtomic } from '@brain-core/shared'
import type { RuntimeSettings, SettingsStore } from '../contracts/index.ts'

const EMPTY: RuntimeSettings = { agents: {} }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
}

function unreadable(): BrainError {
  return new BrainError('INTERNAL', 'settings file is unreadable')
}

/** `state/settings.json`: the owner's choices; a missing file means nothing has been chosen yet (D21). */
export function createSettingsStore(file: string): SettingsStore {
  let tail: Promise<unknown> = Promise.resolve()
  /** Serializes operations so two concurrent writes cannot lose each other's update. */
  function run<T>(fn: () => Promise<T>): Promise<T> {
    const result = tail.then(fn, fn)
    tail = result.then(() => undefined, () => undefined)
    return result
  }

  async function readAll(): Promise<RuntimeSettings> {
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return EMPTY
      throw unreadable()
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw unreadable()
    }
    if (!isRecord(parsed)) throw unreadable()
    // An agent table that is missing or the wrong shape reads as "nothing chosen", never as a default model.
    const agents = isRecord(parsed.agents) ? parsed.agents : {}
    return { ...parsed, agents } as unknown as RuntimeSettings
  }

  return {
    read: () => run(readAll),
    write: (next) => run(async () => {
      await ensurePrivateDir(path.dirname(file))
      await writeFileAtomic(file, JSON.stringify(next))
    }),
  }
}
