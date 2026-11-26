import assert from 'node:assert/strict'
import test from 'node:test'
import { renderAppleThemeCss, renderShellHtml, type ShellViewInput } from '../../src/shell/theme.ts'

function view(overrides: Partial<ShellViewInput> = {}): ShellViewInput {
  return {
    theme: 'dark',
    activePageId: 'settings',
    authenticated: true,
    roleCardName: '小满',
    sharedQuotaWarning: false,
    navItems: [
      { id: 'settings', title: '设置', group: 'core' },
      { id: 'memory', title: '记忆', group: 'core' },
      { id: 'plugins', title: '插件', badge: '3', group: 'plugin' },
    ],
    mainHtml: '<p id="page-body">设置面板</p>',
    ...overrides,
  }
}

test('the Apple theme CSS carries vibrancy, the mirror edge and all three theme blocks', () => {
  const css = renderAppleThemeCss()
  assert.match(css, /backdrop-filter: blur\(48px\)/)
  assert.match(css, /-webkit-backdrop-filter: blur\(48px\)/)
  assert.match(css, /saturate\(190%\)/)
  assert.match(css, /--saturate: 180%;/)
  assert.match(css, /\[data-theme="dark"\]/)
  assert.match(css, /\[data-theme="light"\]/)
  assert.match(css, /\[data-theme="auto"\]/)
  assert.match(css, /@media \(prefers-color-scheme: light\)/)
})

test('the Apple theme CSS defines every class the shell and the pages share', () => {
  const css = renderAppleThemeCss()
  for (const selector of ['.wallpaper', '.window', '.sidebar', '.traffic-lights', '.segmented', '.glass-card', '.apple-badge', '.mono']) {
    assert.ok(css.includes(selector), `missing ${selector}`)
  }
  assert.match(css, /\.window \{[^}]*border-radius: 22px/s)
  assert.match(css, /\.glass-card \{[^}]*border-radius: 18px/s)
  assert.match(css, /inset 0 1px 0/)
  assert.match(css, /#FF5F56/)
  assert.match(css, /#FFBD2E/)
  assert.match(css, /#27C93F/)
  assert.match(css, /"SF Mono", Menlo, monospace/)
  assert.match(css, /tabular-nums/)
  assert.match(css, /-apple-system/)
})

test('renderShellHtml switches between the three themes', () => {
  for (const theme of ['dark', 'light', 'auto'] as const) {
    const html = renderShellHtml(view({ theme }))
    assert.match(html, new RegExp(`<html lang="zh-CN" data-theme="${theme}">`))
  }
  const dark = renderShellHtml(view({ theme: 'dark' }))
  assert.match(dark, /data-theme-option="light"/)
  assert.match(dark, /data-theme-option="auto"/)
  assert.match(dark, /data-theme-option="dark" aria-selected="true"/)
})

test('renderShellHtml draws the three traffic lights and the navigation slots', () => {
  const html = renderShellHtml(view())
  assert.match(html, /class="traffic-lights"/)
  assert.match(html, /class="traffic-light close"/)
  assert.match(html, /class="traffic-light minimize"/)
  assert.match(html, /class="traffic-light zoom"/)
  assert.match(html, /class="sidebar"/)
  assert.match(html, /data-nav-id="settings"[^>]*aria-current="page"/)
  assert.match(html, /data-nav-id="memory"/)
  assert.match(html, /data-nav-id="plugins"/)
  assert.match(html, /<span class="apple-badge">3<\/span>/)
  assert.match(html, /<div class="nav-group-label">插件<\/div>/)
})

test('an unauthenticated shell renders only the token login box, never mainHtml or business data', () => {
  const html = renderShellHtml(view({
    authenticated: false,
    roleCardName: '小满',
    sharedQuotaWarning: true,
    mainHtml: '<p id="page-body">SECRET-PAGE-DATA</p>',
    navItems: [{ id: 'plugins', title: '插件', badge: '7', group: 'plugin' }],
  }))
  assert.match(html, /id="token-login-form"/)
  assert.match(html, /type="password"/)
  assert.ok(!html.includes('SECRET-PAGE-DATA'), 'mainHtml must not be rendered before the token is checked')
  assert.ok(!html.includes('page-body'), 'the main area must not exist before the token is checked')
  assert.ok(!html.includes('data-nav-id="plugins"'), 'navigation must not render before the token is checked')
  assert.ok(!html.includes('<span class="apple-badge">7</span>'), 'badges are business data and must not render')
  assert.ok(!html.includes('小满'), 'the role card name is business data and must not render')
  assert.ok(!html.includes('id="shared-quota-warning"'), 'whether the owner shares quota is state and must not render')
})

test('the authenticated shell renders the login form nowhere and the page body once', () => {
  const html = renderShellHtml(view())
  assert.ok(!html.includes('id="token-login-form"'))
  assert.match(html, /<p id="page-body">设置面板<\/p>/)
})

test('a missing role card shows the prominent banner; a chosen one shows its name', () => {
  const missing = renderShellHtml(view({ roleCardName: null }))
  assert.match(missing, /先选角色卡/)
  assert.match(missing, /未选角色卡时唤醒返回 UNAVAILABLE/)
  assert.match(missing, /id="role-card-missing"/)

  const chosen = renderShellHtml(view({ roleCardName: '小满' }))
  assert.ok(!chosen.includes('先选角色卡'))
  assert.match(chosen, /id="role-card-active"/)
  assert.match(chosen, /小满/)
})

test('a shared quota warning renders the notice only when it is true', () => {
  assert.match(renderShellHtml(view({ sharedQuotaWarning: true })), /与主 DSH 共用配额/)
  assert.ok(!renderShellHtml(view({ sharedQuotaWarning: false })).includes('与主 DSH 共用配额'))
})

test('navigation titles and badges are escaped', () => {
  const html = renderShellHtml(view({
    navItems: [{ id: 'plugins', title: '<script>x</script>', badge: '"1"', group: 'plugin' }],
  }))
  assert.ok(!html.includes('<script>x</script>'))
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/)
  assert.match(html, /&quot;1&quot;/)
})

test('Apple theme CSS includes accounting and interop glass styles and console index exports accounting', async () => {
  const css = renderAppleThemeCss()
  for (const selector of [
    '.accounting-kpi-grid',
    '.budget-meter-svg',
    '.accounting-budget-svg',
    '.plugin-cost-svg',
    '.daily-cost-svg',
    '.patch-yaml-code',
    '.glass-code',
  ]) {
    assert.ok(css.includes(selector), `missing ${selector}`)
  }
  assert.match(css, /(?:^|\n)\.accounting-kpi-grid\s*\{[\s\S]*?display:\s*grid/)
  assert.match(css, /(?:^|\n)\.glass-code,\s*\n\.patch-yaml-code\s*\{/)

  const consolePkg = await import('../../src/index.ts')
  assert.equal(typeof consolePkg.createAccountingPageController, 'function')
  assert.equal(typeof consolePkg.createHttpAccountingPageApi, 'function')
  assert.equal(typeof consolePkg.renderAccountingView, 'function')
})
