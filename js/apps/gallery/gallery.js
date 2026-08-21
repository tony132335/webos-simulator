/**
 * gallery.js —— 相册 APP
 * ---------------------------------------------------------
 * 功能：
 *   - 网格（瀑布流式等宽网格）展示 IndexedDB `photos` 表中所有照片缩略图
 *   - 点击进入全屏查看：支持双指缩放（bindPinchZoom）、左右滑动切换（bindSwipe）
 *   - 全屏视图工具栏：删除、分享（Web Share API）、跳转 P 图编辑器
 *   - 分享行为：优先使用 navigator.share 的文件分享能力（Level 2），
 *     若浏览器不支持文件分享则降级为分享一个 Blob 生成的临时下载链接提示。
 */

import { DB } from '../../core/db.js';
import { VFS } from '../../core/vfs.js';
import { bindPinchZoom, bindSwipe } from '../../core/gesture.js';
import { openEditor } from '../camera/editor.js';

export async function mount(container, ctx) {
  injectGalleryStyles();

  container.innerHTML = `
    <div class="app-root gal-root">
      <div class="toolbar">
        <span class="toolbar-title">相册</span>
        <span class="gal-count badge"></span>
      </div>
      <div class="gal-grid"></div>
    </div>
    <div class="gal-viewer" hidden></div>
  `;

  const grid = container.querySelector('.gal-grid');
  const countBadge = container.querySelector('.gal-count');
  const viewer = container.querySelector('.gal-viewer');

  let photos = [];
  let objectUrls = [];

  async function loadPhotos() {
    photos = await DB.getAll('photos');
    photos.sort((a, b) => b.createdAt - a.createdAt);
    countBadge.textContent = `${photos.length} 张`;
    renderGrid();
  }

  function revokeAllUrls() {
    objectUrls.forEach((u) => URL.revokeObjectURL(u));
    objectUrls = [];
  }

  function renderGrid() {
    revokeAllUrls();
    grid.innerHTML = '';
    if (photos.length === 0) {
      grid.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🖼️</div><div>还没有照片，快去拍一张吧</div></div>`;
      return;
    }
    photos.forEach((p, index) => {
      const url = URL.createObjectURL(p.thumbBlob || p.blob);
      objectUrls.push(url);
      const cell = document.createElement('div');
      cell.className = 'gal-cell';
      cell.style.backgroundImage = `url(${url})`;
      cell.addEventListener('click', () => openViewer(index));
      grid.appendChild(cell);
    });
  }

  // ================= 全屏查看器 =================
  let currentIndex = 0;
  let currentUrl = null;

  function openViewer(index) {
    currentIndex = index;
    viewer.hidden = false;
    renderViewerPhoto();
  }

  function closeViewer() {
    viewer.hidden = true;
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }

  function renderViewerPhoto() {
    const p = photos[currentIndex];
    if (!p) {
      closeViewer();
      return;
    }
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = URL.createObjectURL(p.blob);

    viewer.innerHTML = `
      <div class="gal-viewer-topbar">
        <button class="icon-btn gal-close">✕</button>
        <span class="gal-viewer-date">${formatDate(p.createdAt)}</span>
        <span style="width:36px"></span>
      </div>
      <div class="gal-viewer-stage">
        <img class="gal-viewer-img" src="${currentUrl}" draggable="false" />
      </div>
      <div class="gal-viewer-toolbar">
        <button class="gal-action" data-action="edit">✏️<span>编辑</span></button>
        <button class="gal-action" data-action="share">📤<span>分享</span></button>
        <button class="gal-action" data-action="delete">🗑️<span>删除</span></button>
      </div>
    `;

    const stage = viewer.querySelector('.gal-viewer-stage');
    const img = viewer.querySelector('.gal-viewer-img');

    bindPinchZoom(stage, {
      onChange: ({ scale, translateX, translateY }) => {
        img.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
      },
    });

    bindSwipe(stage, {
      onSwipeLeft: () => {
        if (currentIndex < photos.length - 1) {
          currentIndex++;
          renderViewerPhoto();
        }
      },
      onSwipeRight: () => {
        if (currentIndex > 0) {
          currentIndex--;
          renderViewerPhoto();
        } else {
          closeViewer();
        }
      },
    });

    viewer.querySelector('.gal-close').addEventListener('click', closeViewer);

    viewer.querySelector('[data-action="edit"]').addEventListener('click', () => {
      openEditor(container, p, {
        onSaved: async () => {
          await loadPhotos();
          closeViewer();
        },
        onClose: () => {},
      });
    });

    viewer.querySelector('[data-action="share"]').addEventListener('click', () => sharePhoto(p));

    viewer.querySelector('[data-action="delete"]').addEventListener('click', async () => {
      if (!confirm('确定删除这张照片吗？')) return;
      await DB.delete('photos', p.id);
      try {
        if (p.vfsPath) await VFS.remove(p.vfsPath);
      } catch (e) {
        /* VFS 引用可能已不存在，忽略 */
      }
      await loadPhotos();
      closeViewer();
    });
  }

  async function sharePhoto(p) {
    const file = new File([p.blob], `photo_${p.id}.jpg`, { type: 'image/jpeg' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'WebOS 照片分享' });
        return;
      } catch (err) {
        if (err.name === 'AbortError') return; // 用户取消
        console.warn('[Gallery] Web Share 文件分享失败，尝试降级:', err);
      }
    }
    // 降级方案：生成一个可下载的临时链接供用户长按保存
    const url = URL.createObjectURL(p.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `photo_${p.id}.jpg`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    document.dispatchEvent(new CustomEvent('webos:toast', { detail: { message: '当前浏览器不支持直接分享，已触发下载' } }));
  }

  function formatDate(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  await loadPhotos();

  // 监听相机拍照事件，若相册处于打开状态可以实时刷新（通过重新聚焦时机简单实现：这里监听toast作为轻量信号亦可，
  // 但为了不引入耦合，改为每次窗口重新 focus 时用户手动下拉刷新；此处提供一个简单的下拉刷新手势）
  let pullStartY = null;
  grid.addEventListener(
    'touchstart',
    (e) => {
      if (grid.scrollTop === 0) pullStartY = e.touches[0].clientY;
    },
    { passive: true }
  );
  grid.addEventListener('touchend', async (e) => {
    if (pullStartY === null) return;
    const dy = e.changedTouches[0].clientY - pullStartY;
    if (dy > 70) await loadPhotos();
    pullStartY = null;
  });

  return () => {
    revokeAllUrls();
    if (currentUrl) URL.revokeObjectURL(currentUrl);
  };
}

function injectGalleryStyles() {
  if (document.getElementById('gallery-styles')) return;
  const style = document.createElement('style');
  style.id = 'gallery-styles';
  style.textContent = `
    .gal-root { display:flex; flex-direction:column; height:100%; }
    .gal-grid { flex:1; overflow-y:auto; display:grid; grid-template-columns: repeat(3, 1fr); gap:2px; padding:2px; -webkit-overflow-scrolling: touch; }
    .gal-cell { aspect-ratio:1/1; background-size:cover; background-position:center; background-color:#ddd; }
    .gal-viewer { position:absolute; inset:0; background:#000; z-index:15; display:flex; flex-direction:column; }
    .gal-viewer-topbar { display:flex; align-items:center; justify-content:space-between; padding:12px 14px calc(10px + env(safe-area-inset-top,0px));
      color:#fff; background:rgba(0,0,0,.5); }
    .gal-viewer-date { font-size:13px; opacity:.85; }
    .gal-viewer-topbar .icon-btn { color:#fff; }
    .gal-viewer-stage { flex:1; overflow:hidden; display:flex; align-items:center; justify-content:center; touch-action:none; }
    .gal-viewer-img { max-width:100%; max-height:100%; will-change:transform; }
    .gal-viewer-toolbar { display:flex; justify-content:space-around; padding:14px 20px calc(18px + env(safe-area-inset-bottom,0px)); background:rgba(0,0,0,.5); }
    .gal-action { display:flex; flex-direction:column; align-items:center; gap:4px; color:#fff; font-size:11px; }
    .gal-action span { opacity:.85; }
  `;
  document.head.appendChild(style);
}
