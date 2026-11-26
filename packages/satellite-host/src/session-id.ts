/** Binds a DSH session id to one channel, so a tool call's viewer never depends on model input. */
import type { AgentClass } from './selection.ts'

export interface SessionBinding {
  readonly agentClass: AgentClass
  readonly channel: string
  readonly generation: number
}

const ID_PATTERN = /^brn-(chat|activity)-([A-Za-z0-9_-]{4,172})-(\d{1,6})$/
const CHANNEL_PATTERN = /^[a-z0-9-]+:[a-z0-9-]+:\S+$/
const MAX_CHANNEL_BYTES = 128

export function encodeSessionId(binding: SessionBinding): string {
  const { agentClass, channel, generation } = binding
  if (!CHANNEL_PATTERN.test(channel) || Buffer.byteLength(channel) > MAX_CHANNEL_BYTES) {
    throw new RangeError(`invalid channel: ${JSON.stringify(channel)}`)
  }
  if (!Number.isInteger(generation) || generation < 0 || generation > 999_999) {
    throw new RangeError(`invalid generation: ${generation}`)
  }
  return `brn-${agentClass}-${Buffer.from(channel).toString('base64url')}-${generation}`
}

/** Returns null for anything we did not mint ourselves. */
export function decodeSessionId(id: string): SessionBinding | null {
  const match = ID_PATTERN.exec(id)
  if (match === null) return null
  const [, agentClass, encoded, generation] = match
  const channel = Buffer.from(encoded as string, 'base64url').toString()
  const binding: SessionBinding = { agentClass: agentClass as AgentClass, channel, generation: Number(generation) }
  try {
    return encodeSessionId(binding) === id ? binding : null
  } catch {
    return null
  }
}
