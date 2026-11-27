import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Viewer } from '@dsh-brain-core/sdk'
import type {
  ContextAssembler, CrossChannelMode, ForgetService, KeywordIndex, Policy, RecordStore, WriteIdentity,
} from '../../src/contracts/index.ts'
import { prepareBrainHome, type BrainPaths } from '../../src/home/index.ts'
import { createIdentityService, createProfileStore, type IdentityService, type ProfileStore } from '../../src/identity-persona/index.ts'
import type { Logger } from '../../src/log/index.ts'
import { createAuditLog, type AuditLog } from '../../src/memory-api/audit.ts'
import { createChannelFacts, type ChannelFactsSource } from '../../src/memory-api/channel-facts.ts'
import {
  createMemoryApiServer, openMemory,
  type Memory, type MemoryApiServer, type MemoryOptions,
} from '../../src/memory-api/index.ts'
import { createMemoryService, type MemoryServiceImplementation } from '../../src/memory-api/service.ts'
import { createContextAssembler } from '../../src/memory-context/index.ts'
import { createForgetService } from '../../src/memory-forget/index.ts'
import { createPolicy } from '../../src/memory-policy/index.ts'
import { createKeywordIndex } from '../../src/memory-search/index.ts'
import { createSqliteRecordStore } from '../../src/memory-store/index.ts'

export const silentLog: Logger = { info() {}, warn() {}, error() {} }

export const OWNER_IDENTITY: WriteIdentity = {
  kind: 'kernel', source: 'owner-console', trust: 'owner', defaultVisibility: 'owner',
}
export const OWNER_VIEWER: Viewer = { caller: 'owner-console', channel: null, participants: [] }

export function agentViewer(channel: string, participants: readonly string[] = []): Viewer {
  return { caller: 'agent', channel, participants }
}

export interface TempBrain {
  readonly dir: string
  readonly paths: BrainPaths
  readonly memory: Memory
  close(): Promise<void>
}

export async function openTempBrain(overrides: Partial<MemoryOptions> = {}): Promise<TempBrain> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brain-memory-api-'))
  const paths = await prepareBrainHome({ env: { BRAIN_HOME: dir }, userHome: os.homedir() })
  const memory = await openMemory({
    paths,
    clock: { now: () => Date.now() },
    log: silentLog,
    crossChannelMode: () => 'shadow' as CrossChannelMode,
    ownerChannels: [],
    ...overrides,
  })
  return {
    dir,
    paths,
    memory,
    async close() {
      await memory.close()
      await rm(dir, { recursive: true, force: true, maxRetries: 5 })
    },
  }
}

export interface HttpResult {
  readonly status: number
  readonly body: Record<string, unknown>
}

export interface TestApi {
  readonly port: number
  readonly server: MemoryApiServer
  request(method: string, route: string, body?: unknown, headers?: Record<string, string>): Promise<HttpResult>
  close(): Promise<void>
}

export async function startApi(memory: Memory, token = 'test-token'): Promise<TestApi> {
  const server = createMemoryApiServer(memory, { token, port: 0, log: silentLog })
  const { port } = await server.listen()
  return {
    port,
    server,
    async request(method, route, body, headers = {}) {
      const hasBody = body !== undefined
      const response = await fetch(`http://127.0.0.1:${port}/api/v1${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        ...(hasBody ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
      })
      const text = await response.text()
      return { status: response.status, body: JSON.parse(text) as Record<string, unknown> }
    },
    async close() {
      await server.close()
    },
  }
}

/** Every component of the facade, real unless a test passes a replacement. */
export interface Parts {
  readonly dir: string
  readonly paths: BrainPaths
  readonly store: RecordStore
  readonly index: KeywordIndex
  readonly audit: AuditLog
  readonly identity: IdentityService
  readonly profiles: ProfileStore
  readonly facts: ChannelFactsSource
  readonly policy: Policy
  readonly assembler: ContextAssembler
  readonly forget: ForgetService
  close(): Promise<void>
}

export async function openParts(options: {
  readonly store?: RecordStore
  readonly index?: KeywordIndex
  readonly audit?: AuditLog
} = {}): Promise<Parts> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brain-memory-api-'))
  const paths = await prepareBrainHome({ env: { BRAIN_HOME: dir }, userHome: os.homedir() })
  const clock = { now: () => Date.now() }
  const ownedStore = options.store === undefined
  const ownedIndex = options.index === undefined
  const ownedAudit = options.audit === undefined
  const store = options.store ?? await createSqliteRecordStore({ path: path.join(paths.memory, 'records.db'), clock })
  const index = options.index ?? await createKeywordIndex({ path: path.join(paths.memory, 'index.db') })
  const audit = options.audit ?? await createAuditLog({ path: path.join(paths.memory, 'audit.db') })
  const identity = await createIdentityService({ path: path.join(paths.memory, 'identity.json'), clock })
  const profiles = createProfileStore({ store, clock })
  const facts = createChannelFacts({ ownerChannels: [], identity })
  const policy = createPolicy()
  const assembler = createContextAssembler({
    store, index, policy, profiles, audit, clock,
    facts: (viewer) => facts.forViewer(viewer),
    crossChannelMode: () => 'shadow',
  })
  const forget = createForgetService({ store, index, onForgotten: async () => {} })
  return {
    dir, paths, store, index, audit, identity, profiles, facts, policy, assembler, forget,
    async close() {
      if (ownedIndex) await index.close()
      if (ownedAudit) await audit.close()
      if (ownedStore) await store.close()
      await rm(dir, { recursive: true, force: true, maxRetries: 5 })
    },
  }
}

export function facadeOf(
  parts: Parts,
  overrides: Partial<Parameters<typeof createMemoryService>[0]> = {},
): MemoryServiceImplementation {
  return createMemoryService({
    store: parts.store,
    index: parts.index,
    policy: parts.policy,
    assembler: parts.assembler,
    forget: parts.forget,
    identity: parts.identity,
    facts: parts.facts,
    audit: parts.audit,
    crossChannelMode: () => 'shadow' as CrossChannelMode,
    jobsHealth: () => 'ok',
    clock: { now: () => Date.now() },
    log: silentLog,
    ...overrides,
  })
}
