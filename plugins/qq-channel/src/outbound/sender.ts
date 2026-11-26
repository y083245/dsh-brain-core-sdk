// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { computeHumanPauseMs } from '@brain-core/chat-kit'
import type { IngestEvent } from '@brain-core/sdk'
import type { QqConfig, SendGapMode } from '../config.ts'
import { allowed } from '../inbound/access.ts'
import { normalizeMessageId } from '../onebot/types.ts'
import { sensitiveReason } from './sensitive.ts'
import { plainQqText, splitText } from './split.ts'
import { SendRateLimit } from './rate-limit.ts'

export interface SendRequest { readonly channel: string; readonly messages: readonly string[]; readonly replyToMessageId?: string; readonly atUserId?: string; readonly gapMode?: SendGapMode }
export interface SendStickerRequest {
  readonly channel: string
  readonly sticker: { readonly id: string; readonly url?: string }
  readonly replyToMessageId?: string
  readonly atUserId?: string
}
export interface SenderDependencies {
  readonly config: () => QqConfig
  readonly secrets: () => Promise<readonly string[]>
  readonly canSend: (channel: string) => boolean | Promise<boolean>
  readonly hasSeenMessage: (channel: string, messageId: string) => boolean | Promise<boolean>
  readonly action: (action: string, params: unknown) => Promise<unknown>
  readonly ingest: (event: IngestEvent) => Promise<unknown>
  readonly noteSelfMessage?: (channel: string, messageId: string) => void | Promise<void>
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
}
/** The protocol confirmed delivery, but recording local metadata failed. Do not retry blindly. */
export class SentMessageError extends Error {
  readonly sent = true
  readonly messageId: string
  readonly deliveredIds: readonly string[]
  constructor(messageId: string, deliveredIds: readonly string[] = [messageId]) {
    super('Message was sent but the rest of the operation is unavailable')
    this.messageId = messageId
    this.deliveredIds = [...deliveredIds]
  }
}
export class QqSender {
  private readonly queues = new Map<string, Promise<void>>()
  private readonly limiter: SendRateLimit
  private readonly voiceLimiter: SendRateLimit
  private readonly sentVoices = new Map<string, Set<string>>()
  private readonly deps: SenderDependencies
  constructor(deps: SenderDependencies) { this.deps = deps; const config = deps.config(); this.limiter = new SendRateLimit(config.send.maxPerMinute, config.send.maxPerHour, deps.now); this.voiceLimiter = new SendRateLimit(config.voice.maxPerMinute, config.voice.maxPerHour, deps.now) }
  private async enqueue<T>(channel: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(channel) ?? Promise.resolve()
    const operation = previous.catch(() => {}).then(work)
    const tail = operation.then(() => {}, () => {})
    this.queues.set(channel, tail)
    try { return await operation } finally { if (this.queues.get(channel) === tail) this.queues.delete(channel) }
  }
  async send(request: SendRequest): Promise<readonly string[]> {
    return this.enqueue(request.channel, () => this.sendSerial(request))
  }
  async sendSticker(request: SendStickerRequest): Promise<string> {
    return this.enqueue(request.channel, async () => {
      const match = /^qq:(private|group):([1-9]\d*)$/.exec(request.channel)
      if (!match) throw new Error('Invalid channel')
      if (!request.sticker || typeof request.sticker.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(request.sticker.id)) {
        throw new Error('Invalid sticker')
      }
      const kind = match[1] as 'private' | 'group', id = match[2]!
      const checkAccess = async (): Promise<void> => {
        if (!allowed(this.deps.config(), kind, id) || !await this.deps.canSend(request.channel)) {
          throw new Error('Channel unavailable')
        }
      }
      await checkAccess()
      if (request.atUserId !== undefined && (kind !== 'group' || !/^[1-9]\d{4,15}$/.test(request.atUserId))) {
        throw new Error('Invalid mention')
      }
      if (request.replyToMessageId !== undefined && (!/^-?[1-9]\d*$/.test(request.replyToMessageId) || !await this.deps.hasSeenMessage(request.channel, request.replyToMessageId))) {
        throw new Error('Invalid reply')
      }
      const config = this.deps.config()
      this.limiter.setLimits(config.send.maxPerMinute, config.send.maxPerHour)
      const reservation = this.limiter.reserve(request.channel, 1)
      try {
        await checkAccess()
        if (request.replyToMessageId && !await this.deps.hasSeenMessage(request.channel, request.replyToMessageId)) {
          throw new Error('Invalid reply')
        }
        const message: { type: string; data: Record<string, unknown> }[] = []
        if (request.replyToMessageId) message.push({ type: 'reply', data: { id: request.replyToMessageId } })
        if (request.atUserId) message.push({ type: 'at', data: { qq: request.atUserId } })
        message.push({
          type: 'image',
          data: {
            file: request.sticker.url ?? request.sticker.id,
            subType: 1,
            ...(request.sticker.url ? { url: request.sticker.url } : {}),
          },
        })
        const response = await this.deps.action(
          kind === 'private' ? 'send_private_msg' : 'send_group_msg',
          { [kind === 'private' ? 'user_id' : 'group_id']: id, message },
        ) as { message_id?: unknown }
        reservation.sent()
        const messageId = normalizeMessageId(response?.message_id)
        try {
          await this.deps.noteSelfMessage?.(request.channel, messageId)
          await this.deps.ingest({
            kind: 'qq.message',
            channel: request.channel,
            subjects: [],
            actor: 'self',
            visibility: 'origin',
            content: {
              direction: 'outbound',
              messageId,
              media: [{ type: 'sticker', stickerId: request.sticker.id }],
            },
            tEvent: (this.deps.now ?? Date.now)(),
            idempotencyKey: `qq:outbound:${request.channel}:${messageId}`,
          })
        } catch {
          throw new SentMessageError(messageId)
        }
        return messageId
      } finally {
        reservation.rollback()
      }
    })
  }
  async sendRecord(channel: string, segment: { readonly type: 'record'; readonly data: { readonly file: string } }): Promise<string> {
    return this.enqueue(channel, async () => {
      const match = /^qq:(private|group):([1-9]\d*)$/.exec(channel)
      if (!match || segment.type !== 'record' || !/^base64:\/\/[A-Za-z0-9+/]+={0,2}$/.test(segment.data.file)) throw new Error('Invalid voice')
      const kind = match[1] as 'private' | 'group', id = match[2]!
      const check = async (): Promise<void> => {
        const current = this.deps.config()
        if (!current.voice.enabled || !allowed(current, kind, id) || !await this.deps.canSend(channel)) throw new Error('Channel unavailable')
      }
      await check()
      const config = this.deps.config()
      const payload = segment.data.file.slice('base64://'.length)
      const decoded = Buffer.from(payload, 'base64')
      if (!decoded.length || decoded.length > Math.min(config.voice.maxBytes, 4 * 1024 * 1024) || decoded.toString('base64') !== payload) throw new Error('Invalid voice')
      const body = JSON.stringify({ [kind === 'private' ? 'user_id' : 'group_id']: id, message: [segment] })
      const rpcLine = JSON.stringify({ jsonrpc: '2.0', id: 'x'.repeat(128), method: 'http.fetch', params: { url: config.onebotHttpUrl, options: { method: 'POST', body: Buffer.from(body).toString('base64') } } })
      if (Buffer.byteLength(rpcLine) >= 8 * 1024 * 1024 - 4096) throw new Error('Voice exceeds RPC budget')
      this.limiter.setLimits(config.send.maxPerMinute, config.send.maxPerHour)
      this.voiceLimiter.setLimits(Math.min(config.voice.maxPerMinute, 2), Math.min(config.voice.maxPerHour, 10))
      const general = this.limiter.reserve(channel, 1)
      let voice: ReturnType<SendRateLimit['reserve']> | undefined
      try {
        voice = this.voiceLimiter.reserve(channel, 1)
        await check()
        const response = await this.deps.action(kind === 'private' ? 'send_private_msg' : 'send_group_msg', JSON.parse(body)) as { message_id?: unknown }
        general.sent(); voice.sent()
        const messageId = normalizeMessageId(response?.message_id)
        try {
          await this.deps.noteSelfMessage?.(channel, messageId)
          await this.deps.ingest({ kind: 'qq.message', channel, subjects: [], actor: 'self', visibility: 'origin', content: { direction: 'outbound', messageId, media: [{ type: 'record' }] }, tEvent: (this.deps.now ?? Date.now)(), idempotencyKey: `qq:outbound:${channel}:${messageId}` })
        } catch { throw new SentMessageError(messageId) }
        const ids = this.sentVoices.get(channel) ?? new Set<string>()
        ids.add(messageId)
        if (ids.size > 1000) {
          const oldest = ids.values().next().value
          if (oldest !== undefined) ids.delete(oldest)
        }
        this.sentVoices.set(channel, ids)
        return messageId
      } finally { general.rollback(); voice?.rollback() }
    })
  }
  async readSentRecord(channel: string, messageId: string): Promise<{ readonly message_id: string; readonly message: readonly { readonly type: 'record' }[] }> {
    if (!this.sentVoices.get(channel)?.has(messageId)) throw new Error('NOT_FOUND')
    const match = /^qq:(private|group):([1-9]\d*)$/.exec(channel)
    if (!match || !allowed(this.deps.config(), match[1] as 'private' | 'group', match[2] ?? '') || !await this.deps.canSend(channel)) throw new Error('NOT_FOUND')
    const result = await this.deps.action('get_msg', { message_id: messageId }) as { message_id?: unknown; message_type?: unknown; group_id?: unknown; user_id?: unknown; message?: unknown }
    if (String(result?.message_id) !== messageId || result.message_type !== match[1] || String(match[1] === 'group' ? result.group_id : result.user_id) !== match[2] || !Array.isArray(result.message) || !result.message.some((part: unknown) => !!part && typeof part === 'object' && (part as { type?: unknown }).type === 'record')) throw new Error('NOT_FOUND')
    return { message_id: messageId, message: [{ type: 'record' }] }
  }
  private async sendSerial(request: SendRequest): Promise<readonly string[]> {
    const match = /^qq:(private|group):([1-9]\d*)$/.exec(request.channel)
    if (!match) throw new Error('Invalid channel')
    const kind = match[1] as 'private' | 'group', id = match[2]!
    const config = this.deps.config()
    const checkAccess = async (): Promise<void> => {
      if (!allowed(this.deps.config(), kind, id) || !await this.deps.canSend(request.channel)) throw new Error('Channel unavailable')
    }
    await checkAccess()
    if (!Array.isArray(request.messages) || request.messages.length < 1 || request.messages.length > Math.min(6, config.send.maxBurst) || request.messages.some((text) => typeof text !== 'string' || !text.trim())) throw new Error('Invalid messages')
    if (request.atUserId !== undefined && (kind !== 'group' || !/^[1-9]\d{4,15}$/.test(request.atUserId))) throw new Error('Invalid mention')
    if (request.replyToMessageId !== undefined && (!/^-?[1-9]\d*$/.test(request.replyToMessageId) || !await this.deps.hasSeenMessage(request.channel, request.replyToMessageId))) throw new Error('Invalid reply')
    const secrets = await this.deps.secrets()
    for (const text of request.messages) if (sensitiveReason(text, secrets)) throw new Error('Sensitive content blocked')
    const texts = request.messages.flatMap((text) => splitText(plainQqText(text), Math.min(4000, Math.max(2, config.send.hardSplitChars))))
    if (texts.length === 0 || texts.some((text) => !text.trim())) throw new Error('Invalid messages')
    if (texts.length > Math.min(6, config.send.maxBurst)) throw new Error('Burst limit exceeded')
    for (const text of texts) if (sensitiveReason(text, secrets)) throw new Error('Sensitive content blocked')
    this.limiter.setLimits(config.send.maxPerMinute, config.send.maxPerHour)
    const reservation = this.limiter.reserve(request.channel, texts.length)
    const sent: string[] = []
    try {
      for (let i = 0; i < texts.length; i++) {
        if (i > 0) {
          const mode = request.gapMode ?? config.send.gapMode
          const delay = mode === 'fixed' ? config.send.fixedGapMs : mode === 'byLength' ? Math.min(config.send.maxGapMs, config.send.baseGapMs + [...texts[i]!].length * config.send.msPerChar) : computeHumanPauseMs(texts[i]!, { baseMs: config.send.baseGapMs, maxMs: config.send.maxGapMs, minMs: 0, burstIndex: i })
          await (this.deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(delay)
        }
        await checkAccess()
        if (request.replyToMessageId && !await this.deps.hasSeenMessage(request.channel, request.replyToMessageId)) throw new Error('Invalid reply')
        const message: { type: string; data: Record<string, string> }[] = []
        if (i === 0 && request.replyToMessageId) message.push({ type: 'reply', data: { id: request.replyToMessageId } })
        if (i === 0 && request.atUserId) message.push({ type: 'at', data: { qq: request.atUserId } })
        message.push({ type: 'text', data: { text: texts[i]! } })
        const response = await this.deps.action(kind === 'private' ? 'send_private_msg' : 'send_group_msg', { [kind === 'private' ? 'user_id' : 'group_id']: id, message })
        reservation.sent()
        const messageId = normalizeMessageId((response as { message_id?: unknown })?.message_id)
        sent.push(messageId)
        await this.deps.noteSelfMessage?.(request.channel, messageId)
        await this.deps.ingest({ kind: 'qq.message', channel: request.channel, subjects: [], actor: 'self', visibility: 'origin', content: { direction: 'outbound', messageId, text: texts[i] }, tEvent: (this.deps.now ?? Date.now)(), idempotencyKey: `qq:outbound:${request.channel}:${messageId}` })
      }
      return sent
    } catch (error) {
      const lastDelivered = sent.at(-1)
      if (lastDelivered !== undefined) throw new SentMessageError(lastDelivered, sent)
      throw error
    } finally { reservation.rollback() }
  }
}
