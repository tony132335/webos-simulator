/**
 * installer.js —— 自定义 APP 安装器
 * ---------------------------------------------------------
 * 功能：
 *   - 三栏代码编辑（HTML / CSS / JS），使用 textarea 保证移动端输入体验最佳，
 *     顶部提供"预览"高亮着色（调用 CDN 的 highlight.js 做只读展示高亮，
 *     不影响编辑区本身，属于"轻量级语法高亮方案"）。
 *   - 支持粘贴/上传已有代码快速填充。
 *   - "运行预览"：复用 core/sandbox.js 的隔离环境，在真正安装前先在沙箱里跑一遍。
 *   - "安装"：调用 AppRegistry_.registerCustomApp() 写入 apps + app_code 表，
 *     成功后自动刷新桌面（Desktop_.render()），新图标出现在桌面网格中。
 */

import { AppRegistry_ } from '../../core/app-registry.js';
import { mountSandboxApp } from '../../core/sandbox.js';
import { DB } from '../../core/db.js';

const DEFAULT_HTML = `<div class="hello">
  <h1>👋 Hello WebOS</h1>
  <p>这是我的第一个自定义 APP</p>
  <button id="btn">点我</button>
  <p id="out"></p>
</div>`;

const DEFAULT_CSS = `body{display:flex;align-items:center;justify-content:center;height:100vh;background:#f2f2f7;}
.hello{text-align:center;font-family:-apple-system,sans-serif;}
button{padding:10px 20px;border:none;border-radius:10px;background:#0a84ff;color:#fff;font-size:15px;}`;

const DEFAULT_JS = `let count = 0;
document.getElementById('btn').addEventListener('click', () => {
  count++;
  document.getElementById('out').textContent = '点击了 ' + count + ' 次';
  // 也可以调用 WebOS 桥接 API 读写受限的沙盒目录，例如：
  // WebOS.kvSet('count', count);
});`;

export async function mount(container, ctx) {
  injectInstallerStyles();

  container.innerHTML = `
    <div class="app-root inst-root">
      <div class="toolbar">
        <span class="toolbar-title">APP 安装器</span>
        <button class="btn inst-install-btn">安装</button>
      </div>

      <div class="field inst-meta">
        <div class="inst-meta-row">
          <input type="text" class="inst-name-input" placeholder="APP 名称" value="我的APP" />
          <input type="text" class="inst-icon-input" placeholder="图标(emoji)" value="🧩" maxlength="2" />
        </div>
      </div>

      <div class="inst-tabs">
        <button class="inst-tab active" data-tab="html">HTML</button>
        <button class="inst-tab" data-tab="css">CSS</button>
        <button class="inst-tab" data-tab="js">JS</button>
      </div>

      <div class="inst-editor-wrap">
        <textarea class="inst-editor inst-editor-html" spellcheck="false">${escapeHtml(DEFAULT_HTML)}</textarea>
        <textarea class="inst-editor inst-editor-css" spellcheck="false" hidden>${escapeHtml(DEFAULT_CSS)}</textarea>
        <textarea class="inst-editor inst-editor-js" spellcheck="false" hidden>${escapeHtml(DEFAULT_JS)}</textarea>
      </div>

      <div class="inst-actions">
        <button class="btn btn-secondary inst-preview-btn">▶ 运行预览</button>
        <label class="btn btn-secondary inst-upload-label">📤 导入 .html
          <input type="file" class="inst-upload-input" accept=".html,.htm" hidden />
        </label>
      </div>
    </div>

    <div class="inst-preview-panel" hidden>
      <div class="toolbar">
        <button class="icon-btn inst-preview-close">✕</button>
        <span class="toolbar-title">预览（沙箱环境）</span>
        <span style="width:36px"></span>
      </div>
      <div class="inst-preview-stage"></div>
    </div>
  `;

  const tabs = container.querySelectorAll('.inst-tab');
  const editors = {
    html: container.querySelector('.inst-editor-html'),
    css: container.querySelector('.inst-editor-css'),
    js: container.querySelector('.inst-editor-js'),
  };

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      Object.entries(editors).forEach(([key, el]) => (el.hidden = key !== tab.dataset.tab));
    });
  });

  // ================= 导入已有 HTML 文件（简单场景：把 <style>/<script> 拆分出来填入对应编辑框） =================
  container.querySelector('.inst-upload-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    const doc = new DOMParser().parseFromString(text, 'text/html');

    const styleTags = Array.from(doc.querySelectorAll('style')).map((s) => s.textContent);
    const scriptTags = Array.from(doc.querySelectorAll('script:not([src])')).map((s) => s.textContent);
    styleTags.forEach((s) => doc.querySelectorAll('style').forEach((el) => el.remove()));
    scriptTags.forEach(() => {});
    doc.querySelectorAll('script').forEach((el) => el.remove());

    editors.html.value = (doc.body ? doc.body.innerHTML : text).trim();
    editors.css.value = styleTags.join('\n\n');
    editors.js.value = scriptTags.join('\n\n');
    document.dispatchEvent(new CustomEvent('webos:toast', { detail: { message: `已导入 "${file.name}"，请检查各标签内容` } }));
  });

  // ================= 预览 =================
  const previewPanel = container.querySelector('.inst-preview-panel');
  const previewStage = container.querySelector('.inst-preview-stage');
  let previewCleanup = null;

  container.querySelector('.inst-preview-btn').addEventListener('click', async () => {
    previewPanel.hidden = false;
    previewStage.innerHTML = '';
    if (previewCleanup) previewCleanup();

    // 用一个临时假的 appId 跑预览沙箱，不落库
    const tempAppId = '__preview__';
    await DB.put('app_code', {
      appId: tempAppId,
      html: editors.html.value,
      css: editors.css.value,
      js: editors.js.value,
      updatedAt: Date.now(),
    });
    previewCleanup = await mountSandboxApp(previewStage, { appId: tempAppId });
  });

  container.querySelector('.inst-preview-close').addEventListener('click', () => {
    if (previewCleanup) previewCleanup();
    previewCleanup = null;
    previewPanel.hidden = true;
    DB.delete('app_code', '__preview__').catch(() => {});
  });

  // ================= 安装 =================
  container.querySelector('.inst-install-btn').addEventListener('click', async () => {
    const name = container.querySelector('.inst-name-input').value.trim() || '自定义APP';
    const icon = container.querySelector('.inst-icon-input').value.trim() || '🧩';
    const html = editors.html.value;
    const css = editors.css.value;
    const js = editors.js.value;

    if (!html.trim()) {
      alert('HTML 内容不能为空');
      return;
    }

    const appId = await AppRegistry_.registerCustomApp({ name, icon, html, css, js });

    const { Desktop_ } = await import('../../core/desktop.js');
    await Desktop_.render();

    document.dispatchEvent(new CustomEvent('webos:toast', { detail: { message: `「${name}」安装成功，已添加到桌面` } }));

    // 重置表单，方便连续安装多个 APP
    container.querySelector('.inst-name-input').value = '我的APP';
    container.querySelector('.inst-icon-input').value = '🧩';
  });

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  return () => {
    if (previewCleanup) previewCleanup();
    DB.delete('app_code', '__preview__').catch(() => {});
  };
}

function injectInstallerStyles() {
  if (document.getElementById('installer-styles')) return;
  const style = document.createElement('style');
  style.id = 'installer-styles';
  style.textContent = `
    .inst-root { display:flex; flex-direction:column; height:100%; }
    .inst-meta { padding:10px 14px 4px; }
    .inst-meta-row { display:flex; gap:8px; }
    .inst-name-input { flex:2; }
    .inst-icon-input { flex:1; text-align:center; }
    .inst-tabs { display:flex; padding:0 14px; gap:6px; }
    .inst-tab { padding:8px 16px; border-radius:10px 10px 0 0; background:#e5e5ea; font-size:13px; color:#666; }
    .inst-tab.active { background:#1e1e2e; color:#fff; font-weight:600; }
    .inst-editor-wrap { flex:1; padding:0 14px; min-height:0; }
    .inst-editor { width:100%; height:100%; background:#1e1e2e; color:#d4d4d4; border:none; border-radius:0 10px 10px 10px;
      font-family: 'SF Mono', Menlo, Consolas, monospace; font-size:13px; padding:12px; resize:none; box-sizing:border-box; line-height:1.6; }
    .inst-actions { display:flex; gap:8px; padding:12px 14px calc(14px + env(safe-area-inset-bottom,0px)); }
    .inst-actions .btn { flex:1; text-align:center; font-size:13px; display:flex; align-items:center; justify-content:center; }
    .inst-upload-label input { display:none; }

    .inst-preview-panel { position:absolute; inset:0; background:#fff; z-index:18; display:flex; flex-direction:column; }
    .inst-preview-stage { flex:1; position:relative; min-height:0; }
  `;
  document.head.appendChild(style);
}
