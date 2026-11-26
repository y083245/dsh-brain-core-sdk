import { useCallback, useEffect, useState } from 'react'
import { memoryApi } from '../../api/client.ts'
import { LAYERS, type PersonSummary } from '../../api/types.ts'
import { Badge, BrushButton, BrushTabs, EmptyState, InkInput, InkSelect, InkSkeleton, InkSlider, InkSwitch, LayerTag, Plate } from '../../ui/index.ts'
import { highlighted, recordSummary, RequestError, shortDate } from './common.tsx'
import {
  buildConsoleSearchRequest,
  formatPersonLabel,
  formatScopeSummary,
  INITIAL_SEARCH_OPTIONS,
  type ResolvedSearchContext,
  type SearchOptions,
} from './searchContext.ts'

export { INITIAL_SEARCH_OPTIONS, type SearchOptions }

const SEARCH_LAYERS = [...LAYERS].reverse()
const SCOPES = [
  { id: 'here', label: '当前通道' },
  { id: 'person', label: '当前人物' },
  { id: 'all', label: '全部' },
] as const

function channelHelperText(context: ResolvedSearchContext): string | undefined {
  if (context.effectiveChannel === null) return undefined
  switch (context.channelSource) {
    case 'option':
      return `当前生效通道：${context.effectiveChannel}`
    case 'filter':
      return `跟随墨阶筛选通道：${context.effectiveChannel}`
    case 'voice':
      return `跟随语页当前通道：${context.effectiveChannel}`
    case 'sole':
      return `自动选定唯一已知通道：${context.effectiveChannel}`
    default:
      return undefined
  }
}

function personHelperText(context: ResolvedSearchContext): string | undefined {
  if (context.effectivePersonId === null) return undefined
  const label = context.effectivePersonLabel ?? context.effectivePersonId
  switch (context.personSource) {
    case 'option':
      return `当前生效人物：${label}`
    case 'filter':
      return `跟随墨阶筛选人物：${label}`
    case 'sole':
      return `自动选定唯一人物：${label}`
    default:
      return undefined
  }
}

export function SearchOptionsCard({
  options,
  onChange,
  persons,
  context,
}: {
  readonly options: SearchOptions
  readonly onChange: (next: SearchOptions) => void
  readonly persons: readonly PersonSummary[]
  readonly context: ResolvedSearchContext
}) {
  const autoChannelLabel = context.effectiveChannel !== null && options.channel === ''
    ? `自动（${context.effectiveChannel}）`
    : '请选择通道'
  const autoPersonLabel = options.scope === 'person'
    ? (context.effectivePersonId !== null && options.subject === ''
      ? `自动（${context.effectivePersonLabel ?? context.effectivePersonId}）`
      : '请选择人物')
    : '全部'

  return <Plate level="raised" className="memory-search-options memory-inset" style={{ position: 'absolute' }}>
    <div className="memory-stack">
      <BrushTabs items={SCOPES} value={options.scope} ariaLabel="检索范围"
        onChange={(scope) => onChange({ ...options, scope })} />
      {options.scope === 'here' && (
        <InkSelect
          label="当前通道"
          value={options.channel}
          options={[
            { value: '', label: autoChannelLabel },
            ...context.availableChannels.map((channel) => ({ value: channel, label: channel })),
          ]}
          helperText={channelHelperText(context)}
          error={context.effectiveChannel === null
            ? (context.availableChannels.length > 0
              ? '请先选择要检索的通道，或在墨阶筛选条选定通道'
              : '当前还没有已知通道')
            : null}
          onChange={(channel) => onChange({ ...options, channel })}
        />
      )}
      <div className="memory-actions" aria-label="检索层级">
        {SEARCH_LAYERS.map((layer) => <label key={layer} className="memory-actions">
          <input type="checkbox" checked={options.layers.includes(layer)} onChange={(event) =>
            onChange({ ...options, layers: event.target.checked
              ? [...options.layers, layer] : options.layers.filter((value) => value !== layer) })}
          /> <LayerTag layer={layer} />
        </label>)}
      </div>
      <div className="memory-pair">
        <InkInput type="date" label="开始日期" value={options.from}
          onChange={(event) => onChange({ ...options, from: event.target.value })} />
        <InkInput type="date" label="结束日期" value={options.to}
          onChange={(event) => onChange({ ...options, to: event.target.value })} />
      </div>
      <InkSelect
        label={options.scope === 'person' ? '当前人物' : '主体'}
        value={options.subject}
        options={[
          { value: '', label: autoPersonLabel },
          ...persons.map((person) => ({
            value: person.personId,
            label: formatPersonLabel(person.personId, persons),
          })),
        ]}
        helperText={options.scope === 'person' ? personHelperText(context) : undefined}
        error={options.scope === 'person' && context.effectivePersonId === null
          ? (persons.length > 0
            ? '请先在高级检索或筛选条中选择要检索的人物'
            : '当前还没有可检索的人物')
          : null}
        onChange={(subject) => onChange({ ...options, subject })}
      />
      <InkSlider label="前后邻居" min={0} max={3} step={1} value={options.neighbors}
        onChange={(neighbors) => onChange({ ...options, neighbors })} />
      <InkSwitch label="历史版本" checked={options.history} onChange={(history) => onChange({ ...options, history })} />
    </div>
  </Plate>
}

type SearchResult = Awaited<ReturnType<typeof memoryApi.search>>

export function MemorySearch({
  query,
  options,
  context,
  persons,
  onOptionsChange,
  onRecord,
  onClear,
}: {
  readonly query: string
  readonly options: SearchOptions
  readonly context: ResolvedSearchContext
  readonly persons: readonly PersonSummary[]
  readonly onOptionsChange: (next: SearchOptions) => void
  readonly onRecord: (id: string) => void
  readonly onClear: () => void
}) {
  const [result, setResult] = useState<SearchResult>()
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState(context.missingReason === null)
  const [revision, setRevision] = useState(0)

  const missingReason = context.missingReason
  const scopeSummary = formatScopeSummary(context)

  const makeRequest = useCallback((cursor?: string) => {
    const request = buildConsoleSearchRequest(query, options, context, cursor)
    if (request === null) return null
    return memoryApi.search(request)
  }, [query, options, context])

  useEffect(() => {
    let current = true
    setResult(undefined)
    setError(undefined)
    const pending = makeRequest()
    if (pending === null) {
      setBusy(false)
      return () => { current = false }
    }
    setBusy(true)
    void pending.then(
      (value) => { if (current) setResult(value) },
      (cause: unknown) => { if (current) setError(cause) },
    ).finally(() => { if (current) setBusy(false) })
    return () => { current = false }
  }, [makeRequest, revision])

  async function more() {
    if (!result?.nextCursor || busy) return
    const pending = makeRequest(result.nextCursor)
    if (pending === null) return
    setBusy(true)
    setError(undefined)
    try {
      const next = await pending
      setResult((current) => current === result ? {
        items: [...result.items, ...next.items], degraded: result.degraded || next.degraded,
        nextCursor: next.nextCursor,
      } : current)
    } catch (cause) {
      setError(cause)
    } finally {
      setBusy(false)
    }
  }

  return <div className="memory-stack">
    <Plate level="sunken" className="memory-inset memory-toolbar">
      <span>
        检索：{query} · {scopeSummary} · {missingReason !== null
          ? '待选择上下文'
          : result === undefined
            ? '正在检索'
            : `${result.nextCursor ? '已加载 ' : ''}${result.items.length} 条`}
      </span>
      <BrushButton variant="ghost" size="sm" onClick={onClear}>清除</BrushButton>
    </Plate>
    {missingReason === 'channel' && (
      <Plate tone="warn" className="memory-inset memory-stack" role="status">
        <span>
          {context.availableChannels.length > 0
            ? '当前未选定检索通道。请先在下方、高级检索选项或墨阶筛选条中选择要检索的通道。'
            : '当前还没有已知通道，请先切到「全部」范围检索。'}
        </span>
        <div className="memory-actions">
          {context.availableChannels.length > 0 && (
            <InkSelect
              ariaLabel="选择当前通道"
              placeholder="选择通道"
              value={options.channel}
              options={[
                { value: '', label: '请选择通道' },
                ...context.availableChannels.map((channel) => ({ value: channel, label: channel })),
              ]}
              onChange={(channel) => onOptionsChange({ ...options, channel })}
            />
          )}
          <BrushButton variant="secondary" size="sm" onClick={() => onOptionsChange({ ...options, scope: 'all' })}>
            改为全部范围
          </BrushButton>
        </div>
      </Plate>
    )}
    {missingReason === 'person' && (
      <Plate tone="warn" className="memory-inset memory-stack" role="status">
        <span>
          {persons.length > 0
            ? '请先在高级检索或筛选条中选择要检索的人物。'
            : '当前还没有可检索的人物，请先切到「全部」范围检索。'}
        </span>
        <div className="memory-actions">
          {persons.length > 0 && (
            <InkSelect
              ariaLabel="选择当前人物"
              placeholder="选择人物"
              value={options.subject}
              options={[
                { value: '', label: '请选择人物' },
                ...persons.map((person) => ({
                  value: person.personId,
                  label: formatPersonLabel(person.personId, persons),
                })),
              ]}
              onChange={(subject) => onOptionsChange({ ...options, subject })}
            />
          )}
          <BrushButton variant="secondary" size="sm" onClick={() => onOptionsChange({ ...options, scope: 'all' })}>
            改为全部范围
          </BrushButton>
        </div>
      </Plate>
    )}
    {result?.degraded && <Plate tone="warn" className="memory-inset" role="status">索引降级，结果可能不全</Plate>}
    {error !== undefined && <RequestError error={error} retry={() => setRevision((value) => value + 1)} />}
    {missingReason === null && busy && result === undefined && <Plate className="memory-inset"><InkSkeleton rows={5} /></Plate>}
    {missingReason === null && result?.items.length === 0 && <Plate><EmptyState glyph="无痕" description="没有找到匹配的记忆。" /></Plate>}
    {SEARCH_LAYERS.map((layer) => {
      const hits = result?.items.filter(({ record }) => record.layer === layer && record.status !== 'tombstoned') ?? []
      if (!hits.length) return null
      return <Plate key={layer} level="base" className="memory-layer">
        <header className="memory-layer-header"><LayerTag layer={layer} /><span className="num">{hits.length} 条</span></header>
        {hits.map((hit) => <article key={hit.record.id} className="memory-search-record">
          <button type="button" className="memory-search-hit" onClick={() => onRecord(hit.record.id)}>
            <span>{highlighted(recordSummary(hit.record, 160), query)}</span>
            <span className="num">{hit.score.toFixed(2)}</span>
            <Badge tone={hit.disclosure.speakable === 'never' ? 'yanzhi' :
              hit.disclosure.speakable === 'if-subject-raises' ? 'tenghuang' : 'neutral'}>{hit.disclosure.label}</Badge>
          </button>
          {hit.neighbors?.map((item) => <button type="button" key={item.record.id} className="memory-search-neighbor" onClick={() => onRecord(item.record.id)}>
            <span className="num">{item.position === 'before' ? '之前' : '之后'} · {shortDate(item.record.tEvent)}</span>
            <span>{recordSummary(item.record)}</span>
          </button>)}
          {hit.history?.map((entry, index) => <p key={`${entry.key}:${index}`} className="memory-search-history">
            <span className="num">{shortDate(entry.changedAt)} · {entry.label}</span> <del>{entry.text}</del>
          </p>)}
        </article>)}
      </Plate>
    })}
    {result?.nextCursor && <BrushButton variant="secondary" loading={busy} onClick={() => void more()}>加载更多结果</BrushButton>}
  </div>
}
