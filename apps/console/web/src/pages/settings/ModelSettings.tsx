import { useRef, useState, type FormEvent } from 'react'
import { settingsApi } from '../../api/client.ts'
import {
  ApiError,
  EFFORT_LABELS,
  MODEL_CATALOG,
  type AgentClass,
  type ConsoleSettingsView,
  type ModelSelection,
  type SaveModelSelectionInput,
  type ThinkingEffort,
} from '../../api/types.ts'
import { BrushButton, InkSelect, MagneticButton, toast } from '../../ui/index.ts'

const providerOptions = [...new Set(MODEL_CATALOG.map(({ provider }) => provider))]
  .map((provider) => ({ value: provider, label: provider }))

interface ModelFormProps {
  readonly agentClass: AgentClass
  readonly saved: Partial<ModelSelection> | undefined
  readonly savingClass: AgentClass | null
  readonly onSave: (selection: SaveModelSelectionInput) => void
}

function ModelForm({ agentClass, saved, savingClass, onSave }: ModelFormProps) {
  const [provider, setProvider] = useState<string | null>(null)
  const [model, setModel] = useState<string | null>(null)
  const [effort, setEffort] = useState<ThinkingEffort | null>(null)
  const disabled = savingClass !== null

  const availableModels = MODEL_CATALOG.filter((entry) => entry.provider === provider)
  const selection = availableModels.find((entry) => entry.model === model)

  function save(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (disabled || !selection || effort === null || !selection.efforts.includes(effort)) return
    onSave({ agentClass, provider: selection.provider, model: selection.model, effort })
  }

  return (
    <form className="inktide-settings-form" aria-label={agentClass} onSubmit={save}>
      <div className="inktide-settings-row-heading">
        <h3 className="num">{agentClass}</h3>
        {saved?.provider && saved.model && saved.effort ? (
          <span className="num inktide-settings-note">
            已配置 {saved.provider} / {saved.model} / {saved.effort}
          </span>
        ) : null}
      </div>
      <div className="inktide-settings-model-row">
        <InkSelect
          label="提供方"
          ariaLabel={agentClass + ' 提供方'}
          options={providerOptions}
          value={provider}
          onChange={(value) => {
            setProvider(value)
            setModel(null)
            setEffort(null)
          }}
          disabled={disabled}
        />
        <InkSelect
          label="模型"
          ariaLabel={agentClass + ' 模型'}
          options={availableModels.map((entry) => ({ value: entry.model, label: entry.model }))}
          value={model}
          onChange={(value) => {
            setModel(value)
            setEffort(null)
          }}
          disabled={provider === null || disabled}
        />
        <InkSelect
          label="思考强度"
          ariaLabel={agentClass + ' 思考强度'}
          options={(selection?.efforts ?? []).map((value) => ({
            value,
            label: value === 'model-default' ? '跟随模型默认' : EFFORT_LABELS[value],
          }))}
          value={effort}
          onChange={setEffort}
          disabled={selection === undefined || disabled}
        />
        <MagneticButton disabled={disabled || effort === null || !selection}>
          <BrushButton
            variant="primary"
            type="submit"
            disabled={disabled || effort === null || !selection}
            loading={savingClass === agentClass}
          >
            保存
          </BrushButton>
        </MagneticButton>
      </div>
      {selection?.supportsImages === false && <p className="inktide-settings-note">不支持图片</p>}
      {selection?.toolUpdate === 'fixed' && <p className="inktide-settings-note">会话中不能追加工具</p>}
      {effort === 'model-default' && <p className="inktide-settings-note">适配器实际发送的是 high</p>}
    </form>
  )
}

interface ModelSettingsProps {
  readonly agents: ConsoleSettingsView['agents']
  readonly onSaved: () => void
}

export function ModelSettings({ agents, onSaved }: ModelSettingsProps) {
  const [savingClass, setSavingClass] = useState<AgentClass | null>(null)
  const pending = useRef(false)

  async function save(selection: SaveModelSelectionInput): Promise<void> {
    if (pending.current) return
    pending.current = true
    setSavingClass(selection.agentClass)
    try {
      await settingsApi.saveModelSelection(selection)
      toast.success('已保存模型')
      onSaved()
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : '保存模型失败',
        error instanceof ApiError ? { code: error.code, requestId: error.requestId } : undefined,
      )
    } finally {
      pending.current = false
      setSavingClass(null)
    }
  }

  return (
    <>
      {(['chat', 'activity'] as const).map((agentClass) => (
        <ModelForm
          key={agentClass}
          agentClass={agentClass}
          saved={agents[agentClass]}
          savingClass={savingClass}
          onSave={(selection) => { void save(selection) }}
        />
      ))}
    </>
  )
}
