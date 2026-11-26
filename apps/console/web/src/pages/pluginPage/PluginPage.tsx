import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { pluginsApi } from '../../api/client.ts'
import { ApiError, type ConsolePageItem } from '../../api/types.ts'
import { REDUCED_FADE_DURATION } from '../../motion/presets.ts'
import { DUR, EASE } from '../../motion/tokens.ts'
import { useMotionLevel } from '../../motion/useMotionLevel.ts'
import { PluginSeal } from '../../plugins/PluginSeal.tsx'
import { useConsoleShellData } from '../../shell/ConsoleShell.tsx'
import { ErrorState, PageHeader, Plate } from '../../ui/index.ts'
import './pluginPage.css'

export interface PluginPageProps {
  readonly pluginId: string
  readonly pageId: string
}

function PluginLoadError({ error, retry }: { readonly error: unknown; readonly retry: () => void }) {
  return (
    <ErrorState
      code={error instanceof ApiError ? error.code : 'UNAVAILABLE'}
      message={error instanceof Error ? error.message : '加载插件页面失败'}
      requestId={error instanceof ApiError ? error.requestId : undefined}
      onRetry={retry}
    />
  )
}

function CarvingSeal({ pluginId }: { readonly pluginId: string }) {
  const motionLevel = useMotionLevel()
  return (
    <div className="inktide-plugin-page-carving" role="status" aria-label="刻印中">
      <div className="inktide-plugin-page-carving-mark" aria-hidden="true">
        <PluginSeal pluginId={pluginId} size={56} variant="pending" />
        <motion.span
          className="inktide-plugin-page-carving-line"
          initial={false}
          animate={motionLevel === 'full' ? { x: [4, 28, 4] } : { x: 16 }}
          transition={motionLevel === 'full' ? { duration: DUR.brush * 2, repeat: Infinity, ease: EASE.brush } : { duration: REDUCED_FADE_DURATION }}
        />
      </div>
      <span className="inktide-plugin-page-carving-label">正在刻印插件页面</span>
    </div>
  )
}

type EntryState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly url: string }
  | { readonly status: 'failed'; readonly error: unknown }

function PluginFrame({ page }: { readonly page: ConsolePageItem }) {
  const { pluginId, entry, title } = page
  const [revision, setRevision] = useState(0)
  const [entryState, setEntryState] = useState<EntryState>({ status: 'loading' })
  const [frameLoaded, setFrameLoaded] = useState(false)

  useEffect(() => {
    let current = true
    let url: string | undefined

    // Fetch through the validated client so the bearer token never enters the frame URL.
    void Promise.resolve().then(async () => {
      if (!current) return
      const html = await pluginsApi.fetchEntryHtml(pluginId, entry)
      if (!current) return
      url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }))
      setEntryState({ status: 'ready', url })
    }).catch((error: unknown) => {
      if (current) setEntryState({ status: 'failed', error })
    })

    return () => {
      current = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [entry, pluginId, revision])

  if (entryState.status === 'failed') {
    return (
      <PluginLoadError
        error={entryState.error}
        retry={() => {
          setFrameLoaded(false)
          setEntryState({ status: 'loading' })
          setRevision((previous) => previous + 1)
        }}
      />
    )
  }

  return (
    <div className="inktide-plugin-page-frame" aria-busy={!frameLoaded}>
      {!frameLoaded && <CarvingSeal pluginId={pluginId} />}
      {entryState.status === 'ready' && (
        <iframe
          title={title}
          sandbox=""
          referrerPolicy="no-referrer"
          src={entryState.url}
          data-loaded={frameLoaded}
          onLoad={() => setFrameLoaded(true)}
          onError={() => setEntryState({ status: 'failed', error: new Error('插件页面无法显示') })}
        />
      )}
    </div>
  )
}

export function PluginPage({ pluginId, pageId }: PluginPageProps) {
  const { pluginPages, pluginPagesError, pluginPagesLoading, refreshPluginPages } = useConsoleShellData()
  const page = pluginPages.find((item) => item.pluginId === pluginId && item.id === pageId)

  function retry(): void {
    void refreshPluginPages()
  }

  return (
    <>
      <PageHeader label={'PLUGIN · ' + pluginId} title="插件" />
      <Plate className="inktide-plugin-page">
        <header>
          <PluginSeal pluginId={pluginId} size={20} />
          <span className="num">{pluginId}</span>
          {page && <h2>{page.title}</h2>}
        </header>
        {page ? (
          <PluginFrame key={page.entry} page={page} />
        ) : pluginPagesLoading ? (
          <CarvingSeal pluginId={pluginId} />
        ) : pluginPagesError !== undefined ? (
          <PluginLoadError error={pluginPagesError} retry={retry} />
        ) : (
          <ErrorState code="NOT_FOUND" message="未找到该插件页面" onRetry={retry} />
        )}
      </Plate>
    </>
  )
}
