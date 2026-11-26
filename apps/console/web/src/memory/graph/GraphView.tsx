import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { animate, motion as Motion } from 'motion/react'
import type { MemoryRecord, PersonSummary } from '../../api/types.ts'
import { useInktideStore } from '../../data/store.ts'
import { useInk } from '../../ink/InkProvider.tsx'
import { hashString } from '../../lib/memoryHelpers.ts'
import { DUR, SPRING } from '../../motion/tokens.ts'
import { useMotionLevel } from '../../motion/useMotionLevel.ts'
import { BrushButton, EmptyState, InkSkeleton, LayerTag, Plate } from '../../ui/index.ts'
import { recordSummary, RequestError } from '../../pages/memory/common.tsx'
import type { ForgetDissolveState, ForgetPreviewState } from '../../pages/memory/forgetPreview.ts'
import { PersonPortrait, personName } from '../../pages/memory/MemoryPersons.tsx'
import {
  createGraphRenderer,
  graphRadius,
  type CameraState,
  type EdgeDisconnectSchedule,
  type GraphGeometry,
} from './graphRenderer.ts'
import type { LayoutInput } from './layout.ts'

interface GraphViewProps {
  readonly records: readonly MemoryRecord[]
  readonly truncated?: boolean
  readonly persons: readonly PersonSummary[]
  readonly personId: string
  readonly selected?: string
  readonly forgetPreview?: ForgetPreviewState | null
  readonly forgetDissolve?: ForgetDissolveState | null
  readonly onPerson: (id: string) => void
  readonly onRecord: (id: string) => void
  readonly onList: () => void
}

const MIN_ZOOM = 0.2
const MAX_ZOOM = 8
const MAX_LABELS = 40
const DOUBLE_CLICK_MS = 255
const DISSOLVE_DEPTH_STAGGER_MS = 140
const EDGE_DISCONNECT_STAGGER_MS = 40
const LAYER = { L0: 0, L1: 1, L2: 2, L3: 3 }

let lastLayout: { signature: string; positions: Float32Array } | undefined
let rememberedCamera: CameraState = { x: 0, y: 0, zoom: 1 }

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

function sceneTopology(records: readonly MemoryRecord[]) {
  const items = records.filter((record) => record.status !== 'tombstoned').slice(0, 5000)
  const indices = new Map(items.map((record, index) => [record.id, index]))
  const edges: [number, number][] = []
  items.forEach((record, to) => {
    for (const reference of record.evidence) {
      const from = indices.get(reference.id)
      if (from !== undefined && from !== to && LAYER[items[from]!.layer] < LAYER[record.layer]) edges.push([from, to])
    }
  })
  const signature = JSON.stringify([items.map((record) => [record.id, record.layer]), edges])
  return { items, edges, signature }
}

function useLayoutData(records: readonly MemoryRecord[]) {
  const topology = useMemo(() => sceneTopology(records), [records])
  const [result, setResult] = useState<{ signature: string; positions?: Float32Array; error?: unknown }>()
  const [attempt, setAttempt] = useState(0)
  const { signature } = topology
  const topologyRef = useRef(topology)
  topologyRef.current = topology

  useEffect(() => {
    const { items, edges } = topologyRef.current
    if (items.length === 0) return
    if (lastLayout?.signature === signature) {
      setResult(lastLayout)
      return
    }
    let worker: Worker
    try {
      worker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' })
    } catch (error) {
      setResult({ signature, error })
      return
    }
    worker.onmessage = (event: MessageEvent<Float32Array>) => {
      lastLayout = { signature, positions: event.data }
      setResult(lastLayout)
      worker.terminate()
    }
    worker.onerror = (event) => {
      setResult({ signature, error: new Error(event.message || '图谱布局失败') })
      worker.terminate()
    }
    const input: LayoutInput = { layers: items.map((record) => LAYER[record.layer]), edges, seed: hashString(signature) }
    worker.postMessage(input)
    return () => worker.terminate()
  }, [attempt, signature])

  const positions = result?.signature === signature ? result.positions : undefined
  // Keep geometry identity tied strictly to topology signature + positions so record metadata updates
  // (e.g. status -> outdated or content edits) never dispose & rebuild WebGLRenderer.
  const geometry = useMemo<GraphGeometry | undefined>(() => {
    if (!positions) return undefined
    const current = topologyRef.current
    if (current.signature !== signature) return undefined
    return {
      nodes: current.items.map((record, index) => ({
        id: record.id,
        layer: LAYER[record.layer],
        x: positions[index * 2]!,
        y: positions[index * 2 + 1]!,
      })),
      edges: current.edges,
    }
  }, [positions, signature])
  const retry = useCallback(() => {
    setResult(undefined)
    setAttempt((value) => value + 1)
  }, [])
  return {
    geometry,
    records: topology.items,
    error: result?.signature === signature ? result.error : undefined,
    retry,
  }
}

function buildEdgeDisconnectSchedule(
  geometry: GraphGeometry,
  dissolve: ForgetDissolveState | null,
): EdgeDisconnectSchedule | null {
  if (!dissolve || dissolve.erasedDepthById.size === 0) return null
  const erasedNodes: Array<{ index: number; depth: number }> = []
  geometry.nodes.forEach((node, index) => {
    const depth = dissolve.erasedDepthById.get(node.id)
    if (depth !== undefined) erasedNodes.push({ index, depth })
  })
  if (erasedNodes.length === 0) return null
  erasedNodes.sort((a, b) => a.depth - b.depth || a.index - b.index)

  const incident = new Map<number, number[]>()
  geometry.edges.forEach(([from, to], edgeIdx) => {
    let fromList = incident.get(from)
    if (!fromList) {
      fromList = []
      incident.set(from, fromList)
    }
    fromList.push(edgeIdx)
    let toList = incident.get(to)
    if (!toList) {
      toList = []
      incident.set(to, toList)
    }
    toList.push(edgeIdx)
  })

  const order = new Map<number, number>()
  let seq = 0
  for (const { index } of erasedNodes) {
    for (const edgeIdx of incident.get(index) ?? []) {
      if (!order.has(edgeIdx)) {
        order.set(edgeIdx, seq)
        seq += 1
      }
    }
  }

  let maxDepth = 0
  for (const depth of dissolve.erasedDepthById.values()) {
    if (depth > maxDepth) maxDepth = depth
  }
  const totalDissolveMs = maxDepth * DISSOLVE_DEPTH_STAGGER_MS + Math.round(DUR.dissolve * 1000)
  const budgetMs = Math.max(0, totalDissolveMs - Math.round(DUR.quick * 1000))
  const edgeCount = order.size
  const stepMs = Math.min(EDGE_DISCONNECT_STAGGER_MS, Math.floor(budgetMs / Math.max(1, edgeCount)))
  return { order, stepMs }
}

function GraphSurface({ geometry, records, truncated, personId, selected, forgetPreview, forgetDissolve, onRecord }: {
  geometry: GraphGeometry
  records: readonly MemoryRecord[]
  truncated?: boolean
  personId: string
  selected?: string
  forgetPreview: ForgetPreviewState | null
  forgetDissolve: ForgetDissolveState | null
  onRecord: (id: string) => void
}) {
  const ink = useInk()
  const theme = useInktideStore((state) => state.resolvedTheme)
  const motion = useMotionLevel() === 'full'
  const viewport = useRef<HTMLDivElement>(null)
  const camera = useRef<CameraState>({ ...rememberedCamera })
  const [hovered, setHovered] = useState<number | null>(null)
  const edgeDisconnect = useMemo(
    () => buildEdgeDisconnectSchedule(geometry, forgetDissolve),
    [geometry, forgetDissolve],
  )
  const appearance = useRef({
    records,
    hovered,
    selected,
    personId,
    theme,
    motion,
    forgetPreview,
    forgetDissolve,
    edgeDisconnect,
  })
  appearance.current = {
    records,
    hovered,
    selected,
    personId,
    theme,
    motion,
    forgetPreview,
    forgetDissolve,
    edgeDisconnect,
  }
  const hoveredRef = useRef<number | null>(null)
  const pointer = useRef({ x: 0, y: 0 })
  const tooltip = useRef<HTMLDivElement>(null)
  const labelElements = useRef<(HTMLSpanElement | null)[]>([])
  const [labels, setLabels] = useState<readonly number[]>([])
  const labelsRef = useRef<readonly number[]>([])
  const drag = useRef<{ pointerId: number; x: number; y: number; startX: number; startY: number } | null>(null)
  const lastDragged = useRef(false)
  const inertia = useRef({ x: 0, y: 0, zoom: 0, zoomX: 0, zoomY: 0 })
  const animations = useRef<{ stop(): void }[]>([])
  const clickTimer = useRef<number>(undefined)
  const [renderError, setRenderError] = useState<unknown>()
  const [renderAttempt, setRenderAttempt] = useState(0)
  const labelOrder = useMemo(() => geometry.nodes.map((_, index) => index)
    .filter((index) => geometry.nodes[index]!.layer > 0)
    .sort((a, b) => (records[b]?.importance ?? 0) - (records[a]?.importance ?? 0)), [geometry, records])
  const labelOrderRef = useRef(labelOrder)
  labelOrderRef.current = labelOrder

  // Splat ink at each erased node's screen position staggered by dependency depth during forget dissolve
  useEffect(() => {
    if (!forgetDissolve || !motion) return
    const timers: number[] = []
    for (const node of geometry.nodes) {
      const depth = forgetDissolve.erasedDepthById.get(node.id)
      if (depth === undefined) continue
      const timer = window.setTimeout(() => {
        const rect = viewport.current?.getBoundingClientRect()
        if (!rect || rect.width <= 0 || rect.height <= 0) return
        const view = camera.current
        const sx = rect.left + rect.width / 2 + (node.x - view.x) * view.zoom
        const sy = rect.top + rect.height / 2 - (node.y - view.y) * view.zoom
        if (sx >= rect.left && sx <= rect.right && sy >= rect.top && sy <= rect.bottom) {
          ink.splat({ x: sx, y: sy, radius: 44, amount: 0.3, color: 'smoke' })
        }
      }, depth * DISSOLVE_DEPTH_STAGGER_MS)
      timers.push(timer)
    }
    return () => {
      for (const timer of timers) window.clearTimeout(timer)
    }
  }, [forgetDissolve, geometry, ink, motion])

  const runFlight = useCallback((target: CameraState) => {
    for (const running of animations.current) running.stop()
    inertia.current = { x: 0, y: 0, zoom: 0, zoomX: 0, zoomY: 0 }
    if (!motion) {
      camera.current = { ...target }
      return
    }
    animations.current = (['x', 'y', 'zoom'] as const).map((axis) =>
      animate(camera.current[axis], target[axis], {
        ...SPRING.heavy,
        onUpdate: (value) => {
          camera.current[axis] = axis === 'zoom' ? clamp(value, MIN_ZOOM, MAX_ZOOM) : value
        },
      }))
  }, [motion])

  const previousSelected = useRef<string>(undefined)
  useEffect(() => {
    if (selected === previousSelected.current) return
    previousSelected.current = selected
    const node = geometry.nodes.find(({ id }) => id === selected)
    if (node) runFlight({ x: node.x, y: node.y, zoom: camera.current.zoom })
  }, [geometry, runFlight, selected])

  const updateHover = useCallback((index: number | null) => {
    if (hoveredRef.current === index) return
    hoveredRef.current = index
    setHovered(index)
    if (index !== null && motion) {
      ink.splat({ x: pointer.current.x, y: pointer.current.y, radius: 50, amount: 0.15, color: 'smoke' })
    }
  }, [ink, motion])
  const updateHoverRef = useRef(updateHover)
  updateHoverRef.current = updateHover

  const pick = useCallback((x: number, y: number) => {
    const rect = viewport.current?.getBoundingClientRect()
    if (!rect) return null
    const view = camera.current
    const wx = view.x + (x - rect.left - rect.width / 2) / view.zoom
    const wy = view.y - (y - rect.top - rect.height / 2) / view.zoom
    let nearest: number | null = null
    let normalizedDistance = 1
    geometry.nodes.forEach((node, index) => {
      if (appearance.current.forgetDissolve?.erasedDepthById.has(node.id)) return
      const radius = Math.max(5 / view.zoom, graphRadius(node.layer, view.zoom))
      const distance = Math.hypot(node.x - wx, node.y - wy) / radius
      if (distance < normalizedDistance) {
        normalizedDistance = distance
        nearest = index
      }
    })
    return nearest
  }, [geometry])

  useEffect(() => {
    const stage = viewport.current
    const gl = ink.getGLContext()
    if (!stage || !gl) return
    let current = true
    labelsRef.current = []
    setLabels([])
    updateHoverRef.current(null)
    let drawer: ReturnType<typeof createGraphRenderer>
    try {
      drawer = createGraphRenderer(gl, geometry)
    } catch (error) {
      setRenderError(error)
      return
    }

    let lastLabelUpdate = -1
    ink.setExternalRenderHook((_context, info) => {
      if (!current) return
      const rect = stage.getBoundingClientRect()
      const view = camera.current
      const velocity = inertia.current
      try {
        if (!drag.current) {
          view.x += velocity.x
          view.y += velocity.y
          velocity.x = Math.abs(velocity.x) < 0.01 ? 0 : velocity.x * 0.88
          velocity.y = Math.abs(velocity.y) < 0.01 ? 0 : velocity.y * 0.88
        }
        if (velocity.zoom !== 0) {
          const old = view.zoom
          const next = clamp(old * Math.exp(velocity.zoom), MIN_ZOOM, MAX_ZOOM)
          view.zoom = next
          view.x += (velocity.zoomX - rect.left - rect.width / 2) * (1 / old - 1 / next)
          view.y -= (velocity.zoomY - rect.top - rect.height / 2) * (1 / old - 1 / next)
          velocity.zoom = !appearance.current.motion || next === old || Math.abs(velocity.zoom) < 0.001 ? 0 : velocity.zoom * 0.88
        }
        const project = (index: number) => {
          const node = geometry.nodes[index]!
          return [
            rect.width / 2 + (node.x - view.x) * view.zoom,
            rect.height / 2 - (node.y - view.y) * view.zoom,
          ] as const
        }
        if (info.timeSec - lastLabelUpdate > 0.06) {
          lastLabelUpdate = info.timeSec
          const next: number[] = []
          if (view.zoom > 2) {
            const currentRecords = appearance.current.records
            for (const index of labelOrderRef.current) {
              const node = geometry.nodes[index]
              const rec = currentRecords[index]
              if (!node || !rec) continue
              if (appearance.current.forgetDissolve?.erasedDepthById.has(node.id)) continue
              if (appearance.current.personId && !rec.subjects.includes(appearance.current.personId)) continue
              const [x, y] = project(index)
              if (x >= 0 && x <= rect.width && y >= 0 && y <= rect.height) next.push(index)
              if (next.length >= MAX_LABELS) break
            }
          }
          if (next.length !== labelsRef.current.length || next.some((index, position) => index !== labelsRef.current[position])) {
            labelsRef.current = next
            setLabels(next)
          }
        }
        labelsRef.current.forEach((index, position) => {
          const [x, y] = project(index)
          const label = labelElements.current[position]
          if (label) label.style.transform = `translate3d(${x + 11}px, ${y - 10}px, 0)`
        })
        drawer.draw(rect, view, appearance.current, info)
      } catch (error) {
        current = false
        setRenderError(error)
        ink.setExternalRenderHook(null)
      }
    })

    const wheel = (event: WheelEvent): void => {
      event.preventDefault()
      for (const running of animations.current) running.stop()
      const delta = (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1) * event.deltaY
      inertia.current.zoom = clamp(inertia.current.zoom - delta * (appearance.current.motion ? 0.00038 : 0.002), -0.25, 0.25)
      inertia.current.zoomX = event.clientX
      inertia.current.zoomY = event.clientY
      updateHoverRef.current(null)
    }
    stage.addEventListener('wheel', wheel, { passive: false })
    return () => {
      current = false
      stage.removeEventListener('wheel', wheel)
      ink.setExternalRenderHook(null)
      drawer.dispose()
    }
  }, [geometry, ink, renderAttempt])

  useEffect(() => () => {
    rememberedCamera = { ...camera.current }
    for (const running of animations.current) running.stop()
    if (clickTimer.current !== undefined) window.clearTimeout(clickTimer.current)
  }, [])

  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    for (const running of animations.current) running.stop()
    const velocity = inertia.current
    velocity.x = 0
    velocity.y = 0
    velocity.zoom = 0
    lastDragged.current = false
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const { clientX: x, clientY: y } = event
    pointer.current = { x, y }
    const gesture = drag.current
    if (gesture?.pointerId === event.pointerId) {
      if (Math.hypot(x - gesture.startX, y - gesture.startY) <= 3 && !lastDragged.current) return
      lastDragged.current = true
      const dx = (gesture.x - x) / camera.current.zoom
      const dy = (y - gesture.y) / camera.current.zoom
      camera.current.x += dx
      camera.current.y += dy
      gesture.x = x
      gesture.y = y
      inertia.current.x = motion ? dx * 0.45 : 0
      inertia.current.y = motion ? dy * 0.45 : 0
      updateHover(null)
      return
    }
    updateHover(pick(x, y))
    if (tooltip.current) {
      const rect = event.currentTarget.getBoundingClientRect()
      tooltip.current.style.transform = `translate3d(${Math.max(8, Math.min(rect.width - 254, x - rect.left + 14))}px,${Math.max(8, Math.min(rect.height - 100, y - rect.top + 14))}px,0)`
    }
  }

  function endPointer(event: ReactPointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId === event.pointerId) drag.current = null
  }

  if (renderError !== undefined) {
    return <RequestError error={renderError} retry={() => { setRenderError(undefined); setRenderAttempt((value) => value + 1) }} />
  }

  const hot = hovered === null ? undefined : records[hovered]
  return <Motion.div ref={viewport} layout={motion} transition={SPRING.float} className={`memory-graph-surface${selected ? ' memory-graph-surface-selected' : ''}`}
    role="img" aria-label={`墨痕，${geometry.nodes.length} 个节点，${geometry.edges.length} 条边`} data-cursor="graph"
    onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={endPointer} onPointerCancel={endPointer}
    onPointerLeave={() => updateHover(null)} onLostPointerCapture={endPointer}
    onClick={(event) => {
      if (lastDragged.current) return
      const index = pick(event.clientX, event.clientY)
      if (index === null) return
      const node = geometry.nodes[index]
      if (!node) return
      if (clickTimer.current !== undefined) window.clearTimeout(clickTimer.current)
      if (event.detail > 1) return
      clickTimer.current = window.setTimeout(() => onRecord(node.id), DOUBLE_CLICK_MS)
    }}
    onDoubleClick={(event) => {
      if (clickTimer.current !== undefined) window.clearTimeout(clickTimer.current)
      if (lastDragged.current) return
      const index = pick(event.clientX, event.clientY)
      if (index === null) return
      const node = geometry.nodes[index]
      if (!node) return
      runFlight({ x: node.x, y: node.y, zoom: Math.min(MAX_ZOOM, Math.max(2.5, camera.current.zoom * 1.45)) })
    }}>
    <div className="memory-graph-labels" aria-hidden="true">
      {labels.map((index, position) => {
        const rec = records[index]
        if (!rec) return null
        return <span key={rec.id}
          ref={(element) => { labelElements.current[position] = element }}>
          {recordSummary(rec, 26)}
        </span>
      })}
    </div>
    <div ref={tooltip} className="memory-graph-tooltip" aria-hidden="true">
      {hot && <Plate level="raised" className="memory-inset">
        <LayerTag layer={hot.layer} /> {recordSummary(hot)}
      </Plate>}
    </div>
    {truncated && <div className="memory-graph-corner-note" role="status">
      只显示最近 1500 条原始事件
    </div>}
  </Motion.div>
}

export function GraphView({
  records,
  truncated,
  persons,
  personId,
  selected,
  forgetPreview = null,
  forgetDissolve = null,
  onPerson,
  onRecord,
  onList,
}: GraphViewProps) {
  const layout = useLayoutData(records)
  return <div className="memory-stack">
    <Plate level="sunken" className="memory-inset memory-toolbar">
      <div className="memory-graph-people" aria-label="按人物筛选证据图谱">
        <BrushButton variant={personId ? 'ghost' : 'secondary'} aria-pressed={!personId} size="sm" onClick={() => onPerson('')}>全部</BrushButton>
        {persons.map((person) => <BrushButton key={person.personId} size="sm"
          aria-pressed={personId === person.personId} variant={personId === person.personId ? 'secondary' : 'ghost'}
          onClick={() => onPerson(personId === person.personId ? '' : person.personId)}>
          <PersonPortrait person={person} /> {personName(person)}
        </BrushButton>)}
      </div>
      <BrushButton variant="secondary" size="sm" onClick={onList}>以列表查看</BrushButton>
    </Plate>
    {layout.error !== undefined ? <RequestError error={layout.error} retry={layout.retry} /> :
      layout.geometry ? <GraphSurface geometry={layout.geometry} records={layout.records} truncated={truncated} personId={personId} selected={selected}
        forgetPreview={forgetPreview} forgetDissolve={forgetDissolve} onRecord={onRecord} /> :
        records.length ? <Plate className="memory-inset"><InkSkeleton ariaLabel="计算证据布局" rows={5} /></Plate> :
          <Plate><EmptyState glyph="无痕" description="还没有可绘制的证据。" /></Plate>}
  </div>
}
