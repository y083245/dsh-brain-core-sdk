import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { AgentClass } from '@dsh-brain-core/satellite-host'
import type { WakeMetrics } from '../contracts/index.ts'
import { hasTable, openPrivateDb } from './sqlite.ts'

export interface WakeMetricEntry {
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

/** `state/agent/metrics.db`: one row per wake. Numbers and ids only, never any text (R8). */
export interface WakeMetricsStore extends WakeMetrics {
  list(): Promise<readonly WakeMetricEntry[]>
  close(): Promise<void>
}

interface Row {
  readonly wake_id: string
  readonly channel: string
  readonly agent_class: string
  readonly profile_version: number
  readonly arrived_at: number
  readonly first_send_at: number | null
  readonly debounce_ms: number
  readonly steps: string
  readonly retries: number
  readonly outcome: string
}

export async function createWakeMetrics(path: string): Promise<WakeMetricsStore> {
  const db: DatabaseSync = await openPrivateDb(path, (opened) => {
    if (!hasTable(opened, 'wake_metrics')) {
      opened.exec(`CREATE TABLE wake_metrics (
        wake_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        agent_class TEXT NOT NULL,
        profile_version INTEGER NOT NULL,
        arrived_at INTEGER NOT NULL,
        first_send_at INTEGER,
        debounce_ms INTEGER NOT NULL,
        steps TEXT NOT NULL,
        retries INTEGER NOT NULL,
        outcome TEXT NOT NULL
      ) STRICT`)
    }
  })

  const insert: StatementSync = db.prepare(
    'INSERT INTO wake_metrics (wake_id, channel, agent_class, profile_version, arrived_at, first_send_at, debounce_ms, steps, retries, outcome)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const selectAll: StatementSync = db.prepare(
    'SELECT wake_id, channel, agent_class, profile_version, arrived_at, first_send_at, debounce_ms, steps, retries, outcome'
      + ' FROM wake_metrics ORDER BY arrived_at ASC, wake_id ASC',
  )
  let closed = false

  return {
    async record(entry): Promise<void> {
      insert.run(
        entry.wakeId,
        entry.channel,
        entry.agentClass,
        entry.profileVersion,
        entry.arrivedAt,
        entry.firstSendAt ?? null,
        entry.debounceMs,
        JSON.stringify(entry.steps),
        entry.retries,
        entry.outcome,
      )
    },

    async list(): Promise<readonly WakeMetricEntry[]> {
      return (selectAll.all() as unknown as Row[]).map((row) => ({
        wakeId: row.wake_id,
        channel: row.channel,
        agentClass: row.agent_class as AgentClass,
        profileVersion: row.profile_version,
        arrivedAt: row.arrived_at,
        ...(row.first_send_at === null ? {} : { firstSendAt: row.first_send_at }),
        debounceMs: row.debounce_ms,
        steps: JSON.parse(row.steps) as WakeMetricEntry['steps'],
        retries: row.retries,
        outcome: row.outcome as WakeMetricEntry['outcome'],
      }))
    },

    async close(): Promise<void> {
      if (closed) return
      closed = true
      db.close()
    },
  }
}
