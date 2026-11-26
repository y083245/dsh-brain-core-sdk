import net from 'node:net'

const PRIVATE_BLOCK_LIST = buildPrivateBlockList()

function buildPrivateBlockList(): net.BlockList {
  const list = new net.BlockList()

  // IPv4 IANA RFC 6890 non-global / reserved subnets and cloud metadata endpoints
  list.addSubnet('0.0.0.0', 8, 'ipv4')
  list.addSubnet('10.0.0.0', 8, 'ipv4')
  list.addSubnet('100.64.0.0', 10, 'ipv4')
  list.addSubnet('127.0.0.0', 8, 'ipv4')
  list.addSubnet('169.254.0.0', 16, 'ipv4')
  list.addSubnet('172.16.0.0', 12, 'ipv4')
  list.addSubnet('192.0.0.0', 24, 'ipv4')
  list.addSubnet('192.168.0.0', 16, 'ipv4')
  list.addSubnet('198.18.0.0', 15, 'ipv4')
  list.addSubnet('224.0.0.0', 4, 'ipv4')
  list.addSubnet('240.0.0.0', 4, 'ipv4')
  list.addSubnet('168.63.129.16', 32, 'ipv4')

  // IPv6 IANA RFC 6890 non-global / reserved prefixes
  list.addSubnet('::', 128, 'ipv6')
  list.addSubnet('::1', 128, 'ipv6')
  list.addSubnet('fc00::', 7, 'ipv6')
  list.addSubnet('fe80::', 10, 'ipv6')
  list.addSubnet('fec0::', 10, 'ipv6')
  list.addSubnet('ff00::', 8, 'ipv6')
  list.addSubnet('2001:db8::', 32, 'ipv6')
  list.addSubnet('2001:2::', 48, 'ipv6')
  list.addSubnet('2001:10::', 28, 'ipv6')
  list.addSubnet('2001:20::', 28, 'ipv6')
  list.addSubnet('64:ff9b:1::', 48, 'ipv6')

  return list
}

function parseIpv6Words(normalized: string): readonly number[] | undefined {
  const halves = normalized.split('::')
  if (halves.length > 2) return undefined

  let rawGroups: string[]
  if (halves.length === 2) {
    const left = halves[0] === '' ? [] : halves[0]!.split(':')
    const right = halves[1] === '' ? [] : halves[1]!.split(':')
    const missing = 8 - left.length - right.length
    if (missing < 1) return undefined
    rawGroups = [...left, ...Array<string>(missing).fill('0'), ...right]
  } else {
    rawGroups = normalized.split(':')
  }

  if (rawGroups.length !== 8) return undefined
  const words: number[] = []
  for (const group of rawGroups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined
    words.push(Number.parseInt(group, 16))
  }
  return words
}

function formatEmbeddedIpv4(highWord: number, lowWord: number): string {
  return `${(highWord >>> 8) & 0xff}.${highWord & 0xff}.${(lowWord >>> 8) & 0xff}.${lowWord & 0xff}`
}

function checkIpv6(candidate: string): boolean {
  let normalized: string
  try {
    normalized = new URL(`http://[${candidate}]/`).hostname.slice(1, -1)
  } catch {
    return true
  }

  if (PRIVATE_BLOCK_LIST.check(normalized, 'ipv6')) return true

  const words = parseIpv6Words(normalized)
  if (words === undefined) return true

  const w0 = words[0]!
  const w1 = words[1]!
  const w2 = words[2]!
  const w3 = words[3]!
  const w4 = words[4]!
  const w5 = words[5]!
  const w6 = words[6]!
  const w7 = words[7]!

  const leadingZero4 = w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0

  // IPv4-mapped (::ffff:w6:w7)
  if (leadingZero4 && w4 === 0 && w5 === 0xffff) {
    return isPrivateIp(formatEmbeddedIpv4(w6, w7))
  }
  // IPv4-translated (::ffff:0:w6:w7)
  if (leadingZero4 && w4 === 0xffff && w5 === 0) {
    return isPrivateIp(formatEmbeddedIpv4(w6, w7))
  }
  // IPv4-compatible (::w6:w7 excluding :: and ::1)
  if (leadingZero4 && w4 === 0 && w5 === 0 && (w6 !== 0 || w7 > 1)) {
    return isPrivateIp(formatEmbeddedIpv4(w6, w7))
  }
  // Well-Known NAT64 (64:ff9b::w6:w7)
  if (w0 === 0x0064 && w1 === 0xff9b && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) {
    return isPrivateIp(formatEmbeddedIpv4(w6, w7))
  }
  // 6to4 (2002:w1:w2::)
  if (w0 === 0x2002) {
    return isPrivateIp(formatEmbeddedIpv4(w1, w2))
  }

  return false
}

/** Returns true if the input is non-public, reserved, embedded-private, or malformed (fail-closed). */
export function isPrivateIp(ip: unknown): boolean {
  if (typeof ip !== 'string') return true
  let candidate = ip.toLowerCase()
  if (candidate.startsWith('[') && candidate.endsWith(']')) {
    candidate = candidate.slice(1, -1)
  }
  if (candidate === '' || candidate.includes('%')) return true

  const family = net.isIP(candidate)
  if (family === 0) return true
  if (family === 4) return PRIVATE_BLOCK_LIST.check(candidate, 'ipv4')
  return checkIpv6(candidate)
}
