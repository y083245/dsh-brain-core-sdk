/* global process */
// A minimal protocol-v0 plugin: it only has to come up and stay up, so the kernel can be
// tested against a process that crashes and is restarted.
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

// HOME points at the plugin's own data directory; the test can find this process without scanning.
writeFileSync(path.join(process.env.HOME ?? process.cwd(), 'pid'), String(process.pid))

const rl = readline.createInterface({ input: process.stdin })
function write(message) { process.stdout.write(`${JSON.stringify(message)}\n`) }

rl.on('line', (line) => {
  if (line.trim() === '') return
  const message = JSON.parse(line)
  if (message.id === undefined) {
    if (message.method === 'shutdown') process.exit(0)
    return
  }
  if (message.method === 'initialize') {
    write({ jsonrpc: '2.0', id: message.id, result: { apiVersion: '1.0.0' } })
    write({ jsonrpc: '2.0', method: 'plugin.ready' })
    return
  }
  write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } })
})
rl.on('close', () => process.exit(0))
