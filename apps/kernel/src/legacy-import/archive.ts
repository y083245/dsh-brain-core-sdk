import { lstat } from 'node:fs/promises'
import path from 'node:path'
import type { Trust, Visibility } from '@dsh-brain-core/sdk'
import type { KeywordIndex, NewRecord, RecordStore } from '../contracts/index.ts'
import {
  addL0Candidate, errorCode, isDigits, isPlainObject, type L0MatchCandidate, listSafeEntries, parseTimestamp,
  readRegularFileIfExists, recordToCandidate, sha256Hex, stableStringify,
} from './helpers.ts'

const CHANNEL_DIR_PATTERN = /^(private|group)_(\d+)$/
const ARCHIVE_FILE_PATTERN = /^\d{4}-\d{2}\.jsonl$/

export interface ArchiveImportResult {
  readonly l0Imported: number
  readonly l0Skipped: number
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

/**
 * Imports read-only legacy chat archives (`<fromDir>/long-memory/archive/<private|group>_<digits>/<YYYY-MM>.jsonl`)
 * into L0 memory records, populating `l0ByChannel` for downstream L1 M1 evidence linking.
 */
export async function importChatArchives(params: {
  readonly fromDir: string
  readonly dryRun: boolean
  readonly store: RecordStore
  readonly index?: KeywordIndex
  readonly resolveAccount: (account: string) => Promise<string>
  readonly existingIds: Set<string>
  readonly l0ByChannel: Map<string, L0MatchCandidate[]>
}): Promise<ArchiveImportResult> {
  const longMemoryDir = path.join(params.fromDir, 'long-memory')
  if (!(await isSafeDirectory(longMemoryDir))) {
    return { l0Imported: 0, l0Skipped: 0 }
  }

  const archiveRoot = path.join(longMemoryDir, 'archive')
  const channelDirs = await listSafeEntries(archiveRoot)
  let l0Imported = 0
  let l0Skipped = 0

  for (const dirEntry of channelDirs) {
    if (!dirEntry.isDirectory()) continue
    const dirMatch = CHANNEL_DIR_PATTERN.exec(dirEntry.name)
    if (dirMatch === null) continue

    const kind = dirMatch[1] as 'private' | 'group'
    const digits = dirMatch[2] as string
    const channel = `qq:${kind}:${digits}`
    const visibility: Visibility = kind === 'private' ? 'subject' : 'open'
    const channelDirPath = path.join(archiveRoot, dirEntry.name)
    const fileEntries = await listSafeEntries(channelDirPath)

    let peerPersonId: string | undefined
    const getPeerPersonId = async (): Promise<string> => {
      if (peerPersonId === undefined) {
        peerPersonId = await params.resolveAccount(`qq:${digits}`)
      }
      return peerPersonId
    }

    for (const fileEntry of fileEntries) {
      if (!fileEntry.isFile() || !ARCHIVE_FILE_PATTERN.test(fileEntry.name)) continue
      const filePath = path.join(channelDirPath, fileEntry.name)
      const rawContent = await readRegularFileIfExists(filePath)
      if (rawContent === null) continue

      const lines = rawContent.split(/\r?\n/)
      for (let i = 0; i < lines.length; i += 1) {
        const trimmed = (lines[i] as string).trim()
        if (trimmed === '') continue
        const lineNumber = i + 1

        let parsed: unknown
        try {
          parsed = JSON.parse(trimmed)
        } catch {
          l0Skipped += 1
          continue
        }
        if (!isPlainObject(parsed)) {
          l0Skipped += 1
          continue
        }
        if (parsed.tombstoned === true || typeof parsed.text !== 'string' || parsed.text.trim() === '') {
          l0Skipped += 1
          continue
        }
        const tEvent = parseTimestamp(parsed.t)
        if (tEvent === undefined) {
          l0Skipped += 1
          continue
        }

        const isOutbound = parsed.dir === 'out'
        let actor: string
        let trust: Trust
        let subjects: readonly string[]

        if (isOutbound) {
          actor = 'self'
          trust = 'self'
          if (kind === 'private') {
            const peer = await getPeerPersonId()
            subjects = peer === 'self' ? ['self'] : ['self', peer]
          } else {
            subjects = ['self']
          }
        } else {
          trust = 'member'
          const rawUserId = parsed.userId !== null && parsed.userId !== undefined ? String(parsed.userId).trim() : ''
          if (rawUserId !== '' && isDigits(rawUserId)) {
            actor = await params.resolveAccount(`qq:${rawUserId}`)
          } else if (kind === 'private') {
            actor = await getPeerPersonId()
          } else {
            actor = 'qq:unknown'
          }
          subjects = kind === 'private' ? [await getPeerPersonId()] : [actor]
        }

        if (params.dryRun) {
          l0Imported += 1
          addL0Candidate(params.l0ByChannel, channel, { id: 'dry', tEvent, actor })
          continue
        }

        const content: Record<string, unknown> = {
          text: parsed.text,
          direction: isOutbound ? 'outbound' : 'inbound',
          legacy: true,
          legacyKey: `${kind}:${digits}`,
          ...(parsed.msgId ? { msgId: String(parsed.msgId) } : {}),
          ...(parsed.name ? { name: String(parsed.name) } : {}),
        }
        const record: NewRecord = {
          layer: 'L0',
          kind: 'qq.message',
          source: 'qq',
          channel,
          subjects,
          actor,
          content,
          evidence: [],
          visibility,
          trust,
          confidence: 1,
          importance: 0.5,
          tEvent,
        }
        const idempotencyKey = `legacy:l0:${dirEntry.name}:${fileEntry.name}:${lineNumber}:${sha256Hex(stableStringify(parsed)).slice(0, 16)}`
        const stored = await params.store.insert(record, idempotencyKey)
        if (!params.existingIds.has(stored.id)) {
          params.existingIds.add(stored.id)
          l0Imported += 1
          if (params.index !== undefined) await params.index.add(stored)
        }
        addL0Candidate(params.l0ByChannel, channel, recordToCandidate(stored))
      }
    }
  }

  return { l0Imported, l0Skipped }
}
