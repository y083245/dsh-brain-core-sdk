import { BrainError } from '@brain-core/sdk'
import type {
  Clock,
  ModelAccountingStore,
  PluginLlmExecutor,
  RuntimeSettings,
  TokenUsage,
} from '../contracts/index.ts'
import type { Logger } from '../log/index.ts'

export interface DetailedLlmResult {
  readonly text: string
  readonly tokens: number
  readonly usage: TokenUsage
  readonly provider: string
  readonly model: string
}

export interface DetailedLlmClient {
  completeDetailed(request: {
    readonly system: string
    readonly user: string
    readonly maxOutputTokens: number
  }): Promise<DetailedLlmResult>
}

const MAX_PLUGIN_OUTPUT_TOKENS = 16384
const dayFormatters = new Map<string, Intl.DateTimeFormat>()

function dayFormatterFor(timezone: string | undefined): Intl.DateTimeFormat {
  const key = timezone?.trim() ?? ''
  const cached = dayFormatters.get(key)
  if (cached !== undefined) return cached

  const baseOptions: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-CA', key === '' ? baseOptions : { ...baseOptions, timeZone: key })
  } catch {
    formatter = new Intl.DateTimeFormat('en-CA', baseOptions)
  }
  dayFormatters.set(key, formatter)
  return formatter
}

export function formatDayInTimezone(nowMs: number, timezone: string | undefined): string {
  const formatter = dayFormatterFor(timezone)
  const parts = formatter.formatToParts(new Date(nowMs))
  let year = ''
  let month = ''
  let day = ''
  for (const part of parts) {
    if (part.type === 'year') year = part.value
    else if (part.type === 'month') month = part.value
    else if (part.type === 'day') day = part.value
  }
  return `${year}-${month}-${day}`
}

function isExceeded(used: number, limit: number | undefined): boolean {
  return limit !== undefined && Number.isFinite(limit) && used >= limit
}

export function createPluginLlmExecutor(deps: {
  readonly llm: DetailedLlmClient
  readonly accounting: ModelAccountingStore
  readonly settings: () => Promise<RuntimeSettings>
  readonly clock: Clock
  readonly log: Logger
}): PluginLlmExecutor {
  return {
    async complete(pluginId, request): Promise<{ readonly text: string; readonly tokens: number }> {
      if (typeof pluginId !== 'string' || pluginId.trim() === '') {
        throw new BrainError('INVALID_ARGUMENT', 'pluginId must be a non-empty string')
      }
      if (request === null || typeof request !== 'object') {
        throw new BrainError('INVALID_ARGUMENT', 'llm request must be an object')
      }
      if (typeof request.system !== 'string' || typeof request.user !== 'string') {
        throw new BrainError('INVALID_ARGUMENT', 'system and user must be strings')
      }
      if (
        typeof request.maxOutputTokens !== 'number'
        || !Number.isInteger(request.maxOutputTokens)
        || request.maxOutputTokens < 1
        || request.maxOutputTokens > MAX_PLUGIN_OUTPUT_TOKENS
      ) {
        throw new BrainError('INVALID_ARGUMENT', `maxOutputTokens must be an integer between 1 and ${String(MAX_PLUGIN_OUTPUT_TOKENS)}`)
      }

      const settings = await deps.settings()
      const day = formatDayInTimezone(deps.clock.now(), settings.timezone)
      const acc = settings.accounting
      const pluginLimits = acc?.pluginLimits
      const pluginCfg = pluginLimits !== undefined && Object.hasOwn(pluginLimits, pluginId)
        ? pluginLimits[pluginId]
        : undefined

      const pluginMaxOutput = pluginCfg?.maxOutputTokens
      const effectiveMaxOutputTokens =
        pluginMaxOutput !== undefined && Number.isFinite(pluginMaxOutput) && pluginMaxOutput >= 1
          ? Math.min(request.maxOutputTokens, Math.floor(pluginMaxOutput))
          : request.maxOutputTokens

      const [globalToday, pluginToday] = await Promise.all([
        deps.accounting.todayUsage(day),
        deps.accounting.todayUsage(day, pluginId),
      ])

      const pluginTokenLimit = pluginCfg?.dailyTokenLimit ?? acc?.pluginDailyTokenLimit
      const rateLimited =
        isExceeded(globalToday.tokens, acc?.dailyTokenLimit)
        || isExceeded(globalToday.costMicros, acc?.dailyCostMicrosLimit)
        || isExceeded(pluginToday.tokens, pluginTokenLimit)
        || isExceeded(pluginToday.calls, pluginCfg?.dailyCallsLimit)

      if (rateLimited) {
        deps.log.warn('plugin.llm.rate_limited', { plugin: pluginId, code: 'RATE_LIMITED' })
        throw new BrainError('RATE_LIMITED', '今日模型调用已达限额')
      }

      let result: DetailedLlmResult
      try {
        result = await deps.llm.completeDetailed({
          system: request.system,
          user: request.user,
          maxOutputTokens: effectiveMaxOutputTokens,
        })
      } catch (error) {
        const code = error instanceof BrainError ? error.code : 'UNAVAILABLE'
        deps.log.warn('plugin.llm.failed', { plugin: pluginId, code })
        throw error
      }

      await deps.accounting.record({
        tAt: deps.clock.now(),
        day,
        owner: `plugin:${pluginId}`,
        pluginId,
        agentClass: 'activity',
        provider: result.provider,
        model: result.model,
        usage: result.usage,
      })

      deps.log.info('plugin.llm.completed', { plugin: pluginId, count: result.tokens })
      return { text: result.text, tokens: result.tokens }
    },
  }
}
