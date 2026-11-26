import type { Variants } from 'motion/react'
import { DUR, EASE, SPRING, STAGGER, type MotionLevel } from './tokens.ts'

export const REDUCED_FADE_DURATION = 0.12
export const REDUCED_TRANSITION_DURATION = 0.15

export type MotionPresetName = 'bloom' | 'fade' | 'dissolve' | 'stamp' | 'brushIn' | 'inkText'

export interface CharStaggerInput {
  readonly index: number
  readonly total: number
}

export function charStaggerDelay(index: number, total: number): number {
  if (index <= 0 || total <= 1) return 0
  const maxIndex = total - 1
  const clampedIndex = Math.min(index, maxIndex)
  const step = Math.min(STAGGER.charStep, STAGGER.charMaxTotal / maxIndex)
  return Math.min(clampedIndex * step, STAGGER.charMaxTotal)
}

export function listStaggerDelay(index: number): number {
  if (index <= 0) return 0
  const clampedIndex = Math.min(Math.floor(index), STAGGER.listMax - 1)
  return clampedIndex * STAGGER.listStep
}

function resolveDelay(custom: unknown): number {
  return typeof custom === 'number' && Number.isFinite(custom) && custom > 0 ? custom : 0
}

function resolveCharDelay(custom: unknown): number {
  if (typeof custom === 'number' && Number.isFinite(custom) && custom > 0) {
    return Math.min(custom, STAGGER.charMaxTotal)
  }
  if (
    typeof custom === 'object' &&
    custom !== null &&
    'index' in custom &&
    'total' in custom &&
    typeof (custom as CharStaggerInput).index === 'number' &&
    typeof (custom as CharStaggerInput).total === 'number'
  ) {
    const input = custom as CharStaggerInput
    return charStaggerDelay(input.index, input.total)
  }
  return 0
}

const reducedFadeTransition = {
  duration: REDUCED_FADE_DURATION,
  ease: EASE.settle,
} as const

export const bloom: Variants = {
  initial: {
    opacity: 0,
    scale: 0.96,
    filter: 'blur(8px)',
  },
  animate: (custom?: unknown) => ({
    opacity: 1,
    scale: 1,
    filter: 'blur(0px)',
    transition: {
      duration: DUR.bloom,
      ease: EASE.inkOut,
      delay: resolveDelay(custom),
    },
    transitionEnd: {
      filter: 'none',
    },
  }),
  exit: {
    opacity: 0,
    scale: 1.04,
    filter: 'blur(10px)',
    transition: {
      duration: DUR.base,
      ease: EASE.inkIn,
    },
  },
}

export const bloomReduced: Variants = {
  initial: {
    opacity: 0,
    filter: 'none',
  },
  animate: {
    opacity: 1,
    filter: 'none',
    transition: reducedFadeTransition,
  },
  exit: {
    opacity: 0,
    filter: 'none',
    transition: reducedFadeTransition,
  },
}

export const fade: Variants = {
  initial: {
    opacity: 0,
  },
  animate: (custom?: unknown) => ({
    opacity: 1,
    transition: {
      duration: DUR.base,
      ease: EASE.settle,
      delay: resolveDelay(custom),
    },
  }),
  exit: {
    opacity: 0,
    transition: {
      duration: DUR.base,
      ease: EASE.settle,
    },
  },
}

export const fadeReduced: Variants = {
  initial: {
    opacity: 0,
  },
  animate: {
    opacity: 1,
    transition: reducedFadeTransition,
  },
  exit: {
    opacity: 0,
    transition: reducedFadeTransition,
  },
}

export const dissolve: Variants = {
  initial: {
    opacity: 1,
    scale: 1,
    filter: 'none',
  },
  animate: {
    opacity: 1,
    scale: 1,
    filter: 'none',
  },
  exit: {
    opacity: 0,
    scale: 1.04,
    filter: 'blur(10px)',
    transition: {
      duration: DUR.base,
      ease: EASE.inkIn,
    },
  },
}

export const dissolveReduced: Variants = {
  initial: {
    opacity: 1,
    filter: 'none',
  },
  animate: {
    opacity: 1,
    filter: 'none',
  },
  exit: {
    opacity: 0,
    filter: 'none',
    transition: reducedFadeTransition,
  },
}

export const stamp: Variants = {
  initial: {
    scale: 1.35,
    rotate: -6,
    opacity: 0,
  },
  animate: {
    scale: 1,
    rotate: -2,
    opacity: 1,
    transition: SPRING.heavy,
  },
  exit: {
    opacity: 0,
    transition: {
      duration: DUR.quick,
      ease: EASE.inkIn,
    },
  },
}

export const stampReduced: Variants = {
  initial: {
    opacity: 0,
  },
  animate: {
    opacity: 1,
    transition: reducedFadeTransition,
  },
  exit: {
    opacity: 0,
    transition: reducedFadeTransition,
  },
}

export const brushIn: Variants = {
  initial: {
    pathLength: 0,
  },
  animate: (custom?: unknown) => ({
    pathLength: 1,
    transition: {
      duration: DUR.brush,
      ease: EASE.brush,
      delay: resolveDelay(custom),
    },
  }),
  exit: {
    opacity: 0,
    transition: {
      duration: DUR.quick,
      ease: EASE.inkIn,
    },
  },
}

export const brushInReduced: Variants = {
  initial: {
    pathLength: 1,
    opacity: 0,
  },
  animate: {
    pathLength: 1,
    opacity: 1,
    transition: reducedFadeTransition,
  },
  exit: {
    opacity: 0,
    transition: reducedFadeTransition,
  },
}

export const inkText: Variants = {
  initial: {
    opacity: 0,
    filter: 'blur(6px)',
    y: 4,
  },
  animate: (custom?: unknown) => ({
    opacity: 1,
    filter: 'blur(0px)',
    y: 0,
    transition: {
      duration: DUR.base,
      ease: EASE.inkOut,
      delay: resolveCharDelay(custom),
    },
    transitionEnd: {
      filter: 'none',
    },
  }),
  exit: {
    opacity: 0,
    filter: 'blur(6px)',
    transition: {
      duration: DUR.quick,
      ease: EASE.inkIn,
    },
  },
}

export const inkTextReduced: Variants = {
  initial: {
    opacity: 0,
    filter: 'none',
    y: 0,
  },
  animate: {
    opacity: 1,
    filter: 'none',
    y: 0,
    transition: reducedFadeTransition,
  },
  exit: {
    opacity: 0,
    filter: 'none',
    transition: reducedFadeTransition,
  },
}

const FULL_PRESETS: Readonly<Record<MotionPresetName, Variants>> = {
  bloom,
  fade,
  dissolve,
  stamp,
  brushIn,
  inkText,
}

const REDUCED_PRESETS: Readonly<Record<MotionPresetName, Variants>> = {
  bloom: bloomReduced,
  fade: fadeReduced,
  dissolve: dissolveReduced,
  stamp: stampReduced,
  brushIn: brushInReduced,
  inkText: inkTextReduced,
}

export function getPreset(name: MotionPresetName, level: MotionLevel): Variants {
  return level === 'reduced' ? REDUCED_PRESETS[name] : FULL_PRESETS[name]
}
