import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import type { InstalledPlugin } from '../../src/contracts/index.ts'
import { pluginEnvironment } from '../../src/plugin-external/env.ts'

function plugin(): InstalledPlugin {
  return {
    manifest: { id: 'echo', kinds: ['capability'], api: '^1', runtime: 'process', process: { command: 'x' }, permissions: [] },
    version: '1.0.0', dir: '/nowhere', granted: [], config: {},
  }
}

test('Windows also gets only SystemRoot, ComSpec, PATHEXT and WINDIR from the parent', () => {
  const env = pluginEnvironment(plugin(), '/state', {
    PATH: '/bin', LANG: 'zh', SystemRoot: 'C:\\Windows', ComSpec: 'cmd.exe', PATHEXT: '.EXE', WINDIR: 'C:\\Windows',
    SENTINEL: 'must-not-leak', HOME: '/parent',
  }, {}, 'win32')
  assert.equal(env.PATH, '/bin')
  assert.equal(env.LANG, 'zh')
  assert.equal(env.SystemRoot, 'C:\\Windows')
  assert.equal(env.ComSpec, 'cmd.exe')
  assert.equal(env.PATHEXT, '.EXE')
  assert.equal(env.WINDIR, 'C:\\Windows')
  assert.equal(env.SENTINEL, undefined)
  assert.equal(env.HOME, path.join('/state', 'echo', 'home'))
  assert.equal(env.USERPROFILE, path.join('/state', 'echo', 'home'))
  assert.equal(env.TMPDIR, path.join('/state', 'echo', 'tmp'))
})

test('POSIX refuses the Windows-only variables and lets extra values win', () => {
  const env = pluginEnvironment(plugin(), '/state', {
    PATH: '/bin', LANG: 'zh', LC_ALL: 'C', TZ: 'UTC', SystemRoot: 'C:\\Windows', SENTINEL: 'x', HOME: '/parent',
  }, { LANG: 'en', TOKEN: 'secret' }, 'linux')
  assert.equal(env.PATH, '/bin')
  assert.equal(env.LANG, 'en')
  assert.equal(env.LC_ALL, 'C')
  assert.equal(env.TZ, 'UTC')
  assert.equal(env.TOKEN, 'secret')
  assert.equal(env.SystemRoot, undefined)
  assert.equal(env.SENTINEL, undefined)
  assert.equal(env.HOME, path.join('/state', 'echo', 'home'))
})
