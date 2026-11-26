import { escapeHtml } from '../../shell/theme.ts'
import type { AccountingPageState, AccountingPeriodDays } from './controller.ts'
import type {
  AccountingBudgetConfig,
  AccountingSummary,
  DailyCostPoint,
  ModelPriceBook,
  PluginCostBreakdown,
} from './types.ts'

const PERIOD_OPTIONS: readonly AccountingPeriodDays[] = [7, 14, 30]
const SERIES_COLORS: readonly string[] = ['#0A84FF', '#5E5CE6', '#30D158', '#FF9F0A', '#FF453A']

function finiteOr(value: number | undefined | null, fallback = 0): number {
  return value !== undefined && value !== null && Number.isFinite(value) ? value : fallback
}

export function formatMicros(micros: number): string {
  const safe = finiteOr(micros, 0)
  const units = safe / 1_000_000
  const roundedInt = Math.round(safe)
  if (roundedInt % 10_000 === 0) {
    return units.toFixed(2)
  }
  return units.toFixed(4)
}

function formatInt(value: number | undefined | null): string {
  return String(Math.round(finiteOr(value, 0)))
}

function formatPercent(ratio: number | undefined | null): string {
  const safe = Math.max(0, Math.min(1, finiteOr(ratio, 0)))
  return `${(safe * 100).toFixed(1)}%`
}

function computeBudgetRatio(summary: AccountingSummary): number | null {
  const ratios: number[] = []
  if (summary.dailyCostMicrosLimit !== undefined && Number.isFinite(summary.dailyCostMicrosLimit) && summary.dailyCostMicrosLimit > 0) {
    ratios.push(finiteOr(summary.todayCostMicros) / summary.dailyCostMicrosLimit)
  }
  if (summary.dailyTokenLimit !== undefined && Number.isFinite(summary.dailyTokenLimit) && summary.dailyTokenLimit > 0) {
    ratios.push(finiteOr(summary.todayTokens) / summary.dailyTokenLimit)
  }
  if (ratios.length === 0) return null
  return Math.max(0, ...ratios)
}

function budgetToneColor(ratio: number | null): string {
  if (ratio === null) return '#0A84FF'
  if (ratio >= 1) return '#FF453A'
  if (ratio >= 0.8) return '#FF9F0A'
  return '#30D158'
}

function renderQuotaBanner(sharedQuotaWarning: boolean): string {
  if (sharedQuotaWarning) {
    return '<div class="status-banner" data-tone="info" data-role="shared-quota-warning">未配置独立 API Key，当前与主 DSH 共用配额</div>'
  }
  return '<div class="status-banner" data-tone="ok" data-role="dedicated-quota-shield" style="border-color: rgba(48, 209, 88, 0.45); background: rgba(48, 209, 88, 0.14);">'
    + '<span class="apple-badge" style="background: rgba(48, 209, 88, 0.24); border: 1px solid rgba(48, 209, 88, 0.48);">独立配额护盾</span>'
    + '<span>已启用 Brain 独立 API Key，与主 DSH 配额隔离</span>'
    + '</div>'
}

function renderBudgetMeterSvg(summary: AccountingSummary): string {
  const ratio = computeBudgetRatio(summary)
  const color = budgetToneColor(ratio)
  const clamped = ratio === null ? 0 : Math.max(0, Math.min(1, ratio))
  const radius = 34
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference * (1 - clamped)
  const pctLabel = ratio === null ? '未限' : `${Math.round(ratio * 100)}%`

  return `<svg class="accounting-budget-svg" viewBox="0 0 92 92" width="92" height="92" role="img" aria-label="日预算使用进度" data-chart="budget-meter" data-tone-color="${escapeHtml(color)}">
  <circle cx="46" cy="46" r="${String(radius)}" fill="none" stroke="rgba(127,127,127,0.22)" stroke-width="8" />
  <circle cx="46" cy="46" r="${String(radius)}" fill="none" stroke="${escapeHtml(color)}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${dashOffset.toFixed(2)}" transform="rotate(-90 46 46)" />
  <text x="46" y="50" text-anchor="middle" fill="currentColor" font-size="14" font-weight="600" class="mono">${escapeHtml(pctLabel)}</text>
</svg>`
}

function renderKpiGrid(summary: AccountingSummary): string {
  const currency = escapeHtml(summary.currency)
  const costText = escapeHtml(formatMicros(summary.todayCostMicros))
  const tokensText = escapeHtml(formatInt(summary.todayTokens))
  const hitRatioText = escapeHtml(formatPercent(summary.todayCacheHitRatio))
  const tokenLimitText = summary.dailyTokenLimit === undefined ? '不限' : escapeHtml(formatInt(summary.dailyTokenLimit))
  const costLimitText = summary.dailyCostMicrosLimit === undefined
    ? '不限'
    : `${escapeHtml(formatMicros(summary.dailyCostMicrosLimit))} ${currency}`

  return `<section class="accounting-kpi-grid" data-section="accounting-kpis">
  <article class="glass-card">
    <div class="consolidation-metric-label">今日总花费</div>
    <div class="consolidation-metric-value mono" data-kpi="today-cost">${costText} ${currency}</div>
    <div class="login-hint">限额：<span class="mono">${costLimitText}</span></div>
  </article>
  <article class="glass-card">
    <div class="consolidation-metric-label">今日总 Token</div>
    <div class="consolidation-metric-value mono" data-kpi="today-tokens">${tokensText}</div>
    <div class="login-hint">限额：<span class="mono">${tokenLimitText}</span></div>
  </article>
  <article class="glass-card">
    <div class="consolidation-metric-label">今日缓存命中率</div>
    <div class="consolidation-metric-value mono" data-kpi="cache-hit-ratio">${hitRatioText}</div>
    <div class="login-hint">日期：<span class="mono">${escapeHtml(summary.day)}</span></div>
  </article>
  <article class="glass-card token-budget-meter">
    ${renderBudgetMeterSvg(summary)}
    <div>
      <div class="consolidation-metric-label">日预算进度</div>
      <div class="login-hint">绿 &lt;80% · 琥珀 80–99% · 红 ≥100%</div>
    </div>
  </article>
</section>`
}

function renderPeriodSwitch(days: AccountingPeriodDays): string {
  const buttons = PERIOD_OPTIONS.map((opt) => {
    const active = opt === days
    return `<button type="button" role="tab" data-period-days="${String(opt)}" aria-selected="${String(active)}">${String(opt)} 天</button>`
  }).join('')
  return `<div class="segmented" role="tablist" aria-label="统计周期">${buttons}</div>`
}

function renderPluginBreakdownSvg(rows: readonly PluginCostBreakdown[]): string {
  if (rows.length === 0) {
    return `<svg class="plugin-cost-svg" viewBox="0 0 480 120" width="100%" height="120" role="img" aria-label="按插件分账条形图" data-chart="plugin-cost-breakdown">
  <text x="240" y="64" text-anchor="middle" fill="currentColor" font-size="12">今日暂无模型调用分账数据</text>
</svg>`
  }

  const maxCost = Math.max(1, ...rows.map((r) => finiteOr(r.costMicros)))
  const maxTokens = Math.max(1, ...rows.map((r) => finiteOr(r.totalTokens)))
  const useCost = rows.some((r) => finiteOr(r.costMicros) > 0)
  const height = Math.max(88, 24 + rows.length * 32)

  const bars = rows.map((row, idx) => {
    const y = 16 + idx * 32
    const val = useCost ? finiteOr(row.costMicros) : finiteOr(row.totalTokens)
    const denom = useCost ? maxCost : maxTokens
    const barW = Math.max(4, Math.round((val / denom) * 230))
    const color = SERIES_COLORS[idx % SERIES_COLORS.length]!
    const labelText = row.owner.length > 22 ? `${row.owner.slice(0, 21)}…` : row.owner
    const metricLabel = `${formatMicros(row.costMicros)} ${row.currency}`

    return `<text x="8" y="${String(y + 14)}" fill="currentColor" font-size="11" class="mono">${escapeHtml(labelText)}</text>`
      + `<rect x="164" y="${String(y)}" width="${String(barW)}" height="18" rx="5" fill="${color}" />`
      + `<text x="${String(172 + barW)}" y="${String(y + 14)}" fill="currentColor" font-size="11" class="mono">${escapeHtml(metricLabel)}</text>`
  }).join('')

  return `<svg class="plugin-cost-svg" viewBox="0 0 480 ${String(height)}" width="100%" height="${String(height)}" role="img" aria-label="按插件分账条形图" data-chart="plugin-cost-breakdown">
  ${bars}
</svg>`
}

function renderPluginBreakdownTable(rows: readonly PluginCostBreakdown[]): string {
  if (rows.length === 0) {
    return '<p class="login-hint">今日暂无插件或内核调用记录。</p>'
  }

  const bodyRows = rows.map((row) => {
    const pluginAttr = row.pluginId ?? ''
    const pluginCell = row.pluginId === undefined ? '—' : escapeHtml(row.pluginId)
    const unpricedBadge = row.unpricedCalls > 0
      ? ` <span class="apple-badge" data-tone="warning">未定价 ${escapeHtml(formatInt(row.unpricedCalls))}</span>`
      : ''

    return `<tr data-owner="${escapeHtml(row.owner)}" data-plugin-id="${escapeHtml(pluginAttr)}">
      <td class="mono">${escapeHtml(row.owner)}</td>
      <td class="mono">${pluginCell}</td>
      <td class="mono">${escapeHtml(formatInt(row.calls))}</td>
      <td class="mono">${escapeHtml(formatInt(row.inputTokens))}</td>
      <td class="mono">${escapeHtml(formatInt(row.outputTokens))}</td>
      <td class="mono">${escapeHtml(formatInt(row.cacheReadTokens))} / ${escapeHtml(formatInt(row.cacheWriteTokens))}</td>
      <td class="mono">${escapeHtml(formatInt(row.totalTokens))}</td>
      <td class="mono">${escapeHtml(formatMicros(row.costMicros))} ${escapeHtml(row.currency)}${unpricedBadge}</td>
    </tr>`
  }).join('\n')

  return `<table class="audit-table" data-table="plugin-cost-table">
  <thead>
    <tr>
      <th>归属</th>
      <th>插件 ID</th>
      <th>调用次数</th>
      <th>输入</th>
      <th>输出</th>
      <th>缓存读 / 写</th>
      <th>总 Token</th>
      <th>花费</th>
    </tr>
  </thead>
  <tbody>
    ${bodyRows}
  </tbody>
</table>`
}

function renderDailyTrendSvg(points: readonly DailyCostPoint[]): string {
  if (points.length === 0) {
    return `<svg class="daily-cost-svg" viewBox="0 0 480 160" width="100%" height="160" role="img" aria-label="每日花费趋势柱状图" data-chart="daily-cost-trend">
  <text x="240" y="84" text-anchor="middle" fill="currentColor" font-size="12">所选周期暂无每日花费记录</text>
</svg>`
  }

  const maxCost = Math.max(1, ...points.map((p) => finiteOr(p.costMicros)))
  const useCost = points.some((p) => finiteOr(p.costMicros) > 0)
  const maxVal = useCost ? maxCost : Math.max(1, ...points.map((p) => finiteOr(p.totalTokens)))
  const chartWidth = 420
  const slotW = Math.max(10, Math.floor(chartWidth / points.length))
  const barW = Math.max(6, Math.min(36, slotW - 4))
  const polyCoords: string[] = []

  const bars = points.map((pt, idx) => {
    const val = useCost ? finiteOr(pt.costMicros) : finiteOr(pt.totalTokens)
    const barH = Math.max(4, Math.round((val / maxVal) * 96))
    const x = 30 + idx * slotW + Math.floor((slotW - barW) / 2)
    const y = 120 - barH
    const cx = x + Math.floor(barW / 2)
    polyCoords.push(`${String(cx)},${String(y)}`)
    const shortDay = pt.day.length >= 5 ? pt.day.slice(-5) : pt.day
    const valText = useCost ? formatMicros(pt.costMicros) : formatInt(pt.totalTokens)

    return `<rect x="${String(x)}" y="${String(y)}" width="${String(barW)}" height="${String(barH)}" rx="4" fill="rgba(10,132,255,0.65)" />`
      + `<text x="${String(cx)}" y="138" text-anchor="middle" fill="currentColor" font-size="10" class="mono">${escapeHtml(shortDay)}</text>`
      + `<text x="${String(cx)}" y="${String(Math.max(12, y - 4))}" text-anchor="middle" fill="currentColor" font-size="10" class="mono">${escapeHtml(valText)}</text>`
  }).join('')

  const polyline = polyCoords.length > 1
    ? `<polyline fill="none" stroke="#5E5CE6" stroke-width="2" points="${polyCoords.join(' ')}" />`
    : ''

  return `<svg class="daily-cost-svg" viewBox="0 0 480 154" width="100%" height="154" role="img" aria-label="每日花费趋势柱状图" data-chart="daily-cost-trend">
  ${bars}
  ${polyline}
</svg>`
}

function renderPriceBookForm(prices: ModelPriceBook | null, saving: boolean): string {
  const currency = prices?.currency ?? 'CNY'
  const entries = prices === null ? [] : Object.entries(prices.models)

  const modelRows = entries.length === 0
    ? '<p class="login-hint">暂无模型价格条目。</p>'
    : entries.map(([modelKey, entry]) => `<div class="price-row" data-model-key="${escapeHtml(modelKey)}">
      <div class="mono">${escapeHtml(modelKey)}</div>
      <label>输入 (/1M) <input type="text" name="inputPerMillion" value="${escapeHtml(String(finiteOr(entry.inputPerMillion)))}"></label>
      <label>输出 (/1M) <input type="text" name="outputPerMillion" value="${escapeHtml(String(finiteOr(entry.outputPerMillion)))}"></label>
      <label>缓存读 (/1M) <input type="text" name="cacheReadPerMillion" value="${escapeHtml(String(finiteOr(entry.cacheReadPerMillion)))}"></label>
      <label>缓存写 (/1M) <input type="text" name="cacheWritePerMillion" value="${escapeHtml(String(finiteOr(entry.cacheWritePerMillion)))}"></label>
    </div>`).join('\n')

  return `<form class="glass-card" data-form="price-book">
  <header>
    <h3>模型价格配置</h3>
  </header>
  <label>计价币种 <input type="text" name="currency" value="${escapeHtml(currency)}"></label>
  <div class="price-rows">${modelRows}</div>
  <button type="submit" class="primary"${saving ? ' disabled' : ''}>保存价格配置</button>
</form>`
}

function renderBudgetLimitsForm(
  summary: AccountingSummary | null,
  budget: AccountingBudgetConfig | null,
  saving: boolean,
): string {
  const dailyTokenLimit = budget?.dailyTokenLimit ?? summary?.dailyTokenLimit
  const dailyCostMicrosLimit = budget?.dailyCostMicrosLimit ?? summary?.dailyCostMicrosLimit
  const pluginDailyTokenLimit = budget?.pluginDailyTokenLimit

  return `<form class="glass-card" data-form="budget-limits">
  <header>
    <h3>日限额预算</h3>
  </header>
  <label>全局日 Token 上限 <input type="text" name="dailyTokenLimit" value="${dailyTokenLimit === undefined ? '' : escapeHtml(formatInt(dailyTokenLimit))}" placeholder="留空表示不限"></label>
  <label>全局日花费上限 (micros) <input type="text" name="dailyCostMicrosLimit" value="${dailyCostMicrosLimit === undefined ? '' : escapeHtml(formatInt(dailyCostMicrosLimit))}" placeholder="留空表示不限"></label>
  <label>单插件默认日 Token 上限 <input type="text" name="pluginDailyTokenLimit" value="${pluginDailyTokenLimit === undefined ? '' : escapeHtml(formatInt(pluginDailyTokenLimit))}" placeholder="留空表示不限"></label>
  <button type="submit" class="primary"${saving ? ' disabled' : ''}>保存日限额</button>
</form>`
}

export function renderAccountingView(state: AccountingPageState): string {
  const errorBanner = state.errorMessage !== null
    ? `<div class="status-banner" data-tone="warning" data-role="accounting-error">${escapeHtml(state.errorMessage)}</div>`
    : ''
  const noticeBanner = state.noticeMessage !== null
    ? `<div class="status-banner" data-tone="info" data-role="accounting-notice">${escapeHtml(state.noticeMessage)}</div>`
    : ''

  if (state.summary === null) {
    return `<div class="accounting-page">
  ${errorBanner}
  ${noticeBanner}
  <section class="glass-card" data-section="accounting-unloaded">
    <h3>模型花费与配额</h3>
    <p class="login-hint">${state.loading ? '正在加载花费账本…' : '尚未加载花费账本，请刷新重试。'}</p>
  </section>
  ${renderPriceBookForm(state.prices, state.savingPrices)}
  ${renderBudgetLimitsForm(null, state.budget, state.savingBudget)}
</div>`
  }

  const { summary } = state
  return `<div class="accounting-page">
  ${errorBanner}
  ${noticeBanner}
  ${renderQuotaBanner(summary.sharedQuotaWarning)}
  ${renderKpiGrid(summary)}
  <section class="glass-card" data-section="plugin-breakdown">
    <header>
      <h3>按插件 / 子系统分账</h3>
    </header>
    ${renderPluginBreakdownSvg(summary.byPlugin)}
    ${renderPluginBreakdownTable(summary.byPlugin)}
  </section>
  <section class="glass-card" data-section="daily-trend">
    <header>
      <h3>近 ${escapeHtml(String(state.days))} 天花费趋势</h3>
      ${renderPeriodSwitch(state.days)}
    </header>
    ${renderDailyTrendSvg(summary.dailyTrend)}
  </section>
  <div class="accounting-forms-grid">
    ${renderPriceBookForm(state.prices, state.savingPrices)}
    ${renderBudgetLimitsForm(summary, state.budget, state.savingBudget)}
  </div>
</div>`
}
