import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { BrainError, type BrainContext, type ChannelProvider } from '@dsh-brain-core/sdk'
import { checkPlugin, createTestKernel, runPluginContractTests } from '@dsh-brain-core/testkit'
import { apply, createConsoleChatDebouncer, type ChatHistoryEntry } from '../src/index.ts'
import { renderChatUiHtml } from '../src/ui.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(HERE, '..')

async function readPackageJson(): Promise<{ readonly dependencies: Record<string, string>; readonly brain: unknown }> {
  const raw = await readFile(path.join(PLUGIN_ROOT, 'package.json'), 'utf8')
  return JSON.parse(raw) as { readonly dependencies: Record<string, string>; readonly brain: unknown }
}

function captureApply(): {
  readonly wrappedApply: (ctx: BrainContext, config: Readonly<Record<string, unknown>>) => Promise<void> | void
  readonly getProvider: () => ChannelProvider
  readonly getPages: () => readonly { readonly id: string; readonly title: string; readonly entry: string }[]
} {
  let capturedProvider: ChannelProvider | undefined
  const pages: { readonly id: string; readonly title: string; readonly entry: string }[] = []
  const wrappedApply = (ctx: BrainContext, config: Readonly<Record<string, unknown>>): Promise<void> | void => {
    const wrappedCtx: BrainContext = {
      ...ctx,
      channel: {
        ...ctx.channel,
        provide: (provider) => {
          capturedProvider = provider
          return ctx.channel.provide(provider)
        },
      },
      console: {
        page: (descriptor) => {
          pages.push(descriptor)
          return ctx.console.page(descriptor)
        },
      },
    }
    return apply(wrappedCtx, config)
  }
  return {
    wrappedApply,
    getProvider: () => {
      assert.ok(capturedProvider !== undefined, 'channel provider should be registered')
      return capturedProvider
    },
    getPages: () => pages,
  }
}

describe('plugin-console-chat', () => {
  it('passes all 7 contract checks and brain plugin check with 0 violations', async () => {
    const pkg = await readPackageJson()
    assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@dsh-brain-core/chat-kit', '@dsh-brain-core/sdk'])

    const contract = await runPluginContractTests({ apply }, pkg.brain)
    for (const item of contract) {
      assert.equal(item.ok, true, `${item.name}: ${item.message}`)
    }
    assert.equal(contract.length, 7)

    const report = await checkPlugin(PLUGIN_ROOT)
    assert.equal(report.ok, true, JSON.stringify(report.findings))
    assert.equal(report.findings.filter((f) => f.level === 'must').length, 0)
    assert.equal(report.findings.filter((f) => f.level === 'should').length, 0)
  })

  it('ingests inbound and outbound messages into L0 and serves ordered history', async () => {
    const pkg = await readPackageJson()
    const kernel = createTestKernel()
    const captured = captureApply()
    await kernel.loadPlugin({ apply: captured.wrappedApply }, pkg.brain)

    assert.deepEqual(captured.getPages(), [
      { id: 'chat', title: '与她对话', entry: '/api/v1/plugins/console-chat/ui' },
    ])

    kernel.useAgent(async (_wake, helpers) => {
      const result = await helpers.callTool('console-chat__send_message', {
        text: '你好呀',
        replyTo: 'm1',
      })
      assert.equal(result, 'sent')
    })

    const post = await kernel.http('POST', '/api/v1/plugins/console-chat/messages', {
      channel: 'console-chat:private:owner',
      account: 'owner',
      displayName: '小源',
      text: '在吗',
      messageId: 'm1',
      tEvent: 1700000000000,
    })
    assert.equal(post.ok, true)
    if (!post.ok) return
    const postData = post.data as { readonly recordId: string; readonly personId: string; readonly messageId: string }
    assert.equal(postData.messageId, 'm1')
    assert.equal(postData.personId, 'console-chat:owner')

    const records = kernel.records()
    assert.equal(records.length, 2)
    const inbound = records[0]!
    const outbound = records[1]!
    assert.equal(inbound.layer, 'L0')
    assert.equal(inbound.actor, postData.personId)
    assert.equal(inbound.content.direction, 'inbound')
    assert.equal(inbound.content.text, '在吗')
    assert.equal(outbound.layer, 'L0')
    assert.equal(outbound.actor, 'self')
    assert.equal(outbound.content.direction, 'outbound')
    assert.equal(outbound.content.text, '你好呀')
    assert.equal(outbound.content.replyTo, 'm1')

    const historyRes = await kernel.http('GET', '/api/v1/plugins/console-chat/messages?channel=console-chat:private:owner')
    assert.equal(historyRes.ok, true)
    if (!historyRes.ok) return
    const historyData = historyRes.data as { readonly channel: string; readonly items: readonly ChatHistoryEntry[] }
    assert.equal(historyData.channel, 'console-chat:private:owner')
    assert.equal(historyData.items.length, 2)
    assert.equal(historyData.items[0]!.direction, 'inbound')
    assert.equal(historyData.items[0]!.text, '在吗')
    assert.equal(historyData.items[1]!.direction, 'outbound')
    assert.equal(historyData.items[1]!.text, '你好呀')
    assert.equal(historyData.items[1]!.replyTo, 'm1')
  })

  it('implements channel provider members, resolveIdentity, and monotonic send', async () => {
    const pkg = await readPackageJson()
    const kernel = createTestKernel()
    const captured = captureApply()
    await kernel.loadPlugin({ apply: captured.wrappedApply }, pkg.brain)
    const provider = captured.getProvider()

    assert.deepEqual(await provider.resolveIdentity('console-chat:owner'), { displayName: '主人' })
    assert.equal(await provider.resolveIdentity('console-chat:unknown'), null)
    assert.equal(await provider.resolveIdentity('qq:12345'), null)
    assert.deepEqual(await provider.members('console-chat:private:owner'), [])

    await kernel.http('POST', '/api/v1/plugins/console-chat/messages', {
      channel: 'console-chat:private:owner',
      account: 'owner',
      displayName: '小源',
      text: '更新名片',
    })
    assert.deepEqual(await provider.resolveIdentity('console-chat:owner'), { displayName: '小源' })
    assert.deepEqual(await provider.members('console-chat:private:owner'), ['console-chat:owner'])

    await kernel.http('POST', '/api/v1/plugins/console-chat/messages', {
      channel: 'console-chat:group:room1',
      account: 'console-chat:alice',
      displayName: 'Alice',
      text: '大家好',
    })
    assert.deepEqual(await provider.resolveIdentity('console-chat:alice'), { displayName: 'Alice' })
    assert.deepEqual(await provider.members('console-chat:group:room1'), ['console-chat:alice'])

    const first = await provider.send('console-chat:private:owner', { text: 'a' })
    const second = await provider.send('console-chat:private:owner', { text: 'b' })
    assert.notEqual(first.messageId, second.messageId)
    await assert.rejects(
      () => provider.send('qq:private:1', { text: 'x' }),
      (error: unknown) => error instanceof BrainError && error.code === 'INVALID_ARGUMENT',
    )
  })

  it('enforces idempotency, defaults, and parameter validation', async () => {
    const pkg = await readPackageJson()
    const kernel = createTestKernel()
    let wakeCount = 0
    kernel.useAgent(async (wake, helpers) => {
      wakeCount += 1
      assert.equal(wake.input.debounceMs, 250)
      await helpers.callTool('console-chat__send_message', { text: '收到' })
    })
    await kernel.loadPlugin({ apply }, pkg.brain)

    const first = await kernel.http('POST', '/api/v1/plugins/console-chat/messages', {
      text: '默认参数测试',
      messageId: 'dup-1',
      debounceMs: 250,
    })
    assert.equal(first.ok, true)
    assert.equal(wakeCount, 1)
    assert.equal(kernel.records().length, 2)

    const duplicate = await kernel.http('POST', '/api/v1/plugins/console-chat/messages', {
      text: '默认参数测试',
      messageId: 'dup-1',
      debounceMs: 250,
    })
    assert.equal(duplicate.ok, true)
    assert.equal(wakeCount, 1)
    assert.equal(kernel.records().length, 2)

    const historyRes = await kernel.http('GET', '/api/v1/plugins/console-chat/messages')
    assert.equal(historyRes.ok, true)
    if (historyRes.ok) {
      const items = (historyRes.data as { readonly items: readonly ChatHistoryEntry[] }).items
      assert.equal(items.length, 2)
    }

    const otherChannel = await kernel.http('POST', '/api/v1/plugins/console-chat/messages', {
      channel: 'console-chat:group:g1',
      text: '另一个通道同 id',
      messageId: 'dup-1',
      debounceMs: 250,
    })
    assert.equal(otherChannel.ok, true)
    assert.equal(wakeCount, 2)

    const invalidCases: readonly { readonly method: string; readonly url: string; readonly body?: unknown }[] = [
      { method: 'POST', url: '/api/v1/plugins/console-chat/messages', body: null },
      { method: 'POST', url: '/api/v1/plugins/console-chat/messages', body: { text: '   ' } },
      { method: 'POST', url: '/api/v1/plugins/console-chat/messages', body: { text: 'ok', channel: 'qq:private:1' } },
      { method: 'POST', url: '/api/v1/plugins/console-chat/messages', body: { text: 'ok', channel: 'console-chat:private:' } },
      { method: 'POST', url: '/api/v1/plugins/console-chat/messages', body: { text: 'ok', channel: 'console-chat:private:a b' } },
      { method: 'POST', url: '/api/v1/plugins/console-chat/messages', body: { text: 'ok', account: 'a b' } },
      { method: 'POST', url: '/api/v1/plugins/console-chat/messages', body: { text: 'ok', displayName: 123 } },
      { method: 'POST', url: '/api/v1/plugins/console-chat/messages', body: { text: 'ok', tEvent: Number.NaN } },
      { method: 'POST', url: '/api/v1/plugins/console-chat/messages', body: { text: 'ok', debounceMs: -1 } },
      { method: 'POST', url: '/api/v1/plugins/console-chat/messages', body: { text: 'ok', messageId: '' } },
      { method: 'GET', url: '/api/v1/plugins/console-chat/messages?channel=bad:channel:1' },
      { method: 'GET', url: '/api/v1/plugins/console-chat/ui?channel=bad:channel:1' },
    ]
    for (const entry of invalidCases) {
      const res = await kernel.http(entry.method, entry.url, entry.body)
      assert.equal(res.ok, false, `${entry.method} ${entry.url} should fail`)
      if (!res.ok) assert.equal(res.error.code, 'INVALID_ARGUMENT')
    }

    await assert.rejects(
      () => kernel.callTool('console-chat__send_message', { text: '' }, { channel: 'console-chat:private:owner' }),
      (error: unknown) => error instanceof BrainError && error.code === 'INVALID_ARGUMENT',
    )
    await assert.rejects(
      () => kernel.callTool('console-chat__send_message', { text: 'ok', replyTo: 42 }, { channel: 'console-chat:private:owner' }),
      (error: unknown) => error instanceof BrainError && error.code === 'INVALID_ARGUMENT',
    )
  })

  it('renders Apple frosted-glass UI and escapes HTML in dynamic values', async () => {
    const pkg = await readPackageJson()
    const kernel = createTestKernel()
    await kernel.loadPlugin({ apply }, pkg.brain)

    await kernel.http('POST', '/api/v1/plugins/console-chat/messages', {
      channel: 'console-chat:private:owner',
      displayName: '<img src=x onerror=alert(1)>',
      text: '<script>alert("xss")</script>',
      messageId: 'xss-1',
    })

    const uiRes = await kernel.http('GET', '/api/v1/plugins/console-chat/ui?channel=console-chat:private:owner')
    assert.equal(uiRes.ok, true)
    if (!uiRes.ok) return
    const html = uiRes.data as string
    assert.match(html, /backdrop-filter:\s*blur\(48px\)/)
    assert.match(html, /\.glass-card/)
    assert.match(html, /wakeId:/)
    assert.match(html, /memoryEvidence:/)
    assert.match(html, /<form class="composer"/)
    assert.equal(html.includes('<script>alert("xss")</script>'), false)
    assert.equal(html.includes('<img src=x onerror=alert(1)>'), false)
    assert.equal(html.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'), true)
    assert.equal(html.includes('&lt;img src=x onerror=alert(1)&gt;'), true)
  })

  it('tracks read cursor watermark, snapshot relative time, and optional debouncer after chat-kit migration', async () => {
    const pkg = await readPackageJson()
    const kernel = createTestKernel()
    let failWake = true
    kernel.useAgent(async (_wake, helpers) => {
      if (failWake) {
        throw new BrainError('UNAVAILABLE', 'simulated wake failure')
      }
      await helpers.callTool('console-chat__send_message', { text: '收到啦' })
    })
    await kernel.loadPlugin({ apply }, pkg.brain)

    // When wake fails, inbound is ingested and unreadCount stays 1
    const failedPost = await kernel.http('POST', '/api/v1/plugins/console-chat/messages', {
      channel: 'console-chat:private:owner',
      text: '第一条未读',
      messageId: 'wm-1',
      tEvent: Date.now() - 120_000,
    })
    assert.equal(failedPost.ok, false)

    const unreadRes = await kernel.http('GET', '/api/v1/plugins/console-chat/messages?channel=console-chat:private:owner')
    assert.equal(unreadRes.ok, true)
    if (!unreadRes.ok) return
    const unreadData = unreadRes.data as {
      readonly unreadCount: number
      readonly lastReadMessageId?: string
      readonly snapshot: readonly { readonly id: string; readonly ago: string }[]
    }
    assert.equal(unreadData.unreadCount, 1)
    assert.equal(unreadData.lastReadMessageId, undefined)
    assert.equal(unreadData.snapshot.length, 1)
    assert.equal(unreadData.snapshot[0]!.id, 'wm-1')
    assert.equal(unreadData.snapshot[0]!.ago, '2 分钟前')

    // When wake succeeds, markRead advances watermark and resets unreadCount to 0
    failWake = false
    const okPost = await kernel.http('POST', '/api/v1/plugins/console-chat/messages', {
      channel: 'console-chat:private:owner',
      text: '第二条已读',
      messageId: 'wm-2',
    })
    assert.equal(okPost.ok, true)

    const readRes = await kernel.http('GET', '/api/v1/plugins/console-chat/messages?channel=console-chat:private:owner')
    assert.equal(readRes.ok, true)
    if (!readRes.ok) return
    const readData = readRes.data as {
      readonly unreadCount: number
      readonly lastReadMessageId?: string
      readonly lastReadAt?: number
      readonly snapshot: readonly { readonly id: string; readonly ago: string }[]
    }
    assert.equal(readData.unreadCount, 0)
    assert.equal(readData.lastReadMessageId, 'wm-2')
    assert.equal(typeof readData.lastReadAt, 'number')
    assert.equal(readData.snapshot.length, 3)

    // UI renders relative time using chat-kit formatRelativeTime
    const uiHtml = renderChatUiHtml({
      channel: 'console-chat:private:owner',
      unreadCount: 0,
      now: 10_000_000,
      messages: [
        {
          messageId: 'u1',
          direction: 'inbound',
          displayName: '主人',
          text: '两小时前',
          recordId: 'r1',
          tEvent: 10_000_000 - 2 * 3_600_000,
        },
      ],
    })
    assert.equal(uiHtml.includes('2 小时前'), true)
    assert.equal(uiHtml.includes('unread: 0'), true)

    // Optional debouncer helper works with fake clock/timers
    let now = 0
    let nextTimer = 1
    const timers = new Map<number, { due: number; fn: () => void }>()
    const batches: string[][] = []
    const debouncer = createConsoleChatDebouncer({
      clock: { now: () => now },
      timers: {
        setTimeout: (fn, ms) => {
          const id = nextTimer++
          timers.set(id, { due: now + ms, fn })
          return id
        },
        clearTimeout: (handle) => {
          if (typeof handle === 'number') timers.delete(handle)
        },
      },
      minQuietMs: 500,
      maxWaitMs: 2_000,
      onFlush: (_ch, items) => {
        batches.push(items.map((m) => m.id))
      },
    })
    await debouncer.push('console-chat:private:owner', {
      id: 'rec-1',
      actor: 'console-chat:owner',
      name: '主人',
      text: 'hello',
      tEvent: 0,
    })
    assert.equal(batches.length, 0)
    now = 500
    for (const [id, task] of timers) {
      if (task.due <= now) {
        timers.delete(id)
        task.fn()
      }
    }
    assert.deepEqual(batches, [['rec-1']])
    debouncer.dispose()
  })
})
