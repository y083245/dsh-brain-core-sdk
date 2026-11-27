export { openMemory, type ConsolidationOptions, type Memory, type MemoryOptions } from './open.ts'
export { createMemoryService, type MemoryServiceImplementation } from './service.ts'
export { createChannelFacts, channelKind, type ChannelFactsSource } from './channel-facts.ts'
export { createAuditLog, type AuditEntry, type AuditLog } from './audit.ts'
export { createJobRunner, type Extractor, type Job, type JobRequest, type JobRunner } from './jobs.ts'
export {
  createMemoryApiServer,
  type ChannelCoreBudget,
  type ConsoleAgentProcessStatus,
  type ConsoleInstallPreview,
  type ConsoleIsolationDoctorStatus,
  type ConsoleLocalApplyResult,
  type ConsolePageItem,
  type ConsolePersonSummary,
  type ConsolePluginItem,
  type ConsolePluginUpdateInfo,
  type ConsoleSatelliteSnapshot,
  type ConsoleSessionSurfaceInfo,
  type ConsoleWakeMetricSample,
  type InteropStatus,
  type MemoryApiConsoleDeps,
  type MemoryApiServer,
  type PluginLifecycleState,
} from './server.ts'
