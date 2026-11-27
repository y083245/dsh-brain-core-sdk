import { BrainError, LAYERS, type Layer } from '@dsh-brain-core/sdk'
import type { AgentClass } from '@dsh-brain-core/satellite-host'
import {
  createAccountingPageController,
  createHttpAccountingPageApi,
  renderAccountingView,
  type AccountingPageController,
  type AccountingPeriodDays,
} from '../pages/accounting/index.ts'
import type { AccountingBudgetConfig, ModelPriceBook, ModelPriceEntry } from '../pages/accounting/types.ts'
import {
  createHttpMemoryPageApi,
  createMemoryPageController,
  renderMemoryPage,
  type CrossChannelMode,
  type MemoryBrowseFilter,
  type MemoryPageController,
  type MemorySubView,
} from '../pages/memory/index.ts'
import {
  createHttpPluginsPageApi,
  createPluginsPageController,
  renderPluginsPage,
  type PluginsPageController,
} from '../pages/plugins/index.ts'
import {
  createHttpSatellitePageApi,
  createSatellitePageController,
  renderSatellitePage,
  type SatellitePageController,
  type SatelliteSubView,
} from '../pages/satellite/index.ts'
import { apiFetch } from './api-fetch.ts'
import { renderSettingsPanel, type ConsoleSettingsView } from './settings.ts'
import { escapeHtml, type NavItem } from './theme.ts'

export interface ConsoleKernelApiOptions {
  readonly baseUrl: string
  readonly token: string
  readonly fetchImpl?: typeof globalThis.fetch
}

export interface UiToast {
  readonly tone: 'info' | 'warning' | 'ok'
  readonly message: string
}

export interface ConsoleUiState {
  readonly activePageId: string
  readonly navItems: readonly NavItem[]
  readonly roleCardName: string | null
  readonly sharedQuotaWarning: boolean
  readonly mainHtml: string
  readonly toast?: UiToast
}

export interface ConsoleAppRouterDeps {
  readonly kernelApi?: ConsoleKernelApiOptions
  readonly baseNavItems: readonly NavItem[]
  readonly getSettingsView: () => Promise<ConsoleSettingsView>
  readonly saveModelSelection: (body: unknown) => Promise<unknown>
  readonly saveSecret: (body: unknown) => Promise<unknown>
  readonly saveRoleCard: (body: unknown) => Promise<unknown>
}

export interface ConsoleAppRouter {
  getState(page?: string): Promise<ConsoleUiState>
  handleAction(body: unknown): Promise<ConsoleUiState>
}

interface KernelConsolePage {
  readonly pluginId: string
  readonly id: string
  readonly title: string
  readonly entry: string
}

interface ChatHistoryEntry {
  readonly messageId: string
  readonly channel: string
  readonly direction: 'inbound' | 'outbound'
  readonly actor: string
  readonly displayName: string
  readonly text: string
  readonly replyTo?: string
  readonly recordId: string
  readonly tEvent: number
}

interface ChatMessagesPayload {
  readonly channel: string
  readonly items: readonly ChatHistoryEntry[]
  readonly unreadCount: number
}

const DEFAULT_CHAT_CHANNEL = 'console-chat:private:owner'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  return String(error)
}

function formatRelativeTime(diffMs: number): string {
  const safe = Math.max(0, Math.floor(diffMs / 1000))
  if (safe < 60) return '刚刚'
  const minutes = Math.floor(safe / 60)
  if (minutes < 60) return `${String(minutes)} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)} 小时前`
  const days = Math.floor(hours / 24)
  return `${String(days)} 天前`
}

function renderKernelMissingNotice(title: string): string {
  return `<section class="glass-card" data-section="kernel-unconfigured">
  <h2>${escapeHtml(title)}</h2>
  <p class="login-hint">当前控制台未配置内核 API（kernelApi），暂时无法加载实时数据。</p>
</section>`
}

function parsePluginPageId(pageId: string): { readonly pluginId: string; readonly subPageId: string } | null {
  if (!pageId.startsWith('plugin:')) return null
  const rest = pageId.slice('plugin:'.length)
  const sep = rest.indexOf(':')
  if (sep <= 0 || sep === rest.length - 1) return null
  return { pluginId: rest.slice(0, sep), subPageId: rest.slice(sep + 1) }
}

function parseLayer(value: unknown): Layer | undefined {
  const text = stringOf(value)
  if (text === '' || text === 'all') return undefined
  if ((LAYERS as readonly string[]).includes(text)) return text as Layer
  throw new BrainError('INVALID_ARGUMENT', `invalid layer: ${text}`, { field: 'layer' })
}

function parseOptionalPositiveInt(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string' && value.trim() === '') return undefined
  const num = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(num) || num < 0) {
    throw new BrainError('INVALID_ARGUMENT', `${field} must be a non-negative number`, { field })
  }
  return Math.round(num)
}

function parsePriceEntry(raw: unknown, key: string): ModelPriceEntry {
  if (!isRecord(raw)) {
    throw new BrainError('INVALID_ARGUMENT', `invalid price entry for ${key}`, { field: 'models' })
  }
  const fields = ['inputPerMillion', 'outputPerMillion', 'cacheReadPerMillion', 'cacheWritePerMillion'] as const
  const parsed: Record<string, number> = {}
  for (const field of fields) {
    const val = typeof raw[field] === 'number' ? raw[field] : Number(String(raw[field] ?? '').trim())
    if (!Number.isFinite(val) || val < 0) {
      throw new BrainError('INVALID_ARGUMENT', `${key}.${field} must be a non-negative number`, { field })
    }
    parsed[field] = val
  }
  return {
    inputPerMillion: parsed.inputPerMillion!,
    outputPerMillion: parsed.outputPerMillion!,
    cacheReadPerMillion: parsed.cacheReadPerMillion!,
    cacheWritePerMillion: parsed.cacheWritePerMillion!,
  }
}

function renderConsoleChatPanel(input: {
  readonly channel: string
  readonly items: readonly ChatHistoryEntry[]
  readonly unreadCount: number
  readonly latestWakeId?: string
  readonly loadError?: string
}): string {
  const safeChannel = escapeHtml(input.channel)
  const wakeText = input.latestWakeId ? escapeHtml(input.latestWakeId) : 'idle'
  const now = Date.now()
  const errorBanner = input.loadError
    ? `<div class="status-banner" data-tone="warning" data-role="chat-error">${escapeHtml(input.loadError)}</div>`
    : ''

  const bubblesHtml = input.items.length === 0
    ? '<p class="empty-hint">还没有消息，发一句试试吧。</p>'
    : input.items.map((item) => {
        const rowClass = item.direction === 'outbound' ? 'chat-outbound' : 'chat-inbound'
        const ago = formatRelativeTime(now - item.tEvent)
        const replyHtml = item.replyTo === undefined
          ? ''
          : `<div class="login-hint">回复 ${escapeHtml(item.replyTo)}</div>`
        return `<article class="chat-row ${rowClass}" data-message-id="${escapeHtml(item.messageId)}">
  <div class="chat-meta">
    <strong>${escapeHtml(item.displayName)}</strong>
    <span>${escapeHtml(ago)}</span>
    <button type="button" class="link-btn mono evidence-jump-btn" data-action="jump-to-memory-record" data-record-id="${escapeHtml(item.recordId)}" title="跳转到记忆页查看 L0 记录">${escapeHtml(item.recordId)}</button>
  </div>
  <div class="chat-bubble">
    ${replyHtml}
    <div>${escapeHtml(item.text)}</div>
  </div>
</article>`
      }).join('\n')

  return `<section class="glass-card plugin-chat-panel" data-channel="${safeChannel}">
  <header class="chat-header-bar">
    <div>
      <h2>与她对话</h2>
      <div class="chat-meta mono" data-role="chat-status-pills">
        <span class="apple-badge" data-unread-count="${String(input.unreadCount)}">未读 ${String(input.unreadCount)}</span>
        <span class="apple-badge" data-wake-id="${wakeText}">wakeId: ${wakeText}</span>
      </div>
    </div>
    <form class="chat-channel-form" data-form="plugin-chat-channel">
      <input type="text" name="channel" value="${safeChannel}" placeholder="console-chat:private:owner" aria-label="对话通道">
      <button type="submit">切换通道</button>
      <button type="button" data-action="chat-refresh">刷新</button>
    </form>
  </header>
  ${errorBanner}
  <div class="chat-messages-scroll" aria-label="对话消息列表">
    ${bubblesHtml}
  </div>
  <form class="chat-composer" data-form="plugin-chat-send">
    <input type="hidden" name="channel" value="${safeChannel}">
    <input type="text" name="text" value="" placeholder="发一条消息…" autocomplete="off" required>
    <button type="submit" class="primary">发送</button>
  </form>
</section>`
}

/**
 * Isomorphic server-side UI router connecting the console shell, page controllers,
 * dynamic kernel plugin pages, and the native console-chat experience.
 */
export function createConsoleAppRouter(deps: ConsoleAppRouterDeps): ConsoleAppRouter {
  const kernelRoot = deps.kernelApi?.baseUrl.replace(/\/+$/, '')

  const memoryController: MemoryPageController | null = deps.kernelApi === undefined
    ? null
    : createMemoryPageController(createHttpMemoryPageApi(deps.kernelApi.baseUrl, deps.kernelApi.token, deps.kernelApi.fetchImpl))
  const pluginsController: PluginsPageController | null = deps.kernelApi === undefined
    ? null
    : createPluginsPageController(createHttpPluginsPageApi(deps.kernelApi.baseUrl, deps.kernelApi.token, deps.kernelApi.fetchImpl))
  const satelliteController: SatellitePageController | null = deps.kernelApi === undefined
    ? null
    : createSatellitePageController(createHttpSatellitePageApi(deps.kernelApi.baseUrl, deps.kernelApi.token, deps.kernelApi.fetchImpl))
  const accountingController: AccountingPageController | null = deps.kernelApi === undefined
    ? null
    : createAccountingPageController(createHttpAccountingPageApi(deps.kernelApi.baseUrl, deps.kernelApi.token, deps.kernelApi.fetchImpl))

  let chatChannel = DEFAULT_CHAT_CHANNEL
  let chatLatestWakeId: string | undefined

  async function callKernel<T>(
    path: string,
    options: { readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; readonly body?: unknown } = {},
  ) {
    if (deps.kernelApi === undefined || kernelRoot === undefined) {
      throw new BrainError('UNAVAILABLE', 'kernelApi is not configured')
    }
    return apiFetch<T>(`${kernelRoot}${path}`, {
      token: deps.kernelApi.token,
      ...(options.method === undefined ? {} : { method: options.method }),
      ...(options.body === undefined ? {} : { body: options.body }),
      ...(deps.kernelApi.fetchImpl === undefined ? {} : { fetchImpl: deps.kernelApi.fetchImpl }),
    })
  }

  async function fetchPluginPages(): Promise<readonly KernelConsolePage[]> {
    if (deps.kernelApi === undefined) return []
    const res = await callKernel<{ readonly items?: readonly KernelConsolePage[] } | readonly KernelConsolePage[]>(
      '/api/v1/console/pages',
    )
    if (!res.ok) return []
    const data: unknown = res.data
    const rawItems = Array.isArray(data)
      ? data
      : (isRecord(data) && Array.isArray(data.items) ? data.items : [])
    const pages: KernelConsolePage[] = []
    for (const item of rawItems) {
      if (isRecord(item) && typeof item.pluginId === 'string' && typeof item.id === 'string'
        && typeof item.title === 'string' && typeof item.entry === 'string') {
        pages.push({
          pluginId: item.pluginId,
          id: item.id,
          title: item.title,
          entry: item.entry,
        })
      }
    }
    return pages
  }

  function buildNavItems(pages: readonly KernelConsolePage[]): readonly NavItem[] {
    const pluginItems: NavItem[] = pages.map((page) => ({
      id: `plugin:${page.pluginId}:${page.id}`,
      title: page.title,
      group: 'plugin',
    }))
    return [...deps.baseNavItems, ...pluginItems]
  }

  function hasControlChar(text: string): boolean {
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i)
      if (code <= 0x1f || code === 0x7f) return true
    }
    return false
  }

  function hasUnsafePluginPathSegment(candidate: string): boolean {
    const pathnameOnly = candidate.split(/[?#]/, 1)[0] ?? candidate
    for (const seg of pathnameOnly.split('/')) {
      if (seg === '..' || seg === '.') return true
      try {
        const decoded = decodeURIComponent(seg)
        if (decoded === '..' || decoded === '.' || decoded.includes('/') || decoded.includes('\\')) {
          return true
        }
      } catch {
        return true
      }
    }
    return false
  }

  function resolvePluginEntryPath(
    pluginId: string,
    rawEntry: string,
  ): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly message: string } {
    const safePluginId = pluginId.trim()
    if (
      safePluginId === ''
      || safePluginId === '.'
      || safePluginId === '..'
      || safePluginId.includes('/')
      || safePluginId.includes('\\')
    ) {
      return { ok: false, message: '非法的插件标识' }
    }
    const entry = rawEntry.trim()
    if (entry === '' || hasControlChar(entry) || entry.includes('\\') || entry.includes('//')) {
      return { ok: false, message: '非法的插件入口路径' }
    }
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(entry)) {
      return { ok: false, message: '插件入口路径禁止包含协议头' }
    }
    if (entry.startsWith('/')) {
      if (!entry.startsWith('/api/v1/plugins/') || entry === '/api/v1/plugins/' || hasUnsafePluginPathSegment(entry)) {
        return { ok: false, message: '插件入口路径必须位于 /api/v1/plugins/ 下' }
      }
      return { ok: true, path: entry }
    }
    if (entry.includes(':') || hasUnsafePluginPathSegment(entry)) {
      return { ok: false, message: '非法的插件相对入口路径' }
    }
    return { ok: true, path: `/api/v1/plugins/${encodeURIComponent(safePluginId)}/${entry}` }
  }

  async function fetchGenericPluginEntryHtml(
    pluginId: string,
    entry: string,
  ): Promise<{ readonly ok: true; readonly html: string } | { readonly ok: false; readonly message: string }> {
    if (deps.kernelApi === undefined || kernelRoot === undefined) {
      return { ok: false, message: 'kernelApi 未配置' }
    }
    const resolved = resolvePluginEntryPath(pluginId, entry)
    if (!resolved.ok) {
      return resolved
    }
    const fetchImpl = deps.kernelApi.fetchImpl ?? globalThis.fetch
    try {
      const response = await fetchImpl(`${kernelRoot}${resolved.path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${deps.kernelApi.token}` },
      })
      const text = await response.text()
      if (!response.ok) {
        return { ok: false, message: `加载插件页面失败（HTTP ${String(response.status)}）` }
      }
      if (text.trimStart().startsWith('{')) {
        try {
          const parsed = JSON.parse(text) as unknown
          if (isRecord(parsed) && parsed.ok === true && typeof parsed.data === 'string') {
            return { ok: true, html: parsed.data }
          }
        } catch {
          // Treat as raw HTML if JSON parsing fails.
        }
      }
      return { ok: true, html: text }
    } catch (error) {
      return { ok: false, message: errorText(error) }
    }
  }

  async function renderConsoleChatView(): Promise<string> {
    if (deps.kernelApi === undefined) {
      return renderKernelMissingNotice('与她对话')
    }
    const res = await callKernel<ChatMessagesPayload>(
      `/api/v1/plugins/console-chat/messages?channel=${encodeURIComponent(chatChannel)}`,
    )
    if (!res.ok) {
      return renderConsoleChatPanel({
        channel: chatChannel,
        items: [],
        unreadCount: 0,
        ...(chatLatestWakeId === undefined ? {} : { latestWakeId: chatLatestWakeId }),
        loadError: `${res.code}: ${res.message}`,
      })
    }
    const items = Array.isArray(res.data?.items) ? res.data.items : []
    const unreadCount = typeof res.data?.unreadCount === 'number' ? res.data.unreadCount : 0
    const activeChannel = typeof res.data?.channel === 'string' && res.data.channel !== '' ? res.data.channel : chatChannel
    return renderConsoleChatPanel({
      channel: activeChannel,
      items,
      unreadCount,
      ...(chatLatestWakeId === undefined ? {} : { latestWakeId: chatLatestWakeId }),
    })
  }

  async function renderPluginPage(pageId: string, pages: readonly KernelConsolePage[]): Promise<string> {
    const parsed = parsePluginPageId(pageId)
    if (parsed === null) {
      return '<section class="glass-card"><h2>未知插件页面</h2></section>'
    }
    if (parsed.pluginId === 'console-chat') {
      return renderConsoleChatView()
    }
    const match = pages.find((p) => p.pluginId === parsed.pluginId && p.id === parsed.subPageId)
    if (match === undefined) {
      return `<section class="glass-card"><h2>插件页面未找到</h2><p class="login-hint">${escapeHtml(pageId)}</p></section>`
    }
    const fetched = await fetchGenericPluginEntryHtml(match.pluginId, match.entry)
    if (!fetched.ok) {
      return `<section class="glass-card"><h2>${escapeHtml(match.title)}</h2><div class="status-banner" data-tone="warning">${escapeHtml(fetched.message)}</div></section>`
    }
    return `<section class="glass-card plugin-embed-card">
  <header class="memory-item-header">
    <h2>${escapeHtml(match.title)}</h2>
    <span class="apple-badge mono">${escapeHtml(match.pluginId)}</span>
  </header>
  <iframe class="plugin-iframe" sandbox="" srcdoc="${escapeHtml(fetched.html)}" title="${escapeHtml(match.title)}"></iframe>
</section>`
  }

  async function refreshPageData(pageId: string): Promise<void> {
    if (pageId === 'memory' && memoryController !== null) {
      const state = memoryController.state()
      if (state.subView === 'consolidation') {
        await memoryController.loadConsolidationWorkspace()
      } else {
        await Promise.all([
          state.searchQuery === null ? memoryController.browse(state.filter) : Promise.resolve(),
          memoryController.loadCrossChannelPanel(),
          memoryController.loadPersons(),
        ])
      }
      return
    }
    if (pageId === 'satellite' && satelliteController !== null) {
      const subView = satelliteController.state().activeSubView
      if (subView === 'accounting' && accountingController !== null) {
        await accountingController.load()
      } else if (subView === 'interop') {
        await satelliteController.refreshInterop()
      } else {
        await satelliteController.refresh()
      }
      return
    }
    if (pageId === 'plugins' && pluginsController !== null) {
      await pluginsController.refresh().catch(() => undefined)
    }
  }

  async function renderMainForPage(
    pageId: string,
    settingsView: ConsoleSettingsView,
    pages: readonly KernelConsolePage[],
  ): Promise<{ readonly activePageId: string; readonly mainHtml: string }> {
    if (pageId === 'settings' || pageId === '') {
      return { activePageId: 'settings', mainHtml: renderSettingsPanel(settingsView) }
    }
    if (pageId === 'memory') {
      const mainHtml = memoryController === null
        ? renderKernelMissingNotice('记忆管理')
        : renderMemoryPage(memoryController.state())
      return { activePageId: 'memory', mainHtml }
    }
    if (pageId === 'satellite') {
      let mainHtml: string
      if (satelliteController === null) {
        mainHtml = renderKernelMissingNotice('运行状态')
      } else {
        const satState = satelliteController.state()
        const accountingHtml = satState.activeSubView === 'accounting' && accountingController !== null
          ? renderAccountingView(accountingController.state())
          : undefined
        mainHtml = renderSatellitePage(satState, accountingHtml === undefined ? {} : { accountingHtml })
      }
      return { activePageId: 'satellite', mainHtml }
    }
    if (pageId === 'plugins') {
      const mainHtml = pluginsController === null
        ? renderKernelMissingNotice('插件与权限')
        : renderPluginsPage(pluginsController.state())
      return { activePageId: 'plugins', mainHtml }
    }
    if (pageId.startsWith('plugin:')) {
      return { activePageId: pageId, mainHtml: await renderPluginPage(pageId, pages) }
    }
    return { activePageId: 'settings', mainHtml: renderSettingsPanel(settingsView) }
  }

  async function buildState(pageId: string, toast?: UiToast): Promise<ConsoleUiState> {
    const [settingsView, pages] = await Promise.all([
      deps.getSettingsView(),
      fetchPluginPages(),
    ])
    const navItems = buildNavItems(pages)
    const rendered = await renderMainForPage(pageId, settingsView, pages)
    return {
      activePageId: rendered.activePageId,
      navItems,
      roleCardName: settingsView.roleCard?.name ?? null,
      sharedQuotaWarning: settingsView.sharedQuotaWarning,
      mainHtml: rendered.mainHtml,
      ...(toast === undefined ? {} : { toast }),
    }
  }

  function requireMemoryController(): MemoryPageController {
    if (memoryController === null) throw new BrainError('UNAVAILABLE', 'kernelApi is not configured')
    return memoryController
  }

  function requirePluginsController(): PluginsPageController {
    if (pluginsController === null) throw new BrainError('UNAVAILABLE', 'kernelApi is not configured')
    return pluginsController
  }

  function requireSatelliteController(): SatellitePageController {
    if (satelliteController === null) throw new BrainError('UNAVAILABLE', 'kernelApi is not configured')
    return satelliteController
  }

  function requireAccountingController(): AccountingPageController {
    if (accountingController === null) throw new BrainError('UNAVAILABLE', 'kernelApi is not configured')
    return accountingController
  }

  return {
    async getState(page = 'settings'): Promise<ConsoleUiState> {
      const targetPage = stringOf(page) === '' ? 'settings' : stringOf(page)
      await refreshPageData(targetPage)
      return buildState(targetPage)
    },

    async handleAction(body: unknown): Promise<ConsoleUiState> {
      if (!isRecord(body)) {
        throw new BrainError('INVALID_ARGUMENT', 'body must be an object', { field: '' })
      }
      const action = stringOf(body.action)
      if (action === '') {
        throw new BrainError('INVALID_ARGUMENT', 'action is required', { field: 'action' })
      }
      const page = stringOf(body.page) === '' ? 'settings' : stringOf(body.page)
      const payload = isRecord(body.payload) ? body.payload : {}

      let targetPage = page
      let toast: UiToast | undefined

      try {
        switch (action) {
          case 'save-model': {
            targetPage = 'settings'
            await deps.saveModelSelection(payload)
            toast = { tone: 'ok', message: '模型设置已保存' }
            break
          }
          case 'save-secret': {
            targetPage = 'settings'
            await deps.saveSecret(payload)
            toast = { tone: 'ok', message: '密钥已保存' }
            break
          }
          case 'select-role-card': {
            targetPage = 'settings'
            const name = stringOf(payload.name)
            await deps.saveRoleCard({ mode: 'select', name })
            toast = { tone: 'ok', message: `已切换角色卡：${name}` }
            break
          }
          case 'save-role-interview': {
            targetPage = 'settings'
            const interview = isRecord(payload.interview) ? payload.interview : payload
            const result = await deps.saveRoleCard({ mode: 'interview', interview }) as { readonly name?: string }
            toast = { tone: 'ok', message: `已保存角色卡：${result?.name ?? ''}` }
            break
          }
          case 'save-role-raw': {
            targetPage = 'settings'
            await deps.saveRoleCard({ mode: 'raw', name: payload.name, text: payload.text })
            toast = { tone: 'ok', message: '原始角色卡已保存' }
            break
          }

          case 'switch-memory-subview': {
            targetPage = 'memory'
            const ctrl = requireMemoryController()
            const subView = payload.subView === 'consolidation' ? 'consolidation' : 'browse'
            ctrl.switchSubView(subView as MemorySubView)
            await refreshPageData('memory')
            break
          }
          case 'filter-memory': {
            targetPage = 'memory'
            const ctrl = requireMemoryController()
            const layer = parseLayer(payload.layer)
            const personId = stringOf(payload.personId)
            const channel = stringOf(payload.channel)
            const filter: MemoryBrowseFilter = {
              ...(layer === undefined ? {} : { layer }),
              ...(personId === '' ? {} : { personId }),
              ...(channel === '' ? {} : { channel }),
            }
            await ctrl.browse(filter)
            break
          }
          case 'reset-memory-filter': {
            targetPage = 'memory'
            const ctrl = requireMemoryController()
            await ctrl.browse({})
            toast = { tone: 'info', message: '已重置记忆筛选条件' }
            break
          }
          case 'load-next-memory-page': {
            targetPage = 'memory'
            const ctrl = requireMemoryController()
            await ctrl.loadNextPage()
            break
          }
          case 'search-memory': {
            targetPage = 'memory'
            const ctrl = requireMemoryController()
            const query = stringOf(payload.query)
            if (query === '') {
              await ctrl.browse(ctrl.state().filter)
            } else {
              await ctrl.search(query)
            }
            break
          }
          case 'select-record': {
            targetPage = 'memory'
            const ctrl = requireMemoryController()
            const recordId = stringOf(payload.recordId)
            if (recordId === '') throw new BrainError('INVALID_ARGUMENT', 'recordId is required', { field: 'recordId' })
            await ctrl.selectRecord(recordId)
            break
          }
          case 'mark-outdated': {
            targetPage = 'memory'
            const ctrl = requireMemoryController()
            const recordId = stringOf(payload.recordId)
            const version = Number(payload.version)
            if (recordId === '' || !Number.isFinite(version)) {
              throw new BrainError('INVALID_ARGUMENT', 'recordId and version are required')
            }
            const ok = await ctrl.markOutdated(recordId, version)
            toast = ok
              ? { tone: 'ok', message: '已标记为过时' }
              : { tone: 'warning', message: ctrl.state().conflictWarning ?? ctrl.state().errorMessage ?? '标记过时失败' }
            break
          }
          case 'request-forget': {
            targetPage = 'memory'
            const ctrl = requireMemoryController()
            const recordId = stringOf(payload.recordId)
            if (recordId === '') throw new BrainError('INVALID_ARGUMENT', 'recordId is required', { field: 'recordId' })
            await ctrl.requestForgetRecord(recordId)
            break
          }
          case 'confirm-forget': {
            targetPage = 'memory'
            const ctrl = requireMemoryController()
            const report = await ctrl.confirmForget()
            await ctrl.browse(ctrl.state().filter)
            toast = { tone: 'ok', message: `已完成遗忘：tombstoned=${String(report.tombstoned)}` }
            break
          }
          case 'cancel-forget': {
            targetPage = 'memory'
            const ctrl = requireMemoryController()
            ctrl.cancelForget()
            break
          }
          case 'set-cross-channel': {
            targetPage = 'memory'
            const ctrl = requireMemoryController()
            const mode = stringOf(payload.mode)
            if (mode !== 'off' && mode !== 'shadow' && mode !== 'on') {
              throw new BrainError('INVALID_ARGUMENT', 'invalid cross-channel mode', { field: 'mode' })
            }
            await ctrl.changeCrossChannelMode(mode as CrossChannelMode)
            toast = { tone: 'ok', message: `跨通道模式已切换为 ${mode}` }
            break
          }
          case 'merge-person': {
            targetPage = 'memory'
            const ctrl = requireMemoryController()
            const from = stringOf(payload.from)
            const into = stringOf(payload.into)
            if (from === '' || into === '') {
              throw new BrainError('INVALID_ARGUMENT', 'from 与 into 人物 ID 均不能为空')
            }
            await ctrl.mergePerson(from, into)
            if (ctrl.state().errorMessage === null) {
              toast = { tone: 'ok', message: `已将 ${from} 合并至 ${into}` }
            }
            break
          }
          case 'split-person': {
            targetPage = 'memory'
            const ctrl = requireMemoryController()
            const personId = stringOf(payload.personId)
            const accountsRaw = Array.isArray(payload.accounts)
              ? payload.accounts.map((a) => stringOf(a)).filter((a) => a !== '')
              : stringOf(payload.accounts).split(',').map((a) => a.trim()).filter((a) => a !== '')
            if (personId === '' || accountsRaw.length === 0) {
              throw new BrainError('INVALID_ARGUMENT', '需要填写人物 ID 和至少一个拆出账号')
            }
            const createdId = await ctrl.splitPerson(personId, accountsRaw)
            toast = { tone: 'ok', message: `已拆出新人物：${createdId}` }
            break
          }
          case 'trigger-consolidation': {
            targetPage = 'memory'
            const ctrl = requireMemoryController()
            await ctrl.triggerShadowConsolidation()
            if (ctrl.state().errorMessage === null) {
              toast = { tone: 'ok', message: '夜间影子归纳已生成新提案' }
            }
            break
          }
          case 'choose-conflict-keep': {
            targetPage = 'memory'
            const ctrl = requireMemoryController()
            const conflictId = stringOf(payload.conflictId)
            const keepRecordId = stringOf(payload.keepRecordId)
            if (conflictId === '' || keepRecordId === '') {
              throw new BrainError('INVALID_ARGUMENT', 'conflictId and keepRecordId are required')
            }
            ctrl.chooseConflictKeep(conflictId, keepRecordId)
            break
          }
          case 'approve-proposal': {
            targetPage = 'memory'
            const ctrl = requireMemoryController()
            const proposalId = stringOf(payload.proposalId)
            if (proposalId === '') throw new BrainError('INVALID_ARGUMENT', 'proposalId is required')
            const ok = await ctrl.approveProposal(proposalId)
            toast = ok
              ? { tone: 'ok', message: '提案已生效并更新 L3 画像' }
              : { tone: 'warning', message: ctrl.state().errorMessage ?? '提案生效失败' }
            break
          }
          case 'reject-proposal': {
            targetPage = 'memory'
            const ctrl = requireMemoryController()
            const proposalId = stringOf(payload.proposalId)
            if (proposalId === '') throw new BrainError('INVALID_ARGUMENT', 'proposalId is required')
            const ok = await ctrl.rejectProposal(proposalId)
            toast = ok
              ? { tone: 'info', message: '提案已驳回' }
              : { tone: 'warning', message: ctrl.state().errorMessage ?? '驳回失败' }
            break
          }
          case 'compare-l3': {
            targetPage = 'memory'
            const ctrl = requireMemoryController()
            const versions = ctrl.state().l3Versions
            let from: number
            let to: number
            if (payload.from !== undefined && payload.to !== undefined) {
              from = Number(payload.from)
              to = Number(payload.to)
            } else {
              const target = Number(payload.version)
              const current = versions.find((v) => v.current) ?? versions[0]
              if (current !== undefined && current.version !== target) {
                from = Math.min(target, current.version)
                to = Math.max(target, current.version)
              } else {
                const other = versions.find((v) => v.version !== target)
                from = other === undefined ? Math.max(1, target - 1) : Math.min(target, other.version)
                to = other === undefined ? target : Math.max(target, other.version)
              }
            }
            await ctrl.compareL3Versions(from, to)
            break
          }
          case 'rollback-l3': {
            targetPage = 'memory'
            const ctrl = requireMemoryController()
            const version = Number(payload.version)
            if (!Number.isFinite(version)) throw new BrainError('INVALID_ARGUMENT', 'version is required')
            const ok = await ctrl.rollbackL3(version)
            toast = ok
              ? { tone: 'ok', message: `已回滚至 L3 v${String(version)}` }
              : { tone: 'warning', message: ctrl.state().errorMessage ?? '回滚失败' }
            break
          }
          case 'save-owner-l3': {
            targetPage = 'memory'
            const ctrl = requireMemoryController()
            const stable = typeof payload.stable === 'string' ? payload.stable : undefined
            let dataObj: Record<string, unknown>
            if (isRecord(payload.data)) {
              dataObj = payload.data
            } else {
              const rawJson = typeof payload.dataJson === 'string' && payload.dataJson.trim() !== '' ? payload.dataJson : '{}'
              let parsed: unknown
              try {
                parsed = JSON.parse(rawJson)
              } catch {
                throw new BrainError('INVALID_ARGUMENT', '结构化画像 data 必须是合法 JSON 对象')
              }
              if (!isRecord(parsed)) {
                throw new BrainError('INVALID_ARGUMENT', '结构化画像 data 必须是 JSON 对象')
              }
              dataObj = parsed
            }
            const lockedKeys = Array.isArray(payload.lockedKeys)
              ? payload.lockedKeys.map((k) => stringOf(k)).filter((k) => k !== '')
              : typeof payload.lockedKeys === 'string'
                ? payload.lockedKeys.split(',').map((k) => k.trim()).filter((k) => k !== '')
                : []
            const ok = await ctrl.saveOwnerL3({
              ...(stable === undefined ? {} : { stable }),
              data: dataObj,
              lockedKeys,
            })
            toast = ok
              ? { tone: 'ok', message: '已保存为主人钦定 L3 版本' }
              : { tone: 'warning', message: ctrl.state().errorMessage ?? '保存失败' }
            break
          }

          case 'switch-satellite-subview': {
            targetPage = 'satellite'
            const ctrl = requireSatelliteController()
            const subView = payload.subView === 'accounting' || payload.subView === 'interop'
              ? payload.subView
              : 'runtime'
            ctrl.setSubView(subView as SatelliteSubView)
            await refreshPageData('satellite')
            break
          }
          case 'restart-agent': {
            targetPage = 'satellite'
            const ctrl = requireSatelliteController()
            const agentClass = stringOf(payload.agentClass)
            if (agentClass !== 'chat' && agentClass !== 'activity') {
              throw new BrainError('INVALID_ARGUMENT', 'agentClass must be chat or activity')
            }
            await ctrl.restart(agentClass as AgentClass)
            if (ctrl.state().errorMessage === null) {
              toast = { tone: 'ok', message: `已请求重启 ${agentClass} 进程` }
            }
            break
          }
          case 'run-doctor': {
            targetPage = 'satellite'
            const ctrl = requireSatelliteController()
            const result = await ctrl.runDoctor()
            toast = result.ok
              ? { tone: 'ok', message: '隔离检查通过' }
              : { tone: 'warning', message: `隔离检查发现 ${String(result.problems.length)} 项问题` }
            break
          }
          case 'set-accounting-days': {
            targetPage = 'satellite'
            const sat = requireSatelliteController()
            sat.setSubView('accounting')
            const acc = requireAccountingController()
            const rawDays = Number(payload.days)
            const days: AccountingPeriodDays = rawDays === 14 ? 14 : rawDays === 30 ? 30 : 7
            await acc.setDays(days)
            break
          }
          case 'save-price-book': {
            targetPage = 'satellite'
            const sat = requireSatelliteController()
            sat.setSubView('accounting')
            const acc = requireAccountingController()
            const currency = stringOf(payload.currency)
            if (currency === '') throw new BrainError('INVALID_ARGUMENT', '计价币种不能为空')
            if (!isRecord(payload.models)) throw new BrainError('INVALID_ARGUMENT', 'models must be an object')
            const models: Record<string, ModelPriceEntry> = {}
            for (const [key, entry] of Object.entries(payload.models)) {
              models[key] = parsePriceEntry(entry, key)
            }
            const book: ModelPriceBook = { version: 1, currency, models }
            const ok = await acc.savePrices(book)
            toast = ok
              ? { tone: 'ok', message: '价格配置已保存' }
              : { tone: 'warning', message: acc.state().errorMessage ?? '保存价格失败' }
            break
          }
          case 'save-budget-limits': {
            targetPage = 'satellite'
            const sat = requireSatelliteController()
            sat.setSubView('accounting')
            const acc = requireAccountingController()
            const dailyTokenLimit = parseOptionalPositiveInt(payload.dailyTokenLimit, 'dailyTokenLimit')
            const dailyCostMicrosLimit = parseOptionalPositiveInt(payload.dailyCostMicrosLimit, 'dailyCostMicrosLimit')
            const pluginDailyTokenLimit = parseOptionalPositiveInt(payload.pluginDailyTokenLimit, 'pluginDailyTokenLimit')
            const cfg: AccountingBudgetConfig = {
              ...(dailyTokenLimit === undefined ? {} : { dailyTokenLimit }),
              ...(dailyCostMicrosLimit === undefined ? {} : { dailyCostMicrosLimit }),
              ...(pluginDailyTokenLimit === undefined ? {} : { pluginDailyTokenLimit }),
            }
            const ok = await acc.saveBudget(cfg)
            toast = ok
              ? { tone: 'ok', message: '日限额预算已保存' }
              : { tone: 'warning', message: acc.state().errorMessage ?? '保存预算失败' }
            break
          }
          case 'toggle-amp': {
            targetPage = 'satellite'
            const ctrl = requireSatelliteController()
            ctrl.setSubView('interop')
            const enabled = Boolean(payload.enabled)
            await ctrl.toggleAmpAliases(enabled)
            if (ctrl.state().errorMessage === null) {
              toast = { tone: 'ok', message: enabled ? 'AMP 别名已开启' : 'AMP 别名已关闭' }
            }
            break
          }
          case 'toggle-mcp': {
            targetPage = 'satellite'
            const ctrl = requireSatelliteController()
            ctrl.setSubView('interop')
            const enabled = Boolean(payload.enabled)
            await ctrl.toggleReadOnlyMcp(enabled)
            if (ctrl.state().errorMessage === null) {
              toast = { tone: 'ok', message: enabled ? '只读 MCP 已开启' : '只读 MCP 已关闭' }
            }
            break
          }
          case 'start-debug-view': {
            targetPage = 'satellite'
            const ctrl = requireSatelliteController()
            ctrl.setSubView('interop')
            await ctrl.startDebugView()
            if (ctrl.state().errorMessage === null) {
              toast = { tone: 'ok', message: '隔离调试视图已启动' }
            }
            break
          }
          case 'stop-debug-view': {
            targetPage = 'satellite'
            const ctrl = requireSatelliteController()
            ctrl.setSubView('interop')
            await ctrl.stopDebugView()
            if (ctrl.state().errorMessage === null) {
              toast = { tone: 'info', message: '隔离调试视图已停止' }
            }
            break
          }

          case 'start-install': {
            targetPage = 'plugins'
            const ctrl = requirePluginsController()
            const spec = stringOf(payload.spec)
            if (spec === '') throw new BrainError('INVALID_ARGUMENT', '请输入插件安装 spec')
            await ctrl.startInstall(spec)
            toast = { tone: 'info', message: '请确认插件申请的权限' }
            break
          }
          case 'confirm-install': {
            targetPage = 'plugins'
            const ctrl = requirePluginsController()
            await ctrl.confirmInstall()
            toast = { tone: 'ok', message: '插件已批准并启用' }
            break
          }
          case 'cancel-install': {
            targetPage = 'plugins'
            const ctrl = requirePluginsController()
            ctrl.cancelInstall()
            toast = { tone: 'info', message: '已取消安装' }
            break
          }
          case 'enable-plugin': {
            targetPage = 'plugins'
            const ctrl = requirePluginsController()
            const id = stringOf(payload.id)
            if (id === '') throw new BrainError('INVALID_ARGUMENT', 'plugin id is required')
            await ctrl.enable(id)
            toast = { tone: 'ok', message: `插件 ${id} 已启用` }
            break
          }
          case 'disable-plugin': {
            targetPage = 'plugins'
            const ctrl = requirePluginsController()
            const id = stringOf(payload.id)
            if (id === '') throw new BrainError('INVALID_ARGUMENT', 'plugin id is required')
            await ctrl.disable(id)
            toast = { tone: 'info', message: `插件 ${id} 已停用` }
            break
          }
          case 'start-upgrade': {
            targetPage = 'plugins'
            const ctrl = requirePluginsController()
            const id = stringOf(payload.id)
            const spec = stringOf(payload.spec)
            if (id === '' || spec === '') throw new BrainError('INVALID_ARGUMENT', '插件 ID 与升级 spec 不能为空')
            await ctrl.startUpgrade(id, spec)
            const st = ctrl.state()
            if (st.rollbackNotice !== null) {
              toast = { tone: 'warning', message: st.rollbackNotice }
            } else if (st.pendingUpgrade !== null) {
              toast = { tone: 'info', message: '升级涉及新权限，请确认' }
            } else {
              toast = { tone: 'ok', message: `插件 ${id} 升级完成` }
            }
            break
          }
          case 'confirm-upgrade': {
            targetPage = 'plugins'
            const ctrl = requirePluginsController()
            await ctrl.confirmUpgrade()
            const st = ctrl.state()
            toast = st.rollbackNotice !== null
              ? { tone: 'warning', message: st.rollbackNotice }
              : { tone: 'ok', message: '插件升级已确认生效' }
            break
          }
          case 'cancel-upgrade': {
            targetPage = 'plugins'
            const ctrl = requirePluginsController()
            ctrl.cancelUpgrade()
            toast = { tone: 'info', message: '已取消升级' }
            break
          }
          case 'uninstall-plugin': {
            targetPage = 'plugins'
            const ctrl = requirePluginsController()
            const id = stringOf(payload.id)
            if (id === '') throw new BrainError('INVALID_ARGUMENT', 'plugin id is required')
            await ctrl.uninstall(id, { keepData: Boolean(payload.keepData) })
            toast = { tone: 'info', message: `已卸载插件 ${id}` }
            break
          }
          case 'run-check': {
            targetPage = 'plugins'
            const ctrl = requirePluginsController()
            const dir = stringOf(payload.dir)
            if (dir === '') throw new BrainError('INVALID_ARGUMENT', '请输入插件目录路径')
            const report = await ctrl.runCheck(dir)
            toast = report.ok
              ? { tone: 'ok', message: '插件规范检查通过' }
              : { tone: 'warning', message: '插件规范检查发现问题' }
            break
          }

          case 'chat-send': {
            targetPage = page.startsWith('plugin:console-chat:') ? page : 'plugin:console-chat:chat'
            const text = stringOf(payload.text)
            if (text === '') throw new BrainError('INVALID_ARGUMENT', '请输入消息内容')
            const nextChannel = stringOf(payload.channel)
            if (nextChannel !== '') chatChannel = nextChannel
            const res = await callKernel<{ readonly wake?: { readonly wakeId?: string; readonly outcome?: string } }>(
              '/api/v1/plugins/console-chat/messages',
              { method: 'POST', body: { channel: chatChannel, text } },
            )
            if (!res.ok) {
              toast = { tone: 'warning', message: `${res.code}: ${res.message}` }
            } else {
              if (typeof res.data?.wake?.wakeId === 'string') {
                chatLatestWakeId = res.data.wake.wakeId
              }
              toast = { tone: 'ok', message: '已发送' }
            }
            break
          }
          case 'chat-refresh': {
            targetPage = page.startsWith('plugin:console-chat:') ? page : 'plugin:console-chat:chat'
            const nextChannel = stringOf(payload.channel)
            if (nextChannel !== '') chatChannel = nextChannel
            break
          }
          case 'chat-switch-channel': {
            targetPage = page.startsWith('plugin:console-chat:') ? page : 'plugin:console-chat:chat'
            const nextChannel = stringOf(payload.channel)
            if (nextChannel === '') throw new BrainError('INVALID_ARGUMENT', '通道不能为空')
            chatChannel = nextChannel
            toast = { tone: 'info', message: `已切换对话通道：${chatChannel}` }
            break
          }
          case 'jump-to-memory-record': {
            targetPage = 'memory'
            const recordId = stringOf(payload.recordId)
            if (recordId === '') throw new BrainError('INVALID_ARGUMENT', 'recordId is required')
            const ctrl = requireMemoryController()
            ctrl.switchSubView('browse')
            await Promise.all([
              ctrl.state().items.length === 0 ? ctrl.browse(ctrl.state().filter) : Promise.resolve(),
              ctrl.loadCrossChannelPanel(),
              ctrl.loadPersons(),
            ])
            await ctrl.selectRecord(recordId)
            toast = ctrl.state().selectedRecord === null
              ? { tone: 'warning', message: `未找到记忆记录：${recordId}` }
              : { tone: 'info', message: `已定位记忆记录：${recordId}` }
            break
          }

          default:
            throw new BrainError('INVALID_ARGUMENT', `unknown action: ${action}`, { field: 'action' })
        }
      } catch (error) {
        if (error instanceof BrainError && error.details?.field === 'action') {
          throw error
        }
        toast = { tone: 'warning', message: errorText(error) }
      }

      if (toast === undefined) {
        if (targetPage === 'memory' && memoryController !== null) {
          const err = memoryController.state().conflictWarning ?? memoryController.state().errorMessage
          if (err !== null) toast = { tone: 'warning', message: err }
        } else if (targetPage === 'satellite' && satelliteController !== null) {
          const err = satelliteController.state().errorMessage
            ?? (satelliteController.state().activeSubView === 'accounting' ? accountingController?.state().errorMessage ?? null : null)
          if (err !== null) toast = { tone: 'warning', message: err }
        } else if (targetPage === 'plugins' && pluginsController !== null) {
          const err = pluginsController.state().errorMessage
          if (err !== null) toast = { tone: 'warning', message: err }
        }
      }

      return buildState(targetPage, toast)
    },
  }
}
