import { formatRelativeTime } from '@brain-core/chat-kit'

export interface ChatUiMessage {
  readonly messageId: string
  readonly direction: 'inbound' | 'outbound'
  readonly displayName: string
  readonly text: string
  readonly replyTo?: string
  readonly recordId: string
  readonly tEvent: number
}

export interface ChatUiInput {
  readonly channel: string
  readonly messages: readonly ChatUiMessage[]
  readonly latestWakeId?: string
  readonly unreadCount?: number
  readonly now?: number
}

/** Escape untrusted text before inserting into HTML text nodes or attributes. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Render the Apple iMessage frosted-glass conversation page for `GET /ui`. */
export function renderChatUiHtml(input: ChatUiInput): string {
  const now = input.now ?? Date.now()
  const safeChannel = escapeHtml(input.channel)
  const latestEvidence = input.messages.length > 0 ? input.messages[input.messages.length - 1]!.recordId : 'none'
  const safeWakeId = escapeHtml(input.latestWakeId ?? 'idle')
  const safeEvidence = escapeHtml(latestEvidence)
  const unreadCount = input.unreadCount ?? 0

  const bubblesHtml = input.messages.length === 0
    ? '<div class="empty-state glass-card">还没有消息，发一句试试吧。</div>'
    : input.messages.map((item) => {
      const roleClass = item.direction === 'outbound' ? 'bubble-outbound' : 'bubble-inbound'
      const ago = formatRelativeTime(now - item.tEvent)
      const replyHtml = item.replyTo === undefined
        ? ''
        : `<div class="bubble-reply">回复 ${escapeHtml(item.replyTo)}</div>`
      return `<article class="message-row ${roleClass}" data-message-id="${escapeHtml(item.messageId)}">
        <div class="message-meta">
          <span class="message-author">${escapeHtml(item.displayName)}</span>
          <span class="message-ago">${escapeHtml(ago)}</span>
          <span class="mono evidence-chip" title="L0 记忆证据">${escapeHtml(item.recordId)}</span>
        </div>
        <div class="bubble glass-card">
          ${replyHtml}
          <div class="bubble-text">${escapeHtml(item.text)}</div>
        </div>
      </article>`
    }).join('\n')

  return `<!doctype html>
<html lang="zh-CN" data-theme="auto">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>与她对话 · ${safeChannel}</title>
  <style>
    :root {
      --font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "PingFang SC", sans-serif;
      --font-mono: "SF Mono", Menlo, monospace;
      --blue: #0A84FF;
      --green: #30D158;
      --bg: #05070F;
      --window: rgba(22, 24, 34, 0.58);
      --card: rgba(255, 255, 255, 0.065);
      --card-edge: 1px solid rgba(255, 255, 255, 0.13);
      --card-mirror: inset 0 1px 0 rgba(255, 255, 255, 0.22);
      --text: rgba(255, 255, 255, 0.94);
      --text-dim: rgba(255, 255, 255, 0.62);
      --inbound-bg: rgba(255, 255, 255, 0.12);
      --outbound-bg: rgba(10, 132, 255, 0.86);
    }
    @media (prefers-color-scheme: light) {
      [data-theme="auto"] {
        --bg: #DCE5F2;
        --window: rgba(246, 248, 252, 0.65);
        --card: rgba(255, 255, 255, 0.72);
        --card-edge: 1px solid rgba(255, 255, 255, 0.92);
        --card-mirror: inset 0 1px 0 #FFFFFF;
        --text: rgba(0, 0, 0, 0.88);
        --text-dim: rgba(0, 0, 0, 0.55);
        --inbound-bg: rgba(255, 255, 255, 0.84);
        --outbound-bg: #0A84FF;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: var(--font-sans);
      color: var(--text);
      background:
        radial-gradient(60% 50% at 20% 15%, rgba(10, 132, 255, 0.28), transparent 70%),
        radial-gradient(50% 45% at 85% 25%, rgba(94, 92, 230, 0.24), transparent 72%),
        var(--bg);
      display: grid;
      place-items: center;
      padding: 20px;
    }
    .chat-window {
      width: min(860px, 100%);
      height: min(720px, calc(100vh - 40px));
      display: flex;
      flex-direction: column;
      border-radius: 22px;
      background: var(--window);
      border: var(--card-edge);
      box-shadow: 0 28px 72px rgba(0, 0, 0, 0.35), var(--card-mirror);
      backdrop-filter: blur(48px) saturate(190%);
      -webkit-backdrop-filter: blur(48px) saturate(190%);
      overflow: hidden;
    }
    .glass-card {
      background: var(--card);
      border: var(--card-edge);
      box-shadow: var(--card-mirror);
      border-radius: 18px;
      backdrop-filter: blur(48px) saturate(180%);
      -webkit-backdrop-filter: blur(48px) saturate(180%);
    }
    .status-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 18px;
      border-bottom: 1px solid rgba(127, 127, 127, 0.18);
    }
    .mono {
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
      font-size: 12px;
    }
    .status-pills {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      color: var(--text-dim);
    }
    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .message-row {
      display: flex;
      flex-direction: column;
      max-width: 78%;
      gap: 4px;
    }
    .bubble-inbound { align-self: flex-start; }
    .bubble-outbound { align-self: flex-end; }
    .message-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: var(--text-dim);
      padding: 0 6px;
    }
    .bubble {
      padding: 11px 15px;
      line-height: 1.5;
    }
    .bubble-inbound .bubble { background: var(--inbound-bg); }
    .bubble-outbound .bubble {
      background: var(--outbound-bg);
      color: #FFFFFF;
      border-color: rgba(255, 255, 255, 0.24);
    }
    .bubble-reply {
      font-size: 12px;
      opacity: 0.78;
      margin-bottom: 4px;
      padding-left: 8px;
      border-left: 2px solid currentColor;
    }
    .evidence-chip {
      padding: 2px 7px;
      border-radius: 999px;
      background: rgba(127, 127, 127, 0.18);
    }
    .composer {
      display: flex;
      gap: 10px;
      padding: 14px 18px;
      border-top: 1px solid rgba(127, 127, 127, 0.18);
    }
    .composer input {
      flex: 1;
      padding: 10px 14px;
      border-radius: 14px;
      border: var(--card-edge);
      background: var(--card);
      color: var(--text);
      font: inherit;
      outline: none;
    }
    .composer button {
      padding: 10px 18px;
      border: none;
      border-radius: 14px;
      background: var(--blue);
      color: #FFFFFF;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
    }
    .empty-state {
      margin: auto;
      padding: 18px 24px;
      color: var(--text-dim);
    }
  </style>
</head>
<body>
  <main class="chat-window" data-channel="${safeChannel}">
    <header class="status-bar">
      <div>
        <strong>与她对话</strong>
        <span class="mono">${safeChannel}</span>
      </div>
      <div class="status-pills mono" data-role="evidence-wake-bar">
        <span data-unread-count="${unreadCount}">unread: ${unreadCount}</span>
        <span data-wake-id="${safeWakeId}">wakeId: ${safeWakeId}</span>
        <span data-evidence-id="${safeEvidence}">memoryEvidence: ${safeEvidence}</span>
      </div>
    </header>
    <section class="messages" aria-label="对话消息">
      ${bubblesHtml}
    </section>
    <form class="composer" method="post" action="/api/v1/plugins/console-chat/messages">
      <input type="text" name="text" placeholder="发一条消息…" autocomplete="off" />
      <button type="submit">发送</button>
    </form>
  </main>
</body>
</html>`
}
