import { constants as fsConstants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import path from 'node:path'
import { ensurePrivateDir, writeFileAtomic } from '@brain-core/shared'
import type {
  Clock, KeywordIndex, LegacyImportMode, LegacyImportOptions, LegacyImportReport, RecordStore,
} from '../contracts/index.ts'
import type { IdentityService, ProfileStore } from '../identity-persona/index.ts'
import { importChatArchives } from './archive.ts'
import {
  addL0Candidate, addL1SubjectId, errorCode, invalidArgument, isAnchorKind, type L0MatchCandidate, notFound,
  recordToCandidate,
} from './helpers.ts'
import { importPeopleLedger } from './ledger.ts'
import { importPersona } from './persona.ts'

export type { LegacyImportMode, LegacyImportOptions, LegacyImportReport } from '../contracts/index.ts'

export interface LegacyImporterDeps {
  readonly store: RecordStore
  readonly index?: KeywordIndex
  readonly identity: IdentityService
  readonly profiles: ProfileStore
  readonly clock: Clock
  /** Path to state/memory/import-choice.json (0600) for recording fresh mode & idempotent L3 import markers. */
  readonly choiceFile: string
}

const VALID_MODES = new Set<LegacyImportMode>(['all', 'memory', 'fresh'])

async function assertReadableDirectory(dirPath: string): Promise<void> {
  let statResult
  try {
    statResult = await stat(dirPath)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      throw notFound(`legacy fromDir not found: ${dirPath}`)
    }
    throw invalidArgument(`cannot inspect legacy fromDir: ${dirPath}`)
  }
  if (!statResult.isDirectory()) {
    throw invalidArgument('fromDir must be a directory')
  }
  try {
    await access(dirPath, fsConstants.R_OK)
  } catch {
    throw invalidArgument(`legacy fromDir is not readable: ${dirPath}`)
  }
}

async function writeChoiceFile(choiceFile: string, payload: Readonly<Record<string, unknown>>): Promise<void> {
  const dir = path.dirname(choiceFile)
  if (dir !== '.' && dir !== '') await ensurePrivateDir(dir)
  await writeFileAtomic(choiceFile, JSON.stringify(payload, null, 2))
}

/**
 * Creates the Clean-Room read-only legacy `dsh-memory-brain` data importer (FR-X02, RFC §14 / M1).
 * Never mutates anything inside `fromDir`.
 */
export function createLegacyImporter(deps: LegacyImporterDeps): {
  importFrom(options: LegacyImportOptions): Promise<LegacyImportReport>
} {
  return {
    async importFrom(options: LegacyImportOptions): Promise<LegacyImportReport> {
      if (options === null || options === undefined || typeof options !== 'object') {
        throw invalidArgument('options must be an object')
      }
      if (!VALID_MODES.has(options.mode)) {
        throw invalidArgument('mode must be all, memory or fresh')
      }
      if (typeof options.fromDir !== 'string' || options.fromDir.trim() === '') {
        throw invalidArgument('fromDir must be a non-empty string')
      }

      const dryRun = options.dryRun === true
      const now = deps.clock.now()

      if (options.mode === 'fresh') {
        if (!dryRun) {
          await writeChoiceFile(deps.choiceFile, {
            version: 1,
            mode: 'fresh',
            fromDir: options.fromDir,
            chosenAt: now,
          })
        }
        return {
          mode: 'fresh',
          dryRun,
          l0Imported: 0,
          l0Skipped: 0,
          l1Imported: 0,
          l1Skipped: 0,
          l3SelfCommitted: false,
          l3PersonsImported: 0,
          anchorRecordsCreated: 0,
        }
      }

      await assertReadableDirectory(options.fromDir)

      const existingIds = new Set<string>()
      const l0ByChannel = new Map<string, L0MatchCandidate[]>()
      const l1IdsBySubject = new Map<string, string[]>()

      for await (const record of deps.store.scan(['L0', 'L1', 'L3'])) {
        existingIds.add(record.id)
        if (record.layer === 'L0' && record.status === 'active' && !isAnchorKind(record.kind)) {
          addL0Candidate(l0ByChannel, record.channel, recordToCandidate(record))
        } else if (record.layer === 'L1' && record.status === 'active') {
          for (const subject of record.subjects) {
            addL1SubjectId(l1IdsBySubject, subject, record.id)
          }
        }
      }

      const resolvedAccounts = new Map<string, string>()
      const resolveAccount = async (account: string): Promise<string> => {
        const cached = resolvedAccounts.get(account)
        if (cached !== undefined) return cached
        const personId = dryRun ? `dry:${account}` : await deps.identity.resolve(account)
        resolvedAccounts.set(account, personId)
        return personId
      }

      const archiveRes = await importChatArchives({
        fromDir: options.fromDir,
        dryRun,
        store: deps.store,
        ...(deps.index === undefined ? {} : { index: deps.index }),
        resolveAccount,
        existingIds,
        l0ByChannel,
      })

      const ledgerRes = await importPeopleLedger({
        fromDir: options.fromDir,
        dryRun,
        now,
        store: deps.store,
        ...(deps.index === undefined ? {} : { index: deps.index }),
        resolveAccount,
        existingIds,
        l0ByChannel,
        l1IdsBySubject,
      })

      let l3SelfCommitted = false
      let l3PersonsImported = 0
      let anchorRecordsCreated = ledgerRes.anchorRecordsCreated

      if (options.mode === 'all') {
        const personaRes = await importPersona({
          fromDir: options.fromDir,
          ...(options.role === undefined ? {} : { role: options.role }),
          dryRun,
          now,
          store: deps.store,
          ...(deps.index === undefined ? {} : { index: deps.index }),
          profiles: deps.profiles,
          resolveAccount,
          existingIds,
          l1IdsBySubject,
        })
        l3SelfCommitted = personaRes.l3SelfCommitted
        l3PersonsImported = personaRes.l3PersonsImported
        anchorRecordsCreated += personaRes.anchorRecordsCreated

        if (!dryRun) {
          await writeChoiceFile(deps.choiceFile, {
            version: 1,
            mode: 'all',
            fromDir: options.fromDir,
            ...(personaRes.role === undefined ? {} : { role: personaRes.role }),
            ...(personaRes.coreHash === undefined ? {} : { coreHash: personaRes.coreHash }),
            chosenAt: now,
          })
        }
      }

      return {
        mode: options.mode,
        dryRun,
        l0Imported: archiveRes.l0Imported,
        l0Skipped: archiveRes.l0Skipped,
        l1Imported: ledgerRes.l1Imported,
        l1Skipped: ledgerRes.l1Skipped,
        l3SelfCommitted,
        l3PersonsImported,
        anchorRecordsCreated,
      }
    },
  }
}
