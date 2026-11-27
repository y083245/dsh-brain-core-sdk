import type {
  BrainManifest, ChannelProvider, ManifestGroup, ManifestTool, OwnTimeRequest, ToolCallContext, ToolOutput, ToolParameters,
  WakeFeatures, WakeInput, WakeResult, WakeSkip,
} from '@dsh-brain-core/sdk'
import type { AgentClass, BridgeTool, BridgeToolResult, ModelSelection, ToolCall, ToolUpdateMode } from '@dsh-brain-core/satellite-host'

export interface GatewayTool {
  readonly pluginId: string
  readonly manifest: ManifestTool
  readonly group?: ManifestGroup
  readonly description: string
  readonly parameters: ToolParameters
  /** Already resolved: `<source>:<kind>`, either part may be `*`. */
  readonly channels: readonly string[]
  invoke(args: Readonly<Record<string, unknown>>, call: ToolCallContext): Promise<ToolOutput>
}

export type ProactiveMessageSend = (text: string) => Promise<string>

export interface WakePlan {
  readonly sessionId: string
  readonly wakeId: string
  readonly features: WakeFeatures
  readonly mode: ToolUpdateMode
  readonly silent: boolean
  readonly sendProactiveMessage?: ProactiveMessageSend
  readonly participants: readonly string[]
  readonly evidence: readonly string[]
  /** This snapshot's message text, for the outgoing check. */
  readonly peerTexts: readonly string[]
}

export interface ToolGateway {
  /** In-process, out-of-process and MCP tools all arrive here. */
  register(tool: GatewayTool): () => void
  /** Byte-stable and sorted; holds every enabled tool plus the built-ins. */
  catalog(): readonly BridgeTool[]
  onCatalogChange(listener: () => void): () => void
  /** Grows this session's surface and returns it. The session is the only source of the viewer. */
  planWake(plan: WakePlan): readonly string[]
  surfaceOf(sessionId: string): ReadonlySet<string>
  dispatch(call: ToolCall): Promise<string | BridgeToolResult>
  /** Ends the wake's counters. */
  endWake(sessionId: string): { readonly sent: number; readonly firstSendAt?: number; readonly blocked?: number }
  activatedGroups(sessionId: string): readonly string[]
  restoreSession(sessionId: string, groups: readonly string[]): void
  /** Back to core: rotation, compaction or a forget. */
  resetSession(sessionId: string): void
  /** For the install-time warning (FR-T02). */
  coreBudget(pattern: string): { readonly count: number; readonly tokens: number; readonly over: boolean }
  /** The reason when this outgoing text is refused, otherwise null. Used by send tools and ctx.channel.send. */
  checkOutbound(channel: string, text: string, wakeId?: string): string | null
  /** Counts one send against the per-plugin, per-channel limit; false means RATE_LIMITED. */
  admitSend(pluginId: string, channel: string, perMinute?: number): boolean
  noteOutbound(channel: string, text: string): void
  /** Newest last; memory only, never written to disk. */
  recentSent(channel: string, limit: number): readonly string[]
  forgetSent(channels: readonly string[]): void
}

export interface AgentRuntime {
  wake(channel: string, input: WakeInput): Promise<WakeResult>
  wakeProactiveMessage(
    channel: string,
    input: Pick<WakeInput, 'reason' | 'note' | 'evidence'>,
    send: ProactiveMessageSend,
  ): Promise<WakeResult & { readonly blocked?: boolean }>
  canProactive?(channel: string): Promise<WakeSkip | undefined>
  rotate(channel: string): Promise<void>
  /** Rotates these channels and purges the old sessions (section 3.6 of the S3 design). */
  forgotten(channels: readonly string[]): Promise<void>
  close(): Promise<void>
}

export interface Scheduler {
  every(owner: string, ms: number, run: () => Promise<void> | void): () => void
  at(owner: string, timeMs: number, run: () => Promise<void> | void): () => void
  ownTime(owner: string, request: OwnTimeRequest): () => void
}

export interface ChannelRegistry {
  provide(owner: string, provider: ChannelProvider, acceptsProactive?: (channel: string) => boolean): () => void
  providerOf(channel: string): ChannelProvider | undefined
  proactiveProviderOf(channel: string): ChannelProvider | undefined
}

export interface OutboundAudit {
  sent(entry: { readonly tool: string; readonly pluginId: string; readonly channel: string; readonly ok: boolean; readonly tAt: number }): Promise<void>
}

export interface WakeMetrics {
  record(entry: {
    readonly wakeId: string
    readonly channel: string
    readonly agentClass: AgentClass
    readonly profileVersion: number
    readonly arrivedAt: number
    readonly firstSendAt?: number
    readonly debounceMs: number
    readonly steps: readonly { readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadTokens: number; readonly cacheWriteTokens: number }[]
    readonly retries: number
    readonly outcome: 'acked' | 'interrupted' | 'unavailable'
  }): Promise<void>
}

export interface InstalledPlugin {
  readonly manifest: BrainManifest
  readonly version: string
  readonly dir: string
  readonly granted: readonly string[]
  readonly config: unknown
}
export interface PluginActivator {
  enable(plugin: InstalledPlugin): Promise<void>
  disable(id: string): Promise<void>
  state(id: string): 'enabled' | 'failed' | 'disabled'
}

export interface ProactiveOwnLifeSettings {
  /** 开关，默认 true（仅当存在已绑定且 opt-in 的 ownerChannels 时生效）。 */
  readonly enabled?: boolean
  /** 白天唤醒最小间隔，默认 2.5 小时（9_000_000 ms），下限 60_000 ms。 */
  readonly intervalMs?: number
  /** 每个活动日白天最多唤醒次数，默认 6。 */
  readonly maxPerDay?: number
  /** 半夜静默收尾时刻（HH:MM），默认 '23:30'；传 '' 可关闭半夜收尾。 */
  readonly midnightAt?: string
  /** 每个活动日「忽然想起」最多抽几条，默认 2。 */
  readonly recallPerDay?: number
  /** 同一条素材冷却天数，默认 7。 */
  readonly cooldownDays?: number
  /** 是否启用 1-hop 联想「顺着想到」，默认 true。 */
  readonly associateEnabled?: boolean
  /** 联想查询超时毫秒，默认 1_500。 */
  readonly associateTimeoutMs?: number
  /** 素材最小龄期天数（太新不算旧事），默认 2。 */
  readonly minAgeDays?: number
}

export interface RuntimeSettings {
  readonly agents: Readonly<Partial<Record<AgentClass, Partial<ModelSelection>>>>
  readonly timezone?: string
  readonly quietHours?: readonly [number, number]
  readonly ownTimePerDay?: number
  readonly ownerChannels?: readonly string[]
  readonly style?: { readonly enabled?: boolean; readonly openers?: readonly string[] }
  readonly proactive?: {
    readonly activeWindowMs?: number
    readonly cooldownMs?: number
    readonly ownLife?: ProactiveOwnLifeSettings
  }
  readonly accounting?: {
    readonly dailyTokenLimit?: number
    readonly dailyCostMicrosLimit?: number
    readonly pluginDailyTokenLimit?: number
    readonly pluginLimits?: Readonly<Record<string, {
      readonly dailyTokenLimit?: number
      readonly dailyCallsLimit?: number
      readonly maxOutputTokens?: number
    }>>
  }
  readonly interop?: {
    readonly ampAliases?: boolean
    readonly readOnlyMcp?: {
      readonly enabled?: boolean
      readonly port?: number
    }
  }
}
export interface SettingsStore {
  read(): Promise<RuntimeSettings>
  write(next: RuntimeSettings): Promise<void>
}
