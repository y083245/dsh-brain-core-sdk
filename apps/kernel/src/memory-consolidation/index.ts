import { BrainError, type EvidenceRef, type MemoryRecord } from '@dsh-brain-core/sdk'
import { createUlid } from '@dsh-brain-core/shared'
import type {
  Clock, ConsolidationApplyReport, ConsolidationApproveOptions, ConsolidationEngine, ConsolidationProposal,
  KeywordIndex, LlmClient, NewRecord, RecordStore,
} from '../contracts/index.ts'
import type { ProfileStore, ProfileVersionDetail } from '../identity-persona/index.ts'
import { buildMemoryCatalog, upsertCatalogInStable } from './catalog.ts'
import {
  assertValidWindow, type BudgetTracker, filterValidEvidence, hasOwn, isPlainObject, listAll,
} from './helpers.ts'
import { induceL2AndCorrections } from './induce-l2.ts'
import { detectSelfConflicts } from './self-check.ts'
import { settleL3 } from './settle-l3.ts'
import { createConsolidationStateStore } from './state-store.ts'

export {
  buildMemoryCatalog,
  CATALOG_END,
  CATALOG_START,
  MAX_CATALOG_CHARS,
  type MemoryCatalog,
  upsertCatalogInStable,
} from './catalog.ts'

export interface ConsolidationEngineDeps {
  readonly store: RecordStore
  readonly index?: KeywordIndex
  readonly profiles: ProfileStore
  readonly llm: LlmClient
  readonly clock: Clock
  readonly stateFile?: string
  readonly dailyTokenCap?: number
  readonly maxOutputTokens?: number
  readonly minNewEvidence?: number
}

const DEFAULT_DAILY_TOKEN_CAP = 200_000
const DEFAULT_MAX_OUTPUT_TOKENS = 4_000
const DEFAULT_MIN_NEW_EVIDENCE = 2

function readLockedKeys(detail: ProfileVersionDetail | undefined): readonly string[] {
  if (detail === undefined) return []
  if (detail.ownerLockedKeys !== undefined) return [...detail.ownerLockedKeys].sort()
  if (detail.author === 'owner') return Object.keys(detail.data).sort()
  return []
}

function readPersonLockedKeys(record: MemoryRecord | undefined): readonly string[] {
  if (record === undefined) return []
  const raw = record.content.ownerLockedKeys
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is string => typeof item === 'string').sort()
}

export function createConsolidationEngine(deps: ConsolidationEngineDeps): ConsolidationEngine {
  const dailyTokenCap = deps.dailyTokenCap ?? DEFAULT_DAILY_TOKEN_CAP
  const maxOutputTokens = deps.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  const minNewEvidence = deps.minNewEvidence ?? DEFAULT_MIN_NEW_EVIDENCE
  const nextId = createUlid({ now: () => deps.clock.now() })
  const state = createConsolidationStateStore({
    clock: deps.clock,
    ...(deps.stateFile === undefined ? {} : { stateFile: deps.stateFile }),
  })

  async function archiveOutdatedL3(kind: 'l3.self' | 'l3.person', personId?: string): Promise<void> {
    const filter = personId === undefined
      ? { layers: ['L3'] as const, kinds: [kind], statuses: ['outdated'] as const }
      : { layers: ['L3'] as const, kinds: [kind], statuses: ['outdated'] as const, subjects: [personId] }
    const outdated = await listAll(deps.store, filter)
    for (const record of outdated) {
      await deps.store.patch(record.id, { status: 'archived' }, record.version)
      if (deps.index !== undefined) await deps.index.remove(record.id)
    }
  }

  return {
    runShadow(options): Promise<ConsolidationProposal> {
      return state.withLock(async () => {
        const now = deps.clock.now()
        const watermark = await state.getWatermark()
        const from = options?.from ?? watermark
        const to = options?.to ?? now
        assertValidWindow(from, to)

        const window = { from, to }
        let usedToday = await state.getUsedTokensToday(now)
        let runTokens = 0
        let capped = usedToday >= dailyTokenCap

        const budget: BudgetTracker = {
          canCall: () => !capped && usedToday < dailyTokenCap,
          consume: async (tokens: number) => {
            const delta = Math.max(0, tokens)
            runTokens += delta
            usedToday = await state.addTokens(delta, deps.clock.now())
            if (usedToday >= dailyTokenCap) {
              capped = true
            }
          },
          used: () => runTokens,
          isCapped: () => capped,
        }

        const selfConflicts = await detectSelfConflicts({
          store: deps.store,
          llm: deps.llm,
          budget,
          maxOutputTokens,
          nextId,
        })

        const l2Result = await induceL2AndCorrections({
          store: deps.store,
          llm: deps.llm,
          budget,
          window,
          maxOutputTokens,
          nextId,
        })

        const l3Result = await settleL3({
          store: deps.store,
          profiles: deps.profiles,
          llm: deps.llm,
          budget,
          window,
          force: options?.force === true,
          minNewEvidence,
          maxOutputTokens,
          now,
        })
        if (l3Result.capped === true) {
          capped = true
        }

        const proposal: ConsolidationProposal = {
          id: `prop_${nextId()}`,
          status: 'pending',
          createdAt: now,
          window,
          tokensUsed: runTokens,
          l2Candidates: l2Result.l2Candidates,
          corrections: l2Result.corrections,
          selfConflicts,
          l3SelfPatch: l3Result.l3SelfPatch,
          l3PersonPatches: l3Result.l3PersonPatches,
          ...(l3Result.skippedL3Reason === undefined ? {} : { skippedL3Reason: l3Result.skippedL3Reason }),
        }

        // Watermark advances ONLY when runShadow finishes completely without error and without hitting dailyTokenCap.
        await state.saveProposal(proposal, capped ? undefined : to)
        return proposal
      })
    },

    listProposals(status): Promise<readonly ConsolidationProposal[]> {
      return state.withLock(() => state.listProposals(status))
    },

    getProposal(id): Promise<ConsolidationProposal | null> {
      return state.withLock(() => state.getProposal(id))
    },

    approveProposal(id: string, options?: ConsolidationApproveOptions): Promise<ConsolidationApplyReport> {
      return state.withLock(async () => {
        const proposal = await state.getProposal(id)
        if (proposal === null) throw new BrainError('NOT_FOUND', `proposal ${id} not found`)
        if (proposal.status !== 'pending') {
          throw new BrainError('CONFLICT', `proposal ${id} is already ${proposal.status}`)
        }

        // Validate conflict resolution choices before mutating storage.
        for (const conflict of proposal.selfConflicts) {
          const override = options?.conflictKeepIds?.[conflict.id]
          if (override !== undefined && override !== conflict.recordAId && override !== conflict.recordBId) {
            throw new BrainError(
              'INVALID_ARGUMENT',
              `conflictKeepIds[${conflict.id}] must be ${conflict.recordAId} or ${conflict.recordBId}`,
            )
          }
        }

        const now = deps.clock.now()
        let l2Created = 0
        let correctionsApplied = 0
        let conflictsResolved = 0
        let newProfileVersion: number | undefined
        let personsUpdated = 0

        // 1. Insert L2 candidates and index them.
        const shadowIdToRecordId = new Map<string, string>()
        for (const candidate of proposal.l2Candidates) {
          const validEvidence = await filterValidEvidence(deps.store, candidate.evidence)
          if (validEvidence.length === 0) continue

          const newL2: NewRecord = {
            layer: 'L2',
            kind: candidate.kind,
            source: 'kernel',
            actor: 'kernel',
            channel: candidate.channel,
            subjects: [...candidate.subjects],
            content: structuredClone(candidate.content),
            evidence: validEvidence,
            visibility: candidate.visibility,
            trust: 'self',
            confidence: candidate.confidence,
            importance: candidate.importance,
            tEvent: now,
          }
          const stored = await deps.store.insert(newL2)
          shadowIdToRecordId.set(candidate.id, stored.id)
          if (deps.index !== undefined) await deps.index.add(stored)
          l2Created += 1
        }

        // 2. Apply corrections (promote-candidate, supersede-fact, close-topic).
        for (const correction of proposal.corrections) {
          const target = await deps.store.get(correction.targetId)
          if (target === null || target.status !== 'active') continue

          if (correction.action === 'promote-candidate') {
            const rawContent = isPlainObject(correction.replacementContent)
              ? { ...correction.replacementContent }
              : { ...target.content }
            const mergedIds = Array.isArray(rawContent.mergedCandidateIds)
              ? rawContent.mergedCandidateIds.filter((item): item is string => typeof item === 'string')
              : []
            delete rawContent.mergedCandidateIds
            delete rawContent.duplicateOf
            rawContent.kind = 'l1.fact'

            const validEvidence = await filterValidEvidence(
              deps.store,
              correction.evidence.length > 0 ? correction.evidence : target.evidence,
            )
            if (validEvidence.length > 0) {
              const promoted: NewRecord = {
                layer: 'L1',
                kind: 'l1.fact',
                source: 'kernel',
                actor: 'kernel',
                channel: target.channel,
                subjects: [...target.subjects],
                content: rawContent,
                evidence: validEvidence,
                visibility: target.visibility,
                trust: target.trust,
                confidence: Math.max(target.confidence, 0.85),
                importance: target.importance,
                tEvent: target.tEvent,
              }
              const stored = await deps.store.insert(promoted)
              if (deps.index !== undefined) await deps.index.add(stored)
            }

            await deps.store.patch(target.id, { status: 'archived' }, target.version)
            if (deps.index !== undefined) await deps.index.remove(target.id)
            for (const otherId of mergedIds) {
              const other = await deps.store.get(otherId)
              if (other !== null && other.status === 'active') {
                await deps.store.patch(other.id, { status: 'archived' }, other.version)
                if (deps.index !== undefined) await deps.index.remove(other.id)
              }
            }
            correctionsApplied += 1
          } else if (correction.action === 'supersede-fact') {
            // RFC M10: historical events are never superseded or marked outdated.
            if (target.kind === 'l1.event') continue
            await deps.store.patch(target.id, { status: 'outdated' }, target.version)
            if (deps.index !== undefined) await deps.index.remove(target.id)
            correctionsApplied += 1
          } else if (correction.action === 'close-topic') {
            const replacement = isPlainObject(correction.replacementContent) ? correction.replacementContent : {}
            const rawPromotedTo = typeof replacement.promotedTo === 'string' ? replacement.promotedTo : undefined
            const resolvedPromotedTo = rawPromotedTo !== undefined
              ? (shadowIdToRecordId.get(rawPromotedTo) ?? rawPromotedTo)
              : undefined
            const nextContent: Record<string, unknown> = {
              ...target.content,
              ...replacement,
              state: 'closed',
              ...(resolvedPromotedTo === undefined ? {} : { promotedTo: resolvedPromotedTo }),
            }
            const updated = await deps.store.patch(target.id, { content: nextContent }, target.version)
            if (deps.index !== undefined) await deps.index.add(updated)
            correctionsApplied += 1
          }
        }

        // 3. Apply L1.6 self-conflict resolutions.
        for (const conflict of proposal.selfConflicts) {
          const keepId = options?.conflictKeepIds?.[conflict.id] ?? conflict.recommendedKeepId ?? conflict.recordAId
          const dropId = keepId === conflict.recordAId ? conflict.recordBId : conflict.recordAId
          const dropRecord = await deps.store.get(dropId)
          if (dropRecord !== null && dropRecord.status === 'active') {
            await deps.store.patch(dropRecord.id, { status: 'outdated' }, dropRecord.version)
            if (deps.index !== undefined) await deps.index.remove(dropRecord.id)
            conflictsResolved += 1
          }
        }

        // 4. Commit L3 self patch with fresh owner-lock re-verification.
        if (proposal.l3SelfPatch !== null) {
          const latestSnapshot = await deps.profiles.current()
          const latestDetail = latestSnapshot.version > 0
            ? await deps.profiles.getVersion(latestSnapshot.version)
            : undefined
          const latestLocked = readLockedKeys(latestDetail)
          const mergedLocked = [...new Set([...proposal.l3SelfPatch.preservedOwnerKeys, ...latestLocked])].sort()

          const mergedData: Record<string, unknown> = structuredClone(proposal.l3SelfPatch.data)
          for (const key of mergedLocked) {
            if (latestDetail !== undefined && hasOwn(latestDetail.data, key)) {
              mergedData[key] = structuredClone(latestDetail.data[key])
            } else if (latestDetail !== undefined) {
              delete mergedData[key]
            }
          }
          const catalog = await buildMemoryCatalog(deps.store)
          if (!mergedLocked.includes('memoryCatalog')) {
            if (catalog.text !== '') {
              mergedData.memoryCatalog = {
                personKeys: catalog.personKeys,
                openTopics: catalog.openTopics,
              }
            } else {
              delete mergedData.memoryCatalog
            }
          }
          const stable = mergedLocked.includes('stable') && latestDetail !== undefined
            ? latestDetail.stable
            : upsertCatalogInStable(proposal.l3SelfPatch.stable, catalog.text)

          const validEvidence = await filterValidEvidence(deps.store, proposal.l3SelfPatch.evidence)
          if (validEvidence.length > 0) {
            newProfileVersion = await deps.profiles.commit({
              stable,
              data: mergedData,
              evidence: validEvidence,
              author: 'settlement',
              ...(mergedLocked.length > 0 ? { ownerLockedKeys: mergedLocked } : {}),
            })
            await archiveOutdatedL3('l3.self')
          }
        }

        // 5. Apply L3 person patches.
        for (const personPatch of proposal.l3PersonPatches) {
          const validEvidence = await filterValidEvidence(deps.store, personPatch.evidence)
          if (validEvidence.length === 0) continue

          const existingActive = await listAll(deps.store, {
            layers: ['L3'],
            kinds: ['l3.person'],
            statuses: ['active'],
            subjects: [personPatch.personId],
          })
          const latestExisting = existingActive[existingActive.length - 1]
          const latestLocked = readPersonLockedKeys(latestExisting)
          const mergedLocked = [...new Set([...personPatch.preservedOwnerKeys, ...latestLocked])].sort()

          const nextData = structuredClone(personPatch.data) as Record<string, unknown>
          if (latestExisting !== undefined) {
            for (const lockKey of mergedLocked) {
              const dot = lockKey.indexOf('.')
              if (dot !== -1) {
                const section = lockKey.slice(0, dot)
                const field = lockKey.slice(dot + 1)
                const existingSec = latestExisting.content[section]
                const targetSec = nextData[section]
                if (isPlainObject(existingSec) && isPlainObject(targetSec) && hasOwn(existingSec, field)) {
                  targetSec[field] = structuredClone(existingSec[field])
                }
              } else if (hasOwn(latestExisting.content, lockKey)) {
                nextData[lockKey] = structuredClone(latestExisting.content[lockKey])
              }
            }
          }

          const evidenceRecords: MemoryRecord[] = []
          for (const ref of validEvidence) {
            const rec = await deps.store.get(ref.id)
            if (rec !== null) evidenceRecords.push(rec)
          }
          const visibility = evidenceRecords.some((rec) => rec.visibility === 'internal')
            ? 'internal'
            : evidenceRecords.some((rec) => rec.visibility === 'owner')
              ? 'owner'
              : 'subject'

          for (const activeRec of existingActive) {
            await deps.store.patch(activeRec.id, { status: 'archived' }, activeRec.version)
            if (deps.index !== undefined) await deps.index.remove(activeRec.id)
          }
          await archiveOutdatedL3('l3.person', personPatch.personId)

          const content: Record<string, unknown> = {
            personId: personPatch.personId,
            ...nextData,
            ...(mergedLocked.length > 0 ? { ownerLockedKeys: mergedLocked } : {}),
          }
          const inserted = await deps.store.insert({
            layer: 'L3',
            kind: 'l3.person',
            source: 'kernel',
            actor: 'kernel',
            channel: `kernel:person:${personPatch.personId}`,
            subjects: [personPatch.personId],
            content,
            evidence: validEvidence,
            visibility,
            trust: 'self',
            confidence: 0.9,
            importance: 0.8,
            tEvent: now,
          })
          if (deps.index !== undefined) await deps.index.add(inserted)
          personsUpdated += 1
        }

        // 6. Mark proposal approved and persist.
        await state.updateProposal(id, (current) => ({
          ...current,
          status: 'approved',
          resolvedAt: now,
        }))

        return {
          proposalId: id,
          l2Created,
          correctionsApplied,
          conflictsResolved,
          ...(newProfileVersion === undefined ? {} : { newProfileVersion }),
          personsUpdated,
        }
      })
    },

    rejectProposal(id: string): Promise<ConsolidationProposal> {
      return state.withLock(async () => {
        const proposal = await state.getProposal(id)
        if (proposal === null) throw new BrainError('NOT_FOUND', `proposal ${id} not found`)
        if (proposal.status !== 'pending') {
          throw new BrainError('CONFLICT', `proposal ${id} is already ${proposal.status}`)
        }
        return state.updateProposal(id, (current) => ({
          ...current,
          status: 'rejected',
          resolvedAt: deps.clock.now(),
        }))
      })
    },

    budgetStatus(): Promise<{
      readonly usedTokensToday: number
      readonly dailyTokenCap: number
      readonly lastConsolidatedTo: number
    }> {
      return state.withLock(async () => {
        const [usedTokensToday, lastConsolidatedTo] = await Promise.all([
          state.getUsedTokensToday(deps.clock.now()),
          state.getWatermark(),
        ])
        return {
          usedTokensToday,
          dailyTokenCap,
          lastConsolidatedTo,
        }
      })
    },
  }
}

export type { EvidenceRef }
