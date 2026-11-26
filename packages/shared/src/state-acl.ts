import childProcess from 'node:child_process'
import fs from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

export interface HardenResult {
  readonly ok: boolean
  readonly detail: string
}

interface DirStamp {
  readonly ino: number
  readonly birthtimeMs: number
}

const WELL_KNOWN_SYSTEM_SID = '*S-1-5-18'
const WELL_KNOWN_ADMINS_SID = '*S-1-5-32-544'
const PERMISSIVE_SIDS = ['*S-1-5-11', '*S-1-5-32-545', '*S-1-1-0'] as const

const PERMISSIVE_TRUSTEE_PATTERN =
  /(?:^|[\s\\*])(?:Authenticated Users|BUILTIN\\Users|Everyone|S-1-5-11|S-1-5-32-545|S-1-1-0)\s*(?::|$)/i

const ACE_INHERITANCE_FLAGS = new Set(['(I)', '(OI)', '(CI)', '(IO)', '(NP)'])
const ICACLS_TIMEOUT_MS = 30_000

const hardenedDirCache = new Map<string, DirStamp>()

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function splitRelevantLines(icaclsOutput: string | null | undefined): string[] {
  const raw = String(icaclsOutput ?? '')
  const lines: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '') continue
    if (line.toLowerCase().includes('mandatory label')) continue
    lines.push(line)
  }
  return lines
}

function extractAceTokenGroups(line: string): string[][] {
  const groups: string[][] = []
  let idx = 0
  while (idx < line.length) {
    const colonParen = line.indexOf(':(', idx)
    if (colonParen === -1) break
    let cursor = colonParen + 1
    const tokens: string[] = []
    while (cursor < line.length && line[cursor] === '(') {
      const close = line.indexOf(')', cursor + 1)
      if (close === -1) break
      tokens.push(line.slice(cursor, close + 1))
      cursor = close + 1
    }
    if (tokens.length > 0) groups.push(tokens)
    idx = cursor > colonParen + 1 ? cursor : colonParen + 2
  }
  return groups
}

function isEffectivePermissionGroup(tokens: readonly string[]): boolean {
  let cursor = 0
  while (cursor < tokens.length) {
    const token = tokens[cursor]!.toUpperCase()
    if (!ACE_INHERITANCE_FLAGS.has(token)) break
    if (token === '(IO)') return false
    cursor += 1
  }
  if (cursor >= tokens.length) return false
  for (let i = cursor; i < tokens.length; i += 1) {
    const perm = tokens[i]!.toUpperCase()
    if (perm === '(DENY)' || perm === '(N)') return false
  }
  return true
}

/** Returns true when non-Mandatory-Label icacls lines contain an inherited `(I)` ACE marker. */
export function hasInheritedPermissionAce(icaclsOutput: string | null | undefined): boolean {
  for (const line of splitRelevantLines(icaclsOutput)) {
    if (line.includes('(I)')) return true
  }
  return false
}

/** Returns true when icacls output mentions broad built-in groups or their SIDs. */
export function hasPermissiveTrustee(icaclsOutput: string | null | undefined): boolean {
  for (const line of splitRelevantLines(icaclsOutput)) {
    if (PERMISSIVE_TRUSTEE_PATTERN.test(line)) return true
  }
  return false
}

/** Returns true when non-Mandatory-Label, non-DENY icacls lines grant an effective permission on the target itself. */
export function hasPermissionGrant(icaclsOutput: string | null | undefined): boolean {
  for (const line of splitRelevantLines(icaclsOutput)) {
    for (const group of extractAceTokenGroups(line)) {
      if (isEffectivePermissionGroup(group)) return true
    }
  }
  return false
}

function isAclHardenedOutput(icaclsOutput: string): boolean {
  return hasPermissionGrant(icaclsOutput)
    && !hasInheritedPermissionAce(icaclsOutput)
    && !hasPermissiveTrustee(icaclsOutput)
}

interface IcaclsOutcome {
  readonly ok: boolean
  readonly stdout: string
  readonly detail: string
}

function runIcacls(args: readonly string[]): IcaclsOutcome {
  const result = childProcess.spawnSync('icacls', args, {
    encoding: 'utf8',
    timeout: ICACLS_TIMEOUT_MS,
    windowsHide: true,
  })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  if (result.error !== undefined) {
    return { ok: false, stdout, detail: result.error.message }
  }
  const combined = `${stdout}\n${stderr}`.trim()
  if (result.status !== 0) {
    return { ok: false, stdout, detail: combined || `icacls exited with status ${String(result.status)}` }
  }
  if (/(?:failed processing\s+[1-9]\d*|处理\s+[1-9]\d*\s+个文件时失败)/i.test(combined)) {
    return { ok: false, stdout, detail: combined }
  }
  return { ok: true, stdout, detail: 'icacls' }
}

function verifyWindowsAcl(target: string, requireReadableDir: boolean): HardenResult {
  const probe = runIcacls([target])
  if (!probe.ok) return { ok: false, detail: probe.detail }
  if (!isAclHardenedOutput(probe.stdout)) {
    return { ok: false, detail: 'icacls verification failed: ACL is not private' }
  }
  if (requireReadableDir) {
    try {
      fs.readdirSync(target)
    } catch (error) {
      return { ok: false, detail: errorMessage(error) }
    }
  }
  return { ok: true, detail: 'icacls' }
}

function currentWindowsUser(): string | undefined {
  const user = process.env.USERNAME?.trim()
  return user !== undefined && user !== '' ? user : undefined
}

/** Checks whether a file or directory is restricted to its owner. */
export function isHardened(target: string): boolean {
  if (process.platform !== 'win32') {
    try {
      return (fs.statSync(target).mode & 0o077) === 0
    } catch {
      return false
    }
  }
  const probe = runIcacls([target])
  if (!probe.ok) return false
  return isAclHardenedOutput(probe.stdout)
}

/** Restricts a directory's permissions to the current user (0700 on POSIX, private ACL on Windows). */
export function hardenDir(dir: string): HardenResult {
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(dir, 0o700)
      return { ok: true, detail: 'chmod 700' }
    } catch (error) {
      return { ok: false, detail: errorMessage(error) }
    }
  }

  const user = currentWindowsUser()
  if (user === undefined) {
    return { ok: false, detail: 'missing USERNAME environment variable' }
  }

  const resolved = path.resolve(dir)
  let stamp: DirStamp
  try {
    const stats = fs.statSync(resolved)
    if (!stats.isDirectory()) {
      return { ok: false, detail: `not a directory: ${dir}` }
    }
    stamp = { ino: stats.ino, birthtimeMs: stats.birthtimeMs }
  } catch (error) {
    hardenedDirCache.delete(resolved)
    return { ok: false, detail: errorMessage(error) }
  }

  const cached = hardenedDirCache.get(resolved)
  if (
    cached !== undefined
    && (stamp.ino !== 0 || stamp.birthtimeMs !== 0)
    && cached.ino === stamp.ino
    && cached.birthtimeMs === stamp.birthtimeMs
  ) {
    return { ok: true, detail: 'icacls' }
  }

  const precheck = verifyWindowsAcl(resolved, true)
  if (precheck.ok) {
    hardenedDirCache.set(resolved, stamp)
    return precheck
  }

  const steps: readonly (readonly string[])[] = [
    [resolved, '/T', '/Q', '/grant', `${user}:F`, '/grant', `${WELL_KNOWN_SYSTEM_SID}:F`, '/grant', `${WELL_KNOWN_ADMINS_SID}:F`],
    [resolved, '/inheritance:r', '/Q', '/grant', `${user}:(OI)(CI)F`, '/grant', `${WELL_KNOWN_SYSTEM_SID}:(OI)(CI)F`, '/grant', `${WELL_KNOWN_ADMINS_SID}:(OI)(CI)F`],
    [resolved, '/remove:g', ...PERMISSIVE_SIDS, '/T', '/Q'],
  ]
  for (const args of steps) {
    const outcome = runIcacls(args)
    if (!outcome.ok) {
      hardenedDirCache.delete(resolved)
      return { ok: false, detail: outcome.detail }
    }
  }

  const verified = verifyWindowsAcl(resolved, true)
  if (verified.ok) {
    hardenedDirCache.set(resolved, stamp)
  } else {
    hardenedDirCache.delete(resolved)
  }
  return verified
}

/** Restricts a file's permissions to the current user (0600 on POSIX, private ACL on Windows). */
export function hardenFile(file: string): HardenResult {
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(file, 0o600)
      return { ok: true, detail: 'chmod 600' }
    } catch (error) {
      return { ok: false, detail: errorMessage(error) }
    }
  }

  const user = currentWindowsUser()
  if (user === undefined) {
    return { ok: false, detail: 'missing USERNAME environment variable' }
  }

  const resolved = path.resolve(file)
  const precheck = verifyWindowsAcl(resolved, false)
  if (precheck.ok) return precheck

  const steps: readonly (readonly string[])[] = [
    [resolved, '/inheritance:r', '/grant:r', `${user}:F`, '/grant:r', `${WELL_KNOWN_SYSTEM_SID}:F`, '/grant:r', `${WELL_KNOWN_ADMINS_SID}:F`, '/Q'],
    [resolved, '/remove:g', ...PERMISSIVE_SIDS, '/Q'],
  ]
  for (const args of steps) {
    const outcome = runIcacls(args)
    if (!outcome.ok) return { ok: false, detail: outcome.detail }
  }

  return verifyWindowsAcl(resolved, false)
}

/** Returns a shell command a user can run manually to harden a directory on the current platform. */
export function manualDirCommand(dir: string): string {
  if (process.platform === 'win32') {
    const user = currentWindowsUser() ?? '%USERNAME%'
    const quoted = `"${dir}"`
    return [
      `icacls ${quoted} /T /Q /grant "${user}:F" /grant "${WELL_KNOWN_SYSTEM_SID}:F" /grant "${WELL_KNOWN_ADMINS_SID}:F"`,
      `icacls ${quoted} /inheritance:r /Q /grant "${user}:(OI)(CI)F" /grant "${WELL_KNOWN_SYSTEM_SID}:(OI)(CI)F" /grant "${WELL_KNOWN_ADMINS_SID}:(OI)(CI)F"`,
      `icacls ${quoted} /remove:g "${PERMISSIVE_SIDS.join('" "')}" /T /Q`,
    ].join('\n')
  }
  return `chmod -R go-rwx "${dir}"`
}

/** Creates a directory recursively with mode 0700 and enforces private ACLs. Throws if hardening fails. */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const result = hardenDir(dir)
  if (!result.ok) {
    throw new Error(`failed to harden directory ${dir}: ${result.detail}`)
  }
}
