import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { OutboundAudit } from '../contracts/index.ts'
import { hasTable, openPrivateDb } from './sqlite.ts'

export interface OutboundAuditEntry {
  readonly tool: string
  readonly pluginId: string
  readonly channel: string
  readonly ok: boolean
  readonly tAt: number
}

/** `state/agent/outbound.db`: one row per send attempt. Ids and the tool name only, never the words (R8). */
export interface OutboundAuditStore extends OutboundAudit {
  list(): Promise<readonly OutboundAuditEntry[]>
  close(): Promise<void>
}

interface Row {
  readonly tool: string
  readonly plugin_id: string
  readonly channel: string
  readonly ok: number
  readonly t_at: number
}

export async function createOutboundAudit(path: string): Promise<OutboundAuditStore> {
  const db: DatabaseSync = await openPrivateDb(path, (opened) => {
    if (!hasTable(opened, 'outbound_audit')) {
      opened.exec(`CREATE TABLE outbound_audit (
        tool TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        ok INTEGER NOT NULL,
        t_at INTEGER NOT NULL
      ) STRICT`)
    }
  })

  const insert: StatementSync = db.prepare(
    'INSERT INTO outbound_audit (tool, plugin_id, channel, ok, t_at) VALUES (?, ?, ?, ?, ?)',
  )
  const selectAll: StatementSync = db.prepare(
    'SELECT tool, plugin_id, channel, ok, t_at FROM outbound_audit ORDER BY t_at ASC',
  )
  let closed = false

  return {
    async sent(entry): Promise<void> {
      insert.run(entry.tool, entry.pluginId, entry.channel, entry.ok ? 1 : 0, entry.tAt)
    },

    async list(): Promise<readonly OutboundAuditEntry[]> {
      return (selectAll.all() as unknown as Row[]).map((row) => ({
        tool: row.tool,
        pluginId: row.plugin_id,
        channel: row.channel,
        ok: row.ok === 1,
        tAt: row.t_at,
      }))
    },

    async close(): Promise<void> {
      if (closed) return
      closed = true
      db.close()
    },
  }
}
