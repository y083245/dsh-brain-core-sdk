import { BrainError, type BrainContext, type PluginApply } from '@dsh-brain-core/sdk'

interface SentLogEntry {
  readonly channel: string
  readonly text?: string
  readonly kind: string
}

export const apply: PluginApply = (ctx: BrainContext): void => {
  const membersByChannel = new Map<string, Set<string>>()
  const sentMessages: SentLogEntry[] = []
  const stickers = new Map<string, string>([['smile', '微笑表情'], ['cat_wave', '小猫挥手']])
  const wakeConfigs = new Map<string, Record<string, unknown>>()
  let seq = 0
  const nextId = (): string => {
    seq += 1
    return `qq_msg_${seq}`
  }

  ctx.channel.provide({
    send: async (channel, message) => {
      sentMessages.push({ channel, ...(message.text === undefined ? {} : { text: message.text }), kind: 'message' })
      return { messageId: nextId() }
    },
    members: async (channel) => [...(membersByChannel.get(channel) ?? [])].sort(),
    resolveIdentity: async (account) => (account.startsWith('qq:') ? { displayName: account.slice(3) } : null),
  })

  // Row 2: core send_message, reply, send_burst -> L0.1
  ctx.tools.register({
    name: 'send_message',
    description: '在 QQ 通道发送一条消息',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' }, channel: { type: 'string' } },
      required: ['text'],
    },
    handler: async (args, call) => {
      const text = typeof args.text === 'string' ? args.text : ''
      if (text.trim() === '') throw new BrainError('INVALID_ARGUMENT', 'text is required')
      const sent = await ctx.channel.send(call.channel, { text })
      const msgId = sent.messageId ?? nextId()
      const l0 = await ctx.memory.ingest({
        kind: 'qq.message',
        channel: call.channel,
        subjects: ['self'],
        actor: 'self',
        content: { text, direction: 'outbound', messageId: msgId },
        tEvent: Date.now(),
        idempotencyKey: `qq:out:${call.wakeId}:${msgId}`,
      })
      return JSON.stringify({ messageId: msgId, recordId: l0.id, channel: call.channel })
    },
  })

  ctx.tools.register({
    name: 'reply',
    description: '回复指定消息',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' }, replyTo: { type: 'string' } },
      required: ['text', 'replyTo'],
    },
    handler: async (args, call) => {
      const text = typeof args.text === 'string' ? args.text : ''
      const replyTo = typeof args.replyTo === 'string' ? args.replyTo : ''
      const sent = await ctx.channel.send(call.channel, { text, replyTo })
      const msgId = sent.messageId ?? nextId()
      const l0 = await ctx.memory.ingest({
        kind: 'qq.message',
        channel: call.channel,
        subjects: ['self'],
        actor: 'self',
        content: { text, replyTo, direction: 'outbound', messageId: msgId },
        tEvent: Date.now(),
        idempotencyKey: `qq:reply:${call.wakeId}:${msgId}`,
      })
      return JSON.stringify({ messageId: msgId, recordId: l0.id })
    },
  })

  ctx.tools.register({
    name: 'send_burst',
    description: '连发短消息',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    handler: async (args, call) => {
      const text = typeof args.text === 'string' ? args.text : ''
      const sent = await ctx.channel.send(call.channel, { text })
      const msgId = sent.messageId ?? nextId()
      const l0 = await ctx.memory.ingest({
        kind: 'qq.message',
        channel: call.channel,
        subjects: ['self'],
        actor: 'self',
        content: { text, burst: true, direction: 'outbound', messageId: msgId },
        tEvent: Date.now(),
        idempotencyKey: `qq:burst:${call.wakeId}:${msgId}`,
      })
      return JSON.stringify({ messageId: msgId, recordId: l0.id })
    },
  })

  // Row 9: core set_wake_config (no wait tools)
  ctx.tools.register({
    name: 'set_wake_config',
    description: '设置唤醒条件',
    parameters: {
      type: 'object',
      properties: { mode: { type: 'string' }, minIntervalMs: { type: 'number' } },
      required: ['mode'],
    },
    handler: async (args, call) => {
      const cfg = { mode: String(args.mode ?? 'mention'), minIntervalMs: Number(args.minIntervalMs ?? 5000) }
      wakeConfigs.set(call.channel, cfg)
      await ctx.storage.write(`wake-config-${encodeURIComponent(call.channel)}.json`, JSON.stringify(cfg))
      return JSON.stringify({ channel: call.channel, config: cfg })
    },
  })

  // Row 3: context media & forward -> L0.2
  ctx.tools.register({
    name: 'get_message_images',
    description: '读取图片描述',
    parameters: { type: 'object', properties: { messageId: { type: 'string' } } },
    handler: async (args, call) => {
      const desc = `图片描述(${String(args.messageId ?? 'latest')})：一只小白猫`
      const l0 = await ctx.memory.ingest({
        kind: 'qq.vision',
        channel: call.channel,
        subjects: ['self'],
        actor: 'self',
        content: { text: desc, subLayer: 'L0.2' },
        tEvent: Date.now(),
        idempotencyKey: `qq:vision:${call.wakeId}:${nextId()}`,
      })
      return JSON.stringify({ recordId: l0.id, description: desc })
    },
  })

  ctx.tools.register({
    name: 'get_forward_msg',
    description: '读取合并转发内容',
    parameters: { type: 'object', properties: { forwardId: { type: 'string' } } },
    handler: async (args, call) => {
      const summary = `合并转发(${String(args.forwardId ?? 'fwd')})：周末聚餐时间定在周六`
      const l0 = await ctx.memory.ingest({
        kind: 'qq.vision',
        channel: call.channel,
        subjects: ['self'],
        actor: 'self',
        content: { text: summary, subLayer: 'L0.2' },
        tEvent: Date.now(),
        idempotencyKey: `qq:forward:${call.wakeId}:${nextId()}`,
      })
      return JSON.stringify({ recordId: l0.id, summary })
    },
  })

  // Row 4: context poke -> L0.4
  ctx.tools.register({
    name: 'send_poke',
    description: '回拍一下对方',
    parameters: { type: 'object', properties: { target: { type: 'string' } } },
    handler: async (args, call) => {
      const target = String(args.target ?? 'peer')
      sentMessages.push({ channel: call.channel, kind: 'poke', text: target })
      const l0 = await ctx.memory.ingest({
        kind: 'qq.action',
        channel: call.channel,
        subjects: [target],
        actor: 'self',
        content: { text: `拍了拍 ${target}`, action: 'poke', subLayer: 'L0.4' },
        tEvent: Date.now(),
        idempotencyKey: `qq:poke:${call.wakeId}:${nextId()}`,
      })
      return JSON.stringify({ recordId: l0.id, poked: target })
    },
  })

  // Row 5: onDemand stickers -> L2.3
  ctx.tools.register({
    name: 'list_stickers',
    description: '查看表情列表',
    parameters: { type: 'object', properties: {} },
    handler: async () => JSON.stringify([...stickers.entries()].map(([id, meaning]) => ({ id, meaning }))),
  })

  ctx.tools.register({
    name: 'send_sticker',
    description: '发送一个表情',
    parameters: { type: 'object', properties: { stickerId: { type: 'string' } }, required: ['stickerId'] },
    handler: async (args, call) => {
      const stickerId = String(args.stickerId ?? 'smile')
      const sent = await ctx.channel.send(call.channel, { text: `[sticker:${stickerId}]` })
      const l0 = await ctx.memory.ingest({
        kind: 'qq.action',
        channel: call.channel,
        subjects: ['self'],
        actor: 'self',
        content: { text: `发送表情 ${stickerId}`, stickerId, subLayer: 'L0.4' },
        tEvent: Date.now(),
        idempotencyKey: `qq:sticker:${call.wakeId}:${nextId()}`,
      })
      return JSON.stringify({ messageId: sent.messageId, recordId: l0.id, stickerId })
    },
  })

  ctx.tools.register({
    name: 'collect_sticker',
    description: '收藏表情',
    parameters: { type: 'object', properties: { stickerId: { type: 'string' }, meaning: { type: 'string' } }, required: ['stickerId'] },
    handler: async (args) => {
      const id = String(args.stickerId)
      const meaning = String(args.meaning ?? '新表情')
      stickers.set(id, meaning)
      return JSON.stringify({ collected: id, meaning })
    },
  })

  ctx.tools.register({
    name: 'sticker_note',
    description: '记录表情表达含义',
    parameters: {
      type: 'object',
      properties: { stickerId: { type: 'string' }, meaning: { type: 'string' }, evidenceId: { type: 'string' } },
      required: ['stickerId', 'meaning', 'evidenceId'],
    },
    handler: async (args, call) => {
      const stickerId = String(args.stickerId)
      const meaning = String(args.meaning)
      const evidenceId = String(args.evidenceId)
      const rec = await ctx.memory.record({
        layer: 'L2',
        kind: 'l2.expression',
        channel: call.channel,
        subjects: ['self'],
        actor: 'self',
        visibility: 'open',
        content: { text: `表情 ${stickerId} 表示：${meaning}`, stickerId, meaning },
        evidence: [{ id: evidenceId }],
        confidence: 0.9,
        importance: 0.6,
        idempotencyKey: `qq:sticker-note:${stickerId}:${evidenceId}`,
      })
      return JSON.stringify({ recordId: rec.id, layer: rec.layer, kind: rec.kind })
    },
  })

  // Row 6: onDemand voice -> L0.4
  ctx.tools.register({
    name: 'tts_voice',
    description: '合成语音',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    handler: async (args) => JSON.stringify({ audioRef: `tts://${nextId()}`, textLength: String(args.text ?? '').length }),
  })

  ctx.tools.register({
    name: 'send_voice',
    description: '发送语音消息',
    parameters: { type: 'object', properties: { audioRef: { type: 'string' } }, required: ['audioRef'] },
    handler: async (args, call) => {
      const audioRef = String(args.audioRef ?? 'tts://default')
      const sent = await ctx.channel.send(call.channel, { text: `[voice:${audioRef}]` })
      const l0 = await ctx.memory.ingest({
        kind: 'qq.action',
        channel: call.channel,
        subjects: ['self'],
        actor: 'self',
        content: { text: `发送语音 ${audioRef}`, audioRef, subLayer: 'L0.4' },
        tEvent: Date.now(),
        idempotencyKey: `qq:voice:${call.wakeId}:${nextId()}`,
      })
      return JSON.stringify({ messageId: sent.messageId, recordId: l0.id, audioRef })
    },
  })

  // Row 10: slang L1.7
  ctx.tools.register({
    name: 'slang_note',
    description: '记录黑话',
    parameters: {
      type: 'object',
      properties: { term: { type: 'string' }, meaning: { type: 'string' }, evidenceId: { type: 'string' } },
      required: ['term', 'meaning', 'evidenceId'],
    },
    handler: async (args, call) => {
      const term = String(args.term)
      const meaning = String(args.meaning)
      const evidenceId = String(args.evidenceId)
      const rec = await ctx.memory.record({
        layer: 'L1',
        kind: 'l1.knowledge',
        channel: call.channel,
        subjects: ['self'],
        actor: 'self',
        visibility: 'open',
        content: { text: `黑话「${term}」的意思是：${meaning}`, category: 'l1.slang', term, meaning },
        evidence: [{ id: evidenceId }],
        confidence: 0.9,
        importance: 0.7,
        idempotencyKey: `qq:slang:${call.channel}:${term}`,
      })
      return JSON.stringify({ recordId: rec.id, layer: rec.layer, kind: rec.kind, channel: rec.channel })
    },
  })

  // Row 8: ownTime -> writes L0.5 and wakes channel
  const ownTimeTarget = (ctx.config.ownTimeChannel as string | undefined) ?? 'qq:group:1001'
  ctx.scheduler.ownTime({
    name: 'qq-own-time',
    everyMs: 60_000,
    run: async () => {
      const l0 = await ctx.memory.ingest({
        kind: 'qq.wake',
        channel: ownTimeTarget,
        subjects: ['self'],
        actor: 'self',
        content: { text: '自己的时间到了，想去群里冒泡看看', reason: 'own-time', subLayer: 'L0.5' },
        tEvent: Date.now(),
        idempotencyKey: `qq:owntime:${nextId()}`,
      })
      await ctx.agent.wake(ownTimeTarget, {
        reason: 'own-time',
        silent: false,
        proactive: true,
        evidence: [l0.id],
      })
    },
  })

  // Row 1: HTTP inbound endpoint -> resolves identity, ingests L0.1, wakes channel
  ctx.http.route('POST', '/inbound', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const channel = String(body.channel ?? 'qq:group:1001')
    const account = String(body.account ?? '10001')
    const displayName = String(body.displayName ?? account)
    const text = String(body.text ?? '')
    const fullAccount = account.startsWith('qq:') ? account : `qq:${account}`
    const personId = await ctx.identity.resolve(fullAccount)
    const set = membersByChannel.get(channel) ?? new Set<string>()
    set.add(personId)
    membersByChannel.set(channel, set)

    const messageId = String(body.messageId ?? nextId())
    const tEvent = typeof body.tEvent === 'number' ? body.tEvent : Date.now()
    const ingested = await ctx.memory.ingest({
      kind: 'qq.message',
      channel,
      subjects: [personId],
      actor: personId,
      content: { text, direction: 'inbound', account: fullAccount, messageId },
      tEvent,
      idempotencyKey: `qq:in:${channel}:${messageId}`,
    })
    const wake = await ctx.agent.wake(channel, {
      reason: 'message',
      ...(body.poke === true ? { event: 'poke' as const } : {}),
      messages: [
        {
          id: ingested.id,
          actor: personId,
          name: displayName,
          text,
          tEvent,
          ...(Array.isArray(body.images) ? { images: body.images } : {}),
          ...(body.forwarded === true ? { forwarded: true } : {}),
        },
      ],
    })
    return { recordId: ingested.id, personId, wake }
  })

  ctx.http.route('GET', '/sent', async () => ({ items: [...sentMessages] }))
}
