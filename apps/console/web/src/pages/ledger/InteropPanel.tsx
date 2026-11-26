import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { satelliteApi } from '../../api/client.ts'
import { ApiError, type InteropSnapshot } from '../../api/types.ts'
import { usePolling } from '../../data/polling.ts'
import { REDUCED_FADE_DURATION } from '../../motion/presets.ts'
import { DUR, EASE } from '../../motion/tokens.ts'
import { useMotionLevel } from '../../motion/useMotionLevel.ts'
import { useConsoleShellData } from '../../shell/ConsoleShell.tsx'
import { BrushButton } from '../../ui/BrushButton.tsx'
import { InkNumber } from '../../ui/InkNumber.tsx'
import { InkSwitch } from '../../ui/InkSwitch.tsx'
import { ErrorState, InkSkeleton } from '../../ui/InkStates.tsx'
import { MagneticButton } from '../../ui/MagneticButton.tsx'
import { Plate } from '../../ui/Plate.tsx'
import { toast } from '../../ui/SealToast.tsx'

// The gateway exposes these six fixed aliases; the snapshot exposes their enabled flag.
const AMP_VERBS = ['recall', 'encode', 'forget', 'pin', 'consolidate', 'stats'] as const

function readonlyPatch(yaml: string): string {
  return yaml.replace(/^(\s*Authorization\s*:)\s*.*$/gimu, '$1 "Bearer <MCP_TOKEN>"')
}

function safeDebugUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) return undefined
    return url.href
  } catch {
    return undefined
  }
}

function DebugTimer({ startedAt }: { readonly startedAt: number }) {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const update = (): void => setSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)))
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [startedAt])
  return <><InkNumber value={seconds} /> 秒</>
}

export function InteropPanel() {
  const { satellite, accounting } = useConsoleShellData()
  const level = useMotionLevel()
  const request = usePolling(() => satelliteApi.interop(), 0)
  const [updated, setUpdated] = useState<InteropSnapshot | null>(null)
  const [runningAt, setRunningAt] = useState<number | null>(null)
  const [detectedAt] = useState(() => Date.now())
  const [busy, setBusy] = useState<'amp' | 'mcp' | 'debug' | null>(null)
  const inFlight = useRef(false)
  const copyTimer = useRef<number | null>(null)
  const [copied, setCopied] = useState(false)
  const data = updated ?? request.data
  const patch = data?.mcp.patchYaml ? readonlyPatch(data.mcp.patchYaml) : null
  const debugUrl = safeDebugUrl(data?.debugView.url)

  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
  }, [])

  async function act(kind: Exclude<typeof busy, null>, update: () => Promise<InteropSnapshot>): Promise<void> {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(kind)
    try {
      const next = await update()
      if (kind === 'debug') setRunningAt(next.debugView.running ? Date.now() : null)
      setUpdated(next)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '互联设置更新失败。', { code: err instanceof ApiError ? err.code : undefined })
    } finally {
      inFlight.current = false
      setBusy(null)
    }
  }

  async function copy(): Promise<void> {
    if (patch === null) return
    try {
      await navigator.clipboard.writeText(patch)
      setCopied(true)
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => setCopied(false), 1200)
    } catch {
      toast.error('复制失败，请手动选取配置模板。')
    }
  }

  if (!data) {
    const error = request.error
    return error instanceof Error
      ? <ErrorState message={error.message} code={error instanceof ApiError ? error.code : undefined} onRetry={() => { void request.refresh() }} />
      : <InkSkeleton rows={3} height={90} />
  }

  return (
    <>
      {(satellite?.sharedQuotaWarning ?? accounting?.sharedQuotaWarning) ? <Plate tone="warn" className="ledger-panel" role="status">与主 DSH 共用配额</Plate> : null}
      <div className="ledger-interop">
        <Plate as="section" className="ledger-panel">
          <h2>AMP 别名</h2>
          <p className="ledger-muted">为既有记忆工具启用 AMP 的六个动词别名。</p>
          <InkSwitch label="AMP 别名" checked={data.ampAliases} disabled={busy !== null} onChange={(value) => { void act('amp', () => satelliteApi.setAmpAliases(value)) }} />
          {data.ampAliases ? <div className="ledger-amp">{AMP_VERBS.map((verb) => <code title={`amp__${verb}`} key={verb}>{verb}</code>)}</div> : null}
        </Plate>
        <Plate as="section" className="ledger-panel">
          <h2>只读 MCP</h2>
          <p className="ledger-muted">为只读记忆访问生成本机配置。</p>
          <InkSwitch label="只读 MCP" checked={data.mcp.enabled} disabled={busy !== null} onChange={(value) => { void act('mcp', () => satelliteApi.setReadOnlyMcp(value)) }} />
          <p>{data.mcp.running ? '运行中' : data.mcp.enabled ? '已启用，未运行' : '已关闭'}</p>
          {patch !== null ? (
            <>
              <div className="ledger-code" style={{ borderColor: copied ? 'var(--zhusha)' : undefined, transition: level === 'full' ? `border-color ${Math.round(DUR.quick * 1000)}ms ease` : undefined }}>
                <div className="ledger-heading">
                  <code>--patch YAML</code>
                  <BrushButton variant="ghost" size="sm" onClick={() => { void copy() }}>{copied ? '已复制' : '复制'}</BrushButton>
                </div>
                <pre><code>{patch}</code></pre>
              </div>
              <p className="ledger-muted">配置模板中的 MCP 密钥使用占位符。</p>
            </>
          ) : null}
        </Plate>
        <Plate as="section" className="ledger-panel">
          <h2>调试视图</h2>
          <p className="ledger-muted">打开隔离运行时的本机调试视图。</p>
          {data.debugView.running ? (
            <div className="ledger-book">
              <p role="status">
                <motion.span className="ledger-running" aria-hidden="true"
                  animate={level === 'full' ? { opacity: [1, 0.4, 1] } : { opacity: 1 }}
                  transition={level === 'full' ? { repeat: Infinity, duration: DUR.brush * 2.5, ease: EASE.brush } : { duration: REDUCED_FADE_DURATION }} />
                {runningAt === null ? '本页检测到运行' : '已运行'} <DebugTimer startedAt={runningAt ?? detectedAt} />
              </p>
              {debugUrl ? <a className="num" href={debugUrl} target="_blank" rel="noopener noreferrer">打开调试视图</a> : null}
              <BrushButton variant="secondary" disabled={busy !== null} loading={busy === 'debug'} onClick={() => { void act('debug', () => satelliteApi.stopDebugView()) }}>停止</BrushButton>
            </div>
          ) : (
            <div>
              <MagneticButton disabled={busy !== null}>
                <BrushButton variant="primary" disabled={busy !== null} loading={busy === 'debug'} onClick={() => { void act('debug', () => satelliteApi.startDebugView()) }}>开始</BrushButton>
              </MagneticButton>
            </div>
          )}
        </Plate>
      </div>
    </>
  )
}
