// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { formatRelativeTime, type ChatMode } from '@brain-core/chat-kit'
import type { HealthState } from '../onebot/health.ts'

export interface QqChannelBudgetView {
  readonly used: number
  readonly limit: number
  readonly remaining: number
}

export interface QqChannelStatusItem {
  readonly channel: string
  readonly mode: ChatMode
  readonly unreadCount: number
  readonly lastActivityAt: number | null
  readonly lastWakeAt: number | null
  readonly hourlyBudget: QqChannelBudgetView
}

export interface QqFfmpegStatusView {
  readonly available: boolean
  readonly version?: string
}

export interface QqStatusSnapshot {
  readonly health: {
    readonly state: HealthState
    readonly authError: boolean
    readonly lastHeartbeat: number | null
    readonly heartbeatAgeMs: number | null
  }
  readonly identity: {
    readonly selfId: string | null
    readonly selfNickname: string | null
  }
  readonly reconnectCount: number
  readonly endpoints: {
    readonly httpOrigin: string
    readonly wsOrigin: string
  }
  readonly access: {
    readonly failClosed: boolean
    readonly allowAllWhenEmpty: boolean
    readonly ownerQQ: string | null
    readonly allowPrivate: readonly string[]
    readonly allowGroups: readonly string[]
    readonly denyPrivate: readonly string[]
    readonly denyGroups: readonly string[]
    readonly ignoredSenders: readonly string[]
  }
  readonly stickers: {
    readonly enabled: boolean
    readonly collectEnabled: boolean
    readonly cachedCount: number
  }
  readonly voice: {
    readonly enabled: boolean
  }
  readonly ffmpeg: QqFfmpegStatusView
  readonly channelsCount: number
  readonly timestamp: number
}

export interface StatusPageInput {
  readonly status: QqStatusSnapshot
  readonly channels: readonly QqChannelStatusItem[]
}

/** Escape untrusted text before inserting into HTML text nodes or attributes. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('`', '&#96;')
}

/** Strip path, query, hash, and userinfo from an endpoint URL so secrets never leak. */
export function sanitizeEndpointOrigin(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol) || !parsed.host) {
      return '(invalid)'
    }
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return '(invalid)'
  }
}

const HEALTH_LABEL: Readonly<Record<HealthState, string>> = {
  healthy: '健康在线',
  ws_connected: '已握手待心跳',
  degraded: '降级运行',
  disconnected: '未连接',
}

const MODE_LABEL: Readonly<Record<ChatMode, string>> = {
  active: 'active · 活跃',
  lurking: 'lurking · 潜水',
  muted: 'muted · 静音',
}

function formatTimeSummary(timestamp: number | null, now: number): string {
  if (timestamp === null || !Number.isFinite(timestamp)) return '暂无'
  const ageMs = Math.max(0, now - timestamp)
  return `${formatRelativeTime(ageMs)}（${Math.round(ageMs / 1000)}s 前）`
}

function renderIdList(items: readonly string[], emptyText: string): string {
  if (items.length === 0) return `<span class="muted">${escapeHtml(emptyText)}</span>`
  return items.map((item) => `<span class="chip num">${escapeHtml(item)}</span>`).join('')
}

/**
 * Render an offline self-contained INKTIDE read-only status page compatible with `<iframe sandbox="">`.
 * Zero scripts, zero forms, zero external URLs or fonts, zero inline handlers, zero secret values.
 */
export function renderStatusPageHtml(input: StatusPageInput): string {
  const { status, channels } = input
  const { health, identity, endpoints, access, stickers, voice, ffmpeg, timestamp } = status

  const healthState = escapeHtml(health.state)
  const healthLabel = escapeHtml(HEALTH_LABEL[health.state] ?? health.state)
  const selfIdText = identity.selfId ? escapeHtml(identity.selfId) : '未获取'
  const selfNickText = identity.selfNickname ? escapeHtml(identity.selfNickname) : '未登录 / 待同步'
  const heartbeatText = escapeHtml(formatTimeSummary(health.lastHeartbeat, timestamp))
  const httpOrigin = escapeHtml(sanitizeEndpointOrigin(endpoints.httpOrigin))
  const wsOrigin = escapeHtml(sanitizeEndpointOrigin(endpoints.wsOrigin))
  const ownerDisplay = access.ownerQQ ? escapeHtml(access.ownerQQ) : '未配置'
  const failClosedText = access.failClosed
    ? 'fail-closed（空列表默认拒绝）'
    : 'allowAllWhenEmpty 已开启（空列表放行）'

  const authWarningHtml = health.authError
    ? `<section class="plate banner-danger" role="alert">
        <div class="banner-title">OneBot 鉴权故障告警</div>
        <p class="banner-text">检测到 HTTP 401 / retcode 1401 或连续 WS 异常断连。请核对协议端鉴权配置，并使用 CLI 更新 <code>onebot-http-token</code> / <code>onebot-ws-token</code> 密钥后重新启用插件。</p>
      </section>`
    : ''

  const channelsHtml = channels.length === 0
    ? '<div class="empty-state">暂无已记录的 QQ 频道运行态。</div>'
    : `<div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>频道</th>
              <th>社交模式</th>
              <th>未读</th>
              <th>最近唤醒</th>
              <th>小时唤醒预算</th>
            </tr>
          </thead>
          <tbody>
            ${channels.map((ch) => {
              const safeChannel = escapeHtml(ch.channel)
              const safeMode = escapeHtml(ch.mode)
              const safeModeText = escapeHtml(MODE_LABEL[ch.mode] ?? ch.mode)
              const safeWake = escapeHtml(formatTimeSummary(ch.lastWakeAt, timestamp))
              const budgetText = `${ch.hourlyBudget.remaining} / ${ch.hourlyBudget.limit} 剩余（已用 ${ch.hourlyBudget.used}）`
              return `<tr>
                <td class="num">${safeChannel}</td>
                <td><span class="mode-badge" data-mode="${safeMode}">${safeModeText}</span></td>
                <td class="num">${escapeHtml(String(ch.unreadCount))}</td>
                <td>${safeWake}</td>
                <td class="num">${escapeHtml(budgetText)}</td>
              </tr>`
            }).join('\n')}
          </tbody>
        </table>
      </div>`

  const ffmpegSummary = ffmpeg.available
    ? (ffmpeg.version ? `可用 · ${ffmpeg.version}` : '可用')
    : '不可用（超限静态图与 GIF 将优雅降级为文本提示）'

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>QQ 通道状态 · 墨潮</title>
  <style>
    :root {
      color-scheme: dark;
      --font-display: "Songti SC", "STSong", Georgia, serif;
      --font-ui: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif;
      --font-mono: "SF Mono", Menlo, Consolas, monospace;
      --ink-void: #070605;
      --ink-stone: #0E0C0A;
      --plate: #14110F;
      --plate-raised: #1B1714;
      --plate-sunken: #0B0908;
      --hair: rgba(236, 226, 208, 0.09);
      --hair-strong: rgba(236, 226, 208, 0.18);
      --text-1: #ECE4D4;
      --text-2: rgba(236, 228, 212, 0.66);
      --text-3: rgba(236, 228, 212, 0.40);
      --zhusha: #FF4A1C;
      --tenghuang: #E9AE3A;
      --shilv: #4FB295;
      --shiqing: #5B7FD6;
      --yanzhi: #D2335C;
      --shadow-plate: inset 0 1px 0 rgba(236, 226, 208, 0.06), 0 18px 40px -24px rgba(0, 0, 0, 0.85);
      --radius: 2px;
    }
    @media (prefers-color-scheme: light) {
      :root {
        color-scheme: light;
        --ink-void: #E9E2D3;
        --ink-stone: #EFE9DD;
        --plate: #F7F3EA;
        --plate-raised: #FFFCF5;
        --plate-sunken: #E6DFD0;
        --hair: rgba(28, 22, 16, 0.10);
        --hair-strong: rgba(28, 22, 16, 0.22);
        --text-1: #1A1511;
        --text-2: rgba(26, 21, 17, 0.68);
        --text-3: rgba(26, 21, 17, 0.44);
        --zhusha: #E23A12;
        --tenghuang: #B97A0E;
        --shilv: #2D7F68;
        --shiqing: #3557B0;
        --yanzhi: #B0203F;
        --shadow-plate: inset 0 1px 0 rgba(255, 255, 255, 0.7), 0 16px 36px -26px rgba(60, 40, 20, 0.35);
      }
    }
    *, *::before, *::after { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: var(--ink-stone);
      color: var(--text-1);
      font: 14px/1.6 var(--font-ui);
    }
    .page {
      max-width: 1080px;
      margin: 0 auto;
      padding: 24px 20px 36px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .header {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      justify-content: space-between;
      gap: 12px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--hair);
    }
    .eyebrow {
      font: 600 11px/1.3 var(--font-mono);
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--zhusha);
    }
    .eyebrow::before {
      content: "";
      display: inline-block;
      width: 20px;
      height: 1px;
      background: currentColor;
      margin-right: 8px;
      vertical-align: middle;
    }
    h1 {
      margin: 6px 0 0;
      font: 700 24px/1.25 var(--font-display);
      letter-spacing: -0.01em;
    }
    .readonly-pill {
      font: 500 12px/1 var(--font-mono);
      color: var(--text-2);
      padding: 6px 10px;
      background: var(--plate);
      border: 1px solid var(--hair-strong);
      border-radius: var(--radius);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 12px;
    }
    .plate {
      background: var(--plate);
      border: 1px solid var(--hair);
      border-radius: var(--radius);
      box-shadow: var(--shadow-plate);
      padding: 14px 16px;
    }
    .section-title {
      margin: 0 0 10px;
      font: 600 12px/1.3 var(--font-mono);
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--text-2);
    }
    .metric-value {
      font: 600 18px/1.35 var(--font-ui);
      color: var(--text-1);
      word-break: break-word;
    }
    .metric-sub {
      margin-top: 4px;
      font-size: 12.5px;
      color: var(--text-2);
      word-break: break-word;
    }
    .num, code {
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
    }
    code {
      font-size: 12.5px;
      background: var(--plate-sunken);
      padding: 2px 6px;
      border: 1px solid var(--hair);
      border-radius: var(--radius);
    }
    .lamp {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
    }
    .lamp-dot {
      width: 9px;
      height: 9px;
      border-radius: 999px;
      display: inline-block;
      background: var(--yanzhi);
    }
    [data-health-state="healthy"] .lamp-dot { background: var(--shilv); }
    [data-health-state="ws_connected"] .lamp-dot { background: var(--shiqing); }
    [data-health-state="degraded"] .lamp-dot { background: var(--tenghuang); }
    [data-health-state="disconnected"] .lamp-dot { background: var(--yanzhi); }
    .banner-danger {
      border-left: 3px solid var(--yanzhi);
      background: var(--plate-raised);
    }
    .banner-title {
      font-weight: 700;
      color: var(--yanzhi);
      margin-bottom: 4px;
    }
    .banner-text {
      margin: 0;
      font-size: 13px;
      color: var(--text-1);
    }
    .kv-list {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 10px 18px;
    }
    .kv-item {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 8px 0;
      border-bottom: 1px solid var(--hair);
    }
    .kv-label {
      font-size: 12px;
      color: var(--text-2);
    }
    .chip-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }
    .chip {
      font-size: 12px;
      padding: 2px 8px;
      background: var(--plate-sunken);
      border: 1px solid var(--hair-strong);
      border-radius: var(--radius);
      color: var(--text-1);
    }
    .muted { color: var(--text-3); font-size: 12.5px; }
    .table-wrap { overflow-x: auto; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th, td {
      text-align: left;
      padding: 9px 10px;
      border-bottom: 1px solid var(--hair);
      white-space: nowrap;
    }
    th {
      font: 600 11px/1.3 var(--font-mono);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--text-2);
    }
    .mode-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: var(--radius);
      font: 500 12px/1.3 var(--font-mono);
      border: 1px solid var(--hair-strong);
      background: var(--plate-sunken);
    }
    .mode-badge[data-mode="active"] { color: var(--shilv); }
    .mode-badge[data-mode="lurking"] { color: var(--tenghuang); }
    .mode-badge[data-mode="muted"] { color: var(--yanzhi); }
    .empty-state {
      padding: 16px 0;
      color: var(--text-2);
      font-size: 13px;
    }
    .cli-pre {
      margin: 0;
      padding: 12px 14px;
      background: var(--plate-sunken);
      border: 1px solid var(--hair);
      border-radius: var(--radius);
      font: 12.5px/1.65 var(--font-mono);
      color: var(--text-1);
      overflow-x: auto;
      white-space: pre;
    }
  </style>
</head>
<body>
  <main class="page">
    <header class="header">
      <div>
        <div class="eyebrow">PLUGIN · QQ · INKTIDE</div>
        <h1>QQ 通道只读状态面板</h1>
      </div>
      <div class="readonly-pill">只读视图 · sandbox=&quot;&quot;</div>
    </header>

    ${authWarningHtml}

    <section class="grid" aria-label="OneBot 健康与身份概览">
      <article class="plate" data-health-state="${healthState}">
        <h2 class="section-title">OneBot 健康状态</h2>
        <div class="metric-value lamp"><span class="lamp-dot" aria-hidden="true"></span><span>${healthLabel}</span></div>
        <div class="metric-sub num">state: ${healthState} · authError: ${escapeHtml(String(health.authError))}</div>
      </article>
      <article class="plate">
        <h2 class="section-title">当前登录 QQ</h2>
        <div class="metric-value num">${selfIdText}</div>
        <div class="metric-sub">${selfNickText}</div>
      </article>
      <article class="plate">
        <h2 class="section-title">心跳与重连</h2>
        <div class="metric-value">${heartbeatText}</div>
        <div class="metric-sub num">WS 重连次数：${escapeHtml(String(status.reconnectCount))}</div>
      </article>
      <article class="plate">
        <h2 class="section-title">脱敏端点 Origin</h2>
        <div class="metric-sub">HTTP：<code class="num">${httpOrigin}</code></div>
        <div class="metric-sub">WS：<code class="num">${wsOrigin}</code></div>
      </article>
    </section>

    <section class="plate" aria-label="访问控制与安全边界">
      <h2 class="section-title">访问控制（白/黑名单）</h2>
      <div class="kv-list">
        <div class="kv-item">
          <span class="kv-label">默认策略</span>
          <span>${escapeHtml(failClosedText)}</span>
        </div>
        <div class="kv-item">
          <span class="kv-label">主人 QQ（ownerQQ）</span>
          <span class="num">${ownerDisplay}</span>
        </div>
        <div class="kv-item">
          <span class="kv-label">允许私聊（allowPrivate）</span>
          <div class="chip-row">${renderIdList(access.allowPrivate, '空（默认拒绝）')}</div>
        </div>
        <div class="kv-item">
          <span class="kv-label">允许群聊（allowGroups）</span>
          <div class="chip-row">${renderIdList(access.allowGroups, '空（默认拒绝）')}</div>
        </div>
        <div class="kv-item">
          <span class="kv-label">拒绝私聊 / 群聊（deny 优先）</span>
          <div class="chip-row">${renderIdList([...access.denyPrivate, ...access.denyGroups], '无')}</div>
        </div>
        <div class="kv-item">
          <span class="kv-label">忽略发言人（ignoredSenders）</span>
          <div class="chip-row">${renderIdList(access.ignoredSenders, '无')}</div>
        </div>
      </div>
    </section>

    <section class="plate" aria-label="QQ 频道运行态">
      <h2 class="section-title">各 QQ 频道运行态（${escapeHtml(String(channels.length))}）</h2>
      ${channelsHtml}
    </section>

    <section class="grid" aria-label="能力与环境探测">
      <article class="plate">
        <h2 class="section-title">表情包认知库</h2>
        <div class="metric-value num">${escapeHtml(String(stickers.cachedCount))} 个缓存条目</div>
        <div class="metric-sub">功能开关：${stickers.enabled ? '已开启' : '已关闭'} · 收藏动作：${stickers.collectEnabled ? '已开启' : '已关闭'}</div>
      </article>
      <article class="plate">
        <h2 class="section-title">本地语音发送</h2>
        <div class="metric-value">${voice.enabled ? '已开启' : '默认关闭'}</div>
        <div class="metric-sub">可在插件配置 voice.enabled 中切换</div>
      </article>
      <article class="plate">
        <h2 class="section-title">ffmpeg 媒体探测</h2>
        <div class="metric-value">${ffmpeg.available ? '可用' : '不可用'}</div>
        <div class="metric-sub">${escapeHtml(ffmpegSummary)}</div>
      </article>
    </section>

    <section class="plate" aria-label="CLI 配置与密钥速查">
      <h2 class="section-title">CLI 配置与密钥更新速查</h2>
      <pre class="cli-pre"># 1. 更新 OneBot 双 Token（仅存入内核 0600 密钥库，页面永不回显）
brain secret set plugin.qq.onebot-http-token
brain secret set plugin.qq.onebot-ws-token

# 2. 停用后编辑长期配置（$BRAIN_HOME/state/plugins/qq/config.json）再重新启用
brain plugin disable qq
brain plugin enable qq

# 3. 运维诊断路由（需携带内核 Bearer Token）
# GET /api/v1/plugins/qq/status · POST /api/v1/plugins/qq/probe
# GET /api/v1/plugins/qq/channels · GET /api/v1/plugins/qq/stickers</pre>
    </section>
  </main>
</body>
</html>`
}
