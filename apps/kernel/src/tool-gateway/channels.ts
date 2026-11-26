/** A channel id is `<source>:<kind>:<id>`; a tool's `channels` patterns are `<source>:<kind>` and either part may be `*`. */

function segments(channel: string): readonly [string, string] | null {
  const parts = channel.split(':')
  return parts.length >= 3 ? [parts[0] as string, parts[1] as string] : null
}

function patternParts(pattern: string): readonly [string, string] | null {
  const parts = pattern.split(':')
  return parts.length === 2 ? [parts[0] as string, parts[1] as string] : null
}

/** The second segment (private, group, ...), or an empty string for an id that is not a channel. */
export function channelKind(channel: string): string {
  return segments(channel)?.[1] ?? ''
}

/** True when some pattern equals the channel's first two segments, `*` standing for any. */
export function channelMatches(patterns: readonly string[], channel: string): boolean {
  const own = segments(channel)
  if (own === null) return false
  return patterns.some((pattern) => {
    const parts = patternParts(pattern)
    return parts !== null && (parts[0] === '*' || parts[0] === own[0]) && (parts[1] === '*' || parts[1] === own[1])
  })
}

/** True when some tool pattern and the given pattern can name the same channel; `*` on either side matches. */
export function patternsOverlap(patterns: readonly string[], pattern: string): boolean {
  const given = patternParts(pattern)
  if (given === null) throw new RangeError(`invalid channel pattern: ${JSON.stringify(pattern)}`)
  return patterns.some((other) => {
    const parts = patternParts(other)
    if (parts === null) return false
    const same = (a: string, b: string): boolean => a === '*' || b === '*' || a === b
    return same(parts[0], given[0]) && same(parts[1], given[1])
  })
}
