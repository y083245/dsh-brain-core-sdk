import type { AgentProcessStatus, CrossChannelMode } from '../api/types.ts'

export const CROSS_CHANNEL_CYCLE: Readonly<Record<CrossChannelMode, CrossChannelMode>> = {
  off: 'shadow',
  shadow: 'on',
  on: 'off',
}

export type CommandConfirmIntent = 'enable-cross-channel' | 'restart-chat'

export type ChatRestartBlockReason = 'no-model' | 'restarting' | 'stopping'

export interface ChatRestartEvaluation {
  readonly canRestart: boolean
  readonly reason: ChatRestartBlockReason | null
  readonly notice: string | null
}

export interface CommandCovenantConfig {
  readonly intent: CommandConfirmIntent
  readonly title: string
  readonly body: string
  readonly stampLabel: string
  readonly stampAriaLabel: string
  readonly consequenceId: string
  readonly cancelLabel: string
  readonly stampDisabled: boolean
  readonly blockReason: ChatRestartBlockReason | null
  readonly blockNotice: string | null
}

export interface PaletteOpenConfirmDecision {
  readonly keepConfirmOpen: boolean
  readonly dismissConfirm: boolean
  readonly suppressPalette: boolean
}

export function resolvePaletteOpenWithConfirm(
  pendingConfirm: CommandConfirmIntent | null,
  confirming: boolean,
): PaletteOpenConfirmDecision {
  if (pendingConfirm === null) {
    return { keepConfirmOpen: false, dismissConfirm: false, suppressPalette: false }
  }
  if (confirming) {
    return { keepConfirmOpen: true, dismissConfirm: false, suppressPalette: true }
  }
  return { keepConfirmOpen: false, dismissConfirm: true, suppressPalette: false }
}

export function canCloseConfirmCovenant(confirming: boolean): boolean {
  return !confirming
}

export function getNextCrossChannelMode(
  current: CrossChannelMode | null | undefined,
): CrossChannelMode {
  if (current !== null && current !== undefined) {
    return CROSS_CHANNEL_CYCLE[current]
  }
  return 'shadow'
}

export function requiresCrossChannelConfirm(targetMode: CrossChannelMode): boolean {
  return targetMode === 'on'
}

export function describeCrossChannelActionSubtitle(
  current: CrossChannelMode | null | undefined,
): string {
  const nextMode = getNextCrossChannelMode(current)
  const currentLabel = current ?? '未知'
  return requiresCrossChannelConfirm(nextMode)
    ? `当前：${currentLabel} · 需长按准许`
    : `当前：${currentLabel}`
}

export function evaluateChatRestart(
  chatProcess: AgentProcessStatus | null | undefined,
): ChatRestartEvaluation {
  if (chatProcess === null || chatProcess === undefined) {
    return { canRestart: true, reason: null, notice: null }
  }
  if (chatProcess.selection === null) {
    return {
      canRestart: false,
      reason: 'no-model',
      notice: 'chat 尚未选择模型，无法重启。请先前往「设」配置模型。',
    }
  }
  if (chatProcess.status === 'starting' || chatProcess.recoveryPhase === 'restarting') {
    return {
      canRestart: false,
      reason: 'restarting',
      notice: 'chat 进程正在启动或重启中，请稍候完成后再试。',
    }
  }
  if (chatProcess.status === 'stopping') {
    return {
      canRestart: false,
      reason: 'stopping',
      notice: 'chat 进程正在停止中，请稍候完成后再试。',
    }
  }
  return { canRestart: true, reason: null, notice: null }
}

export function describeRestartChatActionSubtitle(
  chatProcess: AgentProcessStatus | null | undefined,
): string {
  const evaluation = evaluateChatRestart(chatProcess)
  switch (evaluation.reason) {
    case 'no-model':
      return '重启聊天附属运行时（未选择模型）· 需长按确认'
    case 'restarting':
      return 'chat 正在启动或重启中 · 需长按确认'
    case 'stopping':
      return 'chat 正在停止中 · 需长按确认'
    case null:
      return '重启聊天附属运行时 · 需长按确认'
  }
}

export function buildCommandCovenantConfig(
  intent: CommandConfirmIntent,
  chatProcess?: AgentProcessStatus | null,
): CommandCovenantConfig {
  if (intent === 'enable-cross-channel') {
    return {
      intent: 'enable-cross-channel',
      title: '准许',
      body: '启用后，符合可见性与披露约束的记忆可以跨通道使用。跨通道使用仍会写入审计记录。',
      stampLabel: '准许',
      stampAriaLabel: '按住 0.9 秒以准许跨通道',
      consequenceId: 'command-ink-cross-channel-consequence',
      cancelLabel: '算了',
      stampDisabled: false,
      blockReason: null,
      blockNotice: null,
    }
  }

  const evaluation = evaluateChatRestart(chatProcess)
  return {
    intent: 'restart-chat',
    title: '重启',
    body: '重启会打断进行中的会话。',
    stampLabel: '重启',
    stampAriaLabel: '按住 0.9 秒以确认：重启 chat',
    consequenceId: 'command-ink-restart-chat-consequence',
    cancelLabel: '算了',
    stampDisabled: !evaluation.canRestart,
    blockReason: evaluation.reason,
    blockNotice: evaluation.notice,
  }
}
