import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import test from 'node:test'
import {
  createRealSatelliteFactory,
  createSupervisor,
  encodeSessionId,
  isProcessAlive,
  killProcessTree,
  removeTree,
  TurnInterruptedError,
  type ProcessConfig,
  type TurnRunner,
} from '@dsh-brain-core/satellite-host'
import { FakeDeepSeek, type FakeScript } from '../src/fake-deepseek.ts'
import { DEMO_TOOLS, FLASH_LOW } from '../src/rig.ts'

const chatSession = (channel: string): string => encodeSessionId({ agentClass: 'chat', channel: `test:chat:${channel}`, generation: 0 })

const CONFIG: ProcessConfig = { selection: FLASH_LOW, apiKey: 'fake-key', systemPrompt: 'You are a test persona.', catalog: DEMO_TOOLS }

async function waitForExit(pid: number): Promise<void> {
  for (let i = 0; i < 100 && isProcessAlive(pid); i += 1) await sleep(100)
  assert.equal(isProcessAlive(pid), false, `process ${pid} is still alive`)
}

interface Stack {
  readonly brainHome: string
  readonly gateway: FakeDeepSeek
  readonly runner: TurnRunner
  readonly factory: ReturnType<typeof createRealSatelliteFactory>
  /** The pid of the chat child as the supervisor's own satellite sees it. */
  readonly spawned: { pid: number | undefined }[]
}

async function withStack(script: FakeScript, options: { readonly turnTimeoutMs?: number; readonly maxConcurrentTurns?: number }, body: (stack: Stack) => Promise<void>): Promise<void> {
  const brainHome = await mkdtemp(path.join(os.tmpdir(), 'brain-e9-'))
  const gateway = new FakeDeepSeek(script)
  await gateway.listen()
  const factory = createRealSatelliteFactory({
    brainHome,
    surfaceOf: () => new Set(['demo__a']),
    dispatch: async ({ toolName }) => `ran ${toolName}`,
    baseUrl: gateway.url,
  })
  const spawned: { pid: number | undefined }[] = []
  const runner = createSupervisor({
    factory: async (agentClass, config) => {
      const satellite = await factory(agentClass, config)
      const entry: { pid: number | undefined } = { pid: undefined }
      spawned.push(entry)
      return {
        get pid() {
          entry.pid = satellite.pid
          return satellite.pid
        },
        get deniedApprovals() {
          return satellite.deniedApprovals
        },
        start: () => satellite.start(),
        open: id => satellite.open(id),
        run: (id, input, runOptions) => satellite.run(id, input, runOptions),
        close: () => satellite.close(),
      }
    },
    config: async () => CONFIG,
    purge: async () => [],
    now: () => Date.now(),
    maxConcurrentTurns: options.maxConcurrentTurns ?? 2,
    idleCloseMs: 600_000,
    turnTimeoutMs: { chat: options.turnTimeoutMs ?? 60_000, activity: 60_000 },
    restart: { baseMs: 1000, maxMs: 16_000, maxFailures: 5, windowMs: 120_000 },
    purgeFile: path.join(brainHome, 'state', 'agent', 'purge.json'),
  })
  try {
    await body({ brainHome, gateway, runner, factory, spawned })
  } finally {
    await runner.close()
    await gateway.close()
    await removeTree(brainHome)
  }
}

test('a killed child is replaced within 30 seconds and the queued turn runs (NFR-04)', async () => {
  let hangNext = false
  const script: FakeScript = () => {
    if (!hangNext) return { text: 'done' }
    hangNext = false
    return { hang: true }
  }
  // One slot, so the second turn really is queued behind the one that gets cut off.
  await withStack(script, { maxConcurrentTurns: 1 }, async ({ runner, spawned, gateway }) => {
    const session = chatSession('kill')
    assert.equal((await runner.run('chat', session, 'first message')).finalResponse, 'done')
    const pid = spawned[0]?.pid as number
    assert.equal(isProcessAlive(pid), true)

    hangNext = true
    const running = runner.run('chat', session, 'this one is cut off')
    const running_ = assert.rejects(running, TurnInterruptedError)
    const queuedSession = chatSession('kill-queued')
    // Wait until the model has the request, so the kill lands in the middle of the turn.
    const requestsBefore = gateway.requests.length
    for (let i = 0; i < 100 && gateway.requests.length === requestsBefore; i += 1) await sleep(50)
    const queued = runner.run('chat', queuedSession, 'queued behind the crash')
    const startedAt = Date.now()
    await killProcessTree(pid)
    await running_
    const result = await queued
    assert.equal(result.finalResponse, 'done')
    assert.ok(Date.now() - startedAt < 30_000, 'recovered within 30 seconds')
    assert.equal(spawned.length, 2, 'one new process')
    await waitForExit(pid)

    // The session that was cut off carries on in the new process with its history.
    await runner.run('chat', session, 'second message')
    const last = gateway.requests.at(-1)
    assert.match(last?.raw ?? '', /first message/)
    assert.match(last?.raw ?? '', /second message/)
  })
})

test('a child found dead between turns is replaced and the turn runs', async () => {
  await withStack(() => ({ text: 'done' }), {}, async ({ runner, spawned }) => {
    const session = chatSession('dead')
    await runner.run('chat', session, 'one')
    const pid = spawned[0]?.pid as number
    await killProcessTree(pid)
    await waitForExit(pid)
    assert.equal((await runner.run('chat', session, 'two')).finalResponse, 'done')
    assert.equal(spawned.length, 2)
  })
})

test('after a turn times out, the session carries on in a new process', async () => {
  let hang = true
  const script: FakeScript = () => (hang ? { hang: true } : { text: 'recovered' })
  await withStack(script, { turnTimeoutMs: 1500 }, async ({ runner, gateway, spawned }) => {
    const session = chatSession('timeout')
    await assert.rejects(runner.run('chat', session, 'this will hang'), (error: unknown) => {
      assert.ok(error instanceof TurnInterruptedError)
      assert.equal(error.reason, 'timeout')
      return true
    })
    const pid = spawned[0]?.pid as number
    await waitForExit(pid)
    hang = false
    const result = await runner.run('chat', session, 'try again')
    assert.equal(result.finalResponse, 'recovered')
    assert.equal(spawned.length, 2)
    assert.match(gateway.requests.at(-1)?.raw ?? '', /try again/)
  })
})

test('close leaves no child behind', async () => {
  await withStack(() => ({ text: 'done' }), {}, async ({ runner, spawned }) => {
    await runner.run('chat', chatSession('close'), 'hello')
    await runner.run('activity', encodeSessionId({ agentClass: 'activity', channel: 'test:feed:close', generation: 0 }), 'hello')
    const pids = spawned.map(entry => entry.pid as number)
    assert.equal(pids.length, 2)
    for (const pid of pids) assert.equal(isProcessAlive(pid), true)
    await runner.close()
    for (const pid of pids) await waitForExit(pid)
  })
})

test('open says new for a session that is not on disk, and resumed once it is', async () => {
  await withStack(() => ({ text: 'done' }), {}, async ({ factory }) => {
    const session = chatSession('open')
    const first = await factory('chat', CONFIG)
    try {
      await first.start()
      assert.equal(await first.open(session), 'new')
      await first.run(session, 'remember this')
    } finally {
      await first.close()
    }
    const second = await factory('chat', CONFIG)
    try {
      await second.start()
      assert.equal(await second.open(session), 'resumed')
      assert.equal((await second.run(session, 'and this')).finalResponse, 'done')
    } finally {
      await second.close()
    }
  })
})

test('a result carries the per-step usage the gateway reported', async () => {
  await withStack(() => ({ text: 'done' }), {}, async ({ factory }) => {
    const satellite = await factory('chat', CONFIG)
    try {
      await satellite.start()
      const result = await satellite.run(chatSession('usage'), 'hello')
      assert.equal(result.finalResponse, 'done')
      assert.ok(result.steps.length >= 1)
      assert.equal(result.retries, 0)
      assert.equal(result.compacted, false)
    } finally {
      await satellite.close()
    }
  })
})

test('the factory hands the catalog, the session surface and the system prompt to the child', async () => {
  const brainHome = await mkdtemp(path.join(os.tmpdir(), 'brain-e9-wiring-'))
  const gateway = new FakeDeepSeek(() => ({ text: 'done' }))
  await gateway.listen()
  const session = chatSession('wiring')
  const factory = createRealSatelliteFactory({
    brainHome,
    surfaceOf: id => new Set(id === session ? ['wiring__lantern'] : []),
    dispatch: async () => 'ok',
    baseUrl: gateway.url,
  })
  const config: ProcessConfig = {
    ...CONFIG,
    systemPrompt: 'You are Mothkeeper, who answers only in lowercase.',
    catalog: [{ name: 'wiring__lantern', description: 'Lights a lantern.', parameters: { text: { type: 'string' } } }],
  }
  const satellite = await factory('chat', config)
  try {
    await satellite.start()
    await satellite.open(session)
    await satellite.run(session, 'hello')
    // On this first turn the model's tool list and system prompt are request fields, not part of the messages.
    const last = gateway.requests.at(-1)
    assert.deepEqual(last?.tools, ['wiring__lantern'], 'the tool in the catalog and on the surface reaches the model')
    assert.equal(last?.system, 'You are Mothkeeper, who answers only in lowercase.', 'the system prompt reaches the model')
  } finally {
    await satellite.close()
    await gateway.close()
    await removeTree(brainHome)
  }
})
