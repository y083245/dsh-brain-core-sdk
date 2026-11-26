import type { BridgeTool } from './bridge-server.ts'
import type { AgentClass, ModelSelection } from './selection.ts'

export type TurnBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mediaType: string; readonly base64: string }
export type TurnInput = string | readonly TurnBlock[]
export interface StepUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}
export interface TurnResult {
  readonly finalResponse: string
  readonly steps: readonly StepUsage[]
  readonly retries: number             // llm/retry events
  readonly compacted: boolean          // saw compaction/end
}
export class TurnInterruptedError extends Error {
  readonly reason: 'timeout' | 'crash'
  constructor(reason: 'timeout' | 'crash', message: string) {
    super(message)
    this.name = 'TurnInterruptedError'
    this.reason = reason
  }
}
/** The class stopped after too many failures, or the supervisor is closing. Callers map it to UNAVAILABLE. */
export class RunnerFailedError extends Error {
  readonly agentClass: AgentClass
  constructor(agentClass: AgentClass, message: string) {
    super(message)
    this.name = 'RunnerFailedError'
    this.agentClass = agentClass
  }
}

/** Lets the supervisor be tested without DSH. */
export interface SatelliteLike {
  readonly pid: number | undefined
  readonly deniedApprovals: number
  start(): Promise<void>
  /** Resumes a session on disk; 'new' means DSH will create it on the first run. */
  open(sessionId: string): Promise<'resumed' | 'new'>
  run(sessionId: string, input: TurnInput, options?: { readonly timeoutMs?: number }): Promise<TurnResult>
  close(): Promise<void>
}
export interface ProcessConfig {
  readonly selection: ModelSelection
  readonly apiKey: string
  readonly systemPrompt: string
  readonly catalog: readonly BridgeTool[]
}
export type SatelliteFactory = (agentClass: AgentClass, config: ProcessConfig) => Promise<SatelliteLike>

export type RunnerStatus = 'stopped' | 'running' | 'restarting' | 'failed'
export interface TurnRunner {
  run(agentClass: AgentClass, sessionId: string, input: TurnInput, options?: { readonly timeoutMs?: number }): Promise<TurnResult>
  /** Something ProcessConfig depends on changed: restart when this class goes idle. */
  invalidate(agentClass: AgentClass): void
  status(agentClass: AgentClass): RunnerStatus
  /** Leaves 'failed'. */
  reset(agentClass: AgentClass): void
  /** Purges now, or after the next close if the files are still locked. */
  purge(sessionIds: readonly string[]): Promise<void>
  close(): Promise<void>
}
