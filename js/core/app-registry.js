/**
 * app-registry.js —— APP 注册表
 * ---------------------------------------------------------
 * 职责：
 *  1. 声明所有系统内置 APP 的元信息（图标、名称、挂载函数的动态 import 路径）。
 *  2. 首次启动时把内置 APP 写入 `apps` 表（若表为空），保证桌面能读取到统一数据源。
 *  3. 提供 `launch(appId)` 统一入口：内置 APP 走动态 import 挂载，自定义 APP 走 sandbox.js 挂载。
 *
 * 新增一个内置 APP 只需要：
 *   1. 在 BUILTIN_APPS 里加一条元信息；
 *   2. 在 js/apps/xxx/xxx.js 里 export 一个 `mount(container, ctx)` 函数；
 *   3. 其余全自动接入桌面、Dock、窗口管理。
 */

import { DB, uuid } from './db.js';
import { WM } from './window-manager.js';

export const BUILTIN_APPS = [
  { appId: 'camera', name: '相机', icon: '📷', modulePath: '../apps/camera/camera.js', pinned: true, order: 0 },
  { appId: 'gallery', name: '相册', icon: '🖼️', modulePath: '../apps/gallery/gallery.js', pinned: true, order: 1 },
  { appId: 'browser', name: '浏览器', icon: '🌐', modulePath: '../apps/browser/browser.js', pinned: true, order: 2 },
  { appId: 'phone', name: '电话', icon: '📞', modulePath: '../apps/phone/phone.js', pinned: true, order: 3 },
  { appId: 'files', name: '文件', icon: '🗂️', modulePath: '../apps/files/files.js', pinned: false, order: 4 },
  { appId: 'games', name: '游戏中心', icon: '🎮', modulePath: '../apps/games/games-hub.js', pinned: false, order: 5 },
  { appId: 'installer', name: 'APP安装器', icon: '🧩', modulePath: '../apps/installer/installer.js', pinned: false, order: 6 },
  { appId: 'settings', name: '设置', icon: '⚙️', modulePath: '../apps/settings/settings.js', pinned: false, order: 7 },
];

class AppRegistry {
  async init() {
    const existing = await DB.getAll('apps');
    if (existing.length === 0) {
      const now = Date.now();
      for (const app of BUILTIN_APPS) {
        await DB.put('apps', {
          appId: app.appId,
          name: app.name,
          icon: app.icon,
          type: 'system',
          entry: app.modulePath,
          pinned: app.pinned,
          order: app.order,
          installedAt: now,
          permissions: ['vfs:read', 'vfs:write', 'db:read', 'db:write'],
        });
      }
    }
  }

  /** 获取全部已安装 APP（用于桌面渲染），按 order 排序 */
  async getAllApps() {
    const apps = await DB.getAll('apps');
    return apps.sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  }

  async getApp(appId) {
    return DB.get('apps', appId);
  }

  /** 注册一个新的自定义 APP（由安装器调用） */
  async registerCustomApp({ name, icon, html, css, js }) {
    const appId = 'custom_' + uuid();
    const now = Date.now();
    await DB.put('apps', {
      appId,
      name,
      icon: icon || '📦',
      type: 'custom',
      entry: '',
      pinned: false,
      order: (await this.getAllApps()).length,
      installedAt: now,
      permissions: ['vfs:read'],
    });
    await DB.put('app_code', { appId, html: html || '', css: css || '', js: js || '', updatedAt: now });
    return appId;
  }

  async uninstall(appId) {
    WM.closeApp(appId);
    await DB.delete('apps', appId);
    await DB.delete('app_code', appId);
  }

  /**
   * 启动一个 APP：根据 type 分流到内置模块挂载或沙箱挂载。
   * @param {string} appId
   * @param {HTMLElement} [fromEl] 用于开场动画起点
   */
  async launch(appId, fromEl) {
    const meta = await this.getApp(appId);
    if (!meta) {
      console.error(`[AppRegistry] 未找到 APP: ${appId}`);
      return;
    }

    if (meta.type === 'system') {
      const mod = await import(/* @vite-ignore */ meta.entry);
      await WM.openApp(appId, meta, async (container, ctx) => mod.mount(container, ctx), { fromEl });
    } else {
      const { mountSandboxApp } = await import('./sandbox.js');
      await WM.openApp(appId, meta, async (container, ctx) => mountSandboxApp(container, { ...ctx, appId }), {
        fromEl,
      });
    }
  }
}

export const AppRegistry_ = new AppRegistry();
