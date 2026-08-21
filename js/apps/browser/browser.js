/**
 * browser.js —— 现代浏览器 APP
 * ---------------------------------------------------------
 * 功能：
 *   - 顶部地址栏（输入 URL 或搜索词）+ 加载状态
 *   - 底部导航栏：后退、前进、主页、标签页管理、书签
 *   - 多标签页：每个 tab 维护自己的历史栈（数组 + index）
 *   - 渲染机制：调用 render-engine.js 抓取解析页面，塞进 sandboxed iframe 展示
 *   - 历史记录、书签持久化到 IndexedDB
 */

import { DB, uuid } from '../../core/db.js';
import { fetchAndParsePage, looksLikeUrl } from './render-engine.js';

const HOME_URL = 'about:home';

export async function mount(container, ctx) {
  injectBrowserStyles();

  container.innerHTML = `
    <div class="app-root br-root">
      <div class="br-addr-bar">
        <button class="icon-btn br-tabs-btn">▭<span class="br-tab-count">1</span></button>
        <div class="br-addr-input-wrap">
          <input type="text" class="br-addr-input" placeholder="搜索或输入网址" autocomplete="off" autocapitalize="off" />
          <div class="br-loading-bar" hidden></div>
        </div>
        <button class="icon-btn br-bookmark-btn">☆</button>
      </div>
      <div class="br-content"></div>
      <div class="br-nav-bar">
        <button class="icon-btn br-back">‹</button>
        <button class="icon-btn br-forward">›</button>
        <button class="icon-btn br-home">⌂</button>
        <button class="icon-btn br-bookmarks-list">🔖</button>
        <button class="icon-btn br-history">🕘</button>
      </div>
    </div>
    <div class="br-panel" hidden></div>
    <div class="br-tab-switcher" hidden></div>
  `;

  const addrInput = container.querySelector('.br-addr-input');
  const content = container.querySelector('.br-content');
  const loadingBar = container.querySelector('.br-loading-bar');
  const panel = container.querySelector('.br-panel');
  const tabSwitcher = container.querySelector('.br-tab-switcher');
  const tabCountEl = container.querySelector('.br-tab-count');
  const bookmarkBtn = container.querySelector('.br-bookmark-btn');

  /** 标签页数据结构 */
  function createTab() {
    return { id: uuid(), history: [HOME_URL], index: 0, title: '主页' };
  }

  const state = {
    tabs: [createTab()],
    activeTabIndex: 0,
  };

  function activeTab() {
    return state.tabs[state.activeTabIndex];
  }

  function currentUrl() {
    const t = activeTab();
    return t.history[t.index];
  }

  // ================= 渲染当前页 =================
  async function renderCurrent(pushHistoryRow = true) {
    const url = currentUrl();
    addrInput.value = url === HOME_URL ? '' : url;
    updateNavButtons();

    if (url === HOME_URL) {
      renderHomePage();
      return;
    }

    loadingBar.hidden = false;
    content.innerHTML = `<div class="br-loading-placeholder">正在加载 ${escapeHtml(url)} …</div>`;

    try {
      const { title, html, finalUrl } = await fetchAndParsePage(url);
      activeTab().title = title;
      renderPageFrame(html, finalUrl);

      if (pushHistoryRow) {
        await DB.add('browser_history', { id: uuid(), url: finalUrl, title, visitedAt: Date.now() });
      }
    } catch (err) {
      content.innerHTML = `
        <div class="br-error">
          <div class="br-error-icon">⚠️</div>
          <div class="br-error-title">无法加载该页面</div>
          <div class="br-error-msg">${escapeHtml(err.message)}</div>
          <div class="br-error-hint">提示：本浏览器使用自研安全渲染引擎，通过公共 CORS 代理抓取页面，
          部分网站可能因反爬限制或代理服务不可用而无法访问。</div>
        </div>`;
    } finally {
      loadingBar.hidden = true;
    }
  }

  function renderPageFrame(html, baseUrl) {
    const iframe = document.createElement('iframe');
    // 关键安全约束：不含 allow-scripts，远程页面的任何脚本都已在解析阶段被剔除，
    // 此处即便被注入也无法执行，双重保险。
    iframe.setAttribute('sandbox', 'allow-same-origin');
    iframe.className = 'br-page-frame';
    const doc = `<!DOCTYPE html><html><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>
        body{font-family:-apple-system,'PingFang SC',sans-serif;font-size:15px;line-height:1.7;color:#1c1c1e;
          padding:16px;margin:0;word-break:break-word;}
        img{max-width:100%;height:auto;border-radius:8px;margin:6px 0;}
        a{color:#0a84ff;text-decoration:none;}
        h1,h2,h3{line-height:1.3;}
        blockquote{border-left:3px solid #ddd;margin:8px 0;padding:4px 12px;color:#666;}
        pre,code{background:#f5f5f7;border-radius:6px;padding:2px 6px;font-family:Menlo,Consolas,monospace;font-size:13px;}
        table{border-collapse:collapse;width:100%;} td,th{border:1px solid #eee;padding:6px;font-size:13px;}
      </style></head><body>${html || '<p style="color:#999">（该页面没有可提取的正文内容）</p>'}</body></html>`;
    iframe.srcdoc = doc;
    content.innerHTML = '';
    content.appendChild(iframe);

    // 拦截页面内链接点击，转交地址栏做应用内跳转（不能直接绑定到 iframe 内部 DOM，
    // 需等 iframe 加载完成后通过其自身 document 绑定，同源沙箱下允许访问）
    iframe.addEventListener('load', () => {
      try {
        const links = iframe.contentDocument.querySelectorAll('a[data-href]');
        links.forEach((a) => {
          a.addEventListener('click', (e) => {
            e.preventDefault();
            navigateTo(a.getAttribute('data-href'));
          });
        });
      } catch (e) {
        console.warn('[Browser] 绑定链接点击失败:', e);
      }
    });
  }

  function renderHomePage() {
    activeTab().title = '主页';
    content.innerHTML = `
      <div class="br-home">
        <div class="br-home-logo">🌐</div>
        <div class="br-home-hint">输入网址或关键词开始浏览</div>
        <div class="br-home-shortcuts">
          <button class="br-shortcut" data-url="https://www.wikipedia.org">Wikipedia</button>
          <button class="br-shortcut" data-url="https://example.com">Example</button>
          <button class="br-shortcut" data-url="https://www.bing.com/search?q=webos">Bing 搜索</button>
        </div>
      </div>`;
    content.querySelectorAll('.br-shortcut').forEach((btn) => {
      btn.addEventListener('click', () => navigateTo(btn.dataset.url));
    });
  }

  function updateNavButtons() {
    const t = activeTab();
    container.querySelector('.br-back').style.opacity = t.index > 0 ? '1' : '0.35';
    container.querySelector('.br-forward').style.opacity = t.index < t.history.length - 1 ? '1' : '0.35';
    bookmarkBtn.textContent = '☆'; // 实际状态在 checkBookmarked 中异步更新
    checkBookmarked();
  }

  async function checkBookmarked() {
    const url = currentUrl();
    if (url === HOME_URL) return;
    const all = await DB.getAll('browser_bookmarks');
    bookmarkBtn.textContent = all.some((b) => b.url === url) ? '★' : '☆';
  }

  // ================= 导航操作 =================
  function navigateTo(url) {
    const t = activeTab();
    t.history = t.history.slice(0, t.index + 1);
    t.history.push(url);
    t.index = t.history.length - 1;
    renderCurrent();
  }

  addrInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const raw = addrInput.value.trim();
    if (!raw) return;
    const target = looksLikeUrl(raw) ? raw : `https://www.bing.com/search?q=${encodeURIComponent(raw)}`;
    navigateTo(target);
    addrInput.blur();
  });

  container.querySelector('.br-back').addEventListener('click', () => {
    const t = activeTab();
    if (t.index > 0) {
      t.index--;
      renderCurrent(false);
    }
  });
  container.querySelector('.br-forward').addEventListener('click', () => {
    const t = activeTab();
    if (t.index < t.history.length - 1) {
      t.index++;
      renderCurrent(false);
    }
  });
  container.querySelector('.br-home').addEventListener('click', () => navigateTo(HOME_URL));

  // ================= 书签 =================
  bookmarkBtn.addEventListener('click', async () => {
    const url = currentUrl();
    if (url === HOME_URL) return;
    const all = await DB.getAll('browser_bookmarks');
    const existing = all.find((b) => b.url === url);
    if (existing) {
      await DB.delete('browser_bookmarks', existing.id);
      bookmarkBtn.textContent = '☆';
      toast('已取消收藏');
    } else {
      await DB.add('browser_bookmarks', { id: uuid(), url, title: activeTab().title, createdAt: Date.now() });
      bookmarkBtn.textContent = '★';
      toast('已添加书签');
    }
  });

  container.querySelector('.br-bookmarks-list').addEventListener('click', () => showPanel('bookmarks'));
  container.querySelector('.br-history').addEventListener('click', () => showPanel('history'));

  async function showPanel(kind) {
    panel.hidden = false;
    if (kind === 'bookmarks') {
      const rows = (await DB.getAll('browser_bookmarks')).sort((a, b) => b.createdAt - a.createdAt);
      panel.innerHTML = buildPanelHtml('书签', rows, true);
    } else {
      const rows = (await DB.getAll('browser_history')).sort((a, b) => b.visitedAt - a.visitedAt).slice(0, 100);
      panel.innerHTML = buildPanelHtml('历史记录', rows, false);
    }
    panel.querySelector('.br-panel-close').addEventListener('click', () => (panel.hidden = true));
    panel.querySelectorAll('.br-panel-item').forEach((item) => {
      item.addEventListener('click', () => {
        panel.hidden = true;
        navigateTo(item.dataset.url);
      });
    });
    const clearBtn = panel.querySelector('.br-panel-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        await DB.clear(kind === 'bookmarks' ? 'browser_bookmarks' : 'browser_history');
        showPanel(kind);
      });
    }
  }

  function buildPanelHtml(title, rows, isBookmark) {
    const listHtml = rows.length
      ? rows
          .map(
            (r) => `
        <div class="list-item br-panel-item" data-url="${escapeAttr(r.url)}">
          <span class="br-panel-item-icon">${isBookmark ? '🔖' : '🕘'}</span>
          <div class="br-panel-item-text">
            <div class="br-panel-item-title">${escapeHtml(r.title || r.url)}</div>
            <div class="br-panel-item-url">${escapeHtml(r.url)}</div>
          </div>
        </div>`
          )
          .join('')
      : `<div class="empty-state"><div class="empty-state-icon">📭</div><div>暂无记录</div></div>`;

    return `
      <div class="br-panel-header">
        <button class="icon-btn br-panel-close">✕</button>
        <span class="toolbar-title">${title}</span>
        <button class="br-panel-clear icon-btn" title="清空">🗑️</button>
      </div>
      <div class="br-panel-list">${listHtml}</div>
    `;
  }

  // ================= 标签页管理 =================
  container.querySelector('.br-tabs-btn').addEventListener('click', () => showTabSwitcher());

  function showTabSwitcher() {
    tabSwitcher.hidden = false;
    tabSwitcher.innerHTML = `
      <div class="br-tabswitch-header">
        <span class="toolbar-title">标签页</span>
        <button class="btn br-new-tab">＋ 新标签页</button>
      </div>
      <div class="br-tabswitch-list"></div>
      <button class="icon-btn br-tabswitch-close">完成</button>
    `;
    const list = tabSwitcher.querySelector('.br-tabswitch-list');
    state.tabs.forEach((t, i) => {
      const card = document.createElement('div');
      card.className = 'br-tab-card' + (i === state.activeTabIndex ? ' active' : '');
      card.innerHTML = `<span>${escapeHtml(t.title || '新标签页')}</span><button class="br-tab-close">✕</button>`;
      card.addEventListener('click', (e) => {
        if (e.target.classList.contains('br-tab-close')) return;
        state.activeTabIndex = i;
        tabSwitcher.hidden = true;
        renderCurrent(false);
      });
      card.querySelector('.br-tab-close').addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.tabs.length === 1) {
          toast('至少保留一个标签页');
          return;
        }
        state.tabs.splice(i, 1);
        if (state.activeTabIndex >= state.tabs.length) state.activeTabIndex = state.tabs.length - 1;
        showTabSwitcher();
        renderCurrent(false);
        updateTabCount();
      });
      list.appendChild(card);
    });

    tabSwitcher.querySelector('.br-new-tab').addEventListener('click', () => {
      state.tabs.push(createTab());
      state.activeTabIndex = state.tabs.length - 1;
      tabSwitcher.hidden = true;
      renderCurrent(false);
      updateTabCount();
    });
    tabSwitcher.querySelector('.br-tabswitch-close').addEventListener('click', () => (tabSwitcher.hidden = true));
  }

  function updateTabCount() {
    tabCountEl.textContent = String(state.tabs.length);
  }

  function toast(msg) {
    document.dispatchEvent(new CustomEvent('webos:toast', { detail: { message: msg } }));
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function escapeAttr(s) {
    return escapeHtml(s);
  }

  await renderCurrent(false);
  updateTabCount();

  return () => {
    // 浏览器 APP 无需释放特殊硬件资源，iframe 会随 DOM 移除自动清理
  };
}

function injectBrowserStyles() {
  if (document.getElementById('browser-styles')) return;
  const style = document.createElement('style');
  style.id = 'browser-styles';
  style.textContent = `
    .br-root { display:flex; flex-direction:column; height:100%; background:#fff; }
    .br-addr-bar { display:flex; align-items:center; gap:8px; padding:8px 10px; border-bottom:1px solid #eee; flex-shrink:0; }
    .br-tabs-btn { position:relative; font-size:16px; }
    .br-tab-count { position:absolute; top:2px; right:2px; background:#0a84ff; color:#fff; font-size:9px;
      width:14px; height:14px; border-radius:50%; display:flex; align-items:center; justify-content:center; }
    .br-addr-input-wrap { flex:1; position:relative; }
    .br-addr-input { width:100%; padding:8px 12px; border-radius:10px; background:#f0f0f2; border:none; font-size:14px; }
    .br-loading-bar { position:absolute; bottom:-8px; left:6%; right:6%; height:2px; background:#0a84ff; border-radius:2px;
      animation: br-loading 1s ease-in-out infinite; }
    @keyframes br-loading { 0%{transform:scaleX(.1);opacity:1;} 100%{transform:scaleX(1);opacity:0;} }
    .br-content { flex:1; overflow:hidden; position:relative; background:#fff; min-height:0; }
    .br-page-frame { width:100%; height:100%; border:none; }
    .br-loading-placeholder { padding:40px 20px; text-align:center; color:#999; font-size:13px; }
    .br-error { padding:60px 24px; text-align:center; }
    .br-error-icon { font-size:40px; margin-bottom:10px; }
    .br-error-title { font-size:16px; font-weight:700; margin-bottom:6px; }
    .br-error-msg { font-size:13px; color:#c00; margin-bottom:14px; }
    .br-error-hint { font-size:12px; color:#999; line-height:1.6; }
    .br-home { display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; gap:14px; }
    .br-home-logo { font-size:56px; }
    .br-home-hint { color:#999; font-size:13px; }
    .br-home-shortcuts { display:flex; gap:10px; flex-wrap:wrap; justify-content:center; padding:0 20px; }
    .br-shortcut { padding:8px 16px; border-radius:16px; background:#f0f0f2; font-size:13px; }
    .br-nav-bar { display:flex; justify-content:space-around; align-items:center; padding:8px 10px calc(10px + env(safe-area-inset-bottom,0px));
      border-top:1px solid #eee; flex-shrink:0; }
    .br-nav-bar .icon-btn { font-size:20px; }
    .br-panel { position:absolute; inset:0; background:#fff; z-index:12; display:flex; flex-direction:column; }
    .br-panel-header { display:flex; align-items:center; justify-content:space-between; padding:12px 14px; border-bottom:1px solid #eee; }
    .br-panel-list { flex:1; overflow-y:auto; }
    .br-panel-item-text { flex:1; overflow:hidden; }
    .br-panel-item-title { font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .br-panel-item-url { font-size:11px; color:#999; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .br-tab-switcher { position:absolute; inset:0; background:#f2f2f7; z-index:13; display:flex; flex-direction:column; }
    .br-tabswitch-header { display:flex; align-items:center; justify-content:space-between; padding:14px; }
    .br-tabswitch-list { flex:1; overflow-y:auto; padding:0 14px; display:flex; flex-direction:column; gap:8px; }
    .br-tab-card { display:flex; align-items:center; justify-content:space-between; background:#fff; padding:14px;
      border-radius:12px; font-size:14px; border:2px solid transparent; }
    .br-tab-card.active { border-color:#0a84ff; }
    .br-tab-close { color:#999; font-size:16px; }
    .br-tabswitch-close { align-self:center; margin:14px 0 calc(14px + env(safe-area-inset-bottom,0px)); color:#0a84ff; font-weight:600; }
  `;
  document.head.appendChild(style);
}
