import assert from 'node:assert/strict'
import dns from 'node:dns'
import http, { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { createHttpMemoryPageApi, createMemoryPageController } from '@dsh-brain-core/console'
import type { Envelope, WakeResult } from '@dsh-brain-core/sdk'
import {
  CONSOLE_CHAT_DIR, FLASH_LOW, WEB_READER_DIR, assertUnwrappedOk, closeHttpServer,
  extractLatestWakeText, hasToolResultInLastMessage, httpJson, installAndEnablePlugin,
  setupAcceptanceKernel, waitFor,
} from './helpers.ts'

const SCHEDULER_TICK_MS = 30_000
const ARTICLE_URL = 'http://science.example.com/optogenetics.html'
const ARTICLE_HTML = `<!DOCTYPE html>
<html>
<head><title>光遗传学：用光控制神经元</title></head>
<body>
  <article>
    <h1>光遗传学：用光控制神经元</h1>
    <p>通道视紫红质 ChR2 在蓝光照射下打开阳离子通道，使神经元发生去极化并产生动作电位。</p>
  </article>
</body>
</html>`

interface TimerCapture {
  run(ms: number): void
  has(ms: number): boolean
  restore(): void
}

function captureIntervals(): TimerCapture {
  const originalSet = globalThis.setInterval
  const originalClear = globalThis.clearInterval
  const active = new Map<object, { readonly callback: () => void; readonly ms: number }>()
  globalThis.setInterval = ((callback: () => void, ms: number) => {
    const handle = { unref() {} }
    active.set(handle, { callback, ms })
    return handle as unknown as ReturnType<typeof setInterval>
  }) as typeof setInterval
  globalThis.clearInterval = ((handle: object) => {
    active.delete(handle)
  }) as typeof clearInterval
  return {
    run(ms) {
      for (const timer of [...active.values()]) {
        if (timer.ms === ms) timer.callback()
      }
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

test('AT-2: web-reader ownTime writes L0.3 + L1.7 and console-chat recalls it with traceable evidence', async (t) => {
  // Local mock server for science.example.com article
  const articleServer = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(ARTICLE_HTML)
  })
  await new Promise<void>((resolve) => {
    articleServer.listen(0, '127.0.0.1', () => resolve())
  })
  const articlePort = (articleServer.address() as AddressInfo).port
  t.after(async () => { await closeHttpServer(articleServer) })

  // Route only science.example.com through the local article server so web-reader's
  // public-URL check and kernel's guardedFetch run unmodified without real internet access.
  const origLookup = dns.promises.lookup
  const origHttpRequest = http.request
  dns.promises.lookup = (async (hostname: string, options?: unknown) => {
    if (hostname === 'science.example.com') {
      const opts = (typeof options === 'object' && options !== null ? options : {}) as { all?: boolean }
      if (opts.all === true) return [{ address: '93.184.216.34', family: 4 }]
      return { address: '93.184.216.34', family: 4 }
    }
    return origLookup(hostname, options as never)
  }) as typeof dns.promises.lookup

  http.request = ((url: unknown, options?: unknown, cb?: unknown) => {
    if (url instanceof URL && url.hostname === 'science.example.com') {
      const target = new URL(`http://127.0.0.1:${articlePort}${url.pathname}${url.search}`)
      const optsObj = (typeof options === 'object' && options !== null ? { ...options } : {}) as Record<string, unknown>
      delete optsObj.lookup
      delete optsObj.servername
      return (origHttpRequest as (...args: unknown[]) => ReturnType<typeof http.request>)(target, optsObj, cb)
    }
    return (origHttpRequest as (...args: unknown[]) => ReturnType<typeof http.request>)(url, options, cb)
  }) as typeof http.request

  t.after(() => {
    dns.promises.lookup = origLookup
    http.request = origHttpRequest
  })

  // Clock at 12:00 UTC (outside quiet hours [3, 8])
  const now = Date.UTC(2026, 10, 16, 12, 0, 0)
  let searchedOnce = false
  let sentOnce = false
  let sawSearchResult = ''

  const timers = captureIntervals()
  let h: Awaited<ReturnType<typeof setupAcceptanceKernel>>
  try {
    h = await setupAcceptanceKernel(t, {
      crossChannel: 'on',
      clock: { now: () => now },
      settings: {
        agents: { chat: { ...FLASH_LOW }, activity: { ...FLASH_LOW } },
        timezone: 'UTC',
        quietHours: [3, 8],
        ownTimePerDay: 6,
      },
      apiKey: 'fake-at2-key',
      roleCard: '你是小满，喜欢看科普文章，回答准确。',
      withConsole: true,
      script: (request) => {
        const wakeText = extractLatestWakeText(request)
        // Activity wake from web-reader: silent, no tool calls
        if (wakeText.includes('reason="web-read"')) {
          return { text: '记住了。' }
        }
        // Chat wake: step 1 search memory__search, step 2 send_message, step 3 done
        if (!searchedOnce) {
          searchedOnce = true
          return { tool: 'memory__search', input: { query: '光遗传学', scope: 'all' } }
        }
        if (hasToolResultInLastMessage(request) && !sentOnce) {
          sawSearchResult = request.raw
          sentOnce = true
          return {
            tool: 'console-chat__send_message',
            input: {
              text: '我刚看了《光遗传学：用光控制神经元》，讲的是通道视紫红质 ChR2 在蓝光照射下打开阳离子通道。',
            },
          }
        }
        return { text: '好。' }
      },
    })
  } finally {
    timers.restore()
  }

  assert.equal(timers.has(SCHEDULER_TICK_MS), true, 'kernel scheduler timer must be registered')
  await installAndEnablePlugin(h.kernel, WEB_READER_DIR, 'web-reader', {
    feeds: [ARTICLE_URL],
    everyMs: 3_600_000,
  })
  await installAndEnablePlugin(h.kernel, CONSOLE_CHAT_DIR, 'console-chat')

  // Trigger scheduler tick so web-reader's ownTime executes
  timers.run(SCHEDULER_TICK_MS)

  const records = await waitFor(async () => {
    const l0Page = await h.kernel.memory.store.list(
      { layers: ['L0'], kinds: ['web-reader.article'], channels: ['web-reader:feed:default'] },
      { limit: 10 },
    )
    const l1Page = await h.kernel.memory.store.list(
      { layers: ['L1'], kinds: ['l1.knowledge'], channels: ['web-reader:feed:default'] },
      { limit: 10 },
    )
    if (l0Page.items.length >= 1 && l1Page.items.length >= 1) {
      return { l0: l0Page.items[0]!, l1: l1Page.items[0]! }
    }
    return undefined
  }, 30_000, 'web-reader L0.3 and L1.7 records')

  assert.equal(records.l0.kind, 'web-reader.article')
  assert.equal(records.l0.source, 'web-reader')
  assert.equal(records.l0.channel, 'web-reader:feed:default')
  assert.equal(records.l0.trust, 'external')
  assert.equal(records.l0.visibility, 'open')

  assert.equal(records.l1.kind, 'l1.knowledge')
  assert.equal(records.l1.source, 'web-reader')
  assert.equal(records.l1.trust, 'external')
  assert.equal(records.l1.visibility, 'open')
  assert.deepEqual(records.l1.evidence, [{ id: records.l0.id }])

  // Verify activity silent wake happened without triggering any external tool calls
  await waitFor(
    () => (h.fake.requests.some((r) => r.raw.includes('web-read')) ? true : undefined),
    30_000,
    'activity web-read wake',
  )
  const webReadRequests = h.fake.requests.filter((r) => r.raw.includes('web-read'))
  assert.equal(webReadRequests.length, 1, 'activity web-read wake must complete in 1 step with no tool calls')

  // Ask in console-chat
  const chatRes = await httpJson<Envelope<{ readonly wake: WakeResult }>>(
    h.kernel.port,
    'POST',
    '/api/v1/plugins/console-chat/messages',
    {
      token: h.token,
      body: {
        channel: 'console-chat:private:owner',
        account: 'owner',
        displayName: '主人',
        text: '你最近看了什么',
        messageId: 'at2-q1',
        tEvent: now + 1_000,
        debounceMs: 0,
      },
    },
  )
  assert.equal(chatRes.status, 200)
  const chatData = assertUnwrappedOk(chatRes.body)
  assert.equal(chatData.wake.acked, true)
  assert.equal(chatData.wake.sent, 1)
  assert.ok(sawSearchResult.includes(records.l1.id), 'memory__search must return the L1.7 knowledge record')

  // Verify GET /api/v1/plugins/console-chat/messages
  const msgListRes = await httpJson<Envelope<{
    readonly items: readonly { readonly direction: string; readonly text: string }[]
  }>>(
    h.kernel.port,
    'GET',
    '/api/v1/plugins/console-chat/messages?channel=console-chat%3Aprivate%3Aowner',
    { token: h.token },
  )
  assert.equal(msgListRes.status, 200)
  const msgList = assertUnwrappedOk(msgListRes.body)
  const outbound = msgList.items.filter((item) => item.direction === 'outbound')
  assert.equal(outbound.length, 1)
  assert.ok(outbound[0]!.text.includes('光遗传学：用光控制神经元'))
  assert.ok(outbound[0]!.text.includes('ChR2'))

  // Verify evidence chain via MemoryService and Console Memory Page API
  const consoleBaseUrl = `http://127.0.0.1:${h.consolePort!}`
  const memoryApi = createHttpMemoryPageApi(consoleBaseUrl, h.token)
  const memoryController = createMemoryPageController(memoryApi)
  await memoryController.selectRecord(records.l1.id)
  const chain = memoryController.state().evidenceChain
  assert.ok(chain !== null, 'console memory controller must resolve evidenceChain')
  assert.equal(chain.record.id, records.l1.id)
  assert.equal(chain.children.length, 1)
  assert.equal(chain.children[0]!.record.id, records.l0.id)
  assert.equal(chain.children[0]!.record.layer, 'L0')
  assert.ok(JSON.stringify(chain.children[0]!.record.content).includes('通道视紫红质 ChR2'))
})
