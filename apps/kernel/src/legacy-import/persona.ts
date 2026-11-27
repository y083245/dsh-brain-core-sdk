import { lstat } from 'node:fs/promises'
import path from 'node:path'
import type { EvidenceRef } from '@dsh-brain-core/sdk'
import type { KeywordIndex, NewRecord, RecordStore } from '../contracts/index.ts'
import type { ProfileStore } from '../identity-persona/index.ts'
import {
  errorCode, invalidArgument, isDigits, isPlainObject, listSafeEntries, notFound, readRegularFileIfExists,
  sha256Hex, stableStringify,
} from './helpers.ts'

export interface PersonaImportResult {
  readonly role?: string
  readonly coreHash?: string
  readonly l3SelfCommitted: boolean
  readonly l3PersonsImported: number
  readonly anchorRecordsCreated: number
}

async function isSafeDirectory(dirPath: string): Promise<boolean> {
  try {
    const statResult = await lstat(dirPath)
    return !statResult.isSymbolicLink() && statResult.isDirectory()
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}

async function hasSafeRegularFile(filePath: string): Promise<boolean> {
  try {
    const statResult = await lstat(filePath)
    return !statResult.isSymbolicLink() && statResult.isFile()
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}

function validateRoleName(role: string): void {
  if (
    role.trim() === ''
    || role === '.'
    || role === '..'
    || role.includes('/')
    || role.includes('\\')
    || role.includes('\0')
  ) {
    throw invalidArgument('invalid legacy role name')
  }
}

function summarizeValue(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item.trim() : stableStringify(item)))
      .filter((item) => item !== '')
      .join('；')
  }
  if (isPlainObject(value)) {
    return Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : stableStringify(v)}`)
      .join('；')
  }
  return value === undefined || value === null ? '' : String(value)
}

function buildStableSummary(
  role: string,
  core: Record<string, unknown>,
  acceptedBeliefs: readonly Record<string, unknown>[],
): string {
  const lines: string[] = [`[旧版人格导入: ${role}]`]
  const characterText = summarizeValue(core.character)
  if (characterText !== '') lines.push(`性格特征：${characterText}`)
  const traitsText = summarizeValue(core.traits)
  if (traitsText !== '') lines.push(`特质：${traitsText}`)
  const manifestsText = summarizeValue(core.manifests)
  if (manifestsText !== '') lines.push(`表现：${manifestsText}`)
  const prefsText = summarizeValue(core.prefs)
  if (prefsText !== '') lines.push(`偏好：${prefsText}`)
  if (acceptedBeliefs.length > 0) {
    const beliefTexts = acceptedBeliefs
      .map((item) => {
        if (typeof item.text === 'string') return item.text
        if (typeof item.statement === 'string') return item.statement
        return stableStringify(item)
      })
      .filter((item) => item !== '')
    if (beliefTexts.length > 0) lines.push(`已确认信念：${beliefTexts.join('；')}`)
  }
  return lines.join('\n')
}

interface PersonAttributeEntry {
  readonly value: unknown
  readonly source: 'inferred'
  readonly confidence: number
  readonly updatedAt: number
}

function makeAttribute(value: unknown, now: number): PersonAttributeEntry {
  return {
    value: structuredClone(value),
    source: 'inferred',
    confidence: 0.9,
    updatedAt: now,
  }
}

function mergeSection(
  target: Record<string, PersonAttributeEntry>,
  rawSection: unknown,
  now: number,
): void {
  if (!isPlainObject(rawSection)) return
  for (const [key, val] of Object.entries(rawSection)) {
    if (val === undefined) continue
    target[key] = isPlainObject(val) && Object.prototype.hasOwnProperty.call(val, 'value')
      ? makeAttribute(val.value, now)
      : makeAttribute(val, now)
  }
}

/**
 * Imports read-only legacy persona (`<fromDir>/persona/<role>/core.json` and `people.json`)
 * into L3.1 (`l3.self` via ProfileStore) and L3.2 (`l3.person`). Only invoked in `mode === 'all'`.
 */
export async function importPersona(params: {
  readonly fromDir: string
  readonly role?: string
  readonly dryRun: boolean
  readonly now: number
  readonly store: RecordStore
  readonly index?: KeywordIndex
  readonly profiles: ProfileStore
  readonly resolveAccount: (account: string) => Promise<string>
  readonly existingIds: Set<string>
  readonly l1IdsBySubject: Map<string, string[]>
}): Promise<PersonaImportResult> {
  if (params.role !== undefined) {
    validateRoleName(params.role)
  }

  const personaRoot = path.join(params.fromDir, 'persona')
  if (!(await isSafeDirectory(personaRoot))) {
    if (params.role !== undefined) {
      throw notFound('legacy role not found')
    }
    return { l3SelfCommitted: false, l3PersonsImported: 0, anchorRecordsCreated: 0 }
  }

  let selectedRole: string
  if (params.role !== undefined) {
    const candidateDir = path.join(personaRoot, params.role)
    if (!(await isSafeDirectory(candidateDir))) {
      throw notFound('legacy role not found')
    }
    selectedRole = params.role
  } else {
    const entries = await listSafeEntries(personaRoot)
    const roleDirs: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.join(personaRoot, entry.name)
      const hasCore = await hasSafeRegularFile(path.join(dir, 'core.json'))
      const hasPeople = await hasSafeRegularFile(path.join(dir, 'people.json'))
      if (hasCore || hasPeople) roleDirs.push(entry.name)
    }
    if (roleDirs.length === 0) {
      return { l3SelfCommitted: false, l3PersonsImported: 0, anchorRecordsCreated: 0 }
    }
    if (roleDirs.length > 1) {
      throw invalidArgument('multiple legacy roles found; specify --role')
    }
    selectedRole = roleDirs[0] as string
  }

  const roleDir = path.join(personaRoot, selectedRole)
  const coreRaw = await readRegularFileIfExists(path.join(roleDir, 'core.json'))
  const peopleRaw = await readRegularFileIfExists(path.join(roleDir, 'people.json'))

  let anchorRecordsCreated = 0
  let personaAnchorId: string | undefined

  async function ensurePersonaAnchor(sourceSha256: string): Promise<EvidenceRef> {
    if (personaAnchorId !== undefined) return { id: personaAnchorId }

    if (params.dryRun) {
      personaAnchorId = `dry:anchor:persona:${selectedRole}`
      anchorRecordsCreated += 1
      return { id: personaAnchorId }
    }

    const anchorKey = `legacy:anchor:persona:${selectedRole}:${sourceSha256.slice(0, 16)}`
    const anchorRecord: NewRecord = {
      layer: 'L0',
      kind: 'legacy.persona_snapshot',
      source: 'legacy-import',
      channel: `kernel:legacy:persona:${selectedRole}`,
      subjects: ['self'],
      actor: 'owner',
      content: {
        text: '旧版人格导入溯源锚点',
        legacy: true,
        legacySource: `persona/${selectedRole}`,
        personaSha256: sourceSha256,
      },
      evidence: [],
      visibility: 'owner',
      trust: 'owner',
      confidence: 1,
      importance: 0.5,
      tEvent: params.now,
    }
    const stored = await params.store.insert(anchorRecord, anchorKey)
    if (!params.existingIds.has(stored.id)) {
      params.existingIds.add(stored.id)
      anchorRecordsCreated += 1
      if (params.index !== undefined) await params.index.add(stored)
    }
    personaAnchorId = stored.id
    return { id: stored.id }
  }

  let l3SelfCommitted = false
  let coreHash: string | undefined

  if (coreRaw !== null) {
    let coreParsed: unknown
    try {
      coreParsed = JSON.parse(coreRaw)
    } catch {
      throw invalidArgument('invalid legacy core.json')
    }
    if (!isPlainObject(coreParsed)) {
      throw invalidArgument('invalid legacy core.json')
    }

    coreHash = sha256Hex(coreRaw)
    const existingVersions = await params.profiles.list()
    let alreadyCommitted = false
    for (const versionInfo of existingVersions) {
      const detail = await params.profiles.getVersion(versionInfo.version)
      if (detail.data.legacyImportHash === coreHash) {
        alreadyCommitted = true
        break
      }
    }

    if (!alreadyCommitted) {
      const acceptedBeliefs = Array.isArray(coreParsed.beliefs)
        ? coreParsed.beliefs
          .filter((item): item is Record<string, unknown> => isPlainObject(item) && item.status === 'accepted')
          .map((item) => structuredClone(item))
        : []

      const data: Record<string, unknown> = {
        ...(coreParsed.traits !== undefined ? { traits: structuredClone(coreParsed.traits) } : {}),
        ...(coreParsed.character !== undefined ? { character: structuredClone(coreParsed.character) } : {}),
        ...(coreParsed.manifests !== undefined ? { manifests: structuredClone(coreParsed.manifests) } : {}),
        ...(coreParsed.prefs !== undefined ? { prefs: structuredClone(coreParsed.prefs) } : {}),
        beliefs: acceptedBeliefs,
        legacyRole: selectedRole,
        legacyImportHash: coreHash,
      }
      const stable = buildStableSummary(selectedRole, coreParsed, acceptedBeliefs)

      if (params.dryRun) {
        await ensurePersonaAnchor(coreHash)
        l3SelfCommitted = true
      } else {
        const anchorRef = await ensurePersonaAnchor(coreHash)
        await params.profiles.commit({
          stable,
          data,
          evidence: [anchorRef],
          author: 'owner',
        })
        l3SelfCommitted = true
      }
    }
  }

  let l3PersonsImported = 0
  if (peopleRaw !== null) {
    let peopleParsed: unknown
    try {
      peopleParsed = JSON.parse(peopleRaw)
    } catch {
      throw invalidArgument('invalid legacy persona people.json')
    }
    if (!isPlainObject(peopleParsed)) {
      throw invalidArgument('invalid legacy persona people.json')
    }

    const rawPeopleMap = isPlainObject(peopleParsed.people) ? peopleParsed.people : peopleParsed
    const sortedQqIds = Object.keys(rawPeopleMap).filter(isDigits).sort()
    const peopleHash = sha256Hex(peopleRaw)

    for (const qqId of sortedQqIds) {
      const entry = rawPeopleMap[qqId]
      if (!isPlainObject(entry)) continue

      const personId = await params.resolveAccount(`qq:${qqId}`)
      const l1EvidenceIds = params.l1IdsBySubject.get(personId)
      const evidence: readonly EvidenceRef[] = l1EvidenceIds !== undefined && l1EvidenceIds.length > 0
        ? l1EvidenceIds.slice(0, 5).map((id) => ({ id }))
        : [await ensurePersonaAnchor(coreHash ?? peopleHash)]

      if (params.dryRun) {
        l3PersonsImported += 1
        continue
      }

      const identity: Record<string, PersonAttributeEntry> = {}
      mergeSection(identity, entry.identity, params.now)
      if (entry.name !== undefined) identity.name = makeAttribute(entry.name, params.now)
      if (entry.nickname !== undefined) identity.nickname = makeAttribute(entry.nickname, params.now)

      const preferences: Record<string, PersonAttributeEntry> = {}
      mergeSection(preferences, entry.preferences, params.now)
      if (entry.offsets !== undefined) preferences.offsets = makeAttribute(entry.offsets, params.now)
      if (entry.jokes !== undefined) preferences.jokes = makeAttribute(entry.jokes, params.now)

      const relationships: Record<string, PersonAttributeEntry> = {}
      mergeSection(relationships, entry.relationships, params.now)
      if (entry.intimacy !== undefined) relationships.intimacy = makeAttribute(entry.intimacy, params.now)
      if (entry.trust !== undefined) relationships.trust = makeAttribute(entry.trust, params.now)
      if (entry.familiarity !== undefined) relationships.familiarity = makeAttribute(entry.familiarity, params.now)
      if (entry.beliefs !== undefined) relationships.beliefs = makeAttribute(entry.beliefs, params.now)

      const entryHash = sha256Hex(stableStringify(entry)).slice(0, 16)
      const idempotencyKey = `legacy:l3:person:${selectedRole}:${qqId}:${entryHash}`

      const record: NewRecord = {
        layer: 'L3',
        kind: 'l3.person',
        source: 'legacy-import',
        channel: `kernel:person:${personId}`,
        subjects: [personId],
        actor: 'owner',
        content: {
          personId,
          identity,
          preferences,
          relationships,
          history: [],
          legacy: true,
          legacyRole: selectedRole,
        },
        evidence,
        visibility: 'subject',
        trust: 'owner',
        confidence: 0.9,
        importance: 0.8,
        tEvent: params.now,
      }

      const stored = await params.store.insert(record, idempotencyKey)
      if (!params.existingIds.has(stored.id)) {
        params.existingIds.add(stored.id)
        l3PersonsImported += 1
        if (params.index !== undefined) await params.index.add(stored)
      }
    }
  }

  return {
    role: selectedRole,
    ...(coreHash === undefined ? {} : { coreHash }),
    l3SelfCommitted,
    l3PersonsImported,
    anchorRecordsCreated,
  }
}
