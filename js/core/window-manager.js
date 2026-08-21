/**
 * window-manager.js —— 窗口管理器
 * ---------------------------------------------------------
 * 职责：
 *  1. 管理所有已打开 APP 的窗口 DOM（打开 / 关闭 / 最小化 / 聚焦）。
 *  2. 维护窗口栈（z-index 顺序），支持多任务切换视图。
 *  3. 提供统一的窗口生命周期钩子，供各 APP 模块在 mount/unmount 时清理资源
 *     （例如相机 APP 需要在窗口关闭时停止摄像头流）。
 *
 * 每个窗口是一个 <div class="win"> ，内部包含：
 *   .win-titlebar  —— 可选的小型标题栏（用于显示 APP 名 + 返回/关闭手势提示）
 *   .win-body      —— APP 实际内容挂载点
 */

const desktopEl = () => document.getElementById('desktop-layer');
const windowLayer = () => document.getElementById('window-layer');
const taskSwitcherLayer = () => document.getElementById('task-switcher-layer');

class WindowManager {
  constructor() {
    /** @type {Map<string, {el:HTMLElement, appId:string, meta:object, onClose:Function|null, minimized:boolean}>} */
    this.windows = new Map();
    this.stack = []; // appId 顺序，末尾为最上层
    this.zBase = 100;
  }

  /**
   * 打开一个 APP。
   * @param {string} appId
   * @param {object} appMeta  { name, icon, ... } 来自 app-registry
   * @param {(container:HTMLElement, ctx:object)=>Promise<Function|void>} mountFn
   *        由调用方（app-registry）传入的挂载函数，返回一个可选的 cleanup 函数。
   * @param {{fromEl?: HTMLElement}} opts  fromEl 用于计算开场动画的起始位置（如桌面图标）
   */
  async openApp(appId, appMeta, mountFn, opts = {}) {
    // 若已打开，直接聚焦并取消最小化
    if (this.windows.has(appId)) {
      this.focusApp(appId);
      const w = this.windows.get(appId);
      if (w.minimized) this._restore(w);
      return;
    }

    const win = document.createElement('div');
    win.className = 'win';
    win.dataset.appId = appId;

    win.innerHTML = `
      <div class="win-titlebar">
        <button class="win-btn win-back" aria-label="返回桌面">‹</button>
        <span class="win-title">${appMeta.name || appId}</span>
        <button class="win-btn win-minimize" aria-label="最小化">–</button>
      </div>
      <div class="win-body"></div>
    `;

    windowLayer().appendChild(win);
    const body = win.querySelector('.win-body');

    // 开场动画：从图标位置放大到全屏
    this._playOpenAnimation(win, opts.fromEl);

    // 绑定标题栏按钮
    win.querySelector('.win-back').addEventListener('click', () => this.minimizeApp(appId));
    win.querySelector('.win-minimize').addEventListener('click', () => this.minimizeApp(appId));

    const record = { el: win, appId, meta: appMeta, onClose: null, minimized: false };
    this.windows.set(appId, record);
    this.stack.push(appId);
    this.focusApp(appId);

    // 调用 APP 自己的挂载逻辑，拿到清理函数
    try {
      const cleanup = await mountFn(body, { appId, appMeta, wm: this });
      if (typeof cleanup === 'function') record.onClose = cleanup;
    } catch (err) {
      console.error(`[WindowManager] APP "${appId}" 挂载失败:`, err);
      body.innerHTML = `<div class="win-error">应用加载失败：${err.message}</div>`;
    }

    document.dispatchEvent(new CustomEvent('wm:opened', { detail: { appId } }));
  }

  _playOpenAnimation(win, fromEl) {
    win.style.transformOrigin = 'center center';
    if (fromEl) {
      const r = fromEl.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      win.style.transformOrigin = `${cx}px ${cy}px`;
    }
    win.classList.add('win-opening');
    requestAnimationFrame(() => {
      win.classList.add('win-open');
      win.classList.remove('win-opening');
    });
  }

  /** 将窗口置于最上层并显示 */
  focusApp(appId) {
    const record = this.windows.get(appId);
    if (!record) return;
    this.stack = this.stack.filter((id) => id !== appId);
    this.stack.push(appId);
    this.stack.forEach((id, i) => {
      const w = this.windows.get(id);
      if (!w) return;
      w.el.style.zIndex = this.zBase + i;
      w.el.classList.toggle('win-focused', id === appId);
    });
    record.el.classList.remove('win-minimized');
    record.minimized = false;
  }

  /** 最小化（不销毁状态，仅隐藏，回到桌面） */
  minimizeApp(appId) {
    const record = this.windows.get(appId);
    if (!record) return;
    record.el.classList.add('win-minimized');
    record.minimized = true;
    document.dispatchEvent(new CustomEvent('wm:minimized', { detail: { appId } }));
  }

  _restore(record) {
    record.el.classList.remove('win-minimized');
    record.minimized = false;
    this.focusApp(record.appId);
  }

  /** 彻底关闭并销毁窗口（释放资源，如摄像头流） */
  closeApp(appId) {
    const record = this.windows.get(appId);
    if (!record) return;
    try {
      record.onClose && record.onClose();
    } catch (err) {
      console.error(`[WindowManager] APP "${appId}" 清理资源出错:`, err);
    }
    record.el.classList.add('win-closing');
    setTimeout(() => {
      record.el.remove();
    }, 250);
    this.windows.delete(appId);
    this.stack = this.stack.filter((id) => id !== appId);
    document.dispatchEvent(new CustomEvent('wm:closed', { detail: { appId } }));
  }

  /** 获取当前最上层（前台）APP */
  getForegroundApp() {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const w = this.windows.get(this.stack[i]);
      if (w && !w.minimized) return w.appId;
    }
    return null;
  }

  /** 是否有任何窗口处于前台展示状态 */
  hasForeground() {
    return this.getForegroundApp() !== null;
  }

  /**
   * 显示多任务切换视图：把所有未关闭窗口缩略平铺，
   * 点击卡片恢复该窗口，向上滑动卡片关闭该 APP。
   */
  showTaskSwitcher() {
    const layer = taskSwitcherLayer();
    layer.innerHTML = '';
    layer.classList.add('visible');

    const openIds = [...this.windows.keys()];
    if (openIds.length === 0) {
      layer.innerHTML = '<div class="task-empty">暂无正在运行的应用</div>';
      return;
    }

    openIds.forEach((appId) => {
      const record = this.windows.get(appId);
      const card = document.createElement('div');
      card.className = 'task-card';
      card.innerHTML = `
        <div class="task-card-header">
          <span class="task-card-icon">${record.meta.icon || '📱'}</span>
          <span class="task-card-name">${record.meta.name || appId}</span>
        </div>
        <div class="task-card-preview">${record.meta.icon || '📱'}</div>
      `;
      card.addEventListener('click', () => {
        this.hideTaskSwitcher();
        this._restore(record);
      });

      // 简易上滑关闭手势
      let startY = null;
      card.addEventListener(
        'touchstart',
        (e) => {
          startY = e.touches[0].clientY;
        },
        { passive: true }
      );
      card.addEventListener(
        'touchmove',
        (e) => {
          if (startY === null) return;
          const dy = e.touches[0].clientY - startY;
          if (dy < 0) card.style.transform = `translateY(${dy}px)`;
        },
        { passive: true }
      );
      card.addEventListener('touchend', (e) => {
        if (startY === null) return;
        const dy = e.changedTouches[0].clientY - startY;
        if (dy < -60) {
          card.classList.add('task-card-removing');
          this.closeApp(appId);
          setTimeout(() => card.remove(), 200);
        } else {
          card.style.transform = '';
        }
        startY = null;
      });

      layer.appendChild(card);
    });
  }

  hideTaskSwitcher() {
    taskSwitcherLayer().classList.remove('visible');
  }
}

export const WM = new WindowManager();
