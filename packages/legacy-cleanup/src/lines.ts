/** Line splitting that keeps the original line endings, so edits stay byte-exact. */

export interface Line {
  text: string
  eol: string
}

export function splitLines(text: string): Line[] {
  const lines: Line[] = []
  let start = 0
  while (start < text.length) {
    let index = start
    while (index < text.length && text[index] !== '\n' && text[index] !== '\r') index++
    const content = text.slice(start, index)
    let eol = ''
    if (index < text.length) {
      eol = text[index] === '\r' && text[index + 1] === '\n' ? '\r\n' : text[index] ?? ''
      index += eol.length
    }
    lines.push({ text: content, eol })
    start = index
  }
  return lines
}

export function joinLines(lines: readonly Line[]): string {
  return lines.map(line => `${line.text}${line.eol}`).join('')
}

export function indentOf(text: string): number {
  const match = /^(\s*)/.exec(text)
  return match?.[1]?.length ?? 0
}

export function isBlank(text: string): boolean {
  return /^\s*$/.test(text)
}

export function isComment(text: string): boolean {
  return /^\s*#/.test(text)
}

/** A YAML sequence item starts with `-` followed by whitespace or end of line. */
export function isSequenceItem(text: string): boolean {
  return /^\s*-(\s|$)/.test(text)
}

/** The text after the leading `- ` of a sequence item. */
export function itemBody(text: string): string {
  const match = /^\s*-(\s*)([\s\S]*)$/.exec(text)
  return match?.[2] ?? ''
}
