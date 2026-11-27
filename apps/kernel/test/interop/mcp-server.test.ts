import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { BrainError, LIMITS } from '@dsh-brain-core/sdk'
import { prepareBrainHome } from '../../src/home/index.ts'
import { createReadOnlyMcpServer, generateDshMcpPatchYaml } from '../../src/interop/index.ts'
import { openMemory, type Memory } from '../../src/memory-api/index.ts'
import { FakeMemory, fakeLogger } from '../tool-gateway/helpers.ts'

const OWNER_IDENTITY = {
  kind: 'kernel' as const,
  source: 'owner-console',
  trust: 'owner' as const,
  defaultVisibility: 'owner' as const,
}

async function withTempMemory(run: (ctx: { readonly dir: string; readonly dshDir: string; readonly memory: Memory }) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brain-interop-mcp-'))
  const fakeUserHome = path.join(dir, 'user-home')
  const dshDir = path.join(fakeUserHome, '.dsh')
  const brainHome = path.join(dir, 'brain-home')
  const paths = await prepareBrainHome({ env: { BRAIN_HOME: brainHome }, userHome: fakeUserHome })
  const memory = await openMemory({
    paths,
    clock: { now: () => 1_700_000_000_000 },
    log: fakeLogger(),
    crossChannelMode: () => 'shadow',
    ownerChannels: [],
  })
  try {
    await run({ dir, dshDir, memory })
  } finally {
    await memory.close()
    await rm(dir, { recursive: true, force: true, maxRetries: 5 })
  }
}

async function rpcPost(
  url: string,
  body: unknown,
  token?: string,
): Promise<{ readonly status: number; readonly text: string; readonly json: unknown }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      'Content-Type': 'application/json',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await res.text()
  let json: unknown = undefined
  if (text !== '') {
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
  }
  return { status: res.status, text, json }
}

test('generateDshMcpPatchYaml outputs valid StreamableHttpConfig YAML without touching DSH home', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'brain-mcp-yaml-'))
  const prevDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = tmp
  try {
    const yaml = generateDshMcpPatchYaml('http://127.0.0.1:43210/mcp', 'tok_"abc"\\1')
    assert.match(yaml, /^- insert:/m)
    assert.match(yaml, /id: brain-memory-readonly/)
    assert.match(yaml, /name: '@deepseek-ai\/dsh-mcp-client'/)
    assert.match(yaml, /serverName: brain_memory/)
    assert.match(yaml, /transport: streamable-http/)
    assert.match(yaml, /url: "http:\/\/127\.0\.0\.1:43210\/mcp"/)
    assert.match(yaml, /Authorization: "Bearer tok_\\"abc\\"\\\\1"/)

    // Must never write anything to DSH_HOME
    const entries = await readdir(tmp)
    assert.deepEqual(entries, [])
  } finally {
    if (prevDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevDshHome
    await rm(tmp, { recursive: true, force: true })
  }
})

test('read-only MCP server binds 127.0.0.1, enforces Bearer auth, rejects oversized/non-POST, and runs read-only flow', async () => {
  await withTempMemory(async ({ dshDir, memory }) => {
    const l0a = await memory.service.ingest({
      kind: 'chat.message',
      channel: 'qq:private:alice',
      subjects: ['alice'],
      actor: 'alice',
      content: { text: '公开可见的咖啡偏好' },
      tEvent: 1000,
      idempotencyKey: 'mcp-1',
      visibility: 'owner',
    }, OWNER_IDENTITY)
    await memory.service.ingest({
      kind: 'chat.message',
      channel: 'qq:private:alice',
      subjects: ['self'],
      actor: 'self',
      content: { text: '仅internal可见的咖啡内部备注' },
      tEvent: 2000,
      idempotencyKey: 'mcp-2',
      visibility: 'internal',
    }, OWNER_IDENTITY)
    await memory.profiles.commit({
      stable: '我是测试大脑助手',
      data: { mood: 'calm' },
      evidence: [{ id: l0a.id }],
      author: 'owner',
    })

    const token = 'mcp-secret-token-value'
    const server = createReadOnlyMcpServer({
      memory: memory.service,
      profiles: memory.profiles,
      store: memory.store,
      token,
      ampAliases: false,
      log: fakeLogger(),
    })

    assert.deepEqual(server.status(), { enabled: true, running: false })
    const { port, url } = await server.listen()
    try {
      assert.ok(port > 0)
      assert.equal(url, `http://127.0.0.1:${String(port)}/mcp`)
      const status = server.status()
      assert.equal(status.running, true)
      assert.equal(status.url, url)
      assert.equal(status.port, port)
      assert.ok(status.patchYaml?.includes(url))

      // 1. Auth failures -> 401
      assert.equal((await rpcPost(url, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401)
      assert.equal((await rpcPost(url, { jsonrpc: '2.0', id: 1, method: 'ping' }, 'wrong-token')).status, 401)
      assert.equal((await rpcPost(url, { jsonrpc: '2.0', id: 1, method: 'ping' }, 'short')).status, 401)

      // 2. Method / path checks
      const getRes = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      assert.equal(getRes.status, 405)
      const otherPath = await fetch(`http://127.0.0.1:${String(port)}/other`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      assert.equal(otherPath.status, 404)

      // 3. Payload too large -> 413
      const huge = 'x'.repeat(LIMITS.requestBytes + 64)
      assert.equal((await rpcPost(url, huge, token)).status, 413)

      // 4. initialize -> 200
      const initRes = await rpcPost(url, { jsonrpc: '2.0', id: 1, method: 'initialize' }, token)
      assert.equal(initRes.status, 200)
      assert.deepEqual(initRes.json, {
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'brain-memory', version: '1.0.0' },
        },
      })

      // 5. notifications/initialized -> 202 empty
      const notifRes = await rpcPost(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, token)
      assert.equal(notifRes.status, 202)
      assert.equal(notifRes.text, '')

      // 6. ping -> {}
      const pingRes = await rpcPost(url, { jsonrpc: '2.0', id: 2, method: 'ping' }, token)
      assert.deepEqual(pingRes.json, { jsonrpc: '2.0', id: 2, result: {} })

      // 7. tools/list -> only 3 read-only tools when ampAliases=false
      const listRes = await rpcPost(url, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, token)
      const listedNames = ((listRes.json as { result: { tools: { name: string }[] } }).result.tools).map((t) => t.name)
      assert.deepEqual(listedNames, ['memory_search', 'memory_profile', 'memory_stats'])

      // 8. tools/call memory_search sees internal records under OWNER_VIEWER
      const searchRes = await rpcPost(url, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'memory_search', arguments: { query: '咖啡' } },
      }, token)
      const searchText = (searchRes.json as { result: { content: { text: string }[] } }).result.content[0]!.text
      assert.match(searchText, /公开可见的咖啡偏好/)
      assert.match(searchText, /仅internal可见的咖啡内部备注/)

      // 9. tools/call memory_profile
      const profileRes = await rpcPost(url, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'memory_profile', arguments: {} },
      }, token)
      const profileText = (profileRes.json as { result: { content: { text: string }[] } }).result.content[0]!.text
      const profile = JSON.parse(profileText) as { version: number; stable: string }
      assert.equal(profile.version, 1)
      assert.equal(profile.stable, '我是测试大脑助手')

      // 10. tools/call memory_stats
      const statsRes = await rpcPost(url, {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'memory_stats', arguments: {} },
      }, token)
      const statsText = (statsRes.json as { result: { content: { text: string }[] } }).result.content[0]!.text
      assert.equal(statsText.includes('咖啡'), false)
      const stats = JSON.parse(statsText) as { health: Record<string, string>; counts: Record<string, number> }
      assert.equal(stats.health.store, 'ok')
      assert.equal(stats.counts.L0, 2)
      assert.equal(stats.counts.L3, 1)

      // 10b. Invalid tool arguments return MCP isError=true, invalid JSON returns -32700, unknown method returns -32601
      const badArgsRes = await rpcPost(url, {
        jsonrpc: '2.0',
        id: 61,
        method: 'tools/call',
        params: { name: 'memory_search', arguments: { query: '' } },
      }, token)
      assert.equal((badArgsRes.json as { result: { isError: boolean } }).result.isError, true)

      const badJsonRes = await rpcPost(url, '{not json', token)
      assert.equal(badJsonRes.status, 400)
      assert.equal((badJsonRes.json as { error: { code: number } }).error.code, -32700)

      const unknownMethodRes = await rpcPost(url, { jsonrpc: '2.0', id: 62, method: 'resources/list' }, token)
      assert.equal((unknownMethodRes.json as { error: { code: number } }).error.code, -32601)

      // 11. Write tools and disabled amp tools must return -32601
      for (const forbidden of ['memory_record', 'memory_update', 'memory_forget', 'amp_encode', 'amp_forget', 'amp_pin', 'amp_recall', 'unknown_tool']) {
        const res = await rpcPost(url, {
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: forbidden, arguments: {} },
        }, token)
        assert.equal((res.json as { error: { code: number } }).error.code, -32601, `${forbidden} must be rejected`)
      }

      // Ensure zero files were created in fake ~/.dsh
      await assert.rejects(() => readdir(dshDir))
    } finally {
      await server.close()
      assert.equal(server.status().running, false)
    }
  })
})

test('read-only MCP server exposes amp_recall and amp_stats (only read-only) when ampAliases is true', async () => {
  await withTempMemory(async ({ memory }) => {
    await memory.service.ingest({
      kind: 'chat.message',
      channel: 'qq:private:alice',
      subjects: ['alice'],
      actor: 'alice',
      content: { text: 'AMP 只读测试记录' },
      tEvent: 1000,
      idempotencyKey: 'mcp-amp-1',
      visibility: 'owner',
    }, OWNER_IDENTITY)

    const token = 'mcp-amp-token'
    const server = createReadOnlyMcpServer({
      memory: memory.service,
      profiles: memory.profiles,
      store: memory.store,
      token,
      ampAliases: true,
    })

    const { url } = await server.listen()
    try {
      const listRes = await rpcPost(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, token)
      const listedNames = ((listRes.json as { result: { tools: { name: string }[] } }).result.tools).map((t) => t.name)
      assert.deepEqual(listedNames, ['memory_search', 'memory_profile', 'memory_stats', 'amp_recall', 'amp_stats'])

      const recallRes = await rpcPost(url, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'amp_recall', arguments: { query: '只读测试' } },
      }, token)
      const recallText = (recallRes.json as { result: { content: { text: string }[] } }).result.content[0]!.text
      assert.match(recallText, /AMP 只读测试记录/)

      const statsRes = await rpcPost(url, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'amp_stats', arguments: {} },
      }, token)
      const statsText = (statsRes.json as { result: { content: { text: string }[] } }).result.content[0]!.text
      assert.equal((JSON.parse(statsText) as { counts: { L0: number } }).counts.L0, 1)
    } finally {
      await server.close()
    }
  })
})

test('createReadOnlyMcpServer rejects empty token, makes concurrent listen idempotent, binds 127.0.0.1 only, validates limit, and counts only active records', async () => {
  await withTempMemory(async ({ memory }) => {
    assert.throws(
      () => createReadOnlyMcpServer({ memory: memory.service, profiles: memory.profiles, token: '' }),
      (error) => error instanceof BrainError && error.code === 'INVALID_ARGUMENT',
    )

    const l0 = await memory.service.ingest({
      kind: 'chat.message',
      channel: 'qq:private:alice',
      subjects: ['alice'],
      actor: 'alice',
      content: { text: '统计测试基线原文' },
      tEvent: 1000,
      idempotencyKey: 'mcp-stat-base',
      visibility: 'owner',
    }, OWNER_IDENTITY)

    const activeL1 = await memory.service.record({
      layer: 'L1',
      kind: 'l1.fact',
      channel: 'qq:private:alice',
      subjects: ['alice'],
      actor: 'self',
      content: { text: '活跃事实' },
      evidence: [{ id: l0.id }],
      visibility: 'owner',
    }, OWNER_IDENTITY)
    const tombstonedL1 = await memory.service.record({
      layer: 'L1',
      kind: 'l1.fact',
      channel: 'qq:private:alice',
      subjects: ['alice'],
      actor: 'self',
      content: { text: '被遗忘的事实' },
      evidence: [{ id: l0.id }],
      visibility: 'owner',
    }, OWNER_IDENTITY)
    const outdatedL1 = await memory.service.record({
      layer: 'L1',
      kind: 'l1.fact',
      channel: 'qq:private:alice',
      subjects: ['alice'],
      actor: 'self',
      content: { text: '过时的事实' },
      evidence: [{ id: l0.id }],
      visibility: 'owner',
    }, OWNER_IDENTITY)

    await memory.service.remove(tombstonedL1.id, OWNER_IDENTITY, { caller: 'owner-console', channel: null, participants: [] })
    await memory.service.update(
      outdatedL1.id,
      { status: 'outdated' },
      outdatedL1.version,
      OWNER_IDENTITY,
      { caller: 'owner-console', channel: null, participants: [] },
    )
    assert.ok(activeL1.id)

    const token = 'mcp-concurrent-token'
    const server = createReadOnlyMcpServer({
      memory: memory.service,
      profiles: memory.profiles,
      store: memory.store,
      token,
    })

    const [first, second] = await Promise.all([server.listen(), server.listen()])
    try {
      assert.deepEqual(first, second)
      const third = await server.listen()
      assert.deepEqual(third, first)
      assert.equal(new URL(first.url).hostname, '127.0.0.1')
      // Confirm not listening on IPv6 loopback / wildcard ::
      await assert.rejects(() => rpcPost(`http://[::1]:${String(first.port)}/mcp`, { jsonrpc: '2.0', id: 1, method: 'ping' }, token))

      // memory_stats excludes tombstoned and outdated records, counting only active
      const statsRes = await rpcPost(first.url, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'memory_stats', arguments: {} },
      }, token)
      const statsText = (statsRes.json as { result: { content: { text: string }[] } }).result.content[0]!.text
      const stats = JSON.parse(statsText) as { counts: { L0: number; L1: number; L2: number; L3: number } }
      assert.equal(stats.counts.L0, 1)
      assert.equal(stats.counts.L1, 1)
    } finally {
      await server.close()
    }
  })

  // Verify mcp-server validates limit before calling MemoryService.search
  const spyMemory = new FakeMemory()
  const spyServer = createReadOnlyMcpServer({
    memory: spyMemory,
    profiles: { async current() { return { version: 0, stable: '' } } },
    token: 'spy-token',
  })
  const { url } = await spyServer.listen()
  try {
    for (const badLimit of [0, -1, LIMITS.searchLimit + 1, 1.5]) {
      const res = await rpcPost(url, {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'memory_search', arguments: { query: 'test', limit: badLimit } },
      }, 'spy-token')
      const result = (res.json as { result: { isError: boolean; content: { text: string }[] } }).result
      assert.equal(result.isError, true)
      assert.match(result.content[0]!.text, /limit/)
    }
    assert.equal(spyMemory.calls.length, 0)
  } finally {
    await spyServer.close()
  }
})
