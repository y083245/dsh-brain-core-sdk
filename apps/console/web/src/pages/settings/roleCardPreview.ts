import type { RoleCardOrigin } from '../../api/types.ts'

export const ROLE_ORIGIN_LABELS: Readonly<Record<RoleCardOrigin, string>> = {
  factory: '出厂',
  user: '自定义',
  modified: '已修改',
}

export function formatRoleOriginLabel(origin: RoleCardOrigin): string {
  return ROLE_ORIGIN_LABELS[origin]
}

export function getRoleOriginBadgeTone(origin: RoleCardOrigin): 'shiqing' | 'shilv' | 'tenghuang' {
  if (origin === 'factory') return 'shiqing'
  if (origin === 'modified') return 'tenghuang'
  return 'shilv'
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function stripFrontmatter(lines: readonly string[]): readonly string[] {
  if (lines[0]?.trim() !== '---') return lines
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === '---') {
      return lines.slice(i + 1)
    }
  }
  return lines
}

function isHorizontalRule(trimmed: string): boolean {
  return /^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)
}

function isHeading(trimmed: string): boolean {
  return /^#{1,6}(?:\s|$)/.test(trimmed)
}

function isListItem(trimmed: string): boolean {
  return /^(?:[-*+]|\d+\.)\s+/.test(trimmed)
}

function stripListPrefix(trimmed: string): string {
  return trimmed.replace(/^(?:[-*+]|\d+\.)\s+/, '')
}

function truncateChars(text: string, maxLength: number): string {
  if (maxLength <= 0) return ''
  const chars = Array.from(text)
  if (chars.length <= maxLength) return text
  if (maxLength === 1) return '…'
  return `${chars.slice(0, maxLength - 1).join('').trimEnd()}…`
}

/**
 * Extracts the first meaningful body paragraph (or first list item / blockquote) from a Markdown role card
 * so the picker can display a concise subtitle above the full scrollable preview.
 */
export function extractRoleSummary(text: string, maxLength = 120): string {
  if (typeof text !== 'string') return ''
  const normalized = text.replace(/\r\n?/g, '\n').trim()
  if (normalized === '') return ''

  const lines = stripFrontmatter(normalized.split('\n'))
  let inCodeFence = false
  let mode: 'none' | 'paragraph' | 'quote' = 'none'
  const collected: string[] = []

  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    if (trimmed.startsWith('```')) {
      if (mode !== 'none') break
      inCodeFence = !inCodeFence
      continue
    }
    if (inCodeFence) continue

    if (trimmed === '') {
      if (mode !== 'none') break
      continue
    }
    if (isHeading(trimmed) || isHorizontalRule(trimmed)) {
      if (mode !== 'none') break
      continue
    }
    if (isListItem(trimmed)) {
      if (mode !== 'none') break
      const cleaned = stripInlineMarkdown(stripListPrefix(trimmed))
      if (cleaned !== '') return truncateChars(cleaned, maxLength)
      continue
    }
    if (trimmed.startsWith('>')) {
      if (mode === 'paragraph') break
      const quoteLine = trimmed.replace(/^>+\s*/, '')
      if (quoteLine === '') {
        if (mode === 'quote') break
        continue
      }
      mode = 'quote'
      collected.push(quoteLine)
      continue
    }
    if (mode === 'quote') break
    mode = 'paragraph'
    collected.push(trimmed)
  }

  const summary = stripInlineMarkdown(collected.join(' '))
  if (summary === '') return ''
  return truncateChars(summary, maxLength)
}
