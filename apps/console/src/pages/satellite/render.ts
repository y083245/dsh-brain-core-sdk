import type { AgentClass } from '@brain-core/satellite-host'
import { escapeHtml } from '../../shell/theme.ts'
import type { SatellitePageState } from './controller.ts'
import type { Percentiles, SatelliteMetricsSummary, SessionSurfaceWarning } from './metrics.ts'
import type {
  AgentProcessStatus,
  InteropSnapshot,
  IsolationDoctorStatus,
  SatelliteRecoveryPhase,
  SatelliteSubView,
} from './types.ts'

const PHASE_LABELS: Readonly<Record<SatelliteRecoveryPhase, string>> = {
  crashing: '崩溃中',
  restarting: '重启中',
  recovered: '已恢复',
  running: '运行中',
  failed: '连续失败已停止',
  idle: '空闲未启动',
}

const PHASE_TONES: Readonly<Record<SatelliteRecoveryPhase, string>> = {
  crashing: 'danger',
  restarting: 'warning',
  recovered: 'ok',
  running: 'ok',
  failed: 'danger',
  idle: 'neutral',
}

const AGENT_LABELS: Readonly<Record<AgentClass, string>> = {
  chat: '聊天类 (chat)',
  activity: '活动类 (activity)',
}

const SUBVIEWS: readonly { readonly id: SatelliteSubView; readonly label: string }[] = [
  { id: 'runtime', label: '附属运行时与指标' },
  { id: 'accounting', label: '模型花费与配额' },
  { id: 'interop', label: '外部互通与调试视图' },
]

function finiteOr(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback
}

function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${String(Math.round(value))} ms`
}

function formatPercent(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—'
  return `${(ratio * 100).toFixed(1)}%`
}

function formatPercentiles(p: Percentiles | null, unit: string): string {
  if (p === null) return '—'
  const p50 = Number.isFinite(p.p50) ? String(Math.round(p.p50 * 10) / 10) : '0'
  const p95 = Number.isFinite(p.p95) ? String(Math.round(p.p95 * 10) / 10) : '0'
  return `p50: ${p50}${unit} / p95: ${p95}${unit}`
}

function safeLoopbackHref(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && parsed.port !== '') {
      return parsed.toString()
    }
  } catch {
    // Non-URL payloads are blocked from becoming clickable links.
  }
  return '#'
}

function renderSubnav(activeSubView: SatelliteSubView): string {
  const buttons = SUBVIEWS.map((item) => {
    const selected = activeSubView === item.id
    return `<button type="button" role="tab" data-subview="${escapeHtml(item.id)}" aria-selected="${String(selected)}">${escapeHtml(item.label)}</button>`
  }).join('')
  return `<div class="segmented satellite-subnav" role="tablist" aria-label="运行状态子视图切换">${buttons}</div>`
}

function renderProcessCard(proc: AgentProcessStatus, phase: SatelliteRecoveryPhase): string {
  const phaseLabel = PHASE_LABELS[phase]
  const tone = PHASE_TONES[phase]
  const pidText = proc.pid === undefined ? '—' : String(proc.pid)

  const selectionHtml = proc.selection === null
    ? '<div class="status-banner" data-tone="warning" data-role="selection-missing">模型未选择 — 请前往设置选择模型与思考强度（未选时不启动进程）</div>'
    : `<div class="mono" data-role="selection-value">${escapeHtml(proc.selection.provider)} / ${escapeHtml(proc.selection.model)} / ${escapeHtml(proc.selection.effort)}</div>`

  const errorHtml = proc.lastError !== undefined && proc.lastError !== ''
    ? `<div class="status-banner" data-tone="warning" data-role="last-error">最近错误：${escapeHtml(proc.lastError)}</div>`
    : ''

  return `<article class="glass-card" data-agent-card="${escapeHtml(proc.agentClass)}">
  <header>
    <h3>${escapeHtml(AGENT_LABELS[proc.agentClass])}</h3>
    <span class="apple-badge" data-phase="${escapeHtml(phase)}" data-tone="${escapeHtml(tone)}">${escapeHtml(phaseLabel)}</span>
  </header>
  <dl>
    <div><dt>PID</dt><dd class="mono">${escapeHtml(pidText)}</dd></div>
    <div><dt>原始状态</dt><dd class="mono">${escapeHtml(proc.status)}</dd></div>
    <div><dt>活跃会话</dt><dd class="mono">${String(finiteOr(proc.activeSessions))}</dd></div>
    <div><dt>拒绝审批</dt><dd class="mono">${String(finiteOr(proc.deniedApprovals))}</dd></div>
  </dl>
  ${selectionHtml}
  ${errorHtml}
  <div>
    <button type="button" class="primary" data-action="restart" data-agent-class="${escapeHtml(proc.agentClass)}">重启</button>
  </div>
</article>`
}

function renderDoctorCard(isolation: IsolationDoctorStatus): string {
  const badge = isolation.ok
    ? '<span class="apple-badge" data-tone="ok" data-role="doctor-ok">隔离检查通过</span>'
    : '<span class="apple-badge" data-tone="danger" data-role="doctor-fail">隔离检查发现问题</span>'

  const problemsHtml = isolation.problems.length === 0
    ? '<p class="login-hint">未发现隔离问题。</p>'
    : `<ul data-role="doctor-problems">${isolation.problems.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`

  const checkedText = Number.isFinite(isolation.checkedAt)
    ? new Date(isolation.checkedAt).toISOString()
    : '—'

  return `<section class="glass-card" data-section="isolation-doctor">
  <header>
    <h3>隔离检查（brain doctor --isolation）</h3>
    ${badge}
  </header>
  <div class="mono">检查时间：${escapeHtml(checkedText)}</div>
  ${problemsHtml}
  <button type="button" data-action="run-doctor">重新检查</button>
</section>`
}

function renderLatencyComparisonSvg(summary: SatelliteMetricsSummary): string {
  const fsP50 = finiteOr(summary.firstSendLatencyMs?.p50 ?? 0)
  const fsP95 = finiteOr(summary.firstSendLatencyMs?.p95 ?? 0)
  const dbP50 = finiteOr(summary.debouncePauseMs?.p50 ?? 0)
  const dbP95 = finiteOr(summary.debouncePauseMs?.p95 ?? 0)
  const maxVal = Math.max(1, fsP50, fsP95, dbP50, dbP95)

  const rows: readonly { readonly label: string; readonly value: number; readonly color: string }[] = [
    { label: '首条时延 p50', value: fsP50, color: '#0A84FF' },
    { label: '首条时延 p95', value: fsP95, color: '#5E5CE6' },
    { label: '防抖停顿 p50', value: dbP50, color: '#30D158' },
    { label: '防抖停顿 p95', value: dbP95, color: '#FF9F0A' },
  ]

  const bars = rows.map((row, idx) => {
    const y = 18 + idx * 32
    const width = Math.max(2, Math.round((row.value / maxVal) * 200))
    return `<text x="8" y="${String(y + 13)}" fill="currentColor" font-size="11">${escapeHtml(row.label)}</text>`
      + `<rect x="112" y="${String(y)}" width="${String(width)}" height="18" rx="4" fill="${row.color}" />`
      + `<text x="${String(118 + width)}" y="${String(y + 13)}" fill="currentColor" font-size="11">${String(Math.round(row.value))}ms</text>`
  }).join('')

  return `<svg viewBox="0 0 380 156" width="100%" height="156" role="img" aria-label="首条发出时延与刻意防抖停顿对比图" data-chart="latency-comparison">
  ${bars}
</svg>`
}

function renderStepsDistributionSvg(summary: SatelliteMetricsSummary): string {
  const samples = summary.stepsPerReply?.samples ?? []
  const counts = new Map<number, number>()
  for (const s of samples) {
    const step = Math.max(0, Math.round(finiteOr(s)))
    counts.set(step, (counts.get(step) ?? 0) + 1)
  }
  const entries = [...counts.entries()].sort((a, b) => a[0] - b[0])
  const maxCount = Math.max(1, ...entries.map(([, c]) => c))
  const barWidth = Math.max(18, Math.min(48, Math.floor(280 / Math.max(1, entries.length)) - 8))

  const bars = entries.map(([step, count], idx) => {
    const x = 36 + idx * (barWidth + 10)
    const height = Math.max(4, Math.round((count / maxCount) * 86))
    const y = 110 - height
    return `<rect x="${String(x)}" y="${String(y)}" width="${String(barWidth)}" height="${String(height)}" rx="4" fill="#0A84FF" />`
      + `<text x="${String(x + Math.floor(barWidth / 2))}" y="128" text-anchor="middle" fill="currentColor" font-size="11">${String(step)}步</text>`
      + `<text x="${String(x + Math.floor(barWidth / 2))}" y="${String(Math.max(12, y - 4))}" text-anchor="middle" fill="currentColor" font-size="10">${String(count)}</text>`
  }).join('')

  return `<svg viewBox="0 0 380 144" width="100%" height="144" role="img" aria-label="每次回复模型步数分布图" data-chart="steps-distribution">
  ${bars}
</svg>`
}

function renderCacheTrendSvg(summary: SatelliteMetricsSummary): string {
  const points = summary.stepCachePoints
  if (points.length === 0) {
    return `<svg viewBox="0 0 380 144" width="100%" height="144" role="img" aria-label="每步输入 Token 与缓存命中率趋势图" data-chart="cache-trend">
  <text x="190" y="76" text-anchor="middle" fill="currentColor" font-size="12">暂无模型步数样本</text>
</svg>`
  }

  const maxTokens = Math.max(
    1,
    ...points.map((p) => finiteOr(p.inputTokens + p.cacheReadTokens + p.cacheWriteTokens)),
  )
  const stepWidth = Math.max(10, Math.min(40, Math.floor(310 / points.length)))

  const rects: string[] = []
  const polyPoints: string[] = []

  for (let i = 0; i < points.length; i++) {
    const pt = points[i]!
    const total = finiteOr(pt.inputTokens + pt.cacheReadTokens + pt.cacheWriteTokens)
    const ratio = Math.min(1, Math.max(0, finiteOr(pt.hitRatio)))
    const x = 32 + i * stepWidth
    const barH = Math.max(2, Math.round((total / maxTokens) * 90))
    const barY = 114 - barH
    rects.push(`<rect x="${String(x)}" y="${String(barY)}" width="${String(Math.max(4, stepWidth - 4))}" height="${String(barH)}" rx="2" fill="rgba(10,132,255,0.45)" />`)

    const cx = x + Math.floor(Math.max(4, stepWidth - 4) / 2)
    const cy = Math.round(114 - ratio * 90)
    polyPoints.push(`${String(cx)},${String(cy)}`)
  }

  const line = `<polyline fill="none" stroke="#30D158" stroke-width="2" points="${polyPoints.join(' ')}" />`

  return `<svg viewBox="0 0 380 144" width="100%" height="144" role="img" aria-label="每步输入 Token 与缓存命中率趋势图" data-chart="cache-trend">
  ${rects.join('')}
  ${line}
</svg>`
}

function renderMetricsSection(summary: SatelliteMetricsSummary): string {
  if (summary.empty) {
    return `<section class="glass-card" data-section="metrics-empty">
  <h3>唤醒指标分布</h3>
  <p class="login-hint">暂无唤醒指标数据。完成首次唤醒后将展示首条发出时延、防抖停顿、模型步数与缓存命中率。</p>
</section>`
  }

  return `<section class="glass-card" data-section="metrics">
  <h3>唤醒指标分布</h3>
  <dl>
    <div><dt>唤醒次数</dt><dd class="mono">${String(finiteOr(summary.totalWakes))}</dd></div>
    <div><dt>累计重试</dt><dd class="mono">${String(finiteOr(summary.totalRetries))}</dd></div>
    <div><dt>首条发出时延（不含防抖）</dt><dd class="mono">${escapeHtml(formatPercentiles(summary.firstSendLatencyMs, 'ms'))}</dd></div>
    <div><dt>刻意防抖停顿</dt><dd class="mono">${escapeHtml(formatPercentiles(summary.debouncePauseMs, 'ms'))}</dd></div>
    <div><dt>每次回复步数</dt><dd class="mono">${escapeHtml(formatPercentiles(summary.stepsPerReply, '步'))}</dd></div>
    <div><dt>总体缓存命中率</dt><dd class="mono">${escapeHtml(formatPercent(summary.overallCacheHitRatio))}</dd></div>
    <div><dt>第 2 次唤醒起缓存命中率</dt><dd class="mono">${escapeHtml(formatPercent(summary.warmCacheHitRatio))}</dd></div>
    <div><dt>首条时延 p50 / p95</dt><dd class="mono">${escapeHtml(formatMs(summary.firstSendLatencyMs?.p50))} / ${escapeHtml(formatMs(summary.firstSendLatencyMs?.p95))}</dd></div>
  </dl>
  <div class="charts-grid">
    <div>
      <h4>首条发出时延 vs 刻意防抖停顿</h4>
      ${renderLatencyComparisonSvg(summary)}
    </div>
    <div>
      <h4>每次回复步数分布</h4>
      ${renderStepsDistributionSvg(summary)}
    </div>
    <div>
      <h4>每步输入 Token 与缓存命中率趋势</h4>
      ${renderCacheTrendSvg(summary)}
    </div>
  </div>
</section>`
}

function renderSessionsSection(warnings: readonly SessionSurfaceWarning[]): string {
  if (warnings.length === 0) {
    return `<section class="glass-card" data-section="sessions">
  <h3>活跃会话工具面</h3>
  <p class="login-hint">暂无活跃会话。</p>
</section>`
  }

  const items = warnings.map((session) => {
    const alert = session.overThreshold
      ? '<span class="apple-badge" data-tone="warning" data-role="tool-threshold-warning">工具数超阈值告警</span>'
      : '<span class="apple-badge" data-tone="ok">正常</span>'
    return `<li data-session-id="${escapeHtml(session.sessionId)}">
      <span class="mono">${escapeHtml(session.sessionId)}</span>
      <span>${escapeHtml(session.channel)}</span>
      <span class="mono">${escapeHtml(session.agentClass)}</span>
      <span class="mono">工具数：${String(finiteOr(session.toolCount))}</span>
      ${alert}
    </li>`
  }).join('')

  return `<section class="glass-card" data-section="sessions">
  <h3>活跃会话工具面</h3>
  <ul>${items}</ul>
</section>`
}

function renderRuntimeBody(state: SatellitePageState): string {
  if (state.snapshot === null) {
    return `<section class="glass-card" data-section="unloaded">
    <h3>附属运行时状态</h3>
    <p class="login-hint">尚未加载运行时快照，请刷新重试。</p>
  </section>
  ${renderMetricsSection(state.summary)}`
  }

  const { snapshot, summary, displayPhase } = state
  const quotaBanner = snapshot.sharedQuotaWarning
    ? '<div class="status-banner" data-tone="info" data-role="shared-quota-warning">未配置独立 API Key，当前与主 DSH 共用配额</div>'
    : ''

  return `${quotaBanner}
  <div class="process-grid">
    ${renderProcessCard(snapshot.processes.chat, displayPhase.chat)}
    ${renderProcessCard(snapshot.processes.activity, displayPhase.activity)}
  </div>
  ${renderDoctorCard(snapshot.isolation)}
  ${renderMetricsSection(summary)}
  ${renderSessionsSection(summary.sessionWarnings)}`
}

function renderAccountingBody(accountingHtml?: string): string {
  if (accountingHtml !== undefined && accountingHtml !== '') {
    return accountingHtml
  }
  return `<section class="glass-card" data-section="accounting-empty">
  <h3>模型花费与配额</h3>
  <p class="login-hint">暂无模型花费统计视图数据。</p>
</section>`
}

function renderInteropBody(interop: InteropSnapshot | null): string {
  const data: InteropSnapshot = interop ?? {
    ampAliases: false,
    mcp: { enabled: false, running: false },
    debugView: { running: false },
  }

  const ampBadge = data.ampAliases
    ? '<span class="apple-badge" data-tone="ok" data-role="amp-status">已开启</span>'
    : '<span class="apple-badge" data-tone="neutral" data-role="amp-status">已关闭</span>'

  const mcpBadge = data.mcp.running
    ? '<span class="apple-badge" data-tone="ok" data-role="mcp-status">运行中</span>'
    : data.mcp.enabled
      ? '<span class="apple-badge" data-tone="warning" data-role="mcp-status">已启用未运行</span>'
      : '<span class="apple-badge" data-tone="neutral" data-role="mcp-status">已关闭</span>'

  const mcpEndpointText = data.mcp.url !== undefined && data.mcp.url !== ''
    ? data.mcp.url
    : data.mcp.port !== undefined
      ? `http://127.0.0.1:${String(finiteOr(data.mcp.port))}/mcp`
      : '—'

  const patchYamlHtml = data.mcp.patchYaml !== undefined && data.mcp.patchYaml !== ''
    ? `<pre class="mono glass-code" data-role="mcp-patch-yaml">${escapeHtml(data.mcp.patchYaml)}</pre>
    <button type="button" data-action="copy-mcp-patch">复制 --patch YAML</button>`
    : '<p class="login-hint">开启只读 MCP 后将在此生成 `--patch` YAML 配置片段。</p>'

  const debugBadge = data.debugView.running
    ? '<span class="apple-badge" data-tone="ok" data-role="debug-view-status">运行中</span>'
    : '<span class="apple-badge" data-tone="neutral" data-role="debug-view-status">未运行</span>'

  const debugPidText = data.debugView.pid !== undefined ? String(finiteOr(data.debugView.pid)) : '—'
  const debugPortText = data.debugView.port !== undefined ? String(finiteOr(data.debugView.port)) : '—'
  const debugUrlHtml = data.debugView.running && data.debugView.url !== undefined && data.debugView.url !== ''
    ? `<a class="mono" data-role="debug-view-url" href="${escapeHtml(safeLoopbackHref(data.debugView.url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(data.debugView.url)}</a>`
    : '<span class="mono" data-role="debug-view-url">—</span>'

  return `<div class="interop-grid">
  <section class="glass-card" data-section="interop-amp">
    <header>
      <h3>AMP 6 动词别名</h3>
      ${ampBadge}
    </header>
    <p class="login-hint">开启后工具网关额外注册 amp__recall、amp__encode、amp__forget、amp__pin、amp__consolidate 与 amp__stats，共用既有 Policy、证据链与注入检查。</p>
    <div>
      <button type="button" class="primary" data-action="toggle-amp" data-enabled="${String(!data.ampAliases)}">${data.ampAliases ? '关闭 AMP 别名' : '开启 AMP 别名'}</button>
    </div>
  </section>

  <section class="glass-card" data-section="interop-mcp">
    <header>
      <h3>只读 brain-memory MCP</h3>
      ${mcpBadge}
    </header>
    <div class="status-banner" data-tone="info">仅生成配置片段，Brain 绝不写主 DSH</div>
    <dl>
      <div><dt>监听地址</dt><dd class="mono">${escapeHtml(mcpEndpointText)}</dd></div>
    </dl>
    ${patchYamlHtml}
    <div>
      <button type="button" class="primary" data-action="toggle-mcp" data-enabled="${String(!data.mcp.enabled)}">${data.mcp.enabled ? '关闭只读 MCP' : '开启只读 MCP'}</button>
    </div>
  </section>

  <section class="glass-card" data-section="interop-debug-view">
    <header>
      <h3>隔离调试视图（DSH Web）</h3>
      ${debugBadge}
    </header>
    <div class="status-banner" data-tone="info">运行在专用隔离 home，主 DSH 看不到这里的会话</div>
    <dl>
      <div><dt>PID</dt><dd class="mono">${escapeHtml(debugPidText)}</dd></div>
      <div><dt>端口</dt><dd class="mono">${escapeHtml(debugPortText)}</dd></div>
      <div><dt>访问链接</dt><dd>${debugUrlHtml}</dd></div>
    </dl>
    <div>
      <button type="button" class="primary" data-action="${data.debugView.running ? 'stop-debug-view' : 'start-debug-view'}">${data.debugView.running ? '停止调试视图' : '启动调试视图'}</button>
    </div>
  </section>
</div>`
}

export function renderSatellitePage(
  state: SatellitePageState,
  options?: { readonly accountingHtml?: string },
): string {
  const errorBanner = state.errorMessage !== null
    ? `<div class="status-banner" data-tone="warning" data-role="page-error">${escapeHtml(state.errorMessage)}</div>`
    : ''

  let bodyHtml: string
  if (state.activeSubView === 'accounting') {
    bodyHtml = renderAccountingBody(options?.accountingHtml)
  } else if (state.activeSubView === 'interop') {
    bodyHtml = renderInteropBody(state.interop)
  } else {
    bodyHtml = renderRuntimeBody(state)
  }

  return `<div class="satellite-page">
  ${renderSubnav(state.activeSubView)}
  ${errorBanner}
  ${bodyHtml}
</div>`
}
