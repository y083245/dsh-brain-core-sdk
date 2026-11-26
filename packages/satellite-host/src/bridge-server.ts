/** Kernel side of the tool bridge: a loopback HTTP server the bundle inside DSH calls back into. */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface BridgeTool {
  readonly name: string
  readonly description: string
  /** DSH's parameter DSL, passed through to defineTool. */
  readonly parameters: Readonly<Record<string, unknown>>
}

export interface ToolCall {
  readonly sessionId: string
  readonly toolName: string
  readonly args: unknown
}

export type ToolHandler = (call: ToolCall) => Promise<string | BridgeToolResult>

export interface BridgeImage { readonly mediaType: string; readonly base64: string }
export interface BridgeToolResult { readonly text: string; readonly images?: readonly BridgeImage[] }

export interface SurfaceCheck {
  readonly ok: boolean
  readonly unexpected: readonly string[]
  readonly missing: readonly string[]
}

const MAX_BODY_BYTES = 1024 * 1024
/** Identical for every refusal, so a caller cannot probe which sessions or tools exist. */
const REFUSED = 'session unavailable'

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
  }
  return value
}

export class BridgeServer {
  /** Regenerated for every server, and only ever handed over through the child's environment. */
  readonly token = randomBytes(32).toString('hex')
  readonly surfacePulls = new Map<string, number>()
  readonly #catalog: readonly BridgeTool[]
  readonly #handler: ToolHandler
  readonly #surfaces = new Map<string, Set<string>>()
  readonly #surfaceOf: ((sessionId: string) => ReadonlySet<string>) | undefined
  readonly #server: Server
  #childPid: number | undefined
  #surfaceCheck: SurfaceCheck | undefined

  constructor(options: {
    catalog: readonly BridgeTool[]
    handler: ToolHandler
    surfaceOf?: (sessionId: string) => ReadonlySet<string>
  }) {
    // Sorted with sorted keys: the model's tool list must stay byte-stable or the prompt cache misses.
    this.#catalog = [...options.catalog].sort((a, b) => a.name.localeCompare(b.name)).map(tool => canonical(tool) as BridgeTool)
    this.#handler = options.handler
    this.#surfaceOf = options.surfaceOf
    this.#server = createServer((req, res) => {
      this.#route(req, res).catch(() => this.#send(res, 500, { ok: false, error: 'internal' }))
    })
  }

  get url(): string {
    const { port } = this.#server.address() as AddressInfo
    return `http://127.0.0.1:${port}`
  }

  /** Reported by the bundle at startup; the client does not expose its child's pid. */
  get childPid(): number | undefined {
    return this.#childPid
  }

  get surfaceCheck(): SurfaceCheck | undefined {
    return this.#surfaceCheck
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#server.once('error', reject)
      this.#server.listen(0, '127.0.0.1', () => resolve())
    })
  }

  close(): Promise<void> {
    return new Promise(resolve => {
      this.#server.closeAllConnections()
      this.#server.close(() => resolve())
    })
  }

  setSurface(sessionId: string, tools: readonly string[]): void {
    this.#surfaces.set(sessionId, new Set(tools))
  }

  addToSurface(sessionId: string, tools: readonly string[]): void {
    const surface = this.#surfaces.get(sessionId) ?? new Set<string>()
    for (const tool of tools) surface.add(tool)
    this.#surfaces.set(sessionId, surface)
  }

  #toolsFor(sessionId: string): ReadonlySet<string> | undefined {
    return this.#surfaceOf === undefined ? this.#surfaces.get(sessionId) : this.#surfaceOf(sessionId)
  }

  #send(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  #authorized(req: IncomingMessage): boolean {
    const given = Buffer.from(req.headers.authorization ?? '')
    const expected = Buffer.from(`Bearer ${this.token}`)
    return given.length === expected.length && timingSafeEqual(given, expected)
  }

  async #readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > MAX_BODY_BYTES) throw new RangeError('body too large')
      chunks.push(chunk as Buffer)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  }

  async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#authorized(req)) return this.#send(res, 401, { ok: false, error: 'unauthenticated' })
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/bridge/v1/catalog') return this.#send(res, 200, { tools: this.#catalog })
    if (req.method === 'POST' && url.pathname === '/bridge/v1/hello') {
      const { pid } = await this.#readJson(req)
      if (typeof pid === 'number') this.#childPid = pid
      return this.#send(res, 200, { ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/bridge/v1/ready') return this.#ready(req, res)
    const surface = /^\/bridge\/v1\/sessions\/([^/]+)\/surface$/.exec(url.pathname)
    if (req.method === 'GET' && surface !== null) {
      const sessionId = decodeURIComponent(surface[1] as string)
      this.surfacePulls.set(sessionId, (this.surfacePulls.get(sessionId) ?? 0) + 1)
      return this.#send(res, 200, { tools: [...(this.#toolsFor(sessionId) ?? [])] })
    }
    if (req.method === 'POST' && url.pathname === '/bridge/v1/calls') return this.#call(req, res)
    this.#send(res, 404, { ok: false, error: 'not found' })
  }

  /** The tools DSH really has must equal the catalog; anything else means hardening failed. */
  async #ready(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { tools } = await this.#readJson(req)
    const actual = new Set(Array.isArray(tools) ? tools.map(String) : [])
    const expected = new Set(this.#catalog.map(tool => tool.name))
    const unexpected = [...actual].filter(name => !expected.has(name)).sort()
    const missing = [...expected].filter(name => !actual.has(name)).sort()
    this.#surfaceCheck = { ok: unexpected.length === 0 && missing.length === 0, unexpected, missing }
    this.#send(res, this.#surfaceCheck.ok ? 200 : 409, this.#surfaceCheck)
  }

  async #call(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { sessionId, toolName, args } = await this.#readJson(req)
    const allowed = typeof sessionId === 'string' && typeof toolName === 'string' && this.#toolsFor(sessionId)?.has(toolName) === true
    if (!allowed) return this.#send(res, 200, { ok: false, error: REFUSED })
    try {
      const result = await this.#handler({ sessionId, toolName, args })
      if (typeof result === 'string') return this.#send(res, 200, { ok: true, content: result })
      this.#send(res, 200, { ok: true, content: result.text, images: result.images })
    } catch (error) {
      this.#send(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}
