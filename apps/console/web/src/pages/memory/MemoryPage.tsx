import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Ellipsis, Search } from 'lucide-react'
import { memoryApi } from '../../api/client.ts'
import type { CrossChannelMode, Layer, MemoryRecord, PersonSummary } from '../../api/types.ts'
import { useInk } from '../../ink/InkProvider.tsx'
import type { InkEngine } from '../../ink/engine.ts'
import { REDUCED_FADE_DURATION } from '../../motion/presets.ts'
import { DUR } from '../../motion/tokens.ts'
import { useMotionLevel } from '../../motion/useMotionLevel.ts'
import { useConsoleShellData } from '../../shell/ConsoleShell.tsx'
import { useShellNavigation } from '../../shell/PageTransition.tsx'
import { BrushButton, BrushTabs, Covenant, HoldToStamp, InkInput, InkSkeleton, PageHeader, Plate, toast } from '../../ui/index.ts'
import { useVoiceSession } from '../voice/voiceSession.ts'
import { MemoryAudit } from './MemoryAudit.tsx'
import { MemoryDetails } from './MemoryDetails.tsx'
import { ForgetCovenant, type ForgetCompletedPayload, type ForgetTarget } from './ForgetCovenant.tsx'
import { MemoryPersons } from './MemoryPersons.tsx'
import { INITIAL_SEARCH_OPTIONS, MemorySearch, SearchOptionsCard, type SearchOptions } from './MemorySearch.tsx'
import { INITIAL_FILTERS, MemoryStrata, type StrataFilters } from './MemoryStrata.tsx'
import { notifyRequestError, RequestError, useResource } from './common.tsx'
import { resolveSearchContext } from './searchContext.ts'
import {
  BROWSE_BATCH_LIMIT,
  fetchAllBrowsePages,
  selectGraphRecords,
  type ForgetDissolveState,
  type ForgetPreviewState,
} from './forgetPreview.ts'
import './memory.css'

const GraphView = lazy(() => import('../../memory/graph/GraphView.tsx').then(({ GraphView: Component }) => ({ default: Component })))
const TABS = [
  { id: 'strata', label: '墨阶' }, { id: 'graph', label: '墨痕' },
  { id: 'persons', label: '人物' }, { id: 'audit', label: '审计' },
] as const
type MemoryTab = typeof TABS[number]['id']
const MODES = [
  { id: 'off', label: 'off', disabled: false },
  { id: 'shadow', label: 'shadow', disabled: false },
  { id: 'on', label: 'on', disabled: false },
] as const
const MODE_LABELS: Readonly<Record<CrossChannelMode, string>> = {
  off: '不跨通道', shadow: '影子：记录但不说', on: '跨通道',
}
const EMPTY_PERSONS: readonly PersonSummary[] = []
const SEARCH_DEBOUNCE_MS = 400
const DISSOLVE_DEPTH_STAGGER_MS = 140
const DISSOLVE_SETTLE_PAD_MS = 140

// These controls survive station transitions and are discarded on page reload.
let rememberedFilters = INITIAL_FILTERS
let rememberedOptions = INITIAL_SEARCH_OPTIONS
let rememberedTab: MemoryTab = 'strata'
let rememberedLayers = { L2: true, L1: true, L0: true }

function routeParams(route: string): URLSearchParams {
  return new URLSearchParams(route.split('?')[1] ?? '')
}

function supportsGraph(ink: InkEngine): boolean {
  const { quality, backend, contextLost } = ink.getStats()
  return quality !== 'static' && backend === 'webgl2' && !contextLost && typeof window !== 'undefined' && window.innerWidth >= 1024
}

interface RawGraphLayers {
  readonly l3: readonly MemoryRecord[]
  readonly l2: readonly MemoryRecord[]
  readonly l1: readonly MemoryRecord[]
  readonly l0: readonly MemoryRecord[]
  readonly l0ReachedPageCap: boolean
}

async function fetchLayerAll(layer: Layer, isCancelled: () => boolean) {
  return fetchAllBrowsePages(
    (cursor) => memoryApi.browse({ layer, cursor, limit: BROWSE_BATCH_LIMIT }),
    { isCancelled },
  )
}

async function fetchGraphLayers(isCancelled: () => boolean): Promise<RawGraphLayers> {
  const [l3Res, l2Res, l1Res, l0Res] = await Promise.all([
    fetchLayerAll('L3', isCancelled),
    fetchLayerAll('L2', isCancelled),
    fetchLayerAll('L1', isCancelled),
    fetchLayerAll('L0', isCancelled),
  ])
  return {
    l3: l3Res.items,
    l2: l2Res.items,
    l1: l1Res.items,
    l0: l0Res.items,
    l0ReachedPageCap: l0Res.reachedPageCap,
  }
}

export function MemoryPage() {
  const ink = useInk()
  const reduced = useMotionLevel() === 'reduced'
  const { displayedRoute, navigate } = useShellNavigation()
  const shell = useConsoleShellData()
  const { channel: voiceChannel } = useVoiceSession()
  const [tab, setTabState] = useState<MemoryTab>(rememberedTab)
  const [filters, setFilterState] = useState(rememberedFilters)
  const [opened, setOpened] = useState(rememberedLayers)
  const [searchOptions, setSearchOptions] = useState<SearchOptions>(rememberedOptions)
  const [advanced, setAdvanced] = useState(false)
  const [draftQuery, setDraftQuery] = useState('')
  const [query, setQuery] = useState('')
  const [trail, setTrail] = useState<readonly string[]>([])
  const [updates, setUpdates] = useState<ReadonlyMap<string, MemoryRecord>>(new Map())
  const [erasedIds, setErasedIds] = useState<ReadonlySet<string>>(new Set())
  const [channels, setChannels] = useState<readonly string[]>([])
  const [writingMode, setWritingMode] = useState(false)
  const [confirmEnabled, setConfirmEnabled] = useState(false)
  const [graphUnavailable, setGraphUnavailable] = useState(false)

  // Forget covenant, cascade preview, and dissolve choreography states
  const [forgetTarget, setForgetTarget] = useState<ForgetTarget | null>(null)
  const [forgetPreview, setForgetPreview] = useState<ForgetPreviewState | null>(null)
  const [forgetDissolve, setForgetDissolve] = useState<ForgetDissolveState | null>(null)
  const [strataRefreshVersion, setStrataRefreshVersion] = useState(0)
  const [forgottenPersonEvent, setForgottenPersonEvent] = useState<{ readonly id: number; readonly personId: string } | null>(null)

  const dissolveSeqRef = useRef(0)
  const dissolveTimerRef = useRef<number | null>(null)
  const knownRecordsRef = useRef<Map<string, MemoryRecord>>(new Map())
  const probedChannelsRef = useRef(false)
  const searchInput = useRef<HTMLInputElement>(null)

  const persons = useResource(memoryApi.listPersons)
  const lastPersons = useRef(EMPTY_PERSONS)
  if (persons.data !== undefined) lastPersons.current = persons.data
  const knownPersons = persons.data ?? lastPersons.current
  const current = shell.l3Versions.find((version) => version.current)
  const activeMode = shell.crossChannelMode
  const sessionChannels = useMemo(
    () => (shell.satellite?.sessions ?? []).map((item) => item.channel),
    [shell.satellite?.sessions],
  )
  const searchContext = useMemo(
    () => resolveSearchContext({
      options: searchOptions,
      filterChannel: filters.channel,
      filterPersonId: filters.personId,
      discoveredChannels: channels,
      sessionChannels,
      voiceChannel,
      persons: knownPersons,
    }),
    [channels, filters.channel, filters.personId, knownPersons, searchOptions, sessionChannels, voiceChannel],
  )

  const registerChannels = useCallback((records: readonly MemoryRecord[]) => {
    setChannels((known) => {
      const values = new Set(known)
      for (const record of records) values.add(record.channel)
      return known.length === values.size ? known : [...values].sort()
    })
  }, [])
  const updateSearchOptions = useCallback((value: SearchOptions) => {
    setSearchOptions(value)
    rememberedOptions = value
  }, [])

  // Discover existing channels when opening search options or 'here' scope before Strata loads.
  useEffect(() => {
    if (probedChannelsRef.current || channels.length > 0) return
    if (!(advanced || (query !== '' && searchOptions.scope === 'here'))) return
    if (tab === 'strata' && query === '') return
    probedChannelsRef.current = true
    let cancelled = false
    void memoryApi.browse({ limit: 50 }).then(
      (page) => {
        if (!cancelled && page.items.length > 0) registerChannels(page.items)
      },
      () => {
        // Non-fatal: channel candidates fall back to active voice/session channels.
      },
    )
    return () => {
      cancelled = true
    }
  }, [advanced, channels.length, query, registerChannels, searchOptions.scope, tab])

  // Graph data loader with cancellation & race guard
  const graphEnabled = tab === 'graph' && query === '' && !reduced && supportsGraph(ink)
  const [graphState, setGraphState] = useState<{
    readonly data?: RawGraphLayers
    readonly error?: unknown
    readonly loading: boolean
  }>({ loading: false })
  const [graphReloadSeq, setGraphReloadSeq] = useState(0)

  const reloadGraph = useCallback(() => {
    setGraphReloadSeq((n) => n + 1)
  }, [])

  useEffect(() => {
    if (!graphEnabled) return
    let cancelled = false
    setGraphState((prev) => ({ data: prev.data, error: undefined, loading: prev.data === undefined }))
    void fetchGraphLayers(() => cancelled).then(
      (data) => {
        if (cancelled) return
        const allGraphRecords = [...data.l3, ...data.l2, ...data.l1, ...data.l0]
        for (const rec of allGraphRecords) {
          knownRecordsRef.current.set(rec.id, rec)
        }
        registerChannels(allGraphRecords)
        setGraphState({ data, error: undefined, loading: false })
      },
      (error: unknown) => {
        if (cancelled) return
        setGraphState({ data: undefined, error, loading: false })
      },
    )
    return () => {
      cancelled = true
    }
  }, [graphEnabled, graphReloadSeq, registerChannels])

  const graphSlice = useMemo(() => {
    if (!graphState.data) return { records: [] as readonly MemoryRecord[], truncated: false }
    const applyPatch = (items: readonly MemoryRecord[]) =>
      items
        .filter((record) => !erasedIds.has(record.id))
        .map((record) => updates.get(record.id) ?? record)
    return selectGraphRecords({
      l3: applyPatch(graphState.data.l3),
      l2: applyPatch(graphState.data.l2),
      l1: applyPatch(graphState.data.l1),
      l0: applyPatch(graphState.data.l0),
      l0ReachedPageCap: graphState.data.l0ReachedPageCap,
      currentL3Version: current?.version,
    })
  }, [current?.version, erasedIds, graphState.data, updates])

  const selectTab = useCallback((next: MemoryTab) => {
    setTabState(next)
    rememberedTab = next
    setQuery('')
    setDraftQuery('')
    setAdvanced(false)
  }, [])

  const changeFilters = useCallback((patch: Partial<StrataFilters>) => {
    setFilterState((value) => {
      rememberedFilters = { ...value, ...patch }
      return rememberedFilters
    })
  }, [])

  const onRecord = useCallback((id: string) => setTrail([id]), [])
  const onClose = useCallback(() => setTrail([]), [])
  const onHeart = useCallback(() => navigate('heart'), [navigate])
  const closeConfirm = useCallback(() => setConfirmEnabled(false), [])
  const registerKnownRecords = useCallback((records: readonly MemoryRecord[]) => {
    for (const record of records) {
      knownRecordsRef.current.set(record.id, record)
    }
  }, [])

  const openForgetRecord = useCallback((record: MemoryRecord) => {
    if (record.layer === 'L3') return
    knownRecordsRef.current.set(record.id, record)
    setForgetTarget({ kind: 'record', record })
  }, [])

  const openForgetPerson = useCallback((person: PersonSummary) => {
    setForgetTarget({ kind: 'person', person })
  }, [])

  const openForgetChannel = useCallback((channel: string) => {
    if (!channel) return
    setForgetTarget({ kind: 'channel', channel })
  }, [])

  const openForgetTime = useCallback(() => {
    setForgetTarget({
      kind: 'time',
      defaultChannel: filters.channel || undefined,
      channels,
    })
  }, [channels, filters.channel])

  const closeForget = useCallback(() => {
    setForgetTarget(null)
    setForgetPreview(null)
  }, [])

  const handleForgetCompleted = useCallback(
    (payload: ForgetCompletedPayload) => {
      setForgetTarget(null)
      setForgetPreview(null)
      setTrail([])

      // Evict erased records immediately so consecutive forget cascades never read stale cache entries
      if (payload.target.kind !== 'record') {
        knownRecordsRef.current.clear()
      } else {
        for (const id of payload.erasedDepthById.keys()) {
          knownRecordsRef.current.delete(id)
        }
      }

      // Immediately transition non-erased flagged records (e.g. L3) to outdated so they show brushIn strikethrough
      if (payload.outdatedIds.size > 0) {
        setUpdates((prev) => {
          const next = new Map(prev)
          for (const id of payload.outdatedIds) {
            const existing = prev.get(id) ?? knownRecordsRef.current.get(id)
            if (existing) {
              const patched: MemoryRecord = { ...existing, status: 'outdated' }
              next.set(id, patched)
              knownRecordsRef.current.set(id, patched)
            }
          }
          return next
        })
      }

      if (payload.target.kind === 'person') {
        const eventId = ++dissolveSeqRef.current
        setForgottenPersonEvent({ id: eventId, personId: payload.target.person.personId })
      }

      if (dissolveTimerRef.current !== null) {
        window.clearTimeout(dissolveTimerRef.current)
        dissolveTimerRef.current = null
      }

      const finishRefresh = (erased: ReadonlyMap<string, number>) => {
        if (erased.size > 0) {
          setErasedIds((prev) => {
            const next = new Set(prev)
            for (const id of erased.keys()) next.add(id)
            return next
          })
        }
        setForgetDissolve(null)
        setStrataRefreshVersion((v) => v + 1)
        if (graphEnabled) reloadGraph()
        if (payload.target.kind === 'person') persons.reload()
        if (payload.report.l3Flagged > 0) void shell.refreshL3Versions()
      }

      if (payload.erasedDepthById.size > 0) {
        const dissolveId = ++dissolveSeqRef.current
        setForgetDissolve({
          id: dissolveId,
          erasedDepthById: payload.erasedDepthById,
          outdatedIds: payload.outdatedIds,
          startedAtMs: performance.now(),
        })
        let maxDepth = 0
        for (const depth of payload.erasedDepthById.values()) {
          if (depth > maxDepth) maxDepth = depth
        }
        const totalWaitMs = reduced
          ? Math.round(REDUCED_FADE_DURATION * 1000) + DISSOLVE_SETTLE_PAD_MS
          : maxDepth * DISSOLVE_DEPTH_STAGGER_MS + Math.round(DUR.dissolve * 1000) + DISSOLVE_SETTLE_PAD_MS
        dissolveTimerRef.current = window.setTimeout(() => {
          dissolveTimerRef.current = null
          finishRefresh(payload.erasedDepthById)
        }, totalWaitMs)
      } else {
        finishRefresh(payload.erasedDepthById)
      }
    },
    [graphEnabled, persons, reduced, reloadGraph, shell],
  )

  useEffect(() => () => {
    if (dissolveTimerRef.current !== null) {
      window.clearTimeout(dissolveTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const params = routeParams(displayedRoute)
    const id = params.get('record')
    if (params.get('view') === 'audit') selectTab('audit')
    if (id) onRecord(id)
  }, [displayedRoute, onRecord, selectTab])

  useEffect(() => {
    const clean = draftQuery.trim()
    if (clean === query) return
    const timer = window.setTimeout(() => setQuery(clean), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [draftQuery, query])

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent): void => {
      if (event.key !== '/' || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      event.preventDefault()
      searchInput.current?.focus()
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [])

  useEffect(() => {
    const allowGraph = tab === 'graph' && query === '' && !reduced
    ink.setCalm(!allowGraph)
    return () => ink.setCalm(true)
  }, [ink, query, reduced, tab])

  useEffect(() => {
    if (tab !== 'graph' || query !== '') return
    const check = () => {
      if (!supportsGraph(ink)) {
        setGraphUnavailable(true)
        selectTab('strata')
      }
    }
    check()
    window.addEventListener('resize', check)
    const timer = window.setInterval(check, 500)
    return () => {
      window.removeEventListener('resize', check)
      window.clearInterval(timer)
    }
  }, [ink, query, selectTab, tab])

  async function writeMode(value: CrossChannelMode) {
    setWritingMode(true)
    try {
      await memoryApi.setCrossChannelMode(value)
      await shell.refreshCrossChannelMode()
      toast.success(`跨通道模式已切换为 ${value}`)
    } finally {
      setWritingMode(false)
    }
  }

  function changeMode(value: CrossChannelMode) {
    if (value === activeMode || writingMode) return
    if (value === 'on') setConfirmEnabled(true)
    else void writeMode(value).catch(notifyRequestError)
  }

  return <div className="memory-page memory-stack">
    <PageHeader label="MEMORY · STRATA" title="记忆" />
    <Plate level="raised" className="memory-toolbar memory-inset">
      <BrushTabs items={TABS} value={tab} onChange={(value) => { setGraphUnavailable(false); selectTab(value) }} ariaLabel="记忆视图" />
      <div className="memory-toolbar-controls">
        <form className="memory-search-form" onSubmit={(event) => { event.preventDefault(); setQuery(draftQuery.trim()) }}>
          <InkInput ref={searchInput} type="search" value={draftQuery}
            onChange={(event) => setDraftQuery(event.target.value)} aria-label="检索记忆"
            placeholder="检索记忆 · /" prefix={<Search size={17} aria-hidden="true" />} />
          <BrushButton variant="ghost" size="sm" aria-label="高级检索选项" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
            <Ellipsis size={18} aria-hidden="true" />
          </BrushButton>
          {advanced && <SearchOptionsCard options={searchOptions} persons={knownPersons} context={searchContext} onChange={updateSearchOptions} />}
        </form>
        {activeMode && <div className="memory-cross-channel" title={MODE_LABELS[activeMode]}>
          <BrushTabs items={MODES.map((item) => ({ ...item, disabled: writingMode }))} value={activeMode}
            onChange={changeMode} ariaLabel="跨通道模式" size="sm" />
        </div>}
      </div>
    </Plate>
    {graphUnavailable && <Plate className="memory-inset" role="status">此设备只能以列表查看</Plate>}
    {query ? <MemorySearch key={JSON.stringify([query, searchOptions, searchContext.effectiveChannel, searchContext.effectivePersonId])}
      query={query} options={searchOptions} context={searchContext} persons={knownPersons}
      onOptionsChange={updateSearchOptions} onRecord={onRecord}
      onClear={() => { setDraftQuery(''); setQuery('') }} /> :
      tab === 'strata' ? <MemoryStrata filters={filters} onFilters={changeFilters} persons={knownPersons}
        channels={channels} onChannels={registerChannels} onKnownRecords={registerKnownRecords}
        updates={updates} erasedIds={erasedIds} refreshVersion={strataRefreshVersion}
        forgetPreview={forgetPreview} forgetDissolve={forgetDissolve}
        onRecord={onRecord} onForgetRecord={openForgetRecord}
        onForgetChannel={openForgetChannel} onForgetTime={openForgetTime}
        onHeart={onHeart} l3Version={current}
        opened={opened} onExpand={(layer) => setOpened((value) => {
          rememberedLayers = { ...value, [layer]: !value[layer] }
          return rememberedLayers
        })} /> :
        tab === 'persons' ? <MemoryPersons persons={knownPersons} loading={persons.loading}
          error={persons.error} forgottenPersonEvent={forgottenPersonEvent}
          onRefresh={persons.reload} onRecord={onRecord} onForgetPerson={openForgetPerson} /> :
          tab === 'audit' ? <MemoryAudit onRecord={onRecord} /> :
            graphState.error !== undefined ? <RequestError error={graphState.error} retry={reloadGraph} /> :
              graphState.loading && !graphState.data ? <Plate className="memory-inset"><InkSkeleton ariaLabel="读取图谱数据" rows={5} /></Plate> :
                <Suspense fallback={<Plate className="memory-inset"><InkSkeleton rows={5} /></Plate>}>
                  <GraphView records={graphSlice.records} truncated={graphSlice.truncated}
                    persons={knownPersons} personId={filters.personId} onPerson={(personId) => changeFilters({ personId })}
                    selected={trail.at(-1)} forgetPreview={forgetPreview} forgetDissolve={forgetDissolve}
                    onRecord={onRecord} onList={() => selectTab('strata')} />
                </Suspense>}
    <MemoryDetails trail={trail} covenantOpen={forgetTarget !== null} onClose={onClose} onFollow={(record) => setTrail((previous) => {
      const index = previous.indexOf(record.id)
      return index >= 0 ? previous.slice(0, index + 1) : [...previous, record.id]
    })} onBack={(index) => setTrail((previous) => previous.slice(0, index + 1))}
    onChange={(record) => {
      knownRecordsRef.current.set(record.id, record)
      setUpdates((previous) => new Map(previous).set(record.id, record))
    }}
    onForget={openForgetRecord}
    onHeart={onHeart} />
    <ForgetCovenant
      target={forgetTarget}
      knownRecords={knownRecordsRef.current}
      onPreviewChange={setForgetPreview}
      onClose={closeForget}
      onCompleted={handleForgetCompleted}
    />
    <Covenant open={confirmEnabled} title="准许" onClose={closeConfirm} footer={<>
      <HoldToStamp label="准许" ariaLabel="按住 0.9 秒以准许跨通道" ariaDescribedBy="memory-cross-channel-consequence"
        onConfirm={() => writeMode('on')} onComplete={closeConfirm} />
      <BrushButton variant="ghost" onClick={closeConfirm}>算了</BrushButton>
    </>}>
      <p id="memory-cross-channel-consequence">启用后，符合可见性与披露约束的记忆可以跨通道使用。跨通道使用仍会写入审计记录。</p>
    </Covenant>
  </div>
}
