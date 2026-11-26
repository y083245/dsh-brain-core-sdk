import { flushSync } from 'react-dom'
import { inktideStore, type ThemeMode } from '../data/store.ts'
import { EASE } from '../motion/tokens.ts'
import { getMotionLevel } from '../motion/useMotionLevel.ts'

export interface ThemeTransitionOrigin {
  readonly x: number
  readonly y: number
}

interface ViewTransitionLike {
  readonly ready: Promise<void>
}

interface ViewTransitionHost {
  readonly startViewTransition?: (updateCallback: () => void) => ViewTransitionLike
}

const THEME_TRANSITION_DURATION_MS = 700
const THEME_TRANSITION_EASING = `cubic-bezier(${EASE.inkOut.join(', ')})`

function applyThemeUpdate(targetMode?: ThemeMode): void {
  if (targetMode === undefined) {
    inktideStore.cycleThemeMode()
  } else {
    inktideStore.setThemeMode(targetMode)
  }
}

function commitThemeSync(targetMode?: ThemeMode): void {
  let applied = false
  try {
    flushSync(() => {
      applied = true
      applyThemeUpdate(targetMode)
    })
  } catch {
    if (!applied) {
      applyThemeUpdate(targetMode)
    }
  }
}

/**
 * §6.5 主题切换：以按钮中心为圆心，使用 View Transitions API 700ms 圆形扩散新主题。
 * 浏览器不支持或处于减少动效模式时直接切换，由墨潮引擎侧 uThemeMix 完成插值。
 */
export function switchThemeWithTransition(
  origin?: ThemeTransitionOrigin,
  targetMode?: ThemeMode,
): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    applyThemeUpdate(targetMode)
    return
  }

  const doc = document as ViewTransitionHost
  if (getMotionLevel() !== 'full' || typeof doc.startViewTransition !== 'function') {
    applyThemeUpdate(targetMode)
    return
  }

  const vw = window.innerWidth
  const vh = window.innerHeight
  const x = origin !== undefined && Number.isFinite(origin.x) ? origin.x : vw / 2
  const y = origin !== undefined && Number.isFinite(origin.y) ? origin.y : vh / 2
  const maxX = Math.max(x, vw - x)
  const maxY = Math.max(y, vh - y)
  const endRadius = Math.hypot(maxX, maxY)

  try {
    const transition = doc.startViewTransition(() => {
      commitThemeSync(targetMode)
    })

    void transition.ready
      .then(() => {
        if (typeof document.documentElement.animate !== 'function') return
        document.documentElement.animate(
          {
            clipPath: [
              `circle(0px at ${x}px ${y}px)`,
              `circle(${endRadius}px at ${x}px ${y}px)`,
            ],
          },
          {
            duration: THEME_TRANSITION_DURATION_MS,
            easing: THEME_TRANSITION_EASING,
            pseudoElement: '::view-transition-new(root)',
          },
        )
      })
      .catch(() => {
        // View transition may be skipped or superseded by rapid toggles
      })
  } catch {
    applyThemeUpdate(targetMode)
  }
}
