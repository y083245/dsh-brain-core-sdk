import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { BrainError } from '@dsh-brain-core/sdk'
import { createProactivePromises } from '../../src/proactive-promises.ts'
import { createChannelRegistry } from '../../src/runtime-stores/index.ts'
import { FLASH, capturingLogger, installPlugin, setup, waitFor } from './helpers.ts'

const OWNER = 'qq:private:owner'
const OTHER = 'qq:private:other'
const EXPECTED = '今天说好一起看展，别忘了。'
const testTransport = globalThis as typeof globalThis & {
  __brainProactiveTest?: { channel: string; text: string }[]
}

test('the scheduler wakes an opted-in owner private channel, sends once, and hides the tool from normal chat', async (t) => {
  let now = Date.UTC(2026, 10, 26, 10)
  let tick: (() => void) | undefined
  const originalInterval = globalThis.setInterval
  globalThis.setInterval = ((callback: () => void, ms?: number) => {
    if (ms === 30_000) tick = callback
    return originalInterval(callback, ms)
  }) as typeof globalThis.setInterval
  let h: Awaited<ReturnType<typeof setup>>
  try {
    h = await setup(t, {
      settings: { agents: { chat: { ...FLASH } }, timezone: 'UTC' },
      apiKey: 'fake-key',
      roleCard: '你是小满，说话简短。',
      ownerChannels: [OWNER, 'qq:group:owner'],
      clock: { now: () => now },
      script: (_request, index) => index === 0
        ? { tool: 'notify__send', input: { text: EXPECTED } }
        : { text: '好。' },
    })
  } finally {
    globalThis.setInterval = originalInterval
  }

  testTransport.__brainProactiveTest = []
  t.after(() => { delete testTransport.__brainProactiveTest })
  const plugin = path.join(h.home, 'test-plugin')
  await mkdir(plugin)
  await writeFile(path.join(plugin, 'package.json'), JSON.stringify({
    name: 'proactive-test-qq',
    version: '1.0.0',
    type: 'module',
    main: './index.js',
    brain: {
      id: 'qq',
      kinds: ['channel'],
      api: '^1',
      runtime: 'node',
      permissions: ['channel.provide', 'channel.send'],
      source: {
        channels: ['qq:private:*', 'qq:group:*'],
        eventKinds: ['qq.message'],
        defaultVisibility: 'origin',
        trust: 'external',
        proactiveMessaging: true,
      },
    },
  }))
  await writeFile(path.join(plugin, 'index.js'), `
    export function apply(ctx) {
      ctx.channel.provide({
        async send(channel, { text }) {
          globalThis.__brainProactiveTest.push({ channel, text })
          return { messageId: 'qq-verified-1' }
        },
        async members() { return ['p1'] },
        async resolveIdentity() { return null },
      })
    }
  `)
  await installPlugin(h.kernel, plugin, 'qq')

  const identity = { kind: 'kernel', source: 'test', trust: 'owner', defaultVisibility: 'origin' } as const
  for (const channel of [OWNER, OTHER, 'qq:group:owner']) {
    const source = await h.ingest(channel, '2026-11-26 一起看展，约好了。', 'p1')
    await h.kernel.memory.service.record({
      layer: 'L1',
      kind: 'l1.promise',
      channel,
      actor: 'p1',
      subjects: ['p1'],
      evidence: [{ id: source }],
      content: {
        text: channel === OWNER ? '今天一起看展' : '这段约定不应进入主人私聊',
        due: '2026-11-26',
        legacy: true,
        promiseStatus: 'open',
      },
    }, identity)
  }

  const stateFile = path.join(h.home, 'state', 'agent', 'proactive-promises.json')
  assert.ok(tick)
  now += 60_000
  tick()
  await waitFor(() => testTransport.__brainProactiveTest?.length === 1 ? true : undefined, 10_000, 'the proactive send')
  await waitFor(() => h.fake.requests.length >= 2 ? true : undefined, 10_000, 'the proactive turn completion')

  assert.deepEqual(testTransport.__brainProactiveTest, [{ channel: OWNER, text: EXPECTED }])
  assert.match(await readFile(stateFile, 'utf8'), /"status":"sent","messageId":"qq-verified-1"/)
  assert.match(h.fake.requests[0]?.raw ?? '', /今天一起看展/)
  assert.doesNotMatch(h.fake.requests[0]?.raw ?? '', /这段约定不应进入主人私聊/)
  assert.ok(h.fake.requests.some(({ tools, deferred }) => [...tools, ...deferred].includes('notify__send')))

  now += 60_000
  tick()
  const firstNormal = h.fake.requests.length
  await h.wake(OWNER, '我收到了')
  const normal = h.fake.requests.slice(firstNormal)
  assert.ok(normal.length > 0)
  assert.ok(normal.every(({ tools, deferred }) => ![...tools, ...deferred].includes('notify__send')))
  assert.equal(testTransport.__brainProactiveTest.length, 1)

  const audit = new DatabaseSync(path.join(h.home, 'state', 'agent', 'outbound.db'), { readOnly: true })
  try {
    const entry = audit.prepare('SELECT tool, plugin_id, channel, ok FROM outbound_audit WHERE tool = ?').get('notify__send')
    assert.deepEqual({ ...entry }, { tool: 'notify__send', plugin_id: 'qq', channel: OWNER, ok: 1 })
  } finally {
    audit.close()
  }

  const restartedProviders = createChannelRegistry()
  restartedProviders.provide('qq', {
    send: async () => assert.fail('a restored delivery must not send again'),
    members: async () => ['p1'],
    resolveIdentity: async () => null,
  }, () => true)
  const runAfterRestart = createProactivePromises({
    memory: h.kernel.memory,
    agent: { ...h.kernel.agent, wakeProactiveMessage: async () => assert.fail('a restored delivery must not wake again') },
    providers: restartedProviders,
    ownerChannels: new Set([OWNER]),
    settings: () => h.kernel.settings.read(),
    crossChannelMode: () => 'shadow',
    clock: { now: () => now + 60 * 60_000 },
    log: capturingLogger(h.logs),
    stateFile,
  })
  await runAfterRestart()
})

test('blocked proactive wake defers without writing declined, then retries and creates nested state parent dir', async (t) => {
  const now = Date.UTC(2026, 10, 26, 10, 5)
  const h = await setup(t, {
    settings: { agents: { chat: { ...FLASH } }, timezone: 'UTC' },
    apiKey: 'fake-key',
    roleCard: '简短。',
    ownerChannels: [OWNER],
    clock: { now: () => now },
  })
  const source = await h.ingest(OWNER, '2026-11-26 记得拿快递', 'p1')
  const identity = { kind: 'kernel', source: 'test', trust: 'owner', defaultVisibility: 'origin' } as const
  await h.kernel.memory.service.record({
    layer: 'L1',
    kind: 'l1.promise',
    channel: OWNER,
    actor: 'p1',
    subjects: ['p1'],
    evidence: [{ id: source }],
    content: { text: '记得拿快递', due: '2026-11-26', promiseStatus: 'pending' },
  }, identity)

  const providers = createChannelRegistry()
  providers.provide('qq', {
    send: async () => ({ messageId: 'qq-deferred-ok' }),
    members: async () => ['p1'],
    resolveIdentity: async () => null,
  }, () => true)

  const stateFile = path.join(h.home, 'nested', 'dir', 'proactive-promises.json')
  let attempt = 0
  const run = createProactivePromises({
    memory: h.kernel.memory,
    agent: {
      ...h.kernel.agent,
      wakeProactiveMessage: async (_channel, _input, send) => {
        attempt += 1
        if (attempt === 1) {
          return { wakeId: 'w1', acked: true, profileVersion: 1, sent: 0, steps: 1, blocked: true }
        }
        await send('记得拿快递呀')
        return { wakeId: 'w2', acked: true, profileVersion: 1, sent: 1, steps: 2 }
      },
    },
    providers,
    ownerChannels: new Set([OWNER]),
    settings: () => h.kernel.settings.read(),
    crossChannelMode: () => 'off',
    clock: { now: () => now },
    log: capturingLogger(h.logs),
    stateFile,
  })

  await run()
  assert.equal(attempt, 1)
  assert.equal(existsSync(stateFile), false, 'blocked turn must not persist declined')
  assert.ok(h.logs.some((entry) => entry.event === 'proactive.promise_deferred'))

  await run()
  assert.equal(attempt, 2)
  assert.match(await readFile(stateFile, 'utf8'), /"status":"sent","messageId":"qq-deferred-ok"/)
})

test('cold-start owner channel without inbound L0 resolves members from provider, tolerates errors, labels cross-channel notes, and audits only when not skipped', async (t) => {
  const now = Date.UTC(2026, 10, 26, 10, 10)
  const h = await setup(t, {
    settings: { agents: { chat: { ...FLASH } }, timezone: 'UTC' },
    apiKey: 'fake-key',
    roleCard: '简短。',
    crossChannel: 'on',
    ownerChannels: [OWNER],
    clock: { now: () => now },
  })
  const consoleChannel = 'console:private:owner'
  const source = await h.ingest(consoleChannel, '2026-11-26 下午去体检', 'p1')
  const identity = { kind: 'kernel', source: 'test', trust: 'owner', defaultVisibility: 'subject' } as const
  const promise = await h.kernel.memory.service.record({
    layer: 'L1',
    kind: 'l1.promise',
    channel: consoleChannel,
    actor: 'p1',
    subjects: ['p1'],
    evidence: [{ id: source }],
    visibility: 'subject',
    content: { text: '下午去体检', due: '2026-11-26', promiseStatus: 'pending' },
  }, identity)

  let memberShouldFail = true
  const providers = createChannelRegistry()
  providers.provide('qq', {
    send: async () => ({ messageId: 'qq-cold-1' }),
    members: async () => {
      if (memberShouldFail) throw new Error('bridge offline')
      return ['p1']
    },
    resolveIdentity: async () => null,
  }, () => true)

  const seenNotes: string[] = []
  let skipNext = true
  const stateFile = path.join(h.home, 'state', 'agent', 'proactive-promises.json')
  const run = createProactivePromises({
    memory: h.kernel.memory,
    agent: {
      ...h.kernel.agent,
      wakeProactiveMessage: async (_channel, input, send) => {
        seenNotes.push(input.note ?? '')
        if (skipNext) {
          return { wakeId: 'w-skip', acked: false, profileVersion: 1, sent: 0, steps: 0, skipped: 'quiet' }
        }
        await send('下午别忘了体检')
        return { wakeId: 'w-ok', acked: true, profileVersion: 1, sent: 1, steps: 2 }
      },
    },
    providers,
    ownerChannels: new Set([OWNER]),
    settings: () => h.kernel.settings.read(),
    crossChannelMode: () => 'on',
    clock: { now: () => now },
    log: capturingLogger(h.logs),
    stateFile,
  })

  // 1. Failing provider.members logs warning and skips cleanly
  await run()
  assert.equal(seenNotes.length, 0)
  assert.ok(h.logs.some((entry) => entry.event === 'proactive.members_failed'))

  // 2. Working provider.members discovers ['p1'] on cold-start channel; skipped wake must NOT write crossChannelUse audit
  memberShouldFail = false
  await run()
  assert.equal(seenNotes.length, 1)
  assert.match(seenNotes[0] ?? '', /\[.+\]\s*下午去体检/)
  assert.equal((await h.kernel.memory.audit.list(promise.id)).length, 0)

  // 3. Non-skipped wake sends and writes crossChannelUse audit once
  skipNext = false
  await run()
  assert.equal(seenNotes.length, 2)
  assert.equal((await h.kernel.memory.audit.list(promise.id)).length, 1)
  assert.match(await readFile(stateFile, 'utf8'), /"status":"sent","messageId":"qq-cold-1"/)
})

test('RATE_LIMITED provider errors retry up to 3 attempts then mark failed, while UNAVAILABLE and missing messageId stay sending', async (t) => {
  const now = Date.UTC(2026, 10, 26, 10, 15)
  const makeCase = async (
    channel: string,
    sendImpl: () => Promise<{ readonly messageId?: string }>,
  ): Promise<{ readonly run: () => Promise<void>; readonly stateFile: string; readonly wakes: () => number }> => {
    const h = await setup(t, {
      settings: { agents: { chat: { ...FLASH } }, timezone: 'UTC' },
      apiKey: 'fake-key',
      roleCard: '简短。',
      ownerChannels: [channel],
      clock: { now: () => now },
    })
    const source = await h.ingest(channel, '2026-11-26 开会', 'p1')
    const identity = { kind: 'kernel', source: 'test', trust: 'owner', defaultVisibility: 'origin' } as const
    await h.kernel.memory.service.record({
      layer: 'L1',
      kind: 'l1.promise',
      channel,
      actor: 'p1',
      subjects: ['p1'],
      evidence: [{ id: source }],
      content: { text: '今天开会', due: '2026-11-26', promiseStatus: 'pending' },
    }, identity)
    const providers = createChannelRegistry()
    providers.provide('qq', {
      send: sendImpl as never,
      members: async () => ['p1'],
      resolveIdentity: async () => null,
    }, () => true)
    const stateFile = path.join(h.home, 'state', 'agent', 'proactive-promises.json')
    let wakeCount = 0
    const run = createProactivePromises({
      memory: h.kernel.memory,
      agent: {
        ...h.kernel.agent,
        wakeProactiveMessage: async (_ch, _input, send) => {
          wakeCount += 1
          try {
            await send('开会提醒')
            return { wakeId: `w-${wakeCount}`, acked: true, profileVersion: 1, sent: 1, steps: 2 }
          } catch {
            return { wakeId: `w-${wakeCount}`, acked: true, profileVersion: 1, sent: 0, steps: 2 }
          }
        },
      },
      providers,
      ownerChannels: new Set([channel]),
      settings: () => h.kernel.settings.read(),
      crossChannelMode: () => 'off',
      clock: { now: () => now },
      log: capturingLogger(h.logs),
      stateFile,
    })
    return { run, stateFile, wakes: () => wakeCount }
  }

  // Case 1: RATE_LIMITED retries 3 times then marks failed
  const rateCase = await makeCase(OWNER, async () => { throw new BrainError('RATE_LIMITED', '429') })
  await rateCase.run()
  assert.match(await readFile(rateCase.stateFile, 'utf8'), /"status":"retry","attempts":1/)
  await rateCase.run()
  assert.match(await readFile(rateCase.stateFile, 'utf8'), /"status":"retry","attempts":2/)
  await rateCase.run()
  assert.match(await readFile(rateCase.stateFile, 'utf8'), /"status":"failed","attempts":3/)
  await rateCase.run()
  assert.equal(rateCase.wakes(), 3, 'stopped retrying after 3 failed attempts')

  // Case 2: UNAVAILABLE stays sending and never retries
  const unavailCase = await makeCase('qq:private:owner2', async () => { throw new BrainError('UNAVAILABLE', 'ambiguous') })
  await unavailCase.run()
  assert.match(await readFile(unavailCase.stateFile, 'utf8'), /"status":"sending"/)
  await unavailCase.run()
  assert.equal(unavailCase.wakes(), 1)

  // Case 3: undefined/empty response stays sending without throwing TypeError
  const emptyCase = await makeCase('qq:private:owner3', async () => undefined as never)
  await emptyCase.run()
  assert.match(await readFile(emptyCase.stateFile, 'utf8'), /"status":"sending"/)
  await emptyCase.run()
  assert.equal(emptyCase.wakes(), 1)
})

test('third-party opt-in owner channel receives due promise reminders with natural tone and default platforms sort first', async (t) => {
  const now = Date.UTC(2026, 10, 26, 10, 30)
  const thirdParty = 'discord:private:owner'
  const defaultChannel = 'qq:private:owner'
  const h = await setup(t, {
    settings: { agents: { chat: { ...FLASH } }, timezone: 'UTC' },
    apiKey: 'fake-key',
    roleCard: '简短。',
    ownerChannels: [thirdParty, defaultChannel],
    clock: { now: () => now },
  })
  const identity = { kind: 'kernel', source: 'test', trust: 'owner', defaultVisibility: 'origin' } as const
  for (const channel of [thirdParty, defaultChannel]) {
    const source = await h.ingest(channel, '2026-11-26 记得交材料', 'p1')
    await h.kernel.memory.service.record({
      layer: 'L1',
      kind: 'l1.promise',
      channel,
      actor: 'p1',
      subjects: ['p1'],
      evidence: [{ id: source }],
      content: { text: `${channel} 交材料`, due: '2026-11-26', promiseStatus: 'pending' },
    }, identity)
  }

  const delivered: { channel: string; text: string | undefined }[] = []
  const providers = createChannelRegistry()
  providers.provide('discord', {
    send: async (channel, { text }) => { delivered.push({ channel, text }); return { messageId: 'dc-1' } },
    members: async () => ['p1'],
    resolveIdentity: async () => null,
  }, () => true)
  providers.provide('qq', {
    send: async (channel, { text }) => { delivered.push({ channel, text }); return { messageId: 'qq-1' } },
    members: async () => ['p1'],
    resolveIdentity: async () => null,
  }, () => true)

  const seenOrder: { channel: string; note: string }[] = []
  const stateFile = path.join(h.home, 'state', 'agent', 'proactive-promises.json')
  const run = createProactivePromises({
    memory: h.kernel.memory,
    agent: {
      ...h.kernel.agent,
      wakeProactiveMessage: async (channel, input, send) => {
        seenOrder.push({ channel, note: input.note ?? '' })
        await send(`提醒一下：${channel}`)
        return { wakeId: `w-${channel}`, acked: true, profileVersion: 1, sent: 1, steps: 2 }
      },
    },
    providers,
    ownerChannels: new Set([thirdParty, defaultChannel]),
    settings: () => h.kernel.settings.read(),
    crossChannelMode: () => 'off',
    clock: { now: () => now },
    log: capturingLogger(h.logs),
    stateFile,
  })

  await run()
  assert.deepEqual(seenOrder.map((entry) => entry.channel), [defaultChannel, thirdParty])
  assert.ok(seenOrder[1]!.note.includes('今天有到期的约定。想提就自然地提一句，别像闹钟一样念；不想打扰也可以保持安静。'))
  assert.deepEqual(delivered.map((entry) => entry.channel), [defaultChannel, thirdParty])
  assert.match(await readFile(stateFile, 'utf8'), /"channel":"discord:private:owner".*"messageId":"dc-1"/)
})
