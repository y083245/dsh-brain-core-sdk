import { LAYERS, type Layer, type MemoryRecord, type SearchHit } from '@brain-core/sdk'
import { escapeHtml } from '../../shell/theme.ts'
import type { MemoryPageState } from './controller.ts'
import type {
  ConsolidationBudgetView,
  ConsolidationProposalView,
  CrossChannelAuditItem,
  CrossChannelMode,
  EvidenceNode,
  L3ProfileDiffView,
  L3ProfileVersionSummary,
  PersonSummary,
  SelfConflictView,
  ShadowL2CandidateView,
  ShadowL3PatchView,
} from './types.ts'

const CROSS_CHANNEL_MODES: readonly { readonly value: CrossChannelMode; readonly label: string }[] = [
  { value: 'off', label: '关闭 (off)' },
  { value: 'shadow', label: '影子 (shadow)' },
  { value: 'on', label: '开启 (on)' },
]

function isTombstoned(record: MemoryRecord): boolean {
  return record.status === 'tombstoned'
}

function renderRecordContent(record: MemoryRecord): string {
  if (isTombstoned(record)) {
    return '<span class="apple-badge tombstoned-badge" data-status="tombstoned">已遗忘（墓碑）</span>'
  }
  return `<pre class="mono record-content">${escapeHtml(JSON.stringify(record.content))}</pre>`
}

function renderRecordRow(record: MemoryRecord, extraHtml = ''): string {
  const tombstone = isTombstoned(record)
  return `<article class="glass-card memory-item" data-record-id="${escapeHtml(record.id)}" data-status="${escapeHtml(record.status)}">
  <header class="memory-item-header">
    <span class="apple-badge">${escapeHtml(record.layer)}</span>
    <span class="mono">${escapeHtml(record.id)}</span>
    <span class="apple-badge" data-visibility="${escapeHtml(record.visibility)}">${escapeHtml(record.visibility)}</span>
    <span class="apple-badge">${tombstone ? '已遗忘' : escapeHtml(record.status)}</span>
    ${extraHtml}
    <button type="button" class="link-btn" data-action="select-record" data-record-id="${escapeHtml(record.id)}">查看详情</button>
  </header>
  ${tombstone ? '' : `<div class="memory-item-meta"><span class="mono">${escapeHtml(record.kind)}</span> · <span class="mono">${escapeHtml(record.channel)}</span></div>`}
  <div class="memory-item-body">${renderRecordContent(record)}</div>
</article>`
}

function renderSearchHit(hit: SearchHit): string {
  const extra = `<span class="apple-badge">score ${escapeHtml(hit.score.toFixed(2))}</span>`
    + `<span class="apple-badge">${escapeHtml(hit.disclosure.speakable)}</span>`
    + `<span class="apple-badge">${escapeHtml(hit.disclosure.label)}</span>`
  return renderRecordRow(hit.record, extra)
}

function renderFilterBar(state: MemoryPageState): string {
  const allSelected = state.filter.layer === undefined
  const layerButtons = [
    `<button type="button" role="tab" data-filter-layer="all" aria-selected="${String(allSelected)}">全部</button>`,
    ...LAYERS.map((layer: Layer) => {
      const active = state.filter.layer === layer
      return `<button type="button" role="tab" data-filter-layer="${layer}" aria-selected="${String(active)}">${layer}</button>`
    }),
  ].join('')

  return `<section class="glass-card memory-toolbar" aria-label="三维筛选与检索">
  <div class="segmented" role="tablist" aria-label="记忆层级">${layerButtons}</div>
  <div class="filter-inputs">
    <label>人物 ID <input type="text" name="personId" value="${escapeHtml(state.filter.personId ?? '')}" placeholder="按人物筛选"></label>
    <label>通道 <input type="text" name="channel" value="${escapeHtml(state.filter.channel ?? '')}" placeholder="按通道筛选"></label>
    <div class="filter-actions">
      <button type="button" class="primary" data-action="apply-memory-filter">应用筛选</button>
      <button type="button" data-action="reset-memory-filter">重置</button>
    </div>
  </div>
  <form class="search-form" data-action="search">
    <input type="text" name="query" value="${escapeHtml(state.searchQuery ?? '')}" placeholder="关键词或语义检索">
    <button type="submit" class="primary">检索</button>
  </form>
  ${state.degraded ? '<div class="status-banner search-degraded" data-tone="info" role="status">检索降级：当前仅使用关键词召回</div>' : ''}
</section>`
}

function renderRecordList(state: MemoryPageState): string {
  const rows = state.searchHits !== null
    ? state.searchHits.map(renderSearchHit)
    : state.items.map((item) => renderRecordRow(item))

  const empty = '<p class="empty-hint">暂无匹配的记忆记录</p>'
  const nextBtn = state.nextCursor === undefined
    ? ''
    : `<button type="button" class="primary" data-action="load-next-page" data-cursor="${escapeHtml(state.nextCursor)}">加载下一页</button>`

  return `<section class="memory-list" aria-label="记忆列表">
  ${rows.length === 0 ? empty : rows.join('\n')}
  ${nextBtn}
</section>`
}

function renderEvidenceNode(node: EvidenceNode): string {
  const { record, children } = node
  const tombstone = isTombstoned(record)
  const childrenHtml = children.length === 0
    ? ''
    : `<ul class="evidence-children">${children.map(renderEvidenceNode).join('\n')}</ul>`

  return `<li class="evidence-node" data-record-id="${escapeHtml(record.id)}" data-layer="${escapeHtml(record.layer)}" data-status="${escapeHtml(record.status)}">
  <div class="evidence-node-head">
    <span class="apple-badge">${escapeHtml(record.layer)}</span>
    <span class="mono">${escapeHtml(record.id)}</span>
    <span class="apple-badge">${tombstone ? '已遗忘' : escapeHtml(record.status)}</span>
  </div>
  <div class="evidence-node-body">${renderRecordContent(record)}</div>
  ${childrenHtml}
</li>`
}

function renderAuditRows(items: readonly CrossChannelAuditItem[], emptyText: string): string {
  if (items.length === 0) return `<p class="empty-hint">${escapeHtml(emptyText)}</p>`
  const rows = items.map((item) => `<tr>
    <td class="mono">${escapeHtml(item.recordId)}</td>
    <td class="mono">${escapeHtml(item.viewerChannel)}</td>
    <td><span class="apple-badge">${escapeHtml(item.mode)}</span></td>
    <td class="mono">${escapeHtml(String(item.tAt))}</td>
  </tr>`).join('\n')
  return `<table class="audit-table">
  <thead><tr><th>记录 ID</th><th>查看通道</th><th>模式</th><th>时间</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`
}

function renderRecordDetail(state: MemoryPageState): string {
  const rec = state.selectedRecord
  if (rec === null) return ''
  const tombstone = isTombstoned(rec)

  const envelopeFields = tombstone
    ? `<dl class="envelope-fields">
        <dt>ID</dt><dd class="mono">${escapeHtml(rec.id)}</dd>
        <dt>层级</dt><dd>${escapeHtml(rec.layer)}</dd>
        <dt>状态</dt><dd><span class="apple-badge tombstoned-badge">已遗忘（墓碑）</span></dd>
        <dt>版本</dt><dd class="mono">${escapeHtml(String(rec.version))}</dd>
      </dl>`
    : `<dl class="envelope-fields">
        <dt>ID</dt><dd class="mono">${escapeHtml(rec.id)}</dd>
        <dt>层级</dt><dd>${escapeHtml(rec.layer)}</dd>
        <dt>类型</dt><dd class="mono">${escapeHtml(rec.kind)}</dd>
        <dt>来源</dt><dd class="mono">${escapeHtml(rec.source)}</dd>
        <dt>通道</dt><dd class="mono">${escapeHtml(rec.channel)}</dd>
        <dt>主体</dt><dd class="mono">${escapeHtml(rec.subjects.join(', '))}</dd>
        <dt>发言者</dt><dd class="mono">${escapeHtml(rec.actor)}</dd>
        <dt>披露等级</dt><dd><span class="apple-badge">${escapeHtml(rec.visibility)}</span></dd>
        <dt>信任度</dt><dd>${escapeHtml(rec.trust)}</dd>
        <dt>置信度</dt><dd class="mono">${escapeHtml(String(rec.confidence))}</dd>
        <dt>重要度</dt><dd class="mono">${escapeHtml(String(rec.importance))}</dd>
        <dt>事件时间</dt><dd class="mono">${escapeHtml(String(rec.tEvent))}</dd>
        <dt>写入时间</dt><dd class="mono">${escapeHtml(String(rec.tIngest))}</dd>
        <dt>状态</dt><dd>${escapeHtml(rec.status)}</dd>
        <dt>版本</dt><dd class="mono">${escapeHtml(String(rec.version))}</dd>
        ${rec.validFrom === undefined ? '' : `<dt>生效自</dt><dd class="mono">${escapeHtml(String(rec.validFrom))}</dd>`}
        ${rec.validTo === undefined ? '' : `<dt>失效于</dt><dd class="mono">${escapeHtml(String(rec.validTo))}</dd>`}
      </dl>`

  const chainHtml = state.evidenceChain === null
    ? ''
    : `<div class="evidence-chain"><h3>证据链（到 L0）</h3><ul class="evidence-tree">${renderEvidenceNode(state.evidenceChain)}</ul></div>`

  const actionsHtml = tombstone
    ? ''
    : `<div class="actions detail-actions">
    <button type="button" data-action="mark-outdated" data-record-id="${escapeHtml(rec.id)}" data-version="${escapeHtml(String(rec.version))}">标记过时</button>
    <button type="button" data-action="request-forget" data-record-id="${escapeHtml(rec.id)}">遗忘此记忆…</button>
  </div>`

  return `<section class="glass-card record-detail" aria-label="记忆详情与证据链">
  <h2>记忆详情</h2>
  ${envelopeFields}
  ${actionsHtml}
  <div class="detail-content"><h3>内容</h3>${renderRecordContent(rec)}</div>
  ${chainHtml}
  <div class="record-audit">
    <h3>这条记忆用在了哪里</h3>
    ${renderAuditRows(state.recordAudit, '暂无跨通道使用记录')}
  </div>
</section>`
}

function renderPendingForgetModal(state: MemoryPageState): string {
  if (state.pendingForget === null) return ''
  const { preview } = state.pendingForget
  const layerSummary = LAYERS.map((layer) => {
    const ids = preview.byLayer[layer]
    return `<li data-cascade-layer="${layer}">${layer}（${String(ids.length)} 条）：<span class="mono">${escapeHtml(ids.join(', ') || '无')}</span></li>`
  }).join('\n')

  return `<section class="glass-card forget-confirm-modal" role="dialog" aria-modal="true" aria-label="遗忘级联确认">
  <h2>确认遗忘</h2>
  <p>目标记录：<span class="mono">${escapeHtml(preview.targetId)}</span>（共受影响 ${String(preview.affectedIds.length)} 条衍生记忆）</p>
  <ul class="cascade-list">${layerSummary}</ul>
  <div class="modal-actions">
    <button type="button" class="primary" data-action="confirm-forget">确认遗忘</button>
    <button type="button" data-action="cancel-forget">取消</button>
  </div>
</section>`
}

function renderCrossChannelPanel(state: MemoryPageState): string {
  const modeButtons = CROSS_CHANNEL_MODES.map(({ value, label }) => {
    const active = state.crossChannelMode === value
    return `<button type="button" role="tab" data-cross-channel-mode="${value}" aria-selected="${String(active)}">${escapeHtml(label)}</button>`
  }).join('')

  return `<section class="glass-card cross-channel-panel" aria-label="跨通道模式与影子审计">
  <h2>跨通道共享模式</h2>
  <div class="segmented" role="tablist" aria-label="跨通道模式">${modeButtons}</div>
  <h3>shadow 模式下本来会注入什么</h3>
  ${renderAuditRows(state.shadowAudit, '暂无 shadow 审计记录')}
</section>`
}

function renderPersonsPanel(state: MemoryPageState): string {
  const list = state.persons.length === 0
    ? '<p class="empty-hint">暂无人物档案</p>'
    : state.persons.map((person: PersonSummary) => `<li class="person-item" data-person-id="${escapeHtml(person.personId)}">
        <span class="mono">${escapeHtml(person.personId)}</span>
        <span>账号：<span class="mono">${escapeHtml(person.accounts.join(', ') || '无')}</span></span>
        <span>别名：${escapeHtml(person.aliases.join(', ') || '无')}</span>
      </li>`).join('\n')

  return `<section class="glass-card persons-panel" aria-label="人物账号管理">
  <h2>人物账号合并与拆分</h2>
  <ul class="persons-list">${list}</ul>
  <div class="person-actions">
    <div class="person-action-group">
      <input type="text" name="merge-from" data-field="merge-from" value="" placeholder="源人物 ID (from)">
      <input type="text" name="merge-into" data-field="merge-into" value="" placeholder="目标人物 ID (into)">
      <button type="button" data-action="merge-person">合并人物</button>
    </div>
    <div class="person-action-group">
      <input type="text" name="split-person-id" data-field="split-person-id" value="" placeholder="原人物 ID">
      <input type="text" name="split-accounts" data-field="split-accounts" value="" placeholder="拆出账号（逗号分隔）">
      <button type="button" data-action="split-person">拆分账号</button>
    </div>
  </div>
</section>`
}

const PROPOSAL_STATUS_LABELS: Readonly<Record<ConsolidationProposalView['status'], string>> = {
  pending: '待审阅',
  approved: '已生效',
  rejected: '已驳回',
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function renderSubnav(state: MemoryPageState): string {
  const pendingCount = state.proposals.filter((p) => p.status === 'pending').length
  const pendingBadge = pendingCount > 0
    ? `<span class="apple-badge badge-accent" data-role="pending-proposals-badge">${String(pendingCount)}</span>`
    : ''
  return `<div class="segmented memory-subnav" role="tablist" aria-label="记忆视图切换">
  <button type="button" role="tab" data-subview="browse" aria-selected="${String(state.subView === 'browse')}">记忆浏览与证据链</button>
  <button type="button" role="tab" data-subview="consolidation" aria-selected="${String(state.subView === 'consolidation')}">L3 画像与夜间审阅${pendingBadge}</button>
</div>`
}

function renderTokenBudgetMeter(budget: ConsolidationBudgetView | null): string {
  const used = budget?.usedTokensToday ?? 0
  const cap = budget?.dailyTokenCap ?? 0
  const ratio = cap > 0 ? clampUnit(used / cap) : 0
  const pct = Math.round(ratio * 100)
  const radius = 26
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference * (1 - ratio)
  const strokeColor = ratio >= 0.85 ? '#FF9F0A' : '#0A84FF'

  return `<div class="token-budget-meter" aria-label="日 Token 预算">
  <svg class="token-budget-svg" viewBox="0 0 68 68" width="68" height="68" role="img" aria-label="Token 用量环形进度条">
    <circle cx="34" cy="34" r="${String(radius)}" fill="none" stroke="rgba(127, 127, 127, 0.24)" stroke-width="6" />
    <circle cx="34" cy="34" r="${String(radius)}" fill="none" stroke="${strokeColor}" stroke-width="6" stroke-linecap="round"
      stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${dashOffset.toFixed(2)}"
      transform="rotate(-90 34 34)" />
    <text x="34" y="38" text-anchor="middle" fill="currentColor" font-size="12" font-weight="600">${String(pct)}%</text>
  </svg>
  <div class="consolidation-metric">
    <span class="consolidation-metric-label">今日归纳 Token 额度</span>
    <span class="mono">${escapeHtml(String(used))} / ${escapeHtml(String(cap))}</span>
  </div>
</div>`
}

function renderConsolidationHero(state: MemoryPageState): string {
  const currentVersion = state.l3Versions.find((v) => v.current) ?? state.l3Versions[0]
  const pendingCount = state.proposals.filter((p) => p.status === 'pending').length
  const lastTo = state.consolidationBudget?.lastConsolidatedTo
  const lastToText = lastTo !== undefined && lastTo > 0 ? String(lastTo) : '暂无'

  return `<section class="glass-card consolidation-hero" aria-label="夜间归纳与 L3 结算概览">
  <div class="consolidation-metric">
    <span class="consolidation-metric-label">当前生效 L3 画像版本</span>
    <span class="consolidation-metric-value mono">${currentVersion ? `v${escapeHtml(String(currentVersion.version))}` : '暂无'}</span>
  </div>
  <div class="consolidation-metric">
    <span class="consolidation-metric-label">待审阅影子提案</span>
    <span class="consolidation-metric-value mono">${String(pendingCount)}</span>
    <span class="consolidation-metric-label mono">上次归纳水位：${escapeHtml(lastToText)}</span>
  </div>
  ${renderTokenBudgetMeter(state.consolidationBudget)}
  <div class="consolidation-hero-action">
    <button type="button" class="primary" data-action="trigger-consolidation">立即运行夜间影子归纳与结算</button>
  </div>
</section>`
}

function renderShadowL2Candidate(cand: ShadowL2CandidateView): string {
  const confPct = Math.round(clampUnit(cand.confidence) * 100)
  const quoteText = typeof cand.content.quote === 'string' && cand.content.quote !== ''
    ? cand.content.quote
    : typeof cand.content.emotionQuote === 'string' && cand.content.emotionQuote !== ''
      ? cand.content.emotionQuote
      : null
  const quoteHtml = quoteText === null ? '' : `<span class="quote-pill">原话：${escapeHtml(quoteText)}</span>`
  const evidenceHtml = cand.evidenceIds
    .map((id) => `<span class="apple-badge mono">${escapeHtml(id)}</span>`)
    .join(' ')

  return `<article class="shadow-l2-card" data-candidate-id="${escapeHtml(cand.id)}">
  <header class="memory-item-header">
    <span class="apple-badge">${escapeHtml(cand.kind)}</span>
    <span class="mono">${escapeHtml(cand.channel)}</span>
    <span class="apple-badge mono">主体：${escapeHtml(cand.subjects.join(', ') || '无')}</span>
  </header>
  <div>
    <span class="consolidation-metric-label">置信度 ${escapeHtml(String(confPct))}% · 重要度 ${escapeHtml(String(cand.importance))}</span>
    <div class="confidence-bar" aria-label="置信度"><div class="confidence-bar-fill" style="width:${String(confPct)}%"></div></div>
  </div>
  ${quoteHtml}
  <pre class="mono record-content">${escapeHtml(JSON.stringify(cand.content))}</pre>
  <div class="shadow-l2-evidence">${evidenceHtml}</div>
</article>`
}

function renderSelfConflictCard(
  conflict: SelfConflictView,
  decisions: Readonly<Record<string, string>>,
): string {
  const selectedId = decisions[conflict.id]
  const renderOption = (label: string, recordId: string, statement: string): string => {
    const selected = selectedId === recordId
    const recommended = conflict.recommendedKeepId === recordId
    return `<div class="self-conflict-option" data-record-id="${escapeHtml(recordId)}" data-selected="${String(selected)}">
      <div class="memory-item-header">
        <strong>${escapeHtml(label)}</strong>
        <span class="mono">${escapeHtml(recordId)}</span>
        ${recommended ? '<span class="apple-badge badge-accent">建议保留</span>' : ''}
        ${selected ? '<span class="apple-badge version-badge-current">已选保留</span>' : ''}
      </div>
      <p>${escapeHtml(statement)}</p>
      <button type="button" data-action="choose-conflict-keep" data-conflict-id="${escapeHtml(conflict.id)}" data-keep-id="${escapeHtml(recordId)}" aria-pressed="${String(selected)}">保留此陈述</button>
    </div>`
  }

  return `<section class="self-conflict-card" data-conflict-id="${escapeHtml(conflict.id)}" aria-label="自我陈述冲突裁决">
  <header class="memory-item-header">
    <span class="apple-badge">L1.6 自我陈述冲突</span>
    <span>原因：${escapeHtml(conflict.reason)}</span>
  </header>
  <div class="self-conflict-columns">
    ${renderOption('陈述 A', conflict.recordAId, conflict.statementA)}
    ${renderOption('陈述 B', conflict.recordBId, conflict.statementB)}
  </div>
</section>`
}

function renderShadowL3Preview(
  patch: ShadowL3PatchView | null,
  skippedReason: ConsolidationProposalView['skippedL3Reason'],
): string {
  const guardBadge = skippedReason === 'only-external-evidence'
    ? '<span class="apple-badge m4-guard-badge" data-guard="only-external-evidence">M4 外部证据过滤：only-external-evidence（仅外部证据，L3 已跳过变更）</span>'
    : skippedReason === 'insufficient-new-evidence'
      ? '<span class="apple-badge m4-guard-badge" data-guard="insufficient-new-evidence">M4/新鲜度门控：insufficient-new-evidence（新增有效证据不足，L3 已跳过）</span>'
      : '<span class="apple-badge m4-guard-badge" data-guard="passed">M4 外部证据过滤：已通过可信度校验</span>'

  if (patch === null) {
    return `<section class="shadow-l3-preview" aria-label="L3 结算影子预览">
    <header class="memory-item-header">${guardBadge}</header>
    <p class="empty-hint">本次影子提案未产生 L3 画像变更</p>
  </section>`
  }

  const shieldBadge = patch.preservedOwnerKeys.length > 0
    ? `<span class="apple-badge owner-lock-shield">主人锁定 · 自动结算保留：${escapeHtml(patch.preservedOwnerKeys.join(', '))}</span>`
    : ''
  const diffRows = [
    ...patch.added.map((k) => `<div class="diff-row diff-added"><span class="mono">+ ${escapeHtml(k)}</span></div>`),
    ...patch.removed.map((k) => `<div class="diff-row diff-removed"><span class="mono">- ${escapeHtml(k)}</span></div>`),
    ...patch.changed.map((k) => `<div class="diff-row diff-changed"><span class="mono">~ ${escapeHtml(k)}</span></div>`),
  ].join('\n')

  return `<section class="shadow-l3-preview" aria-label="L3 结算影子预览">
  <header class="memory-item-header">
    <span>L3 影子变更预览（基于 v${escapeHtml(String(patch.baseVersion))}）</span>
    ${guardBadge}
    ${shieldBadge}
    <span class="apple-badge">stableChanged: ${patch.stableChanged ? '是' : '否'}</span>
  </header>
  <div class="l3-diff-viewer">${diffRows || '<p class="empty-hint">无字段键增删改</p>'}</div>
  <pre class="mono record-content">${escapeHtml(patch.stable)}</pre>
  <pre class="mono record-content">${escapeHtml(JSON.stringify(patch.data))}</pre>
</section>`
}

function renderShadowProposalCard(
  proposal: ConsolidationProposalView,
  decisions: Readonly<Record<string, string>>,
): string {
  const l2Html = proposal.l2Candidates.length === 0
    ? '<p class="empty-hint">暂无 L2 归纳候选</p>'
    : `<div class="shadow-l2-grid">${proposal.l2Candidates.map(renderShadowL2Candidate).join('\n')}</div>`

  const correctionsHtml = proposal.corrections.length === 0
    ? ''
    : `<ul class="corrections-list">${proposal.corrections.map((c) => `<li><span class="apple-badge">${escapeHtml(c.action)}</span> <span class="mono">${escapeHtml(c.targetId)}</span>：${escapeHtml(c.reason)}</li>`).join('\n')}</ul>`

  const conflictsHtml = proposal.selfConflicts
    .map((conflict) => renderSelfConflictCard(conflict, decisions))
    .join('\n')

  const actionsHtml = proposal.status === 'pending'
    ? `<div class="modal-actions">
        <button type="button" class="primary" data-action="approve-proposal" data-proposal-id="${escapeHtml(proposal.id)}">确认生效并提交新版本</button>
        <button type="button" data-action="reject-proposal" data-proposal-id="${escapeHtml(proposal.id)}">驳回丢弃</button>
      </div>`
    : ''

  return `<article class="glass-card shadow-proposal-card" data-proposal-id="${escapeHtml(proposal.id)}" data-status="${escapeHtml(proposal.status)}">
  <header class="memory-item-header">
    <span class="mono">${escapeHtml(proposal.id)}</span>
    <span class="apple-badge">${escapeHtml(PROPOSAL_STATUS_LABELS[proposal.status])}</span>
    <span class="mono">窗口：${escapeHtml(String(proposal.window.from))} → ${escapeHtml(String(proposal.window.to))}</span>
    <span class="apple-badge mono">Token：${escapeHtml(String(proposal.tokensUsed))}</span>
  </header>
  ${l2Html}
  ${correctionsHtml}
  ${conflictsHtml}
  ${renderShadowL3Preview(proposal.l3SelfPatch, proposal.skippedL3Reason)}
  ${actionsHtml}
</article>`
}

function renderShadowProposalDeck(state: MemoryPageState): string {
  const cards = state.proposals.length === 0
    ? '<p class="empty-hint">暂无夜间影子提案</p>'
    : state.proposals.map((p) => renderShadowProposalCard(p, state.conflictDecisions)).join('\n')

  return `<section class="shadow-proposal-deck" aria-label="夜间影子提案审阅台">
  <h2>夜间影子提案审阅台</h2>
  ${cards}
</section>`
}

function renderL3VersionCard(ver: L3ProfileVersionSummary): string {
  const authorBadge = ver.author === 'owner'
    ? '<span class="apple-badge version-badge-owner">主人钦定</span>'
    : ver.author === 'settlement'
      ? '<span class="apple-badge version-badge-settlement">夜间结算</span>'
      : ''
  const currentBadge = ver.current ? '<span class="apple-badge version-badge-current">当前生效</span>' : ''
  const evidenceBadge = ver.evidenceCount === undefined
    ? ''
    : `<span class="apple-badge mono">证据数: ${escapeHtml(String(ver.evidenceCount))}</span>`
  const lockShield = ver.ownerLockedKeys !== undefined && ver.ownerLockedKeys.length > 0
    ? `<span class="apple-badge owner-lock-shield">主人锁定 · 自动结算保留：${escapeHtml(ver.ownerLockedKeys.join(', '))}</span>`
    : ''

  return `<article class="glass-card l3-version-card" data-l3-version="${escapeHtml(String(ver.version))}" data-current="${String(ver.current)}">
  <header class="memory-item-header">
    <span class="mono">v${escapeHtml(String(ver.version))}</span>
    <span class="apple-badge">${escapeHtml(ver.status)}</span>
    ${currentBadge}
    ${authorBadge}
    ${evidenceBadge}
  </header>
  <div class="memory-item-meta mono">tAt: ${escapeHtml(String(ver.tAt))}</div>
  ${lockShield}
  <div class="modal-actions">
    <button type="button" data-action="compare-l3" data-version="${escapeHtml(String(ver.version))}">对比版本</button>
    <button type="button" data-action="rollback-l3" data-version="${escapeHtml(String(ver.version))}">回滚至此版本</button>
  </div>
</article>`
}

function renderL3DiffViewer(diff: L3ProfileDiffView | null, versions: readonly L3ProfileVersionSummary[]): string {
  if (diff === null) {
    return `<section class="glass-card l3-diff-viewer" aria-label="L3 双栏版本对比">
    <h2>L3 双栏毛玻璃差异对比</h2>
    <p class="empty-hint">选择两个 L3 版本以查看双栏差异</p>
  </section>`
  }

  const fromVer = versions.find((v) => v.version === diff.from)
  const toVer = versions.find((v) => v.version === diff.to)
  const lockedKeys = [...new Set([...(fromVer?.ownerLockedKeys ?? []), ...(toVer?.ownerLockedKeys ?? [])])]
  const lockShield = lockedKeys.length > 0
    ? `<span class="apple-badge owner-lock-shield">主人锁定 · 自动结算保留：${escapeHtml(lockedKeys.join(', '))}</span>`
    : ''

  const addedRows = diff.added.map((k) => `<div class="diff-row diff-added"><span class="mono">+ ${escapeHtml(k)}</span></div>`)
  const removedRows = diff.removed.map((k) => `<div class="diff-row diff-removed"><span class="mono">- ${escapeHtml(k)}</span></div>`)
  const changedRows = diff.changed.map((k) => `<div class="diff-row diff-changed"><span class="mono">~ ${escapeHtml(k)}</span></div>`)

  return `<section class="glass-card l3-diff-viewer" aria-label="L3 双栏版本对比">
  <header class="memory-item-header">
    <h2>L3 双栏毛玻璃差异对比</h2>
    <span class="mono">v${escapeHtml(String(diff.from))} → v${escapeHtml(String(diff.to))}</span>
    <span class="apple-badge" data-stable-changed="${String(diff.stableChanged)}">stableChanged: ${diff.stableChanged ? '是' : '否'}</span>
    ${lockShield}
  </header>
  <div class="l3-diff-columns">
    <div class="l3-diff-pane" data-pane="from">
      <strong class="mono">基准 v${escapeHtml(String(diff.from))}</strong>
      ${removedRows.join('\n') || '<span class="empty-hint">无删除字段</span>'}
      ${changedRows.join('\n')}
    </div>
    <div class="l3-diff-pane" data-pane="to">
      <strong class="mono">目标 v${escapeHtml(String(diff.to))}</strong>
      ${addedRows.join('\n') || '<span class="empty-hint">无新增字段</span>'}
      ${changedRows.join('\n')}
    </div>
  </div>
</section>`
}

function renderL3OwnerEditor(versions: readonly L3ProfileVersionSummary[]): string {
  const current = versions.find((v) => v.current) ?? versions[0]
  const stableVal = current?.stable ?? ''
  const dataVal = current?.data ? JSON.stringify(current.data, null, 2) : '{}'
  const lockedVal = current?.ownerLockedKeys?.join(', ') ?? ''

  return `<section class="glass-card l3-owner-editor" aria-label="主人手动编辑 L3 画像">
  <h2>主人直编 L3 画像</h2>
  <form data-action="save-owner-l3">
    <label>稳定摘要 (stable)
      <textarea name="stable" rows="3">${escapeHtml(stableVal)}</textarea>
    </label>
    <label>结构化画像 (data JSON)
      <textarea name="dataJson" rows="5">${escapeHtml(dataVal)}</textarea>
    </label>
    <label>主人锁定键（逗号分隔，自动结算保留）
      <input type="text" name="lockedKeys" value="${escapeHtml(lockedVal)}" placeholder="例如：hobbies, tone">
    </label>
    <button type="submit" class="primary">保存为主人钦定版本</button>
  </form>
</section>`
}

/**
 * Renders the Apple Frosted Glass L3 Profile Version Timeline, Xcode FileMerge dual-pane Diff viewer,
 * Owner direct editor, SVG token budget meter, and Nightly Shadow Consolidation review deck.
 */
export function renderL3ConsolidationWorkspace(state: MemoryPageState): string {
  const timelineCards = state.l3Versions.length === 0
    ? '<p class="empty-hint">暂无 L3 画像版本历史</p>'
    : state.l3Versions.map(renderL3VersionCard).join('\n')

  return `<div class="l3-consolidation-workspace">
  ${renderConsolidationHero(state)}
  ${renderShadowProposalDeck(state)}
  <div class="l3-version-workspace">
    <section class="l3-version-timeline" aria-label="L3 版本时间轴">
      <h2>L3 画像版本时间轴</h2>
      ${timelineCards}
    </section>
    <div class="l3-version-inspector">
      ${renderL3DiffViewer(state.l3Diff, state.l3Versions)}
      ${renderL3OwnerEditor(state.l3Versions)}
    </div>
  </div>
</div>`
}

/**
 * Renders the memory browser, evidence chain viewer, forget confirmation dialog,
 * cross-channel switch & shadow audit panel, person identity panel, and L3 consolidation workspace
 * using the console's Apple vibrancy classes and strict HTML escaping.
 */
export function renderMemoryPage(state: MemoryPageState): string {
  const banners: string[] = []
  if (state.conflictWarning !== null) {
    banners.push(`<div class="status-banner conflict-warning" data-tone="warning" role="alert">${escapeHtml(state.conflictWarning)}</div>`)
  }
  if (state.errorMessage !== null) {
    banners.push(`<div class="status-banner error-banner" data-tone="warning" role="alert">${escapeHtml(state.errorMessage)}</div>`)
  }
  if (state.lastForgetReport !== null) {
    const r = state.lastForgetReport
    banners.push(
      `<div class="status-banner forget-report" data-tone="info" role="status">已遗忘：tombstoned=${String(r.tombstoned)}，invalidated=${String(r.invalidated)}，l3Flagged=${String(r.l3Flagged)}</div>`,
    )
  }
  if (state.rollbackNotice !== null) {
    banners.push(`<div class="status-banner rollback-notice" data-tone="info" role="status">${escapeHtml(state.rollbackNotice)}</div>`)
  }

  const bodyHtml = state.subView === 'consolidation'
    ? renderL3ConsolidationWorkspace(state)
    : `${renderFilterBar(state)}
  ${renderPendingForgetModal(state)}
  ${renderRecordList(state)}
  ${renderRecordDetail(state)}
  ${renderCrossChannelPanel(state)}
  ${renderPersonsPanel(state)}`

  return `<div class="memory-page">
  ${renderSubnav(state)}
  ${banners.join('\n')}
  ${bodyHtml}
</div>`
}
