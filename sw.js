/**
 * sw.js —— Service Worker
 * ---------------------------------------------------------
 * 简单的离线缓存策略：安装时预缓存核心静态资源，
 * 运行时对同源请求采用"缓存优先，网络回退"策略，
 * 使 WebOS 在弱网/离线状态下仍可正常启动（用户数据本身就在 IndexedDB，天然离线可用）。
 * 注意：浏览器 APP 内的 fetch（访问外部网页）不经过此缓存逻辑，始终走网络。
 */

const CACHE_NAME = 'webos-cache-v1';
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/system.css',
  './css/window-manager.css',
  './css/apps.css',
  './js/core/boot.js',
  './js/core/db.js',
  './js/core/vfs.js',
  './js/core/window-manager.js',
  './js/core/app-registry.js',
  './js/core/sandbox.js',
  './js/core/statusbar.js',
  './js/core/desktop.js',
  './js/core/gesture.js',
  './js/apps/camera/camera.js',
  './js/apps/camera/editor.js',
  './js/apps/camera/filters.js',
  './js/apps/gallery/gallery.js',
  './js/apps/browser/browser.js',
  './js/apps/browser/render-engine.js',
  './js/apps/phone/phone.js',
  './js/apps/files/files.js',
  './js/apps/games/games-hub.js',
  './js/apps/games/snake.js',
  './js/apps/games/game2048.js',
  './js/apps/installer/installer.js',
  './js/apps/settings/settings.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // 仅对同源 GET 请求做缓存优先策略，跨域请求（如浏览器APP的CORS代理）直接放行
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((resp) => {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return resp;
        })
        .catch(() => cached);
    })
  );
});
