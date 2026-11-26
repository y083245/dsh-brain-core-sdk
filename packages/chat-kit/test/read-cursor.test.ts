import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createReadCursor } from '../src/index.ts'

describe('read-cursor', () => {
  it('tracks inbound unread counts with messageId deduplication and markRead reset', () => {
    const cursor = createReadCursor()
    assert.deepEqual(cursor.get('ch1'), { unreadCount: 0 })

    const s1 = cursor.onInbound('ch1', 'm1', 100)
    assert.equal(s1.unreadCount, 1)
    assert.equal(s1.lastInboundMessageId, 'm1')
    assert.equal(s1.lastInboundAt, 100)

    // Duplicate messageId does not increment unreadCount
    const s1Dup = cursor.onInbound('ch1', 'm1', 105)
    assert.equal(s1Dup.unreadCount, 1)

    const s2 = cursor.onInbound('ch1', 'm2', 200)
    assert.equal(s2.unreadCount, 2)
    assert.equal(s2.lastInboundMessageId, 'm2')

    const afterRead = cursor.markRead('ch1', 'm2', 250)
    assert.equal(afterRead.unreadCount, 0)
    assert.equal(afterRead.lastReadMessageId, 'm2')
    assert.equal(afterRead.lastReadAt, 250)

    // Inbound with already-read id does not re-increment
    const afterReadDup = cursor.onInbound('ch1', 'm2', 260)
    assert.equal(afterReadDup.unreadCount, 0)
  })

  it('slices unread messages strictly after lastReadMessageId', () => {
    const cursor = createReadCursor()
    const messages = [
      { messageId: 'm1', text: 'one' },
      { messageId: 'm2', text: 'two' },
      { messageId: 'm3', text: 'three' },
    ] as const

    // Unknown watermark returns all messages
    assert.deepEqual(cursor.unreadOf('ch1', messages), messages)

    cursor.markRead('ch1', 'm1', 100)
    assert.deepEqual(cursor.unreadOf('ch1', messages), [
      { messageId: 'm2', text: 'two' },
      { messageId: 'm3', text: 'three' },
    ])

    cursor.markRead('ch1', 'm3', 300)
    assert.deepEqual(cursor.unreadOf('ch1', messages), [])

    // Unknown lastReadMessageId in list returns all messages
    cursor.markRead('ch1', 'm0', 50)
    assert.deepEqual(cursor.unreadOf('ch1', messages), messages)
  })

  it('supports snapshot serialization and restoration', () => {
    const cursor1 = createReadCursor()
    cursor1.onInbound('ch1', 'm1', 100)
    cursor1.markRead('ch2', 'm9', 900)
    cursor1.onInbound('ch2', 'm10', 950)

    const snap = JSON.parse(JSON.stringify(cursor1.snapshot())) as ReturnType<typeof cursor1.snapshot>
    const cursor2 = createReadCursor(snap)

    assert.deepEqual(cursor2.get('ch1'), cursor1.get('ch1'))
    assert.deepEqual(cursor2.get('ch2'), cursor1.get('ch2'))
    assert.equal(cursor2.onInbound('ch1', 'm1', 100).unreadCount, 1)

    assert.throws(() => createReadCursor('bad' as never), TypeError)
    assert.throws(() => cursor2.onInbound('', 'm1', 100), RangeError)
    assert.throws(() => cursor2.markRead('ch1', 'm1', Number.NaN), RangeError)
  })
})
