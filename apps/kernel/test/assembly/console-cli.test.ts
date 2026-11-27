import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { writeFileAtomic } from '@dsh-brain-core/shared'
import { createSecretStore } from '../../src/secrets/index.ts'
import { createSettingsStore } from '../../src/runtime-stores/settings.ts'

const CLI = fileURLToPath(new URL('../../src/cli.ts', import.meta.url))
const CONSOLE_CHAT_PLUGIN = fileURLToPath(new URL('../../../../plugins/console-chat', import.meta.url))

async function tempHome(t: { after(fn: () => Promise<void> | void): void }): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brain-console-cli-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  return dir
}

/** Every CLI child resolves DSH_HOME inside its own temp dir, never the real ~/.dsh. */
function dshHomeOf(homeDir: string): string {
  const dir = path.join(homeDir, 'dsh')
  mkdirSync(dir, { recursive: true })
  return dir
}

async function hashTree(rootDir: string, currentDir = rootDir, out = new Map<string, string>()): Promise<Map<string, string>> {
  const entries = await readdir(currentDir, { withFileTypes: true })
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name)
    if (entry.isDirectory()) {
      await hashTree(rootDir, fullPath, out)
    } else if (entry.isFile()) {
      const content = await readFile(fullPath)
      const rel = path.relative(rootDir, fullPath).split(path.sep).join('/')
      out.set(rel, createHash('sha256').update(content).digest('hex'))
    }
  }
  return out
}

function runCliSync(homeDir: string, args: readonly string[]): {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
} {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, BRAIN_HOME: homeDir, DSH_HOME: dshHomeOf(homeDir) },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

interface SpawnedConsole {
  readonly child: ReturnType<typeof spawn>
  readonly consoleUrl: string
  readonly apiUrl: string
  readonly token: string
  readonly stdoutLines: readonly string[]
  readonly getOutput: () => { readonly stdout: string; readonly stderr: string }
}

async function spawnBrainConsole(
  t: { after(fn: () => Promise<void> | void): void },
  homeDir: string,
  extraArgs: readonly string[] = ['--port', '0', '--api-port', '0'],
): Promise<SpawnedConsole> {
  const child = spawn(process.execPath, [CLI, 'console', ...extraArgs], {
    env: { ...process.env, BRAIN_HOME: homeDir, DSH_HOME: dshHomeOf(homeDir) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  t.after(() => { if (child.exitCode === null) child.kill() })

  assert.ok(child.stdout !== null)
  assert.ok(child.stderr !== null)
  const stdout = child.stdout
  const stderr = child.stderr
  stdout.setEncoding('utf8')
  stderr.setEncoding('utf8')

  const lines: string[] = []
  let stdoutText = ''
  let stderrText = ''
  stderr.on('data', (chunk: string) => { stderrText += chunk })

  const ready = await new Promise<{ consoleUrl: string; apiUrl: string; token: string }>((resolve, reject) => {
    let buffer = ''
    stdout.on('data', (chunk: string) => {
      stdoutText += chunk
      buffer += chunk
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        lines.push(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
      }
      const consoleMatch = /^Brain console: (http:\/\/127\.0\.0\.1:\d+)$/.exec(lines[0] ?? '')
      const apiMatch = /^Brain memory API: (http:\/\/127\.0\.0\.1:\d+\/api\/v1)$/.exec(lines[1] ?? '')
      const tokenMatch = /^Token: (.+)$/.exec(lines[2] ?? '')
      if (consoleMatch !== null && apiMatch !== null && tokenMatch !== null) {
        resolve({
          consoleUrl: consoleMatch[1] as string,
          apiUrl: apiMatch[1] as string,
          token: tokenMatch[1] as string,
        })
      }
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      reject(new Error(`brain console exited early with ${String(code)}: ${stderrText}`))
    })
  })

  return { child, ...ready, stdoutLines: lines, getOutput: () => ({ stdout: stdoutText, stderr: stderrText }) }
}

async function fetchJson(
  baseUrl: string,
  route: string,
  options: { readonly token?: string; readonly method?: string; readonly body?: unknown } = {},
): Promise<{ readonly status: number; readonly raw: string; readonly json: Record<string, unknown> }> {
  const headers: Record<string, string> = {}
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`
  if (options.body !== undefined) headers['content-type'] = 'application/json'

  const response = await fetch(`${baseUrl}${route}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  const raw = await response.text()
  return { status: response.status, raw, json: JSON.parse(raw) as Record<string, unknown> }
}

test('brain console validates arguments and refuses to start while a kernel is running', async (t) => {
  const dir = await tempHome(t)

  for (const args of [
    ['console', '--port', 'nope'],
    ['console', '--port', '-1'],
    ['console', '--port', '65536'],
    ['console', '--port', ''],
    ['console', '--api-port', 'nope'],
    ['console', '--api-port', '70000'],
    ['console', '--cross-channel', 'invalid'],
    ['console', '--port', '18000', '--api-port', '18000'],
    ['console', '--unknown-flag'],
    ['console', 'unexpected-positional'],
  ]) {
    const result = runCliSync(dir, args)
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`)
    assert.match(result.stderr, /brain console/)
  }

  await mkdir(path.join(dir, 'state'), { recursive: true })
  await writeFileAtomic(path.join(dir, 'state', 'kernel.pid'), `${process.pid}\n`)

  const conflict = runCliSync(dir, ['console', '--port', '0', '--api-port', '0'])
  assert.equal(conflict.status, 1)
  assert.match(conflict.stderr, /内核还在运行/)
})

test('brain console serves full-stack UI, persists settings, proxies kernel memory APIs, installs console-chat, and shuts down cleanly', async (t) => {
  const dir = await tempHome(t)
  const dshDir = dshHomeOf(dir)
  await writeFile(path.join(dshDir, 'sentinel.json'), '{"owner":"main-dsh"}\n', 'utf8')
  const dshBefore = await hashTree(dshDir)

  const spawned = await spawnBrainConsole(t, dir, [
    '--port', '0',
    '--api-port', '0',
    '--cross-channel', 'shadow',
    '--owner-channel', 'qq:private:owner',
  ])
  const { child, consoleUrl, apiUrl, token, stdoutLines } = spawned

  // Token is printed once only.
  assert.equal(stdoutLines.filter((line) => line.includes(token)).length, 1)
  assert.match(apiUrl, /^http:\/\/127\.0\.0\.1:\d+\/api\/v1$/)

  const pidFile = path.join(dir, 'state', 'kernel.pid')
  assert.equal((await readFile(pidFile, 'utf8')).trim(), String(child.pid))

  // 1. Unauthenticated access: GET / shows login box only; console APIs return 401.
  const loginRes = await fetch(`${consoleUrl}/`)
  assert.equal(loginRes.status, 200)
  const loginHtml = await loginRes.text()
  assert.match(loginHtml, /token-login-form/)
  assert.equal(loginHtml.includes('role-card-active'), false)
  assert.equal(loginHtml.includes('shared-quota-warning'), false)

  assert.equal((await fetch(`${consoleUrl}/api/v1/console/ui/state`)).status, 401)
  assert.equal((await fetch(`${consoleUrl}/api/v1/console/plugins`)).status, 401)

  // 2. Client asset returns 200 JS.
  const assetRes = await fetch(`${consoleUrl}/assets/console-client.js`, {
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(assetRes.status, 200)
  assert.match(assetRes.headers.get('content-type') ?? '', /javascript/)
  const assetJs = await assetRes.text()
  assert.ok(assetJs.length > 0)

  // 3. Session and all four core pages render real HTML when authenticated.
  const sessionRes = await fetchJson(consoleUrl, '/api/v1/console/session', { token })
  assert.equal(sessionRes.status, 200)
  assert.deepEqual(sessionRes.json.data, { authenticated: true })

  for (const [page, marker] of [
    ['settings', 'settings-agent'],
    ['memory', '三维筛选与检索'],
    ['satellite', '附属运行时与指标'],
    ['plugins', '安装插件'],
  ] as const) {
    const pageRes = await fetchJson(consoleUrl, `/api/v1/console/ui/state?page=${page}`, { token })
    assert.equal(pageRes.status, 200)
    const data = pageRes.json.data as { activePageId: string; mainHtml: string }
    assert.equal(data.activePageId, page)
    assert.ok(data.mainHtml.includes(marker), `page=${page} missing ${marker}`)
  }

  // 4. Settings persistence loop via POST /api/v1/console/ui/action (save-model, save-secret, save-role-raw).
  const secretValue = 'sk-isolated-secret-value-42'

  const modelRes = await fetchJson(consoleUrl, '/api/v1/console/ui/action', {
    token,
    method: 'POST',
    body: {
      action: 'save-model',
      page: 'settings',
      payload: {
        agentClass: 'chat',
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        effort: 'low',
      },
    },
  })
  assert.equal(modelRes.status, 200)
  assert.equal((modelRes.json.data as { toast?: { tone: string } }).toast?.tone, 'ok')

  const secretRes = await fetchJson(consoleUrl, '/api/v1/console/ui/action', {
    token,
    method: 'POST',
    body: {
      action: 'save-secret',
      page: 'settings',
      payload: {
        name: 'brain-deepseek-api-key',
        value: secretValue,
      },
    },
  })
  assert.equal(secretRes.status, 200)
  assert.equal(secretRes.raw.includes(secretValue), false, 'secret plaintext must never appear in HTTP response')
  assert.equal((secretRes.json.data as { sharedQuotaWarning: boolean }).sharedQuotaWarning, false)

  const roleRes = await fetchJson(consoleUrl, '/api/v1/console/ui/action', {
    token,
    method: 'POST',
    body: {
      action: 'save-role-raw',
      page: 'settings',
      payload: {
        name: 'xiaoman',
        text: '你是小满，一个温和细心的朋友。',
      },
    },
  })
  assert.equal(roleRes.status, 200)
  const roleData = roleRes.json.data as { roleCardName: string | null; mainHtml: string }
  assert.equal(roleData.roleCardName, 'xiaoman')
  assert.ok(roleData.mainHtml.includes('xiaoman'))
  assert.equal(roleRes.raw.includes(secretValue), false)

  // Verify settings, secret, and role card persisted on disk inside BRAIN_HOME.
  const storedSettings = await createSettingsStore(path.join(dir, 'state', 'settings.json')).read()
  assert.deepEqual(storedSettings.agents.chat, { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'low' })
  assert.equal(await createSecretStore({ file: path.join(dir, 'state', 'secrets.json') }).get('brain-deepseek-api-key'), secretValue)
  assert.match(await readFile(path.join(dir, 'state', 'roles', 'xiaoman.md'), 'utf8'), /你是小满/)

  // 5. Same-origin proxy writes an L0 memory event, renders it on memory page, and switches cross-channel mode.
  const memoryMarker = 'console-cli-e2e-l0-手冲桂花乌龙茶'
  const ingestRes = await fetchJson(consoleUrl, '/api/v1/memory/events', {
    token,
    method: 'POST',
    body: {
      kind: 'chat.message',
      channel: 'qq:group:alpha',
      subjects: ['self'],
      actor: 'self',
      content: { text: memoryMarker },
      tEvent: Date.now(),
      idempotencyKey: 'console-cli-l0-1',
      visibility: 'open',
    },
  })
  assert.equal(ingestRes.status, 202)

  const memoryStateRes = await fetchJson(consoleUrl, '/api/v1/console/ui/state?page=memory', { token })
  assert.equal(memoryStateRes.status, 200)
  const memoryHtml = (memoryStateRes.json.data as { mainHtml: string }).mainHtml
  assert.ok(memoryHtml.includes(memoryMarker), 'L0 memory event must appear on memory page')

  const crossRes = await fetchJson(consoleUrl, '/api/v1/console/ui/action', {
    token,
    method: 'POST',
    body: {
      action: 'set-cross-channel',
      page: 'memory',
      payload: { mode: 'on' },
    },
  })
  assert.equal(crossRes.status, 200)
  const crossCheck = await fetchJson(consoleUrl, '/api/v1/console/memory/cross-channel', { token })
  assert.equal(crossCheck.status, 200)
  assert.deepEqual(crossCheck.json.data, { mode: 'on' })

  // 6. Install and enable built-in plugins/console-chat via two-step permission preview -> confirm.
  assert.equal(existsSync(CONSOLE_CHAT_PLUGIN), true)
  const startInstallRes = await fetchJson(consoleUrl, '/api/v1/console/ui/action', {
    token,
    method: 'POST',
    body: {
      action: 'start-install',
      page: 'plugins',
      payload: { spec: CONSOLE_CHAT_PLUGIN },
    },
  })
  assert.equal(startInstallRes.status, 200)
  const previewHtml = (startInstallRes.json.data as { mainHtml: string }).mainHtml
  assert.ok(previewHtml.includes('console-chat'))
  assert.ok(previewHtml.includes('channel.provide'))

  const confirmInstallRes = await fetchJson(consoleUrl, '/api/v1/console/ui/action', {
    token,
    method: 'POST',
    body: {
      action: 'confirm-install',
      page: 'plugins',
      payload: {},
    },
  })
  assert.equal(confirmInstallRes.status, 200)

  const settingsWithPlugin = await fetchJson(consoleUrl, '/api/v1/console/ui/state?page=settings', { token })
  assert.equal(settingsWithPlugin.status, 200)
  const navItems = (settingsWithPlugin.json.data as { navItems: readonly { id: string; title: string; group: string }[] }).navItems
  assert.ok(
    navItems.some((item) => item.id === 'plugin:console-chat:chat' && item.title === '与她对话'),
    `expected console-chat nav item in ${JSON.stringify(navItems)}`,
  )

  const chatPageRes = await fetchJson(consoleUrl, '/api/v1/console/ui/state?page=plugin:console-chat:chat', { token })
  assert.equal(chatPageRes.status, 200)
  const chatData = chatPageRes.json.data as { activePageId: string; mainHtml: string }
  assert.equal(chatData.activePageId, 'plugin:console-chat:chat')
  assert.ok(chatData.mainHtml.includes('plugin-chat-panel'))
  assert.ok(chatData.mainHtml.includes('与她对话'))
  assert.ok(chatData.mainHtml.includes('data-form="plugin-chat-send"'))

  // Trigger authenticated and error kernel API requests so request logs are flushed to stderr.
  const apiHealth = await fetchJson(apiUrl, '/memory/health', { token })
  assert.equal(apiHealth.status, 200)
  const apiUnknown = await fetchJson(apiUrl, '/console/nonexistent-route', { token })
  assert.equal(apiUnknown.status, 404)
  const apiBadAuth = await fetchJson(apiUrl, '/memory/health', { token: 'wrong-token' })
  assert.equal(apiBadAuth.status, 401)

  // 7. Graceful shutdown via IPC disconnect deletes state/kernel.pid and exits 0.
  const exited = new Promise<number | null>((resolve) => { child.once('exit', (code) => resolve(code)) })
  assert.equal(typeof child.disconnect, 'function')
  child.disconnect()
  assert.equal(await exited, 0)
  assert.equal(existsSync(pidFile), false)

  // M57 & M58: after exit, full stdout prints Token: exactly once and full stderr never leaks plaintext token.
  const fullOutput = spawned.getOutput()
  assert.equal((fullOutput.stdout.match(/^Token:/gm) ?? []).length, 1, 'stdout must print Token: exactly once')
  assert.equal(fullOutput.stdout.split(token).length - 1, 1, 'stdout must print token value exactly once')
  assert.ok(fullOutput.stderr.includes('http.request'), 'stderr must record request logs')
  assert.equal(fullOutput.stderr.includes(token), false, 'stderr must never contain plaintext token')

  // Verify DSH_HOME remained untouched throughout the full-stack console session.
  const dshAfter = await hashTree(dshDir)
  assert.deepEqual([...dshAfter.entries()], [...dshBefore.entries()])
})

test('brain console cleans up the started kernel and leaves no kernel.pid when the console port is occupied', async (t) => {
  const dir = await tempHome(t)
  const blocker = createNetServer()
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject)
    blocker.listen({ host: '127.0.0.1', port: 0 }, () => {
      blocker.off('error', reject)
      resolve()
    })
  })
  t.after(async () => {
    await new Promise<void>((resolve) => blocker.close(() => resolve()))
  })
  const address = blocker.address()
  assert.ok(address !== null && typeof address === 'object')

  const child = spawn(process.execPath, [CLI, 'console', '--port', String(address.port), '--api-port', '0'], {
    env: { ...process.env, BRAIN_HOME: dir, DSH_HOME: dshHomeOf(dir) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })

  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => { stderr += chunk })

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  assert.equal(exit.signal, null)
  assert.equal(exit.code, 1, stderr)
  assert.equal(existsSync(path.join(dir, 'state', 'kernel.pid')), false)
})

test('brain console lists the 4 starter factory cards, previews them, and commits L3.1 on select', async (t) => {
  const dir = await tempHome(t)
  const dshDir = dshHomeOf(dir)
  await writeFile(path.join(dshDir, 'sentinel.json'), '{"owner":"main-dsh"}\n', 'utf8')
  const dshBefore = await hashTree(dshDir)

  const spawned = await spawnBrainConsole(t, dir)
  const { child, consoleUrl, token } = spawned

  const starterNames = [
    '小鲸鱼-松弛搭子',
    '小鲸鱼-傲娇本味',
    '小鲸鱼-温柔陪伴',
    '小鲸鱼-理性参谋',
  ] as const

  // 1. Fresh BRAIN_HOME exposes all 4 factory cards with no pre-selected roleCard.
  const initialSettings = await fetchJson(consoleUrl, '/api/v1/console/settings', { token })
  assert.equal(initialSettings.status, 200)
  const initialData = initialSettings.json.data as {
    readonly roleCard: { readonly name: string; readonly text: string } | null
    readonly availableRoleCards: readonly string[]
  }
  assert.equal(initialData.roleCard, null)
  for (const name of starterNames) {
    assert.ok(
      initialData.availableRoleCards.includes(name),
      `expected starter card ${name} in ${JSON.stringify(initialData.availableRoleCards)}`,
    )
  }

  // 2. Preview endpoint returns factory origin and full card text.
  const chosen = '小鲸鱼-松弛搭子'
  const previewRes = await fetchJson(
    consoleUrl,
    `/api/v1/console/settings/role-card?name=${encodeURIComponent(chosen)}`,
    { token },
  )
  assert.equal(previewRes.status, 200)
  const previewData = previewRes.json.data as {
    readonly name: string
    readonly text: string
    readonly origin: string
  }
  assert.equal(previewData.name, chosen)
  assert.equal(previewData.origin, 'factory')
  assert.ok(previewData.text.includes('你是小鲸鱼'))

  // 3. Selecting the factory card activates it and immediately commits an L3.1 profile version.
  const selectRes = await fetchJson(consoleUrl, '/api/v1/console/settings/role-card', {
    token,
    method: 'PUT',
    body: { mode: 'select', name: chosen },
  })
  assert.equal(selectRes.status, 200)
  assert.equal(existsSync(path.join(dir, 'state', 'roles', `${chosen}.md`)), false)

  const updatedSettings = await fetchJson(consoleUrl, '/api/v1/console/settings', { token })
  assert.equal(updatedSettings.status, 200)
  const updatedData = updatedSettings.json.data as {
    readonly roleCard: { readonly name: string; readonly text: string } | null
  }
  assert.deepEqual(updatedData.roleCard, { name: chosen, text: previewData.text })

  const l3Res = await fetchJson(consoleUrl, '/api/v1/console/memory/l3/versions', { token })
  assert.equal(l3Res.status, 200)
  const l3Items = (l3Res.json.data as {
    readonly items: readonly {
      readonly version: number
      readonly stable: string
      readonly data: Readonly<Record<string, unknown>>
    }[]
  }).items
  assert.equal(l3Items.length, 1)
  assert.equal(l3Items[0]?.version, 1)
  assert.deepEqual(l3Items[0]?.data, { roleCard: chosen })
  assert.ok(l3Items[0]?.stable.includes('你是小鲸鱼'))

  // 4. Clean shutdown and untouched DSH_HOME.
  const exited = new Promise<number | null>((resolve) => { child.once('exit', (code) => resolve(code)) })
  child.disconnect()
  assert.equal(await exited, 0)

  const dshAfter = await hashTree(dshDir)
  assert.deepEqual([...dshAfter.entries()], [...dshBefore.entries()])
})
