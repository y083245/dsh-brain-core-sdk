import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const scriptPath = process.argv[2] as string
const logPath = process.argv[3] as string
const script = JSON.parse(readFileSync(scriptPath, 'utf8')) as Record<string, unknown>

const generationFile = script.generationFile as string | undefined
let generation = 1
if (generationFile !== undefined) {
  let previous = 0
  try { previous = Number(readFileSync(generationFile, 'utf8')) || 0 } catch { /* first start */ }
  generation = previous + 1
  writeFileSync(generationFile, String(generation))
}

function log(entry: Record<string, unknown>): void {
  try { appendFileSync(logPath, `${JSON.stringify({ t: Date.now(), ...entry })}\n`) } catch { /* the test is gone */ }
}
function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}
function respond(id: unknown, result: unknown): void {
  send({ jsonrpc: '2.0', id, result: result === undefined ? null : result })
}
function respondError(id: unknown, error: unknown): void {
  send({ jsonrpc: '2.0', id, error })
}

log({ event: 'start', pid: process.pid, generation })
log({ event: 'argv', argv: process.argv.slice(2) })
if (typeof script.envFile === 'string') writeFileSync(script.envFile, JSON.stringify(process.env))
if (typeof script.stderr === 'string') process.stderr.write(script.stderr)
for (const line of (script.garbage as string[] | undefined) ?? []) process.stdout.write(`${line}\n`)
if (typeof script.overlong === 'number') process.stdout.write(`${'x'.repeat(script.overlong)}\n`)

const crashGenerations = (script.crashGenerations as number[] | undefined) ?? []
if (script.crashEveryStart === true || crashGenerations.includes(generation)) {
  log({ event: 'crash', generation })
  process.exit(1)
}

let nextId = 1
const pending = new Map<number, { key?: string; method: string }>()
const toolResults = (script.toolResults as Record<string, unknown> | undefined) ?? {}
const responses = (script.respond as Record<string, unknown> | undefined) ?? {}
const delays = (script.delay as Record<string, number> | undefined) ?? {}

function runCalls(): void {
  for (const call of (script.calls as { method: string; params?: unknown; key?: string }[] | undefined) ?? []) {
    const id = nextId++
    pending.set(id, call.key === undefined ? { method: call.method } : { key: call.key, method: call.method })
    const message: Record<string, unknown> = { jsonrpc: '2.0', id, method: call.method }
    if (call.params !== undefined) message.params = call.params
    send(message)
  }
  const exitGenerations = script.exitAfterReadyGenerations as number[] | undefined
  if (typeof script.exitAfterReadyMs === 'number' && (exitGenerations === undefined || exitGenerations.includes(generation))) {
    setTimeout(() => { log({ event: 'crash', generation }); process.exit(1) }, script.exitAfterReadyMs)
  }
  setTimeout(() => send({ jsonrpc: '2.0', method: 'plugin.ready' }), script.readyDelayMs as number | undefined)
}

function reply(id: unknown, value: unknown): void {
  if (value !== null && typeof value === 'object' && 'error' in (value as Record<string, unknown>)) {
    respondError(id, (value as Record<string, unknown>).error)
  } else {
    respond(id, value)
  }
}

function handle(message: Record<string, unknown>): void {
  if (typeof message.method === 'string') {
    if (message.id === undefined) {
      if (message.method === 'shutdown') {
        log({ event: 'shutdown' })
        if (script.ignoreShutdown !== true) setTimeout(() => process.exit(0), 10)
        return
      }
      log({ event: 'notification', method: message.method, params: message.params })
      return
    }
    log({ event: 'request', method: message.method, params: message.params, id: message.id })
    if (message.method === 'initialize') {
      if (script.hangInitialize === true) return
      if (script.initializeError !== undefined) { respondError(message.id, script.initializeError); return }
      if (script.readyEarly === true) send({ jsonrpc: '2.0', method: 'plugin.ready' })
      respond(message.id, script.initializeResult ?? { apiVersion: '1.0.0' })
      if (script.ready !== false) runCalls()
      return
    }
    const delay = delays[message.method] ?? 0
    const value = message.method === 'tool.invoke'
      ? toolResults[(message.params as { name?: string } | undefined)?.name ?? ''] ?? responses['tool.invoke'] ?? null
      : responses[message.method] ?? null
    if (delay > 0) setTimeout(() => reply(message.id, value), delay)
    else reply(message.id, value)
    return
  }
  const id = message.id as number
  const info = pending.get(id)
  pending.delete(id)
  log({ event: 'response', id, key: info?.key, method: info?.method, result: message.result, error: message.error })
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
process.stdin.on('end', () => {
  log({ event: 'stdin-end' })
  if (script.stayOnStdinEnd !== true) process.exit(0)
})
