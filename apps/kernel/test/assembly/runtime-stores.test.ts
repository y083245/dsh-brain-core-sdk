import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { BrainError } from '@dsh-brain-core/sdk'
import {
  createChannelRegistry, createOutboundAudit, createSettingsStore, createWakeMetrics,
} from '../../src/runtime-stores/index.ts'

async function tempDir(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brain-stores-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  return dir
}

function columns(file: string): readonly string[] {
  const db = new DatabaseSync(file)
  try {
    return (db.prepare('PRAGMA table_info(outbound_audit)').all() as unknown as { name: string }[]).map((row) => row.name)
  } finally {
    db.close()
  }
}

function columnsOf(file: string, table: string): readonly string[] {
  const db = new DatabaseSync(file)
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map((row) => row.name)
  } finally {
    db.close()
  }
}

test('settings: a missing file reads as no agents and a write round-trips', async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, 'state', 'settings.json')
  const store = createSettingsStore(file)
  assert.deepEqual(await store.read(), { agents: {} })

  await store.write({ agents: { chat: { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'low' } }, timezone: 'Asia/Shanghai' })
  assert.deepEqual(await store.read(), {
    agents: { chat: { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'low' } },
    timezone: 'Asia/Shanghai',
  })
  const raw = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(raw.timezone, 'Asia/Shanghai')
})

test('settings: proactive.ownLife round-trips verbatim and remains compatible with legacy settings', async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, 'state', 'settings.json')
  const store = createSettingsStore(file)

  // Legacy settings without proactive/ownLife
  await store.write({ agents: { chat: { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'low' } } })
  const legacy = await store.read()
  assert.equal(legacy.proactive, undefined)

  // Full proactive.ownLife settings
  const next = {
    agents: { chat: { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'low' } },
    timezone: 'Asia/Shanghai',
    proactive: {
      activeWindowMs: 600_000,
      cooldownMs: 3_600_000,
      ownLife: {
        enabled: true,
        intervalMs: 7_200_000,
        maxPerDay: 5,
        midnightAt: '23:45',
        recallPerDay: 3,
        cooldownDays: 10,
        associateEnabled: false,
        associateTimeoutMs: 2_000,
        minAgeDays: 4,
      },
    },
  } as const
  await store.write(next)
  assert.deepEqual(await store.read(), next)
})

test('settings: a damaged file is INTERNAL, and an agent table of the wrong shape reads as empty', async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, 'settings.json')
  await writeFile(file, '{not json')
  const store = createSettingsStore(file)
  let error: unknown
  try { await store.read() } catch (caught) { error = caught }
  assert.ok(error instanceof BrainError)
  assert.equal((error as BrainError).code, 'INTERNAL')

  await writeFile(file, JSON.stringify({ agents: [] }))
  assert.deepEqual(await store.read(), { agents: {} })
})

test('channel registry finds a provider by the first channel segment and refuses a second provide', () => {
  const registry = createChannelRegistry()
  const sent: string[] = []
  const provider = {
    async send(channel: string): Promise<{ messageId: string }> { sent.push(channel); return { messageId: 'm1' } },
    async members(): Promise<readonly string[]> { return [] },
    async resolveIdentity(): Promise<null> { return null },
  }
  const dispose = registry.provide('sample', provider)
  assert.equal(registry.providerOf('sample:private:u1'), provider)
  assert.equal(registry.providerOf('other:private:u1'), undefined)
  assert.equal(registry.providerOf('not-a-channel'), undefined)

  let error: unknown
  try { registry.provide('sample', provider) } catch (caught) { error = caught }
  assert.ok(error instanceof BrainError)
  assert.equal((error as BrainError).code, 'CONFLICT')

  dispose()
  assert.equal(registry.providerOf('sample:private:u1'), undefined)
  dispose()
  assert.equal(registry.providerOf('sample:private:u1'), undefined)
  assert.deepEqual(sent, [])
})

test('proactive providers require an active opt-in for the exact private channel', () => {
  const registry = createChannelRegistry()
  const provider = {
    async send() { return { messageId: 'm1' } },
    async members() { return [] },
    async resolveIdentity() { return null },
  }
  const dispose = registry.provide('sample', provider, (channel) => channel.endsWith(':u1'))
  assert.equal(registry.proactiveProviderOf('sample:private:u1'), provider)
  assert.equal(registry.proactiveProviderOf('sample:private:u2'), undefined)
  assert.equal(registry.proactiveProviderOf('sample:group:u1'), undefined)
  dispose()
  registry.provide('sample', provider)
  assert.equal(registry.proactiveProviderOf('sample:private:u1'), undefined)
})

test('outbound audit stores one row per attempt and no message text', async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, 'outbound.db')
  const audit = await createOutboundAudit(file)
  await audit.sent({ tool: 'sample__say', pluginId: 'sample', channel: 'sample:private:u1', ok: true, tAt: 10 })
  await audit.sent({ tool: 'sample__say', pluginId: 'sample', channel: 'sample:private:u1', ok: false, tAt: 11 })
  assert.deepEqual(await audit.list(), [
    { tool: 'sample__say', pluginId: 'sample', channel: 'sample:private:u1', ok: true, tAt: 10 },
    { tool: 'sample__say', pluginId: 'sample', channel: 'sample:private:u1', ok: false, tAt: 11 },
  ])
  await audit.close()
  assert.deepEqual(columns(file), ['tool', 'plugin_id', 'channel', 'ok', 't_at'])
  assert.equal(columns(file).includes('text'), false)
})

test('wake metrics stores steps as JSON and no message text', async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, 'metrics.db')
  const metrics = await createWakeMetrics(file)
  await metrics.record({
    wakeId: 'w1', channel: 'sample:private:u1', agentClass: 'chat', profileVersion: 1, arrivedAt: 100,
    firstSendAt: 120, debounceMs: 5, retries: 0, outcome: 'acked',
    steps: [{ inputTokens: 10, outputTokens: 2, cacheReadTokens: 90, cacheWriteTokens: 0 }],
  })
  await metrics.record({
    wakeId: 'w2', channel: 'sample:private:u1', agentClass: 'chat', profileVersion: 1, arrivedAt: 200,
    debounceMs: 0, retries: 1, outcome: 'unavailable', steps: [],
  })
  const rows = await metrics.list()
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], {
    wakeId: 'w1', channel: 'sample:private:u1', agentClass: 'chat', profileVersion: 1, arrivedAt: 100,
    firstSendAt: 120, debounceMs: 5, retries: 0, outcome: 'acked',
    steps: [{ inputTokens: 10, outputTokens: 2, cacheReadTokens: 90, cacheWriteTokens: 0 }],
  })
  assert.equal('firstSendAt' in rows[1]!, false)
  await metrics.close()
  const table = columnsOf(file, 'wake_metrics')
  assert.deepEqual(table, [
    'wake_id', 'channel', 'agent_class', 'profile_version', 'arrived_at', 'first_send_at', 'debounce_ms', 'steps', 'retries', 'outcome',
  ])
  assert.equal(table.includes('text'), false)
})

test('a late dispose does not remove the same owner’s newer provider', () => {
  const registry = createChannelRegistry()
  const make = () => ({
    async send(channel: string): Promise<{ messageId: string }> { return { messageId: channel } },
    async members(): Promise<readonly string[]> { return [] },
    async resolveIdentity(): Promise<null> { return null },
  })
  const first = make()
  const disposeFirst = registry.provide('sample', first)
  disposeFirst()
  const second = make()
  registry.provide('sample', second)

  disposeFirst()
  assert.equal(registry.providerOf('sample:private:u1'), second)
})

test('both databases and their WAL sidecars are mode 600', async (t) => {
  if (process.platform === 'win32') {
    t.skip('NTFS does not carry POSIX permission bits')
    return
  }
  const dir = await tempDir(t)
  const outboundFile = path.join(dir, 'outbound.db')
  const metricsFile = path.join(dir, 'metrics.db')
  const audit = await createOutboundAudit(outboundFile)
  const metrics = await createWakeMetrics(metricsFile)
  try {
    await audit.sent({ tool: 'sample__say', pluginId: 'sample', channel: 'sample:private:u1', ok: true, tAt: 1 })
    await metrics.record({
      wakeId: 'w1', channel: 'sample:private:u1', agentClass: 'chat', profileVersion: 1, arrivedAt: 1,
      debounceMs: 0, retries: 0, outcome: 'acked', steps: [],
    })
    for (const db of [outboundFile, metricsFile]) {
      for (const file of [db, `${db}-wal`, `${db}-shm`]) {
        assert.equal((await stat(file)).mode & 0o777, 0o600, file)
      }
    }
  } finally {
    await audit.close()
    await metrics.close()
  }
})
