import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { settingsApi } from '../../api/client.ts'
import {
  ApiError,
  type ConsoleSettingsView,
  type RoleCardPreview,
  type RoleTraitInterview,
  type SaveRoleCardInput,
} from '../../api/types.ts'
import { inktideStore } from '../../data/store.ts'
import { useInk } from '../../ink/InkProvider.tsx'
import { getPreset } from '../../motion/presets.ts'
import { DUR } from '../../motion/tokens.ts'
import { useMotionLevel } from '../../motion/useMotionLevel.ts'
import { Badge, BrushButton, BrushTabs, Enso, InkInput, InkText, InkTextarea, MagneticButton, toast } from '../../ui/index.ts'
import { extractRoleSummary, formatRoleOriginLabel, getRoleOriginBadgeTone } from './roleCardPreview.ts'

type RoleMode = SaveRoleCardInput['mode']
type TraitDraft = RoleTraitInterview & { readonly key: number }

const MODES = [
  { id: 'select', label: '选' },
  { id: 'interview', label: '问' },
  { id: 'raw', label: '写' },
] as const

interface RoleCardSettingsProps {
  readonly roleCard: ConsoleSettingsView['roleCard']
  readonly available: readonly string[]
  readonly onSaved: () => void
}

export function RoleCardSettings({ roleCard, available, onSaved }: RoleCardSettingsProps) {
  const [mode, setMode] = useState<RoleMode>('select')
  const [selected, setSelected] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [summary, setSummary] = useState('')
  const [tone, setTone] = useState('')
  const [traits, setTraits] = useState<readonly TraitDraft[]>([
    { key: 0, trait: '', manifestation: '' },
  ])
  const [rawDraft, setRawDraft] = useState<{ readonly name: string; readonly text: string } | null>(null)
  const [displayName, setDisplayName] = useState<string | null>(null)
  const [paint, setPaint] = useState(0)
  const [saving, setSaving] = useState(false)
  const [cardPreview, setCardPreview] = useState<RoleCardPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const nextTraitKey = useRef(1)
  const previewSeq = useRef(0)
  const preview = useRef<HTMLDivElement>(null)
  const ink = useInk()
  const motionLevel = useMotionLevel()
  const rowVariants = useMemo(() => ({
    ...getPreset('bloom', motionLevel),
    exit: getPreset('dissolve', motionLevel).exit!,
  }), [motionLevel])

  useEffect(() => {
    const seq = ++previewSeq.current
    if (mode !== 'select' || selected === null) {
      setPreviewLoading(false)
      setPreviewError(null)
      setCardPreview(null)
      return () => {
        previewSeq.current += 1
      }
    }

    const controller = new AbortController()
    setPreviewLoading(true)
    setPreviewError(null)
    setCardPreview((previous) => (previous?.name === selected ? previous : null))

    void settingsApi.getRoleCard(selected, controller.signal).then(
      (detail) => {
        if (seq !== previewSeq.current) return
        setCardPreview(detail)
        setPreviewLoading(false)
      },
      (error: unknown) => {
        if (seq !== previewSeq.current) return
        setCardPreview(null)
        setPreviewError(error instanceof Error && error.message !== '' ? error.message : '读取角色卡预览失败')
        setPreviewLoading(false)
      },
    )

    return () => {
      previewSeq.current += 1
      controller.abort()
    }
  }, [mode, selected, paint])

  const previewSummary = useMemo(
    () => (cardPreview === null ? '' : extractRoleSummary(cardPreview.text)),
    [cardPreview],
  )

  const raw = rawDraft ?? roleCard ?? { name: '', text: '' }
  const visibleName = displayName ?? roleCard?.name ?? '未选择'
  const interviewComplete = name.trim() !== '' && summary.trim() !== '' && tone.trim() !== ''
    && traits.length > 0 && traits.every(({ trait, manifestation }) => trait.trim() && manifestation.trim())

  function updateTrait(key: number, field: keyof RoleTraitInterview, value: string): void {
    setTraits((previous) => previous.map((row) => row.key === key ? { ...row, [field]: value } : row))
  }

  function getSaveInput(): SaveRoleCardInput | null {
    if (mode === 'select' && selected !== null) {
      return { mode, name: selected }
    }
    if (mode === 'interview' && interviewComplete) {
      return {
        mode,
        interview: {
          name: name.trim(),
          summary: summary.trim(),
          tone: tone.trim(),
          traits: traits.map(({ trait, manifestation }) => ({
            trait: trait.trim(),
            manifestation: manifestation.trim(),
          })),
        },
      }
    }
    if (mode === 'raw' && raw.name.trim() && raw.text.trim()) {
      return { mode, name: raw.name.trim(), text: raw.text }
    }
    return null
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const input = getSaveInput()
    if (saving || input === null) return
    setSaving(true)
    try {
      const result = await settingsApi.saveRoleCard(input)
      setRawDraft(null)
      setDisplayName(result.name)
      setPaint((previous) => previous + 1)
      inktideStore.setRoleCardName(result.name)
      if (motionLevel === 'full' && preview.current) {
        const rect = preview.current.getBoundingClientRect()
        ink.splat({
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          radius: 300,
          amount: 0.3,
          color: 'smoke',
        })
      }
      toast.success('换了角色卡，她会在下次唤醒时用新的人设')
      onSaved()
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : '保存角色卡失败',
        error instanceof ApiError ? { code: error.code, requestId: error.requestId } : undefined,
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="inktide-settings-form" onSubmit={(event) => { void save(event) }}>
      <div className="inktide-settings-role-preview" ref={preview}>
        <span className="inktide-settings-enso-well" data-enso-well="72">
          <Enso
            key={paint}
            size={72}
            state={visibleName === '未选择' ? 'offline' : 'idle'}
            brushInDurationSec={paint > 0 ? DUR.brush : undefined}
          />
        </span>
        <InkText key={visibleName} as="span" text={visibleName} className="title-display" />
      </div>
      <BrushTabs items={MODES} value={mode} onChange={setMode} ariaLabel="角色卡方式" />
      {mode === 'select' && (
        available.length > 0 ? (
          <div className="inktide-settings-role-select-stack">
            <div className="inktide-settings-role-grid">
              {available.map((cardName) => (
                <div
                  key={cardName}
                  className="inktide-settings-role-card-shell"
                  data-selected={selected === cardName ? 'true' : undefined}
                >
                  <div aria-hidden="true" className="plate inktide-settings-role-card-paper" />
                  <button
                    className="inktide-settings-role-card"
                    type="button"
                    aria-pressed={selected === cardName}
                    disabled={saving}
                    onClick={() => setSelected(cardName)}
                  >
                    <span className="inktide-settings-enso-well" data-enso-well="32">
                      <Enso size={32} state={selected === cardName ? 'listening' : 'idle'} />
                    </span>
                    <span>{cardName}</span>
                  </button>
                </div>
              ))}
            </div>
            {selected !== null && (
              <div className="inktide-settings-role-detail" aria-live="polite">
                <div className="inktide-settings-role-detail-head">
                  <strong className="inktide-settings-role-detail-name">{selected}</strong>
                  {cardPreview !== null && cardPreview.name === selected && (
                    <Badge tone={getRoleOriginBadgeTone(cardPreview.origin)}>
                      {formatRoleOriginLabel(cardPreview.origin)}
                    </Badge>
                  )}
                </div>
                {previewSummary !== '' && (
                  <p className="inktide-settings-role-detail-summary">{previewSummary}</p>
                )}
                <p className="inktide-settings-role-detail-hint">
                  选定后，控制台与所有接入插件将统一使用该人设与记忆
                </p>
                {previewLoading && cardPreview?.name !== selected ? (
                  <p className="inktide-settings-role-detail-status">正在读取角色卡内容…</p>
                ) : previewError !== null ? (
                  <p className="inktide-settings-role-detail-error" role="alert">
                    无法加载角色卡预览：{previewError}
                  </p>
                ) : cardPreview !== null ? (
                  <pre className="inktide-settings-role-detail-body">{cardPreview.text}</pre>
                ) : null}
              </div>
            )}
          </div>
        ) : <p className="inktide-settings-note">暂无可选角色卡</p>
      )}
      {mode === 'interview' && (
        <div className="inktide-settings-form">
          <InkInput label="名字" value={name} disabled={saving} onChange={(event) => setName(event.target.value)} />
          <InkInput
            label="一句话简介"
            value={summary}
            disabled={saving}
            onChange={(event) => setSummary(event.target.value)}
          />
          <InkInput label="语气" value={tone} disabled={saving} onChange={(event) => setTone(event.target.value)} />
          <AnimatePresence initial={false}>
            {traits.map(({ key, trait, manifestation }, index) => (
              <motion.div
                key={key}
                className="inktide-settings-trait-row"
                variants={rowVariants}
                initial="initial"
                animate="animate"
                exit="exit"
              >
                <InkInput
                  label="特质名"
                  aria-label={'特质名 ' + String(index + 1)}
                  value={trait}
                  disabled={saving}
                  onChange={(event) => updateTrait(key, 'trait', event.target.value)}
                />
                <InkInput
                  label="怎么表现"
                  aria-label={'怎么表现 ' + String(index + 1)}
                  value={manifestation}
                  disabled={saving}
                  onChange={(event) => updateTrait(key, 'manifestation', event.target.value)}
                />
                <BrushButton
                  variant="ghost"
                  size="sm"
                  aria-label={'删除特质 ' + String(index + 1)}
                  disabled={saving}
                  onClick={() => setTraits((previous) => previous.filter((item) => item.key !== key))}
                >
                  删除
                </BrushButton>
              </motion.div>
            ))}
          </AnimatePresence>
          <div>
            <BrushButton
              variant="secondary"
              disabled={saving}
              onClick={() => {
                const key = nextTraitKey.current++
                setTraits((previous) => [...previous, { key, trait: '', manifestation: '' }])
              }}
            >
              新增特质
            </BrushButton>
          </div>
        </div>
      )}
      {mode === 'raw' && (
        <div className="inktide-settings-form">
          <InkInput
            label="名字"
            value={raw.name}
            disabled={saving}
            onChange={(event) => setRawDraft({ ...raw, name: event.target.value })}
          />
          <InkTextarea
            label="角色卡原文"
            rows={16}
            value={raw.text}
            disabled={saving}
            onChange={(event) => setRawDraft({ ...raw, text: event.target.value })}
          />
        </div>
      )}
      <div>
        <MagneticButton disabled={saving || getSaveInput() === null}>
          <BrushButton variant="primary" type="submit" disabled={getSaveInput() === null} loading={saving}>
            保存角色卡
          </BrushButton>
        </MagneticButton>
      </div>
    </form>
  )
}
