import type { ToolUpdateMode } from '@brain-core/satellite-host'
import type { ManifestGroup, ToolLoad, ToolParameters, Viewer, WhenExpr } from '@brain-core/sdk'
import type { GatewayTool, ProactiveMessageSend, WriteIdentity } from '../contracts/index.ts'

export interface BuiltinCall {
  readonly sessionId: string
  readonly channel: string
  readonly wake: WakeRecord
  readonly state: SessionState
  readonly viewer: Viewer
  readonly identity: WriteIdentity
}

/** One tool the gateway can show: a plugin's, or one of the six built-ins. */
export interface ToolEntry {
  /** The name the model sees. */
  readonly name: string
  readonly description: string
  readonly parameters: ToolParameters
  readonly load: ToolLoad
  readonly group?: string
  readonly groupInfo?: ManifestGroup
  readonly summary: string
  readonly keywords: readonly string[]
  readonly when?: WhenExpr
  readonly channels: readonly string[]
  readonly ownerOnly: boolean
  /** Set for plugin tools. */
  readonly plugin?: GatewayTool
  /** Set for built-ins. */
  readonly run?: (call: BuiltinCall, args: Readonly<Record<string, unknown>>) => Promise<string>
}

export interface ToolGroup {
  readonly name: string
  readonly summary: string
  readonly usage?: string
  readonly keywords: readonly string[]
  /** Only reachable through tools__search and tools__load when some tool in it is onDemand. */
  readonly onDemand: boolean
  /** Every applicable tool of the group, sorted by name. */
  readonly tools: readonly ToolEntry[]
}

export interface SessionState {
  readonly surface: Set<string>
  readonly activated: Set<string>
  readonly pending: Set<string>
  planned: boolean
}

export interface WakeRecord {
  readonly sessionId: string
  readonly wakeId: string
  readonly silent: boolean
  readonly sendProactiveMessage?: ProactiveMessageSend
  proactiveMessageInFlight?: boolean
  readonly participants: readonly string[]
  readonly evidence: readonly string[]
  readonly peerTexts: readonly string[]
  readonly mode: ToolUpdateMode
  sent: number
  blocked: number
  firstSendAt?: number
}
