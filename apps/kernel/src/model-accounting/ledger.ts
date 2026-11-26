import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { BrainError } from '@brain-core/sdk'
import { createUlid, ensurePrivateDir, hardenFile } from '@brain-core/shared'
import type {
  AccountingEntry,
  AccountingEntryInput,
  AccountingSummary,
  Clock,
  DailyCostPoint,
  ModelAccountingStore,
  ModelPriceBook,
  PluginCostBreakdown,
  TokenUsage,
} from '../contracts/index.ts'
import { computeCostMicros, loadPriceBook, lookupPrice, savePriceBook } from './prices.ts'

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const VALID_AGENT_CLASSES = new Set<string>(['chat', 'activity', 'kernel'])

interface TodayRow {
  readonly tokens: number
  readonly cost_micros: number
  readonly calls: number
}

interface TodayDetailRow {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_read_tokens: number
  readonly cache_write_tokens: number
  readonly cost_micros: number
}

interface PluginBreakdownRow {
  readonly owner: string
  readonly plugin_id: string | null
  readonly calls: number
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_read_tokens: number
  readonly cache_write_tokens: number
  readonly total_tokens: number
  readonly cost_micros: number
  readonly currency: string | null
  readonly unpriced_calls: number
}

interface DailyTrendRow {
  readonly day: string
  readonly calls: number
  readonly total_tokens: number
  readonly cost_micros: number
  readonly currency: string | null
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
}

function hardenSidecars(dbPath: string): void {
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${dbPath}${suffix}`
    if (!existsSync(sidecar)) continue
    const hardened = hardenFile(sidecar)
    if (!hardened.ok) {
      throw new Error(`could not harden ${sidecar}: ${hardened.detail}`)
    }
  }
}

export async function openAccountingDb(dbPath: string): Promise<DatabaseSync> {
  await ensurePrivateDir(path.dirname(dbPath))
  if (!existsSync(dbPath)) {
    try {
      writeFileSync(dbPath, '', { mode: 0o600, flag: 'wx' })
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
    }
  }
  const hardened = hardenFile(dbPath)
  if (!hardened.ok) {
    throw new Error(`could not harden ${dbPath}: ${hardened.detail}`)
  }

  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA secure_delete = ON')
    db.exec(`
      CREATE TABLE IF NOT EXISTS usage_ledger (
        id TEXT PRIMARY KEY,
        t_at INTEGER NOT NULL,
        day TEXT NOT NULL,
        owner TEXT NOT NULL,
        plugin_id TEXT,
        agent_class TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        cost_micros INTEGER NOT NULL,
        currency TEXT NOT NULL,
        priced INTEGER NOT NULL,
        channel TEXT,
        wake_id TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS usage_ledger_day ON usage_ledger (day);
      CREATE INDEX IF NOT EXISTS usage_ledger_plugin_day ON usage_ledger (plugin_id, day);
    `)
    hardenSidecars(dbPath)
  } catch (error) {
    try { db.close() } catch { /* original error wins */ }
    throw error
  }
  return db
}

function assertNonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new BrainError('INVALID_ARGUMENT', `${field} must be a non-negative integer`)
  }
  return value
}

function validateUsage(usage: TokenUsage): void {
  if (usage === null || typeof usage !== 'object') {
    throw new BrainError('INVALID_ARGUMENT', 'usage must be an object')
  }
  assertNonNegativeInt(usage.inputTokens, 'usage.inputTokens')
  assertNonNegativeInt(usage.outputTokens, 'usage.outputTokens')
  assertNonNegativeInt(usage.cacheReadTokens, 'usage.cacheReadTokens')
  assertNonNegativeInt(usage.cacheWriteTokens, 'usage.cacheWriteTokens')
}

function validateEntryInput(entry: AccountingEntryInput): void {
  if (entry === null || typeof entry !== 'object') {
    throw new BrainError('INVALID_ARGUMENT', 'entry must be an object')
  }
  if (typeof entry.tAt !== 'number' || !Number.isFinite(entry.tAt)) {
    throw new BrainError('INVALID_ARGUMENT', 'tAt must be a finite number')
  }
  if (typeof entry.day !== 'string' || entry.day.trim() === '') {
    throw new BrainError('INVALID_ARGUMENT', 'day must be a non-empty string')
  }
  if (typeof entry.owner !== 'string' || entry.owner.trim() === '') {
    throw new BrainError('INVALID_ARGUMENT', 'owner must be a non-empty string')
  }
  if (!VALID_AGENT_CLASSES.has(entry.agentClass)) {
    throw new BrainError('INVALID_ARGUMENT', 'agentClass must be chat, activity, or kernel')
  }
  if (typeof entry.provider !== 'string' || entry.provider.trim() === '') {
    throw new BrainError('INVALID_ARGUMENT', 'provider must be a non-empty string')
  }
  if (typeof entry.model !== 'string' || entry.model.trim() === '') {
    throw new BrainError('INVALID_ARGUMENT', 'model must be a non-empty string')
  }
  validateUsage(entry.usage)
}

function subtractCalendarDays(day: string, deltaDays: number): string | undefined {
  const match = DAY_PATTERN.exec(day)
  if (match === null) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const date = Number(match[3])
  const utc = new Date(Date.UTC(year, month - 1, date - deltaDays))
  if (Number.isNaN(utc.getTime())) return undefined
  const y = String(utc.getUTCFullYear()).padStart(4, '0')
  const m = String(utc.getUTCMonth() + 1).padStart(2, '0')
  const d = String(utc.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export async function createModelAccountingStore(options: {
  readonly dbPath: string
  readonly pricesFile: string
  readonly clock: Clock
}): Promise<ModelAccountingStore> {
  await loadPriceBook(options.pricesFile)
  const db = await openAccountingDb(options.dbPath)
  const nextId = createUlid({ now: () => options.clock.now() })
  let closed = false
  let tail: Promise<unknown> = Promise.resolve()

  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work, work)
    tail = result.then(() => undefined, () => undefined)
    return result
  }

  function assertOpen(): void {
    if (closed) {
      throw new BrainError('UNAVAILABLE', 'model accounting store is closed')
    }
  }

  const insertStmt: StatementSync = db.prepare(`
    INSERT INTO usage_ledger (
      id, t_at, day, owner, plugin_id, agent_class, provider, model,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      cost_micros, currency, priced, channel, wake_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const todayAllStmt: StatementSync = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens,
      COALESCE(SUM(cost_micros), 0) AS cost_micros,
      COUNT(*) AS calls
    FROM usage_ledger
    WHERE day = ?
  `)

  const todayPluginStmt: StatementSync = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens,
      COALESCE(SUM(cost_micros), 0) AS cost_micros,
      COUNT(*) AS calls
    FROM usage_ledger
    WHERE day = ? AND plugin_id = ?
  `)

  const todayDetailStmt: StatementSync = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
      COALESCE(SUM(cost_micros), 0) AS cost_micros
    FROM usage_ledger
    WHERE day = ?
  `)

  const byPluginStmt: StatementSync = db.prepare(`
    SELECT
      owner,
      plugin_id,
      COUNT(*) AS calls,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
      COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS total_tokens,
      COALESCE(SUM(cost_micros), 0) AS cost_micros,
      MAX(currency) AS currency,
      COALESCE(SUM(CASE WHEN priced = 0 THEN 1 ELSE 0 END), 0) AS unpriced_calls
    FROM usage_ledger
    WHERE day = ?
    GROUP BY owner, plugin_id
    ORDER BY cost_micros DESC, total_tokens DESC, owner ASC
  `)

  const trendRangeStmt: StatementSync = db.prepare(`
    SELECT
      day,
      COUNT(*) AS calls,
      COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS total_tokens,
      COALESCE(SUM(cost_micros), 0) AS cost_micros,
      MAX(currency) AS currency
    FROM usage_ledger
    WHERE day >= ? AND day <= ?
    GROUP BY day
    ORDER BY day ASC
  `)

  const trendLimitStmt: StatementSync = db.prepare(`
    SELECT
      day,
      COUNT(*) AS calls,
      COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS total_tokens,
      COALESCE(SUM(cost_micros), 0) AS cost_micros,
      MAX(currency) AS currency
    FROM usage_ledger
    WHERE day <= ?
    GROUP BY day
    ORDER BY day DESC
    LIMIT ?
  `)

  return {
    record(entry: AccountingEntryInput): Promise<AccountingEntry> {
      return serialized(async () => {
        assertOpen()
        validateEntryInput(entry)
        const book = await loadPriceBook(options.pricesFile)
        const priceEntry = lookupPrice(book, entry.provider, entry.model)
        const { costMicros, currency, priced } = computeCostMicros(entry.usage, priceEntry, book.currency)
        const id = `acc_${nextId()}`

        insertStmt.run(
          id,
          Math.trunc(entry.tAt),
          entry.day,
          entry.owner,
          entry.pluginId ?? null,
          entry.agentClass,
          entry.provider,
          entry.model,
          entry.usage.inputTokens,
          entry.usage.outputTokens,
          entry.usage.cacheReadTokens,
          entry.usage.cacheWriteTokens,
          costMicros,
          currency,
          priced ? 1 : 0,
          entry.channel ?? null,
          entry.wakeId ?? null,
        )
        hardenSidecars(options.dbPath)

        return {
          id,
          tAt: Math.trunc(entry.tAt),
          day: entry.day,
          owner: entry.owner,
          ...(entry.pluginId === undefined ? {} : { pluginId: entry.pluginId }),
          agentClass: entry.agentClass,
          provider: entry.provider,
          model: entry.model,
          usage: {
            inputTokens: entry.usage.inputTokens,
            outputTokens: entry.usage.outputTokens,
            cacheReadTokens: entry.usage.cacheReadTokens,
            cacheWriteTokens: entry.usage.cacheWriteTokens,
          },
          ...(entry.channel === undefined ? {} : { channel: entry.channel }),
          ...(entry.wakeId === undefined ? {} : { wakeId: entry.wakeId }),
          costMicros,
          currency,
          priced,
        }
      })
    },

    todayUsage(day: string, pluginId?: string): Promise<{ readonly tokens: number; readonly costMicros: number; readonly calls: number }> {
      return serialized(async () => {
        assertOpen()
        const row = (
          pluginId === undefined
            ? todayAllStmt.get(day)
            : todayPluginStmt.get(day, pluginId)
        ) as TodayRow | undefined
        return {
          tokens: Number(row?.tokens ?? 0),
          costMicros: Number(row?.cost_micros ?? 0),
          calls: Number(row?.calls ?? 0),
        }
      })
    },

    summary(summaryOptions: {
      readonly day: string
      readonly days?: number
      readonly sharedQuotaWarning?: boolean
      readonly dailyTokenLimit?: number
      readonly dailyCostMicrosLimit?: number
    }): Promise<AccountingSummary> {
      return serialized(async () => {
        assertOpen()
        const book = await loadPriceBook(options.pricesFile)
        const rawDays = summaryOptions.days
        const days = rawDays !== undefined && Number.isFinite(rawDays)
          ? Math.max(1, Math.floor(rawDays))
          : 7
        const sharedQuotaWarning = summaryOptions.sharedQuotaWarning ?? false

        const todayRow = todayDetailStmt.get(summaryOptions.day) as TodayDetailRow | undefined
        const input = Number(todayRow?.input_tokens ?? 0)
        const output = Number(todayRow?.output_tokens ?? 0)
        const cacheRead = Number(todayRow?.cache_read_tokens ?? 0)
        const cacheWrite = Number(todayRow?.cache_write_tokens ?? 0)
        const todayTokens = input + output + cacheRead + cacheWrite
        const todayCostMicros = Number(todayRow?.cost_micros ?? 0)
        const todayCacheHitRatio = cacheRead / Math.max(1, input + cacheRead + cacheWrite)

        const pluginRows = byPluginStmt.all(summaryOptions.day) as unknown as PluginBreakdownRow[]
        const byPlugin: PluginCostBreakdown[] = pluginRows.map((row) => ({
          owner: row.owner,
          ...(row.plugin_id === null ? {} : { pluginId: row.plugin_id }),
          calls: Number(row.calls),
          inputTokens: Number(row.input_tokens),
          outputTokens: Number(row.output_tokens),
          cacheReadTokens: Number(row.cache_read_tokens),
          cacheWriteTokens: Number(row.cache_write_tokens),
          totalTokens: Number(row.total_tokens),
          costMicros: Number(row.cost_micros),
          currency: row.currency ?? book.currency,
          unpricedCalls: Number(row.unpriced_calls),
        }))

        const startDay = subtractCalendarDays(summaryOptions.day, days - 1)
        const trendRows = startDay !== undefined
          ? (trendRangeStmt.all(startDay, summaryOptions.day) as unknown as DailyTrendRow[])
          : (trendLimitStmt.all(summaryOptions.day, days) as unknown as DailyTrendRow[]).reverse()

        const dailyTrend: DailyCostPoint[] = trendRows.map((row) => ({
          day: row.day,
          calls: Number(row.calls),
          totalTokens: Number(row.total_tokens),
          costMicros: Number(row.cost_micros),
          currency: row.currency ?? book.currency,
        }))

        return {
          day: summaryOptions.day,
          currency: book.currency,
          todayTokens,
          todayCostMicros,
          todayCacheHitRatio,
          ...(summaryOptions.dailyTokenLimit === undefined ? {} : { dailyTokenLimit: summaryOptions.dailyTokenLimit }),
          ...(summaryOptions.dailyCostMicrosLimit === undefined ? {} : { dailyCostMicrosLimit: summaryOptions.dailyCostMicrosLimit }),
          sharedQuotaWarning,
          byPlugin,
          dailyTrend,
        }
      })
    },

    prices(): Promise<ModelPriceBook> {
      return serialized(async () => {
        assertOpen()
        return loadPriceBook(options.pricesFile)
      })
    },

    setPrices(next: ModelPriceBook): Promise<ModelPriceBook> {
      return serialized(async () => {
        assertOpen()
        return savePriceBook(options.pricesFile, next)
      })
    },

    close(): Promise<void> {
      return serialized(async () => {
        if (closed) return
        closed = true
        db.close()
      })
    },
  }
}
