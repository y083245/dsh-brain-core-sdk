import assert from 'node:assert/strict'
import test from 'node:test'
import { BrainError } from '@brain-core/sdk'
import { extractOutboundTexts } from '../../src/tool-gateway/index.ts'
import { GROUP, PRIVATE, call, fakeTool, harness, plan, rejection, sessionFor } from './helpers.ts'
import { dice } from '../../src/tool-gateway/similarity.ts'

const LONG = '今天天气真的很不错我们出去走走吧'

test('openers: text starting with a listed opener is refused with the opener quoted', () => {
  const { gateway } = harness({ style: { openers: ['作为一个AI', '当然可以'] } })
  assert.equal(gateway.checkOutbound(PRIVATE, '作为一个AI我觉得'), '没发出去：开头「作为一个AI」是套话，直接说具体的事，改一次再发。')
  assert.equal(gateway.checkOutbound(PRIVATE, '   \n当然可以，没问题'), '没发出去：开头「当然可以」是套话，直接说具体的事，改一次再发。')
  assert.equal(gateway.checkOutbound(PRIVATE, '我觉得当然可以'), null)
})

test('openers apply to short text too, and an empty opener is ignored', () => {
  const { gateway } = harness({ style: { openers: ['', '嗯'] } })
  assert.match(gateway.checkOutbound(PRIVATE, '嗯嗯') ?? '', /开头「嗯」是套话/)
  assert.equal(gateway.checkOutbound(PRIVATE, '好'), null)
})

test('the built-in opener list is not in the gateway: only what style() returns counts', () => {
  const { gateway } = harness({ style: { openers: [] } })
  assert.equal(gateway.checkOutbound(PRIVATE, '作为一个AI我觉得这样很好呀'), null)
})

test('similar to something she recently said (Dice >= 0.65) is refused; a different text is not', () => {
  const { gateway } = harness()
  gateway.noteOutbound(PRIVATE, LONG)
  assert.equal(gateway.checkOutbound(PRIVATE, LONG), '没发出去：和你最近说的太像了，换个说法，改一次再发。')
  assert.equal(gateway.checkOutbound(PRIVATE, `${LONG}！！`), '没发出去：和你最近说的太像了，换个说法，改一次再发。')
  assert.equal(gateway.checkOutbound(PRIVATE, '明天我想去吃那家新开的火锅店你去不去'), null)
})

test('recent-self is per channel', () => {
  const { gateway } = harness()
  gateway.noteOutbound(PRIVATE, LONG)
  assert.equal(gateway.checkOutbound(GROUP, LONG), null)
})

test('text with fewer than 8 characters after stripping punctuation is not compared, 8 is', () => {
  const { gateway } = harness()
  gateway.noteOutbound(PRIVATE, '嗯嗯，好的呀。')
  assert.equal(gateway.checkOutbound(PRIVATE, '嗯嗯，好的呀。'), null)
  gateway.noteOutbound(PRIVATE, '一二三四五六七八')
  assert.ok(gateway.checkOutbound(PRIVATE, '一二三四五六七八') !== null)
  // seven characters once the commas are gone, and close to the eight remembered above
  assert.equal(gateway.checkOutbound(PRIVATE, '一二，三四，五六，七'), null)
})

test('the self-similarity threshold is 0.65: 0.7 is refused, and 0.6 is not', () => {
  const { gateway } = harness()
  // ten bigrams on each side; seven shared gives 0.7, six shared gives 0.6
  gateway.noteOutbound(PRIVATE, 'abcdefghijk')
  assert.ok(gateway.checkOutbound(PRIVATE, 'abcdefghxyz') !== null)
  assert.equal(gateway.checkOutbound(PRIVATE, 'abcdefgxyzw'), null)
})

test('clashing with what others just said (>= 0.8 against peerTexts) is refused, below it is allowed', () => {
  const { gateway } = harness()
  gateway.planWake(plan(PRIVATE, { wakeId: 'w1', peerTexts: ['今天晚上我们一起去看电影怎么样呀'] }))
  assert.equal(gateway.checkOutbound(PRIVATE, '今天晚上我们一起去看电影怎么样呀', 'w1'), '没发出去：和别人刚说的撞车了，换个角度，或者这轮不说。')
  assert.equal(gateway.checkOutbound(PRIVATE, '周末想去爬山你有没有空陪我一起', 'w1'), null)
  assert.equal(gateway.checkOutbound(PRIVATE, '今天晚上我们一起去看电影怎么样呀'), null, 'without a wake id there is no peer text to compare')
  assert.equal(gateway.checkOutbound(PRIVATE, '今天晚上我们一起去看电影怎么样呀', 'unknown-wake'), null)
})

test('the peer-text threshold is 0.8, not 0.65', () => {
  const { gateway } = harness()
  // ten bigrams on each side and seven shared: Dice 0.7, past the 0.65 self line but short of 0.8
  gateway.planWake(plan(PRIVATE, { wakeId: 'w1', peerTexts: ['abcdefghijk'] }))
  assert.equal(gateway.checkOutbound(PRIVATE, 'abcdefghxyz', 'w1'), null)
})

test('when style is disabled nothing is checked, not even the block limit', () => {
  const { gateway, style } = harness()
  style.enabled = false
  gateway.noteOutbound(PRIVATE, LONG)
  assert.equal(gateway.checkOutbound(PRIVATE, LONG), null)
  assert.equal(gateway.checkOutbound(PRIVATE, '作为一个AI'), null)
})

test('recentSent returns the newest last, capped at 20 per channel, and honours the limit', () => {
  const { gateway } = harness()
  for (let index = 0; index < 25; index += 1) gateway.noteOutbound(PRIVATE, `第${index}句话`)
  const all = gateway.recentSent(PRIVATE, 100)
  assert.equal(all.length, 20)
  assert.equal(all[0], '第5句话')
  assert.equal(all.at(-1), '第24句话')
  assert.deepEqual(gateway.recentSent(PRIVATE, 2), ['第23句话', '第24句话'])
  assert.deepEqual(gateway.recentSent(PRIVATE, 0), [])
  assert.deepEqual(gateway.recentSent(GROUP, 5), [])
})

test('forgetSent clears just the named channels', () => {
  const { gateway } = harness()
  gateway.noteOutbound(PRIVATE, 'a')
  gateway.noteOutbound(GROUP, 'b')
  gateway.forgetSent([PRIVATE, 'qq:private:nobody'])
  assert.deepEqual(gateway.recentSent(PRIVATE, 5), [])
  assert.deepEqual(gateway.recentSent(GROUP, 5), ['b'])
})

test('admitSend allows 20 a minute by default, then refuses until a minute passes', () => {
  const { gateway, clock } = harness()
  for (let index = 0; index < 20; index += 1) assert.equal(gateway.admitSend('p', PRIVATE), true)
  assert.equal(gateway.admitSend('p', PRIVATE), false)
  assert.equal(gateway.admitSend('q', PRIVATE), true, 'another plugin has its own allowance')
  assert.equal(gateway.admitSend('p', GROUP), true, 'another channel has its own allowance')
  clock.advance(59_999)
  assert.equal(gateway.admitSend('p', PRIVATE), false)
  clock.advance(1)
  assert.equal(gateway.admitSend('p', PRIVATE), true)
})

test('the window slides: sends spread over time free up one at a time', () => {
  const { gateway, clock } = harness({ sendPerMinute: 2 })
  assert.equal(gateway.admitSend('p', PRIVATE), true)
  clock.advance(30_000)
  assert.equal(gateway.admitSend('p', PRIVATE), true)
  assert.equal(gateway.admitSend('p', PRIVATE), false)
  clock.advance(30_000)
  assert.equal(gateway.admitSend('p', PRIVATE), true)
  assert.equal(gateway.admitSend('p', PRIVATE), false)
})

test('a refused admitSend is not counted, and a manifest limit can only lower the kernel limit', () => {
  const { gateway, clock } = harness({ sendPerMinute: 3 })
  assert.equal(gateway.admitSend('p', PRIVATE, 1), true)
  assert.equal(gateway.admitSend('p', PRIVATE, 1), false)
  assert.equal(gateway.admitSend('x', PRIVATE, 100), true)
  assert.equal(gateway.admitSend('x', PRIVATE, 100), true)
  assert.equal(gateway.admitSend('x', PRIVATE, 100), true)
  assert.equal(gateway.admitSend('x', PRIVATE, 100), false, 'the kernel limit of 3 wins over 100')
  clock.advance(60_000)
  assert.equal(gateway.admitSend('p', PRIVATE, 1), true)
})

test('after two blocks in one wake, every further send in that wake is refused outright', () => {
  const { gateway } = harness({ style: { openers: ['套话'] } })
  gateway.planWake(plan(PRIVATE, { wakeId: 'w1' }))
  assert.match(gateway.checkOutbound(PRIVATE, '套话一', 'w1') ?? '', /套话/)
  assert.match(gateway.checkOutbound(PRIVATE, '套话二', 'w1') ?? '', /套话/)
  assert.equal(gateway.checkOutbound(PRIVATE, '这是一句完全正常的话', 'w1'), '这一轮不再发了。')
  gateway.endWake(sessionFor(PRIVATE))
  gateway.planWake(plan(PRIVATE, { wakeId: 'w2' }))
  assert.equal(gateway.checkOutbound(PRIVATE, '这是一句完全正常的话', 'w2'), null)
})

test('a send tool with textArg is refused before the plugin runs, and the refusal counts as a block', async () => {
  const { gateway, audit } = harness({ style: { openers: ['套话'] } })
  const tool = fakeTool({ name: 'say', effect: 'send', textArg: 'text' })
  gateway.register(tool)
  gateway.planWake(plan(PRIVATE, { wakeId: 'w1' }))
  const result = await gateway.dispatch(call(sessionFor(PRIVATE), 'p__say', { text: '套话开头' }))
  assert.equal(result, '没发出去：开头「套话」是套话，直接说具体的事，改一次再发。')
  assert.equal(tool.calls.length, 0)
  assert.equal(audit.entries.length, 0, 'a refused text is not a send')
  await gateway.dispatch(call(sessionFor(PRIVATE), 'p__say', { text: '套话二' }))
  assert.equal(await gateway.dispatch(call(sessionFor(PRIVATE), 'p__say', { text: '这是一句完全正常的话' })), '这一轮不再发了。')
  assert.equal(tool.calls.length, 0)
  assert.deepEqual(gateway.endWake(sessionFor(PRIVATE)), { sent: 0 })
})

test('a send tool that declares no textArg skips the style check, and a non-string argument skips it too', async () => {
  const { gateway } = harness({ style: { openers: ['套话'] } })
  const plain = fakeTool({ name: 'poke', effect: 'send' })
  const typed = fakeTool({ name: 'say', effect: 'send', textArg: 'text' })
  gateway.register(plain)
  gateway.register(typed)
  gateway.planWake(plan(PRIVATE))
  assert.equal(await gateway.dispatch(call(sessionFor(PRIVATE), 'p__poke', { text: '套话' })), 'ok')
  assert.equal(await gateway.dispatch(call(sessionFor(PRIVATE), 'p__say', { text: 42 })), 'ok')
  assert.equal(plain.calls.length + typed.calls.length, 2)
})

test('a send past the rate limit throws RATE_LIMITED and the plugin is not called', async () => {
  const { gateway, clock, audit } = harness({ sendPerMinute: 2 })
  const tool = fakeTool({ name: 'say', effect: 'send' })
  gateway.register(tool)
  gateway.planWake(plan(PRIVATE))
  const session = sessionFor(PRIVATE)
  await gateway.dispatch(call(session, 'p__say', {}))
  await gateway.dispatch(call(session, 'p__say', {}))
  const error = await rejection(gateway.dispatch(call(session, 'p__say', {})))
  assert.ok(error instanceof BrainError && error.code === 'RATE_LIMITED')
  assert.ok(error.message.length > 0)
  assert.equal(tool.calls.length, 2)
  assert.equal(audit.entries.length, 2, 'a call that never reached the plugin is not audited as a send')
  clock.advance(60_000)
  assert.equal(await gateway.dispatch(call(session, 'p__say', {})), 'ok')
})

test('the manifest sendPerMinute lowers the limit for that tool only', async () => {
  const { gateway } = harness()
  gateway.register(fakeTool({ name: 'slow', effect: 'send', sendPerMinute: 1 }))
  gateway.planWake(plan(PRIVATE))
  const session = sessionFor(PRIVATE)
  await gateway.dispatch(call(session, 'p__slow', {}))
  const error = await rejection(gateway.dispatch(call(session, 'p__slow', {})))
  assert.ok(error instanceof BrainError && error.code === 'RATE_LIMITED')
})

test('the allowance is shared by all send tools of one plugin on one channel', async () => {
  const { gateway } = harness({ sendPerMinute: 2 })
  gateway.register(fakeTool({ name: 'a', effect: 'send' }))
  gateway.register(fakeTool({ name: 'b', effect: 'send' }))
  gateway.planWake(plan(PRIVATE))
  const session = sessionFor(PRIVATE)
  await gateway.dispatch(call(session, 'p__a', {}))
  await gateway.dispatch(call(session, 'p__b', {}))
  await assert.rejects(gateway.dispatch(call(session, 'p__a', {})), (error: unknown) => error instanceof BrainError && error.code === 'RATE_LIMITED')
})

test('a silent wake refuses send tools but still runs read and write tools', async () => {
  const { gateway } = harness()
  const send = fakeTool({ name: 'say', effect: 'send' })
  const read = fakeTool({ name: 'look', effect: 'read' })
  const write = fakeTool({ name: 'note', effect: 'write' })
  for (const tool of [send, read, write]) gateway.register(tool)
  gateway.planWake(plan(PRIVATE, { silent: true }))
  const session = sessionFor(PRIVATE)
  const error = await rejection(gateway.dispatch(call(session, 'p__say', {})))
  assert.equal(error.message, '这一轮不能发消息。')
  assert.equal(send.calls.length, 0)
  assert.equal(await gateway.dispatch(call(session, 'p__look', {})), 'ok')
  assert.equal(await gateway.dispatch(call(session, 'p__note', {})), 'ok')
})

test('a send is audited on success and on failure, without any content, and counted only on success', async () => {
  const { gateway, audit, clock } = harness()
  let fail = false
  gateway.register(fakeTool({
    name: 'say',
    effect: 'send',
    textArg: 'text',
    handler: () => { if (fail) throw new Error('boom'); return 'sent' },
  }))
  gateway.planWake(plan(PRIVATE))
  const session = sessionFor(PRIVATE)
  clock.advance(1234)
  await gateway.dispatch(call(session, 'p__say', { text: '这是一句完全正常的话' }))
  fail = true
  await assert.rejects(gateway.dispatch(call(session, 'p__say', { text: '另一句完全不同的话语' })), /boom/)
  assert.deepEqual(audit.entries, [
    { tool: 'p__say', pluginId: 'p', channel: PRIVATE, ok: true, tAt: clock.now() },
    { tool: 'p__say', pluginId: 'p', channel: PRIVATE, ok: false, tAt: clock.now() },
  ])
  assert.ok(!JSON.stringify(audit.entries).includes('完全正常'))
  assert.deepEqual(gateway.endWake(session), { sent: 1, firstSendAt: clock.now() })
})

test('only the first successful send sets firstSendAt, and a successful textArg send is remembered for the next check', async () => {
  const { gateway, clock } = harness()
  gateway.register(fakeTool({ name: 'say', effect: 'send', textArg: 'text' }))
  gateway.planWake(plan(PRIVATE))
  const session = sessionFor(PRIVATE)
  const start = clock.now()
  await gateway.dispatch(call(session, 'p__say', { text: LONG }))
  clock.advance(5000)
  await gateway.dispatch(call(session, 'p__say', { text: '这是一句完全不同的话语真的哦' }))
  assert.deepEqual(gateway.recentSent(PRIVATE, 10), [LONG, '这是一句完全不同的话语真的哦'])
  assert.deepEqual(gateway.endWake(session), { sent: 2, firstSendAt: start })
})

test('a send without textArg is audited and counted but not remembered', async () => {
  const { gateway } = harness()
  gateway.register(fakeTool({ name: 'poke', effect: 'send' }))
  gateway.planWake(plan(PRIVATE))
  await gateway.dispatch(call(sessionFor(PRIVATE), 'p__poke', { text: '拍一拍' }))
  assert.deepEqual(gateway.recentSent(PRIVATE, 10), [])
  assert.equal(gateway.endWake(sessionFor(PRIVATE)).sent, 1)
})

test('a failed send is not remembered', async () => {
  const { gateway } = harness()
  gateway.register(fakeTool({ name: 'say', effect: 'send', textArg: 'text', handler: () => { throw new Error('down') } }))
  gateway.planWake(plan(PRIVATE))
  await assert.rejects(gateway.dispatch(call(sessionFor(PRIVATE), 'p__say', { text: LONG })))
  assert.deepEqual(gateway.recentSent(PRIVATE, 10), [])
})

test('endWake returns zero sends for a wake with none, for an unknown session, and clears the record', async () => {
  const { gateway } = harness()
  gateway.planWake(plan(PRIVATE))
  assert.deepEqual(gateway.endWake(sessionFor(PRIVATE)), { sent: 0 })
  assert.deepEqual(gateway.endWake(sessionFor(PRIVATE)), { sent: 0 })
  assert.deepEqual(gateway.endWake(sessionFor(GROUP)), { sent: 0 })
  await rejection(gateway.dispatch(call(sessionFor(PRIVATE), 'tools__search', { query: 'x' })))
})

test('an audit failure does not fail the send and is logged without content', async () => {
  const h = harness()
  h.audit.sent = async () => { throw new Error('disk full') }
  h.gateway.register(fakeTool({ name: 'say', effect: 'send', textArg: 'text' }))
  h.gateway.planWake(plan(PRIVATE))
  assert.equal(await h.gateway.dispatch(call(sessionFor(PRIVATE), 'p__say', { text: LONG })), 'ok')
  assert.ok(h.log.lines.some((line) => line.level === 'warn'))
  assert.ok(!JSON.stringify(h.log.lines).includes(LONG))
  assert.ok(!JSON.stringify(h.log.lines).includes('disk full'))
})

// Review round 1 (PR #28)

test('a wake record is released by endWake: its peer texts stop applying', () => {
  const { gateway } = harness()
  const peer = '今天晚上我们一起去看电影怎么样呀'
  gateway.planWake(plan(PRIVATE, { wakeId: 'w1', peerTexts: [peer] }))
  assert.equal(gateway.checkOutbound(PRIVATE, peer, 'w1'), '没发出去：和别人刚说的撞车了，换个角度，或者这轮不说。')
  gateway.endWake(sessionFor(PRIVATE))
  assert.equal(gateway.checkOutbound(PRIVATE, peer, 'w1'), null)
})

test('a wake record is released when the same session plans again without endWake: the old wake id stops applying', () => {
  const { gateway } = harness()
  const peer = '今天晚上我们一起去看电影怎么样呀'
  gateway.planWake(plan(PRIVATE, { wakeId: 'w1', peerTexts: [peer] }))
  assert.equal(gateway.checkOutbound(PRIVATE, peer, 'w1'), '没发出去：和别人刚说的撞车了，换个角度，或者这轮不说。')
  gateway.planWake(plan(PRIVATE, { wakeId: 'w2', peerTexts: [] }))
  assert.equal(gateway.checkOutbound(PRIVATE, peer, 'w1'), null)
  assert.equal(gateway.checkOutbound(PRIVATE, peer, 'w2'), null)
})

test('read and write tools are never audited, whether they succeed or fail', async () => {
  const { gateway, audit } = harness()
  gateway.register(fakeTool({ name: 'look', effect: 'read' }))
  gateway.register(fakeTool({ name: 'note', effect: 'write' }))
  gateway.register(fakeTool({ name: 'broken', effect: 'read', handler: () => { throw new Error('down') } }))
  gateway.register(fakeTool({ name: 'broken_write', effect: 'write', handler: () => { throw new Error('down') } }))
  gateway.planWake(plan(PRIVATE))
  const session = sessionFor(PRIVATE)
  await gateway.dispatch(call(session, 'p__look', {}))
  await gateway.dispatch(call(session, 'p__note', {}))
  await rejection(gateway.dispatch(call(session, 'p__broken', {})))
  await rejection(gateway.dispatch(call(session, 'p__broken_write', {})))
  assert.deepEqual(audit.entries, [])
  assert.deepEqual(gateway.endWake(session), { sent: 0 }, 'only send tools count as sends')
})

test('the self-similarity line is exactly 0.65: a pair at 0.65 is refused, a pair at 0.6 is not', () => {
  const { gateway } = harness()
  const earlier = 'abcdefghijklmnopqrstu'
  // 21 characters each, 20 bigrams each. The first 14 characters are shared, which gives 13 shared bigrams.
  const atLine = 'abcdefghijklmn1234567'
  // The first 13 characters are shared, which gives 12 shared bigrams.
  const below = 'abcdefghijklm12345678'
  assert.equal(dice(earlier, atLine), 0.65)
  assert.ok(dice(earlier, below) < 0.65 && dice(earlier, below) === 0.6)
  gateway.noteOutbound(PRIVATE, earlier)
  assert.equal(gateway.checkOutbound(PRIVATE, atLine), '没发出去：和你最近说的太像了，换个说法，改一次再发。')
  assert.equal(gateway.checkOutbound(PRIVATE, below), null)
})

test('extractOutboundTexts handles strings, string arrays with empty/non-string items, and other values', () => {
  assert.deepEqual(extractOutboundTexts('hello'), ['hello'])
  assert.deepEqual(extractOutboundTexts(''), [''])
  assert.deepEqual(extractOutboundTexts(['第一句', '', 42, null, undefined, {}, '第二句']), ['第一句', '第二句'])
  assert.deepEqual(extractOutboundTexts([]), [])
  assert.deepEqual(extractOutboundTexts(42), [])
  assert.deepEqual(extractOutboundTexts(null), [])
  assert.deepEqual(extractOutboundTexts(undefined), [])
})

test('multi-bubble string[] textArg blocks if any bubble fails opener, self-repeat, or peer-collision without invoking or consuming admit quota', async () => {
  const peerLine = '今天晚上我们一起去看电影怎么样呀'

  // 1. 2nd bubble hits opener check, does not invoke tool, audit, or consume sendPerMinute quota
  {
    const { gateway, audit } = harness({ sendPerMinute: 1, style: { openers: ['套话'] } })
    const tool = fakeTool({ name: 'say', effect: 'send', textArg: 'messages' })
    gateway.register(tool)
    gateway.planWake(plan(PRIVATE, { wakeId: 'w1' }))
    const session = sessionFor(PRIVATE)
    const refused = await gateway.dispatch(call(session, 'p__say', { messages: ['第一句很正常的回复', '套话开头了'] }))
    assert.equal(refused, '没发出去：开头「套话」是套话，直接说具体的事，改一次再发。')
    assert.equal(tool.calls.length, 0)
    assert.equal(audit.entries.length, 0)
    // Quota of 1/min was NOT consumed by the blocked call
    assert.equal(await gateway.dispatch(call(session, 'p__say', { messages: ['第一句很正常的回复', '第二句也很正常呀'] })), 'ok')
    assert.equal(tool.calls.length, 1)
  }

  // 2. 2nd bubble hits self-repeat (Dice >= 0.65)
  {
    const { gateway, audit } = harness({ sendPerMinute: 1 })
    const tool = fakeTool({ name: 'say', effect: 'send', textArg: 'messages' })
    gateway.register(tool)
    gateway.noteOutbound(PRIVATE, LONG)
    gateway.planWake(plan(PRIVATE, { wakeId: 'w1' }))
    const session = sessionFor(PRIVATE)
    const refused = await gateway.dispatch(call(session, 'p__say', { messages: ['另外一段毫不相干的话', `${LONG}！`] }))
    assert.equal(refused, '没发出去：和你最近说的太像了，换个说法，改一次再发。')
    assert.equal(tool.calls.length, 0)
    assert.equal(audit.entries.length, 0)
    // Quota of 1/min still available
    assert.equal(await gateway.dispatch(call(session, 'p__say', { messages: ['明天想去逛逛书店'] })), 'ok')
  }

  // 3. 2nd bubble hits peer-collision (Dice >= 0.80)
  {
    const { gateway, audit } = harness({ sendPerMinute: 1 })
    const tool = fakeTool({ name: 'say', effect: 'send', textArg: 'messages' })
    gateway.register(tool)
    gateway.planWake(plan(PRIVATE, { wakeId: 'w1', peerTexts: [peerLine] }))
    const session = sessionFor(PRIVATE)
    const refused = await gateway.dispatch(call(session, 'p__say', { messages: ['我刚看到消息', peerLine] }))
    assert.equal(refused, '没发出去：和别人刚说的撞车了，换个角度，或者这轮不说。')
    assert.equal(tool.calls.length, 0)
    assert.equal(audit.entries.length, 0)
    // Quota of 1/min still available
    assert.equal(await gateway.dispatch(call(session, 'p__say', { messages: ['换个完全不同的话题聊聊吧'] })), 'ok')
  }
})

test('successful multi-bubble send notes every non-empty bubble and counts only once against sendPerMinute', async () => {
  const { gateway, audit } = harness({ sendPerMinute: 2 })
  const multi = fakeTool({ name: 'say', effect: 'send', textArg: 'messages' })
  const single = fakeTool({ name: 'reply', effect: 'send', textArg: 'text' })
  gateway.register(multi)
  gateway.register(single)
  gateway.planWake(plan(PRIVATE, { wakeId: 'w1' }))
  const session = sessionFor(PRIVATE)

  const bubble1 = '我刚下班准备回家做饭呢'
  const bubble2 = '今天晚上想喝点热腾腾的番茄蛋汤'
  assert.equal(await gateway.dispatch(call(session, 'p__say', { messages: [bubble1, '', 999, bubble2] })), 'ok')
  assert.deepEqual(gateway.recentSent(PRIVATE, 10), [bubble1, bubble2])

  // Repeating the 2nd bubble in a single-string send is caught by self-repeat
  const singleRefused = await gateway.dispatch(call(session, 'p__reply', { text: bubble2 }))
  assert.equal(singleRefused, '没发出去：和你最近说的太像了，换个说法，改一次再发。')

  // Repeating the 2nd bubble in another multi-bubble send is also caught by self-repeat
  const multiRefused = await gateway.dispatch(call(session, 'p__say', { messages: ['换个开场白吧', `${bubble2}呀`] }))
  assert.equal(multiRefused, '没发出去：和你最近说的太像了，换个说法，改一次再发。')

  // Reset wake (blocked count reached 2) and verify sendPerMinute still allows a 2nd send, then blocks the 3rd
  gateway.endWake(session)
  gateway.planWake(plan(PRIVATE, { wakeId: 'w2' }))
  assert.equal(await gateway.dispatch(call(session, 'p__say', { messages: ['周末计划去海边吹吹风', '顺便吃一顿海鲜烧烤'] })), 'ok')
  assert.equal(audit.entries.length, 2)
  assert.deepEqual(gateway.endWake(session).sent, 1)

  gateway.planWake(plan(PRIVATE, { wakeId: 'w3' }))
  const rateError = await rejection(gateway.dispatch(call(session, 'p__say', { messages: ['第三次发送应该被限频'] })))
  assert.ok(rateError instanceof BrainError && rateError.code === 'RATE_LIMITED')
})

test('notify__send is unconditionally reserved and reports proactive blocks on endWake', async () => {
  const disabled = harness({ proactiveMessaging: false })
  assert.throws(
    () => disabled.gateway.register(fakeTool({ pluginId: 'notify', name: 'send', effect: 'send' })),
    (error: unknown) => error instanceof BrainError && error.code === 'CONFLICT',
  )

  const { gateway } = harness({
    proactiveMessaging: true,
    owners: [PRIVATE],
    sendPerMinute: 1,
    style: { openers: ['套话'] },
  })
  const session = sessionFor(PRIVATE)
  gateway.planWake(plan(PRIVATE, {
    wakeId: 'w-proactive-1',
    sendProactiveMessage: async () => 'msg-1',
  }))
  const openerRefusal = await gateway.dispatch(call(session, 'notify__send', { text: '套话开头了' }))
  assert.match(String(openerRefusal), /套话/)
  assert.deepEqual(gateway.endWake(session), { sent: 0, blocked: 1 })

  gateway.planWake(plan(PRIVATE, {
    wakeId: 'w-proactive-2',
    sendProactiveMessage: async () => 'msg-2',
  }))
  assert.equal(await gateway.dispatch(call(session, 'notify__send', { text: '这是一条正常的提醒消息' })), '已发送：msg-2')
  assert.equal(gateway.endWake(session).sent, 1)

  gateway.planWake(plan(PRIVATE, {
    wakeId: 'w-proactive-3',
    sendProactiveMessage: async () => 'msg-3',
  }))
  const limited = await rejection(gateway.dispatch(call(session, 'notify__send', { text: '另一条完全正常的提醒' })))
  assert.ok(limited instanceof BrainError && limited.code === 'RATE_LIMITED')
  assert.deepEqual(gateway.endWake(session), { sent: 0, blocked: 1 })
})
