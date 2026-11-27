import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runDoctor } from '@dsh-brain-core/kernel/isolation-doctor'
import { removeTree } from '@dsh-brain-core/satellite-host'
import type { Envelope, WakeResult } from '@dsh-brain-core/sdk'
import {
  CONSOLE_CHAT_DIR, FLASH_LOW, assertUnwrappedOk, createFakeMainDshHome,
  hasToolResultInLastMessage, httpJson, installAndEnablePlugin, setupAcceptanceKernel,
} from './helpers.ts'

async function collectRelativeFiles(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      out.push(...await collectRelativeFiles(full, rel))
    } else {
      out.push(rel)
    }
  }
  return out.sort()
}

test('AT-1: 50 full turns with real kernel + console-chat leave fake main DSH home untouched', async (t) => {
  const dshRoot = await mkdtemp(path.join(os.tmpdir(), 'brain-at1-dsh-'))
  t.after(async () => { await removeTree(dshRoot) })

  const fakeMain = await createFakeMainDshHome(dshRoot)
  const snapshotFile = path.join(dshRoot, 'dsh-snapshot.json')

  const snap = await runDoctor({ mode: 'snapshot', dshHome: fakeMain.dshHome, file: snapshotFile })
  assert.equal(snap.kind, 'snapshot')
  assert.ok(snap.entries >= 8, `expected >= 8 entries in snapshot, got ${snap.entries}`)
  if (process.platform !== 'win32') {
    const mode = (await stat(snapshotFile)).mode & 0o777
    assert.equal(mode, 0o600, `snapshot file permissions must be 0600, got ${mode.toString(8)}`)
  }
  const snapshotContent = await readFile(snapshotFile, 'utf8')
  assert.equal(snapshotContent.includes(fakeMain.sentinelSecret), false, 'doctor must never read credential contents')

  // Advance logical clock by 7 seconds per turn so 50 turns span ~350s within the same UTC day
  // without tripping the per-minute outbound rate limit (20 admits/min; send tool + channel.send = 2/turn).
  let now = Date.UTC(2026, 10, 16, 12, 0, 0)
  const clock = { now: () => now }

  let turnCounter = 0
  const h = await setupAcceptanceKernel(t, {
    dshHome: fakeMain.dshHome,
    crossChannel: 'shadow',
    clock,
    settings: { agents: { chat: { ...FLASH_LOW } }, timezone: 'UTC' },
    apiKey: 'fake-at1-key',
    roleCard: '你是小满，说话简短自然。',
    script: (request) => {
      if (hasToolResultInLastMessage(request)) {
        return { text: '好。' }
      }
      turnCounter += 1
      return {
        tool: 'console-chat__send_message',
        input: { text: `第${turnCounter}回收到` },
      }
    },
  })

  await installAndEnablePlugin(h.kernel, CONSOLE_CHAT_DIR, 'console-chat')

  const totalTurns = 50
  for (let i = 1; i <= totalTurns; i += 1) {
    now += 7_000
    const res = await httpJson<Envelope<{ readonly recordId: string; readonly wake: WakeResult }>>(
      h.kernel.port,
      'POST',
      '/api/v1/plugins/console-chat/messages',
      {
        token: h.token,
        body: {
          channel: 'console-chat:private:owner',
          account: 'owner',
          displayName: '主人',
          text: `第 ${i} 个回合的测试消息`,
          messageId: `at1-msg-${i}`,
          tEvent: now,
          debounceMs: 0,
        },
      },
    )
    assert.equal(res.status, 200, `turn ${i} HTTP status`)
    const data = assertUnwrappedOk(res.body)
    assert.equal(data.wake.acked, true, `turn ${i} wake acked`)
    assert.equal(data.wake.sent, 1, `turn ${i} wake sent`)
  }

  // Verify 100 L0 messages stored (50 inbound + 50 outbound)
  const l0Records = []
  let cursor: string | undefined
  for (;;) {
    const page = await h.kernel.memory.store.list(
      { layers: ['L0'], channels: ['console-chat:private:owner'] },
      cursor === undefined ? { limit: 200 } : { limit: 200, cursor },
    )
    l0Records.push(...page.items)
    if (page.nextCursor === undefined) break
    cursor = page.nextCursor
  }
  assert.equal(l0Records.length, 100, `expected 100 L0 records (50 in + 50 out), got ${l0Records.length}`)

  // Mid-run isolation check
  const midCheck = await runDoctor({ mode: 'check', dshHome: fakeMain.dshHome })
  assert.equal(midCheck.kind, 'check')
  assert.equal(midCheck.ok, true, `check problems: ${JSON.stringify(midCheck.problems)}`)
  assert.deepEqual(midCheck.problems, [])

  const mainSessionFiles = await collectRelativeFiles(path.join(fakeMain.dshHome, 'sessions'))
  assert.deepEqual(mainSessionFiles, ['main-work/user-session-01/events.jsonl'])
  assert.equal(mainSessionFiles.some((f) => f.includes('brn-') || f.toLowerCase().includes('brain')), false)

  const brainSessionFiles = await collectRelativeFiles(
    path.join(h.brainHome, 'state', 'satellite', 'dsh-home', 'sessions'),
  )
  assert.ok(brainSessionFiles.length > 0, 'Brain satellite dsh-home must contain session files')

  // Simulate uninstalling Brain: close kernel and delete state/satellite
  await h.kernel.close()
  await removeTree(path.join(h.brainHome, 'state', 'satellite'))

  const afterCompare = await runDoctor({ mode: 'compare', dshHome: fakeMain.dshHome, file: snapshotFile })
  assert.equal(afterCompare.kind, 'compare')
  assert.equal(afterCompare.unchanged, true, `unexpected changes: ${JSON.stringify(afterCompare)}`)
  assert.deepEqual(afterCompare.added, [])
  assert.deepEqual(afterCompare.removed, [])
  assert.deepEqual(afterCompare.changed, [])
})
