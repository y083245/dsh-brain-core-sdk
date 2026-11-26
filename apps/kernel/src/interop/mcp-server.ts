import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { BrainError, LIMITS, type SearchScope, type Viewer } from '@brain-core/sdk'
import type { MemoryService, ProfileReader, ReadOnlyMcpStatus, RecordStore } from '../contracts/index.ts'
import type { Logger } from '../log/index.ts'

const PROTOCOL_VERSION = '2025-03-26'
const SERVER_INFO = { name: 'brain-memory', version: '1.0.0' } as const
const OWNER_VIEWER: Viewer = { caller: 'owner-console', channel: null, participants: [] }
const SEARCH_SCOPES: readonly SearchScope[] = ['here', 'person', 'all']

export interface ReadOnlyMcpServerDeps {
  readonly memory: MemoryService
  readonly profiles: ProfileReader
  readonly store?: RecordStore
  readonly token: string
  readonly port?: number
  readonly ampAliases?: boolean
  readonly log?: Logger
}

export interface ReadOnlyMcpServer {
  listen(): Promise<{ readonly port: number; readonly url: string }>
  close(): Promise<void>
  status(): ReadOnlyMcpStatus
}

interface McpToolDef {
  readonly name: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
}

function sha256(text: string): Buffer {
  return createHash('sha256').update(text).digest()
}

function authorized(header: string | undefined, token: string): boolean {
  if (typeof header !== 'string') return false
  const prefix = 'Bearer '
  if (!header.startsWith(prefix)) return false
  return timingSafeEqual(sha256(header.slice(prefix.length)), sha256(token))
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}

function jsonRpcOk(id: unknown, result: unknown): Readonly<Record<string, unknown>> {
  return { jsonrpc: '2.0', id: id ?? null, result }
}

function jsonRpcError(id: unknown, code: number, message: string): Readonly<Record<string, unknown>> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sendEmpty(res: ServerResponse, status: number): void {
  if (res.headersSent) return
  res.writeHead(status, { 'Content-Length': 0 })
  res.end()
}

/**
 * Generates a DSH `--patch` YAML snippet matching `@deepseek-ai/dsh-mcp-client`
 * v0.2.2-rc.1 `StreamableHttpConfig`. Pure string builder: never touches `~/.dsh` or disk.
 */
export function generateDshMcpPatchYaml(url: string, token: string): string {
  const safeUrl = JSON.stringify(url)
  const safeAuth = JSON.stringify(`Bearer ${token}`)
  return [
    '- insert:',
    '  - id: brain-memory-readonly',
    "    name: '@deepseek-ai/dsh-mcp-client'",
    '    config:',
    '      serverName: brain_memory',
    '      transport: streamable-http',
    `      url: ${safeUrl}`,
    '      headers:',
    `        Authorization: ${safeAuth}`,
  ].join('\n')
}

function readOnlyTools(ampAliases: boolean): readonly McpToolDef[] {
  const searchSchema: Readonly<Record<string, unknown>> = {
    type: 'object',
    properties: {
      query: { type: 'string', description: '检索关键词或问题' },
      scope: { type: 'string', enum: ['here', 'person', 'all'], default: 'all' },
      limit: { type: 'integer', minimum: 1, maximum: LIMITS.searchLimit },
      neighbors: { type: 'integer', minimum: 0, maximum: 10 },
      history: { type: 'boolean' },
    },
    required: ['query'],
  }

  const emptySchema: Readonly<Record<string, unknown>> = {
    type: 'object',
    properties: {},
  }

  const tools: McpToolDef[] = [
    {
      name: 'memory_search',
      description: '只读检索主人可见记忆（包含 owner/internal 记录，绝不修改任何数据）。',
      inputSchema: searchSchema,
    },
    {
      name: 'memory_profile',
      description: '只读获取当前 L3 自我画像版本与稳定前缀文本。',
      inputSchema: emptySchema,
    },
    {
      name: 'memory_stats',
      description: '只读获取记忆健康状态与各层活跃记录计数（不含聊天原文）。',
      inputSchema: emptySchema,
    },
  ]

  if (ampAliases) {
    tools.push(
      {
        name: 'amp_recall',
        description: '只读 AMP recall 检索别名（主人视角，绝不修改任何数据）。',
        inputSchema: searchSchema,
      },
      {
        name: 'amp_stats',
        description: '只读 AMP stats 统计别名（不含聊天原文）。',
        inputSchema: emptySchema,
      },
    )
  }

  return tools
}

export function createReadOnlyMcpServer(deps: ReadOnlyMcpServerDeps): ReadOnlyMcpServer {
  if (deps.token === '') {
    throw new BrainError('INVALID_ARGUMENT', 'read-only MCP server token must not be empty')
  }

  const ampAliases = deps.ampAliases === true
  const tools = readOnlyTools(ampAliases)
  const toolNames = new Set(tools.map((t) => t.name))

  let boundPort: number | undefined
  let boundUrl: string | undefined
  let listening = false
  let inflightListen: Promise<{ readonly port: number; readonly url: string }> | undefined

  async function readBody(req: IncomingMessage): Promise<{ readonly kind: 'ok'; readonly data: unknown } | { readonly kind: 'too_large' } | { readonly kind: 'invalid_json' }> {
    const chunks: Buffer[] = []
    let total = 0
    let tooLarge = false
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      total += buf.length
      if (total > LIMITS.requestBytes) {
        tooLarge = true
        chunks.length = 0
      } else if (!tooLarge) {
        chunks.push(buf)
      }
    }
    if (tooLarge) return { kind: 'too_large' }
    if (total === 0) return { kind: 'invalid_json' }
    try {
      return { kind: 'ok', data: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
    } catch {
      return { kind: 'invalid_json' }
    }
  }

  async function runReadOnlySearch(args: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (typeof args.query !== 'string' || args.query.trim() === '') {
      throw new BrainError('INVALID_ARGUMENT', 'query must be a non-empty string')
    }
    const scope = args.scope === undefined ? 'all' : args.scope
    if (!SEARCH_SCOPES.includes(scope as SearchScope)) {
      throw new BrainError('INVALID_ARGUMENT', 'scope must be here, person, or all')
    }
    if (
      args.limit !== undefined
      && (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > LIMITS.searchLimit)
    ) {
      throw new BrainError('INVALID_ARGUMENT', `limit must be an integer between 1 and ${String(LIMITS.searchLimit)}`)
    }
    if (args.neighbors !== undefined && (!Number.isInteger(args.neighbors) || (args.neighbors as number) < 0 || (args.neighbors as number) > 10)) {
      throw new BrainError('INVALID_ARGUMENT', 'neighbors must be an integer between 0 and 10')
    }
    if (args.history !== undefined && typeof args.history !== 'boolean') {
      throw new BrainError('INVALID_ARGUMENT', 'history must be a boolean')
    }
    const result = await deps.memory.search({
      query: args.query,
      scope: scope as SearchScope,
      ...(args.limit === undefined ? {} : { limit: args.limit as number }),
      ...(args.neighbors === undefined ? {} : { neighbors: args.neighbors as number }),
      ...(args.history === undefined ? {} : { history: args.history }),
    }, OWNER_VIEWER)

    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    }
  }

  async function runProfile(): Promise<unknown> {
    const profile = await deps.profiles.current()
    return {
      content: [{ type: 'text', text: JSON.stringify(profile) }],
    }
  }

  async function runStats(): Promise<unknown> {
    const health = await deps.memory.health()
    let counts: Record<'L0' | 'L1' | 'L2' | 'L3', number> | undefined
    if (deps.store !== undefined) {
      counts = { L0: 0, L1: 0, L2: 0, L3: 0 }
      for await (const rec of deps.store.scan()) {
        if (rec.status === 'active') counts[rec.layer] += 1
      }
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ health, ...(counts === undefined ? {} : { counts }) }),
      }],
    }
  }

  async function dispatchRpc(msg: Readonly<Record<string, unknown>>): Promise<{ readonly status: number; readonly body?: unknown }> {
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return { status: 400, body: jsonRpcError(msg.id, -32600, 'Invalid Request') }
    }
    const hasId = Object.hasOwn(msg, 'id')
    const id = msg.id
    const method = msg.method

    if (method === 'notifications/initialized' || (!hasId && method.startsWith('notifications/'))) {
      return { status: 202 }
    }

    if (method === 'initialize') {
      return {
        status: 200,
        body: jsonRpcOk(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        }),
      }
    }

    if (method === 'ping') {
      return { status: 200, body: jsonRpcOk(id, {}) }
    }

    if (method === 'tools/list') {
      return { status: 200, body: jsonRpcOk(id, { tools }) }
    }

    if (method === 'tools/call') {
      if (!isPlainObject(msg.params) || typeof msg.params.name !== 'string') {
        return { status: 200, body: jsonRpcError(id, -32602, 'Invalid params: tool name is required') }
      }
      const toolName = msg.params.name
      if (!toolNames.has(toolName)) {
        return { status: 200, body: jsonRpcError(id, -32601, `Tool not found: ${toolName}`) }
      }
      const args = isPlainObject(msg.params.arguments) ? msg.params.arguments : {}
      try {
        if (toolName === 'memory_search' || toolName === 'amp_recall') {
          return { status: 200, body: jsonRpcOk(id, await runReadOnlySearch(args)) }
        }
        if (toolName === 'memory_profile') {
          return { status: 200, body: jsonRpcOk(id, await runProfile()) }
        }
        return { status: 200, body: jsonRpcOk(id, await runStats()) }
      } catch (error) {
        const message = error instanceof Error && error.message !== '' ? error.message : 'tool execution failed'
        return {
          status: 200,
          body: jsonRpcOk(id, {
            content: [{ type: 'text', text: message }],
            isError: true,
          }),
        }
      }
    }

    return { status: 200, body: jsonRpcError(id, -32601, `Method not found: ${method}`) }
  }

  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (!authorized(req.headers.authorization, deps.token)) {
          req.resume()
          sendJson(res, 401, { error: 'UNAUTHENTICATED', message: 'missing or invalid bearer token' })
          return
        }

        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (url.pathname !== '/mcp') {
          req.resume()
          sendJson(res, 404, { error: 'NOT_FOUND', message: 'not found' })
          return
        }

        if ((req.method ?? 'GET') !== 'POST') {
          req.resume()
          sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED', message: 'only POST /mcp is supported' })
          return
        }

        const parsed = await readBody(req)
        if (parsed.kind === 'too_large') {
          sendJson(res, 413, { error: 'PAYLOAD_TOO_LARGE', message: 'request body exceeds limit' })
          return
        }
        if (parsed.kind === 'invalid_json') {
          sendJson(res, 400, jsonRpcError(null, -32700, 'Parse error'))
          return
        }
        if (!isPlainObject(parsed.data)) {
          sendJson(res, 400, jsonRpcError(null, -32600, 'Invalid Request'))
          return
        }

        const outcome = await dispatchRpc(parsed.data)
        if (outcome.status === 202) {
          sendEmpty(res, 202)
          return
        }
        sendJson(res, outcome.status, outcome.body)
      } catch {
        deps.log?.error('interop.mcp_internal')
        sendJson(res, 500, jsonRpcError(null, -32603, 'Internal error'))
      }
    })()
  })

  return {
    listen(): Promise<{ readonly port: number; readonly url: string }> {
      if (listening && boundPort !== undefined && boundUrl !== undefined) {
        return Promise.resolve({ port: boundPort, url: boundUrl })
      }
      if (inflightListen !== undefined) {
        return inflightListen
      }
      inflightListen = new Promise<{ readonly port: number; readonly url: string }>((resolve, reject) => {
        const onError = (error: Error): void => { reject(error) }
        server.once('error', onError)
        // Loopback only: read-only MCP must never bind non-loopback interfaces.
        server.listen({ host: '127.0.0.1', port: deps.port ?? 0 }, () => {
          server.off('error', onError)
          const addr = server.address()
          if (addr === null || typeof addr === 'string' || addr.address !== '127.0.0.1') {
            server.closeAllConnections()
            server.close(() => {
              reject(new BrainError('UNAVAILABLE', 'read-only MCP server must bind to 127.0.0.1'))
            })
            return
          }
          boundPort = addr.port
          boundUrl = `http://127.0.0.1:${String(boundPort)}/mcp`
          listening = true
          resolve({ port: boundPort, url: boundUrl })
        })
      }).finally(() => {
        inflightListen = undefined
      })
      return inflightListen
    },

    async close(): Promise<void> {
      if (inflightListen !== undefined) {
        try {
          await inflightListen
        } catch {
          // Ignore startup failures during shutdown.
        }
      }
      if (!listening && !server.listening) {
        boundPort = undefined
        boundUrl = undefined
        listening = false
        return
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined || error === null) resolve()
          else reject(error)
        })
        server.closeAllConnections()
      })
      listening = false
      boundPort = undefined
      boundUrl = undefined
    },

    status(): ReadOnlyMcpStatus {
      return {
        enabled: true,
        running: listening,
        ...(boundUrl === undefined ? {} : { url: boundUrl }),
        ...(boundPort === undefined ? {} : { port: boundPort }),
        ...(boundUrl === undefined ? {} : { patchYaml: generateDshMcpPatchYaml(boundUrl, deps.token) }),
      }
    },
  }
}
