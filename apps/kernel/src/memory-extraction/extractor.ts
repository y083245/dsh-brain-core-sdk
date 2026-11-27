import { createHash } from 'node:crypto'
import { TRUST_LEVELS, type MemoryRecord, type Trust } from '@dsh-brain-core/sdk'
import { scanInjection } from '@dsh-brain-core/shared'
import type { Clock, LlmClient, NewRecord, RecordFilter, RecordStore } from '../contracts/index.ts'
import { parseExtraction, isCompleteJson, keepGroundedFacts } from './parse.ts'
import { EXTRACTION_SYSTEM_PROMPT, buildUserPrompt } from './prompt.ts'
import type { ExtractedFact, ExtractionReport, ProcessedLog } from './types.ts'

const DAY_MS = 86_400_000
const PAGE_LIMIT = 1000
const MAX_KNOWN_KEYS = 100

/** The counters as they are built up; `runOnce` returns the readonly ExtractionReport. */
interface Counters {
  processed: number
  batches: number
  candidates: number
  promoted: number
  discardedBatches: number
  incompleteBatches: number
  parkedBatches: number
  droppedFacts: number
  injectedFacts: number
  tokens: number
  capped: boolean
}

async function listAll(store: RecordStore, filter: RecordFilter): Promise<MemoryRecord[]> {
  const records: MemoryRecord[] = []
  let cursor: string | undefined
  for (;;) {
    const page = cursor === undefined
      ? await store.list(filter, { limit: PAGE_LIMIT })
      : await store.list(filter, { limit: PAGE_LIMIT, cursor })
    records.push(...page.items)
    if (page.nextCursor === undefined) return records
    cursor = page.nextCursor
  }
}

function compareId(left: MemoryRecord, right: MemoryRecord): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

/** Split into batches that share one channel and one visibility, so a candidate is never wider than its source. */
function batchRecords(records: readonly MemoryRecord[], batchSize: number): MemoryRecord[][] {
  const groups = new Map<string, MemoryRecord[]>()
  for (const record of records) {
    const key = JSON.stringify([record.channel, record.visibility])
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [record])
    else group.push(record)
  }

  const ordered = [...groups.values()]
    .map((group) => group.sort(compareId))
    .sort((left, right) => compareId(left[0] as MemoryRecord, right[0] as MemoryRecord))

  const batches: MemoryRecord[][] = []
  for (const group of ordered) {
    for (let start = 0; start < group.length; start += batchSize) {
      batches.push(group.slice(start, start + batchSize))
    }
  }
  return batches
}

function lowestTrust(records: readonly MemoryRecord[]): Trust {
  let lowest: Trust = 'self'
  for (const record of records) {
    if (TRUST_LEVELS.indexOf(record.trust) > TRUST_LEVELS.indexOf(lowest)) lowest = record.trust
  }
  return lowest
}

function idempotencyKey(fact: ExtractedFact): string {
  const evidence = [...fact.evidence].sort().join(',')
  return `extraction:${createHash('sha256').update(`${evidence}\n${fact.text}`).digest('hex')}`
}

export function createExtractor(deps: {
  readonly store: RecordStore
  readonly llm: LlmClient
  readonly clock: Clock
  readonly processed: ProcessedLog
  readonly dailyTokenCap: number
  readonly maxOutputTokens: number
  readonly promoteConfidence?: number   // defaults to 0.8; a rule threshold, not a model setting
  readonly batchSize?: number           // defaults to 20
  readonly maxIncompleteAttempts?: number   // defaults to 3; a rule threshold, not a model setting
  /** The keyword index, when the kernel opened one; a failed add fails the run and is retried by idempotency. */
  readonly index?: { add(record: MemoryRecord): Promise<void> }
}): { runOnce(window: { readonly from: number; readonly to: number; readonly channel?: string }): Promise<ExtractionReport> } {
  const promoteConfidence = deps.promoteConfidence ?? 0.8
  const batchSize = deps.batchSize ?? 20
  const maxIncompleteAttempts = deps.maxIncompleteAttempts ?? 3

  /** L0 ids whose reply was incomplete, and how many times; only this extractor object sees them. */
  const incomplete = new Map<string, number>()
  /** L0 ids skipped until this extractor is recreated; a restart is the owner's cue to try again. */
  const parked = new Set<string>()

  let day = Math.floor(deps.clock.now() / DAY_MS)
  let tokensToday = 0

  /** Usage is kept per UTC day and only in this extractor; persistent accounting is v1.x model-accounting. */
  function syncDay(): void {
    const current = Math.floor(deps.clock.now() / DAY_MS)
    if (current !== day) {
      day = current
      tokensToday = 0
    }
  }

  /** Attribute names already held about the people in this batch, so the model reuses the same spelling. */
  async function knownKeys(batch: readonly MemoryRecord[]): Promise<readonly string[]> {
    const people = new Set<string>()
    for (const record of batch) {
      if (record.actor !== 'self') people.add(record.actor)
      for (const subject of record.subjects) {
        if (subject !== 'self') people.add(subject)
      }
    }
    if (people.size === 0) return []

    const existing = await listAll(deps.store, {
      layers: ['L1'],
      kinds: ['l1.fact'],
      statuses: ['active'],
      subjects: [...people],
    })
    const keys = new Set<string>()
    for (const record of existing) {
      if (record.visibility !== 'open' && record.visibility !== 'subject') continue
      if (typeof record.content.key === 'string') keys.add(record.content.key)
    }
    return [...keys].sort().slice(0, MAX_KNOWN_KEYS)
  }

  /**
   * An l1.fact with a key and value conflicts when an active one about the same people holds a different
   * value; when every existing one holds the same value the fact repeats an existing record.
   */
  async function compareExisting(fact: ExtractedFact): Promise<{ readonly conflict: boolean; readonly duplicateOf?: string }> {
    if (fact.kind !== 'l1.fact' || fact.key === undefined || fact.value === undefined) return { conflict: false }
    const existing = await listAll(deps.store, {
      layers: ['L1'],
      kinds: ['l1.fact'],
      statuses: ['active'],
      subjects: [...fact.subjects],
    })
    const sameKey = existing.filter((record) => record.content.key === fact.key)
    if (sameKey.some((record) => record.content.value !== fact.value)) return { conflict: true }
    if (sameKey.length > 0) return { conflict: false, duplicateOf: (sameKey[0] as MemoryRecord).id }
    return { conflict: false }
  }

  async function writeFact(fact: ExtractedFact, batch: readonly MemoryRecord[], report: Counters): Promise<void> {
    const byId = new Map(batch.map((record) => [record.id, record]))
    const evidenceRecords = fact.evidence.map((id) => byId.get(id) as MemoryRecord)
    const { conflict, duplicateOf } = await compareExisting(fact)
    const promoted = fact.confidence >= promoteConfidence && !conflict && duplicateOf === undefined

    const content: Record<string, unknown> = { text: fact.text, kind: fact.kind }
    if (fact.key !== undefined) content.key = fact.key
    if (fact.value !== undefined) content.value = fact.value
    if (fact.due !== undefined) {
      content.due = fact.due
      content.promiseStatus = 'pending'
    }
    if (duplicateOf !== undefined) content.duplicateOf = duplicateOf

    const record: NewRecord = {
      layer: 'L1',
      kind: promoted ? fact.kind : 'l1.candidate',
      source: 'kernel',
      channel: (batch[0] as MemoryRecord).channel,
      subjects: [...fact.subjects],
      actor: 'kernel',
      content,
      evidence: fact.evidence.map((id) => ({ id })),
      visibility: (batch[0] as MemoryRecord).visibility,
      trust: lowestTrust(evidenceRecords),
      confidence: fact.confidence,
      importance: 0.5,
      tEvent: Math.max(...evidenceRecords.map((evidence) => evidence.tEvent)),
    }
    const stored = await deps.store.insert(record, idempotencyKey(fact))
    // A failed add is not swallowed: the batch stays unprocessed, the retry finds the same record by
    // idempotency and adds it again, so the index heals itself.
    if (deps.index !== undefined) await deps.index.add(stored)
    if (promoted) report.promoted += 1
    else report.candidates += 1
  }

  return {
    async runOnce(window): Promise<ExtractionReport> {
      const report: Counters = {
        processed: 0,
        batches: 0,
        candidates: 0,
        promoted: 0,
        discardedBatches: 0,
        incompleteBatches: 0,
        parkedBatches: 0,
        droppedFacts: 0,
        injectedFacts: 0,
        tokens: 0,
        capped: false,
      }

      const filter: RecordFilter = {
        layers: ['L0'],
        statuses: ['active'],
        from: window.from,
        to: window.to,
        ...(window.channel === undefined ? {} : { channels: [window.channel] }),
      }
      const pending = (await listAll(deps.store, filter))
        .filter((record) => !deps.processed.has(record.id) && !parked.has(record.id))

      let stop = false
      for (const batch of batchRecords(pending, batchSize)) {
        if (stop) break
        syncDay()
        if (tokensToday >= deps.dailyTokenCap) {
          report.capped = true
          break
        }

        const keys = await knownKeys(batch)
        const reply = await deps.llm.complete({
          system: EXTRACTION_SYSTEM_PROMPT,
          user: buildUserPrompt(batch, keys),
          maxOutputTokens: deps.maxOutputTokens,
        })
        report.batches += 1
        tokensToday += reply.tokens
        report.tokens += reply.tokens

        if (!isCompleteJson(reply.text)) {
          // Nothing is written and nothing is marked processed: the same input is retried next run.
          report.incompleteBatches += 1
          let attempts = 0
          for (const record of batch) {
            const count = (incomplete.get(record.id) ?? 0) + 1
            incomplete.set(record.id, count)
            if (count > attempts) attempts = count
          }
          if (attempts >= maxIncompleteAttempts) {
            for (const record of batch) parked.add(record.id)
            report.parkedBatches += 1
          } else {
            // An empty reply is usually a global problem (model config, network); calling again now only
            // costs tokens. Stop after this batch and retry it on the next run.
            stop = true
          }
        } else {
          const facts = parseExtraction(reply.text, batch)
          if (facts === null) {
            report.discardedBatches += 1
          } else {
            const { kept, dropped } = keepGroundedFacts(facts, batch)
            report.droppedFacts += dropped
            for (const fact of kept) {
              if (scanInjection(fact.text) !== null) {
                report.injectedFacts += 1
                continue
              }
              await writeFact(fact, batch, report)
            }
          }

          // A discarded batch is marked too: the same input would only buy the same bad output again.
          await deps.processed.add(batch.map((record) => record.id))
          report.processed += batch.length
          for (const record of batch) incomplete.delete(record.id)
        }

        // The cap is checked before the "stop this run" decision, so both can be reported together.
        if (tokensToday >= deps.dailyTokenCap) {
          report.capped = true
          break
        }
      }

      return report
    },
  }
}
