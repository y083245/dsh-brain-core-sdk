/** Text similarity for the outgoing check and tools__search: bigram Dice over text with punctuation and spaces removed. */

/** Lower case, with punctuation and whitespace of every script removed. */
export function squash(text: string): string {
  return text.toLowerCase().replace(/[\p{P}\s]+/gu, '')
}

/** How many characters are left once punctuation and spaces are gone. */
export function significantLength(text: string): number {
  return [...squash(text)].length
}

function grams(text: string): Map<string, number> {
  const chars = [...squash(text)]
  const out = new Map<string, number>()
  if (chars.length === 0) return out
  if (chars.length === 1) {
    out.set(chars[0] as string, 1)
    return out
  }
  for (let index = 0; index < chars.length - 1; index += 1) {
    const gram = `${chars[index]}${chars[index + 1]}`
    out.set(gram, (out.get(gram) ?? 0) + 1)
  }
  return out
}

/** 2 * shared bigrams / total bigrams, in [0, 1]. Either side empty gives 0. */
export function dice(a: string, b: string): number {
  const left = grams(a)
  const right = grams(b)
  let total = 0
  for (const count of left.values()) total += count
  for (const count of right.values()) total += count
  if (total === 0) return 0
  let shared = 0
  for (const [gram, count] of left) shared += Math.min(count, right.get(gram) ?? 0)
  return (2 * shared) / total
}
