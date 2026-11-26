/**
 * Browser-side ES module script served at `GET /assets/console-client.js`.
 * Keeps the bearer token strictly in JS memory (`authToken`) and delegates all UI interactions
 * to `/api/v1/console/ui/*` without adding any third-party dependency or bundler.
 */
export function renderConsoleClientScript(): string {
  return String.raw`(() => {
  let authToken = '';
  let currentPageId = 'settings';
  let pendingPageId = null;
  let busy = false;
  let toastTimer = null;

  const THEME_STORAGE_KEY = 'brain-console-theme';
  const VALID_THEMES = new Set(['dark', 'light', 'auto']);

  function applyTheme(mode, persist) {
    if (!VALID_THEMES.has(mode)) return;
    document.documentElement.dataset.theme = mode;
    for (const btn of document.querySelectorAll('[data-theme-option]')) {
      btn.setAttribute('aria-selected', String(btn.dataset.themeOption === mode));
    }
    if (persist) {
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, mode);
      } catch {}
    }
  }

  try {
    const savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (savedTheme && VALID_THEMES.has(savedTheme)) {
      applyTheme(savedTheme, false);
    }
  } catch {}

  function ensureToastRegion() {
    let region = document.getElementById('toast-region');
    if (region) return region;
    const content = document.querySelector('.content') || document.querySelector('.window') || document.body;
    region = document.createElement('div');
    region.id = 'toast-region';
    region.className = 'toast-region';
    region.setAttribute('aria-live', 'polite');
    content.insertBefore(region, content.firstChild);
    return region;
  }

  function showToast(tone, message) {
    if (!message) return;
    const region = ensureToastRegion();
    region.textContent = '';
    const banner = document.createElement('div');
    banner.className = 'toast-banner';
    banner.dataset.tone = tone || 'info';
    banner.textContent = message;
    region.appendChild(banner);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (banner.parentNode === region) region.removeChild(banner);
    }, 4500);
  }

  function showLoginError(message) {
    const card = document.querySelector('.login-card');
    if (!card) {
      showToast('warning', message);
      return;
    }
    let box = card.querySelector('[data-role="login-error"]');
    if (!box) {
      box = document.createElement('div');
      box.className = 'status-banner';
      box.dataset.tone = 'warning';
      box.dataset.role = 'login-error';
      card.appendChild(box);
    }
    box.textContent = message;
  }

  function renderSidebar(navItems, activePageId) {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;
    sidebar.textContent = '';
    const core = navItems.filter((item) => item.group !== 'plugin');
    const plugins = navItems.filter((item) => item.group === 'plugin');

    function appendGroup(labelText, items) {
      if (items.length === 0) return;
      const label = document.createElement('div');
      label.className = 'nav-group-label';
      label.textContent = labelText;
      sidebar.appendChild(label);

      for (const nav of items) {
        const link = document.createElement('a');
        link.className = 'nav-item';
        link.dataset.navId = nav.id;
        link.href = '#' + nav.id;
        if (nav.id === activePageId) {
          link.setAttribute('aria-current', 'page');
        }
        const titleSpan = document.createElement('span');
        titleSpan.className = 'nav-title';
        titleSpan.textContent = nav.title;
        link.appendChild(titleSpan);
        if (nav.badge !== undefined && nav.badge !== null && nav.badge !== '') {
          const badge = document.createElement('span');
          badge.className = 'apple-badge';
          badge.textContent = String(nav.badge);
          link.appendChild(badge);
        }
        sidebar.appendChild(link);
      }
    }

    appendGroup('内核', core);
    appendGroup('插件', plugins);
  }

  function renderStatusBar(roleCardName, sharedQuotaWarning) {
    const content = document.querySelector('.content');
    if (!content) return;
    let bar = content.querySelector('.status-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'status-bar';
      content.insertBefore(bar, content.firstChild);
    }
    bar.textContent = '';

    if (roleCardName === null || roleCardName === undefined) {
      const warn = document.createElement('div');
      warn.className = 'status-banner';
      warn.dataset.tone = 'warning';
      warn.id = 'role-card-missing';
      warn.textContent = '先选角色卡（未选角色卡时唤醒返回 UNAVAILABLE）';
      bar.appendChild(warn);
    } else {
      const badge = document.createElement('span');
      badge.className = 'apple-badge';
      badge.id = 'role-card-active';
      badge.textContent = '角色卡：' + roleCardName;
      bar.appendChild(badge);
    }

    if (sharedQuotaWarning) {
      const quota = document.createElement('div');
      quota.className = 'status-banner';
      quota.dataset.tone = 'info';
      quota.id = 'shared-quota-warning';
      quota.textContent = '与主 DSH 共用配额';
      bar.appendChild(quota);
    }
  }

  function ensureMainArea() {
    const content = document.querySelector('.content');
    if (!content) return null;
    let main = content.querySelector('.main-area');
    if (!main) {
      const loginCard = content.querySelector('.login-card');
      if (loginCard) loginCard.remove();
      main = document.createElement('div');
      main.className = 'main-area';
      content.appendChild(main);
    }
    return main;
  }

  function applyUiState(ui) {
    if (!ui || typeof ui !== 'object') return;
    currentPageId = ui.activePageId || 'settings';
    if (window.location.hash !== '#' + currentPageId) {
      try {
        window.history.replaceState(null, '', '#' + currentPageId);
      } catch {}
    }
    if (Array.isArray(ui.navItems)) {
      renderSidebar(ui.navItems, currentPageId);
    }
    renderStatusBar(ui.roleCardName ?? null, Boolean(ui.sharedQuotaWarning));
    const main = ensureMainArea();
    if (main && typeof ui.mainHtml === 'string') {
      main.innerHTML = ui.mainHtml;
      main.classList.remove('is-loading');
    }
    if (ui.toast && ui.toast.message) {
      showToast(ui.toast.tone, ui.toast.message);
    }
  }

  async function apiRequest(url, options = {}) {
    const headers = {
      ...(options.headers || {}),
      ...(authToken ? { Authorization: 'Bearer ' + authToken } : {}),
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return { status: response.status, ok: response.ok, parsed };
  }

  async function navigateTo(pageId) {
    if (!authToken) return;
    const target = pageId || 'settings';
    if (pendingPageId === target) return;
    pendingPageId = target;
    const main = document.querySelector('.main-area');
    if (main) main.classList.add('is-loading');
    try {
      const res = await apiRequest('/api/v1/console/ui/state?page=' + encodeURIComponent(target));
      if (!res.ok || !res.parsed || !res.parsed.ok) {
        const msg = res.parsed?.error?.message || '页面加载失败';
        showToast('warning', msg);
        return;
      }
      applyUiState(res.parsed.data);
    } catch {
      showToast('warning', '网络错误，无法加载页面');
    } finally {
      if (pendingPageId === target) pendingPageId = null;
      if (main) main.classList.remove('is-loading');
    }
  }

  async function dispatchAction(action, payload, triggerEl) {
    if (!authToken) {
      showToast('warning', '请先输入控制台令牌登录');
      return;
    }
    if (busy) return;
    busy = true;
    const originalText = triggerEl ? triggerEl.textContent : null;
    const wasDisabled = triggerEl ? Boolean(triggerEl.disabled) : false;
    if (triggerEl) {
      triggerEl.disabled = true;
      if (triggerEl.tagName === 'BUTTON') triggerEl.textContent = '处理中…';
    }
    const main = document.querySelector('.main-area');
    if (main) main.classList.add('is-loading');
    try {
      const res = await apiRequest('/api/v1/console/ui/action', {
        method: 'POST',
        body: { page: currentPageId, action, payload: payload || {} },
      });
      if (!res.ok || !res.parsed || !res.parsed.ok) {
        const msg = res.parsed?.error?.message || '操作失败';
        showToast('warning', msg);
        return;
      }
      applyUiState(res.parsed.data);
    } catch {
      showToast('warning', '请求失败：内核未响应');
    } finally {
      busy = false;
      if (main) main.classList.remove('is-loading');
      if (triggerEl && document.contains(triggerEl)) {
        triggerEl.disabled = wasDisabled;
        if (triggerEl.tagName === 'BUTTON' && originalText !== null) {
          triggerEl.textContent = originalText;
        }
      }
    }
  }

  function addTraitRow(buttonEl) {
    const fieldset = buttonEl.closest('.role-traits');
    if (!fieldset) return;
    const rows = fieldset.querySelectorAll('.role-trait-row');
    const nextIdx = rows.length;
    const row = document.createElement('div');
    row.className = 'role-trait-row';
    row.dataset.traitIndex = String(nextIdx);

    const traitInput = document.createElement('input');
    traitInput.type = 'text';
    traitInput.name = 'trait';
    traitInput.dataset.field = 'trait';
    traitInput.placeholder = '特质';

    const maniInput = document.createElement('input');
    maniInput.type = 'text';
    maniInput.name = 'manifestation';
    maniInput.dataset.field = 'manifestation';
    maniInput.placeholder = '在对话里怎么体现';

    row.appendChild(traitInput);
    row.appendChild(maniInput);
    fieldset.insertBefore(row, buttonEl);
  }

  async function copyMcpPatch() {
    const el = document.querySelector('[data-role="mcp-patch-yaml"]');
    if (!el) return;
    const text = el.textContent || '';
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        showToast('ok', '已复制 --patch YAML');
        return;
      }
    } catch {}
    showToast('info', '请手动选中 --patch YAML 内容复制');
  }

  window.addEventListener('brain-console-token', async (event) => {
    const candidate = typeof event.detail === 'string' ? event.detail.trim() : '';
    if (!candidate) {
      showLoginError('请输入控制台令牌');
      return;
    }
    try {
      const checkRes = await fetch('/api/v1/console/session', {
        headers: { Authorization: 'Bearer ' + candidate },
      });
      const text = await checkRes.text();
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {}
      if (!checkRes.ok || !parsed || !parsed.ok) {
        showLoginError('令牌无效或内核未响应');
        return;
      }
      authToken = candidate;
      const hashPage = window.location.hash ? window.location.hash.slice(1) : '';
      const initialPage = hashPage || 'settings';
      const stateRes = await apiRequest('/api/v1/console/ui/state?page=' + encodeURIComponent(initialPage));
      if (!stateRes.ok || !stateRes.parsed || !stateRes.parsed.ok) {
        showLoginError('控制台状态初始化失败');
        return;
      }
      applyUiState(stateRes.parsed.data);
    } catch {
      showLoginError('令牌无效或内核未响应');
    }
  });

  window.addEventListener('hashchange', () => {
    if (!authToken) return;
    const target = window.location.hash ? window.location.hash.slice(1) : 'settings';
    if (target && target !== currentPageId && target !== pendingPageId) {
      void navigateTo(target);
    }
  });

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const themeBtn = target.closest('[data-theme-option]');
    if (themeBtn) {
      const mode = themeBtn.dataset.themeOption;
      if (mode) applyTheme(mode, true);
      return;
    }

    const navLink = target.closest('a[data-nav-id]');
    if (navLink) {
      event.preventDefault();
      const navId = navLink.dataset.navId;
      if (navId) {
        try {
          window.history.replaceState(null, '', '#' + navId);
        } catch {}
        void navigateTo(navId);
      }
      return;
    }

    const subviewBtn = target.closest('[data-subview]');
    if (subviewBtn) {
      const subView = subviewBtn.dataset.subview;
      if (subviewBtn.closest('.memory-subnav')) {
        void dispatchAction('switch-memory-subview', { subView }, subviewBtn);
      } else if (subviewBtn.closest('.satellite-subnav')) {
        void dispatchAction('switch-satellite-subview', { subView }, subviewBtn);
      }
      return;
    }

    const filterLayerBtn = target.closest('[data-filter-layer]');
    if (filterLayerBtn) {
      const toolbar = filterLayerBtn.closest('.memory-toolbar');
      const personId = toolbar?.querySelector('input[name="personId"]')?.value || '';
      const channel = toolbar?.querySelector('input[name="channel"]')?.value || '';
      void dispatchAction('filter-memory', {
        layer: filterLayerBtn.dataset.filterLayer,
        personId,
        channel,
      }, filterLayerBtn);
      return;
    }

    const crossBtn = target.closest('[data-cross-channel-mode]');
    if (crossBtn) {
      void dispatchAction('set-cross-channel', { mode: crossBtn.dataset.crossChannelMode }, crossBtn);
      return;
    }

    const periodBtn = target.closest('[data-period-days]');
    if (periodBtn) {
      void dispatchAction('set-accounting-days', { days: Number(periodBtn.dataset.periodDays) }, periodBtn);
      return;
    }

    const evidenceJump = target.closest('[data-evidence-jump]');
    if (evidenceJump) {
      const recordId = evidenceJump.dataset.evidenceJump;
      if (recordId) void dispatchAction('jump-to-memory-record', { recordId }, evidenceJump);
      return;
    }

    const actionBtn = target.closest('[data-action]');
    if (actionBtn && actionBtn.tagName !== 'FORM') {
      const action = actionBtn.dataset.action;
      if (action === 'add-trait-row') {
        addTraitRow(actionBtn);
        return;
      }
      if (action === 'copy-mcp-patch') {
        void copyMcpPatch();
        return;
      }
      if (action === 'save-model') {
        const agentClass = actionBtn.dataset.agentClass;
        const section = actionBtn.closest('.settings-agent');
        const customProvider = section?.querySelector('input[name="custom-provider"]')?.value?.trim() || '';
        const customModel = section?.querySelector('input[name="custom-model"]')?.value?.trim() || '';
        const selectedModel = section?.querySelector('select[name="model"]')?.value || '';
        const effort = section?.querySelector('select[name="effort"]')?.value || '';
        let provider = customProvider;
        let model = customModel;
        if ((!provider || !model) && selectedModel.includes('/')) {
          const idx = selectedModel.indexOf('/');
          provider = selectedModel.slice(0, idx);
          model = selectedModel.slice(idx + 1);
        }
        void dispatchAction('save-model', { agentClass, provider, model, effort }, actionBtn);
        return;
      }
      if (action === 'select-role-card') {
        const selectEl = document.querySelector('select[name="role-card"]');
        void dispatchAction('select-role-card', { name: selectEl ? selectEl.value : '' }, actionBtn);
        return;
      }
      if (action === 'apply-memory-filter') {
        const toolbar = actionBtn.closest('.memory-toolbar');
        const activeLayer = toolbar?.querySelector('[data-filter-layer][aria-selected="true"]')?.dataset.filterLayer || 'all';
        const personId = toolbar?.querySelector('input[name="personId"]')?.value || '';
        const channel = toolbar?.querySelector('input[name="channel"]')?.value || '';
        void dispatchAction('filter-memory', { layer: activeLayer, personId, channel }, actionBtn);
        return;
      }
      if (action === 'reset-memory-filter') {
        void dispatchAction('reset-memory-filter', {}, actionBtn);
        return;
      }
      if (action === 'load-next-page') {
        void dispatchAction('load-next-memory-page', {}, actionBtn);
        return;
      }
      if (action === 'select-record') {
        const recordId = actionBtn.dataset.recordId;
        if (recordId) void dispatchAction('select-record', { recordId }, actionBtn);
        return;
      }
      if (action === 'mark-outdated') {
        void dispatchAction('mark-outdated', {
          recordId: actionBtn.dataset.recordId,
          version: Number(actionBtn.dataset.version),
        }, actionBtn);
        return;
      }
      if (action === 'request-forget') {
        void dispatchAction('request-forget', { recordId: actionBtn.dataset.recordId }, actionBtn);
        return;
      }
      if (action === 'confirm-forget') {
        void dispatchAction('confirm-forget', {}, actionBtn);
        return;
      }
      if (action === 'cancel-forget') {
        void dispatchAction('cancel-forget', {}, actionBtn);
        return;
      }
      if (action === 'merge-person') {
        const panel = actionBtn.closest('.persons-panel');
        const from = panel?.querySelector('input[name="merge-from"]')?.value || '';
        const into = panel?.querySelector('input[name="merge-into"]')?.value || '';
        void dispatchAction('merge-person', { from, into }, actionBtn);
        return;
      }
      if (action === 'split-person') {
        const panel = actionBtn.closest('.persons-panel');
        const personId = panel?.querySelector('input[name="split-person-id"]')?.value || '';
        const accounts = panel?.querySelector('input[name="split-accounts"]')?.value || '';
        void dispatchAction('split-person', { personId, accounts }, actionBtn);
        return;
      }
      if (action === 'trigger-consolidation') {
        void dispatchAction('trigger-consolidation', {}, actionBtn);
        return;
      }
      if (action === 'choose-conflict-keep') {
        void dispatchAction('choose-conflict-keep', {
          conflictId: actionBtn.dataset.conflictId,
          keepRecordId: actionBtn.dataset.keepId,
        }, actionBtn);
        return;
      }
      if (action === 'approve-proposal') {
        void dispatchAction('approve-proposal', { proposalId: actionBtn.dataset.proposalId }, actionBtn);
        return;
      }
      if (action === 'reject-proposal') {
        void dispatchAction('reject-proposal', { proposalId: actionBtn.dataset.proposalId }, actionBtn);
        return;
      }
      if (action === 'compare-l3') {
        void dispatchAction('compare-l3', { version: Number(actionBtn.dataset.version) }, actionBtn);
        return;
      }
      if (action === 'rollback-l3') {
        void dispatchAction('rollback-l3', { version: Number(actionBtn.dataset.version) }, actionBtn);
        return;
      }
      if (action === 'restart') {
        void dispatchAction('restart-agent', { agentClass: actionBtn.dataset.agentClass }, actionBtn);
        return;
      }
      if (action === 'run-doctor') {
        void dispatchAction('run-doctor', {}, actionBtn);
        return;
      }
      if (action === 'toggle-amp') {
        void dispatchAction('toggle-amp', { enabled: actionBtn.dataset.enabled === 'true' }, actionBtn);
        return;
      }
      if (action === 'toggle-mcp') {
        void dispatchAction('toggle-mcp', { enabled: actionBtn.dataset.enabled === 'true' }, actionBtn);
        return;
      }
      if (action === 'start-debug-view' || action === 'stop-debug-view') {
        void dispatchAction(action, {}, actionBtn);
        return;
      }
      if (action === 'confirm-install' || action === 'cancel-install' || action === 'confirm-upgrade' || action === 'cancel-upgrade') {
        void dispatchAction(action, {}, actionBtn);
        return;
      }
      if (action === 'enable') {
        void dispatchAction('enable-plugin', { id: actionBtn.dataset.pluginId }, actionBtn);
        return;
      }
      if (action === 'disable') {
        void dispatchAction('disable-plugin', { id: actionBtn.dataset.pluginId }, actionBtn);
        return;
      }
      if (action === 'upgrade') {
        const pluginId = actionBtn.dataset.pluginId || '';
        const card = actionBtn.closest('article[data-plugin-id]');
        const inputEl = card?.querySelector('[data-upgrade-spec-for]');
        let spec = inputEl ? inputEl.value.trim() : '';
        if (!spec && typeof window.prompt === 'function') {
          spec = (window.prompt('请输入升级插件 spec：') || '').trim();
        }
        if (spec) void dispatchAction('start-upgrade', { id: pluginId, spec }, actionBtn);
        return;
      }
      if (action === 'uninstall-keep-data') {
        void dispatchAction('uninstall-plugin', { id: actionBtn.dataset.pluginId, keepData: true }, actionBtn);
        return;
      }
      if (action === 'uninstall-delete-data') {
        void dispatchAction('uninstall-plugin', { id: actionBtn.dataset.pluginId, keepData: false }, actionBtn);
        return;
      }
      if (action === 'chat-refresh') {
        void dispatchAction('chat-refresh', {}, actionBtn);
        return;
      }
      if (action === 'chat-switch-channel') {
        void dispatchAction('chat-switch-channel', { channel: actionBtn.dataset.channel }, actionBtn);
        return;
      }
      if (action === 'jump-to-memory-record') {
        void dispatchAction('jump-to-memory-record', { recordId: actionBtn.dataset.recordId }, actionBtn);
        return;
      }
    }

    const memoryCard = target.closest('.memory-item[data-record-id]');
    if (memoryCard && !target.closest('button, input, select, textarea, a')) {
      const recordId = memoryCard.dataset.recordId;
      if (recordId) void dispatchAction('select-record', { recordId }, null);
    }
  });

  document.addEventListener('submit', (event) => {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (!form || form.id === 'token-login-form') return;
    event.preventDefault();
    const submitBtn = form.querySelector('button[type="submit"]');

    if (form.classList.contains('secret-form')) {
      const name = form.querySelector('input[name="name"]')?.value || '';
      const value = form.querySelector('input[name="value"]')?.value || '';
      void dispatchAction('save-secret', { name, value }, submitBtn);
      return;
    }

    if (form.classList.contains('role-interview') || form.dataset.form === 'role-interview') {
      const name = form.querySelector('input[name="name"]')?.value || '';
      const summary = form.querySelector('input[name="summary"]')?.value || '';
      const tone = form.querySelector('input[name="tone"]')?.value || '';
      const traits = [];
      for (const row of form.querySelectorAll('.role-trait-row')) {
        const trait = row.querySelector('input[name="trait"]')?.value || '';
        const manifestation = row.querySelector('input[name="manifestation"]')?.value || '';
        if (trait.trim() !== '' || manifestation.trim() !== '') {
          traits.push({ trait, manifestation });
        }
      }
      void dispatchAction('save-role-interview', { interview: { name, summary, tone, traits } }, submitBtn);
      return;
    }

    if (form.dataset.form === 'role-raw') {
      const name = form.querySelector('input[name="name"]')?.value || '';
      const text = form.querySelector('textarea[name="text"]')?.value || '';
      void dispatchAction('save-role-raw', { name, text }, submitBtn);
      return;
    }

    if (form.classList.contains('search-form')) {
      const query = form.querySelector('input[name="query"]')?.value || '';
      void dispatchAction('search-memory', { query }, submitBtn);
      return;
    }

    if (form.dataset.action === 'save-owner-l3') {
      const stable = form.querySelector('textarea[name="stable"]')?.value || '';
      const dataJson = form.querySelector('textarea[name="dataJson"]')?.value || '{}';
      const lockedKeys = form.querySelector('input[name="lockedKeys"]')?.value || '';
      void dispatchAction('save-owner-l3', { stable, dataJson, lockedKeys }, submitBtn);
      return;
    }

    if (form.dataset.form === 'price-book') {
      const currency = form.querySelector('input[name="currency"]')?.value || 'CNY';
      const models = {};
      for (const row of form.querySelectorAll('.price-row[data-model-key]')) {
        const key = row.dataset.modelKey;
        if (!key) continue;
        models[key] = {
          inputPerMillion: row.querySelector('input[name="inputPerMillion"]')?.value || '0',
          outputPerMillion: row.querySelector('input[name="outputPerMillion"]')?.value || '0',
          cacheReadPerMillion: row.querySelector('input[name="cacheReadPerMillion"]')?.value || '0',
          cacheWritePerMillion: row.querySelector('input[name="cacheWritePerMillion"]')?.value || '0',
        };
      }
      void dispatchAction('save-price-book', { currency, models }, submitBtn);
      return;
    }

    if (form.dataset.form === 'budget-limits') {
      const dailyTokenLimit = form.querySelector('input[name="dailyTokenLimit"]')?.value || '';
      const dailyCostMicrosLimit = form.querySelector('input[name="dailyCostMicrosLimit"]')?.value || '';
      const pluginDailyTokenLimit = form.querySelector('input[name="pluginDailyTokenLimit"]')?.value || '';
      void dispatchAction('save-budget-limits', { dailyTokenLimit, dailyCostMicrosLimit, pluginDailyTokenLimit }, submitBtn);
      return;
    }

    if (form.dataset.form === 'plugin-install') {
      const spec = form.querySelector('input[name="spec"]')?.value || '';
      void dispatchAction('start-install', { spec }, submitBtn);
      return;
    }

    if (form.dataset.form === 'plugin-check') {
      const dir = form.querySelector('input[name="dir"]')?.value || '';
      void dispatchAction('run-check', { dir }, submitBtn);
      return;
    }

    if (form.dataset.form === 'plugin-chat-channel') {
      const channel = form.querySelector('input[name="channel"]')?.value || '';
      void dispatchAction('chat-switch-channel', { channel }, submitBtn);
      return;
    }

    if (form.dataset.form === 'plugin-chat-send') {
      const text = form.querySelector('input[name="text"]')?.value || '';
      const channel = form.querySelector('input[name="channel"]')?.value || '';
      void dispatchAction('chat-send', { text, channel }, submitBtn);
    }
  });
})();`
}
