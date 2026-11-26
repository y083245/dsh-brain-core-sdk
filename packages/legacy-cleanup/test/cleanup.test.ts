import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { readManifest } from '../src/backup.ts'
import {
  backupDirectories,
  CLEANED_PATCH,
  CREDENTIALS,
  createFixture,
  fingerprintTree,
  LINK_TYPE,
  packageJsonText,
  PROFILE_NAMES,
  removeFixture,
  runCli,
  type Fixture,
} from './helpers.ts'

function withFixture(t: TestContext, legacy: boolean): Promise<Fixture> {
  return createFixture({ legacy }).then(fixture => {
    t.after(() => removeFixture(fixture))
    return fixture
  })
}

function profileFile(fixture: Fixture, profile: string, name: string): string {
  return path.join(fixture.dshHome, 'profiles', profile, name)
}

test('plan leaves the DSH home byte-identical', async t => {
  const fixture = await withFixture(t, true)
  const before = await fingerprintTree(fixture.dshHome)
  const result = runCli(['plan', '--dsh-home', fixture.dshHome], { brainHome: fixture.brainHome })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(await fingerprintTree(fixture.dshHome), before)
  assert.deepEqual(await backupDirectories(fixture.brainHome), [])
  assert.match(result.stdout, /mcp-snowluma/)
  assert.match(result.stdout, /qq-mode/)
})

test('apply without --yes changes nothing', async t => {
  const fixture = await withFixture(t, true)
  const before = await fingerprintTree(fixture.dshHome)
  const result = runCli(['apply', '--dsh-home', fixture.dshHome], { brainHome: fixture.brainHome })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /refused/)
  assert.deepEqual(await fingerprintTree(fixture.dshHome), before)
  assert.deepEqual(await backupDirectories(fixture.brainHome), [])
})

test('apply removes the legacy entries and keeps every user byte', async t => {
  const fixture = await withFixture(t, true)
  const result = runCli(['apply', '--dsh-home', fixture.dshHome, '--yes'], { brainHome: fixture.brainHome })
  assert.equal(result.status, 0, result.stderr)

  for (const profile of PROFILE_NAMES) {
    assert.equal(await fs.readFile(profileFile(fixture, profile, 'cordis.patch.yml'), 'utf8'), CLEANED_PATCH,
      `${profile}: comments and user entries must survive byte-for-byte`)
    assert.equal(await fs.readFile(profileFile(fixture, profile, 'package.json'), 'utf8'),
      packageJsonText(fixture.dshHome, profile, false), `${profile}: only the legacy package entries may disappear`)
    const userLink = path.join(fixture.dshHome, 'profiles', profile, 'node_modules', 'user-plugin')
    assert.equal((await fs.lstat(userLink)).isSymbolicLink(), true, `${profile}: user link must stay`)
  }
  assert.equal(await fs.readFile(path.join(fixture.dshHome, '.credentials.yaml'), 'utf8'), CREDENTIALS)
  await assert.rejects(fs.lstat(path.join(fixture.dshHome, 'plugins', 'qq-mode-console')), { code: 'ENOENT' })
  await assert.rejects(fs.lstat(path.join(fixture.dshHome, 'plugins', 'qq-agent-presets')), { code: 'ENOENT' })

  const backups = await backupDirectories(fixture.brainHome)
  assert.equal(backups.length, 1)
  const backupDir = path.join(fixture.brainHome, 'state', 'legacy-cleanup', backups[0]!)
  const manifest = await readManifest(backupDir)
  assert.equal(manifest.items.length, 10)
  assert.equal(await fs.readFile(path.join(backupDir, 'files', 'profiles', 'web', 'package.json'), 'utf8'),
    packageJsonText(fixture.dshHome, 'web', true))
})

test('restore reproduces the pre-cleanup tree byte-for-byte', async t => {
  const fixture = await withFixture(t, true)
  const before = await fingerprintTree(fixture.dshHome)
  const applied = runCli(['apply', '--dsh-home', fixture.dshHome, '--yes'], { brainHome: fixture.brainHome })
  assert.equal(applied.status, 0, applied.stderr)
  const backups = await backupDirectories(fixture.brainHome)
  const backupDir = path.join(fixture.brainHome, 'state', 'legacy-cleanup', backups[0]!)

  const afterApply = await fingerprintTree(fixture.dshHome)
  const refused = runCli(['restore', '--backup', backupDir, '--dsh-home', fixture.dshHome], { brainHome: fixture.brainHome })
  assert.notEqual(refused.status, 0)
  assert.deepEqual(await fingerprintTree(fixture.dshHome), afterApply)

  const restored = runCli(['restore', '--backup', backupDir, '--dsh-home', fixture.dshHome, '--yes'], { brainHome: fixture.brainHome })
  assert.equal(restored.status, 0, restored.stderr)
  assert.deepEqual(await fingerprintTree(fixture.dshHome), before)
})

test('apply on a home without the legacy install is a no-op', async t => {
  const fixture = await withFixture(t, false)
  const before = await fingerprintTree(fixture.dshHome)
  const result = runCli(['apply', '--dsh-home', fixture.dshHome, '--yes'], { brainHome: fixture.brainHome })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /nothing to clean up/)
  assert.deepEqual(await fingerprintTree(fixture.dshHome), before)
  assert.deepEqual(await backupDirectories(fixture.brainHome), [])
})

test('a repeated apply is idempotent and does not back up again', async t => {
  const fixture = await withFixture(t, true)
  const first = runCli(['apply', '--dsh-home', fixture.dshHome, '--yes'], { brainHome: fixture.brainHome })
  assert.equal(first.status, 0, first.stderr)
  const backupsBefore = await backupDirectories(fixture.brainHome)
  const backupTreeBefore = await fingerprintTree(path.join(fixture.brainHome, 'state', 'legacy-cleanup'))

  const second = runCli(['apply', '--dsh-home', fixture.dshHome, '--yes'], { brainHome: fixture.brainHome })
  assert.equal(second.status, 0, second.stderr)
  assert.match(second.stdout, /nothing to clean up/)
  assert.deepEqual(await backupDirectories(fixture.brainHome), backupsBefore)
  assert.deepEqual(await fingerprintTree(path.join(fixture.brainHome, 'state', 'legacy-cleanup')), backupTreeBefore)
})

test('a bundle link is kept while another profile still uses it', async t => {
  const fixture = await withFixture(t, true)
  const customDir = path.join(fixture.dshHome, 'profiles', 'custom')
  await fs.mkdir(path.join(customDir, 'node_modules'), { recursive: true })
  await fs.writeFile(path.join(customDir, 'package.json'), '{\n  "name": "dsh-profile-custom"\n}\n', 'utf8')
  await fs.writeFile(path.join(customDir, 'notes.txt'), 'do not touch\n', 'utf8')
  await fs.symlink(path.join(fixture.dshHome, 'plugins', 'qq-mode-console'),
    path.join(customDir, 'node_modules', 'qq-mode-console'), LINK_TYPE)
  const customBefore = await fingerprintTree(customDir)

  const plan = runCli(['plan', '--dsh-home', fixture.dshHome], { brainHome: fixture.brainHome })
  assert.equal(plan.status, 0, plan.stderr)
  assert.match(plan.stdout,
    /manual\s+plugins\/qq-mode-console: profile "custom" still uses node_modules\/qq-mode-console; plugins\/qq-mode-console kept/)

  const applied = runCli(['apply', '--dsh-home', fixture.dshHome, '--yes'], { brainHome: fixture.brainHome })
  assert.equal(applied.status, 0, applied.stderr)
  assert.equal((await fs.lstat(path.join(fixture.dshHome, 'plugins', 'qq-mode-console'))).isSymbolicLink(), true,
    'the bundle still used by the custom profile must stay')
  await assert.rejects(fs.lstat(path.join(fixture.dshHome, 'plugins', 'qq-agent-presets')), { code: 'ENOENT' })
  assert.deepEqual(await fingerprintTree(customDir), customBefore, 'the custom profile must not change')
})

test('a missing --dsh-home is a usage error', async t => {
  const fixture = await withFixture(t, false)
  for (const args of [['plan'], ['apply', '--yes'], ['restore', '--backup', fixture.brainHome, '--yes']]) {
    const result = runCli(args, { brainHome: fixture.brainHome })
    assert.notEqual(result.status, 0, args.join(' '))
    assert.match(result.stderr, /--dsh-home is required/)
  }
  assert.deepEqual(await backupDirectories(fixture.brainHome), [])
})

test('BRAIN_HOME inside the DSH home is refused before anything is written', async t => {
  const fixture = await withFixture(t, true)
  const before = await fingerprintTree(fixture.dshHome)
  const result = runCli(['apply', '--dsh-home', fixture.dshHome, '--yes'], { brainHome: path.join(fixture.dshHome, 'state') })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /must not be inside the DSH home/)
  assert.deepEqual(await fingerprintTree(fixture.dshHome), before)
})

test('the credentials file is never opened', async t => {
  const fixture = await withFixture(t, true)
  const credentials = path.join(fixture.dshHome, '.credentials.yaml')
  if (process.platform === 'linux') await fs.chmod(credentials, 0o000)

  const plan = runCli(['plan', '--dsh-home', fixture.dshHome], { brainHome: fixture.brainHome })
  assert.equal(plan.status, 0, plan.stderr)
  const applied = runCli(['apply', '--dsh-home', fixture.dshHome, '--yes'], { brainHome: fixture.brainHome })
  assert.equal(applied.status, 0, applied.stderr)
  const backups = await backupDirectories(fixture.brainHome)
  const restored = runCli(['restore', '--backup', path.join(fixture.brainHome, 'state', 'legacy-cleanup', backups[0]!),
    '--dsh-home', fixture.dshHome, '--yes'], { brainHome: fixture.brainHome })
  assert.equal(restored.status, 0, restored.stderr)
  assert.doesNotMatch(`${plan.stderr}${applied.stderr}${restored.stderr}`, /EACCES|permission denied/i)
  if (process.platform === 'linux') await fs.chmod(credentials, 0o600)
  assert.equal(await fs.readFile(credentials, 'utf8'), CREDENTIALS)
})
