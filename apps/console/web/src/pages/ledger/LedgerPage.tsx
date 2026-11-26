import { useMemo, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { ApiError, type AccountingBudgetConfig, type AccountingSummary } from '../../api/types.ts'
import { REDUCED_FADE_DURATION } from '../../motion/presets.ts'
import { DUR, EASE } from '../../motion/tokens.ts'
import { useMotionLevel } from '../../motion/useMotionLevel.ts'
import { PluginSeal } from '../../plugins/PluginSeal.tsx'
import { useConsoleShellData } from '../../shell/ConsoleShell.tsx'
import { useShellNavigation } from '../../shell/PageTransition.tsx'
import { Badge } from '../../ui/Badge.tsx'
import { BrushButton } from '../../ui/BrushButton.tsx'
import { BrushTabs } from '../../ui/BrushTabs.tsx'
import { InkNumber } from '../../ui/InkNumber.tsx'
import { EmptyState, ErrorState, InkSkeleton } from '../../ui/InkStates.tsx'
import { PageHeader } from '../../ui/PageHeader.tsx'
import { Plate } from '../../ui/Plate.tsx'
import { EnsoGauge } from '../../ui/charts/EnsoGauge.tsx'
import { InkArea } from '../../ui/charts/InkArea.tsx'
import { BudgetPanel, PricePanel } from './AccountingForms.tsx'
import { InteropPanel } from './InteropPanel.tsx'
import './ledger.css'

const TABS = [{ id: 'accounting', label: '账' }, { id: 'interop', label: '通' }] as const
const RANGES = [{ id: '7', label: '7 天' }, { id: '14', label: '14 天' }, { id: '30', label: '30 天' }] as const
const QUOTA_HEIGHT = 160
const BAR_PATH = 'M 1 6 Q 30 4 58 5 Q 76 6 99 3 Q 92 8 64 9 Q 29 10 1 8 Z'

function money(micros: number, currency: string): string {
  const value = (micros / 1_000_000).toFixed(2)
  const symbol = { USD: '$', CNY: '¥', JPY: '¥', EUR: '€', GBP: '£' }[currency]
  return symbol ? `${symbol}${value}` : `${currency} ${value}`
}

function utilization(used: number, limit: number): number {
  if (limit > 0) return used / limit
  return used > 0 ? 2 : 0
}

function PluginBreakdown({ summary }: { readonly summary: AccountingSummary }) {
  const level = useMotionLevel()
  const { navigate } = useShellNavigation()
  const list = useMemo(() => summary.byPlugin.toSorted((left, right) => right.costMicros - left.costMicros), [summary.byPlugin])
  const max = Math.max(1, list[0]?.costMicros ?? 0)
  return (
    <Plate as="section" className="ledger-panel">
      <h2>按插件</h2>
      {list.length === 0 ? <EmptyState glyph="无账" description="此期间没有插件花费。" /> :
        <ul className="ledger-by-plugin">
          {list.map((item) => (
            <li key={item.owner} className="ledger-breakdown-row">
              <div className="ledger-plugin-name">
                {item.pluginId ? (
                  <>
                    <PluginSeal pluginId={item.pluginId} size={22} />
                    <BrushButton size="sm" variant="ghost" onClick={() => navigate(`seals?plugin=${encodeURIComponent(item.pluginId!)}`)}>{item.pluginId}</BrushButton>
                  </>
                ) : <span>{item.owner}</span>}
                {item.unpricedCalls > 0 ? <span title={`有 ${item.unpricedCalls} 次调用的模型没有配价格`} aria-label={`有 ${item.unpricedCalls} 次调用的模型没有配价格`}><Badge tone="tenghuang">无价</Badge></span> : null}
              </div>
              <svg aria-hidden="true" className="ledger-plugin-chart" viewBox="0 0 100 12" preserveAspectRatio="none" height={12}>
                <path d={BAR_PATH} fill="var(--hair)" />
                <motion.path d={BAR_PATH} fill="var(--zhusha)" style={{ transformOrigin: '0 50%' }}
                  initial={false} animate={{ scaleX: Math.max(0, item.costMicros) / max }} transition={{ duration: level === 'full' ? DUR.bloom : REDUCED_FADE_DURATION, ease: EASE.inkOut }} />
              </svg>
              <InkNumber value={item.costMicros} format={(value) => money(value, item.currency)} />
            </li>
          ))}
        </ul>}
    </Plate>
  )
}

function AccountBook({ localBudget, saveBudget }: {
  readonly localBudget: AccountingBudgetConfig | undefined
  readonly saveBudget: (budget: AccountingBudgetConfig) => void
}) {
  const level = useMotionLevel()
  const { accounting, accountingDays, accountingError, setAccountingDays, refreshAccounting } = useConsoleShellData()
  const budgetSection = useRef<HTMLElement>(null)
  const budgetInput = useRef<HTMLInputElement>(null)
  const trend = useMemo(() => accounting?.dailyTrend.map((point) => ({
    label: point.day.slice(5),
    sublabel: point.day,
    value: point.costMicros,
  })) ?? [], [accounting?.dailyTrend])

  function focusBudget(): void {
    budgetSection.current?.scrollIntoView({ behavior: level === 'full' ? 'smooth' : 'instant', block: 'start' })
    budgetInput.current?.focus({ preventScroll: true })
  }

  let ratio: number | undefined
  let quota = ''
  if (accounting) {
    const tokenRatio = accounting.dailyTokenLimit === undefined ? undefined : utilization(accounting.todayTokens, accounting.dailyTokenLimit)
    const costRatio = accounting.dailyCostMicrosLimit === undefined ? undefined : utilization(accounting.todayCostMicros, accounting.dailyCostMicrosLimit)
    if (tokenRatio !== undefined && (costRatio === undefined || tokenRatio >= costRatio)) {
      ratio = tokenRatio
      quota = accounting.dailyTokenLimit === 0 ? '每日 token 上限为 0' : '每日 token 预算'
    } else if (costRatio !== undefined) {
      ratio = costRatio
      quota = accounting.dailyCostMicrosLimit === 0 ? '每日花费上限为 0' : '每日花费预算'
    }
  }

  return (
    <div className="ledger-book">
      {accounting?.sharedQuotaWarning ? <Plate tone="warn" className="ledger-panel" role="status">与主 DSH 共用配额</Plate> : null}
      {accountingError instanceof Error ? <ErrorState message={accountingError.message} code={accountingError instanceof ApiError ? accountingError.code : undefined} onRetry={() => { void refreshAccounting() }} /> : null}
      {!accounting && !accountingError ? <InkSkeleton rows={2} height={96} /> : null}
      {accounting ? (
        <>
          <Plate as="section" className="ledger-panel ledger-metrics" aria-label="今日账目">
            <dl className="ledger-metric-values">
              <div><dt>今日 token</dt><dd><InkNumber variant="xl" value={accounting.todayTokens} /></dd></div>
              <div><dt>今日花费</dt><dd><InkNumber variant="xl" value={accounting.todayCostMicros} format={(value) => money(value, accounting.currency)} /></dd></div>
              <div><dt>缓存命中率</dt><dd><InkNumber variant="xl" value={accounting.todayCacheHitRatio} format={(value) => `${(value * 100).toFixed(1)}%`} /></dd></div>
            </dl>
            <div className="ledger-gauge">
              {ratio === undefined ? <p className="ledger-muted">未设上限</p> : <EnsoGauge ratio={ratio} size={QUOTA_HEIGHT} sublabel={quota} ariaLabel={quota} />}
              <BrushButton size="sm" variant="secondary" onClick={focusBudget}>设置预算</BrushButton>
            </div>
          </Plate>
          <Plate as="section" className="ledger-panel">
            <div className="ledger-heading">
              <h2>每日花费</h2>
              <BrushTabs items={RANGES} value={String(accountingDays) as '7' | '14' | '30'} onChange={(range) => setAccountingDays(range === '7' ? 7 : range === '14' ? 14 : 30)} ariaLabel="花费日期范围" />
            </div>
            {trend.length > 0 ? <InkArea data={trend} height={246} ariaLabel="每日花费趋势" formatValue={(value) => money(value, accounting.currency)} formatAxisValue={(value) => money(value, accounting.currency)} /> :
              <EmptyState glyph="无账" description="此期间没有每日花费数据。" />}
          </Plate>
          <PluginBreakdown summary={accounting} />
        </>
      ) : null}
      <PricePanel onSaved={() => { void refreshAccounting() }} />
      {accounting ? (
        <BudgetPanel
          initial={{ ...localBudget, dailyTokenLimit: accounting.dailyTokenLimit, dailyCostMicrosLimit: accounting.dailyCostMicrosLimit }}
          complete={localBudget !== undefined}
          currency={accounting.currency}
          sectionRef={budgetSection}
          firstInputRef={budgetInput}
          onSaved={(next) => {
            saveBudget(next)
            void refreshAccounting()
          }}
        />
      ) : null}
    </div>
  )
}

export function LedgerPage() {
  const { displayedRoute, navigate } = useShellNavigation()
  const interop = new URLSearchParams(displayedRoute.split('?')[1]).get('tab') === 'interop'
  const [budget, setBudget] = useState<AccountingBudgetConfig>()
  return (
    <section className="ledger-page">
      <PageHeader label="LEDGER · COST & INTEROP" title="账通" actions={<BrushTabs items={TABS} value={interop ? 'interop' : 'accounting'}
        ariaLabel="账通分区" onChange={(next) => navigate(next === 'interop' ? 'ledger?tab=interop' : 'ledger')} />} />
      {interop ? <InteropPanel /> : <AccountBook localBudget={budget} saveBudget={setBudget} />}
    </section>
  )
}
