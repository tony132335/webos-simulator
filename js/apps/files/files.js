/**
 * files.js —— 档案/文件管理器 APP
 * ---------------------------------------------------------
 * 功能：
 *   - 列表视图浏览 VFS（vfs.js）目录树，面包屑导航
 *   - 新建文件夹、重命名、删除（含"非空目录需确认递归删除"）
 *   - 文件详情：路径、大小、属主/属组、权限位（rwxr-xr-x 可视化，并支持 chmod）
 *   - 从设备导入文件（<input type="file"> 多选）到当前目录
 *   - 长按进入多选模式，可批量删除
 *
 * 权限管理 UI 说明：
 *   每个节点的权限用 3 组 rwx 复选框（属主/属组/其他）可视化展示与编辑，
 *   点击保存后调用 VFS.chmod()，若当前用户不是属主则后端会抛出 EACCES，
 *   前端捕获后给出清晰的错误提示，体现真实的权限校验流程。
 */

import { VFS, VFSError, modeToString, CURRENT_UID, CURRENT_GID } from '../../core/vfs.js';

export async function mount(container, ctx) {
  injectFilesStyles();

  container.innerHTML = `
    <div class="app-root fl-root">
      <div class="toolbar">
        <button class="icon-btn fl-up" title="返回上级">⬆️</button>
        <span class="toolbar-title fl-breadcrumb">/</span>
        <div class="fl-toolbar-actions">
          <button class="icon-btn fl-import" title="导入文件">📥</button>
          <button class="icon-btn fl-new-folder" title="新建文件夹">📁+</button>
        </div>
      </div>
      <div class="fl-list"></div>
      <input type="file" class="fl-file-input" multiple hidden />
    </div>
    <div class="fl-detail-panel" hidden></div>
  `;

  const listEl = container.querySelector('.fl-list');
  const breadcrumbEl = container.querySelector('.fl-breadcrumb');
  const fileInput = container.querySelector('.fl-file-input');
  const detailPanel = container.querySelector('.fl-detail-panel');

  const state = { currentPath: '/storage' };

  async function render() {
    breadcrumbEl.textContent = state.currentPath;
    listEl.innerHTML = '';
    let children;
    try {
      children = await VFS.list(state.currentPath);
    } catch (err) {
      listEl.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🚫</div><div>${escapeHtml(errMsg(err))}</div></div>`;
      return;
    }

    if (children.length === 0) {
      listEl.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📂</div><div>此文件夹为空</div></div>`;
      return;
    }

    children.forEach((node) => {
      const row = document.createElement('div');
      row.className = 'list-item fl-item';
      row.dataset.path = node.path;
      const icon = node.type === 'dir' ? '📁' : iconForFile(node);
      row.innerHTML = `
        <span class="fl-item-icon">${icon}</span>
        <div class="fl-item-info">
          <div class="fl-item-name">${escapeHtml(node.name)}</div>
          <div class="fl-item-meta">
            <span class="perm-tag">${modeToString(node.mode, node.type)}</span>
            <span class="fl-item-owner">${node.owner}:${node.group}</span>
            ${node.type === 'file' ? `<span class="fl-item-size">${formatSize(node.size)}</span>` : ''}
          </div>
        </div>
        <span class="fl-item-chevron">›</span>
      `;
      row.addEventListener('click', () => {
        if (node.type === 'dir') {
          state.currentPath = node.path;
          render();
        } else {
          openDetail(node);
        }
      });

      // 长按呼出详情/操作菜单（对文件夹也适用，便于重命名/删除/权限修改）
      let pressTimer = null;
      row.addEventListener(
        'touchstart',
        () => {
          pressTimer = setTimeout(() => openDetail(node), 480);
        },
        { passive: true }
      );
      row.addEventListener('touchend', () => clearTimeout(pressTimer));
      row.addEventListener('touchmove', () => clearTimeout(pressTimer));

      listEl.appendChild(row);
    });
  }

  function iconForFile(node) {
    if (node.mime && node.mime.startsWith('image/')) return '🖼️';
    if (node.mime === 'application/x-webos-photo-ref') return '📸';
    if (node.mime === 'text/markdown') return '📝';
    if (node.mime === 'application/json') return '🧾';
    return '📄';
  }

  function formatSize(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0,
      v = bytes;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
  }

  function errMsg(err) {
    if (err instanceof VFSError) {
      const map = { ENOENT: '路径不存在', EACCES: '权限不足', ENOTDIR: '不是目录', EISDIR: '是目录而非文件', EEXIST: '已存在同名项', ENOTEMPTY: '目录非空' };
      return map[err.code] || err.message;
    }
    return err.message;
  }

  // ================= 返回上级 =================
  container.querySelector('.fl-up').addEventListener('click', () => {
    if (state.currentPath === '/') return;
    const idx = state.currentPath.lastIndexOf('/');
    state.currentPath = idx <= 0 ? '/' : state.currentPath.slice(0, idx);
    render();
  });

  // ================= 新建文件夹 =================
  container.querySelector('.fl-new-folder').addEventListener('click', async () => {
    const name = prompt('新建文件夹名称：');
    if (!name) return;
    try {
      await VFS.mkdir(`${state.currentPath === '/' ? '' : state.currentPath}/${name}`);
      render();
    } catch (err) {
      alert(errMsg(err));
    }
  });

  // ================= 导入文件 =================
  container.querySelector('.fl-import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    for (const f of files) {
      try {
        await VFS.importFile(state.currentPath, f);
      } catch (err) {
        alert(`导入 "${f.name}" 失败：${errMsg(err)}`);
      }
    }
    fileInput.value = '';
    render();
    if (files.length) toast(`已导入 ${files.length} 个文件`);
  });

  // ================= 详情 / 权限管理 面板 =================
  function openDetail(node) {
    detailPanel.hidden = false;
    const bits = [(node.mode >> 6) & 7, (node.mode >> 3) & 7, node.mode & 7];
    const segLabels = ['属主 (Owner)', '属组 (Group)', '其他 (Other)'];

    detailPanel.innerHTML = `
      <div class="fl-detail-header">
        <button class="icon-btn fl-detail-close">✕</button>
        <span class="toolbar-title">属性</span>
        <span style="width:36px"></span>
      </div>
      <div class="fl-detail-body">
        <div class="fl-detail-icon">${node.type === 'dir' ? '📁' : iconForFile(node)}</div>
        <div class="fl-detail-name">${escapeHtml(node.name)}</div>
        <div class="fl-detail-row"><span>路径</span><span class="fl-detail-value">${escapeHtml(node.path)}</span></div>
        <div class="fl-detail-row"><span>类型</span><span class="fl-detail-value">${node.type === 'dir' ? '文件夹' : node.mime || '未知'}</span></div>
        ${node.type === 'file' ? `<div class="fl-detail-row"><span>大小</span><span class="fl-detail-value">${formatSize(node.size)}</span></div>` : ''}
        <div class="fl-detail-row"><span>属主</span><span class="fl-detail-value">${node.owner}</span></div>
        <div class="fl-detail-row"><span>属组</span><span class="fl-detail-value">${node.group}</span></div>
        <div class="fl-detail-row"><span>修改时间</span><span class="fl-detail-value">${new Date(node.modifiedAt).toLocaleString()}</span></div>

        <div class="fl-perm-title">权限管理（chmod）</div>
        <div class="fl-perm-grid">
          ${segLabels
            .map(
              (label, i) => `
            <div class="fl-perm-seg">
              <div class="fl-perm-seg-label">${label}</div>
              <label><input type="checkbox" class="fl-perm-cb" data-seg="${i}" data-bit="4" ${bits[i] & 4 ? 'checked' : ''}/> 读(r)</label>
              <label><input type="checkbox" class="fl-perm-cb" data-seg="${i}" data-bit="2" ${bits[i] & 2 ? 'checked' : ''}/> 写(w)</label>
              <label><input type="checkbox" class="fl-perm-cb" data-seg="${i}" data-bit="1" ${bits[i] & 1 ? 'checked' : ''}/> 执行(x)</label>
            </div>`
            )
            .join('')}
        </div>
        <div class="fl-perm-preview">当前：<span class="perm-tag fl-perm-preview-text">${modeToString(node.mode, node.type)}</span></div>
        ${
          node.owner !== CURRENT_UID
            ? `<div class="fl-perm-hint">⚠️ 当前用户(${CURRENT_UID})不是该节点属主(${node.owner})，无法修改权限（只读展示）</div>`
            : ''
        }

        <div class="fl-detail-actions">
          <button class="btn btn-secondary fl-rename">重命名</button>
          <button class="btn ${node.owner === CURRENT_UID ? '' : 'btn-secondary'} fl-chmod-save" ${node.owner !== CURRENT_UID ? 'disabled' : ''}>保存权限</button>
          <button class="btn btn-danger fl-delete" ${node.owner === 'system' ? 'disabled' : ''}>删除</button>
        </div>
      </div>
    `;

    detailPanel.querySelector('.fl-detail-close').addEventListener('click', () => (detailPanel.hidden = true));

    // 复选框联动预览
    detailPanel.querySelectorAll('.fl-perm-cb').forEach((cb) => {
      cb.addEventListener('change', () => {
        const newBits = [0, 1, 2].map((seg) => {
          let v = 0;
          detailPanel.querySelectorAll(`.fl-perm-cb[data-seg="${seg}"]`).forEach((c) => {
            if (c.checked) v |= Number(c.dataset.bit);
          });
          return v;
        });
        const newMode = (newBits[0] << 6) | (newBits[1] << 3) | newBits[2];
        detailPanel.querySelector('.fl-perm-preview-text').textContent = modeToString(newMode, node.type);
      });
    });

    detailPanel.querySelector('.fl-chmod-save').addEventListener('click', async () => {
      const newBits = [0, 1, 2].map((seg) => {
        let v = 0;
        detailPanel.querySelectorAll(`.fl-perm-cb[data-seg="${seg}"]`).forEach((c) => {
          if (c.checked) v |= Number(c.dataset.bit);
        });
        return v;
      });
      const newMode = (newBits[0] << 6) | (newBits[1] << 3) | newBits[2];
      try {
        await VFS.chmod(node.path, newMode);
        toast('权限已更新');
        detailPanel.hidden = true;
        render();
      } catch (err) {
        alert(errMsg(err));
      }
    });

    detailPanel.querySelector('.fl-rename').addEventListener('click', async () => {
      const newName = prompt('新名称：', node.name);
      if (!newName || newName === node.name) return;
      try {
        await VFS.rename(node.path, newName);
        detailPanel.hidden = true;
        render();
      } catch (err) {
        alert(errMsg(err));
      }
    });

    detailPanel.querySelector('.fl-delete').addEventListener('click', async () => {
      const isDir = node.type === 'dir';
      let force = false;
      if (isDir) {
        const children = await VFS.list(node.path).catch(() => []);
        if (children.length > 0) {
          if (!confirm(`「${node.name}」不是空文件夹，确定要递归删除其中所有内容吗？`)) return;
          force = true;
        } else if (!confirm(`确定删除「${node.name}」吗？`)) return;
      } else if (!confirm(`确定删除「${node.name}」吗？`)) {
        return;
      }
      try {
        await VFS.remove(node.path, { force });
        detailPanel.hidden = true;
        render();
        toast('已删除');
      } catch (err) {
        alert(errMsg(err));
      }
    });
  }

  function toast(msg) {
    document.dispatchEvent(new CustomEvent('webos:toast', { detail: { message: msg } }));
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  await render();

  return () => {};
}

function injectFilesStyles() {
  if (document.getElementById('files-styles')) return;
  const style = document.createElement('style');
  style.id = 'files-styles';
  style.textContent = `
    .fl-root { display:flex; flex-direction:column; height:100%; }
    .fl-toolbar-actions { display:flex; gap:4px; }
    .fl-breadcrumb { flex:1; text-align:center; font-size:13px; font-family: Menlo, Consolas, monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .fl-list { flex:1; overflow-y:auto; background:#fff; }
    .fl-item-icon { font-size:22px; width:30px; text-align:center; flex-shrink:0; }
    .fl-item-info { flex:1; overflow:hidden; }
    .fl-item-name { font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .fl-item-meta { display:flex; align-items:center; gap:6px; margin-top:3px; }
    .fl-item-owner, .fl-item-size { font-size:11px; color:#999; }
    .fl-item-chevron { color:#c7c7cc; font-size:16px; }

    .fl-detail-panel { position:absolute; inset:0; background:#f2f2f7; z-index:14; display:flex; flex-direction:column; }
    .fl-detail-header { display:flex; align-items:center; justify-content:space-between; padding:12px 14px; background:#fff; border-bottom:1px solid #eee; }
    .fl-detail-body { flex:1; overflow-y:auto; padding:18px; }
    .fl-detail-icon { font-size:48px; text-align:center; }
    .fl-detail-name { text-align:center; font-size:16px; font-weight:700; margin: 6px 0 16px; word-break:break-all; }
    .fl-detail-row { display:flex; justify-content:space-between; padding:9px 0; border-bottom:1px solid #e5e5ea; font-size:13px; }
    .fl-detail-row > span:first-child { color:#666; }
    .fl-detail-value { max-width:60%; text-align:right; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .fl-perm-title { font-size:13px; font-weight:700; margin: 20px 0 8px; }
    .fl-perm-grid { display:flex; flex-direction:column; gap:10px; background:#fff; border-radius:12px; padding:12px; }
    .fl-perm-seg-label { font-size:12px; font-weight:600; margin-bottom:4px; }
    .fl-perm-seg label { display:inline-flex; align-items:center; gap:4px; font-size:12px; margin-right:14px; color:#444; }
    .fl-perm-preview { margin-top:10px; font-size:13px; }
    .fl-perm-hint { margin-top:10px; font-size:12px; color:#c00; background:#fff0ee; padding:8px 10px; border-radius:8px; }
    .fl-detail-actions { display:flex; gap:8px; margin-top:22px; }
    .fl-detail-actions .btn { flex:1; padding:10px 6px; font-size:13px; }
  `;
  document.head.appendChild(style);
}
