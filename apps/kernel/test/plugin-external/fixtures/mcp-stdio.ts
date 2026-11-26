import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const scriptPath = process.argv[2] as string
const logPath = process.argv[3] as string
const script = JSON.parse(readFileSync(scriptPath, 'utf8')) as Record<string, unknown>

function log(entry: Record<string, unknown>): void {
  try { appendFileSync(logPath, `${JSON.stringify({ t: Date.now(), ...entry })}\n`) } catch { /* the test is gone */ }
}
function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

log({ event: 'start', pid: process.pid })
if (typeof script.envFile === 'string') writeFileSync(script.envFile, JSON.stringify(process.env))
if (typeof script.stderr === 'string') process.stderr.write(script.stderr)

function handle(message: Record<string, unknown>): void {
  const method = message.method as string | undefined
  if (method === undefined) return
  log({ event: 'request', method, params: message.params, id: message.id })
  if (message.id === undefined) return
  if (method === 'initialize') {
    const params = (message.params ?? {}) as { protocolVersion?: string }
    send({
      jsonrpc: '2.0', id: message.id,
      result: {
        protocolVersion: params.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp', version: '1.0.0' },
      },
    })
    return
  }
  if (method === 'ping') { send({ jsonrpc: '2.0', id: message.id, result: {} }); return }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: script.tools ?? [] } })
    return
  }
  if (method === 'tools/call') {
    const name = (message.params as { name?: string } | undefined)?.name ?? ''
    const table = (script.calls as Record<string, unknown> | undefined) ?? {}
    const value = table[name] ?? { content: [{ type: 'text', text: 'default' }] }
    send({ jsonrpc: '2.0', id: message.id, result: value })
    return
  }
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  buffer += chunk
  for (;;) {
    const index = buffer.indexOf('\n')
    if (index === -1) return
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line === '') continue
    try { handle(JSON.parse(line) as Record<string, unknown>) } catch { /* not a message */ }
  }
})
process.stdin.on('end', () => process.exit(0))
