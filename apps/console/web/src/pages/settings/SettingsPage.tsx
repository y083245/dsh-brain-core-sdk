import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { LayoutGroup, motion } from 'motion/react'
import { settingsApi } from '../../api/client.ts'
import { ApiError, type ConsoleSettingsView } from '../../api/types.ts'
import { inktideStore, useInktideStore } from '../../data/store.ts'
import { REDUCED_TRANSITION_DURATION } from '../../motion/presets.ts'
import { SPRING } from '../../motion/tokens.ts'
import { useMotionLevel } from '../../motion/useMotionLevel.ts'
import { switchThemeWithTransition } from '../../shell/themeTransition.ts'
import { BrushTabs, ErrorState, InkSkeleton, InkSwitch, PageHeader, Plate } from '../../ui/index.ts'
import { ModelSettings } from './ModelSettings.tsx'
import { MemorySettings } from './MemorySettings.tsx'
import { RoleCardSettings } from './RoleCardSettings.tsx'
import { SecretSettings } from './SecretSettings.tsx'
import './settings.css'

const SECTIONS = [
  { id: 'memory', label: '记忆' },
  { id: 'models', label: '模型' },
  { id: 'secrets', label: '密钥' },
  { id: 'persona', label: '角色卡' },
  { id: 'interface', label: '界面' },
] as const
type Section = (typeof SECTIONS)[number]['id']

const THEME_OPTIONS = [
  { id: 'night', label: '夜墨' },
  { id: 'paper', label: '宣纸' },
  { id: 'auto', label: '跟随系统' },
] as const
const MOTION_OPTIONS = [
  { id: 'full', label: '完整' },
  { id: 'reduced', label: '减少' },
] as const
const QUALITY_OPTIONS = [
  { id: 'auto', label: '自动' },
  { id: 'high', label: '高' },
  { id: 'medium', label: '中' },
  { id: 'low', label: '低' },
  { id: 'static', label: '静止' },
] as const
const CURSOR_OPTIONS = [
  { id: 'brush', label: '笔锋' },
  { id: 'system', label: '系统' },
] as const

function InterfaceSettings() {
  const { themeMode, motionPreference, qualityPreference, cursorMode, soundEnabled } = useInktideStore()
  const themeOrigin = useRef<{ readonly x: number; readonly y: number } | undefined>(undefined)

  function handleThemeClick(event: MouseEvent<HTMLDivElement>): void {
    // BrushTabs reports selection separately. Capture the clicked control for the ink circle.
    const button = event.target instanceof Element ? event.target.closest('button') : null
    if (!button) return
    const rect = button.getBoundingClientRect()
    themeOrigin.current = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  }

  return (
    <div className="inktide-settings-preferences">
      <div onClickCapture={handleThemeClick}>
        <span>主题</span>
        <BrushTabs
          ariaLabel="主题"
          items={THEME_OPTIONS}
          value={themeMode}
          onChange={(value) => {
            switchThemeWithTransition(themeOrigin.current, value)
            themeOrigin.current = undefined
          }}
        />
      </div>
      <div>
        <span>动效</span>
        <BrushTabs
          ariaLabel="动效"
          items={MOTION_OPTIONS}
          value={motionPreference}
          onChange={inktideStore.setMotionPreference}
        />
      </div>
      <div>
        <span>流体画质</span>
        <BrushTabs
          ariaLabel="流体画质"
          items={QUALITY_OPTIONS}
          value={qualityPreference}
          onChange={inktideStore.setQualityPreference}
        />
      </div>
      <div>
        <span>光标</span>
        <BrushTabs
          ariaLabel="光标"
          items={CURSOR_OPTIONS}
          value={cursorMode}
          onChange={inktideStore.setCursorMode}
        />
      </div>
      <div>
        <span>声音</span>
        <InkSwitch
          ariaLabel="合成音效"
          checked={soundEnabled}
          onChange={inktideStore.setSoundEnabled}
        />
      </div>
    </div>
  )
}

interface EnsoWellCircle {
  readonly x: number
  readonly y: number
  readonly r: number
}

function PersonaSectionPlate({ children }: { readonly children: ReactNode }) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [wells, setWells] = useState<readonly EnsoWellCircle[]>([])

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return

    const measure = (): void => {
      const hostRect = host.getBoundingClientRect()
      if (hostRect.width <= 0 || hostRect.height <= 0) return
      const nodes = host.querySelectorAll<HTMLElement>('[data-enso-well]')
      const next: EnsoWellCircle[] = []
      for (const node of nodes) {
        const rect = node.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) continue
        const declaredSize = Number(node.dataset.ensoWell)
        const diameter = Number.isFinite(declaredSize) && declaredSize > 0 ? declaredSize : rect.width
        next.push({
          x: Number((rect.left - hostRect.left + rect.width * 0.5).toFixed(2)),
          y: Number((rect.top - hostRect.top + rect.height * 0.5).toFixed(2)),
          r: Math.round(diameter * 0.5 + 4),
        })
      }
      setWells((prev) => {
        if (
          prev.length === next.length &&
          prev.every(
            (item, idx) =>
              Math.abs(item.x - next[idx]!.x) < 0.25 &&
              Math.abs(item.y - next[idx]!.y) < 0.25 &&
              item.r === next[idx]!.r,
          )
        ) {
          return prev
        }
        return next
      })
    }

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    const observeAll = (): void => {
      if (!ro) return
      ro.disconnect()
      ro.observe(host)
      for (const node of host.querySelectorAll<HTMLElement>('[data-enso-well]')) {
        ro.observe(node)
      }
    }

    observeAll()
    measure()

    const mo =
      typeof MutationObserver !== 'undefined'
        ? new MutationObserver(() => {
            observeAll()
            measure()
          })
        : null
    mo?.observe(host, { childList: true, subtree: true })
    window.addEventListener('resize', measure, { passive: true })

    return () => {
      mo?.disconnect()
      ro?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  const maskValue =
    wells.length > 0
      ? wells
          .map(
            (well) =>
              `radial-gradient(circle ${well.r}px at ${well.x}px ${well.y}px, transparent 100%, var(--ink-void) 100%)`,
          )
          .join(', ')
      : undefined

  const paperStyle: CSSProperties =
    maskValue !== undefined
      ? {
          maskImage: maskValue,
          WebkitMaskImage: maskValue,
          ...(wells.length > 1
            ? {
                maskComposite: 'intersect',
                WebkitMaskComposite: 'source-in',
              }
            : {}),
        }
      : {}

  return (
    <div ref={hostRef} className="inktide-settings-plate inktide-settings-persona-plate">
      <div aria-hidden="true" className="plate inktide-settings-persona-paper" style={paperStyle} />
      {children}
    </div>
  )
}

function SettingsSection({ id, children }: { readonly id: Section; readonly children: ReactNode }) {
  const section = SECTIONS.find((item) => item.id === id)!
  return (
    <section id={'settings-' + id} aria-labelledby={'settings-title-' + id} className="inktide-settings-section">
      {id === 'persona' ? (
        <PersonaSectionPlate>
          <h2 id={'settings-title-' + id}>{section.label}</h2>
          {children}
        </PersonaSectionPlate>
      ) : (
        <Plate className="inktide-settings-plate">
          <h2 id={'settings-title-' + id}>{section.label}</h2>
          {children}
        </Plate>
      )}
    </section>
  )
}

export function SettingsPage() {
  const [active, setActive] = useState<Section>('memory')
  const [settings, setSettings] = useState<ConsoleSettingsView>()
  const [error, setError] = useState<Error>()
  const [revision, setRevision] = useState(0)
  const motionLevel = useMotionLevel()

  function goTo(section: Section): void {
    setActive(section)
    document.getElementById('settings-' + section)?.scrollIntoView({
      behavior: motionLevel === 'full' ? 'smooth' : 'instant',
    })
  }

  const reload = (): void => {
    setError(undefined)
    setRevision((previous) => previous + 1)
  }

  useEffect(() => {
    let current = true
    void Promise.resolve().then(async () => {
      if (!current) return
      const data = await settingsApi.getSettings()
      if (current) setSettings(data)
    }).catch((failure: unknown) => {
      if (current) setError(failure instanceof Error ? failure : new Error('读取设置失败'))
    })
    return () => { current = false }
  }, [revision])

  useEffect(() => {
    const visibleSections = new Set<string>()
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visibleSections.add(entry.target.id)
        else visibleSections.delete(entry.target.id)
      }
      const section = SECTIONS.find(({ id }) => visibleSections.has('settings-' + id))
      if (section) setActive(section.id)
    }, { rootMargin: '-12% 0px -55% 0px' })
    for (const { id } of SECTIONS) {
      const element = document.getElementById('settings-' + id)
      if (element) observer.observe(element)
    }
    return () => observer.disconnect()
  }, [Boolean(settings)])

  return (
    <>
      <PageHeader label="SETTINGS" title="设置" />
      <div className="inktide-settings">
        <nav aria-label="设置目录" className="inktide-settings-nav">
          <LayoutGroup id="settings-nav">
            {SECTIONS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                aria-current={active === id ? 'true' : undefined}
                disabled={id !== 'interface' && !settings}
                onClick={() => goTo(id)}
              >
                {active === id ? (
                  <motion.span
                    aria-hidden="true"
                    className="inktide-settings-nav-bar"
                    layoutId={motionLevel === 'full' ? 'settings-nav-active' : undefined}
                    transition={motionLevel === 'full' ? SPRING.snappy : { duration: REDUCED_TRANSITION_DURATION }}
                  />
                ) : null}
                <span>{label}</span>
              </button>
            ))}
          </LayoutGroup>
        </nav>
        <div className="inktide-settings-content">
          {error && (
            <ErrorState
              code={error instanceof ApiError ? error.code : 'UNAVAILABLE'}
              message={error.message}
              requestId={error instanceof ApiError ? error.requestId : undefined}
              onRetry={reload}
            />
          )}
          {settings ? (
            <>
              <SettingsSection id="memory">
                <MemorySettings agents={settings.agents} onSaved={reload} goTo={goTo} />
              </SettingsSection>
              <SettingsSection id="models">
                <ModelSettings agents={settings.agents} onSaved={reload} />
              </SettingsSection>
              <SettingsSection id="secrets">
                <SecretSettings names={settings.secretNames} sharedQuota={settings.sharedQuotaWarning} onSaved={reload} />
              </SettingsSection>
              <SettingsSection id="persona">
                <RoleCardSettings
                  roleCard={settings.roleCard}
                  available={settings.availableRoleCards}
                  onSaved={reload}
                />
              </SettingsSection>
            </>
          ) : !error && <InkSkeleton rows={3} height={40} />}
          <SettingsSection id="interface"><InterfaceSettings /></SettingsSection>
        </div>
      </div>
    </>
  )
}
