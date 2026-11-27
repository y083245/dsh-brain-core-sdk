import assert from 'node:assert/strict'
import test from 'node:test'
import { toDshParameters } from '@dsh-brain-core/satellite-host'
import { BrainError } from '@dsh-brain-core/sdk'
import { fakeTool, harness, rejection } from './helpers.ts'

const BUILTINS = ['memory__forget', 'memory__remember', 'memory__search', 'memory__update', 'tools__load', 'tools__search']

test('the catalog holds every built-in tool, sorted, with DSH-shaped parameters', () => {
  const { gateway } = harness()
  const names = gateway.catalog().map((tool) => tool.name)
  assert.deepEqual(names, BUILTINS)
  const search = gateway.catalog().find((tool) => tool.name === 'memory__search')
  assert.ok(search !== undefined)
  assert.equal(typeof search.description, 'string')
  assert.ok(search.description.length > 0)
  assert.deepEqual(Object.keys(search.parameters).sort(), ['history', 'limit', 'neighbors', 'query', 'scope'])
  assert.equal((search.parameters.query as { required?: boolean }).required, true)
})

test('a registered tool appears as <pluginId>__<name> with its parameters converted for DSH', () => {
  const { gateway } = harness()
  const tool = fakeTool({
    pluginId: 'bili',
    name: 'watch',
    parameters: { type: 'object', properties: { url: { type: 'string', format: 'uri' } }, required: ['url'] },
  })
  gateway.register(tool)
  const entry = gateway.catalog().find((item) => item.name === 'bili__watch')
  assert.ok(entry !== undefined)
  assert.equal(entry.description, 'watch description')
  assert.deepEqual(entry.parameters, toDshParameters(tool.parameters))
})

test('the catalog is sorted and byte-identical whatever order tools were registered in', () => {
  const make = () => [
    fakeTool({ pluginId: 'b', name: 'two' }),
    fakeTool({ pluginId: 'a', name: 'one' }),
    fakeTool({ pluginId: 'c', name: 'three' }),
  ]
  const first = harness()
  for (const tool of make()) first.gateway.register(tool)
  const second = harness()
  for (const tool of make().reverse()) second.gateway.register(tool)
  assert.equal(JSON.stringify(first.gateway.catalog()), JSON.stringify(second.gateway.catalog()))
  const names = first.gateway.catalog().map((tool) => tool.name)
  assert.deepEqual(names, [...names].sort())
  assert.ok(names.includes('a__one') && names.includes('b__two') && names.includes('c__three'))
})

test('a tool that was never registered is not in the catalog and cannot be reached (T5)', async () => {
  const { gateway } = harness()
  assert.equal(gateway.catalog().some((tool) => tool.name === 'p__ghost'), false)
  assert.equal(gateway.catalog().length, 6)
})

test('revoking removes the tool and both register and revoke notify listeners', () => {
  const { gateway } = harness()
  let changes = 0
  const stop = gateway.onCatalogChange(() => { changes += 1 })
  const revoke = gateway.register(fakeTool({ name: 'a' }))
  assert.equal(changes, 1)
  assert.ok(gateway.catalog().some((tool) => tool.name === 'p__a'))
  revoke()
  assert.equal(changes, 2)
  assert.equal(gateway.catalog().some((tool) => tool.name === 'p__a'), false)
  revoke()
  assert.equal(changes, 2, 'revoking twice does nothing')
  stop()
  gateway.register(fakeTool({ name: 'b' }))
  assert.equal(changes, 2, 'an unsubscribed listener hears nothing')
})

test('a stale revoke function does not remove a tool registered again under the same name', () => {
  const { gateway } = harness()
  const revokeOld = gateway.register(fakeTool({ name: 'a' }))
  revokeOld()
  gateway.register(fakeTool({ name: 'a' }))
  revokeOld()
  assert.ok(gateway.catalog().some((tool) => tool.name === 'p__a'))
})

test('registering a name twice, or a built-in name, is a CONFLICT and changes nothing', () => {
  const { gateway } = harness()
  let changes = 0
  gateway.onCatalogChange(() => { changes += 1 })
  gateway.register(fakeTool({ name: 'a' }))
  for (const duplicate of [fakeTool({ name: 'a' }), fakeTool({ pluginId: 'memory', name: 'search' })]) {
    assert.throws(() => gateway.register(duplicate), (error: unknown) => error instanceof BrainError && error.code === 'CONFLICT')
  }
  assert.equal(changes, 1)
})

test('a tool whose parameters have no object root, or whose when cannot be parsed, is refused at register', () => {
  const { gateway } = harness()
  const badRoot = fakeTool({ name: 'a', parameters: { type: 'string' } as never })
  assert.throws(() => gateway.register(badRoot), (error: unknown) => error instanceof BrainError && error.code === 'INVALID_ARGUMENT')
  const badWhen = fakeTool({ name: 'b', load: 'context', group: 'g', when: 'not a feature' })
  assert.throws(() => gateway.register(badWhen), (error: unknown) => error instanceof BrainError && error.code === 'INVALID_ARGUMENT')
  assert.equal(gateway.catalog().length, 6)
})

test('a listener that throws does not stop the others or the registration', () => {
  const { gateway, log } = harness()
  let heard = 0
  gateway.onCatalogChange(() => { throw new Error('boom') })
  gateway.onCatalogChange(() => { heard += 1 })
  gateway.register(fakeTool({ name: 'a' }))
  assert.equal(heard, 1)
  assert.ok(gateway.catalog().some((tool) => tool.name === 'p__a'))
  assert.ok(log.lines.some((line) => line.level === 'warn'))
})

test('a catalog request in an unknown session throws the same message as any refusal', async () => {
  const { gateway } = harness()
  const error = await rejection(gateway.dispatch({ sessionId: 'nonsense', toolName: 'tools__search', args: {} }))
  assert.equal(error.message, 'session unavailable')
})
