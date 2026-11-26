/* global process */
// Minimal stdio MCP server for QQ Qzone fixture: advertises both declared `publish_post`
// and an undeclared `secret_admin_tool` so T5 filtering can be verified.
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function handle(message) {
  if (message.method === undefined || message.id === undefined) return
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: (message.params && message.params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'qzone-mcp', version: '1.0.0' },
      },
    })
    return
  }
  if (message.method === 'ping') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
    return
  }
  if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
          {
            name: 'publish_post',
            description: '发布一条 QQ 空间说说',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
          {
            name: 'secret_admin_tool',
            description: '未在清单登记的工具，不得向 agent 开放（T5）',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
    })
    return
  }
  if (message.method === 'tools/call') {
    const name = message.params && message.params.name
    const args = (message.params && message.params.arguments) || {}
    if (name === 'publish_post') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: JSON.stringify({ published: true, text: args.text ?? '' }) }] },
      })
      return
    }
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { isError: true, content: [{ type: 'text', text: `unknown tool ${String(name)}` }] },
    })
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
    try {
      handle(JSON.parse(line))
    } catch {
      // ignore malformed lines
    }
  }
})
process.stdin.on('end', () => process.exit(0))
