import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { isHardened } from '@dsh-brain-core/shared'
import { prepareBrainHome, resolveBrainHome, type BrainPaths } from '../../src/home/index.ts'

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'brain-home-'))
}

function allDirectories(paths: BrainPaths): string[] {
  return [
    paths.home, paths.state, paths.satellite, paths.satelliteDshHome, paths.satelliteOsHome, paths.satelliteTmp,
    paths.workspaceChat, paths.workspaceActivity, paths.memory, paths.plugins,
  ]
}

test('resolveBrainHome uses <userHome>/.brain-core by default', () => {
  const userHome = path.resolve(path.sep, 'tmp', 'brain-user-home')
  assert.equal(resolveBrainHome({}, userHome), path.join(userHome, '.brain-core'))
  assert.equal(resolveBrainHome({ BRAIN_HOME: '   ' }, userHome), path.join(userHome, '.brain-core'))
})

test('resolveBrainHome turns a relative BRAIN_HOME into an absolute path', () => {
  const relative = resolveBrainHome({ BRAIN_HOME: 'relative/brain' }, path.join(path.sep, 'tmp', 'home'))
  assert.equal(path.isAbsolute(relative), true)
  assert.equal(relative, path.resolve('relative/brain'))
})

test('prepareBrainHome refuses a home inside the user .dsh and creates nothing', async () => {
  const userHome = await tempDir()
  try {
    const brainHome = path.join(userHome, '.dsh', 'brain')
    await assert.rejects(
      prepareBrainHome({ env: { BRAIN_HOME: brainHome }, userHome }),
      /BRAIN_HOME must not be inside a DSH home/,
    )
    assert.equal(existsSync(path.join(userHome, '.dsh')), false)
    assert.equal(existsSync(brainHome), false)
  } finally {
    await rm(userHome, { recursive: true, force: true })
  }
})

test('prepareBrainHome refuses a home inside DSH_HOME and creates nothing', async () => {
  const userHome = await tempDir()
  try {
    const dshHome = path.join(userHome, 'other-dsh-home')
    const brainHome = path.join(dshHome, 'brain')
    await assert.rejects(
      prepareBrainHome({ env: { BRAIN_HOME: brainHome, DSH_HOME: dshHome }, userHome }),
      /BRAIN_HOME must not be inside a DSH home/,
    )
    assert.equal(existsSync(dshHome), false)
    assert.equal(existsSync(brainHome), false)
  } finally {
    await rm(userHome, { recursive: true, force: true })
  }
})

test('prepareBrainHome creates every RFC 9.4 directory with mode 700', async () => {
  const userHome = await tempDir()
  try {
    const paths = await prepareBrainHome({ env: { BRAIN_HOME: path.join(userHome, 'brain') }, userHome })
    assert.equal(paths.home, path.join(userHome, 'brain'))
    assert.equal(paths.secretsFile, path.join(paths.state, 'secrets.json'))
    for (const dir of allDirectories(paths)) {
      assert.equal((await stat(dir)).isDirectory(), true, `${dir} is not a directory`)
      if (process.platform === 'win32') assert.equal(isHardened(dir), true)
      else assert.equal((await stat(dir)).mode & 0o777, 0o700)
    }
    assert.equal(existsSync(paths.secretsFile), false)
  } finally {
    await rm(userHome, { recursive: true, force: true })
  }
})

test('prepareBrainHome falls back to <userHome>/.brain-core when BRAIN_HOME is blank', async () => {
  const userHome = await tempDir()
  try {
    const paths = await prepareBrainHome({ env: { BRAIN_HOME: '' }, userHome })
    assert.equal(paths.home, path.join(userHome, '.brain-core'))
    assert.equal(existsSync(paths.home), true)
  } finally {
    await rm(userHome, { recursive: true, force: true })
  }
})
