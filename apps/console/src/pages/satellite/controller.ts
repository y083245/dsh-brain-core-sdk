import type { AgentClass } from '@dsh-brain-core/satellite-host'
import { computeSatelliteMetricsSummary, type SatelliteMetricsSummary } from './metrics.ts'
import type {
  AgentProcessStatus,
  InteropSnapshot,
  IsolationDoctorStatus,
  SatellitePageApi,
  SatelliteRecoveryPhase,
  SatelliteSnapshot,
  SatelliteSubView,
} from './types.ts'

export interface SatellitePageState {
  readonly activeSubView: SatelliteSubView
  readonly snapshot: SatelliteSnapshot | null
  readonly summary: SatelliteMetricsSummary
  readonly displayPhase: Readonly<Record<AgentClass, SatelliteRecoveryPhase>>
  readonly interop: InteropSnapshot | null
  readonly errorMessage: string | null
}

export interface SatellitePageController {
  state(): SatellitePageState
  setSubView(view: SatelliteSubView): void
  refresh(): Promise<void>
  restart(agentClass: AgentClass): Promise<void>
  runDoctor(): Promise<IsolationDoctorStatus>
  refreshInterop(): Promise<void>
  toggleAmpAliases(enabled: boolean): Promise<void>
  toggleReadOnlyMcp(enabled: boolean): Promise<void>
  startDebugView(): Promise<void>
  stopDebugView(): Promise<void>
}

const AGENT_CLASSES: readonly AgentClass[] = ['chat', 'activity']

function errorText(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : String(error)
}

export function createSatellitePageController(api: SatellitePageApi): SatellitePageController {
  let activeSubView: SatelliteSubView = 'runtime'
  let snapshot: SatelliteSnapshot | null = null
  let summary: SatelliteMetricsSummary = computeSatelliteMetricsSummary([], [])
  let displayPhase: Record<AgentClass, SatelliteRecoveryPhase> = {
    chat: 'idle',
    activity: 'idle',
  }
  let interop: InteropSnapshot | null = null
  let errorMessage: string | null = null

  const prevPhase: Record<AgentClass, SatelliteRecoveryPhase> = {
    chat: 'idle',
    activity: 'idle',
  }
  const restartPending: Record<AgentClass, boolean> = {
    chat: false,
    activity: false,
  }

  function resolvePhase(agentClass: AgentClass, proc: AgentProcessStatus): SatelliteRecoveryPhase {
    if (proc.recoveryPhase === 'crashing') {
      return 'crashing'
    }
    if (proc.status === 'restarting' || proc.recoveryPhase === 'restarting') {
      return 'restarting'
    }
    if (proc.status === 'running') {
      const wasRecovering =
        prevPhase[agentClass] === 'crashing'
        || prevPhase[agentClass] === 'restarting'
        || restartPending[agentClass]
      restartPending[agentClass] = false
      if (wasRecovering || proc.recoveryPhase === 'recovered') {
        return 'recovered'
      }
      return 'running'
    }
    if (proc.status === 'failed') {
      restartPending[agentClass] = false
      return 'failed'
    }
    restartPending[agentClass] = false
    return 'idle'
  }

  async function runInteropUpdate(fn: (() => Promise<InteropSnapshot>) | undefined): Promise<void> {
    if (fn === undefined) {
      errorMessage = '当前后端未启用外部互通接口'
      return
    }
    try {
      interop = await fn()
      errorMessage = null
    } catch (error) {
      errorMessage = errorText(error)
    }
  }

  return {
    state(): SatellitePageState {
      return {
        activeSubView,
        snapshot,
        summary,
        displayPhase: { ...displayPhase },
        interop,
        errorMessage,
      }
    },

    setSubView(view: SatelliteSubView): void {
      activeSubView = view
    },

    async refresh(): Promise<void> {
      try {
        const next = await api.getSnapshot()
        snapshot = next
        summary = computeSatelliteMetricsSummary(next.metrics, next.sessions)

        const nextDisplay: Record<AgentClass, SatelliteRecoveryPhase> = {
          chat: displayPhase.chat,
          activity: displayPhase.activity,
        }
        for (const agentClass of AGENT_CLASSES) {
          const phase = resolvePhase(agentClass, next.processes[agentClass])
          nextDisplay[agentClass] = phase
          prevPhase[agentClass] = phase
        }
        displayPhase = nextDisplay
        errorMessage = null
      } catch (error) {
        errorMessage = errorText(error)
      }
    },

    async restart(agentClass: AgentClass): Promise<void> {
      try {
        await api.restart(agentClass)
        restartPending[agentClass] = true
        errorMessage = null
      } catch (error) {
        errorMessage = errorText(error)
        return
      }
      await this.refresh()
    },

    async runDoctor(): Promise<IsolationDoctorStatus> {
      try {
        const isolation = await api.runIsolationDoctor()
        if (snapshot !== null) {
          snapshot = { ...snapshot, isolation }
        }
        errorMessage = null
        return isolation
      } catch (error) {
        errorMessage = errorText(error)
        throw error
      }
    },

    async refreshInterop(): Promise<void> {
      if (api.getInterop === undefined) return
      await runInteropUpdate(() => api.getInterop!())
    },

    async toggleAmpAliases(enabled: boolean): Promise<void> {
      await runInteropUpdate(api.setAmpAliases === undefined ? undefined : () => api.setAmpAliases!(enabled))
    },

    async toggleReadOnlyMcp(enabled: boolean): Promise<void> {
      await runInteropUpdate(api.setReadOnlyMcp === undefined ? undefined : () => api.setReadOnlyMcp!(enabled))
    },

    async startDebugView(): Promise<void> {
      await runInteropUpdate(api.startDebugView === undefined ? undefined : () => api.startDebugView!())
    },

    async stopDebugView(): Promise<void> {
      await runInteropUpdate(api.stopDebugView === undefined ? undefined : () => api.stopDebugView!())
    },
  }
}
