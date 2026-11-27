import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { BrainLogger } from '@dsh-brain-core/sdk'
import { redact } from '../log/index.ts'

const MAX_BYTES = 1024 * 1024
const MAX_STRING = 200
const DROPPED_KEYS = new Set(['content', 'text', 'message', 'body', 'prompt'])

/** One JSON line per call in `<dir>/plugin.log`; chat-like keys and non-primitive values never reach it. */
export function createPluginLogger(options: {
  readonly dir: string
  readonly now: () => number
  readonly secrets?: () => Iterable<string>
}): BrainLogger {
  const file = path.join(options.dir, 'plugin.log')
  let tail: Promise<void> = Promise.resolve()

  function write(level: 'info' | 'warn' | 'error', event: string, fields?: Readonly<Record<string, string | number | boolean>>): void {
    const secrets = [...(options.secrets?.() ?? [])]
    const line: Record<string, string | number | boolean> = { t: options.now(), level, event: redact(String(event).slice(0, MAX_STRING), secrets) }
    for (const [key, value] of Object.entries((fields ?? {}) as Record<string, unknown>)) {
      if (DROPPED_KEYS.has(key.toLowerCase()) || key === 't' || key === 'level' || key === 'event') continue
      if (typeof value === 'string') line[key] = redact(value.slice(0, MAX_STRING), secrets)
      else if (typeof value === 'number' || typeof value === 'boolean') line[key] = value
    }
    const text = `${JSON.stringify(line)}\n`
    tail = tail.then(async () => {
      try {
        await mkdir(options.dir, { recursive: true })
        let size = 0
        try { size = (await stat(file)).size } catch { /* no file yet */ }
        if (size + Buffer.byteLength(text) > MAX_BYTES) await writeFile(file, text)
        else await appendFile(file, text)
      } catch {
        // a broken log file must not break the plugin
      }
    })
  }

  return {
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  }
}
