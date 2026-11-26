import { useMemo, type ReactNode } from 'react'
import { motion } from 'motion/react'
import type { L3ProfileDiffView } from '../../api/types.ts'
import { getPreset } from '../../motion/presets.ts'
import { useMotionLevel } from '../../motion/useMotionLevel.ts'
import { diffStableText } from './diff.ts'

interface ProfileValues {
  readonly stable?: string
  readonly data?: Readonly<Record<string, unknown>>
}

export function formatProfileValue(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2) ?? '—'
}

function DeletedText({ children, className }: { readonly children: ReactNode; readonly className: string }) {
  const level = useMotionLevel()
  const erase = getPreset('brushIn', level)
  return (
    <del className={className}>
      <span>{children}</span>
      <svg className="heart-diff-strike" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true">
        <motion.path
          d="M 0 2 Q 50 0.8 100 2"
          fill="none"
          stroke="var(--text-3)"
          strokeWidth={1.4}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          variants={erase}
          initial={level === 'full' ? 'initial' : false}
          animate="animate"
        />
      </svg>
    </del>
  )
}

export function ProfileDiff({ changes, before, after }: {
  readonly changes: Pick<L3ProfileDiffView, 'stableChanged' | 'added' | 'removed' | 'changed'>
  readonly before: ProfileValues | undefined
  readonly after: ProfileValues
}) {
  const level = useMotionLevel()
  const beforeStable = before?.stable ?? ''
  const afterStable = after.stable ?? ''
  const stableSpans = useMemo(
    () => changes.stableChanged ? diffStableText(beforeStable, afterStable) : [],
    [afterStable, beforeStable, changes.stableChanged],
  )
  const write = getPreset('inkText', level)
  const entries = [
    ...changes.added.map((key) => ({ key, kind: 'added' as const })),
    ...changes.removed.map((key) => ({ key, kind: 'removed' as const })),
    ...changes.changed.map((key) => ({ key, kind: 'changed' as const })),
  ]
  if (stableSpans.length === 0 && entries.length === 0) return <p className="heart-muted">这两版没有改动。</p>
  return (
    <div>
      {stableSpans.length > 0 && (
        <section className="heart-diff-entry" aria-label="稳定文本对比">
          <h3>稳定文本</h3>
          <p className="heart-diff-stable">
            {stableSpans.map((span, index) => span.kind === 'same'
              ? <span key={index}>{span.text}</span>
              : span.kind === 'added'
                ? <motion.ins key={index} className="heart-diff-new" variants={write} initial="initial" animate="animate">{span.text}</motion.ins>
                : <DeletedText key={index} className="heart-diff-old">{span.text}</DeletedText>)}
          </p>
        </section>
      )}
      {entries.map(({ key, kind }) => (
        <div key={key} className="heart-diff-entry">
          <span className="heart-diff-key">{key}</span>
          {kind !== 'added' ? (
            <DeletedText className="heart-diff-old heart-diff-stable">
              {formatProfileValue(before?.data?.[key])}
            </DeletedText>
          ) : null}
          {kind !== 'removed' ? (
            <motion.ins className="heart-diff-new heart-diff-stable" variants={write} initial="initial" animate="animate">
              {formatProfileValue(after.data?.[key])}
            </motion.ins>
          ) : null}
        </div>
      ))}
    </div>
  )
}
