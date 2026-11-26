// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

/** Remove lightweight Markdown decoration while preserving code whitespace and punctuation. */
export function plainQqText(text: string): string {
  return text.replace(/\r\n?/g, '\n')
    .split(/(```[^\n]*\n[\s\S]*?```|`[^`\n]+`)/g)
    .map((part, index) => {
      if (index % 2 === 1) {
        return part.startsWith('```') ? part.slice(part.indexOf('\n') + 1, -3) : part.slice(1, -1)
      }
      return part.replace(/^ {0,3}#{1,6}[ \t]+/gm, '').replace(/(\*\*|__|~~)([^\n]+?)\1/g, '$2')
    })
    .join('')
}

/** Split by UTF-16 code units without separating surrogate pairs. */
export function splitText(text: string, limit = 4000): string[] {
  if (!Number.isInteger(limit) || limit < 2 || limit > 4000) throw new Error('Invalid split limit')
  const result: string[] = []
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + limit, text.length)
    if (end < text.length && /[\uD800-\uDBFF]/.test(text.charAt(end - 1)) && /[\uDC00-\uDFFF]/.test(text.charAt(end))) end--
    result.push(text.slice(start, end))
    start = end
  }
  return result
}
