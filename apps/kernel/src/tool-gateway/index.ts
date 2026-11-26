import { decodeSessionId, toDshParameters } from '@brain-core/satellite-host'
import type { BridgeTool, BridgeToolResult, ToolCall } from '@brain-core/satellite-host'
import { BrainError, LIMITS, evalWhen, parseWhen } from '@brain-core/sdk'
import type { Viewer } from '@brain-core/sdk'
import type {
  Clock, ConsolidationEngine, GatewayTool, MemoryService, OutboundAudit, RecordStore, ToolGateway, WakePlan, WriteIdentity,
} from '../contracts/index.ts'
import { createAmpBuiltinEntries, type AmpBuiltinEntry } from '../interop/index.ts'
import type { Logger } from '../log/index.ts'
import { createBuiltins } from './builtins.ts'
import { channelKind, channelMatches, patternsOverlap } from './channels.ts'
import { createOutbound } from './outbound.ts'
import type { SessionState, ToolEntry, ToolGroup, WakeRecord } from './types.ts'

export interface ToolGatewayDeps {
  readonly memory: MemoryService
  readonly audit: OutboundAudit
  readonly clock: Clock
  readonly log: Logger
  readonly ownerChannels: () => ReadonlySet<string>
  readonly style: () => { readonly enabled: boolean; readonly openers: readonly string[] }
  /** Sends one plugin may make on one channel in a minute. Default 20. */
  readonly sendPerMinute?: number
  /** Dynamic toggle for AMP 6-verb builtin aliases (FR-A06, default off). */
  readonly ampAliases?: () => boolean
  readonly consolidation?: ConsolidationEngine
  readonly store?: RecordStore
  readonly proactiveMessaging?: boolean
}

/** Identical for every refusal, so a caller cannot probe which sessions exist. */
const SESSION_UNAVAILABLE = 'session unavailable'
const DEFAULT_SEND_PER_MINUTE = 20
const CORE_TOOL_LIMIT = 8
const CORE_TOKEN_LIMIT = 2_000
const PROACTIVE_SEND = 'notify__send'
const PROACTIVE_TOOL: BridgeTool = {
  name: PROACTIVE_SEND,
  description: '向本次主动唤醒已绑定的私聊发送一条消息。只有确实想开口时才调用。',
  parameters: toDshParameters({
    type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false,
  }),
}

function byName(a: { readonly name: string }, b: { readonly name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

function sorted(names: Iterable<string>): string[] {
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

/** Extracts outbound text strings from a single-string or multi-bubble string-array argument. */
export function extractOutboundTexts(value: unknown): readonly string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return []
}

function unavailable(name: string): Error {
  return new Error(`工具 ${name} 现在不可用。先用 tools__search 查找，再用 tools__load 加载。`)
}

function limitText(text: string): string {
  if (text.length <= LIMITS.toolResultChars) return text
  const cut = text.slice(0, LIMITS.toolResultChars)
  // Cutting inside a surrogate pair would leave half an emoji, which is invalid Unicode in the request.
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

function base64Bytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

function toResult(output: unknown): string | BridgeToolResult {
  if (typeof output === 'string') return limitText(output)
  if (!isPlainObject(output) || typeof output.text !== 'string') throw new Error('工具返回的内容格式不对。')
  const text = limitText(output.text)
  if (output.images === undefined) return { text }
  if (!Array.isArray(output.images)) throw new Error('工具返回的图片格式不对。')
  if (output.images.length > LIMITS.toolImages) throw new Error(`工具返回的图片太多，一次最多 ${LIMITS.toolImages} 张。`)
  for (const image of output.images as readonly unknown[]) {
    if (!isPlainObject(image) || typeof image.mediaType !== 'string' || typeof image.base64 !== 'string') {
      throw new Error('工具返回的图片格式不对。')
    }
    if (base64Bytes(image.base64) > LIMITS.toolImageBytes) throw new Error(`工具返回的图片太大，单张最多 ${LIMITS.toolImageBytes} 字节。`)
  }
  return { text, images: output.images as BridgeToolResult['images'] }
}

function asError(error: unknown): Error {
  if (error instanceof Error) return error.message === '' ? new Error('工具出错了。') : error
  return new Error(String(error) === '' ? '工具出错了。' : String(error))
}

function describe(entry: ToolEntry): BridgeTool {
  return { name: entry.name, description: entry.description, parameters: toDshParameters(entry.parameters) }
}

function buildGroup(name: string, tools: readonly ToolEntry[]): ToolGroup {
  const ordered = [...tools].sort(byName)
  const info = ordered.find((tool) => tool.groupInfo !== undefined)?.groupInfo
  const usage = ordered.find((tool) => tool.groupInfo?.usage !== undefined)?.groupInfo?.usage
  return {
    name,
    summary: info?.summary ?? ordered.map((tool) => tool.summary).join('；'),
    ...(usage === undefined ? {} : { usage }),
    keywords: [...new Set(ordered.flatMap((tool) => tool.keywords))],
    onDemand: ordered.some((tool) => tool.load === 'onDemand'),
    tools: ordered,
  }
}

function ampToToolEntry(entry: AmpBuiltinEntry): ToolEntry {
  return {
    name: entry.name,
    description: entry.description,
    parameters: entry.parameters,
    load: entry.load,
    ...(entry.group === undefined ? {} : { group: entry.group }),
    ...(entry.groupInfo === undefined ? {} : { groupInfo: entry.groupInfo }),
    summary: entry.summary,
    keywords: entry.keywords,
    channels: entry.channels,
    ownerOnly: entry.ownerOnly,
    run: (call, args) => entry.run(call, args),
  }
}

export function createToolGateway(deps: ToolGatewayDeps): ToolGateway & { refreshBuiltins(): void } {
  const plugins = new Map<string, ToolEntry>()
  const sessions = new Map<string, SessionState>()
  const wakesBySession = new Map<string, WakeRecord>()
  const wakesById = new Map<string, WakeRecord>()
  const listeners = new Set<() => void>()
  const outbound = createOutbound({
    clock: deps.clock,
    style: deps.style,
    sendPerMinute: deps.sendPerMinute ?? DEFAULT_SEND_PER_MINUTE,
    wakeOf: (wakeId) => wakesById.get(wakeId),
  })
  const baseBuiltins = createBuiltins({ memory: deps.memory, groupsFor })
  const ampBuiltins = createAmpBuiltinEntries({
    memory: deps.memory,
    ...(deps.consolidation === undefined ? {} : { consolidation: deps.consolidation }),
    ...(deps.store === undefined ? {} : { store: deps.store }),
  }).map(ampToToolEntry)
  let catalogCache: readonly BridgeTool[] | undefined

  function activeBuiltins(): readonly ToolEntry[] {
    return deps.ampAliases?.() === true ? [...baseBuiltins, ...ampBuiltins] : baseBuiltins
  }

  function allEntries(): readonly ToolEntry[] {
    return [...activeBuiltins(), ...plugins.values()]
  }

  function entryOf(name: string): ToolEntry | undefined {
    return activeBuiltins().find((entry) => entry.name === name) ?? plugins.get(name)
  }

  function isApplicable(entry: ToolEntry, channel: string): boolean {
    return channelMatches(entry.channels, channel) && (!entry.ownerOnly || deps.ownerChannels().has(channel))
  }

  function applicable(channel: string): readonly ToolEntry[] {
    return allEntries().filter((entry) => isApplicable(entry, channel))
  }

  function groupsFor(channel: string): readonly ToolGroup[] {
    const grouped = new Map<string, ToolEntry[]>()
    for (const entry of applicable(channel)) {
      if (entry.group === undefined) continue
      grouped.set(entry.group, [...(grouped.get(entry.group) ?? []), entry])
    }
    return [...grouped].map(([name, tools]) => buildGroup(name, tools)).sort(byName)
  }

  function notify(): void {
    catalogCache = undefined
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        deps.log.warn('tool-gateway.listener_failed')
      }
    }
  }

  function stateFor(sessionId: string): SessionState {
    let state = sessions.get(sessionId)
    if (state === undefined) {
      state = { surface: new Set(), activated: new Set(), pending: new Set(), planned: false }
      sessions.set(sessionId, state)
    }
    return state
  }

  function toEntry(tool: GatewayTool): ToolEntry {
    const name = `${tool.pluginId}__${tool.manifest.name}`
    try {
      toDshParameters(tool.parameters)
    } catch {
      throw new BrainError('INVALID_ARGUMENT', `工具 ${name} 的参数根必须是 object。`)
    }
    const when = tool.manifest.when === undefined ? undefined : parseWhen(tool.manifest.when)
    return {
      name,
      description: tool.description,
      parameters: tool.parameters,
      load: tool.manifest.load,
      ...(tool.manifest.group === undefined ? {} : { group: tool.manifest.group }),
      ...(tool.group === undefined ? {} : { groupInfo: tool.group }),
      summary: tool.manifest.summary,
      keywords: tool.manifest.keywords ?? [],
      ...(when === undefined ? {} : { when }),
      channels: tool.channels,
      ownerOnly: tool.manifest.audience === 'owner',
      plugin: tool,
    }
  }

  function register(tool: GatewayTool): () => void {
    const name = `${tool.pluginId}__${tool.manifest.name}`
    if (name === PROACTIVE_SEND
      || activeBuiltins().some((entry) => entry.name === name) || plugins.has(name)) {
      throw new BrainError('CONFLICT', `工具 ${name} 已经注册过了。`)
    }
    const entry = toEntry(tool)
    plugins.set(name, entry)
    notify()
    return () => {
      if (plugins.get(name) !== entry) return
      plugins.delete(name)
      notify()
    }
  }

  function catalog(): readonly BridgeTool[] {
    catalogCache ??= [...allEntries().map(describe), ...(deps.proactiveMessaging === true ? [PROACTIVE_TOOL] : [])].sort(byName)
    return catalogCache
  }

  function proactiveWake(wake: WakeRecord | undefined, channel: string): wake is WakeRecord & {
    readonly sendProactiveMessage: NonNullable<WakeRecord['sendProactiveMessage']>
  } {
    return deps.proactiveMessaging === true && wake?.sendProactiveMessage !== undefined
      && !wake.silent && channelKind(channel) === 'private' && deps.ownerChannels().has(channel)
  }

  function surfaceOf(sessionId: string): ReadonlySet<string> {
    const binding = decodeSessionId(sessionId)
    const state = sessions.get(sessionId)
    if (binding === null || state === undefined) return new Set()
    const wake = wakesBySession.get(sessionId)
    const names = [...state.surface].filter((name) => {
      const entry = entryOf(name)
      return entry !== undefined && isApplicable(entry, binding.channel)
        && (wake?.sendProactiveMessage === undefined || entry.plugin?.manifest.effect !== 'send')
    })
    if (proactiveWake(wake, binding.channel)) names.push(PROACTIVE_SEND)
    return new Set(sorted(names))
  }

  function planWake(plan: WakePlan): readonly string[] {
    const binding = decodeSessionId(plan.sessionId)
    if (binding === null) throw new RangeError('invalid session id')
    const state = stateFor(plan.sessionId)
    const here = applicable(binding.channel)
    const core = here.filter((entry) => entry.load === 'core')
    const context = here.filter((entry) => entry.load === 'context')
    const matched = context.filter((entry) => entry.when !== undefined && evalWhen(entry.when, plan.features))

    if (plan.mode === 'addition-only') {
      const activated = here.filter((entry) => entry.group !== undefined && state.activated.has(entry.group))
      for (const entry of [...core, ...matched, ...activated]) state.surface.add(entry.name)
    } else if (!state.planned) {
      for (const group of state.pending) state.activated.add(group)
      state.pending.clear()
      const activated = here.filter((entry) => entry.group !== undefined && state.activated.has(entry.group))
      for (const entry of [...core, ...context, ...activated]) state.surface.add(entry.name)
    }
    state.planned = true

    const previous = wakesBySession.get(plan.sessionId)
    if (previous !== undefined) wakesById.delete(previous.wakeId)
    const wake: WakeRecord = {
      sessionId: plan.sessionId,
      wakeId: plan.wakeId,
      silent: plan.silent,
      ...(plan.sendProactiveMessage === undefined ? {} : { sendProactiveMessage: plan.sendProactiveMessage }),
      participants: plan.participants,
      evidence: plan.evidence,
      peerTexts: plan.peerTexts,
      mode: plan.mode,
      sent: 0,
      blocked: 0,
    }
    wakesBySession.set(plan.sessionId, wake)
    wakesById.set(plan.wakeId, wake)
    return sorted(surfaceOf(plan.sessionId))
  }

  async function auditSend(tool: string, pluginId: string, channel: string, ok: boolean): Promise<void> {
    try {
      await deps.audit.sent({ tool, pluginId, channel, ok, tAt: deps.clock.now() })
    } catch {
      deps.log.warn('tool-gateway.audit_failed', { plugin: pluginId, channel })
    }
  }

  async function sendProactive(wake: WakeRecord, channel: string, args: Readonly<Record<string, unknown>>): Promise<string> {
    if (!proactiveWake(wake, channel)) throw unavailable(PROACTIVE_SEND)
    if (typeof args.text !== 'string' || args.text.trim() === '' || Object.keys(args).length !== 1) {
      throw new BrainError('INVALID_ARGUMENT', '请只提供非空的 text。')
    }
    if (wake.sent > 0 || wake.proactiveMessageInFlight === true) {
      throw new BrainError('CONFLICT', '这次主动消息已经发送或正在发送。')
    }
    const body = args.text.trim()
    const reason = outbound.check(channel, body, wake.wakeId)
    if (reason !== null) return reason
    const pluginId = channel.split(':')[0] as string
    if (!outbound.admit(pluginId, channel)) {
      wake.blocked += 1
      throw new BrainError('RATE_LIMITED', '发得太频繁了，过一会儿再发。')
    }
    wake.proactiveMessageInFlight = true
    let ok = false
    try {
      const messageId = await wake.sendProactiveMessage(body)
      wake.sent += 1
      wake.firstSendAt = deps.clock.now()
      outbound.note(channel, body)
      ok = true
      return limitText(`已发送：${messageId}`)
    } finally {
      await auditSend(PROACTIVE_SEND, pluginId, channel, ok)
      wake.proactiveMessageInFlight = false
    }
  }

  async function dispatch(request: ToolCall): Promise<string | BridgeToolResult> {
    const binding = decodeSessionId(request.sessionId)
    const wake = binding === null ? undefined : wakesBySession.get(request.sessionId)
    if (binding === null || wake === undefined) throw new Error(SESSION_UNAVAILABLE)
    const { channel } = binding
    if (deps.proactiveMessaging === true && request.toolName === PROACTIVE_SEND) {
      return sendProactive(wake, channel, isPlainObject(request.args) ? request.args : {})
    }
    const state = sessions.get(request.sessionId)
    const entry = entryOf(request.toolName)
    if (state === undefined || entry === undefined || !state.surface.has(entry.name) || !isApplicable(entry, channel)) {
      throw unavailable(String(request.toolName))
    }
    // Whatever the model puts under channel or viewer is never read: the viewer comes from the session alone.
    const args = isPlainObject(request.args) ? request.args : {}

    if (entry.plugin === undefined) {
      const viewer: Viewer = { caller: 'agent', channel, participants: wake.participants }
      const identity: WriteIdentity = {
        kind: 'kernel',
        source: 'agent',
        trust: 'self',
        defaultVisibility: channelKind(channel) === 'private' ? 'subject' : 'open',
      }
      return toResult(await (entry.run as NonNullable<ToolEntry['run']>)({ sessionId: request.sessionId, channel, wake, state, viewer, identity }, args))
    }

    const tool = entry.plugin
    const isSend = tool.manifest.effect === 'send'
    const textArg = tool.manifest.textArg
    const texts = textArg !== undefined ? extractOutboundTexts(args[textArg]) : []
    if (isSend) {
      if (wake.silent) throw new Error('这一轮不能发消息。')
      if (wake.sendProactiveMessage !== undefined) throw unavailable(entry.name)
      for (const text of texts) {
        const reason = outbound.check(channel, text, wake.wakeId)
        if (reason !== null) return reason
      }
      if (!outbound.admit(tool.pluginId, channel, tool.manifest.sendPerMinute)) {
        throw new BrainError('RATE_LIMITED', '发得太频繁了，过一会儿再发。')
      }
    }

    let output: unknown
    try {
      output = await tool.invoke(args, { channel, wakeId: wake.wakeId })
    } catch (error) {
      if (isSend) await auditSend(entry.name, tool.pluginId, channel, false)
      deps.log.warn('tool-gateway.tool_failed', { plugin: tool.pluginId, channel })
      throw asError(error)
    }
    if (isSend) {
      await auditSend(entry.name, tool.pluginId, channel, true)
      wake.sent += 1
      wake.firstSendAt ??= deps.clock.now()
      for (const text of texts) outbound.note(channel, text)
    }
    return toResult(output)
  }

  function endWake(sessionId: string): { readonly sent: number; readonly firstSendAt?: number; readonly blocked?: number } {
    const wake = wakesBySession.get(sessionId)
    if (wake === undefined) return { sent: 0 }
    wakesBySession.delete(sessionId)
    wakesById.delete(wake.wakeId)
    return {
      sent: wake.sent,
      ...(wake.firstSendAt === undefined ? {} : { firstSendAt: wake.firstSendAt }),
      ...(wake.sendProactiveMessage !== undefined && wake.blocked > 0 ? { blocked: wake.blocked } : {}),
    }
  }

  function activatedGroups(sessionId: string): readonly string[] {
    const state = sessions.get(sessionId)
    return state === undefined ? [] : sorted(new Set([...state.activated, ...state.pending]))
  }

  function restoreSession(sessionId: string, groups: readonly string[]): void {
    const state = stateFor(sessionId)
    for (const group of groups) state.activated.add(group)
  }

  function resetSession(sessionId: string): void {
    sessions.delete(sessionId)
  }

  function coreBudget(pattern: string): { readonly count: number; readonly tokens: number; readonly over: boolean } {
    const core = allEntries().filter((entry) => entry.load === 'core' && patternsOverlap(entry.channels, pattern))
    let tokens = 0
    for (const entry of core) {
      const tool = describe(entry)
      const bytes = Buffer.byteLength(tool.name) + Buffer.byteLength(tool.description) + Buffer.byteLength(JSON.stringify(tool.parameters))
      tokens += Math.ceil(bytes / 3)
    }
    return { count: core.length, tokens, over: core.length > CORE_TOOL_LIMIT || tokens > CORE_TOKEN_LIMIT }
  }

  return {
    register,
    catalog,
    onCatalogChange(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    planWake,
    surfaceOf,
    dispatch,
    endWake,
    activatedGroups,
    restoreSession,
    resetSession,
    coreBudget,
    checkOutbound: outbound.check,
    admitSend: outbound.admit,
    noteOutbound: outbound.note,
    recentSent: outbound.recent,
    forgetSent: outbound.forget,
    refreshBuiltins: notify,
  }
}
