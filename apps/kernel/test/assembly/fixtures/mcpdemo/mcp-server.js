/* global process */
// A hand-written stdio MCP server: one tool, one text result.
function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`) }

function handle(message) {
  if (message.method === undefined || message.id === undefined) return
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0', id: message.id,
      result: {
        protocolVersion: (message.params && message.params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'demo-mcp', version: '1.0.0' },
      },
    })
    return
  }
  if (message.method === 'ping') { send({ jsonrpc: '2.0', id: message.id, result: {} }); return }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'ping', description: 'pong', inputSchema: { type: 'object' } }] } })
    return
  }
  if (message.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'pong' }] } })
    return
  }
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const index = buffer.indexOf('\n')
    if (index === -1) return
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line === '') continue
    try { handle(JSON.parse(line)) } catch { /* not a message */ }
  }
})
process.stdin.on('end', () => process.exit(0))
