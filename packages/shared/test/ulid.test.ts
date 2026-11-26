import assert from 'node:assert/strict'
import test from 'node:test'
import { createUlid, ulidTime } from '../src/ulid.ts'

const ALPHABET = /^[0-9A-HJKMNP-TV-Z]{26}$/

test('createUlid stays strictly increasing at the same millisecond', () => {
  const next = createUlid({ now: () => 1_760_000_000_000 })
  const ids: string[] = []
  for (let index = 0; index < 1000; index += 1) ids.push(next())
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index] as string
    assert.match(id, ALPHABET)
    if (index > 0) assert.ok(id > (ids[index - 1] as string), `id ${index} is not increasing`)
  }
  assert.equal(new Set(ids).size, ids.length)
})

test('ulidTime decodes the encoded millisecond', () => {
  const at = 1_760_123_456_789
  const id = createUlid({ now: () => at })()
  assert.equal(ulidTime(id), at)
})

test('createUlid keeps increasing when the clock goes backwards', () => {
  let now = 2000
  const next = createUlid({ now: () => now })
  const first = next()
  now = 1000
  const second = next()
  assert.ok(second > first)
  // 时钟倒退时时间部分沿用上一个，ID 仍按字符串排序。
  assert.equal(ulidTime(second), 2000)
  assert.equal(ulidTime(first), 2000)
})

test('ulidTime rejects a malformed ULID', () => {
  assert.throws(() => ulidTime('short'), /invalid ULID/)
  assert.throws(() => ulidTime('I'.repeat(26)), /invalid ULID/)
})
