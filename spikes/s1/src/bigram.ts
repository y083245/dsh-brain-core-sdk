/** FTS5's trigram tokenizer misses two-character Chinese words, so CJK runs are split into bigrams here. */

const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu

function splitRun(run: string): string[] {
  const chars = [...run]
  if (chars.length === 1) return chars
  return chars.slice(0, -1).map((char, index) => char + chars[index + 1])
}

/** The text to store in a `tokenize='unicode61'` FTS5 column. */
export function bigrams(text: string): string {
  return text.replace(CJK_RUN, run => ` ${splitRun(run).join(' ')} `).replace(/\s+/g, ' ').trim()
}

/** An FTS5 MATCH expression: every token of the term must be present, as a phrase within each run. */
export function bigramQuery(term: string): string {
  const phrases: string[] = []
  for (const part of term.split(/\s+/).filter(Boolean)) {
    const tokens = bigrams(part).split(' ').filter(Boolean)
    phrases.push(`"${tokens.join(' ').replaceAll('"', '""')}"`)
  }
  return phrases.join(' AND ')
}
