/** The real SatelliteLike: one DSH child behind a fresh BridgeServer, with results and errors in the supervisor's terms. */
import os from 'node:os'
import { TransportClosedError, type RunResult, type SdkPromptContentBlock } from '@deepseek-ai/dsh-sdk-client'
import { BridgeServer, type SurfaceCheck, type ToolHandler } from './bridge-server.ts'
import { Satellite, TurnTimeoutError, type SatelliteOptions } from './satellite.ts'
import { TurnInterruptedError, type SatelliteFactory, type SatelliteLike, type StepUsage, type TurnInput, type TurnResult } from './turn.ts'

/** What the wrapper needs from Satellite; a test passes a fake. */
export interface SatelliteHandle {
  readonly deniedApprovals: number
  start(): Promise<void>
  resume(sessionId: string): Promise<void>
  run(sessionId: string, input: string | SdkPromptContentBlock[], options?: { readonly timeoutMs?: number }): Promise<RunResult>
  close(): Promise<void>
}

/** What the wrapper needs from BridgeServer; a test passes a fake. */
export interface BridgeHandle {
  readonly childPid: number | undefined
  readonly surfaceCheck: SurfaceCheck | undefined
  close(): Promise<void>
}

/** Satellites run below the kernel's own priority so a busy turn cannot starve it. */
const CHILD_PRIORITY = 10

function toDshInput(input: TurnInput): string | SdkPromptContentBlock[] {
  if (typeof input === 'string') return input
  return input.map((block): SdkPromptContentBlock => block.type === 'text'
    ? { type: 'text', text: block.text }
    : { type: 'image', data: block.base64, mimeType: block.mediaType as 'image/png' })
}

function toTurnResult(result: RunResult): TurnResult {
  const steps: StepUsage[] = []
  let retries = 0
  let compacted = false
  for (const event of result.events as readonly { type?: string; data?: { usage?: Partial<StepUsage> } }[]) {
    if (event.type === 'assistant/message' && event.data?.usage !== undefined) {
      const { inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0 } = event.data.usage
      steps.push({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens })
    }
    if (event.type === 'llm/retry') retries += 1
    if (event.type === 'compaction/end') compacted = true
  }
  return { finalResponse: result.finalResponse, steps, retries, compacted }
}

function isTransportError(error: unknown): boolean {
  return error instanceof TransportClosedError || (error instanceof Error && error.name.includes('Transport'))
}

export function wrapSatellite(
  satellite: SatelliteHandle,
  bridge: BridgeHandle,
  options: { readonly setPriority?: (pid: number, priority: number) => void } = {},
): SatelliteLike {
  const setPriority = options.setPriority ?? os.setPriority
  let closing: Promise<void> | undefined

  const close = (): Promise<void> => {
    closing ??= (async () => {
      try {
        await satellite.close()
      } finally {
        await bridge.close()
      }
    })()
    return closing
  }

  return {
    get pid() {
      return bridge.childPid
    },
    get deniedApprovals() {
      return satellite.deniedApprovals
    },
    async start() {
      await satellite.start()
      if (bridge.childPid === undefined) return
      try {
        setPriority(bridge.childPid, CHILD_PRIORITY)
      } catch {
        // Lowering the priority is a courtesy; some platforms or sandboxes refuse it.
      }
    },
    async open(sessionId) {
      try {
        await satellite.resume(sessionId)
        return 'resumed'
      } catch (error) {
        if (error instanceof Error && error.message.includes('not found')) return 'new'
        // The child can die while a turn is still opening its session; that is a crash like any other.
        if (isTransportError(error)) throw new TurnInterruptedError('crash', (error as Error).message)
        throw error
      }
    },
    async run(sessionId, input, runOptions) {
      if (bridge.surfaceCheck?.ok === false) {
        await close()
        throw new TurnInterruptedError('crash', 'tool surface differs from the catalog')
      }
      try {
        return toTurnResult(await satellite.run(sessionId, toDshInput(input), runOptions))
      } catch (error) {
        if (error instanceof TurnTimeoutError) throw new TurnInterruptedError('timeout', error.message)
        if (isTransportError(error)) throw new TurnInterruptedError('crash', (error as Error).message)
        throw error
      }
    },
    close,
  }
}

export function createRealSatelliteFactory(deps: {
  readonly brainHome: string
  readonly surfaceOf: (sessionId: string) => ReadonlySet<string>
  readonly dispatch: ToolHandler
  readonly parentEnv?: NodeJS.ProcessEnv
  readonly baseUrl?: string
  readonly maxOldSpaceMb?: number
  readonly proxy?: SatelliteOptions['proxy']
}): SatelliteFactory {
  return async (agentClass, config) => {
    const bridge = new BridgeServer({ catalog: config.catalog, handler: deps.dispatch, surfaceOf: deps.surfaceOf })
    await bridge.listen()
    try {
      const satellite = new Satellite({
        brainHome: deps.brainHome,
        agentClass,
        selection: config.selection,
        apiKey: config.apiKey,
        systemPrompt: config.systemPrompt,
        bridge,
        ...(deps.parentEnv === undefined ? {} : { parentEnv: deps.parentEnv }),
        ...(deps.baseUrl === undefined ? {} : { baseUrl: deps.baseUrl }),
        ...(deps.maxOldSpaceMb === undefined ? {} : { maxOldSpaceMb: deps.maxOldSpaceMb }),
        ...(deps.proxy === undefined ? {} : { proxy: deps.proxy }),
      })
      return wrapSatellite(satellite, bridge)
    } catch (error) {
      await bridge.close()
      throw error
    }
  }
}
