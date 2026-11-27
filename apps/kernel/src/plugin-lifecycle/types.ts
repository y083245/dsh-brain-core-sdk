import type { BrainLogger, BrainManifest, PluginStorage } from '@dsh-brain-core/sdk'
import type { Clock, PluginActivator } from '../contracts/index.ts'
import type { Logger } from '../log/index.ts'

export type PluginState = 'pending' | 'enabled' | 'disabled' | 'failed'

export interface PluginEntry {
  readonly id: string
  readonly version: string
  readonly state: PluginState
  readonly permissions: readonly string[]
  readonly granted: readonly string[]
}

export interface InstallPreview {
  readonly id: string
  readonly version: string
  readonly permissions: readonly string[]
  readonly newPermissions: readonly string[]
  readonly warnings: readonly string[]
}

export interface PluginLifecycle {
  /** Unpacks and validates. Nothing is enabled until confirm. */
  install(spec: string): Promise<InstallPreview>
  confirm(id: string): Promise<void>
  enable(id: string): Promise<void>
  disable(id: string): Promise<void>
  upgrade(id: string, spec: string): Promise<InstallPreview>
  uninstall(id: string, options: { readonly keepData: boolean }): Promise<void>
  setConfig(id: string, value: unknown): Promise<void>
  list(): Promise<readonly PluginEntry[]>
}

export type RunCommand = (command: string, args: readonly string[], options: { readonly cwd: string }) => Promise<void>

export interface PluginLifecycleDeps {
  readonly pluginsDir: string
  readonly sdkDir: string
  readonly brainPackages?: Readonly<Record<string, string>>
  readonly activator: PluginActivator
  readonly storageFor: (id: string) => PluginStorage
  readonly loggerFor: (id: string) => BrainLogger
  readonly run: RunCommand
  readonly coreWarnings: (manifest: BrainManifest) => readonly string[]
  readonly clock: Clock
  readonly log: Logger
}
