import { appendFile, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ensurePrivateDir, hardenFile } from '@brain-core/shared'
import type { ProcessedLog } from './types.ts'

/** A full L0 id: the layer prefix and a 26-character ULID. Anything else is a torn line from a crash. */
const ID_PATTERN = /^l0_[0-9A-Z]{26}$/

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
}

export function createMemoryProcessedLog(): ProcessedLog {
  const ids = new Set<string>()
  return {
    has: (id) => ids.has(id),
    async add(batch: readonly string[]): Promise<void> {
      for (const id of batch) ids.add(id)
    },
  }
}

/** One id per line. Only ids are stored, never any text from the records. */
export async function createFileProcessedLog(path: string): Promise<ProcessedLog> {
  const ids = new Set<string>()
  let needsLeadingNewline = false
  try {
    const contents = await readFile(path, 'utf8')
    for (const line of contents.split('\n')) {
      if (ID_PATTERN.test(line)) ids.add(line)
    }
    // A crash can leave the last line without its newline. Without one, the next append would glue
    // its first id onto that torn line and the id would be lost on the next reopen.
    needsLeadingNewline = contents.length > 0 && !contents.endsWith('\n')
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }

  let prepared: Promise<void> | undefined
  let hardened = false
  let queue: Promise<void> = Promise.resolve()

  return {
    has: (id) => ids.has(id),
    async add(batch: readonly string[]): Promise<void> {
      const lines = [...batch]
      if (lines.length === 0) return
      queue = queue.then(async () => {
        prepared ??= ensurePrivateDir(dirname(path))
        await prepared
        const prefix = needsLeadingNewline ? '\n' : ''
        await appendFile(path, `${prefix}${lines.join('\n')}\n`, { mode: 0o600 })
        needsLeadingNewline = false
        if (!hardened) {
          const result = hardenFile(path)
          if (!result.ok) throw new Error(`could not harden ${path}: ${result.detail}`)
          hardened = true
        }
        for (const id of lines) ids.add(id)
      })
      await queue
    },
  }
}
