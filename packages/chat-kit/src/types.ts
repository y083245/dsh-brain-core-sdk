/** Injectable monotonic or wall clock for deterministic testing. */
export interface ChatClock {
  now(): number
}

/** Injectable timer primitives for deterministic testing without real sleeps. */
export interface ChatTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export type ChatMode = 'active' | 'lurking' | 'muted'

export type GroupTrigger = 'mention' | 'keyword' | 'always'

export type ChannelKind = 'private' | 'group' | 'other'

export interface WakeConfig {
  readonly groupTrigger: GroupTrigger
  readonly keywords: readonly string[]
  readonly activeWindowMs: number
  readonly lurkAfterMs: number
  readonly minWakeIntervalMs: number
  readonly quietDebounceMs: number
  readonly shortAsciiWordBoundary?: boolean
  readonly speakerIds?: readonly string[]
  readonly replyProbability?: number
  readonly maxWakePerHour?: number
}

export interface ChannelSocialState {
  readonly mode: ChatMode
  readonly config: WakeConfig
  readonly lastActivityAt?: number
  readonly lastWakeAt?: number
  readonly wakeTimestamps?: readonly number[]
}

export interface IncomingChatEvent {
  readonly channelKind: ChannelKind
  readonly text: string
  readonly mentioned?: boolean
  readonly quotedSelf?: boolean
  readonly isPoke?: boolean
  readonly randomRoll?: number
  readonly actor?: string
  readonly messageId?: string
  readonly tEvent?: number
}

export type WakeReason =
  | 'muted-skip'
  | 'private-message'
  | 'direct-mention'
  | 'poke'
  | 'speaker'
  | 'keyword'
  | 'always'
  | 'active-thread'
  | 'probability'
  | 'lurking-skip'
  | 'cooldown-skip'
  | 'hourly-budget-skip'

export interface WakeDecision {
  readonly shouldWake: boolean
  readonly reason: WakeReason
  readonly nextMode: ChatMode
  readonly suggestedDebounceMs: number
}

export interface ChatSnapshotMessage {
  readonly id: string
  readonly who: string
  readonly text: string
  readonly tEvent: number
  readonly direction?: 'inbound' | 'outbound'
  readonly hasMedia?: boolean
  readonly forwarded?: boolean
}

export interface FormattedSnapshotItem {
  readonly id: string
  readonly who: string
  readonly ago: string
  readonly text: string
  readonly direction?: 'inbound' | 'outbound'
  readonly hasMedia?: true
  readonly forwarded?: true
}

export interface ReadCursorState {
  readonly lastReadMessageId?: string
  readonly lastReadAt?: number
  readonly lastInboundMessageId?: string
  readonly lastInboundAt?: number
  readonly unreadCount: number
}

export interface TopicEntry {
  readonly topic: string
  readonly recordedAt: number
}
