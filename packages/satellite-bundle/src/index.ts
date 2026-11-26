/** Runs inside the DSH child: exposes the kernel's tools as native tools, one surface per step. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { stepCache } from './step-cache.ts'

export const name = 'brain-bridge'
export const inject = ['tools']

interface CatalogTool {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, never>
}

interface AttachmentsService {
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<unknown>
}

export async function apply(ctx: Context): Promise<void> {
  const base = process.env.BRAIN_BRIDGE_URL
  const token = process.env.BRAIN_BRIDGE_TOKEN
  if (base === undefined || token === undefined) throw new Error('brain-bridge: bridge address or token missing from env')
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const post = (path: string, body: unknown, signal?: AbortSignal) =>
    fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body), ...(signal === undefined ? {} : { signal }) })

  await post('/bridge/v1/hello', { pid: process.pid })
  const catalogReply = await fetch(`${base}/bridge/v1/catalog`, { headers })
  if (!catalogReply.ok) throw new Error(`brain-bridge: catalog request failed with ${catalogReply.status}`)
  const { tools } = await catalogReply.json() as { tools: CatalogTool[] }

  // Runs on the first step, once every plugin has registered, so a late tool cannot slip past it.
  let verification: Promise<void> | undefined
  const verifySurface = () => {
    verification ??= (async () => {
      const actual = ctx.tools.schemas().map(schema => schema.name)
      const reply = await post('/bridge/v1/ready', { tools: actual })
      if (!reply.ok) throw new Error(`brain-bridge: tool surface differs from catalog: ${await reply.text()}`)
    })()
    return verification
  }

  const surfaceOf = new Map<string, (stepKey: object, signal: AbortSignal) => Promise<ReadonlySet<string>>>()
  const lookupFor = (sessionId: string) => {
    let lookup = surfaceOf.get(sessionId)
    if (lookup === undefined) {
      // The signal comes from the step that starts the load. Capturing it here would tie
      // every later step to the first turn's signal: once that turn was aborted, every
      // surface request for this session would fail at once.
      lookup = stepCache(async (_stepKey: object, signal: AbortSignal) => {
        const reply = await fetch(`${base}/bridge/v1/sessions/${encodeURIComponent(sessionId)}/surface`, { headers, signal })
        if (!reply.ok) throw new Error(`brain-bridge: surface request failed with ${reply.status}`)
        return new Set((await reply.json() as { tools: string[] }).tools)
      })
      surfaceOf.set(sessionId, lookup)
    }
    return lookup
  }

  for (const tool of tools) {
    ctx.tools.register(defineTool({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: { type: 'string', required: true }, images: { type: 'array', items: { type: 'json' } } },
        },
        render: (_args, value) => [
          { type: 'text', text: value.text },
          ...(value.images ?? []).map(attachment => ({ type: 'image', attachment }) as never),
        ],
      },
      async execute(args: unknown, exec) {
        const sessionId = exec.agent?.id
        const reply = await post('/bridge/v1/calls', { sessionId, toolName: tool.name, args }, exec.signal)
        const body = await reply.json() as {
          ok: boolean
          content?: string
          images?: readonly { mediaType: string; base64: string }[]
          error?: string
        }
        if (!body.ok) throw new Error(body.error ?? 'tool call failed')
        if (body.images === undefined || body.images.length === 0) return { text: body.content ?? '' }
        const attachments = ctx.get('attachments') as AttachmentsService
        const images = []
        for (const image of body.images) {
          const ref = await attachments.saveImage({
            data: Buffer.from(image.base64, 'base64'),
            mediaType: image.mediaType,
            name: 'tool-image',
          })
          images.push(JSON.parse(JSON.stringify(ref)))
        }
        return { text: body.content ?? '', images }
      },
    }), {
      // Throwing fails the step on purpose. Returning false would let the model reply
      // with no tools at all, and would rebuild the prompt cache baseline.
      when: async ({ agent, modelSelection, signal }) => {
        await verifySurface()
        const surface = await lookupFor(agent.id)(modelSelection, signal)
        return surface.has(tool.name)
      },
    })
  }

  ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    if (result.isError === true && result.error?.message?.startsWith('unknown tool')) {
      return { ...result, content: [{ type: 'text', text: `unknown tool "${exec.name}": 这个工具现在不可用。先用 tools__search 查找，再用 tools__load 加载。` }] }
    }
    return result
  })
}
