import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import Schema from 'schemastery'
import {
  BrainManifestSchema,
  ContextItemSchema,
} from '../src/schema.ts'
import { LIMITS } from '../src/types.ts'
import {
  PLUGIN_API_VERSION,
  PLUGIN_KINDS,
  TOOL_EFFECTS,
  TOOL_LOADS,
  validateManifest,
} from '../src/plugin.ts'
import * as sdk from '../src/index.ts'

const disclosure = { speakable: 'yes', label: '一件旧事' }

test('ContextItem accepts an optional inferred flag', () => {
  const withInferred = { id: 'l2_1', text: '她记得他怕冷', disclosure, inferred: true }
  assert.deepEqual(Schema.resolve(withInferred, ContextItemSchema, {})[0], withInferred)

  const withoutInferred = { id: 'l2_1', text: '她记得他怕冷', disclosure }
  assert.deepEqual(Schema.resolve(withoutInferred, ContextItemSchema, {})[0], withoutInferred)

  assert.throws(() => Schema.resolve({ ...withoutInferred, inferred: 'yes' }, ContextItemSchema, {}))
})

test('BrainManifestSchema checks the shape of a manifest', () => {
  const manifest = {
    id: 'qq',
    kinds: ['channel'],
    api: '^1',
    runtime: 'node',
    permissions: ['memory.ingest', 'tools.register', 'channel.send', 'secrets:qq-token'],
    source: {
      channels: ['qq:group:*'],
      eventKinds: ['qq.message.received'],
      defaultVisibility: 'origin',
      trust: 'member',
    },
    tools: [{ name: 'send', effect: 'send', load: 'core', summary: '发消息' }],
    groups: { stickers: { summary: '表情', usage: '先看再发' } },
    mcp: { command: 'node', args: ['server.mjs'], env: { TOKEN: 'secret:qq-token' } },
  }
  assert.equal(validateManifest(manifest).ok, true)
  const resolved = Schema.resolve(manifest, BrainManifestSchema, {})[0] as typeof manifest
  assert.equal(resolved.id, 'qq')
  assert.deepEqual(resolved.groups, { stickers: { summary: '表情', usage: '先看再发' } })
  assert.equal(resolved.mcp?.command, 'node')

  assert.throws(() => Schema.resolve({ ...manifest, kinds: ['plugin'] }, BrainManifestSchema, {}))
  assert.throws(() => Schema.resolve({ ...manifest, runtime: 'worker' }, BrainManifestSchema, {}))
  assert.throws(() => Schema.resolve({ ...manifest, tools: 'send' }, BrainManifestSchema, {}))
  assert.throws(() => Schema.resolve({ ...manifest, groups: { stickers: { usage: 1 } } }, BrainManifestSchema, {}))
})

test('LIMITS gained the S3 tool and wake caps', () => {
  assert.equal(LIMITS.toolSummaryChars, 60)
  assert.equal(LIMITS.toolResultChars, 64 * 1024)
  assert.equal(LIMITS.toolImages, 4)
  assert.equal(LIMITS.toolImageBytes, 8 * 1024 * 1024)
  assert.equal(LIMITS.wakeMessages, 50)
  assert.equal(LIMITS.wakeMessageChars, 2000)
})

test('the plugin constants are exported from the package root', () => {
  assert.equal(sdk.PLUGIN_API_VERSION, '1.0.0')
  assert.deepEqual([...sdk.PLUGIN_KINDS], ['channel', 'activity', 'capability', 'memory-provider'])
  assert.deepEqual([...sdk.TOOL_EFFECTS], ['read', 'write', 'send'])
  assert.deepEqual([...sdk.TOOL_LOADS], ['core', 'context', 'onDemand'])
  assert.equal(typeof sdk.Schema.string, 'function')
  assert.deepEqual(sdk.parsePermission('memory.ingest'), { kind: 'plain', name: 'memory.ingest' })
  assert.deepEqual(sdk.parseWhen('event.poke'), { anyOf: [[{ feature: 'event.poke' }]] })
})

test('PLUGIN_API_VERSION has a stable major', () => {
  assert.equal(PLUGIN_API_VERSION, '1.0.0')
  assert.deepEqual([...PLUGIN_KINDS], ['channel', 'activity', 'capability', 'memory-provider'])
  assert.deepEqual([...TOOL_EFFECTS], ['read', 'write', 'send'])
  assert.deepEqual([...TOOL_LOADS], ['core', 'context', 'onDemand'])
})

test('the sdk depends on schemastery only', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  assert.deepEqual(packageJson.dependencies, { schemastery: '3.18.0' })
  assert.equal(packageJson.devDependencies, undefined)
})
