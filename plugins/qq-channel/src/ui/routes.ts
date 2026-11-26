// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { execFile } from 'node:child_process'
import { basename, isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import type { ChatMode, ReadCursor, SocialStateMachine } from '@brain-core/chat-kit'
import type { BrainContext, Disposable } from '@brain-core/sdk'
import type { QqConfig } from '../config.ts'
import { cleanText } from '../inbound/segments.ts'
import type { HealthState } from '../onebot/health.ts'
import { OneBotHttpError } from '../onebot/http-client.ts'
import {
  renderStatusPageHtml,
  sanitizeEndpointOrigin,
  type QqChannelStatusItem,
  type QqFfmpegStatusView,
  type QqStatusSnapshot,
} from './status-page.ts'

const runFile = promisify(execFile)
const HOUR_MS = 3_600_000

export interface QqChannelUiInput {
  readonly channel: string
  readonly mode: ChatMode
  readonly unreadCount: number
  readonly lastActivityAt?: number
  readonly lastWakeAt?: number
  readonly wakeTimestamps?: readonly number[]
  readonly maxWakePerHour?: number
}

export interface QqUiDeps {
  readonly config: () => QqConfig
  readonly health: () => {
    readonly state: HealthState
    readonly authError: boolean
    readonly lastHeartbeat?: number
  }
  readonly selfIdentity?: () => {
    readonly selfId?: string
    readonly selfNickname?: string
  }
  readonly reconnectCount?: () => number
  readonly channels: () => readonly string[] | Promise<readonly string[]>
  readonly channelState?: (channel: string) => QqChannelUiInput | undefined
  readonly socialState?: Pick<SocialStateMachine, 'getState'>
  readonly readCursor?: Pick<ReadCursor, 'get'>
  readonly stickers: () =>
    | Promise<{ readonly cachedCount: number; readonly items: readonly { readonly id: string }[] }>
    | { readonly cachedCount: number; readonly items: readonly { readonly id: string }[] }
  readonly action: (action: string, params?: unknown) => Promise<unknown>
  readonly probeFfmpeg?: (ffmpegPath?: string) => Promise<QqFfmpegStatusView>
  readonly now?: () => number
}

export type ProbeResultItem =
  | { readonly ok: true; readonly userId: string | null; readonly nickname: string | null }
  | { readonly ok: false; readonly errorKind: 'auth' | 'http' | 'protocol' | 'unknown' }

export type ProbeStatusItem =
  | { readonly ok: true; readonly online: boolean; readonly good: boolean }
  | { readonly ok: false; readonly errorKind: 'auth' | 'http' | 'protocol' | 'unknown' }

export interface QqProbeReport {
  readonly ok: boolean
  readonly errorKind?: 'auth' | 'http' | 'protocol' | 'unknown'
  readonly endpoints: {
    readonly httpOrigin: string
    readonly wsOrigin: string
  }
  readonly loginInfo: ProbeResultItem
  readonly status: ProbeStatusItem
  readonly probedAt: number
}

/** Probe ffmpeg availability via execFile without shell; silently degrades on any error. */
export async function probeFfmpeg(ffmpegPath?: string): Promise<QqFfmpegStatusView> {
  const executable = ffmpegPath && ffmpegPath.trim() !== '' ? ffmpegPath.trim() : 'ffmpeg'
  if (
    executable !== 'ffmpeg'
    && (!isAbsolute(executable) || !/^ffmpeg(?:\.exe)?$/i.test(basename(executable)))
  ) {
    return { available: false }
  }
  try {
    const { stdout } = await runFile(executable, ['-version'], {
      timeout: 2000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    })
    const firstLine = typeof stdout === 'string' ? stdout.split(/\r?\n/, 1)[0]?.trim() : ''
    if (firstLine && firstLine.length > 0) {
      return { available: true, version: cleanText(firstLine).slice(0, 120) }
    }
    return { available: true }
  } catch {
    return { available: false }
  }
}

function extractErrorKind(error: unknown): 'auth' | 'http' | 'protocol' | 'unknown' {
  if (error instanceof OneBotHttpError) return error.kind
  if (typeof error === 'object' && error !== null && 'kind' in error) {
    const kind = (error as { readonly kind?: unknown }).kind
    if (kind === 'auth' || kind === 'http' || kind === 'protocol') return kind
  }
  return 'unknown'
}

function buildChannelItems(
  channelNames: readonly string[],
  config: QqConfig,
  deps: QqUiDeps,
  now: number,
): readonly QqChannelStatusItem[] {
  const unique = [...new Set(channelNames)]
  const cutoff = now - HOUR_MS
  return unique.map((channel) => {
    const provided = deps.channelState?.(channel)
    if (provided) {
      const limit = provided.maxWakePerHour ?? config.wake.maxWakePerHour
      const used = (provided.wakeTimestamps ?? []).filter((ts) => ts > cutoff).length
      return {
        channel,
        mode: provided.mode,
        unreadCount: provided.unreadCount,
        lastActivityAt: provided.lastActivityAt ?? null,
        lastWakeAt: provided.lastWakeAt ?? null,
        hourlyBudget: {
          used,
          limit,
          remaining: Math.max(0, limit - used),
        },
      }
    }
    const social = deps.socialState?.getState(channel)
    const cursor = deps.readCursor?.get(channel)
    const limit = social?.config.maxWakePerHour ?? config.wake.maxWakePerHour
    const used = (social?.wakeTimestamps ?? []).filter((ts) => ts > cutoff).length
    return {
      channel,
      mode: social?.mode ?? 'lurking',
      unreadCount: cursor?.unreadCount ?? 0,
      lastActivityAt: social?.lastActivityAt ?? null,
      lastWakeAt: social?.lastWakeAt ?? null,
      hourlyBudget: {
        used,
        limit,
        remaining: Math.max(0, limit - used),
      },
    }
  })
}

async function readSanitizedStickers(deps: QqUiDeps, config: QqConfig): Promise<{
  readonly enabled: boolean
  readonly cachedCount: number
  readonly items: readonly { readonly id: string }[]
}> {
  if (!config.stickers.enabled) {
    return { enabled: false, cachedCount: 0, items: [] }
  }
  try {
    const summary = await deps.stickers()
    const items = summary.items.map((item) => ({ id: cleanText(item.id) })).filter((item) => item.id !== '')
    return {
      enabled: true,
      cachedCount: Math.max(items.length, summary.cachedCount),
      items,
    }
  } catch {
    return { enabled: true, cachedCount: 0, items: [] }
  }
}

async function buildStatusSnapshot(
  deps: QqUiDeps,
  ffmpeg: QqFfmpegStatusView,
  channelCount: number,
  stickerCachedCount: number,
  now: number,
): Promise<QqStatusSnapshot> {
  const config = deps.config()
  const health = deps.health()
  const identity = deps.selfIdentity?.()
  const lastHeartbeat = health.lastHeartbeat ?? null
  return {
    health: {
      state: health.state,
      authError: health.authError,
      lastHeartbeat,
      heartbeatAgeMs: lastHeartbeat !== null ? Math.max(0, now - lastHeartbeat) : null,
    },
    identity: {
      selfId: identity?.selfId ?? null,
      selfNickname: identity?.selfNickname ? cleanText(identity.selfNickname).slice(0, 64) : null,
    },
    reconnectCount: deps.reconnectCount?.() ?? 0,
    endpoints: {
      httpOrigin: sanitizeEndpointOrigin(config.onebotHttpUrl),
      wsOrigin: sanitizeEndpointOrigin(config.onebotWsUrl),
    },
    access: {
      failClosed: !config.allowAllWhenEmpty,
      allowAllWhenEmpty: config.allowAllWhenEmpty,
      ownerQQ: config.ownerQQ || null,
      allowPrivate: [...config.allowPrivate],
      allowGroups: [...config.allowGroups],
      denyPrivate: [...config.denyPrivate],
      denyGroups: [...config.denyGroups],
      ignoredSenders: [...config.ignoredSenders],
    },
    stickers: {
      enabled: config.stickers.enabled,
      collectEnabled: config.stickers.collectEnabled,
      cachedCount: stickerCachedCount,
    },
    voice: {
      enabled: config.voice.enabled,
    },
    ffmpeg,
    channelsCount: channelCount,
    timestamp: now,
  }
}

/** Register read-only status UI, ops HTTP routes, and console page; returns a combined Disposable. */
export function registerQqUiRoutes(
  ctx: Pick<BrainContext, 'http' | 'console'>,
  deps: QqUiDeps,
): Disposable {
  const runProbeFfmpeg = deps.probeFfmpeg ?? probeFfmpeg
  const nowFn = deps.now ?? Date.now

  const disposables: Disposable[] = [
    ctx.http.route('GET', '/ui', async () => {
      const now = nowFn()
      const config = deps.config()
      const [channelNames, stickerSummary, ffmpeg] = await Promise.all([
        deps.channels(),
        readSanitizedStickers(deps, config),
        runProbeFfmpeg(config.media.ffmpegPath),
      ])
      const channels = buildChannelItems(channelNames, config, deps, now)
      const status = await buildStatusSnapshot(deps, ffmpeg, channels.length, stickerSummary.cachedCount, now)
      return renderStatusPageHtml({ status, channels })
    }),

    ctx.http.route('GET', '/status', async () => {
      const now = nowFn()
      const config = deps.config()
      const [channelNames, stickerSummary, ffmpeg] = await Promise.all([
        deps.channels(),
        readSanitizedStickers(deps, config),
        runProbeFfmpeg(config.media.ffmpegPath),
      ])
      return buildStatusSnapshot(deps, ffmpeg, [...new Set(channelNames)].length, stickerSummary.cachedCount, now)
    }),

    ctx.http.route('POST', '/probe', async (): Promise<QqProbeReport> => {
      const now = nowFn()
      const config = deps.config()
      const [loginRes, statusRes] = await Promise.allSettled([
        deps.action('get_login_info', {}),
        deps.action('get_status', {}),
      ])

      let loginInfo: ProbeResultItem
      if (loginRes.status === 'fulfilled') {
        const raw = (loginRes.value && typeof loginRes.value === 'object'
          ? loginRes.value
          : {}) as Record<string, unknown>
        const rawId = raw.user_id !== undefined && raw.user_id !== null ? String(raw.user_id) : ''
        const userId = /^[1-9]\d*$/.test(rawId) ? rawId : null
        const nickname = typeof raw.nickname === 'string' && raw.nickname !== ''
          ? cleanText(raw.nickname).slice(0, 64)
          : null
        loginInfo = { ok: true, userId, nickname }
      } else {
        loginInfo = { ok: false, errorKind: extractErrorKind(loginRes.reason) }
      }

      let status: ProbeStatusItem
      if (statusRes.status === 'fulfilled') {
        const raw = (statusRes.value && typeof statusRes.value === 'object'
          ? statusRes.value
          : {}) as Record<string, unknown>
        status = {
          ok: true,
          online: raw.online === true,
          good: raw.good === true,
        }
      } else {
        status = { ok: false, errorKind: extractErrorKind(statusRes.reason) }
      }

      const errorKind = !loginInfo.ok
        ? loginInfo.errorKind
        : !status.ok
          ? status.errorKind
          : undefined

      return {
        ok: loginInfo.ok && status.ok,
        ...(errorKind !== undefined ? { errorKind } : {}),
        endpoints: {
          httpOrigin: sanitizeEndpointOrigin(config.onebotHttpUrl),
          wsOrigin: sanitizeEndpointOrigin(config.onebotWsUrl),
        },
        loginInfo,
        status,
        probedAt: now,
      }
    }),

    ctx.http.route('GET', '/channels', async () => {
      const now = nowFn()
      const config = deps.config()
      const channelNames = await deps.channels()
      const items = buildChannelItems(channelNames, config, deps, now)
      return {
        items,
        total: items.length,
        timestamp: now,
      }
    }),

    ctx.http.route('GET', '/stickers', async () => {
      const config = deps.config()
      return readSanitizedStickers(deps, config)
    }),

    ctx.console.page({
      id: 'qq-status',
      title: 'QQ 通道',
      entry: '/api/v1/plugins/qq/ui',
    }),
  ]

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (let i = disposables.length - 1; i >= 0; i--) {
      disposables[i]?.()
    }
  }
}
