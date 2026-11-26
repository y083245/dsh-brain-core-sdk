import type { Logger } from '../log/index.ts'

export interface ExternalDeps {
  readonly pluginsDir: string
  readonly log: Logger
  readonly now: () => number
  readonly onFailed: (pluginId: string) => void
  readonly parentEnv?: NodeJS.ProcessEnv
}
