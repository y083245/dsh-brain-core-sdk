/** A scripted stand-in for DeepSeek's Messages API: deterministic, free, and needs no key. */
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface CapturedRequest {
  readonly model: string
  readonly tools: readonly string[]
  readonly deferred: readonly string[]
  readonly additions: number
  readonly removals: number
  readonly effort: string | undefined
  readonly thinking: string | undefined
  readonly system: string
  readonly messageCount: number
  readonly raw: string
  /** Every top-level request field, which is where the DSH upload extensions would appear. */
  readonly topLevelKeys: readonly string[]
}

export type FakeReply =
  | { readonly tool: string; readonly input?: Record<string, unknown> }
  | { readonly text: string }
  | { readonly hang: true }

export type FakeScript = (request: CapturedRequest, index: number) => FakeReply

export class FakeDeepSeek {
  readonly requests: CapturedRequest[] = []
  uploads = 0
  readonly #script: FakeScript
  readonly #server: Server

  constructor(script: FakeScript) {
    this.#script = script
    this.#server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk as Buffer))
      req.on('end', () => {
        // The adapter uploads images to the Files API before referring to them in a message.
        if (req.url?.endsWith('/files') === true) return this.#acceptFile(res)
        this.#answer(Buffer.concat(chunks).toString('utf8'), res)
      })
    })
  }

  get url(): string {
    return `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`
  }

  listen(): Promise<void> {
    return new Promise(resolve => this.#server.listen(0, '127.0.0.1', () => resolve()))
  }

  close(): Promise<void> {
    return new Promise(resolve => {
      this.#server.closeAllConnections()
      this.#server.close(() => resolve())
    })
  }

  #acceptFile(res: ServerResponse): void {
    this.uploads += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id: `file_${this.uploads}`, type: 'file', mime_type: 'image/png', size_bytes: 1,
      created_at: new Date().toISOString(), filename: 'upload.png',
    }))
  }

  #answer(rawBody: string, res: ServerResponse): void {
    const body = JSON.parse(rawBody) as {
      model: string
      system?: string
      tools?: { name: string; defer_loading?: true }[]
      messages?: unknown[]
      output_config?: { effort?: string }
      thinking?: { type?: string }
    }
    const messages = JSON.stringify(body.messages ?? [])
    const captured: CapturedRequest = {
      model: body.model,
      tools: (body.tools ?? []).filter(tool => tool.defer_loading !== true).map(tool => tool.name),
      deferred: (body.tools ?? []).filter(tool => tool.defer_loading === true).map(tool => tool.name),
      additions: messages.split('"tool_addition"').length - 1,
      removals: messages.split('"tool_removal"').length - 1,
      effort: body.output_config?.effort,
      thinking: body.thinking?.type,
      system: body.system ?? '',
      messageCount: (body.messages ?? []).length,
      raw: messages,
      topLevelKeys: Object.keys(body),
    }
    const index = this.requests.length
    this.requests.push(captured)
    const reply = this.#script(captured, index)
    if ('hang' in reply) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      return
    }
    const send = (event: { type: string } & Record<string, unknown>) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    send({
      type: 'message_start',
      message: {
        id: `msg_${index}`, type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 },
      },
    })
    if ('tool' in reply) {
      send({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `call_${index}`, name: reply.tool, input: {} } })
      send({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(reply.input ?? {}) } })
      send({ type: 'content_block_stop', index: 0 })
      send({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } })
    } else {
      send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply.text } })
      send({ type: 'content_block_stop', index: 0 })
      send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })
    }
    send({ type: 'message_stop' })
    res.end()
  }
}

/** Calls each named tool in order across the turn, then replies with text. */
export function scriptedTools(...tools: string[]): FakeScript {
  return (_request, index) => {
    const tool = tools[index]
    return tool === undefined ? { text: 'done' } : { tool }
  }
}
