import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { isPlainObject } from './helpers.ts'

export type RoleOrigin = 'modified' | 'user' | 'factory'

export interface RoleStoreOptions {
  readonly root: string
  readonly stateDir: string
  readonly log?: (message: string) => void
}

export interface RoleStore {
  list(): string[]
  origin(name: string): RoleOrigin | null
  exists(name: string): boolean
  read(name: string): string
  path(name: string): string | null
  write(name: string, content: string): void
  create(name: string, content: string): void
  rename(from: string, to: string): void
  remove(name: string): void
  reset(name: string): void
  readonly factoryDir: string
  readonly userDir: string
}

interface RoleTarget {
  readonly name: string
  readonly userFile: string
  readonly factoryFile: string
}

interface CardInspection {
  readonly target: RoleTarget | null
  readonly hasUser: boolean
  readonly hasFactory: boolean
  readonly origin: RoleOrigin | null
  readonly file: string | null
}

const HIDDEN_INDEX_NAME = 'hidden.json'
const RETRYABLE_WIN_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const MAX_RENAME_ATTEMPTS = 5
const SYNC_SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4))

function syncPause(ms: number): void {
  Atomics.wait(SYNC_SLEEP_BUF, 0, 0, ms)
}

function errnoCode(err: unknown): string | undefined {
  return err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : undefined
}

function renameSyncWithRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(from, to)
      return
    } catch (err) {
      const code = errnoCode(err)
      if (
        process.platform !== 'win32'
        || code === undefined
        || !RETRYABLE_WIN_RENAME_CODES.has(code)
        || attempt >= MAX_RENAME_ATTEMPTS
      ) {
        throw err
      }
      syncPause(50 * attempt)
    }
  }
}

function isRegularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

function listMarkdownNames(dir: string): string[] {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    const names: string[] = []
    for (const entry of entries) {
      if (!entry.name.endsWith('.md') || entry.name === 'README.md') continue
      if (entry.isFile() || (entry.isSymbolicLink() && isRegularFile(path.join(dir, entry.name)))) {
        names.push(entry.name.slice(0, -3))
      }
    }
    return names
  } catch {
    return []
  }
}

function dirPrefix(dir: string): string {
  const resolved = path.resolve(dir)
  return resolved.endsWith(path.sep) ? resolved : resolved + path.sep
}

/** Creates an O(1)-lookup dual-layer Markdown role card store (factory + user overlay). */
export function createRoleStore({ root, stateDir, log = () => {} }: RoleStoreOptions): RoleStore {
  const factoryDir = path.join(root, 'roles')
  const userDir = path.join(stateDir, 'roles')
  const hiddenFile = path.join(userDir, HIDDEN_INDEX_NAME)
  const factoryPrefix = dirPrefix(factoryDir)
  const userPrefix = dirPrefix(userDir)
  const loggedWarnings = new Set<string>()

  function warnOnce(message: string): void {
    if (loggedWarnings.has(message)) return
    loggedWarnings.add(message)
    try {
      log(message)
    } catch {
      // Logging errors must never interrupt role store operations.
    }
  }

  function resolveRoleTarget(name: unknown): RoleTarget | null {
    const raw = typeof name === 'string' ? name : String(name ?? '')
    if (
      raw === ''
      || raw === '.'
      || raw === '..'
      || raw === 'README'
      || raw.includes('/')
      || raw.includes('\\')
      || raw.includes('\0')
    ) {
      return null
    }
    const userFile = path.resolve(userDir, `${raw}.md`)
    const factoryFile = path.resolve(factoryDir, `${raw}.md`)
    if (!userFile.startsWith(userPrefix) || !factoryFile.startsWith(factoryPrefix)) {
      return null
    }
    return { name: raw, userFile, factoryFile }
  }

  function requireRoleTarget(name: unknown): RoleTarget {
    const target = resolveRoleTarget(name)
    if (target === null) {
      throw new Error(`人格名不合法：${String(name ?? '').slice(0, 40)}`)
    }
    return target
  }

  function ensureUserDir(): void {
    fs.mkdirSync(userDir, { recursive: true, mode: 0o700 })
    try {
      fs.chmodSync(userDir, 0o700)
    } catch {
      // Windows does not apply POSIX permission bits via chmodSync.
    }
  }

  function atomicWriteSync(targetFile: string, content: string): void {
    ensureUserDir()
    const tmpFile = `${targetFile}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
    let fd: number | undefined
    try {
      fd = fs.openSync(tmpFile, 'wx', 0o600)
      fs.writeFileSync(fd, content, 'utf8')
      fs.fsyncSync(fd)
      fs.closeSync(fd)
      fd = undefined
      renameSyncWithRetry(tmpFile, targetFile)
      try {
        fs.chmodSync(targetFile, 0o600)
      } catch {
        // Ignore on platforms without POSIX mode bits.
      }
    } catch (err) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd)
        } catch {
          // Preserve original write/rename failure.
        }
      }
      try {
        fs.unlinkSync(tmpFile)
      } catch {
        // Temporary file might not exist or was already moved.
      }
      throw err
    }
  }

  function readHidden(): Set<string> {
    let raw: string
    try {
      raw = fs.readFileSync(hiddenFile, 'utf8')
    } catch {
      return new Set()
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!isPlainObject(parsed) || !Array.isArray(parsed.names)) return new Set()
      return new Set(parsed.names.filter((n): n is string => typeof n === 'string' && n.length > 0))
    } catch {
      warnOnce('⚠️ state/roles/hidden.json 解析失败，按未隐藏处理')
      return new Set()
    }
  }

  function writeHidden(hidden: Set<string>): void {
    if (hidden.size === 0) {
      try {
        fs.rmSync(hiddenFile, { force: true })
      } catch {
        // Ignore if already absent.
      }
      return
    }
    const names = [...hidden].sort((a, b) => a.localeCompare(b, 'zh-CN'))
    atomicWriteSync(hiddenFile, `${JSON.stringify({ version: 1, names }, null, 2)}\n`)
  }

  /** O(1) statSync-based card lookup; only reads hidden.json when factory exists without a user override. */
  function inspectCard(name: string): CardInspection {
    const target = resolveRoleTarget(name)
    if (target === null) {
      return { target: null, hasUser: false, hasFactory: false, origin: null, file: null }
    }
    const hasUser = isRegularFile(target.userFile)
    const hasFactory = isRegularFile(target.factoryFile)

    if (hasUser) {
      return {
        target,
        hasUser: true,
        hasFactory,
        origin: hasFactory ? 'modified' : 'user',
        file: target.userFile,
      }
    }
    if (hasFactory) {
      const hidden = readHidden()
      if (hidden.has(target.name)) {
        return { target, hasUser: false, hasFactory: true, origin: null, file: null }
      }
      return { target, hasUser: false, hasFactory: true, origin: 'factory', file: target.factoryFile }
    }
    return { target, hasUser: false, hasFactory: false, origin: null, file: null }
  }

  function list(): string[] {
    const hidden = readHidden()
    const userNames = new Set(listMarkdownNames(userDir))
    const combined = new Set(userNames)
    for (const name of listMarkdownNames(factoryDir)) {
      if (userNames.has(name) || !hidden.has(name)) {
        combined.add(name)
      }
    }
    return [...combined].sort((a, b) => a.localeCompare(b, 'zh-CN'))
  }

  function origin(name: string): RoleOrigin | null {
    return inspectCard(name).origin
  }

  function exists(name: string): boolean {
    return inspectCard(name).origin !== null
  }

  function filePath(name: string): string | null {
    return inspectCard(name).file
  }

  function read(name: string): string {
    const file = inspectCard(name).file
    if (file === null) {
      throw new Error(`人格「${name}」不存在`)
    }
    return fs.readFileSync(file, 'utf8')
  }

  function write(name: string, content: string): void {
    const target = requireRoleTarget(name)
    atomicWriteSync(target.userFile, String(content ?? ''))
    const hidden = readHidden()
    if (hidden.delete(target.name)) {
      writeHidden(hidden)
    }
  }

  function create(name: string, content: string): void {
    const target = requireRoleTarget(name)
    if (inspectCard(target.name).origin !== null) {
      throw new Error(`人格「${name}」已存在`)
    }
    write(target.name, content)
  }

  function rename(from: string, to: string): void {
    const source = inspectCard(from)
    if (source.file === null || source.target === null) {
      throw new Error(`人格「${from}」不存在`)
    }
    const destTarget = requireRoleTarget(to)
    if (inspectCard(destTarget.name).origin !== null) {
      throw new Error(`人格「${to}」已存在`)
    }
    const content = fs.readFileSync(source.file, 'utf8')
    write(destTarget.name, content)
    if (source.hasUser) {
      fs.rmSync(source.target.userFile, { force: true })
    }
    if (source.hasFactory) {
      const hidden = readHidden()
      hidden.add(source.target.name)
      writeHidden(hidden)
    }
  }

  function remove(name: string): void {
    const info = inspectCard(name)
    if (info.origin === null || info.target === null) {
      throw new Error(`人格「${name}」不存在`)
    }
    if (info.hasUser) {
      fs.rmSync(info.target.userFile, { force: true })
    }
    if (info.hasFactory) {
      const hidden = readHidden()
      hidden.add(info.target.name)
      writeHidden(hidden)
    }
  }

  function reset(name: string): void {
    const info = inspectCard(name)
    if (info.origin !== 'modified' || info.target === null) {
      throw new Error(`人格「${name}」没有可恢复的出厂版本（不是「已修改」）`)
    }
    fs.rmSync(info.target.userFile, { force: true })
  }

  return {
    list,
    origin,
    exists,
    read,
    path: filePath,
    write,
    create,
    rename,
    remove,
    reset,
    factoryDir,
    userDir,
  }
}
