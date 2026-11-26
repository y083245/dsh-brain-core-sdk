import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { LayoutGroup, motion, useMotionValue, useTransform } from 'motion/react'
import { memoryApi } from '../../api/client.ts'
import { ApiError, type L3ProfileVersionSummary } from '../../api/types.ts'
import { usePolling } from '../../data/polling.ts'
import { useInk } from '../../ink/InkProvider.tsx'
import { getPreset } from '../../motion/presets.ts'
import { SPRING } from '../../motion/tokens.ts'
import { useMotionLevel } from '../../motion/useMotionLevel.ts'
import { useConsoleShellData } from '../../shell/ConsoleShell.tsx'
import { useShellNavigation } from '../../shell/PageTransition.tsx'
import { BrushButton } from '../../ui/BrushButton.tsx'
import { BrushTabs } from '../../ui/BrushTabs.tsx'
import { HoldToStamp } from '../../ui/HoldToStamp.tsx'
import { EmptyState, ErrorState, InkSkeleton } from '../../ui/InkStates.tsx'
import { PageHeader } from '../../ui/PageHeader.tsx'
import { Plate } from '../../ui/Plate.tsx'
import { ProfileDiff } from './ProfileDiff.tsx'
import { ProfileEditor } from './ProfileEditor.tsx'
import { TidePanel } from './TidePanel.tsx'
import './heart.css'

const FOLIO_WIDTH = 280
const DATE = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
const TABS = [{ id: 'scroll', label: '卷' }, { id: 'tide', label: '潮' }] as const

function VersionsDiff({ before, after }: { readonly before: L3ProfileVersionSummary; readonly after: L3ProfileVersionSummary }) {
  const request = usePolling(() => memoryApi.diffL3Versions(before.version, after.version), 0)
  const error = request.error instanceof ApiError ? request.error : undefined
  return (
    <Plate className="heart-panel">
      <h2>版本对比 <span className="num">v{before.version} → v{after.version}</span></h2>
      {request.error ? <ErrorState code={error?.code} message={error?.message} requestId={error?.requestId} onRetry={() => { void request.refresh() }} /> :
        request.data ? <ProfileDiff changes={request.data} before={before} after={after} /> : <InkSkeleton rows={3} />}
    </Plate>
  )
}

function VersionScroll({ versions, versionQuery, refresh }: {
  readonly versions: readonly L3ProfileVersionSummary[]
  readonly versionQuery: string | null
  readonly refresh: () => Promise<readonly L3ProfileVersionSummary[] | undefined>
}) {
  const level = useMotionLevel()
  const ink = useInk()
  const viewport = useRef<HTMLDivElement>(null)
  const currentSeal = useRef<HTMLSpanElement>(null)
  const landingVersion = useRef<number | null>(null)
  const position = useMotionValue(0)
  const startId = useId()
  const endId = useId()
  const [visibleWidth, setVisibleWidth] = useState(0)
  const [selection, setSelection] = useState<number | null>(null)
  const [editing, setEditing] = useState<L3ProfileVersionSummary | null>(null)
  const [rollbackVersion, setRollbackVersion] = useState<number | null>(null)
  const [manualRange, setManualRange] = useState<readonly [number, number] | null>(null)
  const [dragRange, setDragRange] = useState<readonly [number, number] | null>(null)
  const requestedVersion = versionQuery === null ? null : Number(versionQuery)
  const queryFound = versions.find((version) => version.version === requestedVersion)?.version
  const current = versions.find((version) => version.version === rollbackVersion)
    ?? versions.find((version) => version.current)
  const active = versions.find((version) => version.version === selection)
    ?? versions.find((version) => version.version === queryFound)
    ?? current
    ?? versions.at(-1)
  const overflow = Math.max(0, versions.length * FOLIO_WIDTH - visibleWidth)
  const leftShaft = useTransform(position, (value) => level === 'full' ? Math.max(0, value) * 0.12 : 0)
  const rightShaft = useTransform(position, (value) => level === 'full' ? Math.min(0, value + overflow) * 0.12 : 0)
  const currentIndex = Math.max(0, versions.findIndex((version) => version.version === current?.version))
  const activeIndex = versions.findIndex((version) => version.version === active?.version)
  const defaultRange = [Math.max(0, currentIndex - 1), currentIndex] as const
  const comparison = manualRange ?? defaultRange
  const preview = dragRange ?? comparison
  const startIndex = Math.min(versions.length - 1, preview[0])
  const endIndex = Math.min(versions.length - 1, preview[1])
  const before = versions[comparison[0]]
  const after = versions[comparison[1]]

  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const measure = (): void => setVisibleWidth(element.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (queryFound !== undefined) setSelection(queryFound)
  }, [queryFound])

  useEffect(() => {
    if (visibleWidth === 0 || activeIndex < 0) return
    position.stop()
    position.set(Math.min(0, Math.max(-overflow, visibleWidth / 2 - (activeIndex + 0.5) * FOLIO_WIDTH)))
  }, [activeIndex, overflow, position, visibleWidth])

  useEffect(() => {
    if (rollbackVersion !== null && versions.some((version) => version.current && version.version === rollbackVersion)) {
      setRollbackVersion(null)
    }
  }, [rollbackVersion, versions])

  useEffect(() => {
    const element = viewport.current
    if (!element || overflow === 0) return
    const wheel = (event: WheelEvent): void => {
      const amount = event.deltaX || event.deltaY
      const step = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? visibleWidth : 1
      const next = Math.min(0, Math.max(-overflow, position.get() - amount * step))
      if (event.ctrlKey || next === position.get()) return
      event.preventDefault()
      position.stop()
      position.set(next)
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [overflow, position, visibleWidth])

  async function rollback(version: number): Promise<void> {
    const result = await memoryApi.rollbackL3Version(version)
    landingVersion.current = result.version
    setRollbackVersion(result.version)
    setManualRange(null)
    await refresh()
  }

  function compare(index: number, value: number): void {
    const start = index === 0 ? Math.min(value, endIndex) : startIndex
    const end = index === 1 ? Math.max(value, startIndex) : endIndex
    setDragRange([start, end])
  }

  function commitRange(): void {
    if (dragRange) setManualRange(dragRange)
    setDragRange(null)
  }

  return (
    <>
      <Plate className="heart-roll">
        <div className="heart-roll-shaft" style={{ left: 0 }} aria-hidden="true"><motion.span style={{ rotate: leftShaft }} /></div>
        <div className="heart-roll-shaft" style={{ right: 0 }} aria-hidden="true"><motion.span style={{ rotate: rightShaft }} /></div>
        <div ref={viewport} className="heart-roll-viewport">
          <LayoutGroup id="heart-l3">
            <motion.div drag={overflow > 0 ? 'x' : false} dragConstraints={{ left: -overflow, right: 0 }} dragElastic={level === 'full' ? 0.14 : 0} dragMomentum={level === 'full'} style={{ x: position }} className="heart-roll-strip">
              {versions.map((version) => {
                const isCurrent = version.version === current?.version
                const archived = version.status === 'archived' || (rollbackVersion !== null && version.version > rollbackVersion)
                return (
                  <article key={version.version} className="heart-folio" aria-current={isCurrent ? 'true' : undefined} data-archived={archived || undefined}>
                    <div className="heart-folio-header">
                      <BrushButton variant="ghost" className="heart-folio-version" aria-pressed={active?.version === version.version} onClick={() => setSelection(version.version)} onFocus={() => {
                        const index = versions.indexOf(version)
                        const left = index * FOLIO_WIDTH + position.get()
                        if (left < 0 || left + FOLIO_WIDTH > visibleWidth) {
                          position.stop()
                          position.set(Math.min(0, Math.max(-overflow, visibleWidth / 2 - (index + 0.5) * FOLIO_WIDTH)))
                        }
                      }}>v{version.version}</BrushButton>
                      {isCurrent ? (
                        <motion.span ref={currentSeal} className="heart-current-seal" layoutId={level === 'full' ? 'l3-current' : undefined} transition={SPRING.heavy}
                          onLayoutAnimationComplete={() => {
                            const rect = currentSeal.current?.getBoundingClientRect()
                            if (level === 'full' && rect && landingVersion.current === version.version) {
                              landingVersion.current = null
                              const cx = rect.x + rect.width / 2
                              const cy = rect.y + rect.height / 2
                              ink.splat({ x: cx, y: cy, color: 'zhusha', radius: 90, amount: 0.8 })
                              for (let index = 0; index < 6; index += 1) {
                                const angle = (Math.PI * 2 * index) / 6
                                ink.splat({
                                  x: cx + Math.cos(angle) * 20,
                                  y: cy + Math.sin(angle) * 20,
                                  dx: Math.cos(angle) * 120,
                                  dy: Math.sin(angle) * 120,
                                  radius: 24,
                                  amount: 0.25,
                                  color: 'zhusha',
                                })
                              }
                            }
                          }}>
                          <motion.span variants={getPreset('stamp', level)} initial={rollbackVersion === version.version ? 'initial' : false} animate="animate">今</motion.span>
                        </motion.span>
                      ) : null}
                    </div>
                    <time className="num" dateTime={new Date(version.tAt).toISOString()}>{DATE.format(version.tAt)}</time>
                    <div>{version.author === 'owner' ? '主人' : version.author === 'settlement' ? '巩固' : '—'}{archived ? ' · 已归档' : ''}</div>
                    <div className="heart-muted">证据 {version.evidenceCount ?? 0} · 锁 {version.ownerLockedKeys?.length ?? 0} 项</div>
                    <blockquote>{version.stable ?? ''}</blockquote>
                    {isCurrent ? <BrushButton variant="secondary" size="sm" onClick={() => setEditing(version)}>改写</BrushButton> :
                      active?.version === version.version && version.status !== 'outdated'
                        ? <><span id={`rollback-${version.version}`} className="heart-muted">复位会归档更新的版本。</span><HoldToStamp label="复位" ariaLabel={`按住 0.9 秒以确认：复位到 v${version.version}`} ariaDescribedBy={`rollback-${version.version}`} onConfirm={() => rollback(version.version)} /></>
                        : null}
                  </article>
                )
              })}
            </motion.div>
          </LayoutGroup>
        </div>
      </Plate>
      {versions.length > 1 ? (
        <Plate className="heart-panel">
          <div className="heart-timeline">
            <div className="heart-timeline-labels"><label htmlFor={startId}>对比起点 · v{versions[startIndex]?.version}</label><label htmlFor={endId}>对比终点 · v{versions[endIndex]?.version}</label></div>
            <div className="heart-timeline-track">
              <input id={startId} type="range" min={0} max={versions.length - 1} value={startIndex} aria-valuetext={`v${versions[startIndex]?.version}`}
                onChange={(event) => compare(0, event.currentTarget.valueAsNumber)} onPointerUp={commitRange} onKeyUp={commitRange} onBlur={commitRange} onPointerCancel={() => setDragRange(null)} />
              <input id={endId} type="range" min={0} max={versions.length - 1} value={endIndex} aria-valuetext={`v${versions[endIndex]?.version}`}
                onChange={(event) => compare(1, event.currentTarget.valueAsNumber)} onPointerUp={commitRange} onKeyUp={commitRange} onBlur={commitRange} onPointerCancel={() => setDragRange(null)} />
            </div>
          </div>
        </Plate>
      ) : null}
      {before && after && before.version !== after.version ? <VersionsDiff key={`${before.version}:${after.version}`} before={before} after={after} /> : null}
      {editing ? <ProfileEditor key={editing.version} version={editing} onClose={() => setEditing(null)} onSaved={async (version) => {
        await refresh()
        setSelection(version)
        setManualRange(null)
        setEditing(null)
      }} /> : null}
    </>
  )
}

export function HeartPage() {
  const { displayedRoute, navigate } = useShellNavigation()
  const query = new URLSearchParams(displayedRoute.split('?')[1])
  const tab = query.get('tab') === 'tide' ? 'tide' : 'scroll'
  const { l3Versions, l3VersionsError, refreshL3Versions } = useConsoleShellData()
  const versions = useMemo(() => l3Versions.toSorted((left, right) => left.version - right.version), [l3Versions])
  return (
    <section className="heart-page">
      <PageHeader label="HEART · L3 & TIDE" title="心潮" actions={<BrushTabs items={TABS} value={tab} ariaLabel="心潮分区" onChange={(next) => navigate(next === 'tide' ? 'heart?tab=tide' : 'heart')} />} />
      {tab === 'tide' ? <TidePanel /> : versions.length > 0
        ? <VersionScroll versions={versions} versionQuery={query.get('version')} refresh={refreshL3Versions} />
        : l3VersionsError instanceof Error ? <ErrorState message={l3VersionsError.message} onRetry={() => { void refreshL3Versions() }} />
          : <EmptyState glyph="无卷" description="L3 版本会在这里按时间展开。" />}
    </section>
  )
}
