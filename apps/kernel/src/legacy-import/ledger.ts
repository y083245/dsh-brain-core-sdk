import { lstat } from 'node:fs/promises'
import path from 'node:path'
import type { EvidenceRef, Visibility } from '@brain-core/sdk'
import type { KeywordIndex, NewRecord, RecordStore } from '../contracts/index.ts'
import {
  addL1SubjectId, errorCode, invalidArgument, isDigits, isPlainObject, type L0MatchCandidate, parseTimestamp,
  readRegularFileIfExists, sha256Hex,
} from './helpers.ts'

const SOURCE_KEY_PATTERN = /^(private|group):(\d+)$/
const EVIDENCE_WINDOW_MS = 86_400_000

export interface LedgerImportResult {
  readonly l1Imported: number
  readonly l1Skipped: number
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

function findMatchingL0(
  candidates: readonly L0MatchCandidate[] | undefined,
  tEvent: number,
  personId: string,
): L0MatchCandidate | undefined {
  if (candidates === undefined || candidates.length === 0) return undefined
  let best: L0MatchCandidate | undefined
  let bestSameActor = false
  let bestDiff = Infinity

  for (const candidate of candidates) {
    const diff = Math.abs(candidate.tEvent - tEvent)
    if (diff > EVIDENCE_WINDOW_MS) continue
    const sameActor = candidate.actor === personId
    if (best === undefined) {
      best = candidate
      bestSameActor = sameActor
      bestDiff = diff
      continue
    }
    if (sameActor !== bestSameActor) {
      if (sameActor) {
        best = candidate
        bestSameActor = true
        bestDiff = diff
      }
      continue
    }
    if (diff < bestDiff) {
      best = candidate
      bestDiff = diff
      continue
    }
    if (diff === bestDiff) {
      if (candidate.tEvent < best.tEvent || (candidate.tEvent === best.tEvent && candidate.id < best.id)) {
        best = candidate
      }
    }
  }
  return best
}

function mapLedgerKind(cat: unknown): 'l1.fact' | 'l1.event' | 'l1.promise' {
  if (cat === 'event') return 'l1.event'
  if (cat === 'pending') return 'l1.promise'
  return 'l1.fact'
}

function mapLedgerChannel(sourceKey: unknown, qqId: string): string {
  if (typeof sourceKey === 'string') {
    const match = SOURCE_KEY_PATTERN.exec(sourceKey.trim())
    if (match !== null) return `qq:${match[1]}:${match[2]}`
  }
  return `qq:private:${qqId}`
}

function hasFlagOrTimestamp(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '' && value !== false
}

/**
 * Imports read-only legacy people ledger items (`<fromDir>/long-memory/people.json`) into L1 records,
 * enforcing RFC M1 evidence by matching nearby L0 archive records or synthesizing `legacy.ledger_snapshot` L0 anchors.
 */
export async function importPeopleLedger(params: {
  readonly fromDir: string
  readonly dryRun: boolean
  readonly now: number
  readonly store: RecordStore
  readonly index?: KeywordIndex
  readonly resolveAccount: (account: string) => Promise<string>
  readonly existingIds: Set<string>
  readonly l0ByChannel: Map<string, L0MatchCandidate[]>
  readonly l1IdsBySubject: Map<string, string[]>
}): Promise<LedgerImportResult> {
  const longMemoryDir = path.join(params.fromDir, 'long-memory')
  if (!(await isSafeDirectory(longMemoryDir))) {
    return { l1Imported: 0, l1Skipped: 0, anchorRecordsCreated: 0 }
  }

  const peopleFile = path.join(longMemoryDir, 'people.json')
  const rawContent = await readRegularFileIfExists(peopleFile)
  if (rawContent === null) {
    return { l1Imported: 0, l1Skipped: 0, anchorRecordsCreated: 0 }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawContent)
  } catch {
    throw invalidArgument('invalid legacy long-memory/people.json')
  }
  if (!isPlainObject(parsed)) {
    throw invalidArgument('invalid legacy long-memory/people.json')
  }
  if (parsed.people !== undefined && !isPlainObject(parsed.people)) {
    throw invalidArgument('invalid legacy long-memory/people.json: people must be an object')
  }

  const ledgerSha256 = sha256Hex(rawContent)
  const peopleMap = isPlainObject(parsed.people) ? parsed.people : {}
  const sortedQqIds = Object.keys(peopleMap).filter(isDigits).sort()

  const anchorCache = new Map<string, string>()
  let l1Imported = 0
  let l1Skipped = 0
  let anchorRecordsCreated = 0

  async function ensureLedgerAnchor(channel: string): Promise<EvidenceRef> {
    const cached = anchorCache.get(channel)
    if (cached !== undefined) return { id: cached }

    if (params.dryRun) {
      const virtualId = `dry:anchor:${channel}`
      anchorCache.set(channel, virtualId)
      anchorRecordsCreated += 1
      return { id: virtualId }
    }

    const anchorKey = `legacy:anchor:ledger:${channel}:${ledgerSha256.slice(0, 16)}`
    const anchorRecord: NewRecord = {
      layer: 'L0',
      kind: 'legacy.ledger_snapshot',
      source: 'legacy-import',
      channel,
      subjects: ['self'],
      actor: 'owner',
      content: {
        text: '旧版账本导入溯源锚点（原系统无对应聊天存档）',
        legacy: true,
        legacySource: 'long-memory/people.json',
        ledgerSha256,
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
    anchorCache.set(channel, stored.id)
    return { id: stored.id }
  }

  for (const qqId of sortedQqIds) {
    const personEntry = peopleMap[qqId]
    if (!isPlainObject(personEntry) || !Array.isArray(personEntry.items)) continue

    const personId = await params.resolveAccount(`qq:${qqId}`)

    for (const item of personEntry.items) {
      if (!isPlainObject(item) || typeof item.text !== 'string' || item.text.trim() === '') {
        l1Skipped += 1
        continue
      }

      const channel = mapLedgerChannel(item.sourceKey, qqId)
      const tEvent = parseTimestamp(item.at) ?? params.now
      const matchedL0 = findMatchingL0(params.l0ByChannel.get(channel), tEvent, personId)
      const evidence: readonly EvidenceRef[] = matchedL0 !== undefined
        ? [{ id: matchedL0.id }]
        : [await ensureLedgerAnchor(channel)]

      if (params.dryRun) {
        l1Imported += 1
        continue
      }

      const kind = mapLedgerKind(item.cat)
      const visibility: Visibility = item.scope === 'private' ? 'origin' : 'open'
      const rawId = item.id !== undefined && item.id !== null && String(item.id) !== '' ? String(item.id) : ''
      const rawCat = typeof item.cat === 'string' ? item.cat : ''
      const keySuffix = rawId !== ''
        ? rawId
        : sha256Hex(`${rawCat}|${item.text}|${String(item.at ?? '')}|${String(item.sourceKey ?? '')}`).slice(0, 16)
      const idempotencyKey = `legacy:l1:${qqId}:${keySuffix}`

      const content: Record<string, unknown> = {
        text: item.text,
        legacy: true,
        ...(rawCat !== '' ? { legacyCat: rawCat } : {}),
        ...(rawId !== '' ? { legacyId: rawId } : {}),
        ...(item.core === true ? { core: true } : {}),
        ...(item.due !== undefined && item.due !== null && item.due !== '' ? { due: item.due } : {}),
        ...(item.by !== undefined && item.by !== null && item.by !== '' ? { by: item.by } : {}),
        ...(item.status !== undefined && item.status !== null && item.status !== '' ? { promiseStatus: item.status } : {}),
      }

      const record: NewRecord = {
        layer: 'L1',
        kind,
        source: 'legacy-import',
        channel,
        subjects: [personId],
        actor: 'owner',
        content,
        evidence,
        visibility,
        trust: 'owner',
        confidence: 0.85,
        importance: item.core === true ? 0.9 : 0.6,
        tEvent,
      }

      const stored = await params.store.insert(record, idempotencyKey)
      const isNew = !params.existingIds.has(stored.id)
      if (isNew) {
        params.existingIds.add(stored.id)
        l1Imported += 1
      }

      const hasOutdated = hasFlagOrTimestamp(item.outdatedAt)
      const hasArchived = hasFlagOrTimestamp(item.archivedAt)
      let finalRecord = stored

      if ((hasOutdated || hasArchived) && stored.status === 'active') {
        const nextStatus = hasOutdated ? 'outdated' : 'archived'
        const validTo = parseTimestamp(hasOutdated ? item.outdatedAt : item.archivedAt)
        finalRecord = await params.store.patch(
          stored.id,
          { status: nextStatus, ...(validTo !== undefined ? { validTo } : {}) },
          stored.version,
        )
        if (params.index !== undefined) await params.index.remove(finalRecord.id)
      } else if (isNew && finalRecord.status === 'active') {
        if (params.index !== undefined) await params.index.add(finalRecord)
      }

      if (finalRecord.status === 'active') {
        addL1SubjectId(params.l1IdsBySubject, personId, finalRecord.id)
      }
    }
  }

  return { l1Imported, l1Skipped, anchorRecordsCreated }
}
