import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { ApiError, type MemoryRecord } from '../../api/types.ts'
import { memoryApi } from '../../api/client.ts'
import { formatTimestamp } from '../../lib/memoryHelpers.ts'
import { getPreset } from '../../motion/presets.ts'
import { useMotionLevel } from '../../motion/useMotionLevel.ts'
import { ErrorState, toast } from '../../ui/index.ts'

export function useResource<T>(load: () => Promise<T>, enabled = true) {
  const [revision, setRevision] = useState(0)
  const [result, setResult] = useState<{
    load: () => Promise<T>
    revision: number
    data?: T
    error?: unknown
  }>()
  useEffect(() => {
    if (!enabled) return
    let current = true
    void load().then(
      (data) => { if (current) setResult({ load, revision, data }) },
      (error: unknown) => { if (current) setResult({ load, revision, error }) },
    )
    return () => { current = false }
  }, [enabled, load, revision])
  const current = enabled && result?.load === load && result.revision === revision ? result : undefined
  return {
    data: current?.data,
    error: current?.error,
    loading: enabled && current === undefined,
    reload: useCallback(() => setRevision((value) => value + 1), []),
  }
}

export function RequestError({ error, retry }: { error: unknown; retry: () => void }) {
  return <ErrorState
    code={error instanceof ApiError ? error.code : undefined}
    requestId={error instanceof ApiError ? error.requestId : undefined}
    message={error instanceof Error ? error.message : '无法读取数据'}
    onRetry={retry}
  />
}

export function notifyRequestError(error: unknown): void {
  toast.error(error instanceof Error ? error.message : '操作失败', error instanceof ApiError ? error : undefined)
}

export function recordSummary(record: MemoryRecord, limit = 80): string {
  const text = [record.content.text, record.content.summary, ...Object.values(record.content)]
    .find((item): item is string => typeof item === 'string' && item.trim() !== '')
    ?.trim() ?? record.kind
  const chars = Array.from(text)
  return chars.length <= limit ? text : `${chars.slice(0, limit - 1).join('')}…`
}

export function shortDate(timestamp: number): string {
  return formatTimestamp(timestamp).replace(/^\d{4}[/.-]/, '')
}

export async function recordsById(ids: Iterable<string>): Promise<Map<string, MemoryRecord>> {
  const unique = [...new Set(ids)]
  const records = new Map<string, MemoryRecord>()
  for (let start = 0; start < unique.length; start += 8) {
    await Promise.all(unique.slice(start, start + 8).map(async (id) => {
      const record = await memoryApi.getRecord(id)
      if (record && record.status !== 'tombstoned') records.set(id, record)
    }))
  }
  return records
}

export function highlighted(text: string, query: string): ReactNode {
  const words = query.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return text
  const escaped = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return text.split(new RegExp(`(${escaped.join('|')})`, 'gi')).map((part, index) =>
    index % 2 ? <span className="memory-match" key={index}>{part}</span> : part)
}

export function InkMetric({ label, value }: { label: string; value: number }) {
  const clamped = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
  return <span className="memory-metric">
    <span>{label}</span><meter min={0} max={1} value={clamped} aria-label={label} />
    <span className="num">{clamped.toFixed(2)}</span>
  </span>
}

/**
 * §8.4.5: Faint ink horizontal brush strikethrough drawn via SVG `brushIn` (static when motion is reduced).
 */
export function OutdatedBrushStrike({
  active,
  className,
  children,
}: {
  readonly active: boolean
  readonly className?: string
  readonly children: ReactNode
}) {
  const motionLevel = useMotionLevel()
  const variants = getPreset('brushIn', motionLevel)
  return (
    <span className={`memory-outdated-strike${className ? ` ${className}` : ''}`}>
      {children}
      {active && (
        <svg
          className="memory-outdated-strike-svg"
          viewBox="0 0 100 10"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <motion.path
            d="M 0 5.4 Q 50 4.2 100 5.2"
            fill="none"
            stroke="var(--text-3)"
            strokeWidth={1.6}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            variants={variants}
            initial={motionLevel === 'reduced' ? false : 'initial'}
            animate="animate"
          />
        </svg>
      )}
    </span>
  )
}
