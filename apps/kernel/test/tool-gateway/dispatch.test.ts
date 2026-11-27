import assert from 'node:assert/strict'
import test from 'node:test'
import { LIMITS } from '@dsh-brain-core/sdk'
import { PRIVATE, call, fakeTool, harness, plan, rejection, sessionFor } from './helpers.ts'

function started(h: ReturnType<typeof harness>, overrides: Parameters<typeof plan>[1] = {}): string {
  h.gateway.planWake(plan(PRIVATE, overrides))
  return sessionFor(PRIVATE)
}

test('a plugin tool is called with the arguments as given and the session channel and wake id (FR-G04)', async () => {
  const h = harness()
  const tool = fakeTool({ name: 'echo' })
  h.gateway.register(tool)
  const session = started(h, { wakeId: 'wake-42' })
  await h.gateway.dispatch(call(session, 'p__echo', { text: 'hi', channel: 'qq:group:evil', viewer: { caller: 'owner-console' } }))
  assert.equal(tool.calls.length, 1)
  assert.deepEqual(tool.calls[0]?.call, { channel: PRIVATE, wakeId: 'wake-42' })
  assert.equal(tool.calls[0]?.args.text, 'hi')
})

test('arguments that are not a plain object become an empty object', async () => {
  const h = harness()
  const tool = fakeTool({ name: 'echo' })
  h.gateway.register(tool)
  const session = started(h)
  for (const args of [undefined, null, 'text', 5, ['a'], new Date()]) await h.gateway.dispatch(call(session, 'p__echo', args))
  assert.deepEqual(tool.calls.map((entry) => entry.args), [{}, {}, {}, {}, {}, {}])
})

test('a plugin that throws gives the model its message, and the log has no message or arguments', async () => {
  const h = harness()
  h.gateway.register(fakeTool({ name: 'boom', handler: () => { throw new Error('网络不通：secret-token-123') } }))
  const session = started(h)
  const error = await rejection(h.gateway.dispatch(call(session, 'p__boom', { text: '私密内容' })))
  assert.equal(error.message, '网络不通：secret-token-123')
  const logged = JSON.stringify(h.log.lines)
  assert.ok(h.log.lines.some((line) => line.level === 'warn'))
  assert.ok(!logged.includes('secret-token-123') && !logged.includes('私密内容'))
  assert.equal(await h.gateway.dispatch(call(session, 'tools__search', { query: 'x' })), '没找到相关工具', 'the wake carries on')
})

test('a plugin that rejects with something that is not an Error, or with no message, still gives a message', async () => {
  const h = harness()
  h.gateway.register(fakeTool({ name: 'text', handler: () => Promise.reject('字符串错误') }))
  h.gateway.register(fakeTool({ name: 'blank', handler: () => { throw new Error('') } }))
  h.gateway.register(fakeTool({ name: 'empty', handler: () => Promise.reject('') }))
  const session = started(h)
  assert.equal((await rejection(h.gateway.dispatch(call(session, 'p__text', {})))).message, '字符串错误')
  assert.equal((await rejection(h.gateway.dispatch(call(session, 'p__blank', {})))).message, '工具出错了。')
  assert.equal((await rejection(h.gateway.dispatch(call(session, 'p__empty', {})))).message, '工具出错了。')
})

test('a string output and a text-only object output', async () => {
  const h = harness()
  h.gateway.register(fakeTool({ name: 'str', handler: () => '你好' }))
  h.gateway.register(fakeTool({ name: 'obj', handler: () => ({ text: '图文' }) }))
  const session = started(h)
  assert.equal(await h.gateway.dispatch(call(session, 'p__str', {})), '你好')
  assert.deepEqual(await h.gateway.dispatch(call(session, 'p__obj', {})), { text: '图文' })
})

test('an object output with images becomes a BridgeToolResult', async () => {
  const h = harness()
  const images = [{ mediaType: 'image/png', base64: 'QUJD' }]
  h.gateway.register(fakeTool({ name: 'pic', handler: () => ({ text: '看', images }) }))
  assert.deepEqual(await h.gateway.dispatch(call(started(h), 'p__pic', {})), { text: '看', images })
})

test('text over LIMITS.toolResultChars is cut to exactly that many characters, string or object', async () => {
  const h = harness()
  const long = 'a'.repeat(LIMITS.toolResultChars + 500)
  h.gateway.register(fakeTool({ name: 'str', handler: () => long }))
  h.gateway.register(fakeTool({ name: 'obj', handler: () => ({ text: long }) }))
  h.gateway.register(fakeTool({ name: 'exact', handler: () => 'b'.repeat(LIMITS.toolResultChars) }))
  const session = started(h)
  assert.equal(((await h.gateway.dispatch(call(session, 'p__str', {}))) as string).length, LIMITS.toolResultChars)
  assert.equal(((await h.gateway.dispatch(call(session, 'p__obj', {}))) as { text: string }).text.length, LIMITS.toolResultChars)
  assert.equal(((await h.gateway.dispatch(call(session, 'p__exact', {}))) as string).length, LIMITS.toolResultChars)
})

test('at most LIMITS.toolImages images are accepted', async () => {
  const h = harness()
  const image = { mediaType: 'image/png', base64: 'QUJD' }
  h.gateway.register(fakeTool({ name: 'ok', handler: () => ({ text: 't', images: Array(LIMITS.toolImages).fill(image) as never }) }))
  h.gateway.register(fakeTool({ name: 'many', handler: () => ({ text: 't', images: Array(LIMITS.toolImages + 1).fill(image) as never }) }))
  const session = started(h)
  const accepted = (await h.gateway.dispatch(call(session, 'p__ok', {}))) as { readonly images?: readonly unknown[] }
  assert.equal(accepted.images?.length, LIMITS.toolImages)
  await rejection(h.gateway.dispatch(call(session, 'p__many', {})))
})

test('an image of exactly LIMITS.toolImageBytes passes and one byte more is refused', async () => {
  const h = harness()
  // 3 bytes per 4 base64 characters
  const exact = 'A'.repeat((LIMITS.toolImageBytes / 3) * 4)
  const over = 'A'.repeat((LIMITS.toolImageBytes / 3) * 4 + 4)
  const padded = `${'A'.repeat((LIMITS.toolImageBytes / 3) * 4 - 4)}AA==`
  h.gateway.register(fakeTool({ name: 'exact', handler: () => ({ text: 't', images: [{ mediaType: 'image/png', base64: exact }] }) }))
  h.gateway.register(fakeTool({ name: 'over', handler: () => ({ text: 't', images: [{ mediaType: 'image/png', base64: over }] }) }))
  h.gateway.register(fakeTool({ name: 'padded', handler: () => ({ text: 't', images: [{ mediaType: 'image/png', base64: padded }] }) }))
  const session = started(h)
  await h.gateway.dispatch(call(session, 'p__exact', {}))
  await h.gateway.dispatch(call(session, 'p__padded', {}))
  await rejection(h.gateway.dispatch(call(session, 'p__over', {})))
})

test('an output of the wrong shape is refused instead of passed on', async () => {
  const h = harness()
  const outputs: unknown[] = [undefined, null, 5, ['a'], {}, { text: 5 }, { text: 't', images: 'x' }, { text: 't', images: [{ mediaType: 'image/png' }] }, { text: 't', images: [null] }]
  outputs.forEach((output, index) => h.gateway.register(fakeTool({ name: `bad${index}`, handler: () => output as never })))
  const session = started(h)
  for (let index = 0; index < outputs.length; index += 1) await rejection(h.gateway.dispatch(call(session, `p__bad${index}`, {})))
})

test('a plugin that fails after sending is audited as a failure and the wake carries on', async () => {
  const h = harness()
  h.gateway.register(fakeTool({ name: 'say', effect: 'send', handler: () => ({ text: 't', images: 'bad' as never }) }))
  const session = started(h)
  await rejection(h.gateway.dispatch(call(session, 'p__say', {})))
  assert.deepEqual(h.audit.entries.map((entry) => entry.ok), [true], 'the plugin call itself succeeded, only its output was refused')
})

test('only the six built-ins and registered tools can ever be called (T5)', async () => {
  const h = harness()
  const session = started(h)
  for (const name of ['p__ghost', 'shell', 'memory__ingest', '', 'tools__search\u0000']) {
    const error = await rejection(h.gateway.dispatch(call(session, name, {})))
    assert.match(error.message, /tools__search/)
  }
})

test('two sessions never share a surface, a wake or an activated group', async () => {
  const h = harness()
  h.gateway.register(fakeTool({ name: 'sticker', load: 'onDemand', group: 'stickers', keywords: ['表情'] }))
  const a = sessionFor('qq:private:a')
  const b = sessionFor('qq:private:b')
  h.gateway.planWake(plan('qq:private:a', { sessionId: a, wakeId: 'wa', participants: ['a'] }))
  h.gateway.planWake(plan('qq:private:b', { sessionId: b, wakeId: 'wb', participants: ['b'] }))
  await h.gateway.dispatch(call(a, 'tools__load', { group: 'stickers' }))
  assert.ok(h.gateway.surfaceOf(a).has('p__sticker'))
  assert.ok(!h.gateway.surfaceOf(b).has('p__sticker'))
  assert.deepEqual(h.gateway.activatedGroups(b), [])
  h.gateway.endWake(a)
  await rejection(h.gateway.dispatch(call(a, 'tools__search', { query: 'x' })))
  assert.equal(await h.gateway.dispatch(call(b, 'tools__search', { query: 'zzz' })), '没找到相关工具')
})

test('a new wake in the same session replaces the old wake record', async () => {
  const h = harness({ style: { openers: ['套话'] } })
  h.gateway.register(fakeTool({ name: 'say', effect: 'send', textArg: 'text' }))
  const session = started(h, { wakeId: 'w1' })
  h.gateway.checkOutbound(PRIVATE, '套话', 'w1')
  h.gateway.planWake(plan(PRIVATE, { wakeId: 'w2' }))
  assert.equal(h.gateway.checkOutbound(PRIVATE, '这是一句完全正常的话', 'w1'), null, 'the old wake id is gone')
  assert.equal(await h.gateway.dispatch(call(session, 'p__say', { text: '这是一句完全正常的话' })), 'ok')
})

test('coreBudget counts the built-in core tools alone as 3 and not over', () => {
  const { gateway } = harness()
  const budget = gateway.coreBudget('qq:private')
  assert.equal(budget.count, 3)
  assert.ok(budget.tokens > 0 && budget.tokens < 2000)
  assert.equal(budget.over, false)
})

test('coreBudget goes over at 9 core tools but not at 8', () => {
  const { gateway } = harness()
  for (let index = 0; index < 5; index += 1) gateway.register(fakeTool({ name: `c${index}`, load: 'core' }))
  assert.deepEqual([gateway.coreBudget('qq:private').count, gateway.coreBudget('qq:private').over], [8, false])
  gateway.register(fakeTool({ name: 'c5', load: 'core' }))
  assert.deepEqual([gateway.coreBudget('qq:private').count, gateway.coreBudget('qq:private').over], [9, true])
})

test('coreBudget counts only core tools whose channels fit the pattern', () => {
  const { gateway } = harness()
  gateway.register(fakeTool({ name: 'g', load: 'core', channels: ['qq:group'] }))
  gateway.register(fakeTool({ name: 'p', load: 'core', channels: ['qq:private'] }))
  gateway.register(fakeTool({ name: 'any', load: 'core', channels: ['qq:*'] }))
  gateway.register(fakeTool({ name: 'ctx', load: 'context', group: 'x', when: 'event.poke', channels: ['qq:*'] }))
  gateway.register(fakeTool({ name: 'od', load: 'onDemand', group: 'y', channels: ['qq:*'] }))
  assert.equal(gateway.coreBudget('qq:group').count, 3 + 2)
  assert.equal(gateway.coreBudget('qq:private').count, 3 + 2)
  assert.equal(gateway.coreBudget('tg:group').count, 3)
  assert.equal(gateway.coreBudget('*:*').count, 3 + 3)
  assert.throws(() => gateway.coreBudget('qq'), RangeError)
})

test('coreBudget tokens add ceil(UTF-8 bytes / 3) of name, description and parameters per tool, and go over at 2000', () => {
  const { gateway } = harness()
  const before = gateway.coreBudget('qq:private').tokens
  const parameters = { type: 'object' as const, properties: { text: { type: 'string' } }, required: ['text'] }
  const dsh = '{"text":{"type":"string","required":true}}'
  const description = '长'.repeat(100)
  gateway.register(fakeTool({ name: 'big', load: 'core', description, parameters }))
  const bytes = Buffer.byteLength('p__big') + Buffer.byteLength(description) + Buffer.byteLength(dsh)
  assert.equal(gateway.coreBudget('qq:private').tokens - before, Math.ceil(bytes / 3))
  const heavy = harness()
  heavy.gateway.register(fakeTool({ name: 'heavy', load: 'core', description: '长'.repeat(2000) }))
  const budget = heavy.gateway.coreBudget('qq:private')
  assert.equal(budget.count, 4)
  assert.ok(budget.tokens > 2000)
  assert.equal(budget.over, true)
})

test('PERF: dispatch adds little time: p95 of 1000 calls to an instant tool stays under 10 ms (NFR-01)', async () => {
  const h = harness()
  h.gateway.register(fakeTool({ name: 'instant' }))
  for (let index = 0; index < 50; index += 1) h.gateway.register(fakeTool({ pluginId: `x${index}`, name: 'other' }))
  const session = started(h)
  const samples: number[] = []
  for (let index = 0; index < 1000; index += 1) {
    const start = performance.now()
    await h.gateway.dispatch(call(session, 'p__instant', { text: 'hi' }))
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  const p95 = samples[Math.floor(samples.length * 0.95) - 1] as number
  console.log(`tool-gateway dispatch p95 ${p95.toFixed(3)} ms over ${samples.length} calls`)
  assert.ok(p95 <= 10, `p95 ${p95} ms`)
})

// Review round 1 (PR #28)

test('a cut that would land inside an emoji drops the whole emoji instead of leaving half of it', async () => {
  const h = harness()
  // The LIMITS.toolResultChars-th UTF-16 unit is the first half of the emoji.
  const split = `${'a'.repeat(LIMITS.toolResultChars - 1)}😀${'b'.repeat(10)}`
  assert.equal(split.charCodeAt(LIMITS.toolResultChars - 1) >= 0xd800 && split.charCodeAt(LIMITS.toolResultChars - 1) <= 0xdbff, true)
  // The emoji ends exactly at the limit, so nothing is cut inside it.
  const fits = `${'a'.repeat(LIMITS.toolResultChars - 2)}😀${'b'.repeat(10)}`
  h.gateway.register(fakeTool({ name: 'split', handler: () => split }))
  h.gateway.register(fakeTool({ name: 'splitobj', handler: () => ({ text: split }) }))
  h.gateway.register(fakeTool({ name: 'fits', handler: () => fits }))
  const session = started(h)
  const cut = (await h.gateway.dispatch(call(session, 'p__split', {}))) as string
  assert.equal(cut.length, LIMITS.toolResultChars - 1)
  assert.equal(cut, 'a'.repeat(LIMITS.toolResultChars - 1))
  assert.equal(cut.isWellFormed(), true)
  const cutObject = (await h.gateway.dispatch(call(session, 'p__splitobj', {}))) as { text: string }
  assert.equal(cutObject.text, 'a'.repeat(LIMITS.toolResultChars - 1))
  const whole = (await h.gateway.dispatch(call(session, 'p__fits', {}))) as string
  assert.equal(whole.length, LIMITS.toolResultChars)
  assert.equal(whole.endsWith('😀'), true)
  assert.equal(whole.isWellFormed(), true)
})

function coreTokens(description: string): { readonly tokens: number; readonly over: boolean; readonly count: number } {
  const h = harness()
  h.gateway.register(fakeTool({ name: 'sized', load: 'core', description }))
  return h.gateway.coreBudget('qq:private')
}

test('coreBudget is over only above 2000 tokens: exactly 2000 is not over, 2001 is', () => {
  // ASCII text, so each added character is one more byte; the token count moves up one step every third byte.
  let atLimit: ReturnType<typeof coreTokens> | undefined
  let above: ReturnType<typeof coreTokens> | undefined
  for (let size = 0; size < 8000 && above === undefined; size += 1) {
    const budget = coreTokens('a'.repeat(size))
    if (budget.tokens === 2000) atLimit = budget
    if (budget.tokens === 2001) above = budget
  }
  assert.ok(atLimit !== undefined && above !== undefined, 'found descriptions that land on 2000 and on 2001')
  assert.equal(atLimit.count, 4, 'the count is far below its own limit, so only tokens decide')
  assert.deepEqual([atLimit.tokens, atLimit.over], [2000, false])
  assert.deepEqual([above.tokens, above.over], [2001, true])
})
