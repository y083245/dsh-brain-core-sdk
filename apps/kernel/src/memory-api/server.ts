import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  BrainError, ERROR_CODES, LAYERS, LIMITS, validate,
  type ContextRequest, type Envelope, type EvidenceRef, type ForgetSelector, type IngestEvent, type Layer,
  type ManifestTool, type Meta, type PluginKind, type PluginRequest, type RecordInput, type RecordPatch,
  type SearchRequest, type Viewer,
} from '@dsh-brain-core/sdk'
import type { AgentClass, ModelSelection, RunnerStatus } from '@dsh-brain-core/satellite-host'
import type { CheckReport } from '@dsh-brain-core/testkit'
import { createUlid } from '@dsh-brain-core/shared'
import type {
  AccountingSummary, ConsolidationApproveOptions, ConsolidationProposal, CrossChannelMode, DebugViewStatus,
  ModelPriceBook, ReadOnlyMcpStatus, RecordFilter, RuntimeSettings, WorkingMemoryInput, WriteIdentity,
} from '../contracts/index.ts'
import type { Logger } from '../log/index.ts'
import type { AuditEntry } from './audit.ts'
import type { Memory } from './open.ts'

export interface InteropStatus {
  readonly ampAliases: boolean
  readonly mcp: ReadOnlyMcpStatus
  readonly debugView: DebugViewStatus
}

export type PluginLifecycleState = 'discovered' | 'pending' | 'enabled' | 'disabled' | 'failed'

export interface ConsolePluginUpdateInfo {
  readonly version: string
  readonly sha8: string
  readonly permissions: readonly string[]
  readonly newPermissions: readonly string[]
  readonly warnings: readonly string[]
}

export interface ConsolePluginItem {
  readonly id: string
  readonly version: string
  readonly kinds: readonly PluginKind[]
  readonly runtime: 'node' | 'process'
  readonly state: PluginLifecycleState
  readonly permissions: readonly string[]
  readonly granted: readonly string[]
  readonly checkPassed: boolean
  readonly tools: readonly ManifestTool[]
  readonly source?: 'workspace' | 'installed'
  readonly warnings?: readonly string[]
  readonly updateAvailable?: ConsolePluginUpdateInfo
}

export interface ConsoleInstallPreview {
  readonly id: string
  readonly version: string
  readonly permissions: readonly string[]
  readonly newPermissions: readonly string[]
  readonly warnings: readonly string[]
}

export interface ConsoleLocalApplyResult extends ConsoleInstallPreview {
  readonly applied: boolean
  readonly state: PluginLifecycleState
}

export interface ChannelCoreBudget {
  readonly pattern: string
  readonly count: number
  readonly tokens: number
  readonly over: boolean
}

export interface ConsolePersonSummary {
  readonly personId: string
  readonly accounts: readonly string[]
  readonly aliases: readonly string[]
}

export interface ConsoleAgentProcessStatus {
  readonly agentClass: AgentClass
  readonly status: RunnerStatus
  readonly pid?: number
  readonly activeSessions: number
  readonly selection: ModelSelection | null
  readonly lastError?: string
  readonly deniedApprovals: number
}

export interface ConsoleSessionSurfaceInfo {
  readonly sessionId: string
  readonly channel: string
  readonly agentClass: AgentClass
  readonly toolCount: number
}

export interface ConsoleIsolationDoctorStatus {
  readonly ok: boolean
  readonly checkedAt: number
  readonly problems: readonly string[]
}

export interface ConsoleWakeMetricSample {
  readonly wakeId: string
  readonly channel: string
  readonly agentClass: AgentClass
  readonly profileVersion: number
  readonly arrivedAt: number
  readonly firstSendAt?: number
  readonly debounceMs: number
  readonly steps: readonly {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheReadTokens: number
    readonly cacheWriteTokens: number
  }[]
  readonly retries: number
  readonly outcome: 'acked' | 'interrupted' | 'unavailable'
}

export interface ConsoleSatelliteSnapshot {
  readonly processes: Readonly<Record<AgentClass, ConsoleAgentProcessStatus>>
  readonly sessions: readonly ConsoleSessionSurfaceInfo[]
  readonly isolation: ConsoleIsolationDoctorStatus
  readonly metrics: readonly ConsoleWakeMetricSample[]
  readonly sharedQuotaWarning: boolean
}

export interface ConsolePageItem {
  readonly pluginId: string
  readonly id: string
  readonly title: string
  readonly entry: string
}

export interface MemoryApiConsoleDeps {
  readonly accounting?: {
    summary(days?: number): Promise<AccountingSummary>
    prices(): Promise<ModelPriceBook>
    setPrices(next: ModelPriceBook): Promise<ModelPriceBook>
    setBudget(budget: NonNullable<RuntimeSettings['accounting']>): Promise<NonNullable<RuntimeSettings['accounting']>>
  }
  readonly interop?: {
    snapshot(): Promise<InteropStatus>
    setAmpAliases(enabled: boolean): Promise<InteropStatus>
    setReadOnlyMcp(enabled: boolean): Promise<InteropStatus>
    startDebugView(): Promise<InteropStatus>
    stopDebugView(): Promise<InteropStatus>
  }
  readonly plugins?: {
    list(): Promise<{ readonly plugins: readonly ConsolePluginItem[]; readonly coreBudgets: readonly ChannelCoreBudget[] }>
    scan?(): Promise<{ readonly plugins: readonly ConsolePluginItem[]; readonly coreBudgets: readonly ChannelCoreBudget[] }>
    install(spec: string): Promise<ConsoleInstallPreview>
    confirm(id: string): Promise<void>
    enable(id: string): Promise<void>
    disable(id: string): Promise<void>
    upgrade(id: string, spec: string): Promise<ConsoleInstallPreview & { readonly applied: boolean }>
    applyLocal?(
      id: string,
      input: { readonly action: 'enable' | 'update'; readonly confirmPermissions?: boolean },
    ): Promise<ConsoleLocalApplyResult>
    uninstall(id: string, options: { readonly keepData: boolean }): Promise<void>
    check(dir: string): Promise<CheckReport>
  }
  readonly memoryConsole?: {
    readonly crossChannel?: {
      getMode(): CrossChannelMode | Promise<CrossChannelMode>
      setMode(mode: CrossChannelMode): void | Promise<void>
    }
    readonly automation?: {
      get(): ConsoleMemoryAutomation
      set(enabled: boolean): Promise<ConsoleMemoryAutomation>
    }
    readonly audit?: (recordId?: string) => Promise<readonly AuditEntry[]>
    readonly persons?: {
      list(): Promise<readonly ConsolePersonSummary[]>
      merge(from: string, into: string): Promise<void>
      split(personId: string, accounts: readonly string[]): Promise<string>
    }
  }
  readonly satellite?: {
    snapshot(): Promise<ConsoleSatelliteSnapshot>
    restart(agentClass: AgentClass): Promise<void> | void
    runDoctor(): Promise<ConsoleIsolationDoctorStatus>
  }
  readonly pages?: {
    list(): readonly ConsolePageItem[]
  }
}

interface ConsoleMemoryAutomation {
  readonly enabled: boolean
  readonly activityConfigured: boolean
  readonly modelKeyConfigured: boolean
}

/** S2 has no plugins yet, so every HTTP caller is the owner console (RFC P1). */
const OWNER_VIEWER: Viewer = { caller: 'owner-console', channel: null, participants: [] }
const OWNER_IDENTITY: WriteIdentity = {
  kind: 'kernel',
  source: 'owner-console',
  trust: 'owner',
  defaultVisibility: 'owner',
}

const PREFIX = '/api/v1'
const RECORD_PATH = /^\/memory\/records\/(.+)$/
const JOB_PATH = /^\/memory\/jobs\/(.+)$/
const PROPOSAL_APPROVE_PATH = /^\/console\/memory\/consolidation\/proposals\/([^/]+)\/approve$/
const PROPOSAL_REJECT_PATH = /^\/console\/memory\/consolidation\/proposals\/([^/]+)\/reject$/
const WORKING_ITEM_PATH = /^\/memory\/working\/([^/]+)$/
const PLUGIN_APPLY_LOCAL_PATH = /^\/console\/plugins\/([^/]+)\/apply-local$/
const PLUGIN_ACTION_PATH = /^\/console\/plugins\/([^/]+)\/(confirm|enable|disable|upgrade|uninstall)$/
const CONSOLE_RECORD_PATH = /^\/console\/memory\/records\/([^/]+)$/
const CONSOLE_RECORD_DEPENDENTS_PATH = /^\/console\/memory\/records\/([^/]+)\/dependents$/
const PERSON_SPLIT_PATH = /^\/console\/memory\/persons\/([^/]+)\/split$/
const SATELLITE_RESTART_PATH = /^\/console\/satellite\/([^/]+)\/restart$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decodeSegment(raw: string, label: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    throw new BrainError('INVALID_ARGUMENT', `invalid ${label}`)
  }
}

function requireSegment(raw: string, label: string): string {
  const decoded = decodeSegment(raw, label)
  if (decoded.trim() === '') {
    throw new BrainError('INVALID_ARGUMENT', `invalid ${label}`)
  }
  return decoded
}

function requireStringField(body: unknown, field: string): string {
  if (!isPlainObject(body)) {
    throw new BrainError('INVALID_ARGUMENT', 'request body must be an object')
  }
  const value = body[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BrainError('INVALID_ARGUMENT', `${field} must be a non-empty string`)
  }
  return value
}

function parseQueryInt(raw: string | null, name: string): number {
  if (raw === null || !/^-?[0-9]+$/.test(raw)) {
    throw new BrainError('INVALID_ARGUMENT', `${name} must be an integer`)
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) {
    throw new BrainError('INVALID_ARGUMENT', `${name} must be a safe integer`)
  }
  return value
}

function parseEvidenceRefs(raw: unknown, field: string): readonly EvidenceRef[] {
  if (!Array.isArray(raw)) {
    throw new BrainError('INVALID_ARGUMENT', `${field} must be an array`)
  }
  const refs: EvidenceRef[] = []
  for (const item of raw) {
    if (!isPlainObject(item) || typeof item.id !== 'string' || item.id.trim() === '') {
      throw new BrainError('INVALID_ARGUMENT', `${field} entries must have non-empty string id`)
    }
    refs.push({ id: item.id })
  }
  return refs
}

function parseNonNegSafeInt(value: unknown, field: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isSafeInteger(value) || value < min) {
    throw new BrainError('INVALID_ARGUMENT', `${field} must be an integer >= ${String(min)}`)
  }
  return value
}

function parseAccountingBudget(body: unknown): NonNullable<RuntimeSettings['accounting']> {
  if (!isPlainObject(body)) {
    throw new BrainError('INVALID_ARGUMENT', 'budget body must be an object')
  }
  const result: {
    dailyTokenLimit?: number
    dailyCostMicrosLimit?: number
    pluginDailyTokenLimit?: number
    pluginLimits?: Record<string, { readonly dailyTokenLimit?: number; readonly dailyCallsLimit?: number; readonly maxOutputTokens?: number }>
  } = {}
  if (body.dailyTokenLimit !== undefined) {
    result.dailyTokenLimit = parseNonNegSafeInt(body.dailyTokenLimit, 'dailyTokenLimit')
  }
  if (body.dailyCostMicrosLimit !== undefined) {
    result.dailyCostMicrosLimit = parseNonNegSafeInt(body.dailyCostMicrosLimit, 'dailyCostMicrosLimit')
  }
  if (body.pluginDailyTokenLimit !== undefined) {
    result.pluginDailyTokenLimit = parseNonNegSafeInt(body.pluginDailyTokenLimit, 'pluginDailyTokenLimit')
  }
  if (body.pluginLimits !== undefined) {
    if (!isPlainObject(body.pluginLimits)) {
      throw new BrainError('INVALID_ARGUMENT', 'pluginLimits must be an object')
    }
    const limits: Record<string, { readonly dailyTokenLimit?: number; readonly dailyCallsLimit?: number; readonly maxOutputTokens?: number }> = {}
    for (const [pluginId, rawEntry] of Object.entries(body.pluginLimits)) {
      if (pluginId.trim() === '' || pluginId === '__proto__' || pluginId === 'constructor' || pluginId === 'prototype') {
        throw new BrainError('INVALID_ARGUMENT', 'invalid pluginLimits key')
      }
      if (!isPlainObject(rawEntry)) {
        throw new BrainError('INVALID_ARGUMENT', `pluginLimits[${pluginId}] must be an object`)
      }
      limits[pluginId] = {
        ...(rawEntry.dailyTokenLimit === undefined
          ? {}
          : { dailyTokenLimit: parseNonNegSafeInt(rawEntry.dailyTokenLimit, `pluginLimits[${pluginId}].dailyTokenLimit`) }),
        ...(rawEntry.dailyCallsLimit === undefined
          ? {}
          : { dailyCallsLimit: parseNonNegSafeInt(rawEntry.dailyCallsLimit, `pluginLimits[${pluginId}].dailyCallsLimit`) }),
        ...(rawEntry.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: parseNonNegSafeInt(rawEntry.maxOutputTokens, `pluginLimits[${pluginId}].maxOutputTokens`, 1) }),
      }
    }
    result.pluginLimits = limits
  }
  return result
}

function parseEnabledBody(body: unknown): boolean {
  if (!isPlainObject(body) || typeof body.enabled !== 'boolean') {
    throw new BrainError('INVALID_ARGUMENT', 'enabled must be a boolean')
  }
  return body.enabled
}

function parseConsoleSearchBody(body: unknown): { readonly request: SearchRequest; readonly viewer: Viewer } {
  if (!isPlainObject(body)) {
    throw new BrainError('INVALID_ARGUMENT', 'search body must be an object')
  }
  let channel: string | null = null
  if (body.channel !== undefined) {
    if (typeof body.channel !== 'string' || body.channel.trim() === '') {
      throw new BrainError('INVALID_ARGUMENT', 'channel must be a non-empty string')
    }
    channel = body.channel.trim()
  }
  let participants: readonly string[] = []
  if (body.participants !== undefined) {
    if (
      !Array.isArray(body.participants)
      || body.participants.length > LIMITS.subjects
      || !body.participants.every((item) => typeof item === 'string' && item.trim() !== '')
    ) {
      throw new BrainError(
        'INVALID_ARGUMENT',
        `participants must be an array of at most ${String(LIMITS.subjects)} non-empty strings`,
      )
    }
    participants = body.participants.map((item: string) => item.trim())
  }
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new BrainError('INVALID_ARGUMENT', 'invalid search field')
    }
    if (key === 'channel' || key === 'participants' || key === 'viewer' || key === 'caller') continue
    rest[key] = value
  }
  return {
    request: rest as unknown as SearchRequest,
    viewer: {
      caller: 'owner-console',
      channel,
      participants,
    },
  }
}

function toProposalView(proposal: ConsolidationProposal) {
  return {
    ...proposal,
    l2Candidates: proposal.l2Candidates.map((candidate) => ({
      ...candidate,
      evidenceIds: candidate.evidence.map((ref) => ref.id),
    })),
  }
}

export interface MemoryApiServer {
  listen(): Promise<{ readonly port: number }>
  close(): Promise<void>
  /** For tests: the exact address `node:http` bound to. */
  address(): AddressInfo | string | null
}

function sha256(text: string): Buffer {
  return createHash('sha256').update(text).digest()
}

/** Constant time even when the lengths differ: both sides are compared as fixed-length digests. */
function authorized(header: string | undefined, token: string): boolean {
  if (typeof header !== 'string') return false
  const prefix = 'Bearer '
  if (!header.startsWith(prefix)) return false
  return timingSafeEqual(sha256(header.slice(prefix.length)), sha256(token))
}

function parseIfMatch(value: string | string[] | undefined): number {
  const text = Array.isArray(value) ? value[0] : value
  if (typeof text !== 'string' || !/^[1-9][0-9]*$/.test(text)) {
    throw new BrainError('INVALID_ARGUMENT', 'If-Match must be a positive integer version')
  }
  const version = Number(text)
  if (!Number.isSafeInteger(version)) throw new BrainError('INVALID_ARGUMENT', 'If-Match must be a positive integer version')
  return version
}

export function createMemoryApiServer(memory: Memory, options: {
  readonly token: string
  readonly port: number
  readonly log: Logger
  /** Plugin HTTP routes, mounted under `/api/v1/plugins/<id>/…` behind the same token and envelope. */
  readonly pluginRoute?: (pluginId: string, request: PluginRequest) => Promise<unknown>
  /** Console endpoints for model accounting and external interop. */
  readonly console?: MemoryApiConsoleDeps
}): MemoryApiServer {
  const nextRequestId = createUlid()

  async function readJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []
    let total = 0
    let tooLarge = false
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      total += buffer.length
      if (total > LIMITS.requestBytes) {
        // Keep draining so the client can read the 413 instead of seeing a reset.
        tooLarge = true
        chunks.length = 0
      } else if (!tooLarge) {
        chunks.push(buffer)
      }
    }
    if (tooLarge) throw new BrainError('PAYLOAD_TOO_LARGE', 'request body is too large')
    if (total === 0) return undefined
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    } catch {
      throw new BrainError('INVALID_ARGUMENT', 'request body is not valid JSON')
    }
  }

  function send(res: ServerResponse, status: number, body: unknown): void {
    if (res.headersSent) return
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
    })
    res.end(text)
  }

  function okEnvelope<T>(requestId: string, data: T, extra: Partial<Meta> = {}): Envelope<T> {
    const meta: Meta = { requestId, apiVersion: '1.0', ...extra }
    return { ok: true, data, meta }
  }

  function errorEnvelope(requestId: string, error: BrainError): Envelope<never> {
    return {
      ok: false,
      error: { code: error.code, message: error.message, details: error.details },
      meta: { requestId },
    }
  }

  async function route(requestId: string, req: IncomingMessage, body: unknown): Promise<{ status: number; payload: unknown }> {
    const method = req.method ?? 'GET'
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const pathname = url.pathname
    if (!pathname.startsWith(PREFIX)) throw new BrainError('NOT_FOUND', 'not found')
    const tail = pathname.slice(PREFIX.length)

    const respond = <T>(data: T, extra: Partial<Meta> = {}): { status: number; payload: unknown } => ({
      status: 200,
      payload: okEnvelope(requestId, data, extra),
    })

    const pluginMatch = /^\/plugins\/([^/]+)(\/.*)?$/.exec(tail)
    if (pluginMatch !== null) {
      if (options.pluginRoute === undefined) throw new BrainError('NOT_FOUND', 'not found')
      let pluginId: string
      try {
        pluginId = decodeURIComponent(pluginMatch[1] as string)
      } catch {
        throw new BrainError('INVALID_ARGUMENT', 'invalid plugin id')
      }
      const request: PluginRequest = {
        method,
        path: pluginMatch[2] ?? '/',
        query: Object.fromEntries(url.searchParams),
        body,
      }
      return respond(await options.pluginRoute(pluginId, request))
    }

    if (method === 'POST' && tail === '/memory/events') {
      const result = await memory.service.ingest(body as IngestEvent, OWNER_IDENTITY)
      return { status: 202, payload: okEnvelope(requestId, result) }
    }
    if (method === 'POST' && tail === '/memory/records') {
      return respond(await memory.service.record(body as RecordInput, OWNER_IDENTITY))
    }

    const recordMatch = RECORD_PATH.exec(tail)
    if (recordMatch !== null) {
      let id: string
      try {
        id = decodeURIComponent(recordMatch[1] as string)
      } catch {
        throw new BrainError('INVALID_ARGUMENT', 'invalid record id')
      }
      if (method === 'PATCH') {
        const version = parseIfMatch(req.headers['if-match'])
        return respond(await memory.service.update(id, body as RecordPatch, version, OWNER_IDENTITY, OWNER_VIEWER))
      }
      if (method === 'DELETE') {
        await memory.service.remove(id, OWNER_IDENTITY, OWNER_VIEWER)
        return respond({})
      }
      throw new BrainError('NOT_FOUND', 'not found')
    }

    if (method === 'POST' && tail === '/memory/search') {
      const result = await memory.service.search(body as SearchRequest, OWNER_VIEWER)
      return respond(
        { items: result.items },
        { degraded: result.degraded, ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }) },
      )
    }
    if (method === 'POST' && tail === '/memory/context') {
      // Validate before reading `channel`: an empty or non-object body must be 400, not a TypeError.
      validate('ContextRequest', body)
      const request = body as ContextRequest
      const viewer: Viewer = { ...OWNER_VIEWER, channel: request.channel }
      return respond(await memory.service.context(request, viewer))
    }
    if (method === 'POST' && tail === '/memory/forget') {
      return respond(await memory.service.forget(body as ForgetSelector))
    }
    if (method === 'POST' && tail === '/memory/jobs') {
      return respond(memory.jobs.start(body))
    }

    const jobMatch = JOB_PATH.exec(tail)
    if (method === 'GET' && jobMatch !== null) {
      let id: string
      try {
        id = decodeURIComponent(jobMatch[1] as string)
      } catch {
        throw new BrainError('INVALID_ARGUMENT', 'invalid job id')
      }
      return respond(memory.jobs.get(id))
    }
    if (method === 'GET' && tail === '/memory/health') {
      return respond(await memory.service.health())
    }

    if (method === 'GET' && tail === '/console/memory/l3/versions') {
      const list = await memory.profiles.list()
      const items = await Promise.all(
        list.map(async (item) => {
          const detail = await memory.profiles.getVersion(item.version)
          return {
            ...item,
            stable: detail.stable,
            data: detail.data,
          }
        }),
      )
      return respond({ items })
    }

    if (method === 'GET' && tail === '/console/memory/l3/diff') {
      const from = parseQueryInt(url.searchParams.get('from'), 'from')
      const to = parseQueryInt(url.searchParams.get('to'), 'to')
      return respond(await memory.profiles.diff(from, to))
    }

    if (method === 'POST' && tail === '/console/memory/l3/rollback') {
      if (!isPlainObject(body) || typeof body.version !== 'number' || !Number.isSafeInteger(body.version)) {
        throw new BrainError('INVALID_ARGUMENT', 'rollback requires an integer version')
      }
      const version = await memory.profiles.rollback(body.version)
      return respond({ version })
    }

    if (method === 'PUT' && tail === '/console/memory/l3/owner') {
      if (!isPlainObject(body) || !isPlainObject(body.data)) {
        throw new BrainError('INVALID_ARGUMENT', 'owner edit requires an object with data')
      }
      if (body.stable !== undefined && typeof body.stable !== 'string') {
        throw new BrainError('INVALID_ARGUMENT', 'stable must be a string')
      }
      if (
        body.lockedKeys !== undefined
        && (!Array.isArray(body.lockedKeys) || !body.lockedKeys.every((item) => typeof item === 'string'))
      ) {
        throw new BrainError('INVALID_ARGUMENT', 'lockedKeys must be an array of strings')
      }
      const evidence = body.evidence === undefined ? undefined : parseEvidenceRefs(body.evidence, 'evidence')
      const version = await memory.profiles.editByOwner({
        ...(body.stable === undefined ? {} : { stable: body.stable }),
        data: body.data,
        ...(body.lockedKeys === undefined ? {} : { lockedKeys: body.lockedKeys }),
        ...(evidence === undefined ? {} : { evidence }),
      })
      return respond({ version })
    }

    if (method === 'GET' && tail === '/console/memory/consolidation/proposals') {
      const statusParam = url.searchParams.get('status')
      if (statusParam !== null && statusParam !== 'pending' && statusParam !== 'approved' && statusParam !== 'rejected') {
        throw new BrainError('INVALID_ARGUMENT', 'status must be pending, approved or rejected')
      }
      if (memory.consolidation === undefined) {
        return respond({ items: [] })
      }
      const status = statusParam ?? undefined
      const proposals = await memory.consolidation.listProposals(status)
      return respond({ items: proposals.map(toProposalView) })
    }

    if (method === 'GET' && tail === '/console/memory/consolidation/budget') {
      if (memory.consolidation === undefined) {
        return respond({ usedTokensToday: 0, dailyTokenCap: 0, lastConsolidatedTo: 0 })
      }
      return respond(await memory.consolidation.budgetStatus())
    }

    if (method === 'POST' && tail === '/console/memory/consolidation/run') {
      if (memory.consolidation === undefined) {
        throw new BrainError('UNAVAILABLE', 'consolidation is not available')
      }
      let runOptions: { readonly from?: number; readonly to?: number; readonly force?: boolean } | undefined
      if (body !== undefined) {
        if (!isPlainObject(body)) {
          throw new BrainError('INVALID_ARGUMENT', 'consolidation run body must be an object')
        }
        if (body.from !== undefined && (typeof body.from !== 'number' || !Number.isFinite(body.from))) {
          throw new BrainError('INVALID_ARGUMENT', 'from must be a finite number')
        }
        if (body.to !== undefined && (typeof body.to !== 'number' || !Number.isFinite(body.to))) {
          throw new BrainError('INVALID_ARGUMENT', 'to must be a finite number')
        }
        if (body.force !== undefined && typeof body.force !== 'boolean') {
          throw new BrainError('INVALID_ARGUMENT', 'force must be a boolean')
        }
        runOptions = {
          ...(body.from === undefined ? {} : { from: body.from }),
          ...(body.to === undefined ? {} : { to: body.to }),
          ...(body.force === undefined ? {} : { force: body.force }),
        }
      }
      const proposal = await memory.consolidation.runShadow(runOptions)
      return respond(toProposalView(proposal))
    }

    const approveMatch = PROPOSAL_APPROVE_PATH.exec(tail)
    if (method === 'POST' && approveMatch !== null) {
      if (memory.consolidation === undefined) {
        throw new BrainError('UNAVAILABLE', 'consolidation is not available')
      }
      const id = decodeSegment(approveMatch[1] as string, 'proposal id')
      let approveOptions: ConsolidationApproveOptions | undefined
      if (body !== undefined) {
        if (!isPlainObject(body)) {
          throw new BrainError('INVALID_ARGUMENT', 'approve body must be an object')
        }
        if (body.conflictKeepIds !== undefined) {
          if (!isPlainObject(body.conflictKeepIds)) {
            throw new BrainError('INVALID_ARGUMENT', 'conflictKeepIds must be an object')
          }
          const resolved: Record<string, string> = {}
          for (const [key, val] of Object.entries(body.conflictKeepIds)) {
            if (typeof val !== 'string') {
              throw new BrainError('INVALID_ARGUMENT', 'conflictKeepIds values must be strings')
            }
            resolved[key] = val
          }
          approveOptions = { conflictKeepIds: resolved }
        }
      }
      return respond(await memory.consolidation.approveProposal(id, approveOptions))
    }

    const rejectMatch = PROPOSAL_REJECT_PATH.exec(tail)
    if (method === 'POST' && rejectMatch !== null) {
      if (memory.consolidation === undefined) {
        throw new BrainError('UNAVAILABLE', 'consolidation is not available')
      }
      const id = decodeSegment(rejectMatch[1] as string, 'proposal id')
      return respond(toProposalView(await memory.consolidation.rejectProposal(id)))
    }

    if (method === 'POST' && tail === '/memory/working') {
      if (!isPlainObject(body)) {
        throw new BrainError('INVALID_ARGUMENT', 'working memory input must be an object')
      }
      if (body.promoteToL1 !== undefined && typeof body.promoteToL1 !== 'boolean') {
        throw new BrainError('INVALID_ARGUMENT', 'promoteToL1 must be a boolean')
      }
      const evidence = body.evidence === undefined ? undefined : parseEvidenceRefs(body.evidence, 'evidence')
      const input: WorkingMemoryInput = {
        channel: body.channel as string,
        key: body.key as string,
        text: body.text as string,
        ...(body.ttlMs === undefined ? {} : { ttlMs: body.ttlMs as number }),
        ...(body.promoteToL1 === undefined ? {} : { promoteToL1: body.promoteToL1 }),
        ...(evidence === undefined ? {} : { evidence }),
      }
      return respond(await memory.workingMemory.put(input))
    }

    if (method === 'GET' && tail === '/memory/working') {
      const channel = url.searchParams.get('channel')
      if (channel === null || channel.trim() === '') {
        throw new BrainError('INVALID_ARGUMENT', 'channel query parameter is required')
      }
      return respond({ items: await memory.workingMemory.listActive(channel) })
    }

    const workingMatch = WORKING_ITEM_PATH.exec(tail)
    if (method === 'DELETE' && workingMatch !== null) {
      const id = decodeSegment(workingMatch[1] as string, 'working memory id')
      const removed = await memory.workingMemory.remove(id)
      return respond({ removed })
    }

    if (method === 'GET' && tail === '/console/accounting/summary') {
      const accounting = options.console?.accounting
      if (accounting === undefined) throw new BrainError('UNAVAILABLE', 'accounting is not available')
      const daysParam = url.searchParams.get('days')
      let days: number | undefined
      if (daysParam !== null) {
        days = parseQueryInt(daysParam, 'days')
        if (days < 1) throw new BrainError('INVALID_ARGUMENT', 'days must be >= 1')
      }
      return respond(await accounting.summary(days))
    }

    if (method === 'GET' && tail === '/console/accounting/prices') {
      const accounting = options.console?.accounting
      if (accounting === undefined) throw new BrainError('UNAVAILABLE', 'accounting is not available')
      return respond(await accounting.prices())
    }

    if (method === 'PUT' && tail === '/console/accounting/prices') {
      const accounting = options.console?.accounting
      if (accounting === undefined) throw new BrainError('UNAVAILABLE', 'accounting is not available')
      return respond(await accounting.setPrices(body as ModelPriceBook))
    }

    if (method === 'PUT' && tail === '/console/accounting/budget') {
      const accounting = options.console?.accounting
      if (accounting === undefined) throw new BrainError('UNAVAILABLE', 'accounting is not available')
      return respond(await accounting.setBudget(parseAccountingBudget(body)))
    }

    if (method === 'GET' && tail === '/console/interop') {
      const interop = options.console?.interop
      if (interop === undefined) throw new BrainError('UNAVAILABLE', 'interop is not available')
      return respond(await interop.snapshot())
    }

    if (method === 'PUT' && tail === '/console/interop/amp') {
      const interop = options.console?.interop
      if (interop === undefined) throw new BrainError('UNAVAILABLE', 'interop is not available')
      return respond(await interop.setAmpAliases(parseEnabledBody(body)))
    }

    if (method === 'PUT' && tail === '/console/interop/mcp') {
      const interop = options.console?.interop
      if (interop === undefined) throw new BrainError('UNAVAILABLE', 'interop is not available')
      return respond(await interop.setReadOnlyMcp(parseEnabledBody(body)))
    }

    if (method === 'POST' && tail === '/console/interop/debug-view/start') {
      const interop = options.console?.interop
      if (interop === undefined) throw new BrainError('UNAVAILABLE', 'interop is not available')
      return respond(await interop.startDebugView())
    }

    if (method === 'POST' && tail === '/console/interop/debug-view/stop') {
      const interop = options.console?.interop
      if (interop === undefined) throw new BrainError('UNAVAILABLE', 'interop is not available')
      return respond(await interop.stopDebugView())
    }

    // ---- console: plugins (8 routes) ----

    if (method === 'GET' && tail === '/console/plugins') {
      const plugins = options.console?.plugins
      if (plugins === undefined) throw new BrainError('UNAVAILABLE', 'plugins console is not available')
      return respond(await plugins.list())
    }

    if (method === 'POST' && tail === '/console/plugins/scan') {
      const plugins = options.console?.plugins
      if (plugins === undefined) throw new BrainError('UNAVAILABLE', 'plugins console is not available')
      return respond(await (plugins.scan ? plugins.scan() : plugins.list()))
    }

    if (method === 'POST' && tail === '/console/plugins/install') {
      const plugins = options.console?.plugins
      if (plugins === undefined) throw new BrainError('UNAVAILABLE', 'plugins console is not available')
      const spec = requireStringField(body, 'spec')
      return respond(await plugins.install(spec))
    }

    if (method === 'POST' && tail === '/console/plugins/check') {
      const plugins = options.console?.plugins
      if (plugins === undefined) throw new BrainError('UNAVAILABLE', 'plugins console is not available')
      const dir = requireStringField(body, 'dir')
      return respond(await plugins.check(dir))
    }

    const pluginApplyLocalMatch = PLUGIN_APPLY_LOCAL_PATH.exec(tail)
    if (method === 'POST' && pluginApplyLocalMatch !== null) {
      const plugins = options.console?.plugins
      if (plugins === undefined || plugins.applyLocal === undefined) {
        throw new BrainError('UNAVAILABLE', 'plugins console is not available')
      }
      const id = requireSegment(pluginApplyLocalMatch[1] as string, 'plugin id')
      if (!isPlainObject(body)) {
        throw new BrainError('INVALID_ARGUMENT', 'apply-local body must be an object')
      }
      if (body.action !== 'enable' && body.action !== 'update') {
        throw new BrainError('INVALID_ARGUMENT', 'action must be enable or update')
      }
      if (body.confirmPermissions !== undefined && typeof body.confirmPermissions !== 'boolean') {
        throw new BrainError('INVALID_ARGUMENT', 'confirmPermissions must be a boolean')
      }
      return respond(await plugins.applyLocal(id, {
        action: body.action,
        ...(body.confirmPermissions === undefined ? {} : { confirmPermissions: body.confirmPermissions }),
      }))
    }

    const pluginActionMatch = PLUGIN_ACTION_PATH.exec(tail)
    if (method === 'POST' && pluginActionMatch !== null) {
      const plugins = options.console?.plugins
      if (plugins === undefined) throw new BrainError('UNAVAILABLE', 'plugins console is not available')
      const id = requireSegment(pluginActionMatch[1] as string, 'plugin id')
      const action = pluginActionMatch[2]
      if (action === 'confirm') {
        await plugins.confirm(id)
        return respond({ ok: true })
      }
      if (action === 'enable') {
        await plugins.enable(id)
        return respond({ ok: true })
      }
      if (action === 'disable') {
        await plugins.disable(id)
        return respond({ ok: true })
      }
      if (action === 'upgrade') {
        const spec = requireStringField(body, 'spec')
        return respond(await plugins.upgrade(id, spec))
      }
      if (action === 'uninstall') {
        let keepData = false
        if (body !== undefined) {
          if (!isPlainObject(body)) {
            throw new BrainError('INVALID_ARGUMENT', 'uninstall body must be an object')
          }
          if (body.keepData !== undefined && typeof body.keepData !== 'boolean') {
            throw new BrainError('INVALID_ARGUMENT', 'keepData must be a boolean')
          }
          keepData = body.keepData === true
        }
        await plugins.uninstall(id, { keepData })
        return respond({ ok: true })
      }
    }

    // ---- console: memory search / browse / dependents / audit / cross-channel / persons (10 routes) ----

    if (method === 'POST' && tail === '/console/memory/search') {
      const { request, viewer } = parseConsoleSearchBody(body)
      const result = await memory.service.search(request, viewer)
      return respond(
        { items: result.items },
        { degraded: result.degraded, ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }) },
      )
    }

    if (method === 'GET' && tail === '/console/memory/records') {
      const layerParam = url.searchParams.get('layer')
      let layer: Layer | undefined
      if (layerParam !== null) {
        if (!(LAYERS as readonly string[]).includes(layerParam)) {
          throw new BrainError('INVALID_ARGUMENT', 'layer must be L0, L1, L2 or L3')
        }
        layer = layerParam as Layer
      }
      const limitParam = url.searchParams.get('limit')
      let limit = 50
      if (limitParam !== null) {
        limit = parseQueryInt(limitParam, 'limit')
        if (limit < 1 || limit > 200) {
          throw new BrainError('INVALID_ARGUMENT', 'limit must be between 1 and 200')
        }
      }
      const personIdParam = url.searchParams.get('personId')
      let subjects: readonly string[] | undefined
      if (personIdParam !== null && personIdParam !== '') {
        const snapshot = await memory.identity.snapshot()
        subjects = snapshot.idsOf(personIdParam)
      }
      const channelParam = url.searchParams.get('channel')
      const channel = channelParam !== null && channelParam !== '' ? channelParam : undefined
      const cursorParam = url.searchParams.get('cursor')
      const cursor = cursorParam !== null && cursorParam !== '' ? cursorParam : undefined
      const filter: RecordFilter = {
        ...(layer === undefined ? {} : { layers: [layer] }),
        ...(channel === undefined ? {} : { channels: [channel] }),
        ...(subjects === undefined ? {} : { subjects }),
      }
      const page = await memory.store.list(filter, {
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      })
      return respond({
        items: page.items,
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      })
    }

    const consoleDependentsMatch = CONSOLE_RECORD_DEPENDENTS_PATH.exec(tail)
    if (method === 'GET' && consoleDependentsMatch !== null) {
      const id = requireSegment(consoleDependentsMatch[1] as string, 'record id')
      const items = await memory.store.dependentsOf(id)
      return respond({ items })
    }

    const consoleRecordMatch = CONSOLE_RECORD_PATH.exec(tail)
    if (method === 'GET' && consoleRecordMatch !== null) {
      const id = requireSegment(consoleRecordMatch[1] as string, 'record id')
      const record = await memory.store.get(id)
      if (record === null) throw new BrainError('NOT_FOUND', `record ${id} not found`)
      return respond(record)
    }

    if (method === 'GET' && tail === '/console/memory/audit') {
      const rawRecordId = url.searchParams.get('recordId')
      const recordId = rawRecordId !== null && rawRecordId !== '' ? rawRecordId : undefined
      const auditFn = options.console?.memoryConsole?.audit
      const items = auditFn !== undefined ? await auditFn(recordId) : await memory.audit.list(recordId)
      return respond({ items })
    }

    if (method === 'GET' && tail === '/console/memory/cross-channel') {
      const crossChannel = options.console?.memoryConsole?.crossChannel
      if (crossChannel === undefined) throw new BrainError('UNAVAILABLE', 'cross-channel config is not available')
      return respond({ mode: await crossChannel.getMode() })
    }

    if (method === 'PUT' && tail === '/console/memory/cross-channel') {
      const crossChannel = options.console?.memoryConsole?.crossChannel
      if (crossChannel === undefined) throw new BrainError('UNAVAILABLE', 'cross-channel config is not available')
      if (!isPlainObject(body) || (body.mode !== 'off' && body.mode !== 'shadow' && body.mode !== 'on')) {
        throw new BrainError('INVALID_ARGUMENT', 'mode must be off, shadow or on')
      }
      await crossChannel.setMode(body.mode)
      return respond({ mode: body.mode })
    }

    if (tail === '/console/memory/automation' && (method === 'GET' || method === 'PUT')) {
      const automation = options.console?.memoryConsole?.automation
      if (automation === undefined) throw new BrainError('UNAVAILABLE', 'memory automation is not available')
      return respond(method === 'GET' ? automation.get() : await automation.set(parseEnabledBody(body)))
    }

    if (method === 'GET' && tail === '/console/memory/persons') {
      const persons = options.console?.memoryConsole?.persons
      const items = persons !== undefined ? await persons.list() : await memory.identity.listPersons()
      return respond({ items })
    }

    if (method === 'POST' && tail === '/console/memory/persons/merge') {
      const from = requireStringField(body, 'from')
      const into = requireStringField(body, 'into')
      const persons = options.console?.memoryConsole?.persons
      if (persons !== undefined) await persons.merge(from, into)
      else await memory.identity.merge(from, into)
      return respond({ ok: true })
    }

    const personSplitMatch = PERSON_SPLIT_PATH.exec(tail)
    if (method === 'POST' && personSplitMatch !== null) {
      const id = requireSegment(personSplitMatch[1] as string, 'person id')
      if (
        !isPlainObject(body)
        || !Array.isArray(body.accounts)
        || body.accounts.length === 0
        || !body.accounts.every((item) => typeof item === 'string' && item.trim() !== '')
      ) {
        throw new BrainError('INVALID_ARGUMENT', 'accounts must be a non-empty array of strings')
      }
      const persons = options.console?.memoryConsole?.persons
      const personId = persons !== undefined
        ? await persons.split(id, body.accounts)
        : await memory.identity.split(id, body.accounts)
      return respond({ personId })
    }

    // ---- console: satellite & pages (4 routes) ----

    if (method === 'GET' && tail === '/console/satellite') {
      const satellite = options.console?.satellite
      if (satellite === undefined) throw new BrainError('UNAVAILABLE', 'satellite console is not available')
      return respond(await satellite.snapshot())
    }

    if (method === 'POST' && tail === '/console/satellite/doctor') {
      const satellite = options.console?.satellite
      if (satellite === undefined) throw new BrainError('UNAVAILABLE', 'satellite console is not available')
      return respond(await satellite.runDoctor())
    }

    const satelliteRestartMatch = SATELLITE_RESTART_PATH.exec(tail)
    if (method === 'POST' && satelliteRestartMatch !== null) {
      const satellite = options.console?.satellite
      if (satellite === undefined) throw new BrainError('UNAVAILABLE', 'satellite console is not available')
      const agentClass = requireSegment(satelliteRestartMatch[1] as string, 'agent class')
      if (agentClass !== 'chat' && agentClass !== 'activity') {
        throw new BrainError('INVALID_ARGUMENT', 'agentClass must be chat or activity')
      }
      await satellite.restart(agentClass)
      return respond({ ok: true })
    }

    if (method === 'GET' && tail === '/console/pages') {
      const pages = options.console?.pages
      if (pages === undefined) throw new BrainError('UNAVAILABLE', 'console pages are not available')
      return respond({ items: pages.list() })
    }

    throw new BrainError('NOT_FOUND', 'not found')
  }

  const server = createServer((req, res) => {
    const requestId = nextRequestId()
    const started = Date.now()
    void (async () => {
      let status = 500
      try {
        if (!authorized(req.headers.authorization, options.token)) {
          // Drain whatever body may be coming so the client reads the response, not a reset.
          req.resume()
          throw new BrainError('UNAUTHENTICATED', 'missing or invalid token')
        }
        const method = req.method ?? 'GET'
        const body = method === 'POST' || method === 'PATCH' || method === 'PUT' ? await readJson(req) : undefined
        if (method !== 'POST' && method !== 'PATCH' && method !== 'PUT') req.resume()
        const result = await route(requestId, req, body)
        status = result.status
        send(res, status, result.payload)
      } catch (error) {
        if (error instanceof BrainError) {
          status = ERROR_CODES[error.code]
          send(res, status, errorEnvelope(requestId, error))
        } else {
          status = 500
          const errorName = error instanceof Error ? error.name : undefined
          const errorCode = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
          options.log.error('http.internal', {
            requestId,
            errorName: typeof errorName === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(errorName) ? errorName : undefined,
            errorCode: typeof errorCode === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(errorCode) ? errorCode : undefined,
          })
          send(res, status, {
            ok: false,
            error: { code: 'INTERNAL', message: 'internal error', details: {} },
            meta: { requestId },
          })
        }
      } finally {
        options.log.info('http.request', { requestId, code: String(status), durationMs: Date.now() - started })
      }
    })()
  })

  return {
    listen(): Promise<{ readonly port: number }> {
      return new Promise((resolve, reject) => {
        const onError = (error: Error): void => { reject(error) }
        server.once('error', onError)
        // Loopback only; there is deliberately no option to widen this.
        server.listen({ host: '127.0.0.1', port: options.port }, () => {
          server.off('error', onError)
          const address = server.address()
          resolve({ port: address !== null && typeof address === 'object' ? address.port : options.port })
        })
      })
    },

    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined || error === null) resolve(); else reject(error) })
        server.closeAllConnections()
      })
    },

    address(): AddressInfo | string | null {
      return server.address()
    },
  }
}
