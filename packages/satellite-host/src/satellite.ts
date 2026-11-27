/** Owns one DSH child for one agent class. The only kernel-side code that touches @deepseek-ai/*. */
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { DeepSeekHarness, type HarnessNotification, type HarnessSession, type RunResult, type SdkPromptContentBlock } from '@deepseek-ai/dsh-sdk-client'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { BridgeServer } from './bridge-server.ts'
import { buildSatelliteEnv } from './env.ts'
import { isPathInside } from './platform.ts'
import type { AgentClass, ModelSelection } from './selection.ts'

export interface SatelliteOptions {
  readonly brainHome: string
  readonly agentClass: AgentClass
  /** Required with no fallback: the sdk-client would otherwise pick a model on its own. */
  readonly selection: ModelSelection
  readonly apiKey: string
  readonly systemPrompt: string
  readonly bridge: BridgeServer
  readonly parentEnv?: NodeJS.ProcessEnv
  /** Replaces the hardening patch; only the negative test passes this. */
  readonly patches?: readonly string[]
  readonly maxOldSpaceMb?: number
  readonly proxy?: { readonly http?: string; readonly https?: string; readonly no?: string }
  /** Fake gateway address for tests. */
  readonly baseUrl?: string
}

export class TurnTimeoutError extends Error {
  constructor(sessionId: string, timeoutMs: number) {
    super(`turn on ${sessionId} exceeded ${timeoutMs} ms; satellite closed`)
    this.name = 'TurnTimeoutError'
  }
}

const require = createRequire(import.meta.url)

export function hardeningPatchPath(): string {
  return require.resolve('@dsh-brain-core/satellite-bundle/patches/hardening.yml')
}

/** Refuses a BRAIN_HOME inside the owner's DSH home, where it could leak into their sessions. */
export function assertOutsideDshHome(brainHome: string, parentEnv: NodeJS.ProcessEnv, userHome: string): void {
  const dshHomes = [path.join(userHome, '.dsh'), ...(parentEnv.DSH_HOME === undefined ? [] : [parentEnv.DSH_HOME])]
  for (const dshHome of dshHomes) {
    if (isPathInside(brainHome, dshHome)) throw new Error(`BRAIN_HOME must not be inside a DSH home (${dshHome})`)
  }
}

export class Satellite {
  readonly #options: SatelliteOptions
  readonly #sessions = new Map<string, HarnessSession>()
  #harness: DeepSeekHarness | undefined
  /** How many approval requests were refused; there should be none with no local tools. */
  deniedApprovals = 0

  constructor(options: SatelliteOptions) {
    this.#options = options
  }

  get pid(): number | undefined {
    return this.#options.bridge.childPid
  }

  async start(): Promise<void> {
    const { brainHome, agentClass, selection, bridge } = this.#options
    const parentEnv = this.#options.parentEnv ?? process.env
    assertOutsideDshHome(brainHome, parentEnv, os.homedir())
    const root = path.join(brainHome, 'state', 'satellite')
    const dshHome = path.join(root, 'dsh-home')
    const osHome = path.join(root, 'os-home')
    const tmpDir = path.join(root, 'tmp')
    const workspace = path.join(root, 'workspace', agentClass)
    for (const dir of [dshHome, osHome, tmpDir, workspace]) await mkdir(dir, { recursive: true })

    const env = buildSatelliteEnv({
      parent: parentEnv,
      platform: process.platform,
      osHome,
      tmpDir,
      apiKey: this.#options.apiKey,
      systemPrompt: this.#options.systemPrompt,
      bridgeUrl: bridge.url,
      bridgeToken: bridge.token,
      maxOldSpaceMb: this.#options.maxOldSpaceMb ?? 1024,
      ...(this.#options.proxy === undefined ? {} : { proxy: this.#options.proxy }),
      ...(this.#options.baseUrl === undefined ? {} : { baseUrl: this.#options.baseUrl }),
    })
    const harness = new DeepSeekHarness({
      profile: 'sdk-minimal',
      dshHome,
      env,
      patches: [...(this.#options.patches ?? [hardeningPatchPath()])],
      cwd: workspace,
      processCwd: workspace,
      provider: selection.provider,
      model: selection.model,
      ...(selection.effort === 'model-default' ? {} : { reasoningEffort: ReasoningEffortId(selection.effort) }),
      approvalRequests: true,
      initializeTimeoutMs: 60_000,
    })
    harness.client.start()
    harness.client.onRequest(async method => {
      if (method !== 'approval/request') throw new Error(`Unsupported request: ${method}`)
      this.deniedApprovals += 1
      return { outcome: 'rejected' }
    })
    this.#harness = harness
    await harness.start()
  }

  async resume(sessionId: string): Promise<void> {
    this.#sessions.set(sessionId, await this.#require().resumeSession(sessionId))
  }

  async run(
    sessionId: string,
    input: string | SdkPromptContentBlock[],
    options: { readonly timeoutMs?: number; readonly onNotification?: (notification: HarnessNotification) => void } = {},
  ): Promise<RunResult> {
    let session = this.#sessions.get(sessionId)
    if (session === undefined) {
      session = this.#require().session(sessionId)
      this.#sessions.set(sessionId, session)
    }
    const running = session.run(input, options.onNotification === undefined ? {} : { onNotification: options.onNotification })
    if (options.timeoutMs === undefined) return running
    // The protocol has no cancel request: the only way out of a stuck turn is to close the child.
    let timer: NodeJS.Timeout | undefined
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new TurnTimeoutError(sessionId, options.timeoutMs as number)), options.timeoutMs)
    })
    try {
      return await Promise.race([running, timedOut])
    } catch (error) {
      if (error instanceof TurnTimeoutError) {
        running.catch(() => {})
        await this.close()
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  async close(): Promise<void> {
    await this.#harness?.close()
    this.#harness = undefined
    this.#sessions.clear()
  }

  #require(): DeepSeekHarness {
    if (this.#harness === undefined) throw new Error('satellite is not running')
    return this.#harness
  }
}
