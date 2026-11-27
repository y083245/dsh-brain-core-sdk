import type { Layer } from '@dsh-brain-core/sdk'

/** The only fields a log line may carry (RFC R8): no message text, no record content, no secrets. */
export interface LogFields {
  readonly requestId?: string
  /** A record id; never record content. */
  readonly recordId?: string
  readonly plugin?: string
  readonly channel?: string
  readonly layer?: Layer
  readonly code?: string
  readonly durationMs?: number
  readonly count?: number
}

export interface Logger {
  info(event: string, fields?: LogFields): void
  warn(event: string, fields?: LogFields): void
  error(event: string, fields?: LogFields): void
}

const FIELD_KEYS = ['requestId', 'recordId', 'plugin', 'channel', 'layer', 'code', 'durationMs', 'count'] as const
const NUMERIC_KEYS = new Set<string>(['durationMs', 'count'])

export function redact(text: string, secrets: Iterable<string>): string {
  const values = [...secrets].filter((value) => value.length >= 8).sort((a, b) => b.length - a.length)
  let result = text
  for (const value of values) result = result.split(value).join('[redacted]')
  result = result.replace(/sk-[A-Za-z0-9_-]{16,}/g, '[redacted]')
  result = result.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, '[redacted]')
  return result
}

/** Runtime whitelist: a cast can put extra keys in, but they never reach the line. */
function sanitizeFields(fields: LogFields | undefined, secrets: Iterable<string>): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  if (fields === undefined) return out
  const raw = fields as unknown as Record<string, unknown>
  for (const key of FIELD_KEYS) {
    const value = raw[key]
    if (value === undefined) continue
    if (NUMERIC_KEYS.has(key)) {
      if (typeof value === 'number') out[key] = value
      continue
    }
    if (typeof value === 'string') out[key] = redact(value, secrets)
  }
  return out
}

export function createLogger(options: {
  readonly write: (line: string) => void
  readonly now?: () => number                 // default Date.now
  readonly secrets?: () => Iterable<string>   // values to cut out, e.g. from the secret store
}): Logger {
  const now = options.now ?? Date.now

  /** event is a fixed English event name such as `memory.ingest`; never put chat content here. */
  function log(level: 'info' | 'warn' | 'error', event: string, fields?: LogFields): void {
    const secrets = options.secrets?.() ?? []
    const line: Record<string, string | number> = {
      t: now(),
      level,
      event: redact(event, secrets),
      ...sanitizeFields(fields, secrets),
    }
    options.write(JSON.stringify(line))
  }

  return {
    info: (event, fields) => log('info', event, fields),
    warn: (event, fields) => log('warn', event, fields),
    error: (event, fields) => log('error', event, fields),
  }
}
