import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ChevronDown, Ellipsis } from 'lucide-react'
import { memoryApi } from '../../api/client.ts'
import type { MemoryRecord, PersonSummary, RecordStatus } from '../../api/types.ts'
import { POLL_INTERVALS, usePolling } from '../../data/polling.ts'
import { useInk } from '../../ink/InkProvider.tsx'
import { getPreset, REDUCED_FADE_DURATION } from '../../motion/presets.ts'
import { DUR, EASE, SPRING } from '../../motion/tokens.ts'
import { useMotionLevel } from '../../motion/useMotionLevel.ts'
import { useConsoleShellData } from '../../shell/ConsoleShell.tsx'
import { BrushButton, EmptyState, InkInput, InkNumber, InkSelect, InkSkeleton, LayerTag, Plate, toast } from '../../ui/index.ts'
import { InkMetric, notifyRequestError, OutdatedBrushStrike, recordSummary, RequestError, shortDate } from './common.tsx'
import {
  BROWSE_BATCH_LIMIT,
  fetchAllBrowsePages,
  sortNewestFirst,
  type ForgetDissolveState,
  type ForgetPreviewState,
} from './forgetPreview.ts'

export interface StrataFilters {
  readonly personId: string
  readonly channel: string
  readonly time: 'all' | '7' | '30' | '90'
  readonly status: 'all' | RecordStatus
}

export const INITIAL_FILTERS: StrataFilters = { personId: '', channel: '', time: '30', status: 'active' }
const LAYER_NAMES = { L2: '浓墨 · 场景与反思', L1: '中墨 · 事实、事件、承诺', L0: '淡墨 · 原始事件' } as const
const TIME_OPTIONS = [
  { value: 'all', label: '全部时间' }, { value: '7', label: '近 7 天' },
  { value: '30', label: '近 30 天' }, { value: '90', label: '近 90 天' },
] as const
const STATUS_OPTIONS = [
  { value: 'all', label: '全部状态' }, { value: 'active', label: '有效' },
  { value: 'outdated', label: '已过时' }, { value: 'archived', label: '已归档' },
] as const

const DISPLAY_PAGE_SIZE = 50
const PREVIEW_DEPTH_STAGGER_SEC = 0.12
const DISSOLVE_DEPTH_STAGGER_SEC = 0.14
const DISSOLVE_DEPTH_STAGGER_MS = 140
const FRESH_HIGHLIGHT_SEC = DUR.dissolve + DUR.brush
const DISSOLVE_SPLAT_COUNT = 8
const DISSOLVE_SPLAT_DX_RANGE = 60

type BrowseLayer = keyof typeof LAYER_NAMES

type BrowseProps = {
  readonly filters: StrataFilters
  readonly onRecord: (id: string) => void
  readonly updates: ReadonlyMap<string, MemoryRecord>
  readonly erasedIds: ReadonlySet<string>
  readonly refreshVersion: number
  readonly forgetPreview: ForgetPreviewState | null
  readonly forgetDissolve: ForgetDissolveState | null
  readonly onChannels: (records: readonly MemoryRecord[]) => void
  readonly onKnownRecords: (records: readonly MemoryRecord[]) => void
  readonly onForgetRecord: (record: MemoryRecord) => void
}

function withinTime(record: MemoryRecord, time: StrataFilters['time']): boolean {
  if (time === 'all') return true
  return record.tEvent >= Date.now() - Number(time) * 86_400_000
}

function RecordRow({
  record,
  fresh,
  previewDepth,
  dissolveDepth,
  dissolveId,
  onRecord,
  onForgetRecord,
}: {
  record: MemoryRecord
  fresh: boolean
  previewDepth?: number
  dissolveDepth?: number
  dissolveId?: number
  onRecord: (id: string) => void
  onForgetRecord: (record: MemoryRecord) => void
}) {
  const rowRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const motionLevel = useMotionLevel()
  const ink = useInk()
  const animate = motionLevel === 'full'

  useEffect(() => {
    if (!fresh || !animate || !rowRef.current) return
    const { left, right, top, bottom } = rowRef.current.getBoundingClientRect()
    if (bottom > 0 && top < window.innerHeight) {
      ink.splat({
        x: left + Math.min(150, (right - left) * 0.25),
        y: (top + bottom) / 2,
        radius: 40,
        amount: 0.2,
        color: 'zhusha',
      })
    }
  }, [animate, fresh, ink])

  // §8.4.6 墨散: dilute row screen rect + 8 horizontal smoke splats staggered 140ms per depth
  useEffect(() => {
    if (dissolveDepth === undefined || dissolveId === undefined || !animate) return
    const timer = window.setTimeout(() => {
      const el = rowRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.top >= window.innerHeight) return
      ink.dilute(
        { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
        Math.round(DUR.dissolve * 1000),
      )
      const midY = rect.top + rect.height * 0.5
      for (let i = 0; i < DISSOLVE_SPLAT_COUNT; i += 1) {
        const ratio = (i + 0.5) / DISSOLVE_SPLAT_COUNT
        const dx = (Math.random() * 2 - 1) * DISSOLVE_SPLAT_DX_RANGE
        ink.splat({
          x: rect.left + rect.width * ratio,
          y: midY,
          dx,
          dy: -24,
          color: 'smoke',
          amount: 0.25,
          radius: 28,
        })
      }
    }, dissolveDepth * DISSOLVE_DEPTH_STAGGER_MS)
    return () => window.clearTimeout(timer)
  }, [animate, dissolveDepth, dissolveId, ink])

  const dissolving = dissolveDepth !== undefined
  const rowAnimate = dissolving
    ? animate
      ? { opacity: 0, y: -8, filter: 'blur(14px)' }
      : { opacity: 0 }
    : { opacity: 1, y: 0, filter: 'none' }

  const rowTransition = dissolving
    ? animate
      ? { duration: DUR.dissolve, delay: dissolveDepth * DISSOLVE_DEPTH_STAGGER_SEC, ease: EASE.inkIn }
      : { duration: REDUCED_FADE_DURATION, ease: EASE.settle }
    : SPRING.float

  return <motion.div ref={rowRef} layout={animate && !dissolving} animate={rowAnimate} transition={rowTransition}
    className={`memory-record-row${record.status === 'outdated' ? ' memory-outdated' : ''}`}
    data-layer={record.layer}
    data-menu-open={menuOpen || undefined}
    data-forget-preview={previewDepth !== undefined && !dissolving ? 'true' : undefined}
    onKeyDown={(event) => { if (event.key === 'Escape') setMenuOpen(false) }}
    onMouseEnter={() => { if (!dissolving) setExpanded(true) }}
    onMouseLeave={() => setExpanded(false)}
    onFocus={() => { if (!dissolving) setExpanded(true) }}
    onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) {
        setExpanded(false)
        setMenuOpen(false)
      }
    }}>
    {fresh && animate && (
      <motion.span
        aria-hidden="true"
        className="memory-record-fresh-glow"
        initial={{ opacity: 1 }}
        animate={{ opacity: 0 }}
        transition={{ duration: FRESH_HIGHLIGHT_SEC, ease: EASE.inkOut }}
      />
    )}
    {previewDepth !== undefined && !dissolving && (
      <motion.span
        aria-hidden="true"
        className="memory-record-preview-bar"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{
          duration: animate ? DUR.base : REDUCED_FADE_DURATION,
          delay: animate ? previewDepth * PREVIEW_DEPTH_STAGGER_SEC : 0,
          ease: EASE.inkOut,
        }}
      />
    )}
    <button type="button" className="memory-record-main" disabled={dissolving} onClick={() => onRecord(record.id)}>
      <span className="memory-record-summary">
        <OutdatedBrushStrike active={record.status === 'outdated'}>
          {record.layer === 'L0' && <span className="num memory-record-channel">{record.channel} · </span>}
          {recordSummary(record)}
        </OutdatedBrushStrike>
      </span>
      <span className="num memory-record-aside">{record.kind} · {shortDate(record.tEvent)} · 证据 {record.evidence.length}</span>
    </button>
    <BrushButton variant="ghost" size="sm" disabled={dissolving} aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)} aria-label="打开记录操作">
      <Ellipsis size={17} aria-hidden="true" />
    </BrushButton>
    {menuOpen && <Plate level="raised" className="memory-person-menu-popover">
      <BrushButton variant="ghost" size="sm" onClick={() => { setMenuOpen(false); onRecord(record.id) }}>查看详情</BrushButton>
      <BrushButton variant="ghost" size="sm" onClick={() => {
        setMenuOpen(false)
        void navigator.clipboard?.writeText(record.id).then(() => toast.success('已复制记录 ID'), notifyRequestError)
      }}>复制 ID</BrushButton>
      <BrushButton variant="danger" size="sm" onClick={() => { setMenuOpen(false); onForgetRecord(record) }}>遗忘…</BrushButton>
    </Plate>}
    {expanded && !dissolving && <div className="memory-record-extra">
      <span>主体 {record.subjects.join('、') || '—'}</span><span>来源 {record.channel}</span>
      <span>可见 {record.visibility}</span><span>可信 {record.trust}</span>
      <InkMetric label="置信" value={record.confidence} /><InkMetric label="重要" value={record.importance} />
    </div>}
  </motion.div>
}

function LayerBand({
  layer,
  filters,
  updates,
  erasedIds,
  refreshVersion,
  forgetPreview,
  forgetDissolve,
  onRecord,
  onChannels,
  onKnownRecords,
  onForgetRecord,
  expanded,
  onExpand,
}: BrowseProps & {
  layer: BrowseLayer
  expanded: boolean
  onExpand: () => void
}) {
  const [cachedRecords, setCachedRecords] = useState<ReadonlyMap<string, MemoryRecord>>(new Map())
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<unknown>()
  const [reachedCap, setReachedCap] = useState(false)
  const [visibleCount, setVisibleCount] = useState(DISPLAY_PAGE_SIZE)
  const [freshIds, setFreshIds] = useState<ReadonlySet<string>>(new Set())
  const [reloadTick, setReloadTick] = useState(0)

  const recordsMapRef = useRef<Map<string, MemoryRecord>>(new Map())
  const tailCursorRef = useRef<string | undefined>(undefined)
  const sentinelRef = useRef<HTMLButtonElement>(null)
  const motionLevel = useMotionLevel()
  const { observeMemoryRecords } = useConsoleShellData()

  // Clear fresh highlight IDs once the 1.6s glow fade finishes or the band collapses,
  // so collapsing and re-expanding never replays glow or ink.splat.
  useEffect(() => {
    if (!expanded) {
      setFreshIds((prev) => (prev.size > 0 ? new Set() : prev))
      return
    }
    if (freshIds.size === 0) return
    const timer = window.setTimeout(
      () => setFreshIds(new Set()),
      Math.round(FRESH_HIGHLIGHT_SEC * 1000),
    )
    return () => window.clearTimeout(timer)
  }, [expanded, freshIds])

  const readPage = useCallback(
    (cursor?: string) =>
      memoryApi.browse({
        layer,
        personId: filters.personId,
        channel: filters.channel,
        cursor,
        limit: BROWSE_BATCH_LIMIT,
      }),
    [layer, filters.personId, filters.channel],
  )

  // Initial full cursor scan for accurate total count & newest-first local ordering
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(undefined)
    setVisibleCount(DISPLAY_PAGE_SIZE)

    void fetchAllBrowsePages(readPage, { isCancelled: () => cancelled }).then(
      (result) => {
        if (cancelled) return
        const nextMap = new Map<string, MemoryRecord>()
        for (const item of result.items) {
          nextMap.set(item.id, item)
        }
        recordsMapRef.current = nextMap
        tailCursorRef.current = result.tailCursor
        setCachedRecords(new Map(nextMap))
        setReachedCap(result.reachedPageCap)
        setLoaded(true)
        setLoading(false)
        setFreshIds(new Set())
        onChannels(result.items)
        onKnownRecords(result.items)
        observeMemoryRecords(result.items, { splat: false })
      },
      (error: unknown) => {
        if (cancelled) return
        setLoadError(error)
        setLoading(false)
      },
    )

    return () => {
      cancelled = true
    }
  }, [observeMemoryRecords, onChannels, onKnownRecords, readPage, refreshVersion, reloadTick])

  // Tail-only polling every 10s: starts from `tailCursorRef` and only pulls newly appended pages
  const pollTail = useCallback(async () => {
    let cursor = tailCursorRef.current
    const appended: MemoryRecord[] = []
    let nextTailCursor = cursor
    let pages = 0

    for (; pages < 10; pages += 1) {
      nextTailCursor = cursor
      const page = await readPage(cursor)
      appended.push(...page.items)
      if (page.nextCursor === undefined || page.nextCursor === cursor) {
        break
      }
      cursor = page.nextCursor
    }

    tailCursorRef.current = nextTailCursor
    if (appended.length === 0) {
      setFreshIds((prev) => (prev.size > 0 ? new Set() : prev))
      return appended
    }

    const newlyArrived: string[] = []
    let changed = false
    const map = recordsMapRef.current
    for (const item of appended) {
      const prev = map.get(item.id)
      if (!prev) {
        map.set(item.id, item)
        changed = true
        if (item.status !== 'tombstoned') newlyArrived.push(item.id)
      } else if (prev.version !== item.version || prev.status !== item.status) {
        map.set(item.id, item)
        changed = true
      }
    }

    if (changed) {
      setCachedRecords(new Map(map))
      onChannels(appended)
      onKnownRecords(appended)
      observeMemoryRecords(appended, { splat: false })
    }
    if (newlyArrived.length > 0) {
      setFreshIds(new Set(newlyArrived))
    } else {
      setFreshIds((prev) => (prev.size > 0 ? new Set() : prev))
    }
    return appended
  }, [observeMemoryRecords, onChannels, onKnownRecords, readPage])

  usePolling(pollTail, POLL_INTERVALS.memoryActiveMs, {
    enabled: expanded && loaded && loadError === undefined,
    immediate: false,
  })

  const records = useMemo(() => {
    const merged: MemoryRecord[] = []
    for (const record of cachedRecords.values()) {
      if (erasedIds.has(record.id)) continue
      const effective = updates.get(record.id) ?? record
      if (effective.status === 'tombstoned') continue
      if (filters.status !== 'all' && effective.status !== filters.status) continue
      if (!withinTime(effective, filters.time)) continue
      merged.push(effective)
    }
    return sortNewestFirst(merged)
  }, [cachedRecords, erasedIds, filters.status, filters.time, updates])

  const shownRecords = useMemo(() => records.slice(0, visibleCount), [records, visibleCount])
  const hasMoreLocal = shownRecords.length < records.length

  // Progressive local expansion (50 items per step) when scrolling to bottom of band
  useEffect(() => {
    const button = sentinelRef.current
    if (!button || !hasMoreLocal || !expanded || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisibleCount((count) => Math.min(records.length, count + DISPLAY_PAGE_SIZE))
        }
      },
      { rootMargin: '0px 0px 80px 0px' },
    )
    observer.observe(button)
    return () => observer.disconnect()
  }, [expanded, hasMoreLocal, records.length])

  const variants = { ...getPreset('bloom', motionLevel), exit: getPreset('dissolve', motionLevel).exit! }
  return <Plate level="base" className="memory-layer" data-layer={layer}>
    <button type="button" className="memory-layer-header" aria-expanded={expanded} onClick={onExpand}>
      <LayerTag layer={layer} /><span>{LAYER_NAMES[layer]}</span>
      <span className="num">
        {loaded && <><InkNumber value={records.length} /> 条{reachedCap ? '+' : ''}</>}
      </span>
      <ChevronDown size={16} className={expanded ? 'memory-chevron-expanded' : ''} aria-hidden="true" />
    </button>
    <AnimatePresence initial={false}>
      {expanded && <motion.div variants={variants} initial="initial" animate="animate" exit="exit">
        {loadError !== undefined && <RequestError error={loadError} retry={() => setReloadTick((n) => n + 1)} />}
        {loading && !loaded && <div className="memory-inset"><InkSkeleton rows={3} /></div>}
        {loaded && records.length === 0 && <EmptyState glyph="无痕" description="这一层没有符合筛选的记忆。" />}
        {shownRecords.map((record) => (
          <RecordRow
            key={record.id}
            record={record}
            fresh={freshIds.has(record.id)}
            previewDepth={forgetPreview?.depthById.get(record.id)}
            dissolveDepth={forgetDissolve?.erasedDepthById.get(record.id)}
            dissolveId={forgetDissolve?.id}
            onRecord={onRecord}
            onForgetRecord={onForgetRecord}
          />
        ))}
        {hasMoreLocal && (
          <BrushButton
            ref={sentinelRef}
            className="memory-more"
            variant="secondary"
            size="sm"
            onClick={() => setVisibleCount((count) => Math.min(records.length, count + DISPLAY_PAGE_SIZE))}
          >
            继续显示（剩余 {records.length - shownRecords.length} 条）
          </BrushButton>
        )}
      </motion.div>}
    </AnimatePresence>
  </Plate>
}

export function MemoryStrata({
  filters,
  onFilters,
  persons,
  channels,
  onHeart,
  l3Version,
  opened,
  onExpand,
  onForgetChannel,
  onForgetTime,
  ...browse
}: BrowseProps & {
  readonly onFilters: (patch: Partial<StrataFilters>) => void
  readonly persons: readonly PersonSummary[]
  readonly channels: readonly string[]
  readonly onHeart: () => void
  readonly l3Version?: { readonly version: number; readonly tAt: number; readonly data?: Readonly<Record<string, unknown>> }
  readonly opened: Readonly<Record<BrowseLayer, boolean>>
  readonly onExpand: (layer: BrowseLayer) => void
  readonly onForgetChannel: (channel: string) => void
  readonly onForgetTime: () => void
}) {
  const [channelInput, setChannelInput] = useState(filters.channel)
  const [channelMenuOpen, setChannelMenuOpen] = useState(false)
  const channelMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => { setChannelInput(filters.channel) }, [filters.channel])

  useEffect(() => {
    if (!channelMenuOpen) return
    const handlePointerDown = (event: PointerEvent) => {
      if (channelMenuRef.current && !channelMenuRef.current.contains(event.target as Node)) {
        setChannelMenuOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setChannelMenuOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [channelMenuOpen])

  const filterKey = JSON.stringify(filters)
  const motionLevel = useMotionLevel()
  const variants = { ...getPreset('bloom', motionLevel), exit: getPreset('dissolve', motionLevel).exit! }
  return <div className="memory-stack memory-strata">
    <Plate level="sunken" className="memory-filters memory-inset">
      <InkSelect label="人物" value={filters.personId}
        options={[{ value: '', label: '全部' }, ...persons.map((person) => ({ value: person.personId, label: person.aliases[0] ?? person.personId }))]}
        onChange={(personId) => onFilters({ personId })} />
      <div>
        <div className="memory-channel-filter-row" ref={channelMenuRef}>
          <InkSelect label="通道" value={filters.channel}
            options={[{ value: '', label: '全部' }, ...[...new Set([...channels, filters.channel].filter(Boolean))].map((channel) => ({ value: channel, label: channel }))]}
            onChange={(channel) => onFilters({ channel })} />
          <BrushButton
            variant="ghost"
            size="sm"
            className="memory-channel-menu-btn"
            aria-label="通道与时间遗忘操作"
            aria-expanded={channelMenuOpen}
            onClick={() => setChannelMenuOpen((open) => !open)}
          >
            <Ellipsis size={17} aria-hidden="true" />
          </BrushButton>
          {channelMenuOpen && (
            <Plate level="raised" className="memory-channel-menu-popover">
              <BrushButton
                variant="danger"
                size="sm"
                disabled={!filters.channel}
                onClick={() => {
                  setChannelMenuOpen(false)
                  if (filters.channel) onForgetChannel(filters.channel)
                }}
              >
                遗忘当前通道…
              </BrushButton>
              <BrushButton
                variant="danger"
                size="sm"
                onClick={() => {
                  setChannelMenuOpen(false)
                  onForgetTime()
                }}
              >
                按时间段遗忘…
              </BrushButton>
            </Plate>
          )}
        </div>
        <form className="memory-channel-entry" onSubmit={(event) => { event.preventDefault(); onFilters({ channel: channelInput.trim() }) }}>
          <InkInput aria-label="输入通道 ID" placeholder="通道 ID" value={channelInput} onChange={(event) => setChannelInput(event.target.value)} />
          <BrushButton type="submit" size="sm" variant="secondary">应用</BrushButton>
        </form>
      </div>
      <InkSelect label="时间" value={filters.time} options={TIME_OPTIONS} onChange={(time) => onFilters({ time })} />
      <InkSelect label="状态" value={filters.status === 'tombstoned' ? 'all' : filters.status} options={STATUS_OPTIONS} onChange={(status) => onFilters({ status })} />
    </Plate>
    <Plate level="base" className="memory-layer">
      <button type="button" className="memory-layer-header" onClick={onHeart}>
        <LayerTag layer="L3" /><span>焦墨 · 身份</span>
        <span className="num">
          {l3Version ? `v${l3Version.version} · ${shortDate(l3Version.tAt)}` : '—'}
          {Array.isArray(l3Version?.data?.beliefs) && <> · <InkNumber value={l3Version.data.beliefs.length} /> 条信念</>}
        </span>
        <span>去「心」 →</span>
      </button>
    </Plate>
    <AnimatePresence mode="wait" initial={false}>
      <motion.div className="memory-layer-bands" key={filterKey} variants={variants} initial="initial" animate="animate" exit="exit">
        {(['L2', 'L1', 'L0'] as const).map((layer) => <LayerBand key={layer} {...browse}
          layer={layer} filters={filters} expanded={opened[layer]} onExpand={() => onExpand(layer)} />)}
      </motion.div>
    </AnimatePresence>
  </div>
}
