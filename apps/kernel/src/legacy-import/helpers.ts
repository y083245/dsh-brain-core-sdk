import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { lstat, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { BrainError, type MemoryRecord } from '@dsh-brain-core/sdk'

export interface L0MatchCandidate {
  readonly id: string
  readonly tEvent: number
  readonly actor: string
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== 'object') return value
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key])
  }
  return sorted
}

/** Deterministic JSON serialization with object keys sorted at every depth. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? 'undefined'
}

export function isDigits(value: string): boolean {
  return /^\d+$/.test(value)
}

export function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return undefined
    const parsed = Date.parse(trimmed)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** Reads a regular non-symlink UTF-8 file; returns null when missing or when path is a symlink/non-file. */
export async function readRegularFileIfExists(filePath: string): Promise<string | null> {
  let statResult
  try {
    statResult = await lstat(filePath)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
  if (statResult.isSymbolicLink() || !statResult.isFile()) return null
  return readFile(filePath, 'utf8')
}

/** Lists non-symlink directory entries sorted lexicographically by name; returns [] when dir is missing. */
export async function listSafeEntries(dirPath: string): Promise<readonly Dirent[]> {
  let statResult
  try {
    statResult = await lstat(dirPath)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return []
    throw error
  }
  if (statResult.isSymbolicLink() || !statResult.isDirectory()) return []
  const entries = await readdir(dirPath, { withFileTypes: true })
  return entries
    .filter((entry) => !entry.isSymbolicLink())
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
}

export function invalidArgument(message: string): BrainError {
  return new BrainError('INVALID_ARGUMENT', message)
}

export function notFound(message: string): BrainError {
  return new BrainError('NOT_FOUND', message)
}

export function isAnchorKind(kind: string): boolean {
  return kind === 'legacy.ledger_snapshot' || kind === 'legacy.persona_snapshot'
}

export function addL0Candidate(
  byChannel: Map<string, L0MatchCandidate[]>,
  channel: string,
  candidate: L0MatchCandidate,
): void {
  const list = byChannel.get(channel)
  if (list === undefined) {
    byChannel.set(channel, [candidate])
    return
  }
  if (!list.some((item) => item.id === candidate.id && item.id !== 'dry')) {
    list.push(candidate)
  }
}

export function addL1SubjectId(bySubject: Map<string, string[]>, subject: string, recordId: string): void {
  const list = bySubject.get(subject)
  if (list === undefined) {
    bySubject.set(subject, [recordId])
    return
  }
  if (!list.includes(recordId)) list.push(recordId)
}

export function recordToCandidate(record: MemoryRecord): L0MatchCandidate {
  return { id: record.id, tEvent: record.tEvent, actor: record.actor }
}

export function safeJoin(base: string, ...segments: readonly string[]): string {
  return path.join(base, ...segments)
}
