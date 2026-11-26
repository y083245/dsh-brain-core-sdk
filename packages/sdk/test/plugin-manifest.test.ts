import assert from 'node:assert/strict'
import test from 'node:test'
import { apiMajor, validateManifest } from '../src/plugin.ts'
import type { BrainManifest, ManifestResult } from '../src/plugin.ts'

function clone<T>(value: T): T {
  return structuredClone(value)
}

/** The manifest from RFC 8.2, which must pass. */
const rfcManifest = {
  id: 'bilibili',
  kinds: ['activity', 'capability'],
  api: '^1.0.0',
  runtime: 'node',
  permissions: ['memory.ingest', 'schedule.ownTime', 'agent.session', 'tools.register', 'network:api.bilibili.com'],
  source: {
    channels: ['bilibili:feed:self'],
    eventKinds: ['bilibili.video_watched'],
    defaultVisibility: 'open',
    trust: 'external',
    retentionDays: 90,
    rateLimitPerHour: 200,
  },
  tools: [{
    name: 'watch',
    effect: 'read',
    load: 'onDemand',
    group: 'video',
    summary: '打开一个 B 站视频并读出要点',
    keywords: ['看视频', 'B站', 'bilibili'],
  }],
  config: './dist/config.js',
  migrations: './migrations',
}

function fieldsOf(json: unknown): string[] {
  const result = validateManifest(json)
  if (result.ok) assert.fail(`expected errors, got a valid manifest: ${JSON.stringify(result.manifest)}`)
  return result.errors.map((error) => error.field)
}

function assertField(json: unknown, field: string): void {
  assert.ok(fieldsOf(json).includes(field), `expected field ${field}, got ${JSON.stringify(fieldsOf(json))}`)
}

test('proactive messaging is opt-in for channel plugins with private transport', () => {
  const source = { ...rfcManifest.source, channels: ['bilibili:private:*'], proactiveMessaging: true }
  const kinds = ['channel']
  const permissions = [...rfcManifest.permissions, 'channel.provide', 'channel.send']
  const valid = { ...rfcManifest, source, kinds, permissions }
  assert.equal(validateManifest(valid).ok, true)
  assertField({ ...valid, kinds: ['activity'] }, 'source.proactiveMessaging')
  assertField({ ...valid, permissions: rfcManifest.permissions }, 'source.proactiveMessaging')
  assertField({ ...valid, source: { ...source, channels: ['bilibili:group:*'] } }, 'source.proactiveMessaging')
  assertField({ ...valid, source: { ...source, proactiveMessaging: 'true' } }, 'source.proactiveMessaging')
})

function toolManifest(tool: unknown, permissions: readonly string[] = ['tools.register']): Record<string, unknown> {
  return {
    id: 'demo',
    kinds: ['capability'],
    api: '^1',
    runtime: 'node',
    permissions: [...permissions],
    tools: [tool],
  }
}

const validTool = {
  name: 'watch',
  effect: 'read',
  load: 'onDemand',
  group: 'video',
  summary: '看视频',
}

function sourceManifest(source: unknown, permissions: readonly string[] = ['memory.ingest']): Record<string, unknown> {
  return {
    id: 'qq',
    kinds: ['channel'],
    api: '^1',
    runtime: 'node',
    permissions: [...permissions],
    source,
  }
}

const validSource = {
  channels: ['qq:group:*'],
  eventKinds: ['qq.message.received'],
  defaultVisibility: 'origin',
  trust: 'member',
}

test('apiMajor reads the major of a caret range', () => {
  assert.equal(apiMajor('^1'), 1)
  assert.equal(apiMajor('^1.2'), 1)
  assert.equal(apiMajor('^1.2.3'), 1)
  assert.equal(apiMajor('^0.1.0'), 0)
  assert.equal(apiMajor('^12.0'), 12)
  for (const range of ['1', '1.2.3', '^', '^x', '^1.2.3.4', '~1', '>=1', '^01', '^1 ', ' ^1', '']) {
    assert.equal(apiMajor(range), null, range)
  }
})

test('the RFC 8.2 manifest passes and is returned as given', () => {
  const result = validateManifest(rfcManifest)
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.manifest, rfcManifest)
})

test('validateManifest result narrows on ok', () => {
  const result: ManifestResult = validateManifest(rfcManifest)
  if (result.ok) {
    const manifest: BrainManifest = result.manifest
    assert.equal(manifest.id, 'bilibili')
  } else {
    assert.fail('expected ok')
  }
})

test('a non-object manifest is rejected', () => {
  for (const value of [null, undefined, 'manifest', 1, []]) {
    assert.equal(validateManifest(value).ok, false)
  }
  assert.deepEqual(fieldsOf(null), [''])
})

test('id is required, well formed and not reserved', () => {
  const withoutId = clone(rfcManifest) as Record<string, unknown>
  delete withoutId.id
  assertField(withoutId, 'id')

  assertField({ ...clone(rfcManifest), id: 'Bilibili' }, 'id')
  assertField({ ...clone(rfcManifest), id: '1bilibili' }, 'id')
  assertField({ ...clone(rfcManifest), id: 'bilibili_plugin' }, 'id')
  assertField({ ...clone(rfcManifest), id: 'a'.repeat(32) }, 'id')
  assertField({ ...clone(rfcManifest), id: 7 }, 'id')
  for (const reserved of ['memory', 'tools', 'agent', 'brain', 'kernel', 'self', 'owner-console', 'notify']) {
    assertField({ ...clone(rfcManifest), id: reserved }, 'id')
  }
  assert.equal(validateManifest({
    id: 'a'.repeat(31),
    kinds: ['capability'],
    api: '^1',
    runtime: 'node',
    permissions: [],
  }).ok, true)
})

test('kinds are required, non-empty, unique and known', () => {
  const withoutKinds = clone(rfcManifest) as Record<string, unknown>
  delete withoutKinds.kinds
  assertField(withoutKinds, 'kinds')

  assertField({ ...clone(rfcManifest), kinds: [] }, 'kinds')
  assertField({ ...clone(rfcManifest), kinds: 'channel' }, 'kinds')
  assertField({ ...clone(rfcManifest), kinds: ['channel', 'channel'] }, 'kinds[1]')
  assertField({ ...clone(rfcManifest), kinds: ['channel', 'plugin'] }, 'kinds[1]')
})

test('api is required and must be a caret range', () => {
  const withoutApi = clone(rfcManifest) as Record<string, unknown>
  delete withoutApi.api
  assertField(withoutApi, 'api')

  for (const api of ['1.0.0', '^x', '^1.2.3.4', '~1.0.0', '^', 1]) {
    assertField({ ...clone(rfcManifest), api }, 'api')
  }
  for (const api of ['^1', '^1.2', '^1.2.3']) {
    assert.equal(validateManifest({ ...clone(rfcManifest), api }).ok, true)
  }
})

test('runtime is required and gates process', () => {
  const withoutRuntime = clone(rfcManifest) as Record<string, unknown>
  delete withoutRuntime.runtime
  assertField(withoutRuntime, 'runtime')
  assertField({ ...clone(rfcManifest), runtime: 'worker' }, 'runtime')

  assert.equal(validateManifest({
    ...clone(rfcManifest),
    runtime: 'process',
    process: { command: 'python', args: ['main.py'] },
  }).ok, true)

  assertField({ ...clone(rfcManifest), runtime: 'process' }, 'process.command')
  assertField({ ...clone(rfcManifest), runtime: 'process', process: {} }, 'process.command')
  assertField({ ...clone(rfcManifest), runtime: 'process', process: { command: '' } }, 'process.command')
  assertField({ ...clone(rfcManifest), runtime: 'process', process: { command: 'x', args: [1] } }, 'process.args')
  assertField({ ...clone(rfcManifest), runtime: 'process', process: { command: 'x', cwd: '/tmp' } }, 'process.cwd')

  assertField({ ...clone(rfcManifest), process: { command: 'python' } }, 'process')
})

test('permissions are required, parseable and unique', () => {
  const withoutPermissions = clone(rfcManifest) as Record<string, unknown>
  delete withoutPermissions.permissions
  assertField(withoutPermissions, 'permissions')

  assertField({ ...clone(rfcManifest), permissions: 'memory.ingest' }, 'permissions')
  assertField({ ...clone(rfcManifest), permissions: ['memory.eat'] }, 'permissions[0]')
  assertField({ ...clone(rfcManifest), permissions: ['memory.ingest', 'memory.ingest'] }, 'permissions[1]')
  assertField({ ...clone(rfcManifest), permissions: [7] }, 'permissions[0]')
})

test('source is required when the plugin writes memory', () => {
  for (const permission of ['memory.ingest', 'memory.record']) {
    const manifest = { ...clone(rfcManifest), permissions: [permission] } as Record<string, unknown>
    delete manifest.source
    assertField(manifest, 'source')
  }
  const manifest = { ...clone(rfcManifest), permissions: ['tools.register'] } as Record<string, unknown>
  delete manifest.source
  assert.equal(validateManifest(manifest).ok, true)
})

test('source.channels is a non-empty list of own channels', () => {
  assert.equal(validateManifest(sourceManifest(clone(validSource))).ok, true)

  assertField(sourceManifest({ ...clone(validSource), channels: [] }), 'source.channels')
  const withoutChannels = clone(validSource) as Record<string, unknown>
  delete withoutChannels.channels
  assertField(sourceManifest(withoutChannels), 'source.channels')
  assertField(sourceManifest({ ...clone(validSource), channels: 'qq:group:*' }), 'source.channels')

  for (const channel of ['other:group:1', 'qq:GROUP:1', 'qq:group:', 'qq:group:a b', 'qq:group', 'qq::1', 7]) {
    assertField(sourceManifest({ ...clone(validSource), channels: [channel] }), 'source.channels[0]')
  }
  assert.equal(validateManifest(sourceManifest({ ...clone(validSource), channels: ['qq:private:123'] })).ok, true)
})

test('source.eventKinds must start with the plugin id', () => {
  const withoutKinds = clone(validSource) as Record<string, unknown>
  delete withoutKinds.eventKinds
  assertField(sourceManifest(withoutKinds), 'source.eventKinds')
  assertField(sourceManifest({ ...clone(validSource), eventKinds: 'qq.message' }), 'source.eventKinds')
  assertField(sourceManifest({ ...clone(validSource), eventKinds: ['qq.message', 'other.event'] }), 'source.eventKinds[1]')
})

test('source.defaultVisibility and trust are checked against the constants', () => {
  const withoutVisibility = clone(validSource) as Record<string, unknown>
  delete withoutVisibility.defaultVisibility
  assertField(sourceManifest(withoutVisibility), 'source.defaultVisibility')
  assertField(sourceManifest({ ...clone(validSource), defaultVisibility: 'public' }), 'source.defaultVisibility')

  const withoutTrust = clone(validSource) as Record<string, unknown>
  delete withoutTrust.trust
  assertField(sourceManifest(withoutTrust), 'source.trust')
  assertField(sourceManifest({ ...clone(validSource), trust: 'self' }), 'source.trust')
  assertField(sourceManifest({ ...clone(validSource), trust: 'stranger' }), 'source.trust')
  for (const trust of ['owner', 'member', 'external']) {
    assert.equal(validateManifest(sourceManifest({ ...clone(validSource), trust })).ok, true)
  }
})

test('source retention and rate limit are optional positive integers', () => {
  for (const retentionDays of [0, -1, 1.5, '90']) {
    assertField(sourceManifest({ ...clone(validSource), retentionDays }), 'source.retentionDays')
  }
  for (const rateLimitPerHour of [0, -1, 1.5, '200']) {
    assertField(sourceManifest({ ...clone(validSource), rateLimitPerHour }), 'source.rateLimitPerHour')
  }
  const withoutLimits = clone(validSource) as Record<string, unknown>
  assert.equal(validateManifest(sourceManifest(withoutLimits)).ok, true)
})

test('source rejects unknown fields', () => {
  assertField(sourceManifest({ ...clone(validSource), visibility: 'owner' }), 'source.visibility')
})

test('wanting tools requires tools.register', () => {
  assertField(toolManifest(validTool, []), 'tools')
  assert.equal(validateManifest(toolManifest(validTool)).ok, true)
})

test('tool names are well formed and unique', () => {
  for (const name of ['Watch', '1watch', 'watch-this', 'a'.repeat(32), 'a__b', 7]) {
    assertField(toolManifest({ ...clone(validTool), name }), 'tools[0].name')
  }
  assert.equal(validateManifest(toolManifest({ ...clone(validTool), name: 'a'.repeat(31) })).ok, true)
  assertField({ ...toolManifest(validTool), tools: [validTool, validTool] }, 'tools[1].name')
})

test('tool effect and load are required and known', () => {
  const withoutEffect = clone(validTool) as Record<string, unknown>
  delete withoutEffect.effect
  assertField(toolManifest(withoutEffect), 'tools[0].effect')
  assertField(toolManifest({ ...clone(validTool), effect: 'execute' }), 'tools[0].effect')

  const withoutLoad = clone(validTool) as Record<string, unknown>
  delete withoutLoad.load
  assertField(toolManifest(withoutLoad), 'tools[0].load')
  assertField(toolManifest({ ...clone(validTool), load: 'lazy' }), 'tools[0].load')
})

test('context and onDemand tools need a group; group names are checked', () => {
  const withoutGroup = clone(validTool) as Record<string, unknown>
  delete withoutGroup.group
  assertField(toolManifest(withoutGroup), 'tools[0].group')
  assertField(toolManifest({ ...clone(validTool), load: 'context', when: 'message.hasMedia', group: 'Video' }), 'tools[0].group')
  assert.equal(validateManifest(toolManifest({ name: 'w', effect: 'read', load: 'core', summary: '常驻' })).ok, true)
})

test('tool summary is required and capped by code points', () => {
  const withoutSummary = clone(validTool) as Record<string, unknown>
  delete withoutSummary.summary
  assertField(toolManifest(withoutSummary), 'tools[0].summary')
  assertField(toolManifest({ ...clone(validTool), summary: '' }), 'tools[0].summary')
  assertField(toolManifest({ ...clone(validTool), summary: 'a'.repeat(61) }), 'tools[0].summary')
  assert.equal(validateManifest(toolManifest({ ...clone(validTool), summary: 'a'.repeat(60) })).ok, true)
  assert.equal(validateManifest(toolManifest({ ...clone(validTool), summary: '😀'.repeat(60) })).ok, true)
})

test('tool keywords are optional, at most 16, each 1-32 characters', () => {
  assert.equal(validateManifest(toolManifest(validTool)).ok, true)
  assert.equal(validateManifest(toolManifest({
    ...clone(validTool),
    keywords: Array.from({ length: 16 }, (_, index) => `k${index}`),
  })).ok, true)
  assertField(toolManifest({
    ...clone(validTool),
    keywords: Array.from({ length: 17 }, (_, index) => `k${index}`),
  }), 'tools[0].keywords')
  assertField(toolManifest({ ...clone(validTool), keywords: [''] }), 'tools[0].keywords[0]')
  assertField(toolManifest({ ...clone(validTool), keywords: ['a'.repeat(33)] }), 'tools[0].keywords[0]')
  assertField(toolManifest({ ...clone(validTool), keywords: [7] }), 'tools[0].keywords[0]')
  assertField(toolManifest({ ...clone(validTool), keywords: 'video' }), 'tools[0].keywords')
})

test('when belongs to context tools only and must parse', () => {
  const contextTool = {
    name: 'look',
    effect: 'read',
    load: 'context',
    group: 'media',
    summary: '看图',
    when: 'message.hasMedia',
  }
  assert.equal(validateManifest(toolManifest(contextTool)).ok, true)

  const withoutWhen = clone(contextTool) as Record<string, unknown>
  delete withoutWhen.when
  assertField(toolManifest(withoutWhen), 'tools[0].when')

  assertField(toolManifest({ ...clone(contextTool), when: 'message.hasVideo' }), 'tools[0].when')
  assertField(toolManifest({ ...clone(contextTool), when: '(message.hasMedia)' }), 'tools[0].when')
  assertField(toolManifest({ ...clone(validTool), when: 'message.hasMedia' }), 'tools[0].when')
  assertField(toolManifest({ ...clone(validTool), load: 'core', when: 'message.hasMedia' }), 'tools[0].when')
})

test('tool channels match <source>:<kind> with optional stars', () => {
  for (const channels of [['qq:group'], ['*:group'], ['qq:*'], ['*:*']]) {
    assert.equal(validateManifest(toolManifest({ ...clone(validTool), channels })).ok, true)
  }
  for (const channels of [['Qq:group'], ['qq:Group'], ['qq'], ['qq:'], [':group'], [7]]) {
    assertField(toolManifest({ ...clone(validTool), channels }), 'tools[0].channels[0]')
  }
  assertField(toolManifest({ ...clone(validTool), channels: 'qq:group' }), 'tools[0].channels')
})

test('sendPerMinute and textArg belong to send tools and are validated', () => {
  const sendTool = { name: 'say', effect: 'send', load: 'core', summary: '说话', textArg: 'text', sendPerMinute: 10 }
  assert.equal(validateManifest(toolManifest(sendTool, ['tools.register', 'channel.send'])).ok, true)

  assertField(toolManifest({ ...clone(validTool), sendPerMinute: 10 }), 'tools[0].sendPerMinute')
  assertField(toolManifest({ ...clone(validTool), textArg: 'text' }), 'tools[0].textArg')
  for (const sendPerMinute of [0, -1, 1.5, '10']) {
    assertField(toolManifest({ ...clone(sendTool), sendPerMinute }, ['tools.register', 'channel.send']), 'tools[0].sendPerMinute')
  }
  for (const textArg of ['', 7]) {
    assertField(toolManifest({ ...clone(sendTool), textArg }, ['tools.register', 'channel.send']), 'tools[0].textArg')
  }
})

test('send tools need channel.send', () => {
  const sendTool = { name: 'say', effect: 'send', load: 'core', summary: '说话' }
  assertField(toolManifest(sendTool), 'tools[0].effect')
  assert.equal(validateManifest(toolManifest(sendTool, ['tools.register', 'channel.send'])).ok, true)
})

test('audience is owner or absent', () => {
  assert.equal(validateManifest(toolManifest({ ...clone(validTool), audience: 'owner' })).ok, true)
  assertField(toolManifest({ ...clone(validTool), audience: 'member' }), 'tools[0].audience')
})

test('mcpName is only allowed next to mcp', () => {
  assertField(toolManifest({ ...clone(validTool), mcpName: 'HassTurnOn' }), 'tools[0].mcpName')
  const withMcp = {
    ...toolManifest({ ...clone(validTool), mcpName: 'HassTurnOn' }),
    mcp: { command: 'hass-mcp' },
  }
  assert.equal(validateManifest(withMcp).ok, true)
})

test('tools reject unknown fields', () => {
  assertField(toolManifest({ ...clone(validTool), sumary: 'typo' }), 'tools[0].sumary')
})

test('groups check keys, summary and usage', () => {
  const manifest = (groups: unknown): Record<string, unknown> => ({
    ...clone(rfcManifest),
    groups,
  })
  assert.equal(validateManifest(manifest({ video: { summary: '视频', usage: '怎么用' } })).ok, true)
  assertField(manifest({ Video: { summary: '视频' } }), 'groups.Video')
  assertField(manifest({ video: {} }), 'groups.video.summary')
  assertField(manifest({ video: { summary: '' } }), 'groups.video.summary')
  assertField(manifest({ video: { summary: '视频', usage: 'a'.repeat(2001) } }), 'groups.video.usage')
  assert.equal(validateManifest(manifest({ video: { summary: '视频', usage: 'a'.repeat(2000) } })).ok, true)
  assertField(manifest('video'), 'groups')
  assertField(manifest({ video: { summary: '视频', extra: true } }), 'groups.video.extra')
})

test('config and migrations are relative paths without parent segments', () => {
  assert.equal(validateManifest(clone(rfcManifest)).ok, true)
  for (const config of ['dist/config.js', '/abs/config.js', './a/../b', 7]) {
    assertField({ ...clone(rfcManifest), config }, 'config')
  }
  for (const migrations of ['migrations', '../migrations', './a/../b', 7]) {
    assertField({ ...clone(rfcManifest), migrations }, 'migrations')
  }
})

const mcpManifest = {
  id: 'qzone',
  kinds: ['channel'],
  api: '^1',
  runtime: 'node',
  permissions: ['tools.register', 'channel.send', 'network:qzone.qq.com', 'secrets:qzone-token'],
  tools: [{ name: 'post', effect: 'send', load: 'onDemand', group: 'post', summary: '发一条说说', textArg: 'text' }],
  mcp: { url: 'https://qzone.qq.com/mcp', headers: { Authorization: 'secret:qzone-token' } },
}

test('a manifest with an MCP server passes', () => {
  assert.equal(validateManifest(mcpManifest).ok, true)
})

test('mcp has exactly one of command and url', () => {
  assertField({ ...clone(mcpManifest), mcp: {} }, 'mcp')
  assertField({ ...clone(mcpManifest), mcp: { command: 'node', url: 'https://qzone.qq.com' } }, 'mcp')
  assertField({ ...clone(mcpManifest), mcp: { command: '' } }, 'mcp.command')
  assertField({ ...clone(mcpManifest), mcp: { command: 'node', args: [1] } }, 'mcp.args')
  assertField({ ...clone(mcpManifest), mcp: { command: 'node', headers: { A: 'b' } } }, 'mcp.headers')
  assertField({ ...clone(mcpManifest), mcp: { url: 'https://qzone.qq.com', args: ['x'] } }, 'mcp.args')
})

test('a literal mcp.url must be http(s) and covered by a network or lan permission', () => {
  assert.equal(validateManifest({ ...clone(mcpManifest), mcp: { url: 'http://qzone.qq.com/mcp' } }).ok, true)
  assertField({ ...clone(mcpManifest), mcp: { url: 'ftp://qzone.qq.com/mcp' } }, 'mcp.url')
  assertField({ ...clone(mcpManifest), mcp: { url: 'not a url' } }, 'mcp.url')
  assertField({ ...clone(mcpManifest), mcp: { url: 'https://evil.example.com/mcp' } }, 'mcp.url')

  const wildcard = { ...clone(mcpManifest), permissions: [...mcpManifest.permissions, 'network:*.qzone.qq.com'] }
  assert.equal(validateManifest({ ...wildcard, mcp: { url: 'https://feed.qzone.qq.com/mcp' } }).ok, true)

  const lan = { ...clone(mcpManifest), permissions: [...mcpManifest.permissions, 'lan:192.168.1.5'] }
  assert.equal(validateManifest({ ...lan, mcp: { url: 'http://192.168.1.5:8123/mcp' } }).ok, true)
})

test('a config mcp.url needs the matching config permission', () => {
  const withPermission = {
    ...clone(mcpManifest),
    permissions: [...mcpManifest.permissions, 'network:config:haUrl'],
    mcp: { url: 'config:haUrl' },
  }
  assert.equal(validateManifest(withPermission).ok, true)

  assertField({ ...clone(mcpManifest), mcp: { url: 'config:haUrl' } }, 'mcp.url')
  assertField({ ...clone(mcpManifest), mcp: { url: 'config:' } }, 'mcp.url')
  assertField({ ...clone(mcpManifest), mcp: { url: 'config:1bad' } }, 'mcp.url')

  const lanConfig = {
    ...clone(mcpManifest),
    permissions: [...mcpManifest.permissions, 'lan:config:comfy'],
    mcp: { url: 'config:comfy' },
  }
  assert.equal(validateManifest(lanConfig).ok, true)
})

test('secret values need the matching secrets permission; config and literals do not', () => {
  assert.equal(validateManifest({
    ...clone(mcpManifest),
    mcp: { url: 'https://qzone.qq.com/mcp', headers: { Authorization: 'Bearer literal' } },
  }).ok, true)
  assert.equal(validateManifest({
    ...clone(mcpManifest),
    permissions: [...mcpManifest.permissions, 'network:config:token'],
    mcp: { url: 'https://qzone.qq.com/mcp', headers: { Authorization: 'config:token' } },
  }).ok, true)

  assertField({
    ...clone(mcpManifest),
    permissions: ['tools.register', 'channel.send', 'network:qzone.qq.com'],
    mcp: { url: 'https://qzone.qq.com/mcp', headers: { Authorization: 'secret:qzone-token' } },
  }, 'mcp.headers.Authorization')

  assertField({
    ...clone(mcpManifest),
    permissions: ['tools.register', 'channel.send', 'network:qzone.qq.com'],
    mcp: { command: 'node', env: { TOKEN: 'secret:qzone-token' } },
  }, 'mcp.env.TOKEN')

  assertField({
    ...clone(mcpManifest),
    mcp: { url: 'https://qzone.qq.com/mcp', headers: { Authorization: 'secret:' } },
  }, 'mcp.headers.Authorization')
})

test('unknown fields at the root are reported', () => {
  assertField({ ...clone(rfcManifest), nmae: 'typo' }, 'nmae')
})

test('every problem is reported, not just the first', () => {
  const broken = {
    ...clone(rfcManifest),
    id: 'Bad',
    api: '1.0',
    runtime: 'browser',
  }
  assert.deepEqual(fieldsOf(broken).sort(), ['api', 'id', 'runtime'])
})

test('a manifest full of independent mistakes reports them all', () => {
  const broken = {
    id: 'demo',
    kinds: [],
    api: '^1',
    runtime: 'process',
    permissions: ['tools.register', 'tools.register'],
    tools: [
      { name: 'watch', effect: 'read', load: 'onDemand', summary: '' },
      { name: 'watch', effect: 'send', load: 'core', summary: 'x' },
    ],
    config: '/abs.js',
  }
  const fields = fieldsOf(broken).sort()
  assert.deepEqual(fields, [
    'config',
    'kinds',
    'permissions[1]',
    'process.command',
    'tools[0].group',
    'tools[0].summary',
    'tools[1].effect',
    'tools[1].name',
  ].sort())
})

test('source.channels allows colons in the last segment and still wants it non-empty without spaces', () => {
  assert.equal(validateManifest(sourceManifest({ ...clone(validSource), channels: ['qq:guild:1:2'] })).ok, true)
  for (const channel of ['qq:group:a b', 'qq:group:']) {
    assertField(sourceManifest({ ...clone(validSource), channels: [channel] }), 'source.channels[0]')
  }
})

test('source.eventKinds needs the dot after the plugin id', () => {
  assertField(sourceManifest({ ...clone(validSource), eventKinds: ['qqx.event'] }), 'source.eventKinds[0]')
  assert.equal(validateManifest(sourceManifest({ ...clone(validSource), eventKinds: ['qq.event'] })).ok, true)
})

test('tools must be an array', () => {
  assertField({ ...toolManifest(validTool), tools: {} }, 'tools')
})

test('a context tool without a group is reported', () => {
  const tool = { ...clone(validTool), load: 'context', when: 'message.hasMedia' } as Record<string, unknown>
  delete tool.group
  assertField(toolManifest(tool), 'tools[0].group')
})

test('group names are at most 31 characters, for tools and for groups', () => {
  assert.equal(validateManifest(toolManifest({ ...clone(validTool), group: 'a'.repeat(31) })).ok, true)
  assertField(toolManifest({ ...clone(validTool), group: 'a'.repeat(32) }), 'tools[0].group')

  const withGroups = (groups: unknown): Record<string, unknown> => ({ ...clone(rfcManifest), groups })
  assert.equal(validateManifest(withGroups({ ['a'.repeat(31)]: { summary: '视频' } })).ok, true)
  assertField(withGroups({ ['a'.repeat(32)]: { summary: '视频' } }), `groups.${'a'.repeat(32)}`)
})

test('mcpName must be a non-empty string when the manifest has mcp', () => {
  for (const mcpName of ['', 7]) {
    assertField({
      ...toolManifest({ ...clone(validTool), mcpName }),
      mcp: { command: 'hass-mcp' },
    }, 'tools[0].mcpName')
  }
})

test('groups.<name>.summary is capped at 60 characters', () => {
  const withGroups = (summary: string): Record<string, unknown> => ({ ...clone(rfcManifest), groups: { video: { summary } } })
  assert.equal(validateManifest(withGroups('a'.repeat(60))).ok, true)
  assertField(withGroups('a'.repeat(61)), 'groups.video.summary')
})

test('a literal mcp.url needs a lan permission for its own host', () => {
  const lan = { ...clone(mcpManifest), permissions: [...mcpManifest.permissions, 'lan:192.168.1.5'] }
  assertField({ ...lan, mcp: { url: 'http://192.168.1.6:8123/mcp' } }, 'mcp.url')
})

test('a literal mcp.url on a bracketed IPv6 host passes with the matching lan permission', () => {
  const lan = { ...clone(mcpManifest), permissions: [...mcpManifest.permissions, 'lan:[::1]'] }
  assert.equal(validateManifest({ ...lan, mcp: { url: 'http://[::1]:3000/mcp' } }).ok, true)
})

test('a config mcp.url needs the permission for that very key', () => {
  assertField({
    ...clone(mcpManifest),
    permissions: [...mcpManifest.permissions, 'network:config:other'],
    mcp: { url: 'config:haUrl' },
  }, 'mcp.url')
})

test('a secret value needs the secrets permission with that very name', () => {
  assertField({
    ...clone(mcpManifest),
    permissions: ['tools.register', 'channel.send', 'network:qzone.qq.com', 'secrets:other'],
    mcp: { url: 'https://qzone.qq.com/mcp', headers: { Authorization: 'secret:qzone-token' } },
  }, 'mcp.headers.Authorization')
})

test('mcp with both command and url reports only mcp', () => {
  assert.deepEqual(
    fieldsOf({ ...clone(mcpManifest), mcp: { command: 'node', url: 'https://qzone.qq.com/mcp' } }),
    ['mcp'],
  )
})

test('memory.readL0 and memory.writeDerived require the memory-provider kind and need no source', () => {
  for (const permission of ['memory.readL0', 'memory.writeDerived']) {
    assertField({
      id: 'bad-reader',
      kinds: ['capability'],
      api: '^1.0.0',
      runtime: 'node',
      permissions: [permission],
    }, 'permissions')
  }

  const validProvider = {
    id: 'my-provider',
    kinds: ['memory-provider'],
    api: '^1.0.0',
    runtime: 'node',
    permissions: ['memory.readL0', 'memory.writeDerived'],
  }
  const result = validateManifest(validProvider)
  assert.equal(result.ok, true)
})
