import { randomBytes } from 'node:crypto'
import { unlink, open, rename as renameFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { hardenFile } from './state-acl.ts'

export interface AtomicWriteOptions {
  /** Defaults to fs.promises.rename. Tests pass one that throws, to simulate a crash mid-write. */
  readonly rename?: (from: string, to: string) => Promise<void>
}

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RENAME_ATTEMPTS = 5

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function renameWithRetry(rename: (from: string, to: string) => Promise<void>, from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = errorCode(error)
      // Windows 上杀毒软件和索引服务会临时占用文件；其他平台不掩盖真正的失败。
      if (process.platform !== 'win32' || code === undefined || !RETRYABLE_RENAME_CODES.has(code) || attempt >= RENAME_ATTEMPTS) {
        throw error
      }
      await wait(50 * attempt)
    }
  }
}

/** Writes to a temporary file in the same directory, fsyncs, then renames over the target. The file ends up 600. */
export async function writeFileAtomic(file: string, data: string | Uint8Array, options: AtomicWriteOptions = {}): Promise<void> {
  const rename = options.rename ?? renameFile
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  let handle: FileHandle | undefined
  try {
    handle = await open(tmp, 'wx', 0o600)
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = undefined
    await renameWithRetry(rename, tmp, file)
    const hardened = hardenFile(file)
    if (!hardened.ok) throw new Error(`could not harden ${file}: ${hardened.detail}`)
  } catch (error) {
    if (handle !== undefined) {
      try { await handle.close() } catch { /* the original error wins */ }
    }
    try { await unlink(tmp) } catch { /* already renamed or never created */ }
    throw error
  }
}
