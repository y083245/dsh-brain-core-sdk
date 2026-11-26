import type { MemoryRecord } from '@brain-core/sdk'
import type { ExtractedFact } from './types.ts'

const ALLOWED_KEYS = new Set(['kind', 'text', 'subjects', 'evidence', 'confidence', 'key', 'value', 'due'])
const ALLOWED_KINDS = new Set(['l1.fact', 'l1.event', 'l1.promise'])
const MAX_FACTS = 50

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Strips one ```json (or plain ```) fence around the reply; a reply without a fence is returned trimmed. */
function stripFence(raw: string): string {
  let text = raw.trim()
  if (!text.startsWith('```')) return text
  text = text.slice(3)
  if (text.startsWith('json')) text = text.slice(4)
  text = text.trimStart()
  if (text.endsWith('```')) text = text.slice(0, -3)
  return text.trim()
}

function groundedDue(due: unknown, evidence: readonly string[], records: ReadonlyMap<string, MemoryRecord>): string | undefined {
  if (typeof due !== 'string' || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(due)) return
  const timestamp = Date.parse(due)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== due) return

  const date = new Date(timestamp)
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth() + 1
  const day = date.getUTCDate()
  const monthPattern = month < 10 ? `0?${month}` : month
  const dayPattern = day < 10 ? `0?${day}` : day
  const chinese = new RegExp(`(?<!\\d)${year}\\s*年\\s*${monthPattern}\\s*月\\s*${dayPattern}\\s*[日号]`)
  const numeric = new RegExp(`(?<!\\d)${year}([-/.])${monthPattern}\\1${dayPattern}(?!\\d)`)
  for (const id of evidence) {
    const text = records.get(id)?.content.text
    if (typeof text === 'string' && (chinese.test(text) || numeric.test(text))) return due
  }
}

function validateFact(value: unknown, records: ReadonlyMap<string, MemoryRecord>, known: ReadonlySet<string>): ExtractedFact | null {
  if (!isObject(value)) return null
  if (Object.keys(value).some((key) => !ALLOWED_KEYS.has(key))) return null

  const { kind, text, subjects, evidence, confidence, key, value: factValue } = value

  if (typeof kind !== 'string' || !ALLOWED_KINDS.has(kind)) return null
  if (typeof text !== 'string' || text.length < 1 || text.length > 500) return null

  if (!Array.isArray(subjects) || subjects.length < 1 || subjects.length > 10) return null
  if (!subjects.every((subject) => typeof subject === 'string' && known.has(subject))) return null

  if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 20) return null
  if (!evidence.every((id) => typeof id === 'string' && records.has(id))) return null

  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null
  if (key !== undefined && (typeof key !== 'string' || key.length < 1 || key.length > 50)) return null
  if (factValue !== undefined && (typeof factValue !== 'string' || factValue.length < 1 || factValue.length > 200)) return null

  const due = kind === 'l1.promise' ? groundedDue(value.due, evidence, records) : undefined

  return {
    kind: kind as ExtractedFact['kind'],
    text,
    subjects: subjects as string[],
    evidence: evidence as string[],
    confidence,
    ...(key === undefined ? {} : { key }),
    ...(factValue === undefined ? {} : { value: factValue }),
    ...(due === undefined ? {} : { due }),
  }
}

/** False for an empty, truncated or non-JSON reply, which is worth retrying; true for any reply that parses. */
export function isCompleteJson(text: string): boolean {
  try {
    JSON.parse(stripFence(text))
    return true
  } catch {
    return false
  }
}

/** Removes facts about someone else whose evidence is only the agent's own words (RFC M9). */
export function keepGroundedFacts(
  facts: readonly ExtractedFact[],
  batch: readonly MemoryRecord[],
): { readonly kept: readonly ExtractedFact[]; readonly dropped: number } {
  const byId = new Map(batch.map((record) => [record.id, record]))
  const kept: ExtractedFact[] = []
  let dropped = 0
  for (const fact of facts) {
    const selfOnly = fact.evidence.every((id) => byId.get(id)?.actor === 'self')
    const aboutOthers = fact.subjects.some((subject) => subject !== 'self')
    const mentionsSelf = fact.subjects.includes('self')
    const discard = fact.kind === 'l1.fact'
      ? selfOnly && aboutOthers
      : fact.kind === 'l1.event' && selfOnly && !mentionsSelf
    if (discard) dropped += 1
    else kept.push(fact)
  }
  return { kept, dropped }
}

/** null when the output breaks any rule; the whole batch is then discarded. */
export function parseExtraction(text: string, batch: readonly MemoryRecord[]): readonly ExtractedFact[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFence(text))
  } catch {
    return null
  }

  if (!isObject(parsed)) return null
  const keys = Object.keys(parsed)
  if (keys.length !== 1 || keys[0] !== 'facts') return null

  const facts = parsed.facts
  if (!Array.isArray(facts) || facts.length > MAX_FACTS) return null

  const records = new Map<string, MemoryRecord>()
  const known = new Set<string>(['self'])
  for (const record of batch) {
    records.set(record.id, record)
    known.add(record.actor)
    for (const subject of record.subjects) known.add(subject)
  }

  const result: ExtractedFact[] = []
  for (const item of facts) {
    const fact = validateFact(item, records, known)
    if (fact === null) return null
    result.push(fact)
  }
  return result
}
