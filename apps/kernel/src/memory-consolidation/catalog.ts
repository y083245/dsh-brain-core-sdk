import type { MemoryRecord } from '@brain-core/sdk'
import type { RecordStore } from '../contracts/index.ts'
import { listAll, truncateCodePoints } from './helpers.ts'

export const CATALOG_START = '[记忆目录]'
export const CATALOG_END = '[/记忆目录]'
export const MAX_CATALOG_CHARS = 400

const MAX_TOPIC_TITLE_CHARS = 24
const MAX_OPEN_TOPICS = 10
const HIDDEN_VISIBILITIES = new Set(['owner', 'origin', 'internal'])

export interface MemoryCatalog {
  readonly text: string
  readonly personKeys: Readonly<Record<string, readonly string[]>>
  readonly openTopics: readonly string[]
}

function compareLex(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function codePointLength(text: string): number {
  return [...text].length
}

function sanitizeLinePart(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim()
}

function topicTitleOf(record: MemoryRecord): string {
  const rawTitle = typeof record.content.title === 'string' && record.content.title.trim() !== ''
    ? record.content.title
    : typeof record.content.text === 'string'
      ? record.content.text
      : ''
  const cleaned = sanitizeLinePart(rawTitle)
  return cleaned === '' ? '' : truncateCodePoints(cleaned, MAX_TOPIC_TITLE_CHARS)
}

/**
 * Builds a deterministic, privacy-filtered summary of known attribute keys and open topics
 * for the cached L3.self `stable` prefix. Values are never included.
 */
export async function buildMemoryCatalog(store: RecordStore): Promise<MemoryCatalog> {
  const activeL1 = await listAll(store, { layers: ['L1'], statuses: ['active'] })
  const keysByPerson = new Map<string, Set<string>>()
  const topicSet = new Set<string>()

  for (const record of activeL1) {
    if (HIDDEN_VISIBILITIES.has(record.visibility)) continue

    if (record.kind !== 'l1.candidate' && typeof record.content.key === 'string') {
      const key = sanitizeLinePart(record.content.key)
      if (key !== '') {
        for (const subject of record.subjects) {
          const personId = sanitizeLinePart(subject)
          if (personId === '') continue
          let set = keysByPerson.get(personId)
          if (set === undefined) {
            set = new Set<string>()
            keysByPerson.set(personId, set)
          }
          set.add(key)
        }
      }
    }

    if (record.kind === 'l1.topic' && record.content.state !== 'closed') {
      const title = topicTitleOf(record)
      if (title !== '') topicSet.add(title)
    }
  }

  const sortedPersons = [...keysByPerson.keys()].sort(compareLex)
  const personKeys: Record<string, readonly string[]> = {}
  for (const personId of sortedPersons) {
    personKeys[personId] = [...(keysByPerson.get(personId) as Set<string>)].sort(compareLex)
  }
  const openTopics = [...topicSet].sort(compareLex).slice(0, MAX_OPEN_TOPICS)

  if (sortedPersons.length === 0 && openTopics.length === 0) {
    return { text: '', personKeys: {}, openTopics: [] }
  }

  const bodyLines: string[] = [
    ...sortedPersons.map((personId) => `已知属性名：${personId}: ${personKeys[personId]!.join('、')}`),
    ...(openTopics.length > 0 ? [`未闭合话题：${openTopics.join('；')}`] : []),
  ]

  const keptLines: string[] = []
  for (const line of bodyLines) {
    const candidate = [CATALOG_START, ...keptLines, line, CATALOG_END].join('\n')
    if (codePointLength(candidate) <= MAX_CATALOG_CHARS) {
      keptLines.push(line)
    }
  }

  const text = keptLines.length === 0 ? '' : [CATALOG_START, ...keptLines, CATALOG_END].join('\n')
  return { text, personKeys, openTopics }
}

/**
 * Replaces or removes the `[记忆目录]...[/记忆目录]` section in `stable` and appends `catalogText`
 * when non-empty.
 */
export function upsertCatalogInStable(stable: string, catalogText: string): string {
  const startIdx = stable.indexOf(CATALOG_START)
  const endIdx = startIdx === -1 ? -1 : stable.indexOf(CATALOG_END, startIdx + CATALOG_START.length)

  let cleaned: string
  if (startIdx !== -1 && endIdx !== -1) {
    const before = stable.slice(0, startIdx).replace(/\s+$/, '')
    const after = stable.slice(endIdx + CATALOG_END.length).replace(/^\s+/, '').replace(/\s+$/, '')
    cleaned = before !== '' && after !== '' ? `${before}\n\n${after}` : (before !== '' ? before : after)
  } else {
    cleaned = stable.replace(/\s+$/, '')
  }

  if (catalogText === '') return cleaned
  return cleaned === '' ? catalogText : `${cleaned}\n\n${catalogText}`
}
