import { useEffect, useRef, useState, type FormEvent, type Ref } from 'react'
import { accountingApi } from '../../api/client.ts'
import { ApiError, type AccountingBudgetConfig, type ModelPriceBook, type ModelPriceEntry, type PluginAccountingLimit } from '../../api/types.ts'
import { usePolling } from '../../data/polling.ts'
import { BrushButton } from '../../ui/BrushButton.tsx'
import { InkInput } from '../../ui/InkInput.tsx'
import { ErrorState, InkSkeleton } from '../../ui/InkStates.tsx'
import { InkTable, type InkTableColumn } from '../../ui/InkTable.tsx'
import { MagneticButton } from '../../ui/MagneticButton.tsx'
import { Plate } from '../../ui/Plate.tsx'
import { toast } from '../../ui/SealToast.tsx'

function errorText(err: unknown): string {
  return err instanceof ApiError ? `${err.code} · ${err.message}` : err instanceof Error ? err.message : '保存失败。'
}

const PRICE_FIELDS = [
  { id: 'inputPerMillion', label: '输入' },
  { id: 'outputPerMillion', label: '输出' },
  { id: 'cacheReadPerMillion', label: '缓存读' },
  { id: 'cacheWritePerMillion', label: '缓存写' },
] as const

interface PriceRow {
  readonly id: number
  readonly model: string
  readonly values: Readonly<Record<keyof ModelPriceEntry, string>>
}

function priceRows(book: ModelPriceBook): PriceRow[] {
  return Object.entries(book.models).map(([model, prices], id) => ({
    id, model, values: {
      inputPerMillion: String(prices.inputPerMillion),
      outputPerMillion: String(prices.outputPerMillion),
      cacheReadPerMillion: String(prices.cacheReadPerMillion),
      cacheWritePerMillion: String(prices.cacheWritePerMillion),
    },
  }))
}

function PriceEditor({ book, onSaved }: { readonly book: ModelPriceBook; readonly onSaved: () => void }) {
  const [rows, setRows] = useState(() => priceRows(book))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const busy = useRef(false)
  const nextId = useRef(rows.length)

  function edit(id: number, update: (row: PriceRow) => PriceRow): void {
    setRows((current) => current.map((row) => row.id === id ? update(row) : row))
  }

  const columns: readonly InkTableColumn<PriceRow>[] = [
    { key: 'model', header: '模型', render: (row) => (
      <InkInput aria-label="模型标识" value={row.model} disabled={loading} onChange={(event) => edit(row.id, (item) => ({ ...item, model: event.target.value }))} monospace />
    ) },
    ...PRICE_FIELDS.map(({ id, label }): InkTableColumn<PriceRow> => ({
      key: id, header: label, numeric: true, render: (row) => (
        <InkInput aria-label={`${row.model || '新模型'} ${label}价格`} value={row.values[id]} type="number" min={0} step="any" inputMode="decimal"
          disabled={loading} onChange={(event) => edit(row.id, (item) => ({ ...item, values: { ...item.values, [id]: event.target.value } }))}
          monospace containerClassName="ledger-price-input" />
      ),
    })),
    { key: 'remove', header: '', render: ({ id, model }) => (
      <BrushButton variant="ghost" size="sm" disabled={loading} aria-label={`移除 ${model || '空行'}`}
        onClick={() => setRows((current) => current.filter((item) => item.id !== id))}>移除</BrushButton>
    ) },
  ]

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (busy.current) return
    const entries: [string, ModelPriceEntry][] = []
    const seen = new Set<string>()
    for (const row of rows) {
      const model = row.model.trim()
      const { values } = row
      if (!model || seen.has(model)) { setError('模型标识不能留空或重复。'); return }
      if (Object.values(values).some((price) => price.trim() === '' || !Number.isFinite(Number(price)) || Number(price) < 0)) {
        setError(`「${model}」的四个价格都需要填写非负数。`)
        return
      }
      seen.add(model)
      entries.push([model, {
        inputPerMillion: Number(values.inputPerMillion),
        outputPerMillion: Number(values.outputPerMillion),
        cacheReadPerMillion: Number(values.cacheReadPerMillion),
        cacheWritePerMillion: Number(values.cacheWritePerMillion),
      }])
    }
    busy.current = true
    setLoading(true)
    setError('')
    try {
      const next = await accountingApi.savePrices({ version: 1, currency: book.currency, models: Object.fromEntries(entries) })
      const nextRows = priceRows(next)
      nextId.current = nextRows.length
      setRows(nextRows)
      onSaved()
      toast.success('价格表已保存')
    } catch (err) {
      setError(errorText(err))
    } finally {
      busy.current = false
      setLoading(false)
    }
  }

  return (
    <form className="ledger-form" onSubmit={(event) => { void save(event) }}>
      <p className="ledger-muted">{book.currency} / 百万 token</p>
      <div className="ledger-table"><InkTable columns={columns} rows={rows} getRowKey={(row) => row.id} ariaLabel="模型价格表" /></div>
      {error ? <p role="alert" style={{ color: 'var(--yanzhi)' }}>{error}</p> : null}
      <div className="ledger-heading">
        <BrushButton variant="secondary" disabled={loading} onClick={() => {
          const id = nextId.current++
          setRows((current) => [...current, { id, model: '', values: { inputPerMillion: '', outputPerMillion: '', cacheReadPerMillion: '', cacheWritePerMillion: '' } }])
        }}>添加模型</BrushButton>
        <MagneticButton disabled={loading}>
          <BrushButton variant="primary" type="submit" loading={loading}>保存价格</BrushButton>
        </MagneticButton>
      </div>
    </form>
  )
}

export function PricePanel({ onSaved }: { readonly onSaved: () => void }) {
  const prices = usePolling(() => accountingApi.prices(), 0)
  return (
    <Plate as="section" className="ledger-panel">
      <h2>价格表</h2>
      {prices.error ? <ErrorState message={errorText(prices.error)} onRetry={() => { void prices.refresh() }} /> :
        prices.data ? <PriceEditor book={prices.data} onSaved={onSaved} /> : <InkSkeleton rows={2} height={38} />}
    </Plate>
  )
}

const PLUGIN_FIELDS = [
  { id: 'dailyTokenLimit', name: '每日 token', min: 0 },
  { id: 'dailyCallsLimit', name: '每日调用次数', min: 0 },
  { id: 'maxOutputTokens', name: '单次输出 token', min: 1 },
] as const

interface LimitRow {
  readonly id: number
  readonly pluginId: string
  readonly values: Readonly<Record<keyof PluginAccountingLimit, string>>
}

function optionalInteger(value: string, label: string, min = 0): number | undefined {
  if (value.trim() === '') return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min) throw new Error(`${label}需要填写不小于 ${min} 的整数。`)
  return parsed
}

function decimalMicros(value: string): number | undefined {
  if (value.trim() === '') return undefined
  const parsed = Number(value) * 1_000_000
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isSafeInteger(Math.round(parsed))) throw new Error('每日花费上限需要填写有效的非负金额。')
  return Math.round(parsed)
}

export function BudgetPanel({ initial, complete, currency, sectionRef, firstInputRef, onSaved }: {
  readonly initial: AccountingBudgetConfig
  readonly complete: boolean
  readonly currency: string
  readonly sectionRef?: Ref<HTMLElement>
  readonly firstInputRef?: Ref<HTMLInputElement>
  readonly onSaved: (budget: AccountingBudgetConfig) => void
}) {
  const [dailyTokens, setDailyTokens] = useState(initial.dailyTokenLimit?.toString() ?? '')
  const [dailyCost, setDailyCost] = useState(initial.dailyCostMicrosLimit === undefined ? '' : String(initial.dailyCostMicrosLimit / 1_000_000))
  const [pluginTokens, setPluginTokens] = useState(initial.pluginDailyTokenLimit?.toString() ?? '')
  const [rows, setRows] = useState<LimitRow[]>(() => Object.entries(initial.pluginLimits ?? {}).map(([pluginId, row], id) => ({
    id, pluginId, values: {
      dailyTokenLimit: row.dailyTokenLimit?.toString() ?? '', dailyCallsLimit: row.dailyCallsLimit?.toString() ?? '', maxOutputTokens: row.maxOutputTokens?.toString() ?? '',
    },
  })))
  const [dirty, setDirty] = useState(false)
  const [acknowledged, setAcknowledged] = useState(complete)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const nextId = useRef(rows.length)
  const busy = useRef(false)

  useEffect(() => {
    if (dirty) return
    setDailyTokens(initial.dailyTokenLimit?.toString() ?? '')
    setDailyCost(initial.dailyCostMicrosLimit === undefined ? '' : String(initial.dailyCostMicrosLimit / 1_000_000))
  }, [dirty, initial.dailyCostMicrosLimit, initial.dailyTokenLimit])

  useEffect(() => {
    if (complete) setAcknowledged(true)
  }, [complete])

  function edit(id: number, update: (row: LimitRow) => LimitRow): void {
    setDirty(true)
    setRows((current) => current.map((row) => row.id === id ? update(row) : row))
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (busy.current || !acknowledged) return
    busy.current = true
    setSaving(true)
    setError('')
    try {
      const entries: [string, PluginAccountingLimit][] = []
      const seen = new Set<string>()
      for (const row of rows) {
        const id = row.pluginId.trim()
        if (!id || ['__proto__', 'constructor', 'prototype'].includes(id) || seen.has(id)) throw new Error('插件标识无效或重复。')
        seen.add(id)
        entries.push([id, {
          dailyTokenLimit: optionalInteger(row.values.dailyTokenLimit, `${id} 的每日 token`),
          dailyCallsLimit: optionalInteger(row.values.dailyCallsLimit, `${id} 的每日调用次数`),
          maxOutputTokens: optionalInteger(row.values.maxOutputTokens, `${id} 的单次输出 token`, 1),
        }])
      }
      const next = await accountingApi.saveBudget({
        dailyTokenLimit: optionalInteger(dailyTokens, '每日 token 上限'),
        dailyCostMicrosLimit: decimalMicros(dailyCost),
        pluginDailyTokenLimit: optionalInteger(pluginTokens, '单个插件每日 token 上限'),
        pluginLimits: Object.fromEntries(entries),
      })
      setDirty(false)
      toast.success('预算已保存')
      onSaved(next)
    } catch (err) {
      setError(errorText(err))
    } finally {
      busy.current = false
      setSaving(false)
    }
  }

  return (
    <Plate ref={sectionRef} as="section" id="ledger-budget" className="ledger-panel ledger-budget-section">
      <h2>预算</h2>
      <form className="ledger-form" onSubmit={(event) => { void save(event) }}>
        <p className="ledger-muted">留空表示不限。保存会替换整份预算。</p>
        <div className="ledger-budget-grid">
          <InkInput ref={firstInputRef} label="每日 token 上限" type="number" min={0} step={1} value={dailyTokens} onChange={(event) => { setDirty(true); setDailyTokens(event.target.value) }} disabled={saving} monospace />
          <InkInput label={`每日花费上限（${currency}）`} type="number" min={0} step={0.000001} value={dailyCost} onChange={(event) => { setDirty(true); setDailyCost(event.target.value) }} disabled={saving} monospace />
          <InkInput label="单个插件的每日 token 上限" type="number" min={0} step={1} value={pluginTokens} onChange={(event) => { setDirty(true); setPluginTokens(event.target.value) }} disabled={saving} monospace />
        </div>
        <h3>按插件的上限</h3>
        {rows.map((row) => (
          <Plate level="sunken" key={row.id} className="ledger-form ledger-limit">
            <InkInput label="插件标识" value={row.pluginId} onChange={(event) => edit(row.id, (item) => ({ ...item, pluginId: event.target.value }))} disabled={saving} monospace />
            <div className="ledger-limit-fields">
              {PLUGIN_FIELDS.map(({ id, name, min }) => (
                <InkInput key={id} label={name} type="number" step={1} min={min} value={row.values[id]}
                  onChange={(event) => edit(row.id, (item) => ({ ...item, values: { ...item.values, [id]: event.target.value } }))} disabled={saving} monospace />
              ))}
            </div>
            <div>
              <BrushButton variant="ghost" size="sm" disabled={saving} onClick={() => { setDirty(true); setRows((current) => current.filter((item) => item.id !== row.id)) }}>移除</BrushButton>
            </div>
          </Plate>
        ))}
        <div><BrushButton variant="secondary" disabled={saving} onClick={() => {
          const id = nextId.current++
          setDirty(true)
          setRows((current) => [...current, { id, pluginId: '', values: { dailyTokenLimit: '', dailyCallsLimit: '', maxOutputTokens: '' } }])
        }}>添加插件上限</BrushButton></div>
        {!complete ? (
          <Plate tone="warn" className="ledger-panel">
            <p>当前接口只返回全局上限。若已设置逐插件上限，请在保存前重新填入。</p>
            <label><input type="checkbox" checked={acknowledged} disabled={saving} onChange={(event) => setAcknowledged(event.target.checked)} /> 确认按表单替换预算</label>
          </Plate>
        ) : null}
        {error ? <p role="alert" style={{ color: 'var(--yanzhi)' }}>{error}</p> : null}
        <div className="ledger-heading">
          <span />
          <MagneticButton disabled={saving || !acknowledged}>
            <BrushButton variant="primary" type="submit" loading={saving} disabled={!acknowledged}>保存预算</BrushButton>
          </MagneticButton>
        </div>
      </form>
    </Plate>
  )
}
