import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { assertOutsideDshHome } from '../src/satellite.ts'

const home = path.resolve('/users/someone')

test('BRAIN_HOME inside the default DSH home is refused', () => {
  assert.throws(() => assertOutsideDshHome(path.join(home, '.dsh', 'brain'), {}, home), /must not be inside/)
})

test('BRAIN_HOME inside a custom DSH_HOME is refused', () => {
  const custom = path.resolve('/data/dsh')
  assert.throws(() => assertOutsideDshHome(path.join(custom, 'brain'), { DSH_HOME: custom }, home), /must not be inside/)
})

test('the default BRAIN_HOME is fine', () => {
  assert.doesNotThrow(() => assertOutsideDshHome(path.join(home, '.brain-core'), {}, home))
})
