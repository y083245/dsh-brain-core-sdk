import {
  ApiError,
  ERROR_CODES,
  type AccountingBudgetConfig,
  type AccountingSummary,
  type AgentClass,
  type ApiResult,
  type ChatMessagesResponse,
  type CheckReport,
  type ConsoleInstallPreview,
  type ConsoleLocalApplyResult,
  type ConsolePageItem,
  type ConsoleSearchRequest,
  type ConsoleSettingsView,
  type ConsoleThemeMode,
  type ConsolidationBudgetView,
  type ConsolidationProposalView,
  type CrossChannelAuditItem,
  type CrossChannelMode,
  type Envelope,
  type ErrorCode,
  type ForgetReport,
  type ForgetSelector,
  type InteropSnapshot,
  type IsolationDoctorStatus,
  type MemoryAutomation,
  type L3ProfileDiffView,
  type L3ProfileVersionSummary,
  type MemoryBrowseFilter,
  type MemoryRecord,
  type Meta,
  type ModelPriceBook,
  type PersonSummary,
  type PluginsListResponse,
  type RecordPatch,
  type ResolvedTheme,
  type RoleCardPreview,
  type SatelliteSnapshot,
  type SaveModelSelectionInput,
  type SaveRoleCardInput,
  type SaveSecretInput,
  type SearchHit,
  type SendChatMessageInput,
  type SendChatMessageResponse,
} from './types.ts'

/**
 * FR-C01: The console bearer token lives strictly in this JS module memory variable.
 * It is NEVER written to localStorage, sessionStorage, document.cookie, or URL query/hash.
 */
let inMemoryToken = ''
const authExpiredListeners = new Set<() => void>()

export function getAuthToken(): string {
  return inMemoryToken
}

export function setAuthToken(token: string): void {
  inMemoryToken = token.trim()
}

export function clearAuthToken(): void {
  inMemoryToken = ''
}

export function hasAuthToken(): boolean {
  return inMemoryToken.length > 0
}

export function onAuthExpired(listener: () => void): () => void {
  authExpiredListeners.add(listener)
  return () => {
    authExpiredListeners.delete(listener)
  }
}

function notifyAuthExpired(): void {
  if (inMemoryToken !== '') {
    for (const listener of authExpiredListeners) listener()
  }
}

// ---- Theme Persistence (Only non-sensitive UI theme mode may touch localStorage) ----

export const THEME_STORAGE_KEY = 'brain-console-theme'
const VALID_THEME_MODES: ReadonlySet<string> = new Set(['dark', 'light', 'auto'])

export function readInitialThemeMode(): ConsoleThemeMode {
  if (typeof window === 'undefined') return 'dark'
  try {
    const url = new URL(window.location.href)
    const fromQuery = url.searchParams.get('theme')
    if (fromQuery !== null && VALID_THEME_MODES.has(fromQuery)) {
      return fromQuery as ConsoleThemeMode
    }
  } catch {
    // Ignore URL parsing errors
  }
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (saved !== null && VALID_THEME_MODES.has(saved)) {
      return saved as ConsoleThemeMode
    }
  } catch {
    // Ignore storage access errors in restricted environments
  }
  return 'dark'
}

export function persistThemeMode(mode: ConsoleThemeMode): void {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = mode
  }
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, mode)
    } catch {
      // Ignore storage quota / private mode failures
    }
  }
}

export function resolveThemeMode(mode: ConsoleThemeMode): ResolvedTheme {
  if (mode === 'dark' || mode === 'light') return mode
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  }
  return 'dark'
}

// ---- Low-level Envelope HTTP Client ----

export interface ApiRequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  readonly body?: unknown
  readonly ifMatch?: number
  readonly token?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEnvelope(value: unknown): value is Envelope<unknown> {
  if (!isRecord(value)) return false
  if (value.ok === true) return 'data' in value && isRecord(value.meta)
  if (value.ok === false) {
    const error = value.error
    if (!isRecord(error) || typeof error.code !== 'string') return false
    return typeof error.message === 'string' && (error.details === undefined || isRecord(error.details))
  }
  return false
}

function extractItems<T>(data: unknown): readonly T[] {
  if (Array.isArray(data)) return data as readonly T[]
  if (isRecord(data) && Array.isArray(data.items)) {
    return data.items as readonly T[]
  }
  return []
}

export async function apiFetch<T>(path: string, options: ApiRequestOptions = {}): Promise<ApiResult<T>> {
  const token = options.token ?? inMemoryToken
  const headers: Record<string, string> = { ...options.headers }
  if (token !== '') {
    headers.Authorization = `Bearer ${token}`
  }
  if (options.ifMatch !== undefined) {
    headers['If-Match'] = String(options.ifMatch)
  }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }

  let response: Response
  try {
    response = await globalThis.fetch(path, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (error) {
    const message = error instanceof Error && error.message !== '' ? error.message : '网络请求失败，内核未响应'
    return { ok: false, status: 0, code: 'UNAVAILABLE', message, details: {} }
  }

  let text: string
  try {
    text = await response.text()
  } catch (error) {
    const message = error instanceof Error && error.message !== '' ? error.message : '读取响应失败'
    return { ok: false, status: response.status, code: 'UNAVAILABLE', message, details: {} }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }

  if (isEnvelope(parsed)) {
    if (parsed.ok) {
      return {
        ok: true,
        status: response.status,
        data: parsed.data as T,
        meta: parsed.meta,
      }
    }
    const raw = parsed.error
    const code: ErrorCode = Object.hasOwn(ERROR_CODES, raw.code) ? (raw.code as ErrorCode) : 'INTERNAL'
    if (code === 'UNAUTHENTICATED' && options.token === undefined) {
      notifyAuthExpired()
    }
    return {
      ok: false,
      status: response.status,
      code,
      message: raw.message,
      details: raw.details ?? {},
      ...(parsed.meta?.requestId === undefined ? {} : { requestId: parsed.meta.requestId }),
    }
  }

  const status = response.status
  const code: ErrorCode = status === 401 ? 'UNAUTHENTICATED' : 'UNAVAILABLE'
  if (code === 'UNAUTHENTICATED' && options.token === undefined) {
    notifyAuthExpired()
  }
  const message = parsed === undefined ? `非 JSON 响应 (HTTP ${String(status)})` : '响应格式非标准信封'
  return { ok: false, status, code, message, details: {} }
}

export async function apiRequestWithMeta<T>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<{ readonly data: T; readonly meta: Meta }> {
  const result = await apiFetch<T>(path, options)
  if (!result.ok) {
    throw new ApiError(result.code, result.status, result.message, result.details, result.requestId)
  }
  return { data: result.data, meta: result.meta }
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { data } = await apiRequestWithMeta<T>(path, options)
  return data
}

// ---- Settings API (/api/v1/console/session & /api/v1/console/settings*) ----

export const settingsApi = {
  async checkSession(candidateToken?: string): Promise<{ readonly authenticated: boolean }> {
    return apiRequest<{ readonly authenticated: boolean }>('/api/v1/console/session', {
      ...(candidateToken === undefined ? {} : { token: candidateToken }),
    })
  },

  async getSettings(): Promise<ConsoleSettingsView> {
    return apiRequest<ConsoleSettingsView>('/api/v1/console/settings')
  },

  async getRoleCard(name: string, signal?: AbortSignal): Promise<RoleCardPreview> {
    return apiRequest<RoleCardPreview>(
      `/api/v1/console/settings/role-card?name=${encodeURIComponent(name)}`,
      signal === undefined ? {} : { signal },
    )
  },

  async saveModelSelection(input: SaveModelSelectionInput): Promise<unknown> {
    return apiRequest<unknown>('/api/v1/console/settings/model', {
      method: 'PUT',
      body: input,
    })
  },

  async saveSecret(input: SaveSecretInput): Promise<{ readonly saved: string; readonly secretNames: readonly string[] }> {
    return apiRequest<{ readonly saved: string; readonly secretNames: readonly string[] }>(
      '/api/v1/console/settings/secret',
      {
        method: 'PUT',
        body: input,
      },
    )
  },

  async saveRoleCard(input: SaveRoleCardInput): Promise<{ readonly name: string }> {
    return apiRequest<{ readonly name: string }>('/api/v1/console/settings/role-card', {
      method: 'PUT',
      body: input,
    })
  },
}

// ---- Memory & Consolidation API ----

export const memoryApi = {
  async browse(
    filter: MemoryBrowseFilter = {},
  ): Promise<{ readonly items: readonly MemoryRecord[]; readonly nextCursor?: string }> {
    const params = new URLSearchParams()
    if (filter.layer !== undefined) params.set('layer', filter.layer)
    if (filter.personId !== undefined && filter.personId.trim() !== '') params.set('personId', filter.personId.trim())
    if (filter.channel !== undefined && filter.channel.trim() !== '') params.set('channel', filter.channel.trim())
    if (filter.cursor !== undefined && filter.cursor.trim() !== '') params.set('cursor', filter.cursor.trim())
    if (filter.limit !== undefined) params.set('limit', String(filter.limit))
    const qs = params.toString()
    const path = qs === '' ? '/api/v1/console/memory/records' : `/api/v1/console/memory/records?${qs}`
    const { data, meta } = await apiRequestWithMeta<{
      readonly items: readonly MemoryRecord[]
      readonly nextCursor?: string
    }>(path)
    const nextCursor = data.nextCursor ?? meta.nextCursor
    return {
      items: data.items,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    }
  },

  async search(
    request: ConsoleSearchRequest,
  ): Promise<{ readonly items: readonly SearchHit[]; readonly nextCursor?: string; readonly degraded: boolean }> {
    const endpoint =
      request.scope !== 'all'
      || request.channel !== undefined
      || request.participants !== undefined
        ? '/api/v1/console/memory/search'
        : '/api/v1/memory/search'
    const { data, meta } = await apiRequestWithMeta<{
      readonly items: readonly SearchHit[]
      readonly nextCursor?: string
      readonly degraded?: boolean
    }>(endpoint, {
      method: 'POST',
      body: request,
    })
    const nextCursor = meta.nextCursor ?? data.nextCursor
    const degraded = meta.degraded ?? data.degraded ?? false
    return {
      items: data.items,
      degraded,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    }
  },

  async getRecord(id: string): Promise<MemoryRecord | null> {
    const res = await apiFetch<MemoryRecord>(`/api/v1/console/memory/records/${encodeURIComponent(id)}`)
    if (!res.ok) {
      if (res.code === 'NOT_FOUND') return null
      throw new ApiError(res.code, res.status, res.message, res.details, res.requestId)
    }
    return res.data
  },

  async getDependents(id: string): Promise<readonly MemoryRecord[]> {
    const data = await apiRequest<readonly MemoryRecord[] | { readonly items: readonly MemoryRecord[] }>(
      `/api/v1/console/memory/records/${encodeURIComponent(id)}/dependents`,
    )
    return extractItems<MemoryRecord>(data)
  },

  async updateRecord(id: string, patch: RecordPatch, expectedVersion: number): Promise<MemoryRecord> {
    return apiRequest<MemoryRecord>(`/api/v1/memory/records/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: patch,
      ifMatch: expectedVersion,
    })
  },

  async forget(selector: ForgetSelector): Promise<ForgetReport> {
    return apiRequest<ForgetReport>('/api/v1/memory/forget', {
      method: 'POST',
      body: selector,
    })
  },

  async listAudit(recordId?: string): Promise<readonly CrossChannelAuditItem[]> {
    const path =
      recordId === undefined || recordId.trim() === ''
        ? '/api/v1/console/memory/audit'
        : `/api/v1/console/memory/audit?recordId=${encodeURIComponent(recordId.trim())}`
    const data = await apiRequest<
      readonly CrossChannelAuditItem[] | { readonly items: readonly CrossChannelAuditItem[] }
    >(path)
    return extractItems<CrossChannelAuditItem>(data)
  },

  async getCrossChannelMode(): Promise<CrossChannelMode> {
    const data = await apiRequest<CrossChannelMode | { readonly mode: CrossChannelMode }>(
      '/api/v1/console/memory/cross-channel',
    )
    return typeof data === 'string' ? data : data.mode
  },

  async setCrossChannelMode(mode: CrossChannelMode): Promise<void> {
    await apiRequest<unknown>('/api/v1/console/memory/cross-channel', {
      method: 'PUT',
      body: { mode },
    })
  },

  getMemoryAutomation(): Promise<MemoryAutomation> {
    return apiRequest('/api/v1/console/memory/automation')
  },

  setMemoryAutomation(enabled: boolean): Promise<MemoryAutomation> {
    return apiRequest('/api/v1/console/memory/automation', {
      method: 'PUT',
      body: { enabled },
    })
  },

  async listPersons(): Promise<readonly PersonSummary[]> {
    const data = await apiRequest<readonly PersonSummary[] | { readonly items: readonly PersonSummary[] }>(
      '/api/v1/console/memory/persons',
    )
    return extractItems<PersonSummary>(data)
  },

  async mergePerson(from: string, into: string): Promise<void> {
    await apiRequest<unknown>('/api/v1/console/memory/persons/merge', {
      method: 'POST',
      body: { from, into },
    })
  },

  async splitPerson(personId: string, accounts: readonly string[]): Promise<string> {
    const data = await apiRequest<string | { readonly personId: string }>(
      `/api/v1/console/memory/persons/${encodeURIComponent(personId)}/split`,
      {
        method: 'POST',
        body: { accounts },
      },
    )
    return typeof data === 'string' ? data : data.personId
  },

  async listL3Versions(): Promise<readonly L3ProfileVersionSummary[]> {
    const data = await apiRequest<
      readonly L3ProfileVersionSummary[] | { readonly items: readonly L3ProfileVersionSummary[] }
    >('/api/v1/console/memory/l3/versions')
    return extractItems<L3ProfileVersionSummary>(data)
  },

  async diffL3Versions(from: number, to: number): Promise<L3ProfileDiffView> {
    return apiRequest<L3ProfileDiffView>(
      `/api/v1/console/memory/l3/diff?from=${encodeURIComponent(String(from))}&to=${encodeURIComponent(String(to))}`,
    )
  },

  async rollbackL3Version(version: number): Promise<{ readonly version: number }> {
    return apiRequest<{ readonly version: number }>('/api/v1/console/memory/l3/rollback', {
      method: 'POST',
      body: { version },
    })
  },

  async editL3ByOwner(patch: {
    readonly stable?: string
    readonly data: Readonly<Record<string, unknown>>
    readonly lockedKeys?: readonly string[]
    readonly evidence?: readonly { readonly id: string }[]
  }): Promise<{ readonly version: number }> {
    return apiRequest<{ readonly version: number }>('/api/v1/console/memory/l3/owner', {
      method: 'PUT',
      body: patch,
    })
  },

  async listConsolidationProposals(
    status?: 'pending' | 'approved' | 'rejected',
  ): Promise<readonly ConsolidationProposalView[]> {
    const path =
      status === undefined
        ? '/api/v1/console/memory/consolidation/proposals'
        : `/api/v1/console/memory/consolidation/proposals?status=${encodeURIComponent(status)}`
    const data = await apiRequest<
      readonly ConsolidationProposalView[] | { readonly items: readonly ConsolidationProposalView[] }
    >(path)
    return extractItems<ConsolidationProposalView>(data)
  },

  async getConsolidationBudget(): Promise<ConsolidationBudgetView> {
    return apiRequest<ConsolidationBudgetView>('/api/v1/console/memory/consolidation/budget')
  },

  async runConsolidationShadow(options?: {
    readonly from?: number
    readonly to?: number
    readonly force?: boolean
  }): Promise<ConsolidationProposalView> {
    return apiRequest<ConsolidationProposalView>('/api/v1/console/memory/consolidation/run', {
      method: 'POST',
      ...(options === undefined ? {} : { body: options }),
    })
  },

  async approveConsolidationProposal(
    id: string,
    conflictKeepIds?: Readonly<Record<string, string>>,
  ): Promise<{ readonly newProfileVersion?: number; readonly l2Created: number }> {
    return apiRequest<{ readonly newProfileVersion?: number; readonly l2Created: number }>(
      `/api/v1/console/memory/consolidation/proposals/${encodeURIComponent(id)}/approve`,
      {
        method: 'POST',
        body: conflictKeepIds === undefined ? {} : { conflictKeepIds },
      },
    )
  },

  async rejectConsolidationProposal(id: string): Promise<void> {
    await apiRequest<unknown>(`/api/v1/console/memory/consolidation/proposals/${encodeURIComponent(id)}/reject`, {
      method: 'POST',
    })
  },
}

// ---- Satellite & Interop API ----

export const satelliteApi = {
  async snapshot(): Promise<SatelliteSnapshot> {
    return apiRequest<SatelliteSnapshot>('/api/v1/console/satellite')
  },

  async getSnapshot(): Promise<SatelliteSnapshot> {
    return apiRequest<SatelliteSnapshot>('/api/v1/console/satellite')
  },

  async restart(agentClass: AgentClass): Promise<void> {
    await apiRequest<unknown>(`/api/v1/console/satellite/${encodeURIComponent(agentClass)}/restart`, {
      method: 'POST',
    })
  },

  async doctor(): Promise<IsolationDoctorStatus> {
    return apiRequest<IsolationDoctorStatus>('/api/v1/console/satellite/doctor', {
      method: 'POST',
    })
  },

  async runIsolationDoctor(): Promise<IsolationDoctorStatus> {
    return apiRequest<IsolationDoctorStatus>('/api/v1/console/satellite/doctor', {
      method: 'POST',
    })
  },

  async interop(): Promise<InteropSnapshot> {
    return apiRequest<InteropSnapshot>('/api/v1/console/interop')
  },

  async getInterop(): Promise<InteropSnapshot> {
    return apiRequest<InteropSnapshot>('/api/v1/console/interop')
  },

  async amp(enabled: boolean): Promise<InteropSnapshot> {
    return apiRequest<InteropSnapshot>('/api/v1/console/interop/amp', {
      method: 'PUT',
      body: { enabled },
    })
  },

  async setAmpAliases(enabled: boolean): Promise<InteropSnapshot> {
    return apiRequest<InteropSnapshot>('/api/v1/console/interop/amp', {
      method: 'PUT',
      body: { enabled },
    })
  },

  async mcp(enabled: boolean): Promise<InteropSnapshot> {
    return apiRequest<InteropSnapshot>('/api/v1/console/interop/mcp', {
      method: 'PUT',
      body: { enabled },
    })
  },

  async setReadOnlyMcp(enabled: boolean): Promise<InteropSnapshot> {
    return apiRequest<InteropSnapshot>('/api/v1/console/interop/mcp', {
      method: 'PUT',
      body: { enabled },
    })
  },

  async startDebugView(): Promise<InteropSnapshot> {
    return apiRequest<InteropSnapshot>('/api/v1/console/interop/debug-view/start', {
      method: 'POST',
    })
  },

  async stopDebugView(): Promise<InteropSnapshot> {
    return apiRequest<InteropSnapshot>('/api/v1/console/interop/debug-view/stop', {
      method: 'POST',
    })
  },

  async debugView(action: 'start' | 'stop'): Promise<InteropSnapshot> {
    return action === 'start' ? this.startDebugView() : this.stopDebugView()
  },
}

// ---- Accounting API ----

export const accountingApi = {
  async summary(days?: number): Promise<AccountingSummary> {
    const qs = days === undefined ? '' : `?days=${encodeURIComponent(String(days))}`
    return apiRequest<AccountingSummary>(`/api/v1/console/accounting/summary${qs}`)
  },

  async getSummary(days?: number): Promise<AccountingSummary> {
    return this.summary(days)
  },

  async prices(): Promise<ModelPriceBook> {
    return apiRequest<ModelPriceBook>('/api/v1/console/accounting/prices')
  },

  async getPrices(): Promise<ModelPriceBook> {
    return this.prices()
  },

  async savePrices(book: ModelPriceBook): Promise<ModelPriceBook> {
    return apiRequest<ModelPriceBook>('/api/v1/console/accounting/prices', {
      method: 'PUT',
      body: book,
    })
  },

  async saveBudget(budget: AccountingBudgetConfig): Promise<AccountingBudgetConfig> {
    return apiRequest<AccountingBudgetConfig>('/api/v1/console/accounting/budget', {
      method: 'PUT',
      body: budget,
    })
  },
}

// ---- Plugins API ----

function resolveSafePluginEntryPath(pluginId: string, rawEntry: string): string {
  const safeId = pluginId.trim()
  if (safeId === '' || safeId === '.' || safeId === '..' || safeId.includes('/') || safeId.includes('\\')) {
    throw new ApiError('INVALID_ARGUMENT', 400, '非法的插件标识')
  }
  const entry = rawEntry.trim()
  if (entry === '' || entry.includes('\\') || entry.includes('//') || entry.includes('..')) {
    throw new ApiError('INVALID_ARGUMENT', 400, '非法的插件入口路径')
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(entry)) {
    throw new ApiError('INVALID_ARGUMENT', 400, '插件入口禁止包含外部协议头')
  }
  if (entry.startsWith('/')) {
    if (!entry.startsWith('/api/v1/plugins/') || entry === '/api/v1/plugins/') {
      throw new ApiError('INVALID_ARGUMENT', 400, '插件入口路径必须位于 /api/v1/plugins/ 下')
    }
    return entry
  }
  return `/api/v1/plugins/${encodeURIComponent(safeId)}/${entry}`
}

export const pluginsApi = {
  async list(): Promise<PluginsListResponse> {
    return apiRequest<PluginsListResponse>('/api/v1/console/plugins')
  },

  async scan(): Promise<PluginsListResponse> {
    return apiRequest<PluginsListResponse>('/api/v1/console/plugins/scan', {
      method: 'POST',
    })
  },

  async install(spec: string): Promise<ConsoleInstallPreview> {
    return apiRequest<ConsoleInstallPreview>('/api/v1/console/plugins/install', {
      method: 'POST',
      body: { spec },
    })
  },

  async confirm(id: string): Promise<void> {
    await apiRequest<unknown>(`/api/v1/console/plugins/${encodeURIComponent(id)}/confirm`, {
      method: 'POST',
    })
  },

  async enable(id: string): Promise<void> {
    await apiRequest<unknown>(`/api/v1/console/plugins/${encodeURIComponent(id)}/enable`, {
      method: 'POST',
    })
  },

  async disable(id: string): Promise<void> {
    await apiRequest<unknown>(`/api/v1/console/plugins/${encodeURIComponent(id)}/disable`, {
      method: 'POST',
    })
  },

  async upgrade(id: string, spec: string): Promise<ConsoleInstallPreview & { readonly applied: boolean }> {
    return apiRequest<ConsoleInstallPreview & { readonly applied: boolean }>(
      `/api/v1/console/plugins/${encodeURIComponent(id)}/upgrade`,
      {
        method: 'POST',
        body: { spec },
      },
    )
  },

  async applyLocal(
    id: string,
    input: { readonly action: 'enable' | 'update'; readonly confirmPermissions?: boolean },
  ): Promise<ConsoleLocalApplyResult> {
    return apiRequest<ConsoleLocalApplyResult>(
      `/api/v1/console/plugins/${encodeURIComponent(id)}/apply-local`,
      {
        method: 'POST',
        body: input,
      },
    )
  },

  async uninstall(id: string, options: { readonly keepData: boolean }): Promise<void> {
    await apiRequest<unknown>(`/api/v1/console/plugins/${encodeURIComponent(id)}/uninstall`, {
      method: 'POST',
      body: { keepData: options.keepData },
    })
  },

  async check(dir: string): Promise<CheckReport> {
    return apiRequest<CheckReport>('/api/v1/console/plugins/check', {
      method: 'POST',
      body: { dir },
    })
  },

  async pages(): Promise<readonly ConsolePageItem[]> {
    const data = await apiRequest<readonly ConsolePageItem[] | { readonly items: readonly ConsolePageItem[] }>(
      '/api/v1/console/pages',
    )
    return extractItems<ConsolePageItem>(data)
  },

  async listPages(): Promise<readonly ConsolePageItem[]> {
    return this.pages()
  },

  async fetchEntryHtml(pluginId: string, entry: string): Promise<string> {
    const resolvedPath = resolveSafePluginEntryPath(pluginId, entry)
    const headers: Record<string, string> = {}
    if (inMemoryToken !== '') {
      headers.Authorization = `Bearer ${inMemoryToken}`
    }
    const response = await globalThis.fetch(resolvedPath, { method: 'GET', headers })
    const text = await response.text()
    if (response.status === 401) {
      notifyAuthExpired()
      throw new ApiError('UNAUTHENTICATED', 401, '会话令牌已失效，请重新认证')
    }
    if (!response.ok) {
      throw new ApiError('UNAVAILABLE', response.status, `加载插件页面失败（HTTP ${String(response.status)}）`)
    }
    if (text.trimStart().startsWith('{')) {
      try {
        const parsed = JSON.parse(text) as unknown
        if (isRecord(parsed) && parsed.ok === true && typeof parsed.data === 'string') {
          return parsed.data
        }
      } catch {
        // Fallback to raw HTML
      }
    }
    return text
  },
}

// ---- Console Chat API (/api/v1/plugins/console-chat/messages) ----

export const DEFAULT_CHAT_CHANNEL = 'console-chat:private:owner'

export const chatApi = {
  async getMessages(channel = DEFAULT_CHAT_CHANNEL): Promise<ChatMessagesResponse> {
    const target = channel.trim() === '' ? DEFAULT_CHAT_CHANNEL : channel.trim()
    return apiRequest<ChatMessagesResponse>(
      `/api/v1/plugins/console-chat/messages?channel=${encodeURIComponent(target)}`,
    )
  },

  async listMessages(channel = DEFAULT_CHAT_CHANNEL): Promise<ChatMessagesResponse> {
    return this.getMessages(channel)
  },

  async sendMessage(input: SendChatMessageInput): Promise<SendChatMessageResponse> {
    return apiRequest<SendChatMessageResponse>('/api/v1/plugins/console-chat/messages', {
      method: 'POST',
      body: {
        channel: DEFAULT_CHAT_CHANNEL,
        ...input,
      },
    })
  },

  async send(input: SendChatMessageInput): Promise<SendChatMessageResponse> {
    return this.sendMessage(input)
  },
}
