import { BrainError, validateManifest, type BrainContext, type PluginApply, type ToolDefinition } from '@dsh-brain-core/sdk'
import { createTestKernel, type LoadOptions, type TestKernel } from './kernel.ts'

export interface ContractResult { readonly name: string; readonly ok: boolean; readonly message: string }

const APPLY_TIMEOUT_MS = 10_000

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000} seconds`)), ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

function failureOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function codeOf(error: unknown): string | undefined {
  return error instanceof BrainError ? error.code : undefined
}

/** Registered tool names must all be declared. Exported so the kit's own tests can prove the check can fail. */
export function evaluateNoExtraTools(expected: readonly string[], actual: readonly string[]): ContractResult {
  const extras = actual.filter((name) => !expected.includes(name))
  return {
    name: 'no-extra-tools',
    ok: extras.length === 0,
    message: extras.length === 0 ? 'no tool outside the manifest' : `not in the manifest: ${extras.join(', ')}`,
  }
}

/** The same check the contract runner runs after unload; exported so the kit's own tests can prove it can fail. */
export function evaluateUnloadClean(kernel: Pick<TestKernel, 'tools' | 'routes' | 'timers'>): ContractResult {
  const tools = kernel.tools().length
  const routes = kernel.routes().length
  const timers = kernel.timers()
  const ok = tools === 0 && routes === 0 && timers === 0
  return {
    name: 'unload-clean',
    ok,
    message: ok
      ? 'unload removed every registration'
      : `after unload: ${tools} tool(s), ${routes} route(s), ${timers} timer(s) remain`,
  }
}

/** Registration methods must be refused once the plugin is unloaded. */
export async function evaluateLateRegister(ctx: BrainContext): Promise<ContractResult> {
  const probe: ToolDefinition = {
    name: 'late',
    description: 'a registration after unload',
    parameters: { type: 'object' },
    handler: async () => 'late',
  }
  const attempts: readonly { readonly label: string; readonly run: () => unknown }[] = [
    { label: 'tools.register', run: () => ctx.tools.register(probe) },
    { label: 'http.route', run: () => ctx.http.route('GET', '/late', async () => null) },
    { label: 'scheduler.every', run: () => ctx.scheduler.every(60_000, () => undefined) },
    { label: 'events.on', run: () => ctx.events.on('late', () => undefined) },
    { label: 'channel.provide', run: () => ctx.channel.provide({ send: async () => ({}), members: async () => [], resolveIdentity: async () => null }) },
  ]
  const accepted: string[] = []
  for (const attempt of attempts) {
    try {
      await attempt.run()
      accepted.push(attempt.label)
    } catch (error) {
      if (codeOf(error) !== 'PERMISSION_DENIED') accepted.push(`${attempt.label} (${codeOf(error) ?? failureOf(error)})`)
    }
  }
  const ok = accepted.length === 0
  return {
    name: 'no-late-register',
    ok,
    message: ok ? 'every registration after unload was refused' : `accepted after unload: ${accepted.join(', ')}`,
  }
}

/**
 * The checks `brain plugin check` and a plugin's own test suite share. No test framework is involved:
 * the caller gets one result per line and decides how to report it.
 */
export async function runPluginContractTests(
  plugin: { readonly apply: PluginApply },
  manifestJson: unknown,
  options?: LoadOptions,
): Promise<readonly ContractResult[]> {
  const results: ContractResult[] = []
  const validation = validateManifest(manifestJson)
  results.push({
    name: 'manifest',
    ok: validation.ok,
    message: validation.ok
      ? 'the manifest is valid'
      : validation.errors.map((error) => `${error.field}: ${error.message}`).join('; '),
  })
  if (!validation.ok) {
    for (const name of ['apply', 'tools-registered', 'no-extra-tools', 'no-internal-writes', 'unload-clean', 'no-late-register']) {
      results.push({ name, ok: false, message: 'skipped: the manifest is invalid' })
    }
    return results
  }

  const manifest = validation.manifest
  const kernel = createTestKernel()
  let captured: BrainContext | undefined
  const capturing = {
    apply: async (ctx: BrainContext, config: Readonly<Record<string, unknown>>): Promise<void> => {
      captured = ctx
      return plugin.apply(ctx, config)
    },
  }

  let applyOk = true
  let applyMessage = 'apply finished without throwing'
  try {
    await withTimeout(kernel.loadPlugin(capturing, manifestJson, options), APPLY_TIMEOUT_MS)
  } catch (error) {
    applyOk = false
    applyMessage = `apply failed: ${failureOf(error)}`
  }
  results.push({ name: 'apply', ok: applyOk, message: applyMessage })

  const expected = (manifest.tools ?? []).map((tool) => `${manifest.id}__${tool.name}`)
  const actual = [...kernel.tools()]

  if (manifest.mcp !== undefined) {
    results.push({ name: 'tools-registered', ok: true, message: 'skipped: an mcp plugin registers its tools through the server' })
  } else {
    const missing = expected.filter((name) => !actual.includes(name))
    results.push({
      name: 'tools-registered',
      ok: missing.length === 0,
      message: missing.length === 0 ? 'every declared tool is registered' : `not registered: ${missing.join(', ')}`,
    })
  }

  results.push(evaluateNoExtraTools(expected, actual))

  const internalWrites = kernel.calls.filter((call) => {
    if (call.method !== 'memory.record') return false
    const input = call.args[0]
    return typeof input === 'object' && input !== null && (input as { readonly layer?: unknown }).layer === 'L3'
  })
  results.push({
    name: 'no-internal-writes',
    ok: internalWrites.length === 0,
    message: internalWrites.length === 0 ? 'no L3 write was attempted' : `attempted ${internalWrites.length} L3 write(s)`,
  })

  try {
    await kernel.unload()
    results.push(evaluateUnloadClean(kernel))
  } catch (error) {
    results.push({ name: 'unload-clean', ok: false, message: `unload failed: ${failureOf(error)}` })
  }

  if (captured === undefined) {
    results.push({ name: 'no-late-register', ok: false, message: 'apply never received a context' })
  } else {
    results.push(await evaluateLateRegister(captured))
  }

  return results
}
