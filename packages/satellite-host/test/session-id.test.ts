import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeSessionId, encodeSessionId } from '../src/session-id.ts'

test('a binding survives a round trip', () => {
  const binding = { agentClass: 'chat', channel: 'qq:group:20001', generation: 3 } as const
  assert.deepEqual(decodeSessionId(encodeSessionId(binding)), binding)
})

test('the id is a single safe path segment even for odd channels', () => {
  const id = encodeSessionId({ agentClass: 'activity', channel: 'web:feed:路径/../x?y', generation: 0 })
  assert.match(id, /^[A-Za-z0-9_-]+$/)
  assert.equal(decodeSessionId(id)?.channel, 'web:feed:路径/../x?y')
})

test('ids we did not mint decode to null', () => {
  assert.equal(decodeSessionId('session-1234'), null)
  assert.equal(decodeSessionId('brn-admin-cXE6Z3JvdXA6MQ-0'), null)
  assert.equal(decodeSessionId('brn-chat-!!!!-0'), null)
  assert.equal(decodeSessionId(''), null)
})

test('non-canonical base64 is refused', () => {
  const id = encodeSessionId({ agentClass: 'chat', channel: 'qq:group:1', generation: 0 })
  const mangled = id.replace(/-0$/, '=-0')
  assert.equal(decodeSessionId(mangled), null)
})

test('bad channels and generations cannot be encoded', () => {
  assert.throws(() => encodeSessionId({ agentClass: 'chat', channel: 'no-colons', generation: 0 }), RangeError)
  assert.throws(() => encodeSessionId({ agentClass: 'chat', channel: `a:b:${'x'.repeat(200)}`, generation: 0 }), RangeError)
  assert.throws(() => encodeSessionId({ agentClass: 'chat', channel: 'a:b:c', generation: -1 }), RangeError)
})
