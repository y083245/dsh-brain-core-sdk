import type { ErrorCode } from '@brain-core/sdk'
import { apiFetch } from '../../shell/api-fetch.ts'

export interface ModelPriceEntry {
  readonly inputPerMillion: number
  readonly outputPerMillion: number
  readonly cacheReadPerMillion: number
  readonly cacheWritePerMillion: number
}

export interface ModelPriceBook {
  readonly version: 1
  readonly currency: string
  readonly models: Readonly<Record<string, ModelPriceEntry>>
}

export interface PluginCostBreakdown {
  readonly owner: string
  readonly pluginId?: string
  readonly calls: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly totalTokens: number
  readonly costMicros: number
  readonly currency: string
  readonly unpricedCalls: number
}

export interface DailyCostPoint {
  readonly day: string
  readonly calls: number
  readonly totalTokens: number
  readonly costMicros: number
  readonly currency: string
}

export interface AccountingSummary {
  readonly day: string
  readonly currency: string
  readonly todayTokens: number
  readonly todayCostMicros: number
  readonly todayCacheHitRatio: number
  readonly dailyTokenLimit?: number
  readonly dailyCostMicrosLimit?: number
  readonly sharedQuotaWarning: boolean
  readonly byPlugin: readonly PluginCostBreakdown[]
  readonly dailyTrend: readonly DailyCostPoint[]
}

export interface PluginAccountingLimit {
  readonly dailyTokenLimit?: number
  readonly dailyCallsLimit?: number
  readonly maxOutputTokens?: number
}

export interface AccountingBudgetConfig {
  readonly dailyTokenLimit?: number
  readonly dailyCostMicrosLimit?: number
  readonly pluginDailyTokenLimit?: number
  readonly pluginLimits?: Readonly<Record<string, PluginAccountingLimit>>
}

export interface AccountingPageApi {
  getSummary(days?: number): Promise<AccountingSummary>
  getPrices(): Promise<ModelPriceBook>
  savePrices(book: ModelPriceBook): Promise<ModelPriceBook>
  saveBudget(budget: AccountingBudgetConfig): Promise<AccountingBudgetConfig>
}

export class AccountingApiError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly requestId?: string

  constructor(code: ErrorCode, status: number, message: string, requestId?: string) {
    super(`${code}: ${message}`)
    this.name = 'AccountingApiError'
    this.code = code
    this.status = status
    if (requestId !== undefined) this.requestId = requestId
  }
}

export function createHttpAccountingPageApi(
  baseUrl: string,
  token: string,
  fetchImpl?: typeof globalThis.fetch,
): AccountingPageApi {
  const base = baseUrl.replace(/\/+$/, '')

  return {
    async getSummary(days?: number): Promise<AccountingSummary> {
      const query = days === undefined ? '' : `?days=${encodeURIComponent(String(days))}`
      const result = await apiFetch<AccountingSummary>(`${base}/api/v1/console/accounting/summary${query}`, {
        token,
        ...(fetchImpl === undefined ? {} : { fetchImpl }),
      })
      if (!result.ok) {
        throw new AccountingApiError(result.code, result.status, result.message, result.requestId)
      }
      return result.data
    },

    async getPrices(): Promise<ModelPriceBook> {
      const result = await apiFetch<ModelPriceBook>(`${base}/api/v1/console/accounting/prices`, {
        token,
        ...(fetchImpl === undefined ? {} : { fetchImpl }),
      })
      if (!result.ok) {
        throw new AccountingApiError(result.code, result.status, result.message, result.requestId)
      }
      return result.data
    },

    async savePrices(book: ModelPriceBook): Promise<ModelPriceBook> {
      const result = await apiFetch<ModelPriceBook>(`${base}/api/v1/console/accounting/prices`, {
        token,
        method: 'PUT',
        body: book,
        ...(fetchImpl === undefined ? {} : { fetchImpl }),
      })
      if (!result.ok) {
        throw new AccountingApiError(result.code, result.status, result.message, result.requestId)
      }
      return result.data
    },

    async saveBudget(budget: AccountingBudgetConfig): Promise<AccountingBudgetConfig> {
      const result = await apiFetch<AccountingBudgetConfig>(`${base}/api/v1/console/accounting/budget`, {
        token,
        method: 'PUT',
        body: budget,
        ...(fetchImpl === undefined ? {} : { fetchImpl }),
      })
      if (!result.ok) {
        throw new AccountingApiError(result.code, result.status, result.message, result.requestId)
      }
      return result.data
    },
  }
}
