import childProcess from 'node:child_process'
import { statSync } from 'node:fs'
import path from 'node:path'
import { BrainError } from '@dsh-brain-core/sdk'

export interface CommandResolutionOptions {
  readonly platform: NodeJS.Platform
  readonly execPath: string
  readonly env: NodeJS.ProcessEnv
  readonly isFile: (file: string) => boolean
}

/** Resolve npm's JS entry without executing a Windows batch shim or interpreting arguments. */
export function resolveCommand(command: string, args: readonly string[], options: CommandResolutionOptions): {
  readonly executable: string
  readonly args: readonly string[]
} {
  if (options.platform !== 'win32' || (command !== 'npm' && command !== 'npx')) {
    return { executable: command, args: [...args] }
  }
  const win = path.win32
  const scriptName = `${command}-cli.js`
  const candidates: string[] = []
  const npmExecPath = options.env.npm_execpath
  if (command === 'npm' && npmExecPath && /^npm-cli\.(?:js|cjs|mjs)$/i.test(win.basename(npmExecPath))) {
    candidates.push(npmExecPath)
  }
  const nodeDir = win.dirname(options.execPath)
  candidates.push(
    win.join(nodeDir, 'node_modules', 'npm', 'bin', scriptName),
    win.join(nodeDir, '..', 'node_modules', 'npm', 'bin', scriptName),
  )
  for (const candidate of candidates) {
    if (options.isFile(candidate)) return { executable: options.execPath, args: [candidate, ...args] }
  }
  for (const entry of (options.env.PATH ?? options.env.Path ?? '').split(win.delimiter)) {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1')
    if (!dir) continue
    const shim = win.join(dir, `${command}.cmd`)
    // npm.cmd uses this sibling layout; also support a CLI directory without a shim.
    const cliDir = options.isFile(shim) ? win.dirname(shim) : dir
    const candidate = win.join(cliDir, 'node_modules', 'npm', 'bin', scriptName)
    if (options.isFile(candidate)) return { executable: options.execPath, args: [candidate, ...args] }
  }
  throw new BrainError('UNAVAILABLE', `${command} CLI is not available`)
}

function isFile(file: string): boolean {
  try { return statSync(file).isFile() } catch { return false }
}

/** Runs one lifecycle tool without a shell, so arguments are never re-parsed. */
export async function runCommand(command: string, args: readonly string[], options: { readonly cwd: string }): Promise<void> {
  const resolved = resolveCommand(command, args, {
    platform: process.platform, execPath: process.execPath, env: process.env, isFile,
  })
  return new Promise((resolve, reject) => {
    function fail(error: unknown): void {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
      // Never expose output, paths or package metadata to CLI / HTTP callers.
      reject(code === 'ENOENT'
        ? new BrainError('UNAVAILABLE', `command not found: ${command}`)
        : new BrainError('INTERNAL', `command failed: ${command}`))
    }
    try {
      childProcess.execFile(resolved.executable, [...resolved.args], {
        cwd: options.cwd, windowsHide: true, shell: false, maxBuffer: 16 * 1024 * 1024,
      }, (error) => {
        if (error === null) resolve()
        else fail(error)
      })
    } catch (error) {
      fail(error)
    }
  })
}
