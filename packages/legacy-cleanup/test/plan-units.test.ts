import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { planCordisPatch } from '../src/cordis-patch.ts'
import { planPackageJson } from '../src/package-json.ts'
import { CLEANED_PATCH, LEGACY_PATCH, USER_ONLY_PATCH } from './helpers.ts'

const dshHome = path.join(os.tmpdir(), 'fake-dsh')

test('package.json removal fixes the trailing comma when the legacy entry is last', () => {
  const link = `link:${path.join(dshHome, 'plugins', 'qq-mode-console')}`
  const text = `${JSON.stringify({
    dependencies: { 'user-plugin': '1.0.0', 'qq-mode-console': link },
    dsh: { profile: { bundles: ['user-plugin', 'qq-mode-console'] } },
  }, null, 2)}\n`
  const plan = planPackageJson(text, { dshHome, bundleNames: ['qq-mode-console'] })
  assert.deepEqual(plan.manual, [])
  assert.ok(plan.nextText !== null)
  const parsed = JSON.parse(plan.nextText) as Record<string, unknown>
  assert.deepEqual(parsed.dependencies, { 'user-plugin': '1.0.0' })
  assert.deepEqual((parsed.dsh as { profile: { bundles: string[] } }).profile.bundles, ['user-plugin'])
})

test('package.json leaves a same-named dependency alone when it is not the legacy link', () => {
  const text = `${JSON.stringify({ dependencies: { 'qq-mode-console': '1.0.0' } }, null, 2)}\n`
  const plan = planPackageJson(text, { dshHome, bundleNames: ['qq-mode-console'] })
  assert.equal(plan.nextText, null)
  assert.equal(plan.manual.length, 1)
  assert.match(plan.manual[0] ?? '', /not the legacy link/)
})

test('cordis.patch.yml keeps user comments, user entries and a shared insert parent', () => {
  const plan = planCordisPatch(LEGACY_PATCH)
  assert.deepEqual(plan.manual, [])
  assert.equal(plan.nextText, CLEANED_PATCH)
  assert.ok(plan.removals.includes('MCP server "mcp-snowluma"'))
  assert.ok(plan.removals.includes('settings namespace "qq-mode"'))
})

test('cordis.patch.yml keeps CRLF line endings', () => {
  const plan = planCordisPatch(LEGACY_PATCH.replace(/\r?\n/g, '\r\n'))
  assert.equal(plan.nextText, CLEANED_PATCH.replace(/\r?\n/g, '\r\n'))
})

test('cordis.patch.yml without legacy entries is untouched', () => {
  const plan = planCordisPatch(USER_ONLY_PATCH)
  assert.equal(plan.nextText, null)
  assert.deepEqual(plan.manual, [])
  assert.deepEqual(plan.removals, [])
})

test('an empty root sequence is untouched', () => {
  const plan = planCordisPatch('[]\n')
  assert.equal(plan.nextText, null)
  assert.deepEqual(plan.manual, [])
})

test('an insert parent with other selectors survives with an empty insert list', () => {
  const text = `- id: shared
  before: something
  insert:
    - id: mcp-snowluma
      name: '@deepseek-ai/dsh-mcp-client'
`
  const plan = planCordisPatch(text)
  assert.deepEqual(plan.manual, [])
  assert.equal(plan.nextText, `- id: shared
  before: something
  insert: []
`)
})
