// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

function safeDecodePercent(text: string): string {
  return text.replace(/%(?:[0-9A-Fa-f]{2})+/g, (match) => {
    try {
      return decodeURIComponent(match)
    } catch {
      return match.replace(/%[0-7][0-9A-Fa-f]/gi, (ascii) => String.fromCharCode(Number.parseInt(ascii.slice(1), 16)))
    }
  })
}

/** Return a deliberately non-sensitive reason; never include the matched text. */
export function sensitiveReason(text: string, secrets: readonly string[] = []): string | undefined {
  const decoded = text.includes('%') ? safeDecodePercent(text) : text
  const candidates = decoded !== text ? [text, decoded] : [text]
  if (candidates.some((candidate) => secrets.some((secret) => secret.length > 0 && candidate.includes(secret)))) {
    return 'secret'
  }
  if (candidates.some((candidate) => /(?:\/Users\/|\/home\/|[A-Za-z]:\\|\.dsh(?:\b|\/|\\))/i.test(candidate))) {
    return 'local path'
  }
  if (candidates.some((candidate) => /(?:\bsk-[A-Za-z0-9_-]+|\bBearer\s+\S+|\baccess_token["']?\s*[:=]|\bcookie["']?\s*[:=])/i.test(candidate))) {
    return 'credential'
  }
  return undefined
}
