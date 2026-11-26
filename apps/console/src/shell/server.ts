import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync, type Dirent } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrainError, ERROR_CODES, LIMITS, type Envelope, type Meta } from '@brain-core/sdk'
import { createUlid, ensurePrivateDir, writeFileAtomic } from '@brain-core/shared'
import {
  requireSelection, SelectionMissingError,
  type AgentClass, type ModelSelection,
} from '@brain-core/satellite-host'
import { createSecretStore, type SecretStore } from './secrets.ts'
import {
  buildRoleCardFromInterview, SHARED_QUOTA_SECRET,
  type ConsoleSettingsView, type RoleCardInterviewInput,
} from './settings.ts'
import { createConsoleAppRouter, type ConsoleKernelApiOptions } from './app-router.ts'
import { renderConsoleClientScript } from './client-script.ts'
import { renderShellHtml, type ConsoleThemeMode, type NavItem } from './theme.ts'

export type { ConsoleKernelApiOptions }

export type RoleCardOrigin = 'factory' | 'user' | 'modified'

export interface RoleCardPreview {
  readonly name: string
  readonly text: string
  readonly origin: RoleCardOrigin
}

export interface ConsoleServerOptions {
  readonly token: string
  readonly port?: number
  readonly brainHome: string
  readonly webDistDir?: string
  readonly factoryRolesDir?: string
  readonly kernelApi?: ConsoleKernelApiOptions
  readonly onInvalidateRunner?: (agentClass: AgentClass) => void | Promise<void>
  readonly persistRoleCard?: (card: {
    readonly name: string
    readonly text: string
    readonly mode: 'select' | 'interview' | 'raw'
  }) => Promise<void> | void
  /** Extra route handler for sub-pages (/api/v1/console/plugins/*, /memory/*, /satellite/*, /accounting/*, /interop/*). */
  readonly extraRoutes?: (method: string, path: string, body: unknown) => Promise<unknown | undefined>
}

export interface ConsoleServer {
  listen(): Promise<{ readonly port: number }>
  close(): Promise<void>
}

const CONSOLE_PREFIX = '/api/v1/console'
const AGENT_CLASSES: readonly AgentClass[] = ['chat', 'activity']
const THEME_MODES: readonly ConsoleThemeMode[] = ['dark', 'light', 'auto']

/** The pages every console build has; the three page modules add their own data behind these ids. */
export const DEFAULT_NAV_ITEMS: readonly NavItem[] = [
  { id: 'settings', title: '设置', group: 'core' },
  { id: 'memory', title: '记忆', group: 'core' },
  { id: 'satellite', title: '运行状态', group: 'core' },
  { id: 'plugins', title: '插件', group: 'plugin' },
]

function sha256(text: string): Buffer {
  return createHash('sha256').update(text).digest()
}

/** Constant time even when the lengths differ: both sides are compared as fixed-length digests (FR-C01). */
function authorized(header: string | undefined, token: string): boolean {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  return timingSafeEqual(sha256(header.slice('Bearer '.length)), sha256(token))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function hasUnsafeRoleNameChar(value: string): boolean {
  for (const ch of value) {
    const code = ch.charCodeAt(0)
    if (
      code <= 0x1f
      || ch === '/' || ch === '\\'
      || ch === '<' || ch === '>' || ch === ':' || ch === '"' || ch === '|' || ch === '?' || ch === '*'
    ) {
      return true
    }
  }
  return false
}

/** A role name becomes a file name, so separators, Windows-illegal characters, README and dot-names are refused before anything touches the disk. */
function assertRoleName(name: string): string {
  const value = stringOf(name)
  if (value === '' || value.length > 62 || value === '.' || value === '..'
    || value.toUpperCase() === 'README' || hasUnsafeRoleNameChar(value)) {
    throw new BrainError('INVALID_ARGUMENT', 'invalid role card name', { field: 'name' })
  }
  return value
}

/** Ensures `<name>.md` resolves strictly inside `baseDir` so no traversal can escape the directory. */
function resolveSafeRoleFile(baseDir: string, name: string): string {
  const resolvedBase = path.resolve(baseDir)
  const resolvedFile = path.resolve(resolvedBase, `${name}.md`)
  const rel = path.relative(resolvedBase, resolvedFile)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes('/') || rel.includes('\\')) {
    throw new BrainError('INVALID_ARGUMENT', 'invalid role card name', { field: 'name' })
  }
  return resolvedFile
}

/**
 * Resolves symlinks for both `baseDir` and `<name>.md` and verifies the target is a regular file strictly
 * inside `realBase` (preventing symlink escape, directory `.md` entries, and README aliases).
 */
async function resolveAndCheckRealRoleFile(baseDir: string, name: string): Promise<string | null> {
  const candidate = resolveSafeRoleFile(baseDir, name)
  let realBase: string
  let realFile: string
  let fileStat: Awaited<ReturnType<typeof stat>>
  try {
    ;[realBase, realFile, fileStat] = await Promise.all([
      realpath(baseDir),
      realpath(candidate),
      stat(candidate),
    ])
  } catch {
    return null
  }
  if (!fileStat.isFile()) return null
  const rel = path.relative(realBase, realFile)
  if (
    rel === ''
    || rel.startsWith('..')
    || path.isAbsolute(rel)
    || rel.includes('/')
    || rel.includes('\\')
    || rel.toLowerCase() === 'readme.md'
  ) {
    return null
  }
  return realFile
}

async function readJsonFile(file: string): Promise<unknown> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return undefined
  }
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

function partialSelection(value: unknown): Partial<ModelSelection> | undefined {
  if (!isRecord(value)) return undefined
  const picked: { provider?: string; model?: string; effort?: string } = {}
  if (typeof value.provider === 'string') picked.provider = value.provider
  if (typeof value.model === 'string') picked.model = value.model
  // 存档里的强度可能已经不是已知值：原样带出，面板会把它显示成未选中，不会被悄悄换成别的。
  if (typeof value.effort === 'string') picked.effort = value.effort
  return Object.keys(picked).length === 0 ? undefined : (picked as Partial<ModelSelection>)
}

const SYNAPSE_MIME_TYPES: Readonly<Record<string, string>> = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
}

function resolveDefaultWebDistDir(): string {
  const candidates = [
    fileURLToPath(new URL('../../dist-web', import.meta.url)),
    fileURLToPath(new URL('../../../dist-web', import.meta.url)),
  ]
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'index.html'))) return dir
  }
  return candidates[0]!
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  if (res.headersSent) return
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  })
  res.end(html)
}

function sendScript(res: ServerResponse, status: number, script: string): void {
  if (res.headersSent) return
  res.writeHead(status, {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Content-Length': Buffer.byteLength(script),
    'Cache-Control': 'no-store',
  })
  res.end(script)
}

function sendRaw(res: ServerResponse, status: number, contentType: string, text: string): void {
  if (res.headersSent) return
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

function hasUnsafeProxyPath(rawUrl: string | undefined, url: URL): boolean {
  if (url.origin !== 'http://127.0.0.1') return true
  const rawPath = (rawUrl ?? '/').split(/[?#]/, 1)[0] ?? '/'
  if (rawPath.includes('//') || rawPath.includes('\\') || url.pathname.includes('//')) return true
  for (const candidate of [rawPath, url.pathname]) {
    for (const seg of candidate.split('/')) {
      if (seg === '..') return true
      try {
        const decoded = decodeURIComponent(seg)
        if (decoded === '..' || decoded.includes('/') || decoded.includes('\\')) return true
      } catch {
        return true
      }
    }
  }
  return false
}

/**
 * The loopback console (FR-C01, FR-C05). It binds 127.0.0.1 only, keeps the token comparison constant time,
 * and writes secrets and role cards into `brainHome` alone — the main DSH's home is never read or touched.
 */
export function createConsoleServer(options: ConsoleServerOptions): ConsoleServer {
  const brainHome = options.brainHome
  const webDistDir = options.webDistDir !== undefined ? path.resolve(options.webDistDir) : resolveDefaultWebDistDir()
  const factoryRolesDir = options.factoryRolesDir !== undefined && options.factoryRolesDir.trim() !== ''
    ? path.resolve(options.factoryRolesDir)
    : undefined
  const stateDir = path.join(brainHome, 'state')
  const settingsFile = path.join(stateDir, 'settings.json')
  const rolesDir = path.join(stateDir, 'roles')
  const hiddenRolesFile = path.join(rolesDir, 'hidden.json')
  const personaActiveFile = path.join(stateDir, 'persona', 'active.json')
  const secrets: SecretStore = createSecretStore({ file: path.join(stateDir, 'secrets.json') })
  const nextRequestId = createUlid()

  async function readSettingsDocument(): Promise<Record<string, unknown>> {
    const parsed = await readJsonFile(settingsFile)
    return isRecord(parsed) ? parsed : {}
  }

  async function readAgents(): Promise<Record<string, unknown>> {
    const agents = (await readSettingsDocument()).agents
    return isRecord(agents) ? agents : {}
  }

  async function readHiddenRoleNames(): Promise<ReadonlySet<string>> {
    const parsed = await readJsonFile(hiddenRolesFile)
    if (!isRecord(parsed) || !Array.isArray(parsed.names)) return new Set()
    if (parsed.version !== undefined && parsed.version !== 1) return new Set()
    const hidden = new Set<string>()
    for (const item of parsed.names) {
      if (typeof item === 'string') {
        const trimmed = item.trim()
        if (trimmed !== '') hidden.add(trimmed)
      }
    }
    return hidden
  }

  async function unhideRoleName(name: string): Promise<void> {
    const hidden = await readHiddenRoleNames()
    if (!hidden.has(name)) return
    const remaining = [...hidden]
      .filter((item) => item !== name)
      .sort((a, b) => a.localeCompare(b, 'zh-CN'))
    if (remaining.length === 0) {
      await rm(hiddenRolesFile, { force: true })
      return
    }
    await ensurePrivateDir(rolesDir)
    await writeFileAtomic(hiddenRolesFile, JSON.stringify({ version: 1, names: remaining }))
  }

  async function listRoleNamesInDir(dir: string): Promise<string[]> {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const names: string[] = []
    for (const entry of entries) {
      if (entry.isDirectory()) continue
      if (!entry.isFile() && !entry.isSymbolicLink()) continue
      if (!entry.name.endsWith('.md') || entry.name.toLowerCase() === 'readme.md') continue
      const candidate = entry.name.slice(0, -'.md'.length)
      let validName: string
      try {
        validName = assertRoleName(candidate)
      } catch {
        continue
      }
      const checked = await resolveAndCheckRealRoleFile(dir, validName)
      if (checked !== null) {
        names.push(validName)
      }
    }
    return names
  }

  async function readRoleCardByName(name: string): Promise<RoleCardPreview | null> {
    const userRealFile = await resolveAndCheckRealRoleFile(rolesDir, name)
    if (userRealFile !== null) {
      try {
        const text = await readFile(userRealFile, 'utf8')
        const hasFactory = factoryRolesDir !== undefined
          && (await resolveAndCheckRealRoleFile(factoryRolesDir, name)) !== null
        return { name, text, origin: hasFactory ? 'modified' : 'user' }
      } catch {
        // Fall through if the file vanished between check and read.
      }
    }
    if (factoryRolesDir === undefined) return null
    const hidden = await readHiddenRoleNames()
    if (hidden.has(name)) return null
    const factoryRealFile = await resolveAndCheckRealRoleFile(factoryRolesDir, name)
    if (factoryRealFile === null) return null
    try {
      const text = await readFile(factoryRealFile, 'utf8')
      return { name, text, origin: 'factory' }
    } catch {
      return null
    }
  }

  async function availableRoleCards(): Promise<readonly string[]> {
    const userNames = await listRoleNamesInDir(rolesDir)
    const merged = new Set<string>(userNames)
    if (factoryRolesDir !== undefined) {
      const [factoryNames, hidden] = await Promise.all([
        listRoleNamesInDir(factoryRolesDir),
        readHiddenRoleNames(),
      ])
      for (const name of factoryNames) {
        if (!hidden.has(name)) {
          merged.add(name)
        }
      }
    }
    return [...merged].sort((a, b) => a.localeCompare(b, 'zh-CN'))
  }

  async function activeRoleCard(): Promise<{ name: string; text: string } | null> {
    const active = await readJsonFile(personaActiveFile)
    if (!isRecord(active) || typeof active.name !== 'string' || active.name === '') return null
    let name: string
    try {
      // active.json 在磁盘上可能被手写或被改坏：名字先过和写入时同一道校验，才不会越出 rolesDir。
      name = assertRoleName(active.name)
    } catch {
      return null
    }
    const found = await readRoleCardByName(name)
    if (found === null) return null
    return { name: found.name, text: found.text }
  }

  async function getRoleCardPreview(rawName: string | null): Promise<RoleCardPreview> {
    const name = assertRoleName(rawName ?? '')
    const found = await readRoleCardByName(name)
    if (found === null) {
      throw new BrainError('NOT_FOUND', `role card not found: ${name}`, { field: 'name' })
    }
    return found
  }

  async function settingsView(): Promise<ConsoleSettingsView> {
    const agents = await readAgents()
    const secretNames = await secrets.names()
    return {
      agents: { chat: partialSelection(agents.chat), activity: partialSelection(agents.activity) },
      secretNames,
      sharedQuotaWarning: !secretNames.includes(SHARED_QUOTA_SECRET),
      roleCard: await activeRoleCard(),
      availableRoleCards: await availableRoleCards(),
    }
  }

  async function saveModelSelection(body: unknown): Promise<unknown> {
    if (!isRecord(body)) throw new BrainError('INVALID_ARGUMENT', 'body must be an object', { field: '' })
    const agentClass = body.agentClass
    if (agentClass !== 'chat' && agentClass !== 'activity') {
      throw new BrainError('INVALID_ARGUMENT', 'agentClass must be chat or activity', { field: 'agentClass' })
    }
    let selection: ModelSelection
    try {
      selection = requireSelection({ provider: body.provider, model: body.model, effort: body.effort }, agentClass)
    } catch (error) {
      // SelectionMissingError and RangeError are both the caller's fault at this boundary.
      throw new BrainError('INVALID_ARGUMENT', error instanceof Error ? error.message : 'invalid selection', {
        field: error instanceof SelectionMissingError ? 'selection' : 'effort',
      })
    }
    const document = await readSettingsDocument()
    const agents = isRecord(document.agents) ? document.agents : {}
    await ensurePrivateDir(stateDir)
    // writeFileAtomic leaves the file at 600; everything else in settings.json (timezone, quiet hours) is kept.
    await writeFileAtomic(settingsFile, JSON.stringify({ ...document, agents: { ...agents, [agentClass]: selection } }))
    await options.onInvalidateRunner?.(agentClass)
    return { ...agents, [agentClass]: selection }
  }

  async function saveSecret(body: unknown): Promise<unknown> {
    if (!isRecord(body)) throw new BrainError('INVALID_ARGUMENT', 'body must be an object', { field: '' })
    if (typeof body.name !== 'string') throw new BrainError('INVALID_ARGUMENT', 'invalid secret name', { field: 'name' })
    if (typeof body.value !== 'string') throw new BrainError('INVALID_ARGUMENT', 'invalid secret value', { field: 'value' })
    const name = body.name
    await ensurePrivateDir(stateDir)
    await secrets.set(name, body.value)
    for (const agentClass of AGENT_CLASSES) await options.onInvalidateRunner?.(agentClass)
    return { saved: name, secretNames: await secrets.names() }
  }

  async function saveRoleCard(body: unknown): Promise<unknown> {
    if (!isRecord(body)) throw new BrainError('INVALID_ARGUMENT', 'body must be an object', { field: '' })
    if (body.mode === 'select') {
      const name = assertRoleName(typeof body.name === 'string' ? body.name : '')
      const found = await readRoleCardByName(name)
      if (found === null) {
        throw new BrainError('NOT_FOUND', `role card not found: ${name}`, { field: 'name' })
      }
      if (options.persistRoleCard !== undefined) {
        await options.persistRoleCard({ name, text: found.text, mode: 'select' })
      } else {
        await ensurePrivateDir(path.dirname(personaActiveFile))
        await writeFileAtomic(personaActiveFile, JSON.stringify({ version: 1, name }))
      }
      for (const agentClass of AGENT_CLASSES) await options.onInvalidateRunner?.(agentClass)
      return { name }
    }
    let card: { readonly name: string; readonly text: string }
    let mode: 'interview' | 'raw'
    if (body.mode === 'interview') {
      if (!isRecord(body.interview)) throw new BrainError('INVALID_ARGUMENT', 'interview must be an object', { field: 'interview' })
      card = buildRoleCardFromInterview(body.interview as unknown as RoleCardInterviewInput)
      mode = 'interview'
    } else if (body.mode === 'raw') {
      const name = assertRoleName(typeof body.name === 'string' ? body.name : '')
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (text === '') throw new BrainError('INVALID_ARGUMENT', 'role card text is empty', { field: 'text' })
      card = { name, text: `${text}\n` }
      mode = 'raw'
    } else {
      throw new BrainError('INVALID_ARGUMENT', 'mode must be interview, raw or select', { field: 'mode' })
    }
    const name = assertRoleName(card.name)

    if (options.persistRoleCard !== undefined) {
      await options.persistRoleCard({ name, text: card.text, mode })
    } else {
      await ensurePrivateDir(rolesDir)
      await writeFileAtomic(resolveSafeRoleFile(rolesDir, name), card.text)
      await unhideRoleName(name)
      await ensurePrivateDir(path.dirname(personaActiveFile))
      await writeFileAtomic(personaActiveFile, JSON.stringify({ version: 1, name }))
    }
    for (const agentClass of AGENT_CLASSES) await options.onInvalidateRunner?.(agentClass)
    return { name }
  }

  async function readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []
    let total = 0
    let tooLarge = false
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      total += buffer.length
      if (total > LIMITS.requestBytes) {
        // Keep draining so the client reads the 413 instead of a reset.
        tooLarge = true
        chunks.length = 0
      } else if (!tooLarge) {
        chunks.push(buffer)
      }
    }
    if (tooLarge) throw new BrainError('PAYLOAD_TOO_LARGE', 'request body is too large')
    if (total === 0) return undefined
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    } catch {
      throw new BrainError('INVALID_ARGUMENT', 'request body is not valid JSON')
    }
  }

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    if (res.headersSent) return
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
    })
    res.end(text)
  }

  function okEnvelope<T>(requestId: string, data: T, extra: Partial<Meta> = {}): Envelope<T> {
    return { ok: true, data, meta: { requestId, apiVersion: '1.0', ...extra } }
  }

  function errorEnvelope(requestId: string, error: BrainError): Envelope<never> {
    return { ok: false, error: { code: error.code, message: error.message, details: error.details }, meta: { requestId } }
  }

  const appRouter = createConsoleAppRouter({
    ...(options.kernelApi === undefined ? {} : { kernelApi: options.kernelApi }),
    baseNavItems: DEFAULT_NAV_ITEMS,
    getSettingsView: settingsView,
    saveModelSelection,
    saveSecret,
    saveRoleCard,
  })

  async function proxyKernel(
    method: string,
    url: URL,
    req: IncomingMessage,
    body: unknown,
  ): Promise<{ readonly status: number; readonly contentType: string; readonly text: string }> {
    const kernel = options.kernelApi
    if (kernel === undefined || !url.pathname.startsWith('/api/v1/') || hasUnsafeProxyPath(req.url, url)) {
      throw new BrainError('NOT_FOUND', 'not found')
    }
    const targetUrl = `${kernel.baseUrl.replace(/\/+$/, '')}${url.pathname}${url.search}`
    const headers: Record<string, string> = {
      Authorization: `Bearer ${kernel.token}`,
    }
    const ifMatch = req.headers['if-match']
    if (typeof ifMatch === 'string' && ifMatch !== '') {
      headers['If-Match'] = ifMatch
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }
    const fetchImpl = kernel.fetchImpl ?? globalThis.fetch
    let upstream: Response
    try {
      upstream = await fetchImpl(targetUrl, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch {
      throw new BrainError('UNAVAILABLE', 'kernel api unavailable')
    }
    const text = await upstream.text()
    const contentType = upstream.headers.get('content-type') ?? 'application/json; charset=utf-8'
    return { status: upstream.status, contentType, text }
  }

  async function routeConsole(
    requestId: string,
    method: string,
    url: URL,
    req: IncomingMessage,
    body: unknown,
  ): Promise<{ status: number; payload?: unknown; raw?: { contentType: string; text: string } }> {
    const pathname = url.pathname
    const respond = (data: unknown): { status: number; payload: unknown } => ({ status: 200, payload: okEnvelope(requestId, data) })

    if (method === 'GET' && pathname === `${CONSOLE_PREFIX}/session`) return respond({ authenticated: true })
    if (method === 'GET' && pathname === `${CONSOLE_PREFIX}/settings`) return respond(await settingsView())
    if (method === 'GET' && pathname === `${CONSOLE_PREFIX}/settings/role-card`) {
      return respond(await getRoleCardPreview(url.searchParams.get('name')))
    }
    if (method === 'PUT' && pathname === `${CONSOLE_PREFIX}/settings/model`) return respond(await saveModelSelection(body))
    if (method === 'PUT' && pathname === `${CONSOLE_PREFIX}/settings/secret`) return respond(await saveSecret(body))
    if (method === 'PUT' && pathname === `${CONSOLE_PREFIX}/settings/role-card`) return respond(await saveRoleCard(body))
    if (method === 'GET' && pathname === `${CONSOLE_PREFIX}/ui/state`) {
      return respond(await appRouter.getState(url.searchParams.get('page') ?? undefined))
    }
    if (method === 'POST' && pathname === `${CONSOLE_PREFIX}/ui/action`) {
      return respond(await appRouter.handleAction(body))
    }

    if (options.extraRoutes !== undefined) {
      const handled = await options.extraRoutes(method, pathname, body)
      if (handled !== undefined) return respond(handled)
    }

    if (options.kernelApi !== undefined && pathname.startsWith('/api/v1/')) {
      if (hasUnsafeProxyPath(req.url, url)) {
        throw new BrainError('NOT_FOUND', 'not found')
      }
      const proxied = await proxyKernel(method, url, req, body)
      return { status: proxied.status, raw: { contentType: proxied.contentType, text: proxied.text } }
    }

    throw new BrainError('NOT_FOUND', 'not found')
  }

  async function shellPage(url: URL): Promise<string> {
    const requested = url.searchParams.get('theme')
    const theme = THEME_MODES.includes(requested as ConsoleThemeMode) ? (requested as ConsoleThemeMode) : 'dark'
    try {
      const rawHtml = await readFile(path.join(webDistDir, 'index.html'), 'utf8')
      return rawHtml.replace(/<html lang="zh-CN" data-theme="[^"]*">/, `<html lang="zh-CN" data-theme="${theme}">`)
    } catch {
      return renderShellHtml({
        theme,
        activePageId: 'settings',
        authenticated: false,
        // 未登录的壳只说明有这件事，不带任何真实状态。
        roleCardName: null,
        sharedQuotaWarning: false,
        navItems: DEFAULT_NAV_ITEMS,
        mainHtml: '',
      })
    }
  }

  async function serveSynapseAsset(req: IncomingMessage, url: URL, res: ServerResponse, method: string): Promise<void> {
    const rawPath = (req.url ?? '/').split(/[?#]/, 1)[0] ?? '/'
    if (
      hasUnsafeProxyPath(req.url, url)
      || !rawPath.startsWith('/synapse/')
      || !url.pathname.startsWith('/synapse/')
      || url.pathname.endsWith('/')
      || rawPath.includes('\0')
      || url.pathname.includes('\0')
      || rawPath.includes('..')
      || url.pathname.includes('..')
      || rawPath.includes('\\')
      || url.pathname.includes('\\')
      || rawPath.includes('//')
      || url.pathname.includes('//')
      || /%(?:2e|2f|5c|00)/i.test(rawPath)
    ) {
      throw new BrainError('NOT_FOUND', 'not found')
    }

    const rawRel = url.pathname.slice('/synapse/'.length)
    if (rawRel === '') {
      throw new BrainError('NOT_FOUND', 'not found')
    }
    const segments: string[] = []
    for (const seg of rawRel.split('/')) {
      if (seg === '' || seg === '.' || seg === '..') {
        throw new BrainError('NOT_FOUND', 'not found')
      }
      let decoded: string
      try {
        decoded = decodeURIComponent(seg)
      } catch {
        throw new BrainError('NOT_FOUND', 'not found')
      }
      if (
        decoded === ''
        || decoded === '.'
        || decoded === '..'
        || decoded.includes('/')
        || decoded.includes('\\')
        || decoded.includes('\0')
      ) {
        throw new BrainError('NOT_FOUND', 'not found')
      }
      segments.push(decoded)
    }

    const rel = segments.join(path.sep)
    const candidate = path.resolve(webDistDir, rel)
    const relCheck = path.relative(webDistDir, candidate)
    if (relCheck === '' || relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
      throw new BrainError('NOT_FOUND', 'not found')
    }

    let realRoot: string
    let realFile: string
    let fileStat: Awaited<ReturnType<typeof stat>>
    try {
      ;[realRoot, realFile, fileStat] = await Promise.all([
        realpath(webDistDir),
        realpath(candidate),
        stat(candidate),
      ])
    } catch {
      throw new BrainError('NOT_FOUND', 'not found')
    }

    const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`
    const realRelCheck = path.relative(realRoot, realFile)
    if (
      !realFile.startsWith(rootWithSep)
      || !fileStat.isFile()
      || realRelCheck === ''
      || realRelCheck.startsWith('..')
      || path.isAbsolute(realRelCheck)
    ) {
      throw new BrainError('NOT_FOUND', 'not found')
    }

    const content = await readFile(realFile)
    const ext = path.extname(realFile).toLowerCase()
    const contentType = SYNAPSE_MIME_TYPES[ext] ?? 'application/octet-stream'
    const cacheControl = url.pathname.startsWith('/synapse/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-store'

    if (res.headersSent) return
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': content.byteLength,
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
    })
    if (method === 'HEAD') {
      res.end()
    } else {
      res.end(content)
    }
  }

  const server = createServer((req, res) => {
    const requestId = nextRequestId()
    void (async () => {
      try {
        const method = req.method ?? 'GET'
        const rawPath = (req.url ?? '/').split(/[?#]/, 1)[0] ?? '/'
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const authenticated = authorized(req.headers.authorization, options.token)

        // GET / is the public login shell; /synapse/* and /assets/console-client.js carry static UI assets only.
        if (method === 'GET' && url.pathname === '/') {
          req.resume()
          sendHtml(res, 200, await shellPage(url))
          return
        }
        if (
          (method === 'GET' || method === 'HEAD')
          && (url.pathname === '/synapse'
            || url.pathname.startsWith('/synapse/')
            || rawPath === '/synapse'
            || rawPath.startsWith('/synapse/'))
        ) {
          req.resume()
          await serveSynapseAsset(req, url, res, method)
          return
        }
        if (method === 'GET' && url.pathname === '/assets/console-client.js') {
          req.resume()
          sendScript(res, 200, renderConsoleClientScript())
          return
        }
        if (method === 'GET' && url.pathname === '/favicon.ico') {
          req.resume()
          res.writeHead(204).end()
          return
        }
        if ((method === 'GET' || method === 'HEAD') && !url.pathname.startsWith('/api/')) {
          req.resume()
          throw new BrainError('NOT_FOUND', 'not found')
        }

        const hasBodyMethod = method === 'PUT' || method === 'POST' || method === 'PATCH' || method === 'DELETE'
        const body = hasBodyMethod ? await readBody(req) : undefined
        if (!hasBodyMethod) req.resume()
        if (!authenticated) throw new BrainError('UNAUTHENTICATED', 'missing or invalid token')

        const result = await routeConsole(requestId, method, url, req, body)
        if (result.raw !== undefined) {
          sendRaw(res, result.status, result.raw.contentType, result.raw.text)
        } else {
          sendJson(res, result.status, result.payload)
        }
      } catch (error) {
        if (error instanceof BrainError) {
          sendJson(res, ERROR_CODES[error.code], errorEnvelope(requestId, error))
        } else {
          sendJson(res, 500, {
            ok: false,
            error: { code: 'INTERNAL', message: 'internal error', details: {} },
            meta: { requestId },
          })
        }
      }
    })()
  })

  return {
    listen(): Promise<{ readonly port: number }> {
      return new Promise((resolve, reject) => {
        const onError = (error: Error): void => { reject(error) }
        server.once('error', onError)
        // Loopback only; there is deliberately no option to widen this.
        server.listen({ host: '127.0.0.1', port: options.port ?? 0 }, () => {
          server.off('error', onError)
          const address = server.address()
          resolve({ port: address !== null && typeof address === 'object' ? address.port : (options.port ?? 0) })
        })
      })
    },

    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined || error === null) resolve(); else reject(error) })
        server.closeAllConnections()
      })
    },
  }
}
