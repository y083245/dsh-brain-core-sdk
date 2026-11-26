import assert from 'node:assert/strict'
import test from 'node:test'
import { createFakeChannel } from '../src/index.ts'

test('createFakeChannel records sends and returns the members it was given', async () => {
  const channel = createFakeChannel()
  channel.setMembers('demo:group:1', ['p1', 'p2'])
  assert.deepEqual(await channel.members('demo:group:1'), ['p1', 'p2'])
  assert.deepEqual(await channel.members('demo:group:2'), [])
  assert.equal(await channel.resolveIdentity('demo:42'), null)
  const first = await channel.send('demo:group:1', { text: 'hello', replyTo: 'm0' })
  const second = await channel.send('demo:group:1', { images: [{ mediaType: 'image/png', base64: 'AA==' }] })
  assert.deepEqual(first, { messageId: 'msg_1' })
  assert.deepEqual(second, { messageId: 'msg_2' })
  assert.deepEqual(channel.sent, [
    { channel: 'demo:group:1', message: { text: 'hello', replyTo: 'm0' } },
    { channel: 'demo:group:1', message: { images: [{ mediaType: 'image/png', base64: 'AA==' }] } },
  ])
  channel.setMembers('demo:group:1', ['p3'])
  assert.deepEqual(await channel.members('demo:group:1'), ['p3'])
})
