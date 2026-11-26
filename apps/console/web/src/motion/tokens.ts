export const DUR = {
  instant: 0.09,
  quick: 0.16,
  base: 0.26,
  bloom: 0.42,
  flood: 0.38,
  ebb: 0.52,
  stamp: 0.34,
  brush: 0.64,
  dissolve: 0.9,
} as const // 秒，Motion 用秒

export const EASE = {
  inkOut: [0.16, 1, 0.3, 1],
  inkIn: [0.7, 0, 0.84, 0],
  brush: [0.65, 0, 0.35, 1],
  settle: [0.33, 1, 0.68, 1],
} as const

export const SPRING = {
  press: { type: 'spring', stiffness: 700, damping: 32, mass: 0.6 },
  snappy: { type: 'spring', stiffness: 420, damping: 30, mass: 0.8 },
  float: { type: 'spring', stiffness: 170, damping: 22, mass: 1.0 },
  heavy: { type: 'spring', stiffness: 120, damping: 20, mass: 1.6 },
  magnet: { type: 'spring', stiffness: 260, damping: 18, mass: 0.5 },
} as const

export const STAGGER = { listStep: 0.028, listMax: 12, charStep: 0.014, charMaxTotal: 0.6 } as const

export const HOLD_TO_STAMP_MS = 900
export const COVENANT_LOCK_MS = 1200 // 契约打开后多久才能按「准」
export const FLOOD_COVER_START_MS = 300
export const FLOOD_COVER_END_MS = 600

export const INK = {
  dissipationDye: 0.985,
  dissipationDyeCalm: 0.955,
  dissipationVelocity: 0.97,
  idleAfterMs: 30_000,
  idleWispEveryMs: 6_000,
  idleWispAmount: 0.08,
  pointerMinSpeed: 2, // px/帧，低于它只加力不加墨
  pointerAmountDivisor: 40,
  pointerAmountMax: 0.6,
  degradeFrameMs: 18,
  upgradeFrameMs: 11,
  upgradeAfterMs: 20_000,
  sampleEveryMs: 2_000,
} as const

export const QUALITY = {
  high: { sim: 192, dye: 1024, pressureIters: 24, curl: 28 },
  medium: { sim: 128, dye: 768, pressureIters: 16, curl: 22 },
  low: { sim: 96, dye: 512, pressureIters: 10, curl: 16 },
} as const

export type QualityTier = keyof typeof QUALITY | 'static'
export type MotionLevel = 'full' | 'reduced'
