import assert from 'node:assert/strict'
import test from 'node:test'
import { OWNER_CHANNEL, GROUP, PRIVATE, call, fakeTool, features, harness, plan, rejection, sessionFor } from './helpers.ts'

const CORE = ['memory__search', 'tools__load', 'tools__search']

test('planWake on a bare gateway gives the three core built-ins, sorted', () => {
  const { gateway } = harness()
  assert.deepEqual(gateway.planWake(plan(PRIVATE)), CORE)
  assert.deepEqual([...gateway.surfaceOf(sessionFor(PRIVATE))].sort(), CORE)
})

test('planWake rejects a session id it did not mint with RangeError', () => {
  const { gateway } = harness()
  assert.throws(() => gateway.planWake({ ...plan(PRIVATE), sessionId: 'nonsense' }), RangeError)
})

test('surfaceOf is empty for a session nobody planned or for an id that does not decode', () => {
  const { gateway } = harness()
  assert.equal(gateway.surfaceOf(sessionFor(PRIVATE)).size, 0)
  assert.equal(gateway.surfaceOf('nonsense').size, 0)
})

test('core plugin tools join the surface; context and onDemand ones do not without a match', () => {
  const { gateway } = harness()
  gateway.register(fakeTool({ name: 'say', load: 'core' }))
  gateway.register(fakeTool({ name: 'look', load: 'context', group: 'media', when: 'message.hasMedia' }))
  gateway.register(fakeTool({ name: 'sticker', load: 'onDemand', group: 'stickers' }))
  const surface = gateway.planWake(plan(PRIVATE))
  assert.ok(surface.includes('p__say'))
  assert.ok(!surface.includes('p__look'))
  assert.ok(!surface.includes('p__sticker'))
})

test('image, forward and poke wakes each add only their own context tool (FR-T02)', () => {
  const { gateway } = harness()
  gateway.register(fakeTool({ name: 'look', load: 'context', group: 'media', when: 'message.hasMedia' }))
  gateway.register(fakeTool({ name: 'unfold', load: 'context', group: 'forward', when: 'message.hasForward' }))
  gateway.register(fakeTool({ name: 'poke_back', load: 'context', group: 'poke', when: 'event.poke' }))
  const extras = (overrides: Parameters<typeof features>[0], channel: string): string[] => {
    const fresh = harness()
    for (const entry of ['look', 'unfold', 'poke_back']) {
      fresh.gateway.register(fakeTool({
        name: entry,
        load: 'context',
        group: entry,
        when: entry === 'look' ? 'message.hasMedia' : entry === 'unfold' ? 'message.hasForward' : 'event.poke',
      }))
    }
    return fresh.gateway.planWake(plan(channel, { features: features(overrides) })).filter((name) => name.startsWith('p__'))
  }
  assert.deepEqual(extras({ media: true }, PRIVATE), ['p__look'])
  assert.deepEqual(extras({ forward: true }, PRIVATE), ['p__unfold'])
  assert.deepEqual(extras({ poke: true }, PRIVATE), ['p__poke_back'])
  assert.deepEqual(extras({}, PRIVATE), [])
  assert.deepEqual(extras({ media: true, poke: true }, PRIVATE), ['p__look', 'p__poke_back'])
  void gateway
})

test('a channel.kind == "group" condition does not appear in a private chat but does in a group', () => {
  const { gateway } = harness()
  gateway.register(fakeTool({ name: 'roster', load: 'context', group: 'members', when: 'channel.kind == "group"' }))
  assert.ok(!gateway.planWake(plan(PRIVATE, { features: features({ kind: 'private' }) })).includes('p__roster'))
  assert.ok(gateway.planWake(plan(GROUP, { features: features({ kind: 'group' }), sessionId: sessionFor(GROUP) })).includes('p__roster'))
})

test('a context tool with no when is never matched in addition-only mode', () => {
  const { gateway } = harness()
  gateway.register(fakeTool({ name: 'odd', load: 'context', group: 'odd' }))
  assert.ok(!gateway.planWake(plan(PRIVATE)).includes('p__odd'))
})

test('a tool for another channel is neither listed nor callable (FR-G03)', async () => {
  const { gateway } = harness()
  const tool = fakeTool({ name: 'say', channels: ['qq:group'] })
  gateway.register(tool)
  assert.ok(!gateway.planWake(plan(PRIVATE)).includes('p__say'))
  const error = await rejection(gateway.dispatch(call(sessionFor(PRIVATE), 'p__say', { text: 'hi' })))
  assert.match(error.message, /tools__search/)
  assert.equal(tool.calls.length, 0)
  assert.ok(gateway.planWake(plan(GROUP, { sessionId: sessionFor(GROUP) })).includes('p__say'))
})

test('channels may use * in either segment', () => {
  const { gateway } = harness()
  gateway.register(fakeTool({ pluginId: 'a', name: 'src', channels: ['qq:*'] }))
  gateway.register(fakeTool({ pluginId: 'b', name: 'kind', channels: ['*:group'] }))
  gateway.register(fakeTool({ pluginId: 'c', name: 'all', channels: ['*:*'] }))
  gateway.register(fakeTool({ pluginId: 'd', name: 'other', channels: ['tg:private'] }))
  const privateQq = gateway.planWake(plan(PRIVATE))
  assert.deepEqual(privateQq.filter((name) => !name.includes('tools__') && !name.startsWith('memory')), ['a__src', 'c__all'])
  const groupQq = gateway.planWake(plan(GROUP, { sessionId: sessionFor(GROUP) }))
  assert.deepEqual(groupQq.filter((name) => !name.includes('tools__') && !name.startsWith('memory')), ['a__src', 'b__kind', 'c__all'])
})

test('an owner-only tool shows up on an owner channel and nowhere else', () => {
  const { gateway } = harness({ owners: [OWNER_CHANNEL] })
  gateway.register(fakeTool({ name: 'admin', audience: 'owner' }))
  assert.ok(gateway.planWake(plan(OWNER_CHANNEL, { sessionId: sessionFor(OWNER_CHANNEL) })).includes('p__admin'))
  assert.ok(!gateway.planWake(plan(PRIVATE)).includes('p__admin'))
  assert.ok(!gateway.planWake(plan('console:private:guest', { sessionId: sessionFor('console:private:guest') })).includes('p__admin'))
})

test('an owner tool is dropped from the surface and refused once the channel stops being an owner channel', async () => {
  const h = harness({ owners: [OWNER_CHANNEL] })
  h.gateway.register(fakeTool({ name: 'admin', audience: 'owner' }))
  const session = sessionFor(OWNER_CHANNEL)
  h.gateway.planWake(plan(OWNER_CHANNEL, { sessionId: session }))
  assert.equal(h.gateway.surfaceOf(session).has('p__admin'), true)
  h.owners.delete(OWNER_CHANNEL)
  assert.equal(h.gateway.surfaceOf(session).has('p__admin'), false)
  await rejection(h.gateway.dispatch(call(session, 'p__admin', { text: 'x' })))
})

test('the surface only grows within a session: a later wake with other features keeps earlier context tools', () => {
  const { gateway } = harness()
  gateway.register(fakeTool({ name: 'look', load: 'context', group: 'media', when: 'message.hasMedia' }))
  gateway.register(fakeTool({ name: 'poke_back', load: 'context', group: 'poke', when: 'event.poke' }))
  const first = gateway.planWake(plan(PRIVATE, { features: features({ media: true }), wakeId: 'w1' }))
  assert.ok(first.includes('p__look') && !first.includes('p__poke_back'))
  gateway.endWake(sessionFor(PRIVATE))
  const second = gateway.planWake(plan(PRIVATE, { features: features({ poke: true }), wakeId: 'w2' }))
  assert.ok(second.includes('p__look') && second.includes('p__poke_back'))
})

test('a revoked tool leaves the surface (the only way it shrinks) and comes back if registered again', () => {
  const { gateway } = harness()
  const revoke = gateway.register(fakeTool({ name: 'say' }))
  const session = sessionFor(PRIVATE)
  gateway.planWake(plan(PRIVATE))
  assert.ok(gateway.surfaceOf(session).has('p__say'))
  revoke()
  assert.equal(gateway.surfaceOf(session).has('p__say'), false)
  gateway.register(fakeTool({ name: 'say' }))
  assert.ok(gateway.surfaceOf(session).has('p__say'))
})

test('fixed mode: the first plan carries every context tool of the channel and later plans change nothing (W6)', () => {
  const { gateway } = harness()
  gateway.register(fakeTool({ name: 'look', load: 'context', group: 'media', when: 'message.hasMedia' }))
  gateway.register(fakeTool({ name: 'poke_back', load: 'context', group: 'poke', when: 'event.poke' }))
  gateway.register(fakeTool({ name: 'sticker', load: 'onDemand', group: 'stickers' }))
  const first = gateway.planWake(plan(PRIVATE, { mode: 'fixed', wakeId: 'w1' }))
  assert.ok(first.includes('p__look') && first.includes('p__poke_back'))
  assert.ok(!first.includes('p__sticker'))
  gateway.endWake(sessionFor(PRIVATE))
  gateway.register(fakeTool({ name: 'late', load: 'context', group: 'late', when: 'message.hasMedia' }))
  const second = gateway.planWake(plan(PRIVATE, { mode: 'fixed', wakeId: 'w2', features: features({ media: true }) }))
  assert.deepEqual(second, first)
})

test('resetSession puts the session back to the core tools and lets the next plan start over', () => {
  const { gateway } = harness()
  gateway.register(fakeTool({ name: 'look', load: 'context', group: 'media', when: 'message.hasMedia' }))
  const session = sessionFor(PRIVATE)
  gateway.planWake(plan(PRIVATE, { features: features({ media: true }) }))
  assert.ok(gateway.surfaceOf(session).has('p__look'))
  gateway.resetSession(session)
  assert.equal(gateway.surfaceOf(session).size, 0, 'reset clears the surface; the next plan builds it from core again')
  assert.deepEqual(gateway.activatedGroups(session), [])
  assert.deepEqual(gateway.planWake(plan(PRIVATE, { wakeId: 'w2' })), CORE)
})

test('restoreSession puts activated groups back so the next plan carries their tools', () => {
  const { gateway } = harness()
  gateway.register(fakeTool({ name: 'sticker', load: 'onDemand', group: 'stickers' }))
  const session = sessionFor(PRIVATE)
  gateway.restoreSession(session, ['stickers'])
  assert.deepEqual(gateway.activatedGroups(session), ['stickers'])
  assert.ok(gateway.planWake(plan(PRIVATE)).includes('p__sticker'))
})

test('restoreSession of a group that no longer exists is kept but adds nothing', () => {
  const { gateway } = harness()
  const session = sessionFor(PRIVATE)
  gateway.restoreSession(session, ['gone'])
  assert.deepEqual(gateway.activatedGroups(session), ['gone'])
  assert.deepEqual(gateway.planWake(plan(PRIVATE)), CORE)
})

test('activatedGroups is sorted and empty for an unknown session', () => {
  const { gateway } = harness()
  gateway.restoreSession(sessionFor(PRIVATE), ['b', 'a'])
  assert.deepEqual(gateway.activatedGroups(sessionFor(PRIVATE)), ['a', 'b'])
  assert.deepEqual(gateway.activatedGroups(sessionFor(GROUP)), [])
})

test('dispatch without a wake in progress, or after endWake, is refused with the one fixed message', async () => {
  const { gateway } = harness()
  const session = sessionFor(PRIVATE)
  const before = await rejection(gateway.dispatch(call(session, 'tools__search', { query: 'x' })))
  gateway.planWake(plan(PRIVATE))
  gateway.endWake(session)
  const after = await rejection(gateway.dispatch(call(session, 'tools__search', { query: 'x' })))
  const garbage = await rejection(gateway.dispatch(call('nonsense', 'tools__search', { query: 'x' })))
  assert.equal(before.message, 'session unavailable')
  assert.equal(after.message, 'session unavailable')
  assert.equal(garbage.message, 'session unavailable')
})

test('a tool outside the surface is refused with a hint to use tools__search and tools__load', async () => {
  const { gateway } = harness()
  gateway.register(fakeTool({ name: 'sticker', load: 'onDemand', group: 'stickers' }))
  gateway.planWake(plan(PRIVATE))
  const error = await rejection(gateway.dispatch(call(sessionFor(PRIVATE), 'p__sticker', { text: 'x' })))
  assert.equal(error.message, '工具 p__sticker 现在不可用。先用 tools__search 查找，再用 tools__load 加载。')
  const ghost = await rejection(gateway.dispatch(call(sessionFor(PRIVATE), 'p__never', {})))
  assert.equal(ghost.message, '工具 p__never 现在不可用。先用 tools__search 查找，再用 tools__load 加载。')
})
