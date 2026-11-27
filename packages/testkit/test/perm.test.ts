import assert from 'node:assert/strict'
import test from 'node:test'
import { BrainError, type BrainContext } from '@dsh-brain-core/sdk'
import { codeOf, loadIdle, MANIFEST, OWN, recordInput } from './helpers.ts'

const provider = {
  send: async (): Promise<{ readonly messageId?: string }> => ({ messageId: 'msg_1' }),
  members: async (): Promise<readonly string[]> => [],
  resolveIdentity: async (): Promise<null> => null,
}

const tool = {
  name: 'look',
  description: 'Look around',
  parameters: { type: 'object' as const },
  handler: async (): Promise<string> => 'ok',
}

/** Every ctx method the spec marks with a permission, with arguments that would otherwise succeed. */
const TABLE: readonly { readonly name: string; readonly permission: string; readonly call: (ctx: BrainContext) => unknown }[] = [
  { name: 'memory.ingest', permission: 'memory.ingest', call: (ctx) => ctx.memory.ingest({} as never) },
  { name: 'memory.record', permission: 'memory.record', call: (ctx) => ctx.memory.record({} as never) },
  { name: 'memory.update', permission: 'memory.record', call: (ctx) => ctx.memory.update('r', {}, 1) },
  { name: 'memory.remove', permission: 'memory.record', call: (ctx) => ctx.memory.remove('r') },
  { name: 'memory.search', permission: 'memory.search', call: (ctx) => ctx.memory.search({} as never) },
  { name: 'memory.context', permission: 'memory.context', call: (ctx) => ctx.memory.context({} as never) },
  { name: 'memory.forget', permission: 'memory.forget', call: (ctx) => ctx.memory.forget({ by: 'record', id: 'r' }) },
  { name: 'agent.session', permission: 'agent.session', call: (ctx) => ctx.agent.session(OWN) },
  { name: 'agent.wake', permission: 'agent.session', call: (ctx) => ctx.agent.wake(OWN, { reason: 'm' }) },
  { name: 'tools.register', permission: 'tools.register', call: (ctx) => ctx.tools.register(tool) },
  { name: 'channel.provide', permission: 'channel.provide', call: (ctx) => ctx.channel.provide(provider) },
  { name: 'channel.send', permission: 'channel.send', call: (ctx) => ctx.channel.send(OWN, { text: 'hi' }) },
  { name: 'identity.resolve', permission: 'identity.link', call: (ctx) => ctx.identity.resolve('demo:1') },
  { name: 'identity.link', permission: 'identity.link', call: (ctx) => ctx.identity.link('demo:1', 'p1') },
  { name: 'scheduler.ownTime', permission: 'schedule.ownTime', call: (ctx) => ctx.scheduler.ownTime({ name: 'n', everyMs: 60_000, run: () => undefined }) },
  { name: 'secrets.get', permission: 'secrets:token', call: (ctx) => ctx.secrets.get('token') },
  { name: 'llm.complete', permission: 'llm.invoke', call: (ctx) => ctx.llm.complete({ system: 's', user: 'u', maxOutputTokens: 1 }) },
  { name: 'http.fetch', permission: 'network:api.example.com', call: (ctx) => ctx.http.fetch('https://api.example.com/x') },
]

for (const row of TABLE) {
  test(`${row.name} needs ${row.permission}`, async () => {
    const { ctx } = await loadIdle({ load: { granted: [] } })
    const code = await codeOf(() => row.call(ctx))
    assert.equal(code, 'PERMISSION_DENIED', `${row.name} returned ${code}`)
  })
}

test('a manifest permission that was not granted does not count', async () => {
  const granted = MANIFEST.permissions.filter((permission) => permission !== 'memory.search')
  const { ctx } = await loadIdle({ load: { granted } })
  assert.equal(await codeOf(() => ctx.memory.search({ query: 'x', scope: 'all' })), 'PERMISSION_DENIED')
})

test('granting the permission makes every table entry reach its own rules', async () => {
  const { kernel, ctx } = await loadIdle()
  const ingest = await ctx.memory.ingest({
    kind: 'demo.message', channel: OWN, subjects: [], actor: 'p1', content: {}, tEvent: 0, idempotencyKey: 'granted',
  })
  assert.match(ingest.id, /^l0_/)
  assert.equal(await ctx.identity.resolve('demo:42'), 'demo:42')
  await ctx.identity.link('demo:42', 'p42')
  assert.equal(await ctx.identity.resolve('demo:42'), 'p42')
  ctx.channel.provide(provider)
  assert.deepEqual(await ctx.channel.send(OWN, { text: 'hi' }), { messageId: 'msg_1' })
  ctx.tools.register(tool)
  assert.deepEqual(kernel.tools(), ['demo__look'])
  ctx.scheduler.ownTime({ name: 'n', everyMs: 60_000, run: () => undefined })
  assert.equal(kernel.timers(), 1)
  kernel.setSecret('token', 'abc')
  assert.equal(await ctx.secrets.get('token'), 'abc')
  assert.equal(await codeOf(() => ctx.llm.complete({ system: 's', user: 'u', maxOutputTokens: 1 })), 'UNAVAILABLE')
  kernel.setResponse('https://api.example.com/x', { status: 200, body: 'ok' })
  assert.equal((await ctx.http.fetch('https://api.example.com/x')).text(), 'ok')
})

interface Rejection { readonly code: string; readonly message: string }

async function rejectionOf(work: () => Promise<unknown> | unknown): Promise<Rejection | undefined> {
  try {
    await work()
    return undefined
  } catch (error) {
    if (error instanceof BrainError) return { code: error.code, message: error.message }
    return { code: error instanceof Error ? error.name : 'unknown', message: error instanceof Error ? error.message : String(error) }
  }
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The same permission table, but every call is otherwise valid and uses one of the plugin's own
 * channels. A table row that is refused by an ownership check instead of the permission check
 * fails here, because the message has to name the permission.
 */
const OWN_TABLE: readonly { readonly name: string; readonly permission: string; readonly call: (ctx: BrainContext) => unknown }[] = [
  {
    name: 'memory.ingest',
    permission: 'memory.ingest',
    call: (ctx) => ctx.memory.ingest({
      kind: 'demo.message', channel: OWN, subjects: [], actor: 'p1', content: {}, tEvent: 0, idempotencyKey: 'perm',
    }),
  },
  { name: 'memory.record', permission: 'memory.record', call: (ctx) => ctx.memory.record(recordInput('l0_missing') as never) },
  { name: 'memory.update', permission: 'memory.record', call: (ctx) => ctx.memory.update('r', {}, 1, { channel: OWN }) },
  { name: 'memory.remove', permission: 'memory.record', call: (ctx) => ctx.memory.remove('r', { channel: OWN }) },
  { name: 'memory.search', permission: 'memory.search', call: (ctx) => ctx.memory.search({ query: 'x', scope: 'all', limit: 1 }) },
  { name: 'memory.context', permission: 'memory.context', call: (ctx) => ctx.memory.context({ channel: OWN }) },
  { name: 'memory.forget', permission: 'memory.forget', call: (ctx) => ctx.memory.forget({ by: 'record', id: 'r' }) },
  { name: 'agent.session', permission: 'agent.session', call: (ctx) => ctx.agent.session(OWN) },
  { name: 'agent.wake', permission: 'agent.session', call: (ctx) => ctx.agent.wake(OWN, { reason: 'm' }) },
  { name: 'tools.register', permission: 'tools.register', call: (ctx) => ctx.tools.register(tool) },
  { name: 'channel.provide', permission: 'channel.provide', call: (ctx) => ctx.channel.provide(provider) },
  { name: 'channel.send', permission: 'channel.send', call: (ctx) => ctx.channel.send(OWN, { text: 'hi' }) },
  { name: 'identity.resolve', permission: 'identity.link', call: (ctx) => ctx.identity.resolve('demo:1') },
  { name: 'identity.link', permission: 'identity.link', call: (ctx) => ctx.identity.link('demo:1', 'p1') },
  { name: 'scheduler.ownTime', permission: 'schedule.ownTime', call: (ctx) => ctx.scheduler.ownTime({ name: 'n', everyMs: 60_000, run: () => undefined }) },
  { name: 'secrets.get', permission: 'secrets:token', call: (ctx) => ctx.secrets.get('token') },
  { name: 'llm.complete', permission: 'llm.invoke', call: (ctx) => ctx.llm.complete({ system: 's', user: 'u', maxOutputTokens: 1 }) },
  { name: 'http.fetch', permission: 'network:api.example.com', call: (ctx) => ctx.http.fetch('https://api.example.com/x') },
]

for (const row of OWN_TABLE) {
  test(`${row.name} names the missing ${row.permission}`, async () => {
    const { ctx } = await loadIdle({ load: { granted: [] } })
    const rejection = await rejectionOf(() => row.call(ctx))
    assert.ok(rejection !== undefined, `${row.name} did not throw`)
    assert.equal(rejection.code, 'PERMISSION_DENIED', `${row.name} returned ${rejection.code}`)
    if (row.permission.startsWith('network:')) {
      // http.fetch filters by host instead of naming the permission; it must still be a host refusal.
      assert.match(rejection.message, /network access/, `${row.name}: ${rejection.message}`)
    } else {
      assert.match(rejection.message, new RegExp(escapeForRegExp(row.permission)), `${row.name}: ${rejection.message}`)
    }
  })
}
