import { BrainError } from '@brain-core/sdk'
import type { AgentClass, ModelSelection, ThinkingEffort } from '@brain-core/satellite-host'
import { escapeHtml } from './theme.ts'

export interface ModelCatalogEntry {
  readonly provider: string
  readonly model: string
  readonly supportsImages: boolean
  readonly toolUpdate: 'addition-only' | 'fixed'
  readonly efforts: readonly ThinkingEffort[]
}

export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    supportsImages: true,
    toolUpdate: 'addition-only',
    efforts: ['off', 'low', 'high', 'max', 'model-default'],
  },
  {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    supportsImages: true,
    toolUpdate: 'fixed',
    efforts: ['off', 'low', 'high', 'max', 'model-default'],
  },
]

export interface RoleTraitInterview {
  readonly trait: string
  readonly manifestation: string
}

export interface RoleCardInterviewInput {
  readonly name: string
  readonly summary: string
  readonly tone: string
  readonly traits: readonly RoleTraitInterview[]
}

export interface ConsoleSettingsView {
  readonly agents: {
    readonly chat?: Partial<ModelSelection>
    readonly activity?: Partial<ModelSelection>
  }
  readonly secretNames: readonly string[]
  readonly sharedQuotaWarning: boolean
  readonly roleCard: { readonly name: string; readonly text: string } | null
  readonly availableRoleCards: readonly string[]
}

/** The key whose absence means the console borrows the main DSH's quota (D17). */
export const SHARED_QUOTA_SECRET = 'brain-deepseek-api-key'

const AGENT_CLASSES: readonly AgentClass[] = ['chat', 'activity']

const AGENT_LABELS: Readonly<Record<AgentClass, string>> = {
  chat: '聊天类',
  activity: '活动类',
}

const EFFORT_LABELS: Readonly<Record<ThinkingEffort, string>> = {
  off: '关闭',
  low: '低',
  high: '高',
  max: '最大',
  'model-default': '跟随模型默认（适配器当前默认实际发送 high）',
}

const TOOL_UPDATE_WARNING = '该模型不支持增量工具更新（fixed），工具面在会话开始时一次定好，tools__load 需换会话才生效，会影响缓存与首条时延'

const NOT_CHOSEN = '未选择 — 该类 Agent 进程不启动'

function trimmed(text: unknown): string {
  return typeof text === 'string' ? text.trim() : ''
}

function catalogEntryFor(provider: string, model: string): ModelCatalogEntry | undefined {
  return MODEL_CATALOG.find((entry) => entry.provider === provider && entry.model === model)
}

/** Only the catalog declares `addition-only`; a hand-typed id is treated as `fixed` because nothing vouches for it. */
function isAdditionOnly(selection: Partial<ModelSelection> | undefined): boolean {
  if (selection?.provider === undefined || selection?.model === undefined) return false
  return catalogEntryFor(selection.provider, selection.model)?.toolUpdate === 'addition-only'
}

/** The catalog's effort list for the chosen model, else every effort the host knows. */
function effortsOf(selection: Partial<ModelSelection> | undefined): readonly ThinkingEffort[] {
  const entry = selection?.provider === undefined || selection?.model === undefined
    ? undefined
    : catalogEntryFor(selection.provider, selection.model)
  return entry?.efforts ?? MODEL_CATALOG[0]?.efforts ?? []
}

function selectOptions(items: readonly { readonly value: string; readonly label: string; readonly selected: boolean }[]): string {
  return items
    .map((item) => `<option value="${escapeHtml(item.value)}"${item.selected ? ' selected' : ''}>${escapeHtml(item.label)}</option>`)
    .join('')
}

/**
 * Validates interview input and builds the Markdown role card. Every trait has to say how it shows up in
 * conversation: a bare adjective gives the model nothing to act on, so a blank `manifestation` is refused.
 */
export function buildRoleCardFromInterview(input: RoleCardInterviewInput): { readonly name: string; readonly text: string } {
  const name = trimmed(input.name)
  const summary = trimmed(input.summary)
  const tone = trimmed(input.tone)
  if (name === '') throw new BrainError('INVALID_ARGUMENT', '角色卡需要一个名字', { field: 'name' })
  if (summary === '') throw new BrainError('INVALID_ARGUMENT', '角色卡需要核心定位', { field: 'summary' })
  if (tone === '') throw new BrainError('INVALID_ARGUMENT', '角色卡需要说话语气', { field: 'tone' })
  if (!Array.isArray(input.traits) || input.traits.length === 0) {
    throw new BrainError('INVALID_ARGUMENT', '角色卡至少需要一条特质', { field: 'traits' })
  }
  const traits = input.traits.map((trait, index) => {
    const label = trimmed(trait?.trait)
    const manifestation = trimmed(trait?.manifestation)
    if (label === '') throw new BrainError('INVALID_ARGUMENT', '特质不能为空', { field: `traits[${String(index)}].trait` })
    if (manifestation === '') {
      throw new BrainError('INVALID_ARGUMENT', '每条特质都要写清在对话里怎么体现', { field: `traits[${String(index)}].manifestation` })
    }
    return { label, manifestation }
  })

  const lines = [
    `# ${name}`,
    '',
    `- 定位：${summary}`,
    `- 语气：${tone}`,
    '',
    '## 特质',
    '',
    ...traits.map((trait) => `- **${trait.label}**：在对话中体现为：${trait.manifestation}`),
    '',
  ]
  return { name, text: lines.join('\n') }
}

function renderModelPicker(agentClass: AgentClass, selection: Partial<ModelSelection> | undefined): string {
  const provider = trimmed(selection?.provider)
  const model = trimmed(selection?.model)
  const effort = trimmed(selection?.effort)
  const chosen = provider !== '' || model !== ''
  const catalog = MODEL_CATALOG.map((entry) => ({
    value: `${entry.provider}/${entry.model}`,
    label: `${entry.provider} / ${entry.model}`,
    selected: entry.provider === provider && entry.model === model,
  }))
  // A hand-typed id (or one the catalog no longer lists) keeps its own option so the form never silently drops it.
  const custom = chosen && !catalog.some((option) => option.selected)
    ? `<option value="${escapeHtml(`${provider}/${model}`)}" selected>${escapeHtml(`${provider} / ${model}`)}（目录外）</option>`
    : ''
  const effortOptions = effortsOf(selection).map((value) => ({
    value,
    label: EFFORT_LABELS[value],
    selected: value === effort,
  }))
  const warning = chosen && !isAdditionOnly(selection)
    ? `<p class="settings-warning" data-warning="tool-update-fixed">${TOOL_UPDATE_WARNING}</p>`
    : ''
  const state = provider === '' || model === '' || effort === ''
    ? `<p class="settings-empty" data-agent-unset="${agentClass}">${NOT_CHOSEN}</p>`
    : ''

  return `<section class="glass-card settings-agent" data-agent-class="${agentClass}">
  <h2>${AGENT_LABELS[agentClass]}</h2>
  <label>模型
    <select name="model" data-field="model" data-agent-class="${agentClass}">
      <option value=""${chosen ? '' : ' selected'}>${NOT_CHOSEN}</option>
      ${selectOptions(catalog)}
      ${custom}
    </select>
  </label>
  <label>思考强度
    <select name="effort" data-field="effort" data-agent-class="${agentClass}">
      <option value=""${effort === '' ? ' selected' : ''}>${NOT_CHOSEN}</option>
      ${selectOptions(effortOptions)}
    </select>
  </label>
  <label>手填 provider 与模型 ID
    <input type="text" name="custom-provider" data-field="custom-provider" data-agent-class="${agentClass}" value="" placeholder="provider，例如 deepseek-official">
    <input type="text" name="custom-model" data-field="custom-model" data-agent-class="${agentClass}" value="" placeholder="model ID，例如 custom-model">
  </label>
  ${state}
  ${warning}
  <div class="actions">
    <button type="button" class="primary" data-action="save-model" data-agent-class="${agentClass}">保存模型设置</button>
  </div>
</section>`
}

function renderSecrets(view: ConsoleSettingsView): string {
  const rows = view.secretNames.length === 0
    ? '<p class="settings-empty" data-secret-list="empty">还没有保存任何密钥</p>'
    : `<ul class="secret-list">${view.secretNames
      .map((name) => `<li data-secret-name="${escapeHtml(name)}">${escapeHtml(name)}：已保存</li>`)
      .join('')}</ul>`
  const quota = view.sharedQuotaWarning
    ? '<p class="settings-warning" data-warning="shared-quota">与主 DSH 共用配额</p>'
    : ''
  return `<section class="glass-card settings-secrets">
  <h2>密钥</h2>
  <p class="settings-hint">只显示名字，密钥原文读不回来。保存在 Brain 自己的 state/secrets.json（600）。</p>
  ${rows}
  <form class="secret-form" autocomplete="off">
    <label>密钥名 <input type="text" name="name" data-field="secret-name" value=""></label>
    <label>密钥值 <input type="password" name="value" data-field="secret-value" value="" autocomplete="new-password"></label>
    <button class="primary" type="submit">保存</button>
  </form>
  ${quota}
</section>`
}

function renderRoleCard(view: ConsoleSettingsView): string {
  const active = view.roleCard === null
    ? '<p class="settings-warning" data-warning="role-card-missing">先选角色卡（未选角色卡时唤醒返回 UNAVAILABLE）</p>'
    : `<p data-role-card-active="${escapeHtml(view.roleCard.name)}">当前角色卡：${escapeHtml(view.roleCard.name)}</p>`
  const options = view.availableRoleCards
    .map((name) => `<option value="${escapeHtml(name)}"${view.roleCard?.name === name ? ' selected' : ''}>${escapeHtml(name)}</option>`)
    .join('')
  return `<section class="glass-card settings-role-card">
  <h2>角色卡</h2>
  ${active}
  <div class="inline-field">
    <label>选择已有角色卡
      <select name="role-card" data-field="role-card">
        <option value="">未选择</option>
        ${options}
      </select>
    </label>
    <button type="button" data-action="select-role-card">切换选中角色卡</button>
  </div>
  <form class="role-interview" data-form="role-interview">
    <label>名字 <input type="text" name="name" data-field="role-name" value=""></label>
    <label>核心定位 <input type="text" name="summary" data-field="role-summary" value=""></label>
    <label>说话语气 <input type="text" name="tone" data-field="role-tone" value=""></label>
    <fieldset class="role-traits">
      <legend>特质与它在对话里的样子</legend>
      <div class="role-trait-row" data-trait-index="0">
        <input type="text" name="trait" data-field="trait" value="" placeholder="特质">
        <input type="text" name="manifestation" data-field="manifestation" value="" placeholder="在对话里怎么体现">
      </div>
      <button type="button" data-action="add-trait-row">+ 添加特质</button>
    </fieldset>
    <button class="primary" type="submit">生成并保存角色卡</button>
  </form>
  <form class="role-raw" data-form="role-raw">
    <h3>直接编辑角色卡 Markdown</h3>
    <label>角色卡名字 <input type="text" name="name" data-field="raw-role-name" value="${escapeHtml(view.roleCard?.name ?? '')}" placeholder="例如：小满"></label>
    <label>Markdown 内容 <textarea name="text" data-field="raw-role-text" rows="6" placeholder="# 角色名&#10;&#10;- 定位：...">${escapeHtml(view.roleCard?.text ?? '')}</textarea></label>
    <button type="submit">保存原始角色卡</button>
  </form>
</section>`
}

/**
 * Renders the settings panel. Nothing is pre-selected (D21): a class with no choice shows the empty option and
 * says the process will not start, and no secret value ever reaches the HTML (FR-C05).
 */
export function renderSettingsPanel(view: ConsoleSettingsView): string {
  return `<div class="settings-panel settings-layout">
${AGENT_CLASSES.map((agentClass) => renderModelPicker(agentClass, view.agents[agentClass])).join('\n')}
${renderSecrets(view)}
${renderRoleCard(view)}
</div>`
}
