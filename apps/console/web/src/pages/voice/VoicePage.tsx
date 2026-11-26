import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import { LayoutGroup, motion } from 'motion/react'
import { chatApi, DEFAULT_CHAT_CHANNEL, settingsApi } from '../../api/client.ts'
import { ApiError, type AgentProcessStatus, type ChatHistoryEntry, type ChatMessagesResponse, type MemoryRecord, type WakeMetricSample } from '../../api/types.ts'
import { POLL_INTERVALS, usePolling } from '../../data/polling.ts'
import { useInktideStore } from '../../data/store.ts'
import { useInk } from '../../ink/InkProvider.tsx'
import { summarizeRecordContent } from '../../lib/memoryHelpers.ts'
import { getPreset } from '../../motion/presets.ts'
import { DUR, EASE } from '../../motion/tokens.ts'
import { useMotionLevel } from '../../motion/useMotionLevel.ts'
import { useConsoleShellData } from '../../shell/ConsoleShell.tsx'
import { useShellNavigation } from '../../shell/PageTransition.tsx'
import { playReplyTick } from '../../sound/synth.ts'
import { BrushButton } from '../../ui/BrushButton.tsx'
import { Enso } from '../../ui/Enso.tsx'
import { InkTextarea } from '../../ui/InkInput.tsx'
import { InkNumber } from '../../ui/InkNumber.tsx'
import { InkSelect } from '../../ui/InkSelect.tsx'
import { EmptyState, ErrorState, InkSkeleton } from '../../ui/InkStates.tsx'
import { LayerTag } from '../../ui/LayerTag.tsx'
import { MagneticButton } from '../../ui/MagneticButton.tsx'
import { PageHeader } from '../../ui/PageHeader.tsx'
import { Plate } from '../../ui/Plate.tsx'
import { toast } from '../../ui/SealToast.tsx'
import { CHAT_STATE_LABELS, chatEnsoState, latestChatMetric } from './chatStatus.ts'
import { SafeMarkdown } from './SafeMarkdown.tsx'
import { useVoiceEvidence } from './useVoiceEvidence.ts'
import {
  reconcileOutgoing,
  saveVoiceDraft,
  selectVoiceChannel,
  sendVoiceMessage,
  useVoiceSession,
  type OutgoingMessage,
} from './voiceSession.ts'
import './voice.css'

const EMPTY_OUTGOING: readonly OutgoingMessage[] = []
const EMPTY_MESSAGES: readonly ChatHistoryEntry[] = []
const EMPTY_EVIDENCE: readonly MemoryRecord[] = []
const REPLY_PULSE_MS = 1_000
const AT_BOTTOM_PX = 32
const EVIDENCE_DATE = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' })

interface DisplayMessage {
  readonly id: string
  readonly direction: ChatHistoryEntry['direction']
  readonly text: string
  readonly tEvent: number
  readonly recordId?: string
  readonly outgoing?: OutgoingMessage
}

interface EvidenceHover {
  readonly messageRecordId: string
  readonly recordId: string
  readonly source: HTMLElement
}

interface InkCurve {
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
}

function messageKey(message: ChatHistoryEntry): string {
  return message.direction + ':' + message.messageId
}

function makeMessageId(): string {
  const seed = globalThis.crypto.getRandomValues(new Uint32Array(2))
  return `voice_${Date.now().toString(36)}_${Array.from(seed, (part) => part.toString(36)).join('_')}`
}

function combineMessages(
  history: readonly ChatHistoryEntry[],
  outgoing: readonly OutgoingMessage[],
): readonly DisplayMessage[] {
  const pending = new Map(outgoing.map((message) => [message.messageId, message]))
  const messages: DisplayMessage[] = history.map((message) => {
    const local = message.direction === 'inbound' ? pending.get(message.messageId) : undefined
    if (local) pending.delete(message.messageId)
    return {
      id: message.messageId,
      direction: message.direction,
      text: message.text,
      tEvent: message.tEvent,
      recordId: message.recordId,
      ...(local?.status === 'sending' ? { outgoing: local } : {}),
    }
  })
  for (const message of pending.values()) {
    messages.push({
      id: message.messageId,
      direction: 'inbound',
      text: message.text,
      tEvent: message.tEvent,
      outgoing: message,
    })
  }
  return messages.sort((left, right) => left.tEvent - right.tEvent)
}

function evidenceDate(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '—'
  const parts = EVIDENCE_DATE.formatToParts(timestamp)
  return parts.filter((part) => part.type === 'month' || part.type === 'day').map((part) => part.value).join('-')
}

function compactTokens(tokens: number): string {
  return tokens < 1_000 ? String(tokens) : `${(tokens / 1_000).toFixed(1)}k`
}

function HistoryError({ error, onRetry }: { readonly error: unknown; readonly onRetry: () => void }) {
  return (
    <ErrorState
      message={error instanceof Error ? error.message : '无法读取对话'}
      {...(error instanceof ApiError && { code: error.code, requestId: error.requestId })}
      onRetry={onRetry}
    />
  )
}

function VoiceConversation({
  channel,
  chat,
  metrics,
  selection,
  modelLoading,
  modelError,
  refreshModel,
}: {
  readonly channel: string
  readonly chat: AgentProcessStatus | undefined
  readonly metrics: readonly WakeMetricSample[] | undefined
  readonly selection: { readonly model?: string; readonly effort?: string } | undefined
  readonly modelLoading: boolean
  readonly modelError: unknown
  readonly refreshModel: () => void
}) {
  const { navigate } = useShellNavigation()
  const { notifyNewMemory } = useConsoleShellData()
  const { drafts, outgoing } = useVoiceSession()
  const ink = useInk()
  const motionLevel = useMotionLevel()
  const roleName = useInktideStore((state) => state.roleCardName) || '她'
  const fullMotion = motionLevel === 'full'
  const [draftId, setDraftId] = useState(makeMessageId)
  const [hasUnread, setHasUnread] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [composerFocused, setComposerFocused] = useState(false)
  const [rippleKey, setRippleKey] = useState(0)
  const [pulseKey, setPulseKey] = useState(0)
  const [reveals, setReveals] = useState<ReadonlyMap<string, string>>(new Map())
  const [hover, setHover] = useState<EvidenceHover | null>(null)
  const [curve, setCurve] = useState<InkCurve | null>(null)
  const layoutRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const ensoRef = useRef<HTMLDivElement>(null)
  const composing = useRef(false)
  const atBottom = useRef(true)
  const previousHistory = useRef<ReadonlyMap<string, string> | null>(null)
  const previousVisible = useRef<ReadonlyMap<string, string> | null>(null)
  const initialHistoryDisplayed = useRef(false)
  const pulseTimer = useRef<number | null>(null)
  const evidenceTargets = useRef(new Map<string, HTMLButtonElement>())
  const { evidence, loadEvidence } = useVoiceEvidence()

  const draft = drafts.get(channel) ?? ''
  const pending = outgoing.get(channel) ?? EMPTY_OUTGOING
  const sending = pending.some((message) => message.status === 'sending')

  const onMessages = useCallback((response: ChatMessagesResponse) => {
    const before = previousHistory.current
    previousHistory.current = new Map(response.items.map((item) => [messageKey(item), item.text]))
    reconcileOutgoing(channel, new Set(response.items.filter((item) => item.direction === 'inbound').map((item) => item.messageId)))
    if (!before) return
    const changed = new Map<string, string>()
    for (const message of response.items) {
      const key = messageKey(message)
      if (!before.has(key) && message.recordId) {
        notifyNewMemory(message.recordId)
      }
      if (message.direction !== 'outbound') continue
      const oldText = before.get(key)
      if (oldText === message.text) continue
      if (oldText === undefined || message.text.startsWith(oldText)) changed.set(message.messageId, oldText ?? '')
    }
    if (changed.size === 0) return
    setReveals((current) => new Map([...current, ...changed]))
    setSpeaking(true)
    setPulseKey((key) => key + changed.size)
    playReplyTick()
    if (pulseTimer.current !== null) window.clearTimeout(pulseTimer.current)
    pulseTimer.current = window.setTimeout(() => {
      setSpeaking(false)
      setReveals(new Map())
      pulseTimer.current = null
    }, REPLY_PULSE_MS)
  }, [channel, notifyNewMemory])

  const history = usePolling(() => chatApi.getMessages(channel), POLL_INTERVALS.chatActiveMs, { onData: onMessages })
  const messages = history.data?.items ?? EMPTY_MESSAGES
  const timeline = useMemo(() => combineMessages(messages, pending), [messages, pending])
  const listening = composerFocused || draft.trim() !== ''
  const state = chatEnsoState(chat, sending, speaking, listening)
  const lastReply = timeline.findLast((item) => item.direction === 'outbound')
  const evidenceRecordId = hover?.messageRecordId ?? lastReply?.recordId
  const currentEvidence = evidenceRecordId ? evidence.get(evidenceRecordId) ?? EMPTY_EVIDENCE : EMPTY_EVIDENCE
  const metric = latestChatMetric(metrics, channel)
  const metricTokens = metric?.steps.reduce((count, step) => count + step.inputTokens + step.outputTokens, 0)

  useEffect(() => () => {
    if (pulseTimer.current !== null) window.clearTimeout(pulseTimer.current)
  }, [])

  useEffect(() => {
    if (lastReply?.recordId) loadEvidence(lastReply.recordId)
  }, [lastReply?.recordId, loadEvidence])

  useLayoutEffect(() => {
    const container = scrollRef.current
    if (!container) return
    const before = previousVisible.current
    const readingHistory = !initialHistoryDisplayed.current && history.data !== undefined
    if (readingHistory) initialHistoryDisplayed.current = true
    const next = new Map(timeline.map((item) => [`${item.direction}:${item.id}`, item.text]))
    previousVisible.current = next
    const changes = before && !readingHistory
      ? timeline.filter((item) => before.get(`${item.direction}:${item.id}`) !== item.text)
      : []
    if (!before || readingHistory || (changes.length > 0 && atBottom.current)) {
      container.scrollTop = container.scrollHeight
    } else if (changes.length > 0) {
      setHasUnread(true)
    }

    if (!fullMotion || changes.length === 0) return
    const scrollBounds = container.getBoundingClientRect()
    const rows = new Map([...container.querySelectorAll<HTMLElement>('[data-voice-message]')].map(
      (element) => [element.dataset.voiceMessage, element],
    ))
    for (const item of changes) {
      const owner = item.direction === 'inbound'
      if (owner && item.outgoing?.status !== 'sending') continue
      const key = `${item.direction}:${item.id}`
      const row = rows.get(key)?.getBoundingClientRect()
      if (!row || row.bottom <= scrollBounds.top || row.top >= scrollBounds.bottom) continue
      const isIncrementalUpdate = !owner && before?.has(key) === true
      ink.splat({
        x: owner ? row.right : row.left,
        y: row.top + row.height * 0.5,
        radius: 70,
        color: owner ? 'smoke' : 'zhusha',
        amount: owner ? 0.3 : isIncrementalUpdate ? 0.12 : 0.35,
      })
    }
  }, [timeline, fullMotion, history.data, ink])

  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    if (typeof IntersectionObserver === 'undefined') {
      function loadVisibleRecords(): void {
        for (const row of scroll?.querySelectorAll<HTMLElement>('[data-voice-record]') ?? []) {
          if (row.dataset.voiceRecord) loadEvidence(row.dataset.voiceRecord)
        }
      }
      loadVisibleRecords()
      const changes = new MutationObserver(loadVisibleRecords)
      changes.observe(scroll, { childList: true })
      return () => changes.disconnect()
    }
    const observer = new IntersectionObserver((entries) => {
      for (const { target, boundingClientRect, rootBounds, isIntersecting } of entries) {
        const row = target as HTMLElement
        if (isIntersecting && row.dataset.voiceRecord) loadEvidence(row.dataset.voiceRecord)
        if (!fullMotion || !rootBounds) continue
        const center = boundingClientRect.top + boundingClientRect.height * 0.5
        const distance = Math.abs(center - (rootBounds.top + rootBounds.height * 0.5))
        row.style.setProperty('--voice-distance', String(Math.min(1, distance / Math.max(1, rootBounds.height * 0.58))))
      }
    }, { root: scroll, threshold: [0, 0.25, 0.5, 0.75, 1] })
    function observeRow(row: Node): void {
      if (!(row instanceof HTMLElement) || !row.hasAttribute('data-voice-message')) return
      if (!fullMotion) row.style.removeProperty('--voice-distance')
      observer.observe(row)
    }
    for (const row of scroll.children) observeRow(row)
    const changes = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const row of mutation.removedNodes) {
          if (row instanceof HTMLElement) observer.unobserve(row)
        }
        for (const row of mutation.addedNodes) observeRow(row)
      }
    })
    changes.observe(scroll, { childList: true })
    return () => {
      changes.disconnect()
      observer.disconnect()
    }
  }, [fullMotion, loadEvidence])

  useEffect(() => {
    if (!fullMotion || state !== 'thinking') return
    const bounds = ensoRef.current?.getBoundingClientRect()
    if (!bounds) return
    return ink.stir({
      x: bounds.left + bounds.width * 0.5,
      y: bounds.top + bounds.height * 0.5,
      radius: 140,
      strength: 0.9,
      durationMs: 60_000,
    })
  }, [fullMotion, ink, state])

  useLayoutEffect(() => {
    if (!hover) {
      setCurve(null)
      return
    }
    const layout = layoutRef.current
    const target = evidenceTargets.current.get(hover.recordId)
    if (!layout || !target) {
      setCurve(null)
      return
    }
    function update(): void {
      if (!layout || !target || !hover || !hover.source.isConnected || !target.isConnected) {
        setCurve(null)
        return
      }
      const frame = layout.getBoundingClientRect()
      const from = hover.source.getBoundingClientRect()
      const scrollBounds = scrollRef.current?.getBoundingClientRect()
      if (scrollBounds && (from.bottom < scrollBounds.top || from.top > scrollBounds.bottom)) {
        setCurve(null)
        return
      }
      const to = target.getBoundingClientRect()
      setCurve({
        x1: from.right - frame.left,
        y1: from.top + from.height * 0.5 - frame.top,
        x2: to.left - frame.left,
        y2: to.top + to.height * 0.5 - frame.top,
      })
    }
    update()
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    resize?.observe(layout)
    resize?.observe(target)
    scrollRef.current?.addEventListener('scroll', update, { passive: true })
    const scroll = scrollRef.current
    return () => {
      resize?.disconnect()
      scroll?.removeEventListener('scroll', update)
    }
  }, [hover, currentEvidence])

  async function send(message: OutgoingMessage, consumeDraft: boolean): Promise<void> {
    const outcome = await sendVoiceMessage(channel, message, consumeDraft)
    if (outcome?.outcome === 'unavailable' && outcome.error) toast.warn(outcome.error)
    await history.refresh()
  }

  function submitDraft(): void {
    const text = draft.trim()
    if (text === '' || sending || composing.current) return
    void send({ messageId: draftId, text, tEvent: Date.now(), status: 'sending' }, true)
    setDraftId(makeMessageId())
    atBottom.current = true
    setHasUnread(false)
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    submitDraft()
  }

  function onTextareaKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing ||
        event.nativeEvent.keyCode === 229 || composing.current) return
    event.preventDefault()
    submitDraft()
  }

  function scrollToNew(): void {
    const container = scrollRef.current
    if (!container) return
    container.scrollTo({ top: container.scrollHeight, behavior: fullMotion ? 'smooth' : 'instant' })
    setHasUnread(false)
  }

  function openRecord(recordId: string): void {
    navigate('memory?record=' + encodeURIComponent(recordId))
  }

  const curveMiddle = curve ? (curve.x1 + curve.x2) / 2 : 0

  const voiceGridStyle = useMemo(
    () => ({
      '--voice-dur-quick': `${Math.round(DUR.quick * 1000)}ms`,
      '--voice-caret-cycle': `${REPLY_PULSE_MS}ms`,
    }) as CSSProperties,
    [],
  )

  return (
    <LayoutGroup id={channel}>
      <div className="voice-grid" data-motion-level={motionLevel} style={voiceGridStyle} ref={layoutRef}>
        <section className="voice-conversation" aria-label="对话">
          <div className="voice-conversation-paper plate" aria-hidden="true" />
          <div className="voice-enso" ref={ensoRef}>
            <Enso size={120} state={state} rippleKey={rippleKey} pulseKey={pulseKey} ariaLabel={`${roleName}，${CHAT_STATE_LABELS[state]}`} />
          </div>
          <div
            className="voice-scroll"
            role="log"
            aria-label="对话消息"
            aria-live="polite"
            aria-relevant="additions text"
            ref={scrollRef}
            tabIndex={0}
            onScroll={(event) => {
              const scroll = event.currentTarget
              atBottom.current = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= AT_BOTTOM_PX
              if (atBottom.current) setHasUnread(false)
            }}
          >
            {history.error && history.data === undefined ? (
              <HistoryError error={history.error} onRetry={() => { void history.refresh() }} />
            ) : history.data === undefined && timeline.length === 0 ? (
              <InkSkeleton height={112} />
            ) : timeline.length === 0 ? (
              <EmptyState glyph="无言" description="这条通道还没有消息" />
            ) : timeline.map((message) => {
              const owner = message.direction === 'inbound'
              const previousText = owner ? undefined : reveals.get(message.id)
              const failed = message.outgoing?.status === 'failed'
              const citations = message.recordId ? evidence.get(message.recordId) ?? EMPTY_EVIDENCE : EMPTY_EVIDENCE
              return (
                <article
                  key={`${message.direction}:${message.id}`}
                  className="voice-message"
                  data-voice-message={`${message.direction}:${message.id}`}
                  data-direction={message.direction}
                  data-voice-record={owner ? undefined : message.recordId}
                  data-failed={failed || undefined}
                >
                  <span className="voice-message-name">{owner ? '你' : '她'}</span>
                  <motion.div
                    className="voice-message-body"
                    layoutId={owner && fullMotion && message.outgoing ? `msg-${message.id}` : undefined}
                    transition={{ duration: DUR.base, ease: EASE.inkOut }}
                  >
                    <SafeMarkdown value={message.text} previousText={previousText} />
                    {!owner && speaking && lastReply?.id === message.id && (
                      <span className="voice-reply-caret" aria-hidden="true">▍</span>
                    )}
                    {failed && message.outgoing && (
                      <div className="voice-send-failed">
                        <span>没送出去</span>
                        <span aria-hidden="true"> · </span>
                        <button type="button" disabled={sending} onClick={() => { void send(message.outgoing!, false) }}>
                          重试
                        </button>
                        {message.outgoing.error instanceof ApiError && (
                          <small title={message.outgoing.error.requestId}>{message.outgoing.error.code}</small>
                        )}
                      </div>
                    )}
                    {citations.length > 0 && message.recordId && (
                      <ul className="voice-citations" aria-label="记忆证据">
                        {citations.map((item) => (
                          <li key={item.id}>
                            <button
                              type="button"
                              onMouseEnter={(event) => { setHover({ recordId: item.id, messageRecordId: message.recordId!, source: event.currentTarget }) }}
                              onMouseLeave={() => setHover(null)}
                              onFocus={(event) => { setHover({ recordId: item.id, messageRecordId: message.recordId!, source: event.currentTarget }) }}
                              onBlur={() => setHover(null)}
                              onClick={() => openRecord(item.id)}
                            >
                              <LayerTag layer={item.layer} /> · {item.kind} · {evidenceDate(item.tEvent)}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </motion.div>
                </article>
              )
            })}
          </div>
          {hasUnread && <button type="button" className="voice-new-stamp" onClick={scrollToNew}>新消息 ↓</button>}
          <form className="voice-composer" onSubmit={onSubmit}>
            <div className="voice-draft">
              {fullMotion && draft.trim() !== '' && (
                <motion.div layoutId={`msg-${draftId}`} className="voice-draft-flight" aria-hidden="true">{draft}</motion.div>
              )}
              <InkTextarea
                aria-label="对话消息"
                placeholder="说点什么…"
                value={draft}
                rows={2}
                onFocus={() => setComposerFocused(true)}
                onBlur={() => setComposerFocused(false)}
                onChange={(event) => {
                  const nextValue = event.currentTarget.value
                  saveVoiceDraft(channel, nextValue)
                  if (nextValue !== draft && nextValue.length > 0) {
                    setRippleKey((key) => key + 1)
                  }
                }}
                onCompositionStart={() => { composing.current = true }}
                onCompositionEnd={() => { composing.current = false }}
                onKeyDown={onTextareaKeyDown}
              />
            </div>
            <MagneticButton disabled={draft.trim() === '' || sending}>
              <BrushButton type="submit" variant="primary" loading={sending} disabled={draft.trim() === ''}>送</BrushButton>
            </MagneticButton>
          </form>
        </section>
        <Plate as="aside" aria-labelledby="voice-presence-heading" className="voice-presence">
          <h2 id="voice-presence-heading">她此刻</h2>
          <dl className="voice-presence-list">
            <div><dt>状态</dt><dd>{CHAT_STATE_LABELS[state]}</dd></div>
            <div>
              <dt>模型</dt>
              <dd>
                {selection?.model ? <span className="num">{selection.model}{selection.effort ? ` / ${selection.effort}` : ''}</span> : modelLoading ? (
                  <span>读取中</span>
                ) : modelError ? (
                  <>
                    模型配置未取得
                    <BrushButton variant="ghost" size="sm" onClick={refreshModel}>重试</BrushButton>
                  </>
                ) : (
                  <>
                    未选择模型
                    <BrushButton variant="ghost" size="sm" onClick={() => navigate('settings')}>去「设」</BrushButton>
                  </>
                )}
              </dd>
            </div>
            <div>
              <dt>本轮</dt>
              <dd>{metric && metricTokens !== undefined
                ? <><InkNumber value={metric.steps.length} /> 步 · <InkNumber value={compactTokens(metricTokens)} /> tok</>
                : '—'}</dd>
            </div>
          </dl>
          <div className="voice-evidence">
            <h3>这轮用到的记忆</h3>
            {currentEvidence.length === 0 ? <p>暂无可查看的记忆引用</p> : (
              <ul>
                {currentEvidence.map((item) => (
                  <li key={item.id}>
                    <button
                      ref={(node) => {
                        if (node) evidenceTargets.current.set(item.id, node)
                        else evidenceTargets.current.delete(item.id)
                      }}
                      type="button"
                      data-highlighted={item.id === hover?.recordId || undefined}
                      onClick={() => openRecord(item.id)}
                    >
                      <LayerTag layer={item.layer} />
                      <span>{summarizeRecordContent(item, 60)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Plate>
        {hover && curve && (
          <svg className="voice-evidence-connection" aria-hidden="true">
            <motion.path
              key={hover.messageRecordId + ':' + hover.recordId}
              d={`M ${curve.x1} ${curve.y1} C ${curveMiddle} ${curve.y1} ${curveMiddle} ${curve.y2} ${curve.x2} ${curve.y2}`}
              variants={getPreset('brushIn', motionLevel)}
              initial="initial"
              animate="animate"
            />
            <circle cx={curve.x1} cy={curve.y1} r={1.5} />
            <circle cx={curve.x2} cy={curve.y2} r={1.5} />
          </svg>
        )}
      </div>
    </LayoutGroup>
  )
}

export function VoicePage() {
  const { navigate, displayedRoute } = useShellNavigation()
  const { satellite, plugins, pluginsError, refreshPlugins } = useConsoleShellData()
  const { channel } = useVoiceSession()
  const pluginEnabled = plugins?.plugins.some((plugin) => plugin.id === 'console-chat' && plugin.state === 'enabled')
  const channels = [...new Set([
    DEFAULT_CHAT_CHANNEL,
    channel,
    ...(satellite?.sessions ?? []).filter((item) => item.channel.startsWith('console-chat:')).map((item) => item.channel),
  ])]
  const settings = usePolling(() => settingsApi.getSettings(), 0, {
    enabled: pluginEnabled === true && displayedRoute.split('?')[0] === 'voice',
  })
  const chat = satellite?.processes.chat

  return (
    <div className="voice-page">
      <PageHeader
        label="VOICE · CHAT"
        title="对话"
        actions={pluginEnabled ? (
          <div className="voice-channel">
            <span>通道</span>
            <InkSelect
              ariaLabel="通道"
              options={channels.map((value) => ({ value, label: value }))}
              value={channel}
              onChange={selectVoiceChannel}
            />
          </div>
        ) : undefined}
      />
      {plugins === undefined ? pluginsError === undefined ? <InkSkeleton height={330} /> : (
        <HistoryError error={pluginsError} onRetry={() => { void refreshPlugins() }} />
      ) : !pluginEnabled ? (
        <Plate as="section" className="voice-disconnected" aria-label="对话未连接">
          <EmptyState glyph="未通" description="请在印谱安装并启用 console-chat 插件" actionLabel="前往「印」" onAction={() => navigate('seals')} />
        </Plate>
      ) : (
        <VoiceConversation
          key={channel}
          channel={channel}
          chat={chat}
          metrics={satellite?.metrics}
          selection={settings.data?.agents.chat}
          modelLoading={settings.data === undefined && settings.error === undefined}
          modelError={settings.error}
          refreshModel={() => { void settings.refresh() }}
        />
      )}
    </div>
  )
}
