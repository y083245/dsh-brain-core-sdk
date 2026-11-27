import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { BrainError, hostAllowed, parsePermission, type FetchOptions, type FetchResponse, type ParsedPermission } from '@dsh-brain-core/sdk'
import type { InstalledPlugin } from '../contracts/index.ts'
import { isPrivateIp } from './safe-fetch.ts'

export type Lookup = (host: string) => Promise<readonly string[]>

const DEFAULT_TIMEOUT_MS = 20_000
const MAX_BYTES = 8 * 1024 * 1024
const MAX_REDIRECTS = 5
export const REDIRECTS = new Set([301, 302, 303, 307, 308])

const LOOPBACK_BLOCK_LIST = (() => {
  const list = new net.BlockList()
  list.addSubnet('127.0.0.0', 8, 'ipv4')
  list.addSubnet('::1', 128, 'ipv6')
  list.addSubnet('::ffff:127.0.0.0', 104, 'ipv6')
  return list
})()

/** Returns true only for IPv4 127.0.0.0/8, IPv6 ::1, and IPv4-mapped IPv6 ::ffff:127.0.0.0/104 (fail-closed). */
export function isLoopbackIp(ip: unknown): boolean {
  if (typeof ip !== 'string') return false
  let candidate = ip.toLowerCase()
  if (candidate.startsWith('[') && candidate.endsWith(']')) {
    candidate = candidate.slice(1, -1)
  }
  if (candidate === '' || candidate.includes('%')) return false
  const family = net.isIP(candidate)
  if (family === 4) return LOOPBACK_BLOCK_LIST.check(candidate, 'ipv4')
  if (family !== 6) return false
  let normalized: string
  try {
    normalized = new URL(`http://[${candidate}]/`).hostname.slice(1, -1)
  } catch {
    return false
  }
  return LOOPBACK_BLOCK_LIST.check(normalized, 'ipv6')
}

function denied(message: string): BrainError {
  return new BrainError('PERMISSION_DENIED', message)
}

const defaultLookup: Lookup = async (host) => (await dns.promises.lookup(host, { all: true, verbatim: true })).map((entry) => entry.address)

export function bareHost(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
}

/** Hosts of the URLs held by one config field (a string or an array of strings). */
function configHosts(config: unknown, key: string): string[] {
  const value = typeof config === 'object' && config !== null ? (config as Record<string, unknown>)[key] : undefined
  const items = Array.isArray(value) ? value : [value]
  const hosts: string[] = []
  for (const item of items) {
    if (typeof item !== 'string') continue
    try { hosts.push(bareHost(new URL(item))) } catch { /* not a URL */ }
  }
  return hosts
}

function lanHost(text: string): string {
  return text.toLowerCase().replace(/^\[|\]$/g, '')
}

export async function resolveAll(host: string, lookup: Lookup): Promise<readonly string[]> {
  if (net.isIP(host)) return [host]
  const addresses = await lookup(host)
  if (addresses.length === 0) throw denied('host did not resolve')
  return addresses
}

/** Throws PERMISSION_DENIED unless this plugin may reach the URL; returns the addresses that were checked. */
async function check(plugin: InstalledPlugin, url: URL, lookup: Lookup): Promise<readonly string[]> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw denied('only http and https are allowed')
  if (url.username !== '' || url.password !== '') throw denied('a URL must not carry credentials')
  const host = bareHost(url)
  const parsed: ParsedPermission[] = []
  for (const entry of plugin.granted) {
    try { parsed.push(parsePermission(entry)) } catch { /* not a permission */ }
  }
  let addresses: readonly string[] | undefined
  const resolved = async (): Promise<readonly string[]> => (addresses ??= await resolveAll(host, lookup))
  for (const permission of parsed) {
    if (permission.kind === 'network' && hostAllowed(permission.host, host)) {
      const found = await resolved()
      if (!found.some((address) => isPrivateIp(address))) return found
    } else if (permission.kind === 'network-config' && configHosts(plugin.config, permission.key).includes(host)) {
      const found = await resolved()
      if (!found.some((address) => isPrivateIp(address))) return found
    } else if (permission.kind === 'lan' && lanHost(permission.host) === host) {
      return resolved()
    } else if (permission.kind === 'lan-config' && configHosts(plugin.config, permission.key).includes(host)) {
      return resolved()
    }
  }
  throw denied(`network access to ${host} is not granted`)
}

export async function guardUrl(plugin: InstalledPlugin, url: URL, lookup: Lookup = defaultLookup): Promise<void> {
  await check(plugin, url, lookup)
}

function request(url: URL, address: string, options: FetchOptions, budgetMs: number, maxBytes: number): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }> {
  return new Promise((resolve, reject) => {
    // One timer for the whole hop: a server that trickles bytes cannot stretch it.
    let settled = false
    let req: ReturnType<typeof http.request> | undefined
    const timer = setTimeout(() => {
      fail(new BrainError('UNAVAILABLE', 'request timed out'))
      req?.destroy()
    }, budgetMs)
    const done = <T>(settle: (value: T) => void) => (value: T): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      settle(value)
    }
    const succeed = done(resolve)
    const fail = done(reject)
    const client = url.protocol === 'https:' ? https : http
    const headers: Record<string, string> = { ...(options.headers ?? {}) }
    try {
      req = client.request(url, {
        method: options.method ?? 'GET',
        headers,
        // Connect to the address that was checked, never to a second lookup.
        lookup: ((_host: string, lookupOptions: { all?: boolean }, callback: (error: Error | null, address: unknown, family?: number) => void) => {
          const family = net.isIP(address)
          if (lookupOptions?.all === true) callback(null, [{ address, family }])
          else callback(null, address, family)
        }) as never,
        servername: net.isIP(bareHost(url)) ? undefined : bareHost(url),
      }, (response) => {
        const chunks: Buffer[] = []
        let total = 0
        response.on('data', (chunk: Buffer) => {
          total += chunk.length
          if (total > maxBytes) {
            fail(new BrainError('PAYLOAD_TOO_LARGE', 'response is too large'))
            req?.destroy()
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          const out: Record<string, string> = {}
          for (const [key, value] of Object.entries(response.headers)) {
            if (value !== undefined) out[key] = Array.isArray(value) ? value.join(', ') : value
          }
          succeed({ status: response.statusCode ?? 0, headers: out, body: new Uint8Array(Buffer.concat(chunks)) })
        })
        response.on('error', () => fail(new BrainError('UNAVAILABLE', 'request failed')))
      })
      req.on('error', () => fail(new BrainError('UNAVAILABLE', 'request failed')))
      if (options.body !== undefined) req.write(options.body)
      req.end()
    } catch {
      // e.g. a header value with a newline: client.request throws synchronously. Do not echo its text.
      fail(new BrainError('INVALID_ARGUMENT', 'invalid request'))
      req?.destroy()
    }
  })
}

const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization'])

/** Credentials stay with the origin they were meant for. */
function withoutSensitive(headers: FetchOptions['headers']): FetchOptions['headers'] {
  if (headers === undefined) return undefined
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !SENSITIVE_HEADERS.has(key.toLowerCase())))
}

export async function guardedFetch(plugin: InstalledPlugin, rawUrl: string, options: FetchOptions = {}, lookup: Lookup = defaultLookup): Promise<FetchResponse> {
  if (options.redirect !== undefined && options.redirect !== 'follow' && options.redirect !== 'error') {
    throw new BrainError('INVALID_ARGUMENT', 'invalid redirect option')
  }
  let url: URL
  try { url = new URL(rawUrl) } catch { throw new BrainError('INVALID_ARGUMENT', 'invalid URL') }
  const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
  const maxBytes = Math.min(options.maxBytes ?? MAX_BYTES, MAX_BYTES)
  const deadline = Date.now() + timeoutMs
  let method = options.method
  let body = options.body
  let headers = options.headers
  for (let hop = 0; ; hop += 1) {
    const addresses = await check(plugin, url, lookup)
    const left = deadline - Date.now()
    if (left <= 0) throw new BrainError('UNAVAILABLE', 'request timed out')
    const result = await request(url, addresses[0] as string, { ...options, method, body, headers }, left, maxBytes)
    if (REDIRECTS.has(result.status)) {
      if (options.redirect === 'error') throw denied('redirects are not allowed')
      if (result.headers.location !== undefined) {
        if (hop >= MAX_REDIRECTS) throw new BrainError('UNAVAILABLE', 'too many redirects')
        const next = new URL(result.headers.location, url)
        if (next.protocol !== url.protocol || next.hostname !== url.hostname || next.port !== url.port) headers = withoutSensitive(headers)
        url = next
        if (result.status === 303 || ((result.status === 301 || result.status === 302) && method === 'POST')) { method = 'GET'; body = undefined }
        continue
      }
    }
    const bytes = result.body
    return { status: result.status, headers: result.headers, text: () => new TextDecoder().decode(bytes), bytes: () => bytes }
  }
}
