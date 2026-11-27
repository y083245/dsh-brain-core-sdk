import {
  BrainError,
  type ManifestResult,
  type ManifestTool,
  type PluginKind,
  type ToolEffect,
  type ToolLoad,
} from '@brain-core/sdk'
import { apiFetch, type ApiFetchOptions } from '../../shell/api-fetch.ts'

export type { ManifestResult, ManifestTool, PluginKind, ToolEffect, ToolLoad }

export interface ContractResult {
  readonly name: string
  readonly ok: boolean
  readonly message: string
}

/** One thing `brain plugin check` found. A `must` finding makes the plugin unfit to install. */
export interface CheckFinding {
  readonly rule: string
  readonly level: 'must' | 'should'
  readonly message: string
  readonly file?: string
  readonly line?: number
}

export interface CheckReport {
  /** No `must` finding. */
  readonly ok: boolean
  readonly manifest: ManifestResult
  readonly contract: readonly ContractResult[]
  readonly findings: readonly CheckFinding[]
  readonly notes: readonly string[]
}

export type PluginLifecycleState = 'discovered' | 'pending' | 'enabled' | 'disabled' | 'failed'

export interface ConsolePluginUpdateInfo {
  readonly version: string
  readonly sha8: string
  readonly permissions: readonly string[]
  readonly newPermissions: readonly string[]
  readonly warnings: readonly string[]
}

export interface ConsolePluginItem {
  readonly id: string
  readonly version: string
  readonly kinds: readonly PluginKind[]
  readonly runtime: 'node' | 'process'
  readonly state: PluginLifecycleState
  readonly permissions: readonly string[]
  readonly granted: readonly string[]
  readonly checkPassed: boolean
  readonly tools: readonly ManifestTool[]
  readonly source?: 'workspace' | 'installed'
  readonly warnings?: readonly string[]
  readonly updateAvailable?: ConsolePluginUpdateInfo
}

export interface ConsoleInstallPreview {
  readonly id: string
  readonly version: string
  readonly permissions: readonly string[]
  readonly newPermissions: readonly string[]
  readonly warnings: readonly string[]
}

export interface ConsoleLocalApplyResult extends ConsoleInstallPreview {
  readonly applied: boolean
  readonly state: PluginLifecycleState
}

export interface ChannelCoreBudget {
  readonly pattern: string
  readonly count: number
  readonly tokens: number
  readonly over: boolean
}

export interface PluginsPageApi {
  list(): Promise<{ readonly plugins: readonly ConsolePluginItem[]; readonly coreBudgets: readonly ChannelCoreBudget[] }>
  scan?(): Promise<{ readonly plugins: readonly ConsolePluginItem[]; readonly coreBudgets: readonly ChannelCoreBudget[] }>
  install(spec: string): Promise<ConsoleInstallPreview>
  confirm(id: string): Promise<void>
  enable(id: string): Promise<void>
  disable(id: string): Promise<void>
  upgrade(id: string, spec: string): Promise<ConsoleInstallPreview & { readonly applied: boolean }>
  applyLocal?(
    id: string,
    input: { readonly action: 'enable' | 'update'; readonly confirmPermissions?: boolean },
  ): Promise<ConsoleLocalApplyResult>
  uninstall(id: string, options: { readonly keepData: boolean }): Promise<void>
  check(dir: string): Promise<CheckReport>
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
}

/** HTTP client for the console plugins management API, backed by `apiFetch`. */
export function createHttpPluginsPageApi(
  baseUrl: string,
  token: string,
  fetchImpl?: typeof globalThis.fetch,
): PluginsPageApi {
  const base = normalizeBaseUrl(baseUrl)

  async function request<T>(path: string, options: Omit<ApiFetchOptions, 'token' | 'fetchImpl'> = {}): Promise<T> {
    const result = await apiFetch<T>(`${base}${path}`, {
      ...options,
      token,
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    })
    if (!result.ok) {
      throw new BrainError(result.code, result.message, result.details)
    }
    return result.data
  }

  return {
    list() {
      return request('/api/v1/console/plugins', { method: 'GET' })
    },
    scan() {
      return request('/api/v1/console/plugins/scan', { method: 'POST' })
    },
    install(spec) {
      return request('/api/v1/console/plugins/install', { method: 'POST', body: { spec } })
    },
    async confirm(id) {
      await request<unknown>(`/api/v1/console/plugins/${encodeURIComponent(id)}/confirm`, { method: 'POST' })
    },
    async enable(id) {
      await request<unknown>(`/api/v1/console/plugins/${encodeURIComponent(id)}/enable`, { method: 'POST' })
    },
    async disable(id) {
      await request<unknown>(`/api/v1/console/plugins/${encodeURIComponent(id)}/disable`, { method: 'POST' })
    },
    upgrade(id, spec) {
      return request(`/api/v1/console/plugins/${encodeURIComponent(id)}/upgrade`, { method: 'POST', body: { spec } })
    },
    applyLocal(id, input) {
      return request(`/api/v1/console/plugins/${encodeURIComponent(id)}/apply-local`, { method: 'POST', body: input })
    },
    async uninstall(id, options) {
      await request<unknown>(`/api/v1/console/plugins/${encodeURIComponent(id)}/uninstall`, {
        method: 'POST',
        body: { keepData: options.keepData },
      })
    },
    check(dir) {
      return request('/api/v1/console/plugins/check', { method: 'POST', body: { dir } })
    },
  }
}
