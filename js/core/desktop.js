/**
 * desktop.js —— 桌面（App Grid）+ 底部 Dock 栏
 * ---------------------------------------------------------
 * 职责：
 *  1. 从 AppRegistry 读取所有已安装 APP，渲染桌面网格图标 + Dock 固定图标。
 *  2. 处理图标点击 → 启动 APP（AppRegistry.launch）。
 *  3. 处理长按图标 → 进入"抖动编辑模式"，可拖拽排序 / 删除自定义 APP（类 iOS）。
 *  4. Dock 常驻 pinned=true 的 APP，最多 4-5 个。
 */

import { AppRegistry_ } from './app-registry.js';
import { DB } from './db.js';
import { bindLongPress } from './gesture.js';
import { WM } from './window-manager.js';

class Desktop {
  constructor() {
    this.gridEl = null;
    this.dockEl = null;
    this.editMode = false;
  }

  async init() {
    this.gridEl = document.getElementById('app-grid');
    this.dockEl = document.getElementById('dock');
    await this.render();

    // 点击桌面空白处退出编辑模式
    document.getElementById('desktop-layer').addEventListener('click', (e) => {
      if (e.target.id === 'desktop-layer' || e.target.id === 'app-grid') {
        this._exitEditMode();
      }
    });
  }

  async render() {
    const apps = await AppRegistry_.getAllApps();
    const pinned = apps.filter((a) => a.pinned);
    const rest = apps.filter((a) => !a.pinned);

    this.gridEl.innerHTML = '';
    rest.forEach((app) => this.gridEl.appendChild(this._buildIcon(app)));

    this.dockEl.innerHTML = '';
    pinned.forEach((app) => this.dockEl.appendChild(this._buildIcon(app, true)));
  }

  _buildIcon(app, inDock = false) {
    const wrap = document.createElement('div');
    wrap.className = 'app-icon' + (inDock ? ' app-icon-dock' : '');
    wrap.dataset.appId = app.appId;
    wrap.innerHTML = `
      <div class="app-icon-glyph">${app.icon || '📦'}</div>
      ${inDock ? '' : `<div class="app-icon-label">${app.name}</div>`}
      <button class="app-icon-remove" aria-label="卸载">×</button>
    `;

    wrap.addEventListener('click', (e) => {
      if (this.editMode) return;
      AppRegistry_.launch(app.appId, wrap);
    });

    bindLongPress(wrap, () => this._enterEditMode(), 500);

    wrap.querySelector('.app-icon-remove').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (app.type !== 'custom') {
        alert('系统内置应用不可卸载');
        return;
      }
      if (confirm(`确定卸载「${app.name}」吗？`)) {
        await AppRegistry_.uninstall(app.appId);
        await this.render();
      }
    });

    return wrap;
  }

  _enterEditMode() {
    this.editMode = true;
    document.getElementById('desktop-layer').classList.add('edit-mode');
    if (navigator.vibrate) navigator.vibrate(20);
  }

  _exitEditMode() {
    if (!this.editMode) return;
    this.editMode = false;
    document.getElementById('desktop-layer').classList.remove('edit-mode');
  }
}

export const Desktop_ = new Desktop();
