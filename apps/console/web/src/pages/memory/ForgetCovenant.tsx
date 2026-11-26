import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { memoryApi } from '../../api/client.ts'
import type { ForgetReport, Layer, MemoryRecord, PersonSummary } from '../../api/types.ts'
import { COVENANT_LOCK_MS } from '../../motion/tokens.ts'
import { playForget } from '../../sound/synth.ts'
import {
  BrushButton,
  Covenant,
  HoldToStamp,
  InkInput,
  InkNumber,
  InkSelect,
  InkSkeleton,
  LayerTag,
  Plate,
  toast,
} from '../../ui/index.ts'
import { recordSummary, RequestError } from './common.tsx'
import {
  BROWSE_BATCH_LIMIT,
  computeRecordForgetCascade,
  fetchAllBrowsePages,
  type ForgetPreviewState,
  type RecordForgetCascadeResult,
} from './forgetPreview.ts'

export type ForgetTarget =
  | { readonly kind: 'record'; readonly record: MemoryRecord }
  | { readonly kind: 'person'; readonly person: PersonSummary }
  | { readonly kind: 'channel'; readonly channel: string }
  | { readonly kind: 'time'; readonly defaultChannel?: string; readonly channels: readonly string[] }

export interface ForgetCompletedPayload {
  readonly target: ForgetTarget
  readonly report: ForgetReport
  readonly erasedDepthById: ReadonlyMap<string, number>
  readonly outdatedIds: ReadonlySet<string>
}

export interface ForgetCovenantProps {
  readonly target: ForgetTarget | null
  readonly knownRecords?: ReadonlyMap<string, MemoryRecord>
  readonly onPreviewChange: (preview: ForgetPreviewState | null) => void
  readonly onClose: () => void
  readonly onCompleted: (payload: ForgetCompletedPayload) => void
}

const FORGET_LAYERS: readonly ('L0' | 'L1' | 'L2')[] = ['L0', 'L1', 'L2']
const DISPLAY_LAYERS: readonly Layer[] = ['L0', 'L1', 'L2', 'L3']
const PREVIEW_SUMMARY_LIMIT = 5

function formatForgetToast(report: ForgetReport): string {
  const l3Part = report.l3Flagged > 0 ? ` · 标记 L3 ${report.l3Flagged} 版` : ''
  return `已遗忘 · 擦除 ${report.tombstoned} 条 · 失效 ${report.invalidated} 条${l3Part}`
}

function toDatetimeLocalValue(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function parseDatetimeLocal(value: string): number | null {
  if (!value.trim()) return null
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}

async function scanBatchRecords(
  filter: { readonly personId?: string; readonly channel?: string },
  isCancelled: () => boolean,
): Promise<{ readonly records: readonly MemoryRecord[]; readonly reachedCap: boolean }> {
  const results = await Promise.all(
    FORGET_LAYERS.map((layer) =>
      fetchAllBrowsePages(
        (cursor) =>
          memoryApi.browse({
            layer,
            personId: filter.personId,
            channel: filter.channel,
            cursor,
            limit: BROWSE_BATCH_LIMIT,
          }),
        { isCancelled },
      ),
    ),
  )
  const byId = new Map<string, MemoryRecord>()
  let reachedCap = false
  for (const res of results) {
    if (res.reachedPageCap) reachedCap = true
    for (const record of res.items) {
      if (record.status !== 'tombstoned') byId.set(record.id, record)
    }
  }
  return { records: [...byId.values()], reachedCap }
}

function targetKeyOf(target: ForgetTarget | null): string {
  if (!target) return 'none'
  if (target.kind === 'record') return `record:${target.record.id}`
  if (target.kind === 'person') return `person:${target.person.personId}`
  if (target.kind === 'channel') return `channel:${target.channel}`
  return `time:${target.defaultChannel ?? ''}`
}

export function ForgetCovenant({
  target,
  knownRecords,
  onPreviewChange,
  onClose,
  onCompleted,
}: ForgetCovenantProps) {
  const open = target !== null
  const [lastTarget, setLastTarget] = useState<ForgetTarget | null>(target)
  const displayTarget = target ?? lastTarget

  useEffect(() => {
    if (target !== null) {
      setLastTarget(target)
    }
  }, [target])

  const [ready, setReady] = useState(false)
  const [reloadSeq, setReloadSeq] = useState(0)

  // Single-record cascade preview state
  const [cascade, setCascade] = useState<RecordForgetCascadeResult>()
  const [loading, setLoading] = useState(true)
  const [previewError, setPreviewError] = useState<unknown>()

  // Batch preview state (person / channel / time)
  const [batchScan, setBatchScan] = useState<{
    readonly records: readonly MemoryRecord[]
    readonly reachedCap: boolean
  }>()

  // Time range selector inputs (used when target.kind === 'time')
  const [timeFrom, setTimeFrom] = useState(() => toDatetimeLocalValue(Date.now() - 24 * 60 * 60 * 1000))
  const [timeTo, setTimeTo] = useState(() => toDatetimeLocalValue(Date.now()))
  const [timeChannel, setTimeChannel] = useState(() =>
    target?.kind === 'time' ? (target.defaultChannel ?? '') : '',
  )

  const pendingPayloadRef = useRef<ForgetCompletedPayload | null>(null)

  // Reset time-range inputs whenever a new time-forget covenant opens
  useEffect(() => {
    if (!target || target.kind !== 'time') return
    const now = Date.now()
    setTimeFrom(toDatetimeLocalValue(now - 24 * 60 * 60 * 1000))
    setTimeTo(toDatetimeLocalValue(now))
    setTimeChannel(target.defaultChannel ?? '')
  }, [target])

  // Enforce COVENANT_LOCK_MS before HoldToStamp can be pressed
  useEffect(() => {
    if (!open || !target) return
    setReady(false)
    const timer = window.setTimeout(() => setReady(true), COVENANT_LOCK_MS)
    return () => window.clearTimeout(timer)
  }, [open, target])

  // Clear preview on unmount
  useEffect(() => () => onPreviewChange(null), [onPreviewChange])

  // Load preview data based on target kind
  useEffect(() => {
    if (!open || !target) {
      onPreviewChange(null)
      return
    }
    let cancelled = false
    const isCancelled = () => cancelled
    setLoading(true)
    setPreviewError(undefined)

    if (target.kind === 'record') {
      setCascade(undefined)
      void computeRecordForgetCascade(target.record, {
        getDependents: (id) => memoryApi.getDependents(id),
        getRecord: (id) => memoryApi.getRecord(id),
        knownRecords,
        isCancelled,
      }).then(
        (result) => {
          if (cancelled) return
          setCascade(result)
          setLoading(false)
          onPreviewChange({
            rootIds: new Set([target.record.id]),
            depthById: result.depthById,
            edgeDepthByKey: result.edgeDepthByKey,
            startedAtMs: performance.now(),
          })
        },
        (error: unknown) => {
          if (cancelled) return
          setPreviewError(error)
          setLoading(false)
        },
      )
    } else if (target.kind === 'person') {
      setBatchScan(undefined)
      onPreviewChange(null)
      void scanBatchRecords({ personId: target.person.personId }, isCancelled).then(
        (result) => {
          if (cancelled) return
          setBatchScan(result)
          setLoading(false)
        },
        (error: unknown) => {
          if (cancelled) return
          setPreviewError(error)
          setLoading(false)
        },
      )
    } else if (target.kind === 'channel') {
      setBatchScan(undefined)
      onPreviewChange(null)
      void scanBatchRecords({ channel: target.channel }, isCancelled).then(
        (result) => {
          if (cancelled) return
          setBatchScan(result)
          setLoading(false)
        },
        (error: unknown) => {
          if (cancelled) return
          setPreviewError(error)
          setLoading(false)
        },
      )
    } else {
      // time mode: scan records for selected channel (or all channels), then filter locally by time window
      setBatchScan(undefined)
      onPreviewChange(null)
      void scanBatchRecords({ channel: timeChannel || undefined }, isCancelled).then(
        (result) => {
          if (cancelled) return
          setBatchScan(result)
          setLoading(false)
        },
        (error: unknown) => {
          if (cancelled) return
          setPreviewError(error)
          setLoading(false)
        },
      )
    }

    return () => {
      cancelled = true
    }
  }, [knownRecords, onPreviewChange, open, reloadSeq, target, timeChannel])

  const parsedFrom = displayTarget?.kind === 'time' ? parseDatetimeLocal(timeFrom) : null
  const parsedTo = displayTarget?.kind === 'time' ? parseDatetimeLocal(timeTo) : null
  const timeRangeValid =
    displayTarget?.kind !== 'time' ||
    (parsedFrom !== null && parsedTo !== null && parsedFrom < parsedTo)

  const matchedBatchRecords = useMemo(() => {
    if (!batchScan || !displayTarget) return []
    if (displayTarget.kind !== 'time') return batchScan.records
    if (parsedFrom === null || parsedTo === null || parsedFrom >= parsedTo) return []
    return batchScan.records.filter(
      (record) => record.tEvent >= parsedFrom && record.tEvent <= parsedTo,
    )
  }, [batchScan, displayTarget, parsedFrom, parsedTo])

  const batchCountByLayer = useMemo(() => {
    const counts: Record<'L0' | 'L1' | 'L2', number> = { L0: 0, L1: 0, L2: 0 }
    for (const record of matchedBatchRecords) {
      if (record.layer === 'L0' || record.layer === 'L1' || record.layer === 'L2') {
        counts[record.layer] += 1
      }
    }
    return counts
  }, [matchedBatchRecords])

  const handleConfirm = useCallback(async () => {
    pendingPayloadRef.current = null
    if (!displayTarget) return
    if (displayTarget.kind === 'record') {
      const report = await memoryApi.forget({ by: 'record', id: displayTarget.record.id })
      const erasedDepthById = cascade
        ? cascade.erasedDepthById
        : new Map<string, number>([[displayTarget.record.id, 0]])
      const outdatedIds = cascade ? cascade.outdatedIds : new Set<string>()
      pendingPayloadRef.current = { target: displayTarget, report, erasedDepthById, outdatedIds }
      return
    }

    if (displayTarget.kind === 'person') {
      const report = await memoryApi.forget({ by: 'person', personId: displayTarget.person.personId })
      const erasedDepthById = new Map<string, number>(
        matchedBatchRecords.map((record) => [record.id, 0]),
      )
      pendingPayloadRef.current = { target: displayTarget, report, erasedDepthById, outdatedIds: new Set() }
      return
    }

    if (displayTarget.kind === 'channel') {
      const report = await memoryApi.forget({ by: 'channel', channel: displayTarget.channel })
      const erasedDepthById = new Map<string, number>(
        matchedBatchRecords.map((record) => [record.id, 0]),
      )
      pendingPayloadRef.current = { target: displayTarget, report, erasedDepthById, outdatedIds: new Set() }
      return
    }

    if (parsedFrom === null || parsedTo === null || parsedFrom >= parsedTo) {
      throw new Error('请选择有效的起止时间段')
    }
    const report = await memoryApi.forget({
      by: 'time',
      from: parsedFrom,
      to: parsedTo,
      ...(timeChannel ? { channel: timeChannel } : {}),
    })
    const erasedDepthById = new Map<string, number>(
      matchedBatchRecords.map((record) => [record.id, 0]),
    )
    pendingPayloadRef.current = { target: displayTarget, report, erasedDepthById, outdatedIds: new Set() }
  }, [cascade, displayTarget, matchedBatchRecords, parsedFrom, parsedTo, timeChannel])

  const handleComplete = useCallback(() => {
    const payload = pendingPayloadRef.current
    pendingPayloadRef.current = null
    onPreviewChange(null)
    if (!payload) {
      onClose()
      return
    }
    playForget()
    toast.success(formatForgetToast(payload.report))
    onCompleted(payload)
  }, [onClose, onCompleted, onPreviewChange])

  const consequenceRendered =
    displayTarget !== null &&
    previewError === undefined &&
    !loading &&
    (displayTarget.kind !== 'record' || cascade !== undefined)

  const stampDisabled =
    !ready ||
    loading ||
    previewError !== undefined ||
    !timeRangeValid ||
    displayTarget === null

  const ariaLabel = !displayTarget
    ? '按住 0.9 秒以确认：遗忘记忆'
    : displayTarget.kind === 'record'
      ? '按住 0.9 秒以确认：遗忘这条记忆'
      : displayTarget.kind === 'person'
        ? `按住 0.9 秒以确认：遗忘 ${displayTarget.person.aliases.find(Boolean) ?? displayTarget.person.personId} 的记忆`
        : displayTarget.kind === 'channel'
          ? `按住 0.9 秒以确认：遗忘通道 ${displayTarget.channel} 的记忆`
          : '按住 0.9 秒以确认：按时间段遗忘记忆'

  const subtitle = !displayTarget
    ? ''
    : displayTarget.kind === 'record'
      ? `单条记录 · ${displayTarget.record.id}`
      : displayTarget.kind === 'person'
        ? `按人物批量遗忘 · ${displayTarget.person.aliases.find(Boolean) ?? displayTarget.person.personId}`
        : displayTarget.kind === 'channel'
          ? `按通道批量遗忘 · ${displayTarget.channel}`
          : '按时间段批量遗忘'

  return (
    <Covenant
      open={open && displayTarget !== null}
      onClose={onClose}
      title="遗忘"
      subtitle={displayTarget ? <span className="num">{subtitle}</span> : undefined}
      footer={
        <>
          {open && !ready && (
            <p className="memory-forget-lock-hint" role="status" aria-live="polite">
              请确认以上影响范围后长按落印
            </p>
          )}
          <HoldToStamp
            key={targetKeyOf(displayTarget)}
            label="遗忘"
            disabled={stampDisabled}
            ariaLabel={ariaLabel}
            ariaDescribedBy={consequenceRendered ? 'memory-forget-consequence' : undefined}
            onConfirm={handleConfirm}
            onComplete={handleComplete}
          />
          <BrushButton variant="ghost" onClick={onClose}>
            算了
          </BrushButton>
        </>
      }
    >
      {displayTarget && (
        <div className="memory-stack">
          {displayTarget.kind === 'time' && (
            <Plate level="sunken" className="memory-inset memory-stack">
              <div className="memory-pair">
                <InkInput
                  type="datetime-local"
                  label="开始时间"
                  value={timeFrom}
                  onChange={(event) => setTimeFrom(event.target.value)}
                />
                <InkInput
                  type="datetime-local"
                  label="结束时间"
                  value={timeTo}
                  onChange={(event) => setTimeTo(event.target.value)}
                />
              </div>
              <InkSelect
                label="限定通道（可选）"
                value={timeChannel}
                options={[
                  { value: '', label: '全部通道' },
                  ...[...new Set([...displayTarget.channels, timeChannel].filter(Boolean))].map(
                    (channel) => ({ value: channel, label: channel }),
                  ),
                ]}
                onChange={setTimeChannel}
              />
              {!timeRangeValid && (
                <p className="memory-forget-hint" role="alert">
                  开始时间必须早于结束时间。
                </p>
              )}
            </Plate>
          )}

          {previewError !== undefined ? (
            <RequestError error={previewError} retry={() => setReloadSeq((n) => n + 1)} />
          ) : loading || (displayTarget.kind === 'record' && !cascade) ? (
            <Plate level="sunken" className="memory-inset">
              <InkSkeleton ariaLabel="计算遗忘影响范围" rows={4} />
            </Plate>
          ) : displayTarget.kind === 'record' && cascade ? (
            <>
              <Plate level="sunken" tone="warn" className="memory-inset memory-stack">
                <p id="memory-forget-consequence" className="memory-forget-consequence">
                  遗忘后原文会被擦除，依据它的 <InkNumber value={cascade.invalidatedRecords.length} />{' '}
                  条记忆会失效，无法恢复。
                  {cascade.l3FlaggedRecords.length > 0 && (
                    <>
                      {' '}
                      同时有 <InkNumber value={cascade.l3FlaggedRecords.length} /> 版 L3
                      身份记录将被标记为过时。
                    </>
                  )}
                </p>
                <div className="memory-forget-stats num">
                  <span>
                    直接擦除 <InkNumber value={cascade.tombstonedRecords.length} /> 条
                  </span>
                  <span>
                    级联失效 <InkNumber value={cascade.invalidatedRecords.length} /> 条
                  </span>
                  {cascade.l3FlaggedRecords.length > 0 && (
                    <span>
                      标记 L3 <InkNumber value={cascade.l3FlaggedRecords.length} /> 版
                    </span>
                  )}
                </div>
              </Plate>

              <div className="memory-forget-layers">
                {DISPLAY_LAYERS.map((layer) => {
                  const items = cascade.byLayer[layer]
                  if (items.length === 0) return null
                  const shown = items.slice(0, PREVIEW_SUMMARY_LIMIT)
                  const remaining = items.length - shown.length
                  return (
                    <section key={layer} className="memory-forget-layer-group">
                      <header className="memory-forget-layer-head">
                        <LayerTag layer={layer} />
                        <span className="num">
                          <InkNumber value={items.length} /> 条
                        </span>
                        <span className="memory-forget-layer-role">
                          {layer === 'L3' ? '将标记过时' : '将被擦除'}
                        </span>
                      </header>
                      <ul className="memory-forget-list">
                        {shown.map((rec) => (
                          <li key={rec.id}>{recordSummary(rec, 64)}</li>
                        ))}
                        {remaining > 0 && (
                          <li className="memory-forget-more num">… 另有 {remaining} 条</li>
                        )}
                      </ul>
                    </section>
                  )
                })}
              </div>
            </>
          ) : (
            <Plate level="sunken" tone="warn" className="memory-inset memory-stack">
              <p id="memory-forget-consequence" className="memory-forget-consequence">
                {displayTarget.kind === 'person' ? (
                  <>
                    当前可见关联记录 <InkNumber value={matchedBatchRecords.length} />
                    {batchScan?.reachedCap ? '+' : ''} 条。遗忘后原文会被擦除，后端也会一并覆盖此人的全部别名与发言记录，依据它们的上级记忆会级联失效，无法恢复。
                  </>
                ) : displayTarget.kind === 'channel' ? (
                  <>
                    通道 <span className="num">{displayTarget.channel}</span> 当前匹配{' '}
                    <InkNumber value={matchedBatchRecords.length} />
                    {batchScan?.reachedCap ? '+' : ''} 条记忆。遗忘后原文会被擦除，依据它们的上级记忆会级联失效，无法恢复。
                  </>
                ) : (
                  <>
                    该时间段内当前匹配 <InkNumber value={matchedBatchRecords.length} />
                    {batchScan?.reachedCap ? '+' : ''} 条记忆。遗忘后原文会被擦除，依据它们的上级记忆会级联失效，无法恢复。
                  </>
                )}
              </p>
              <div className="memory-forget-stats num">
                {FORGET_LAYERS.map((layer) => (
                  <span key={layer} className="memory-actions">
                    <LayerTag layer={layer} />
                    <InkNumber value={batchCountByLayer[layer]} /> 条
                  </span>
                ))}
              </div>
            </Plate>
          )}
        </div>
      )}
    </Covenant>
  )
}
