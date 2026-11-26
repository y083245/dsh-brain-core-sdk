import assert from 'node:assert/strict'
import test from 'node:test'
import { BrainError } from '@brain-core/sdk'
import {
  buildRoleCardFromInterview, MODEL_CATALOG, renderSettingsPanel,
  type ConsoleSettingsView, type RoleCardInterviewInput,
} from '../../src/shell/settings.ts'

const NOT_CHOSEN = '未选择 — 该类 Agent 进程不启动'

function view(overrides: Partial<ConsoleSettingsView> = {}): ConsoleSettingsView {
  return {
    agents: {},
    secretNames: [],
    sharedQuotaWarning: true,
    roleCard: null,
    availableRoleCards: [],
    ...overrides,
  }
}

test('the model catalog is exactly what the order pinned', () => {
  assert.deepEqual(MODEL_CATALOG, [
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
  ])
})

test('nothing is pre-selected when no model or effort has been chosen (D21)', () => {
  const html = renderSettingsPanel(view())
  // 四个空选项：两个 Agent 类的模型和强度各一个。
  assert.equal(html.match(/<option value="" selected>/g)?.length, 4, 'only the empty option may be selected')
  assert.equal(html.match(/ selected>/g)?.length, 4, 'no catalog model or effort may be pre-selected')
  assert.ok(!/deepseek-flash" selected/.test(html))
  assert.ok(!/deepseek-v4-pro" selected/.test(html))
  assert.ok(!/value="high" selected/.test(html))
  assert.match(html, /data-agent-unset="chat"/)
  assert.match(html, /data-agent-unset="activity"/)
  assert.ok(html.includes(NOT_CHOSEN))
})

test('a class with only a model chosen still refuses to look configured', () => {
  const html = renderSettingsPanel(view({ agents: { chat: { provider: 'deepseek-official', model: 'deepseek-flash' } } }))
  assert.match(html, /data-agent-unset="chat"/)
  assert.match(html, /<option value="" selected>/)
})

test('deepseek-flash declares addition-only, so no fixed warning appears', () => {
  const html = renderSettingsPanel(view({
    agents: { chat: { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'high' } },
  }))
  assert.ok(!html.includes('data-warning="tool-update-fixed"'))
  assert.ok(!html.includes('不支持增量工具更新'))
  assert.match(html, /<option value="deepseek-official\/deepseek-flash" selected>/)
  assert.match(html, /<option value="high" selected>/)
  assert.ok(!html.includes('data-agent-unset="chat"'))
})

test('deepseek-v4-pro warns about the fixed tool surface, caching and first latency', () => {
  const html = renderSettingsPanel(view({
    agents: { activity: { provider: 'deepseek-official', model: 'deepseek-v4-pro', effort: 'low' } },
  }))
  assert.match(html, /data-warning="tool-update-fixed"/)
  assert.match(html, /该模型不支持增量工具更新（fixed）/)
  assert.match(html, /tools__load 需换会话才生效/)
  assert.match(html, /会影响缓存与首条时延/)
  assert.match(html, /<option value="low" selected>/)
})

test('a hand-typed model id keeps its own option and gets the fixed warning', () => {
  const html = renderSettingsPanel(view({
    agents: { chat: { provider: 'deepseek-official', model: 'custom-model', effort: 'max' } },
  }))
  assert.match(html, /deepseek-official \/ custom-model（目录外）/)
  assert.match(html, /data-warning="tool-update-fixed"/)
  assert.match(html, /<option value="deepseek-official\/custom-model" selected>/)
})

test('the model-default effort says which effort the adapter actually sends', () => {
  const html = renderSettingsPanel(view({
    agents: { chat: { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'model-default' } },
  }))
  assert.match(html, /跟随模型默认（适配器当前默认实际发送 high）/)
  assert.match(html, /<option value="model-default" selected>/)
})

test('a catalog model under an unknown provider is outside the catalog and gets the fixed warning', () => {
  const html = renderSettingsPanel(view({
    agents: { chat: { provider: 'custom-provider', model: 'deepseek-flash', effort: 'high' } },
  }))
  assert.match(html, /custom-provider \/ deepseek-flash（目录外）/)
  assert.match(html, /<option value="custom-provider\/deepseek-flash" selected>/)
  assert.match(html, /data-warning="tool-update-fixed"/)
})

test('a model chosen without a provider leaves the model dropdown on the empty option', () => {
  const html = renderSettingsPanel(view({ agents: { chat: { model: 'deepseek-flash' } } }))
  // 只有两个强度空项和 activity 的模型空项带 selected：chat 的模型空项不算选中。
  assert.equal(html.match(/<option value="" selected>/g)?.length, 3)
  assert.ok(!html.includes('<option value="deepseek-official/deepseek-flash" selected>'))
  assert.match(html, /data-agent-unset="chat"/)
})

test('secrets render their names and never a value', () => {
  const html = renderSettingsPanel(view({
    secretNames: ['brain-deepseek-api-key', 'deepseek-api-key'],
    sharedQuotaWarning: false,
  }))
  assert.match(html, /brain-deepseek-api-key：已保存/)
  assert.match(html, /deepseek-api-key：已保存/)
  assert.match(html, /type="password"/)
  assert.match(html, /data-field="secret-value" value=""/)
  assert.ok(!html.includes('与主 DSH 共用配额'))
})

test('an empty secret list says so, and the shared quota warning follows the view flag', () => {
  const html = renderSettingsPanel(view({ secretNames: [], sharedQuotaWarning: true }))
  assert.match(html, /data-secret-list="empty"/)
  assert.match(html, /data-warning="shared-quota"/)
  assert.match(html, /与主 DSH 共用配额/)
})

test('a missing role card shows the loud warning and the existing cards are offered', () => {
  const html = renderSettingsPanel(view({ roleCard: null, availableRoleCards: ['小满', '阿澜'] }))
  assert.match(html, /data-warning="role-card-missing"/)
  assert.match(html, /先选角色卡（未选角色卡时唤醒返回 UNAVAILABLE）/)
  assert.match(html, /<option value="小满">小满<\/option>/)
  assert.match(html, /<option value="阿澜">阿澜<\/option>/)
})

test('an active role card is named and marked selected', () => {
  const html = renderSettingsPanel(view({
    roleCard: { name: '小满', text: '# 小满\n' },
    availableRoleCards: ['小满', '阿澜'],
  }))
  assert.ok(!html.includes('data-warning="role-card-missing"'))
  assert.match(html, /data-role-card-active="小满"/)
  assert.match(html, /<option value="小满" selected>小满<\/option>/)
})

test('the interview builds a Markdown role card with a line per trait', () => {
  const card = buildRoleCardFromInterview({
    name: '  小满  ',
    summary: ' 一个记事、也会打岔的人 ',
    tone: ' 轻、短句 ',
    traits: [
      { trait: ' 记性好 ', manifestation: ' 会主动提起你上周随口说的事 ' },
      { trait: '嘴硬', manifestation: '被夸时先说「哪有」，再接着聊下去' },
    ],
  })
  assert.equal(card.name, '小满')
  assert.match(card.text, /^# 小满/)
  assert.match(card.text, /定位：一个记事、也会打岔的人/)
  assert.match(card.text, /语气：轻、短句/)
  assert.match(card.text, /- \*\*记性好\*\*：在对话中体现为：会主动提起你上周随口说的事/)
  assert.match(card.text, /- \*\*嘴硬\*\*：在对话中体现为：被夸时先说「哪有」，再接着聊下去/)
})

function refuses(input: RoleCardInterviewInput, field: string): void {
  assert.throws(
    () => buildRoleCardFromInterview(input),
    (error: unknown) => error instanceof BrainError
      && error.code === 'INVALID_ARGUMENT'
      && (error.details as { field?: string }).field === field,
    `expected INVALID_ARGUMENT with field ${field}`,
  )
}

const GOOD: RoleCardInterviewInput = {
  name: '小满',
  summary: '记事的人',
  tone: '轻',
  traits: [{ trait: '记性好', manifestation: '主动提起旧事' }],
}

test('the interview refuses a blank name, summary or tone', () => {
  refuses({ ...GOOD, name: '   ' }, 'name')
  refuses({ ...GOOD, summary: '' }, 'summary')
  refuses({ ...GOOD, tone: '\n\t ' }, 'tone')
})

test('the interview refuses no traits or a trait that is blank or has no manifestation', () => {
  refuses({ ...GOOD, traits: [] }, 'traits')
  refuses({ ...GOOD, traits: [{ trait: '  ', manifestation: '主动提起旧事' }] }, 'traits[0].trait')
  refuses({ ...GOOD, traits: [{ trait: '记性好', manifestation: '   ' }] }, 'traits[0].manifestation')
  refuses({ ...GOOD, traits: [{ trait: '记性好', manifestation: '' }] }, 'traits[0].manifestation')
  refuses({
    ...GOOD,
    traits: [{ trait: '记性好', manifestation: '主动提起旧事' }, { trait: '嘴硬', manifestation: ' ' }],
  }, 'traits[1].manifestation')
})
