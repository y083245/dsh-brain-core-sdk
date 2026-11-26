export const CHAT_KIT_VERSION = '0.0.0'

export type {
  ChannelKind,
  ChannelSocialState,
  ChatClock,
  ChatMode,
  ChatSnapshotMessage,
  ChatTimers,
  FormattedSnapshotItem,
  GroupTrigger,
  IncomingChatEvent,
  ReadCursorState,
  TopicEntry,
  WakeConfig,
  WakeDecision,
  WakeReason,
} from './types.ts'

export {
  createSocialStateMachine,
  createWakeConfigToolSpec,
  DEFAULT_WAKE_CONFIG,
  parseWakeConfigArgs,
  type ParsedWakeConfigArgs,
  type SocialStateMachine,
  type SocialStateSnapshot,
  type WakeConfigPatch,
  type WakeConfigToolSpec,
} from './social-state.ts'

export {
  createMessageDebouncer,
  type DebouncePushOptions,
  type MessageDebouncer,
  type MessageDebouncerOptions,
} from './debounce.ts'

export {
  createReadCursor,
  type ReadCursor,
} from './read-cursor.ts'

export {
  computeHumanPauseMs,
  scheduleHumanPause,
  type HumanPauseHandle,
  type HumanPauseOptions,
} from './human-pause.ts'

export {
  buildMessageSnapshot,
  formatRelativeTime,
  truncateCodePoints,
  type SnapshotOptions,
} from './snapshot.ts'

export {
  createTopicDeduper,
  topicSimilarity,
  type TopicDeduper,
  type TopicDeduperSnapshot,
  type TopicNoveltyResult,
} from './topic-dedupe.ts'
