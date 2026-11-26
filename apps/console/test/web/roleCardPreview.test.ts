import assert from 'node:assert/strict'
import test from 'node:test'
import {
  extractRoleSummary,
  formatRoleOriginLabel,
  getRoleOriginBadgeTone,
} from '../../web/src/pages/settings/roleCardPreview.ts'

test('formatRoleOriginLabel maps all RoleCardOrigin variants to Chinese labels', () => {
  assert.equal(formatRoleOriginLabel('factory'), '出厂')
  assert.equal(formatRoleOriginLabel('user'), '自定义')
  assert.equal(formatRoleOriginLabel('modified'), '已修改')
})

test('getRoleOriginBadgeTone returns stable ink-tide tones for each origin', () => {
  assert.equal(getRoleOriginBadgeTone('factory'), 'shiqing')
  assert.equal(getRoleOriginBadgeTone('user'), 'shilv')
  assert.equal(getRoleOriginBadgeTone('modified'), 'tenghuang')
})

test('extractRoleSummary returns empty string for blank or heading-only cards', () => {
  assert.equal(extractRoleSummary(''), '')
  assert.equal(extractRoleSummary('   \n\t\n  '), '')
  assert.equal(extractRoleSummary('# 小满\n\n## 性格\n\n---'), '')
})

test('extractRoleSummary extracts and joins the first body paragraph across line wraps', () => {
  const md = [
    '# 阿澜',
    '',
    '安静克制的夜间搭档，',
    '习惯先听完再给建议。',
    '',
    '第二段不应出现在副标题里。',
  ].join('\n')

  assert.equal(extractRoleSummary(md), '安静克制的夜间搭档， 习惯先听完再给建议。')
})

test('extractRoleSummary skips YAML frontmatter, horizontal rules and fenced code blocks', () => {
  const md = [
    '---',
    'version: 1',
    'author: starter',
    '---',
    '',
    '# 墨羽',
    '***',
    '```txt',
    'code block should be skipped',
    '```',
    '',
    '**冷静**但带点`幽默`的[观察者](https://example.invalid)。',
  ].join('\r\n')

  assert.equal(extractRoleSummary(md), '冷静但带点幽默的观察者。')
})

test('extractRoleSummary handles interview-generated list items and blockquotes', () => {
  const interviewMd = [
    '# 小满',
    '',
    '- 定位：一个记事、也会打岔的人',
    '- 语气：轻、短句',
  ].join('\n')
  assert.equal(extractRoleSummary(interviewMd), '定位：一个记事、也会打岔的人')

  const quoteMd = [
    '# 书砚',
    '',
    '> 慢一点的人，',
    '> 喜欢把话说清楚。',
    '',
    '后续段落',
  ].join('\n')
  assert.equal(extractRoleSummary(quoteMd), '慢一点的人， 喜欢把话说清楚。')
})

test('extractRoleSummary truncates long summaries cleanly by Unicode code points', () => {
  const longText = `# 长文\n\n${'墨'.repeat(150)}`
  const summary = extractRoleSummary(longText, 20)
  assert.equal(Array.from(summary).length, 20)
  assert.ok(summary.endsWith('…'))

  const emojiText = `# 表情\n\n${'🌊'.repeat(10)}`
  const emojiSummary = extractRoleSummary(emojiText, 5)
  assert.equal(Array.from(emojiSummary).length, 5)
  assert.equal(emojiSummary, '🌊🌊🌊🌊…')

  assert.equal(extractRoleSummary('# 极短\n\n一二三', 1), '…')
  assert.equal(extractRoleSummary('# 零长\n\n一二三', 0), '')
})
