import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { BrainError } from '@dsh-brain-core/sdk'
import type { MemoryRecord, WakeInput, WakeResult, WakeSkip } from '@dsh-brain-core/sdk'
import type { AgentRuntime } from '../../src/contracts/index.ts'
import { createProactiveOwnLife } from '../../src/proactive-life.ts'
import { createChannelRegistry } from '../../src/runtime-stores/index.ts'
import { FLASH, capturingLogger, installPlugin, setup, waitFor } from './helpers.ts'

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const OWNER = 'qq:private:owner'

async function seedL1(
  h: Awaited<ReturnType<typeof setup>>,
  opts: {
    readonly channel?: string
    readonly kind?: string
    readonly text: string
    readonly subjects?: readonly string[]
    readonly visibility?: 'origin' | 'subject' | 'owner' | 'open' | 'internal'
    readonly tEvent: number
    readonly importance?: number
    readonly validTo?: number
    readonly status?: 'active' | 'outdated' | 'archived'
    readonly decay?: { readonly stabilityDays: number; readonly difficulty: number; readonly lastReviewedAt: number; readonly reps: number }
  },
): Promise<MemoryRecord> {
  const ch = opts.channel ?? OWNER
  const sourceId = await h.ingest(ch, `source:${opts.text}`, opts.subjects?.[0] ?? 'p1')
  const rec = await h.kernel.memory.service.record({
    layer: 'L1',
    kind: opts.kind ?? 'l1.fact',
    channel: ch,
    actor: 'p1',
    subjects: opts.subjects ?? ['p1'],
    evidence: [{ id: sourceId }],
    visibility: opts.visibility ?? 'origin',
    importance: opts.importance ?? 0.8,
    tEvent: opts.tEvent,
    content: {
      text: opts.text,
      ...(opts.decay === undefined ? {} : { decay: opts.decay }),
    },
  }, { kind: 'kernel', source: 'test', trust: 'owner', defaultVisibility: 'origin' })
  if (opts.validTo !== undefined || opts.status !== undefined) {
    return await h.kernel.memory.store.patch(rec.id, {
      ...(opts.validTo === undefined ? {} : { validTo: opts.validTo }),
      ...(opts.status === undefined ? {} : { status: opts.status }),
    }, rec.version)
  }
  return rec
}

test('startupDelayMs, enabled:false, intervalMs floor, maxPerDay, and activityDay cross-midnight rhythm', async (t) => {
  let now = Date.UTC(2026, 10, 26, 9, 0) // 2026-11-26 09:00 UTC
  const h = await setup(t, {
    settings: {
      agents: { chat: { ...FLASH } },
      timezone: 'UTC',
      quietHours: [3, 8],
      proactive: {
        ownLife: {
          enabled: true,
          intervalMs: 1_000, // clamped to 60_000
          maxPerDay: 2,
          midnightAt: '23:30',
          recallPerDay: 0,
        },
      },
    },
    apiKey: 'fake-key',
    roleCard: '简短。',
    ownerChannels: [OWNER],
    clock: { now: () => now },
  })

  const providers = createChannelRegistry()
  providers.provide('qq', {
    send: async () => ({ messageId: 'm1' }),
    members: async () => ['p1'],
    resolveIdentity: async () => null,
  }, () => true)

  const wakes: { readonly channel: string; readonly reason: string; readonly silent?: boolean; readonly note?: string }[] = []
  let skipNext: WakeSkip | undefined
  const fakeAgent: AgentRuntime = {
    ...h.kernel.agent,
    canProactive: async () => skipNext,
    wake: async (channel, input: WakeInput): Promise<WakeResult> => {
      wakes.push({ channel, reason: input.reason, ...(input.silent === undefined ? {} : { silent: input.silent }), ...(input.note === undefined ? {} : { note: input.note }) })
      return { wakeId: 'w-mid', acked: true, profileVersion: 1, sent: 0, steps: 1 }
    },
    wakeProactiveMessage: async (channel, input) => {
      wakes.push({ channel, reason: input.reason, ...(input.note === undefined ? {} : { note: input.note }) })
      return { wakeId: 'w-day', acked: true, profileVersion: 1, sent: 0, steps: 1 }
    },
  }

  const stateFile = path.join(h.home, 'nested', 'own-life.json')
  const run = createProactiveOwnLife({
    memory: h.kernel.memory,
    agent: fakeAgent,
    providers,
    ownerChannels: new Set([OWNER]),
    settings: () => h.kernel.settings.read(),
    crossChannelMode: () => 'off',
    clock: { now: () => now },
    log: capturingLogger(h.logs),
    stateFile,
  })

  // 1. Within default 90_000 ms startupDelayMs -> does nothing
  now += 89_999
  await run()
  assert.equal(wakes.length, 0)

  // 2. Past 90_000 ms -> fires daytime slot #1
  now += 1
  await run()
  assert.equal(wakes.length, 1)
  assert.equal(wakes[0]!.reason, 'own-life')
  assert.match(wakes[0]!.note ?? '', /现在是你的时间/)

  // 3. 30s later (< 60_000 ms floor) -> does not fire
  now += 30_000
  await run()
  assert.equal(wakes.length, 1)

  // 4. 30s more (60_000 ms elapsed) -> fires daytime slot #2
  now += 30_000
  await run()
  assert.equal(wakes.length, 2)

  // 5. Same activity day, maxPerDay=2 exhausted -> does not fire
  now += 2 * HOUR_MS
  await run()
  assert.equal(wakes.length, 2)

  // 6. Midnight window at 23:40: deferred while quiet or foreground, succeeds even if unanswered/cooldown
  now = Date.UTC(2026, 10, 26, 23, 40)
  skipNext = 'foreground'
  await run()
  assert.equal(wakes.length, 2, 'foreground defers midnight without consuming')

  skipNext = 'unanswered'
  await run()
  assert.equal(wakes.length, 3, 'unanswered does NOT block silent midnight wind-down')
  assert.equal(wakes[2]!.reason, 'own-life-midnight')
  assert.equal(wakes[2]!.silent, true)
  assert.match(wakes[2]!.note ?? '', /半夜了，没人打扰，这段时间别主动给主人发消息/)

  // 7. At 00:30 next calendar day (still same activity day 2026-11-26 since quiet[0]=3), midnight already ran and daytime is closed
  now = Date.UTC(2026, 10, 27, 0, 30)
  skipNext = undefined
  await run()
  assert.equal(wakes.length, 3)

  // 8. At 08:05 on 2026-11-27 -> new activity day starts, fires again!
  now = Date.UTC(2026, 10, 27, 8, 5)
  await run()
  assert.equal(wakes.length, 4)

  // 9. enabled: false stops execution
  const current = await h.kernel.settings.read()
  await h.kernel.settings.write({ ...current, proactive: { ownLife: { enabled: false } } })
  now += 5 * HOUR_MS
  await run()
  assert.equal(wakes.length, 4)
})

test('channel prioritization: defaults first, third-party requires 30-day bidirectional L0, skips gracefully without spending quota', async (t) => {
  const now = Date.UTC(2026, 10, 26, 14, 0)
  const dcZero = 'discord:private:zero'
  const dcLow = 'discord:private:low'
  const dcHigh = 'discord:private:high'
  const tgOwner = 'telegram:private:owner'

  const h = await setup(t, {
    settings: {
      agents: { chat: { ...FLASH } },
      timezone: 'UTC',
      proactive: { ownLife: { recallPerDay: 0 } },
    },
    apiKey: 'fake-key',
    roleCard: '简短。',
    ownerChannels: [dcZero, dcLow, dcHigh, tgOwner],
    clock: { now: () => now },
  })

  const id = { kind: 'kernel', source: 'test', trust: 'owner', defaultVisibility: 'origin' } as const
  // dcZero: only inbound (0 outbound -> bidirectionalCount = 0) and old bidirectional (35d ago)
  await h.kernel.memory.service.ingest({
    kind: 'discord.message', channel: dcZero, subjects: ['p1'], actor: 'p1',
    content: { text: '只有入站', direction: 'inbound' }, tEvent: now - DAY_MS, idempotencyKey: 'z1',
  }, id)
  await h.kernel.memory.service.ingest({
    kind: 'discord.message', channel: dcZero, subjects: ['p1'], actor: 'self',
    content: { text: '35天前出站', direction: 'outbound' }, tEvent: now - 35 * DAY_MS, idempotencyKey: 'z2',
  }, id)

  // dcLow: 1 bidirectional pair
  await h.kernel.memory.service.ingest({
    kind: 'discord.message', channel: dcLow, subjects: ['p1'], actor: 'p1',
    content: { text: '低活跃入', direction: 'inbound' }, tEvent: now - 2 * DAY_MS, idempotencyKey: 'l1',
  }, id)
  await h.kernel.memory.service.ingest({
    kind: 'discord.message', channel: dcLow, subjects: ['p1'], actor: 'self',
    content: { text: '低活跃出', direction: 'outbound' }, tEvent: now - 2 * DAY_MS + 1000, idempotencyKey: 'l2',
  }, id)

  // dcHigh: 2 bidirectional pairs
  for (const i of [1, 2]) {
    await h.kernel.memory.service.ingest({
      kind: 'discord.message', channel: dcHigh, subjects: ['p1'], actor: 'p1',
      content: { text: `高活跃入${i}`, direction: 'inbound' }, tEvent: now - i * DAY_MS, idempotencyKey: `h-in-${i}`,
    }, id)
    await h.kernel.memory.service.ingest({
      kind: 'discord.message', channel: dcHigh, subjects: ['p1'], actor: 'self',
      content: { text: `高活跃出${i}`, direction: 'outbound' }, tEvent: now - i * DAY_MS + 1000, idempotencyKey: `h-out-${i}`,
    }, id)
  }

  const providers = createChannelRegistry()
  providers.provide('discord', {
    send: async () => ({ messageId: 'd1' }), members: async () => ['p1'], resolveIdentity: async () => null,
  }, () => true)
  providers.provide('telegram', {
    send: async () => ({ messageId: 't1' }), members: async () => ['p1'], resolveIdentity: async () => null,
  }, () => true)

  const skips = new Map<string, WakeSkip | undefined>([
    [tgOwner, 'cooldown'],
    [dcHigh, undefined],
  ])
  const woken: string[] = []
  const stateFile = path.join(h.home, 'state', 'agent', 'own-life.json')
  const run = createProactiveOwnLife({
    memory: h.kernel.memory,
    agent: {
      ...h.kernel.agent,
      canProactive: async (ch) => skips.get(ch),
      wakeProactiveMessage: async (ch) => {
        woken.push(ch)
        return { wakeId: 'w1', acked: true, profileVersion: 1, sent: 0, steps: 1 }
      },
    },
    providers,
    ownerChannels: new Set([dcZero, dcLow, dcHigh, tgOwner]),
    settings: () => h.kernel.settings.read(),
    crossChannelMode: () => 'off',
    clock: { now: () => now },
    log: capturingLogger(h.logs),
    stateFile,
    startupDelayMs: 0,
  })

  // tgOwner is skipped -> falls through to dcHigh (higher 30d bidirectional count than dcLow); dcZero excluded
  await run()
  assert.deepEqual(woken, [dcHigh])

  // If ALL eligible channels are skipped -> logs own_life_skipped and does NOT spend quota
  skips.set(dcHigh, 'unanswered')
  skips.set(dcLow, 'unanswered')
  const stateBefore = JSON.parse(await readFile(stateFile, 'utf8')) as { firedToday: number }
  const runAllSkipped = createProactiveOwnLife({
    memory: h.kernel.memory,
    agent: {
      ...h.kernel.agent,
      canProactive: async (ch) => skips.get(ch),
      wakeProactiveMessage: async () => assert.fail('must not wake when all channels skipped by canProactive'),
    },
    providers,
    ownerChannels: new Set([dcZero, dcLow, dcHigh, tgOwner]),
    settings: () => h.kernel.settings.read(),
    crossChannelMode: () => 'off',
    clock: { now: () => now + 3 * HOUR_MS },
    log: capturingLogger(h.logs),
    stateFile,
    startupDelayMs: 0,
  })
  await runAllSkipped()
  const stateAfter = JSON.parse(await readFile(stateFile, 'utf8')) as { firedToday: number }
  assert.equal(stateAfter.firedToday, stateBefore.firedToday)
  assert.ok(h.logs.some((entry) => entry.event === 'proactive.own_life_skipped'))
})

test('strict privacy filtering, FSRS recall, 1-hop association with timeout fallback, reinforcement, and zero raw text persistence', async (t) => {
  const now = Date.UTC(2026, 10, 26, 15, 0)
  const h = await setup(t, {
    settings: {
      agents: { chat: { ...FLASH } },
      timezone: 'UTC',
      proactive: {
        ownLife: {
          recallPerDay: 2,
          cooldownDays: 7,
          minAgeDays: 2,
          associateEnabled: true,
          associateTimeoutMs: 50,
        },
      },
    },
    apiKey: 'fake-key',
    roleCard: '简短。',
    crossChannel: 'on',
    ownerChannels: [OWNER],
    clock: { now: () => now },
  })

  // Eligible L1 seed (10 days old) + eligible L2 associated record matching keyword "海边散步"
  const seed = await seedL1(h, {
    text: '去年秋天去海边散步捡到了贝壳',
    tEvent: now - 10 * DAY_MS,
    importance: 0.9,
  })
  const l0ForL2 = await h.ingest(OWNER, '海边散步之后喝了热可可', 'p1')
  const assoc = await h.kernel.memory.service.record({
    layer: 'L2',
    kind: 'l2.reflection',
    channel: 'console:private:owner',
    actor: 'self',
    subjects: ['p1'],
    evidence: [{ id: l0ForL2 }],
    visibility: 'subject',
    importance: 0.7,
    tEvent: now - 12 * DAY_MS,
    content: { text: '海边散步时聊起过喜欢的歌单' },
  }, { kind: 'kernel', source: 'test', trust: 'owner', defaultVisibility: 'subject' })

  // Ineligible records that MUST NEVER appear:
  await seedL1(h, { kind: 'l1.promise', text: '绝不能抽到promise海边散步', tEvent: now - 10 * DAY_MS })
  await seedL1(h, { kind: 'l1.candidate', text: '绝不能抽到candidate海边散步', tEvent: now - 10 * DAY_MS })
  await seedL1(h, { kind: 'l1.topic', text: '绝不能抽到topic海边散步', tEvent: now - 10 * DAY_MS })
  await seedL1(h, { text: '绝不能抽到internal海边散步', visibility: 'internal', tEvent: now - 10 * DAY_MS })
  await seedL1(h, { text: '绝不能抽到expired海边散步', validTo: now - 1000, tEvent: now - 10 * DAY_MS })
  await seedL1(h, { text: '绝不能抽到tooNew海边散步', tEvent: now - DAY_MS })
  // Deeply forgotten L1 (R < 0.15)
  await seedL1(h, {
    text: '绝不能抽到forgotten海边散步',
    tEvent: now - 200 * DAY_MS,
    decay: { stabilityDays: 0.5, difficulty: 5, lastReviewedAt: now - 200 * DAY_MS, reps: 1 },
  })
  // Group L0 and short L0 (< 12 codepoints after stripping [...]) MUST NEVER be recalled
  await h.kernel.memory.service.ingest({
    kind: 'qq.message', channel: 'qq:group:g1', subjects: ['p1'], actor: 'p1',
    content: { text: '群里的海边散步绝对不能跨通道泄漏出去' }, tEvent: now - 10 * DAY_MS, idempotencyKey: 'grp-l0',
  }, { kind: 'kernel', source: 'test', trust: 'owner', defaultVisibility: 'origin' })
  await h.kernel.memory.service.ingest({
    kind: 'qq.message', channel: OWNER, subjects: ['p1'], actor: 'p1',
    content: { text: '[图片][表情] 太短了只有八个字' }, tEvent: now - 10 * DAY_MS, idempotencyKey: 'short-l0',
  }, { kind: 'kernel', source: 'test', trust: 'owner', defaultVisibility: 'origin' })

  const providers = createChannelRegistry()
  providers.provide('qq', {
    send: async () => ({ messageId: 'qq-life-1' }),
    members: async () => ['p1'],
    resolveIdentity: async () => null,
  }, () => true)

  const stateFile = path.join(h.home, 'state', 'agent', 'own-life.json')
  // Write corrupted state file to test safe fallback
  await mkdir(path.dirname(stateFile), { recursive: true })
  await writeFile(stateFile, '{corrupted json')

  let capturedNote = ''
  let capturedEvidence: readonly string[] = []
  const run = createProactiveOwnLife({
    memory: h.kernel.memory,
    agent: {
      ...h.kernel.agent,
      canProactive: async () => undefined,
      wakeProactiveMessage: async (_ch, input, send) => {
        capturedNote = input.note ?? ''
        capturedEvidence = input.evidence ?? []
        await send('突然想起以前去海边捡贝壳的事了')
        return { wakeId: 'w-recall', acked: true, profileVersion: 1, sent: 1, steps: 2 }
      },
    },
    providers,
    ownerChannels: new Set([OWNER]),
    settings: () => h.kernel.settings.read(),
    crossChannelMode: () => 'on',
    clock: { now: () => now },
    log: capturingLogger(h.logs),
    stateFile,
    startupDelayMs: 0,
    rng: () => 0,
  })

  await run()

  // Seed & associated selected, ineligible filtered out
  assert.ok(capturedEvidence.includes(seed.id))
  assert.ok(capturedNote.includes('去年秋天去海边散步捡到了贝壳'))
  if (capturedEvidence.includes(assoc.id)) {
    assert.ok(capturedNote.includes('说起这个顺带想到的'))
    assert.ok(capturedNote.includes('海边散步时聊起过喜欢的歌单'))
  }
  assert.doesNotMatch(capturedNote, /绝不能抽到/)
  assert.doesNotMatch(capturedNote, /群里的海边散步/)
  assert.doesNotMatch(capturedNote, /太短了/)

  // FSRS reinforce updated seed version & decay
  const refreshedSeed = await h.kernel.memory.store.get(seed.id)
  assert.ok(refreshedSeed !== null)
  assert.equal(refreshedSeed.version, seed.version + 1)
  assert.equal((refreshedSeed.content.decay as { reps: number }).reps, 1)

  // State file contains zero raw text
  const rawState = await readFile(stateFile, 'utf8')
  assert.doesNotMatch(rawState, /海边散步/)
  assert.doesNotMatch(rawState, /歌单/)

  // Logs contain zero raw text
  const rawLogs = JSON.stringify(h.logs)
  assert.doesNotMatch(rawLogs, /海边散步/)
  assert.doesNotMatch(rawLogs, /歌单/)

  // Cross-channel audit recorded at most once for assoc (by memory.service.search)
  if (capturedEvidence.includes(assoc.id)) {
    const assocAudits = await h.kernel.memory.audit.list(assoc.id)
    assert.equal(assocAudits.length, 1)
  }

  // Test 1-hop search timeout graceful degradation + sendCallback validation
  const slowMemory = {
    ...h.kernel.memory,
    service: {
      ...h.kernel.memory.service,
      search: () => new Promise<never>(() => undefined), // never resolves -> triggers 50ms timeout
    },
  }
  const l0Eligible = await h.kernel.memory.service.ingest({
    kind: 'qq.message', channel: OWNER, subjects: ['p1'], actor: 'p1',
    content: { text: '[图片] 这是一条满十二个字以上的同通道回忆消息呀' },
    tEvent: now - 10 * DAY_MS,
    idempotencyKey: 'l0-eligible',
  }, { kind: 'kernel', source: 'test', trust: 'owner', defaultVisibility: 'origin' })

  let timeoutNote = ''
  let timeoutEvidence: readonly string[] = []
  const runTimeout = createProactiveOwnLife({
    memory: slowMemory,
    agent: {
      ...h.kernel.agent,
      canProactive: async () => undefined,
      wakeProactiveMessage: async (_ch, input, send) => {
        timeoutNote = input.note ?? ''
        timeoutEvidence = input.evidence ?? []
        // Verify sendCallback rejects if evidence was forgotten mid-turn
        await h.kernel.memory.store.tombstone(l0Eligible.id)
        await assert.rejects(() => send('hi'), /相关记忆已失效或不可见/)
        return { wakeId: 'w-timeout', acked: true, profileVersion: 1, sent: 0, steps: 1 }
      },
    },
    providers,
    ownerChannels: new Set([OWNER]),
    settings: () => h.kernel.settings.read(),
    crossChannelMode: () => 'on',
    clock: { now: () => now + 4 * HOUR_MS },
    log: capturingLogger(h.logs),
    stateFile,
    startupDelayMs: 0,
    rng: () => 0,
  })
  await runTimeout()
  assert.deepEqual(timeoutEvidence, [l0Eligible.id])
  assert.match(timeoutNote, /这是一条满十二个字以上的同通道回忆消息呀/)
  assert.doesNotMatch(timeoutNote, /说起这个顺带想到的/)
})

test('sendCallback validates provider messageId and silent daytime turn consumes slot without setting lastProactiveAt', async (t) => {
  const now = Date.UTC(2026, 10, 26, 16, 0)
  const h = await setup(t, {
    settings: {
      agents: { chat: { ...FLASH } },
      timezone: 'UTC',
      proactive: { ownLife: { recallPerDay: 0 } },
    },
    apiKey: 'fake-key',
    roleCard: '简短。',
    ownerChannels: [OWNER],
    clock: { now: () => now },
  })

  let returnEmptyId = true
  const providers = createChannelRegistry()
  providers.provide('qq', {
    send: async () => (returnEmptyId ? { messageId: '' } : { messageId: 'ok-1' }),
    members: async () => ['p1'],
    resolveIdentity: async () => null,
  }, () => true)

  const stateFile = path.join(h.home, 'state', 'agent', 'own-life.json')
  const run = createProactiveOwnLife({
    memory: h.kernel.memory,
    agent: {
      ...h.kernel.agent,
      canProactive: async () => undefined,
      wakeProactiveMessage: async (_ch, _input, send) => {
        await assert.rejects(
          () => send('hello'),
          (err: unknown) => err instanceof BrainError && err.code === 'UNAVAILABLE',
        )
        return { wakeId: 'w-silent', acked: true, profileVersion: 1, sent: 0, steps: 1 }
      },
    },
    providers,
    ownerChannels: new Set([OWNER]),
    settings: () => h.kernel.settings.read(),
    crossChannelMode: () => 'off',
    clock: { now: () => now },
    log: capturingLogger(h.logs),
    stateFile,
    startupDelayMs: 0,
  })
  await run()
  const saved = JSON.parse(await readFile(stateFile, 'utf8')) as { firedToday: number; lastFiredAt: number }
  assert.equal(saved.firedToday, 1)
  assert.equal(saved.lastFiredAt, now)
  returnEmptyId = false

  // Real agent-runtime silent turn (FakeDeepSeek returns text without notify__send) leaves lastProactiveAt unset
  const realSilentRun = createProactiveOwnLife({
    memory: h.kernel.memory,
    agent: h.kernel.agent,
    providers,
    ownerChannels: new Set([OWNER]),
    settings: () => h.kernel.settings.read(),
    crossChannelMode: () => 'off',
    clock: { now: () => now + 3 * HOUR_MS },
    log: capturingLogger(h.logs),
    stateFile,
    startupDelayMs: 0,
  })
  await realSilentRun()
  const savedAfterSilent = JSON.parse(await readFile(stateFile, 'utf8')) as { firedToday: number; lastFiredAt: number }
  assert.equal(savedAfterSilent.firedToday, 2)
  assert.equal(savedAfterSilent.lastFiredAt, now + 3 * HOUR_MS)
  assert.equal(await h.kernel.agent.canProactive?.(OWNER), undefined)
})

test('createKernel end-to-end wires kernel:own-life scheduler and delivers proactive message via notify__send', async (t) => {
  let now = Date.UTC(2026, 10, 26, 11, 0)
  const ticks: (() => void)[] = []
  const originalInterval = globalThis.setInterval
  globalThis.setInterval = ((callback: () => void, ms?: number) => {
    if (ms === 30_000) ticks.push(callback)
    return originalInterval(callback, ms)
  }) as typeof globalThis.setInterval

  let h: Awaited<ReturnType<typeof setup>>
  try {
    h = await setup(t, {
      settings: {
        agents: { chat: { ...FLASH } },
        timezone: 'UTC',
        proactive: { ownLife: { recallPerDay: 0, midnightAt: '' } },
      },
      apiKey: 'fake-key',
      roleCard: '你是小满，说话简短。',
      ownerChannels: [OWNER],
      clock: { now: () => now },
      script: (_request, index) => index === 0
        ? { tool: 'notify__send', input: { text: '在看书，突然想问问你今天累不累。' } }
        : { text: '发好了。' },
    })
  } finally {
    globalThis.setInterval = originalInterval
  }

  const delivered: { channel: string; text: string }[] = []
  const testGlobal = globalThis as typeof globalThis & { __ownLifeE2E?: { channel: string; text: string }[] }
  testGlobal.__ownLifeE2E = delivered
  t.after(() => { delete testGlobal.__ownLifeE2E })

  const plugin = path.join(h.home, 'own-life-qq')
  await mkdir(plugin)
  await writeFile(path.join(plugin, 'package.json'), JSON.stringify({
    name: 'own-life-qq',
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
        channels: ['qq:private:*'],
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
          globalThis.__ownLifeE2E.push({ channel, text })
          return { messageId: 'qq-ownlife-1' }
        },
        async members() { return ['p1'] },
        async resolveIdentity() { return null },
      })
    }
  `)
  await installPlugin(h.kernel, plugin, 'qq')

  const tick = ticks.at(-1)
  assert.ok(tick)
  // Advance past 90s startup delay
  now += 100_000
  tick()

  await waitFor(() => delivered.length === 1 ? true : undefined, 10_000, 'own-life proactive send')
  assert.deepEqual(delivered, [{ channel: OWNER, text: '在看书，突然想问问你今天累不累。' }])

  const stateFile = path.join(h.home, 'state', 'agent', 'own-life.json')
  await waitFor(async () => {
    try {
      const content = await readFile(stateFile, 'utf8')
      return content.includes('"firedToday":1') ? content : undefined
    } catch {
      return undefined
    }
  }, 10_000, 'own-life.json persistence')

  // Verify scheduler recorded kernel:own-life under its own owner key, separate from 'kernel'
  const schedulerState = JSON.parse(await readFile(path.join(h.home, 'state', 'agent', 'scheduler.json'), 'utf8')) as {
    scheduled: Record<string, { day: string; count: number }>
  }
  assert.ok(schedulerState.scheduled['kernel:own-life'] !== undefined)
})

test('cross-channel 1-hop association writes zero audit on skipped turns or unselected hits and exactly one per injected record', async (t) => {
  const now = Date.UTC(2026, 10, 26, 15, 0)
  const otherPrivate = 'console:private:owner'
  const h = await setup(t, {
    settings: {
      agents: { chat: { ...FLASH } },
      timezone: 'UTC',
      proactive: { ownLife: { recallPerDay: 2, minAgeDays: 2, associateEnabled: true, associateTimeoutMs: 1000 } },
    },
    apiKey: 'fake-key',
    roleCard: '简短。',
    crossChannel: 'on',
    ownerChannels: [OWNER],
    clock: { now: () => now },
  })

  // Seed in another private channel (cross-channel)
  const seed = await seedL1(h, {
    channel: otherPrivate,
    visibility: 'owner',
    text: '银杏叶散步',
    tEvent: now - 10 * DAY_MS,
    importance: 0.9,
  })
  // One eligible cross-channel L1 hit (score/picked), one cross-channel L1 hit that stays unselected (because rng picks first or second),
  // and one cross-channel L0 matching the keyword (must NEVER be audited or returned by association)
  const l0Cross = await h.ingest(otherPrivate, '银杏叶散步的跨通道原始对话绝对不该被审计', 'p1')
  await h.kernel.memory.store.patch(l0Cross, {}, 1).catch(() => undefined)
  const l0Source = await h.ingest(otherPrivate, '银杏叶证据', 'p1')
  const assocA = await h.kernel.memory.service.record({
    layer: 'L1',
    kind: 'l1.fact',
    channel: otherPrivate,
    actor: 'p1',
    subjects: ['p1'],
    evidence: [{ id: l0Source }],
    visibility: 'owner',
    importance: 0.8,
    tEvent: now - 12 * DAY_MS,
    content: { text: '银杏叶散步后去喝了桂花拿铁' },
  }, { kind: 'kernel', source: 'test', trust: 'owner', defaultVisibility: 'owner' })
  const assocB = await h.kernel.memory.service.record({
    layer: 'L1',
    kind: 'l1.event',
    channel: otherPrivate,
    actor: 'p1',
    subjects: ['p1'],
    evidence: [{ id: l0Source }],
    visibility: 'owner',
    importance: 0.4,
    tEvent: now - 14 * DAY_MS,
    content: { text: '银杏叶散步的另一条未选中联想' },
  }, { kind: 'kernel', source: 'test', trust: 'owner', defaultVisibility: 'owner' })

  const providers = createChannelRegistry()
  providers.provide('qq', {
    send: async () => ({ messageId: 'qq-audit-1' }),
    members: async () => ['p1'],
    resolveIdentity: async () => null,
  }, () => true)

  const stateFile = path.join(h.home, 'state', 'agent', 'own-life.json')
  let shouldSkip = true
  let selectedEvidence: readonly string[] = []
  const run = createProactiveOwnLife({
    memory: h.kernel.memory,
    agent: {
      ...h.kernel.agent,
      canProactive: async () => undefined,
      wakeProactiveMessage: async (_ch, input) => {
        selectedEvidence = input.evidence ?? []
        if (shouldSkip) return { wakeId: 'w-skip', acked: false, profileVersion: 1, sent: 0, steps: 0, skipped: 'quiet' }
        return { wakeId: 'w-ok', acked: true, profileVersion: 1, sent: 0, steps: 1 }
      },
    },
    providers,
    ownerChannels: new Set([OWNER]),
    settings: () => h.kernel.settings.read(),
    crossChannelMode: () => 'on',
    clock: { now: () => now },
    log: capturingLogger(h.logs),
    stateFile,
    startupDelayMs: 0,
    rng: () => 0,
  })

  // 1. Skipped turn -> zero audit anywhere
  await run()
  assert.equal((await h.kernel.memory.audit.list()).length, 0)

  // 2. Non-skipped turn -> cross-channel L0 and unselected assocB have 0 audits; injected seed and assocA each have 1 audit
  shouldSkip = false
  await run()
  assert.equal(selectedEvidence.length, 2)
  assert.ok(selectedEvidence.includes(seed.id))
  const pickedAssocId = selectedEvidence.find((id) => id !== seed.id)!
  const unpickedAssocId = pickedAssocId === assocA.id ? assocB.id : assocA.id
  assert.equal((await h.kernel.memory.audit.list(seed.id)).length, 1)
  assert.equal((await h.kernel.memory.audit.list(pickedAssocId)).length, 1)
  assert.equal((await h.kernel.memory.audit.list(unpickedAssocId)).length, 0)
  assert.equal((await h.kernel.memory.audit.list(l0Cross)).length, 0)
})

test('cross-midnight quietHours and midnightAt parsing/fallback boundaries', async (t) => {
  let now = Date.UTC(2026, 10, 26, 12, 0)
  const h = await setup(t, {
    settings: {
      agents: { chat: { ...FLASH } },
      timezone: 'UTC',
      quietHours: [22, 6],
      proactive: { ownLife: { recallPerDay: 0 } }, // default midnightAt '23:30' falls inside [22, 6]
    },
    apiKey: 'fake-key',
    roleCard: '简短。',
    ownerChannels: [OWNER],
    clock: { now: () => now },
  })
  const providers = createChannelRegistry()
  providers.provide('qq', {
    send: async () => ({ messageId: 'm1' }), members: async () => ['p1'], resolveIdentity: async () => null,
  }, () => true)

  const reasons: string[] = []
  const stateFile = path.join(h.home, 'state', 'agent', 'own-life.json')
  const run = createProactiveOwnLife({
    memory: h.kernel.memory,
    agent: {
      ...h.kernel.agent,
      canProactive: async () => undefined,
      wake: async (_ch, input) => { reasons.push(input.reason); return { wakeId: 'w', acked: true, profileVersion: 1, sent: 0, steps: 1 } },
      wakeProactiveMessage: async (_ch, input) => { reasons.push(input.reason); return { wakeId: 'w', acked: true, profileVersion: 1, sent: 0, steps: 1 } },
    },
    providers,
    ownerChannels: new Set([OWNER]),
    settings: () => h.kernel.settings.read(),
    crossChannelMode: () => 'off',
    clock: { now: () => now },
    log: capturingLogger(h.logs),
    stateFile,
    startupDelayMs: 0,
  })

  // 12:00 UTC with quietHours [22, 6] + default midnightAt '23:30' MUST run daytime own-life, NOT midnight
  await run()
  assert.deepEqual(reasons, ['own-life'])

  // 22:30 UTC is inside quietHours [22, 6] -> does nothing
  now = Date.UTC(2026, 10, 26, 22, 30)
  await run()
  assert.deepEqual(reasons, ['own-life'])

  // quietHours [23, 6] + midnightAt '22:30' at 22:35 UTC -> triggers own-life-midnight
  await h.kernel.settings.write({
    agents: { chat: { ...FLASH } },
    timezone: 'UTC',
    quietHours: [23, 6],
    proactive: { ownLife: { recallPerDay: 0, midnightAt: '22:30' } },
  })
  now = Date.UTC(2026, 10, 26, 22, 35)
  await run()
  assert.deepEqual(reasons, ['own-life', 'own-life-midnight'])

  // Invalid midnightAt ('25:00') falls back to '23:30' (not disabled)
  await h.kernel.settings.write({
    agents: { chat: { ...FLASH } },
    timezone: 'UTC',
    quietHours: [3, 8],
    proactive: { ownLife: { recallPerDay: 0, midnightAt: '25:00' } },
  })
  now = Date.UTC(2026, 10, 27, 23, 35)
  await run()
  assert.deepEqual(reasons, ['own-life', 'own-life-midnight', 'own-life-midnight'])
})

test('late rejections after Promise.race timeout do not trigger unhandledRejection, and inFlight guards reentrancy', async (t) => {
  const now = Date.UTC(2026, 10, 26, 15, 0)
  const h = await setup(t, {
    settings: {
      agents: { chat: { ...FLASH } },
      timezone: 'UTC',
      proactive: { ownLife: { recallPerDay: 2, associateEnabled: true, associateTimeoutMs: 10, minAgeDays: 2 } },
    },
    apiKey: 'fake-key',
    roleCard: '简短。',
    ownerChannels: [OWNER],
    clock: { now: () => now },
  })
  await seedL1(h, { text: '测试超时和并发重入的记忆', tEvent: now - 10 * DAY_MS })

  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  t.after(() => { process.off('unhandledRejection', onUnhandled) })

  const providers = createChannelRegistry()
  providers.provide('qq', {
    send: async () => ({ messageId: 'm1' }),
    members: () => new Promise<readonly string[]>((_resolve, reject) => {
      // Rejects AFTER the 3s members timeout to verify no unhandledRejection escapes
      setTimeout(() => reject(new Error('late members failure')), 3_050)
    }),
    resolveIdentity: async () => null,
  }, () => true)
  // Clear cached members so resolveViewer actually calls provider.members(OWNER)
  h.kernel.memory.channels.setMembers(OWNER, [])

  let releaseWake!: () => void
  let markWakeEntered!: () => void
  const wakeEntered = new Promise<void>((resolve) => { markWakeEntered = resolve })
  const gate = new Promise<void>((resolve) => { releaseWake = resolve })
  let wakeCalls = 0
  const run = createProactiveOwnLife({
    memory: {
      ...h.kernel.memory,
      service: {
        ...h.kernel.memory.service,
        searchWithoutAudit: () => new Promise((_, reject) => {
          setTimeout(() => reject(new Error('late search failure')), 40)
        }),
      },
    },
    agent: {
      ...h.kernel.agent,
      canProactive: async () => undefined,
      wakeProactiveMessage: async () => {
        wakeCalls += 1
        markWakeEntered()
        await gate
        return { wakeId: 'w1', acked: true, profileVersion: 1, sent: 0, steps: 1 }
      },
    },
    providers,
    ownerChannels: new Set([OWNER]),
    settings: () => h.kernel.settings.read(),
    crossChannelMode: () => 'off',
    clock: { now: () => now },
    log: capturingLogger(h.logs),
    stateFile: path.join(h.home, 'state', 'agent', 'own-life.json'),
    startupDelayMs: 0,
    rng: () => 0,
  })

  const first = run()
  await wakeEntered
  // Concurrent reentrant call while first is still in flight -> ignored!
  await run()
  assert.equal(wakeCalls, 1)
  releaseWake()
  await first
  await sleep(120)
  assert.deepEqual(unhandled, [])
})

test('identity.merge expands cross-channel subject visibility and sendCallback rejects after identity.split', async (t) => {
  const now = Date.UTC(2026, 10, 26, 15, 0)
  const consoleChannel = 'console:private:owner'
  const h = await setup(t, {
    settings: {
      agents: { chat: { ...FLASH } },
      timezone: 'UTC',
      proactive: { ownLife: { recallPerDay: 2, minAgeDays: 2, associateEnabled: false } },
    },
    apiKey: 'fake-key',
    roleCard: '简短。',
    crossChannel: 'on',
    ownerChannels: [OWNER],
    clock: { now: () => now },
  })

  const qqPerson = await h.kernel.memory.identity.resolve('qq:owner')
  const consolePerson = await h.kernel.memory.identity.resolve('console:owner')
  await h.kernel.memory.identity.merge(consolePerson, qqPerson)

  const l0 = await h.ingest(consoleChannel, '跨通道别名的原始证据', consolePerson)
  await h.kernel.memory.service.record({
    layer: 'L1',
    kind: 'l1.fact',
    channel: consoleChannel,
    actor: consolePerson,
    subjects: [consolePerson], // only references consolePerson, reachable via qqPerson after merge!
    evidence: [{ id: l0 }],
    visibility: 'subject',
    importance: 0.9,
    tEvent: now - 10 * DAY_MS,
    content: { text: '合并身份后才能跨通道看见的事实' },
  }, { kind: 'kernel', source: 'test', trust: 'owner', defaultVisibility: 'subject' })

  const providers = createChannelRegistry()
  providers.provide('qq', {
    send: async () => ({ messageId: 'm1' }),
    members: async () => [qqPerson],
    resolveIdentity: async () => null,
  }, () => true)

  let capturedNote = ''
  const run = createProactiveOwnLife({
    memory: h.kernel.memory,
    agent: {
      ...h.kernel.agent,
      canProactive: async () => undefined,
      wakeProactiveMessage: async (_ch, input, send) => {
        capturedNote = input.note ?? ''
        // Split identity mid-turn -> currentViewer in sendCallback no longer contains consolePerson!
        await h.kernel.memory.identity.split(qqPerson, ['console:owner'])
        await assert.rejects(() => send('hi'), /相关记忆当前不可披露/)
        return { wakeId: 'w-split', acked: true, profileVersion: 1, sent: 0, steps: 1 }
      },
    },
    providers,
    ownerChannels: new Set([OWNER]),
    settings: () => h.kernel.settings.read(),
    crossChannelMode: () => 'on',
    clock: { now: () => now },
    log: capturingLogger(h.logs),
    stateFile: path.join(h.home, 'state', 'agent', 'own-life.json'),
    startupDelayMs: 0,
    rng: () => 0,
  })

  await run()
  assert.match(capturedNote, /\[私下聊过\]/)
  assert.match(capturedNote, /合并身份后才能跨通道看见的事实/)
})

