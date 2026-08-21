/**
 * boot.js —— 系统启动引导
 * ---------------------------------------------------------
 * 启动顺序：
 *   1. 显示开机画面（可选的简短动画，模拟真实设备体验）
 *   2. DB.ready() —— 打开 / 建立 IndexedDB 连接与表结构
 *   3. VFS.init() —— 建立虚拟文件系统默认目录骨架
 *   4. AppRegistry_.init() —— 写入内置 APP 元数据（首次运行）
 *   5. StatusBar_.init() —— 启动状态栏时钟/电量
 *   6. Desktop_.init() —— 渲染桌面与 Dock
 *   7. 绑定全局手势（左边缘右滑返回、Home 键行为、Toast 监听）
 *   8. 隐藏开机画面，系统就绪
 */

import { DB } from './db.js';
import { VFS } from './vfs.js';
import { AppRegistry_ } from './app-registry.js';
import { StatusBar_ } from './statusbar.js';
import { Desktop_ } from './desktop.js';
import { WM } from './window-manager.js';
import { bindEdgeSwipeBack } from './gesture.js';

const WALLPAPER_CSS = {
  'blue-purple': 'linear-gradient(160deg, #4facfe, #7367f0)',
  sunset: 'linear-gradient(160deg, #ff9a56, #ff6b6b)',
  forest: 'linear-gradient(160deg, #11998e, #38ef7d)',
  night: 'linear-gradient(160deg, #0f0f1e, #302b63)',
  pink: 'linear-gradient(160deg, #fbc2eb, #a6c1ee)',
};

async function boot() {
  const bootScreen = document.getElementById('boot-screen');

  try {
    await DB.ready();
    await VFS.init();
    await AppRegistry_.init();
    await StatusBar_.init();
    await Desktop_.init();
    await _applySavedWallpaper();
  } catch (err) {
    console.error('[Boot] 系统启动失败:', err);
    bootScreen.innerHTML = `<div class="boot-error">系统启动失败：${err.message}</div>`;
    return;
  }

  _bindGlobalUI();
  _bindToast();

  // 开机动画结束，淡出开机画面
  setTimeout(() => {
    bootScreen.classList.add('boot-hidden');
    setTimeout(() => bootScreen.remove(), 600);
  }, 900);

  _registerServiceWorker();
}

async function _applySavedWallpaper() {
  const saved = await DB.get('system_kv', 'wallpaper');
  const css = WALLPAPER_CSS[saved?.value] || WALLPAPER_CSS['blue-purple'];
  document.getElementById('desktop-layer').style.background = css;
}

function _registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('[Boot] Service Worker 注册失败（不影响系统主体功能）:', err);
    });
  }
}

function _bindGlobalUI() {
  const windowLayer = document.getElementById('window-layer');

  // 每个新窗口内部会各自绑定，这里做一个全局兜底：
  // 在 window-layer 上监听左边缘右滑，返回时最小化当前前台 APP。
  bindEdgeSwipeBack(windowLayer, () => {
    const fg = WM.getForegroundApp();
    if (fg) WM.minimizeApp(fg);
  });

  // Home 键（圆形按钮）：最小化当前 APP，回到桌面
  document.getElementById('home-button').addEventListener('click', () => {
    const fg = WM.getForegroundApp();
    if (fg) WM.minimizeApp(fg);
    WM.hideTaskSwitcher();
  });

  // 长按 / 双击 Home 键：呼出多任务切换视图
  let homeTapTimer = null;
  document.getElementById('home-button').addEventListener('dblclick', () => {
    WM.showTaskSwitcher();
  });
  document.getElementById('home-button').addEventListener(
    'touchstart',
    () => {
      homeTapTimer = setTimeout(() => WM.showTaskSwitcher(), 550);
    },
    { passive: true }
  );
  document.getElementById('home-button').addEventListener('touchend', () => {
    if (homeTapTimer) clearTimeout(homeTapTimer);
  });

  // 点击多任务视图的空白背景关闭该视图
  document.getElementById('task-switcher-layer').addEventListener('click', (e) => {
    if (e.target.id === 'task-switcher-layer') WM.hideTaskSwitcher();
  });
}

function _bindToast() {
  let toastTimer = null;
  document.addEventListener('webos:toast', (e) => {
    const el = document.getElementById('toast');
    el.textContent = e.detail.message;
    el.classList.add('visible');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('visible'), 2200);
  });
}

boot();
