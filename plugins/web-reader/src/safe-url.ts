import { BrainError } from '@dsh-brain-core/sdk'

function normalizeHost(hostname: string): string {
  return hostname.trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
}

function isForbiddenIpv4Octets(a: number, b: number): boolean {
  if (a === 0) return true
  if (a === 10) return true
  if (a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a >= 224) return true
  return false
}

function parseIpv4(host: string): readonly [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!match) return null
  const a = Number(match[1])
  const b = Number(match[2])
  const c = Number(match[3])
  const d = Number(match[4])
  if (a > 255 || b > 255 || c > 255 || d > 255) return null
  return [a, b, c, d]
}

function isForbiddenIpv6(host: string): boolean {
  const ipv6 = (host.split('%')[0] ?? host).toLowerCase()
  if (ipv6 === '::' || ipv6 === '::1' || ipv6 === '0:0:0:0:0:0:0:0' || ipv6 === '0:0:0:0:0:0:0:1') {
    return true
  }
  if (/^fe[89ab][0-9a-f]?(:|$)/.test(ipv6)) return true
  if (/^f[cd][0-9a-f]{0,2}(:|$)/.test(ipv6)) return true
  if (/^ff[0-9a-f]{0,2}(:|$)/.test(ipv6)) return true

  const v4Dotted = /^(?:::ffff:|(?:0{1,4}:){5}ffff:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(ipv6)
  if (v4Dotted) {
    const octets = parseIpv4(v4Dotted[1]!)
    return octets === null ? true : isForbiddenIpv4Octets(octets[0], octets[1])
  }

  const v4Hex = /^(?:::ffff:|(?:0{1,4}:){5}ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ipv6)
  if (v4Hex) {
    const hi = parseInt(v4Hex[1]!, 16)
    const a = (hi >> 8) & 0xff
    const b = hi & 0xff
    return isForbiddenIpv4Octets(a, b)
  }

  return false
}

/** Returns true when `hostname` is loopback, link-local, private, multicast, reserved, or single-label. */
export function isForbiddenHost(hostname: string): boolean {
  const host = normalizeHost(hostname)
  if (host === '') return true
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true

  const ipv4 = parseIpv4(host)
  if (ipv4 !== null) return isForbiddenIpv4Octets(ipv4[0], ipv4[1])

  if (host.includes(':')) return isForbiddenIpv6(host)
  if (!host.includes('.')) return true
  return false
}

/**
 * Validates that `rawUrl` is http/https without credentials, is NOT a loopback/private/link-local/reserved host
 * or IP, and its hostname matches one of the configured public feed URLs; throws BrainError PERMISSION_DENIED
 * or INVALID_ARGUMENT otherwise.
 */
export function assertSafeFeedUrl(rawUrl: string, configuredFeeds: readonly string[]): URL {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new BrainError('INVALID_ARGUMENT', 'invalid URL')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BrainError('PERMISSION_DENIED', `unsupported protocol: ${parsed.protocol}`)
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new BrainError('PERMISSION_DENIED', 'credentials in URL are refused')
  }
  if (isForbiddenHost(parsed.hostname)) {
    throw new BrainError('PERMISSION_DENIED', 'loopback and private network addresses are refused')
  }

  const allowedHosts = new Set<string>()
  for (const feed of configuredFeeds) {
    try {
      const feedUrl = new URL(feed)
      if (
        (feedUrl.protocol === 'http:' || feedUrl.protocol === 'https:')
        && feedUrl.username === ''
        && feedUrl.password === ''
        && !isForbiddenHost(feedUrl.hostname)
      ) {
        allowedHosts.add(normalizeHost(feedUrl.hostname))
      }
    } catch {
      // ignore invalid feed entries
    }
  }

  const targetHost = normalizeHost(parsed.hostname)
  if (!allowedHosts.has(targetHost)) {
    throw new BrainError('PERMISSION_DENIED', `host ${targetHost} is not in configured feeds`)
  }

  return parsed
}
