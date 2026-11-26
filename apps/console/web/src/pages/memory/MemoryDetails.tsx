import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { memoryApi } from '../../api/client.ts'
import { ApiError, VISIBILITIES, type EvidenceNode, type MemoryRecord, type RecordPatch, type Visibility } from '../../api/types.ts'
import { formatTimestamp } from '../../lib/memoryHelpers.ts'
import { getPreset } from '../../motion/presets.ts'
import { useMotionLevel } from '../../motion/useMotionLevel.ts'
import { Badge, BrushButton, EmptyState, InkInput, InkNumber, InkSelect, InkSkeleton, InkSlider, InkTextarea, LayerTag, Plate, ScrollDrawer, toast } from '../../ui/index.ts'
import { InkMetric, notifyRequestError, OutdatedBrushStrike, recordSummary, recordsById, RequestError, shortDate, useResource } from './common.tsx'

interface DetailProps {
  readonly trail: readonly string[]
  readonly covenantOpen?: boolean
  readonly onFollow: (record: MemoryRecord) => void
  readonly onBack: (index: number) => void
  readonly onClose: () => void
  readonly onChange: (record: MemoryRecord) => void
  readonly onForget: (record: MemoryRecord) => void
  readonly onHeart: () => void
}

const DISPLAYED_EVIDENCE = 20
const COPY_FEEDBACK_MS = 1400

const WRAPPABLE_LINK_BUTTON_STYLE: CSSProperties = {
  maxWidth: '100%',
  minWidth: 0,
  whiteSpace: 'normal',
  textAlign: 'left',
  justifyContent: 'flex-start',
  height: 'auto',
  paddingBlock: 'var(--sp-1)',
  lineHeight: 'var(--lh-small)',
}

async function downstreamTree(id: string): Promise<readonly EvidenceNode[]> {
  const expanded = new Set([id])
  async function visit(source: string): Promise<readonly EvidenceNode[]> {
    const result: EvidenceNode[] = []
    for (const record of await memoryApi.getDependents(source)) {
      if (record.id === id || record.status === 'tombstoned') continue
      const repeat = expanded.has(record.id)
      expanded.add(record.id)
      // Keep every direct relationship visible without expanding the same subtree twice.
      result.push({ record, children: repeat ? [] : await visit(record.id) })
    }
    return result
  }
  return visit(id)
}

function Branches({ nodes, follow }: { nodes: readonly EvidenceNode[]; follow: DetailProps['onFollow'] }) {
  return <ul className="memory-evidence-tree">{nodes.map(({ record, children }) =>
    <li key={record.id}>
      <BrushButton variant="ghost" size="sm" style={WRAPPABLE_LINK_BUTTON_STYLE} onClick={() => follow(record)}>
        <LayerTag layer={record.layer} /> {recordSummary(record)}
      </BrushButton>
      {children.length > 0 && <Branches nodes={children} follow={follow} />}
    </li>
  )}</ul>
}

function RecordEditor({ record, onSave, onCancel }: {
  record: MemoryRecord
  onSave: (record: MemoryRecord) => void
  onCancel: () => void
}) {
  const textFields = Object.entries(record.content)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  const [fields, setFields] = useState<Record<string, string>>(() => Object.fromEntries(textFields))
  const [subjects, setSubjects] = useState(record.subjects)
  const [subject, setSubject] = useState('')
  const [visibility, setVisibility] = useState<Visibility>(record.visibility)
  const [confidence, setConfidence] = useState(record.confidence)
  const [importance, setImportance] = useState(record.importance)
  const [latest, setLatest] = useState<MemoryRecord>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<unknown>()

  function addSubject() {
    const clean = subject.trim()
    if (clean && !subjects.includes(clean)) setSubjects([...subjects, clean])
    setSubject('')
  }

  async function save(base: MemoryRecord) {
    if (saving) return
    setSaving(true)
    setError(undefined)
    const allSubjects = subject.trim() ? [...new Set([...subjects, subject.trim()])] : subjects
    const patch: RecordPatch = {
      content: { ...base.content, ...fields },
      subjects: allSubjects,
      visibility,
      confidence,
      importance,
    }
    try {
      const updated = await memoryApi.updateRecord(record.id, patch, base.version)
      toast.success('记忆已更新')
      onSave(updated)
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'CONFLICT') {
        try {
          const current = await memoryApi.getRecord(record.id)
          if (current && current.status !== 'tombstoned') setLatest(current)
          else setError(cause)
        } catch (readError) {
          setError(readError)
        }
      } else {
        setError(cause)
      }
    } finally {
      setSaving(false)
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    void save(record)
  }

  return <form className="memory-stack" onSubmit={submit}>
    {latest && <Plate tone="warn" level="sunken" className="memory-inset" aria-live="polite">
      这条记忆刚被改过（现在是 v{latest.version}）
      <div className="memory-actions">
        <BrushButton variant="secondary" disabled={saving} onClick={() => onSave(latest)}>看最新的</BrushButton>
        <BrushButton variant="secondary" disabled={saving} onClick={() => void save(latest)}>用我的覆盖</BrushButton>
      </div>
    </Plate>}
    {error !== undefined && <RequestError error={error} retry={() => void save(latest ?? record)} />}
    {textFields.map(([key]) =>
      <InkTextarea key={key} label={key} value={fields[key] ?? ''} onChange={(event) =>
        setFields({ ...fields, [key]: event.target.value })} />)}
    <div className="memory-stack">
      <div className="memory-actions" aria-label="主体标签">
        {subjects.map((item) => <BrushButton key={item} variant="ghost" size="sm"
          aria-label={`移除主体 ${item}`} onClick={() => setSubjects(subjects.filter((person) => person !== item))}>
          {item} ×
        </BrushButton>)}
      </div>
      <div className="memory-actions">
        <InkInput label="主体" value={subject} onChange={(event) => setSubject(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); addSubject() } }} />
        <BrushButton variant="secondary" onClick={addSubject}>添加主体</BrushButton>
      </div>
    </div>
    <InkSelect label="可见性" value={visibility}
      options={VISIBILITIES.map((value) => ({ value, label: value }))}
      onChange={setVisibility} />
    <InkSlider label="置信度" min={0} max={1} step={0.01} value={confidence} onChange={setConfidence} />
    <InkSlider label="重要度" min={0} max={1} step={0.01} value={importance} onChange={setImportance} />
    <div className="memory-actions">
      <BrushButton type="submit" variant="primary" loading={saving} disabled={latest !== undefined}>保存</BrushButton>
      <BrushButton variant="ghost" onClick={onCancel}>取消</BrushButton>
    </div>
  </form>
}

function DetailBody({ id, follow, onChange, onForget, onHeart, onResolved }: {
  id: string
  follow: DetailProps['onFollow']
  onChange: DetailProps['onChange']
  onForget: DetailProps['onForget']
  onHeart: DetailProps['onHeart']
  onResolved: (record: MemoryRecord) => void
}) {
  const loadRecord = useCallback(() => memoryApi.getRecord(id), [id])
  const recordSource = useResource(loadRecord)
  const [modified, setModified] = useState<MemoryRecord>()
  const record = modified ?? recordSource.data
  const [editing, setEditing] = useState(false)
  const [statusPending, setStatusPending] = useState(false)
  const [shownEvidence, setShownEvidence] = useState(DISPLAYED_EVIDENCE)
  const refs = record?.evidence
  const loadEvidence = useCallback(() => recordsById((refs ?? []).slice(0, shownEvidence).map((reference) => reference.id)), [refs, shownEvidence])
  const evidence = useResource(loadEvidence, Boolean(refs?.length))
  const loadDependents = useCallback(() => downstreamTree(id), [id])
  const dependents = useResource(loadDependents, Boolean(record))
  const loadAudit = useCallback(() => memoryApi.listAudit(id), [id])
  const audit = useResource(loadAudit, Boolean(record))
  const reduced = useMotionLevel() === 'reduced'
  const editPreset = getPreset('bloom', reduced ? 'reduced' : 'full')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (record && record.status !== 'tombstoned') onResolved(record)
  }, [onResolved, record])

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS)
    return () => window.clearTimeout(timer)
  }, [copied])

  if (recordSource.error !== undefined) return <RequestError error={recordSource.error} retry={recordSource.reload} />
  if (recordSource.loading) return <InkSkeleton rows={4} />
  if (!record || record.status === 'tombstoned') return <EmptyState glyph="无痕" description="这条记忆已不可用。" />

  function applyUpdate(updated: MemoryRecord) {
    setModified(updated)
    setEditing(false)
    onChange(updated)
  }

  async function toggleStatus() {
    if (!record || statusPending) return
    setStatusPending(true)
    try {
      const status = record.status === 'outdated' ? 'active' : 'outdated'
      applyUpdate(await memoryApi.updateRecord(id, { status }, record.version))
      toast.success(status === 'active' ? '记忆已恢复' : '记忆已标过时')
    } catch (error) {
      notifyRequestError(error)
      if (error instanceof ApiError && error.code === 'CONFLICT') {
        try {
          const latest = await memoryApi.getRecord(id)
          if (latest) applyUpdate(latest)
        } catch (readError) {
          notifyRequestError(readError)
        }
      }
    } finally {
      setStatusPending(false)
    }
  }

  const fields = Object.entries(record.content).filter(([key]) => key !== 'text')
  const titleText = typeof record.content.text === 'string' ? record.content.text : recordSummary(record)
  return <div className="memory-stack">
    <BrushButton variant="ghost" size="sm" className="num memory-copy" style={WRAPPABLE_LINK_BUTTON_STYLE} title="复制记录 ID"
      onClick={() => { void navigator.clipboard?.writeText(record.id).then(() => setCopied(true), notifyRequestError) }}>
      {copied ? '已复制' : record.id}
    </BrushButton>
    {editing ? <RecordEditor key={record.version} record={record} onSave={applyUpdate} onCancel={() => setEditing(false)} /> :
      <motion.div key={record.version} className="memory-stack" variants={editPreset} initial="initial" animate="animate">
        <h3 className={`memory-detail-title${record.status === 'outdated' ? ' memory-outdated' : ''}`}>
          <OutdatedBrushStrike active={record.status === 'outdated'}>{titleText}</OutdatedBrushStrike>
        </h3>
        <dl className="memory-detail-meta">
          <dt>主体</dt><dd>{record.subjects.join('、') || '—'}</dd><dt>通道</dt><dd>{record.channel}</dd>
          <dt>来源</dt><dd>{record.source}</dd><dt>可信度</dt><dd>{record.trust}</dd>
          <dt>可见</dt><dd>{record.visibility}</dd><dt>版本</dt><dd>v<InkNumber value={record.version} /></dd>
          <dt>发生</dt><dd>{formatTimestamp(record.tEvent)}</dd><dt>写入</dt><dd>{formatTimestamp(record.tIngest)}</dd>
        </dl>
        <div className="memory-actions"><InkMetric label="置信" value={record.confidence} /><InkMetric label="重要" value={record.importance} /></div>
        {fields.length > 0 && <dl className="memory-content-fields num">{fields.map(([key, value]) =>
          <div key={key}><dt>{key}</dt><dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd></div>
        )}</dl>}
        <section className="memory-detail-section">
          <h4>依据（证据）</h4>
          {evidence.error !== undefined ? <RequestError error={evidence.error} retry={evidence.reload} /> :
            evidence.loading ? <InkSkeleton rows={2} /> :
              record.evidence.length === 0 ? <p>未记录依据。</p> :
                <ul className="memory-evidence-tree">{record.evidence.slice(0, shownEvidence).map(({ id: refId }) => {
                  const target = evidence.data?.get(refId)
                  return <li key={refId}>{target
                    ? <BrushButton variant="ghost" size="sm" style={WRAPPABLE_LINK_BUTTON_STYLE} onClick={() => follow(target)}>
                      <LayerTag layer={target.layer} /> <span className="num">{shortDate(target.tEvent)}</span> {recordSummary(target)}
                    </BrushButton>
                    : <span className="num">{refId} · 不可用</span>}</li>
                })}</ul>}
          {shownEvidence < record.evidence.length && <BrushButton variant="secondary" size="sm"
            onClick={() => setShownEvidence(shownEvidence + DISPLAYED_EVIDENCE)}>
            再看 {Math.min(DISPLAYED_EVIDENCE, record.evidence.length - shownEvidence)} 条
          </BrushButton>}
        </section>
        <section className="memory-detail-section">
          <h4>用在了哪里</h4>
          {dependents.error !== undefined ? <RequestError error={dependents.error} retry={dependents.reload} /> :
            dependents.loading ? <InkSkeleton rows={2} /> :
              dependents.data?.length ? <Branches nodes={dependents.data} follow={follow} /> : <p>还没有被别的记忆引用。</p>}
        </section>
        <section className="memory-detail-section">
          <h4>审计</h4>
          {audit.error !== undefined ? <RequestError error={audit.error} retry={audit.reload} /> :
            audit.loading ? <InkSkeleton rows={2} /> :
              audit.data?.length ? <ul className="memory-evidence-tree">{audit.data.map((item, index) =>
                <li key={index}>{shortDate(item.tAt)} · {item.viewerChannel} <Badge>{item.mode}</Badge></li>
              )}</ul> : <p>没有跨通道记录。</p>}
        </section>
        <div className="memory-actions">
          {record.layer === 'L3' ? <BrushButton variant="secondary" onClick={onHeart}>去「心」页管理</BrushButton> : <>
            {record.layer !== 'L0' && <BrushButton variant="secondary" onClick={() => setEditing(true)}>编辑</BrushButton>}
            {record.layer !== 'L0' && <BrushButton variant="secondary" loading={statusPending}
              onClick={() => void toggleStatus()}>{record.status === 'outdated' ? '恢复有效' : '标过时'}</BrushButton>}
            <BrushButton variant="danger" className="memory-action-end" onClick={() => onForget(record)}>遗忘…</BrushButton>
          </>}
        </div>
      </motion.div>}
  </div>
}

export function MemoryDetails({
  trail,
  covenantOpen = false,
  onFollow,
  onBack,
  onClose,
  onChange,
  onForget,
  onHeart,
}: DetailProps) {
  const id = trail.at(-1)
  const [known, setKnown] = useState<ReadonlyMap<string, MemoryRecord>>(new Map())
  const learn = useCallback((record: MemoryRecord) =>
    setKnown((previous) => previous.get(record.id) === record ? previous : new Map(previous).set(record.id, record)), [])
  const selected = id ? known.get(id) : undefined
  const follow = useCallback((record: MemoryRecord) => {
    learn(record)
    onFollow(record)
  }, [learn, onFollow])
  const motionLevel = useMotionLevel()
  const variant = { ...getPreset('bloom', motionLevel), exit: getPreset('dissolve', motionLevel).exit! }
  return <ScrollDrawer open={id !== undefined} onClose={onClose} size="md"
    closeOnEscape={!covenantOpen} closeOnBackdrop={!covenantOpen}
    title={selected ? <span className="memory-actions"><LayerTag layer={selected.layer} /><span className="num">{selected.kind}</span></span> : '记忆详情'}>
    {trail.length > 1 && <nav className="memory-breadcrumb" aria-label="证据追溯">
      {trail.map((entry, index) => <BrushButton key={`${index}:${entry}`} size="sm" variant="ghost"
        style={WRAPPABLE_LINK_BUTTON_STYLE}
        disabled={index === trail.length - 1} onClick={() => onBack(index)}
        title={entry}>{index ? '› ' : ''}{known.has(entry) ? recordSummary(known.get(entry)!, 22) : entry.slice(0, 16)}</BrushButton>)}
    </nav>}
    <AnimatePresence mode="wait" initial={false}>
      {id && <motion.div key={id} style={{ minWidth: 0 }} variants={variant} initial="initial" animate="animate" exit="exit">
        <DetailBody id={id} follow={follow} onChange={onChange} onForget={onForget} onHeart={onHeart} onResolved={learn} />
      </motion.div>}
    </AnimatePresence>
  </ScrollDrawer>
}
