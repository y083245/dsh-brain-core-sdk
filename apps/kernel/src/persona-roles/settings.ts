import { isPlainObject } from './helpers.ts'

export interface GroupBatchSettings {
  messages: number
  minutes: number
}

export interface AppraisalSettings {
  mode: 'model' | 'rules' | 'off'
  timeoutMs: number
  dailyLimit: number
  groupBatch: GroupBatchSettings
  contextMessages: number
}

export interface EmotionSettings {
  coreHalfLifeMin: number
  sceneHalfLifeMin: number
  labelHalfLifeMin: number
  stepClamp: number
  coreWeight: number
  coreShare: number
  coreHourlyBudget: number
  labelCap: number
  labelCapStrong: number
}

export interface GrowthSettings {
  nightlyAt: string
  dailyStep: number
  maxDrift: number
  personOffsetMax: number
  beliefMinEvidence: number
  beliefMinDays: number
  selfBeliefMinPeople: number
  beliefHalfLifeDays: number
  selfBeliefCap: number
  personBeliefCap: number
  weeklyReport: boolean
  reportToDiary: boolean
}

export interface ExpectMinutes {
  private: number
  group: number
}

export interface ExpressSettings {
  toOwnerPerDay: number
  quiet: readonly [number, number]
  expectMinutes: ExpectMinutes
}

export interface Settings {
  enabled: boolean
  inject: boolean
  appraisal: AppraisalSettings
  emotion: EmotionSettings
  growth: GrowthSettings
  express: ExpressSettings
}

/**
 * Default persona engine configuration.
 * Top-level frozen per contract; omits model/baseUrl so selection stays explicit (D21).
 */
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  enabled: true,
  inject: true,
  appraisal: {
    mode: 'model' as const,
    timeoutMs: 20_000,
    dailyLimit: 400,
    groupBatch: { messages: 20, minutes: 5 },
    contextMessages: 6,
  },
  emotion: {
    coreHalfLifeMin: 360,
    sceneHalfLifeMin: 45,
    labelHalfLifeMin: 45,
    stepClamp: 0.12,
    coreWeight: 0.4,
    coreShare: 0.4,
    coreHourlyBudget: 0.5,
    labelCap: 0.6,
    labelCapStrong: 0.8,
  },
  growth: {
    nightlyAt: '03:30',
    dailyStep: 1,
    maxDrift: 15,
    personOffsetMax: 10,
    beliefMinEvidence: 3,
    beliefMinDays: 2,
    selfBeliefMinPeople: 2,
    beliefHalfLifeDays: 45,
    selfBeliefCap: 10,
    personBeliefCap: 8,
    weeklyReport: true,
    reportToDiary: true,
  },
  express: {
    toOwnerPerDay: 2,
    quiet: [0, 8] as const,
    expectMinutes: { private: 30, group: 10 },
  },
})

function cloneDefaults(): Settings {
  const d = DEFAULT_SETTINGS
  return {
    enabled: d.enabled,
    inject: d.inject,
    appraisal: {
      mode: d.appraisal.mode,
      timeoutMs: d.appraisal.timeoutMs,
      dailyLimit: d.appraisal.dailyLimit,
      groupBatch: {
        messages: d.appraisal.groupBatch.messages,
        minutes: d.appraisal.groupBatch.minutes,
      },
      contextMessages: d.appraisal.contextMessages,
    },
    emotion: { ...d.emotion },
    growth: { ...d.growth },
    express: {
      toOwnerPerDay: d.express.toOwnerPerDay,
      quiet: [d.express.quiet[0], d.express.quiet[1]],
      expectMinutes: {
        private: d.express.expectMinutes.private,
        group: d.express.expectMinutes.group,
      },
    },
  }
}

/** Merges up to two nested levels of plain-object overrides onto DEFAULT_SETTINGS without deep cloning on empty input. */
export function mergeSettings(overrides: unknown = {}): Settings {
  const merged = cloneDefaults()
  if (!isPlainObject(overrides)) return merged
  const entries = Object.entries(overrides)
  if (entries.length === 0) return merged

  const root = merged as unknown as Record<string, unknown>
  for (const [topKey, topVal] of entries) {
    const baseSection = root[topKey]
    if (isPlainObject(topVal) && isPlainObject(baseSection)) {
      for (const [subKey, subVal] of Object.entries(topVal)) {
        const baseLeaf = baseSection[subKey]
        if (isPlainObject(subVal) && isPlainObject(baseLeaf)) {
          baseSection[subKey] = { ...baseLeaf, ...subVal }
        } else {
          baseSection[subKey] = subVal
        }
      }
    } else {
      root[topKey] = topVal
    }
  }
  return merged
}

/** Clamps a finite number into [min, max]; non-finite inputs fall back to min. */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

/** Maps a 0–100 trait score into three behavioral bands. */
export function band(score: unknown): '高' | '中' | '低' {
  const n = typeof score === 'number' ? score : Number(score)
  const effective = Number.isFinite(n) && score !== null && score !== '' ? n : 50
  if (effective >= 60) return '高'
  if (effective <= 40) return '低'
  return '中'
}

/** Exponential half-life retention ratio after `elapsedMs` milliseconds. */
export function halfLifeFactor(elapsedMs: number, halfLifeMin: number): number {
  if (!(elapsedMs > 0) || !(halfLifeMin > 0)) return 1
  return 0.5 ** (elapsedMs / (halfLifeMin * 60_000))
}

/** Formats local calendar date `YYYY-MM-DD` for a millisecond timestamp. */
export function dayOf(ms: number): string {
  const date = new Date(ms)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Checks whether the local hour of `ms` falls within `settings.express.quiet` (supports wrap-around windows). */
export function inQuiet(ms: number, settings: Settings): boolean {
  const [startHour, endHour] = settings.express.quiet
  const hour = new Date(ms).getHours()
  if (startHour <= endHour) return hour >= startHour && hour < endHour
  return hour >= startHour || hour < endHour
}
