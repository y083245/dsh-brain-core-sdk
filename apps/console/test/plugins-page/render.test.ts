import assert from 'node:assert/strict'
import test from 'node:test'
import { renderPluginsPage, type PluginsPageState } from '../../src/pages/plugins/index.ts'

function baseState(overrides: Partial<PluginsPageState> = {}): PluginsPageState {
  return {
    plugins: [],
    coreBudgets: [],
    pendingInstall: null,
    pendingUpgrade: null,
    lastCheckReport: null,
    rollbackNotice: null,
    errorMessage: null,
    ...overrides,
  }
}

test('renderPluginsPage renders empty state without alerts or modals', () => {
  const html = renderPluginsPage(baseState())
  assert.match(html, /暂无已安装插件/)
  assert.match(html, /暂无已注册工具/)
  assert.match(html, /暂无通道预算数据/)
  assert.doesNotMatch(html, /data-role="permission-modal"/)
  assert.doesNotMatch(html, /data-role="rollback-banner"/)
  assert.doesNotMatch(html, /data-role="error-banner"/)
  assert.doesNotMatch(html, /data-role="check-report"/)
  assert.doesNotMatch(html, /data-role="core-budget-alert"/)
})

test('renderPluginsPage renders plugin cards, states, check badges, lan highlights, and uninstall choices', () => {
  const html = renderPluginsPage(baseState({
    plugins: [
      {
        id: 'alpha',
        version: '1.0.0',
        kinds: ['channel', 'capability'],
        runtime: 'node',
        state: 'enabled',
        permissions: ['memory.search', 'lan:192.168.1.5'],
        granted: ['memory.search', 'lan:192.168.1.5'],
        checkPassed: true,
        tools: [
          {
            name: 'send_msg',
            effect: 'send',
            load: 'core',
            group: 'messaging',
            when: 'channel == "private"',
            audience: 'owner',
            summary: 'Send a message',
          },
        ],
      },
      {
        id: 'beta',
        version: '0.2.0',
        kinds: [],
        runtime: 'process',
        state: 'disabled',
        permissions: [],
        granted: [],
        checkPassed: false,
        tools: [
          {
            name: 'fetch_item',
            effect: 'read',
            load: 'onDemand',
            summary: 'Fetch item',
          },
        ],
      },
      {
        id: 'gamma',
        version: '0.3.0',
        kinds: ['activity'],
        runtime: 'node',
        state: 'pending',
        permissions: ['lan:config:endpoint'],
        granted: ['lan:config:endpoint'],
        checkPassed: true,
        tools: [],
      },
      {
        id: 'delta',
        version: '0.4.0',
        kinds: ['memory-provider'],
        runtime: 'process',
        state: 'failed',
        permissions: ['memory.ingest'],
        granted: ['memory.ingest'],
        checkPassed: false,
        tools: [],
      },
      {
        id: 'epsilon',
        version: '0.5.0',
        kinds: ['capability'],
        runtime: 'node',
        state: 'discovered',
        source: 'workspace',
        permissions: ['memory.search'],
        granted: [],
        checkPassed: true,
        tools: [],
      },
      {
        id: 'zeta',
        version: '1.0.0',
        kinds: ['capability'],
        runtime: 'node',
        state: 'enabled',
        source: 'workspace',
        permissions: ['memory.search'],
        granted: ['memory.search'],
        checkPassed: true,
        tools: [],
        updateAvailable: {
          version: '1.1.0',
          sha8: 'abcdef12',
          permissions: ['memory.search'],
          newPermissions: [],
          warnings: [],
        },
      },
    ],
  }))

  assert.match(html, /class="glass-card"/)
  assert.match(html, /class="apple-badge/)
  assert.match(html, /class="[^"]*\bmono\b/)
  assert.match(html, /data-state="discovered"[^>]*>本地发现/)
  assert.match(html, /data-state="enabled"[^>]*>已启用/)
  assert.match(html, /data-state="disabled"[^>]*>已停用/)
  assert.match(html, /data-state="pending"[^>]*>待确认/)
  assert.match(html, /data-state="failed"[^>]*>异常/)
  assert.match(html, /data-role="update-available"[^>]*>有本地更新 v1\.1\.0/)
  assert.match(html, /符合规范/)
  assert.match(html, /未通过检查/)
  assert.match(html, /data-lan="true"[^>]*>内网访问 · lan:192\.168\.1\.5/)
  assert.match(html, /data-lan="true"[^>]*>内网访问 · lan:config:endpoint/)
  assert.match(html, /无权限/)
  assert.match(html, /保留私有数据/)
  assert.match(html, /删除私有数据/)

  // Tool catalog assertions
  assert.match(html, /alpha__send_msg/)
  assert.match(html, /core/)
  assert.match(html, /send/)
  assert.match(html, /messaging/)
  assert.match(html, /channel == &quot;private&quot;/)
  assert.match(html, /owner/)
  assert.match(html, /Send a message/)
  assert.match(html, /beta__fetch_item/)
  assert.match(html, /onDemand/)
  assert.match(html, /Fetch item/)
  assert.match(html, /data-tool-name="beta__fetch_item" data-plugin-state="disabled"/)
  assert.match(html, /未启用/)
})

test('renderPluginsPage renders checkPassed true vs false accurately on individual plugin cards', () => {
  const passedOnlyHtml = renderPluginsPage(baseState({
    plugins: [
      {
        id: 'passed-plugin',
        version: '1.0.0',
        kinds: ['capability'],
        runtime: 'node',
        state: 'enabled',
        permissions: [],
        granted: [],
        checkPassed: true,
        tools: [],
      },
    ],
  }))
  assert.match(passedOnlyHtml, /data-check="passed"[^>]*>符合规范/)
  assert.doesNotMatch(passedOnlyHtml, /未通过检查/)

  const failedOnlyHtml = renderPluginsPage(baseState({
    plugins: [
      {
        id: 'failed-plugin',
        version: '1.0.0',
        kinds: ['capability'],
        runtime: 'node',
        state: 'enabled',
        permissions: [],
        granted: [],
        checkPassed: false,
        tools: [],
      },
    ],
  }))
  assert.match(failedOnlyHtml, /data-check="failed"[^>]*>未通过检查/)
  assert.doesNotMatch(failedOnlyHtml, /符合规范/)
})

test('renderPluginsPage renders permission modal for install and upgrade with lan highlight and warnings', () => {
  const installHtml = renderPluginsPage(baseState({
    pendingInstall: {
      id: 'lan-plugin',
      version: '1.0.0',
      permissions: ['memory.ingest', 'lan:127.0.0.1'],
      newPermissions: ['lan:127.0.0.1'],
      warnings: ['core tool count exceeds 8'],
    },
  }))
  assert.match(installHtml, /data-role="permission-modal" data-mode="install"/)
  assert.match(installHtml, /安装权限确认/)
  assert.match(installHtml, /data-role="new-permissions"/)
  assert.match(installHtml, /新增权限：/)
  assert.match(installHtml, /内网访问 · lan:127\.0\.0\.1/)
  assert.match(installHtml, /core tool count exceeds 8/)
  assert.match(installHtml, /批准权限并启用/)
  assert.match(installHtml, /取消/)

  const upgradeHtml = renderPluginsPage(baseState({
    pendingUpgrade: {
      id: 'lan-plugin',
      spec: '2.0.0',
      preview: {
        id: 'lan-plugin',
        version: '2.0.0',
        permissions: ['memory.ingest', 'lan:config:hosts'],
        newPermissions: [],
        warnings: [],
      },
    },
  }))
  assert.match(upgradeHtml, /data-role="permission-modal" data-mode="upgrade"/)
  assert.match(upgradeHtml, /升级权限确认/)
  assert.doesNotMatch(upgradeHtml, /data-role="new-permissions"/)
  assert.doesNotMatch(upgradeHtml, /data-role="preview-warnings"/)
})

test('renderPluginsPage renders rollbackNotice, errorMessage, and checkReport (manifest ok & error, contract, findings, notes)', () => {
  const okReportHtml = renderPluginsPage(baseState({
    rollbackNotice: '插件 demo 已自动回滚至旧版',
    errorMessage: '网络超时',
    lastCheckReport: {
      target: '/plugins/demo',
      report: {
        ok: true,
        manifest: {
          ok: true,
          manifest: {
            id: 'demo',
            kinds: ['capability'],
            api: '^1.0.0',
            runtime: 'node',
            permissions: [],
          },
        },
        contract: [
          { name: 'apply', ok: true, message: 'apply finished without throwing' },
          { name: 'unload-clean', ok: false, message: '1 timer left' },
        ],
        findings: [
          { rule: 'no-direct-network', level: 'must', message: 'forbidden import', file: 'src/index.ts', line: 12 },
          { rule: 'prefer-summary', level: 'should', message: 'short summary' },
        ],
        notes: ['checked 1 file'],
      },
    },
  }))

  assert.match(okReportHtml, /data-role="error-banner"/)
  assert.match(okReportHtml, /网络超时/)
  assert.match(okReportHtml, /data-role="rollback-banner"/)
  assert.match(okReportHtml, /插件 demo 已自动回滚至旧版/)
  assert.match(okReportHtml, /manifest 通过/)
  assert.match(okReportHtml, /PASS/)
  assert.match(okReportHtml, /FAIL/)
  assert.match(okReportHtml, /unload-clean/)
  assert.match(okReportHtml, /no-direct-network/)
  assert.match(okReportHtml, /src\/index\.ts:12/)
  assert.match(okReportHtml, /prefer-summary/)
  assert.match(okReportHtml, /checked 1 file/)

  const badManifestHtml = renderPluginsPage(baseState({
    lastCheckReport: {
      target: '/plugins/broken',
      report: {
        ok: false,
        manifest: {
          ok: false,
          errors: [{ field: 'id', message: 'missing id' }],
        },
        contract: [],
        findings: [],
        notes: [],
      },
    },
  }))
  assert.match(badManifestHtml, /manifest 未通过/)
  assert.match(badManifestHtml, /missing id/)
  assert.match(badManifestHtml, /无静态扫描问题/)
  assert.doesNotMatch(badManifestHtml, /data-role="check-notes"/)
})

test('renderPluginsPage renders core budget alert ONLY when over === true', () => {
  const normalHtml = renderPluginsPage(baseState({
    coreBudgets: [
      { pattern: 'console:*', count: 3, tokens: 450, over: false },
      { pattern: 'qq:*', count: 8, tokens: 2000, over: false },
    ],
  }))
  assert.match(normalHtml, /3 \/ 8/)
  assert.match(normalHtml, /450 \/ 2000/)
  assert.doesNotMatch(normalHtml, /data-role="core-budget-alert"/)
  assert.doesNotMatch(normalHtml, /Core 工具预算超限告警/)

  const overHtml = renderPluginsPage(baseState({
    coreBudgets: [
      { pattern: 'console:*', count: 3, tokens: 450, over: false },
      { pattern: 'qq:*', count: 9, tokens: 2150, over: true },
    ],
  }))
  assert.match(overHtml, /data-role="core-budget-alert"/)
  assert.match(overHtml, /Core 工具预算超限告警/)
  assert.match(overHtml, /9 \/ 8/)
  assert.match(overHtml, /2150 \/ 2000/)
  assert.match(overHtml, /超限/)
})

test('renderPluginsPage escapes all dynamic text to prevent XSS', () => {
  const xss = '<script>alert("xss")</script>'
  const html = renderPluginsPage(baseState({
    errorMessage: xss,
    rollbackNotice: xss,
    pendingInstall: {
      id: xss,
      version: xss,
      permissions: [`lan:${xss}`],
      newPermissions: [xss],
      warnings: [xss],
    },
    plugins: [
      {
        id: xss,
        version: xss,
        kinds: ['capability'],
        runtime: 'node',
        state: 'enabled',
        permissions: [xss],
        granted: [xss],
        checkPassed: true,
        updateAvailable: {
          version: xss,
          sha8: 'deadbeef',
          permissions: [],
          newPermissions: [],
          warnings: [],
        },
        tools: [
          {
            name: xss,
            effect: 'read',
            load: 'context',
            group: xss,
            when: xss,
            summary: xss,
          },
        ],
      },
    ],
    coreBudgets: [{ pattern: xss, count: 1, tokens: 10, over: false }],
    lastCheckReport: {
      target: xss,
      report: {
        ok: false,
        manifest: { ok: false, errors: [{ field: xss, message: xss }] },
        contract: [{ name: xss, ok: false, message: xss }],
        findings: [{ rule: xss, level: 'must', message: xss, file: xss, line: 1 }],
        notes: [xss],
      },
    },
  }))

  assert.equal(html.includes('<script>'), false)
  assert.equal(html.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'), true)
})
