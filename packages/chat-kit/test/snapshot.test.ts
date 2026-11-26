import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildMessageSnapshot, formatRelativeTime, truncateCodePoints } from '../src/index.ts'

describe('snapshot', () => {
  it('formats relative time across all boundary buckets', () => {
    assert.equal(formatRelativeTime(-5_000), '刚刚')
    assert.equal(formatRelativeTime(0), '刚刚')
    assert.equal(formatRelativeTime(59_999), '刚刚')
    assert.equal(formatRelativeTime(60_000), '1 分钟前')
    assert.equal(formatRelativeTime(3_599_999), '59 分钟前')
    assert.equal(formatRelativeTime(3_600_000), '1 小时前')
    assert.equal(formatRelativeTime(86_399_999), '23 小时前')
    assert.equal(formatRelativeTime(86_400_000), '1 天前')
    assert.equal(formatRelativeTime(3 * 86_400_000), '3 天前')
  })

  it('truncates by Unicode code points without splitting surrogate pairs', () => {
    const emojis = '😀😁😂🤣😃😄'
    assert.equal(truncateCodePoints(emojis, 6), emojis)
    const truncated = truncateCodePoints(emojis, 4)
    assert.equal(truncated, '😀😁😂…')
    assert.equal([...truncated].length, 4)
    assert.equal(Buffer.from(truncated, 'utf8').toString('utf8'), truncated)
    assert.equal(truncateCodePoints(emojis, 1), '…')
    assert.equal(truncateCodePoints(emojis, 0), '')
  })

  it('builds compact snapshots enforcing maxMessages and maxTotalChars newest-first in ascending order', () => {
    const now = 10_000_000
    const messages = [
      { id: '1', who: 'A', text: 'oldest', tEvent: now - 2 * 86_400_000 },
      { id: '2', who: 'B', text: '1234567890', tEvent: now - 3_600_000, direction: 'inbound' as const, hasMedia: true },
      { id: '3', who: 'C', text: 'abcdef', tEvent: now - 120_000, direction: 'outbound' as const, forwarded: true },
      { id: '4', who: 'D', text: 'latest-msg', tEvent: now - 5_000 },
    ] as const

    const snap = buildMessageSnapshot(messages, now, {
      maxMessages: 3,
      maxMessageChars: 8,
      maxTotalChars: 15,
    })

    // Message 4 truncated to 8 chars ('latest-…', 8 chars) + Message 3 ('abcdef', 6 chars) = 14 <= 15
    // Message 2 ('1234567…', 8 chars) would exceed 15, so only 3 and 4 remain in ascending order.
    assert.deepEqual(snap, [
      { id: '3', who: 'C', ago: '2 分钟前', text: 'abcdef', direction: 'outbound', forwarded: true },
      { id: '4', who: 'D', ago: '刚刚', text: 'latest-…' },
    ])

    // Exact maxMessageChars keeps text without ellipsis; budget smaller than newest item yields empty
    const exactSnap = buildMessageSnapshot(
      [{ id: '5', who: 'E', text: '1234', tEvent: now, hasMedia: false }],
      now,
      { maxMessageChars: 4, maxTotalChars: 4 },
    )
    assert.deepEqual(exactSnap, [{ id: '5', who: 'E', ago: '刚刚', text: '1234' }])
    assert.deepEqual(buildMessageSnapshot([{ id: '6', who: 'F', text: '12345', tEvent: now }], now, { maxTotalChars: 4 }), [])

    assert.deepEqual(buildMessageSnapshot(messages, now, { maxMessages: 0 }), [])
  })
})
