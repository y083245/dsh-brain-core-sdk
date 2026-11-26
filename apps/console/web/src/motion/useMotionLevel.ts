import { useSyncExternalStore } from 'react'
import { inktideStore, useInktideStore } from '../data/store.ts'
import type { MotionLevel } from './tokens.ts'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

function getOsPrefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }
  return window.matchMedia(REDUCED_MOTION_QUERY).matches
}

function getServerReducedMotion(): boolean {
  return false
}

function subscribeOsReducedMotion(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {}
  }
  const mql = window.matchMedia(REDUCED_MOTION_QUERY)
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', onChange)
    return () => {
      mql.removeEventListener('change', onChange)
    }
  }
  if (typeof mql.addListener === 'function') {
    mql.addListener(onChange)
    return () => {
      mql.removeListener(onChange)
    }
  }
  return () => {}
}

export function getMotionLevel(): MotionLevel {
  const preference = inktideStore.getSnapshot().motionPreference
  return preference === 'reduced' || getOsPrefersReducedMotion() ? 'reduced' : 'full'
}

export function useMotionLevel(): MotionLevel {
  const preference = useInktideStore((s) => s.motionPreference)
  const osReduced = useSyncExternalStore(
    subscribeOsReducedMotion,
    getOsPrefersReducedMotion,
    getServerReducedMotion,
  )
  return preference === 'reduced' || osReduced ? 'reduced' : 'full'
}
