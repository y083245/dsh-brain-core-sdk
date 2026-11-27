import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  BrainError, type EvidenceRef, type MemoryRecord, type RecordStatus,
} from '@dsh-brain-core/sdk'
import { createUlid, ensurePrivateDir, writeFileAtomic } from '@dsh-brain-core/shared'
import {
  type Clock, type NewRecord, type ProfileReader, type ProfileSnapshot, type RecordStore,
} from '../contracts/index.ts'

// ---------------------------------------------------------------------------
// Identity: person ids, account aliases, merge and split
// ---------------------------------------------------------------------------

/** The person the character herself is; it always exists and cannot be merged or split. */
export const SELF = 'self'

/** `<source>:<id>`, e.g. `qq:10001`. Exactly one colon, so it cannot be confused with a channel id. */
export const ACCOUNT_PATTERN = /^[a-z0-9][a-z0-9-]*:[^\s:]+$/

export interface PersonSummary {
  readonly personId: string
  readonly accounts: readonly string[]
  readonly aliases: readonly string[]
}

export interface IdentityService {
  /** Binds an account to an existing person. CONFLICT when it already belongs to someone else. */
  link(account: string, personId: string): Promise<void>
  /** The person behind an account; creates a new person when the account is unknown. */
  resolve(account: string): Promise<string>
  /** Moves every account of `from` to `into`; `from` stays as an alias that resolves to `into`. */
  merge(from: string, into: string): Promise<void>
  /** Moves these accounts to a new person and returns its id. */
  split(personId: string, accounts: readonly string[]): Promise<string>
  accountsOf(personId: string): Promise<readonly string[]>
  /** The person's canonical id followed by every id merged into it, sorted. */
  idsOf(personId: string): Promise<readonly string[]>
  /** Follows merges to the id that is still in use. */
  canonical(personId: string): Promise<string>
  /** Every active canonical person (excluding `self`), with sorted accounts and merged aliases. */
  listPersons(): Promise<readonly PersonSummary[]>
  /** A synchronous copy of the alias table as it is now, for paths that check many records at once. */
  snapshot(): Promise<IdentitySnapshot>
}

export interface IdentitySnapshot {
  /** Like canonical, but an unknown id comes back unchanged instead of throwing. */
  canonical(personId: string): string
  /** Like idsOf; an unknown id gives [personId]. */
  idsOf(personId: string): readonly string[]
}

interface PersonEntry {
  readonly mergedInto?: string
}

interface IdentityState {
  readonly accounts: ReadonlyMap<string, string>
  readonly persons: ReadonlyMap<string, PersonEntry>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

function unreadable(): BrainError {
  return new BrainError('UNAVAILABLE', 'the identity file is unreadable')
}

function invalidArgument(message: string): BrainError {
  return new BrainError('INVALID_ARGUMENT', message)
}

/** Follows merges inside a set of maps. Undefined means the id is not a known person. */
function canonicalIn(persons: ReadonlyMap<string, PersonEntry>, personId: string): string | undefined {
  if (personId === SELF) return SELF
  let current = personId
  const seen = new Set<string>()
  for (;;) {
    const entry = persons.get(current)
    if (entry === undefined) return undefined
    if (entry.mergedInto === undefined) return current
    if (seen.has(current)) return undefined
    seen.add(current)
    current = entry.mergedInto
  }
}

/** The canonical id plus every id merged into it, sorted. `self` always comes back as ['self']. */
function idsOfIn(persons: ReadonlyMap<string, PersonEntry>, personId: string): readonly string[] {
  const canonical = canonicalIn(persons, personId)
  if (canonical === undefined) return [personId]
  if (canonical === SELF) return [SELF]
  const ids = [canonical]
  for (const other of persons.keys()) {
    if (other !== canonical && canonicalIn(persons, other) === canonical) ids.push(other)
  }
  return ids.sort()
}

function cloneState(state: IdentityState): { accounts: Map<string, string>; persons: Map<string, PersonEntry> } {
  return {
    accounts: new Map(state.accounts),
    persons: new Map([...state.persons].map(([personId, entry]) => [personId, { ...entry }])),
  }
}

function assertAccount(account: string): void {
  if (typeof account !== 'string' || !ACCOUNT_PATTERN.test(account)) {
    throw invalidArgument('invalid account')
  }
}

async function loadIdentity(file: string): Promise<{ accounts: Map<string, string>; persons: Map<string, PersonEntry> }> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { accounts: new Map(), persons: new Map() }
    throw unreadable()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw unreadable()
  }
  if (!isPlainObject(parsed) || parsed.version !== 1 || !isPlainObject(parsed.accounts) || !isPlainObject(parsed.persons)) {
    throw unreadable()
  }

  const accounts = new Map<string, string>()
  for (const [account, personId] of Object.entries(parsed.accounts)) {
    if (!ACCOUNT_PATTERN.test(account) || typeof personId !== 'string') throw unreadable()
    accounts.set(account, personId)
  }

  const persons = new Map<string, PersonEntry>()
  for (const [personId, entry] of Object.entries(parsed.persons)) {
    // `self` is never stored; ignoring it keeps an old file readable.
    if (personId === SELF) continue
    if (!isPlainObject(entry)) throw unreadable()
    const keys = Object.keys(entry)
    if (keys.length === 0) {
      persons.set(personId, {})
      continue
    }
    if (keys.length !== 1 || keys[0] !== 'mergedInto' || typeof entry.mergedInto !== 'string') throw unreadable()
    persons.set(personId, { mergedInto: entry.mergedInto })
  }

  for (const personId of accounts.values()) {
    if (personId !== SELF && !persons.has(personId)) throw unreadable()
  }
  for (const entry of persons.values()) {
    // `self` is never a merge target, so every stored target must be a stored person.
    if (entry.mergedInto !== undefined && !persons.has(entry.mergedInto)) throw unreadable()
  }
  for (const personId of persons.keys()) {
    if (canonicalIn(persons, personId) === undefined) throw unreadable()
  }

  return { accounts, persons }
}

async function saveIdentity(
  file: string,
  state: IdentityState,
): Promise<void> {
  const accounts: Record<string, string> = {}
  for (const account of [...state.accounts.keys()].sort()) accounts[account] = state.accounts.get(account) as string
  const persons: Record<string, { readonly mergedInto?: string }> = {}
  for (const personId of [...state.persons.keys()].sort()) {
    if (personId === SELF) continue
    const entry = state.persons.get(personId) as PersonEntry
    persons[personId] = entry.mergedInto === undefined ? {} : { mergedInto: entry.mergedInto }
  }
  const dir = path.dirname(file)
  if (dir !== '.' && dir !== '') await ensurePrivateDir(dir)
  await writeFileAtomic(file, JSON.stringify({ version: 1, accounts, persons }))
}

export async function createIdentityService(deps: {
  readonly path: string
  readonly clock: Clock
}): Promise<IdentityService> {
  const file = deps.path
  const nextId = createUlid({ now: () => deps.clock.now() })
  let state = await loadIdentity(file)

  // Mutations go one at a time so two concurrent resolves of the same account create one person.
  let tail: Promise<unknown> = Promise.resolve()
  function run<T>(fn: () => Promise<T>): Promise<T> {
    const result = tail.then(fn, fn)
    tail = result.then(() => undefined, () => undefined)
    return result
  }

  function canonicalOrThrow(personId: string): string {
    const canonical = canonicalIn(state.persons, personId)
    if (canonical === undefined) throw new BrainError('NOT_FOUND', `person ${personId} not found`)
    return canonical
  }

  function accountsOfCanonical(canonical: string): readonly string[] {
    const accounts: string[] = []
    for (const [account, personId] of state.accounts) {
      if (canonicalIn(state.persons, personId) === canonical) accounts.push(account)
    }
    return accounts.sort()
  }

  return {
    link: (account, personId) => run(async () => {
      assertAccount(account)
      const target = canonicalOrThrow(personId)
      const owner = state.accounts.get(account)
      if (owner !== undefined) {
        if (canonicalOrThrow(owner) === target) return
        throw new BrainError('CONFLICT', `account ${account} belongs to another person`)
      }
      const next = cloneState(state)
      next.accounts.set(account, target)
      await saveIdentity(file, next)
      state = next
    }),

    resolve: (account) => run(async () => {
      assertAccount(account)
      const existing = state.accounts.get(account)
      if (existing !== undefined) return canonicalOrThrow(existing)
      const next = cloneState(state)
      const personId = `p_${nextId()}`
      next.persons.set(personId, {})
      next.accounts.set(account, personId)
      await saveIdentity(file, next)
      state = next
      return personId
    }),

    merge: (from, into) => run(async () => {
      const fromCanonical = canonicalOrThrow(from)
      if (fromCanonical === SELF) throw invalidArgument('self cannot be merged')
      const intoCanonical = canonicalOrThrow(into)
      if (intoCanonical === SELF) throw invalidArgument('self cannot be merged')
      if (fromCanonical === intoCanonical) return
      const next = cloneState(state)
      for (const [account, personId] of next.accounts) {
        if (canonicalIn(next.persons, personId) === fromCanonical) next.accounts.set(account, intoCanonical)
      }
      next.persons.set(fromCanonical, { mergedInto: intoCanonical })
      await saveIdentity(file, next)
      state = next
    }),

    split: (personId, accounts) => run(async () => {
      const owner = canonicalOrThrow(personId)
      if (owner === SELF) throw invalidArgument('self cannot be split')
      if (!Array.isArray(accounts) || accounts.length === 0) {
        throw invalidArgument('split needs at least one account')
      }
      for (const account of accounts) {
        const holder = state.accounts.get(account)
        if (holder === undefined || canonicalOrThrow(holder) !== owner) {
          throw invalidArgument(`account ${account} does not belong to this person`)
        }
      }
      const next = cloneState(state)
      const id = `p_${nextId()}`
      next.persons.set(id, {})
      for (const account of accounts) next.accounts.set(account, id)
      await saveIdentity(file, next)
      state = next
      // Records already written keep their old personId: there is no way to tell which record
      // belonged to which side of the split.
      return id
    }),

    accountsOf: async (personId) => accountsOfCanonical(canonicalOrThrow(personId)),

    idsOf: async (personId) => idsOfIn(state.persons, canonicalOrThrow(personId)),

    canonical: async (personId) => canonicalOrThrow(personId),

    listPersons: async () => {
      const canonicalIds = [...state.persons.entries()]
        .filter(([personId, entry]) => personId !== SELF && entry.mergedInto === undefined)
        .map(([personId]) => personId)
        .sort()
      return canonicalIds.map((personId) => {
        const aliases: string[] = []
        for (const other of state.persons.keys()) {
          if (other !== personId && canonicalIn(state.persons, other) === personId) {
            aliases.push(other)
          }
        }
        aliases.sort()
        return {
          personId,
          accounts: accountsOfCanonical(personId),
          aliases,
        }
      })
    },

    snapshot: async () => {
      const persons = new Map([...state.persons].map(([personId, entry]) => [personId, { ...entry }]))
      return {
        canonical: (personId) => canonicalIn(persons, personId) ?? personId,
        idsOf: (personId) => idsOfIn(persons, personId),
      }
    },
  }
}

// ---------------------------------------------------------------------------
// L3 self profile: versioned snapshots with rollback
// ---------------------------------------------------------------------------

export interface ProfileVersion {
  readonly version: number
  readonly tAt: number
  readonly status: RecordStatus
  readonly current: boolean
  readonly author?: 'settlement' | 'owner'
  readonly evidenceCount?: number
  readonly ownerLockedKeys?: readonly string[]
}

export interface ProfileVersionDetail extends ProfileVersion {
  readonly recordId: string
  readonly stable: string
  readonly data: Readonly<Record<string, unknown>>
  readonly evidence: readonly EvidenceRef[]
}

export interface ProfileDiff {
  readonly from: number
  readonly to: number
  readonly stableChanged: boolean
  readonly added: readonly string[]
  readonly removed: readonly string[]
  readonly changed: readonly string[]
}

export interface ProfileStore extends ProfileReader {
  /** Kernel only: plugins never reach this (RFC M3). Returns the new version number. */
  commit(next: {
    readonly stable: string
    readonly data: Readonly<Record<string, unknown>>
    readonly evidence: readonly EvidenceRef[]
    readonly author?: 'settlement' | 'owner'
    readonly ownerLockedKeys?: readonly string[]
  }): Promise<number>
  list(): Promise<readonly ProfileVersion[]>
  getVersion(version: number): Promise<ProfileVersionDetail>
  diff(a: number, b: number): Promise<ProfileDiff>
  /** Makes an earlier (or later) version current again; nothing is deleted. Returns that version. */
  rollback(version: number): Promise<number>
  /** Applies an owner edit and locks modified/specified top-level keys against automatic settlement overwrites. */
  editByOwner(edit: {
    readonly stable?: string
    readonly data: Readonly<Record<string, unknown>>
    readonly lockedKeys?: readonly string[]
    readonly evidence?: readonly EvidenceRef[]
  }): Promise<number>
}

interface VersionedRecord {
  readonly record: MemoryRecord
  readonly version: number
  readonly stable: string
  readonly data: Readonly<Record<string, unknown>>
}

const PAGE_LIMIT = 1000

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== 'object') return value
  const prototype = Object.getPrototypeOf(value)
  // Only plain objects differ by key order; Dates and other exotic values keep their own JSON.
  if (prototype !== Object.prototype && prototype !== null) return value
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key])
  }
  return sorted
}

/** JSON.stringify with object keys sorted at every depth, so equal values give equal bytes. */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? 'undefined'
}

function readAuthor(content: Readonly<Record<string, unknown>>): 'settlement' | 'owner' | undefined {
  return content.author === 'settlement' || content.author === 'owner' ? content.author : undefined
}

function readOwnerLockedKeys(content: Readonly<Record<string, unknown>>): readonly string[] | undefined {
  if (!Array.isArray(content.ownerLockedKeys)) return undefined
  return content.ownerLockedKeys.filter((item): item is string => typeof item === 'string')
}

function toProfileVersion(entry: VersionedRecord, current: VersionedRecord | undefined): ProfileVersion {
  const author = readAuthor(entry.record.content)
  const ownerLockedKeys = readOwnerLockedKeys(entry.record.content)
  return {
    version: entry.version,
    tAt: entry.record.tIngest,
    status: entry.record.status,
    current: current !== undefined && entry.version === current.version,
    ...(author === undefined ? {} : { author }),
    evidenceCount: entry.record.evidence.length,
    ...(ownerLockedKeys === undefined ? {} : { ownerLockedKeys }),
  }
}

export function createProfileStore(deps: {
  readonly store: RecordStore
  readonly clock: Clock
}): ProfileStore {
  const store = deps.store

  async function loadAll(): Promise<VersionedRecord[]> {
    const records: MemoryRecord[] = []
    let cursor: string | undefined
    for (;;) {
      const page = await store.list(
        { layers: ['L3'], kinds: ['l3.self'] },
        cursor === undefined ? { limit: PAGE_LIMIT } : { limit: PAGE_LIMIT, cursor },
      )
      records.push(...page.items)
      if (page.nextCursor === undefined) break
      cursor = page.nextCursor
    }
    const versioned: VersionedRecord[] = []
    for (const record of records) {
      if (record.status === 'tombstoned') continue
      const version = record.content.profileVersion
      if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) continue
      const data = record.content.data
      versioned.push({
        record,
        version,
        stable: typeof record.content.stable === 'string' ? record.content.stable : '',
        data: isPlainObject(data) ? data : {},
      })
    }
    return versioned.sort((left, right) => left.version - right.version)
  }

  function currentOf(versions: readonly VersionedRecord[]): VersionedRecord | undefined {
    let current: VersionedRecord | undefined
    for (const entry of versions) {
      if (entry.record.status !== 'active') continue
      if (current === undefined || entry.version > current.version) current = entry
    }
    return current
  }

  let tail: Promise<unknown> = Promise.resolve()
  function run<T>(fn: () => Promise<T>): Promise<T> {
    const result = tail.then(fn, fn)
    tail = result.then(() => undefined, () => undefined)
    return result
  }

  async function commitInternal(
    versions: readonly VersionedRecord[],
    next: {
      readonly stable: string
      readonly data: Readonly<Record<string, unknown>>
      readonly evidence: readonly EvidenceRef[]
      readonly author?: 'settlement' | 'owner'
      readonly ownerLockedKeys?: readonly string[]
    },
  ): Promise<number> {
    const version = versions.length === 0
      ? 1
      : (versions[versions.length - 1] as VersionedRecord).version + 1
    const content: Record<string, unknown> = {
      profileVersion: version,
      stable: next.stable,
      data: next.data,
      ...(next.author === undefined ? {} : { author: next.author }),
      ...(next.ownerLockedKeys === undefined ? {} : { ownerLockedKeys: [...next.ownerLockedKeys] }),
    }
    const record: NewRecord = {
      layer: 'L3',
      kind: 'l3.self',
      source: 'kernel',
      actor: 'kernel',
      channel: 'kernel:profile:self',
      subjects: ['self'],
      content,
      // The store rejects an empty evidence list; let its INVALID_ARGUMENT through unchanged.
      evidence: next.evidence,
      visibility: 'owner',
      trust: 'self',
      confidence: 1,
      importance: 1,
      tEvent: deps.clock.now(),
    }
    await store.insert(record)
    return version
  }

  return {
    commit: (next) => run(async () => commitInternal(await loadAll(), next)),

    current: async (): Promise<ProfileSnapshot> => {
      const current = currentOf(await loadAll())
      return current === undefined ? { version: 0, stable: '' } : { version: current.version, stable: current.stable }
    },

    list: async () => {
      const versions = await loadAll()
      const current = currentOf(versions)
      return versions.map((entry) => toProfileVersion(entry, current))
    },

    getVersion: async (version) => {
      const versions = await loadAll()
      const current = currentOf(versions)
      const entry = versions.find((item) => item.version === version)
      if (entry === undefined) throw new BrainError('NOT_FOUND', `profile version ${version} not found`)
      return {
        ...toProfileVersion(entry, current),
        recordId: entry.record.id,
        stable: entry.stable,
        data: structuredClone(entry.data),
        evidence: entry.record.evidence.map((ref) => ({ id: ref.id })),
      }
    },

    diff: async (a, b) => {
      const versions = await loadAll()
      const left = versions.find((entry) => entry.version === a)
      const right = versions.find((entry) => entry.version === b)
      if (left === undefined) throw new BrainError('NOT_FOUND', `profile version ${a} not found`)
      if (right === undefined) throw new BrainError('NOT_FOUND', `profile version ${b} not found`)
      const leftKeys = new Set(Object.keys(left.data))
      const rightKeys = new Set(Object.keys(right.data))
      const added = [...rightKeys].filter((key) => !leftKeys.has(key)).sort()
      const removed = [...leftKeys].filter((key) => !rightKeys.has(key)).sort()
      const changed = [...leftKeys]
        .filter((key) => rightKeys.has(key) && stableStringify(left.data[key]) !== stableStringify(right.data[key]))
        .sort()
      return { from: a, to: b, stableChanged: left.stable !== right.stable, added, removed, changed }
    },

    rollback: (version) => run(async () => {
      const versions = await loadAll()
      const target = versions.find((entry) => entry.version === version)
      if (target === undefined) throw new BrainError('NOT_FOUND', `profile version ${version} not found`)
      if (target.record.status === 'outdated') {
        throw invalidArgument(`profile version ${version} is outdated`)
      }
      for (const entry of versions) {
        if (entry.version > version && entry.record.status === 'active') {
          await store.patch(entry.record.id, { status: 'archived' }, entry.record.version)
        }
      }
      if (target.record.status === 'archived') {
        await store.patch(target.record.id, { status: 'active' }, target.record.version)
      }
      return version
    }),

    editByOwner: (edit) => run(async () => {
      const versions = await loadAll()
      const current = currentOf(versions)
      if (current === undefined && (!edit.evidence || edit.evidence.length === 0)) {
        throw invalidArgument('editByOwner requires non-empty evidence when no current version exists')
      }
      const evidence = edit.evidence ?? (current as VersionedRecord).record.evidence
      const stable = edit.stable ?? current?.stable ?? ''
      const previousLocked = current !== undefined ? (readOwnerLockedKeys(current.record.content) ?? []) : []
      const currentData = current?.data ?? {}
      const modifiedKeys = Object.keys(edit.data).filter(
        (key) => current === undefined
          || !Object.prototype.hasOwnProperty.call(currentData, key)
          || stableStringify(edit.data[key]) !== stableStringify(currentData[key]),
      )
      const lockedKeys = [...new Set([...previousLocked, ...modifiedKeys, ...(edit.lockedKeys ?? [])])].sort()
      return commitInternal(versions, {
        stable,
        data: edit.data,
        evidence,
        author: 'owner',
        ownerLockedKeys: lockedKeys,
      })
    }),
  }
}
