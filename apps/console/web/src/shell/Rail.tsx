import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { ConsolePageItem } from '../api/types.ts'
import type { EnsoState } from '../ink/engine.ts'
import { getPreset } from '../motion/presets.ts'
import { SPRING } from '../motion/tokens.ts'
import { useMotionLevel } from '../motion/useMotionLevel.ts'
import { PluginSeal } from '../plugins/PluginSeal.tsx'
import { Enso } from '../ui/Enso.tsx'
import { MagneticButton } from '../ui/MagneticButton.tsx'
import type { NavigationOrigin } from './PageTransition.tsx'
import {
  STATIONS,
  StationBrushIcon,
  type StationDef,
} from './routes.ts'

export interface RailProps {
  readonly activeRoute: string
  readonly roleCardName?: string | null
  readonly ensoState?: EnsoState
  readonly pluginPages?: readonly ConsolePageItem[]
  readonly onNavigate: (route: string, origin?: NavigationOrigin) => void
  readonly compact?: boolean
  readonly className?: string
  readonly style?: CSSProperties
}

const PRIMARY_STATIONS: readonly StationDef[] = STATIONS.filter(
  (station) => station.id !== 'settings',
)
const SETTINGS_STATION: StationDef = STATIONS.find(
  (station) => station.id === 'settings',
)!

function getElementCenter(el: HTMLElement | null): NavigationOrigin | undefined {
  if (el === null) return undefined
  const rect = el.getBoundingClientRect()
  return {
    x: rect.left + rect.width * 0.5,
    y: rect.top + rect.height * 0.5,
  }
}

function useIsNarrowCompact(compact: boolean): boolean {
  const [narrow, setNarrow] = useState<boolean>(() => {
    if (!compact || typeof window === 'undefined') return false
    return window.innerWidth < 520
  })

  useEffect(() => {
    if (!compact || typeof window === 'undefined') {
      setNarrow(false)
      return
    }
    const update = (): void => {
      setNarrow(window.innerWidth < 520)
    }
    update()
    const mql =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(max-width: 519px)')
        : null
    mql?.addEventListener('change', update)
    window.addEventListener('resize', update, { passive: true })
    return () => {
      mql?.removeEventListener('change', update)
      window.removeEventListener('resize', update)
    }
  }, [compact])

  return compact && narrow
}

interface RailStationButtonProps {
  readonly station: StationDef
  readonly isActive: boolean
  readonly compact: boolean
  readonly narrow?: boolean
  readonly onNavigate: (route: string, origin?: NavigationOrigin) => void
}

function RailStationButton({
  station,
  isActive,
  compact,
  narrow = false,
  onNavigate,
}: RailStationButtonProps) {
  const motionLevel = useMotionLevel()
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const [hovered, setHovered] = useState(false)
  const [drawKey, setDrawKey] = useState(0)
  const prevActiveRef = useRef(isActive)

  useEffect(() => {
    if (isActive && !prevActiveRef.current) {
      setDrawKey((prev) => prev + 1)
    }
    prevActiveRef.current = isActive
  }, [isActive])

  const bloomVariants = getPreset('bloom', motionLevel)

  const handleMouseEnter = (): void => {
    setHovered(true)
    setDrawKey((prev) => prev + 1)
  }

  const handleMouseLeave = (): void => {
    setHovered(false)
  }

  const handleClick = (event: MouseEvent<HTMLButtonElement>): void => {
    const origin =
      getElementCenter(buttonRef.current) ?? {
        x: event.clientX,
        y: event.clientY,
      }
    onNavigate(station.id, origin)
  }

  const buttonWidth = compact ? (narrow ? 41 : 48) : 56
  const buttonHeight = compact ? 48 : 56
  const indicatorWidth = narrow ? 24 : 28

  return (
    <MagneticButton disabled={compact} radius={44} maxOffset={5} style={{ flexShrink: 0 }}>
      <motion.button
        ref={buttonRef}
        type="button"
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        whileTap={motionLevel === 'full' ? { scale: 0.92 } : undefined}
        transition={SPRING.press}
        aria-label={`${station.glyph} · ${station.title}`}
        aria-current={isActive ? 'page' : undefined}
        title={`${station.title} · ${station.label}`}
        data-rail-station={station.id}
        data-station={station.id}
        data-active={isActive ? 'true' : 'false'}
        style={{
          position: 'relative',
          width: `${String(buttonWidth)}px`,
          height: `${String(buttonHeight)}px`,
          padding: 0,
          border: 0,
          borderRadius: 'var(--radius)',
          background: 'transparent',
          color: isActive || hovered ? 'var(--text-1)' : 'var(--text-2)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: narrow ? '3px' : '4px',
          cursor: 'pointer',
          flexShrink: 0,
          userSelect: 'none',
        }}
      >
        {isActive && (
          <>
            <motion.span
              aria-hidden="true"
              layoutId={motionLevel === 'full' ? 'rail-active-trail' : undefined}
              transition={SPRING.float}
              style={
                compact
                  ? {
                      position: 'absolute',
                      top: 0,
                      left: '50%',
                      marginLeft: `-${String(indicatorWidth / 2)}px`,
                      width: `${String(indicatorWidth)}px`,
                      height: '3px',
                      borderRadius: '1px',
                      background: 'var(--zhusha)',
                      opacity: 0.35,
                      pointerEvents: 'none',
                    }
                  : {
                      position: 'absolute',
                      left: '-8px',
                      top: '50%',
                      marginTop: '-14px',
                      width: '3px',
                      height: '28px',
                      borderRadius: '1px',
                      background: 'var(--zhusha)',
                      opacity: 0.35,
                      pointerEvents: 'none',
                    }
              }
            />
            <motion.span
              aria-hidden="true"
              layoutId={motionLevel === 'full' ? 'rail-active' : undefined}
              transition={SPRING.snappy}
              style={
                compact
                  ? {
                      position: 'absolute',
                      top: 0,
                      left: '50%',
                      marginLeft: `-${String(indicatorWidth / 2)}px`,
                      width: `${String(indicatorWidth)}px`,
                      height: '3px',
                      borderRadius: '1px',
                      background: 'var(--zhusha)',
                      pointerEvents: 'none',
                    }
                  : {
                      position: 'absolute',
                      left: '-8px',
                      top: '50%',
                      marginTop: '-14px',
                      width: '3px',
                      height: '28px',
                      borderRadius: '1px',
                      background: 'var(--zhusha)',
                      pointerEvents: 'none',
                    }
              }
            />
          </>
        )}

        <AnimatePresence>
          {hovered && (
            <motion.span
              key="hover-mist"
              aria-hidden="true"
              variants={bloomVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              style={{
                position: 'absolute',
                width: '40px',
                height: '40px',
                borderRadius: '50%',
                background:
                  'radial-gradient(circle, var(--hair-strong) 0%, transparent 72%)',
                pointerEvents: 'none',
              }}
            />
          )}
        </AnimatePresence>

        <span
          style={{
            position: 'relative',
            zIndex: 1,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            // Hover redraws SVG paths, so they must not become the click target.
            pointerEvents: 'none',
          }}
        >
          <StationBrushIcon
            stationId={station.id}
            size={compact ? (narrow ? 19 : 20) : 24}
            drawKey={drawKey}
          />
        </span>

        <span
          style={{
            position: 'relative',
            zIndex: 1,
            fontSize: 'var(--fs-small)',
            lineHeight: 1,
            fontWeight: isActive ? 600 : 400,
            pointerEvents: 'none',
          }}
        >
          {station.glyph}
        </span>
      </motion.button>
    </MagneticButton>
  )
}

interface RailPluginPageButtonProps {
  readonly page: ConsolePageItem
  readonly isActive: boolean
  readonly compact: boolean
  readonly narrow?: boolean
  readonly onNavigate: (route: string, origin?: NavigationOrigin) => void
}

function RailPluginPageButton({
  page,
  isActive,
  compact,
  narrow = false,
  onNavigate,
}: RailPluginPageButtonProps) {
  const motionLevel = useMotionLevel()
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const [hovered, setHovered] = useState(false)
  const bloomVariants = getPreset('bloom', motionLevel)
  const route = `page/${encodeURIComponent(page.pluginId)}/${encodeURIComponent(page.id)}`
  const shortLabel = Array.from(page.title.trim()).slice(0, 2).join('') || page.id.slice(0, 2)
  const buttonWidth = compact ? (narrow ? 41 : 48) : 56
  const buttonHeight = compact ? 48 : 56
  const indicatorWidth = narrow ? 24 : 28

  const handleClick = (event: MouseEvent<HTMLButtonElement>): void => {
    const origin =
      getElementCenter(buttonRef.current) ?? {
        x: event.clientX,
        y: event.clientY,
      }
    onNavigate(route, origin)
  }

  return (
    <MagneticButton disabled={compact} radius={44} maxOffset={5} style={{ flexShrink: 0 }}>
      <motion.button
        ref={buttonRef}
        type="button"
        onClick={handleClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        whileTap={motionLevel === 'full' ? { scale: 0.92 } : undefined}
        transition={SPRING.press}
        aria-label={`插件页面：${page.title}（${page.pluginId}）`}
        aria-current={isActive ? 'page' : undefined}
        title={`${page.title} · ${page.pluginId}`}
        data-rail-plugin-page={`${page.pluginId}/${page.id}`}
        data-active={isActive ? 'true' : 'false'}
        style={{
          position: 'relative',
          width: `${String(buttonWidth)}px`,
          height: `${String(buttonHeight)}px`,
          padding: 0,
          border: 0,
          borderRadius: 'var(--radius)',
          background: 'transparent',
          color: isActive || hovered ? 'var(--text-1)' : 'var(--text-2)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: narrow ? '3px' : '4px',
          cursor: 'pointer',
          flexShrink: 0,
          userSelect: 'none',
        }}
      >
        {isActive && (
          <>
            <motion.span
              aria-hidden="true"
              layoutId={motionLevel === 'full' ? 'rail-active-trail' : undefined}
              transition={SPRING.float}
              style={
                compact
                  ? {
                      position: 'absolute',
                      top: 0,
                      left: '50%',
                      marginLeft: `-${String(indicatorWidth / 2)}px`,
                      width: `${String(indicatorWidth)}px`,
                      height: '3px',
                      borderRadius: '1px',
                      background: 'var(--zhusha)',
                      opacity: 0.35,
                      pointerEvents: 'none',
                    }
                  : {
                      position: 'absolute',
                      left: '-8px',
                      top: '50%',
                      marginTop: '-14px',
                      width: '3px',
                      height: '28px',
                      borderRadius: '1px',
                      background: 'var(--zhusha)',
                      opacity: 0.35,
                      pointerEvents: 'none',
                    }
              }
            />
            <motion.span
              aria-hidden="true"
              layoutId={motionLevel === 'full' ? 'rail-active' : undefined}
              transition={SPRING.snappy}
              style={
                compact
                  ? {
                      position: 'absolute',
                      top: 0,
                      left: '50%',
                      marginLeft: `-${String(indicatorWidth / 2)}px`,
                      width: `${String(indicatorWidth)}px`,
                      height: '3px',
                      borderRadius: '1px',
                      background: 'var(--zhusha)',
                      pointerEvents: 'none',
                    }
                  : {
                      position: 'absolute',
                      left: '-8px',
                      top: '50%',
                      marginTop: '-14px',
                      width: '3px',
                      height: '28px',
                      borderRadius: '1px',
                      background: 'var(--zhusha)',
                      pointerEvents: 'none',
                    }
              }
            />
          </>
        )}

        <AnimatePresence>
          {hovered && (
            <motion.span
              key="plugin-hover-mist"
              aria-hidden="true"
              variants={bloomVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              style={{
                position: 'absolute',
                width: '40px',
                height: '40px',
                borderRadius: '50%',
                background:
                  'radial-gradient(circle, var(--hair-strong) 0%, transparent 72%)',
                pointerEvents: 'none',
              }}
            />
          )}
        </AnimatePresence>

        <span style={{ position: 'relative', zIndex: 1, pointerEvents: 'none' }}>
          <PluginSeal
            pluginId={page.pluginId}
            size={narrow ? 19 : 20}
            variant="auto"
            title={`${page.pluginId} · ${page.title}`}
          />
        </span>

        <span
          style={{
            position: 'relative',
            zIndex: 1,
            fontSize: 'var(--fs-label)',
            lineHeight: 1,
            maxWidth: narrow ? '38px' : '48px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
          }}
        >
          {shortLabel}
        </span>
      </motion.button>
    </MagneticButton>
  )
}

export function Rail({
  activeRoute,
  roleCardName,
  ensoState = 'idle',
  pluginPages = [],
  onNavigate,
  compact = false,
  className,
  style,
}: RailProps) {
  const motionLevel = useMotionLevel()
  const isNarrowCompact = useIsNarrowCompact(compact)
  const railRef = useRef<HTMLElement | null>(null)
  const brandRef = useRef<HTMLButtonElement | null>(null)
  const ensoSlotRef = useRef<HTMLSpanElement | null>(null)
  const compactScrollRef = useRef<HTMLDivElement | null>(null)
  const trimmedName = (roleCardName ?? '').trim()
  const nameChars = Array.from(trimmedName)
  const showVerticalName = !compact && nameChars.length > 0 && nameChars.length <= 2
  const brandTitle = trimmedName !== '' ? trimmedName : '墨潮'
  const [ensoCenter, setEnsoCenter] = useState<{ readonly x: number; readonly y: number }>(
    () => (compact ? { x: 26, y: 28 } : { x: 36, y: 38 }),
  )

  useEffect(() => {
    if (!compact) return
    const scrollEl = compactScrollRef.current
    if (!scrollEl) return
    const activeEl = scrollEl.querySelector<HTMLElement>('[data-active="true"]')
    if (activeEl && typeof activeEl.scrollIntoView === 'function') {
      activeEl.scrollIntoView({
        block: 'nearest',
        inline: 'nearest',
        behavior: motionLevel === 'full' ? 'smooth' : 'instant',
      })
    }
  }, [activeRoute, compact, motionLevel, pluginPages.length])

  useLayoutEffect(() => {
    const railEl = railRef.current
    const ensoEl = ensoSlotRef.current
    if (!railEl || !ensoEl) return

    const measure = (): void => {
      const railRect = railEl.getBoundingClientRect()
      const ensoRect = ensoEl.getBoundingClientRect()
      if (ensoRect.width <= 0 || ensoRect.height <= 0) return
      const x = Number((ensoRect.left - railRect.left + ensoRect.width * 0.5).toFixed(2))
      const y = Number((ensoRect.top - railRect.top + ensoRect.height * 0.5).toFixed(2))
      setEnsoCenter((prev) =>
        Math.abs(prev.x - x) < 0.25 && Math.abs(prev.y - y) < 0.25 ? prev : { x, y },
      )
    }

    measure()

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(railEl)
    ro?.observe(ensoEl)

    const scrollEl = compactScrollRef.current
    scrollEl?.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure, { passive: true })

    return () => {
      ro?.disconnect()
      scrollEl?.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
    }
  }, [compact, isNarrowCompact, pluginPages.length, showVerticalName, trimmedName])

  const maskRadiusPx = compact ? (isNarrowCompact ? 15 : 18) : 22
  const ensoWellMask = `radial-gradient(circle ${maskRadiusPx}px at ${ensoCenter.x}px ${ensoCenter.y}px, transparent 100%, var(--ink-void) 100%)`
  const paperLayerStyle: CSSProperties = {
    position: 'absolute',
    inset: 0,
    zIndex: 0,
    pointerEvents: 'none',
    borderRadius: 0,
    boxShadow: 'none',
    background: 'var(--plate)',
    maskImage: ensoWellMask,
    WebkitMaskImage: ensoWellMask,
  }

  const handleBrandClick = (event: MouseEvent<HTMLButtonElement>): void => {
    const origin =
      getElementCenter(brandRef.current) ?? {
        x: event.clientX,
        y: event.clientY,
      }
    onNavigate('court', origin)
  }

  if (compact) {
    return (
      <nav
        ref={railRef}
        aria-label="主导航"
        data-shell-rail="compact"
        className={className}
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 'var(--statusbar-h)',
          height: '56px',
          zIndex: 30,
          isolation: 'isolate',
          background: 'transparent',
          borderRadius: 0,
          boxShadow: 'none',
          borderTop: '1px solid var(--hair)',
          overflow: 'hidden',
          ...style,
        }}
      >
        <div aria-hidden="true" className="plate" data-rail-paper="true" style={paperLayerStyle} />
        <div
          ref={compactScrollRef}
          style={{
            position: 'relative',
            zIndex: 1,
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent:
              isNarrowCompact && pluginPages.length === 0 ? 'space-between' : 'flex-start',
            gap: isNarrowCompact ? '2px' : 'var(--sp-1)',
            padding: isNarrowCompact ? '0 var(--sp-1)' : '0 var(--sp-2)',
            overflowX: 'auto',
            overflowY: 'hidden',
          }}
        >
          <button
            ref={brandRef}
            type="button"
            onClick={handleBrandClick}
            title={brandTitle}
            aria-label={`返回总览 · ${brandTitle}`}
            style={{
              border: 0,
              background: 'transparent',
              width: isNarrowCompact ? '30px' : undefined,
              height: '48px',
              padding: isNarrowCompact ? '0 3px' : '0 var(--sp-1)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              cursor: 'pointer',
            }}
          >
            <span
              ref={ensoSlotRef}
              style={{ display: 'inline-flex', flexShrink: 0, pointerEvents: 'none' }}
            >
              <Enso
                size={isNarrowCompact ? 24 : 28}
                state={ensoState}
                layoutId="enso"
                ariaLabel={brandTitle}
              />
            </span>
          </button>

          {PRIMARY_STATIONS.map((station) => (
            <RailStationButton
              key={station.id}
              station={station}
              isActive={activeRoute === station.id}
              compact
              narrow={isNarrowCompact}
              onNavigate={onNavigate}
            />
          ))}

          {pluginPages.length > 0 && (
            <span
              aria-hidden="true"
              style={{
                width: '1px',
                height: '24px',
                background: 'var(--hair)',
                flexShrink: 0,
                margin: isNarrowCompact ? '0 2px' : '0 var(--sp-1)',
                pointerEvents: 'none',
              }}
            />
          )}

          {pluginPages.map((page) => {
            const targetRoute = `page/${page.pluginId}/${page.id}`
            const encodedRoute = `page/${encodeURIComponent(page.pluginId)}/${encodeURIComponent(page.id)}`
            return (
              <RailPluginPageButton
                key={`${page.pluginId}:${page.id}`}
                page={page}
                isActive={activeRoute === targetRoute || activeRoute === encodedRoute}
                compact
                narrow={isNarrowCompact}
                onNavigate={onNavigate}
              />
            )
          })}

          <RailStationButton
            station={SETTINGS_STATION}
            isActive={activeRoute === 'settings'}
            compact
            narrow={isNarrowCompact}
            onNavigate={onNavigate}
          />
        </div>
      </nav>
    )
  }

  return (
    <aside
      ref={railRef}
      aria-label="主导航"
      data-shell-rail="desktop"
      className={className}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        bottom: 'var(--statusbar-h)',
        width: 'var(--rail-w)',
        zIndex: 20,
        isolation: 'isolate',
        background: 'transparent',
        borderRadius: 0,
        boxShadow: 'none',
        borderRight: '1px solid var(--hair)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        paddingTop: 'var(--sp-3)',
        paddingBottom: 'var(--sp-3)',
        ...style,
      }}
    >
      {/* Paper backing layer with a concentric cutout so the WebGL2 #ink Enso shines through */}
      <div aria-hidden="true" className="plate" data-rail-paper="true" style={paperLayerStyle} />

      {/* Top Enso + vertical short role card name (<=2 chars; longer goes into title tooltip) */}
      <button
        ref={brandRef}
        type="button"
        onClick={handleBrandClick}
        title={brandTitle}
        aria-label={`返回总览 · ${brandTitle}`}
        data-rail-brand="true"
        style={{
          position: 'relative',
          zIndex: 1,
          width: '100%',
          minHeight: '52px',
          padding: 'var(--sp-1) var(--sp-1)',
          marginBottom: 'var(--sp-3)',
          border: 0,
          background: 'transparent',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '4px',
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        <span ref={ensoSlotRef} style={{ display: 'inline-flex', flexShrink: 0 }}>
          <Enso size={36} state={ensoState} layoutId="enso" ariaLabel={brandTitle} />
        </span>
        {showVerticalName && (
          <span
            style={{
              fontFamily: 'var(--font-display-cjk)',
              fontSize: 'var(--fs-small)',
              lineHeight: 1.15,
              fontWeight: 700,
              color: 'var(--text-1)',
              writingMode: 'vertical-rl',
              textOrientation: 'upright',
              letterSpacing: '0.06em',
              userSelect: 'none',
            }}
          >
            {trimmedName}
          </span>
        )}
      </button>

      {/* Primary stations + dynamic plugin pages */}
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          flex: 1,
          minHeight: 0,
          width: '100%',
          overflowY: 'auto',
          overflowX: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 'var(--sp-2)',
          paddingBottom: 'var(--sp-2)',
        }}
      >
        {PRIMARY_STATIONS.map((station) => (
          <RailStationButton
            key={station.id}
            station={station}
            isActive={activeRoute === station.id}
            compact={false}
            onNavigate={onNavigate}
          />
        ))}

        {pluginPages.length > 0 && (
          <>
            <div
              role="separator"
              aria-orientation="horizontal"
              style={{
                width: '36px',
                height: '1px',
                background: 'var(--hair)',
                margin: 'var(--sp-1) 0',
                flexShrink: 0,
              }}
            />
            {pluginPages.map((page) => {
              const targetRoute = `page/${page.pluginId}/${page.id}`
              const encodedRoute = `page/${encodeURIComponent(page.pluginId)}/${encodeURIComponent(page.id)}`
              return (
                <RailPluginPageButton
                  key={`${page.pluginId}:${page.id}`}
                  page={page}
                  isActive={activeRoute === targetRoute || activeRoute === encodedRoute}
                  compact={false}
                  onNavigate={onNavigate}
                />
              )
            })}
          </>
        )}
      </div>

      {/* Bottom pinned Settings station */}
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          paddingTop: 'var(--sp-2)',
          borderTop: '1px solid var(--hair)',
          flexShrink: 0,
        }}
      >
        <RailStationButton
          station={SETTINGS_STATION}
          isActive={activeRoute === 'settings'}
          compact={false}
          onNavigate={onNavigate}
        />
      </div>
    </aside>
  )
}
