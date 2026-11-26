/** The console's visual system: macOS Sequoia vibrancy, a visionOS mirror edge and Apple system colours (S4 design 3.1). */

export type ConsoleThemeMode = 'dark' | 'light' | 'auto'

export interface NavItem {
  readonly id: string
  readonly title: string
  readonly badge?: string
  readonly group?: 'core' | 'plugin'
}

export interface ShellViewInput {
  readonly theme: ConsoleThemeMode
  readonly activePageId: string
  readonly authenticated: boolean
  readonly roleCardName: string | null
  readonly sharedQuotaWarning: boolean
  readonly navItems: readonly NavItem[]
  readonly mainHtml: string
}

const THEME_LABELS: Readonly<Record<ConsoleThemeMode, string>> = {
  dark: '深空',
  light: '冰川白',
  auto: '跟随系统',
}

const THEME_MODES: readonly ConsoleThemeMode[] = ['dark', 'light', 'auto']

const ROLE_CARD_BANNER = '先选角色卡（未选角色卡时唤醒返回 UNAVAILABLE）'
const SHARED_QUOTA_NOTICE = '与主 DSH 共用配额'

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * The shared stylesheet every console page uses. `.window` and `.glass-card` carry the vibrancy and the
 * 1px mirror edge; the three `data-theme` blocks swap the material without touching the layout.
 */
export function renderAppleThemeCss(): string {
  return `
:root {
  --font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "PingFang SC", sans-serif;
  --font-mono: "SF Mono", Menlo, monospace;
  --blue: #0A84FF;
  --green: #30D158;
  --orange: #FF9F0A;
  --red: #FF453A;
  --radius-window: 22px;
  --radius-card: 18px;
  --radius-control: 9px;
  --blur: blur(48px);
}

/* 深空毛玻璃：默认主题，也是 auto 在深色系统下的样子。 */
[data-theme="dark"] {
  color-scheme: dark;
  --text: rgba(255, 255, 255, 0.94);
  --text-dim: rgba(255, 255, 255, 0.62);
  --wallpaper: #05070F;
  --wallpaper-glow-a: #0A84FF;
  --wallpaper-glow-b: #5E5CE6;
  --wallpaper-glow-c: #30D158;
  --window: rgba(22, 24, 34, 0.58);
  --window-edge: 1px solid rgba(255, 255, 255, 0.12);
  --saturate: 190%;
  --card: rgba(255, 255, 255, 0.065);
  --card-edge: 1px solid rgba(255, 255, 255, 0.13);
  --card-mirror: inset 0 1px 0 rgba(255, 255, 255, 0.22);
  --sidebar: rgba(12, 14, 22, 0.42);
  --control: rgba(255, 255, 255, 0.08);
  --control-active: rgba(255, 255, 255, 0.18);
  --badge: rgba(255, 255, 255, 0.12);
  --glass-subsurface: rgba(255, 255, 255, 0.045);
  --glass-subsurface-edge: rgba(255, 255, 255, 0.10);
  --diff-pane-bg: rgba(12, 14, 22, 0.48);
}

/* 冰川白毛玻璃：浅雾银蓝底，卡片更实、镜面更亮。 */
[data-theme="light"] {
  color-scheme: light;
  --text: rgba(0, 0, 0, 0.88);
  --text-dim: rgba(0, 0, 0, 0.55);
  --wallpaper: #DCE5F2;
  --wallpaper-glow-a: #A9C9FF;
  --wallpaper-glow-b: #C6C2FF;
  --wallpaper-glow-c: #B8F0D0;
  --window: rgba(246, 248, 252, 0.65);
  --window-edge: 1px solid rgba(255, 255, 255, 0.86);
  --saturate: 180%;
  --card: rgba(255, 255, 255, 0.72);
  --card-edge: 1px solid rgba(255, 255, 255, 0.92);
  --card-mirror: inset 0 1px 0 #FFFFFF;
  --sidebar: rgba(255, 255, 255, 0.42);
  --control: rgba(0, 0, 0, 0.06);
  --control-active: rgba(255, 255, 255, 0.96);
  --badge: rgba(0, 0, 0, 0.08);
  --glass-subsurface: rgba(255, 255, 255, 0.56);
  --glass-subsurface-edge: rgba(0, 0, 0, 0.08);
  --diff-pane-bg: rgba(255, 255, 255, 0.78);
}

/* 跟随系统：先按深空渲染，系统偏好浅色时整体换成冰川白。 */
[data-theme="auto"] {
  color-scheme: dark light;
  --text: rgba(255, 255, 255, 0.94);
  --text-dim: rgba(255, 255, 255, 0.62);
  --wallpaper: #05070F;
  --wallpaper-glow-a: #0A84FF;
  --wallpaper-glow-b: #5E5CE6;
  --wallpaper-glow-c: #30D158;
  --window: rgba(22, 24, 34, 0.58);
  --window-edge: 1px solid rgba(255, 255, 255, 0.12);
  --saturate: 190%;
  --card: rgba(255, 255, 255, 0.065);
  --card-edge: 1px solid rgba(255, 255, 255, 0.13);
  --card-mirror: inset 0 1px 0 rgba(255, 255, 255, 0.22);
  --sidebar: rgba(12, 14, 22, 0.42);
  --control: rgba(255, 255, 255, 0.08);
  --control-active: rgba(255, 255, 255, 0.18);
  --badge: rgba(255, 255, 255, 0.12);
  --glass-subsurface: rgba(255, 255, 255, 0.045);
  --glass-subsurface-edge: rgba(255, 255, 255, 0.10);
  --diff-pane-bg: rgba(12, 14, 22, 0.48);
}

@media (prefers-color-scheme: light) {
  [data-theme="auto"] {
    color-scheme: light;
    --text: rgba(0, 0, 0, 0.88);
    --text-dim: rgba(0, 0, 0, 0.55);
    --wallpaper: #DCE5F2;
    --wallpaper-glow-a: #A9C9FF;
    --wallpaper-glow-b: #C6C2FF;
    --wallpaper-glow-c: #B8F0D0;
    --window: rgba(246, 248, 252, 0.65);
    --window-edge: 1px solid rgba(255, 255, 255, 0.86);
    --saturate: 180%;
    --card: rgba(255, 255, 255, 0.72);
    --card-edge: 1px solid rgba(255, 255, 255, 0.92);
    --card-mirror: inset 0 1px 0 #FFFFFF;
    --sidebar: rgba(255, 255, 255, 0.42);
    --control: rgba(0, 0, 0, 0.06);
    --control-active: rgba(255, 255, 255, 0.96);
    --badge: rgba(0, 0, 0, 0.08);
    --glass-subsurface: rgba(255, 255, 255, 0.56);
    --glass-subsurface-edge: rgba(0, 0, 0, 0.08);
    --diff-pane-bg: rgba(255, 255, 255, 0.78);
  }
}

* { box-sizing: border-box; }

html, body {
  height: 100%;
  margin: 0;
  font-family: var(--font-sans);
  color: var(--text);
  -webkit-font-smoothing: antialiased;
}

body {
  display: grid;
  place-items: center;
  padding: 24px;
  background: var(--wallpaper);
  overflow: hidden;
}

.wallpaper {
  position: fixed;
  inset: 0;
  z-index: 0;
  background:
    radial-gradient(60% 50% at 18% 12%, color-mix(in srgb, var(--wallpaper-glow-a) 55%, transparent), transparent 70%),
    radial-gradient(55% 45% at 82% 22%, color-mix(in srgb, var(--wallpaper-glow-b) 45%, transparent), transparent 72%),
    radial-gradient(70% 60% at 50% 108%, color-mix(in srgb, var(--wallpaper-glow-c) 30%, transparent), transparent 70%),
    var(--wallpaper);
  filter: saturate(115%);
}

.window {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  width: min(1180px, 100%);
  height: min(760px, 100%);
  overflow: hidden;
  background: var(--window);
  border: var(--window-edge);
  border-radius: 22px;
  box-shadow: 0 32px 80px rgba(0, 0, 0, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.16);
  backdrop-filter: blur(48px) saturate(190%);
  -webkit-backdrop-filter: blur(48px) saturate(190%);
  backdrop-filter: var(--blur) saturate(var(--saturate));
  -webkit-backdrop-filter: var(--blur) saturate(var(--saturate));
}

.toolbar {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 16px;
  padding: 14px 18px;
  border-bottom: 1px solid rgba(127, 127, 127, 0.18);
}

.traffic-lights { display: flex; gap: 8px; }

.traffic-light {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 0.5px rgba(0, 0, 0, 0.18);
}

.traffic-light.close { background: #FF5F56; }
.traffic-light.minimize { background: #FFBD2E; }
.traffic-light.zoom { background: #27C93F; }

.segmented {
  display: inline-flex;
  padding: 2px;
  gap: 2px;
  background: var(--control);
  border-radius: 10px;
}

.segmented > button,
.segmented > a {
  appearance: none;
  border: 0;
  padding: 5px 14px;
  border-radius: 8px;
  font: inherit;
  font-size: 13px;
  color: var(--text-dim);
  background: transparent;
  text-decoration: none;
  cursor: pointer;
}

.segmented > button[aria-selected="true"],
.segmented > a[aria-selected="true"],
.segmented > button[data-active="true"],
.segmented > a[data-active="true"] {
  color: var(--text);
  background: var(--control-active);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.22);
}

.spacer { flex: 1 1 auto; }

.shell-body {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
}

.sidebar {
  flex: 0 0 232px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 16px 12px;
  overflow-y: auto;
  background: var(--sidebar);
  border-right: 1px solid rgba(127, 127, 127, 0.16);
}

.nav-group-label {
  padding: 12px 10px 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-dim);
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 10px;
  font-size: 13px;
  color: var(--text);
  text-decoration: none;
}

.nav-item:hover { background: var(--control); }

.nav-item[aria-current="page"] {
  background: var(--control-active);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18);
}

.apple-badge {
  display: inline-flex;
  align-items: center;
  min-width: 18px;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  line-height: 16px;
  color: var(--text);
  background: var(--badge);
}

.content {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.status-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 10px 22px;
  font-size: 12.5px;
  border-bottom: 1px solid rgba(127, 127, 127, 0.14);
}

.status-banner {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: 10px;
  border: 1px solid rgba(255, 159, 10, 0.38);
  background: rgba(255, 159, 10, 0.14);
  color: var(--text);
}

.status-banner[data-tone="warning"] { border-color: rgba(255, 69, 58, 0.42); background: rgba(255, 69, 58, 0.14); }
.status-banner[data-tone="info"] { border-color: rgba(10, 132, 255, 0.4); background: rgba(10, 132, 255, 0.14); }

.main-area {
  flex: 1 1 auto;
  padding: 22px;
  overflow-y: auto;
}

.glass-card {
  padding: 18px 20px;
  background: var(--card);
  border: var(--card-edge);
  border-radius: 18px;
  box-shadow: var(--card-mirror), 0 8px 24px rgba(0, 0, 0, 0.12);
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
}

.login-card {
  max-width: 380px;
  margin: 8vh auto 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.login-title { margin: 0; font-size: 17px; font-weight: 600; }
.login-hint { margin: 0; font-size: 12.5px; color: var(--text-dim); }

input[type="password"],
input[type="text"],
select,
textarea {
  width: 100%;
  padding: 9px 12px;
  font: inherit;
  font-size: 13px;
  color: var(--text);
  background: var(--control);
  border: 1px solid rgba(127, 127, 127, 0.28);
  border-radius: 9px;
}

button.primary {
  appearance: none;
  padding: 9px 16px;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  color: #FFFFFF;
  background: #0A84FF;
  border: 0;
  border-radius: 9px;
  cursor: pointer;
}

.mono {
  font-family: "SF Mono", Menlo, monospace;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum" 1;
}

/* L3 画像版本时间轴、毛玻璃双栏 Diff 与夜间影子审阅台 */
.memory-subnav {
  margin-bottom: 16px;
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
  border: var(--card-edge);
  box-shadow: var(--card-mirror);
}

.memory-subnav > button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.apple-badge.badge-accent,
.badge-accent {
  background: rgba(10, 132, 255, 0.24);
  border: 1px solid rgba(10, 132, 255, 0.45);
  color: var(--text);
}

.consolidation-hero {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  align-items: center;
  gap: 16px;
  margin-bottom: 18px;
}

.consolidation-metric {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  background: var(--glass-subsurface);
  border: 1px solid var(--glass-subsurface-edge);
  border-radius: 14px;
}

.consolidation-metric-label {
  font-size: 12px;
  color: var(--text-dim);
}

.consolidation-metric-value {
  font-size: 20px;
  font-weight: 600;
}

.token-budget-meter {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 14px;
  background: var(--glass-subsurface);
  border: 1px solid var(--glass-subsurface-edge);
  border-radius: 14px;
}

.token-budget-svg {
  flex: 0 0 auto;
}

.shadow-proposal-deck {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-bottom: 20px;
}

.shadow-proposal-card {
  border-radius: 18px;
  box-shadow: var(--card-mirror), 0 12px 28px rgba(0, 0, 0, 0.14);
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.shadow-l2-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 12px;
}

.shadow-l2-card {
  padding: 12px 14px;
  background: var(--glass-subsurface);
  border: 1px solid var(--glass-subsurface-edge);
  border-radius: 14px;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.confidence-bar {
  width: 100%;
  height: 6px;
  border-radius: 999px;
  background: var(--control);
  overflow: hidden;
}

.confidence-bar-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #0A84FF, #30D158);
}

.quote-pill {
  display: inline-flex;
  align-items: center;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 12px;
  background: rgba(94, 92, 230, 0.16);
  border: 1px solid rgba(94, 92, 230, 0.36);
  color: var(--text);
}

.self-conflict-card {
  padding: 14px 16px;
  border-radius: 14px;
  border: 1px solid rgba(255, 159, 10, 0.45);
  background: rgba(255, 159, 10, 0.10);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.self-conflict-columns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.self-conflict-option {
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--glass-subsurface);
  border: 1px solid var(--glass-subsurface-edge);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.owner-lock-shield {
  background: rgba(10, 132, 255, 0.18);
  border: 1px solid rgba(10, 132, 255, 0.42);
  color: var(--text);
}

.m4-guard-badge {
  background: rgba(94, 92, 230, 0.18);
  border: 1px solid rgba(94, 92, 230, 0.42);
  color: var(--text);
}

.shadow-l3-preview {
  padding: 14px 16px;
  border-radius: 14px;
  background: var(--glass-subsurface);
  border: 1px solid var(--glass-subsurface-edge);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.l3-version-workspace {
  display: grid;
  grid-template-columns: minmax(280px, 1fr) minmax(360px, 1.4fr);
  gap: 18px;
  align-items: start;
}

.l3-version-timeline {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.l3-version-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.version-badge-current {
  background: rgba(48, 209, 88, 0.20);
  border: 1px solid rgba(48, 209, 88, 0.48);
}

.version-badge-owner {
  background: rgba(10, 132, 255, 0.22);
  border: 1px solid rgba(10, 132, 255, 0.48);
}

.version-badge-settlement {
  background: rgba(94, 92, 230, 0.22);
  border: 1px solid rgba(94, 92, 230, 0.48);
}

.l3-diff-viewer {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.l3-diff-columns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.l3-diff-pane {
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--diff-pane-bg);
  border: 1px solid var(--glass-subsurface-edge);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.diff-row {
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 12.5px;
}

.diff-row.diff-added {
  background: rgba(48, 209, 88, 0.14);
  border-left: 3px solid #30D158;
}

.diff-row.diff-removed {
  background: rgba(255, 69, 58, 0.14);
  border-left: 3px solid #FF453A;
}

.diff-row.diff-changed {
  background: rgba(255, 159, 10, 0.14);
  border-left: 3px solid #FF9F0A;
}

.l3-owner-editor {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 16px;
}

/* 模型花费与配额视图、外部互通与调试卡片 Apple 原生毛玻璃样式 */
.satellite-page,
.accounting-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.satellite-subnav {
  align-self: flex-start;
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
  border: var(--card-edge);
  box-shadow: var(--card-mirror);
}

.accounting-kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 14px;
}

.accounting-budget-svg,
.budget-meter-svg {
  flex: 0 0 auto;
  display: block;
}

.plugin-cost-svg,
.daily-cost-svg {
  display: block;
  width: 100%;
  border-radius: 14px;
  background: var(--glass-subsurface);
  border: 1px solid var(--glass-subsurface-edge);
  padding: 6px;
}

.accounting-forms-grid,
.process-grid,
.interop-grid,
.charts-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
}

.price-rows {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 12px 0;
}

.price-row {
  display: grid;
  grid-template-columns: minmax(140px, 1.3fr) repeat(4, minmax(72px, 1fr));
  gap: 8px;
  align-items: end;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--glass-subsurface);
  border: 1px solid var(--glass-subsurface-edge);
}

.audit-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 12px;
  font-size: 12.5px;
}

.audit-table th,
.audit-table td {
  padding: 8px 10px;
  text-align: left;
  border-bottom: 1px solid var(--glass-subsurface-edge);
}

.audit-table th {
  font-weight: 600;
  color: var(--text-dim);
}

.glass-code,
.patch-yaml-code {
  margin: 8px 0;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--diff-pane-bg);
  border: 1px solid var(--glass-subsurface-edge);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12);
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

/* 交互式控件、表单、表格、Toast 与原生对谈面板样式 */
button:not(.primary):not([role="tab"]) {
  appearance: none;
  padding: 7px 14px;
  font: inherit;
  font-size: 13px;
  color: var(--text);
  background: var(--control);
  border: 1px solid rgba(127, 127, 127, 0.25);
  border-radius: 9px;
  cursor: pointer;
  transition: background 0.15s ease, opacity 0.15s ease;
}

button:not(.primary):not([role="tab"]):hover:not(:disabled) {
  background: var(--control-active);
}

button.primary {
  transition: opacity 0.15s ease, transform 0.1s ease;
}

button.primary:hover:not(:disabled) {
  opacity: 0.9;
}

button:disabled {
  opacity: 0.52;
  cursor: not-allowed;
}

button.link-btn {
  padding: 3px 10px;
  font-size: 12px;
  border-radius: 999px;
}

.settings-layout {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 16px;
}

.settings-role-card {
  grid-column: 1 / -1;
}

.settings-layout label,
.memory-page label,
.plugins-page label,
.accounting-page label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12.5px;
  color: var(--text-dim);
  margin-bottom: 10px;
}

.inline-field,
.actions,
.modal-actions,
.filter-actions,
.person-action-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

.inline-field > label {
  flex: 1 1 220px;
  margin-bottom: 0;
}

.role-traits {
  margin: 12px 0;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid var(--glass-subsurface-edge);
  background: var(--glass-subsurface);
}

.role-trait-row {
  display: grid;
  grid-template-columns: 1fr 1.6fr;
  gap: 8px;
  margin-bottom: 8px;
}

.role-raw {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid rgba(127, 127, 127, 0.18);
}

.memory-page,
.plugins-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.filter-inputs,
.plugin-toolbar-forms {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
  align-items: end;
}

.search-form {
  display: flex;
  gap: 10px;
  margin-top: 10px;
}

.search-form > input {
  flex: 1 1 auto;
}

.memory-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.memory-item {
  cursor: pointer;
  transition: border-color 0.15s ease, transform 0.12s ease;
}

.memory-item:hover {
  border-color: rgba(10, 132, 255, 0.45);
}

.memory-item-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.memory-item-meta {
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 6px;
}

.record-content {
  margin: 6px 0 0;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--diff-pane-bg);
  border: 1px solid var(--glass-subsurface-edge);
  white-space: pre-wrap;
  word-break: break-word;
}

.envelope-fields {
  display: grid;
  grid-template-columns: minmax(90px, auto) 1fr;
  gap: 6px 14px;
  margin: 10px 0;
  font-size: 12.5px;
}

.envelope-fields dt {
  color: var(--text-dim);
}

.envelope-fields dd {
  margin: 0;
  word-break: break-word;
}

.evidence-tree,
.evidence-children {
  list-style: none;
  padding-left: 16px;
  margin: 8px 0;
  border-left: 1px solid var(--glass-subsurface-edge);
}

.plugins-page table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 10px;
  font-size: 12.5px;
}

.plugins-page th,
.plugins-page td {
  padding: 8px 10px;
  text-align: left;
  border-bottom: 1px solid var(--glass-subsurface-edge);
}

.plugins-page th {
  color: var(--text-dim);
  font-weight: 600;
}

.upgrade-spec-input {
  max-width: 180px;
}

.toast-region {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  justify-content: flex-end;
  pointer-events: none;
}

.toast-banner {
  pointer-events: auto;
  margin-bottom: 12px;
  padding: 9px 14px;
  border-radius: 12px;
  font-size: 13px;
  background: var(--card);
  border: var(--card-edge);
  box-shadow: var(--card-mirror), 0 12px 28px rgba(0, 0, 0, 0.25);
  backdrop-filter: blur(24px) saturate(160%);
  -webkit-backdrop-filter: blur(24px) saturate(160%);
}

.toast-banner[data-tone="ok"] {
  border-color: rgba(48, 209, 88, 0.48);
  background: rgba(48, 209, 88, 0.16);
}

.toast-banner[data-tone="warning"] {
  border-color: rgba(255, 69, 58, 0.48);
  background: rgba(255, 69, 58, 0.16);
}

.toast-banner[data-tone="info"] {
  border-color: rgba(10, 132, 255, 0.45);
  background: rgba(10, 132, 255, 0.16);
}

.plugin-chat-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 520px;
}

.chat-header-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.chat-channel-form {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.chat-channel-form input {
  width: 240px;
}

.chat-messages-scroll {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 400px;
  overflow-y: auto;
  padding: 4px 2px;
}

.chat-row {
  display: flex;
  flex-direction: column;
  max-width: 80%;
  gap: 4px;
}

.chat-inbound {
  align-self: flex-start;
}

.chat-outbound {
  align-self: flex-end;
}

.chat-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-dim);
}

.chat-bubble {
  padding: 10px 14px;
  border-radius: 16px;
  background: var(--glass-subsurface);
  border: var(--card-edge);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.chat-outbound .chat-bubble {
  background: rgba(10, 132, 255, 0.86);
  color: #FFFFFF;
  border-color: rgba(255, 255, 255, 0.24);
}

.chat-composer {
  display: flex;
  gap: 10px;
  margin-top: auto;
}

.chat-composer input {
  flex: 1 1 auto;
}

.plugin-iframe {
  width: 100%;
  min-height: 540px;
  border: var(--card-edge);
  border-radius: 14px;
  background: transparent;
}

.is-loading {
  opacity: 0.68;
  transition: opacity 0.15s ease;
}

@media (max-width: 820px) {
  body { padding: 8px; }
  .shell-body { flex-direction: column; }
  .sidebar { flex: 0 0 auto; border-right: 0; border-bottom: 1px solid rgba(127, 127, 127, 0.16); }
  .role-trait-row { grid-template-columns: 1fr; }
  .l3-version-workspace,
  .l3-diff-columns,
  .self-conflict-columns,
  .accounting-kpi-grid,
  .accounting-forms-grid,
  .process-grid,
  .interop-grid,
  .charts-grid,
  .price-row {
    grid-template-columns: 1fr;
  }
}
`.trimStart()
}

function renderThemeSwitch(theme: ConsoleThemeMode): string {
  const buttons = THEME_MODES.map((mode) => {
    const active = mode === theme
    return `<button type="button" role="tab" data-theme-option="${mode}" aria-selected="${String(active)}">${THEME_LABELS[mode]}</button>`
  })
  return `<div class="segmented theme-switch" role="tablist" aria-label="主题">${buttons.join('')}</div>`
}

function renderNav(input: ShellViewInput): string {
  if (!input.authenticated) {
    // 未登录时侧栏只有应用名：导航里的角标是业务数据，在令牌校验通过前不能渲染。
    return '<div class="nav-group-label">Brain Core</div>'
  }
  const core = input.navItems.filter((item) => item.group !== 'plugin')
  const plugins = input.navItems.filter((item) => item.group === 'plugin')
  const item = (nav: NavItem): string => {
    const current = nav.id === input.activePageId ? ' aria-current="page"' : ''
    const badge = nav.badge === undefined ? '' : `<span class="apple-badge">${escapeHtml(nav.badge)}</span>`
    return `<a class="nav-item" data-nav-id="${escapeHtml(nav.id)}" href="#${escapeHtml(nav.id)}"${current}>`
      + `<span class="nav-title">${escapeHtml(nav.title)}</span>${badge}</a>`
  }
  const groups = ['<div class="nav-group-label">内核</div>', ...core.map(item)]
  if (plugins.length > 0) groups.push('<div class="nav-group-label">插件</div>', ...plugins.map(item))
  return groups.join('')
}

function renderStatusBar(input: ShellViewInput): string {
  // 未登录时不渲染状态栏：角色卡、共用配额都是业务状态。
  if (!input.authenticated) return ''
  const banners: string[] = []
  if (input.roleCardName === null) {
    banners.push(`<div class="status-banner" data-tone="warning" id="role-card-missing">${ROLE_CARD_BANNER}</div>`)
  } else {
    banners.push(`<span class="apple-badge" id="role-card-active">角色卡：${escapeHtml(input.roleCardName)}</span>`)
  }
  if (input.sharedQuotaWarning) {
    banners.push(`<div class="status-banner" data-tone="info" id="shared-quota-warning">${SHARED_QUOTA_NOTICE}</div>`)
  }
  return `<div class="status-bar">${banners.join('')}</div>`
}

function renderLogin(): string {
  // 未通过令牌校验时主区域只有登录框：mainHtml 和任何业务数据都不渲染。
  return `<section class="glass-card login-card">
  <h1 class="login-title">Brain Core 控制台</h1>
  <p class="login-hint">令牌只保存在本机内存里。粘上内核启动时打印的那一串令牌。</p>
  <form id="token-login-form" autocomplete="off">
    <input type="password" id="token" name="token" placeholder="控制台令牌" aria-label="控制台令牌" required>
    <button class="primary" type="submit">进入</button>
  </form>
</section>`
}

function renderMain(input: ShellViewInput): string {
  if (!input.authenticated) return renderLogin()
  return injectThemeScript(`<div class="main-area">${input.mainHtml}</div>`)
}

/** The shell ships no client bundle, so the login box brings its own handler: it hands the typed token to the page in memory only. */
function renderLoginScript(): string {
  return `<script type="module">
  const form = document.getElementById('token-login-form')
  if (form) {
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const field = document.getElementById('token')
      if (!(field instanceof HTMLInputElement) || field.value === '') return
      window.dispatchEvent(new CustomEvent('brain-console-token', { detail: field.value }))
      field.value = ''
    })
  }
</script>`
}

/** Theme switching writes the choice back to `<html data-theme>` and remembers it; nothing else needs a bundle. */
function injectThemeScript(mainArea: string): string {
  return `${mainArea}
<script type="module">
  const root = document.documentElement
  for (const button of document.querySelectorAll('[data-theme-option]')) {
    button.addEventListener('click', () => {
      const mode = button.dataset.themeOption
      root.dataset.theme = mode
      for (const other of document.querySelectorAll('[data-theme-option]')) {
        other.setAttribute('aria-selected', String(other === button))
      }
      try { localStorage.setItem('brain-console-theme', mode) } catch {}
    })
  }
</script>`
}

/** The whole console frame. `mainHtml` is the page's own markup and is inserted as-is; every label is escaped. */
export function renderShellHtml(input: ShellViewInput): string {
  const theme = THEME_MODES.includes(input.theme) ? input.theme : 'dark'
  const authenticated = input.authenticated === true
  return `<!doctype html>
<html lang="zh-CN" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>Brain Core 控制台</title>
<style>
${renderAppleThemeCss()}
</style>
</head>
<body>
<div class="wallpaper" aria-hidden="true"></div>
<div class="window" role="application">
  <header class="toolbar">
    <div class="traffic-lights" aria-hidden="true">
      <span class="traffic-light close"></span>
      <span class="traffic-light minimize"></span>
      <span class="traffic-light zoom"></span>
    </div>
    <div class="spacer"></div>
    ${renderThemeSwitch(theme)}
  </header>
  <div class="shell-body">
    <aside class="sidebar">${renderNav(input)}</aside>
    <section class="content">
      ${renderStatusBar(input)}
      ${renderMain(input)}
    </section>
  </div>
</div>
${authenticated ? '' : renderLoginScript()}
<script type="module" src="/assets/console-client.js"></script>
</body>
</html>`
}
