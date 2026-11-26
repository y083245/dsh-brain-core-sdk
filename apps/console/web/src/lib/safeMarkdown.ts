export type InlineToken =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'bold'; readonly text: string }
  | { readonly kind: 'code'; readonly code: string }

export type MarkdownBlock =
  | {
      readonly kind: 'code-block'
      readonly language: string
      readonly code: string
      readonly lineCount: number
    }
  | {
      readonly kind: 'blockquote'
      readonly lines: readonly (readonly InlineToken[])[]
    }
  | {
      readonly kind: 'unordered-list'
      readonly items: readonly (readonly InlineToken[])[]
    }
  | {
      readonly kind: 'ordered-list'
      readonly items: readonly (readonly InlineToken[])[]
    }
  | {
      readonly kind: 'paragraph'
      readonly lines: readonly (readonly InlineToken[])[]
    }

interface CodeBlockSegment {
  readonly kind: 'code-block'
  readonly language: string
  readonly code: string
}

interface TextBlockSegment {
  readonly kind: 'text-block'
  readonly content: string
}

type RawSegment = CodeBlockSegment | TextBlockSegment

function parseRawSegments(raw: string): readonly RawSegment[] {
  const normalized = raw.replace(/\r\n/g, '\n')
  const segments: RawSegment[] = []
  const fenceRegex = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g

  let lastIndex = 0
  let match: RegExpExecArray | null = fenceRegex.exec(normalized)

  while (match !== null) {
    if (match.index > lastIndex) {
      segments.push({
        kind: 'text-block',
        content: normalized.slice(lastIndex, match.index),
      })
    }
    const language = (match[1] ?? '').trim() || 'text'
    const code = (match[2] ?? '').replace(/\n$/, '')
    segments.push({
      kind: 'code-block',
      language,
      code,
    })
    lastIndex = match.index + match[0].length
    match = fenceRegex.exec(normalized)
  }

  if (lastIndex < normalized.length) {
    segments.push({
      kind: 'text-block',
      content: normalized.slice(lastIndex),
    })
  }

  return segments.length > 0 ? segments : [{ kind: 'text-block', content: normalized }]
}

function parseBoldTokens(text: string): readonly InlineToken[] {
  const tokens: InlineToken[] = []
  const boldRegex = /\*\*([^*]+?)\*\*/g
  let lastIndex = 0
  let match: RegExpExecArray | null = boldRegex.exec(text)

  while (match !== null) {
    if (match.index > lastIndex) {
      tokens.push({ kind: 'text', text: text.slice(lastIndex, match.index) })
    }
    tokens.push({ kind: 'bold', text: match[1] ?? '' })
    lastIndex = match.index + match[0].length
    match = boldRegex.exec(text)
  }

  if (lastIndex < text.length) {
    tokens.push({ kind: 'text', text: text.slice(lastIndex) })
  }

  return tokens.length > 0 ? tokens : [{ kind: 'text', text }]
}

/**
 * Parses a single line of inline markdown (`code` and **bold**) into structured tokens.
 * Never produces HTML strings.
 */
export function parseInlineMarkdown(line: string): readonly InlineToken[] {
  const tokens: InlineToken[] = []
  const codeRegex = /`([^`\n]+?)`/g
  let lastIndex = 0
  let match: RegExpExecArray | null = codeRegex.exec(line)

  while (match !== null) {
    if (match.index > lastIndex) {
      const before = line.slice(lastIndex, match.index)
      tokens.push(...parseBoldTokens(before))
    }
    tokens.push({ kind: 'code', code: match[1] ?? '' })
    lastIndex = match.index + match[0].length
    match = codeRegex.exec(line)
  }

  if (lastIndex < line.length) {
    tokens.push(...parseBoldTokens(line.slice(lastIndex)))
  }

  return tokens.length > 0 ? tokens : [{ kind: 'text', text: line }]
}

/**
 * Pure block/inline Markdown parser returning an unstyled AST.
 * Consumers render these blocks with React elements and never inject raw HTML.
 */
export function parseMarkdownBlocks(raw: string): readonly MarkdownBlock[] {
  const segments = parseRawSegments(raw)
  const blocks: MarkdownBlock[] = []

  for (const segment of segments) {
    if (segment.kind === 'code-block') {
      const lineCount = segment.code === '' ? 1 : segment.code.split('\n').length
      blocks.push({
        kind: 'code-block',
        language: segment.language,
        code: segment.code,
        lineCount,
      })
      continue
    }

    const trimmed = segment.content.replace(/^\n+|\n+$/g, '')
    if (trimmed === '') continue

    const paragraphs = trimmed.split(/\n{2,}/)
    for (const para of paragraphs) {
      const lines = para.split('\n')
      if (lines.every((l) => l.trimStart().startsWith('>'))) {
        blocks.push({
          kind: 'blockquote',
          lines: lines.map((l) => parseInlineMarkdown(l.trimStart().replace(/^>\s?/, ''))),
        })
        continue
      }

      if (lines.every((l) => /^[-*]\s+/.test(l.trimStart()))) {
        blocks.push({
          kind: 'unordered-list',
          items: lines.map((l) => parseInlineMarkdown(l.trimStart().replace(/^[-*]\s+/, ''))),
        })
        continue
      }

      if (lines.every((l) => /^\d+\.\s+/.test(l.trimStart()))) {
        blocks.push({
          kind: 'ordered-list',
          items: lines.map((l) => parseInlineMarkdown(l.trimStart().replace(/^\d+\.\s+/, ''))),
        })
        continue
      }

      blocks.push({
        kind: 'paragraph',
        lines: lines.map((line) => parseInlineMarkdown(line)),
      })
    }
  }

  return blocks
}
