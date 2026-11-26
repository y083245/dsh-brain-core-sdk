import { Fragment, useMemo, type ReactNode } from 'react'
import { parseMarkdownBlocks, type InlineToken, type MarkdownBlock } from '../../lib/safeMarkdown.ts'
import { InkText } from '../../ui/InkText.tsx'

interface LinkPiece {
  readonly text: string
  readonly href?: string
}

function safeHref(value: string): string | undefined {
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code <= 32 || code === 127 || char === '\\') return undefined
  }
  try {
    const url = new URL(value)
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) return url.href
  } catch {
    return undefined
  }
  return undefined
}

function splitLinks(text: string): readonly LinkPiece[] {
  const pieces: LinkPiece[] = []
  const matches = text.matchAll(/\[([^\]\n]+)\]\(([^\s)]+)\)/g)
  let from = 0
  for (const match of matches) {
    const start = match.index
    // Image syntax stays literal; no browser image fetch is ever created.
    if (start > 0 && text[start - 1] === '!') continue
    const href = safeHref(match[2] ?? '')
    if (!href) continue
    if (start > from) pieces.push({ text: text.slice(from, start) })
    pieces.push({ text: match[1] ?? '', href })
    from = start + match[0].length
  }
  if (from < text.length) pieces.push({ text: text.slice(from) })
  return pieces
}

function visibleTokenText(token: InlineToken): string {
  if (token.kind === 'code') return token.code
  return splitLinks(token.text).map((piece) => piece.text).join('')
}

function visibleLength(blocks: readonly MarkdownBlock[]): number {
  let length = 0
  for (const block of blocks) {
    if (block.kind === 'code-block') length += Array.from(block.code).length
    else {
      const lines = 'lines' in block ? block.lines : block.items
      for (const line of lines) {
        for (const token of line) length += Array.from(visibleTokenText(token)).length
      }
    }
  }
  return length
}

export function SafeMarkdown({
  value,
  previousText,
}: {
  readonly value: string
  /** Undefined renders an already displayed message without replaying its ink. */
  readonly previousText?: string
}) {
  const blocks = useMemo(() => parseMarkdownBlocks(value), [value])
  const previousBlocks = useMemo(
    () => previousText === undefined ? null : parseMarkdownBlocks(previousText),
    [previousText],
  )
  let remaining = previousBlocks === null ? Number.POSITIVE_INFINITY : visibleLength(previousBlocks)

  function renderText(text: string): ReactNode {
    const length = Array.from(text).length
    const fromIndex = Math.min(remaining, length)
    remaining = Math.max(0, remaining - length)
    return fromIndex === length ? text : <InkText text={text} fromIndex={fromIndex} />
  }

  function renderLine(tokens: readonly InlineToken[]): ReactNode {
    return tokens.map((token, index) => {
      if (token.kind === 'code') {
        return <code key={index}>{renderText(token.code)}</code>
      }
      const contents = splitLinks(token.text).map((piece, pieceIndex) =>
        piece.href !== undefined ? (
          <a key={pieceIndex} href={piece.href} target="_blank" rel="noopener noreferrer">{renderText(piece.text)}</a>
        ) : <Fragment key={pieceIndex}>{renderText(piece.text)}</Fragment>,
      )
      return token.kind === 'bold'
        ? <strong key={index}>{contents}</strong>
        : <Fragment key={index}>{contents}</Fragment>
    })
  }

  return (
    <div className="voice-markdown">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case 'code-block':
            return <pre key={index}><code>{renderText(block.code)}</code></pre>
          case 'blockquote':
            return (
              <blockquote key={index}>
                {block.lines.map((line, lineIndex) => <p key={lineIndex}>{renderLine(line)}</p>)}
              </blockquote>
            )
          case 'unordered-list':
          case 'ordered-list': {
            const List = block.kind === 'unordered-list' ? 'ul' : 'ol'
            return <List key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{renderLine(item)}</li>)}</List>
          }
          case 'paragraph':
            return (
              <p key={index}>
                {block.lines.map((line, lineIndex) => (
                  <Fragment key={lineIndex}>{lineIndex > 0 && <br />}{renderLine(line)}</Fragment>
                ))}
              </p>
            )
        }
      })}
    </div>
  )
}
