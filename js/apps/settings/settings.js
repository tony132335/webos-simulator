/**
 * settings.js —— 系统设置 APP
 * ---------------------------------------------------------
 * 提供：壁纸切换、电量模拟重置、存储占用查看、危险操作（清空全部数据）、
 * 关于本系统信息展示。
 */

import { DB } from '../../core/db.js';

const WALLPAPERS = [
  { id: 'blue-purple', label: '蓝紫', css: 'linear-gradient(160deg, #4facfe, #7367f0)' },
  { id: 'sunset', label: '日落', css: 'linear-gradient(160deg, #ff9a56, #ff6b6b)' },
  { id: 'forest', label: '森林', css: 'linear-gradient(160deg, #11998e, #38ef7d)' },
  { id: 'night', label: '深夜', css: 'linear-gradient(160deg, #0f0f1e, #302b63)' },
  { id: 'pink', label: '粉调', css: 'linear-gradient(160deg, #fbc2eb, #a6c1ee)' },
];

export async function mount(container, ctx) {
  injectSettingsStyles();

  container.innerHTML = `
    <div class="app-root set-root">
      <div class="toolbar"><span class="toolbar-title">设置</span></div>
      <div class="set-body">

        <div class="list-section-title">外观</div>
        <div class="set-wallpaper-grid list"></div>

        <div class="list-section-title">系统</div>
        <div class="list">
          <div class="list-item"><span>存储占用</span><span class="set-storage-info badge">计算中…</span></div>
          <div class="list-item set-reset-battery"><span>重置模拟电量为 100%</span><span>›</span></div>
        </div>

        <div class="list-section-title">关于</div>
        <div class="list">
          <div class="list-item"><span>系统名称</span><span class="badge">WebOS 模拟器</span></div>
          <div class="list-item"><span>版本</span><span class="badge">1.0.0</span></div>
          <div class="list-item"><span>技术栈</span><span class="badge">HTML5 + CSS3 + Vanilla JS</span></div>
        </div>

        <div class="list-section-title">危险区域</div>
        <div class="list">
          <div class="list-item set-clear-data" style="color:#ff3b30;"><span>清空全部系统数据（不可恢复）</span><span>›</span></div>
        </div>

      </div>
    </div>
  `;

  const grid = container.querySelector('.set-wallpaper-grid');
  const currentWallpaper = (await DB.get('system_kv', 'wallpaper'))?.value || 'blue-purple';

  WALLPAPERS.forEach((w) => {
    const item = document.createElement('div');
    item.className = 'set-wallpaper-item' + (w.id === currentWallpaper ? ' active' : '');
    item.innerHTML = `<div class="set-wallpaper-swatch" style="background:${w.css}"></div><span>${w.label}</span>`;
    item.addEventListener('click', async () => {
      await DB.put('system_kv', { key: 'wallpaper', value: w.id });
      document.getElementById('desktop-layer').style.background = w.css;
      grid.querySelectorAll('.set-wallpaper-item').forEach((el) => el.classList.remove('active'));
      item.classList.add('active');
    });
    grid.appendChild(item);
  });

  // 存储占用估算
  (async () => {
    const infoEl = container.querySelector('.set-storage-info');
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      const usedMB = ((est.usage || 0) / 1024 / 1024).toFixed(1);
      infoEl.textContent = `${usedMB} MB`;
    } else {
      infoEl.textContent = '不支持';
    }
  })();

  container.querySelector('.set-reset-battery').addEventListener('click', async () => {
    await DB.put('system_kv', { key: 'battery_sim', value: 100 });
    document.dispatchEvent(new CustomEvent('webos:toast', { detail: { message: '电量已重置为 100%（下次刷新生效）' } }));
  });

  container.querySelector('.set-clear-data').addEventListener('click', async () => {
    if (!confirm('确定要清空全部系统数据吗？此操作将删除所有照片、联系人、自定义 APP 等数据，且不可恢复。')) return;
    if (!confirm('请再次确认：真的要清空所有数据吗？')) return;
    indexedDB.deleteDatabase('WebOS_DB');
    document.dispatchEvent(new CustomEvent('webos:toast', { detail: { message: '数据已清空，即将重新加载系统' } }));
    setTimeout(() => location.reload(), 1200);
  });

  return () => {};
}

function injectSettingsStyles() {
  if (document.getElementById('settings-styles')) return;
  const style = document.createElement('style');
  style.id = 'settings-styles';
  style.textContent = `
    .set-root { display:flex; flex-direction:column; height:100%; }
    .set-body { flex:1; overflow-y:auto; padding-bottom:20px; }
    .set-wallpaper-grid { display:flex; gap:10px; padding:12px 16px; overflow-x:auto; background:transparent; }
    .set-wallpaper-item { display:flex; flex-direction:column; align-items:center; gap:6px; flex-shrink:0; }
    .set-wallpaper-swatch { width:56px; height:56px; border-radius:14px; border:2px solid transparent; }
    .set-wallpaper-item.active .set-wallpaper-swatch { border-color:#0a84ff; }
    .set-wallpaper-item span { font-size:11px; color:#666; }
    .list-item { justify-content:space-between; }
  `;
  document.head.appendChild(style);
}
