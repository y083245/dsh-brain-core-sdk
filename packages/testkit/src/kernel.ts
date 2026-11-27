import net from 'node:net'
import path from 'node:path'
import {
  BrainError, LIMITS, VISIBILITIES, hostAllowed, parsePermission, validate, validateManifest,
  type BrainContext, type BrainEvents, type BrainManifest, type ChannelEventResult, type ChannelProvider,
  type ContextBundle, type DerivedRecordInput, type Disclosure, type Disposable, type Envelope, type FetchOptions,
  type FetchResponse, type ForgetReport, type ForgetSelector, type IngestEvent, type MemoryProvider, type MemoryRecord,
  type OutboundMessage, type OwnTimeRequest, type ParsedPermission, type PluginApply, type PluginRequest,
  type ReadL0Request, type ReadL0Result, type RecordInput, type RecordPatch, type SearchHit, type SearchRequest,
  type ToolCallContext, type ToolDefinition, type ToolOutput,
  type Viewer, type ViewOptions, type Visibility, type WakeInput, type WakeResult,
  type WebSocketEvent, type WebSocketSubscribeOptions,
} from '@dsh-brain-core/sdk'

export interface LoadOptions {
  readonly config?: Readonly<Record<string, unknown>>
  /** Defaults to everything the manifest asks for. */
  readonly granted?: readonly string[]
}
export interface FakeWake { readonly channel: string; readonly input: WakeInput }
export interface FakeAgentHelpers {
  callTool(name: string, args?: Readonly<Record<string, unknown>>): Promise<ToolOutput>
}
export type FakeAgentScript = (wake: FakeWake, helpers: FakeAgentHelpers) => Promise<void> | void

export interface TestKernel {
  loadPlugin(plugin: { readonly apply: PluginApply }, manifest: unknown, options?: LoadOptions): Promise<void>
  unload(): Promise<void>
  /** Emits a built-in event as the kernel would. */
  deliver<K extends keyof BrainEvents>(name: K, payload: BrainEvents[K]): void
  http(method: string, path: string, body?: unknown): Promise<Envelope<unknown>>
  callTool(
    name: string,
    args?: Readonly<Record<string, unknown>>,
    options?: { readonly channel?: string; readonly wakeId?: string },
  ): Promise<ToolOutput>
  tools(): readonly string[]
  routes(): readonly string[]
  timers(): number
  records(): readonly MemoryRecord[]
  readonly calls: readonly { readonly method: string; readonly args: readonly unknown[] }[]
  advance(ms: number): Promise<void>
  useAgent(script: FakeAgentScript): void
  useLlm(handler: (request: { readonly system: string; readonly user: string; readonly maxOutputTokens: number }) => Promise<{ readonly text: string; readonly tokens: number }> | { readonly text: string; readonly tokens: number }): void
  memoryProviders(): readonly MemoryProvider[]
  setSecret(name: string, value: string): void
  setResponse(
    url: string,
    response: { readonly status: number; readonly body: string; readonly headers?: Readonly<Record<string, string>> },
  ): void
  webSockets(): readonly { readonly configKey: string; readonly url: string }[]
  emitWebSocket(configKey: string, event: WebSocketEvent): Promise<void>
}

/** Same minimum the real scheduler enforces, so a plugin that works here works there. */
const MIN_INTERVAL_MS = 60_000
const HOUR_MS = 60 * 60 * 1000
const OWN_TIME_NAME = /^[a-z0-9_-]{1,32}$/
const DROPPED_FIELDS: ReadonlySet<string> = new Set(['content', 'text', 'message', 'body', 'prompt', 'note'])
const LOG_DROPPED: ReadonlySet<string> = new Set(['content', 'text', 'message', 'body', 'prompt'])
const DEFAULT_SOURCE_CHANNELS: readonly string[] = ['*:*']
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])
const CHANNEL_ID_PATTERN = /^[^:]+:[^:]+:.+$/
const POLICY_LABELS = {
  here: '就在这里说过',
  raiseOnly: '，不要当众提，对方自己提起再接话',
} as const
const FORBIDDEN_WS_QUERY_PARAMS: ReadonlySet<string> = new Set([
  'access_token', 'token', 'auth', 'authorization', 'api_key', 'apikey', 'key',
  'secret', 'password', 'passwd', 'pwd', 'bearer', 'jwt', 'session', 'cookie',
])

const KINDS: Readonly<Record<string, readonly string[]>> = {
  L1: ['l1.fact', 'l1.event', 'l1.promise', 'l1.topic', 'l1.relation', 'l1.self', 'l1.knowledge', 'l1.candidate'],
  L2: ['l2.scene', 'l2.person_tip', 'l2.expression', 'l2.interest', 'l2.reflection', 'l2.autobiography'],
}
const LAYER_ORDER: Readonly<Record<string, number>> = { L0: 0, L1: 1, L2: 2, L3: 3 }

interface RegisteredTool {
  readonly definition: ToolDefinition
  readonly channels: readonly string[]
  readonly ownerOnly: boolean
}
interface RouteEntry {
  readonly handler: (request: PluginRequest) => Promise<unknown>
}
interface Task {
  readonly id: string
  readonly kind: 'every' | 'at' | 'ownTime'
  readonly run: () => Promise<void> | void
  nextAt: number
  readonly intervalMs?: number
  readonly name?: string
}
interface CallRecord { readonly method: string; readonly args: readonly unknown[] }
type Handler = (payload: unknown) => void | Promise<void>

function denied(message: string): BrainError {
  return new BrainError('PERMISSION_DENIED', message)
}
function invalidArgument(message: string): BrainError {
  return new BrainError('INVALID_ARGUMENT', message)
}
function clone<T>(value: T): T {
  return structuredClone(value)
}
/** `qq:group:*` matches `qq:group:123`; otherwise the channel must be equal. */
function channelMatches(pattern: string, channel: string): boolean {
  if (pattern === channel) return true
  const head = pattern.split(':')
  if (head.length < 3 || head[head.length - 1] !== '*') return false
  const prefix = head.slice(0, -1).join(':')
  return channel.startsWith(`${prefix}:`) && channel.length > prefix.length + 1 && channel.split(':').length >= 3
}

/** A tool's `channels` pattern is `<source>:<kind>` with `*` standing for either part. */
function toolChannelMatches(patterns: readonly string[], channel: string): boolean {
  const parts = channel.split(':')
  if (parts.length < 3) return false
  const [source, kind] = [parts[0] as string, parts[1] as string]
  return patterns.some((pattern) => {
    const given = pattern.split(':')
    if (given.length !== 2) return false
    return (given[0] === '*' || given[0] === source) && (given[1] === '*' || given[1] === kind)
  })
}

function assertObjectRoot(parameters: unknown): void {
  if (typeof parameters !== 'object' || parameters === null
    || (parameters as { readonly type?: unknown }).type !== 'object') {
    throw new BrainError('INVALID_ARGUMENT', '工具的参数根必须是 object。')
  }
}

/** Exported for the kit's own tests: the call log and the stored log both go through this filter. */
export function filterLogFields(fields: Readonly<Record<string, unknown>> | undefined, secrets: Iterable<string>): Record<string, string | number | boolean> {
  const known = [...secrets]
  const out: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (LOG_DROPPED.has(key.toLowerCase())) continue
    if (typeof value === 'string') {
      let text = value
      for (const secret of known) {
        if (secret !== '') text = text.split(secret).join('[redacted]')
      }
      out[key] = text
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value
    }
  }
  return out
}

/** The call log keeps ids and numbers, never chat text. */
function sanitize(value: unknown): unknown {
  if (value instanceof Uint8Array) return { bytes: value.byteLength }
  if (Array.isArray(value)) return value.map(sanitize)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (DROPPED_FIELDS.has(key.toLowerCase())) continue
      out[key] = sanitize(entry)
    }
    return out
  }
  return value
}

/** Hosts of the URLs held by one config field (a string or an array of strings). */
function configHosts(config: unknown, key: string): string[] {
  const value = typeof config === 'object' && config !== null ? (config as Record<string, unknown>)[key] : undefined
  const items = Array.isArray(value) ? value : [value]
  const hosts: string[] = []
  for (const item of items) {
    if (typeof item !== 'string') continue
    try {
      hosts.push(new URL(item).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, ''))
    } catch {
      // not a URL
    }
  }
  return hosts
}

function bareHost(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
}

const LOOPBACK_BLOCK_LIST = (() => {
  const list = new net.BlockList()
  list.addSubnet('127.0.0.0', 8, 'ipv4')
  list.addSubnet('::1', 128, 'ipv6')
  list.addSubnet('::ffff:127.0.0.0', 104, 'ipv6')
  return list
})()

function isLoopbackHost(hostname: string): boolean {
  let candidate = hostname.toLowerCase()
  if (candidate.replace(/\.$/, '') === 'localhost') return true
  if (candidate.startsWith('[') && candidate.endsWith(']')) {
    candidate = candidate.slice(1, -1)
  }
  if (candidate === '' || candidate.includes('%')) return false
  const family = net.isIP(candidate)
  if (family === 4) return LOOPBACK_BLOCK_LIST.check(candidate, 'ipv4')
  if (family !== 6) return false
  let normalized: string
  try {
    normalized = new URL(`http://[${candidate}]/`).hostname.slice(1, -1)
  } catch {
    return false
  }
  return LOOPBACK_BLOCK_LIST.check(normalized, 'ipv6')
}

function kindOfChannel(channel: string): string {
  return channel.split(':')[1] ?? ''
}

interface FakeWebSocketSubscription {
  readonly configKey: string
  readonly url: string
  readonly listener: (event: WebSocketEvent) => void | Promise<void>
}

class FakeKernel implements TestKernel {
  readonly calls: CallRecord[] = []
  #now: number
  #loaded = false
  #manifest: BrainManifest | undefined
  #granted = new Set<string>()
  #config: Readonly<Record<string, unknown>> = {}
  #ctx: BrainContext | undefined
  #nextRecord = 0
  #nextRequest = 0
  #nextWake = 0
  #nextCall = 0
  #nextTask = 0
  #writes: number[] = []
  #agentScript: FakeAgentScript | undefined
  #llmHandler: ((request: { readonly system: string; readonly user: string; readonly maxOutputTokens: number }) => Promise<{ readonly text: string; readonly tokens: number }> | { readonly text: string; readonly tokens: number }) | undefined
  readonly #records = new Map<string, MemoryRecord>()
  readonly #idempotency = new Map<string, string>()
  readonly #tools = new Map<string, RegisteredTool>()
  readonly #activeCalls = new Map<string, { readonly channel: string; readonly wakeId: string }>()
  readonly #routes = new Map<string, RouteEntry>()
  readonly #tasks = new Map<string, Task>()
  readonly #listeners = new Map<string, Set<Handler>>()
  readonly #providers: ChannelProvider[] = []
  readonly #memoryProviders: MemoryProvider[] = []
  readonly #pages = new Map<string, { readonly id: string; readonly title: string; readonly entry: string }>()
  readonly #secrets = new Map<string, string>()
  readonly #storage = new Map<string, Uint8Array>()
  readonly #responses = new Map<string, { readonly status: number; readonly body: string; readonly headers?: Readonly<Record<string, string>> }>()
  readonly #webSockets = new Set<FakeWebSocketSubscription>()
  readonly #identityLinks = new Map<string, string>()
  readonly #logs: Record<string, unknown>[] = []
  readonly #ownerChannels: ReadonlySet<string>

  constructor(now: number, ownerChannels: ReadonlySet<string>) {
    this.#now = now
    this.#ownerChannels = ownerChannels
  }

  get #id(): string {
    return this.#manifest?.id ?? ''
  }

  get #source(): BrainManifest['source'] {
    return this.#manifest?.source
  }

  #record(method: string, args: readonly unknown[]): void {
    this.calls.push({ method, args: args.map(sanitize) })
  }

  #alive(): void {
    if (!this.#loaded) throw denied('plugin is not enabled')
  }

  #need(permission: string): void {
    this.#alive()
    if (!this.#granted.has(permission)) throw denied(`permission ${permission} is not granted`)
  }

  #owns(channel: unknown): channel is string {
    if (typeof channel !== 'string') return false
    return (this.#source?.channels ?? []).some((pattern) => channelMatches(pattern, channel))
  }

  #own(channel: unknown): string {
    if (!this.#owns(channel)) throw denied('channel does not belong to this plugin')
    return channel
  }

  #limit(): void {
    const max = this.#source?.rateLimitPerHour
    if (max === undefined) return
    while (this.#writes.length > 0 && (this.#writes[0] as number) <= this.#now - HOUR_MS) this.#writes.shift()
    if (this.#writes.length >= max) throw new BrainError('RATE_LIMITED', 'write rate limit reached')
    this.#writes.push(this.#now)
  }

  #participants(channel: string): Promise<readonly string[]> {
    const provider = this.#providers[0]
    return provider === undefined ? Promise.resolve([]) : provider.members(channel)
  }

  async #viewerFor(view: ViewOptions | undefined): Promise<Viewer> {
    const channel = view?.channel
    if (channel === undefined) return { caller: this.#id, channel: null, participants: [] }
    this.#own(channel)
    return { caller: this.#id, channel, participants: await this.#participants(channel) }
  }

  #assertContentSize(content: Readonly<Record<string, unknown>>): void {
    if (Buffer.byteLength(JSON.stringify(content) ?? '') > LIMITS.contentBytes) {
      throw new BrainError('PAYLOAD_TOO_LARGE', 'record content is too large')
    }
  }

  #store(record: MemoryRecord, idempotencyKey: string | undefined): MemoryRecord {
    this.#records.set(record.id, record)
    if (idempotencyKey !== undefined) this.#idempotency.set(`${record.source}\u0000${idempotencyKey}`, record.id)
    return clone(record)
  }

  #existingIdempotent(source: string, key: string | undefined): MemoryRecord | undefined {
    if (key === undefined) return undefined
    const id = this.#idempotency.get(`${source}\u0000${key}`)
    return id === undefined ? undefined : this.#records.get(id)
  }

  #newId(layer: string): string {
    this.#nextRecord += 1
    return `${layer.toLowerCase()}_${String(this.#nextRecord).padStart(26, '0')}`
  }

  async #ingest(event: IngestEvent): Promise<{ readonly id: string }> {
    this.#record('memory.ingest', [event])
    this.#need('memory.ingest')
    const channel = this.#own((event as { readonly channel?: unknown } | null)?.channel)
    this.#limit()
    validate('IngestEvent', event)
    const source = this.#source
    if (source === undefined) throw denied('plugin has no source in its manifest')
    if (!source.eventKinds.includes(event.kind)) {
      throw denied(`event kind ${event.kind} is not registered for ${this.#id}`)
    }
    this.#assertContentSize(event.content)
    const existing = this.#existingIdempotent(this.#id, event.idempotencyKey)
    if (existing !== undefined) return { id: existing.id }
    const record: MemoryRecord = {
      id: this.#newId('L0'),
      layer: 'L0',
      kind: event.kind,
      source: this.#id,
      channel,
      subjects: [...event.subjects],
      actor: event.actor,
      content: clone(event.content),
      evidence: [],
      visibility: (event.visibility ?? source.defaultVisibility) as Visibility,
      trust: source.trust,
      confidence: 1,
      importance: 0.5,
      tEvent: event.tEvent,
      tIngest: this.#now,
      status: 'active',
      version: 1,
    }
    return { id: this.#store(record, event.idempotencyKey).id }
  }

  async #recordMemory(input: RecordInput): Promise<MemoryRecord> {
    this.#record('memory.record', [input])
    this.#need('memory.record')
    const channel = this.#own((input as { readonly channel?: unknown } | null)?.channel)
    this.#limit()
    validate('RecordInput', input)
    const source = this.#source
    if (source === undefined) throw denied('plugin has no source in its manifest')
    if (!(KINDS[input.layer] ?? []).includes(input.kind)) {
      throw invalidArgument(`kind ${input.kind} is not a ${input.layer} kind`)
    }
    this.#assertContentSize(input.content)
    if (input.evidence.length === 0) throw invalidArgument(`${input.layer} records need at least one evidence reference`)
    for (const reference of input.evidence) {
      const target = this.#records.get(reference.id)
      if (target === undefined) throw invalidArgument(`evidence ${reference.id} does not exist`)
      if (target.status === 'tombstoned') throw invalidArgument(`evidence ${reference.id} is tombstoned`)
      if ((LAYER_ORDER[target.layer] as number) >= (LAYER_ORDER[input.layer] as number)) {
        throw invalidArgument(`evidence ${reference.id} is not from a lower layer`)
      }
    }
    const existing = this.#existingIdempotent(this.#id, input.idempotencyKey)
    if (existing !== undefined) return clone(existing)
    this.#nextRecord += 1
    const record: MemoryRecord = {
      id: `l${input.layer === 'L1' ? '1' : '2'}_${String(this.#nextRecord).padStart(26, '0')}`,
      layer: input.layer,
      kind: input.kind,
      source: this.#id,
      channel,
      subjects: [...input.subjects],
      actor: input.actor,
      content: clone(input.content),
      evidence: input.evidence.map((reference) => ({ id: reference.id })),
      visibility: (input.visibility ?? source.defaultVisibility) as Visibility,
      trust: source.trust,
      confidence: input.confidence ?? 1,
      importance: input.importance ?? 0.5,
      tEvent: input.tEvent ?? this.#now,
      tIngest: this.#now,
      status: 'active',
      version: 1,
      ...(input.validFrom === undefined ? {} : { validFrom: input.validFrom }),
    }
    return this.#store(record, input.idempotencyKey)
  }

  async #update(recordId: string, patch: RecordPatch, expectedVersion: number, view: ViewOptions | undefined): Promise<MemoryRecord> {
    this.#record('memory.update', [recordId, patch, expectedVersion, view])
    this.#need('memory.record')
    const viewer = await this.#viewerFor(view)
    const current = this.#records.get(recordId)
    if (current === undefined || current.status === 'tombstoned') throw new BrainError('NOT_FOUND', 'record not found')
    if (current.source !== this.#id) throw denied(`record ${current.id} belongs to ${current.source}`)
    validate('RecordPatch', patch)
    if (current.layer === 'L0') throw denied('L0 records cannot be patched')
    if (current.layer === 'L3') throw denied('L3 records are versioned and cannot be patched by a plugin')
    if (patch.status === 'tombstoned') throw invalidArgument("use remove() instead of patch({ status: 'tombstoned' })")
    if (expectedVersion !== current.version) {
      throw new BrainError('CONFLICT', `record ${current.id} is at version ${current.version}`)
    }
    if (patch.content !== undefined) this.#assertContentSize(patch.content)
    void viewer
    const next: MemoryRecord = {
      ...current,
      ...(patch.content === undefined ? {} : { content: clone(patch.content) }),
      ...(patch.subjects === undefined ? {} : { subjects: [...patch.subjects] }),
      ...(patch.visibility === undefined ? {} : { visibility: patch.visibility }),
      ...(patch.confidence === undefined ? {} : { confidence: patch.confidence }),
      ...(patch.importance === undefined ? {} : { importance: patch.importance }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.validTo === undefined ? {} : { validTo: patch.validTo }),
      version: current.version + 1,
    }
    this.#records.set(next.id, next)
    return clone(next)
  }

  async #remove(recordId: string, view: ViewOptions | undefined): Promise<void> {
    this.#record('memory.remove', [recordId, view])
    this.#need('memory.record')
    await this.#viewerFor(view)
    const current = this.#records.get(recordId)
    if (current === undefined || current.status === 'tombstoned') throw new BrainError('NOT_FOUND', 'record not found')
    if (current.source !== this.#id) throw denied(`record ${current.id} belongs to ${current.source}`)
    if (current.layer === 'L3') throw denied('L3 records are versioned and cannot be removed')
    this.#tombstone(current)
  }

  #tombstone(record: MemoryRecord): boolean {
    if (record.status === 'tombstoned') return false
    this.#records.set(record.id, { ...record, content: {}, status: 'tombstoned', version: record.version + 1 })
    return true
  }

  async #search(request: SearchRequest, view: ViewOptions | undefined): Promise<{
    readonly items: readonly SearchHit[]; readonly nextCursor?: string; readonly degraded: boolean
  }> {
    this.#record('memory.search', [request, view])
    this.#need('memory.search')
    const viewer = await this.#viewerFor(view)
    validate('SearchRequest', request)
    const limit = Math.min(request.limit ?? 20, LIMITS.searchLimit)
    const offset = request.cursor === undefined ? 0 : this.#decodeCursor(request.cursor)
    const matched = [...this.#records.values()].filter((record) => {
      if (record.source !== this.#id || record.status !== 'active' || record.visibility !== 'open') return false
      if (request.layers !== undefined && !request.layers.includes(record.layer)) return false
      if (request.from !== undefined && record.tEvent < request.from) return false
      if (request.to !== undefined && record.tEvent > request.to) return false
      if (request.subjects !== undefined && request.subjects.length > 0
        && !record.subjects.some((subject) => request.subjects?.includes(subject) === true)) return false
      if (request.scope === 'here' && (viewer.channel === null || record.channel !== viewer.channel)) return false
      return JSON.stringify(record.content).includes(request.query)
    })
    const page = matched.slice(offset, offset + limit)
    const nextCursor = matched.length > offset + limit ? this.#encodeCursor(offset + limit) : undefined
    return {
      items: page.map((record) => ({
        record: clone(record),
        disclosure: { speakable: 'yes' as const, label: 'own record' },
        score: 1,
      })),
      ...(nextCursor === undefined ? {} : { nextCursor }),
      degraded: false,
    }
  }

  #decodeCursor(cursor: string): number {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { readonly offset?: unknown }
      if (typeof parsed.offset === 'number' && Number.isSafeInteger(parsed.offset) && parsed.offset >= 0) return parsed.offset
    } catch {
      // fall through
    }
    throw invalidArgument('invalid cursor')
  }

  #encodeCursor(offset: number): string {
    return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url')
  }

  async #readChannelEvent(recordId: string, call: ToolCallContext): Promise<ChannelEventResult> {
    this.#record('memory.readChannelEvent', [recordId, call])
    this.#need('memory.search')
    if (typeof recordId !== 'string' || recordId.length === 0) {
      throw invalidArgument('recordId must be a non-empty string')
    }
    if (typeof call !== 'object' || call === null || Array.isArray(call)) {
      throw denied('readChannelEvent requires an active tool call context')
    }
    const callToken = (call as { readonly callToken?: unknown }).callToken
    const active = typeof callToken === 'string' ? this.#activeCalls.get(callToken) : undefined
    if (active === undefined || call.channel !== active.channel || call.wakeId !== active.wakeId) {
      throw denied('invalid or expired tool call token')
    }
    this.#own(active.channel)
    const record = this.#records.get(recordId)
    if (
      record === undefined
      || record.layer !== 'L0'
      || record.status !== 'active'
      || record.source !== this.#id
      || record.channel !== active.channel
    ) {
      throw new BrainError('NOT_FOUND', 'record not found')
    }

    let disclosure: Disclosure
    switch (record.visibility) {
      case 'internal':
        throw new BrainError('NOT_FOUND', 'record not found')
      case 'owner':
        if (!this.#ownerChannels.has(active.channel)) {
          throw new BrainError('NOT_FOUND', 'record not found')
        }
        disclosure = { speakable: 'yes', label: POLICY_LABELS.here }
        break
      case 'origin':
      case 'open':
        disclosure = { speakable: 'yes', label: POLICY_LABELS.here }
        break
      case 'subject': {
        const subjects = new Set(record.subjects.filter((subject) => subject !== 'self' && !CHANNEL_ID_PATTERN.test(subject)))
        const participants = (await this.#participants(active.channel)).filter((person) => person !== 'self')
        if (!participants.some((person) => subjects.has(person))) {
          throw new BrainError('NOT_FOUND', 'record not found')
        }
        const speakable = kindOfChannel(active.channel) === 'private' ? 'yes' : 'if-subject-raises'
        disclosure = {
          speakable,
          label: speakable === 'if-subject-raises' ? POLICY_LABELS.here + POLICY_LABELS.raiseOnly : POLICY_LABELS.here,
        }
        break
      }
    }
    return { record: clone(record), disclosure }
  }

  async #context(request: { readonly channel: string; readonly query?: string }): Promise<ContextBundle> {
    this.#record('memory.context', [request])
    this.#need('memory.context')
    this.#own((request as { readonly channel?: unknown } | null)?.channel)
    validate('ContextRequest', request)
    const items = [...this.#records.values()]
      .filter((record) => record.source === this.#id && record.status === 'active' && record.visibility === 'open'
        && (request.query === undefined || JSON.stringify(record.content).includes(request.query)))
      .map((record) => ({
        id: record.id,
        text: JSON.stringify(record.content),
        disclosure: { speakable: 'yes' as const, label: 'own record' },
      }))
    return { profileVersion: 1, stable: '', blocks: [{ name: 'facts', items }], truncated: false }
  }

  async #forget(selector: ForgetSelector): Promise<ForgetReport> {
    this.#record('memory.forget', [selector])
    this.#need('memory.forget')
    validate('ForgetSelector', selector)
    const raw = selector as unknown as Record<string, unknown>
    if (raw.by === 'record') {
      if (typeof raw.id !== 'string' || raw.id === '') throw invalidArgument('a record id is required')
      const record = this.#records.get(raw.id)
      if (record === undefined || record.source !== this.#id) throw new BrainError('NOT_FOUND', 'no such record')
      if (record.layer === 'L3') throw denied('L3 records cannot be forgotten by a plugin')
      return { tombstoned: this.#tombstone(record) ? 1 : 0, invalidated: 0, l3Flagged: 0 }
    }
    if (raw.by === 'channel') {
      this.#own(raw.channel)
      return this.#forgetMatching((record) => record.channel === raw.channel)
    }
    if (raw.by === 'time') {
      // A time-only selector is the owner's; a plugin must name one of its channels.
      if (raw.channel === undefined) throw denied('this selector is for the owner only')
      this.#own(raw.channel)
      return this.#forgetMatching((record) => {
        if (record.tEvent < (raw.from as number) || record.tEvent > (raw.to as number)) return false
        return raw.channel === undefined || record.channel === raw.channel
      })
    }
    throw denied('this selector is for the owner only')
  }

  #forgetMatching(matches: (record: MemoryRecord) => boolean): ForgetReport {
    let tombstoned = 0
    let l3Flagged = 0
    for (const record of [...this.#records.values()]) {
      if (!matches(record)) continue
      if (record.layer === 'L3') {
        if (record.status !== 'tombstoned') l3Flagged += 1
        continue
      }
      if (this.#tombstone(record)) tombstoned += 1
    }
    return { tombstoned, invalidated: 0, l3Flagged }
  }

  async #readL0(request?: ReadL0Request): Promise<ReadL0Result> {
    this.#record('memory.readL0', [request])
    this.#need('memory.readL0')
    if (request !== undefined) {
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        throw invalidArgument('readL0 request must be an object')
      }
      if (request.afterId !== undefined && typeof request.afterId !== 'string') {
        throw invalidArgument('afterId must be a string')
      }
      if (request.from !== undefined && (typeof request.from !== 'number' || !Number.isFinite(request.from))) {
        throw invalidArgument('from must be a finite number')
      }
      if (request.to !== undefined && (typeof request.to !== 'number' || !Number.isFinite(request.to))) {
        throw invalidArgument('to must be a finite number')
      }
      if (request.limit !== undefined && (typeof request.limit !== 'number' || !Number.isInteger(request.limit) || request.limit < 1 || request.limit > LIMITS.searchLimit)) {
        throw invalidArgument(`limit must be an integer between 1 and ${LIMITS.searchLimit}`)
      }
    }
    const limit = request?.limit ?? LIMITS.searchLimit
    const matched = [...this.#records.values()]
      .filter((record) => {
        if (record.layer !== 'L0' || record.status !== 'active') return false
        if (request?.from !== undefined && record.tEvent < request.from) return false
        if (request?.to !== undefined && record.tEvent > request.to) return false
        if (request?.afterId !== undefined && record.id <= request.afterId) return false
        return true
      })
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    const page = matched.slice(0, limit)
    const nextCursor = matched.length > limit ? page[page.length - 1]!.id : undefined
    return {
      items: page.map(clone),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    }
  }

  async #writeDerived(input: DerivedRecordInput): Promise<MemoryRecord> {
    this.#record('memory.writeDerived', [input])
    this.#need('memory.writeDerived')
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw invalidArgument('derived record input must be an object')
    }
    if (typeof input.channel !== 'string' || input.channel === '') {
      throw invalidArgument('channel must be a non-empty string')
    }
    if (!Array.isArray(input.subjects) || input.subjects.some((s) => typeof s !== 'string') || input.subjects.length > LIMITS.subjects) {
      throw invalidArgument('invalid subjects')
    }
    if (typeof input.content !== 'object' || input.content === null || Array.isArray(input.content)) {
      throw invalidArgument('content must be an object')
    }
    this.#assertContentSize(input.content)
    if (!Array.isArray(input.evidence) || input.evidence.length === 0 || input.evidence.length > LIMITS.evidence) {
      throw invalidArgument('derived records need at least one evidence reference')
    }
    if (input.visibility !== undefined && !VISIBILITIES.includes(input.visibility)) {
      throw invalidArgument('invalid visibility')
    }
    if (input.confidence !== undefined && (typeof input.confidence !== 'number' || !Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) {
      throw invalidArgument('confidence must be between 0 and 1')
    }
    if (input.importance !== undefined && (typeof input.importance !== 'number' || !Number.isFinite(input.importance) || input.importance < 0 || input.importance > 1)) {
      throw invalidArgument('importance must be between 0 and 1')
    }
    for (const reference of input.evidence) {
      if (typeof reference !== 'object' || reference === null || typeof reference.id !== 'string' || reference.id === '') {
        throw invalidArgument('invalid evidence reference')
      }
      const target = this.#records.get(reference.id)
      if (target === undefined) throw invalidArgument(`evidence ${reference.id} does not exist`)
      if (target.status === 'tombstoned') throw invalidArgument(`evidence ${reference.id} is tombstoned`)
      if (target.layer !== 'L0') throw invalidArgument(`evidence ${reference.id} must be an L0 record`)
    }
    const existing = this.#existingIdempotent(this.#id, input.idempotencyKey)
    if (existing !== undefined) return clone(existing)
    const record: MemoryRecord = {
      id: this.#newId('L1'),
      layer: 'L1',
      kind: 'l1.candidate',
      source: this.#id,
      channel: input.channel,
      subjects: [...input.subjects],
      actor: this.#id,
      content: clone(input.content),
      evidence: input.evidence.map((reference) => ({ id: reference.id })),
      visibility: (input.visibility ?? 'origin') as Visibility,
      trust: 'external',
      confidence: input.confidence ?? 1,
      importance: input.importance ?? 0.5,
      tEvent: input.tEvent ?? this.#now,
      tIngest: this.#now,
      status: 'active',
      version: 1,
    }
    return this.#store(record, input.idempotencyKey)
  }

  #provideMemory(provider: MemoryProvider): Disposable {
    this.#record('memory.provide', [provider])
    this.#need('memory.readL0')
    if (!this.#manifest?.kinds.includes('memory-provider')) {
      throw denied('memory.provide requires plugin kind "memory-provider"')
    }
    if (typeof provider !== 'object' || provider === null || typeof provider.search !== 'function' || typeof provider.onForgotten !== 'function') {
      throw invalidArgument('memory provider must implement search and onForgotten')
    }
    this.#memoryProviders.push(provider)
    return () => {
      const index = this.#memoryProviders.indexOf(provider)
      if (index !== -1) this.#memoryProviders.splice(index, 1)
    }
  }

  #dispatch(name: string, payload: unknown): void {
    for (const handler of [...(this.#listeners.get(name) ?? [])]) {
      try {
        const result = handler(payload)
        if (result instanceof Promise) result.catch(() => undefined)
      } catch {
        // one handler's failure must not reach the others
      }
    }
  }

  #permittedHost(host: string): boolean {
    const parsed: ParsedPermission[] = []
    for (const entry of this.#granted) {
      try {
        parsed.push(parsePermission(entry))
      } catch {
        // not a permission string
      }
    }
    return parsed.some((permission) => {
      if (permission.kind === 'network') return hostAllowed(permission.host, host)
      if (permission.kind === 'network-config') return configHosts(this.#config, permission.key).includes(host)
      if (permission.kind === 'lan') return bareHost(permission.host) === host
      if (permission.kind === 'lan-config') return configHosts(this.#config, permission.key).includes(host)
      return false
    })
  }

  async #fetch(url: string, options: FetchOptions = {}): Promise<FetchResponse> {
    this.#record('http.fetch', [url, options])
    this.#alive()
    if (options.redirect !== undefined && options.redirect !== 'follow' && options.redirect !== 'error') {
      throw invalidArgument('redirect must be "follow" or "error"')
    }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw invalidArgument('invalid URL')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw denied('only http and https are allowed')
    if (parsed.username !== '' || parsed.password !== '') throw denied('a URL must not carry credentials')
    const host = bareHost(parsed.hostname)
    if (!this.#permittedHost(host)) throw denied(`network access to ${host} is not granted`)
    const response = this.#responses.get(url)
    if (response === undefined) throw new BrainError('UNAVAILABLE', `no fake response for ${url}`)
    if (options.redirect === 'error' && REDIRECT_STATUSES.has(response.status)) {
      throw new BrainError('PERMISSION_DENIED', 'redirects are not allowed')
    }
    const bytes = new TextEncoder().encode(response.body)
    return {
      status: response.status,
      headers: response.headers ? { ...response.headers } : {},
      text: () => response.body,
      bytes: () => bytes,
    }
  }

  async #subscribeWebSocket(
    options: WebSocketSubscribeOptions,
    listener: (event: WebSocketEvent) => void | Promise<void>,
  ): Promise<Disposable> {
    this.#record('http.subscribeWebSocket', [options])
    this.#alive()
    if (typeof options !== 'object' || options === null || Array.isArray(options)) {
      throw invalidArgument('options must be an object')
    }
    if (typeof listener !== 'function') {
      throw invalidArgument('listener must be a function')
    }
    if (typeof options.configKey !== 'string' || options.configKey.length === 0) {
      throw invalidArgument('configKey must be a non-empty string')
    }
    if (
      !this.#granted.has(`lan:config:${options.configKey}`)
      && !this.#granted.has(`network:config:${options.configKey}`)
    ) {
      throw denied(`permission lan:config:${options.configKey} or network:config:${options.configKey} is not granted`)
    }
    const rawConfigured = this.#config[options.configKey]
    if (typeof rawConfigured !== 'string' || rawConfigured.length === 0) {
      throw invalidArgument(`config.${options.configKey} must be a non-empty WebSocket URL`)
    }
    let configured: URL
    try {
      configured = new URL(rawConfigured)
    } catch {
      throw invalidArgument('invalid configured WebSocket URL')
    }
    if (configured.protocol !== 'ws:' && configured.protocol !== 'wss:') {
      throw denied('only ws and wss are allowed')
    }
    if (configured.username !== '' || configured.password !== '') {
      throw denied('a WebSocket URL must not carry credentials')
    }

    let authParamLower: string | undefined
    if (options.auth !== undefined) {
      if (typeof options.auth !== 'object' || options.auth === null || Array.isArray(options.auth)) {
        throw invalidArgument('auth must be an object')
      }
      if (
        !Array.isArray(options.auth.secretNames)
        || options.auth.secretNames.length === 0
        || options.auth.secretNames.some((name) => typeof name !== 'string' || name.length === 0)
      ) {
        throw invalidArgument('auth.secretNames must be a non-empty array of strings')
      }
      if (options.auth.transport !== undefined && options.auth.transport !== 'header' && options.auth.transport !== 'query') {
        throw invalidArgument('auth.transport must be "header" or "query"')
      }
      if (options.auth.paramName !== undefined) {
        if (typeof options.auth.paramName !== 'string' || options.auth.paramName.length === 0) {
          throw invalidArgument('auth.paramName must be a non-empty string')
        }
        authParamLower = options.auth.paramName.toLowerCase()
      }
    }

    for (const key of configured.searchParams.keys()) {
      const lower = key.toLowerCase()
      if (FORBIDDEN_WS_QUERY_PARAMS.has(lower) || (authParamLower !== undefined && lower === authParamLower)) {
        throw denied(`WebSocket URL must not contain auth query parameter "${key}"`)
      }
    }

    if (options.url !== undefined) {
      if (typeof options.url !== 'string') throw denied('WebSocket URL mismatch')
      let expected: URL
      try {
        expected = new URL(options.url)
      } catch {
        throw denied('WebSocket URL mismatch')
      }
      if (
        expected.protocol !== configured.protocol
        || expected.hostname !== configured.hostname
        || expected.port !== configured.port
        || expected.pathname !== configured.pathname
        || expected.search !== configured.search
        || expected.username !== ''
        || expected.password !== ''
      ) {
        throw denied('WebSocket URL does not match configured URL')
      }
    }

    if (options.auth !== undefined) {
      for (const name of options.auth.secretNames) {
        if (!this.#granted.has(`secrets:${name}`)) {
          throw denied(`permission secrets:${name} is not granted`)
        }
      }
      let resolvedSecret: string | undefined
      for (const name of options.auth.secretNames) {
        const value = this.#secrets.get(name)
        if (value !== undefined && value !== '') {
          resolvedSecret = value
          break
        }
      }
      if (resolvedSecret !== undefined && configured.protocol === 'ws:' && !isLoopbackHost(configured.hostname)) {
        throw denied('ws: with a secret is only allowed for loopback hosts')
      }
    }

    const subscription: FakeWebSocketSubscription = {
      configKey: options.configKey,
      url: configured.href,
      listener,
    }
    this.#webSockets.add(subscription)
    try {
      await listener({ type: 'open' })
    } catch {
      // listener failure must not break subscription registration
    }
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.#webSockets.delete(subscription)
    }
  }

  #storagePath(relative: unknown): string {
    if (typeof relative !== 'string' || relative.length === 0) throw invalidArgument('path must not be empty')
    if (relative.includes('\0')) throw invalidArgument('invalid path')
    if (path.isAbsolute(relative) || path.win32.isAbsolute(relative) || path.posix.isAbsolute(relative)) {
      throw denied('absolute paths are refused')
    }
    if (relative.split(/[\\/]+/).includes('..')) throw denied('.. is refused')
    return relative.split(/[\\/]+/).filter((part) => part !== '' && part !== '.').join('/')
  }

  #log(level: 'info' | 'warn' | 'error', event: string, fields: Readonly<Record<string, string | number | boolean>> | undefined): void {
    const filtered = filterLogFields(fields, this.#secrets.values())
    this.#record(`logger.${level}`, [event, filtered])
    this.#alive()
    this.#logs.push({ t: this.#now, level, event, ...filtered })
  }

  async #runTask(task: Task): Promise<void> {
    try {
      await task.run()
    } catch {
      // a failing task is only logged in the real scheduler; it never stops the others
    }
  }

  #buildContext(): BrainContext {
    const id = this.#id
    return {
      plugin: { id, version: '0.0.0' },
      memory: {
        ingest: (event) => this.#ingest(event),
        record: (input) => this.#recordMemory(input),
        update: (recordId, patch, expectedVersion, view) => this.#update(recordId, patch, expectedVersion, view),
        remove: (recordId, view) => this.#remove(recordId, view),
        search: (request, view) => this.#search(request, view),
        readChannelEvent: (recordId, call) => this.#readChannelEvent(recordId, call),
        context: (request) => this.#context(request),
        forget: (selector) => this.#forget(selector),
        readL0: (request) => this.#readL0(request),
        writeDerived: (input) => this.#writeDerived(input),
        provide: (provider) => this.#provideMemory(provider),
      },
      agent: {
        session: (channel) => {
          this.#record('agent.session', [channel])
          this.#need('agent.session')
          const owned = this.#own(channel)
          return {
            channel: owned,
            wake: (input) => this.#wake(owned, input),
            rotate: async () => {
              this.#record('agent.rotate', [owned])
              this.#alive()
            },
          }
        },
        wake: (channel, input) => this.#wake(channel, input),
      },
      tools: {
        register: (tool) => this.#registerTool(tool),
      },
      channel: {
        provide: (provider) => this.#provide(provider),
        send: (channel, message) => this.#send(channel, message),
      },
      identity: {
        resolve: (account) => this.#resolveIdentity(account),
        link: (account, personId) => this.#linkIdentity(account, personId),
      },
      scheduler: {
        every: (ms, run) => this.#every(ms, run),
        at: (timeMs, run) => this.#at(timeMs, run),
        ownTime: (request) => this.#ownTime(request),
      },
      events: {
        on: (name: string, handler: Handler) => this.#on(name, handler),
        emit: (name, payload) => this.#emit(name, payload),
      } as BrainContext['events'],
      http: {
        route: (method, routePath, handler) => this.#route(method, routePath, handler),
        fetch: (url, options) => this.#fetch(url, options),
        subscribeWebSocket: (options, listener) => this.#subscribeWebSocket(options, listener),
      },
      console: {
        page: (descriptor) => this.#page(descriptor),
      },
      config: this.#config,
      secrets: {
        get: (name) => this.#getSecret(name),
      },
      storage: {
        read: (relative) => this.#storageRead(relative),
        write: (relative, data) => this.#storageWrite(relative, data),
        remove: (relative) => this.#storageRemove(relative),
        list: (prefix) => this.#storageList(prefix),
      },
      logger: {
        info: (event, fields) => this.#log('info', event, fields),
        warn: (event, fields) => this.#log('warn', event, fields),
        error: (event, fields) => this.#log('error', event, fields),
      },
      llm: {
        complete: async (request) => {
          this.#record('llm.complete', [])
          this.#need('llm.invoke')
          if (this.#llmHandler === undefined) {
            throw new BrainError('UNAVAILABLE', 'ctx.llm arrives after v1')
          }
          return this.#llmHandler(request)
        },
      },
    }
  }

  async #wake(channel: string, input: WakeInput): Promise<WakeResult> {
    this.#record('agent.wake', [channel, input])
    this.#need('agent.session')
    const owned = this.#own(channel)
    this.#nextWake += 1
    const wakeId = `wake_${this.#nextWake}`
    if (this.#agentScript !== undefined) {
      const helpers: FakeAgentHelpers = {
        callTool: (name, args) => this.callTool(name, args, { channel: owned, wakeId }),
      }
      await this.#agentScript({ channel: owned, input }, helpers)
    }
    return { wakeId, acked: true, profileVersion: 1, sent: 0, steps: 0 }
  }

  #registerTool(tool: ToolDefinition): Disposable {
    this.#record('tools.register', [tool])
    this.#need('tools.register')
    const declared = this.#manifest?.tools?.find((candidate) => candidate.name === tool.name)
    if (declared === undefined) throw denied(`tool ${tool.name} is not in the manifest`)
    assertObjectRoot(tool.parameters)
    const full = `${this.#id}__${tool.name}`
    if (this.#tools.has(full)) throw new BrainError('CONFLICT', `tool ${full} is already registered`)
    const channels = declared.channels
      ?? (this.#source === undefined
        ? DEFAULT_SOURCE_CHANNELS
        : this.#source.channels.map((channel) => channel.split(':').slice(0, 2).join(':')))
    const entry: RegisteredTool = {
      definition: tool,
      channels: [...channels],
      ownerOnly: declared.audience === 'owner',
    }
    this.#tools.set(full, entry)
    return () => {
      if (this.#tools.get(full) === entry) this.#tools.delete(full)
    }
  }

  #isOwnerChannel(channel: string): boolean {
    return this.#ownerChannels.has(channel)
  }

  #provide(provider: ChannelProvider): Disposable {
    this.#record('channel.provide', [provider])
    this.#need('channel.provide')
    if (this.#providers.length > 0) throw new BrainError('CONFLICT', 'a provider is already registered')
    this.#providers.push(provider)
    return () => {
      const index = this.#providers.indexOf(provider)
      if (index !== -1) this.#providers.splice(index, 1)
    }
  }

  async #send(channel: string, message: OutboundMessage): Promise<{ readonly messageId?: string }> {
    this.#record('channel.send', [channel, message])
    this.#need('channel.send')
    this.#own(channel)
    const provider = this.#providers[0]
    if (provider === undefined) throw new BrainError('UNAVAILABLE', 'no provider for this channel')
    return provider.send(channel, message)
  }

  async #resolveIdentity(account: string): Promise<string> {
    this.#record('identity.resolve', [account])
    this.#need('identity.link')
    this.#assertAccount(account)
    return this.#identityLinks.get(account) ?? account
  }

  async #linkIdentity(account: string, personId: string): Promise<void> {
    this.#record('identity.link', [account, personId])
    this.#need('identity.link')
    this.#assertAccount(account)
    this.#identityLinks.set(account, personId)
  }

  #assertAccount(account: string): void {
    if (typeof account !== 'string' || !account.startsWith(`${this.#id}:`)) {
      throw denied(`account must start with ${this.#id}:`)
    }
  }

  #every(ms: number, run: () => Promise<void> | void): Disposable {
    this.#record('scheduler.every', [ms])
    this.#alive()
    if (!Number.isFinite(ms) || ms < MIN_INTERVAL_MS) {
      throw invalidArgument(`every interval must be at least ${MIN_INTERVAL_MS} ms`)
    }
    return this.#addTask({ kind: 'every', run, nextAt: this.#now + ms, intervalMs: ms })
  }

  #at(timeMs: number, run: () => Promise<void> | void): Disposable {
    this.#record('scheduler.at', [timeMs])
    this.#alive()
    if (!Number.isFinite(timeMs)) throw invalidArgument('at time must be a finite epoch millisecond')
    return this.#addTask({ kind: 'at', run, nextAt: timeMs })
  }

  #ownTime(request: OwnTimeRequest): Disposable {
    this.#record('scheduler.ownTime', [request])
    this.#need('schedule.ownTime')
    const candidate = request as unknown as { readonly name?: unknown; readonly everyMs?: unknown; readonly run?: unknown }
    if (candidate === null || candidate === undefined || typeof candidate !== 'object') {
      throw invalidArgument('ownTime takes an object with name, everyMs and run')
    }
    if (typeof candidate.name !== 'string' || !OWN_TIME_NAME.test(candidate.name)) {
      throw invalidArgument('ownTime name must match ^[a-z0-9_-]{1,32}$')
    }
    if (typeof candidate.everyMs !== 'number' || !Number.isFinite(candidate.everyMs) || candidate.everyMs < MIN_INTERVAL_MS) {
      throw invalidArgument(`ownTime interval must be at least ${MIN_INTERVAL_MS} ms`)
    }
    if (typeof candidate.run !== 'function') throw invalidArgument('ownTime run must be a function')
    for (const task of this.#tasks.values()) {
      if (task.kind === 'ownTime' && task.name === candidate.name) {
        throw new BrainError('CONFLICT', `ownTime ${this.#id}/${candidate.name} is already registered`)
      }
    }
    return this.#addTask({
      kind: 'ownTime',
      run: candidate.run as () => Promise<void> | void,
      nextAt: 0,
      intervalMs: candidate.everyMs,
      name: candidate.name,
    })
  }

  #addTask(task: Omit<Task, 'id'>): Disposable {
    this.#nextTask += 1
    const id = `task:${this.#nextTask}`
    const stored: Task = { id, ...task }
    this.#tasks.set(id, stored)
    return () => {
      this.#tasks.delete(id)
    }
  }

  #on(name: string, handler: Handler): Disposable {
    this.#record('events.on', [name])
    this.#alive()
    if (typeof name !== 'string') throw invalidArgument('an event name must be a string')
    const set = this.#listeners.get(name) ?? new Set<Handler>()
    this.#listeners.set(name, set)
    set.add(handler)
    return () => {
      set.delete(handler)
    }
  }

  #emit(name: string, payload: Readonly<Record<string, unknown>>): void {
    this.#record('events.emit', [name, payload])
    this.#alive()
    if (typeof name !== 'string' || !name.startsWith(`${this.#id}.`)) {
      throw denied(`event names must start with ${this.#id}.`)
    }
    this.#dispatch(name, payload)
  }

  #route(method: string, routePath: string, handler: (request: PluginRequest) => Promise<unknown>): Disposable {
    this.#record('http.route', [method, routePath])
    this.#alive()
    if (typeof routePath !== 'string' || !routePath.startsWith('/')) {
      throw invalidArgument('a route path starts with /')
    }
    const key = `${String(method).toUpperCase()} ${routePath}`
    if (this.#routes.has(key)) throw new BrainError('CONFLICT', `route ${key} is already registered`)
    const entry: RouteEntry = { handler }
    this.#routes.set(key, entry)
    return () => {
      if (this.#routes.get(key) === entry) this.#routes.delete(key)
    }
  }

  #page(descriptor: { readonly id: string; readonly title: string; readonly entry: string }): Disposable {
    this.#record('console.page', [descriptor])
    this.#alive()
    if (this.#pages.has(descriptor.id)) throw new BrainError('CONFLICT', `page ${descriptor.id} is already registered`)
    this.#pages.set(descriptor.id, descriptor)
    return () => {
      this.#pages.delete(descriptor.id)
    }
  }

  async #getSecret(name: string): Promise<string | undefined> {
    this.#record('secrets.get', [name])
    this.#need(`secrets:${name}`)
    return this.#secrets.get(name)
  }

  async #storageRead(relative: string): Promise<Uint8Array | undefined> {
    this.#record('storage.read', [relative])
    this.#alive()
    const file = this.#storage.get(this.#storagePath(relative))
    return file === undefined ? undefined : new Uint8Array(file)
  }

  async #storageWrite(relative: string, data: string | Uint8Array): Promise<void> {
    this.#record('storage.write', [relative, data])
    this.#alive()
    const file = this.#storagePath(relative)
    this.#storage.set(file, typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data))
  }

  async #storageRemove(relative: string): Promise<void> {
    this.#record('storage.remove', [relative])
    this.#alive()
    this.#storage.delete(this.#storagePath(relative))
  }

  async #storageList(prefix?: string): Promise<readonly string[]> {
    this.#record('storage.list', [prefix])
    this.#alive()
    const normalized = prefix === undefined || prefix === '' ? '' : this.#storagePath(prefix)
    return [...this.#storage.keys()].filter((file) => file.startsWith(normalized)).sort()
  }

  async loadPlugin(plugin: { readonly apply: PluginApply }, manifestJson: unknown, options: LoadOptions = {}): Promise<void> {
    if (this.#loaded) throw new BrainError('CONFLICT', 'a plugin is already loaded')
    const result = validateManifest(manifestJson)
    if (!result.ok) {
      throw new BrainError('INVALID_ARGUMENT', 'invalid manifest', { errors: result.errors })
    }
    const manifest = result.manifest
    const allowed = new Set(manifest.permissions)
    this.#manifest = manifest
    this.#granted = new Set(options.granted === undefined
      ? manifest.permissions
      : options.granted.filter((permission) => allowed.has(permission)))
    this.#config = options.config ?? {}
    this.#writes = []
    this.#ctx = this.#buildContext()
    // The context is usable while apply runs, exactly like the real runtime.
    this.#loaded = true
    try {
      await plugin.apply(this.#ctx, this.#config)
    } catch (error) {
      this.#loaded = false
      this.#clearRegistrations()
      throw error
    }
  }

  async unload(): Promise<void> {
    if (!this.#loaded) return
    this.#loaded = false
    this.#clearRegistrations()
  }

  #clearRegistrations(): void {
    this.#tools.clear()
    this.#activeCalls.clear()
    this.#routes.clear()
    this.#tasks.clear()
    this.#listeners.clear()
    this.#providers.splice(0, this.#providers.length)
    this.#memoryProviders.splice(0, this.#memoryProviders.length)
    this.#pages.clear()
    this.#webSockets.clear()
  }

  deliver<K extends keyof BrainEvents>(name: K, payload: BrainEvents[K]): void {
    this.#dispatch(name, payload)
  }

  async http(method: string, requestPath: string, body?: unknown): Promise<Envelope<unknown>> {
    this.#nextRequest += 1
    const meta = { requestId: `req_${this.#nextRequest}` }
    let parsed: URL
    try {
      parsed = new URL(requestPath, 'http://localhost')
    } catch {
      return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'invalid path', details: {} }, meta }
    }
    const prefix = `/api/v1/plugins/${this.#id}`
    if (parsed.pathname !== prefix && !parsed.pathname.startsWith(`${prefix}/`)) {
      return { ok: false, error: { code: 'NOT_FOUND', message: 'not found', details: {} }, meta }
    }
    const subPath = parsed.pathname.slice(prefix.length) === '' ? '/' : parsed.pathname.slice(prefix.length)
    const key = `${method.toUpperCase()} ${subPath}`
    const route = this.#routes.get(key)
    if (route === undefined) {
      return { ok: false, error: { code: 'NOT_FOUND', message: 'not found', details: {} }, meta }
    }
    const query: Record<string, string> = {}
    for (const [name, value] of parsed.searchParams.entries()) query[name] = value
    const request: PluginRequest = { method: method.toUpperCase(), path: subPath, query, body }
    try {
      return { ok: true, data: await route.handler(request), meta }
    } catch (error) {
      if (error instanceof BrainError) {
        return {
          ok: false,
          error: { code: error.code, message: error.message, details: error.details },
          meta,
        }
      }
      return {
        ok: false,
        error: { code: 'INTERNAL', message: error instanceof Error ? error.message : 'internal error', details: {} },
        meta,
      }
    }
  }

  async callTool(
    name: string,
    args: Readonly<Record<string, unknown>> = {},
    options: { readonly channel?: string; readonly wakeId?: string } = {},
  ): Promise<ToolOutput> {
    this.#alive()
    const entry = this.#tools.get(name)
    if (entry === undefined) throw new BrainError('NOT_FOUND', `tool ${name} is not registered`)
    // The real kernel only calls a tool inside a woke channel, so owner tools never run channel-less.
    if (entry.ownerOnly && options.channel === undefined) {
      throw denied(`tool ${name} is only for owner channels`)
    }
    if (options.channel !== undefined) {
      if (!toolChannelMatches(entry.channels, options.channel)) {
        throw denied(`tool ${name} does not apply to channel ${options.channel}`)
      }
      if (entry.ownerOnly && !this.#isOwnerChannel(options.channel)) {
        throw denied(`tool ${name} is only for owner channels`)
      }
    }
    const channel = options.channel ?? ''
    const wakeId = options.wakeId ?? 'wake_1'
    this.#nextCall += 1
    const callToken = `call_${this.#nextCall}`
    this.#activeCalls.set(callToken, { channel, wakeId })
    try {
      return await entry.definition.handler(args, { channel, wakeId, callToken })
    } finally {
      this.#activeCalls.delete(callToken)
    }
  }

  tools(): readonly string[] {
    return [...this.#tools.keys()].sort()
  }

  routes(): readonly string[] {
    return [...this.#routes.keys()].sort()
  }

  timers(): number {
    return this.#tasks.size
  }

  records(): readonly MemoryRecord[] {
    return [...this.#records.values()].map(clone)
  }

  async advance(ms: number): Promise<void> {
    this.#now += ms
    const due = [...this.#tasks.values()]
      .filter((task) => task.nextAt <= this.#now)
      .sort((left, right) => left.nextAt - right.nextAt)
    const pending: Promise<void>[] = []
    for (const task of due) {
      if (!this.#tasks.has(task.id)) continue
      if (task.kind === 'at') this.#tasks.delete(task.id)
      else task.nextAt = this.#now + (task.intervalMs as number)
      pending.push(this.#runTask(task))
    }
    await Promise.allSettled(pending)
  }

  useAgent(script: FakeAgentScript): void {
    this.#agentScript = script
  }

  useLlm(handler: (request: { readonly system: string; readonly user: string; readonly maxOutputTokens: number }) => Promise<{ readonly text: string; readonly tokens: number }> | { readonly text: string; readonly tokens: number }): void {
    this.#llmHandler = handler
  }

  memoryProviders(): readonly MemoryProvider[] {
    return [...this.#memoryProviders]
  }

  setSecret(name: string, value: string): void {
    this.#secrets.set(name, value)
  }

  setResponse(
    url: string,
    response: { readonly status: number; readonly body: string; readonly headers?: Readonly<Record<string, string>> },
  ): void {
    this.#responses.set(url, response)
  }

  webSockets(): readonly { readonly configKey: string; readonly url: string }[] {
    return [...this.#webSockets].map((sub) => ({ configKey: sub.configKey, url: sub.url }))
  }

  async emitWebSocket(configKey: string, event: WebSocketEvent): Promise<void> {
    const matches = [...this.#webSockets].filter((sub) => sub.configKey === configKey)
    for (const sub of matches) {
      try {
        await sub.listener(event)
      } catch {
        // listener failure must not affect other subscribers
      }
    }
  }
}

/** A kernel-shaped stand-in for offline plugin tests. Never touches the network, the disk or a model. */
export function createTestKernel(
  options: { readonly now?: number; readonly ownerChannels?: readonly string[] } = {},
): TestKernel {
  return new FakeKernel(options.now ?? 0, new Set(options.ownerChannels ?? []))
}

