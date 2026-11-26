import { useRef, useState, type FormEvent } from 'react'
import { LockKeyhole } from 'lucide-react'
import { memoryApi } from '../../api/client.ts'
import { ApiError, type L3ProfileVersionSummary } from '../../api/types.ts'
import { BrushButton } from '../../ui/BrushButton.tsx'
import { InkInput, InkTextarea } from '../../ui/InkInput.tsx'
import { InkSwitch } from '../../ui/InkSwitch.tsx'
import { MagneticButton } from '../../ui/MagneticButton.tsx'
import { Plate } from '../../ui/Plate.tsx'
import { ScrollDrawer } from '../../ui/ScrollDrawer.tsx'

interface Field {
  readonly id: number
  readonly name: string
  readonly value: string
  readonly locked: boolean
  readonly previouslyLocked: boolean
}

export function ProfileEditor({ version, onSaved, onClose }: {
  readonly version: L3ProfileVersionSummary
  readonly onSaved: (version: number) => Promise<void>
  readonly onClose: () => void
}) {
  const initialLocks = new Set(version.ownerLockedKeys)
  const [stable, setStable] = useState(version.stable ?? '')
  const [fields, setFields] = useState<Field[]>(() => Object.entries(version.data ?? {}).map(([name, value], id) => ({
    id, name, value: JSON.stringify(value) ?? 'null',
    locked: initialLocks.has(name), previouslyLocked: initialLocks.has(name),
  })))
  const nextId = useRef(fields.length)
  const busy = useRef(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const edit = (id: number, patch: Partial<Field>): void => {
    setFields((current) => current.map((field) => field.id === id ? { ...field, ...patch } : field))
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (busy.current) return
    setError('')
    const entries: [string, unknown][] = []
    const lockedKeys: string[] = []
    const seen = new Set<string>()
    for (const field of fields) {
      const key = field.name.trim()
      if (key === '' || seen.has(key)) {
        setError('键名不得为空或重复。')
        return
      }
      seen.add(key)
      try {
        entries.push([key, JSON.parse(field.value) as unknown])
      } catch {
        setError(`「${key}」需要有效的 JSON 值，文本请用双引号括起。`)
        return
      }
      if (field.locked) lockedKeys.push(key)
    }
    busy.current = true
    setSaving(true)
    try {
      const result = await memoryApi.editL3ByOwner({ stable, data: Object.fromEntries(entries), lockedKeys })
      await onSaved(result.version)
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code} · ${err.message}` : '改写失败，请重试。')
    } finally {
      busy.current = false
      setSaving(false)
    }
  }

  return (
    <ScrollDrawer open title="改写" size="lg" onClose={onClose} closeOnEscape={!saving} closeOnBackdrop={!saving}>
      <form className="heart-panel" onSubmit={(event) => { void save(event) }}>
        <div className="heart-editor">
          <InkTextarea label="稳定文本" rows={18} value={stable} onChange={(event) => setStable(event.target.value)} disabled={saving} />
          <div className="heart-editor-rows">
            <p className="heart-muted">每项按 JSON 编辑。保存后，修改过的键会自动锁定。</p>
            {fields.map((field) => (
              <Plate key={field.id} level="sunken" className="heart-editor-row">
                <InkInput label="键名" value={field.name} onChange={(event) => edit(field.id, { name: event.target.value })} readOnly={field.id < Object.keys(version.data ?? {}).length} disabled={saving} monospace />
                <InkTextarea label="值（JSON）" rows={2} value={field.value} onChange={(event) => edit(field.id, { value: event.target.value })} disabled={saving} />
                <div className="heart-actions">
                  {field.previouslyLocked ? <span className="heart-keys"><LockKeyhole size={14} aria-hidden="true" /> 主人已锁定</span> : (
                    <InkSwitch checked={field.locked} onChange={(locked) => edit(field.id, { locked })} label="锁定" disabled={saving} />
                  )}
                  <BrushButton variant="ghost" size="sm" disabled={saving} onClick={() => setFields((current) => current.filter(({ id }) => id !== field.id))}>移除键</BrushButton>
                </div>
              </Plate>
            ))}
            <BrushButton variant="secondary" disabled={saving} onClick={() => {
              const id = nextId.current++
              setFields((current) => [...current, { id, name: '', value: '""', locked: false, previouslyLocked: false }])
            }}>添加键</BrushButton>
          </div>
        </div>
        {error ? <p role="alert" style={{ color: 'var(--yanzhi)' }}>{error}</p> : null}
        <div className="heart-actions">
          <MagneticButton disabled={saving}>
            <BrushButton variant="primary" type="submit" loading={saving}>保存改写</BrushButton>
          </MagneticButton>
          <BrushButton variant="ghost" disabled={saving} onClick={onClose}>算了</BrushButton>
        </div>
      </form>
    </ScrollDrawer>
  )
}
