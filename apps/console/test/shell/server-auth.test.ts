import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { LIMITS, validate } from '@dsh-brain-core/sdk'
import { makeBrainHome, startConsole, TOKEN, type TempHome, type TestConsole } from './helpers.ts'

const PROTECTED_ROUTES: readonly { readonly method: string; readonly route: string; readonly body?: unknown }[] = [
  { method: 'GET', route: '/api/v1/console/session' },
  { method: 'GET', route: '/api/v1/console/settings' },
  { method: 'PUT', route: '/api/v1/console/settings/model', body: { agentClass: 'chat', provider: 'deepseek-official', model: 'deepseek-flash', effort: 'high' } },
  { method: 'PUT', route: '/api/v1/console/settings/secret', body: { name: 'deepseek-api-key', value: 'sk-should-never-be-written' } },
  {
    method: 'PUT',
    route: '/api/v1/console/settings/role-card',
    body: { mode: 'raw', name: '小满', text: '# 小满\n' },
  },
]

async function withConsole(run: (console: TestConsole, home: TempHome) => Promise<void>): Promise<void> {
  const home = await makeBrainHome()
  const consoleServer = await startConsole(home)
  try {
    await run(consoleServer, home)
  } finally {
    await consoleServer.close()
    await home.close()
  }
}

function assertUnauthenticated(body: Record<string, unknown>): void {
  assert.equal(body.ok, false)
  const error = body.error as { code?: string } | undefined
  assert.equal(error?.code, 'UNAUTHENTICATED')
}

test('every console API route answers 401 UNAUTHENTICATED without a token', async () => {
  await withConsole(async (consoleServer) => {
    for (const { method, route, body } of PROTECTED_ROUTES) {
      const result = await consoleServer.request(method, route, { token: null, ...(body === undefined ? {} : { body }) })
      assert.equal(result.status, 401, `${method} ${route}`)
      validate('Envelope', result.body)
      assertUnauthenticated(result.body)
    }
  })
})

test('a wrong token answers 401 UNAUTHENTICATED on every console API route', async () => {
  await withConsole(async (consoleServer) => {
    for (const { method, route, body } of PROTECTED_ROUTES) {
      const result = await consoleServer.request(method, route, { token: 'not-the-token', ...(body === undefined ? {} : { body }) })
      assert.equal(result.status, 401, `${method} ${route}`)
      assertUnauthenticated(result.body)
    }
  })
})

test('a rejected write leaves nothing behind on disk', async () => {
  await withConsole(async (consoleServer, home) => {
    for (const { method, route, body } of PROTECTED_ROUTES) {
      await consoleServer.request(method, route, { token: 'not-the-token', ...(body === undefined ? {} : { body }) })
    }
    const settings = await readFile(path.join(home.state, 'settings.json'), 'utf8').catch(() => undefined)
    const secrets = await readFile(path.join(home.state, 'secrets.json'), 'utf8').catch(() => undefined)
    assert.equal(settings, undefined, 'a rejected model write must not create settings.json')
    assert.equal(secrets, undefined, 'a rejected secret write must not create secrets.json')
  })
})

test('the right token answers 200 with a valid envelope', async () => {
  await withConsole(async (consoleServer) => {
    const result = await consoleServer.request('GET', '/api/v1/console/session')
    assert.equal(result.status, 200)
    validate('Envelope', result.body)
    assert.equal(result.body.ok, true)
    assert.deepEqual(result.body.data, { authenticated: true })
  })
})

test('GET / without a token renders the SYNAPSE SPA login shell and no settings or business data', async () => {
  await withConsole(async (consoleServer, home) => {
    // 先写一份设置、密钥和一张角色卡：未登录的壳连它们存在都不该透露。
    await consoleServer.request('PUT', '/api/v1/console/settings/model', {
      body: { agentClass: 'chat', provider: 'deepseek-official', model: 'deepseek-flash', effort: 'high' },
    })
    await consoleServer.request('PUT', '/api/v1/console/settings/secret', {
      body: { name: 'deepseek-api-key', value: 'sk-auth-secret-never-leaked' },
    })
    await consoleServer.request('PUT', '/api/v1/console/settings/role-card', {
      body: { mode: 'raw', name: '小满', text: '# 小满\n' },
    })
    const settingsFile = await readFile(path.join(home.state, 'settings.json'), 'utf8')

    const html = await consoleServer.html('/')
    assert.match(html, /id="token-login-form"/)
    assert.match(html, /type="password"/)
    assert.match(html, /\/synapse\/assets\//)
    assert.ok(!html.includes('settings-panel'), 'the settings panel must not render before the token is checked')
    assert.ok(!html.includes('data-agent-class'), 'model pickers must not render before the token is checked')
    assert.ok(!html.includes('小满'), 'the active role card must not render before the token is checked')
    assert.ok(!html.includes('deepseek-flash'), 'model names must not render before the token is checked')
    assert.ok(!html.includes('sk-auth-secret-never-leaked'), 'secret plaintext must never render in GET /')
    assert.ok(!settingsFile.includes(TOKEN))
  })
})

test('GET / with the right token still serves the pure SYNAPSE SPA shell without leaking settings or business data', async () => {
  await withConsole(async (consoleServer) => {
    await consoleServer.request('PUT', '/api/v1/console/settings/model', {
      body: { agentClass: 'chat', provider: 'deepseek-official', model: 'deepseek-flash', effort: 'high' },
    })
    await consoleServer.request('PUT', '/api/v1/console/settings/secret', {
      body: { name: 'deepseek-api-key', value: 'sk-auth-secret-never-leaked' },
    })
    await consoleServer.request('PUT', '/api/v1/console/settings/role-card', {
      body: { mode: 'raw', name: '小满', text: '# 小满\n' },
    })
    const html = await consoleServer.html('/', TOKEN)
    assert.match(html, /id="token-login-form"/)
    assert.match(html, /type="password"/)
    assert.match(html, /\/synapse\/assets\//)
    assert.ok(!html.includes('settings-panel'))
    assert.ok(!html.includes('data-agent-class'))
    assert.ok(!html.includes('小满'))
    assert.ok(!html.includes('deepseek-flash'))
    assert.ok(!html.includes('sk-auth-secret-never-leaked'))
  })
})

test('GET / honours the theme query and rejects an unknown one', async () => {
  await withConsole(async (consoleServer) => {
    assert.match(await consoleServer.html('/?theme=light'), /data-theme="light"/)
    assert.match(await consoleServer.html('/?theme=light'), /\/synapse\/assets\//)
    assert.match(await consoleServer.html('/?theme=light', TOKEN), /data-theme="light"/)
    assert.match(await consoleServer.html('/?theme=auto'), /data-theme="auto"/)
    assert.match(await consoleServer.html('/?theme=dark'), /data-theme="dark"/)
    assert.match(await consoleServer.html('/?theme=neon'), /data-theme="dark"/)
  })
})

test('unknown console routes are 404, and extraRoutes takes what it claims', async () => {
  const home = await makeBrainHome()
  const consoleServer = await startConsole(home, {
    extraRoutes: async (method, route, body) => (
      method === 'GET' && route === '/api/v1/console/plugins/list' ? { items: [], echoed: body } : undefined
    ),
  })
  try {
    const missing = await consoleServer.request('GET', '/api/v1/console/nope')
    assert.equal(missing.status, 404)
    assert.equal((missing.body.error as { code?: string }).code, 'NOT_FOUND')

    const handled = await consoleServer.request('GET', '/api/v1/console/plugins/list')
    assert.equal(handled.status, 200)
    assert.deepEqual(handled.body.data, { items: [] })

    // extraRoutes 也在鉴权之后：未登录时不会走到它。
    const unauthenticated = await consoleServer.request('GET', '/api/v1/console/plugins/list', { token: null })
    assert.equal(unauthenticated.status, 401)
  } finally {
    await consoleServer.close()
    await home.close()
  }
})

function findExternalIPv4(): string | undefined {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return undefined
}

/** 'CONNECTED' when the port answered, otherwise the socket error code (or ETIMEDOUT). */
function connectOutcome(port: number, host: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ port, host })
    let settled = false
    const done = (outcome: string): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(outcome)
    }
    socket.setTimeout(3000, () => done('ETIMEDOUT'))
    socket.once('connect', () => done('CONNECTED'))
    socket.once('error', (error: NodeJS.ErrnoException) => done(error.code ?? 'ERROR'))
  })
}

test('the server only listens on loopback', async () => {
  const home = await makeBrainHome()
  const consoleServer = await startConsole(home)
  try {
    const local = await fetch(`http://127.0.0.1:${String(consoleServer.port)}/api/v1/console/session`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    assert.equal(local.status, 200)

    const external = findExternalIPv4()
    if (external === undefined) {
      console.log('no non-internal IPv4 address on this machine; skipped the outside-connection check')
      return
    }
    const outcome = await connectOutcome(consoleServer.port, external)
    assert.notEqual(outcome, 'CONNECTED', `the console answered on the external address ${external}`)
    if (process.platform === 'win32') {
      // The Windows runner's firewall drops the packet instead of sending a reset.
      console.log(`connecting to ${external}:${String(consoleServer.port)} gave ${outcome} on Windows (not CONNECTED)`)
    } else {
      assert.equal(outcome, 'ECONNREFUSED')
    }
  } finally {
    await consoleServer.close()
    await home.close()
  }
})

test('a token that still answers 200 leaves no room for another auth scheme', async () => {
  await withConsole(async (consoleServer) => {
    // `Basic  ` 后面直接跟令牌：跳过前 7 个字符正好等于 TOKEN，只有 `Bearer ` 前缀能挡住它。
    const result = await consoleServer.request('GET', '/api/v1/console/session', {
      token: null,
      headers: { Authorization: `Basic  ${TOKEN}` },
    })
    assert.equal(result.status, 401)
    assertUnauthenticated(result.body)
  })
})

test('the bare login shell never reads the settings, so a broken secrets file still renders it', async () => {
  await withConsole(async (consoleServer, home) => {
    await mkdir(home.state, { recursive: true })
    await writeFile(path.join(home.state, 'secrets.json'), '{broken', 'utf8')
    const html = await consoleServer.html('/')
    assert.match(html, /id="token-login-form"/)
    assert.ok(!html.includes('settings-panel'))
  })
})

test('a request body over the limit answers 413 PAYLOAD_TOO_LARGE', async () => {
  await withConsole(async (consoleServer) => {
    const result = await consoleServer.request('PUT', '/api/v1/console/settings/model', {
      body: JSON.stringify({ x: 'a'.repeat(LIMITS.requestBytes + 100) }),
    })
    assert.equal(result.status, 413)
    assert.equal((result.body.error as { code?: string }).code, 'PAYLOAD_TOO_LARGE')
  })
})

test('a body that is not JSON answers 400 INVALID_ARGUMENT', async () => {
  await withConsole(async (consoleServer) => {
    const result = await consoleServer.request('PUT', '/api/v1/console/settings/model', { body: '{not json' })
    assert.equal(result.status, 400)
    assert.equal((result.body.error as { code?: string }).code, 'INVALID_ARGUMENT')
  })
})

test('a settings file that is not JSON still serves the shell instead of crashing', async () => {
  await withConsole(async (consoleServer, home) => {
    await writeFile(path.join(home.state, 'settings.json'), '{broken', 'utf8').catch(async () => {
      const { mkdir } = await import('node:fs/promises')
      await mkdir(home.state, { recursive: true })
      await writeFile(path.join(home.state, 'settings.json'), '{broken', 'utf8')
    })
    const result = await consoleServer.request('GET', '/api/v1/console/settings')
    assert.equal(result.status, 200)
    const data = result.body.data as { agents: unknown }
    assert.deepEqual(data.agents, {})
  })
})
