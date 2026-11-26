import { useCallback, useMemo, useState } from 'react'
import { memoryApi } from '../../api/client.ts'
import type { CrossChannelAuditItem } from '../../api/types.ts'
import { Badge, BrushButton, EmptyState, InkInput, InkSkeleton, InkTable, LayerTag, Plate } from '../../ui/index.ts'
import { recordSummary, recordsById, RequestError, shortDate, useResource } from './common.tsx'

export function MemoryAudit({ onRecord }: { onRecord: (id: string) => void }) {
  const [filter, setFilter] = useState('')
  const [recordId, setRecordId] = useState('')
  const loadAudit = useCallback(() => memoryApi.listAudit(recordId), [recordId])
  const audit = useResource(loadAudit)
  const loadRecords = useCallback(() => recordsById(audit.data?.map((row) => row.recordId) ?? []), [audit.data])
  const records = useResource(loadRecords, Boolean(audit.data?.length))

  const columns = useMemo(() => [
    { key: 'time', header: '时间', render: (row: CrossChannelAuditItem) => shortDate(row.tAt) },
    { key: 'record', header: '记录', render: (row: CrossChannelAuditItem) => {
      const record = records.data?.get(row.recordId)
      return record ? <BrushButton size="sm" variant="ghost" onClick={() => onRecord(record.id)}>
        <LayerTag layer={record.layer} /> {recordSummary(record, 54)}
      </BrushButton> : <span className="num">{row.recordId}</span>
    } },
    { key: 'channel', header: '看到它的通道', render: (row: CrossChannelAuditItem) => row.viewerChannel },
    { key: 'mode', header: '当时的模式', render: (row: CrossChannelAuditItem) => <Badge>{row.mode}</Badge> },
  ], [onRecord, records.data])

  return <div className="memory-stack">
    <Plate level="sunken" className="memory-inset">
      <form className="memory-actions" onSubmit={(event) => { event.preventDefault(); setRecordId(filter.trim()) }}>
        <InkInput placeholder="按记录 ID 过滤" aria-label="按记录 ID 过滤" monospace value={filter}
          onChange={(event) => setFilter(event.target.value)} />
        <BrushButton type="submit" variant="secondary">筛选</BrushButton>
      </form>
    </Plate>
    {audit.error !== undefined ? <RequestError error={audit.error} retry={audit.reload} /> :
      audit.loading ? <Plate className="memory-inset"><InkSkeleton rows={5} /></Plate> :
        !audit.data?.length ? <Plate><EmptyState glyph="无痕" description="没有符合条件的跨通道审计记录。" /></Plate> :
          <Plate>
            {records.error !== undefined && <RequestError error={records.error} retry={records.reload} />}
            <InkTable ariaLabel="跨通道审计" columns={columns} rows={audit.data}
              getRowKey={(item, index) => `${item.recordId}:${item.tAt}:${index}`} />
          </Plate>}
  </div>
}
