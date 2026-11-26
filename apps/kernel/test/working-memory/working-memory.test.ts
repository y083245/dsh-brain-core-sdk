import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { BrainError } from '@brain-core/sdk'
import { MAX_WORKING_MEMORY_TTL_MS, createWorkingMemoryStore } from '../../src/working-memory/index.ts'
import { FakeClock } from '../fakes/index.ts'

const NOW = Date.UTC(2026, 10, 19, 10, 0, 0)
const CH1 = 'qq:group:100'
const CH2 = 'qq:private:200'

test('MAX_WORKING_MEMORY_TTL_MS is 24 hours', () => {
  assert.equal(MAX_WORKING_MEMORY_TTL_MS, 86_400_000)
})

test('put stores items visible before expiresAt and hidden at or after expiresAt (FR-M17)', async () => {
  const clock = new FakeClock(NOW)
  const store = createWorkingMemoryStore({ clock })

  const item = await store.put({ channel: CH1, key: 'topic', text: 'planning weekend trip', ttlMs: 10_000 })
  assert.ok(item.id.startsWith('wm_'))
  assert.equal(item.createdAt, NOW)
  assert.equal(item.updatedAt, NOW)
  assert.equal(item.expiresAt, NOW + 10_000)

  const activeBefore = await store.listActive(CH1, NOW + 9_999)
  assert.equal(activeBefore.length, 1)
  assert.equal(activeBefore[0]?.id, item.id)

  // Other channel never sees it.
  assert.deepEqual(await store.listActive(CH2, NOW), [])

  // At exact expiry boundary and after, it must not be returned.
  assert.deepEqual(await store.listActive(CH1, NOW + 10_000), [])
  assert.deepEqual(await store.listActive(CH1, NOW + 10_001), [])
})

test('listActive sorts by updatedAt desc then id asc', async () => {
  const clock = new FakeClock(NOW)
  const store = createWorkingMemoryStore({ clock })

  const a = await store.put({ channel: CH1, key: 'k1', text: 'first' })
  const b = await store.put({ channel: CH1, key: 'k2', text: 'second' })
  clock.advance(1_000)
  const c = await store.put({ channel: CH1, key: 'k3', text: 'newer' })

  const items = await store.listActive(CH1)
  assert.deepEqual(items.map((item) => item.id), [c.id, ...[a.id, b.id].sort()])
})

test('put updates active (channel, key) in place and allocates new id after expiry', async () => {
  const clock = new FakeClock(NOW)
  const store = createWorkingMemoryStore({ clock })

  const first = await store.put({
    channel: CH1,
    key: 'draft',
    text: 'v1',
    ttlMs: 5_000,
    promoteToL1: true,
    evidence: [{ id: 'l0_1' }],
  })

  clock.advance(2_000)
  const updated = await store.put({
    channel: CH1,
    key: 'draft',
    text: 'v2',
    ttlMs: 5_000,
    promoteToL1: false,
  })

  assert.equal(updated.id, first.id)
  assert.equal(updated.createdAt, first.createdAt)
  assert.equal(updated.updatedAt, NOW + 2_000)
  assert.equal(updated.expiresAt, NOW + 7_000)
  assert.equal(updated.text, 'v2')
  assert.equal(updated.promoteToL1, false)
  assert.equal(updated.evidence, undefined)

  // Advance past expiry -> new put generates a fresh id.
  clock.set(updated.expiresAt)
  const recreated = await store.put({ channel: CH1, key: 'draft', text: 'v3' })
  assert.notEqual(recreated.id, first.id)
  assert.equal(recreated.createdAt, updated.expiresAt)
  assert.equal(recreated.expiresAt, updated.expiresAt + MAX_WORKING_MEMORY_TTL_MS)
  assert.deepEqual((await store.listActive(CH1)).map((item) => item.id), [recreated.id])

  // Same key on a different channel stays isolated and does not overwrite CH1.
  const otherChannel = await store.put({ channel: CH2, key: 'draft', text: 'other channel text' })
  assert.notEqual(otherChannel.id, recreated.id)
  assert.equal((await store.listActive(CH1))[0]?.text, 'v3')
  assert.equal((await store.listActive(CH2))[0]?.text, 'other channel text')
})

test('put rejects invalid channel, key, text, ttlMs, and promoteToL1 without evidence', async () => {
  const clock = new FakeClock(NOW)
  const store = createWorkingMemoryStore({ clock })

  const badInputs = [
    { channel: '', key: 'k', text: 't' },
    { channel: '   ', key: 'k', text: 't' },
    { channel: CH1, key: '', text: 't' },
    { channel: CH1, key: '  ', text: 't' },
    { channel: CH1, key: 'k', text: '' },
    { channel: CH1, key: 'k', text: '\t\n' },
    { channel: CH1, key: 'k', text: 't', ttlMs: 0 },
    { channel: CH1, key: 'k', text: 't', ttlMs: -100 },
    { channel: CH1, key: 'k', text: 't', ttlMs: MAX_WORKING_MEMORY_TTL_MS + 1 },
    { channel: CH1, key: 'k', text: 't', ttlMs: Number.NaN },
    { channel: CH1, key: 'k', text: 't', ttlMs: Number.POSITIVE_INFINITY },
    { channel: CH1, key: 'k', text: 't', promoteToL1: true },
    { channel: CH1, key: 'k', text: 't', promoteToL1: true, evidence: [] },
  ]

  for (const input of badInputs) {
    await assert.rejects(
      () => store.put(input),
      (err: unknown) => err instanceof BrainError && err.code === 'INVALID_ARGUMENT',
    )
  }
})

test('remove deletes existing item and returns false for missing id', async () => {
  const clock = new FakeClock(NOW)
  const store = createWorkingMemoryStore({ clock })

  const item = await store.put({ channel: CH1, key: 'k', text: 'hello' })
  assert.equal(await store.remove(item.id), true)
  assert.equal(await store.remove(item.id), false)
  assert.deepEqual(await store.listActive(CH1), [])
})

test('sweep removes expired items, calls promote for flagged items, and drops even if promote throws', async () => {
  const clock = new FakeClock(NOW)
  const store = createWorkingMemoryStore({ clock })

  const plainExpired = await store.put({ channel: CH1, key: 'plain', text: 'ephemeral', ttlMs: 1_000 })
  const evidenceNoFlag = await store.put({
    channel: CH1,
    key: 'no-flag',
    text: 'has evidence but promote omitted',
    ttlMs: 1_000,
    evidence: [{ id: 'l0_omitted' }],
  })
  const evidenceFalseFlag = await store.put({
    channel: CH1,
    key: 'false-flag',
    text: 'has evidence but promote false',
    ttlMs: 1_000,
    promoteToL1: false,
    evidence: [{ id: 'l0_false' }],
  })
  const promoteOk = await store.put({
    channel: CH1,
    key: 'ok',
    text: 'important',
    ttlMs: 1_000,
    promoteToL1: true,
    evidence: [{ id: 'l0_ok' }],
  })
  const promoteFail = await store.put({
    channel: CH1,
    key: 'fail',
    text: 'flaky',
    ttlMs: 1_000,
    promoteToL1: true,
    evidence: [{ id: 'l0_fail' }],
  })
  const stillActive = await store.put({
    channel: CH1,
    key: 'live',
    text: 'keep me',
    ttlMs: 10_000,
    promoteToL1: true,
    evidence: [{ id: 'l0_live' }],
  })

  const seen: string[] = []
  const report = await store.sweep(NOW + 1_000, async (item) => {
    seen.push(item.id)
    if (item.id === promoteFail.id) throw new Error('disk full')
  })

  assert.equal(report.dropped, 5)
  assert.equal(report.promoted, 1)
  assert.deepEqual(seen.sort(), [promoteFail.id, promoteOk.id].sort())
  assert.deepEqual((await store.listActive(CH1, NOW + 1_000)).map((item) => item.id), [stillActive.id])

  // Ensure the expired items are gone permanently even if queried at an earlier timestamp.
  assert.deepEqual((await store.listActive(CH1, NOW)).map((item) => item.id), [stillActive.id])
  assert.equal(await store.remove(plainExpired.id), false)
  assert.equal(await store.remove(evidenceNoFlag.id), false)
  assert.equal(await store.remove(evidenceFalseFlag.id), false)
  assert.equal(await store.remove(promoteFail.id), false)
})

test('filePath persists items with 0600 mode on POSIX, restores active items, and rejects corrupt files', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brain-wm-test-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })

  const filePath = path.join(root, 'nested', 'working-memory.json')
  const clock = new FakeClock(NOW)
  const store1 = createWorkingMemoryStore({ clock, filePath })

  // Non-existent file starts empty cleanly.
  assert.deepEqual(await store1.listActive(CH1), [])

  const short = await store1.put({ channel: CH1, key: 'short', text: 'expires soon', ttlMs: 1_000 })
  const long = await store1.put({
    channel: CH1,
    key: 'long',
    text: 'persisted note',
    ttlMs: 20_000,
    promoteToL1: true,
    evidence: [{ id: 'l0_1' }],
  })

  if (process.platform !== 'win32') {
    const info = await stat(filePath)
    assert.equal(info.mode & 0o777, 0o600)
  }

  // Re-instantiate at NOW + 5_000: only non-expired item is active; sweep removes expired one from disk.
  const clock2 = new FakeClock(NOW + 5_000)
  const store2 = createWorkingMemoryStore({ clock: clock2, filePath })
  const restored = await store2.listActive(CH1)
  assert.equal(restored.length, 1)
  assert.equal(restored[0]?.id, long.id)
  assert.equal(restored[0]?.text, 'persisted note')
  assert.deepEqual(restored[0]?.evidence, [{ id: 'l0_1' }])

  const swept = await store2.sweep()
  assert.equal(swept.dropped, 1)
  assert.equal(await store2.remove(short.id), false)

  // Re-instantiate at NOW (before short's original expiry) to verify sweep persisted removal to disk.
  const store3 = createWorkingMemoryStore({ clock: new FakeClock(NOW), filePath })
  assert.deepEqual((await store3.listActive(CH1, NOW)).map((item) => item.id), [long.id])

  // Remove long and re-instantiate to verify remove persisted deletion to disk.
  assert.equal(await store3.remove(long.id), true)
  const store4 = createWorkingMemoryStore({ clock: new FakeClock(NOW), filePath })
  assert.deepEqual(await store4.listActive(CH1, NOW), [])

  // Corrupt file throws UNAVAILABLE.
  const corruptPath = path.join(root, 'corrupt.json')
  await writeFile(corruptPath, '{not-json', 'utf8')
  const storeCorrupt = createWorkingMemoryStore({ clock, filePath: corruptPath })
  await assert.rejects(
    () => storeCorrupt.listActive(CH1),
    (err: unknown) => err instanceof BrainError && err.code === 'UNAVAILABLE',
  )
})
