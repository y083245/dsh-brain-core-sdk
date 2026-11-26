import { appendFile, chmod, mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { InstalledPlugin } from '../contracts/index.ts'

const MAX_STDERR_BYTES = 1024 * 1024
const BASE_KEYS = ['PATH', 'LANG', 'LC_ALL', 'TZ'] as const
const WINDOWS_KEYS = ['SystemRoot', 'ComSpec', 'PATHEXT', 'WINDIR'] as const

export function pluginHome(pluginsDir: string, pluginId: string): string {
  return path.join(pluginsDir, pluginId, 'home')
}

export function pluginTmp(pluginsDir: string, pluginId: string): string {
  return path.join(pluginsDir, pluginId, 'tmp')
}

export function stderrFile(pluginsDir: string, pluginId: string): string {
  return path.join(pluginsDir, pluginId, 'stderr.log')
}

export async function ensurePluginDirs(pluginsDir: string, pluginId: string): Promise<void> {
  await mkdir(pluginHome(pluginsDir, pluginId), { recursive: true })
  await mkdir(pluginTmp(pluginsDir, pluginId), { recursive: true })
}

/**
 * Only the variables a process may see: a PATH to find its interpreter, locale and time zone, and
 * HOME/TMP moved under the plugin's own directory. Nothing else is inherited.
 */
export function pluginEnvironment(
  plugin: InstalledPlugin,
  pluginsDir: string,
  parentEnv: NodeJS.ProcessEnv = process.env,
  extra: Readonly<Record<string, string>> = {},
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const env: Record<string, string> = {}
  const keys = platform === 'win32' ? [...BASE_KEYS, ...WINDOWS_KEYS] : [...BASE_KEYS]
  for (const key of keys) {
    const value = parentEnv[key]
    if (typeof value === 'string' && value !== '') env[key] = value
  }
  const home = pluginHome(pluginsDir, plugin.manifest.id)
  const tmp = pluginTmp(pluginsDir, plugin.manifest.id)
  env.HOME = home
  env.USERPROFILE = home
  env.TMPDIR = tmp
  env.TEMP = tmp
  env.TMP = tmp
  return { ...env, ...extra }
}

export interface StderrSink {
  write(chunk: string | Uint8Array): void
  close(): Promise<void>
}

/**
 * Appends to `<pluginsDir>/<id>/stderr.log` with mode 600. When the file would pass 1 MiB it is
 * replaced, so a chatty plugin cannot grow it without bound; this file never reaches the kernel log.
 */
export function createStderrSink(file: string): StderrSink {
  let tail: Promise<void> = Promise.resolve()
  let created = false

  function append(data: Buffer): void {
    tail = tail.then(async () => {
      await mkdir(path.dirname(file), { recursive: true })
      let size = 0
      try { size = (await stat(file)).size } catch { /* will be created */ }
      const bytes = data.length > MAX_STDERR_BYTES ? data.subarray(data.length - MAX_STDERR_BYTES) : data
      if (size + bytes.length > MAX_STDERR_BYTES) {
        await writeFile(file, bytes, { mode: 0o600 })
        created = true
      } else {
        await appendFile(file, bytes, { mode: 0o600 })
        created = true
      }
      if (created && process.platform !== 'win32') await chmod(file, 0o600)
    }).catch(() => {
      // a broken log file must not break the plugin
    })
  }

  return {
    write(chunk) {
      append(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk))
    },
    async close() {
      await tail
    },
  }
}
