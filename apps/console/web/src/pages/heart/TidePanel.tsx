import { useEffect, useId, useRef, useState } from 'react'
import { AnimatePresence, motion, useMotionValue, useSpring } from 'motion/react'
import { LockKeyhole } from 'lucide-react'
import { memoryApi } from '../../api/client.ts'
import { ApiError, type ConsolidationProposalView, type L3ProfileVersionSummary, type ShadowCorrectionView } from '../../api/types.ts'
import { POLL_INTERVALS, usePolling } from '../../data/polling.ts'
import { useInk } from '../../ink/InkProvider.tsx'
import { getPreset, REDUCED_TRANSITION_DURATION } from '../../motion/presets.ts'
import { DUR, EASE, SPRING } from '../../motion/tokens.ts'
import { useMotionLevel } from '../../motion/useMotionLevel.ts'
import { useConsoleShellData } from '../../shell/ConsoleShell.tsx'
import { useShellNavigation } from '../../shell/PageTransition.tsx'
import { BrushButton } from '../../ui/BrushButton.tsx'
import { HoldToStamp } from '../../ui/HoldToStamp.tsx'
import { InkNumber } from '../../ui/InkNumber.tsx'
import { InkSelect } from '../../ui/InkSelect.tsx'
import { EmptyState, ErrorState, InkSkeleton } from '../../ui/InkStates.tsx'
import { MagneticButton } from '../../ui/MagneticButton.tsx'
import { Plate } from '../../ui/Plate.tsx'
import { toast } from '../../ui/SealToast.tsx'
import { formatProfileValue, ProfileDiff } from './ProfileDiff.tsx'

type Proposal = ConsolidationProposalView
type ProposalStatus = Proposal['status']

const STATUS = { pending: '待批', approved: '已批', rejected: '已拒' } as const
const STATUS_OPTIONS = (Object.keys(STATUS) as ProposalStatus[]).map((value) => ({ value, label: STATUS[value] }))
const CORRECTION_LABELS: Readonly<Record<ShadowCorrectionView['action'], string>> = {
  'promote-candidate': '转正', 'supersede-fact': '取代', 'close-topic': '结题',
}
const SKIP_LABELS = { 'only-external-evidence': '证据都来自外部', 'insufficient-new-evidence': '新证据不够' } as const
const DATE = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
const DAY = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' })
const CHART_WIDTH = 300
const CHART_HEIGHT = 180

function wavePath(level: number, amplitude: number, phase: number, close = false): string {
  const height = CHART_HEIGHT - 8 - (CHART_HEIGHT - 16) * level
  const points = Array.from({ length: 31 }, (_, index) => {
    const x = index * (CHART_WIDTH / 30)
    const y = height + amplitude * (Math.sin(x * 0.022 + phase) + 0.35 * Math.sin(x * 0.043 - phase))
    return `${x} ${y.toFixed(2)}`
  })
  return `M ${points.join(' L ')}${close ? ` L ${CHART_WIDTH} ${CHART_HEIGHT} L 0 ${CHART_HEIGHT} Z` : ''}`
}

function TideChart({ ratio, running }: { readonly ratio: number; readonly running: boolean }) {
  const motionLevel = useMotionLevel()
  const ink = useInk()
  const chart = useRef<HTMLDivElement>(null)
  const phase = useRef([0, 0])
  const level = Math.min(1, Math.max(0, ratio))
  const drawnLevel = useSpring(level, SPRING.float)
  const intensity = useSpring(1, SPRING.float)
  const front = useMotionValue(wavePath(level, 0, 0, true))
  const back = useMotionValue(wavePath(level, 0, 0, true))
  const line = useMotionValue(wavePath(level, 0, 0))
  const color = ratio >= 1 ? 'var(--yanzhi)' : ratio >= 0.8 ? 'var(--tenghuang)' : 'var(--text-1)'

  useEffect(() => {
    drawnLevel.set(level)
    intensity.set(running ? 3 : 1)
    if (motionLevel === 'reduced') {
      drawnLevel.jump(level)
      front.set(wavePath(level, 0, 0, true))
      back.set(wavePath(level, 0, 0, true))
      line.set(wavePath(level, 0, 0))
      return
    }
    let frame = 0
    let previous = performance.now()
    const draw = (now: number): void => {
      const dt = Math.min(50, now - previous)
      previous = now
      const factor = intensity.get()
      const y = drawnLevel.get()
      phase.current[0] = (phase.current[0] ?? 0) + (dt * factor * Math.PI * 2) / 7000
      phase.current[1] = (phase.current[1] ?? 0) - (dt * factor * Math.PI * 2) / 11000
      front.set(wavePath(y, 3.8 * factor, phase.current[0], true))
      back.set(wavePath(y, 3 * factor, phase.current[1], true))
      line.set(wavePath(y, 3.8 * factor, phase.current[0]))
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [back, drawnLevel, front, intensity, level, line, motionLevel, running])

  useEffect(() => {
    const rect = chart.current?.getBoundingClientRect()
    if (!rect || !running || motionLevel === 'reduced') return
    return ink.stir({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, radius: 130, strength: 0.5, durationMs: 300_000 })
  }, [ink, motionLevel, running])

  return (
    <div ref={chart} className="heart-tide-chart">
      <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} aria-hidden="true">
        <rect x={0.5} y={0.5} width={CHART_WIDTH - 1} height={CHART_HEIGHT - 1} stroke="var(--hair-strong)" fill="none" />
        <motion.path d={back} fill="var(--text-1)" fillOpacity={0.06} />
        <motion.path d={front} fill="var(--text-1)" fillOpacity={0.12} />
        <motion.path d={line} fill="none" stroke={color} strokeWidth={1.5} />
      </svg>
    </div>
  )
}

function ProposalCard({ proposal, baseVersion, fresh, onStatusChange }: {
  readonly proposal: Proposal
  readonly baseVersion: L3ProfileVersionSummary | undefined
  readonly fresh: boolean
  readonly onStatusChange: (id: string, status: ProposalStatus) => void
}) {
  const ink = useInk()
  const { navigate } = useShellNavigation()
  const level = useMotionLevel()
  const titleId = useId()
  const article = useRef<HTMLElement | null>(null)
  const busy = useRef(false)
  const [open, setOpen] = useState(false)
  const [action, setAction] = useState<'approving' | 'approved' | 'rejecting' | null>(null)
  const [choices, setChoices] = useState<Readonly<Record<string, string>>>({})
  const splat = (): void => {
    const rect = article.current?.getBoundingClientRect()
    if (!rect || level !== 'full') return
    const cx = rect.right - 48
    const cy = rect.top + 38
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
  const openRecord = (id: string): void => navigate(`memory?record=${encodeURIComponent(id)}`)

  async function approve(): Promise<void> {
    if (busy.current) return
    busy.current = true
    setAction('approving')
    try {
      await memoryApi.approveConsolidationProposal(proposal.id, choices)
      setAction('approved')
      splat()
    } catch (err) {
      busy.current = false
      setAction(null)
      throw err
    }
  }

  async function reject(): Promise<void> {
    if (busy.current) return
    busy.current = true
    setAction('rejecting')
    try {
      await memoryApi.rejectConsolidationProposal(proposal.id)
      const rect = article.current?.getBoundingClientRect()
      if (rect && level === 'full') ink.dilute({ x: rect.x, y: rect.y, w: rect.width, h: rect.height }, Math.round(DUR.brush * 1000))
      onStatusChange(proposal.id, 'rejected')
    } catch (err) {
      busy.current = false
      setAction(null)
      toast.error(err instanceof Error ? err.message : '拒绝提案失败', { code: err instanceof ApiError ? err.code : undefined })
    }
  }

  const patch = proposal.l3SelfPatch
  return (
    <motion.article ref={article} layout={level === 'full'} aria-labelledby={titleId}
      initial={fresh ? (level === 'full' ? { opacity: 0, x: -40, scale: 0.96, filter: 'blur(8px)' } : { opacity: 0, filter: 'none' }) : false}
      animate={level === 'full'
        ? { opacity: 1, x: 0, scale: 1, filter: 'blur(0px)', transitionEnd: { filter: 'none' } }
        : { opacity: 1, x: 0, scale: 1, filter: 'none' }}
      transition={level === 'full' ? SPRING.float : { duration: REDUCED_TRANSITION_DURATION, ease: EASE.settle }}
      variants={{ dissolve: getPreset('dissolve', level).exit ?? { opacity: 0 } }}
      exit={action === 'approved' ? { opacity: 0, y: level === 'full' ? 24 : 0, transition: { duration: level === 'full' ? DUR.base : REDUCED_TRANSITION_DURATION, ease: EASE.inkIn } } : 'dissolve'}>
      <Plate className="heart-panel">
        <div className="heart-actions">
          <div>
            <h3 id={titleId}>{DAY.format(proposal.createdAt)} 夜 · 窗口 <span className="num">{DATE.format(proposal.window.from)}–{DATE.format(proposal.window.to)}</span></h3>
            <p className="heart-muted">{proposal.l2Candidates.length} 条新场景 · {proposal.corrections.length} 处纠正 · {proposal.selfConflicts.length} 处自相矛盾{patch ? ' · L3 补丁' : ''}</p>
          </div>
          <BrushButton size="sm" variant="secondary" onClick={() => setOpen(!open)} aria-expanded={open} disabled={action !== null}>{open ? '收起' : '展开'}</BrushButton>
        </div>
        {open ? (
          <motion.div layout={level === 'full'} className="heart-proposals">
            {proposal.l2Candidates.length > 0 ? <section className="heart-proposals"><h3>新场景</h3>
              {proposal.l2Candidates.map((candidate) => (
                <Plate key={candidate.id} level="sunken" className="heart-panel">
                  <p className="heart-diff-stable">{formatProfileValue(candidate.content.summary ?? candidate.content.text ?? candidate.content)}</p>
                  {candidate.subjects.length ? <p className="heart-muted">主体 {candidate.subjects.join('、')}</p> : null}
                  <div className="heart-keys">证据 {candidate.evidenceIds.length}{candidate.evidenceIds.map((id, index) => (
                    <BrushButton key={id} size="sm" variant="ghost" onClick={() => openRecord(id)} aria-label={`查看证据 ${index + 1}`}>{index + 1}</BrushButton>
                  ))}</div>
                </Plate>
              ))}
            </section> : null}
            {proposal.corrections.length > 0 ? <section className="heart-proposals"><h3>纠正</h3>
              {proposal.corrections.map((correction) => (
                <Plate key={correction.id} level="sunken" className="heart-panel">
                  <div className="heart-actions"><strong>{CORRECTION_LABELS[correction.action]}</strong>
                    <BrushButton variant="ghost" size="sm" onClick={() => openRecord(correction.targetId)}>查看目标记录</BrushButton>
                  </div><p>{correction.reason}</p>
                </Plate>
              ))}
            </section> : null}
            {proposal.selfConflicts.length > 0 ? <section className="heart-proposals"><h3>自相矛盾</h3>
              {proposal.selfConflicts.map((conflict) => {
                const choice = choices[conflict.id]
                const card = (id: string, statement: string, letter: string) => (
                  <motion.button type="button" onClick={() => setChoices((current) => ({ ...current, [conflict.id]: id }))}
                    disabled={proposal.status !== 'pending' || action !== null} aria-pressed={choice === id}
                    className="plate heart-panel" style={{ textAlign: 'start', border: `1px solid var(--${conflict.recommendedKeepId === id ? 'shilv' : 'hair'})` }}
                    animate={{ scale: choice === id && level === 'full' ? 1.03 : 1, opacity: choice !== undefined && choice !== id ? 0.6 : 1 }}
                    transition={level === 'full' ? SPRING.snappy : { duration: REDUCED_TRANSITION_DURATION }}>
                    <span className="heart-muted">{letter}{conflict.recommendedKeepId === id ? ' · 建议保留' : ''}</span>
                    <span>{statement}</span>
                  </motion.button>
                )
                return <div key={conflict.id} className="heart-proposals">
                  <p className="heart-muted">{conflict.reason}</p>
                  <div className="heart-conflicts">{card(conflict.recordAId, conflict.statementA, 'A')}<span aria-hidden="true">⇄</span>{card(conflict.recordBId, conflict.statementB, 'B')}</div>
                </div>
              })}
            </section> : null}
            {patch ? <section><h3>L3 补丁</h3>
              {baseVersion === undefined ? <p className="heart-muted">原版 v{patch.baseVersion} 暂不可用。</p> : null}
              <ProfileDiff changes={patch} before={baseVersion} after={patch} />
              {patch.preservedOwnerKeys.length ? <p className="heart-keys"><LockKeyhole size={14} aria-hidden /> 主人锁定，未改 · {patch.preservedOwnerKeys.join('、')}</p> : null}
            </section> : null}
            {proposal.skippedL3Reason ? <p className="heart-muted">未改写 L3 · {SKIP_LABELS[proposal.skippedL3Reason]}</p> : null}
            {proposal.status === 'pending' ? (
              <div className="heart-actions" style={{ justifyContent: 'end' }}>
                <BrushButton variant="ghost" loading={action === 'rejecting'} disabled={action !== null} onClick={() => { void reject() }}>拒</BrushButton>
                <HoldToStamp label="准" disabled={action === 'rejecting'} ariaLabel="按住 0.9 秒以确认：批准巩固提案"
                  onConfirm={approve} onComplete={() => onStatusChange(proposal.id, 'approved')} />
              </div>
            ) : null}
          </motion.div>
        ) : null}
        {action === 'approved' ? <motion.span className="heart-current-seal heart-proposal-stamp" variants={getPreset('stamp', level)} initial="initial" animate="animate">准</motion.span> : null}
      </Plate>
    </motion.article>
  )
}

export function TidePanel() {
  const { l3Versions, refreshL3Versions } = useConsoleShellData()
  const proposals = usePolling(() => memoryApi.listConsolidationProposals(), POLL_INTERVALS.proposalsActiveMs)
  const budget = usePolling(() => memoryApi.getConsolidationBudget(), POLL_INTERVALS.proposalsActiveMs)
  const [status, setStatus] = useState<ProposalStatus>('pending')
  const [running, setRunning] = useState(false)
  const [fresh, setFresh] = useState<Proposal | null>(null)
  const [completed, setCompleted] = useState<Readonly<Record<string, ProposalStatus>>>({})
  const busy = useRef(false)
  const items = fresh && !proposals.data?.some(({ id }) => id === fresh.id)
    ? [fresh, ...(proposals.data ?? [])] : (proposals.data ?? [])
  const resolved = items.map((item) => completed[item.id] ? { ...item, status: completed[item.id]! } : item)
  const visible = resolved.filter((proposal) => proposal.status === status).sort((left, right) => right.createdAt - left.createdAt)
  const counts = { pending: 0, approved: 0, rejected: 0 }
  for (const item of resolved) counts[item.status] += 1
  const limit = budget.data?.dailyTokenCap ?? 0
  const used = budget.data?.usedTokensToday ?? 0
  const ratio = limit > 0 ? used / limit : 0

  async function run(): Promise<void> {
    if (busy.current) return
    busy.current = true
    setRunning(true)
    try {
      const item = await memoryApi.runConsolidationShadow()
      setFresh(item)
      setStatus(item.status)
      await Promise.all([proposals.refresh(), budget.refresh()])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '巩固失败', { code: err instanceof ApiError ? err.code : undefined })
    } finally {
      busy.current = false
      setRunning(false)
    }
  }

  function changeStatus(id: string, next: ProposalStatus): void {
    setCompleted((current) => ({ ...current, [id]: next }))
    void proposals.refresh()
    void budget.refresh()
    if (next === 'approved') void refreshL3Versions()
  }

  return (
    <div className="heart-tide">
      <Plate as="section" className="heart-panel">
        <h2>潮位</h2>
        {budget.error instanceof Error ? <ErrorState message={budget.error.message} onRetry={() => { void budget.refresh() }} /> :
          !budget.data ? <InkSkeleton height={160} /> :
            <>
              <TideChart ratio={ratio} running={running} />
              <p>今日 <InkNumber value={Math.round(ratio * 100)} format={(value) => `${value}%`} className="heart-tide-level" /></p>
              <p className="num"><InkNumber value={used} /> / <InkNumber value={limit} /> tok</p>
              <p className="heart-muted">上次巩固到 {budget.data.lastConsolidatedTo > 0 ? DATE.format(budget.data.lastConsolidatedTo) : '尚未巩固'}</p>
            </>}
        <MagneticButton disabled={running}>
          <BrushButton variant="primary" loading={running} onClick={() => { void run() }}>现在涨一次潮</BrushButton>
        </MagneticButton>
      </Plate>
      <section aria-label="巩固提案" className="heart-proposals">
        <Plate className="heart-actions" style={{ padding: 'var(--sp-4)' }}>
          <span className="num">待批 {counts.pending} · 已批 {counts.approved} · 已拒 {counts.rejected}</span>
          <InkSelect options={STATUS_OPTIONS} value={status} onChange={setStatus} ariaLabel="筛选提案状态" />
        </Plate>
        {proposals.error instanceof Error ? <ErrorState message={proposals.error.message} onRetry={() => { void proposals.refresh() }} /> : null}
        {proposals.loading && !proposals.data && !fresh ? <InkSkeleton height={72} rows={2} /> : null}
        {!proposals.loading && !proposals.error && visible.length === 0 ? <EmptyState glyph="无案" description={`当前没有${STATUS[status]}的提案。`} /> : null}
        <AnimatePresence>
          {visible.map((proposal) => (
            <ProposalCard key={proposal.id} proposal={proposal} fresh={proposal.id === fresh?.id}
              baseVersion={l3Versions.find((version) => version.version === proposal.l3SelfPatch?.baseVersion)}
              onStatusChange={changeStatus} />
          ))}
        </AnimatePresence>
      </section>
    </div>
  )
}
