import { useEffect, useId, useState } from 'react'
import { motion } from 'motion/react'
import { satelliteApi } from '../../api/client.ts'
import { ApiError, type AgentProcessStatus, type IsolationDoctorStatus, type SessionSurfaceInfo, type WakeMetricSample } from '../../api/types.ts'
import { REDUCED_FADE_DURATION } from '../../motion/presets.ts'
import { DUR, EASE } from '../../motion/tokens.ts'
import { useMotionLevel } from '../../motion/useMotionLevel.ts'
import { useConsoleShellData } from '../../shell/ConsoleShell.tsx'
import { useShellNavigation } from '../../shell/PageTransition.tsx'
import { BrushButton } from '../../ui/BrushButton.tsx'
import { HoldToStamp } from '../../ui/HoldToStamp.tsx'
import { EmptyState, ErrorState, InkSkeleton } from '../../ui/InkStates.tsx'
import { InkTable, type InkTableColumn } from '../../ui/InkTable.tsx'
import { PageHeader } from '../../ui/PageHeader.tsx'
import { Plate } from '../../ui/Plate.tsx'
import { buildCatmullRomPath } from '../../ui/charts/BrushLine.tsx'
import './pulse.css'

const WIDTH = 590
const HEIGHT = 112
const BASE = 65
const HISTORY_MS = 3 * 60_000
const PHASES = [
  { id: 'idle', text: '静候' },
  { id: 'crashing', text: '断裂' },
  { id: 'restarting', text: '起搏' },
  { id: 'recovered', text: '恢复' },
] as const
const STATUSES = {
  idle: '待机', starting: '启动中', running: '运行中', stopping: '停止中',
  stopped: '已停止', crashed: '异常退出', failed: '启动失败',
} as const

const COLUMNS: readonly InkTableColumn<SessionSurfaceInfo>[] = [
  { key: 'session', header: '会话 ID', render: ({ sessionId }) => <code className="pulse-session-id" title={sessionId}>{sessionId}</code> },
  { key: 'channel', header: '通道', render: ({ channel }) => channel },
  { key: 'agent', header: 'Agent 类', render: ({ agentClass }) => <code>{agentClass}</code> },
  { key: 'tools', header: '工具数', numeric: true, render: ({ toolCount }) => toolCount },
]
const DATE = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' })

function totalTokens(sample: WakeMetricSample): number {
  return sample.steps.reduce((total, step) => total + step.inputTokens + step.outputTokens, 0)
}

function drawBeat(x: number, height: number, span: number): string {
  return buildCatmullRomPath([
    { x: x - span, y: BASE },
    { x: x - span * 0.7, y: BASE + 4 },
    { x: x - span * 0.28, y: BASE },
    { x, y: BASE - height },
    { x: x + span * 0.14, y: BASE + height * 0.14 },
    { x: x + span * 0.36, y: BASE - 4 },
    { x: x + span, y: BASE },
  ])
}

function PulseLine({ process, metrics }: { readonly process: AgentProcessStatus; readonly metrics: readonly WakeMetricSample[] }) {
  const motionLevel = useMotionLevel()
  const [now, setNow] = useState(() => Date.now())
  const [active, setActive] = useState<string | null>(null)
  const restarting = process.status === 'starting' || process.recoveryPhase === 'restarting'
  const crashed = process.status === 'crashed' || process.recoveryPhase === 'crashing'
  const failed = process.status === 'failed' || process.recoveryPhase === 'failed'
  const running = !failed && !restarting && !crashed && process.status === 'running'
  const live = running && motionLevel === 'full'
  const activeSample = metrics.find((item) => item.wakeId === active)
  const latest = metrics.at(-1)?.arrivedAt ?? now
  const rightTime = live ? Math.max(now, latest) : latest
  const stroke = failed || crashed ? 'var(--yanzhi)' : restarting ? 'var(--tenghuang)' : running ? 'var(--text-1)' : 'var(--text-3)'
  const phase = process.recoveryPhase === 'running' || process.recoveryPhase === undefined ? restarting ? 'restarting' : 'idle' : process.recoveryPhase
  const phaseIndex = PHASES.findIndex(({ id }) => id === phase)
  const restingPath = buildCatmullRomPath(Array.from({ length: 31 }, (_, index) => ({
    x: index * WIDTH / 30,
    y: BASE + (live ? Math.sin(index * 1.48 + now / 220) * 0.86 : 0),
  })))

  useEffect(() => {
    if (!live) return
    const timer = window.setInterval(() => { if (!document.hidden) setNow(Date.now()) }, 150)
    return () => window.clearInterval(timer)
  }, [live])

  return (
    <>
      {restarting || crashed || phase === 'recovered' ? (
        <div className="pulse-recovery" aria-label="恢复阶段">
          {PHASES.map(({ id, text }, index) => <span key={id}
            aria-current={index === phaseIndex ? 'step' : undefined}
            style={{ color: index === phaseIndex ? 'var(--zhusha)' : index < phaseIndex ? 'var(--shilv)' : 'var(--text-2)' }}>
            {index > 0 ? <span className="pulse-meta" aria-hidden="true"> → </span> : null}{text} <code>{id}</code>
          </span>)}
        </div>
      ) : null}
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="pulse-line" aria-label={`${process.agentClass} 脉搏`}>
        {crashed ? <>
          <path d={`M 0 ${BASE} H 310 M 317 ${BASE - 19} l -6 20 7 17`} stroke={stroke} strokeWidth={2} fill="none" />
          <path d={`M 323 ${BASE} H ${WIDTH}`} stroke={stroke} strokeDasharray="5 7" fill="none" />
        </> : (
          <path d={restingPath} stroke={stroke} strokeDasharray={failed ? '5 7' : undefined} strokeWidth={1.5} fill="none" />
        )}
        {restarting ? [16, 27, 43].map((height, index) => (
          <motion.path key={height} d={drawBeat(230 + index * 55, height, 24)} stroke={stroke} strokeWidth={2} fill="none"
            initial={motionLevel === 'full' ? { pathLength: 0 } : { opacity: 0 }}
            animate={{ pathLength: 1, opacity: 1 }}
            transition={{
              duration: motionLevel === 'full' ? DUR.bloom : REDUCED_FADE_DURATION,
              ease: EASE.brush,
              delay: motionLevel === 'full' ? index * DUR.quick : 0,
            }} />
        )) : null}
        {running ? metrics.map((sample) => {
          const x = WIDTH - 24 - ((rightTime - sample.arrivedAt) / HISTORY_MS) * (WIDTH - 48)
          if (x < -50 || x > WIDTH) return null
          const height = Math.min(53, Math.max(8, Math.log10(1 + totalTokens(sample)) * 8))
          const latencyMs = sample.firstSendAt === undefined ? 0 : Math.max(0, sample.firstSendAt - sample.arrivedAt)
          const span = Math.min(54, Math.max(8, latencyMs / 160))
          const tone = sample.outcome === 'interrupted' ? 'var(--tenghuang)' : sample.outcome === 'unavailable' ? 'var(--yanzhi)' : stroke
          return (
            <g key={sample.wakeId} role="button" tabIndex={0} aria-label={`${sample.channel} 唤醒详情`} aria-pressed={active === sample.wakeId}
              onPointerEnter={() => setActive(sample.wakeId)} onPointerLeave={() => setActive((value) => value === sample.wakeId ? null : value)}
              onFocus={() => setActive(sample.wakeId)} onBlur={() => setActive((value) => value === sample.wakeId ? null : value)}
              onClick={() => setActive(sample.wakeId)} onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setActive(sample.wakeId) }
                if (event.key === 'Escape') setActive(null)
              }}>
              <path d={drawBeat(x, height, span)} stroke={tone} strokeWidth={2.25} strokeLinecap="round" fill="none" />
              <rect x={x - span} y={BASE - height - 7} width={span * 2} height={height + 26} fill="transparent" />
            </g>
          )
        }) : null}
      </svg>
      {running && activeSample ? (
        <Plate level="sunken" className="pulse-detail">
          <strong>{activeSample.channel}</strong>
          <dl>
            <dt>步骤 · 重试 · 首条回复</dt>
            <dd className="num">{activeSample.steps.length} · {activeSample.retries} · {activeSample.firstSendAt === undefined ? '—' : `${Math.max(0, activeSample.firstSendAt - activeSample.arrivedAt)} ms`}</dd>
            {activeSample.steps.map((step, index) => <div key={index}>
              <dt>第 {index + 1} 步</dt>
              <dd className="num">入 {step.inputTokens} · 出 {step.outputTokens} · 缓存读 {step.cacheReadTokens} · 缓存写 {step.cacheWriteTokens}</dd>
            </div>)}
          </dl>
        </Plate>
      ) : null}
    </>
  )
}

function AgentPulse({ process, metrics, refresh }: {
  readonly process: AgentProcessStatus
  readonly metrics: readonly WakeMetricSample[]
  readonly refresh: () => Promise<unknown>
}) {
  const { navigate } = useShellNavigation()
  const danger = useId()
  return (
    <Plate as="section" className="pulse-panel" data-agent={process.agentClass}>
      <h2>{process.agentClass}</h2>
      <p>
        <span aria-hidden="true" style={{ color: process.status === 'running' ? 'var(--shilv)' : process.status === 'failed' ? 'var(--yanzhi)' : 'var(--text-3)' }}>
          {process.status === 'running' ? '●' : '○'}
        </span> {STATUSES[process.status]}{process.pid === undefined ? '' : ` · pid ${process.pid}`}
        {process.selection ? ` · ${process.activeSessions} 个会话` : ' · 未选择模型'}
      </p>
      <PulseLine process={process} metrics={metrics} />
      {process.selection ? (
        <>
          <p className="num pulse-meta">{process.selection.model} / {process.selection.effort} · 拒绝审批 {process.deniedApprovals}</p>
          <div className="pulse-actions">
            <div>
              <p className="pulse-meta">最近错误 · {process.lastError ?? '无'}</p>
              <p className="pulse-meta" id={danger}>重启会打断进行中的会话。</p>
            </div>
            <HoldToStamp label="重启" ariaLabel={`按住 0.9 秒以确认：重启 ${process.agentClass}`}
              ariaDescribedBy={danger} disabled={process.status === 'starting' || process.status === 'stopping' || process.recoveryPhase === 'restarting'}
              onConfirm={async () => { await satelliteApi.restart(process.agentClass); await refresh() }} />
          </div>
        </>
      ) : <div><BrushButton variant="secondary" onClick={() => navigate('settings')}>去设置模型</BrushButton></div>}
    </Plate>
  )
}

function IsolationCarving() {
  const motionLevel = useMotionLevel()
  return (
    <div role="status" className="pulse-carving">
      <div className="pulse-carving-mark" aria-hidden="true">
        <motion.span
          initial={false}
          animate={motionLevel === 'full' ? { x: [4, 28, 4] } : { x: 16 }}
          transition={motionLevel === 'full' ? { duration: DUR.brush * 2, repeat: Infinity, ease: EASE.brush } : { duration: REDUCED_FADE_DURATION }}
        />
      </div>
      <span className="pulse-meta">正在执行隔离检查</span>
    </div>
  )
}

export function PulsePage() {
  const { satellite, satelliteError, refreshSatellite } = useConsoleShellData()
  const [doctor, setDoctor] = useState<IsolationDoctorStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<unknown>()
  const isolation = doctor && doctor.checkedAt >= (satellite?.isolation.checkedAt ?? 0) ? doctor : satellite?.isolation

  async function check(): Promise<void> {
    if (checking) return
    setChecking(true)
    setCheckError(undefined)
    try {
      setDoctor(await satelliteApi.doctor())
      await refreshSatellite()
    } catch (err) {
      setCheckError(err)
    } finally {
      setChecking(false)
    }
  }

  return (
    <section className="pulse-page">
      <PageHeader label="PULSE · RUNTIME" title="脉动" />
      {satellite?.sharedQuotaWarning ? <Plate tone="warn" className="pulse-panel" role="status">与主 DSH 共用配额</Plate> : null}
      {satelliteError instanceof Error ? <ErrorState message={satelliteError.message} code={satelliteError instanceof ApiError ? satelliteError.code : undefined} onRetry={() => { void refreshSatellite() }} /> : null}
      {!satellite && !satelliteError ? <InkSkeleton rows={2} height={140} /> : null}
      {satellite ? <>
        <div className="pulse-agents">
          {(['chat', 'activity'] as const).map((agent) => (
            <AgentPulse key={agent} process={satellite.processes[agent]} metrics={satellite.metrics.filter((item) => item.agentClass === agent).sort((a, b) => a.arrivedAt - b.arrivedAt)} refresh={refreshSatellite} />
          ))}
        </div>
        <Plate as="section" className="pulse-panel">
          <h2>会话</h2>
          <div className="pulse-table"><InkTable columns={COLUMNS} rows={satellite.sessions} getRowKey={(row) => row.sessionId} ariaLabel="附属运行时会话" emptyState={<EmptyState glyph="无话" description="当前没有附属运行时会话。" />} /></div>
        </Plate>
      </> : null}
      <Plate as="section" className="pulse-panel">
        <div className="pulse-actions">
          <div>
            <h2>隔离检查</h2>
            <p className="pulse-meta">上次检查 · {isolation && isolation.checkedAt > 0 ? DATE.format(isolation.checkedAt) : '尚未检查'}</p>
          </div>
          <BrushButton loading={checking} onClick={() => { void check() }}>现在检查</BrushButton>
        </div>
        {checking ? <IsolationCarving /> : isolation && isolation.checkedAt > 0 ? (
          <>
            <span className="pulse-isolation" style={{ color: isolation.ok ? 'var(--shilv)' : 'var(--yanzhi)' }}>{isolation.ok ? '隔' : '误'}</span>
            {!isolation.ok ? <ul>{isolation.problems.map((problem, index) => <li key={index}>{problem}</li>)}</ul> : null}
          </>
        ) : null}
        {checkError instanceof Error ? <p role="alert" style={{ color: 'var(--yanzhi)' }}>{checkError instanceof ApiError ? `${checkError.code} · ` : ''}{checkError.message}</p> : null}
      </Plate>
    </section>
  )
}
