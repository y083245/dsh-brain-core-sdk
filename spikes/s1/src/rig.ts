/** Builds one isolated satellite against the fake gateway, and tears it all down afterwards. */
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { BridgeServer, removeTree, Satellite, type BridgeTool, type ModelSelection, type SatelliteOptions, type ToolHandler } from '@dsh-brain-core/satellite-host'
import { FakeDeepSeek, type FakeScript } from './fake-deepseek.ts'

export const FLASH_LOW: ModelSelection = { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'low' }

export const DEMO_TOOLS: readonly BridgeTool[] = ['a', 'b', 'c'].map(letter => ({
  name: `demo__${letter}`,
  description: `Demo tool ${letter}.`,
  parameters: { text: { type: 'string' }, channel: { type: 'string' } },
}))

export interface Rig {
  readonly brainHome: string
  readonly gateway: FakeDeepSeek
  readonly bridge: BridgeServer
  readonly satellite: Satellite
  /** Starts another satellite on the same home with a fresh bridge and token. */
  restart(overrides?: Partial<SatelliteOptions>): Promise<{ bridge: BridgeServer; satellite: Satellite }>
}

export interface RigOptions {
  readonly script: FakeScript
  readonly catalog?: readonly BridgeTool[]
  readonly handler?: ToolHandler
  readonly satellite?: Partial<SatelliteOptions>
  readonly autoStart?: boolean
}

export async function withRig<T>(options: RigOptions, body: (rig: Rig) => Promise<T>): Promise<T> {
  const brainHome = await mkdtemp(path.join(os.tmpdir(), 'brain-s1-'))
  const gateway = new FakeDeepSeek(options.script)
  await gateway.listen()
  const handler: ToolHandler = options.handler ?? (async ({ toolName }) => `ran ${toolName}`)
  const catalog = options.catalog ?? DEMO_TOOLS
  const closers: (() => Promise<void>)[] = []
  const launch = async (overrides: Partial<SatelliteOptions> = {}) => {
    const bridge = new BridgeServer({ catalog, handler })
    await bridge.listen()
    const satellite = new Satellite({
      brainHome,
      agentClass: 'chat',
      selection: FLASH_LOW,
      apiKey: 'fake-key',
      systemPrompt: 'You are a test persona.',
      bridge,
      baseUrl: gateway.url,
      ...options.satellite,
      ...overrides,
    })
    closers.push(async () => {
      await satellite.close().catch(() => {})
      await bridge.close()
    })
    return { bridge, satellite }
  }
  try {
    const { bridge, satellite } = await launch()
    if (options.autoStart !== false) await satellite.start()
    return await body({
      brainHome,
      gateway,
      bridge,
      satellite,
      restart: async overrides => {
        const next = await launch(overrides)
        await next.satellite.start()
        return next
      },
    })
  } finally {
    for (const close of closers.reverse()) await close()
    await gateway.close()
    await removeTree(brainHome)
  }
}
