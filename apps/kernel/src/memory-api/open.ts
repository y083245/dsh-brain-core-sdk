import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BrainError, LIMITS, VISIBILITIES,
  type ChannelEventResult, type DerivedRecordInput, type Disclosure, type MemoryRecord,
  type ReadL0Request, type ReadL0Result, type SearchHit, type SearchRequest, type Viewer,
} from '@brain-core/sdk'
import { scanInjection } from '@brain-core/shared'
import type { BrainPaths } from '../home/index.ts'
import type {
  Clock, ConsolidationEngine, CrossChannelMode, LlmClient, MemoryDecay, MemoryProviderRegistry,
  MemoryService, NewRecord, RecordFilter, RecordStore, WorkingMemoryStore,
} from '../contracts/index.ts'
import { createIdentityService, createProfileStore, type IdentityService, type ProfileStore } from '../identity-persona/index.ts'
import type { Logger } from '../log/index.ts'
import { createConsolidationEngine } from '../memory-consolidation/index.ts'
import { createContextAssembler } from '../memory-context/index.ts'
import { createMemoryDecay } from '../memory-decay/index.ts'
import { createExtractor, createFileProcessedLog } from '../memory-extraction/index.ts'
import { createForgetService } from '../memory-forget/index.ts'
import { createPolicy } from '../memory-policy/index.ts'
import { createKeywordIndex } from '../memory-search/index.ts'
import { createSqliteRecordStore, isValidChannel } from '../memory-store/index.ts'
import { createPersonaService, createRoleStore, type PersonaService, type RoleStore } from '../persona-roles/index.ts'
import { createWorkingMemoryStore } from '../working-memory/index.ts'
import { createAuditLog, type AuditLog } from './audit.ts'
import { createChannelFacts, type ChannelFactsSource } from './channel-facts.ts'
import { createJobRunner, type Extractor, type JobRunner } from './jobs.ts'
import { createMemoryService, type MemoryServiceImplementation } from './service.ts'

export interface ConsolidationOptions {
  readonly llm: LlmClient
  readonly dailyTokenCap?: number
  readonly maxOutputTokens?: number
  readonly minNewEvidence?: number
}

export interface MemoryOptions {
  readonly paths: BrainPaths
  readonly clock: Clock
  readonly log: Logger
  readonly crossChannelMode: () => CrossChannelMode
  readonly ownerChannels: readonly string[]
  /** Only when the owner has set up a model for extraction. S2 never has one, so the extract job is UNAVAILABLE. */
  readonly extraction?: { readonly llm: LlmClient; readonly dailyTokenCap: number; readonly maxOutputTokens: number }
  readonly consolidation?: ConsolidationOptions
  readonly activityConfigured?: () => boolean
  /** Optional memory-provider registry for search augmentation and S7 forget sync. */
  readonly providers?: MemoryProviderRegistry
  /** Told which records were forgotten, with the channel each one lived in. */
  readonly onForgotten?: (records: readonly { readonly id: string; readonly channel: string }[]) => Promise<void>
}

export interface Memory {
  readonly service: MemoryService & {
    flush(): Promise<void>
    searchWithoutAudit?(
      request: SearchRequest,
      viewer: Viewer,
    ): Promise<{ readonly items: readonly SearchHit[]; readonly nextCursor?: string; readonly degraded: boolean }>
  }
  readonly jobs: JobRunner
  readonly identity: IdentityService
  readonly profiles: ProfileStore
  readonly roles: RoleStore
  readonly persona: PersonaService
  readonly channels: ChannelFactsSource
  readonly store: RecordStore
  readonly audit: AuditLog
  readonly decay: MemoryDecay
  readonly workingMemory: WorkingMemoryStore
  readonly consolidation?: ConsolidationEngine
  readL0(request?: ReadL0Request): Promise<ReadL0Result>
  writeDerived(pluginId: string, input: DerivedRecordInput): Promise<MemoryRecord>
  readChannelEvent(recordId: string, sourcePluginId: string, viewer: Viewer): Promise<ChannelEventResult>
  close(): Promise<void>
}

const LEGACY_DISCLOSURE_SUFFIX = '（旧系统历史存档，仅作事实参考，不作为当前说话语气）'

function withLegacyDisclosure(record: MemoryRecord, disclosure: Disclosure): Disclosure {
  if (record.layer !== 'L0' || record.content.legacy !== true) return disclosure
  if (disclosure.label.includes(LEGACY_DISCLOSURE_SUFFIX)) return disclosure
  return { ...disclosure, label: `${disclosure.label}${LEGACY_DISCLOSURE_SUFFIX}` }
}

/** `apps/kernel`, which holds the factory role cards under `roles/`. */
function kernelRoot(): string {
  const primary = fileURLToPath(new URL('../..', import.meta.url))
  const candidates = [
    primary,
    fileURLToPath(new URL('../../..', import.meta.url)),
  ]
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'roles'))) return candidate
  }
  return primary
}

export async function openMemory(options: MemoryOptions): Promise<Memory> {
  const dir = options.paths.memory
  const indexPath = path.join(dir, 'index.db')
  // M6: a missing index is rebuilt from the store instead of failing the start.
  const indexExisted = existsSync(indexPath)

  const store = await createSqliteRecordStore({ path: path.join(dir, 'records.db'), clock: options.clock })
  const index = await createKeywordIndex({ path: indexPath })
  const audit = await createAuditLog({ path: path.join(dir, 'audit.db') })
  const identity = await createIdentityService({ path: path.join(dir, 'identity.json'), clock: options.clock })
  const profiles = createProfileStore({ store, clock: options.clock })
  const roles = createRoleStore({ root: kernelRoot(), stateDir: options.paths.state })
  const persona = createPersonaService({
    roles,
    dir: path.join(options.paths.state, 'persona'),
    store,
    profiles,
    clock: options.clock,
  })

  const decay = createMemoryDecay()
  const workingMemory = createWorkingMemoryStore({
    clock: options.clock,
    filePath: path.join(dir, 'working-memory.json'),
  })

  let extractor: Extractor | undefined
  if (options.extraction !== undefined) {
    const processed = await createFileProcessedLog(path.join(dir, 'extraction-processed.log'))
    extractor = createExtractor({
      store,
      llm: options.extraction.llm,
      clock: options.clock,
      processed,
      dailyTokenCap: options.extraction.dailyTokenCap,
      maxOutputTokens: options.extraction.maxOutputTokens,
      index,
    })
  }

  const consolidationConfig = options.consolidation ?? options.extraction
  const consolidationEngine = consolidationConfig === undefined
    ? undefined
    : createConsolidationEngine({
        store,
        index,
        profiles,
        llm: consolidationConfig.llm,
        clock: options.clock,
        stateFile: path.join(dir, 'consolidation.json'),
        dailyTokenCap: consolidationConfig.dailyTokenCap ?? 200_000,
        ...(consolidationConfig.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: consolidationConfig.maxOutputTokens }),
        ...(options.consolidation?.minNewEvidence === undefined
          ? {}
          : { minNewEvidence: options.consolidation.minNewEvidence }),
      })
  const consolidation = consolidationEngine === undefined ? undefined : {
    ...consolidationEngine,
    runShadow(request: Parameters<ConsolidationEngine['runShadow']>[0]) {
      if (options.activityConfigured?.() === false) {
        throw new BrainError('UNAVAILABLE', 'consolidation is not available')
      }
      return consolidationEngine.runShadow(request)
    },
  }

  let markIndexHealthy = (): void => {}
  const jobs = createJobRunner({
    index,
    store,
    clock: options.clock,
    ...(extractor === undefined ? {} : { extractor }),
    ...(consolidation === undefined ? {} : { consolidation }),
    ...(options.activityConfigured === undefined ? {} : { activityConfigured: options.activityConfigured }),
    onRebuildSuccess: () => markIndexHealthy(),
  })

  const facts = createChannelFacts({ ownerChannels: options.ownerChannels, identity })
  const policy = createPolicy()
  const assembler = createContextAssembler({
    store,
    index,
    policy,
    profiles,
    audit,
    clock: options.clock,
    facts: (viewer) => facts.forViewer(viewer),
    crossChannelMode: options.crossChannelMode,
    workingMemory,
    decay,
    recallGate: { maxItems: 6, minMatched: (n) => Math.min(3, Math.ceil(n * 0.25)) },
  })
  const forget = createForgetService({
    store,
    index,
    onForgotten: async (ids) => {
      if (options.onForgotten !== undefined) {
        const records: { readonly id: string; readonly channel: string }[] = []
        for (const id of ids) {
          const record = await store.get(id)
          if (record !== null) records.push({ id: record.id, channel: record.channel })
        }
        await options.onForgotten(records)
      }
      await options.providers?.notifyForgotten(ids)
    },
  })

  const service: MemoryServiceImplementation = createMemoryService({
    store,
    index,
    policy,
    assembler,
    forget,
    identity,
    facts,
    audit,
    crossChannelMode: options.crossChannelMode,
    jobsHealth: () => jobs.health(),
    clock: options.clock,
    log: options.log,
    ...(options.providers === undefined ? {} : { providers: options.providers }),
  })
  markIndexHealthy = () => service.markIndexHealthy()

  async function readL0(request?: ReadL0Request): Promise<ReadL0Result> {
    if (request !== undefined && (typeof request !== 'object' || request === null || Array.isArray(request))) {
      throw new BrainError('INVALID_ARGUMENT', 'readL0 request must be an object')
    }
    const limit = request?.limit === undefined ? 100 : request.limit
    if (!Number.isInteger(limit) || limit < 1) {
      throw new BrainError('INVALID_ARGUMENT', 'readL0 limit must be a positive integer')
    }
    if (request?.from !== undefined && (typeof request.from !== 'number' || !Number.isFinite(request.from))) {
      throw new BrainError('INVALID_ARGUMENT', 'readL0 from must be a finite number')
    }
    if (request?.to !== undefined && (typeof request.to !== 'number' || !Number.isFinite(request.to))) {
      throw new BrainError('INVALID_ARGUMENT', 'readL0 to must be a finite number')
    }
    if (request?.afterId !== undefined && typeof request.afterId !== 'string') {
      throw new BrainError('INVALID_ARGUMENT', 'readL0 afterId must be a string')
    }
    const filter: RecordFilter = {
      layers: ['L0'],
      statuses: ['active'],
      ...(request?.from === undefined ? {} : { from: request.from }),
      ...(request?.to === undefined ? {} : { to: request.to }),
    }
    const page = await store.list(filter, {
      limit: Math.min(limit, 1000),
      ...(request?.afterId === undefined ? {} : { cursor: request.afterId }),
    })
    return {
      items: page.items,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    }
  }

  async function writeDerived(pluginId: string, input: DerivedRecordInput): Promise<MemoryRecord> {
    if (typeof pluginId !== 'string' || pluginId.trim() === '') {
      throw new BrainError('INVALID_ARGUMENT', 'pluginId must be a non-empty string')
    }
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new BrainError('INVALID_ARGUMENT', 'derived input must be an object')
    }
    if (typeof input.channel !== 'string' || !isValidChannel(input.channel)) {
      throw new BrainError('INVALID_ARGUMENT', 'channel must be <source>:<kind>:<id>')
    }
    if (
      !Array.isArray(input.subjects)
      || input.subjects.length > LIMITS.subjects
      || !input.subjects.every((s) => typeof s === 'string' && s.trim() !== '')
    ) {
      throw new BrainError('INVALID_ARGUMENT', 'subjects must be an array of non-empty strings')
    }
    if (typeof input.content !== 'object' || input.content === null || Array.isArray(input.content)) {
      throw new BrainError('INVALID_ARGUMENT', 'content must be an object')
    }
    const contentText = JSON.stringify(input.content) ?? ''
    if (Buffer.byteLength(contentText) > LIMITS.contentBytes) {
      throw new BrainError('PAYLOAD_TOO_LARGE', 'record content is too large')
    }
    const injection = scanInjection(contentText)
    if (injection !== null) {
      throw new BrainError('INVALID_ARGUMENT', `content looks like a prompt injection: ${injection}`)
    }
    if (!Array.isArray(input.evidence) || input.evidence.length === 0 || input.evidence.length > LIMITS.evidence) {
      throw new BrainError('INVALID_ARGUMENT', 'writeDerived requires at least one evidence reference')
    }
    const evidenceRefs: { readonly id: string }[] = []
    for (const ref of input.evidence) {
      if (typeof ref !== 'object' || ref === null || typeof ref.id !== 'string' || ref.id.trim() === '') {
        throw new BrainError('INVALID_ARGUMENT', 'evidence entries must have a non-empty string id')
      }
      const target = await store.get(ref.id)
      if (target === null || target.status === 'tombstoned' || target.layer !== 'L0') {
        throw new BrainError('INVALID_ARGUMENT', `evidence ${ref.id} must point to an active/untombstoned L0 record`)
      }
      evidenceRefs.push({ id: ref.id })
    }
    if (input.visibility !== undefined && !VISIBILITIES.includes(input.visibility)) {
      throw new BrainError('INVALID_ARGUMENT', 'invalid visibility')
    }
    if (input.confidence !== undefined && (typeof input.confidence !== 'number' || !Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) {
      throw new BrainError('INVALID_ARGUMENT', 'confidence must be between 0 and 1')
    }
    if (input.importance !== undefined && (typeof input.importance !== 'number' || !Number.isFinite(input.importance) || input.importance < 0 || input.importance > 1)) {
      throw new BrainError('INVALID_ARGUMENT', 'importance must be between 0 and 1')
    }
    if (input.tEvent !== undefined && (typeof input.tEvent !== 'number' || !Number.isFinite(input.tEvent))) {
      throw new BrainError('INVALID_ARGUMENT', 'tEvent must be a finite number')
    }
    if (input.idempotencyKey !== undefined && typeof input.idempotencyKey !== 'string') {
      throw new BrainError('INVALID_ARGUMENT', 'idempotencyKey must be a string')
    }

    const record: NewRecord = {
      layer: 'L1',
      kind: 'l1.candidate',
      source: pluginId,
      channel: input.channel,
      subjects: [...input.subjects],
      actor: pluginId,
      content: input.content,
      evidence: evidenceRefs,
      visibility: input.visibility ?? 'origin',
      trust: 'external',
      confidence: input.confidence ?? 1,
      importance: input.importance ?? 0.5,
      tEvent: input.tEvent ?? options.clock.now(),
    }
    const stored = await store.insert(record, input.idempotencyKey)
    await index.add(stored)
    return stored
  }

  async function readChannelEvent(recordId: string, sourcePluginId: string, viewer: Viewer): Promise<ChannelEventResult> {
    if (typeof recordId !== 'string' || recordId === '' || typeof sourcePluginId !== 'string' || sourcePluginId === '') {
      throw new BrainError('NOT_FOUND', 'record not found')
    }
    const record = await store.get(recordId)
    if (
      record === null
      || record.layer !== 'L0'
      || record.status !== 'active'
      || record.source !== sourcePluginId
      || viewer.channel === null
      || record.channel !== viewer.channel
    ) {
      throw new BrainError('NOT_FOUND', 'record not found')
    }
    const snapshot = await identity.snapshot()
    const expandedViewer: Viewer = {
      caller: viewer.caller,
      channel: viewer.channel,
      participants: [...new Set(viewer.participants.flatMap((person) => snapshot.idsOf(person)))].sort(),
    }
    const channelFacts = await facts.forViewer(expandedViewer)
    const decision = policy.decide(record, expandedViewer, channelFacts)
    if (!decision.visible || decision.injection !== 'verbatim') {
      throw new BrainError('NOT_FOUND', 'record not found')
    }
    return {
      record,
      disclosure: withLegacyDisclosure(record, decision.disclosure),
    }
  }

  await facts.load(store)

  if (!indexExisted) {
    const page = await store.list({}, { limit: 1 })
    if (page.items.length > 0) jobs.start({ type: 'rebuildIndex' })
  }

  return {
    service,
    jobs,
    identity,
    profiles,
    roles,
    persona,
    channels: facts as ChannelFactsSource,
    store,
    audit,
    decay,
    workingMemory,
    ...(consolidation === undefined ? {} : { consolidation }),
    readL0,
    writeDerived,
    readChannelEvent,
    async close(): Promise<void> {
      await jobs.idle()
      await service.flush()
      await index.close()
      await audit.close()
      await store.close()
    },
  }
}
