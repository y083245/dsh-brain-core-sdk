import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSatelliteEnv, type SatelliteEnvInput } from '../src/env.ts'

const base: SatelliteEnvInput = {
  parent: {},
  platform: 'linux',
  osHome: '/brain/os-home',
  tmpDir: '/brain/tmp',
  apiKey: 'key',
  systemPrompt: 'persona',
  bridgeUrl: 'http://127.0.0.1:1',
  bridgeToken: 'token',
  maxOldSpaceMb: 512,
}

test('hostile parent variables never reach the child', () => {
  const env = buildSatelliteEnv({
    ...base,
    parent: {
      PATH: '/bin',
      HOME: '/home/real',
      DSH_HOME: '/home/real/.dsh',
      DSH_PROFILE: 'web',
      DSH_FUTURE_THING: 'x',
      XDG_CONFIG_HOME: '/home/real/.config',
      OPENAI_API_KEY: 'secret',
      GITHUB_TOKEN: 'secret',
      DEEPSEEK_BASE_URL: 'http://evil.example',
      NODE_OPTIONS: '--require=/evil.js',
    },
  })
  assert.equal(env.PATH, '/bin')
  assert.equal(env.HOME, '/brain/os-home')
  assert.equal(env.USERPROFILE, '/brain/os-home')
  assert.equal(env.NODE_OPTIONS, '--max-old-space-size=512')
  assert.equal(env.DEEPSEEK_BASE_URL, undefined)
  for (const key of Object.keys(env)) {
    assert.ok(!(key.startsWith('DSH_') && key !== 'DSH_SYSTEM_PROMPT'), `leaked ${key}`)
    assert.ok(!key.startsWith('XDG_'), `leaked ${key}`)
  }
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.GITHUB_TOKEN, undefined)
})

test('windows keeps its system variables whatever their case', () => {
  const env = buildSatelliteEnv({
    ...base,
    platform: 'win32',
    parent: { Path: 'C:\\Windows', SYSTEMROOT: 'C:\\Windows', comspec: 'C:\\cmd.exe', Temp: 'C:\\real-temp' },
  })
  assert.equal(env.PATH, 'C:\\Windows')
  assert.equal(env.SystemRoot, 'C:\\Windows')
  assert.equal(env.ComSpec, 'C:\\cmd.exe')
  assert.equal(env.TEMP, '/brain/tmp')
})

test('linux does not pick up windows-only variables', () => {
  const env = buildSatelliteEnv({ ...base, parent: { SystemRoot: 'x', ComSpec: 'y' } })
  assert.equal(env.SystemRoot, undefined)
  assert.equal(env.ComSpec, undefined)
})

test('proxies and a test gateway only appear when asked for', () => {
  const env = buildSatelliteEnv({
    ...base,
    parent: { HTTP_PROXY: 'http://inherited' },
    proxy: { https: 'http://chosen' },
    baseUrl: 'http://127.0.0.1:2',
  })
  assert.equal(env.HTTP_PROXY, undefined)
  assert.equal(env.HTTPS_PROXY, 'http://chosen')
  assert.equal(env.DEEPSEEK_BASE_URL, 'http://127.0.0.1:2')
})
