import { BrainError, LIMITS, type MemoryRecord, type Visibility } from '@brain-core/sdk'
import type { RecordFilter, RecordStore } from '../contracts/index.ts'

const PAGE_LIMIT = 1000
const VISIBILITY_RANK: Record<Visibility, number> = {
  internal: 0,
  owner: 1,
  origin: 2,
  subject: 3,
  open: 4,
}

export interface BudgetTracker {
  canCall(): boolean
  consume(tokens: number): Promise<void>
  used(): number
  isCapped(): boolean
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key)
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== 'object') return value
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return value
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key])
  }
  return sorted
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? 'undefined'
}

export function truncateCodePoints(text: string, max = 20): string {
  const codePoints = [...text.trim()]
  return codePoints.length <= max ? codePoints.join('') : codePoints.slice(0, max).join('')
}

export function stripFence(raw: string): string {
  let text = raw.trim()
  if (!text.startsWith('```')) return text
  text = text.slice(3)
  if (text.startsWith('json')) text = text.slice(4)
  text = text.trimStart()
  if (text.endsWith('```')) text = text.slice(0, -3)
  return text.trim()
}

export function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(stripFence(raw))
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function escapeForPrompt(json: string): string {
  return json
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('`', '\\u0060')
}

export function recordText(record: MemoryRecord): string {
  if (typeof record.content.text === 'string') return record.content.text
  if (typeof record.content.statement === 'string') return record.content.statement
  return stableStringify(record.content)
}

export function compareId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function strictestVisibility(records: readonly MemoryRecord[]): Visibility {
  let current: Visibility = 'open'
  for (const record of records) {
    if (VISIBILITY_RANK[record.visibility] < VISIBILITY_RANK[current]) {
      current = record.visibility
    }
  }
  return current
}

export function clampEvidenceIds(ids: readonly string[]): readonly { readonly id: string }[] {
  const unique = [...new Set(ids)].slice(0, LIMITS.evidence)
  return unique.map((id) => ({ id }))
}

export async function listAll(store: RecordStore, filter: RecordFilter): Promise<MemoryRecord[]> {
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

export async function hasValidEvidence(store: RecordStore, record: MemoryRecord): Promise<boolean> {
  for (const ref of record.evidence) {
    const target = await store.get(ref.id)
    if (target !== null && target.status !== 'tombstoned') return true
  }
  return false
}

export async function filterValidEvidence(
  store: RecordStore,
  refs: readonly { readonly id: string }[],
): Promise<readonly { readonly id: string }[]> {
  const kept: { readonly id: string }[] = []
  const seen = new Set<string>()
  for (const ref of refs) {
    if (seen.has(ref.id)) continue
    seen.add(ref.id)
    const target = await store.get(ref.id)
    if (target !== null && target.status !== 'tombstoned') {
      kept.push({ id: ref.id })
    }
  }
  return kept.slice(0, LIMITS.evidence)
}

export function assertValidWindow(from: number, to: number): void {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
    throw new BrainError('INVALID_ARGUMENT', 'consolidation window requires finite from <= to')
  }
}
