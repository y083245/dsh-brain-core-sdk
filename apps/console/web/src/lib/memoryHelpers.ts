import type {
  EvidenceNode,
  ForgetCascadePreview,
  Layer,
  MemoryRecord,
} from '../api/types.ts'

export function isTombstoned(record: MemoryRecord): boolean {
  return record.status === 'tombstoned'
}

export function clamp01(val: number): number {
  if (!Number.isFinite(val)) return 0
  return Math.max(0, Math.min(1, val))
}

export function summarizeRecordContent(record: MemoryRecord, maxLength = 110): string {
  if (isTombstoned(record)) {
    return '【已遗忘墓碑】内容已物理擦除，仅保留拓扑墓碑占位'
  }
  const c = record.content
  const candidateKeys = [
    'text',
    'summary',
    'statement',
    'fact',
    'stable',
    'quote',
    'emotionQuote',
    'title',
    'description',
    'message',
    'value',
  ]
  for (const key of candidateKeys) {
    const val = c[key]
    if (typeof val === 'string' && val.trim() !== '') {
      const trimmed = val.trim()
      return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed
    }
  }
  const entries = Object.entries(c)
  if (entries.length === 0) {
    return `(${record.kind} · 空载荷)`
  }
  try {
    const raw = JSON.stringify(c)
    return raw.length > maxLength ? `${raw.slice(0, maxLength)}…` : raw
  } catch {
    return record.kind
  }
}

export function formatTimestamp(ts: number | undefined): string {
  if (ts === undefined || !Number.isFinite(ts) || ts <= 0) return '—'
  if (ts < 10_000_000_000 && ts > 1_000_000_000) {
    return new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false })
  }
  if (ts >= 10_000_000_000) {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false })
  }
  return `T+${String(ts)}`
}

export function hashString(input: string): number {
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * Recursively builds the upstream evidence chain down to L0.
 */
export async function buildEvidenceTree(
  record: MemoryRecord,
  localCache: ReadonlyMap<string, MemoryRecord>,
  fetchRecord: (id: string) => Promise<MemoryRecord | null>,
  visited: ReadonlySet<string> = new Set(),
  depth = 0,
): Promise<EvidenceNode> {
  const nextVisited = new Set(visited)
  nextVisited.add(record.id)

  if (record.layer === 'L0' || record.evidence.length === 0 || depth >= 6) {
    return { record, children: [] }
  }

  const children: EvidenceNode[] = []
  for (const ref of record.evidence) {
    if (nextVisited.has(ref.id)) continue
    const cached = localCache.get(ref.id)
    const child = cached !== undefined ? cached : await fetchRecord(ref.id)
    if (child === null) continue
    const subNode = await buildEvidenceTree(child, localCache, fetchRecord, nextVisited, depth + 1)
    children.push(subNode)
  }

  return { record, children }
}

/**
 * Recursively collects all downstream dependent records via fetchDependents(id) for forget cascade preview.
 */
export async function computeForgetCascadePreview(
  targetId: string,
  fetchDependents: (id: string) => Promise<readonly MemoryRecord[]>,
): Promise<{
  readonly preview: ForgetCascadePreview
  readonly dependentRecords: readonly MemoryRecord[]
}> {
  const visited = new Set<string>([targetId])
  const queue: string[] = [targetId]
  const affectedIds: string[] = []
  const byLayer: Record<Layer, string[]> = { L0: [], L1: [], L2: [], L3: [] }
  const dependentRecords: MemoryRecord[] = []

  while (queue.length > 0) {
    const currentId = queue.shift()!
    const deps = await fetchDependents(currentId)
    for (const dep of deps) {
      if (visited.has(dep.id)) continue
      visited.add(dep.id)
      affectedIds.push(dep.id)
      byLayer[dep.layer].push(dep.id)
      dependentRecords.push(dep)
      queue.push(dep.id)
    }
  }

  return {
    preview: {
      targetId,
      affectedIds,
      byLayer,
    },
    dependentRecords,
  }
}
