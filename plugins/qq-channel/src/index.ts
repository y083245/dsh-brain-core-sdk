// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrainError } from '@dsh-brain-core/sdk'
import { applyQqPlugin, type QqPluginHandle } from './apply.ts'
import { runStdioPlugin } from './rpc/stdio-bridge.ts'

export const PLUGIN_ID = 'qq'
export const PLUGIN_VERSION = '0.1.0'

export {
  DEFAULT_QQ_CONFIG,
  configSchema,
  type QqConfig,
  type QqMediaSettings,
  type QqSendSettings,
  type QqStickersSettings,
  type QqVoiceSettings,
  type QqWakeSettings,
  type SendGapMode,
} from './config.ts'

export {
  apply,
  applyQqPlugin,
  type QqApplyDeps,
  type QqPluginHandle,
} from './apply.ts'

export {
  MAX_LINE_BYTES,
  MethodNotFound,
  StdioRpcConnection,
  fromRpcError,
  runStdioPlugin,
  toRpcError,
  type RpcError,
  type RunStdioPluginOptions,
  type StdioPluginHandle,
} from './rpc/stdio-bridge.ts'

export {
  OneBotHealth,
  OneBotHttpClient,
  OneBotHttpError,
  OneBotWsClient,
  normalizeAccountId,
  normalizeMessageId,
  type HealthState,
  type OneBotEvent,
  type OneBotId,
  type OneBotSegment,
  type OneBotWsOptions,
} from './onebot/index.ts'

export {
  MediaStore,
  allowed,
  cleanText,
  createInboundPipeline,
  decodeSegments,
  parseSegments,
  readForwardSummary,
  type AccessConfig,
  type InboundOptions,
  type MediaEntry,
  type ParsedSegments,
  type Segment,
} from './inbound/index.ts'

export {
  QqSender,
  SendRateLimit,
  SentMessageError,
  StickerLibrary,
  VoiceLibrary,
  createVoiceCodec,
  normalizeImage,
  plainQqText,
  readMessageImages,
  sensitiveReason,
  splitText,
  type ImageLocation,
  type MessageImagesOptions,
  type SendRequest,
  type SendStickerRequest,
  type SenderDependencies,
  type Sticker,
  type StickerDependencies,
  type VoiceDependencies,
} from './outbound/index.ts'

export {
  QQ_TOOL_NAMES,
  registerQqTools,
  type GroupMemberInfo,
  type QqToolsDeps,
  type SendStickerRequest as ToolSendStickerRequest,
} from './tools/index.ts'

export {
  escapeHtml,
  probeFfmpeg,
  registerQqUiRoutes,
  renderStatusPageHtml,
  sanitizeEndpointOrigin,
  type ProbeResultItem,
  type ProbeStatusItem,
  type QqChannelBudgetView,
  type QqChannelStatusItem,
  type QqChannelUiInput,
  type QqFfmpegStatusView,
  type QqProbeReport,
  type QqStatusSnapshot,
  type QqUiDeps,
  type StatusPageInput,
} from './ui/index.ts'

function isMainModule(): boolean {
  const entry = process.argv[1]
  if (typeof entry !== 'string' || entry === '') return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(entry))
  } catch {
    return false
  }
}

function formatSanitizedStartupError(error: unknown): string {
  if (error instanceof BrainError) {
    return `[qq-channel] startup failed (${error.code}): ${error.message}\n`
  }
  if (error instanceof Error) {
    return `[qq-channel] startup failed (${error.name})\n`
  }
  return '[qq-channel] startup failed (unknown error)\n'
}

if (isMainModule()) {
  let activeHandle: QqPluginHandle | undefined
  let signalHandled = false

  const handleSignal = (): void => {
    if (signalHandled) return
    signalHandled = true
    void Promise.resolve()
      .then(() => activeHandle?.stop())
      .catch(() => undefined)
      .finally(() => {
        if (!process.stdin.destroyed) {
          process.stdin.destroy()
        }
      })
  }

  process.once('SIGTERM', handleSignal)
  process.once('SIGINT', handleSignal)

  void runStdioPlugin({
    apply: async (ctx, cfg) => {
      const handle = await applyQqPlugin(ctx, cfg, { autoConnect: false })
      activeHandle = handle
      return handle
    },
  })
    .catch((error: unknown) => {
      process.stderr.write(formatSanitizedStartupError(error))
      process.exitCode = 1
      if (!process.stdin.destroyed) {
        process.stdin.destroy()
      }
    })
    .finally(() => {
      process.off('SIGTERM', handleSignal)
      process.off('SIGINT', handleSignal)
    })
}
