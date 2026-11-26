import { useCallback, useEffect, useRef, useState } from 'react'
import { memoryApi } from '../../api/client.ts'
import type { MemoryRecord } from '../../api/types.ts'

type RecordsByMessage = ReadonlyMap<string, readonly MemoryRecord[]>

const EMPTY_RECORDS: readonly MemoryRecord[] = []

/** An outbound journal can point to memories. The chat history itself carries no such links. */
export function useVoiceEvidence(): {
  readonly evidence: RecordsByMessage
  readonly loadEvidence: (recordId: string) => void
} {
  const [evidence, setEvidence] = useState<RecordsByMessage>(() => new Map())
  const active = useRef(new Set<string>())
  const records = useRef(new Map<string, Promise<MemoryRecord | null>>())
  const completed = useRef(new Set<string>())
  const generation = useRef(0)

  useEffect(() => () => {
    generation.current += 1
    active.current.clear()
  }, [])

  const loadEvidence = useCallback((recordId: string): void => {
    if (active.current.has(recordId) || completed.current.has(recordId)) return
    active.current.add(recordId)
    const attempt = generation.current

    function fetchRecord(id: string): Promise<MemoryRecord | null> {
      const cached = records.current.get(id)
      if (cached) return cached
      const request = memoryApi.getRecord(id).catch((error: unknown) => {
        records.current.delete(id)
        throw error
      })
      records.current.set(id, request)
      return request
    }

    void fetchRecord(recordId)
      .then(async (journal) => {
        if (!journal?.evidence.length || journal.status === 'tombstoned') return EMPTY_RECORDS
        const ids = [...new Set(journal.evidence.map(({ id }) => id))].filter((id) => id !== recordId)
        const loaded = await Promise.all(ids.map(fetchRecord))
        return loaded.filter((record): record is MemoryRecord => record !== null && record.status !== 'tombstoned')
      })
      .then((loaded) => {
        if (generation.current !== attempt) return
        completed.current.add(recordId)
        setEvidence((prior) => new Map(prior).set(recordId, loaded))
      })
      .catch(() => { /* The journal or a cited record is unavailable. */ })
      .finally(() => {
        if (generation.current === attempt) active.current.delete(recordId)
      })
  }, [])

  return { evidence, loadEvidence }
}
