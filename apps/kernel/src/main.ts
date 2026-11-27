import { randomBytes } from 'node:crypto'
import { readFileSync, unlinkSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { isProcessAlive } from '@dsh-brain-core/satellite-host'
import { BrainError } from '@dsh-brain-core/sdk'
import type { CrossChannelMode, RuntimeSettings } from './contracts/index.ts'
import { prepareBrainHome } from './home/index.ts'
import { createLogger } from './log/index.ts'
import { createSecretStore } from './secrets/index.ts'
import type { PluginLifecycle } from './plugin-lifecycle/index.ts'
import type { BrainPaths } from './home/index.ts'

export interface Io { readonly stdout: (text: string) => void; readonly stderr: (text: string) => void }

const VERSION_USAGE = 'Usage: brain --version\n'
const USAGE = VERSION_USAGE
  + '       brain start [--port <n>] [--cross-channel off|shadow|on] [--owner-channel <channel>]...\n'
  + '       brain console [--port <n>] [--api-port <n>] [--cross-channel off|shadow|on] [--owner-channel <channel>]...\n'
  + '       brain plugin install <spec> [--yes]\n'
  + '       brain plugin upgrade <id> <spec> [--yes]\n'
  + '       brain plugin confirm <id>\n'
  + '       brain plugin enable|disable <id>\n'
  + '       brain plugin uninstall <id> [--keep-data]\n'
  + '       brain plugin list\n'
  + '       brain plugin check [dir] [--json]\n'
  + '       brain model set <chat|activity> --provider <p> --model <m> --effort <e>\n'
  + '       brain secret set <name>\n'
  + '       brain import --from <dir> --mode <all|memory|fresh> [--role <name>] [--dry-run]\n'
  + '       brain doctor --isolation [--snapshot <file> | --compare <file>] [--dsh-home <dir>]\n'

const DEFAULT_PORT = 17345
const DEFAULT_CONSOLE_PORT = 17346
const DEFAULT_API_PORT = 0
const DEFAULT_CROSS_CHANNEL: CrossChannelMode = 'shadow'

function parsePortArg(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(raw)) return null
  const port = Number(raw)
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : null
}

function parseCrossChannelArg(raw: string | undefined): CrossChannelMode | null {
  const mode = raw ?? DEFAULT_CROSS_CHANNEL
  return mode === 'off' || mode === 'shadow' || mode === 'on' ? mode : null
}

async function awaitGracefulShutdown(pidFile: string, cleanup: () => Promise<void>): Promise<number> {
  return await new Promise<number>((resolve) => {
    let closing = false
    const shutdown = (): void => {
      if (closing) return
      closing = true
      process.off('SIGINT', shutdown)
      process.off('SIGTERM', shutdown)
      process.off('disconnect', shutdown)
      void (async () => {
        await cleanup()
        try { unlinkSync(pidFile) } catch { /* already gone */ }
        resolve(0)
      })()
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
    // Windows has no SIGTERM; a supervisor (or a test) that spawned us with an IPC channel
    // gets the same graceful close by disconnecting it.
    if (process.send !== undefined) {
      process.once('disconnect', shutdown)
      process.channel?.unref?.()
    }
  })
}

function ioError(io: Io, message: string): number {
  io.stderr(`${message}\n`)
  return 1
}

async function prepare(): Promise<BrainPaths> {
  return await prepareBrainHome({ env: process.env, userHome: os.homedir() })
}

function pidFileOf(paths: BrainPaths): string {
  return path.join(paths.state, 'kernel.pid')
}

/** plugin, model and secret change files a running kernel has already read; the S4 console will own live changes. */
async function assertKernelStopped(paths: BrainPaths): Promise<void> {
  let text: string
  try {
    text = await readFile(pidFileOf(paths), 'utf8')
  } catch {
    return
  }
  const pid = Number(text.trim())
  if (!Number.isInteger(pid) || pid <= 0) return
  if (isProcessAlive(pid)) {
    throw new BrainError('CONFLICT', `内核还在运行（pid ${pid}），先停内核再改。`)
  }
}

// ---- start ----

async function start(args: readonly string[], io: Io): Promise<number> {
  let values: { port?: string; 'cross-channel'?: string; 'owner-channel'?: string[] }
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        port: { type: 'string' },
        'cross-channel': { type: 'string' },
        'owner-channel': { type: 'string', multiple: true },
      },
      allowPositionals: false,
      strict: true,
    }))
  } catch {
    io.stderr(USAGE)
    return 2
  }

  const port = parsePortArg(values.port, DEFAULT_PORT)
  const mode = parseCrossChannelArg(values['cross-channel'])
  if (port === null || mode === null) {
    io.stderr(USAGE)
    return 2
  }
  const ownerChannels = values['owner-channel']

  // Loaded lazily so `--version` and the usage paths do not pull in node:sqlite (and its warning).
  const { createKernel } = await import('./assembly.ts')

  const paths = await prepare()
  // A fresh token on every start; it lives in memory only (RFC S10).
  const token = randomBytes(32).toString('base64url')
  const log = createLogger({ write: (line) => io.stderr(`${line}\n`), secrets: () => [token] })

  const kernel = await createKernel({
    env: process.env,
    userHome: os.homedir(),
    port,
    crossChannel: mode,
    crossChannelOverride: values['cross-channel'] !== undefined,
    ...(ownerChannels === undefined ? {} : { ownerChannels }),
    log,
    token,
  })

  const pidFile = pidFileOf(paths)
  const { writeFileAtomic } = await import('@dsh-brain-core/shared')
  await writeFileAtomic(pidFile, `${process.pid}\n`)

  // The only place the token is ever printed, and only once.
  io.stdout(`Brain memory API: http://127.0.0.1:${kernel.port}/api/v1\n`)
  io.stdout(`Token: ${token}\n`)

  return await awaitGracefulShutdown(pidFile, async () => {
    try { await kernel.close() } catch { /* the process is going away */ }
  })
}

// ---- console ----

async function consoleCommand(args: readonly string[], io: Io): Promise<number> {
  let values: { port?: string; 'api-port'?: string; 'cross-channel'?: string; 'owner-channel'?: string[] }
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        port: { type: 'string' },
        'api-port': { type: 'string' },
        'cross-channel': { type: 'string' },
        'owner-channel': { type: 'string', multiple: true },
      },
      allowPositionals: false,
      strict: true,
    }))
  } catch {
    io.stderr(USAGE)
    return 2
  }

  const consolePort = parsePortArg(values.port, DEFAULT_CONSOLE_PORT)
  const apiPort = parsePortArg(values['api-port'], DEFAULT_API_PORT)
  const mode = parseCrossChannelArg(values['cross-channel'])
  if (consolePort === null || apiPort === null || mode === null) {
    io.stderr(USAGE)
    return 2
  }
  if (consolePort !== 0 && consolePort === apiPort) {
    io.stderr(`控制台端口与内核 API 端口不能相同（${consolePort}）。\n${USAGE}`)
    return 2
  }
  const ownerChannels = values['owner-channel']

  const paths = await prepare()
  try {
    await assertKernelStopped(paths)
  } catch (error) {
    return ioError(io, error instanceof Error ? error.message : String(error))
  }

  // Loaded lazily so `--version` and the usage paths do not pull in node:sqlite (and its warning).
  const { createKernel } = await import('./assembly.ts')
  // A fresh token on every start; it lives in memory only (RFC S10).
  const token = randomBytes(32).toString('base64url')
  const log = createLogger({ write: (line) => io.stderr(`${line}\n`), secrets: () => [token] })

  let kernel: Awaited<ReturnType<typeof createKernel>>
  try {
    kernel = await createKernel({
      env: process.env,
      userHome: os.homedir(),
      port: apiPort,
      crossChannel: mode,
      crossChannelOverride: values['cross-channel'] !== undefined,
      ...(ownerChannels === undefined ? {} : { ownerChannels }),
      log,
      token,
    })
  } catch (error) {
    return ioError(io, error instanceof Error ? error.message : String(error))
  }

  let consoleServer: { listen(): Promise<{ readonly port: number }>; close(): Promise<void> }
  let boundConsolePort: number
  try {
    const { createConsoleServer } = await import('@dsh-brain-core/console')
    consoleServer = createConsoleServer({
      token,
      port: consolePort,
      brainHome: paths.home,
      factoryRolesDir: kernel.memory.roles.factoryDir,
      kernelApi: {
        baseUrl: `http://127.0.0.1:${kernel.port}`,
        token,
      },
      persistRoleCard: async ({ name, text, mode }) => {
        if (mode === 'select') await kernel.memory.persona.selectRoleCard(name)
        else await kernel.memory.persona.saveRoleCard({ name, text })
      },
      onInvalidateRunner: async (agentClass) => {
        kernel.runner.invalidate(agentClass)
        if (agentClass === 'activity') await kernel.refreshMemoryAutomation()
      },
    })
    ;({ port: boundConsolePort } = await consoleServer.listen())
  } catch (error) {
    try { await kernel.close() } catch { /* best-effort cleanup */ }
    return ioError(io, error instanceof Error ? error.message : String(error))
  }

  const pidFile = pidFileOf(paths)
  try {
    const { writeFileAtomic } = await import('@dsh-brain-core/shared')
    await writeFileAtomic(pidFile, `${process.pid}\n`)
  } catch (error) {
    try { await consoleServer.close() } catch { /* best-effort cleanup */ }
    try { await kernel.close() } catch { /* best-effort cleanup */ }
    return ioError(io, error instanceof Error ? error.message : String(error))
  }

  // The only place the token is ever printed, and only once.
  io.stdout(`Brain console: http://127.0.0.1:${boundConsolePort}\n`)
  io.stdout(`Brain memory API: http://127.0.0.1:${kernel.port}/api/v1\n`)
  io.stdout(`Token: ${token}\n`)

  return await awaitGracefulShutdown(pidFile, async () => {
    try { await consoleServer.close() } catch { /* the process is going away */ }
    try { await kernel.close() } catch { /* the process is going away */ }
  })
}

// ---- plugin commands ----

function printPreview(io: Io, preview: { id: string; version: string; permissions: readonly string[]; newPermissions: readonly string[]; warnings: readonly string[] }): void {
  io.stdout(`plugin: ${preview.id}\n`)
  io.stdout(`version: ${preview.version}\n`)
  io.stdout(`permissions: ${preview.permissions.join(', ')}\n`)
  io.stdout(`new permissions: ${preview.newPermissions.join(', ')}\n`)
  for (const warning of preview.warnings) io.stdout(`warning: ${warning}\n`)
}

/** The S3 CLI only changes files; the running kernel is the only place a plugin is actually applied. */
const filesOnly = {
  async enable(): Promise<void> { /* the next kernel start enables it */ },
  async disable(): Promise<void> { /* the next kernel start leaves it off */ },
  state: (): 'disabled' => 'disabled',
} as const

async function cliLifecycle(): Promise<PluginLifecycle> {
  const paths = await prepare()
  const { createPluginLifecycle } = await import('./plugin-lifecycle/index.ts')
  const { createPluginStorage } = await import('./plugin-runtime/index.ts')
  const { createPluginLogger } = await import('./plugin-runtime/plugin-logger.ts')
  const { brainPackageDirectory, runCommand, sdkDirectory } = await import('./assembly.ts')
  const log = createLogger({ write: (line) => process.stderr.write(`${line}\n`) })
  const clock = { now: (): number => Date.now() }
  return createPluginLifecycle({
    pluginsDir: paths.plugins,
    sdkDir: sdkDirectory(),
    brainPackages: { 'chat-kit': brainPackageDirectory('@dsh-brain-core/chat-kit') },
    activator: filesOnly,
    storageFor: (id) => createPluginStorage(path.join(paths.plugins, id)),
    loggerFor: (id) => createPluginLogger({ dir: path.join(paths.plugins, id), now: () => clock.now() }),
    run: runCommand,
    coreWarnings: () => [],
    clock,
    log,
  })
}

/** The plugin id and version a local directory spec names, read without unpacking it. */
async function localSpecIdentity(spec: string): Promise<{ readonly id: string; readonly version: string } | undefined> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path.join(path.resolve(spec), 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const record = parsed as { readonly version?: unknown; readonly brain?: unknown }
  if (typeof record.version !== 'string' || record.version === '') return undefined
  const brain = record.brain
  if (brain === null || typeof brain !== 'object' || Array.isArray(brain)) return undefined
  const id = (brain as { readonly id?: unknown }).id
  return typeof id === 'string' && id !== '' ? { id, version: record.version } : undefined
}

async function pluginInstall(args: readonly string[], io: Io, upgrade: boolean): Promise<number> {
  let values: { yes?: boolean }
  let positionals: string[]
  try {
    ({ values, positionals } = parseArgs({
      args: [...args],
      options: { yes: { type: 'boolean' } },
      allowPositionals: true,
      strict: true,
    }))
  } catch {
    io.stderr(USAGE)
    return 2
  }
  const expected = upgrade ? 2 : 1
  if (positionals.length !== expected) {
    io.stderr(USAGE)
    return 2
  }
  const paths = await prepare()
  try {
    await assertKernelStopped(paths)
    const lifecycle = await cliLifecycle()
    if (values.yes === true && !upgrade) {
      const spec = positionals[0] as string
      let preview: Awaited<ReturnType<PluginLifecycle['install']>>
      try {
        // Install what this command names: a pending plugin left by some other spec is not ours to confirm.
        preview = await lifecycle.install(spec)
      } catch (error) {
        if (!(error instanceof BrainError) || error.code !== 'CONFLICT') throw error
        // The same plugin is already installed; a prior run of this command may have left it pending.
        const requested = await localSpecIdentity(spec)
        const pending = (await lifecycle.list()).filter((entry) => entry.state === 'pending')
        const match = requested === undefined
          ? undefined
          : pending.find((entry) => entry.id === requested.id && entry.version === requested.version)
        if (match === undefined) {
          if (requested === undefined && pending.length > 0
            && /^plugin .+ is already installed; use upgrade or uninstall$/.test(error.message)) {
            throw new BrainError('CONFLICT', `${error.message}; pending plugins can be confirmed explicitly: ${pending.map((entry) => `brain plugin confirm ${entry.id}`).join(', ')}`)
          }
          throw error
        }
        await lifecycle.confirm(match.id)
        io.stdout(`installed ${match.id}\n`)
        return 0
      }
      printPreview(io, preview)
      await lifecycle.confirm(preview.id)
      io.stdout(`installed ${preview.id}\n`)
      return 0
    }
    const preview = upgrade
      ? await lifecycle.upgrade(positionals[0] as string, positionals[1] as string)
      : await lifecycle.install(positionals[0] as string)
    printPreview(io, preview)
    if (values.yes !== true) {
      io.stdout(`run "brain plugin confirm ${preview.id}" (or re-run with --yes to confirm)\n`)
      return 0
    }
    // An upgrade with no new permission is applied by the lifecycle itself; only a pending one needs confirm.
    if (!upgrade || preview.newPermissions.length > 0) await lifecycle.confirm(preview.id)
    io.stdout(`${upgrade ? 'upgraded' : 'installed'} ${preview.id}\n`)
    return 0
  } catch (error) {
    return ioError(io, error instanceof Error ? error.message : String(error))
  }
}

async function pluginCommand(args: readonly string[], io: Io): Promise<number> {
  const [action, ...rest] = args
  if (action === 'check') {
    // Static checks need no kernel and are allowed while one is running.
    const { runCheckCli } = await import('@dsh-brain-core/testkit')
    return await runCheckCli(rest, io)
  }
  if (action === 'install') return await pluginInstall(rest, io, false)
  if (action === 'upgrade') return await pluginInstall(rest, io, true)

  let values: { 'keep-data'?: boolean }
  let positionals: string[]
  try {
    ({ values, positionals } = parseArgs({
      args: [...rest],
      options: action === 'confirm' ? {} : { 'keep-data': { type: 'boolean' } },
      allowPositionals: true,
      strict: true,
    }))
  } catch {
    io.stderr(USAGE)
    return 2
  }

  if (action === 'list') {
    if (positionals.length !== 0) { io.stderr(USAGE); return 2 }
    const lifecycle = await cliLifecycle()
    for (const entry of await lifecycle.list()) io.stdout(`${entry.id} ${entry.version} ${entry.state}\n`)
    return 0
  }

  if (action !== 'confirm' && action !== 'enable' && action !== 'disable' && action !== 'uninstall') {
    io.stderr(USAGE)
    return 2
  }
  if (positionals.length !== 1) { io.stderr(USAGE); return 2 }
  const id = positionals[0] as string

  const paths = await prepare()
  try {
    await assertKernelStopped(paths)
    const lifecycle = await cliLifecycle()
    if (action === 'confirm') await lifecycle.confirm(id)
    else if (action === 'enable') await lifecycle.enable(id)
    else if (action === 'disable') await lifecycle.disable(id)
    else await lifecycle.uninstall(id, { keepData: values['keep-data'] === true })
    io.stdout(`${action === 'confirm' ? 'confirmed' : action === 'uninstall' ? 'uninstalled' : action === 'enable' ? 'enabled' : 'disabled'} ${id}\n`)
    return 0
  } catch (error) {
    return ioError(io, error instanceof Error ? error.message : String(error))
  }
}

// ---- model and secret ----

async function modelSet(args: readonly string[], io: Io): Promise<number> {
  const [action, ...rest] = args
  if (action !== 'set') { io.stderr(USAGE); return 2 }
  let values: { provider?: string; model?: string; effort?: string }
  let positionals: string[]
  try {
    ({ values, positionals } = parseArgs({
      args: [...rest],
      options: { provider: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' } },
      allowPositionals: true,
      strict: true,
    }))
  } catch {
    io.stderr(USAGE)
    return 2
  }
  if (positionals.length !== 1) { io.stderr(USAGE); return 2 }
  const agentClass = positionals[0]
  if (agentClass !== 'chat' && agentClass !== 'activity') { io.stderr(USAGE); return 2 }
  // No defaults: all three must come from the owner.
  if (values.provider === undefined || values.model === undefined || values.effort === undefined) {
    io.stderr(USAGE)
    return 2
  }
  const { THINKING_EFFORTS } = await import('@dsh-brain-core/satellite-host')
  if (!(THINKING_EFFORTS as readonly string[]).includes(values.effort)) {
    io.stderr(`unknown effort: ${values.effort}\n${USAGE}`)
    return 2
  }

  const paths = await prepare()
  try {
    await assertKernelStopped(paths)
    const { createSettingsStore } = await import('./runtime-stores/index.ts')
    const store = createSettingsStore(path.join(paths.state, 'settings.json'))
    const current = await store.read()
    const next: RuntimeSettings = {
      ...current,
      agents: {
        ...current.agents,
        [agentClass]: { provider: values.provider, model: values.model, effort: values.effort as never },
      },
    }
    await store.write(next)
    io.stdout(`model set: ${agentClass} ${values.provider}/${values.model} (${values.effort})\n`)
    return 0
  } catch (error) {
    return ioError(io, error instanceof Error ? error.message : String(error))
  }
}

/** One newline from a pipe or the terminal is the terminator, not part of the secret. */
function stripOneNewline(text: string): string {
  return text.replace(/\r?\n$/, '')
}

async function readSecretFromStdin(): Promise<string> {
  const stdin = process.stdin
  if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
    stdin.setRawMode(true)
    stdin.resume()
    let value = ''
    try {
      for await (const chunk of stdin) {
        for (const char of Buffer.from(chunk as Uint8Array).toString('utf8')) {
          if (char === '\r' || char === '\n') {
            process.stdout.write('\n')
            return value
          }
          if (char === '\u0003') throw new BrainError('INVALID_ARGUMENT', 'cancelled')
          if (char === '\u007f' || char === '\b') {
            value = value.slice(0, -1)
            continue
          }
          value += char
        }
      }
    } finally {
      stdin.setRawMode(false)
      stdin.pause()
    }
    return value
  }
  const chunks: Buffer[] = []
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk as Uint8Array))
  return stripOneNewline(Buffer.concat(chunks).toString('utf8'))
}

async function secretSet(args: readonly string[], io: Io): Promise<number> {
  const [action, ...rest] = args
  if (action !== 'set' || rest.length !== 1) { io.stderr(USAGE); return 2 }
  const name = rest[0] as string
  const paths = await prepare()
  try {
    await assertKernelStopped(paths)
    const value = await readSecretFromStdin()
    const store = createSecretStore({ file: paths.secretsFile })
    await store.set(name, value)
    // The name only; the value is never printed.
    io.stdout(`secret set: ${name}\n`)
    return 0
  } catch (error) {
    return ioError(io, error instanceof Error ? error.message : String(error))
  }
}

// ---- import ----

async function importCommand(args: readonly string[], io: Io): Promise<number> {
  let values: { from?: string; mode?: string; role?: string; 'dry-run'?: boolean }
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        from: { type: 'string' },
        mode: { type: 'string' },
        role: { type: 'string' },
        'dry-run': { type: 'boolean' },
      },
      allowPositionals: false,
      strict: true,
    }))
  } catch {
    io.stderr(USAGE)
    return 2
  }

  const fromDir = values.from?.trim() ?? ''
  const mode = values.mode
  if (fromDir === '' || (mode !== 'all' && mode !== 'memory' && mode !== 'fresh')) {
    io.stderr(USAGE)
    return 2
  }
  if (values.role !== undefined && values.role.trim() === '') {
    io.stderr(USAGE)
    return 2
  }

  const paths = await prepare()
  try {
    await assertKernelStopped(paths)
    const clock = { now: (): number => Date.now() }
    const { createSqliteRecordStore } = await import('./memory-store/index.ts')
    const { createKeywordIndex } = await import('./memory-search/index.ts')
    const { createIdentityService, createProfileStore } = await import('./identity-persona/index.ts')
    const { createLegacyImporter } = await import('./legacy-import/index.ts')

    const store = await createSqliteRecordStore({ path: path.join(paths.memory, 'records.db'), clock })
    let index: Awaited<ReturnType<typeof createKeywordIndex>> | undefined
    try {
      index = await createKeywordIndex({ path: path.join(paths.memory, 'index.db') })
      const identity = await createIdentityService({ path: path.join(paths.memory, 'identity.json'), clock })
      const profiles = createProfileStore({ store, clock })
      const importer = createLegacyImporter({
        store,
        index,
        identity,
        profiles,
        clock,
        choiceFile: path.join(paths.memory, 'import-choice.json'),
      })
      const report = await importer.importFrom({
        fromDir,
        mode,
        ...(values.role === undefined ? {} : { role: values.role }),
        dryRun: values['dry-run'] === true,
      })
      const prefix = report.dryRun ? '[预演] ' : ''
      io.stdout(
        `${prefix}导入完成（模式: ${report.mode}）：`
        + `L0 导入 ${report.l0Imported}（跳过 ${report.l0Skipped}），`
        + `L1 导入 ${report.l1Imported}（跳过 ${report.l1Skipped}），`
        + `L3 自我画像 ${report.l3SelfCommitted ? '已提交' : '未提交'}，`
        + `L3 人物 ${report.l3PersonsImported}，`
        + `溯源锚点 ${report.anchorRecordsCreated}\n`,
      )
      return 0
    } finally {
      await index?.close().catch(() => undefined)
      await store.close().catch(() => undefined)
    }
  } catch (error) {
    return ioError(io, error instanceof Error ? error.message : String(error))
  }
}

// ---- doctor ----

async function doctor(args: readonly string[], io: Io): Promise<number> {
  let values: { isolation?: boolean; snapshot?: string; compare?: string; 'dsh-home'?: string }
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        isolation: { type: 'boolean' },
        snapshot: { type: 'string' },
        compare: { type: 'string' },
        'dsh-home': { type: 'string' },
      },
      allowPositionals: false,
      strict: true,
    }))
  } catch {
    io.stderr(USAGE)
    return 2
  }
  if (values.isolation !== true || (values.snapshot !== undefined && values.compare !== undefined)) {
    io.stderr(USAGE)
    return 2
  }
  const mode = values.snapshot !== undefined ? 'snapshot' : values.compare !== undefined ? 'compare' : 'check'
  const file = values.snapshot ?? values.compare
  const { resolveDshHome, runDoctor } = await import('./isolation-doctor/index.ts')
  try {
    const result = await runDoctor({
      mode,
      dshHome: resolveDshHome(values['dsh-home'], process.env, os.homedir()),
      ...(file === undefined ? {} : { file }),
    })
    if (result.kind === 'snapshot') {
      io.stdout(`snapshot: ${result.entries} entries -> ${result.file}\n`)
      return 0
    }
    if (result.kind === 'compare') {
      if (result.unchanged) {
        io.stdout('compare: unchanged\n')
        return 0
      }
      io.stdout('compare: changed\n')
      for (const item of result.added) io.stdout(`added: ${item}\n`)
      for (const item of result.removed) io.stdout(`removed: ${item}\n`)
      for (const item of result.changed) io.stdout(`changed: ${item}\n`)
      return 1
    }
    if (result.ok) {
      io.stdout('check: ok\n')
      return 0
    }
    io.stdout('check: failed\n')
    for (const problem of result.problems) io.stdout(`problem: ${problem}\n`)
    return 1
  } catch (error) {
    return ioError(io, error instanceof Error ? error.message : String(error))
  }
}

/** Returns the exit code. */
export async function main(argv: readonly string[], io: Io): Promise<number> {
  if (argv.length === 1 && argv[0] === '--version') {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    io.stdout(`${pkg.version}\n`)
    return 0
  }
  const [command, ...rest] = argv
  if (command === 'start') return start(rest, io)
  if (command === 'console') return consoleCommand(rest, io)
  if (command === 'plugin') return pluginCommand(rest, io)
  if (command === 'model') return modelSet(rest, io)
  if (command === 'secret') return secretSet(rest, io)
  if (command === 'import') return importCommand(rest, io)
  if (command === 'doctor') return doctor(rest, io)
  // kernel-skeleton fixed the no-argument output; the full usage appears when arguments are wrong.
  io.stderr(argv.length === 0 ? VERSION_USAGE : USAGE)
  return 2
}
