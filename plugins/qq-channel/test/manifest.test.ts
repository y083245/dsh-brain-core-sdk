// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validateManifest, type BrainLogger, type PluginStorage } from '@brain-core/sdk'
import { checkPlugin } from '@brain-core/testkit'
import configSchema, { DEFAULT_QQ_CONFIG } from '../src/config.ts'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function toolAppliesTo(channels: readonly string[] | undefined, channelKind: 'private' | 'group'): boolean {
  if (channels === undefined) return true
  return channels.some((pattern) => {
    const [source, kind] = pattern.split(':')
    return (source === '*' || source === 'qq') && (kind === '*' || kind === channelKind)
  })
}

test('package.json manifest validates cleanly with checkPlugin and exact permissions/dependencies', async () => {
  const pkgText = await readFile(path.join(PLUGIN_ROOT, 'package.json'), 'utf8')
  const pkg = JSON.parse(pkgText) as {
    readonly name: string
    readonly license: string
    readonly dependencies: Readonly<Record<string, string>>
    readonly brain: {
      readonly id: string
      readonly runtime: string
      readonly permissions: readonly string[]
      readonly groups: Readonly<Record<string, unknown>>
      readonly tools: readonly {
        readonly name: string
        readonly load: string
        readonly channels?: readonly string[]
      }[]
    }
  }

  assert.equal(pkg.name, '@brain-core/plugin-qq')
  assert.equal(pkg.license, 'PolyForm-Noncommercial-1.0.0')
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@brain-core/chat-kit', '@brain-core/sdk'])
  assert.equal(pkg.brain.id, 'qq')
  assert.equal(pkg.brain.runtime, 'process')
  assert.equal(pkg.brain.permissions.length, 17)

  const manifestResult = validateManifest(pkg.brain)
  assert.equal(manifestResult.ok, true)

  const report = await checkPlugin(PLUGIN_ROOT)
  assert.equal(report.ok, true)
  assert.equal(report.findings.filter((f) => f.level === 'must' || f.level === 'should').length, 0)

  assert.deepEqual(
    Object.keys(pkg.brain.groups).sort(),
    ['forward', 'group_info', 'history_extra', 'media', 'poke', 'stickers', 'voice'],
  )
  assert.equal(pkg.brain.tools.length, 14)

  const privateCore = pkg.brain.tools.filter((t) => t.load === 'core' && toolAppliesTo(t.channels, 'private'))
  const groupCore = pkg.brain.tools.filter((t) => t.load === 'core' && toolAppliesTo(t.channels, 'group'))
  assert.deepEqual(privateCore.map((t) => t.name), ['send_message'])
  assert.deepEqual(groupCore.map((t) => t.name), ['send_message', 'set_wake_config'])
  // Core tool budget: 1 plugin core + 3 kernel built-ins = 4 (private); 2 + 3 = 5 (group)
  const KERNEL_BUILTIN_CORE_COUNT = 3
  assert.equal(privateCore.length + KERNEL_BUILTIN_CORE_COUNT, 4)
  assert.equal(groupCore.length + KERNEL_BUILTIN_CORE_COUNT, 5)
})

test('config schema fills fail-closed defaults and rejects invalid types or ranges', () => {
  const parsed = configSchema({})
  assert.deepEqual(parsed, DEFAULT_QQ_CONFIG)
  assert.equal(parsed.onebotHttpUrl, 'http://127.0.0.1:3000')
  assert.equal(parsed.onebotWsUrl, 'ws://127.0.0.1:3001')
  assert.deepEqual(parsed.allowPrivate, [])
  assert.deepEqual(parsed.allowGroups, [])
  assert.equal(parsed.allowAllWhenEmpty, false)
  assert.equal(parsed.voice.enabled, false)

  const partial = configSchema({
    ownerQQ: '10001',
    wake: { maxWakePerHour: 12 },
    voice: { enabled: true },
  })
  assert.equal(partial.ownerQQ, '10001')
  assert.equal(partial.wake.maxWakePerHour, 12)
  assert.equal(partial.wake.batchWindowMs, 4000)
  assert.equal(partial.voice.enabled, true)
  assert.equal(partial.voice.maxSeconds, 300)

  for (const invalid of [
    { onebotHttpUrl: 123 },
    { onebotWsUrl: '' },
    { ownerQQ: 'not-digits' },
    { allowPrivate: '10001' },
    { allowAllWhenEmpty: 'false' },
    { wake: { replyProbability: 1.5 } },
    { send: { maxBurst: 7 } },
    { media: { timeoutMs: 100 } },
    { voice: { enabled: 'true' } },
  ]) {
    assert.throws(() => configSchema(invalid))
  }
})

test('001-init migration initializes storage cleanly and is idempotent', async () => {
  const migrationUrl = pathToFileURL(path.join(PLUGIN_ROOT, 'migrations', '001-init.mjs')).href
  const migration = await import(migrationUrl) as {
    readonly up: (deps: { readonly storage: PluginStorage; readonly logger: BrainLogger }) => Promise<void>
  }
  const runInitMigration = migration.up

  const files = new Map<string, Uint8Array>()
  const storage: PluginStorage = {
    read: async (file) => files.get(file),
    write: async (file, data) => {
      files.set(file, typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data))
    },
    remove: async (file) => {
      files.delete(file)
    },
    list: async (prefix = '') => [...files.keys()].filter((k) => k.startsWith(prefix)).sort(),
  }
  const logs: { readonly event: string; readonly fields?: Readonly<Record<string, unknown>> }[] = []
  const logger: BrainLogger = {
    info: (event, fields) => { logs.push({ event, fields }) },
    warn: (event, fields) => { logs.push({ event, fields }) },
    error: (event, fields) => { logs.push({ event, fields }) },
  }

  await runInitMigration({ storage, logger })
  const first = files.get('qq-state.json')
  assert.ok(first !== undefined)
  assert.deepEqual(JSON.parse(new TextDecoder().decode(first)), { schemaVersion: 1 })
  assert.deepEqual(logs, [{ event: 'qq.migration.init', fields: { version: 1 } }])

  // Second run preserves existing state without duplicating or overwriting
  await storage.write('qq-state.json', JSON.stringify({ schemaVersion: 1, marker: 'keep' }))
  await runInitMigration({ storage, logger })
  const second = files.get('qq-state.json')
  assert.deepEqual(JSON.parse(new TextDecoder().decode(second!)), { schemaVersion: 1, marker: 'keep' })
  assert.equal(logs.length, 2)
})
