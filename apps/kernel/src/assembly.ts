import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SelectionMissingError, createDebugViewController, createRealSatelliteFactory, createSupervisor, encodeSessionId,
  fetchToolUpdateMode, purgeSessions, requireSelection,
} from '@brain-core/satellite-host'
import type {
  AgentClass, DebugViewController, ModelSelection, SatelliteFactory, SatelliteLike, ToolUpdateMode, TurnRunner,
} from '@brain-core/satellite-host'
import type { BrainEvents, BrainManifest, PluginApply } from '@brain-core/sdk'
import { BrainError, validateManifest } from '@brain-core/sdk'
import { createUlid, writeFileAtomic } from '@brain-core/shared'
import { checkPlugin } from '@brain-core/testkit'
import {
  buildSystemPrompt, createAgentRuntime, createSatelliteLlm, readSessions,
  type DetailedLlmClient, type DetailedLlmResult,
} from './agent-runtime/index.ts'
import type {
  AgentRuntime, Clock, CrossChannelMode, InstalledPlugin, LlmClient, MemoryProviderRegistry, ModelAccountingStore,
  PluginLlmExecutor, ReadOnlyMcpStatus, RuntimeSettings, SettingsStore, ToolGateway,
} from './contracts/index.ts'
import { createConsolidationTimer, DEFAULT_CONSOLIDATION_INTERVAL_MS } from './consolidation-timer.ts'
import type { ConsolidationTimer } from './consolidation-timer.ts'
import { createExtractionTimer } from './extraction-timer.ts'
import { prepareBrainHome } from './home/index.ts'
import type { BrainPaths } from './home/index.ts'
import { createReadOnlyMcpServer, type ReadOnlyMcpServer } from './interop/index.ts'
import { resolveDshHome, runDoctor } from './isolation-doctor/index.ts'
import type { Logger } from './log/index.ts'
import {
  openMemory, createMemoryApiServer,
  type ChannelCoreBudget, type ConsoleAgentProcessStatus, type ConsoleIsolationDoctorStatus, type ConsolePluginItem,
  type ConsoleSessionSurfaceInfo, type InteropStatus,
} from './memory-api/index.ts'
import type { Memory } from './memory-api/index.ts'
import { createMemoryProviderRegistry } from './memory-provider/index.ts'
import {
  createModelAccountingStore, createPluginLlmExecutor, formatDayInTimezone,
} from './model-accounting/index.ts'
import { createExternalApply, attachMcp } from './plugin-external/index.ts'
import type { ExternalDeps } from './plugin-external/index.ts'
import { createPluginLifecycle, loadNodeEntry } from './plugin-lifecycle/index.ts'
import type { PluginLifecycle } from './plugin-lifecycle/index.ts'
import { createPluginRuntime, createPluginStorage } from './plugin-runtime/index.ts'
import { createProactiveOwnLife } from './proactive-life.ts'
import { createProactivePromises } from './proactive-promises.ts'
import type { PluginRuntime } from './plugin-runtime/index.ts'
import { createScheduler } from './scheduler/index.ts'
import type { SchedulerService } from './scheduler/index.ts'
import { createSecretStore } from './secrets/index.ts'
import type { SecretStore } from './secrets/index.ts'
import { createToolGateway } from './tool-gateway/index.ts'
import {
  createChannelRegistry, createOutboundAudit, createSettingsStore, createWakeMetrics, openMemoryPreferences, type WakeMetricsStore,
} from './runtime-stores/index.ts'

/** The openers the gateway itself refuses, before the owner's list (tool-gateway, section 6). */
const BUILTIN_OPENERS: readonly string[] = ['作为一个AI', '作为 AI', '好的，我', '当然可以', '没问题！', '哈哈，这个']

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000

export interface KernelOptions {
  readonly env: NodeJS.ProcessEnv
  readonly userHome: string
  readonly port: number
  readonly crossChannel: CrossChannelMode
  readonly crossChannelOverride?: boolean
  readonly ownerChannels?: readonly string[]
  readonly clock?: Clock
  readonly log: Logger
  readonly token: string
  /** Fake gateway address for tests. */
  readonly baseUrl?: string
}

export interface KernelInterop {
  readonly mcp: {
    status(): ReadOnlyMcpStatus
    start(): Promise<ReadOnlyMcpStatus>
    stop(): Promise<void>
  }
  readonly debugView: DebugViewController
  snapshot(): Promise<InteropStatus>
}

export interface Kernel {
  readonly port: number
  readonly memory: Memory
  readonly plugins: PluginLifecycle
  readonly runtime: PluginRuntime
  readonly agent: AgentRuntime
  readonly gateway: ToolGateway
  readonly runner: TurnRunner
  readonly settings: SettingsStore
  readonly secrets: SecretStore
  readonly accounting: ModelAccountingStore
  readonly providers: MemoryProviderRegistry
  readonly interop: KernelInterop
  readonly paths: BrainPaths
  readonly metrics: WakeMetricsStore
  getCrossChannelMode(): CrossChannelMode
  setCrossChannelMode(mode: CrossChannelMode): Promise<void>
  refreshMemoryAutomation(): Promise<void>
  close(): Promise<void>
}

/**
 * D17 API key resolution: prefers the dedicated `brain-deepseek-api-key` (isolated quota),
 * falling back to `deepseek-api-key` (shared quota with main DSH).
 */
export async function resolveApiKey(
  secrets: Pick<SecretStore, 'get'>,
  agentClass: AgentClass = 'chat',
): Promise<{ readonly apiKey: string; readonly sharedQuota: boolean }> {
  const dedicated = await secrets.get('brain-deepseek-api-key')
  if (dedicated !== undefined && dedicated !== '') {
    return { apiKey: dedicated, sharedQuota: false }
  }
  const shared = await secrets.get('deepseek-api-key')
  if (shared !== undefined && shared !== '') {
    return { apiKey: shared, sharedQuota: true }
  }
  throw new SelectionMissingError(agentClass, 'API key')
}

/** An agent class counts as chosen only when every field is there; there is no default (D21). */
function isSelected(value: Partial<Record<keyof ModelSelection, unknown>> | undefined): value is ModelSelection {
  if (value === undefined) return false
  return typeof value.provider === 'string' && value.provider.trim() !== ''
    && typeof value.model === 'string' && value.model.trim() !== ''
    && typeof value.effort === 'string' && value.effort.trim() !== ''
}

/** `packages/sdk`, found from the SDK's exported entry so the CLI and tests agree on one copy. */
function brainPackageDirectory(name: '@brain-core/sdk' | '@brain-core/chat-kit'): string {
  const resolved = import.meta.resolve(name)
  const file = resolved.startsWith('file:') ? fileURLToPath(resolved) : resolved
  return path.dirname(path.dirname(realpathSync(file)))
}

function sdkDirectory(): string {
  return brainPackageDirectory('@brain-core/sdk')
}

/** npm is a batch file on Windows and needs cmd.exe; the other tools are real executables. */
function executableOf(command: string): string {
  if (process.platform !== 'win32') return command
  if (command === 'npm' || command === 'npx') return `${command}.cmd`
  return command
}

/** Runs one lifecycle tool without a shell, so arguments are never re-parsed. */
function runCommand(command: string, args: readonly string[], options: { readonly cwd: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(executableOf(command), [...args], { cwd: options.cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error) => {
      if (error === null) resolve()
      // The tool's output may contain paths or package metadata; the error keeps only the command name.
      else reject(new BrainError('INTERNAL', `command failed: ${command}`))
    })
  })
}

function styleOf(settings: { readonly style?: { readonly enabled?: boolean; readonly openers?: readonly string[] } }): {
  readonly enabled: boolean
  readonly openers: readonly string[]
} {
  const openers = [...BUILTIN_OPENERS]
  for (const opener of settings.style?.openers ?? []) {
    if (!openers.includes(opener)) openers.push(opener)
  }
  return { enabled: settings.style?.enabled ?? true, openers }
}

async function readRegistryPlugins(
  pluginsDir: string,
): Promise<Readonly<Record<string, { readonly current?: { readonly version?: string; readonly sha8?: string } }>>> {
  let raw: string
  try {
    raw = await readFile(path.join(pluginsDir, 'registry.json'), 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const plugins = (parsed as { readonly plugins?: unknown }).plugins
    if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins)) return {}
    return plugins as Readonly<Record<string, { readonly current?: { readonly version?: string; readonly sha8?: string } }>>
  } catch {
    return {}
  }
}

async function readPluginManifest(
  pluginsDir: string,
  id: string,
  registryPlugins: Readonly<Record<string, { readonly current?: { readonly version?: string; readonly sha8?: string } }>>,
): Promise<BrainManifest | null> {
  const candidates: string[] = []
  const currentRef = registryPlugins[id]?.current
  if (typeof currentRef?.version === 'string' && typeof currentRef?.sha8 === 'string') {
    candidates.push(path.join(pluginsDir, '.installed', id, `${currentRef.version}-${currentRef.sha8}`, 'package.json'))
  }
  candidates.push(path.join(pluginsDir, id, 'current', 'package.json'))

  for (const file of candidates) {
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const result = validateManifest((parsed as { readonly brain?: unknown }).brain)
    return result.ok ? result.manifest : null
  }
  return null
}

/**
 * Adds `memory.recorded` around the record facade. memory-api's `openMemory` does not expose the
 * service's `onRecorded` seam, so the event is emitted here, before HTTP, plugins and the agent share it.
 */
function withRecordedEvent(memory: Memory, emit: <K extends keyof BrainEvents>(name: K, payload: BrainEvents[K]) => void): Memory {
  const service = memory.service
  return {
    ...memory,
    service: {
      ...service,
      async record(input, identity) {
        const record = await service.record(input, identity)
        if (record.layer === 'L1' || record.layer === 'L2') {
          try {
            emit('memory.recorded', { id: record.id, layer: record.layer, kind: record.kind, source: record.source })
          } catch {
            // A listener must not turn a stored record into a failed write.
          }
        }
        return record
      },
    },
  }
}

export async function createKernel(options: KernelOptions): Promise<Kernel> {
  const clock = options.clock ?? { now: () => Date.now() }
  const log = options.log
  const paths: BrainPaths = await prepareBrainHome({ env: options.env, userHome: options.userHome })
  const stateDir = path.join(paths.state, 'agent')

  // ---- configuration, before anything reads it ----
  const secrets = createSecretStore({ file: paths.secretsFile })
  const settings = createSettingsStore(path.join(paths.state, 'settings.json'))
  let settingsNow = await settings.read()
  const configuredOwners = settingsNow.ownerChannels
  const ownerChannels: readonly string[] = options.ownerChannels
    ?? (Array.isArray(configuredOwners) ? configuredOwners.filter((item) => typeof item === 'string') : [])
  const ownerSet: ReadonlySet<string> = new Set(ownerChannels)
  const memoryPreferences = await openMemoryPreferences(path.join(paths.memory, 'preferences.json'))
  let activityConfigured = isSelected(settingsNow.agents.activity)
  async function keyConfigured(): Promise<boolean> {
    const names = await secrets.names().catch((): readonly string[] => [])
    return names.includes('brain-deepseek-api-key') || names.includes('deepseek-api-key')
  }
  let modelKeyConfigured = await keyConfigured()

  // Everything opened from here on is closed in reverse if a later step fails (for example a busy port).
  const opened: { readonly close: () => Promise<void> }[] = []
  async function closeOpened(): Promise<void> {
    while (opened.length > 0) {
      const item = opened.pop() as { readonly close: () => Promise<void> }
      try {
        await item.close()
      } catch {
        log.error('kernel.startup_cleanup_failed')
      }
    }
  }

  async function start(): Promise<Kernel> {
    // ---- stores and the memory kernel ----
    const audit = await createOutboundAudit(path.join(stateDir, 'outbound.db'))
    opened.push({ close: () => audit.close() })
    const metrics = await createWakeMetrics(path.join(stateDir, 'metrics.db'))
    opened.push({ close: () => metrics.close() })
    const accounting = await createModelAccountingStore({
      dbPath: path.join(stateDir, 'accounting.db'),
      pricesFile: path.join(paths.state, 'model-prices.json'),
      clock,
    })
    opened.push({ close: () => accounting.close() })
    const channels = createChannelRegistry()
    const memoryProviders = createMemoryProviderRegistry({ log })

    // The extraction client needs the runner, and the runner's config needs the memory kernel; the
    // refs are filled in after the pieces exist, and every closure reads them at call time.
    const refs: {
      llm?: LlmClient & DetailedLlmClient
      agent?: AgentRuntime
      runtime?: PluginRuntime
      lifecycle?: PluginLifecycle
    } = {}

    async function recordKernelUsage(owner: 'kernel:extraction' | 'kernel:consolidation', detailed: DetailedLlmResult): Promise<void> {
      try {
        const current = await settings.read()
        await accounting.record({
          tAt: clock.now(),
          day: formatDayInTimezone(clock.now(), current.timezone),
          owner,
          agentClass: 'activity',
          provider: detailed.provider,
          model: detailed.model,
          usage: detailed.usage,
        })
      } catch {
        log.warn('kernel.accounting_record_failed', { code: 'INTERNAL' })
      }
    }

    function wrapKernelLlm(owner: 'kernel:extraction' | 'kernel:consolidation'): LlmClient {
      return {
        async complete(request) {
          const detailed = await (refs.llm as DetailedLlmClient).completeDetailed(request)
          await recordKernelUsage(owner, detailed)
          return { text: detailed.text, tokens: detailed.tokens }
        },
      }
    }

    let crossChannelMode = options.crossChannelOverride
      ? options.crossChannel
      : memoryPreferences.get().crossChannel ?? options.crossChannel
    function getCrossChannelMode(): CrossChannelMode { return crossChannelMode }
    async function setCrossChannelMode(mode: CrossChannelMode): Promise<void> {
      if (mode !== 'off' && mode !== 'shadow' && mode !== 'on') {
        throw new BrainError('INVALID_ARGUMENT', 'mode must be off, shadow or on')
      }
      await memoryPreferences.update({ crossChannel: mode })
      crossChannelMode = memoryPreferences.get().crossChannel ?? options.crossChannel
    }

    function automaticMemoryEnabled(): boolean {
      return activityConfigured && modelKeyConfigured && memoryPreferences.get().automatic !== false
    }

    const memoryBase = await openMemory({
      paths,
      clock,
      log,
      crossChannelMode: getCrossChannelMode,
      ownerChannels,
      providers: memoryProviders,
      activityConfigured: () => activityConfigured,
      extraction: {
        llm: wrapKernelLlm('kernel:extraction'),
        dailyTokenCap: 200_000,
        maxOutputTokens: 4_000,
      },
      consolidation: {
        llm: wrapKernelLlm('kernel:consolidation'),
        dailyTokenCap: 200_000,
        maxOutputTokens: 4_000,
      },
      onForgotten: async (records) => {
        const ids = records.map((record) => record.id)
        const forgottenChannels = [...new Set(records.map((record) => record.channel))]
        try {
          await refs.agent?.forgotten(forgottenChannels)
        } catch {
          log.error('kernel.forgotten_sessions_failed', { count: forgottenChannels.length })
        }
        try {
          refs.runtime?.emit('memory.forgotten', { ids })
        } catch {
          log.warn('kernel.forgotten_event_failed')
        }
      },
    })
    const memory = withRecordedEvent(memoryBase, (name, payload) => { refs.runtime?.emit(name, payload) })
    opened.push({ close: () => memoryBase.close() })

    // Extraction sends nothing and can run during quiet hours.
    const extractionTimer = createExtractionTimer({
      jobs: memory.jobs,
      clock,
      log,
      intervalMs: 10 * MINUTE_MS,
      settleMs: 10 * MINUTE_MS,
      lookbackMs: 7 * DAY_MS,
    })
    let memoryAutomationClosed = false
    opened.push({ close: async () => {
      memoryAutomationClosed = true
      extractionTimer.stop()
    } })
    function syncExtractionTimer(): void {
      if (!memoryAutomationClosed && automaticMemoryEnabled()) extractionTimer.start()
      else extractionTimer.stop()
    }
    async function refreshMemoryAutomation(): Promise<void> {
      const [current, hasKey] = await Promise.all([settings.read(), keyConfigured()])
      activityConfigured = isSelected(current.agents.activity)
      modelKeyConfigured = hasKey
      syncExtractionTimer()
    }
    function memoryAutomationStatus() {
      return { enabled: automaticMemoryEnabled(), activityConfigured, modelKeyConfigured }
    }
    async function setMemoryAutomation(enabled: boolean) {
      await refreshMemoryAutomation()
      if (enabled && !activityConfigured) throw new BrainError('UNAVAILABLE', '请先配置后台模型')
      if (enabled && !modelKeyConfigured) throw new BrainError('UNAVAILABLE', '请先配置 DeepSeek API Key')
      await memoryPreferences.update({ automatic: enabled })
      syncExtractionTimer()
      return memoryAutomationStatus()
    }

    // ---- tools, then the supervisor that runs the model ----
    const gateway = createToolGateway({
      memory: memory.service,
      audit,
      clock,
      log,
      ownerChannels: () => ownerSet,
      proactiveMessaging: ownerSet.size > 0,
      style: () => styleOf(settingsNow),
      ampAliases: () => settingsNow.interop?.ampAliases === true,
      store: memoryBase.store,
      ...(memoryBase.consolidation === undefined ? {} : { consolidation: memoryBase.consolidation }),
    })

    // A small diagnostic file: which DSH switch has which pid, for operators and for the S3 tests to
    // find a satellite without scanning the process table (which is unreliable on Windows).
    const satellitesFile = path.join(stateDir, 'satellites.json')
    const satellitePids: Partial<Record<AgentClass, number>> = {}
    const deniedApprovals: Record<AgentClass, number> = { chat: 0, activity: 0 }
    const activeSatellites: Partial<Record<AgentClass, SatelliteLike>> = {}
    let pidWrites: Promise<void> = Promise.resolve()
    function recordSatellitePid(agentClass: AgentClass, pid: number): void {
      satellitePids[agentClass] = pid
      pidWrites = pidWrites.then(async () => {
        try {
          await writeFileAtomic(satellitesFile, JSON.stringify(satellitePids))
        } catch {
          log.warn('kernel.satellite_pid_write_failed', { code: 'INTERNAL' })
        }
      })
    }

    const realFactory = createRealSatelliteFactory({
      brainHome: paths.home,
      surfaceOf: (sessionId) => gateway.surfaceOf(sessionId),
      dispatch: (call) => gateway.dispatch(call),
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    })
    const factory: SatelliteFactory = async (agentClass, config) => {
      const satellite: SatelliteLike = await realFactory(agentClass, config)
      return {
        get pid() { return satellite.pid },
        get deniedApprovals() { return satellite.deniedApprovals },
        async start() {
          await satellite.start()
          activeSatellites[agentClass] = satellite
          const pid = satellite.pid
          if (pid !== undefined) recordSatellitePid(agentClass, pid)
        },
        open: (sessionId) => satellite.open(sessionId),
        run: (sessionId, input, runOptions) => satellite.run(sessionId, input, runOptions),
        async close() {
          if (activeSatellites[agentClass] === satellite) {
            delete activeSatellites[agentClass]
          }
          await satellite.close()
        },
      }
    }
    const runner: TurnRunner = createSupervisor({
      factory,
      config: async (agentClass: AgentClass) => {
        const current = await settings.read()
        const selection = requireSelection(current.agents[agentClass], agentClass)
        const { apiKey } = await resolveApiKey(secrets, agentClass)
        const profile = await memory.profiles.current()
        return { selection, apiKey, systemPrompt: buildSystemPrompt(profile.stable), catalog: gateway.catalog() }
      },
      purge: (sessionIds) => purgeSessions(paths.home, sessionIds),
      now: () => clock.now(),
      maxConcurrentTurns: 2,
      idleCloseMs: 10 * MINUTE_MS,
      turnTimeoutMs: { chat: 3 * MINUTE_MS, activity: 10 * MINUTE_MS },
      restart: { baseMs: 1_000, maxMs: 16_000, maxFailures: 5, windowMs: 120_000 },
      onDeniedApprovals: (agentClass, count) => {
        deniedApprovals[agentClass] += count
      },
      purgeFile: path.join(stateDir, 'purge.json'),
    })
    opened.push({ close: () => runner.close() })
    const satelliteLlm = createSatelliteLlm({
      runner,
      newId: createUlid({ now: () => clock.now() }),
      selection: async () => (await settings.read()).agents.activity,
    })
    refs.llm = satelliteLlm
    const pluginLlm: PluginLlmExecutor = createPluginLlmExecutor({
      llm: satelliteLlm,
      accounting,
      settings: () => settings.read(),
      clock,
      log,
    })

    const toolModes = new Map<string, ToolUpdateMode>()
    async function toolUpdateMode(agentClass: AgentClass): Promise<ToolUpdateMode> {
      const current = await settings.read()
      let selection: ModelSelection
      try {
        selection = requireSelection(current.agents[agentClass], agentClass)
      } catch (error) {
        // The turn will report UNAVAILABLE from the supervisor; planning still needs a mode.
        if (error instanceof SelectionMissingError) return 'fixed'
        throw error
      }
      const key = `${selection.provider}/${selection.model}`
      const cached = toolModes.get(key)
      if (cached !== undefined) return cached
      let apiKey: string
      try {
        ({ apiKey } = await resolveApiKey(secrets, agentClass))
      } catch (error) {
        if (error instanceof SelectionMissingError) return 'fixed'
        throw error
      }
      const mode = await fetchToolUpdateMode(selection, apiKey, options.baseUrl)
      toolModes.set(key, mode)
      return mode
    }

    // ---- the agent, the scheduler and the plugin host ----
    const agent = createAgentRuntime({
      runner,
      gateway,
      memory: memory.service,
      profiles: memory.profiles,
      mood: () => memory.persona.mood(),
      readRecord: (id) => memory.store.get(id),
      channels,
      setMembers: (channel, people) => memory.channels.setMembers(channel, people),
      settings: async () => {
        settingsNow = await settings.read()
        return settingsNow
      },
      toolUpdateMode,
      metrics,
      emit: (name, payload) => { refs.runtime?.emit(name, payload) },
      clock,
      log,
      stateFile: path.join(stateDir, 'sessions.json'),
      onTurnUsage: async (info) => {
        const current = await settings.read()
        const selected = current.agents[info.agentClass]
        const provider = typeof selected?.provider === 'string' && selected.provider.trim() !== ''
          ? selected.provider.trim()
          : 'unknown'
        const model = typeof selected?.model === 'string' && selected.model.trim() !== ''
          ? selected.model.trim()
          : 'unknown'
        const source = info.channel.split(':')[0] ?? ''
        const knownPlugin = source !== '' && (
          channels.providerOf(info.channel) !== undefined
          || (await refs.lifecycle?.list() ?? []).some((entry) => entry.id === source)
        )
        await accounting.record({
          tAt: info.tAt,
          day: formatDayInTimezone(info.tAt, current.timezone),
          owner: `agent:${info.agentClass}`,
          ...(knownPlugin ? { pluginId: source } : {}),
          agentClass: info.agentClass,
          provider,
          model,
          usage: info.usage,
          channel: info.channel,
          wakeId: info.wakeId,
        })
      },
    })
    refs.agent = agent

    const scheduler: SchedulerService = createScheduler({
      clock,
      log,
      settings: () => settings.read(),
      stateFile: path.join(stateDir, 'scheduler.json'),
    })

    const external: ExternalDeps = {
      pluginsDir: paths.plugins,
      log,
      now: () => clock.now(),
      onFailed: (pluginId) => {
        log.error('plugin.external.failed', { plugin: pluginId })
        void refs.runtime?.disable(pluginId).catch(() => { log.error('plugin.disable_failed', { plugin: pluginId }) })
      },
      parentEnv: options.env,
    }

    async function loadEntry(plugin: InstalledPlugin): Promise<PluginApply> {
      const base = plugin.manifest.runtime === 'process'
        ? createExternalApply(plugin, external)
        : await loadNodeEntry(plugin)
      if (plugin.manifest.mcp === undefined) return base
      return async (ctx, config) => {
        await base(ctx, config)
        await attachMcp(ctx, plugin, external)
      }
    }

    const runtime = createPluginRuntime({
      memory: memory.service,
      identity: memory.identity,
      gateway,
      agent,
      scheduler,
      channels,
      audit,
      secrets,
      clock,
      log,
      pluginsDir: paths.plugins,
      participantsOf: async (channel) => {
        const provider = channels.providerOf(channel)
        if (provider === undefined) return []
        try {
          return await provider.members(channel)
        } catch {
          return []
        }
      },
      readRecord: (id) => memory.store.get(id),
      listL0: (request) => memoryBase.readL0(request),
      writeDerived: (pluginId, input) => memoryBase.writeDerived(pluginId, input),
      readChannelEvent: (recordId, sourcePluginId, viewer) => memoryBase.readChannelEvent(recordId, sourcePluginId, viewer),
      memoryProviders,
      llm: pluginLlm,
      loadEntry,
    })
    refs.runtime = runtime

    gateway.onCatalogChange(() => {
      runner.invalidate('chat')
      runner.invalidate('activity')
    })

    const lifecycle = createPluginLifecycle({
      pluginsDir: paths.plugins,
      sdkDir: sdkDirectory(),
      brainPackages: { 'chat-kit': brainPackageDirectory('@brain-core/chat-kit') },
      activator: runtime,
      storageFor: (id) => createPluginStorage(path.join(paths.plugins, id)),
      loggerFor: (id) => ({
        info: (event) => log.info(event, { plugin: id }),
        warn: (event) => log.warn(event, { plugin: id }),
        error: (event) => log.error(event, { plugin: id }),
      }),
      run: runCommand,
      coreWarnings: (manifest) => {
        const warnings: string[] = []
        // coreBudget looks at `<source>:<kind>`; the manifest names full channels with an id in the last part.
        const kindsOf = (patterns: readonly string[]): readonly string[] =>
          patterns.map((pattern) => pattern.split(':').slice(0, 2).join(':'))
        const defaultKinds = kindsOf(manifest.source?.channels ?? [])
        const kinds = new Set(defaultKinds)
        // A candidate is not registered yet, so its own core tools are only visible in the manifest.
        const declared = (manifest.tools ?? []).filter((tool) => tool.load === 'core')
        for (const tool of declared) for (const kind of kindsOf(tool.channels ?? defaultKinds)) kinds.add(kind)
        for (const kind of kinds) {
          const budget = gateway.coreBudget(kind)
          const own = declared.filter((tool) => kindsOf(tool.channels ?? defaultKinds).includes(kind))
          const ownTokens = own.reduce(
            (sum, tool) => sum + Math.ceil(Buffer.byteLength(`${tool.name}${tool.summary}${JSON.stringify(tool.keywords ?? [])}`, 'utf8') / 3),
            0,
          )
          const count = budget.count + own.length
          const tokens = budget.tokens + ownTokens
          if (count > 8 || tokens > 2_000) {
            warnings.push(`通道 ${kind} 的 core 工具过多：${count} 个、约 ${tokens} token（上限 8 个、2 000 token）`)
          }
        }
        return warnings
      },
      clock,
      log,
    })
    refs.lifecycle = lifecycle

    opened.push({
      close: async () => {
        for (const entry of await lifecycle.list()) {
          if (entry.state !== 'enabled') continue
          try { await runtime.disable(entry.id) } catch { log.error('kernel.plugin_disable_failed', { plugin: entry.id }) }
        }
      },
    })

    // ---- interop: read-only MCP & isolated debug view ----
    const debugView = createDebugViewController({
      brainHome: paths.home,
      parentEnv: options.env,
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    })
    opened.push({ close: () => debugView.stop() })

    let mcpServer: ReadOnlyMcpServer | undefined
    let interopQueue: Promise<unknown> = Promise.resolve()
    function serializeInterop<T>(work: () => Promise<T>): Promise<T> {
      const next = interopQueue.then(work, work)
      interopQueue = next.then(() => undefined, () => undefined)
      return next
    }

    function currentMcpStatus(): ReadOnlyMcpStatus {
      if (mcpServer !== undefined) return mcpServer.status()
      return {
        enabled: settingsNow.interop?.readOnlyMcp?.enabled === true,
        running: false,
      }
    }

    async function startMcp(): Promise<ReadOnlyMcpStatus> {
      if (mcpServer !== undefined && mcpServer.status().running) {
        return mcpServer.status()
      }
      const mcpToken = randomBytes(32).toString('base64url')
      const portOption = settingsNow.interop?.readOnlyMcp?.port
      const serverInstance = createReadOnlyMcpServer({
        memory: memory.service,
        profiles: memory.profiles,
        store: memoryBase.store,
        token: mcpToken,
        ...(portOption === undefined ? {} : { port: portOption }),
        ampAliases: settingsNow.interop?.ampAliases === true,
        log,
      })
      try {
        await serverInstance.listen()
      } catch (error) {
        await serverInstance.close().catch(() => undefined)
        throw error
      }
      mcpServer = serverInstance
      return serverInstance.status()
    }

    async function stopMcp(): Promise<void> {
      const current = mcpServer
      mcpServer = undefined
      if (current !== undefined) {
        await current.close()
      }
    }

    opened.push({ close: () => stopMcp() })
    if (settingsNow.interop?.readOnlyMcp?.enabled === true) {
      await startMcp()
    }

    async function interopSnapshot(): Promise<InteropStatus> {
      settingsNow = await settings.read()
      return {
        ampAliases: settingsNow.interop?.ampAliases === true,
        mcp: currentMcpStatus(),
        debugView: debugView.status(),
      }
    }

    const interopHandle: KernelInterop = {
      mcp: {
        status: currentMcpStatus,
        start: () => serializeInterop(startMcp),
        stop: () => serializeInterop(stopMcp),
      },
      debugView,
      snapshot: () => serializeInterop(interopSnapshot),
    }

    const dshHome = resolveDshHome(undefined, options.env, options.userHome)
    let lastIsolation: ConsoleIsolationDoctorStatus | undefined
    async function runIsolationDoctor(): Promise<ConsoleIsolationDoctorStatus> {
      const result = await runDoctor({ mode: 'check', dshHome })
      const checkedAt = clock.now()
      const status: ConsoleIsolationDoctorStatus = result.kind === 'check'
        ? { ok: result.ok, checkedAt, problems: result.problems }
        : { ok: true, checkedAt, problems: [] }
      lastIsolation = status
      return status
    }

    const server = createMemoryApiServer(memory, {
      token: options.token,
      port: options.port,
      log,
      pluginRoute: (pluginId, request) => runtime.route(pluginId, request),
      console: {
        accounting: {
          async summary(days) {
            const current = await settings.read()
            const dedicatedKey = await secrets.get('brain-deepseek-api-key')
            const sharedQuotaWarning = dedicatedKey === undefined || dedicatedKey === ''
            const day = formatDayInTimezone(clock.now(), current.timezone)
            return accounting.summary({
              day,
              ...(days === undefined ? {} : { days }),
              sharedQuotaWarning,
              ...(current.accounting?.dailyTokenLimit === undefined
                ? {}
                : { dailyTokenLimit: current.accounting.dailyTokenLimit }),
              ...(current.accounting?.dailyCostMicrosLimit === undefined
                ? {}
                : { dailyCostMicrosLimit: current.accounting.dailyCostMicrosLimit }),
            })
          },
          prices: () => accounting.prices(),
          setPrices: (next) => accounting.setPrices(next),
          setBudget: (budget) => serializeInterop(async () => {
            const current = await settings.read()
            const next: RuntimeSettings = { ...current, accounting: budget }
            await settings.write(next)
            settingsNow = next
            return budget
          }),
        },
        interop: {
          snapshot: () => serializeInterop(interopSnapshot),
          setAmpAliases: (enabled) => serializeInterop(async () => {
            const current = await settings.read()
            const next: RuntimeSettings = {
              ...current,
              interop: { ...current.interop, ampAliases: enabled },
            }
            await settings.write(next)
            settingsNow = next
            gateway.refreshBuiltins()
            return interopSnapshot()
          }),
          setReadOnlyMcp: (enabled) => serializeInterop(async () => {
            const current = await settings.read()
            const next: RuntimeSettings = {
              ...current,
              interop: {
                ...current.interop,
                readOnlyMcp: { ...current.interop?.readOnlyMcp, enabled },
              },
            }
            await settings.write(next)
            settingsNow = next
            if (enabled) await startMcp()
            else await stopMcp()
            return interopSnapshot()
          }),
          startDebugView: () => serializeInterop(async () => {
            await debugView.start()
            return interopSnapshot()
          }),
          stopDebugView: () => serializeInterop(async () => {
            await debugView.stop()
            return interopSnapshot()
          }),
        },
        plugins: {
          async list() {
            const entries = await lifecycle.list()
            const registryPlugins = await readRegistryPlugins(paths.plugins)
            const plugins: ConsolePluginItem[] = []
            const patterns = new Set<string>()
            for (const entry of entries) {
              const manifest = await readPluginManifest(paths.plugins, entry.id, registryPlugins)
              plugins.push({
                id: entry.id,
                version: entry.version,
                kinds: manifest !== null ? [...manifest.kinds] : [],
                runtime: manifest !== null ? manifest.runtime : 'node',
                state: entry.state,
                permissions: [...entry.permissions],
                granted: [...entry.granted],
                checkPassed: manifest !== null,
                tools: manifest !== null ? [...(manifest.tools ?? [])] : [],
              })
              if (entry.state === 'enabled' && manifest !== null) {
                const defaultKinds = (manifest.source?.channels ?? [])
                  .map((pattern) => pattern.split(':').slice(0, 2).join(':'))
                  .filter((pattern) => pattern !== '')
                for (const kind of defaultKinds) patterns.add(kind)
                for (const tool of manifest.tools ?? []) {
                  if (tool.load !== 'core') continue
                  if (tool.channels !== undefined) {
                    for (const channel of tool.channels) {
                      const prefix = channel.split(':').slice(0, 2).join(':')
                      if (prefix !== '') patterns.add(prefix)
                    }
                  } else if (defaultKinds.length === 0) {
                    patterns.add('*:*')
                  }
                }
              }
            }
            const coreBudgets: ChannelCoreBudget[] = [...patterns]
              .sort()
              .map((pattern) => ({ pattern, ...gateway.coreBudget(pattern) }))
            return { plugins, coreBudgets }
          },
          install: (spec) => lifecycle.install(spec),
          confirm: (id) => lifecycle.confirm(id),
          enable: (id) => lifecycle.enable(id),
          disable: (id) => lifecycle.disable(id),
          async upgrade(id, spec) {
            const preview = await lifecycle.upgrade(id, spec)
            return { ...preview, applied: preview.newPermissions.length === 0 }
          },
          uninstall: (id, uninstallOptions) => lifecycle.uninstall(id, uninstallOptions),
          check: (dir) => checkPlugin(dir),
        },
        memoryConsole: {
          crossChannel: {
            getMode: getCrossChannelMode,
            setMode: setCrossChannelMode,
          },
          automation: { get: memoryAutomationStatus, set: setMemoryAutomation },
          audit: (recordId) => memory.audit.list(recordId),
          persons: {
            list: () => memory.identity.listPersons(),
            merge: (from, into) => memory.identity.merge(from, into),
            split: (personId, accounts) => memory.identity.split(personId, accounts),
          },
        },
        satellite: {
          async snapshot() {
            const currentSettings = await settings.read()
            const storedSessions = await readSessions(path.join(stateDir, 'sessions.json'))
            const sessions: ConsoleSessionSurfaceInfo[] = [...storedSessions.entries()]
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([channel, entry]) => {
                const kind = channel.split(':')[1]
                const agentClass: AgentClass = kind === 'private' || kind === 'group' ? 'chat' : 'activity'
                const sessionId = encodeSessionId({ agentClass, channel, generation: entry.generation })
                return {
                  sessionId,
                  channel,
                  agentClass,
                  toolCount: gateway.surfaceOf(sessionId).size,
                }
              })
            const processStatus = (agentClass: AgentClass): ConsoleAgentProcessStatus => {
              const status = runner.status(agentClass)
              const pid = status === 'running' ? (activeSatellites[agentClass]?.pid ?? satellitePids[agentClass]) : undefined
              const rawSelection = currentSettings.agents[agentClass]
              const selection: ModelSelection | null = isSelected(rawSelection)
                ? {
                    provider: rawSelection.provider as string,
                    model: rawSelection.model as string,
                    effort: rawSelection.effort as ModelSelection['effort'],
                  }
                : null
              const activeSessions = sessions.filter((session) => session.agentClass === agentClass).length
              return {
                agentClass,
                status,
                ...(pid === undefined ? {} : { pid }),
                activeSessions,
                selection,
                deniedApprovals: deniedApprovals[agentClass],
              }
            }
            const isolation = lastIsolation ?? await runIsolationDoctor()
            const metricList = await metrics.list()
            const dedicatedKey = await secrets.get('brain-deepseek-api-key')
            const sharedQuotaWarning = dedicatedKey === undefined || dedicatedKey === ''
            return {
              processes: {
                chat: processStatus('chat'),
                activity: processStatus('activity'),
              },
              sessions,
              isolation,
              metrics: metricList,
              sharedQuotaWarning,
            }
          },
          restart: (agentClass) => {
            runner.invalidate(agentClass)
          },
          runDoctor: runIsolationDoctor,
        },
        pages: {
          list: () => runtime.pages(),
        },
      },
    })
    opened.push({ close: () => server.close() })
    const { port } = await server.listen()

    scheduler.start()
    opened.push({ close: async () => { scheduler.stop() } })

    // One broken plugin must not keep the kernel from running (A5, NFR-04).
    for (const entry of await lifecycle.list()) {
      if (entry.state !== 'enabled') continue
      try {
        await lifecycle.enable(entry.id)
      } catch {
        log.error('kernel.plugin_enable_failed', { plugin: entry.id })
      }
    }

    if (ownerSet.size > 0) {
      const stop = scheduler.every('kernel', 60_000, createProactivePromises({
        memory,
        agent,
        providers: channels,
        ownerChannels: ownerSet,
        settings: () => settings.read(),
        crossChannelMode: getCrossChannelMode,
        clock,
        log,
        stateFile: path.join(stateDir, 'proactive-promises.json'),
      }))
      opened.push({ close: async () => { stop() } })
      const stopOwnLife = scheduler.every('kernel:own-life', 60_000, createProactiveOwnLife({
        memory,
        agent,
        providers: channels,
        ownerChannels: ownerSet,
        settings: () => settings.read(),
        crossChannelMode: getCrossChannelMode,
        clock,
        log,
        stateFile: path.join(stateDir, 'own-life.json'),
      }))
      opened.push({ close: async () => { stopOwnLife() } })
    }

    syncExtractionTimer()

    const consolidationTimer: ConsolidationTimer = createConsolidationTimer({
      memory,
      clock,
      log,
      settings: () => settings.read(),
      shouldConsolidate: automaticMemoryEnabled,
      intervalMs: DEFAULT_CONSOLIDATION_INTERVAL_MS,
    })
    consolidationTimer.start()
    opened.push({ close: async () => { consolidationTimer.stop() } })

    let closing: Promise<void> | undefined
    async function close(): Promise<void> {
      closing ??= (async () => {
        consolidationTimer.stop()
        memoryAutomationClosed = true
        extractionTimer.stop()
        scheduler.stop()
        try {
          for (const entry of await lifecycle.list()) {
            if (entry.state !== 'enabled') continue
            try {
              // Deactivate only: the registry keeps saying enabled, so the next start brings the plugin back.
              await runtime.disable(entry.id)
            } catch {
              log.error('kernel.plugin_disable_failed', { plugin: entry.id })
            }
          }
        } catch {
          log.error('kernel.plugins_close_failed')
        }
        try { await debugView.stop() } catch { log.error('kernel.debug_view_close_failed') }
        try { await stopMcp() } catch { log.error('kernel.mcp_close_failed') }
        try { await runner.close() } catch { log.error('kernel.runner_close_failed') }
        try { await server.close() } catch { log.error('kernel.http_close_failed') }
        try { await memory.close() } catch { log.error('kernel.memory_close_failed') }
        try { await accounting.close() } catch { log.error('kernel.accounting_close_failed') }
        try { await audit.close() } catch { log.error('kernel.audit_close_failed') }
        try { await metrics.close() } catch { log.error('kernel.metrics_close_failed') }
        await pidWrites.catch(() => undefined)
      })()
      await closing
    }

    return {
      port,
      memory,
      plugins: lifecycle,
      runtime,
      agent,
      gateway,
      runner,
      settings,
      secrets,
      accounting,
      providers: memoryProviders,
      interop: interopHandle,
      paths,
      metrics,
      getCrossChannelMode,
      setCrossChannelMode,
      refreshMemoryAutomation,
      close,
    }
  }

  try {
    return await start()
  } catch (error) {
    await closeOpened()
    throw error
  }
}

// The CLI uses the same wiring and the same opener list.
export { BUILTIN_OPENERS, brainPackageDirectory, runCommand, sdkDirectory }
