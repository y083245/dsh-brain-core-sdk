import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeSessionId } from '@brain-core/satellite-host'
import type { MemoryService } from '../../src/contracts/index.ts'
import { createToolGateway } from '../../src/tool-gateway/index.ts'
import { FakeClock } from '../fakes/index.ts'
import { FakeAudit, fakeLogger, FakeMemory } from './helpers.ts'

test('AMP aliases are disabled by default and appear dynamically on refreshBuiltins', async () => {
  let ampEnabled = false
  const memory: MemoryService = Object.assign(new FakeMemory(), {
    health: async () => ({ store: 'ok', index: 'ok', jobs: 'ok' }) as const,
  })
  const gateway = createToolGateway({
    memory,
    audit: new FakeAudit(),
    clock: new FakeClock(),
    log: fakeLogger(),
    ownerChannels: () => new Set(['qq:private:owner']),
    style: () => ({ enabled: true, openers: [] }),
    ampAliases: () => ampEnabled,
  })

  let changes = 0
  gateway.onCatalogChange(() => { changes += 1 })

  assert.equal(gateway.catalog().some((tool) => tool.name.startsWith('amp__')), false)
  assert.equal(gateway.coreBudget('qq:private').count, 3)

  ampEnabled = true
  gateway.refreshBuiltins()
  assert.equal(changes, 1)

  const names = gateway.catalog().map((tool) => tool.name)
  for (const ampTool of ['amp__recall', 'amp__encode', 'amp__forget', 'amp__pin', 'amp__consolidate', 'amp__stats']) {
    assert.ok(names.includes(ampTool), `missing ${ampTool}`)
  }

  const sessionId = encodeSessionId({ agentClass: 'chat', channel: 'qq:private:owner', generation: 0 })
  const planned = gateway.planWake({
    sessionId,
    wakeId: 'w-amp-1',
    features: { message: { hasMedia: false, hasForward: false }, event: { poke: false }, channel: { kind: 'private' } },
    mode: 'addition-only',
    silent: false,
    participants: ['owner'],
    evidence: [],
    peerTexts: [],
  })
  assert.ok(planned.includes('amp__recall'))
  assert.equal(planned.includes('amp__encode'), false)

  const searchRes = await gateway.dispatch({ sessionId, toolName: 'tools__search', args: { query: 'amp' } })
  assert.ok(typeof searchRes === 'string' && searchRes.includes('amp'))

  const loadRes = await gateway.dispatch({ sessionId, toolName: 'tools__load', args: { group: 'amp' } })
  assert.ok(typeof loadRes === 'string' && loadRes.includes('已加载'))
  assert.ok(gateway.surfaceOf(sessionId).has('amp__stats'))

  const statsRes = await gateway.dispatch({ sessionId, toolName: 'amp__stats', args: {} })
  assert.ok(typeof statsRes === 'string' && statsRes.includes('"health"'))

  // Disabling dynamically removes AMP tools from surface and dispatch
  ampEnabled = false
  gateway.refreshBuiltins()
  assert.equal(changes, 2)
  assert.equal(gateway.catalog().some((tool) => tool.name.startsWith('amp__')), false)
  assert.equal(gateway.surfaceOf(sessionId).has('amp__recall'), false)
  await assert.rejects(
    () => gateway.dispatch({ sessionId, toolName: 'amp__stats', args: {} }),
    /工具 amp__stats 现在不可用/,
  )
})
