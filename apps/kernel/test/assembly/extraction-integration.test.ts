import assert from 'node:assert/strict'
import test from 'node:test'
import { createKernel, type Kernel } from '../../src/assembly.ts'
import type { Job } from '../../src/memory-api/index.ts'
import { FLASH, TOKEN, capturingLogger, httpGet, setup, waitFor, type Harness, type LogEntry } from './helpers.ts'

const TEN_MINUTES = 600_000

interface Captured { readonly callback: () => void; readonly ms: number }

function captureIntervals(): { captured: Captured[]; restore: () => void } {
  const original = globalThis.setInterval
  const captured: Captured[] = []
  globalThis.setInterval = ((callback: () => void, ms: number) => {
    captured.push({ callback, ms })
    return { unref() { /* explicit no-op */ } } as unknown as ReturnType<typeof setInterval>
  }) as typeof setInterval
  return { captured, restore: () => { globalThis.setInterval = original } }
}

interface TrackedTimers {
  run(ms: number): void
  has(ms: number): boolean
  restore(): void
}

/** Unlike captureIntervals, clearInterval really removes a timer here, which is what `stop` must do. */
function trackTimers(): TrackedTimers {
  const originalSet = globalThis.setInterval
  const originalClear = globalThis.clearInterval
  const active = new Map<object, Captured>()
  globalThis.setInterval = ((callback: () => void, ms: number) => {
    const handle = { unref() { /* the test drives the timers */ } }
    active.set(handle, { callback, ms })
    return handle as unknown as ReturnType<typeof setInterval>
  }) as typeof setInterval
  globalThis.clearInterval = ((handle: object) => { active.delete(handle) }) as typeof clearInterval
  return {
    run(ms) {
      for (const timer of [...active.values()]) if (timer.ms === ms) timer.callback()
    },
    has(ms) {
      return [...active.values()].some((timer) => timer.ms === ms)
    },
    restore() {
      globalThis.setInterval = originalSet
      globalThis.clearInterval = originalClear
    },
  }
}

const EXTRACT = '以下是对话记录'

function factReply(request: { raw: string }): { text: string } {
  const ids = [...request.raw.matchAll(/l0_[0-9A-Z]{26}/g)].map((match) => match[0])
  if (ids.length === 0) return { text: '{"facts":[]}' }
  return {
    text: JSON.stringify({
      facts: [{
        kind: 'l1.fact', text: '她喜欢苹果', subjects: ['p1'], evidence: [ids[0]], confidence: 0.9,
        key: '喜欢的水果', value: '苹果',
      }],
    }),
  }
}

async function waitForJob(h: Harness, before: number): Promise<Job> {
  const entry: LogEntry = await waitFor(
    () => h.logs.slice(before).find((item) => item.event === 'extraction_timer.started'),
    30_000, 'the extraction timer to start a job',
  )
  const id = entry.fields?.requestId
  assert.ok(typeof id === 'string')
  return await waitFor(() => {
    const job = h.kernel.memory.jobs.get(id as string)
    return job.status === 'done' || job.status === 'failed' ? job : undefined
  }, 60_000, 'the extraction job to finish')
}

async function l1Texts(h: Harness): Promise<string[]> {
  const texts: string[] = []
  for await (const record of h.kernel.memory.store.scan(['L1'])) {
    if (record.status === 'active' && typeof record.content.text === 'string') texts.push(record.content.text)
  }
  return texts
}

test('the timer skips a record inside settleMs and extracts it once the talk has settled', async (t) => {
  let now = Date.now()
  const clock = { now: () => now }
  const { captured, restore } = captureIntervals()
  let h: Harness
  try {
    h = await setup(t, {
      settings: { agents: { chat: { ...FLASH }, activity: { ...FLASH } }, timezone: 'UTC' },
      apiKey: 'fake-key',
      clock,
      script: (request) => request.raw.includes(EXTRACT)
        ? factReply(request)
        : { text: '好。' },
    })
  } finally {
    restore()
  }
  const timer = captured.find((interval) => interval.ms === TEN_MINUTES)
  assert.ok(timer, 'the extraction timer exists when the activity model is chosen')

  const { id } = await h.kernel.memory.service.ingest(
    { kind: 'sample.message', channel: 'sample:private:u1', subjects: [], actor: 'p1', content: { text: '我喜欢苹果' }, tEvent: now, idempotencyKey: 'm1' },
    { kind: 'kernel', source: 'test', trust: 'owner', defaultVisibility: 'owner' },
  )

  let before = h.logs.length
  timer.callback()
  const quiet = await waitForJob(h, before)
  assert.equal(quiet.status, 'done')
  assert.deepEqual(await l1Texts(h), [], 'a record inside settleMs is not extracted')

  now += TEN_MINUTES + 60_000
  before = h.logs.length
  timer.callback()
  const settled = await waitForJob(h, before)
  assert.equal(settled.status, 'done')
  const texts = await l1Texts(h)
  assert.ok(texts.includes('她喜欢苹果'))
  const l1 = (await (async () => {
    const found = []
    for await (const record of h.kernel.memory.store.scan(['L1'])) if (record.status === 'active') found.push(record)
    return found
  })())[0]
  assert.deepEqual(l1?.evidence.map((reference) => reference.id), [id])
})

test('an incomplete reply leaves the batch unprocessed and the next run sends it again', async (t) => {
  let now = Date.now()
  const clock = { now: () => now }
  let truncate = true
  const { captured, restore } = captureIntervals()
  let h: Harness
  try {
    h = await setup(t, {
      settings: { agents: { chat: { ...FLASH }, activity: { ...FLASH } }, timezone: 'UTC' },
      apiKey: 'fake-key',
      clock,
      script: (request) => {
        if (!request.raw.includes(EXTRACT)) return { text: '好。' }
        if (truncate) {
          truncate = false
          return { text: '{"facts":[' }
        }
        return factReply(request)
      },
    })
  } finally {
    restore()
  }
  const timer = captured.find((interval) => interval.ms === TEN_MINUTES)
  assert.ok(timer)

  await h.kernel.memory.service.ingest(
    { kind: 'sample.message', channel: 'sample:private:u1', subjects: [], actor: 'p1', content: { text: '我喜欢苹果' }, tEvent: now, idempotencyKey: 'm1' },
    { kind: 'kernel', source: 'test', trust: 'owner', defaultVisibility: 'owner' },
  )
  now += TEN_MINUTES + 60_000

  let before = h.logs.length
  timer.callback()
  const first = await waitForJob(h, before)
  assert.equal(first.status, 'done')
  assert.equal((first.result as { incompleteBatches?: number }).incompleteBatches, 1)
  assert.deepEqual(await l1Texts(h), [])

  const firstBatch = h.fake.requests.find((request) => request.raw.includes(EXTRACT))
  assert.ok(firstBatch)
  const batchId = /l0_[0-9A-Z]{26}/.exec(firstBatch.raw)?.[0] as string
  assert.ok(batchId)

  before = h.logs.length
  timer.callback()
  const second = await waitForJob(h, before)
  assert.equal(second.status, 'done')
  const secondBatch = h.fake.requests.filter((request) => request.raw.includes(EXTRACT)).at(-1)!
  assert.ok(secondBatch.raw.includes(batchId), 'the incomplete batch was sent again')
  assert.ok((await l1Texts(h)).includes('她喜欢苹果'))
})

test('without an activity model the kernel starts, has no timer and refuses an extract job', async (t) => {
  const { captured, restore } = captureIntervals()
  let h: Harness
  try {
    h = await setup(t, { settings: { agents: { chat: { ...FLASH } } } })
  } finally {
    restore()
  }
  assert.equal(captured.some((interval) => interval.ms === TEN_MINUTES), false)
  assert.equal(await (await httpGet(h.kernel, '/api/v1/memory/health')).status, 200)
  let error: unknown
  try { h.kernel.memory.jobs.start({ type: 'extract', from: 0, to: 1 }) } catch (caught) { error = caught }
  assert.ok(error instanceof Error)
  assert.equal((error as { code?: string }).code, 'UNAVAILABLE')
})

test('memory switches apply live and persist without changing the startup defaults for a new home', async (t) => {
  const timers = trackTimers()
  const automationRoute = '/api/v1/console/memory/automation'
  const crossChannelRoute = '/api/v1/console/memory/cross-channel'
  function put(kernel: Kernel, route: string, body: object): Promise<Response> {
    return fetch(`http://127.0.0.1:${kernel.port}${route}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }
  let restarted: Kernel | undefined
  try {
    const h = await setup(t, { settings: { agents: { chat: FLASH } }, apiKey: 'fake-key' })
    assert.equal(h.kernel.getCrossChannelMode(), 'shadow')
    assert.equal((await put(h.kernel, automationRoute, { enabled: true })).status, 503)
    assert.equal((await put(h.kernel, automationRoute, { enabled: false })).status, 200)
    await h.kernel.settings.write({ agents: { chat: FLASH, activity: FLASH } })
    await h.kernel.refreshMemoryAutomation()
    assert.equal(timers.has(TEN_MINUTES), false)
    assert.equal((await put(h.kernel, automationRoute, { enabled: true })).status, 200)
    assert.equal(timers.has(TEN_MINUTES), true)
    assert.equal((await put(h.kernel, crossChannelRoute, { mode: 'on' })).status, 200)
    assert.equal(h.kernel.getCrossChannelMode(), 'on')
    assert.equal((await put(h.kernel, automationRoute, { enabled: false })).status, 200)
    assert.equal(timers.has(TEN_MINUTES), false)
    await h.kernel.close()
    restarted = await createKernel({
      env: { ...process.env, BRAIN_HOME: h.home },
      userHome: h.home,
      port: 0,
      crossChannel: 'shadow',
      token: TOKEN,
      log: capturingLogger([]),
    })
    assert.equal(restarted.getCrossChannelMode(), 'on')
    const { data } = await (await httpGet(restarted, automationRoute)).json() as { data: unknown }
    assert.deepEqual(data, { enabled: false, activityConfigured: true, modelKeyConfigured: true })
    assert.equal(timers.has(TEN_MINUTES), false)
  } finally {
    await restarted?.close()
    timers.restore()
  }
})

test('close stops the extraction timer before the rest of the kernel goes away', async (t) => {
  const timers = trackTimers()
  try {
    const h = await setup(t, {
      settings: { agents: { chat: { ...FLASH }, activity: { ...FLASH } }, timezone: 'UTC' },
      apiKey: 'fake-key',
    })
    assert.equal(timers.has(TEN_MINUTES), true, 'the activity model created the extraction timer')
    const before = h.logs.filter((entry) => entry.event === 'extraction_timer.started').length

    // The fake timers stay installed through close, so its clearInterval is the one being asserted.
    await h.kernel.close()

    assert.equal(timers.has(TEN_MINUTES), false, 'close cleared the extraction interval')
    timers.run(TEN_MINUTES)
    assert.equal(h.logs.filter((entry) => entry.event === 'extraction_timer.started').length, before)
  } finally {
    timers.restore()
  }
})
