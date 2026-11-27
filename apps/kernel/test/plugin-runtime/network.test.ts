import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { BrainError } from '@dsh-brain-core/sdk'
import { guardUrl } from '../../src/plugin-runtime/index.ts'
import { guardedFetch, isLoopbackIp } from '../../src/plugin-runtime/network.ts'
import { isPrivateIp } from '../../src/plugin-runtime/safe-fetch.ts'
import { installed } from './helpers.ts'

const PUBLIC = async () => ['93.184.216.34']
const refused = (e: unknown): boolean => e instanceof BrainError && e.code === 'PERMISSION_DENIED'
const plugin = (granted: string[], config: unknown = {}) => installed(granted, { config })

test('isPrivateIp: private, loopback, mapped and malformed addresses are private; public ones are not', () => {
  for (const ip of ['10.0.0.1', '127.0.0.1', '192.168.1.1', '172.16.0.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1',
    '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:c0a8:101', '64:ff9b::c0a8:101', '2002:c0a8:101::1', 'garbage', '', '1.2.3.4%eth0']) {
    assert.equal(isPrivateIp(ip), true, ip)
  }
  for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPrivateIp(ip), false, ip)
})

test('guardUrl: only http/https, no credentials', async () => {
  const p = plugin(['network:example.com'])
  await guardUrl(p, new URL('https://example.com/x'), PUBLIC)
  await assert.rejects(guardUrl(p, new URL('ftp://example.com/x'), PUBLIC), refused)
  await assert.rejects(guardUrl(p, new URL('https://u:p@example.com/'), PUBLIC), refused)
  await assert.rejects(guardUrl(p, new URL('https://u@example.com/'), PUBLIC), refused)
})

test('guardUrl: unlisted hosts, wildcards and the lower-cased host', async () => {
  const p = plugin(['network:example.com', 'network:*.cdn.com'])
  await guardUrl(p, new URL('https://EXAMPLE.com/'), PUBLIC)
  await guardUrl(p, new URL('https://a.cdn.com/'), PUBLIC)
  await assert.rejects(guardUrl(p, new URL('https://cdn.com/'), PUBLIC), refused)
  await assert.rejects(guardUrl(p, new URL('https://evil.com/'), PUBLIC), refused)
  await assert.rejects(guardUrl(p, new URL('https://example.com.evil.com/'), PUBLIC), refused)
  await assert.rejects(guardUrl(plugin([]), new URL('https://example.com/'), PUBLIC), refused)
})

test('guardUrl: a public grant never reaches the LAN, by literal or by what the name resolves to', async () => {
  const p = plugin(['network:example.com', 'network:*.example.com'])
  await assert.rejects(guardUrl(p, new URL('https://example.com/'), async () => ['10.0.0.5']), refused)
  await assert.rejects(guardUrl(p, new URL('https://a.example.com/'), async () => ['93.184.216.34', '127.0.0.1']), refused)
  await assert.rejects(guardUrl(plugin(['network:example.com']), new URL('http://127.0.0.1/'), PUBLIC), refused)
  await assert.rejects(guardUrl(p, new URL('https://example.com/'), async () => []), refused)
})

test('guardUrl: lan grants are exact and may point inside', async () => {
  const p = plugin(['lan:192.168.1.5', 'lan:ha.local', 'lan:[::1]'])
  await guardUrl(p, new URL('http://192.168.1.5:8123/'), PUBLIC)
  await guardUrl(p, new URL('http://ha.local/'), async () => ['192.168.1.9'])
  await guardUrl(p, new URL('http://[::1]:80/'), PUBLIC)
  await assert.rejects(guardUrl(p, new URL('http://192.168.1.6/'), PUBLIC), refused)
  await assert.rejects(guardUrl(p, new URL('http://x.ha.local/'), PUBLIC), refused)
})

test('guardUrl: network:config takes a string or an array of URLs from the config and still blocks the LAN', async () => {
  const grant = ['network:config:feeds']
  await guardUrl(plugin(grant, { feeds: 'https://rss.example.org/a' }), new URL('https://rss.example.org/b'), PUBLIC)
  await guardUrl(plugin(grant, { feeds: ['https://x.org/', 'https://rss.example.org/a'] }), new URL('https://rss.example.org/'), PUBLIC)
  await assert.rejects(guardUrl(plugin(grant, { feeds: ['https://x.org/'] }), new URL('https://rss.example.org/'), PUBLIC), refused)
  await assert.rejects(guardUrl(plugin(grant, {}), new URL('https://rss.example.org/'), PUBLIC), refused)
  await assert.rejects(guardUrl(plugin(grant, { feeds: 5 }), new URL('https://rss.example.org/'), PUBLIC), refused)
  await assert.rejects(guardUrl(plugin(grant, { feeds: 'https://rss.example.org/' }), new URL('https://rss.example.org/'), async () => ['10.0.0.1']), refused)
})

test('guardUrl: lan:config takes hosts from the config, string or array, inside or out', async () => {
  const grant = ['lan:config:ha']
  await guardUrl(plugin(grant, { ha: 'http://192.168.1.5:8123' }), new URL('http://192.168.1.5:8123/api'), PUBLIC)
  await guardUrl(plugin(grant, { ha: ['http://a.local', 'http://192.168.1.5'] }), new URL('http://192.168.1.5/'), PUBLIC)
  await assert.rejects(guardUrl(plugin(grant, { ha: 'http://192.168.1.5' }), new URL('http://192.168.1.6/'), PUBLIC), refused)
  await assert.rejects(guardUrl(plugin(grant, {}), new URL('http://192.168.1.5/'), PUBLIC), refused)
})

async function server(handler: http.RequestListener): Promise<{ port: number; close: () => void }> {
  const s = http.createServer(handler)
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  return { port: (s.address() as AddressInfo).port, close: () => { s.closeAllConnections(); s.close() } }
}

test('fetch: returns status, headers and body; connects to the checked address', async () => {
  const s = await server((req, res) => { res.setHeader('x-a', '1'); res.end(`hi ${req.headers.host}`) })
  try {
    const p = plugin(['lan:fake.local'])
    const res = await guardedFetch(p, `http://fake.local:${s.port}/`, {}, async () => ['127.0.0.1'])
    assert.equal(res.status, 200)
    assert.equal(res.headers['x-a'], '1')
    assert.equal(res.text(), `hi fake.local:${s.port}`)
    assert.deepEqual([...res.bytes()].length, res.text().length)
  } finally { s.close() }
})

test('fetch: a redirect to an unlisted host is refused, to a listed one is followed, and 5 hops is the limit', async () => {
  const s = await server((req, res) => {
    if (req.url === '/to-evil') { res.writeHead(302, { location: 'http://evil.local/' }); res.end(); return }
    if (req.url === '/ok') { res.writeHead(302, { location: '/final' }); res.end(); return }
    if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); return }
    res.end('final')
  })
  try {
    const p = plugin(['lan:fake.local'])
    const lookup = async () => ['127.0.0.1']
    await assert.rejects(guardedFetch(p, `http://fake.local:${s.port}/to-evil`, {}, lookup), refused)
    assert.equal((await guardedFetch(p, `http://fake.local:${s.port}/ok`, {}, lookup)).text(), 'final')
    await assert.rejects(guardedFetch(p, `http://fake.local:${s.port}/loop`, {}, lookup), (e: unknown) => e instanceof BrainError)
  } finally { s.close() }
})

test('fetch: too large a response and a slow server fail; options can lower the caps but not raise them', async () => {
  const s = await server((req, res) => {
    if (req.url === '/slow') return
    res.end('x'.repeat(2000))
  })
  try {
    const p = plugin(['lan:fake.local'])
    const lookup = async () => ['127.0.0.1']
    await assert.rejects(guardedFetch(p, `http://fake.local:${s.port}/big`, { maxBytes: 1000 }, lookup), (e: unknown) => e instanceof BrainError && e.code === 'PAYLOAD_TOO_LARGE')
    assert.equal((await guardedFetch(p, `http://fake.local:${s.port}/big`, { maxBytes: 10 ** 12 }, lookup)).text().length, 2000)
    await assert.rejects(guardedFetch(p, `http://fake.local:${s.port}/slow`, { timeoutMs: 50 }, lookup), (e: unknown) => e instanceof BrainError && e.code === 'UNAVAILABLE')
  } finally { s.close() }
})

test('fetch: a URL with credentials, an invalid URL and an unlisted host are refused before any connection', async () => {
  const p = plugin(['network:example.com'])
  await assert.rejects(guardedFetch(p, 'https://u:p@example.com/', {}, PUBLIC), refused)
  await assert.rejects(guardedFetch(p, 'not a url', {}, PUBLIC), (e: unknown) => e instanceof BrainError && e.code === 'INVALID_ARGUMENT')
  await assert.rejects(guardedFetch(p, 'https://other.com/', {}, PUBLIC), refused)
})

// ---- review round 1 -------------------------------------------------------------------------------------------------

test('guardUrl: a URL with only a password is refused, a trailing dot on the host is ignored', async () => {
  const p = plugin(['network:example.com'])
  await assert.rejects(guardUrl(p, new URL('http://:pw@example.com/'), PUBLIC), refused)
  await guardUrl(p, new URL('https://example.com./x'), PUBLIC)
  await assert.rejects(guardUrl(p, new URL('https://example.com.evil.com./x'), PUBLIC), refused)
  await guardUrl(plugin(['network:config:feeds'], { feeds: 'https://rss.example.org/a' }), new URL('https://rss.example.org./'), PUBLIC)
})

const lookup = async () => ['127.0.0.1']
const origin = (port: number, host = 'fake.local') => `http://${host}:${port}`

test('fetch: options cannot raise the timeout or the size cap past the defaults', async (t) => {
  const delays: number[] = []
  const real = globalThis.setTimeout
  t.mock.method(globalThis, 'setTimeout', ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    delays.push(ms ?? 0)
    return (real as (...a: unknown[]) => NodeJS.Timeout)(fn, ms, ...rest)
  }) as never)
  const s = await server((req, res) => { res.end(req.url === '/huge' ? Buffer.alloc(9 * 1024 * 1024) : 'ok') })
  try {
    const p = plugin(['lan:fake.local'])
    assert.equal((await guardedFetch(p, `${origin(s.port)}/small`, { timeoutMs: 10 ** 9 }, lookup)).text(), 'ok')
    const timers = delays.filter((ms) => ms > 1000)
    assert.ok(timers.length > 0 && timers.every((ms) => ms <= 20_000), String(delays))
    await assert.rejects(guardedFetch(p, `${origin(s.port)}/huge`, { maxBytes: 10 ** 12 }, lookup), (e: unknown) => e instanceof BrainError && e.code === 'PAYLOAD_TOO_LARGE')
  } finally { s.close() }
})

test('fetch: a smaller timeout takes effect', async () => {
  const s = await server(() => undefined)
  try {
    const started = Date.now()
    await assert.rejects(guardedFetch(plugin(['lan:fake.local']), `${origin(s.port)}/`, { timeoutMs: 200 }, lookup), (e: unknown) => e instanceof BrainError && e.code === 'UNAVAILABLE')
    const took = Date.now() - started
    assert.ok(took >= 150 && took < 2000, `took ${took} ms`)
  } finally { s.close() }
})

test('fetch: timeoutMs is the total time, so a server that trickles bytes still fails on time', async () => {
  const s = await server((_, res) => {
    res.writeHead(200)
    const ticker = setInterval(() => res.write('x'), 50)
    res.on('close', () => clearInterval(ticker))
  })
  try {
    const started = Date.now()
    await assert.rejects(guardedFetch(plugin(['lan:fake.local']), `${origin(s.port)}/`, { timeoutMs: 300 }, lookup), (e: unknown) => e instanceof BrainError && e.code === 'UNAVAILABLE')
    const took = Date.now() - started
    assert.ok(took >= 250 && took < 1500, `took ${took} ms`)
  } finally { s.close() }
})

test('fetch: five redirects are followed, a sixth is refused', async () => {
  const s = await server((req, res) => {
    const [, kind, n, last] = /^\/(\w+)\/(\d+)\/(\d+)$/.exec(req.url ?? '') ?? []
    if (kind === undefined) { res.end('?'); return }
    if (Number(n) < Number(last)) { res.writeHead(302, { location: `/${kind}/${Number(n) + 1}/${last}` }); res.end(); return }
    res.end('arrived')
  })
  try {
    const p = plugin(['lan:fake.local'])
    assert.equal((await guardedFetch(p, `${origin(s.port)}/h/0/5`, {}, lookup)).text(), 'arrived')
    await assert.rejects(guardedFetch(p, `${origin(s.port)}/h/0/6`, {}, lookup), (e: unknown) => e instanceof BrainError && e.code === 'UNAVAILABLE')
  } finally { s.close() }
})

test('fetch: the body and custom headers reach the server; 303 turns POST into a body-less GET, 307 and 308 keep method and body', async () => {
  const seen: { url: string; method: string; body: string; headers: http.IncomingHttpHeaders }[] = []
  const s = await server((req, res) => {
    const parts: Buffer[] = []
    req.on('data', (c: Buffer) => parts.push(c))
    req.on('end', () => {
      seen.push({ url: req.url ?? '', method: req.method ?? '', body: Buffer.concat(parts).toString(), headers: req.headers })
      const [, code] = /^\/r(\d+)$/.exec(req.url ?? '') ?? []
      if (code !== undefined) { res.writeHead(Number(code), { location: '/end' }); res.end(); return }
      res.end('done')
    })
  })
  try {
    const p = plugin(['lan:fake.local'])
    const options = { method: 'POST', body: 'payload', headers: { 'x-custom': 'yes', 'content-type': 'text/plain' } }
    await guardedFetch(p, `${origin(s.port)}/direct`, options, lookup)
    assert.deepEqual([seen[0]!.method, seen[0]!.body, seen[0]!.headers['x-custom'], seen[0]!.headers['content-type']], ['POST', 'payload', 'yes', 'text/plain'])
    for (const [code, method, body] of [[303, 'GET', ''], [307, 'POST', 'payload'], [308, 'POST', 'payload']] as const) {
      seen.length = 0
      await guardedFetch(p, `${origin(s.port)}/r${code}`, options, lookup)
      const end = seen.find((entry) => entry.url === '/end')!
      assert.deepEqual([end.method, end.body], [method, body], String(code))
    }
  } finally { s.close() }
})

test('fetch: a redirect to another host or port drops authorization, cookie and proxy-authorization; the same origin keeps them', async () => {
  const seen: Record<string, http.IncomingHttpHeaders> = {}
  const handler = (name: string): http.RequestListener => (req, res) => {
    seen[`${name}${req.url}`] = req.headers
    if (req.url?.startsWith('/jump?')) { res.writeHead(302, { location: decodeURIComponent(req.url.slice(6)) }); res.end(); return }
    res.end('ok')
  }
  const a = await server(handler('a'))
  const b = await server(handler('b'))
  try {
    const p = plugin(['lan:fake.local', 'lan:other.local'])
    const headers = { Authorization: 'Bearer abc', COOKIE: 'a=1', 'Proxy-Authorization': 'Basic x', 'x-keep': 'k' }
    const go = (target: string) => guardedFetch(p, `${origin(a.port)}/jump?${encodeURIComponent(target)}`, { headers }, lookup)

    await go(`${origin(a.port)}/same`)
    assert.deepEqual([seen['a/same']!.authorization, seen['a/same']!.cookie, seen['a/same']!['proxy-authorization'], seen['a/same']!['x-keep']], ['Bearer abc', 'a=1', 'Basic x', 'k'])

    await go(`${origin(a.port, 'other.local')}/otherhost`)
    await go(`${origin(b.port)}/otherport`)
    for (const key of ['a/otherhost', 'b/otherport']) {
      assert.deepEqual([seen[key]!.authorization, seen[key]!.cookie, seen[key]!['proxy-authorization']], [undefined, undefined, undefined], key)
      assert.equal(seen[key]!['x-keep'], 'k', key)
    }
  } finally { a.close(); b.close() }
})

// ---- review round 2 -------------------------------------------------------------------------------------------------

test('fetch: a header the HTTP client refuses ends as INVALID_ARGUMENT without echoing the original error', async () => {
  const s = await server((_req, res) => { res.end('ok') })
  try {
    const p = plugin(['lan:fake.local'])
    await assert.rejects(
      guardedFetch(p, `${origin(s.port)}/`, { headers: { 'x-bad': 'a\r\nInjected: 1' } }, lookup),
      (e: unknown) => e instanceof BrainError && e.code === 'INVALID_ARGUMENT' && e.message === 'invalid request',
    )
  } finally { s.close() }
})

// ---- review round 3 -------------------------------------------------------------------------------------------------

test('fetch: a body Node refuses to write ends as INVALID_ARGUMENT and the request is destroyed', async () => {
  const s = await server((_req, res) => { res.end('ok') })
  try {
    const p = plugin(['lan:fake.local'])
    await assert.rejects(
      guardedFetch(p, `${origin(s.port)}/`, { method: 'POST', body: { a: 1 } as unknown as string }, lookup),
      (e: unknown) => e instanceof BrainError && e.code === 'INVALID_ARGUMENT' && e.message === 'invalid request',
    )
  } finally { s.close() }
})

// ---- cleanroom safe-fetch boundary coverage -------------------------------------------------------------------------

test('isPrivateIp: RFC 6890 reserved ranges, cloud metadata, embedded IPv4 and malformed inputs', () => {
  const privateCases: readonly unknown[] = [
    '168.63.129.16',
    '198.18.0.1',
    '198.19.255.254',
    '192.0.0.1',
    '100.64.0.1',
    '100.127.255.254',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.255.254',
    '10.255.255.254',
    '127.255.255.254',
    '169.254.169.254',
    '0.0.0.1',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '64:ff9b:1::1',
    '2001:db8::1',
    '2001:2::1',
    '2001:10::1',
    '2001:20::1',
    'fec0::1',
    'ff02::1',
    'fc00::1',
    '::ffff:0:7f00:1',
    '::ffff:0:10.0.0.1',
    '::127.0.0.1',
    '::10.0.0.1',
    '64:ff9b::10.0.0.1',
    '64:ff9b::168.63.129.16',
    '2002:0a00:0001::1',
    '2002:7f00:0001::1',
    '[::1]',
    '[FE80::1]',
    '[::FFFF:127.0.0.1]',
    'fe80::1%lo0',
    '[::1%eth0]',
    '2606:4700:4700::1111%eth0',
    '[2606:4700:4700::1111%eth0]',
    '[::1',
    null,
    undefined,
    123,
    {},
  ]
  for (const ip of privateCases) {
    assert.equal(isPrivateIp(ip), true, String(ip))
  }

  const publicCases: readonly string[] = [
    '168.63.129.17',
    '198.20.0.1',
    '198.17.255.254',
    '192.0.1.1',
    '100.63.255.255',
    '100.128.0.1',
    '172.15.255.255',
    '172.32.0.1',
    '64:ff9b::8.8.8.8',
    '64:ff9b::0808:0808',
    '2002:0808:0808::1',
    '::ffff:8.8.8.8',
    '::ffff:0:8.8.8.8',
    '::8.8.8.8',
    '[2606:4700:4700::1111]',
  ]
  for (const ip of publicCases) {
    assert.equal(isPrivateIp(ip), false, ip)
  }
})

// ---- Wave 0B: redirect & isLoopbackIp ------------------------------------------------------------------------------

test('isLoopbackIp: true only for 127.0.0.0/8, ::1, and ::ffff:127.0.0.0/104 (fail-closed)', () => {
  const loopbackCases: readonly unknown[] = [
    '127.0.0.1',
    '127.0.0.0',
    '127.255.255.254',
    '::1',
    '[::1]',
    '0:0:0:0:0:0:0:1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:127.255.255.254',
    '[::FFFF:127.0.0.1]',
  ]
  for (const ip of loopbackCases) {
    assert.equal(isLoopbackIp(ip), true, String(ip))
  }

  const nonLoopbackCases: readonly unknown[] = [
    '0.0.0.0',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '128.0.0.1',
    '93.184.216.34',
    '::',
    'fe80::1',
    'fc00::1',
    '::ffff:0:127.0.0.1',
    '::ffff:0:7f00:1',
    '::ffff:10.0.0.1',
    '::ffff:128.0.0.1',
    '127.0.0.1%eth0',
    '::1%lo0',
    '[::1%eth0]',
    '[::1',
    '',
    'localhost',
    'garbage',
    null,
    undefined,
    123,
    {},
  ]
  for (const ip of nonLoopbackCases) {
    assert.equal(isLoopbackIp(ip), false, String(ip))
  }
})

test('fetch: redirect: "error" rejects all 3xx redirects (even without location header), and invalid redirect throws INVALID_ARGUMENT', async () => {
  let targetHits = 0
  const s = await server((req, res) => {
    if (req.url === '/target') {
      targetHits += 1
      res.end('target')
      return
    }
    const match = /^\/r(\d+)(?:-(noloc))?$/.exec(req.url ?? '')
    if (match !== null) {
      const status = Number(match[1])
      if (match[2] === 'noloc') {
        res.writeHead(status)
      } else {
        res.writeHead(status, { location: '/target' })
      }
      res.end()
      return
    }
    res.end('ok')
  })
  try {
    const p = plugin(['lan:fake.local'])
    await assert.rejects(
      guardedFetch(p, `${origin(s.port)}/ok`, { redirect: 'manual' as never }, lookup),
      (e: unknown) => e instanceof BrainError && e.code === 'INVALID_ARGUMENT' && e.message === 'invalid redirect option',
    )
    for (const status of [301, 302, 303, 307, 308]) {
      await assert.rejects(
        guardedFetch(p, `${origin(s.port)}/r${status}`, { redirect: 'error' }, lookup),
        (e: unknown) => e instanceof BrainError && e.code === 'PERMISSION_DENIED' && e.message === 'redirects are not allowed',
      )
      await assert.rejects(
        guardedFetch(p, `${origin(s.port)}/r${status}-noloc`, { redirect: 'error' }, lookup),
        (e: unknown) => e instanceof BrainError && e.code === 'PERMISSION_DENIED' && e.message === 'redirects are not allowed',
      )
    }
    assert.equal(targetHits, 0)
    assert.equal((await guardedFetch(p, `${origin(s.port)}/r302`, { redirect: 'follow' }, lookup)).text(), 'target')
    assert.equal(targetHits, 1)
  } finally { s.close() }
})
