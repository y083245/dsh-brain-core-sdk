import { escapeHtml } from '../../shell/theme.ts'
import type { PluginsPageState } from './controller.ts'
import type {
  ChannelCoreBudget,
  CheckReport,
  ConsoleInstallPreview,
  ConsolePluginItem,
  PluginLifecycleState,
} from './types.ts'

const STATE_META: Readonly<Record<PluginLifecycleState, { readonly label: string; readonly color: string }>> = {
  discovered: { label: '本地发现', color: '#64D2FF' },
  enabled: { label: '已启用', color: '#30D158' },
  disabled: { label: '已停用', color: '#8E8E93' },
  pending: { label: '待确认', color: '#FF9F0A' },
  failed: { label: '异常', color: '#FF453A' },
}

function isLanPermission(permission: string): boolean {
  return permission.startsWith('lan:') || permission.startsWith('lan:config:')
}

function renderPermissionBadge(permission: string): string {
  const escaped = escapeHtml(permission)
  if (isLanPermission(permission)) {
    return `<span class="apple-badge mono" data-lan="true" style="border: 1px solid #FF9F0A; background: rgba(255, 159, 10, 0.18);">内网访问 · ${escaped}</span>`
  }
  return `<span class="apple-badge mono">${escaped}</span>`
}

function renderPermissionsList(permissions: readonly string[]): string {
  if (permissions.length === 0) {
    return '<span class="apple-badge">无权限</span>'
  }
  return permissions.map(renderPermissionBadge).join(' ')
}

function renderPermissionModal(
  mode: 'install' | 'upgrade',
  preview: ConsoleInstallPreview,
): string {
  const title = mode === 'install' ? '安装权限确认' : '升级权限确认'
  const confirmAction = mode === 'install' ? 'confirm-install' : 'confirm-upgrade'
  const cancelAction = mode === 'install' ? 'cancel-install' : 'cancel-upgrade'

  const newPermsHtml = preview.newPermissions.length > 0
    ? `<div data-role="new-permissions"><strong>新增权限：</strong>${renderPermissionsList(preview.newPermissions)}</div>`
    : ''

  const warningsHtml = preview.warnings.length > 0
    ? `<div class="status-banner" data-tone="warning" data-role="preview-warnings"><ul>${preview.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul></div>`
    : ''

  return `<section class="glass-card" data-role="permission-modal" data-mode="${mode}" style="border-color: #0A84FF;">
  <h3>${title}：<span class="mono">${escapeHtml(preview.id)}</span> <span class="apple-badge mono">v${escapeHtml(preview.version)}</span></h3>
  <div data-role="requested-permissions"><strong>全部申请权限：</strong>${renderPermissionsList(preview.permissions)}</div>
  ${newPermsHtml}
  ${warningsHtml}
  <div class="actions">
    <button type="button" class="primary" data-action="${confirmAction}">批准权限并启用</button>
    <button type="button" data-action="${cancelAction}">取消</button>
  </div>
</section>`
}

function renderPluginCard(plugin: ConsolePluginItem): string {
  const meta = STATE_META[plugin.state]
  const idAttr = escapeHtml(plugin.id)
  const checkBadge = plugin.checkPassed
    ? '<span class="apple-badge" data-check="passed" style="color: #30D158;">符合规范</span>'
    : '<span class="apple-badge" data-check="failed" style="color: #FF453A;">未通过检查</span>'
  const updateBadge = plugin.updateAvailable === undefined
    ? ''
    : `<span class="apple-badge" data-role="update-available">有本地更新 v${escapeHtml(plugin.updateAvailable.version)}</span>`
  const kindsText = plugin.kinds.map((k) => escapeHtml(k)).join(', ')

  return `<article class="glass-card" data-plugin-id="${idAttr}">
  <header>
    <strong class="mono">${idAttr}</strong>
    <span class="apple-badge mono">v${escapeHtml(plugin.version)}</span>
    <span class="apple-badge" data-state="${escapeHtml(plugin.state)}" style="color: ${meta.color};">${meta.label}</span>
    ${updateBadge}
    ${checkBadge}
    <span class="apple-badge mono">${escapeHtml(plugin.runtime)}</span>
    <span class="apple-badge">${kindsText || '-'}</span>
  </header>
  <div data-role="granted-permissions">已批准权限：${renderPermissionsList(plugin.granted)}</div>
  <div class="actions">
    <button type="button" data-action="enable" data-plugin-id="${idAttr}">启用</button>
    <button type="button" data-action="disable" data-plugin-id="${idAttr}">停用</button>
    <input type="text" class="upgrade-spec-input" data-upgrade-spec-for="${idAttr}" value="" placeholder="升级 spec（可选）">
    <button type="button" data-action="upgrade" data-plugin-id="${idAttr}">升级</button>
    <button type="button" data-action="uninstall-keep-data" data-keep-data="true" data-plugin-id="${idAttr}">保留私有数据</button>
    <button type="button" data-action="uninstall-delete-data" data-keep-data="false" data-plugin-id="${idAttr}">删除私有数据</button>
  </div>
</article>`
}

function renderPluginsList(plugins: readonly ConsolePluginItem[]): string {
  if (plugins.length === 0) {
    return '<section class="glass-card" data-role="plugins-empty"><p>暂无已安装插件。</p></section>'
  }
  return `<div data-role="plugins-list">${plugins.map(renderPluginCard).join('')}</div>`
}

function renderCheckReport(target: string, report: CheckReport): string {
  const overallBadge = report.ok
    ? '<span class="apple-badge" style="color: #30D158;">通过</span>'
    : '<span class="apple-badge" style="color: #FF453A;">未通过</span>'

  const manifestHtml = report.manifest.ok
    ? `<div data-role="manifest-result"><span class="apple-badge" style="color: #30D158;">manifest 通过</span> <span class="mono">${escapeHtml(report.manifest.manifest.id)}</span></div>`
    : `<div data-role="manifest-result"><span class="apple-badge" style="color: #FF453A;">manifest 未通过</span><ul>${report.manifest.errors.map((e) => `<li><span class="mono">${escapeHtml(e.field)}</span>: ${escapeHtml(e.message)}</li>`).join('')}</ul></div>`

  const contractHtml = `<ul data-role="contract-results">${report.contract.map((c) => {
    const status = c.ok ? 'PASS' : 'FAIL'
    return `<li><span class="apple-badge">${status}</span> <span class="mono">${escapeHtml(c.name)}</span>: ${escapeHtml(c.message)}</li>`
  }).join('')}</ul>`

  const findingsHtml = report.findings.length === 0
    ? '<p data-role="findings-empty">无静态扫描问题。</p>'
    : `<ul data-role="findings-list">${report.findings.map((f) => {
        const location = f.file === undefined
          ? ''
          : `<span class="mono">${escapeHtml(f.file)}${f.line === undefined ? '' : `:${String(f.line)}`}</span> `
        return `<li><span class="apple-badge">${escapeHtml(f.level)}</span> <span class="mono">${escapeHtml(f.rule)}</span> ${location}${escapeHtml(f.message)}</li>`
      }).join('')}</ul>`

  const notesHtml = report.notes.length === 0
    ? ''
    : `<ul data-role="check-notes">${report.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`

  return `<section class="glass-card" data-role="check-report">
  <h3>规范检查报告 <span class="mono">${escapeHtml(target)}</span> ${overallBadge}</h3>
  ${manifestHtml}
  ${contractHtml}
  ${findingsHtml}
  ${notesHtml}
</section>`
}

function renderToolCatalog(plugins: readonly ConsolePluginItem[]): string {
  const rows: string[] = []
  for (const plugin of plugins) {
    const activeLabel = plugin.state === 'enabled' ? '启用中' : '未启用'
    for (const tool of plugin.tools) {
      const fullName = `${plugin.id}__${tool.name}`
      rows.push(`<tr data-tool-name="${escapeHtml(fullName)}" data-plugin-state="${escapeHtml(plugin.state)}">
  <td class="mono">${escapeHtml(fullName)}</td>
  <td><span class="apple-badge">${escapeHtml(tool.load)}</span></td>
  <td><span class="apple-badge">${escapeHtml(tool.effect)}</span></td>
  <td class="mono">${escapeHtml(tool.group ?? '-')}</td>
  <td class="mono">${escapeHtml(tool.when ?? '-')}</td>
  <td>${escapeHtml(tool.audience ?? 'all')}</td>
  <td>${escapeHtml(tool.summary)}</td>
  <td><span class="apple-badge">${activeLabel}</span></td>
</tr>`)
    }
  }
  const body = rows.length === 0
    ? '<tr><td colspan="8">暂无已注册工具。</td></tr>'
    : rows.join('')

  return `<section class="glass-card" data-role="tool-catalog">
  <h3>工具目录</h3>
  <table>
    <thead><tr><th>工具名</th><th>load</th><th>effect</th><th>group</th><th>when</th><th>audience</th><th>summary</th><th>状态</th></tr></thead>
    <tbody>${body}</tbody>
  </table>
</section>`
}

function renderCoreBudgets(budgets: readonly ChannelCoreBudget[]): string {
  const hasOver = budgets.some((b) => b.over)
  const alertHtml = hasOver
    ? '<div class="status-banner" data-tone="warning" data-role="core-budget-alert">Core 工具预算超限告警：部分通道超出 8 个工具或 2000 tokens 上限。</div>'
    : ''

  const rows = budgets.length === 0
    ? '<tr><td colspan="4">暂无通道预算数据。</td></tr>'
    : budgets.map((b) => `<tr data-budget-over="${String(b.over)}">
  <td class="mono">${escapeHtml(b.pattern)}</td>
  <td class="mono">${String(b.count)} / 8</td>
  <td class="mono">${String(b.tokens)} / 2000</td>
  <td><span class="apple-badge">${b.over ? '超限' : '正常'}</span></td>
</tr>`).join('')

  return `<section class="glass-card" data-role="core-budgets">
  <h3>Core 预算</h3>
  ${alertHtml}
  <table>
    <thead><tr><th>通道模式</th><th>工具数</th><th>Token 估算</th><th>状态</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`
}

function renderPluginToolbar(): string {
  return `<section class="glass-card plugin-toolbar" data-role="plugin-actions">
  <h3>安装插件 &amp; 规范检查</h3>
  <div class="plugin-toolbar-forms">
    <form class="inline-form" data-form="plugin-install">
      <label>安装插件 Spec <input type="text" name="spec" value="" placeholder="插件目录路径或包 spec"></label>
      <button type="submit" class="primary">预览安装</button>
    </form>
    <form class="inline-form" data-form="plugin-check">
      <label>规范检查目录 <input type="text" name="dir" value="" placeholder="插件目录路径"></label>
      <button type="submit">运行检查</button>
    </form>
  </div>
</section>`
}

/** Renders the Apple vibrancy glass UI for the plugins & permissions management page. */
export function renderPluginsPage(state: PluginsPageState): string {
  const parts: string[] = ['<div class="plugins-page">']

  if (state.errorMessage !== null) {
    parts.push(`<div class="status-banner" data-tone="warning" data-role="error-banner">${escapeHtml(state.errorMessage)}</div>`)
  }

  if (state.rollbackNotice !== null) {
    parts.push(`<section class="glass-card status-banner" data-tone="warning" data-role="rollback-banner">${escapeHtml(state.rollbackNotice)}</section>`)
  }

  if (state.pendingInstall !== null) {
    parts.push(renderPermissionModal('install', state.pendingInstall))
  }

  if (state.pendingUpgrade !== null) {
    parts.push(renderPermissionModal('upgrade', state.pendingUpgrade.preview))
  }

  parts.push(renderPluginToolbar())
  parts.push(renderPluginsList(state.plugins))

  if (state.lastCheckReport !== null) {
    parts.push(renderCheckReport(state.lastCheckReport.target, state.lastCheckReport.report))
  }

  parts.push(renderToolCatalog(state.plugins))
  parts.push(renderCoreBudgets(state.coreBudgets))
  parts.push('</div>')

  return parts.join('\n')
}
