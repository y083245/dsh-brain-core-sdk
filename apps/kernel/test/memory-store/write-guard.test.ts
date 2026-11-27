import assert from 'node:assert/strict'
import test from 'node:test'
import { BrainError, type IngestEvent, type RecordInput } from '@dsh-brain-core/sdk'
import type { WriteIdentity } from '../../src/contracts/index.ts'
import { CHANNEL_PATTERN, applyWriteGuard, isValidChannel } from '../../src/memory-store/index.ts'

function pluginIdentity(overrides: Partial<WriteIdentity> = {}): WriteIdentity {
  return {
    kind: 'plugin',
    source: 'qq',
    trust: 'owner',
    defaultVisibility: 'open',
    channels: ['qq:group:1'],
    eventKinds: ['chat'],
    ...overrides,
  }
}

function kernelIdentity(overrides: Partial<WriteIdentity> = {}): WriteIdentity {
  return { kind: 'kernel', source: 'kernel', trust: 'self', defaultVisibility: 'internal', ...overrides }
}

function recordInput(overrides: Partial<RecordInput> = {}): RecordInput {
  return {
    layer: 'L1',
    kind: 'l1.fact',
    channel: 'qq:group:1',
    subjects: ['self'],
    actor: 'owner',
    content: { text: 'hello' },
    evidence: [{ id: 'l0_x' }],
    ...overrides,
  }
}

function ingestEvent(overrides: Partial<IngestEvent> = {}): IngestEvent {
  return {
    kind: 'chat',
    channel: 'qq:group:1',
    subjects: ['self'],
    actor: 'owner',
    content: { text: 'hello' },
    tEvent: 500,
    idempotencyKey: 'k1',
    ...overrides,
  }
}

function throwsCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof BrainError, `expected BrainError, got ${String(error)}`)
    assert.equal(error.code, code)
    return true
  })
}

test('the channel pattern is <source>:<kind>:<id>', () => {
  assert.equal(isValidChannel('qq:group:1'), true)
  assert.equal(isValidChannel('plugin-a:chat:abc_DEF-123'), true)
  assert.equal(isValidChannel('qq'), false)
  assert.equal(isValidChannel('qq:group'), false)
  assert.equal(isValidChannel('QQ:group:1'), false)
  assert.equal(isValidChannel('qq group:1'), false)
  assert.equal(isValidChannel('qq:group:1 2'), false)
  assert.equal(CHANNEL_PATTERN.source, '^[a-z0-9][a-z0-9-]*:[a-z][a-z0-9_-]*:\\S+$')
})

test('a plugin cannot forge source or trust', () => {
  const forged = { ...recordInput(), source: 'evil.plugin', trust: 'external' } as never
  const result = applyWriteGuard(forged, pluginIdentity(), 1234)
  assert.equal(result.source, 'qq')
  assert.equal(result.trust, 'owner')
})

test('a plugin cannot write L3 and an out-of-list kind is rejected', () => {
  const l3 = { ...recordInput(), layer: 'L3', kind: 'l3.self' } as never
  throwsCode(() => applyWriteGuard(l3, pluginIdentity(), 0), 'PERMISSION_DENIED')
  throwsCode(() => applyWriteGuard(l3, kernelIdentity(), 0), 'INVALID_ARGUMENT')

  const l0 = { ...recordInput(), layer: 'L0', kind: 'l0.event' } as never
  throwsCode(() => applyWriteGuard(l0, pluginIdentity(), 0), 'PERMISSION_DENIED')
  throwsCode(() => applyWriteGuard(l0, kernelIdentity(), 0), 'INVALID_ARGUMENT')

  const badKind = { ...recordInput(), kind: 'l1.nope' }
  throwsCode(() => applyWriteGuard(badKind, kernelIdentity(), 0), 'INVALID_ARGUMENT')
})

test('unregistered channels and event kinds are denied; a plugin without a manifest entry writes nothing', () => {
  throwsCode(() => applyWriteGuard(recordInput({ channel: 'qq:group:2' }), pluginIdentity(), 0), 'PERMISSION_DENIED')
  throwsCode(() => applyWriteGuard(ingestEvent({ kind: 'gift' }), pluginIdentity(), 0), 'PERMISSION_DENIED')

  const unregistered = pluginIdentity({ channels: undefined, eventKinds: undefined })
  throwsCode(() => applyWriteGuard(recordInput(), unregistered, 0), 'PERMISSION_DENIED')
  throwsCode(() => applyWriteGuard(ingestEvent(), unregistered, 0), 'PERMISSION_DENIED')

  const kernel = kernelIdentity()
  const channel = 'anything:here:1'
  assert.equal(applyWriteGuard(recordInput({ channel }), kernel, 0).channel, channel)
  assert.equal(applyWriteGuard(ingestEvent({ kind: 'anything', channel }), kernel, 0).layer, 'L0')
})

test('a malformed channel is rejected before any permission check', () => {
  for (const channel of ['qq', 'qq:group', 'QQ:group:1', 'qq group:1', 'qq:group:1 2']) {
    throwsCode(() => applyWriteGuard(recordInput({ channel }), kernelIdentity(), 0), 'INVALID_ARGUMENT')
    throwsCode(() => applyWriteGuard(ingestEvent({ channel }), kernelIdentity(), 0), 'INVALID_ARGUMENT')
  }
})

test('defaults fill visibility, confidence, importance and tEvent', () => {
  const input = applyWriteGuard(recordInput(), pluginIdentity({ defaultVisibility: 'internal' }), 777)
  assert.equal(input.layer, 'L1')
  assert.equal(input.visibility, 'internal')
  assert.equal(input.confidence, 1)
  assert.equal(input.importance, 0.5)
  assert.equal(input.tEvent, 777)
  assert.deepEqual(input.evidence, [{ id: 'l0_x' }])
  assert.equal('validFrom' in input, false)

  const explicit = applyWriteGuard(recordInput({
    visibility: 'owner', confidence: 0.2, importance: 0.9, tEvent: 42, validFrom: 7,
  }), pluginIdentity(), 999)
  assert.equal(explicit.visibility, 'owner')
  assert.equal(explicit.confidence, 0.2)
  assert.equal(explicit.importance, 0.9)
  assert.equal(explicit.tEvent, 42)
  assert.equal(explicit.validFrom, 7)
})

test('an ingest event becomes an L0 record with no evidence and fixed scores', () => {
  const result = applyWriteGuard(ingestEvent(), pluginIdentity({ defaultVisibility: 'owner', source: 'qq', trust: 'member' }), 9999)
  assert.equal(result.layer, 'L0')
  assert.equal(result.kind, 'chat')
  assert.equal(result.channel, 'qq:group:1')
  assert.deepEqual(result.evidence, [])
  assert.equal(result.confidence, 1)
  assert.equal(result.importance, 0.5)
  assert.equal(result.tEvent, 500)
  assert.equal(result.visibility, 'owner')
  assert.equal(result.source, 'qq')
  assert.equal(result.trust, 'member')
  assert.equal('validFrom' in result, false)
})
