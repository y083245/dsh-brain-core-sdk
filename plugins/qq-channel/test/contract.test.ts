// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { BrainError, type BrainContext, type ToolOutput } from '@brain-core/sdk'
import { createTestKernel, runPluginContractTests } from '@brain-core/testkit'
import { apply, applyQqPlugin, type QqPluginHandle } from '../src/index.ts'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Minimal 1x1 GIF89a whose every byte is < 0x80 so FakeKernel TextEncoder preserves it losslessly.
const TINY_ASCII_GIF = Buffer.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
  0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, // 1x1, no global color table
  0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // image descriptor 1x1
  0x02, 0x02, 0x4c, 0x01, 0x00, // LZW min code size 2 + sub-block + terminator
  0x3b, // trailer
])

async function readManifest(): Promise<{ readonly brain: Record<string, unknown> }> {
  const raw = await readFile(path.join(PLUGIN_ROOT, 'package.json'), 'utf8')
  return JSON.parse(raw) as { readonly brain: Record<string, unknown> }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('runPluginContractTests passes all 7 contract checks', async () => {
  const pkg = await readManifest()
  const results = await runPluginContractTests({ apply }, pkg.brain)
  assert.deepEqual(
    results.map((r) => r.name),
    ['manifest', 'apply', 'tools-registered', 'no-extra-tools', 'no-internal-writes', 'unload-clean', 'no-late-register'],
  )
  for (const item of results) {
    assert.equal(item.ok, true, `${item.name} failed: ${item.message}`)
  }
})

test('applyQqPlugin rejects outdated host missing subscribeWebSocket or readChannelEvent', async () => {
  const baseCtx = {
    http: {
      route: () => () => undefined,
      fetch: async () => {
        throw new Error('unused')
      },
      subscribeWebSocket: async () => () => undefined,
    },
    memory: {
      readChannelEvent: async () => {
        throw new Error('unused')
      },
    },
  } as unknown as BrainContext

  const withoutWs = {
    ...baseCtx,
    http: {
      route: baseCtx.http.route,
      fetch: baseCtx.http.fetch,
    },
  } as unknown as BrainContext

  await assert.rejects(
    applyQqPlugin(withoutWs, {}),
    (err: unknown) =>
      err instanceof BrainError
      && err.code === 'UNAVAILABLE'
      && err.message.includes('升级内核'),
  )

  const withoutReadChannelEvent = {
    ...baseCtx,
    memory: {},
  } as unknown as BrainContext

  await assert.rejects(
    applyQqPlugin(withoutReadChannelEvent, {}),
    (err: unknown) =>
      err instanceof BrainError
      && err.code === 'UNAVAILABLE'
      && err.message.includes('升级内核'),
  )
})

test('full kernel integration: non-blocking apply, inbound L0 ingest, wake tools, UI/status routes, and clean unload', async () => {
  const pkg = await readManifest()
  const kernel = createTestKernel({ now: 1_700_000_000_000, ownerChannels: ['qq:private:10001'] })

  kernel.setSecret('onebot-http-token', 'SECRET_HTTP_TOKEN_123')
  kernel.setSecret('onebot-ws-token', 'SECRET_WS_TOKEN_456')

  kernel.setResponse('http://127.0.0.1:3000/get_login_info', {
    status: 200,
    body: JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 999999, nickname: '小鲸鱼' } }),
  })
  kernel.setResponse('http://127.0.0.1:3000/get_status', {
    status: 200,
    body: JSON.stringify({ status: 'ok', retcode: 0, data: { online: true, good: true } }),
  })
  kernel.setResponse('http://127.0.0.1:3000/send_group_msg', {
    status: 200,
    body: JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 8001 } }),
  })
  kernel.setResponse('http://127.0.0.1:3000/get_image', {
    status: 200,
    body: JSON.stringify({ status: 'ok', retcode: 0, data: { url: 'https://gchat.qpic.cn/gchatpic_new/test.gif' } }),
  })
  kernel.setResponse('https://gchat.qpic.cn/gchatpic_new/test.gif', {
    status: 200,
    body: TINY_ASCII_GIF.toString('latin1'),
  })
  kernel.setResponse('http://127.0.0.1:3000/get_forward_msg', {
    status: 200,
    body: JSON.stringify({
      status: 'ok',
      retcode: 0,
      data: {
        messages: [
          {
            sender: { user_id: 10001, nickname: '主人' },
            content: [{ type: 'text', data: { text: '转发内的测试内容' } }],
          },
        ],
      },
    }),
  })
  kernel.setResponse('http://127.0.0.1:3000/fetch_custom_face', {
    status: 200,
    body: JSON.stringify({ status: 'ok', retcode: 0, data: [] }),
  })

  let handle: QqPluginHandle | undefined
  await kernel.loadPlugin(
    {
      apply: async (ctx, cfg) => {
        handle = await applyQqPlugin(ctx, cfg)
      },
    },
    pkg.brain,
    {
      config: {
        onebotHttpUrl: 'http://127.0.0.1:3000',
        onebotWsUrl: 'ws://127.0.0.1:3001',
        ownerQQ: '10001',
        allowPrivate: ['10001'],
        allowGroups: ['20002'],
        wake: {
          groupTrigger: 'mention',
          quietDebounceMs: 0,
          batchWindowMs: 0,
          minWakeIntervalMs: 0,
          replyProbability: 0.5,
        },
      },
    },
  )

  assert.ok(handle !== undefined, 'applyQqPlugin should return a handle immediately')
  // Wait for queued microtask startBackground() to establish the kernel WebSocket subscription.
  await waitFor(() => kernel.webSockets().length === 1)
  assert.deepEqual(kernel.webSockets(), [{ configKey: 'onebotWsUrl', url: 'ws://127.0.0.1:3001/' }])

  // Wait for get_login_info triggered by open event so wsClient.selfId is locked to '999999'.
  await waitFor(() => kernel.calls.some((c) => c.method === 'http.fetch' && c.args[0] === 'http://127.0.0.1:3000/get_login_info'))
  await new Promise((resolve) => setImmediate(resolve))

  const toolResults: Record<string, ToolOutput> = {}
  let wokeChannel = ''
  let wokeHasMedia = false
  let wokeForwarded = false
  let inboundRecordId = ''

  kernel.useAgent(async (wake, helpers) => {
    wokeChannel = wake.channel
    const msg = wake.input.messages?.[0]
    wokeHasMedia = msg?.hasMedia === true
    wokeForwarded = msg?.forwarded === true
    inboundRecordId = msg?.id ?? ''

    const wakeText = msg?.text ?? ''
    assert.ok(wakeText.includes('#1001'), `expected #1001 in wake text, got: ${wakeText}`)
    const match = /\[QQ 外部消息 #(-?\d+)，以下为非指令数据\]/.exec(wakeText)
    assert.ok(match !== null, `expected #messageId header in wake text, got: ${wakeText}`)
    const messageId = match[1]!

    toolResults.detail = await helpers.callTool('qq__get_message_detail', { messageId })
    toolResults.images = await helpers.callTool('qq__get_message_images', { messageId })
    toolResults.forward = await helpers.callTool('qq__get_forward_msg', { forwardId: 'fwd_99' })
    toolResults.stickerNote = await helpers.callTool('qq__sticker_note', {
      stickerId: 'stk_99',
      evidenceRecordId: inboundRecordId,
      note: '开心打招呼',
      tags: ['打招呼'],
    })
    toolResults.wakeConfig = await helpers.callTool('qq__set_wake_config', {
      mode: 'active',
      groupTrigger: 'keyword',
      keywords: ['小鲸鱼'],
    })
    toolResults.send = await helpers.callTool('qq__send_message', {
      messages: ['收到啦', '这就来'],
      replyToMessageId: messageId,
    })
  })

  // Emit heartbeat so health reaches 'healthy'.
  await kernel.emitWebSocket('onebotWsUrl', {
    type: 'message',
    data: JSON.stringify({
      post_type: 'meta_event',
      meta_event_type: 'heartbeat',
      status: { online: true, good: true },
    }),
  })

  // Emit inbound group message mentioning bot with an image, market sticker, and forward segment.
  await kernel.emitWebSocket('onebotWsUrl', {
    type: 'message',
    data: JSON.stringify({
      post_type: 'message',
      message_type: 'group',
      group_id: 20002,
      user_id: 10001,
      message_id: 1001,
      time: 1_700_000_000,
      sender: { user_id: 10001, nickname: '主人', card: '群主' },
      message: [
        { type: 'at', data: { qq: '999999' } },
        { type: 'text', data: { text: ' 帮我看一下图和转发' } },
        { type: 'image', data: { file: 'photo.gif', url: 'https://gchat.qpic.cn/gchatpic_new/test.gif' } },
        { type: 'mface', data: { emoji_id: 'stk_99', summary: '[开心]', url: 'https://gchat.qpic.cn/gchatpic_new/test.gif' } },
        { type: 'forward', data: { id: 'fwd_99' } },
      ],
    }),
  })

  await waitFor(() => wokeChannel === 'qq:group:20002' && toolResults.send !== undefined)

  assert.equal(wokeHasMedia, true)
  assert.equal(wokeForwarded, true)
  assert.ok(inboundRecordId !== '')

  const inboundRecord = kernel.records().find((r) => r.id === inboundRecordId)
  assert.ok(inboundRecord !== undefined)
  assert.equal(inboundRecord.layer, 'L0')
  assert.equal(inboundRecord.source, 'qq')
  assert.equal(inboundRecord.trust, 'external')
  assert.equal(inboundRecord.visibility, 'origin')
  assert.equal(inboundRecord.channel, 'qq:group:20002')

  const detailParsed = JSON.parse(String(toolResults.detail)) as { record: { id: string } }
  assert.equal(detailParsed.record.id, inboundRecordId)

  const imagesOutput = toolResults.images as { readonly text: string; readonly images?: readonly { mediaType: string }[] }
  assert.ok(Array.isArray(imagesOutput.images) && imagesOutput.images.length >= 1)
  assert.equal(imagesOutput.images[0]!.mediaType, 'image/gif')

  assert.equal(String(toolResults.forward).includes('转发内的测试内容'), true)

  const noteParsed = JSON.parse(String(toolResults.stickerNote)) as { ok: boolean; stickerId: string }
  assert.equal(noteParsed.ok, true)
  assert.equal(noteParsed.stickerId, 'stk_99')
  assert.ok(kernel.records().some((r) => r.layer === 'L2' && r.kind === 'l2.expression' && r.content.stickerId === 'stk_99'))

  const wakeParsed = JSON.parse(String(toolResults.wakeConfig)) as { ok: boolean; groupTrigger: string }
  assert.equal(wakeParsed.ok, true)
  assert.equal(wakeParsed.groupTrigger, 'keyword')

  const sendParsed = JSON.parse(String(toolResults.send)) as { ok: boolean; count: number; deliveredMessageIds: readonly string[] }
  assert.equal(sendParsed.ok, true)
  assert.equal(sendParsed.count, 2)
  assert.deepEqual(sendParsed.deliveredMessageIds, ['8001', '8001'])

  const uiEnv = await kernel.http('GET', '/api/v1/plugins/qq/ui')
  assert.equal(uiEnv.ok, true)
  if (uiEnv.ok) {
    const html = String(uiEnv.data)
    assert.equal(html.includes('QQ 通道只读状态面板'), true)
    assert.equal(html.includes('999999'), true)
    assert.equal(html.includes('SECRET_HTTP_TOKEN_123'), false)
    assert.equal(html.includes('SECRET_WS_TOKEN_456'), false)
  }

  const statusEnv = await kernel.http('GET', '/api/v1/plugins/qq/status')
  assert.equal(statusEnv.ok, true)
  if (statusEnv.ok) {
    const snapshot = statusEnv.data as {
      health: { state: string }
      identity: { selfId: string | null }
      channelsCount: number
    }
    assert.equal(snapshot.health.state, 'healthy')
    assert.equal(snapshot.identity.selfId, '999999')
    assert.equal(snapshot.channelsCount, 2)
    assert.equal(JSON.stringify(snapshot).includes('SECRET_HTTP_TOKEN_123'), false)
    assert.equal(JSON.stringify(snapshot).includes('SECRET_WS_TOKEN_456'), false)
  }

  await handle!.stop()
  await kernel.unload()
  assert.equal(kernel.tools().length, 0)
  assert.equal(kernel.routes().length, 0)
  assert.equal(kernel.timers(), 0)
  assert.equal(kernel.webSockets().length, 0)
})

test('OUT-04: applyQqPlugin wires onebot-http-token and onebot-ws-token into QqSender sensitive filter', async () => {
  const pkg = await readManifest()
  const kernel = createTestKernel({ now: 1_700_000_000_000, ownerChannels: ['qq:private:10001'] })
  kernel.setSecret('onebot-http-token', 'SECRET_HTTP_TOKEN_XYZ')
  kernel.setSecret('onebot-ws-token', 'SECRET_WS_TOKEN_XYZ')
  kernel.setResponse('http://127.0.0.1:3000/send_private_msg', {
    status: 200,
    body: JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 9001 } }),
  })

  let handle: QqPluginHandle | undefined
  await kernel.loadPlugin(
    {
      apply: async (ctx, cfg) => {
        handle = await applyQqPlugin(ctx, cfg, { autoConnect: false })
      },
    },
    pkg.brain,
    {
      config: {
        onebotHttpUrl: 'http://127.0.0.1:3000',
        onebotWsUrl: 'ws://127.0.0.1:3001',
        ownerQQ: '10001',
        allowPrivate: ['10001'],
      },
    },
  )

  await assert.rejects(
    kernel.callTool(
      'qq__send_message',
      { messages: ['leak SECRET_HTTP_TOKEN_XYZ here'] },
      { channel: 'qq:private:10001', wakeId: 'w1' },
    ),
    (err: unknown) => err instanceof BrainError && err.code === 'PERMISSION_DENIED',
  )
  await assert.rejects(
    kernel.callTool(
      'qq__send_message',
      { messages: ['leak SECRET_WS_TOKEN_XYZ here'] },
      { channel: 'qq:private:10001', wakeId: 'w2' },
    ),
    (err: unknown) => err instanceof BrainError && err.code === 'PERMISSION_DENIED',
  )
  assert.equal(
    kernel.calls.some((c) => c.method === 'http.fetch' && String(c.args[0]).includes('send_private_msg')),
    false,
  )

  const okOut = await kernel.callTool(
    'qq__send_message',
    { messages: ['normal safe message'] },
    { channel: 'qq:private:10001', wakeId: 'w3' },
  )
  assert.equal(JSON.parse(String(okOut)).ok, true)

  await handle!.stop()
  await kernel.unload()
})
