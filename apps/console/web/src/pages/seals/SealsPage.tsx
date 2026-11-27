import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react'
import { AnimatePresence, motion, useMotionValue, useSpring, useTransform } from 'motion/react'
import { MoreHorizontal } from 'lucide-react'
import { pluginsApi } from '../../api/client.ts'
import { ApiError, type ConsoleInstallPreview, type ConsolePluginItem, type PluginKind, type PluginsListResponse } from '../../api/types.ts'
import { useInk } from '../../ink/InkProvider.tsx'
import { getPreset, REDUCED_FADE_DURATION, REDUCED_TRANSITION_DURATION } from '../../motion/presets.ts'
import { DUR, EASE, SPRING } from '../../motion/tokens.ts'
import { useMotionLevel } from '../../motion/useMotionLevel.ts'
import { PluginSeal } from '../../plugins/PluginSeal.tsx'
import { useConsoleShellData } from '../../shell/ConsoleShell.tsx'
import { useShellNavigation } from '../../shell/PageTransition.tsx'
import { Badge } from '../../ui/Badge.tsx'
import { BrushButton } from '../../ui/BrushButton.tsx'
import { InkNumber } from '../../ui/InkNumber.tsx'
import { InkSwitch } from '../../ui/InkSwitch.tsx'
import { EmptyState, ErrorState, InkSkeleton } from '../../ui/InkStates.tsx'
import { MagneticButton } from '../../ui/MagneticButton.tsx'
import { PageHeader } from '../../ui/PageHeader.tsx'
import { Plate } from '../../ui/Plate.tsx'
import { toast } from '../../ui/SealToast.tsx'
import { ManifestDrawer, PermissionCovenant, SealSourceDialog, UninstallCovenant, type SourceMode } from './SealDialogs.tsx'
import { OFFICIAL_PLUGINS } from './officialPlugins.ts'
import './seals.css'

const KIND_LABELS: Readonly<Record<PluginKind, string>> = {
  channel: '通道', activity: '活动', capability: '能力', 'memory-provider': '记忆提供方',
}

type LocalAction = 'enable' | 'update'

type Dialog =
  | { readonly kind: 'source'; readonly mode: SourceMode; readonly plugin?: ConsolePluginItem; readonly initialSource?: string }
  | { readonly kind: 'permission'; readonly preview: ConsoleInstallPreview; readonly localAction?: LocalAction }
  | { readonly kind: 'manifest' | 'uninstall'; readonly plugin: ConsolePluginItem }

interface SavedPreview {
  readonly preview: ConsoleInstallPreview
  readonly installedVersion: string
  readonly upgrading: boolean
}

function revealPermission(plugin: ConsolePluginItem): ConsoleInstallPreview {
  return { id: plugin.id, version: plugin.version, permissions: plugin.permissions, newPermissions: [], warnings: [] }
}

function PluginCard({ plugin, selected, carving, savedPreview, register, onOpen, refresh }: {
  readonly plugin: ConsolePluginItem
  readonly selected: boolean
  readonly carving: boolean
  readonly savedPreview: SavedPreview | undefined
  readonly register: (id: string, node: HTMLElement | null) => void
  readonly onOpen: (dialog: Dialog) => void
  readonly refresh: () => Promise<PluginsListResponse | undefined>
}) {
  const level = useMotionLevel()
  const ink = useInk()
  const article = useRef<HTMLElement | null>(null)
  const mark = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const busyRef = useRef(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [manualEnabled, setManualEnabled] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [errorTick, setErrorTick] = useState(0)
  const [stampTick, setStampTick] = useState(0)
  const [toggleError, setToggleError] = useState<string | null>(null)
  const rotXRaw = useMotionValue(0)
  const rotYRaw = useMotionValue(0)
  const rotX = useSpring(rotXRaw, SPRING.float)
  const rotY = useSpring(rotYRaw, SPRING.float)
  const gloss = useTransform(
    [rotX, rotY],
    ([x, y]) => `linear-gradient(${125 + Number(y) * 8}deg, transparent ${40 + Number(x) * 2}%, var(--hair-strong), transparent ${60 + Number(x) * 2}%)`,
  )
  const discovered = plugin.state === 'discovered'
  const mountedEnabled = plugin.state === 'enabled'
  const enabled = manualEnabled ?? mountedEnabled
  const pending = plugin.state === 'pending'
  const failed = plugin.state === 'failed'

  useEffect(() => {
    if (manualEnabled !== null && manualEnabled === mountedEnabled) setManualEnabled(null)
  }, [manualEnabled, mountedEnabled])

  useEffect(() => {
    if (!menuOpen) return
    const close: EventListener = (event) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return
      if (event instanceof PointerEvent && event.target instanceof Node && menu.current?.contains(event.target)) return
      setMenuOpen(false)
      if (event instanceof KeyboardEvent) menu.current?.querySelector('button')?.focus()
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', close)
    }
  }, [menuOpen])

  const setArticle = useCallback((node: HTMLElement | null) => {
    article.current = node
    register(plugin.id, node)
  }, [plugin.id, register])

  function tilt(event: PointerEvent<HTMLElement>): void {
    if (level !== 'full') return
    setHovered(true)
    const rect = event.currentTarget.getBoundingClientRect()
    rotXRaw.set((0.5 - (event.clientY - rect.top) / rect.height) * 12)
    rotYRaw.set(((event.clientX - rect.left) / rect.width - 0.5) * 12)
  }

  async function toggle(next: boolean): Promise<void> {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setToggleError(null)
    setManualEnabled(next)
    try {
      if (next) await pluginsApi.enable(plugin.id)
      else await pluginsApi.disable(plugin.id)
      const rect = mark.current?.getBoundingClientRect()
      if (next) setStampTick((tick) => tick + 1)
      if (rect && level === 'full') {
        const card = article.current?.getBoundingClientRect()
        const cx = rect.x + rect.width / 2
        const cy = rect.y + rect.height / 2
        if (next) {
          ink.splat({ x: cx, y: cy, color: 'zhusha', radius: 90, amount: 0.8 })
          for (let index = 0; index < 6; index += 1) {
            const angle = (Math.PI * 2 * index) / 6
            ink.splat({
              x: cx + Math.cos(angle) * 20,
              y: cy + Math.sin(angle) * 20,
              dx: Math.cos(angle) * 120,
              dy: Math.sin(angle) * 120,
              radius: 24,
              amount: 0.25,
              color: 'zhusha',
            })
          }
        } else {
          if (card) ink.dilute({ x: card.x, y: card.y, w: card.width, h: card.height }, Math.round(DUR.ebb * 1000))
          ink.splat({ x: cx, y: cy, color: 'smoke', radius: 44, amount: 0.25 })
        }
      }
      await refresh()
    } catch (err) {
      const message = err instanceof Error ? err.message : '插件状态更新失败'
      setManualEnabled(null)
      setErrorTick((tick) => tick + 1)
      setToggleError(message)
      toast.error(message, { code: err instanceof ApiError ? err.code : undefined, requestId: err instanceof ApiError ? err.requestId : undefined })
      await refresh()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  function open(dialog: Dialog): void {
    setMenuOpen(false)
    onOpen(dialog)
  }

  async function handleLocalUpdate(): Promise<void> {
    const update = plugin.updateAvailable
    if (!update || busyRef.current) return
    if (update.newPermissions.length > 0) {
      open({
        kind: 'permission',
        preview: {
          id: plugin.id,
          version: update.version,
          permissions: update.permissions,
          newPermissions: update.newPermissions,
          warnings: update.warnings,
        },
        localAction: 'update',
      })
      return
    }
    busyRef.current = true
    setBusy(true)
    setToggleError(null)
    try {
      const res = await pluginsApi.applyLocal(plugin.id, { action: 'update' })
      await refresh()
      toast.success(`已更新 ${plugin.id}（${res.state === 'enabled' ? '已实时重载' : '保持停用状态'}）`)
    } catch (err) {
      const message = err instanceof Error ? err.message : '应用本地更新失败'
      setErrorTick((tick) => tick + 1)
      setToggleError(message)
      toast.error(message, { code: err instanceof ApiError ? err.code : undefined, requestId: err instanceof ApiError ? err.requestId : undefined })
      await refresh()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const variant = pending ? 'pending' : failed && !enabled ? 'failed' : 'hollow'
  const stamp = getPreset('stamp', level)
  return (
    <motion.div layout={level === 'full'} style={{ position: 'relative', zIndex: menuOpen ? 4 : undefined }} variants={{
      ...getPreset('bloom', level),
      ...{ exit: getPreset('dissolve', level).exit ?? { opacity: 0 } },
    }} initial="initial" animate="animate" exit="exit">
      <motion.div key={errorTick} initial={errorTick > 0 && level === 'full' ? { x: 0 } : false}
        animate={errorTick > 0 && level === 'full' ? { x: [0, -3, 3, -2, 2, 0] } : { x: 0 }} transition={{ duration: DUR.quick }}>
        <Plate ref={setArticle} as="article" interactive className="seals-card" aria-label={plugin.id} data-enabled={enabled || undefined}
          data-disabled={(!enabled && !pending) || undefined} data-selected={selected || undefined} data-hovered={hovered || undefined}
          onPointerEnter={() => { if (level === 'full') setHovered(true) }}
          onPointerMove={tilt} onPointerLeave={() => { setHovered(false); rotXRaw.set(0); rotYRaw.set(0) }}>
          <div ref={mark} className="seals-card-mark" aria-hidden="true">
            <motion.div className="seals-card-mark-layer" style={{ rotateX: rotX, rotateY: rotY }}>
              <PluginSeal pluginId={plugin.id} variant={variant} />
              {!pending ? (
                <motion.div className="seals-card-mark-layer" initial={false}
                  animate={level === 'full' ? { clipPath: enabled ? 'circle(75% at 50% 50%)' : 'circle(0% at 50% 50%)' } : { opacity: enabled ? 1 : 0, clipPath: 'none' }}
                  transition={{ duration: level === 'full' ? DUR.stamp : REDUCED_TRANSITION_DURATION, ease: EASE.inkOut }}>
                  <motion.div key={stampTick} initial={stampTick > 0 ? 'initial' : false} animate="animate" variants={stamp}>
                    <PluginSeal className="seals-filled" pluginId={plugin.id} />
                  </motion.div>
                </motion.div>
              ) : null}
              {level === 'full' ? (
                <motion.span
                  aria-hidden="true"
                  className="seals-card-gloss"
                  style={{ backgroundImage: gloss, transition: `opacity ${DUR.quick}s ease` }}
                />
              ) : null}
              {carving ? <motion.span style={{ position: 'absolute', height: 2, top: '50%', left: '18%', width: '64%', background: 'var(--zhusha)' }}
                initial={false}
                animate={level === 'full' ? { y: [-26, 26, -26] } : { y: 0, opacity: 0.8 }}
                transition={level === 'full' ? { duration: DUR.brush * 2, repeat: Infinity, ease: EASE.brush } : { duration: REDUCED_FADE_DURATION }} /> : null}
            </motion.div>
          </div>
          <div className="seals-card-details">
            <h2>{plugin.id}</h2>
            <div className="seals-muted"><InkNumber value={`v${plugin.version}`} />{plugin.kinds.length ? ` · ${plugin.kinds.map((kind) => KIND_LABELS[kind]).join(' / ')}` : ''}</div>
            <div className="seals-badges">
              <Badge tone={pending ? 'tenghuang' : enabled ? 'shilv' : failed ? 'yanzhi' : 'neutral'}>
                {discovered ? '本地发现 · 未启用' : pending ? '等你确认权限' : enabled ? '已启用' : failed ? '启用失败' : '已停用'}
              </Badge>
              {plugin.updateAvailable ? (
                <Badge tone="tenghuang">
                  {plugin.updateAvailable.version !== plugin.version ? `有本地更新 v${plugin.updateAvailable.version}` : '本地代码已更新'}
                </Badge>
              ) : null}
            </div>
            <p className="seals-muted">{plugin.tools.length} 个工具 · {plugin.permissions.length} 项权限</p>
            {toggleError ? <p role="alert" style={{ color: 'var(--yanzhi)' }}>{toggleError}</p> : null}
            <div className="seals-card-controls">
              <div className="seals-card-control-group">
                {discovered ? (
                  <InkSwitch
                    checked={false}
                    disabled={busy}
                    ariaLabel={`启用 ${plugin.id}`}
                    onChange={(checked) => {
                      if (checked) {
                        open({
                          kind: 'permission',
                          preview: {
                            id: plugin.id,
                            version: plugin.version,
                            permissions: plugin.permissions,
                            newPermissions: plugin.permissions,
                            warnings: plugin.warnings ?? [],
                          },
                          localAction: 'enable',
                        })
                      }
                    }}
                  />
                ) : pending || savedPreview?.upgrading ? (
                  <BrushButton variant="secondary" size="sm" onClick={() => open({ kind: 'permission', preview: savedPreview?.preview ?? revealPermission(plugin) })}>查看契约</BrushButton>
                ) : (
                  <InkSwitch checked={enabled} disabled={busy} ariaLabel={`启用 ${plugin.id}`} onChange={(checked) => { void toggle(checked) }} />
                )}
                {plugin.updateAvailable ? (
                  <BrushButton variant="secondary" size="sm" disabled={busy} onClick={() => { void handleLocalUpdate() }}>应用更新</BrushButton>
                ) : null}
              </div>
              <div ref={menu} style={{ position: 'relative' }}>
                <BrushButton variant="ghost" size="sm" aria-expanded={menuOpen} aria-label={`${plugin.id} 操作`} onClick={() => setMenuOpen(!menuOpen)}><MoreHorizontal size={18} aria-hidden="true" /></BrushButton>
                {menuOpen ? <Plate className="seals-menu" level="raised" role="group" aria-label="插件操作">
                  {!discovered ? <BrushButton variant="ghost" size="sm" onClick={() => open({ kind: 'source', mode: 'upgrade', plugin })} disabled={busy || pending}>升级…</BrushButton> : null}
                  {!discovered ? <BrushButton variant="ghost" size="sm" onClick={() => open({ kind: 'source', mode: 'check', plugin })}>规范检查</BrushButton> : null}
                  <BrushButton variant="ghost" size="sm" onClick={() => open({ kind: 'manifest', plugin })}>查看清单</BrushButton>
                  {!discovered ? <BrushButton variant="danger" size="sm" onClick={() => open({ kind: 'uninstall', plugin })} disabled={busy}>卸载…</BrushButton> : null}
                </Plate> : null}
              </div>
            </div>
          </div>
        </Plate>
      </motion.div>
    </motion.div>
  )
}

export function SealsPage() {
  const { displayedRoute } = useShellNavigation()
  const selected = new URLSearchParams(displayedRoute.split('?')[1]).get('plugin')
  const { plugins, pluginsError, refreshPlugins, refreshPluginPages } = useConsoleShellData()
  const level = useMotionLevel()
  const ink = useInk()
  const cards = useRef(new Map<string, HTMLElement>())
  const revealed = useRef<string | null>(null)
  const scanningRef = useRef(false)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [lastPermissionDialog, setLastPermissionDialog] = useState<Extract<Dialog, { readonly kind: 'permission' }> | null>(null)
  const [lastUninstallPlugin, setLastUninstallPlugin] = useState<ConsolePluginItem | null>(null)
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const [previews, setPreviews] = useState<ReadonlyMap<string, SavedPreview>>(new Map())
  const [carvingId, setCarvingId] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const close = useCallback(() => setDialog(null), [])

  useEffect(() => {
    if (dialog?.kind === 'permission') setLastPermissionDialog(dialog)
    if (dialog?.kind === 'uninstall') setLastUninstallPlugin(dialog.plugin)
  }, [dialog])

  const activePermissionDialog = dialog?.kind === 'permission' ? dialog : lastPermissionDialog
  const activePermissionPreview = activePermissionDialog?.preview ?? null
  const activeLocalAction = activePermissionDialog?.localAction
  const activeUninstallPlugin = dialog?.kind === 'uninstall' ? dialog.plugin : lastUninstallPlugin
  const register = useCallback((id: string, node: HTMLElement | null) => {
    if (node) cards.current.set(id, node)
    else cards.current.delete(id)
  }, [])
  const refresh = useCallback(async () => {
    const [updated] = await Promise.all([refreshPlugins(), refreshPluginPages()])
    return updated
  }, [refreshPluginPages, refreshPlugins])
  const items = plugins?.plugins.filter((plugin) => !hidden.has(plugin.id)) ?? []

  useEffect(() => {
    if (!plugins) return
    setPreviews((current) => {
      const obsolete = [...current].filter(([id, saved]) => {
        const installed = plugins.plugins.find((plugin) => plugin.id === id)
        return installed && (installed.version !== saved.installedVersion || (!saved.upgrading && installed.state !== 'pending'))
      })
      if (obsolete.length === 0) return current
      const next = new Map(current)
      for (const [id] of obsolete) next.delete(id)
      return next
    })
  }, [plugins])

  useEffect(() => {
    if (!selected) { revealed.current = null; return }
    const card = cards.current.get(selected)
    if (card && revealed.current !== selected) {
      revealed.current = selected
      card.scrollIntoView({ block: 'nearest', behavior: level === 'full' ? 'smooth' : 'instant' })
    }
  }, [level, plugins, selected])

  function clearPreview(id: string): void {
    setPreviews((current) => {
      if (!current.has(id)) return current
      const next = new Map(current)
      next.delete(id)
      return next
    })
  }

  function finish(id: string): void {
    clearPreview(id)
    close()
    void refresh()
  }

  async function handleScan(): Promise<void> {
    if (scanningRef.current) return
    scanningRef.current = true
    setScanning(true)
    try {
      const res = await pluginsApi.scan()
      await refresh()
      toast.success(`已扫描本地插件目录（共 ${res.plugins.length} 个）`)
    } catch (err) {
      const message = err instanceof Error ? err.message : '扫描本地插件目录失败'
      toast.error(message, { code: err instanceof ApiError ? err.code : undefined, requestId: err instanceof ApiError ? err.requestId : undefined })
    } finally {
      scanningRef.current = false
      setScanning(false)
    }
  }

  function removed(id: string): void {
    clearPreview(id)
    const rect = cards.current.get(id)?.getBoundingClientRect()
    if (rect && level === 'full') {
      ink.dilute({ x: rect.x, y: rect.y, w: rect.width, h: rect.height }, Math.round(DUR.dissolve * 1000))
      for (let index = 0; index < 8; index += 1) {
        const angle = index * Math.PI / 4
        const dx = Math.cos(angle)
        const dy = Math.sin(angle)
        ink.splat({ x: rect.x + rect.width / 2 + dx * 30, y: rect.y + rect.height / 2 + dy * 30, dx: dx * 85, dy: dy * 85, color: 'smoke', radius: 34, amount: 0.28 })
      }
    }
    setHidden((current) => new Set([...current, id]))
    close()
    void refresh().then((updated) => {
      if (updated && !updated.plugins.some((plugin) => plugin.id === id && plugin.state !== 'discovered')) {
        setHidden((current) => {
          const next = new Set(current)
          next.delete(id)
          return next
        })
      }
    })
  }

  return (
    <section className="seals-page">
      <PageHeader label="SEALS · PLUGINS" title="印谱" actions={
        <div className="seals-actions">
          <BrushButton variant="secondary" loading={scanning} onClick={() => { void handleScan() }}>扫描插件</BrushButton>
          <MagneticButton>
            <BrushButton variant="primary" onClick={() => setDialog({ kind: 'source', mode: 'install' })}>安装插件</BrushButton>
          </MagneticButton>
        </div>
      } />
      {pluginsError instanceof Error ? <ErrorState message={pluginsError.message} code={pluginsError instanceof ApiError ? pluginsError.code : undefined} onRetry={() => { void refresh() }} /> : null}
      {!plugins && !pluginsError ? <InkSkeleton rows={2} height={180} /> : null}
      {plugins && items.length === 0 ? <>
        <EmptyState glyph="无印" style={{ padding: 'var(--sp-5) var(--sp-4)' }} description="通过 npm 安装的内核默认不预装插件，可从下方选择官方插件快捷安装，或点击右上角输入任意 npm 包名 / Git 地址 / 本地路径；从源码运行时，放入 plugins/ 目录后点「扫描插件」即可自动发现。" />
        <section className="seals-official" aria-label="官方插件推荐">
          <div className="seals-official-heading">
            <h2>官方插件</h2>
            <p className="seals-muted">择一枚印，添一项能力。安装前仍需校验来源并确认权限契约。</p>
          </div>
          <div className="seals-official-grid">
            {OFFICIAL_PLUGINS.map((plugin) => (
              <Plate as="article" className="seals-official-card" key={plugin.id}>
                <div className="seals-official-title"><h3>{plugin.title}</h3><Badge>{plugin.kind}</Badge></div>
                <p className="seals-muted">{plugin.summary}</p>
                <code>{plugin.spec}</code>
                <BrushButton variant="secondary" size="sm" aria-label={`安装${plugin.title}`}
                  onClick={() => setDialog({ kind: 'source', mode: 'install', initialSource: plugin.spec })}>填入并安装</BrushButton>
              </Plate>
            ))}
          </div>
        </section>
      </> : null}
      <div className="seals-grid">
        <AnimatePresence>
          {items.map((plugin) => (
            <PluginCard key={plugin.id} plugin={plugin} selected={selected === plugin.id}
              carving={carvingId === plugin.id} savedPreview={previews.get(plugin.id)}
              register={register} onOpen={setDialog} refresh={refresh} />
          ))}
        </AnimatePresence>
      </div>
      {dialog?.kind === 'source' ? (
        <SealSourceDialog mode={dialog.mode} plugin={dialog.plugin} initialSource={dialog.initialSource}
          installedIds={new Set(items.map((plugin) => plugin.id))} onClose={close} onApplied={() => { void refresh() }}
          onLoadingChange={(loading) => setCarvingId(loading && dialog.mode === 'upgrade' ? dialog.plugin?.id ?? null : null)}
          onPreview={(preview) => {
            const upgrading = dialog.mode === 'upgrade'
            const installedVersion = upgrading ? dialog.plugin?.version ?? preview.version : preview.version
            setPreviews((current) => new Map(current).set(preview.id, { preview, installedVersion, upgrading }))
            setDialog({ kind: 'permission', preview })
          }} />
      ) : null}
      <PermissionCovenant
        open={dialog?.kind === 'permission'}
        preview={activePermissionPreview}
        plugin={activePermissionPreview ? items.find((item) => item.id === activePermissionPreview.id) : undefined}
        actionLabel={
          activeLocalAction === 'enable'
            ? '本地发现 · 授权并实时启用'
            : activeLocalAction === 'update'
              ? '本地更新 · 授权新权限并应用'
              : undefined
        }
        onConfirmAction={
          activeLocalAction && activePermissionPreview
            ? async () => {
                await pluginsApi.applyLocal(activePermissionPreview.id, {
                  action: activeLocalAction,
                  confirmPermissions: true,
                })
              }
            : undefined
        }
        onClose={close}
        onConfirmed={() => {
          if (!activePermissionPreview) return
          const action = activeLocalAction
          const id = activePermissionPreview.id
          finish(id)
          if (action === 'enable') {
            toast.success(`已启用 ${id}（已实时生效）`)
          } else if (action === 'update') {
            toast.success(`已更新 ${id}（保持原启停状态）`)
          }
        }}
      />
      {dialog?.kind === 'manifest' ? <ManifestDrawer plugin={dialog.plugin} onClose={close} /> : null}
      <UninstallCovenant
        open={dialog?.kind === 'uninstall'}
        plugin={activeUninstallPlugin}
        onClose={close}
        onRemoved={() => { if (activeUninstallPlugin) removed(activeUninstallPlugin.id) }}
      />
    </section>
  )
}
