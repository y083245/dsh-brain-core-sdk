import type { AgentClass, ModelSelection, RunnerStatus } from '@brain-core/satellite-host'
import type { ErrorCode } from '@brain-core/sdk'
import { apiFetch } from '../../shell/api-fetch.ts'

export type SatelliteRecoveryPhase = 'idle' | 'running' | 'crashing' | 'restarting' | 'recovered' | 'failed'

export type SatelliteSubView = 'runtime' | 'accounting' | 'interop'

export interface InteropSnapshot {
  readonly ampAliases: boolean
  readonly mcp: {
    readonly enabled: boolean
    readonly running: boolean
    readonly url?: string
    readonly port?: number
    readonly patchYaml?: string
  }
  readonly debugView: {
    readonly running: boolean
    readonly pid?: number
    readonly url?: string
    readonly port?: number
  }
}

export interface AgentProcessStatus {
  readonly agentClass: AgentClass
  readonly status: RunnerStatus
  readonly recoveryPhase?: SatelliteRecoveryPhase
  readonly pid?: number
  readonly activeSessions: number
  readonly selection: ModelSelection | null
  readonly lastError?: string
  readonly deniedApprovals: number
}

export interface SessionSurfaceInfo {
  readonly sessionId: string
  readonly channel: string
  readonly agentClass: AgentClass
  readonly toolCount: number
}

export interface IsolationDoctorStatus {
  readonly ok: boolean
  readonly checkedAt: number
  readonly problems: readonly string[]
}

export interface WakeMetricSample {
  readonly wakeId: string
  readonly channel: string
  readonly agentClass: AgentClass
  readonly profileVersion: number
  readonly arrivedAt: number
  readonly firstSendAt?: number
  readonly debounceMs: number
  readonly steps: readonly {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheReadTokens: number
    readonly cacheWriteTokens: number
  }[]
  readonly retries: number
  readonly outcome: 'acked' | 'interrupted' | 'unavailable'
}

export interface SatelliteSnapshot {
  readonly processes: Readonly<Record<AgentClass, AgentProcessStatus>>
  readonly sessions: readonly SessionSurfaceInfo[]
  readonly isolation: IsolationDoctorStatus
  readonly metrics: readonly WakeMetricSample[]
  readonly sharedQuotaWarning: boolean
}

export interface SatellitePageApi {
  getSnapshot(): Promise<SatelliteSnapshot>
  restart(agentClass: AgentClass): Promise<void>
  runIsolationDoctor(): Promise<IsolationDoctorStatus>
  getInterop?(): Promise<InteropSnapshot>
  setAmpAliases?(enabled: boolean): Promise<InteropSnapshot>
  setReadOnlyMcp?(enabled: boolean): Promise<InteropSnapshot>
  startDebugView?(): Promise<InteropSnapshot>
  stopDebugView?(): Promise<InteropSnapshot>
}

export class SatelliteApiError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly requestId?: string

  constructor(code: ErrorCode, status: number, message: string, requestId?: string) {
    super(`${code}: ${message}`)
    this.name = 'SatelliteApiError'
    this.code = code
    this.status = status
    if (requestId !== undefined) this.requestId = requestId
  }
}

export function createHttpSatellitePageApi(
  baseUrl: string,
  token: string,
  fetchImpl?: typeof globalThis.fetch,
): SatellitePageApi {
  const base = baseUrl.replace(/\/+$/, '')

  async function request<T>(path: string, method: 'GET' | 'POST' | 'PUT' = 'GET', body?: unknown): Promise<T> {
    const result = await apiFetch<T>(`${base}${path}`, {
      token,
      method,
      ...(body === undefined ? {} : { body }),
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    })
    if (!result.ok) {
      throw new SatelliteApiError(result.code, result.status, result.message, result.requestId)
    }
    return result.data
  }

  return {
    getSnapshot(): Promise<SatelliteSnapshot> {
      return request<SatelliteSnapshot>('/api/v1/console/satellite')
    },

    async restart(agentClass: AgentClass): Promise<void> {
      await request<unknown>(
        `/api/v1/console/satellite/${encodeURIComponent(agentClass)}/restart`,
        'POST',
      )
    },

    runIsolationDoctor(): Promise<IsolationDoctorStatus> {
      return request<IsolationDoctorStatus>('/api/v1/console/satellite/doctor', 'POST')
    },

    getInterop(): Promise<InteropSnapshot> {
      return request<InteropSnapshot>('/api/v1/console/interop')
    },

    setAmpAliases(enabled: boolean): Promise<InteropSnapshot> {
      return request<InteropSnapshot>('/api/v1/console/interop/amp', 'PUT', { enabled })
    },

    setReadOnlyMcp(enabled: boolean): Promise<InteropSnapshot> {
      return request<InteropSnapshot>('/api/v1/console/interop/mcp', 'PUT', { enabled })
    },

    startDebugView(): Promise<InteropSnapshot> {
      return request<InteropSnapshot>('/api/v1/console/interop/debug-view/start', 'POST')
    },

    stopDebugView(): Promise<InteropSnapshot> {
      return request<InteropSnapshot>('/api/v1/console/interop/debug-view/stop', 'POST')
    },
  }
}
