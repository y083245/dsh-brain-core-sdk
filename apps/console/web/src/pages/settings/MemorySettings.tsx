import { useEffect, useRef, useState } from 'react'
import { memoryApi, settingsApi } from '../../api/client.ts'
import { ApiError, type ConsoleSettingsView, type CrossChannelMode, type MemoryAutomation } from '../../api/types.ts'
import { useConsoleShellData } from '../../shell/ConsoleShell.tsx'
import { BrushButton, Covenant, ErrorState, HoldToStamp, InkSkeleton, InkSwitch, toast } from '../../ui/index.ts'

interface MemorySettingsProps {
  readonly agents: ConsoleSettingsView['agents']
  readonly onSaved: () => void
  readonly goTo: (section: 'models' | 'secrets') => void
}

export function MemorySettings({ agents, onSaved, goTo }: MemorySettingsProps) {
  const { crossChannelMode, refreshCrossChannelMode } = useConsoleShellData()
  const [mode, setMode] = useState<CrossChannelMode>()
  const [automation, setAutomation] = useState<MemoryAutomation>()
  const [loadError, setLoadError] = useState<Error>()
  const [revision, setRevision] = useState(0)
  const [writing, setWriting] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const pending = useRef(false)
  const chat = agents.chat

  useEffect(() => {
    let current = true
    void Promise.all([memoryApi.getCrossChannelMode(), memoryApi.getMemoryAutomation()]).then(([nextMode, nextAutomation]) => {
      if (current) {
        setMode(nextMode)
        setAutomation(nextAutomation)
      }
    }).catch((error: unknown) => {
      if (current) setLoadError(error instanceof Error ? error : new Error('读取记忆设置失败'))
    })
    return () => { current = false }
  }, [agents, revision])

  const activeMode = crossChannelMode ?? mode

  async function save(action: () => Promise<void>): Promise<void> {
    if (pending.current) return
    pending.current = true
    setWriting(true)
    try {
      await action()
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : '保存记忆设置失败',
        error instanceof ApiError ? { code: error.code, requestId: error.requestId } : undefined,
      )
      throw error
    } finally {
      pending.current = false
      setWriting(false)
    }
  }

  function writeCrossChannel(enabled: boolean): Promise<void> {
    const nextMode = enabled ? 'on' : 'off'
    return save(async () => {
      await memoryApi.setCrossChannelMode(nextMode)
      setMode(nextMode)
      await refreshCrossChannelMode()
      toast.success(enabled ? '跨通道记忆已开启' : '跨通道记忆已关闭')
    })
  }

  function writeAutomation(enabled: boolean): Promise<void> {
    return save(async () => {
      setAutomation(await memoryApi.setMemoryAutomation(enabled))
      toast.success(enabled ? '自动整理已开启' : '自动整理已暂停')
    })
  }

  function useChatModel(): Promise<void> {
    const { provider, model, effort } = chat ?? {}
    if (!provider || !model || !effort) return Promise.resolve()
    return save(async () => {
      await settingsApi.saveModelSelection({ agentClass: 'activity', provider, model, effort })
      try {
        setAutomation(await memoryApi.setMemoryAutomation(true))
      } finally {
        onSaved()
      }
      toast.success('已沿用聊天模型并开启自动整理')
    })
  }

  if (loadError) {
    return <ErrorState code={loadError instanceof ApiError ? loadError.code : 'UNAVAILABLE'} message={loadError.message}
      onRetry={() => { setLoadError(undefined); setRevision((previous) => previous + 1) }} />
  }
  if (!activeMode || !automation) return <InkSkeleton rows={2} height={32} />

  return (
    <div className="inktide-settings-memory">
      <div className="inktide-settings-memory-row">
        <InkSwitch label="跨通道记忆" checked={activeMode === 'on'} disabled={writing}
          description="聊天时可以想起其他插件或会话里允许共享的内容。"
          onChange={(enabled) => {
            if (enabled) setConfirm(true)
            else void writeCrossChannel(false).catch(() => undefined)
          }} />
        {activeMode === 'shadow' && <span className="inktide-settings-note">仅记录可用的记忆</span>}
      </div>
      <div className="inktide-settings-memory-row">
        <InkSwitch label="自动整理记忆" checked={automation.enabled}
          disabled={writing || !automation.activityConfigured || !automation.modelKeyConfigured}
          description="定期从已有记录提取有用信息，会使用后台模型额度。"
          onChange={(enabled) => { void writeAutomation(enabled).catch(() => undefined) }} />
        {!automation.modelKeyConfigured ? (
          <BrushButton variant="secondary" onClick={() => goTo('secrets')}>配置模型密钥</BrushButton>
        ) : !automation.activityConfigured ? (
          chat?.provider && chat.model && chat.effort ? (
            <BrushButton variant="secondary" loading={writing} disabled={writing}
              onClick={() => { void useChatModel().catch(() => undefined) }}>沿用聊天模型并开启</BrushButton>
          ) : <BrushButton variant="secondary" onClick={() => goTo('models')}>配置聊天模型</BrushButton>
        ) : agents.activity?.model ? (
          <span className="inktide-settings-note">后台模型 · {agents.activity.model}</span>
        ) : null}
      </div>
      <Covenant open={confirm} title="开启跨通道记忆" onClose={() => setConfirm(false)} footer={<>
        <HoldToStamp label="开启" ariaLabel="按住 0.9 秒以开启跨通道记忆"
          ariaDescribedBy="settings-memory-sharing"
          onConfirm={() => writeCrossChannel(true)} onComplete={() => setConfirm(false)} />
        <BrushButton variant="ghost" onClick={() => setConfirm(false)}>取消</BrushButton>
      </>}>
        <p id="settings-memory-sharing">开启后，符合可见范围的记忆可以在其他会话中使用。每次跨通道使用都会留下审计记录。</p>
      </Covenant>
    </div>
  )
}
