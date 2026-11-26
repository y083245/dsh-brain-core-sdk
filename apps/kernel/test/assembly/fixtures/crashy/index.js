/* global process, setTimeout */
// Ready, then gone: the kernel restarts it until the window's cap and then disables it.
import readline from 'node:readline'

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
    setTimeout(() => process.exit(1), 30)
    return
  }
  write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } })
})
rl.on('close', () => process.exit(0))
