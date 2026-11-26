import { encodeSessionId, type AgentClass, type ToolCall, type ToolUpdateMode } from '@brain-core/satellite-host'
import type {
  ManifestGroup, ManifestTool, RecordInput, RecordPatch, SearchRequest, ToolCallContext, ToolOutput, Viewer, WakeFeatures,
} from '@brain-core/sdk'
import type { Logger } from '../../src/log/index.ts'
import type { Clock, GatewayTool, MemoryService, OutboundAudit, ToolGateway, WakePlan, WriteIdentity } from '../../src/contracts/index.ts'
import { createToolGateway } from '../../src/tool-gateway/index.ts'
import { FakeClock } from '../fakes/index.ts'

export const PRIVATE = 'qq:private:alice'
export const GROUP = 'qq:group:g1'
export const OWNER_CHANNEL = 'console:private:owner'

export function sessionFor(channel: string, agentClass: AgentClass = 'chat', generation = 0): string {
  return encodeSessionId({ agentClass, channel, generation })
}

export function features(overrides: { media?: boolean; forward?: boolean; poke?: boolean; kind?: string } = {}): WakeFeatures {
  return {
    message: { hasMedia: overrides.media ?? false, hasForward: overrides.forward ?? false },
    event: { poke: overrides.poke ?? false },
    channel: { kind: overrides.kind ?? 'private' },
  }
}

export function plan(channel: string, overrides: Partial<WakePlan> = {}): WakePlan {
  return {
    sessionId: sessionFor(channel),
    wakeId: 'wake-1',
    features: features(),
    mode: 'addition-only',
    silent: false,
    participants: ['alice', 'self'],
    evidence: ['l0_a'],
    peerTexts: [],
    ...overrides,
  }
}

export interface FakeToolOptions {
  readonly pluginId?: string
  readonly name: string
  readonly effect?: ManifestTool['effect']
  readonly load?: ManifestTool['load']
  readonly group?: string
  readonly groupInfo?: ManifestGroup
  readonly summary?: string
  readonly description?: string
  readonly keywords?: readonly string[]
  readonly when?: string
  readonly channels?: readonly string[]
  readonly sendPerMinute?: number
  readonly textArg?: string
  readonly audience?: 'owner'
  readonly parameters?: GatewayTool['parameters']
  readonly handler?: (args: Readonly<Record<string, unknown>>, call: ToolCallContext) => Promise<ToolOutput> | ToolOutput
}

export interface FakeTool extends GatewayTool {
  readonly calls: { readonly args: Readonly<Record<string, unknown>>; readonly call: ToolCallContext }[]
}

export function fakeTool(options: FakeToolOptions): FakeTool {
  const calls: FakeTool['calls'][number][] = []
  const manifest: ManifestTool = {
    name: options.name,
    effect: options.effect ?? 'read',
    load: options.load ?? 'core',
    summary: options.summary ?? `${options.name} summary`,
    ...(options.group === undefined ? {} : { group: options.group }),
    ...(options.keywords === undefined ? {} : { keywords: options.keywords }),
    ...(options.when === undefined ? {} : { when: options.when }),
    ...(options.sendPerMinute === undefined ? {} : { sendPerMinute: options.sendPerMinute }),
    ...(options.textArg === undefined ? {} : { textArg: options.textArg }),
    ...(options.audience === undefined ? {} : { audience: options.audience }),
  }
  return {
    pluginId: options.pluginId ?? 'p',
    manifest,
    ...(options.groupInfo === undefined ? {} : { group: options.groupInfo }),
    description: options.description ?? `${options.name} description`,
    parameters: options.parameters ?? { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    channels: options.channels ?? ['*:*'],
    calls,
    async invoke(args, call) {
      calls.push({ args, call })
      return options.handler === undefined ? 'ok' : options.handler(args, call)
    },
  }
}

export interface MemoryCall { readonly method: string; readonly args: readonly unknown[] }

export class FakeMemory implements MemoryService {
  readonly calls: MemoryCall[] = []
  searchResult: Awaited<ReturnType<MemoryService['search']>> = { items: [], degraded: false }
  failWith: Error | undefined

  #note(method: string, args: readonly unknown[]): void {
    this.calls.push({ method, args })
    if (this.failWith !== undefined) throw this.failWith
  }

  async ingest(): Promise<{ readonly id: string }> { throw new Error('unused') }
  async record(input: RecordInput, identity: WriteIdentity): Promise<never> {
    this.#note('record', [input, identity])
    return { id: 'l1_new' } as never
  }
  async update(id: string, patch: RecordPatch, version: number, identity: WriteIdentity, viewer: Viewer): Promise<never> {
    this.#note('update', [id, patch, version, identity, viewer])
    return { id } as never
  }
  async remove(id: string, identity: WriteIdentity, viewer: Viewer): Promise<void> {
    this.#note('remove', [id, identity, viewer])
  }
  async search(request: SearchRequest, viewer: Viewer): ReturnType<MemoryService['search']> {
    this.#note('search', [request, viewer])
    return this.searchResult
  }
  async context(): Promise<never> { throw new Error('unused') }
  async forget(): Promise<never> { throw new Error('unused') }
  async health(): Promise<never> { throw new Error('unused') }
}

export class FakeAudit implements OutboundAudit {
  readonly entries: Parameters<OutboundAudit['sent']>[0][] = []
  async sent(entry: Parameters<OutboundAudit['sent']>[0]): Promise<void> {
    this.entries.push(entry)
  }
}

export interface LogLine { readonly level: string; readonly event: string; readonly fields: unknown }

export function fakeLogger(): Logger & { readonly lines: LogLine[] } {
  const lines: LogLine[] = []
  const at = (level: string) => (event: string, fields?: unknown): void => { lines.push({ level, event, fields }) }
  return { lines, info: at('info'), warn: at('warn'), error: at('error') }
}

export interface Harness {
  readonly gateway: ToolGateway
  readonly clock: FakeClock
  readonly memory: FakeMemory
  readonly audit: FakeAudit
  readonly log: ReturnType<typeof fakeLogger>
  readonly owners: Set<string>
  readonly style: { enabled: boolean; openers: readonly string[] }
}

export function harness(options: {
  sendPerMinute?: number
  owners?: readonly string[]
  style?: Partial<Harness['style']>
  proactiveMessaging?: boolean
} = {}): Harness {
  const clock = new FakeClock()
  const memory = new FakeMemory()
  const audit = new FakeAudit()
  const log = fakeLogger()
  const owners = new Set<string>(options.owners ?? [OWNER_CHANNEL])
  const style = { enabled: true, openers: ['作为一个AI'] as readonly string[], ...options.style }
  const gateway = createToolGateway({
    memory,
    audit,
    clock: clock as Clock,
    log,
    ownerChannels: () => owners,
    ...(options.proactiveMessaging === undefined ? {} : { proactiveMessaging: options.proactiveMessaging }),
    style: () => style,
    ...(options.sendPerMinute === undefined ? {} : { sendPerMinute: options.sendPerMinute }),
  })
  return { gateway, clock, memory, audit, log, owners, style }
}

export function call(sessionId: string, toolName: string, args: unknown = {}): ToolCall {
  return { sessionId, toolName, args }
}

export async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a rejection')
}

export type { ToolUpdateMode }
