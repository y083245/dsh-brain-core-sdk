import { mkdir, readdir, readFile, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { BrainError, type PluginStorage } from '@dsh-brain-core/sdk'
import { writeFileAtomic } from '@dsh-brain-core/shared'

function denied(message: string): BrainError {
  return new BrainError('PERMISSION_DENIED', message)
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** Files under `dir` only: no absolute paths, no `..`, and no link that leads outside. */
export function createPluginStorage(dir: string): PluginStorage {
  const root = path.resolve(dir)

  function resolve(relative: string): string {
    if (typeof relative !== 'string' || relative.length === 0) throw new BrainError('INVALID_ARGUMENT', 'path must not be empty')
    if (relative.includes('\0')) throw new BrainError('INVALID_ARGUMENT', 'invalid path')
    if (path.isAbsolute(relative) || path.win32.isAbsolute(relative) || path.posix.isAbsolute(relative)) {
      throw denied('absolute paths are refused')
    }
    if (relative.split(/[\\/]+/).includes('..')) throw denied('.. is refused')
    const target = path.resolve(root, relative)
    if (!isInside(root, target)) throw denied('path leaves the plugin directory')
    return target
  }

  /** Real path of the deepest parent that exists; it must still be inside the real root. */
  async function assertRealInside(target: string): Promise<void> {
    await mkdir(root, { recursive: true })
    const realRoot = await realpath(root)
    let probe = target
    for (;;) {
      try {
        const real = await realpath(probe)
        if (!isInside(realRoot, real)) throw denied('path leaves the plugin directory')
        return
      } catch (error) {
        if (error instanceof BrainError) throw error
        if (errorCode(error) !== 'ENOENT') throw error
        const parent = path.dirname(probe)
        if (parent === probe) return
        probe = parent
      }
    }
  }

  async function walk(base: string, prefix: string, out: string[]): Promise<void> {
    let entries
    try {
      entries = await readdir(base, { withFileTypes: true })
    } catch (error) {
      if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return
      throw error
    }
    for (const entry of entries) {
      const full = path.join(base, entry.name)
      if (entry.isDirectory()) await walk(full, prefix, out)
      else if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'))
    }
  }

  return {
    async read(relative) {
      const target = resolve(relative)
      await assertRealInside(target)
      try {
        return new Uint8Array(await readFile(target))
      } catch (error) {
        if (errorCode(error) === 'ENOENT' || errorCode(error) === 'EISDIR') return undefined
        throw error
      }
    },
    async write(relative, data) {
      const target = resolve(relative)
      await assertRealInside(target)
      await mkdir(path.dirname(target), { recursive: true })
      await assertRealInside(target)
      await writeFileAtomic(target, data)
    },
    async remove(relative) {
      const target = resolve(relative)
      await assertRealInside(target)
      await rm(target, { force: true })
    },
    async list(prefix) {
      const base = prefix === undefined || prefix === '' ? root : resolve(prefix)
      await assertRealInside(base)
      const out: string[] = []
      await walk(base, '', out)
      return out.sort()
    },
  }
}
