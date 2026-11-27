import assert from 'node:assert/strict'
import test from 'node:test'
import { PLAIN_PERMISSIONS } from '@dsh-brain-core/sdk'
import { describePermission } from '../../web/src/plugins/permissionText.ts'

test('every SDK plain permission has a Chinese description', () => {
  for (const permission of PLAIN_PERMISSIONS) {
    const result = describePermission(permission)
    assert.equal(result.known, true, permission)
    assert.match(result.text, /\p{Script=Han}/u)
  }
})

test('describes every parameterized permission kind and marks elevated risks', () => {
  for (const [permission, highRisk, lan] of [
    ['network:example.com', false, false], ['network:*.example.com', true, false],
    ['network:config:host', true, false], ['lan:192.168.1.5', true, true],
    ['lan:[::1]', true, true], ['lan:config:device.host', true, true],
    ['secrets:test', true, false], ['channel.send', true, false],
    ['agent.session', true, false], ['memory.forget', true, false],
  ] as const) {
    const result = describePermission(permission)
    assert.equal(result.known, true, permission)
    assert.equal(result.highRisk, highRisk, permission)
    assert.equal(result.lan, lan, permission)
    assert.match(result.text, /\p{Script=Han}/u)
  }
})

test('shows unknown and malformed permissions verbatim', () => {
  for (const permission of ['future.permission', 'network:config', 'lan:*.example.com', 'secrets:NOT_VALID']) {
    assert.deepEqual(describePermission(permission), { text: permission, known: false, highRisk: false, lan: false })
  }
})
