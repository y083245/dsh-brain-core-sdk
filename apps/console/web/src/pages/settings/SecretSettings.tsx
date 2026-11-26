import { useRef, useState, type FormEvent } from 'react'
import { settingsApi } from '../../api/client.ts'
import { ApiError } from '../../api/types.ts'
import { BrushButton, InkInput, MagneticButton, Plate, toast } from '../../ui/index.ts'

interface SecretSettingsProps {
  readonly names: readonly string[]
  readonly sharedQuota: boolean
  readonly onSaved: () => void
}

export function SecretSettings({ names, sharedQuota, onSaved }: SecretSettingsProps) {
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const valueInput = useRef<HTMLInputElement>(null)

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const trimmedName = name.trim()
    if (saving || !trimmedName || !value) return
    setSaving(true)
    try {
      await settingsApi.saveSecret({ name: trimmedName, value })
      setValue('')
      setName('')
      toast.success('已存入密钥库（600）')
      onSaved()
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : '保存密钥失败',
        error instanceof ApiError ? { code: error.code, requestId: error.requestId } : undefined,
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="inktide-settings-form">
      {sharedQuota && <Plate tone="warn" className="inktide-settings-notice">与主 DSH 共用配额</Plate>}
      {names.length > 0 && (
        <ul className="inktide-settings-secret-list">
          {names.map((secretName) => (
            <li key={secretName}>
              <span className="num">{secretName}</span>
              <BrushButton
                variant="secondary"
                disabled={saving}
                aria-label={'替换 ' + secretName}
                onClick={() => {
                  setName(secretName)
                  setValue('')
                  valueInput.current?.focus()
                }}
              >
                替换
              </BrushButton>
            </li>
          ))}
        </ul>
      )}
      <form
        className="inktide-settings-secret-row"
        autoComplete="off"
        onSubmit={(event) => { void save(event) }}
      >
        <InkInput label="名字" value={name} disabled={saving} onChange={(event) => setName(event.target.value)} />
        <InkInput
          ref={valueInput}
          label="值"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          disabled={saving}
          onChange={(event) => setValue(event.target.value)}
        />
        <MagneticButton disabled={saving || !name.trim() || !value}>
          <BrushButton variant="primary" type="submit" disabled={!name.trim() || !value} loading={saving}>保存</BrushButton>
        </MagneticButton>
      </form>
    </div>
  )
}
