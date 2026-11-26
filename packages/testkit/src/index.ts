export type {
  LoadOptions, FakeWake, FakeAgentHelpers, FakeAgentScript, TestKernel,
} from './kernel.ts'
export { createTestKernel } from './kernel.ts'

export type { FakeChannel } from './channel.ts'
export { createFakeChannel } from './channel.ts'

export { FakeDeepSeek, scriptedTools, type CapturedRequest, type FakeReply, type FakeScript } from './fake-deepseek.ts'

export type { ContractResult } from './contract.ts'
export { runPluginContractTests } from './contract.ts'

export type { ConsistencyTarget } from './consistency.ts'
export { runConsistencyCases } from './consistency.ts'

export type { CheckFinding, CheckReport } from './check/types.ts'
export { checkPlugin, runCheckCli } from './check/index.ts'
