import { Client, StreamableHTTPClientTransport, type CallToolResult, type Transport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import {
  BrainError, type BrainContext, type Disposable, type ToolDefinition, type ToolImage, type ToolOutput, type ToolParameters,
} from '@brain-core/sdk'
import type { InstalledPlugin } from '../contracts/index.ts'
import { guardUrl } from '../plugin-runtime/index.ts'
import { createStderrSink, ensurePluginDirs, pluginEnvironment, stderrFile } from './env.ts'
import { watchRevocation } from './liveness.ts'
import type { ExternalDeps } from './types.ts'

interface ContentBlock {
  readonly type: string
  readonly text?: string
  readonly mimeType?: string
  readonly data?: string
}

function invalid(message: string): BrainError {
  return new BrainError('INVALID_ARGUMENT', message)
}

async function resolveValue(value: string, ctx: BrainContext): Promise<string> {
  if (value.startsWith('config:')) {
    const key = value.slice('config:'.length)
    if (key === '') throw invalid('a config: reference needs a key')
    const found = (ctx.config as Readonly<Record<string, unknown>>)[key]
    if (typeof found !== 'string') throw invalid(`config ${key} is not a string`)
    return found
  }
  if (value.startsWith('secret:')) {
    const name = value.slice('secret:'.length)
    if (name === '') throw invalid('a secret: reference needs a name')
    const found = await ctx.secrets.get(name)
    if (found === undefined || found === '') throw new BrainError('UNAVAILABLE', `secret ${name} is not set`)
    return found
  }
  return value
}

async function resolveRecord(values: Readonly<Record<string, string>> | undefined, ctx: BrainContext): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(values ?? {})) out[key] = await resolveValue(value, ctx)
  return out
}

function toToolOutput(result: CallToolResult): ToolOutput {
  const blocks = Array.isArray(result.content) ? result.content as unknown as readonly ContentBlock[] : []
  const texts: string[] = []
  const images: ToolImage[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    else if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
      images.push({ mediaType: block.mimeType, base64: block.data })
    }
  }
  const text = texts.join('\n')
  if (result.isError === true) throw new Error(text)
  return images.length === 0 ? text : { text, images }
}

/** Connects the plugin's own MCP server and registers its tools through ctx. */
export async function attachMcp(ctx: BrainContext, plugin: InstalledPlugin, deps: ExternalDeps): Promise<void> {
  const mcp = plugin.manifest.mcp
  if (mcp === undefined) return
  await ensurePluginDirs(deps.pluginsDir, plugin.manifest.id)
  const client = new Client({ name: 'brain-core', version: plugin.version })
  const sink = createStderrSink(stderrFile(deps.pluginsDir, plugin.manifest.id))
  const registrations: Disposable[] = []
  try {
    let transport: Transport
    if ('command' in mcp) {
      const env = await resolveRecord(mcp.env, ctx)
      const stdio = new StdioClientTransport({
        command: mcp.command,
        args: [...(mcp.args ?? [])],
        env: pluginEnvironment(plugin, deps.pluginsDir, deps.parentEnv ?? process.env, env),
        cwd: plugin.dir,
        stderr: 'pipe',
      })
      stdio.stderr?.on('data', (chunk: Buffer) => { sink.write(chunk) })
      stdio.stderr?.on('error', () => undefined)
      transport = stdio
    } else {
      const resolved = await resolveValue(mcp.url, ctx)
      let url: URL
      try {
        url = new URL(resolved)
      } catch {
        throw invalid('mcp.url is not a URL')
      }
      await guardUrl(plugin, url)
      const headers = await resolveRecord(mcp.headers, ctx)
      transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } })
    }

    await client.connect(transport)
    const listed = await client.listTools()
    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]))
    for (const tool of plugin.manifest.tools ?? []) {
      const sourceName = tool.mcpName ?? tool.name
      const source = byName.get(sourceName)
      if (source === undefined) throw invalid(`the MCP server does not provide tool ${sourceName}`)
      const definition: ToolDefinition = {
        name: tool.name,
        description: typeof source.description === 'string' && source.description !== '' ? source.description : tool.summary,
        parameters: (source.inputSchema ?? { type: 'object' }) as ToolParameters,
        handler: async (args) => toToolOutput(await client.callTool({ name: sourceName, arguments: { ...args } })),
      }
      registrations.push(ctx.tools.register(definition))
    }

    watchRevocation(ctx, plugin.manifest.id, async () => {
      for (const dispose of registrations.splice(0).reverse()) {
        try { dispose() } catch { /* one broken tool must not keep the rest alive */ }
      }
      await client.close().catch(() => undefined)
      await sink.close()
    })
  } catch (error) {
    for (const dispose of registrations.splice(0).reverse()) {
      try { dispose() } catch { /* already gone */ }
    }
    await client.close().catch(() => undefined)
    await sink.close()
    if (error instanceof BrainError) throw error
    throw new BrainError('UNAVAILABLE', 'MCP server failed to start')
  }
}
