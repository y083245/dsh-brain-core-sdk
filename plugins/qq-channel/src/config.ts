// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { GroupTrigger } from '@dsh-brain-core/chat-kit'
import { Schema } from '@dsh-brain-core/sdk'

export type SendGapMode = 'auto' | 'byLength' | 'fixed'

export interface QqWakeSettings {
  readonly groupTrigger: GroupTrigger
  readonly keywords: readonly string[]
  readonly shortAsciiWordBoundary: boolean
  readonly speakerIds: readonly string[]
  readonly batchWindowMs: number
  readonly quietDebounceMs: number
  readonly activeWindowMs: number
  readonly lurkAfterMs: number
  readonly minWakeIntervalMs: number
  readonly maxWakePerHour: number
  readonly replyProbability: number
  readonly pokeEnabled: boolean
}

export interface QqSendSettings {
  readonly maxBurst: number
  readonly maxMessageChars: number
  readonly hardSplitChars: number
  readonly maxPerMinute: number
  readonly maxPerHour: number
  readonly gapMode: SendGapMode
  readonly fixedGapMs: number
  readonly baseGapMs: number
  readonly msPerChar: number
  readonly maxGapMs: number
}

export interface QqMediaSettings {
  readonly maxDownloadBytes: number
  readonly maxImageBytes: number
  readonly maxTotalImageBytes: number
  readonly maxImageDimension: number
  readonly gifFrames: number
  readonly gifCellPx: number
  readonly ffmpegPath: string
  readonly timeoutMs: number
}

export interface QqStickersSettings {
  readonly enabled: boolean
  readonly syncTtlMs: number
  readonly maxListCount: number
  readonly collectEnabled: boolean
  readonly collectPerMinute: number
  readonly collectPerHour: number
  readonly collectAction: string
  readonly collectParamKey: string
}

export interface QqVoiceSettings {
  readonly enabled: boolean
  readonly maxSeconds: number
  readonly maxBytes: number
  readonly maxPerMinute: number
  readonly maxPerHour: number
  readonly normalizeLoudness: boolean
  readonly verifyReadback: boolean
}

export interface QqConfig {
  readonly onebotHttpUrl: string
  readonly onebotWsUrl: string
  readonly ownerQQ: string
  readonly allowPrivate: readonly string[]
  readonly allowGroups: readonly string[]
  readonly denyPrivate: readonly string[]
  readonly denyGroups: readonly string[]
  readonly ignoredSenders: readonly string[]
  readonly allowAllWhenEmpty: boolean
  readonly botAliases: readonly string[]
  readonly wake: QqWakeSettings
  readonly send: QqSendSettings
  readonly media: QqMediaSettings
  readonly stickers: QqStickersSettings
  readonly voice: QqVoiceSettings
}

export const DEFAULT_QQ_CONFIG: QqConfig = {
  onebotHttpUrl: 'http://127.0.0.1:3000',
  onebotWsUrl: 'ws://127.0.0.1:3001',
  ownerQQ: '',
  allowPrivate: [],
  allowGroups: [],
  denyPrivate: [],
  denyGroups: [],
  ignoredSenders: [],
  allowAllWhenEmpty: false,
  botAliases: [],
  wake: {
    groupTrigger: 'mention',
    keywords: [],
    shortAsciiWordBoundary: true,
    speakerIds: [],
    batchWindowMs: 4000,
    quietDebounceMs: 1500,
    activeWindowMs: 300_000,
    lurkAfterMs: 900_000,
    minWakeIntervalMs: 15_000,
    maxWakePerHour: 24,
    replyProbability: 0,
    pokeEnabled: true,
  },
  send: {
    maxBurst: 6,
    maxMessageChars: 500,
    hardSplitChars: 4000,
    maxPerMinute: 8,
    maxPerHour: 60,
    gapMode: 'auto',
    fixedGapMs: 800,
    baseGapMs: 400,
    msPerChar: 45,
    maxGapMs: 3500,
  },
  media: {
    maxDownloadBytes: 5 * 1024 * 1024,
    maxImageBytes: 1024 * 1024,
    maxTotalImageBytes: 2_516_582,
    maxImageDimension: 1280,
    gifFrames: 6,
    gifCellPx: 240,
    ffmpegPath: '',
    timeoutMs: 10_000,
  },
  stickers: {
    enabled: true,
    syncTtlMs: 300_000,
    maxListCount: 30,
    collectEnabled: true,
    collectPerMinute: 2,
    collectPerHour: 10,
    collectAction: '',
    collectParamKey: 'id',
  },
  voice: {
    enabled: false,
    maxSeconds: 300,
    maxBytes: 4_194_304,
    maxPerMinute: 2,
    maxPerHour: 10,
    normalizeLoudness: true,
    verifyReadback: true,
  },
}

const rawConfigSchema = Schema.object({
  onebotHttpUrl: Schema.string().min(1).default(DEFAULT_QQ_CONFIG.onebotHttpUrl),
  onebotWsUrl: Schema.string().min(1).default(DEFAULT_QQ_CONFIG.onebotWsUrl),
  ownerQQ: Schema.string().pattern(/^\d*$/).default(DEFAULT_QQ_CONFIG.ownerQQ),
  allowPrivate: Schema.array(Schema.string()).default([]),
  allowGroups: Schema.array(Schema.string()).default([]),
  denyPrivate: Schema.array(Schema.string()).default([]),
  denyGroups: Schema.array(Schema.string()).default([]),
  ignoredSenders: Schema.array(Schema.string()).default([]),
  allowAllWhenEmpty: Schema.boolean().default(DEFAULT_QQ_CONFIG.allowAllWhenEmpty),
  botAliases: Schema.array(Schema.string()).default([]),
  wake: Schema.object({
    groupTrigger: Schema.union(['mention', 'keyword', 'always']).default(DEFAULT_QQ_CONFIG.wake.groupTrigger),
    keywords: Schema.array(Schema.string()).default([]),
    shortAsciiWordBoundary: Schema.boolean().default(DEFAULT_QQ_CONFIG.wake.shortAsciiWordBoundary),
    speakerIds: Schema.array(Schema.string()).default([]),
    batchWindowMs: Schema.number().min(0).step(1).default(DEFAULT_QQ_CONFIG.wake.batchWindowMs),
    quietDebounceMs: Schema.number().min(0).step(1).default(DEFAULT_QQ_CONFIG.wake.quietDebounceMs),
    activeWindowMs: Schema.number().min(0).step(1).default(DEFAULT_QQ_CONFIG.wake.activeWindowMs),
    lurkAfterMs: Schema.number().min(0).step(1).default(DEFAULT_QQ_CONFIG.wake.lurkAfterMs),
    minWakeIntervalMs: Schema.number().min(0).step(1).default(DEFAULT_QQ_CONFIG.wake.minWakeIntervalMs),
    maxWakePerHour: Schema.number().min(0).step(1).default(DEFAULT_QQ_CONFIG.wake.maxWakePerHour),
    replyProbability: Schema.number().min(0).max(1).default(DEFAULT_QQ_CONFIG.wake.replyProbability),
    pokeEnabled: Schema.boolean().default(DEFAULT_QQ_CONFIG.wake.pokeEnabled),
  }).default({
    ...DEFAULT_QQ_CONFIG.wake,
    keywords: [...DEFAULT_QQ_CONFIG.wake.keywords],
    speakerIds: [...DEFAULT_QQ_CONFIG.wake.speakerIds],
  }),
  send: Schema.object({
    maxBurst: Schema.number().min(1).max(6).step(1).default(DEFAULT_QQ_CONFIG.send.maxBurst),
    maxMessageChars: Schema.number().min(1).max(4000).step(1).default(DEFAULT_QQ_CONFIG.send.maxMessageChars),
    hardSplitChars: Schema.number().min(1).max(4000).step(1).default(DEFAULT_QQ_CONFIG.send.hardSplitChars),
    maxPerMinute: Schema.number().min(1).step(1).default(DEFAULT_QQ_CONFIG.send.maxPerMinute),
    maxPerHour: Schema.number().min(1).step(1).default(DEFAULT_QQ_CONFIG.send.maxPerHour),
    gapMode: Schema.union(['auto', 'byLength', 'fixed']).default(DEFAULT_QQ_CONFIG.send.gapMode),
    fixedGapMs: Schema.number().min(0).step(1).default(DEFAULT_QQ_CONFIG.send.fixedGapMs),
    baseGapMs: Schema.number().min(0).step(1).default(DEFAULT_QQ_CONFIG.send.baseGapMs),
    msPerChar: Schema.number().min(0).step(1).default(DEFAULT_QQ_CONFIG.send.msPerChar),
    maxGapMs: Schema.number().min(0).step(1).default(DEFAULT_QQ_CONFIG.send.maxGapMs),
  }).default({ ...DEFAULT_QQ_CONFIG.send }),
  media: Schema.object({
    maxDownloadBytes: Schema.number().min(1024).max(8 * 1024 * 1024).step(1).default(DEFAULT_QQ_CONFIG.media.maxDownloadBytes),
    maxImageBytes: Schema.number().min(1024).max(8 * 1024 * 1024).step(1).default(DEFAULT_QQ_CONFIG.media.maxImageBytes),
    maxTotalImageBytes: Schema.number().min(1024).max(8 * 1024 * 1024).step(1).default(DEFAULT_QQ_CONFIG.media.maxTotalImageBytes),
    maxImageDimension: Schema.number().min(64).step(1).default(DEFAULT_QQ_CONFIG.media.maxImageDimension),
    gifFrames: Schema.number().min(1).max(16).step(1).default(DEFAULT_QQ_CONFIG.media.gifFrames),
    gifCellPx: Schema.number().min(32).step(1).default(DEFAULT_QQ_CONFIG.media.gifCellPx),
    ffmpegPath: Schema.string().default(DEFAULT_QQ_CONFIG.media.ffmpegPath),
    timeoutMs: Schema.number().min(500).max(60_000).step(1).default(DEFAULT_QQ_CONFIG.media.timeoutMs),
  }).default({ ...DEFAULT_QQ_CONFIG.media }),
  stickers: Schema.object({
    enabled: Schema.boolean().default(DEFAULT_QQ_CONFIG.stickers.enabled),
    syncTtlMs: Schema.number().min(0).step(1).default(DEFAULT_QQ_CONFIG.stickers.syncTtlMs),
    maxListCount: Schema.number().min(1).max(100).step(1).default(DEFAULT_QQ_CONFIG.stickers.maxListCount),
    collectEnabled: Schema.boolean().default(DEFAULT_QQ_CONFIG.stickers.collectEnabled),
    collectPerMinute: Schema.number().min(1).step(1).default(DEFAULT_QQ_CONFIG.stickers.collectPerMinute),
    collectPerHour: Schema.number().min(1).step(1).default(DEFAULT_QQ_CONFIG.stickers.collectPerHour),
    collectAction: Schema.string().pattern(/^(?:|[a-z][a-z0-9_]{0,63})$/).default(DEFAULT_QQ_CONFIG.stickers.collectAction),
    collectParamKey: Schema.string().pattern(/^[a-z][a-z0-9_]{0,31}$/).default(DEFAULT_QQ_CONFIG.stickers.collectParamKey),
  }).default({ ...DEFAULT_QQ_CONFIG.stickers }),
  voice: Schema.object({
    enabled: Schema.boolean().default(DEFAULT_QQ_CONFIG.voice.enabled),
    maxSeconds: Schema.number().min(1).max(600).step(1).default(DEFAULT_QQ_CONFIG.voice.maxSeconds),
    maxBytes: Schema.number().min(1024).max(4_194_304).step(1).default(DEFAULT_QQ_CONFIG.voice.maxBytes),
    maxPerMinute: Schema.number().min(1).step(1).default(DEFAULT_QQ_CONFIG.voice.maxPerMinute),
    maxPerHour: Schema.number().min(1).step(1).default(DEFAULT_QQ_CONFIG.voice.maxPerHour),
    normalizeLoudness: Schema.boolean().default(DEFAULT_QQ_CONFIG.voice.normalizeLoudness),
    verifyReadback: Schema.boolean().default(DEFAULT_QQ_CONFIG.voice.verifyReadback),
  }).default({ ...DEFAULT_QQ_CONFIG.voice }),
})

export const configSchema: Schema<unknown, QqConfig> = rawConfigSchema as unknown as Schema<unknown, QqConfig>

export default configSchema
