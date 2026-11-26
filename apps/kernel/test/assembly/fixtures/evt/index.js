/* global process */
// The S3 tests keep the observable state in a global, since this module runs inside the kernel process.
import { readFileSync } from 'node:fs'
import path from 'node:path'

const received = (globalThis.__brainEventsPlugin ??= { recorded: [], forgotten: [] })

function sessionsSnapshot() {
  const home = process.env.BRAIN_ASSEMBLY_TEST_HOME
  if (typeof home !== 'string' || home === '') return null
  try { return JSON.parse(readFileSync(path.join(home, 'state', 'agent', 'sessions.json'), 'utf8')) } catch { return null }
}

export async function apply(ctx) {
  received.recorded.length = 0
  received.forgotten.length = 0
  ctx.events.on('memory.recorded', (payload) => { received.recorded.push(payload) })
  ctx.events.on('memory.forgotten', (payload) => {
    received.forgotten.push({ ids: payload.ids, sessions: sessionsSnapshot() })
  })
}
