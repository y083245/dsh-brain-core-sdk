import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/cli.ts')

test('brain --version prints the package version', () => {
  const result = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, '0.0.0\n')
})

test('brain with no arguments prints the usage and exits 2', () => {
  const result = spawnSync(process.execPath, [cli], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.equal(result.stderr, 'Usage: brain --version\n')
})
