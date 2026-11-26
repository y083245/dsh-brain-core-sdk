import { readFile } from 'node:fs/promises'
import { BrainError } from '@brain-core/sdk'
import { writeFileAtomic } from '@brain-core/shared'
import type { CrossChannelMode } from '../contracts/index.ts'

interface MemoryPreferences {
  readonly crossChannel?: CrossChannelMode
  readonly automatic?: boolean
}

export async function openMemoryPreferences(file: string) {
  let current: MemoryPreferences = {}
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('invalid memory preferences')
    }
    const { crossChannel, automatic } = parsed as Record<string, unknown>
    if ((crossChannel !== undefined && crossChannel !== 'off' && crossChannel !== 'shadow' && crossChannel !== 'on')
      || (automatic !== undefined && typeof automatic !== 'boolean')) {
      throw new Error('invalid memory preferences')
    }
    current = {
      ...(crossChannel === undefined ? {} : { crossChannel }),
      ...(automatic === undefined ? {} : { automatic }),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new BrainError('INTERNAL', 'memory preferences are unreadable')
    }
  }

  let pending = Promise.resolve()
  return {
    get: () => current,
    update(patch: MemoryPreferences): Promise<void> {
      const operation = pending.then(async () => {
        const next = { ...current, ...patch }
        await writeFileAtomic(file, JSON.stringify(next))
        current = next
      })
      pending = operation.catch(() => undefined)
      return operation
    },
  }
}
