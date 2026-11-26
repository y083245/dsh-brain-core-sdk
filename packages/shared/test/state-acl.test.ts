import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import fs, { chmodSync, existsSync, statSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  ensurePrivateDir,
  hardenDir,
  hardenFile,
  hasInheritedPermissionAce,
  hasPermissionGrant,
  hasPermissiveTrustee,
  isHardened,
  manualDirCommand,
} from '../src/state-acl.ts'

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'brain-acl-'))
}

test('hasInheritedPermissionAce ignores Mandatory Label lines and detects inherited (I) ACEs', () => {
  assert.equal(hasInheritedPermissionAce(null), false)
  assert.equal(hasInheritedPermissionAce(undefined), false)
  assert.equal(hasInheritedPermissionAce(''), false)
  assert.equal(
    hasInheritedPermissionAce('Mandatory Label\\Low Mandatory Level:(I)(OI)(CI)(NW)\n'),
    false,
  )
  assert.equal(
    hasInheritedPermissionAce('mandatory label\\medium mandatory level:(I)(NW)'),
    false,
  )
  assert.equal(
    hasInheritedPermissionAce([
      'C:\\state\\dir NT AUTHORITY\\SYSTEM:(OI)(CI)(F)',
      '             BUILTIN\\Administrators:(OI)(CI)(F)',
      '             Mandatory Label\\Low Mandatory Level:(I)(OI)(CI)(NW)',
    ].join('\n')),
    false,
  )
  assert.equal(
    hasInheritedPermissionAce([
      'C:\\state\\dir NT AUTHORITY\\SYSTEM:(I)(OI)(CI)(F)',
      '             Mandatory Label\\Low Mandatory Level:(I)(OI)(CI)(NW)',
    ].join('\n')),
    true,
  )
})

test('hasPermissiveTrustee detects broad group names and SIDs case-insensitively', () => {
  assert.equal(hasPermissiveTrustee(null), false)
  assert.equal(hasPermissiveTrustee(undefined), false)
  assert.equal(hasPermissiveTrustee(''), false)
  assert.equal(
    hasPermissiveTrustee([
      'C:\\Users\\everyone\\state NT AUTHORITY\\SYSTEM:(OI)(CI)(F)',
      'C:\\Users\\everyone 2\\state BUILTIN\\Administrators:(OI)(CI)(F)',
      '                         MACHINE\\everyone_user:(OI)(CI)(F)',
      '                         BUILTIN\\Users2:(OI)(CI)(F)',
      '                         *S-1-5-110:(RX)',
      '                         *S-1-5-32-5450:(RX)',
      '                         *S-1-1-01:(RX)',
    ].join('\n')),
    false,
  )

  for (const sample of [
    '  NT AUTHORITY\\Authenticated Users:(I)(RX)',
    '  nt authority\\authenticated users:(F)',
    '  BUILTIN\\Users:(I)(RX)',
    '  builtin\\users:(R)',
    '  Everyone:(R)',
    '  everyone:(F)',
    '  *S-1-5-11:(RX)',
    '  *s-1-5-32-545:(rx)',
    '  *S-1-1-0:(R)',
  ]) {
    assert.equal(hasPermissiveTrustee(sample), true, sample)
  }
})

test('hasPermissionGrant requires a non-DENY, non-IO ACE on the target itself', () => {
  assert.equal(hasPermissionGrant(null), false)
  assert.equal(hasPermissionGrant(undefined), false)
  assert.equal(hasPermissionGrant(''), false)
  assert.equal(hasPermissionGrant('Mandatory Label\\Low Mandatory Level:(I)(OI)(CI)(NW)'), false)
  assert.equal(hasPermissionGrant('  BUILTIN\\Users:(DENY)(F)'), false)
  assert.equal(hasPermissionGrant('  BUILTIN\\Users:(OI)(CI)(DENY)(W)'), false)
  assert.equal(hasPermissionGrant('  BUILTIN\\Users:(N)'), false)
  assert.equal(hasPermissionGrant('  BUILTIN\\Administrators:(OI)(CI)(IO)(F)'), false)
  assert.equal(hasPermissionGrant('  NT AUTHORITY\\SYSTEM:(IO)(F)'), false)
  assert.equal(hasPermissionGrant('  NT AUTHORITY\\SYSTEM:(OI)(CI)'), false)

  // Path segments containing "(F)" without an ACE suffix must not count as grants
  assert.equal(hasPermissionGrant('C:\\tmp\\folder(F)\\sub'), false)
  assert.equal(hasPermissionGrant('C:\\tmp\\folder(F) BUILTIN\\Administrators:(IO)(F)'), false)
  assert.equal(hasPermissionGrant('C:\\tmp\\folder(F) BUILTIN\\Users:(DENY)(F)'), false)

  for (const sample of [
    'C:\\tmp\\folder(F) NT AUTHORITY\\SYSTEM:(OI)(CI)(F)',
    'C:\\tmp\\(DENY)\\dir BUILTIN\\Administrators:(F)',
    '  BUILTIN\\Administrators:(F)',
    '  MACHINE\\alice:(I)(M)',
    '  MACHINE\\alice:(NP)(RX)',
    '  MACHINE\\alice:(GR,GW)',
    '  NT AUTHORITY\\SYSTEM:(IO)(F)\n  MACHINE\\alice:(F)',
  ]) {
    assert.equal(hasPermissionGrant(sample), true, sample)
  }
})

test('manualDirCommand formats a platform-appropriate hardening command without mixing (OI)(CI) and /T', () => {
  const dir = path.join(tmpdir(), 'brain-manual-test')
  const assertWindowsCommandSafe = (cmd: string): void => {
    const lines = cmd.split('\n').filter((line) => line.trim() !== '')
    assert.equal(lines.length, 3)
    for (const line of lines) {
      assert.ok(line.includes('icacls'))
      assert.ok(line.includes(dir))
      const tokens = line.split(/\s+/)
      assert.equal(line.includes('(OI)(CI)') && tokens.includes('/T'), false, `unsafe combined flags in: ${line}`)
    }
    assert.ok(cmd.includes('/inheritance:r'))
    assert.ok(cmd.includes('*S-1-5-18'))
    assert.ok(cmd.includes('*S-1-5-32-544'))
    assert.ok(cmd.includes('/remove:g'))
    assert.ok(cmd.includes('*S-1-5-11'))
    assert.ok(cmd.includes('*S-1-5-32-545'))
    assert.ok(cmd.includes('*S-1-1-0'))
  }

  const cmd = manualDirCommand(dir)
  assert.ok(cmd.includes(dir))
  if (process.platform === 'win32') {
    assertWindowsCommandSafe(cmd)
  } else {
    assert.equal(cmd, `chmod -R go-rwx "${dir}"`)
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      assertWindowsCommandSafe(manualDirCommand(dir))
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  }
})

test('isHardened, hardenDir and hardenFile handle missing paths and enforce private permissions', async () => {
  const root = await tempDir()
  try {
    const missing = path.join(root, 'does-not-exist')
    assert.equal(isHardened(missing), false)
    assert.equal(hardenDir(missing).ok, false)
    assert.equal(hardenFile(missing).ok, false)

    const dir = path.join(root, 'private-dir')
    await ensurePrivateDir(dir)
    assert.equal(isHardened(dir), true)
    assert.equal(hardenDir(dir).ok, true)

    const file = path.join(dir, 'secret.txt')
    await writeFile(file, 'top-secret')

    if (process.platform !== 'win32') {
      chmodSync(dir, 0o755)
      assert.equal(isHardened(dir), false)
      chmodSync(dir, 0o740)
      assert.equal(isHardened(dir), false)
      chmodSync(dir, 0o704)
      assert.equal(isHardened(dir), false)
      const dirResult = hardenDir(dir)
      assert.equal(dirResult.ok, true)
      assert.equal(dirResult.detail, 'chmod 700')
      assert.equal(statSync(dir).mode & 0o777, 0o700)
      assert.equal(isHardened(dir), true)

      chmodSync(file, 0o644)
      assert.equal(isHardened(file), false)
      chmodSync(file, 0o604)
      assert.equal(isHardened(file), false)
      const fileResult = hardenFile(file)
      assert.equal(fileResult.ok, true)
      assert.equal(fileResult.detail, 'chmod 600')
      assert.equal(statSync(file).mode & 0o777, 0o600)
      assert.equal(isHardened(file), true)
    } else {
      const fileResult = hardenFile(file)
      assert.equal(fileResult.ok, true)
      assert.equal(isHardened(file), true)
      // Re-running hardenFile and hardenDir exercises the fast-path / check-before-mutate path
      assert.equal(hardenFile(file).ok, true)
      assert.equal(hardenDir(dir).ok, true)
      assert.equal(isHardened(dir), true)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ensurePrivateDir creates nested directories privately and fails when target is a file or hardening fails', async (t) => {
  const root = await tempDir()
  try {
    const nested = path.join(root, 'a', 'b', 'c')
    await ensurePrivateDir(nested)
    assert.equal(existsSync(nested), true)
    assert.equal(isHardened(nested), true)
    if (process.platform !== 'win32') {
      assert.equal(statSync(nested).mode & 0o777, 0o700)
    }
    // Idempotent second call
    await ensurePrivateDir(nested)
    assert.equal(isHardened(nested), true)

    const regularFile = path.join(root, 'not-a-dir')
    await writeFile(regularFile, 'hello')
    await assert.rejects(ensurePrivateDir(regularFile))

    const failDir = path.join(root, 'harden-fails')
    if (process.platform !== 'win32') {
      t.mock.method(fs, 'chmodSync', () => {
        throw new Error('simulated EPERM')
      })
    } else {
      t.mock.method(childProcess, 'spawnSync', () => ({
        pid: 0,
        output: [null, '', 'Access is denied.'],
        stdout: '',
        stderr: 'Access is denied.',
        status: 5,
        signal: null,
      }))
    }
    await assert.rejects(ensurePrivateDir(failDir), /failed to harden directory/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
