import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import type { Layer, MemoryRecord } from '../../api/types.ts'
import { useInk } from '../../ink/InkProvider.tsx'
import { formatTimestamp, summarizeRecordContent } from '../../lib/memoryHelpers.ts'
import { listStaggerDelay, REDUCED_FADE_DURATION } from '../../motion/presets.ts'
import { DUR, SPRING } from '../../motion/tokens.ts'
import { useMotionLevel } from '../../motion/useMotionLevel.ts'
import { useShellNavigation } from '../../shell/PageTransition.tsx'
import { LayerTag } from '../../ui/LayerTag.tsx'
import { DAY_MS } from './memoryTail.ts'

export { DAY_MS }

const DOT_SIZE: Readonly<Record<Layer, number>> = { L0: 5, L1: 8, L2: 12, L3: 22 }
const EMPTY_RECORDS: readonly MemoryRecord[] = []

function recordLabel(record: MemoryRecord): string {
  return [record.layer, record.kind, record.channel, formatTimestamp(record.tIngest), summarizeRecordContent(record, 60)].join(' · ')
}

function laneOf(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0
  }
  return Math.abs(hash) % 3
}

export interface FlowData {
  readonly records: readonly MemoryRecord[]
  readonly capturedAt: number
  readonly hasHistory: boolean
}

export function MemoryFlow({ data }: { readonly data: FlowData | undefined }) {
  const ink = useInk()
  const motionLevel = useMotionLevel()
  const { navigate } = useShellNavigation()
  const axisRef = useRef<HTMLOListElement>(null)
  const seen = useRef<ReadonlySet<string> | null>(null)
  const [point, setPoint] = useState<{ readonly record: MemoryRecord; readonly left: number } | null>(null)
  const [focusedRecord, setFocusedRecord] = useState<{ readonly record: MemoryRecord; readonly left: number } | null>(null)
  const records = data?.records ?? EMPTY_RECORDS
  const tooltip = focusedRecord ?? point
  const updatedSinceMount = seen.current !== null

  useEffect(() => {
    if (!data) return
    const previous = seen.current
    const axis = axisRef.current?.getBoundingClientRect()
    if (motionLevel === 'full' && previous && axis && axis.width > 0) {
      for (const record of records) {
        if (!previous.has(record.id)) {
          ink.splat({
            x: axis.right,
            y: axis.top + axis.height * (laneOf(record.id) + 1) / 4,
            radius: 25,
            amount: 0.2,
            color: record.layer === 'L3' ? 'zhusha' : 'smoke',
          })
        }
      }
    }
    seen.current = new Set(records.map((record) => record.id))
  }, [data, ink, motionLevel, records])

  const reduced = motionLevel === 'reduced'

  return (
    <div className="court-flow">
      {tooltip && records.some((record) => record.id === tooltip.record.id) && (
        <div
          className="court-flow-tooltip plate"
          role="tooltip"
          style={{ left: `clamp(min(124px, 50%), ${tooltip.left}%, max(calc(100% - 124px), 50%))` }}
        >
          <div className="court-flow-tooltip-meta">
            <LayerTag layer={tooltip.record.layer} /> {tooltip.record.kind}
          </div>
          <div className="court-meta">{tooltip.record.channel} · {formatTimestamp(tooltip.record.tIngest)}</div>
          <p>{summarizeRecordContent(tooltip.record, 60)}</p>
        </div>
      )}
      <ol aria-label="最近 24 小时写入的记忆" ref={axisRef}>
        {records.length === 0 ? (
          <li className="court-flow-empty court-meta" aria-live="polite">
            {data?.hasHistory ? '近 24 小时无新写入' : '暂无记忆写入'}
          </li>
        ) : records.map((record, index) => {
          const left = Math.min(100, Math.max(0, (1 - (data!.capturedAt - record.tIngest) / DAY_MS) * 100))
          const newPoint = updatedSinceMount && !seen.current?.has(record.id)
          const staggerDelay = newPoint ? 0 : listStaggerDelay(records.length - 1 - index)
          return (
            <motion.li
              key={record.id}
              className="court-flow-item"
              initial={reduced ? false : { x: newPoint ? '100%' : `${left}%` }}
              animate={{ x: `${left}%` }}
              transition={reduced ? { duration: REDUCED_FADE_DURATION } : SPRING.float}
              style={{ top: `${(laneOf(record.id) + 1) * 25}%` }}
            >
              <motion.button
                type="button"
                aria-label={recordLabel(record)}
                initial={reduced ? { opacity: 0 } : { scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={reduced
                  ? { opacity: { duration: REDUCED_FADE_DURATION } }
                  : {
                      scale: { ...SPRING.float, delay: staggerDelay },
                      opacity: { duration: DUR.quick, delay: staggerDelay },
                    }}
                onPointerEnter={() => setPoint({ record, left })}
                onPointerLeave={() => setPoint(null)}
                onFocus={() => setFocusedRecord({ record, left })}
                onBlur={() => setFocusedRecord(null)}
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect()
                  navigate('memory?record=' + encodeURIComponent(record.id), {
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2,
                  })
                }}
              >
                <span
                  aria-hidden="true"
                  data-layer={record.layer}
                  style={{
                    width: DOT_SIZE[record.layer],
                    height: DOT_SIZE[record.layer],
                    background: `var(--tone-${record.layer.toLowerCase()})`,
                  }}
                />
              </motion.button>
            </motion.li>
          )
        })}
      </ol>
      <div className="court-flow-axis court-meta" aria-hidden="true">
        <span>24 小时前</span><span>现在</span>
      </div>
    </div>
  )
}
