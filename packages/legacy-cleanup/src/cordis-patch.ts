/**
 * Line-based removal of the entries the old setup script put into
 * `<DSH_HOME>/profiles/<name>/cordis.patch.yml`.
 *
 * YAML is never re-serialized: comments, ordering, quoting and blank lines stay
 * exactly as the user left them. Anything this scanner cannot prove safe is
 * reported as "manual" and the file is left untouched.
 */
import { indentOf, isBlank, isComment, isSequenceItem, itemBody, joinLines, splitLines, type Line } from './lines.ts'

export const LEGACY_BUNDLES = ['qq-mode-console', 'qq-agent-presets'] as const
export const LEGACY_MCP_IDS = ['mcp-snowluma', 'mcp-snowluma-host', 'mcp-web-search-safe'] as const
export const LEGACY_PRESET_ROW_IDS = ['preset-qq-chat', 'preset-qq-chat-v2'] as const
export const LEGACY_PRESET_IDS = ['qq-chat', 'qq-chat-v2'] as const
export const LEGACY_QQMODE_ID = 'qq-mode'

const PRESET_PLUGIN_NAME = '@deepseek-ai/dsh-agent-preset'
const MCP_BLOCK_BEGIN = '# === qq-bridge MCP BEGIN ==='
const MCP_BLOCK_END = '# === qq-bridge MCP END ==='

export interface CordisPatchPlan {
  readonly nextText: string | null
  readonly removals: readonly string[]
  readonly manual: readonly string[]
}

interface Item {
  readonly start: number
  readonly coreEnd: number
}

interface Entry {
  readonly start: number
  readonly end: number
  readonly id: string | null
  readonly name: string | null
}

interface InsertBlock {
  readonly insertIndex: number
  readonly entries: readonly Entry[]
  readonly hasOtherKeys: boolean
}

interface KeyValue {
  readonly key: string
  readonly value: string
}

function keyValue(text: string): KeyValue | null {
  const match = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(text)
  if (match === null) return null
  return { key: match[1] ?? '', value: match[2] ?? '' }
}

function scalar(value: string): string {
  const text = value.trim().replace(/\s+#.*$/, '')
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1).replace(/''/g, "'")
  }
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    try {
      return String(JSON.parse(text))
    } catch {
      return text.slice(1, -1)
    }
  }
  return text
}

function firstMeaningfulLine(lines: readonly Line[]): Line | undefined {
  return lines.find(line => !isBlank(line.text) && !isComment(line.text))
}

/** Split the root block sequence into items, keeping trailing user comments outside them. */
function topLevelItems(lines: readonly Line[], baseIndent: number): Item[] {
  const starts: number[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line === undefined || isBlank(line.text) || isComment(line.text)) continue
    if (indentOf(line.text) === baseIndent && isSequenceItem(line.text)) starts.push(index)
  }
  return starts.map((start, position) => {
    const next = starts[position + 1] ?? lines.length
    let coreEnd = next
    while (coreEnd > start + 1) {
      const text = lines[coreEnd - 1]?.text ?? ''
      if (isBlank(text) || (isComment(text) && indentOf(text) <= baseIndent)) coreEnd--
      else break
    }
    return { start, coreEnd }
  })
}

function findInsertBlock(lines: readonly Line[], item: Item): InsertBlock | null {
  let insertIndex = -1
  for (let index = item.start; index < item.coreEnd; index++) {
    const raw = lines[index]?.text ?? ''
    const parsed = keyValue(index === item.start ? itemBody(raw) : raw)
    if (parsed?.key === 'insert' && scalar(parsed.value) === '') {
      insertIndex = index
      break
    }
  }
  if (insertIndex < 0) return null

  const insertIndent = indentOf(lines[insertIndex]?.text ?? '')
  const header = keyValue(itemBody(lines[item.start]?.text ?? ''))
  let hasOtherKeys = header === null || header.key !== 'insert'
  if (item.start !== insertIndex) hasOtherKeys = true

  let subIndent = -1
  for (let index = insertIndex + 1; index < item.coreEnd; index++) {
    const text = lines[index]?.text ?? ''
    if (isBlank(text) || isComment(text)) continue
    const indent = indentOf(text)
    if (indent <= insertIndent) break
    if (isSequenceItem(text)) {
      subIndent = indent
      break
    }
  }
  if (subIndent < 0) return { insertIndex, entries: [], hasOtherKeys }

  const starts: number[] = []
  for (let index = insertIndex + 1; index < item.coreEnd; index++) {
    const text = lines[index]?.text ?? ''
    if (isBlank(text) || isComment(text)) continue
    const indent = indentOf(text)
    if (indent <= insertIndent) break
    if (indent === subIndent && isSequenceItem(text)) starts.push(index)
  }
  const entries = starts.map((start, position) => {
    const end = starts[position + 1] ?? item.coreEnd
    const headerBody = itemBody(lines[start]?.text ?? '')
    const headerPair = keyValue(headerBody)
    let id: string | null = headerPair?.key === 'id' ? scalar(headerPair.value) : null
    let name: string | null = headerPair?.key === 'name' ? scalar(headerPair.value) : null
    for (let index = start + 1; index < end; index++) {
      if (id !== null && name !== null) break
      if (indentOf(lines[index]?.text ?? '') !== subIndent + 2) continue
      const parsed = keyValue(lines[index]?.text ?? '')
      if (parsed === null) continue
      if (parsed.key === 'id' && id === null) id = scalar(parsed.value)
      if (parsed.key === 'name' && name === null) name = scalar(parsed.value)
    }
    return { start, end, id, name }
  })

  // Keys at the insert indentation that are not entries and not the insert itself.
  for (let index = item.start; index < item.coreEnd; index++) {
    if (index === insertIndex) continue
    if (entries.some(entry => index >= entry.start && index < entry.end)) continue
    const text = lines[index]?.text ?? ''
    if (isBlank(text) || isComment(text)) continue
    if (indentOf(text) === insertIndent) hasOtherKeys = true
    if (indentOf(text) < insertIndent) hasOtherKeys = true
  }
  return { insertIndex, entries, hasOtherKeys }
}

function directRowKeys(lines: readonly Line[], item: Item, baseIndent: number): { id: string | null; name: string | null; configIds: string[] } {
  let id: string | null = null
  let name: string | null = null
  const header = keyValue(itemBody(lines[item.start]?.text ?? ''))
  if (header?.key === 'id') id = scalar(header.value)
  if (header?.key === 'name') name = scalar(header.value)
  const configIds: string[] = []
  for (let index = item.start + 1; index < item.coreEnd; index++) {
    const text = lines[index]?.text ?? ''
    if (isBlank(text) || isComment(text)) continue
    const indent = indentOf(text)
    const parsed = keyValue(text)
    if (parsed === null) continue
    if (indent === baseIndent + 2) {
      if (parsed.key === 'id' && id === null) id = scalar(parsed.value)
      if (parsed.key === 'name' && name === null) name = scalar(parsed.value)
    }
    if (parsed.key === 'id') configIds.push(scalar(parsed.value))
  }
  return { id, name, configIds }
}

function isPresetRow(keys: { id: string | null; name: string | null; configIds: string[] }): boolean {
  if (keys.id !== null && (LEGACY_PRESET_ROW_IDS as readonly string[]).includes(keys.id)) return true
  return keys.name === PRESET_PLUGIN_NAME
    && keys.configIds.some(value => (LEGACY_PRESET_IDS as readonly string[]).includes(value))
}

function findLegacyLines(lines: readonly Line[]): string[] {
  const found: string[] = []
  const ids = [...LEGACY_MCP_IDS, ...LEGACY_PRESET_ROW_IDS, ...LEGACY_PRESET_IDS, LEGACY_QQMODE_ID]
  for (const line of lines) {
    if (isComment(line.text)) continue
    for (const id of ids) {
      const pattern = new RegExp(`(?:^|[\\s{,\\[])(?:id|insert)\\s*:\\s*['"]?${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?(?=[\\s,}\\]]#]|$)`)
      if (pattern.test(line.text)) {
        found.push(id)
        break
      }
    }
  }
  return found
}

/** Plan the text edit for one cordis.patch.yml. */
export function planCordisPatch(text: string): CordisPatchPlan {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : ''
  const body = bom === '' ? text : text.slice(1)
  const lines = splitLines(body)
  const first = firstMeaningfulLine(lines)
  if (first === undefined) return { nextText: null, removals: [], manual: [] }
  if (/^\[\s*\]\s*$/.test(first.text.trim()) && lines.filter(line => !isBlank(line.text) && !isComment(line.text)).length === 1) {
    return { nextText: null, removals: [], manual: [] }
  }
  if (!isSequenceItem(first.text)) {
    const remaining = findLegacyLines(lines)
    return remaining.length === 0
      ? { nextText: null, removals: [], manual: [] }
      : { nextText: null, removals: [], manual: [`root of cordis.patch.yml is not a YAML sequence (found ${[...new Set(remaining)].join(', ')}); file left untouched`] }
  }

  const baseIndent = indentOf(first.text)
  const items = topLevelItems(lines, baseIndent)
  const removals: string[] = []
  const manual: string[] = []
  const removed = new Uint8Array(lines.length)
  const replaced = new Map<number, string>()

  const mark = (start: number, end: number): void => {
    for (let index = start; index < end; index++) removed[index] = 1
  }
  const coversItem = (item: Item): boolean => removed[item.start] === 1

  const beginIndex = lines.findIndex(line => line.text.trimEnd() === MCP_BLOCK_BEGIN)
  const endIndex = lines.findIndex(line => line.text.trimEnd() === MCP_BLOCK_END)
  if (beginIndex >= 0 && endIndex > beginIndex) {
    const regionItems = items.filter(item => item.start > beginIndex && item.start < endIndex)
    let clean = regionItems.length > 0
    for (const item of regionItems) {
      const block = findInsertBlock(lines, item)
      if (block === null || block.hasOtherKeys || block.entries.length === 0
        || !block.entries.every(entry => entry.id !== null && (LEGACY_MCP_IDS as readonly string[]).includes(entry.id))) {
        clean = false
        break
      }
    }
    if (clean) {
      for (let index = beginIndex + 1; index < endIndex; index++) {
        if (isBlank(lines[index]?.text ?? '') || isComment(lines[index]?.text ?? '')) continue
        if (regionItems.some(item => index >= item.start && index < item.coreEnd)) continue
        clean = false
        break
      }
    }
    if (clean) {
      for (const item of regionItems) {
        const block = findInsertBlock(lines, item)
        for (const entry of block?.entries ?? []) removals.push(`MCP server "${entry.id}"`)
      }
      removals.push('qq-bridge MCP comment block')
      mark(beginIndex, endIndex + 1)
    } else {
      manual.push('qq-bridge MCP comment block contains unrecognized entries; block comments left untouched')
    }
  } else if (beginIndex >= 0 || endIndex >= 0) {
    manual.push('qq-bridge MCP marker has no matching counterpart; markers left untouched')
  }

  for (const item of items) {
    if (coversItem(item)) continue
    const block = findInsertBlock(lines, item)
    if (block !== null) {
      const removable = block.entries.filter(entry => {
        if (entry.id === null) return false
        return (LEGACY_MCP_IDS as readonly string[]).includes(entry.id)
          || (LEGACY_PRESET_ROW_IDS as readonly string[]).includes(entry.id)
          || entry.id === LEGACY_QQMODE_ID
      })
      if (removable.length === 0) continue
      if (removable.length === block.entries.length && !block.hasOtherKeys) {
        removals.push(...removable.map(entry => entry.id === LEGACY_QQMODE_ID
          ? `settings namespace "${entry.id}"`
          : `entry "${entry.id}"`))
        mark(item.start, item.coreEnd)
        continue
      }
      for (const entry of removable) {
        removals.push(`entry "${entry.id}"`)
        mark(entry.start, entry.end)
      }
      if (removable.length === block.entries.length) {
        const indent = ' '.repeat(indentOf(lines[block.insertIndex]?.text ?? ''))
        replaced.set(block.insertIndex, `${indent}insert: []`)
      }
      continue
    }

    const keys = directRowKeys(lines, item, baseIndent)
    if (keys.id === LEGACY_QQMODE_ID) {
      removals.push(`settings namespace "${LEGACY_QQMODE_ID}"`)
      mark(item.start, item.coreEnd)
      continue
    }
    if (isPresetRow(keys)) {
      const label = keys.id ?? keys.configIds.find(value => (LEGACY_PRESET_IDS as readonly string[]).includes(value)) ?? 'unknown'
      removals.push(`preset row "${label}"`)
      mark(item.start, item.coreEnd)
    }
  }

  // Apply replacements on the original lines first, then drop the removed ranges.
  for (const [index, replacement] of replaced) {
    const line = lines[index]
    if (line === undefined || removed[index] === 1) continue
    line.text = replacement
  }
  const nextText = `${bom}${joinLines(lines.filter((_, index) => removed[index] === 0))}`

  const leftovers = findLegacyLines(splitLines(nextText))
  if (leftovers.length > 0) {
    return {
      nextText: null,
      removals: [],
      manual: [...manual, `legacy entries remain after the edit (${[...new Set(leftovers)].join(', ')}); file left untouched`],
    }
  }
  if (removals.length === 0 && manual.length === 0) return { nextText: null, removals: [], manual: [] }
  return { nextText: nextText === text ? null : nextText, removals, manual }
}
