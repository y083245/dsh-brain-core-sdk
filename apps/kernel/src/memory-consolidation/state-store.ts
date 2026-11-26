import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { BrainError } from '@brain-core/sdk'
import { ensurePrivateDir, writeFileAtomic } from '@brain-core/shared'
import type { Clock, ConsolidationProposal } from '../contracts/index.ts'
import { isPlainObject } from './helpers.ts'

export interface TokenLedger {
  readonly day: string
  readonly usedTokens: number
}

export interface PersistedConsolidationState {
  readonly version: 1
  readonly lastConsolidatedTo: number
  readonly tokenLedger: TokenLedger
  readonly proposals: readonly ConsolidationProposal[]
}

export interface ConsolidationStateStore {
  withLock<T>(fn: () => Promise<T>): Promise<T>
  getWatermark(): Promise<number>
  getUsedTokensToday(now: number): Promise<number>
  addTokens(tokens: number, now: number): Promise<number>
  listProposals(status?: ConsolidationProposal['status']): Promise<readonly ConsolidationProposal[]>
  getProposal(id: string): Promise<ConsolidationProposal | null>
  saveProposal(proposal: ConsolidationProposal, advanceWatermarkTo?: number): Promise<ConsolidationProposal>
  updateProposal(
    id: string,
    updater: (current: ConsolidationProposal) => ConsolidationProposal,
  ): Promise<ConsolidationProposal>
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function isValidProposalStatus(value: unknown): value is ConsolidationProposal['status'] {
  return value === 'pending' || value === 'approved' || value === 'rejected'
}

function isValidProposal(value: unknown): value is ConsolidationProposal {
  if (!isPlainObject(value)) return false
  if (typeof value.id !== 'string' || !isValidProposalStatus(value.status)) return false
  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) return false
  if (value.resolvedAt !== undefined && (typeof value.resolvedAt !== 'number' || !Number.isFinite(value.resolvedAt))) {
    return false
  }
  if (!isPlainObject(value.window)) return false
  if (typeof value.window.from !== 'number' || typeof value.window.to !== 'number') return false
  if (typeof value.tokensUsed !== 'number' || !Number.isFinite(value.tokensUsed)) return false
  if (!Array.isArray(value.l2Candidates) || !Array.isArray(value.corrections) || !Array.isArray(value.selfConflicts)) {
    return false
  }
  if (value.l3SelfPatch !== null && !isPlainObject(value.l3SelfPatch)) return false
  if (!Array.isArray(value.l3PersonPatches)) return false
  return true
}

function parseState(raw: string): {
  lastConsolidatedTo: number
  tokenLedger: { day: string; usedTokens: number }
  proposals: ConsolidationProposal[]
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new BrainError('UNAVAILABLE', 'consolidation state file is unreadable')
  }
  if (!isPlainObject(parsed) || parsed.version !== 1) {
    throw new BrainError('UNAVAILABLE', 'consolidation state file is unreadable')
  }
  if (typeof parsed.lastConsolidatedTo !== 'number' || !Number.isFinite(parsed.lastConsolidatedTo)) {
    throw new BrainError('UNAVAILABLE', 'consolidation state file is unreadable')
  }
  if (
    !isPlainObject(parsed.tokenLedger)
    || typeof parsed.tokenLedger.day !== 'string'
    || typeof parsed.tokenLedger.usedTokens !== 'number'
    || !Number.isFinite(parsed.tokenLedger.usedTokens)
  ) {
    throw new BrainError('UNAVAILABLE', 'consolidation state file is unreadable')
  }
  if (!Array.isArray(parsed.proposals) || !parsed.proposals.every(isValidProposal)) {
    throw new BrainError('UNAVAILABLE', 'consolidation state file is unreadable')
  }
  return {
    lastConsolidatedTo: parsed.lastConsolidatedTo,
    tokenLedger: {
      day: parsed.tokenLedger.day,
      usedTokens: parsed.tokenLedger.usedTokens,
    },
    proposals: parsed.proposals.map((item) => structuredClone(item)),
  }
}

export function createConsolidationStateStore(deps: {
  readonly clock: Clock
  readonly stateFile?: string
}): ConsolidationStateStore {
  let loaded = deps.stateFile === undefined
  let lastConsolidatedTo = 0
  let tokenLedger: { day: string; usedTokens: number } = {
    day: utcDay(deps.clock.now()),
    usedTokens: 0,
  }
  let proposals: ConsolidationProposal[] = []

  let queue: Promise<unknown> = Promise.resolve()

  function syncDay(now: number): void {
    const today = utcDay(now)
    if (tokenLedger.day !== today) {
      tokenLedger = { day: today, usedTokens: 0 }
    }
  }

  async function ensureLoaded(): Promise<void> {
    if (loaded || deps.stateFile === undefined) return
    let raw: string
    try {
      raw = await readFile(deps.stateFile, 'utf8')
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        loaded = true
        return
      }
      throw new BrainError('UNAVAILABLE', 'consolidation state file is unreadable')
    }
    const parsed = parseState(raw)
    lastConsolidatedTo = parsed.lastConsolidatedTo
    tokenLedger = parsed.tokenLedger
    proposals = parsed.proposals
    loaded = true
  }

  async function persist(): Promise<void> {
    if (deps.stateFile === undefined) return
    const dir = path.dirname(deps.stateFile)
    if (dir !== '.' && dir !== '') await ensurePrivateDir(dir)
    const payload: PersistedConsolidationState = {
      version: 1,
      lastConsolidatedTo,
      tokenLedger,
      proposals,
    }
    await writeFileAtomic(deps.stateFile, JSON.stringify(payload, null, 2) + '\n')
  }

  return {
    withLock<T>(fn: () => Promise<T>): Promise<T> {
      const next = queue.then(fn, fn)
      queue = next.then(() => undefined, () => undefined)
      return next
    },

    async getWatermark(): Promise<number> {
      await ensureLoaded()
      return lastConsolidatedTo
    },

    async getUsedTokensToday(now: number): Promise<number> {
      await ensureLoaded()
      syncDay(now)
      return tokenLedger.usedTokens
    },

    async addTokens(tokens: number, now: number): Promise<number> {
      await ensureLoaded()
      syncDay(now)
      tokenLedger = {
        day: tokenLedger.day,
        usedTokens: tokenLedger.usedTokens + Math.max(0, tokens),
      }
      await persist()
      return tokenLedger.usedTokens
    },

    async listProposals(status?: ConsolidationProposal['status']): Promise<readonly ConsolidationProposal[]> {
      await ensureLoaded()
      const filtered = status === undefined
        ? proposals
        : proposals.filter((proposal) => proposal.status === status)
      return [...filtered]
        .sort((left, right) => {
          if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt
          return left.id < right.id ? 1 : left.id > right.id ? -1 : 0
        })
        .map((proposal) => structuredClone(proposal))
    },

    async getProposal(id: string): Promise<ConsolidationProposal | null> {
      await ensureLoaded()
      const found = proposals.find((proposal) => proposal.id === id)
      return found === undefined ? null : structuredClone(found)
    },

    async saveProposal(proposal: ConsolidationProposal, advanceWatermarkTo?: number): Promise<ConsolidationProposal> {
      await ensureLoaded()
      const copy = structuredClone(proposal)
      proposals.push(copy)
      if (advanceWatermarkTo !== undefined && advanceWatermarkTo > lastConsolidatedTo) {
        lastConsolidatedTo = advanceWatermarkTo
      }
      await persist()
      return structuredClone(copy)
    },

    async updateProposal(
      id: string,
      updater: (current: ConsolidationProposal) => ConsolidationProposal,
    ): Promise<ConsolidationProposal> {
      await ensureLoaded()
      const index = proposals.findIndex((proposal) => proposal.id === id)
      if (index === -1) throw new BrainError('NOT_FOUND', `proposal ${id} not found`)
      const updated = structuredClone(updater(proposals[index] as ConsolidationProposal))
      proposals[index] = updated
      await persist()
      return structuredClone(updated)
    },
  }
}
