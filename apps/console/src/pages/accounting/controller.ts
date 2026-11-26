import type {
  AccountingBudgetConfig,
  AccountingPageApi,
  AccountingSummary,
  ModelPriceBook,
} from './types.ts'

export type AccountingPeriodDays = 7 | 14 | 30

export interface AccountingPageState {
  readonly summary: AccountingSummary | null
  readonly prices: ModelPriceBook | null
  readonly budget: AccountingBudgetConfig | null
  readonly days: AccountingPeriodDays
  readonly loading: boolean
  readonly savingPrices: boolean
  readonly savingBudget: boolean
  readonly errorMessage: string | null
  readonly noticeMessage: string | null
}

export interface AccountingPageController {
  state(): AccountingPageState
  load(): Promise<void>
  refresh(): Promise<void>
  setDays(days: AccountingPeriodDays): Promise<void>
  savePrices(book: ModelPriceBook): Promise<boolean>
  saveBudget(budget: AccountingBudgetConfig): Promise<boolean>
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : String(error)
}

function normalizeDays(days: number): AccountingPeriodDays {
  if (days === 14) return 14
  if (days === 30) return 30
  return 7
}

function deriveBudgetFromSummary(summary: AccountingSummary, current: AccountingBudgetConfig | null): AccountingBudgetConfig {
  return {
    ...(summary.dailyTokenLimit === undefined ? {} : { dailyTokenLimit: summary.dailyTokenLimit }),
    ...(summary.dailyCostMicrosLimit === undefined ? {} : { dailyCostMicrosLimit: summary.dailyCostMicrosLimit }),
    ...(current?.pluginDailyTokenLimit === undefined ? {} : { pluginDailyTokenLimit: current.pluginDailyTokenLimit }),
    ...(current?.pluginLimits === undefined ? {} : { pluginLimits: current.pluginLimits }),
  }
}

export function createAccountingPageController(api: AccountingPageApi): AccountingPageController {
  let summary: AccountingSummary | null = null
  let prices: ModelPriceBook | null = null
  let budget: AccountingBudgetConfig | null = null
  let days: AccountingPeriodDays = 7
  let loading = false
  let savingPrices = false
  let savingBudget = false
  let errorMessage: string | null = null
  let noticeMessage: string | null = null

  async function fetchAll(): Promise<void> {
    loading = true
    try {
      const [nextSummary, nextPrices] = await Promise.all([
        api.getSummary(days),
        api.getPrices(),
      ])
      summary = nextSummary
      prices = nextPrices
      budget = deriveBudgetFromSummary(nextSummary, budget)
      errorMessage = null
    } catch (error) {
      errorMessage = errorText(error)
    } finally {
      loading = false
    }
  }

  return {
    state(): AccountingPageState {
      return {
        summary,
        prices,
        budget,
        days,
        loading,
        savingPrices,
        savingBudget,
        errorMessage,
        noticeMessage,
      }
    },

    async load(): Promise<void> {
      noticeMessage = null
      await fetchAll()
    },

    async refresh(): Promise<void> {
      noticeMessage = null
      await fetchAll()
    },

    async setDays(nextDays: AccountingPeriodDays): Promise<void> {
      days = normalizeDays(nextDays)
      noticeMessage = null
      loading = true
      try {
        const [nextSummary, nextPrices] = await Promise.all([
          api.getSummary(days),
          prices === null ? api.getPrices() : Promise.resolve(prices),
        ])
        summary = nextSummary
        prices = nextPrices
        budget = deriveBudgetFromSummary(nextSummary, budget)
        errorMessage = null
      } catch (error) {
        errorMessage = errorText(error)
      } finally {
        loading = false
      }
    },

    async savePrices(book: ModelPriceBook): Promise<boolean> {
      savingPrices = true
      noticeMessage = null
      try {
        const saved = await api.savePrices(book)
        prices = saved
        summary = await api.getSummary(days)
        budget = deriveBudgetFromSummary(summary, budget)
        errorMessage = null
        noticeMessage = '价格配置已保存'
        return true
      } catch (error) {
        errorMessage = errorText(error)
        return false
      } finally {
        savingPrices = false
      }
    },

    async saveBudget(nextBudget: AccountingBudgetConfig): Promise<boolean> {
      savingBudget = true
      noticeMessage = null
      try {
        const saved = await api.saveBudget(nextBudget)
        budget = saved
        summary = await api.getSummary(days)
        errorMessage = null
        noticeMessage = '日限额预算已保存'
        return true
      } catch (error) {
        errorMessage = errorText(error)
        return false
      } finally {
        savingBudget = false
      }
    },
  }
}
