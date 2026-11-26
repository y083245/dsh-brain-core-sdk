export type DiffKind = 'same' | 'added' | 'removed'

export interface DiffSpan {
  readonly kind: DiffKind
  readonly text: string
}

function tokenize(text: string): string[] {
  return text.match(/\p{Script=Han}|(?:(?!\p{Script=Han})[\p{L}\p{M}\p{N}_])+|\s+|./gsu) ?? []
}

function prefixLengths(left: readonly string[], right: readonly string[]): Uint32Array {
  const lengths = new Uint32Array(right.length + 1)
  for (const token of left) {
    let diagonal = 0
    for (let column = 1; column <= right.length; column += 1) {
      const previous = lengths[column]!
      lengths[column] = token === right[column - 1]
        ? diagonal + 1
        : Math.max(previous, lengths[column - 1]!)
      diagonal = previous
    }
  }
  return lengths
}

// Hirschberg's LCS uses one row per direction, including for long profile texts.
function commonTokens(left: readonly string[], right: readonly string[]): string[] {
  if (left.length === 0 || right.length === 0) return []
  if (left.length === 1) return right.includes(left[0]!) ? [left[0]!] : []

  const middle = Math.floor(left.length / 2)
  const before = left.slice(0, middle)
  const after = left.slice(middle)
  const forward = prefixLengths(before, right)
  const backward = prefixLengths(after.toReversed(), right.toReversed())
  let split = 0
  let best = -1
  for (let index = 0; index <= right.length; index += 1) {
    const length = forward[index]! + backward[right.length - index]!
    if (length > best) {
      best = length
      split = index
    }
  }
  if (best === 0) return []
  return commonTokens(before, right.slice(0, split)).concat(commonTokens(after, right.slice(split)))
}

export function diffStableText(before: string, after: string): DiffSpan[] {
  const left = tokenize(before)
  const right = tokenize(after)
  const spans: DiffSpan[] = []
  const append = (kind: DiffKind, text: string): void => {
    if (text === '') return
    const previous = spans.at(-1)
    if (previous?.kind === kind) spans[spans.length - 1] = { kind, text: previous.text + text }
    else spans.push({ kind, text })
  }

  let prefix = 0
  while (prefix < left.length && left[prefix] === right[prefix]) prefix += 1
  let leftEnd = left.length
  let rightEnd = right.length
  while (leftEnd > prefix && rightEnd > prefix && left[leftEnd - 1] === right[rightEnd - 1]) {
    leftEnd -= 1
    rightEnd -= 1
  }

  append('same', left.slice(0, prefix).join(''))
  let leftCursor = prefix
  let rightCursor = prefix
  for (const token of commonTokens(left.slice(prefix, leftEnd), right.slice(prefix, rightEnd))) {
    const leftIndex = left.indexOf(token, leftCursor)
    const rightIndex = right.indexOf(token, rightCursor)
    append('removed', left.slice(leftCursor, leftIndex).join(''))
    append('added', right.slice(rightCursor, rightIndex).join(''))
    append('same', token)
    leftCursor = leftIndex + 1
    rightCursor = rightIndex + 1
  }
  append('removed', left.slice(leftCursor, leftEnd).join(''))
  append('added', right.slice(rightCursor, rightEnd).join(''))
  append('same', left.slice(leftEnd).join(''))
  return spans
}
