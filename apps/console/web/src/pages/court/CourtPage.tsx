import type { ReactNode } from 'react'
import { motion } from 'motion/react'
import { memoryApi } from '../../api/client.ts'
import { ApiError, type AccountingSummary } from '../../api/types.ts'
import { COURT_POLL_INTERVALS, POLL_INTERVALS, usePolling } from '../../data/polling.ts'
import { useInktideStore } from '../../data/store.ts'
import { clamp01 } from '../../lib/memoryHelpers.ts'
import { getPreset, listStaggerDelay } from '../../motion/presets.ts'
import { useMotionLevel } from '../../motion/useMotionLevel.ts'
import { useConsoleShellData } from '../../shell/ConsoleShell.tsx'
import { useShellNavigation } from '../../shell/PageTransition.tsx'
import { BrushButton } from '../../ui/BrushButton.tsx'
import { Enso } from '../../ui/Enso.tsx'
import { formatCostMicros, InkNumber } from '../../ui/InkNumber.tsx'
import { EmptyState, ErrorState, InkSkeleton } from '../../ui/InkStates.tsx'
import { InkText } from '../../ui/InkText.tsx'
import { MagneticButton } from '../../ui/MagneticButton.tsx'
import { PageHeader } from '../../ui/PageHeader.tsx'
import { Plate } from '../../ui/Plate.tsx'
import { EnsoGauge } from '../../ui/charts/EnsoGauge.tsx'
import { CHAT_STATE_LABELS, chatEnsoState } from '../voice/chatStatus.ts'
import { useVoiceSession } from '../voice/voiceSession.ts'
import { MemoryFlow } from './MemoryFlow.tsx'
import { fetchRecentMemoryTail } from './memoryTail.ts'
import './court.css'

const NUMBER_FORMAT = new Intl.NumberFormat('zh-CN')
const TIME_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

function formatCount(value: number): string {
  return NUMBER_FORMAT.format(value)
}

function Budget({ data }: { readonly data: AccountingSummary }) {
  const tokenRatio = data.dailyTokenLimit && data.dailyTokenLimit > 0
    ? data.todayTokens / data.dailyTokenLimit
    : null
  const costRatio = data.dailyCostMicrosLimit && data.dailyCostMicrosLimit > 0
    ? data.todayCostMicros / data.dailyCostMicrosLimit
    : null
  if (tokenRatio === null && costRatio === null) {
    return <span className="court-meta">未设置日预算</span>
  }
  const ratio = Math.max(tokenRatio ?? 0, costRatio ?? 0)
  const label = costRatio !== null && costRatio >= (tokenRatio ?? 0) ? '花费预算' : 'Token 预算'
  return <EnsoGauge size={120} ratio={ratio} label="预算" sublabel={label} ariaLabel={`${label} ${Math.round(ratio * 100)}%`} />
}

function CourtError({ error, onRetry }: { readonly error: unknown; readonly onRetry: () => void }) {
  return (
    <ErrorState
      message={error instanceof Error ? error.message : '暂时无法读取数据'}
      {...(error instanceof ApiError && { code: error.code, requestId: error.requestId })}
      onRetry={onRetry}
    />
  )
}

function TodayCard({ data, error, onRetry }: {
  readonly data: AccountingSummary | undefined
  readonly error: unknown
  readonly onRetry: () => void
}) {
  const hitRate = data && Math.round(clamp01(data.todayCacheHitRatio) * 100)
  return (
    <Plate as="section" aria-labelledby="court-today" className="court-card">
      <h2 id="court-today">今日</h2>
      {data === undefined ? error === undefined ? <InkSkeleton height={130} /> : <CourtError error={error} onRetry={onRetry} /> : (
        <div className="court-today">
          <div>
            <div className="court-today-numbers">
              <span>
                <InkNumber value={data.todayTokens} format={formatCount} variant="xl" />
                <span className="court-meta"> token</span>
              </span>
              <InkNumber value={formatCostMicros(data.todayCostMicros, data.currency)} variant="xl" />
            </div>
            <div className="court-cache">
              <span>缓存命中 <InkNumber value={`${hitRate}%`} /></span>
              <progress aria-label="缓存命中率" value={hitRate} max={100} />
            </div>
          </div>
          <Budget data={data} />
        </div>
      )}
    </Plate>
  )
}

interface TaskRow {
  readonly to: string
  readonly right: string
  readonly label: ReactNode
  readonly tone?: 'warn'
}

export function CourtPage() {
  const {
    satellite, satelliteError, refreshSatellite,
    accounting, accountingError, refreshAccounting,
    plugins, pluginsError, refreshPlugins,
    observeMemoryRecords,
  } = useConsoleShellData()
  const { navigate, displayedRoute } = useShellNavigation()
  const roleCardName = useInktideStore((state) => state.roleCardName)
  const authenticated = useInktideStore((state) => state.authenticated)
  const motionLevel = useMotionLevel()
  const { outgoing } = useVoiceSession()
  const isCourtRoute = displayedRoute.split('?')[0] === 'court'
  const proposals = usePolling(
    () => memoryApi.listConsolidationProposals('pending'),
    COURT_POLL_INTERVALS.proposalsMs,
    { enabled: authenticated && isCourtRoute },
  )
  const memoryFlow = usePolling(
    async (signal) => {
      const tail = await fetchRecentMemoryTail(signal)
      return {
        capturedAt: tail.capturedAt,
        records: tail.recentRecords,
        hasHistory: tail.hasHistory,
        tailRecords: tail.tailRecords,
      }
    },
    POLL_INTERVALS.memoryActiveMs,
    {
      enabled: authenticated && isCourtRoute,
      onData: (result) => observeMemoryRecords(result.tailRecords),
    },
  )
  const chatting = [...outgoing.values()].some((messages) => messages.some((message) => message.status === 'sending'))
  const chat = satellite?.processes.chat
  const ensoState = chatEnsoState(chat, chatting)
  const chatOnline = chat?.status === 'running' || chat?.status === 'idle'
  const pendingPlugins = plugins?.plugins.filter((plugin) => plugin.state === 'pending').length ?? 0
  const pendingProposals = proposals.data?.length ?? 0
  const isolation = satellite?.isolation
  const tasks: TaskRow[] = []
  if (pendingProposals > 0) {
    tasks.push({
      label: <><InkNumber value={pendingProposals} /> 份巩固提案待批</>,
      to: 'heart?tab=tide',
      right: '心',
    })
  }
  if (pendingPlugins > 0) {
    tasks.push({
      label: <><InkNumber value={pendingPlugins} /> 个插件等待确认权限</>,
      to: 'seals',
      right: '印',
    })
  }
  if (isolation?.checkedAt && (!isolation.ok || tasks.length > 0)) {
    tasks.push({
      label: <>隔离检查：{isolation.ok ? '通过' : '异常'}（{TIME_FORMAT.format(isolation.checkedAt)}）</>,
      to: 'pulse',
      right: '脉',
      ...(!isolation.ok ? { tone: 'warn' } : {}),
    })
  }
  const bloom = getPreset('bloom', motionLevel)
  const name = roleCardName || '她'

  return (
    <div className="court-page">
      <PageHeader label="COURT · OVERVIEW" title="总览" />
      <div className="court-grid">
        <motion.section
          className="court-presence"
          aria-label="她的现状"
          variants={bloom}
          initial="initial"
          animate="animate"
        >
          <div className="court-presence-paper plate" aria-hidden="true" />
          <Enso size={220} state={ensoState} ariaLabel={`${name}，${CHAT_STATE_LABELS[ensoState]}`} />
          <InkText key={name} as="h2" text={name} className="court-role-name" />
          {chat ? (
            <p className="court-presence-status">
              {CHAT_STATE_LABELS[ensoState]} · chat {chatOnline ? '在线' : '离线'} · <InkNumber value={chat.activeSessions} /> 个会话
            </p>
          ) : satelliteError === undefined ? (
            <p className="court-presence-status">正在读取运行状态</p>
          ) : (
            <span className="court-presence-status">
              运行状态未取得
              <BrushButton variant="ghost" size="sm" onClick={() => { void refreshSatellite() }}>重试</BrushButton>
            </span>
          )}
          <MagneticButton>
            <BrushButton variant="primary" onClick={() => navigate('voice')}>和她说话 →</BrushButton>
          </MagneticButton>
        </motion.section>
        <motion.div className="court-right" variants={bloom} initial="initial" animate="animate" custom={listStaggerDelay(1)}>
          <TodayCard data={accounting} error={accountingError} onRetry={() => { void refreshAccounting() }} />
          <Plate as="section" aria-labelledby="court-tasks" className="court-card">
            <h2 id="court-tasks">待你处理</h2>
            {proposals.error && proposals.data === undefined ? (
              <CourtError error={proposals.error} onRetry={() => { void proposals.refresh() }} />
            ) : null}
            {pluginsError && plugins === undefined ? (
              <CourtError error={pluginsError} onRetry={() => { void refreshPlugins() }} />
            ) : null}
            {tasks.length > 0 ? (
              <ul className="court-task-list">
                {tasks.map((task) => (
                  <li key={task.to}>
                    <button type="button" data-tone={task.tone} onClick={() => navigate(task.to)}>
                      <span className="court-task-box" aria-hidden="true" />
                      <span>{task.label}</span>
                      <span aria-hidden="true">→ {task.right}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : proposals.error || pluginsError || satelliteError ? null : proposals.data && plugins && satellite ? (
              <EmptyState glyph="无事" description="暂无待处理事项" />
            ) : <InkSkeleton height={88} />}
          </Plate>
        </motion.div>
        <Plate as="section" aria-labelledby="court-flow" className="court-card court-flow-card">
          <h2 id="court-flow">墨流</h2>
          {memoryFlow.data ? (
            <MemoryFlow data={memoryFlow.data} />
          ) : memoryFlow.error !== undefined ? (
            <CourtError error={memoryFlow.error} onRetry={() => { void memoryFlow.refresh() }} />
          ) : <InkSkeleton height={88} />}
        </Plate>
      </div>
    </div>
  )
}
