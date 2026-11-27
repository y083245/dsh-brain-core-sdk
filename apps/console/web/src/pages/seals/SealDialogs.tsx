import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { motion } from 'motion/react'
import { pluginsApi } from '../../api/client.ts'
import { ApiError, type CheckReport, type ConsoleInstallPreview, type ConsolePluginItem } from '../../api/types.ts'
import { useInk } from '../../ink/InkProvider.tsx'
import { getPreset, REDUCED_FADE_DURATION } from '../../motion/presets.ts'
import { COVENANT_LOCK_MS, DUR, EASE } from '../../motion/tokens.ts'
import { useMotionLevel } from '../../motion/useMotionLevel.ts'
import { describePermission } from '../../plugins/permissionText.ts'
import { Badge } from '../../ui/Badge.tsx'
import { BrushButton } from '../../ui/BrushButton.tsx'
import { Covenant } from '../../ui/Covenant.tsx'
import { HoldToStamp } from '../../ui/HoldToStamp.tsx'
import { InkInput } from '../../ui/InkInput.tsx'
import { InkSwitch } from '../../ui/InkSwitch.tsx'
import { MagneticButton } from '../../ui/MagneticButton.tsx'
import { ScrollDrawer } from '../../ui/ScrollDrawer.tsx'
import { availableOfficialPlugins } from './officialPlugins.ts'

export type SourceMode = 'install' | 'upgrade' | 'check'
const SOURCE_LABELS = { install: '安装插件', upgrade: '升级插件', check: '规范检查' } as const
const PERMISSION_STAGGER_SEC = DUR.quick

export function Carving({ label }: { readonly label: string }) {
  const level = useMotionLevel()
  return (
    <div role="status" className="seals-carving">
      <div className="seals-carving-mark" aria-hidden="true">
        <motion.span
          initial={false}
          animate={level === 'full' ? { x: [4, 28, 4] } : { x: 16 }}
          transition={level === 'full' ? { duration: DUR.brush * 2, repeat: Infinity, ease: EASE.brush } : { duration: REDUCED_FADE_DURATION }}
        />
      </div>
      <span>{label}</span>
    </div>
  )
}

export function SealSourceDialog({ mode, plugin, initialSource, installedIds, onPreview, onApplied, onClose, onLoadingChange }: {
  readonly mode: SourceMode
  readonly plugin?: ConsolePluginItem
  readonly initialSource?: string
  readonly installedIds?: ReadonlySet<string>
  readonly onPreview: (preview: ConsoleInstallPreview) => void
  readonly onApplied: () => void
  readonly onClose: () => void
  readonly onLoadingChange: (loading: boolean) => void
}) {
  const [source, setSource] = useState(initialSource ?? '')
  const [loading, setLoading] = useState(false)
  const [report, setReport] = useState<CheckReport | null>(null)
  const [applied, setApplied] = useState<ConsoleInstallPreview | null>(null)
  const [error, setError] = useState('')
  const busy = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    setSource(initialSource ?? '')
    setError('')
    setReport(null)
    setApplied(null)
  }, [initialSource, mode, plugin?.id])
  const shortcuts = mode === 'install' ? availableOfficialPlugins(installedIds) : []

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    const spec = source.trim()
    if (busy.current || spec === '') return
    busy.current = true
    setLoading(true)
    onLoadingChange(true)
    setError('')
    try {
      if (mode === 'check') {
        setReport(await pluginsApi.check(spec))
        return
      }
      if (mode === 'upgrade' && plugin) {
        const result = await pluginsApi.upgrade(plugin.id, spec)
        if (result.applied) {
          onApplied()
          setApplied(result)
        } else if (mounted.current) {
          onPreview(result)
        }
        return
      }
      const preview = await pluginsApi.install(spec)
      onApplied()
      if (mounted.current) onPreview(preview)
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code} · ${err.message}` : '操作失败，请重试。')
    } finally {
      busy.current = false
      setLoading(false)
      onLoadingChange(false)
    }
  }

  return (
    <ScrollDrawer title={SOURCE_LABELS[mode]} open onClose={onClose} closeOnBackdrop={!loading} closeOnEscape={!loading}>
      {applied ? (
        <div className="seals-form">
          <p>没有新增权限，已升级至 <span className="num">v{applied.version}</span>。</p>
          {applied.warnings.map((warning) => <p key={warning} style={{ color: 'var(--tenghuang)' }}>{warning}</p>)}
          <MagneticButton>
            <BrushButton variant="primary" onClick={onClose}>完成</BrushButton>
          </MagneticButton>
        </div>
      ) : (
        <form className="seals-form" onSubmit={(event) => { void submit(event) }}>
          <InkInput label={mode === 'check' ? '插件目录' : '插件来源'} helperText={mode === 'check' ? '输入包含插件清单的目录路径。' : 'npm 包名、git+… 或本地目录路径。'}
            value={source} onChange={(event) => { setSource(event.target.value); setReport(null); setError('') }} disabled={loading} monospace required />
          <div className="seals-actions">
            <MagneticButton disabled={loading || source.trim() === ''}>
              <BrushButton variant="primary" type="submit" loading={loading} disabled={source.trim() === ''}>{mode === 'check' ? '开始检查' : '取回并校验'}</BrushButton>
            </MagneticButton>
            <BrushButton variant="ghost" disabled={loading} onClick={onClose}>算了</BrushButton>
          </div>
          {loading ? <Carving label={mode === 'check' ? '正在检查规范' : '正在取回和校验'} /> : null}
          {error ? <p role="alert" style={{ color: 'var(--yanzhi)' }}>{error}</p> : null}
          {report ? <Report report={report} /> : null}
          {shortcuts.length > 0 ? (
            <div className="seals-shortcuts" role="group" aria-label="官方插件快捷填入">
              <p className="seals-muted">官方插件快捷填入</p>
              <div className="seals-shortcuts-list">
                {shortcuts.map((item) => (
                  <BrushButton key={item.id} variant="secondary" size="sm" disabled={loading}
                    aria-label={`填入${item.title}`} aria-pressed={source === item.spec}
                    onClick={() => { setSource(item.spec); setError(''); setReport(null) }}>{item.title}</BrushButton>
                ))}
              </div>
            </div>
          ) : null}
        </form>
      )}
    </ScrollDrawer>
  )
}

function Report({ report }: { readonly report: CheckReport }) {
  const manifest = report.manifest
  return (
    <div className="seals-report">
      <h3>清单</h3>
      {manifest.ok ? <p><Badge tone="shilv">过</Badge> {manifest.manifest.id}</p> :
        <ul>{manifest.errors.map((error, index) => <li key={index}><Badge tone="yanzhi">误</Badge> <code>{error.field}</code> {error.message}</li>)}</ul>}
      <h3>契约测试</h3>
      {report.contract.length === 0 ? <p className="seals-muted">没有返回契约测试结果。</p> : (
        <ul>{report.contract.map((check, index) => <li key={index}><Badge tone={check.ok ? 'shilv' : 'yanzhi'}>{check.ok ? '过' : '误'}</Badge> {check.name} · {check.message}</li>)}</ul>
      )}
      <h3>静态扫描</h3>
      <ul>{report.findings.length === 0 ? <li><Badge tone="shilv">过</Badge> 无违规报告</li> :
        report.findings.map((finding, index) => (
          <li key={index}><Badge tone={finding.level === 'must' ? 'yanzhi' : 'tenghuang'}>{finding.level === 'must' ? '误' : '慎'}</Badge>
            <code>{finding.rule}</code> {finding.message}{finding.file ? <code>{finding.file}{finding.line === undefined ? '' : `:${finding.line}`}</code> : null}
          </li>
        ))}</ul>
      {report.notes.map((note, index) => <p className="seals-muted" key={index}>{note}</p>)}
    </div>
  )
}

export function PermissionCovenant({ open, preview, plugin, actionLabel, onConfirmAction, onClose, onConfirmed }: {
  readonly open: boolean
  readonly preview: ConsoleInstallPreview | null
  readonly plugin?: ConsolePluginItem
  readonly actionLabel?: string
  readonly onConfirmAction?: () => Promise<void>
  readonly onClose: () => void
  readonly onConfirmed: () => void
}) {
  const motionLevel = useMotionLevel()
  const ink = useInk()
  const [locked, setLocked] = useState(true)
  const [phase, setPhase] = useState<'reading' | 'pending' | 'confirmed'>('reading')
  const mark = useRef<HTMLSpanElement>(null)
  const noticeId = useId()
  const newPermissions = new Set(preview?.newPermissions ?? [])
  let highlightIndex = 0
  const brush = getPreset('brushIn', motionLevel)
  const canClose = phase === 'reading'

  useEffect(() => {
    if (!open || !preview) return
    setLocked(true)
    setPhase('reading')
    const timer = window.setTimeout(() => setLocked(false), COVENANT_LOCK_MS)
    return () => window.clearTimeout(timer)
  }, [open, preview])

  async function confirm(): Promise<void> {
    if (!preview) return
    setPhase('pending')
    try {
      if (onConfirmAction) await onConfirmAction()
      else await pluginsApi.confirm(preview.id)
      setPhase('confirmed')
    } catch (err) {
      setPhase('reading')
      throw err
    }
  }

  useEffect(() => {
    if (phase !== 'confirmed' || motionLevel !== 'full') return
    const rect = mark.current?.getBoundingClientRect()
    if (rect) ink.splat({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, color: 'zhusha', radius: 260, amount: 0.45 })
  }, [ink, motionLevel, phase])

  return (
    <Covenant title="契约" open={open && preview !== null} onClose={onClose} closeOnBackdrop={canClose} closeOnEscape={canClose}
      subtitle={preview ? <>{preview.id} <span className="num">v{preview.version}</span>{plugin?.kinds.length ? ` · ${plugin.kinds.join(' / ')}` : ''}{actionLabel ? ` · ${actionLabel}` : ''}</> : undefined}
      footer={preview ? <div className="seals-form" style={{ justifyItems: 'center' }}>
        <HoldToStamp key={preview.id} label="准" disabled={locked} ariaLabel={`按住 0.9 秒以确认：授权插件 ${preview.id}`} ariaDescribedBy={noticeId} onConfirm={confirm} onComplete={onConfirmed} />
        <BrushButton variant="ghost" disabled={!canClose} onClick={onClose}>算了</BrushButton>
      </div> : undefined}>
      {preview ? <div className="seals-contract-body">
        <p id={noticeId}>它请求以下权限。确认后，插件将获得这些能力。</p>
        <ul className="seals-permissions">
          {preview.permissions.map((permission) => {
            const detail = describePermission(permission)
            const highlight = detail.highRisk || newPermissions.has(permission)
            const delay = highlight ? highlightIndex++ * PERMISSION_STAGGER_SEC : 0
            return <li key={permission} className="seals-permission" data-lan={detail.lan || undefined}>
              <code>{permission}</code>
              <span>{detail.known ? detail.text : <Badge tone="tenghuang">未知权限</Badge>}</span>
              {highlight ? (
                <svg className="seals-permission-mark" viewBox="0 0 180 4" preserveAspectRatio="none" aria-hidden="true">
                  <motion.path d="M 0 3 Q 70 0 180 2" fill="none" stroke="var(--zhusha)" strokeWidth={1.4}
                    variants={brush} initial="initial" animate="animate" custom={motionLevel === 'full' ? delay : 0} />
                </svg>
              ) : null}
            </li>
          })}
        </ul>
        {preview.permissions.length === 0 ? <p className="seals-muted">没有请求额外权限。</p> : null}
        {plugin?.tools.length ? <p>工具 · {plugin.tools.map(({ name, effect }) => `${name}（${{ read: '读', write: '写', send: '发' }[effect]}）`).join('、')}</p> : null}
        {preview.warnings.map((warning) => <p key={warning} style={{ color: 'var(--tenghuang)' }}>提醒 · {warning}</p>)}
        {phase === 'confirmed' ? <motion.span aria-hidden="true" ref={mark} className="seals-approval-mark" variants={getPreset('stamp', motionLevel)} initial="initial" animate="animate">准</motion.span> : null}
      </div> : null}
    </Covenant>
  )
}

export function UninstallCovenant({ open, plugin, onClose, onRemoved }: {
  readonly open: boolean
  readonly plugin: ConsolePluginItem | null
  readonly onClose: () => void
  readonly onRemoved: () => void
}) {
  const [keepData, setKeepData] = useState(false)
  const [busy, setBusy] = useState(false)
  const dangerId = useId()

  useEffect(() => {
    if (!open || !plugin) return
    setKeepData(false)
    setBusy(false)
  }, [open, plugin])

  return (
    <Covenant title="卸印" subtitle={plugin?.id} open={open && plugin !== null} onClose={onClose} closeOnBackdrop={!busy} closeOnEscape={!busy}
      footer={plugin ? <div className="seals-form" style={{ justifyItems: 'center' }}>
        <HoldToStamp key={plugin.id} label="卸载" ariaLabel={`按住 0.9 秒以确认：卸载 ${plugin.id}`} ariaDescribedBy={dangerId} onConfirm={async () => {
          setBusy(true)
          try { await pluginsApi.uninstall(plugin.id, { keepData }) }
          catch (err) { setBusy(false); throw err }
        }} onComplete={onRemoved} />
        <BrushButton variant="ghost" disabled={busy} onClick={onClose}>算了</BrushButton>
      </div> : undefined}>
      {plugin ? <div className="seals-form">
        <p id={dangerId}>卸载会停用插件并移除它的工具。关闭保留数据时，插件数据也会删除。</p>
        <InkSwitch checked={keepData} onChange={setKeepData} label="保留数据" disabled={busy} />
      </div> : null}
    </Covenant>
  )
}

export function ManifestDrawer({ plugin, onClose }: { readonly plugin: ConsolePluginItem; readonly onClose: () => void }) {
  const data = { id: plugin.id, version: plugin.version, kinds: plugin.kinds, runtime: plugin.runtime, permissions: plugin.permissions, tools: plugin.tools }
  const text = JSON.stringify(data, null, 2)
  return (
    <ScrollDrawer title="查看清单" open onClose={onClose}>
      <div className="seals-form">
        <p className="seals-muted">已登记的清单字段</p>
        <pre className="seals-code"><code>{text.split(/("(?:[^"\\]|\\.)*")/gu).map((part, index) => index % 2 === 1
          ? <span key={index} style={{ color: 'var(--zhusha)' }}>{part}</span>
          : <span key={index} style={{ color: 'var(--text-2)' }}>{part}</span>)}</code></pre>
      </div>
    </ScrollDrawer>
  )
}
