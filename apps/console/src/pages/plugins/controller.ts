import type {
  ChannelCoreBudget,
  CheckReport,
  ConsoleInstallPreview,
  ConsolePluginItem,
  PluginsPageApi,
} from './types.ts'

export interface PluginsPageState {
  readonly plugins: readonly ConsolePluginItem[]
  readonly coreBudgets: readonly ChannelCoreBudget[]
  readonly pendingInstall: ConsoleInstallPreview | null
  readonly pendingUpgrade: { readonly id: string; readonly spec: string; readonly preview: ConsoleInstallPreview } | null
  readonly lastCheckReport: { readonly target: string; readonly report: CheckReport } | null
  readonly rollbackNotice: string | null
  readonly errorMessage: string | null
}

export interface PluginsPageController {
  state(): PluginsPageState
  refresh(): Promise<void>
  /** Step 1 of install: fetches InstallPreview only; NEVER calls confirm or enable before confirmInstall(). */
  startInstall(spec: string): Promise<ConsoleInstallPreview>
  /** Step 2 of install: confirms permissions, enables the plugin, clears pendingInstall and refreshes. */
  confirmInstall(): Promise<void>
  cancelInstall(): void
  enable(id: string): Promise<void>
  disable(id: string): Promise<void>
  /**
   * Starts upgrade. When newPermissions is non-empty, stores pendingUpgrade and does NOT call confirm yet.
   * When the API throws or returns an error (migration/enable failure), sets rollbackNotice explaining
   * that the plugin was automatically rolled back to the previous version and data was restored.
   */
  startUpgrade(id: string, spec: string): Promise<void>
  confirmUpgrade(): Promise<void>
  cancelUpgrade(): void
  uninstall(id: string, options: { readonly keepData: boolean }): Promise<void>
  runCheck(dir: string): Promise<CheckReport>
}

function formatError(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : String(error)
}

/** Creates the state controller for the console plugins management page. */
export function createPluginsPageController(api: PluginsPageApi): PluginsPageController {
  let current: PluginsPageState = {
    plugins: [],
    coreBudgets: [],
    pendingInstall: null,
    pendingUpgrade: null,
    lastCheckReport: null,
    rollbackNotice: null,
    errorMessage: null,
  }

  function update(patch: Partial<PluginsPageState>): void {
    current = { ...current, ...patch }
  }

  async function refreshList(): Promise<void> {
    const data = await api.list()
    update({
      plugins: data.plugins,
      coreBudgets: data.coreBudgets,
      errorMessage: null,
    })
  }

  async function safeRefreshAfterRollback(): Promise<void> {
    try {
      const data = await api.list()
      update({ plugins: data.plugins, coreBudgets: data.coreBudgets })
    } catch {
      // Keep the rollback notice intact even if refreshing the list fails.
    }
  }

  return {
    state() {
      return current
    },

    async refresh() {
      try {
        await refreshList()
      } catch (error) {
        update({ errorMessage: formatError(error) })
        throw error
      }
    },

    async startInstall(spec) {
      update({ errorMessage: null })
      try {
        const preview = await api.install(spec)
        update({ pendingInstall: preview })
        return preview
      } catch (error) {
        update({ errorMessage: formatError(error) })
        throw error
      }
    },

    async confirmInstall() {
      const preview = current.pendingInstall
      if (preview === null) {
        const message = 'no pending install to confirm'
        update({ errorMessage: message })
        throw new Error(message)
      }
      update({ errorMessage: null })
      try {
        await api.confirm(preview.id)
        await api.enable(preview.id)
        update({ pendingInstall: null })
        await refreshList()
      } catch (error) {
        update({ errorMessage: formatError(error) })
        throw error
      }
    },

    cancelInstall() {
      update({ pendingInstall: null, errorMessage: null })
    },

    async enable(id) {
      update({ errorMessage: null })
      try {
        await api.enable(id)
        await refreshList()
      } catch (error) {
        update({ errorMessage: formatError(error) })
        throw error
      }
    },

    async disable(id) {
      update({ errorMessage: null })
      try {
        await api.disable(id)
        await refreshList()
      } catch (error) {
        update({ errorMessage: formatError(error) })
        throw error
      }
    },

    async startUpgrade(id, spec) {
      update({ errorMessage: null, rollbackNotice: null })
      try {
        const result = await api.upgrade(id, spec)
        if (result.newPermissions.length > 0 || !result.applied) {
          update({ pendingUpgrade: { id, spec, preview: result } })
          return
        }
        update({ pendingUpgrade: null })
        await refreshList()
      } catch (error) {
        const reason = formatError(error)
        update({
          pendingUpgrade: null,
          rollbackNotice: `插件 ${id} 升级失败（${reason}），已自动回滚至旧版，数据与 schema-version 已恢复。`,
          errorMessage: reason,
        })
        await safeRefreshAfterRollback()
      }
    },

    async confirmUpgrade() {
      const pending = current.pendingUpgrade
      if (pending === null) {
        const message = 'no pending upgrade to confirm'
        update({ errorMessage: message })
        throw new Error(message)
      }
      update({ errorMessage: null, rollbackNotice: null })
      try {
        await api.confirm(pending.id)
        update({ pendingUpgrade: null })
        await refreshList()
      } catch (error) {
        const reason = formatError(error)
        update({
          pendingUpgrade: null,
          rollbackNotice: `插件 ${pending.id} 升级失败（${reason}），已自动回滚至旧版，数据与 schema-version 已恢复。`,
          errorMessage: reason,
        })
        await safeRefreshAfterRollback()
      }
    },

    cancelUpgrade() {
      update({ pendingUpgrade: null, errorMessage: null })
    },

    async uninstall(id, options) {
      update({ errorMessage: null })
      try {
        await api.uninstall(id, { keepData: options.keepData })
        if (current.pendingUpgrade?.id === id) {
          update({ pendingUpgrade: null })
        }
        await refreshList()
      } catch (error) {
        update({ errorMessage: formatError(error) })
        throw error
      }
    },

    async runCheck(dir) {
      update({ errorMessage: null })
      try {
        const report = await api.check(dir)
        update({ lastCheckReport: { target: dir, report } })
        return report
      } catch (error) {
        update({ errorMessage: formatError(error) })
        throw error
      }
    },
  }
}
