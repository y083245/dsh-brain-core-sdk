import type {
  ChannelSocialState,
  ChatClock,
  ChatMode,
  GroupTrigger,
  IncomingChatEvent,
  WakeConfig,
  WakeDecision,
  WakeReason,
} from './types.ts'
import {
  assertFiniteNumber,
  assertNonEmptyString,
  assertNonNegativeFinite,
  isPlainObject,
} from './validate.ts'

export const DEFAULT_WAKE_CONFIG: WakeConfig = {
  groupTrigger: 'mention',
  keywords: [],
  activeWindowMs: 5 * 60_000,
  lurkAfterMs: 15 * 60_000,
  minWakeIntervalMs: 3_000,
  quietDebounceMs: 1_500,
}

const VALID_MODES: ReadonlySet<string> = new Set<ChatMode>(['active', 'lurking', 'muted'])
const VALID_TRIGGERS: ReadonlySet<string> = new Set<GroupTrigger>(['mention', 'keyword', 'always'])
const HOUR_MS = 3_600_000
const SHORT_ASCII_KEYWORD_RE = /^[a-z0-9]{1,4}$/i

export type WakeConfigPatch = Partial<WakeConfig> & { readonly mode?: ChatMode }

export interface SocialStateSnapshot {
  readonly version: 1
  readonly channels: Readonly<Record<string, ChannelSocialState>>
}

export interface SocialStateMachine {
  getState(channel: string): ChannelSocialState
  updateConfig(channel: string, patch: WakeConfigPatch): ChannelSocialState
  evaluateWake(channel: string, event: IncomingChatEvent, now?: number): WakeDecision
  exportState(): SocialStateSnapshot
  importState(snapshot: unknown): void
}

interface MutableChannelState {
  mode: ChatMode
  config: WakeConfig
  lastActivityAt: number | undefined
  lastWakeAt: number | undefined
  wakeTimestamps: number[]
}

function cloneConfig(config: WakeConfig): WakeConfig {
  return {
    groupTrigger: config.groupTrigger,
    keywords: [...config.keywords],
    activeWindowMs: config.activeWindowMs,
    lurkAfterMs: config.lurkAfterMs,
    minWakeIntervalMs: config.minWakeIntervalMs,
    quietDebounceMs: config.quietDebounceMs,
    ...(config.shortAsciiWordBoundary !== undefined
      ? { shortAsciiWordBoundary: config.shortAsciiWordBoundary }
      : {}),
    ...(config.speakerIds !== undefined ? { speakerIds: [...config.speakerIds] } : {}),
    ...(config.replyProbability !== undefined ? { replyProbability: config.replyProbability } : {}),
    ...(config.maxWakePerHour !== undefined ? { maxWakePerHour: config.maxWakePerHour } : {}),
  }
}

function cloneState(state: MutableChannelState): ChannelSocialState {
  return {
    mode: state.mode,
    config: cloneConfig(state.config),
    ...(state.lastActivityAt !== undefined ? { lastActivityAt: state.lastActivityAt } : {}),
    ...(state.lastWakeAt !== undefined ? { lastWakeAt: state.lastWakeAt } : {}),
    ...(state.config.maxWakePerHour !== undefined && state.wakeTimestamps.length > 0
      ? { wakeTimestamps: [...state.wakeTimestamps] }
      : {}),
  }
}

function parseMode(value: unknown, field = 'mode'): ChatMode {
  if (typeof value !== 'string' || !VALID_MODES.has(value)) {
    throw new RangeError(`${field} must be one of: active, lurking, muted`)
  }
  return value as ChatMode
}

function parseGroupTrigger(value: unknown, field = 'groupTrigger'): GroupTrigger {
  if (typeof value !== 'string' || !VALID_TRIGGERS.has(value)) {
    throw new RangeError(`${field} must be one of: mention, keyword, always`)
  }
  return value as GroupTrigger
}

function parseStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError(`${field} must be an array of strings`)
  }
  return [...value]
}

function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${field} must be a boolean`)
  }
  return value
}

function parseReplyProbability(value: unknown, field = 'replyProbability'): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${field} must be a finite number in [0, 1]`)
  }
  return value === 0 ? 0 : value
}

function parseNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative integer`)
  }
  return value === 0 ? 0 : value
}

function parseWakeTimestamps(value: unknown, field = 'wakeTimestamps'): number[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    throw new TypeError(`${field} must be an array of finite numbers`)
  }
  return [...value]
}

function validateRandomRoll(value: unknown): void {
  if (value === undefined) return
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError('randomRoll must be a finite number in [0, 1)')
  }
}

function validateAndMergeConfig(base: WakeConfig, patch: Record<string, unknown>): WakeConfig {
  const groupTrigger = patch.groupTrigger === undefined
    ? base.groupTrigger
    : parseGroupTrigger(patch.groupTrigger)
  const keywords = patch.keywords === undefined
    ? [...base.keywords]
    : parseStringArray(patch.keywords, 'keywords')
  const activeWindowMs = patch.activeWindowMs === undefined
    ? base.activeWindowMs
    : assertNonNegativeFinite(patch.activeWindowMs, 'activeWindowMs')
  const lurkAfterMs = patch.lurkAfterMs === undefined
    ? base.lurkAfterMs
    : assertNonNegativeFinite(patch.lurkAfterMs, 'lurkAfterMs')
  const minWakeIntervalMs = patch.minWakeIntervalMs === undefined
    ? base.minWakeIntervalMs
    : assertNonNegativeFinite(patch.minWakeIntervalMs, 'minWakeIntervalMs')
  const quietDebounceMs = patch.quietDebounceMs === undefined
    ? base.quietDebounceMs
    : assertNonNegativeFinite(patch.quietDebounceMs, 'quietDebounceMs')
  const shortAsciiWordBoundary = patch.shortAsciiWordBoundary === undefined
    ? base.shortAsciiWordBoundary
    : parseBoolean(patch.shortAsciiWordBoundary, 'shortAsciiWordBoundary')
  const speakerIds = patch.speakerIds === undefined
    ? (base.speakerIds !== undefined ? [...base.speakerIds] : undefined)
    : parseStringArray(patch.speakerIds, 'speakerIds')
  const replyProbability = patch.replyProbability === undefined
    ? base.replyProbability
    : parseReplyProbability(patch.replyProbability)
  const maxWakePerHour = patch.maxWakePerHour === undefined
    ? base.maxWakePerHour
    : parseNonNegativeInteger(patch.maxWakePerHour, 'maxWakePerHour')

  return {
    groupTrigger,
    keywords,
    activeWindowMs,
    lurkAfterMs,
    minWakeIntervalMs,
    quietDebounceMs,
    ...(shortAsciiWordBoundary !== undefined ? { shortAsciiWordBoundary } : {}),
    ...(speakerIds !== undefined ? { speakerIds } : {}),
    ...(replyProbability !== undefined ? { replyProbability } : {}),
    ...(maxWakePerHour !== undefined ? { maxWakePerHour } : {}),
  }
}

function matchesKeyword(
  text: string,
  keywords: readonly string[],
  shortAsciiWordBoundary = false,
): boolean {
  if (keywords.length === 0) return false
  const lowerText = text.toLowerCase()
  for (const keyword of keywords) {
    const trimmed = keyword.trim()
    if (trimmed.length === 0) continue
    if (shortAsciiWordBoundary && SHORT_ASCII_KEYWORD_RE.test(trimmed)) {
      if (new RegExp(`\\b${trimmed}\\b`, 'i').test(text)) {
        return true
      }
    } else if (lowerText.includes(keyword.toLowerCase())) {
      return true
    }
  }
  return false
}

export function createSocialStateMachine(options?: {
  readonly clock?: ChatClock
  readonly defaultConfig?: Partial<WakeConfig>
}): SocialStateMachine {
  const clock: ChatClock = options?.clock ?? { now: () => Date.now() }
  let baseConfig = cloneConfig(DEFAULT_WAKE_CONFIG)
  if (options?.defaultConfig !== undefined) {
    if (!isPlainObject(options.defaultConfig)) {
      throw new TypeError('defaultConfig must be an object')
    }
    baseConfig = validateAndMergeConfig(baseConfig, options.defaultConfig)
  }

  const channels = new Map<string, MutableChannelState>()

  const getOrCreate = (channel: string): MutableChannelState => {
    const key = assertNonEmptyString(channel, 'channel')
    let state = channels.get(key)
    if (state === undefined) {
      state = {
        mode: 'lurking',
        config: cloneConfig(baseConfig),
        lastActivityAt: undefined,
        lastWakeAt: undefined,
        wakeTimestamps: [],
      }
      channels.set(key, state)
    }
    return state
  }

  return {
    getState(channel: string): ChannelSocialState {
      return cloneState(getOrCreate(channel))
    },

    updateConfig(channel: string, patch: WakeConfigPatch): ChannelSocialState {
      if (!isPlainObject(patch)) {
        throw new TypeError('patch must be an object')
      }
      const state = getOrCreate(channel)
      const nextConfig = validateAndMergeConfig(state.config, patch)
      const nextMode = patch.mode === undefined ? state.mode : parseMode(patch.mode)
      state.config = nextConfig
      state.mode = nextMode
      return cloneState(state)
    },

    evaluateWake(channel: string, event: IncomingChatEvent, now?: number): WakeDecision {
      const state = getOrCreate(channel)
      const ts = assertFiniteNumber(now ?? event.tEvent ?? clock.now(), 'now')
      validateRandomRoll(event.randomRoll)

      if (state.mode === 'muted') {
        return {
          shouldWake: false,
          reason: 'muted-skip',
          nextMode: 'muted',
          suggestedDebounceMs: 0,
        }
      }

      if (event.channelKind === 'private') {
        state.mode = 'active'
        state.lastActivityAt = ts
        state.lastWakeAt = ts
        return {
          shouldWake: true,
          reason: 'private-message',
          nextMode: 'active',
          suggestedDebounceMs: state.config.quietDebounceMs,
        }
      }

      if (
        state.mode === 'active'
        && state.lastActivityAt !== undefined
        && ts - state.lastActivityAt >= state.config.lurkAfterMs
      ) {
        state.mode = 'lurking'
      }

      let candidateReason: WakeReason
      let bypassCooldown = false

      if (event.mentioned === true || event.quotedSelf === true) {
        candidateReason = 'direct-mention'
        bypassCooldown = true
      } else if (event.isPoke === true) {
        candidateReason = 'poke'
        bypassCooldown = true
      } else if (
        event.actor !== undefined
        && state.config.speakerIds?.includes(event.actor) === true
      ) {
        candidateReason = 'speaker'
      } else if (
        matchesKeyword(event.text, state.config.keywords, state.config.shortAsciiWordBoundary === true)
      ) {
        candidateReason = 'keyword'
      } else if (state.config.groupTrigger === 'always') {
        candidateReason = 'always'
      } else if (
        state.mode === 'active'
        && state.lastActivityAt !== undefined
        && ts - state.lastActivityAt < state.config.activeWindowMs
      ) {
        candidateReason = 'active-thread'
      } else if (
        state.config.replyProbability !== undefined
        && state.config.replyProbability > 0
        && (event.randomRoll ?? Math.random()) < state.config.replyProbability
      ) {
        candidateReason = 'probability'
      } else {
        return {
          shouldWake: false,
          reason: 'lurking-skip',
          nextMode: state.mode,
          suggestedDebounceMs: 0,
        }
      }

      if (
        !bypassCooldown
        && state.lastWakeAt !== undefined
        && ts - state.lastWakeAt < state.config.minWakeIntervalMs
      ) {
        return {
          shouldWake: false,
          reason: 'cooldown-skip',
          nextMode: state.mode,
          suggestedDebounceMs: 0,
        }
      }

      const cutoff = ts - HOUR_MS
      state.wakeTimestamps = state.wakeTimestamps.filter((wakeTs) => wakeTs > cutoff)
      if (
        state.config.maxWakePerHour !== undefined
        && state.wakeTimestamps.length >= state.config.maxWakePerHour
      ) {
        return {
          shouldWake: false,
          reason: 'hourly-budget-skip',
          nextMode: state.mode,
          suggestedDebounceMs: 0,
        }
      }

      state.mode = 'active'
      state.lastActivityAt = ts
      state.lastWakeAt = ts
      state.wakeTimestamps.push(ts)
      return {
        shouldWake: true,
        reason: candidateReason,
        nextMode: 'active',
        suggestedDebounceMs: state.config.quietDebounceMs,
      }
    },

    exportState(): SocialStateSnapshot {
      const out: Record<string, ChannelSocialState> = {}
      for (const [channel, state] of channels) {
        out[channel] = cloneState(state)
      }
      return { version: 1, channels: out }
    },

    importState(snapshot: unknown): void {
      if (!isPlainObject(snapshot) || snapshot.version !== 1 || !isPlainObject(snapshot.channels)) {
        throw new TypeError('snapshot must be a valid SocialStateSnapshot (version 1)')
      }
      const next = new Map<string, MutableChannelState>()
      for (const [channel, raw] of Object.entries(snapshot.channels)) {
        const key = assertNonEmptyString(channel, 'snapshot.channel')
        if (!isPlainObject(raw)) {
          throw new TypeError(`snapshot.channels[${key}] must be an object`)
        }
        const mode = raw.mode === undefined ? 'lurking' : parseMode(raw.mode)
        const config = raw.config === undefined
          ? cloneConfig(baseConfig)
          : validateAndMergeConfig(baseConfig, isPlainObject(raw.config) ? raw.config : (() => {
            throw new TypeError(`snapshot.channels[${key}].config must be an object`)
          })())
        const lastActivityAt = raw.lastActivityAt === undefined
          ? undefined
          : assertFiniteNumber(raw.lastActivityAt, 'lastActivityAt')
        const lastWakeAt = raw.lastWakeAt === undefined
          ? undefined
          : assertFiniteNumber(raw.lastWakeAt, 'lastWakeAt')
        const wakeTimestamps = raw.wakeTimestamps === undefined
          ? []
          : parseWakeTimestamps(raw.wakeTimestamps, `snapshot.channels[${key}].wakeTimestamps`)
        next.set(key, { mode, config, lastActivityAt, lastWakeAt, wakeTimestamps })
      }
      channels.clear()
      for (const [k, v] of next) {
        channels.set(k, v)
      }
    },
  }
}

export interface WakeConfigToolSpec {
  readonly name: 'set_wake_config'
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
}

export interface ParsedWakeConfigArgs {
  readonly channel?: string
  readonly patch: WakeConfigPatch
}

export function createWakeConfigToolSpec(): WakeConfigToolSpec {
  return {
    name: 'set_wake_config',
    description: '设置聊天通道的唤醒方式、关键词、活跃窗口、自动潜水与静音状态。',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: '目标通道 ID（可选，默认当前通道）' },
        mode: {
          type: 'string',
          enum: ['active', 'lurking', 'muted'],
          description: '通道模式：active 活跃、lurking 潜水、muted 静音',
        },
        groupTrigger: {
          type: 'string',
          enum: ['mention', 'keyword', 'always'],
          description: '群聊唤醒模式',
        },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: '触发唤醒的关键词列表',
        },
        activeWindowMs: { type: 'number', minimum: 0, description: '活跃续聊窗口（毫秒）' },
        lurkAfterMs: { type: 'number', minimum: 0, description: '自动转入潜水的无活动时长（毫秒）' },
        minWakeIntervalMs: { type: 'number', minimum: 0, description: '最小唤醒冷却间隔（毫秒）' },
        quietDebounceMs: { type: 'number', minimum: 0, description: '静默防抖等待时长（毫秒）' },
        shortAsciiWordBoundary: {
          type: 'boolean',
          description: '对 1–4 字符短 ASCII 关键词启用词边界匹配',
        },
        speakerIds: {
          type: 'array',
          items: { type: 'string' },
          description: '指定发言必唤醒的用户 ID 列表',
        },
        replyProbability: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: '未命中其他触发条件时的随机插话概率（0 到 1）',
        },
        maxWakePerHour: {
          type: 'integer',
          minimum: 0,
          description: '非私聊通道每小时最大唤醒次数上限',
        },
      },
      additionalProperties: false,
    },
  }
}

export function parseWakeConfigArgs(args: unknown): ParsedWakeConfigArgs {
  if (!isPlainObject(args)) {
    throw new TypeError('set_wake_config arguments must be an object')
  }
  const channel = args.channel === undefined ? undefined : assertNonEmptyString(args.channel, 'channel')
  const patch: Record<string, unknown> = {}

  if (args.mode !== undefined) patch.mode = parseMode(args.mode)
  if (args.groupTrigger !== undefined) patch.groupTrigger = parseGroupTrigger(args.groupTrigger)
  if (args.keywords !== undefined) patch.keywords = parseStringArray(args.keywords, 'keywords')
  if (args.activeWindowMs !== undefined) {
    patch.activeWindowMs = assertNonNegativeFinite(args.activeWindowMs, 'activeWindowMs')
  }
  if (args.lurkAfterMs !== undefined) {
    patch.lurkAfterMs = assertNonNegativeFinite(args.lurkAfterMs, 'lurkAfterMs')
  }
  if (args.minWakeIntervalMs !== undefined) {
    patch.minWakeIntervalMs = assertNonNegativeFinite(args.minWakeIntervalMs, 'minWakeIntervalMs')
  }
  if (args.quietDebounceMs !== undefined) {
    patch.quietDebounceMs = assertNonNegativeFinite(args.quietDebounceMs, 'quietDebounceMs')
  }
  if (args.shortAsciiWordBoundary !== undefined) {
    patch.shortAsciiWordBoundary = parseBoolean(args.shortAsciiWordBoundary, 'shortAsciiWordBoundary')
  }
  if (args.speakerIds !== undefined) {
    patch.speakerIds = parseStringArray(args.speakerIds, 'speakerIds')
  }
  if (args.replyProbability !== undefined) {
    patch.replyProbability = parseReplyProbability(args.replyProbability)
  }
  if (args.maxWakePerHour !== undefined) {
    patch.maxWakePerHour = parseNonNegativeInteger(args.maxWakePerHour, 'maxWakePerHour')
  }

  return {
    ...(channel !== undefined ? { channel } : {}),
    patch: patch as WakeConfigPatch,
  }
}
