import type { AgentProcessStatus, WakeMetricSample } from '../../api/types.ts'
import type { EnsoState } from '../../ink/enso.ts'

export function chatEnsoState(
  chat: AgentProcessStatus | undefined,
  inFlight: boolean,
  speaking = false,
  listening = false,
): EnsoState {
  if (chat?.recoveryPhase === 'restarting') return 'recovering'
  if (chat?.status === 'crashed' || chat?.status === 'failed') return 'error'
  if (!chat?.selection || chat.status === 'stopped' || chat.status === 'stopping') return 'offline'
  if (speaking) return 'speaking'
  if (inFlight) return 'thinking'
  if (chat.status === 'starting') return 'recovering'
  if (listening) return 'listening'
  return 'idle'
}

export const CHAT_STATE_LABELS: Readonly<Record<EnsoState, string>> = {
  idle: '空闲',
  listening: '倾听中',
  thinking: '思考中',
  speaking: '回复中',
  offline: '离线',
  error: '异常',
  recovering: '恢复中',
}

export function latestChatMetric(
  metrics: readonly WakeMetricSample[] | undefined,
  channel: string,
): WakeMetricSample | undefined {
  let latest: WakeMetricSample | undefined
  for (const metric of metrics ?? []) {
    if (metric.agentClass === 'chat' && metric.channel === channel &&
        (latest === undefined || metric.arrivedAt >= latest.arrivedAt)) {
      latest = metric
    }
  }
  return latest
}
