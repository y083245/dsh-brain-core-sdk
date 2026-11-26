import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { animate, AnimatePresence, motion, useMotionValue, type PanInfo } from 'motion/react'
import { Ellipsis } from 'lucide-react'
import { memoryApi } from '../../api/client.ts'
import type { MemoryRecord, PersonSummary } from '../../api/types.ts'
import { useInk } from '../../ink/InkProvider.tsx'
import { getPreset } from '../../motion/presets.ts'
import { COVENANT_LOCK_MS, DUR, SPRING } from '../../motion/tokens.ts'
import { useMotionLevel } from '../../motion/useMotionLevel.ts'
import { PluginSeal } from '../../plugins/PluginSeal.tsx'
import { BrushButton, Covenant, EmptyState, HoldToStamp, InkSelect, InkSkeleton, LayerTag, Plate, ScrollDrawer, toast } from '../../ui/index.ts'
import { recordSummary, RequestError, useResource } from './common.tsx'

export function personName(person: PersonSummary): string {
  return person.aliases.find(Boolean) ?? person.personId
}

export function PersonPortrait({ person }: { person: PersonSummary }) {
  const name = personName(person)
  return <span aria-hidden="true" className={`memory-avatar${person.personId === 'owner' ? ' memory-avatar-owner' : ''}`}>
    {Array.from(name)[0]}
  </span>
}

function accountPlugin(account: string): string {
  const separator = account.indexOf(':')
  return separator < 0 ? account : account.slice(0, separator)
}

function Confirmation({ open, resetKey, title, consequences, disabled, children, onConfirm, onClose }: {
  open: boolean
  resetKey?: string
  title: '合并' | '拆分'
  consequences: string
  disabled?: boolean
  children?: React.ReactNode
  onConfirm: () => Promise<void>
  onClose: () => void
}) {
  const [ready, setReady] = useState(false)
  const labelId = `memory-person-${title === '合并' ? 'merge' : 'split'}-consequences`
  useEffect(() => {
    if (!open) return
    setReady(false)
    const timer = window.setTimeout(() => setReady(true), COVENANT_LOCK_MS)
    return () => window.clearTimeout(timer)
  }, [open, resetKey])
  return <Covenant open={open} onClose={onClose} title={title} footer={<>
    <HoldToStamp key={resetKey} label={title} disabled={disabled || !ready} ariaDescribedBy={labelId}
      ariaLabel={`按住 0.9 秒以确认：${title}人物`} onConfirm={onConfirm} onComplete={onClose} />
    <BrushButton variant="ghost" onClick={onClose}>算了</BrushButton>
  </>}>
    <div>
      <p id={labelId}>{consequences}</p>
      {children}
    </div>
  </Covenant>
}

type DragLine = { x1: number; y1: number; x2: number; y2: number }
type CardPosition = { x: number; y: number }
type PersonOperation = { kind: 'merge' | 'split'; person: PersonSummary; target?: string }

function PersonCard({ person, menuOpen, target, onDetail, onMenu, menu, onDrag, onDrop, register, origin }: {
  person: PersonSummary
  menuOpen: boolean
  target: boolean
  onDetail: () => void
  onMenu: () => void
  menu: React.ReactNode
  onDrag: (info: PanInfo) => void
  onDrop: (info: PanInfo) => void
  register: (element: HTMLDivElement | null) => void
  origin?: CardPosition
}) {
  const level = useMotionLevel()
  const full = level === 'full'
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const card = useRef<HTMLDivElement>(null)
  const moved = useRef(false)
  useLayoutEffect(() => {
    if (!full || !origin || !card.current) return
    const rect = card.current.getBoundingClientRect()
    x.jump(origin.x - (rect.left + rect.width / 2))
    y.jump(origin.y - (rect.top + rect.height / 2))
    const moveX = animate(x, 0, SPRING.float)
    const moveY = animate(y, 0, SPRING.float)
    return () => { moveX.stop(); moveY.stop() }
  }, [full, origin, x, y])
  const bloom = getPreset('bloom', level)
  const variants = full ? {
    ...bloom,
    exit: (destination?: CardPosition) => destination
      ? { x: destination.x, y: destination.y, opacity: 0, scale: 0.76, transition: SPRING.float }
      : { opacity: 0 },
  } : bloom
  return <motion.div ref={(element) => { card.current = element; register(element) }}
    className={`memory-person-frame${target ? ' memory-person-target' : ''}`}
    layout={full} style={{ x, y }}
    variants={variants} initial={origin ? 'initial' : false} animate="animate" exit="exit"
    onPointerDownCapture={() => { moved.current = false }}
    drag={full} dragMomentum={false} whileDrag={{ zIndex: 4 }}
    onDragStart={() => { moved.current = true }}
    onDrag={(_event, info) => onDrag(info)}
    onDragEnd={(_event, info) => {
      onDrop(info)
      animate(x, 0, { ...SPRING.float, velocity: info.velocity.x })
      animate(y, 0, { ...SPRING.float, velocity: info.velocity.y })
    }}>
    <Plate interactive className="memory-person-card memory-inset">
      <button type="button" className="memory-person-main"
        onClick={(event) => { if (event.detail === 0 || !moved.current) onDetail() }}>
        <PersonPortrait person={person} />
        <span className="memory-person-name">{personName(person)}</span>
        <span className="num">{person.personId}</span>
      </button>
      <BrushButton className="memory-person-menu" size="sm" variant="ghost" aria-label={`${personName(person)}的操作`}
        aria-expanded={menuOpen} onClick={onMenu}><Ellipsis size={17} aria-hidden="true" /></BrushButton>
      {menuOpen && <Plate level="raised" className="memory-person-menu-popover">{menu}</Plate>}
      {person.aliases.length > 1 && <div className="memory-person-meta">{person.aliases.join('、')}</div>}
      {person.accounts.length > 0 && <ul className="memory-person-accounts">{person.accounts.map((account) => <li key={account}>
        <PluginSeal pluginId={accountPlugin(account)} size={16} /> <span className="num">{account}</span>
      </li>)}</ul>}
    </Plate>
  </motion.div>
}

function PersonRecords({ person, openRecord, close }: {
  person: PersonSummary
  openRecord: (id: string) => void
  close: () => void
}) {
  const read = useCallback(() => memoryApi.browse({ personId: person.personId, limit: 50 }), [person.personId])
  const records = useResource(read)
  const [extra, setExtra] = useState<readonly MemoryRecord[]>([])
  const [cursor, setCursor] = useState<string | null>()
  const [busy, setBusy] = useState(false)
  const [moreError, setMoreError] = useState<unknown>()
  const next = cursor === undefined ? records.data?.nextCursor : cursor

  async function more() {
    if (!next || busy) return
    setBusy(true)
    setMoreError(undefined)
    try {
      const page = await memoryApi.browse({ personId: person.personId, limit: 50, cursor: next })
      setExtra((seen) => [...seen, ...page.items])
      setCursor(page.nextCursor ?? null)
    } catch (error) {
      setMoreError(error)
    } finally {
      setBusy(false)
    }
  }

  const items = [...(records.data?.items ?? []), ...extra].filter((record) => record.status !== 'tombstoned')
  return <ScrollDrawer open title={personName(person)} onClose={close}>
    <div className="memory-stack">
      {records.error !== undefined && <RequestError error={records.error} retry={records.reload} />}
      {records.loading && <InkSkeleton rows={4} />}
      {records.data && !items.length && !next && <EmptyState glyph="无痕" description="没有与这个人物相关的记忆。" />}
      {(['L3', 'L2', 'L1', 'L0'] as const).map((layer) => {
        const slice = items.filter((record) => record.layer === layer)
        return slice.length > 0 && <section key={layer} className="memory-detail-section">
          <h4><LayerTag layer={layer} /></h4>
          <ul className="memory-evidence-tree">{slice.map((record) => <li key={record.id}>
            <BrushButton variant="ghost" size="sm" onClick={() => openRecord(record.id)}>{recordSummary(record)}</BrushButton>
          </li>)}</ul>
        </section>
      })}
      {moreError !== undefined && <RequestError error={moreError} retry={() => void more()} />}
      {next && <BrushButton variant="secondary" loading={busy} onClick={() => void more()}>读取更多相关记忆</BrushButton>}
    </div>
  </ScrollDrawer>
}

export function MemoryPersons({
  persons,
  loading,
  error,
  forgottenPersonEvent,
  onRefresh,
  onRecord,
  onForgetPerson,
}: {
  persons: readonly PersonSummary[]
  loading: boolean
  error: unknown
  forgottenPersonEvent?: { readonly id: number; readonly personId: string } | null
  onRefresh: () => void
  onRecord: (id: string) => void
  onForgetPerson: (person: PersonSummary) => void
}) {
  const ink = useInk()
  const reduced = useMotionLevel() === 'reduced'
  const [menu, setMenu] = useState<string>()
  const [detail, setDetail] = useState<PersonSummary>()
  const [operation, setOperation] = useState<PersonOperation>()
  const [lastOperation, setLastOperation] = useState<PersonOperation>()
  const [accounts, setAccounts] = useState<readonly string[]>([])
  const [removed, setRemoved] = useState<string>()
  const [added, setAdded] = useState<{ id: string; origin?: CardPosition }>()
  const [exitDestination, setExitDestination] = useState<CardPosition>()
  const [over, setOver] = useState<string>()
  const [line, setLine] = useState<DragLine>()
  const cards = useRef(new Map<string, HTMLDivElement>())
  const viewport = useRef<HTMLDivElement>(null)
  const visible = useMemo(() => persons.filter((person) => person.personId !== removed), [persons, removed])

  // Trigger dissolve ink effect on the person card when "遗忘此人记忆" completes
  useEffect(() => {
    if (!forgottenPersonEvent || reduced) return
    const rect = cards.current.get(forgottenPersonEvent.personId)?.getBoundingClientRect()
    if (!rect || rect.width <= 0 || rect.height <= 0) return
    ink.dilute({ x: rect.left, y: rect.top, w: rect.width, h: rect.height }, Math.round(DUR.dissolve * 1000))
    for (let i = 0; i < 8; i += 1) {
      const ratio = (i + 0.5) / 8
      ink.splat({
        x: rect.left + rect.width * ratio,
        y: rect.top + rect.height * 0.5,
        dx: (Math.random() * 2 - 1) * 60,
        dy: -24,
        color: 'smoke',
        amount: 0.25,
        radius: 28,
      })
    }
  }, [forgottenPersonEvent, ink, reduced])

  function targetAt(person: PersonSummary, info: PanInfo) {
    const x = info.point.x - window.scrollX
    const y = info.point.y - window.scrollY
    for (const [id, element] of cards.current) {
      if (id === person.personId) continue
      const rect = element.getBoundingClientRect()
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return id
    }
  }

  function move(person: PersonSummary, info: PanInfo) {
    const id = targetAt(person, info)
    setOver(id)
    const source = cards.current.get(person.personId)?.getBoundingClientRect()
    const target = id && cards.current.get(id)?.getBoundingClientRect()
    const parent = viewport.current?.getBoundingClientRect()
    if (!source || !target || !parent) {
      setLine(undefined)
      return
    }
    setLine({
      x1: source.left + source.width / 2 - parent.left, y1: source.top + source.height / 2 - parent.top,
      x2: target.left + target.width / 2 - parent.left, y2: target.top + target.height / 2 - parent.top,
    })
  }

  function choose(kind: PersonOperation['kind'], person: PersonSummary, target?: string) {
    setMenu(undefined)
    setAccounts([])
    setOperation({ kind, person, target })
  }

  function splat(id: string) {
    const rect = cards.current.get(id)?.getBoundingClientRect()
    if (rect && !reduced) ink.splat({
      x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, color: 'zhusha', amount: 0.3, radius: 55,
    })
  }

  useEffect(() => {
    if (operation !== undefined) setLastOperation(operation)
  }, [operation])

  const activeOperation = operation ?? lastOperation
  const target = activeOperation?.target ? persons.find((person) => person.personId === activeOperation.target) : undefined
  return <div ref={viewport} className="memory-persons">
    {error !== undefined && <RequestError error={error} retry={onRefresh} />}
    {loading && visible.length === 0 && <Plate className="memory-inset"><InkSkeleton rows={4} /></Plate>}
    {!loading && !visible.length && error === undefined && <Plate>
      <EmptyState glyph="无人" description="没有人物资料。" />
    </Plate>}
    <div className="memory-person-grid">
      <AnimatePresence initial={false} custom={exitDestination}>
        {visible.map((person) => <PersonCard key={person.personId} person={person} origin={added?.id === person.personId ? added.origin : undefined}
          register={(element) => { if (element) cards.current.set(person.personId, element); else cards.current.delete(person.personId) }}
          menuOpen={menu === person.personId} target={over === person.personId}
          onDetail={() => setDetail(person)} onMenu={() => setMenu((current) => current === person.personId ? undefined : person.personId)}
          onDrag={(info) => move(person, info)}
          onDrop={(info) => {
            const destination = targetAt(person, info)
            setLine(undefined)
            setOver(undefined)
            if (destination) choose('merge', person, destination)
          }}
          menu={<>
            <BrushButton variant="ghost" onClick={() => choose('merge', person)} disabled={visible.length < 2}>合并到…</BrushButton>
            <BrushButton variant="ghost" onClick={() => choose('split', person)} disabled={!person.accounts.length}>拆分…</BrushButton>
            <BrushButton variant="danger" onClick={() => { setMenu(undefined); onForgetPerson(person) }}>遗忘此人记忆…</BrushButton>
          </>}
        />)}
      </AnimatePresence>
    </div>
    {line && <svg className="memory-drag-line" aria-hidden="true"><line {...line} /></svg>}
    {detail && <PersonRecords key={detail.personId} person={detail} close={() => setDetail(undefined)}
      openRecord={(id) => { setDetail(undefined); onRecord(id) }} />}
    <Confirmation
      open={operation?.kind === 'merge'}
      resetKey={activeOperation?.kind === 'merge' ? `merge:${activeOperation.person.personId}` : undefined}
      title="合并"
      disabled={!target}
      consequences={activeOperation?.kind === 'merge'
        ? target
          ? `把 ${personName(activeOperation.person)} 合并进 ${personName(target)}？${activeOperation.person.accounts.length} 个账号会归到目标人物。`
          : `请选择接收 ${personName(activeOperation.person)} 的人物。`
        : ''}
      onClose={() => setOperation(undefined)}
      onConfirm={async () => {
        if (!activeOperation || activeOperation.kind !== 'merge' || !target) return
        await memoryApi.mergePerson(activeOperation.person.personId, target.personId)
        const from = cards.current.get(activeOperation.person.personId)?.getBoundingClientRect()
        const to = cards.current.get(target.personId)?.getBoundingClientRect()
        setExitDestination(from && to ? {
          x: (to.left + to.right - from.left - from.right) / 2,
          y: (to.top + to.bottom - from.top - from.bottom) / 2,
        } : undefined)
        splat(target.personId)
        setRemoved(activeOperation.person.personId)
        toast.success('人物已合并')
        onRefresh()
      }}>
      {activeOperation?.kind === 'merge' && <InkSelect label="合并目标" value={activeOperation.target ?? null}
        options={visible.filter((person) => person.personId !== activeOperation.person.personId)
          .map((person) => ({ value: person.personId, label: personName(person) }))}
        onChange={(id) => setOperation({ ...activeOperation, target: id })} />}
    </Confirmation>
    <Confirmation
      open={operation?.kind === 'split'}
      resetKey={activeOperation?.kind === 'split' ? `split:${activeOperation.person.personId}` : undefined}
      title="拆分"
      disabled={accounts.length === 0}
      consequences={activeOperation?.kind === 'split' ? `从 ${personName(activeOperation.person)} 拆出所选账号，建立新人物。` : ''}
      onClose={() => setOperation(undefined)}
      onConfirm={async () => {
        if (!activeOperation || activeOperation.kind !== 'split') return
        const id = await memoryApi.splitPerson(activeOperation.person.personId, accounts)
        const from = cards.current.get(activeOperation.person.personId)?.getBoundingClientRect()
        splat(activeOperation.person.personId)
        setAdded({ id, origin: from ? { x: (from.left + from.right) / 2, y: (from.top + from.bottom) / 2 } : undefined })
        toast.success('人物已拆分')
        onRefresh()
      }}>
      {activeOperation?.kind === 'split' && <fieldset className="memory-account-select"><legend>拆出的账号</legend>{activeOperation.person.accounts.map((account) =>
        <label key={account}><input type="checkbox" checked={accounts.includes(account)}
          onChange={(event) => setAccounts(event.target.checked ? [...accounts, account] : accounts.filter((value) => value !== account))}
        /> <PluginSeal pluginId={accountPlugin(account)} size={16} /><span className="num">{account}</span></label>
      )}</fieldset>}
    </Confirmation>
  </div>
}
