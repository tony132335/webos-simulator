/**
 * statusbar.js —— 顶部状态栏
 * ---------------------------------------------------------
 * 显示：当前时间（每秒更新）、模拟信号格、模拟电量（带缓慢消耗动画，
 * 数值持久化在 system_kv 表，刷新页面后延续，营造"真实设备"感）。
 */

import { DB } from './db.js';

const BATTERY_KEY = 'battery_sim';

class StatusBar {
  constructor() {
    this.el = null;
    this.battery = 100;
    this._timer = null;
  }

  async init() {
    this.el = document.getElementById('status-bar');
    const saved = await DB.get('system_kv', BATTERY_KEY);
    this.battery = saved ? saved.value : 82; // 默认一个不满的电量，更真实

    this._render();
    this._timer = setInterval(() => this._tick(), 1000);

    // 每隔一段时间缓慢"耗电"，模拟真实设备
    setInterval(() => this._drainBattery(), 45000);
  }

  _tick() {
    this._render();
  }

  async _drainBattery() {
    if (this.battery > 5) {
      this.battery -= 1;
      await DB.put('system_kv', { key: BATTERY_KEY, value: this.battery });
      this._render();
    }
  }

  _batteryIcon() {
    const b = this.battery;
    const fillWidth = Math.max(1, Math.round((b / 100) * 16));
    const color = b <= 20 ? '#ff4d4f' : '#fff';
    return `
      <svg width="26" height="13" viewBox="0 0 26 13" fill="none">
        <rect x="1" y="1" width="21" height="11" rx="2.5" stroke="${color}" stroke-opacity="0.8"/>
        <rect x="3" y="3" width="${fillWidth}" height="7" rx="1" fill="${color}"/>
        <rect x="23" y="4" width="2" height="5" rx="1" fill="${color}" fill-opacity="0.8"/>
      </svg>`;
  }

  _render() {
    if (!this.el) return;
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    this.el.innerHTML = `
      <div class="status-left">${hh}:${mm}</div>
      <div class="status-right">
        <span class="status-signal">
          <svg width="18" height="12" viewBox="0 0 18 12" fill="#fff"><rect x="0" y="7" width="3" height="5" rx="1"/><rect x="5" y="5" width="3" height="7" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg>
        </span>
        <span class="status-wifi">
          <svg width="16" height="12" viewBox="0 0 16 12" fill="#fff"><path d="M8 10.5a1.4 1.4 0 100-2.8 1.4 1.4 0 000 2.8zM4.8 6.9a4.6 4.6 0 016.4 0l-1.2 1.2a2.9 2.9 0 00-4 0L4.8 6.9zM2 4a8.4 8.4 0 0112 0L12.8 5.2a6.7 6.7 0 00-9.6 0L2 4z"/></svg>
        </span>
        <span class="status-battery-pct">${this.battery}%</span>
        ${this._batteryIcon()}
      </div>
    `;
  }
}

export const StatusBar_ = new StatusBar();
