// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { BrainError, type BrainContext, type Disposable, type PluginApply } from '@dsh-brain-core/sdk'
import { configSchema, type QqConfig } from './config.ts'
import { MediaStore, cleanText, createInboundPipeline } from './inbound/index.ts'
import { OneBotHealth, OneBotHttpClient, OneBotWsClient, normalizeAccountId } from './onebot/index.ts'
import { QqSender, StickerLibrary, VoiceLibrary, createVoiceCodec } from './outbound/index.ts'
import { registerQqTools, type GroupMemberInfo } from './tools/index.ts'
import { registerQqUiRoutes, type QqChannelUiInput, type QqFfmpegStatusView } from './ui/index.ts'

export interface QqApplyDeps {
  readonly autoConnect?: boolean
  readonly now?: () => number
  readonly random?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  readonly authTransport?: 'header' | 'query'
  readonly probeFfmpeg?: (ffmpegPath?: string) => Promise<QqFfmpegStatusView>
}

export interface QqPluginHandle {
  readonly config: QqConfig
  readonly health: OneBotHealth
  readonly startBackground: () => void
  readonly stop: () => Promise<void>
}

export const HOST_UNSUPPORTED_MESSAGE =
  '当前 Brain Core 宿主版本不支持 QQ 通道插件所需的 WebSocket 订阅或同通道 L0 读取接口，请升级内核后再启用'

async function fetchGroupMembers(
  httpClient: OneBotHttpClient,
  groupId: string,
): Promise<readonly GroupMemberInfo[]> {
  const raw = await httpClient.action('get_group_member_list', { group_id: groupId })
  if (!Array.isArray(raw)) return []
  const members: GroupMemberInfo[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    let userId: string
    try {
      userId = normalizeAccountId(item.user_id)
    } catch {
      continue
    }
    const rawNickname = typeof item.nickname === 'string' ? cleanText(item.nickname).trim().slice(0, 64) : ''
    const rawCard = typeof item.card === 'string' ? cleanText(item.card).trim().slice(0, 64) : ''
    const nickname = rawNickname !== '' ? rawNickname : undefined
    const card = rawCard !== '' ? rawCard : undefined
    const displayName = card ?? nickname
    const rawRole = typeof item.role === 'string' ? cleanText(item.role).trim().slice(0, 32) : ''
    const role = rawRole !== '' ? rawRole : undefined
    const lastActiveAt =
      typeof item.last_sent_time === 'number'
      && Number.isSafeInteger(item.last_sent_time)
      && item.last_sent_time > 0
        ? item.last_sent_time * 1000
        : undefined
    members.push({
      userId,
      ...(nickname !== undefined ? { nickname } : {}),
      ...(card !== undefined ? { card } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
      ...(role !== undefined ? { role } : {}),
      ...(lastActiveAt !== undefined ? { lastActiveAt } : {}),
    })
  }
  return members
}

async function readSecretTokens(ctx: BrainContext<unknown>): Promise<readonly string[]> {
  const results = await Promise.allSettled([
    ctx.secrets.get('onebot-http-token'),
    ctx.secrets.get('onebot-ws-token'),
  ])
  const tokens: string[] = []
  for (const result of results) {
    if (result.status === 'fulfilled' && typeof result.value === 'string' && result.value !== '') {
      tokens.push(result.value)
    }
  }
  return tokens
}

/** Assemble and register the QQ channel plugin on `ctx` without blocking on OneBot handshake. */
export async function applyQqPlugin(
  ctx: BrainContext<unknown>,
  rawConfig?: unknown,
  deps?: QqApplyDeps,
): Promise<QqPluginHandle> {
  if (
    typeof ctx?.http?.subscribeWebSocket !== 'function'
    || typeof ctx?.memory?.readChannelEvent !== 'function'
  ) {
    throw new BrainError('UNAVAILABLE', HOST_UNSUPPORTED_MESSAGE)
  }

  const config = configSchema(rawConfig ?? {})
  let disposed = false

  const health = new OneBotHealth()
  const onAuthError = (): void => {
    health.authFailed()
    if (!disposed) {
      try {
        ctx.logger.warn('qq.auth_failed', { authError: true })
      } catch {
        // Ignore logger failures if host context is already unloaded.
      }
    }
  }

  const httpClient = new OneBotHttpClient(ctx.http, ctx.secrets, config.onebotHttpUrl, onAuthError)
  const mediaStore = new MediaStore()

  const wsClientRef: { current?: OneBotWsClient } = {}

  const pipeline = createInboundPipeline({
    ctx,
    config,
    store: mediaStore,
    getSelfId: () => wsClientRef.current?.selfId,
    ...(deps?.now !== undefined ? { now: deps.now } : {}),
    ...(deps?.random !== undefined ? { random: deps.random } : {}),
    listMembers: (groupId) => fetchGroupMembers(httpClient, groupId),
    lookupIdentity: async (userId) => {
      try {
        const raw = await httpClient.action('get_stranger_info', { user_id: userId })
        if (!raw || typeof raw !== 'object') return undefined
        const nickname = (raw as Record<string, unknown>).nickname
        if (typeof nickname !== 'string') return undefined
        const cleaned = cleanText(nickname).trim().slice(0, 64)
        return cleaned !== '' ? cleaned : undefined
      } catch {
        return undefined
      }
    },
  })

  const wsClient = new OneBotWsClient({
    http: ctx.http,
    health,
    onEvent: (event) => {
      // Enqueue synchronously without awaiting so WS callbacks never stall per-channel FIFO ordering.
      void pipeline.process(event).catch(() => undefined)
    },
    probe: () => httpClient.action('get_status', {}),
    login: () => httpClient.action('get_login_info', {}),
    onAuthError,
    onUnsupportedHost: (message) => {
      if (!disposed) {
        try {
          ctx.logger.error('qq.host_unsupported', { unsupportedHost: true, message })
        } catch {
          // Ignore logger failures if host context is already unloaded.
        }
      }
    },
    ...(deps?.now !== undefined ? { now: deps.now } : {}),
    ...(deps?.random !== undefined ? { random: deps.random } : {}),
    ...(deps?.authTransport !== undefined ? { authTransport: deps.authTransport } : {}),
  })
  wsClientRef.current = wsClient

  const sender = new QqSender({
    config: () => config,
    secrets: () => readSecretTokens(ctx),
    canSend: (channel) => !disposed && pipeline.state.getState(channel).mode !== 'muted',
    hasSeenMessage: pipeline.hasSeenMessage,
    noteSelfMessage: pipeline.noteSelfMessage,
    action: (name, params) => httpClient.action(name, params),
    ingest: (event) => ctx.memory.ingest(event),
    ...(deps?.sleep !== undefined ? { sleep: deps.sleep } : {}),
    ...(deps?.now !== undefined ? { now: deps.now } : {}),
  })

  const collectAdapter =
    config.stickers.collectEnabled && config.stickers.collectAction !== ''
      ? async (stickerId: string): Promise<void> => {
          await httpClient.action(config.stickers.collectAction, {
            [config.stickers.collectParamKey]: stickerId,
          })
        }
      : undefined

  const stickerLibrary = new StickerLibrary({
    action: (name, params) => httpClient.action(name, params),
    storage: ctx.storage,
    memory: ctx.memory,
    ...(collectAdapter !== undefined ? { collect: collectAdapter } : {}),
    collectPerMinute: config.stickers.collectPerMinute,
    collectPerHour: config.stickers.collectPerHour,
    ...(deps?.now !== undefined ? { now: deps.now } : {}),
    ttlMs: config.stickers.syncTtlMs,
  })

  const voiceCodec = createVoiceCodec(config.media.ffmpegPath)
  const voiceLibrary = new VoiceLibrary({
    storage: ctx.storage,
    settings: () => config.voice,
    probeDuration: voiceCodec.probeDuration,
    normalize: voiceCodec.normalize,
    send: (channel, segment) => sender.sendRecord(channel, segment),
    readSent: (channel, messageId) => sender.readSentRecord(channel, messageId),
  })

  const disposables: Disposable[] = [
    ctx.channel.provide({
      send: async (channel, message) => {
        if (disposed) {
          throw new BrainError('UNAVAILABLE', 'QQ 通道插件已停用')
        }
        if (typeof message?.text !== 'string' || message.text.trim() === '') {
          throw new BrainError('INVALID_ARGUMENT', 'QQ 通道发送消息必须包含非空文本')
        }
        const ids = await sender.send({
          channel,
          messages: [message.text],
          ...(message.replyTo ? { replyToMessageId: message.replyTo } : {}),
        })
        const messageId = ids.at(-1)
        return messageId !== undefined ? { messageId } : {}
      },
      members: pipeline.members,
      resolveIdentity: pipeline.resolveIdentity,
    }),

    registerQqTools(ctx, {
      config: () => config,
      canSend: (channel) => !disposed && pipeline.state.getState(channel).mode !== 'muted',
      isDisposed: () => disposed,
      getSelfId: () => wsClient.selfId,
      action: (name, params) => httpClient.action(name, params),
      httpFetch: ctx.http.fetch,
      memory: ctx.memory,
      mediaStore,
      socialState: pipeline.state,
      sender,
      sendSticker: async (req) => {
        const sticker =
          (await stickerLibrary.detail(req.stickerId))
          ?? (await stickerLibrary.list()).find((item) => item.id === req.stickerId)
        if (!sticker) {
          throw new BrainError('NOT_FOUND', '找不到该收藏表情')
        }
        return sender.sendSticker({
          channel: req.channel,
          sticker,
          ...(req.replyToMessageId !== undefined ? { replyToMessageId: req.replyToMessageId } : {}),
          ...(req.atUserId !== undefined ? { atUserId: req.atUserId } : {}),
        })
      },
      recentSpeakers: pipeline.recentSpeakers,
      listGroupMembers: (groupId) => fetchGroupMembers(httpClient, groupId),
      hasSeenMessage: pipeline.hasSeenMessage,
      noteSelfMessage: pipeline.noteSelfMessage,
      stickerLibrary,
      voiceLibrary,
      ...(deps?.now !== undefined ? { now: deps.now } : {}),
    }),

    registerQqUiRoutes(ctx, {
      config: () => config,
      health: () => ({
        state: health.state,
        authError: health.authError,
        ...(health.lastHeartbeat !== undefined ? { lastHeartbeat: health.lastHeartbeat } : {}),
      }),
      selfIdentity: () => ({
        ...(wsClient.selfId !== undefined ? { selfId: wsClient.selfId } : {}),
        ...(wsClient.selfNickname !== undefined ? { selfNickname: wsClient.selfNickname } : {}),
      }),
      reconnectCount: () => wsClient.reconnectCount,
      channels: () => {
        const known = new Set<string>([
          ...config.allowPrivate.map((id) => `qq:private:${id}`),
          ...config.allowGroups.map((id) => `qq:group:${id}`),
          ...Object.keys(pipeline.state.exportState().channels),
          ...Object.keys(pipeline.cursor.snapshot()),
        ])
        return [...known]
      },
      channelState: (channel): QqChannelUiInput => {
        const social = pipeline.state.getState(channel)
        const cursorState = pipeline.cursor.get(channel)
        return {
          channel,
          mode: social.mode,
          unreadCount: cursorState.unreadCount,
          ...(social.lastActivityAt !== undefined ? { lastActivityAt: social.lastActivityAt } : {}),
          ...(social.lastWakeAt !== undefined ? { lastWakeAt: social.lastWakeAt } : {}),
          ...(social.wakeTimestamps !== undefined ? { wakeTimestamps: social.wakeTimestamps } : {}),
          ...(social.config.maxWakePerHour !== undefined ? { maxWakePerHour: social.config.maxWakePerHour } : {}),
        }
      },
      socialState: pipeline.state,
      readCursor: pipeline.cursor,
      stickers: async () => {
        if (disposed || !config.stickers.enabled) {
          return { cachedCount: 0, items: [] }
        }
        try {
          const items = await stickerLibrary.list(false)
          return { cachedCount: items.length, items }
        } catch {
          return { cachedCount: 0, items: [] }
        }
      },
      action: (name, params) => httpClient.action(name, params),
      ...(deps?.probeFfmpeg !== undefined ? { probeFfmpeg: deps.probeFfmpeg } : {}),
      ...(deps?.now !== undefined ? { now: deps.now } : {}),
    }),
  ]

  let stopPromise: Promise<void> | undefined
  const handle: QqPluginHandle = {
    config,
    health,
    startBackground: () => {
      if (disposed) return
      wsClient.start()
    },
    stop: () => {
      disposed = true
      if (stopPromise === undefined) {
        stopPromise = (async () => {
          for (let i = disposables.length - 1; i >= 0; i--) {
            try {
              disposables[i]?.()
            } catch {
              // Ignore individual dispose errors during teardown.
            }
          }
          pipeline.dispose()
          await wsClient.stop()
        })()
      }
      return stopPromise
    },
  }

  if (deps?.autoConnect !== false) {
    queueMicrotask(() => {
      if (!disposed) {
        handle.startBackground()
      }
    })
  }

  return handle
}

export const apply: PluginApply = async (ctx, rawConfig) => {
  await applyQqPlugin(ctx, rawConfig)
}
