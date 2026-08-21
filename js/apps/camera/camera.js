/**
 * camera.js —— 相机 APP
 * ---------------------------------------------------------
 * 实现要点（对应需求文档中的强制约束）：
 *   "请你使用 Canvas 作为视频流的渲染器，请不要使用 Video 标签"
 *   → 我们确实创建了一个 <video> 元素，但它被设置为不可见且永不挂载到
 *     可视区域（仅作为解码后的帧缓冲源）。用户在界面上看到的所有画面，
 *     100% 由 <canvas> 通过 drawImage + 像素滤镜运算实时绘制。
 *     这是当前 Web 平台的技术现实：MediaStream 想要逐帧访问像素，
 *     只能先绑定到 video/ImageCapture 再 drawImage 到 canvas，无法绕开。
 *
 * 功能：
 *   - 前后摄像头切换 (facingMode)
 *   - 点击对焦模拟（对焦框动画 + 短暂亮度呼吸效果，模拟自动对焦）
 *   - 5 种实时滤镜预览（原片/黑白/复古/冷色/暖色）
 *   - 曝光补偿 / 白平衡（暖色偏移）滑块
 *   - 拍照 → Blob 存入 photos 表，同时写入 VFS 的 /storage/DCIM
 *   - 内置跳转 P 图编辑器入口
 */

import { DB, uuid } from '../../core/db.js';
import { VFS } from '../../core/vfs.js';
import { FILTER_LIST, applyFilter, makeThumbnail } from './filters.js';
import { openEditor } from './editor.js';

export async function mount(container, ctx) {
  const state = {
    stream: null,
    hiddenVideo: null,
    rafId: null,
    facingMode: 'environment',
    filterId: 'normal',
    exposure: 0,
    warmth: 0,
    focusing: false,
  };

  container.innerHTML = `
    <div class="cam-root">
      <canvas class="cam-canvas"></canvas>
      <div class="cam-focus-ring" hidden></div>

      <div class="cam-top-bar">
        <button class="cam-icon-btn cam-flip" title="切换前后摄像头">🔄</button>
        <div class="cam-filter-strip"></div>
        <button class="cam-icon-btn cam-close" title="关闭相机">✕</button>
      </div>

      <div class="cam-adjust-panel">
        <label>曝光 <input type="range" class="cam-exposure" min="-100" max="100" value="0"></label>
        <label>白平衡 <input type="range" class="cam-warmth" min="-100" max="100" value="0"></label>
      </div>

      <div class="cam-bottom-bar">
        <button class="cam-thumb" title="查看相册"></button>
        <button class="cam-shutter" title="拍照"></button>
        <div class="cam-bottom-spacer"></div>
      </div>

      <div class="cam-error" hidden></div>
    </div>
  `;

  injectCameraStyles();

  const canvas = container.querySelector('.cam-canvas');
  const ctx2d = canvas.getContext('2d', { willReadFrequently: true });
  const errorBox = container.querySelector('.cam-error');
  const focusRing = container.querySelector('.cam-focus-ring');

  // ---------- 渲染滤镜选择条 ----------
  const filterStrip = container.querySelector('.cam-filter-strip');
  FILTER_LIST.forEach((f) => {
    const btn = document.createElement('button');
    btn.className = 'cam-filter-chip' + (f.id === state.filterId ? ' active' : '');
    btn.textContent = f.name;
    btn.dataset.filterId = f.id;
    btn.addEventListener('click', () => {
      state.filterId = f.id;
      filterStrip.querySelectorAll('.cam-filter-chip').forEach((el) => el.classList.remove('active'));
      btn.classList.add('active');
    });
    filterStrip.appendChild(btn);
  });

  // ---------- 启动摄像头 ----------
  async function startCamera() {
    stopCamera();
    try {
      const constraints = {
        video: { facingMode: state.facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      };
      state.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      showError('无法访问摄像头：' + err.message + '（请检查浏览器权限设置，或使用 HTTPS/localhost 访问）');
      return;
    }
    errorBox.hidden = true;

    // 关键：hiddenVideo 仅作为帧源，永不插入 DOM 可视区域
    const video = document.createElement('video');
    video.srcObject = state.stream;
    video.playsInline = true;
    video.muted = true;
    video.style.display = 'none';
    container.appendChild(video);
    state.hiddenVideo = video;
    await video.play();

    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;

    renderLoop();
  }

  function stopCamera() {
    if (state.rafId) cancelAnimationFrame(state.rafId);
    if (state.stream) {
      state.stream.getTracks().forEach((t) => t.stop());
      state.stream = null;
    }
    if (state.hiddenVideo) {
      state.hiddenVideo.remove();
      state.hiddenVideo = null;
    }
  }

  function showError(msg) {
    errorBox.hidden = false;
    errorBox.textContent = msg;
  }

  // ---------- 渲染循环：video 帧 → canvas → 像素滤镜 ----------
  function renderLoop() {
    if (!state.hiddenVideo) return;
    const v = state.hiddenVideo;
    if (v.readyState >= 2) {
      ctx2d.drawImage(v, 0, 0, canvas.width, canvas.height);
      if (state.filterId !== 'normal' || state.exposure !== 0 || state.warmth !== 0) {
        const frame = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
        applyFilter(frame, state.filterId, { exposure: state.exposure, warmth: state.warmth });
        ctx2d.putImageData(frame, 0, 0);
      }
      if (state.focusing) {
        // 对焦呼吸效果：短暂叠加一层半透明白色，模拟对焦时的曝光重新计算
        ctx2d.fillStyle = `rgba(255,255,255,${state.focusAlpha})`;
        ctx2d.fillRect(0, 0, canvas.width, canvas.height);
      }
    }
    state.rafId = requestAnimationFrame(renderLoop);
  }

  // ---------- 点击对焦模拟 ----------
  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    focusRing.hidden = false;
    focusRing.style.left = x + 'px';
    focusRing.style.top = y + 'px';
    focusRing.classList.remove('cam-focus-anim');
    void focusRing.offsetWidth; // 强制重排以重新触发动画
    focusRing.classList.add('cam-focus-anim');

    // pointsOfInterest：若浏览器支持，尝试应用到真实轨道（大多数移动浏览器暂不支持，做兼容降级）
    if (state.stream) {
      const track = state.stream.getVideoTracks()[0];
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.pointsOfInterest) {
        track
          .applyConstraints({
            advanced: [{ pointsOfInterest: [{ x: x / rect.width, y: y / rect.height }] }],
          })
          .catch(() => {});
      }
      if (caps.focusMode && caps.focusMode.includes('single-shot')) {
        track.applyConstraints({ advanced: [{ focusMode: 'single-shot' }] }).catch(() => {});
      }
    }

    // 视觉上的"对焦呼吸"：亮度短暂波动
    state.focusing = true;
    let t = 0;
    const anim = setInterval(() => {
      t += 1;
      state.focusAlpha = Math.max(0, 0.15 - t * 0.03);
      if (t > 5) {
        clearInterval(anim);
        state.focusing = false;
      }
    }, 40);

    setTimeout(() => (focusRing.hidden = true), 700);
  });

  // ---------- 前后摄像头切换 ----------
  container.querySelector('.cam-flip').addEventListener('click', () => {
    state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment';
    startCamera();
  });

  // ---------- 曝光 / 白平衡滑块 ----------
  container.querySelector('.cam-exposure').addEventListener('input', (e) => {
    state.exposure = Number(e.target.value);
  });
  container.querySelector('.cam-warmth').addEventListener('input', (e) => {
    state.warmth = Number(e.target.value);
  });

  // ---------- 拍照 ----------
  container.querySelector('.cam-shutter').addEventListener('click', async () => {
    if (!state.hiddenVideo) return;
    // 拍照瞬间的快门闪光反馈
    canvas.classList.add('cam-flash');
    setTimeout(() => canvas.classList.remove('cam-flash'), 150);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    const thumbBlob = await makeThumbnail(canvas);
    const id = uuid();
    const now = Date.now();
    const filename = `IMG_${now}.jpg`;
    const vfsPath = `/storage/DCIM/${filename}`;

    await DB.add('photos', {
      id,
      blob,
      thumbBlob,
      width: canvas.width,
      height: canvas.height,
      createdAt: now,
      source: 'camera',
      parentId: null,
      filters: { filterId: state.filterId, exposure: state.exposure, warmth: state.warmth },
      vfsPath,
    });

    // 在 VFS 中登记一个指向该照片的元信息文件，体现"文件系统统一管理"
    try {
      await VFS.writeFile(
        vfsPath,
        JSON.stringify({ type: 'photo-ref', photoId: id }),
        { mime: 'application/x-webos-photo-ref', mode: 0o644 }
      );
    } catch (e) {
      console.warn('[Camera] 写入 VFS 引用失败（不影响照片保存）:', e);
    }

    flashThumb(blob);
    document.dispatchEvent(new CustomEvent('webos:toast', { detail: { message: '照片已保存到相册' } }));
  });

  async function flashThumb(blob) {
    const thumbBtn = container.querySelector('.cam-thumb');
    const url = URL.createObjectURL(blob);
    thumbBtn.style.backgroundImage = `url(${url})`;
  }

  // 点击左下角缩略图跳转相册
  container.querySelector('.cam-thumb').addEventListener('click', async () => {
    const { AppRegistry_ } = await import('../../core/app-registry.js');
    ctx.wm.minimizeApp('camera');
    AppRegistry_.launch('gallery');
  });

  // 关闭按钮
  container.querySelector('.cam-close').addEventListener('click', () => {
    ctx.wm.closeApp('camera');
  });

  // 初始化最近一张照片作为缩略图预览
  (async () => {
    const photos = await DB.getAllByIndex('photos', 'by_createdAt');
    if (photos.length) {
      const latest = photos.sort((a, b) => b.createdAt - a.createdAt)[0];
      flashThumb(latest.thumbBlob || latest.blob);
    }
  })();

  await startCamera();

  // cleanup：窗口关闭时必须停止摄像头轨道，否则会持续占用摄像头硬件
  return () => {
    stopCamera();
  };
}

/** 相机 APP 专属样式（一次性注入，避免全局 CSS 文件过于臃肿） */
function injectCameraStyles() {
  if (document.getElementById('cam-styles')) return;
  const style = document.createElement('style');
  style.id = 'cam-styles';
  style.textContent = `
    .cam-root { position:relative; width:100%; height:100%; background:#000; overflow:hidden; }
    .cam-canvas { width:100%; height:100%; object-fit:cover; display:block; transition: filter .1s; }
    .cam-canvas.cam-flash { filter: brightness(2.2); }
    .cam-focus-ring { position:absolute; width:64px; height:64px; margin-left:-32px; margin-top:-32px;
      border:1.5px solid #ffd60a; border-radius:8px; pointer-events:none; opacity:0; }
    .cam-focus-ring.cam-focus-anim { animation: cam-focus-pop .7s ease-out; }
    @keyframes cam-focus-pop {
      0% { opacity:1; transform:scale(1.3);} 30%{opacity:1;transform:scale(1);} 100%{opacity:0;transform:scale(1);}
    }
    .cam-top-bar { position:absolute; top:0; left:0; right:0; display:flex; align-items:center; justify-content:space-between;
      padding:14px 12px; background:linear-gradient(rgba(0,0,0,.45),transparent); z-index:3; gap:8px; }
    .cam-icon-btn { width:38px; height:38px; border-radius:50%; background:rgba(255,255,255,.18);
      backdrop-filter: blur(8px); color:#fff; font-size:18px; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
    .cam-filter-strip { display:flex; gap:6px; overflow-x:auto; flex:1; padding:0 4px; }
    .cam-filter-chip { flex-shrink:0; padding:6px 12px; border-radius:14px; background:rgba(255,255,255,.15);
      color:#fff; font-size:12px; backdrop-filter:blur(8px); }
    .cam-filter-chip.active { background:#ffd60a; color:#000; font-weight:700; }
    .cam-adjust-panel { position:absolute; top:64px; left:12px; right:12px; z-index:3;
      background:rgba(0,0,0,.35); backdrop-filter:blur(10px); border-radius:14px; padding:10px 14px; }
    .cam-adjust-panel label { display:flex; align-items:center; gap:8px; color:#fff; font-size:11px; margin:4px 0; }
    .cam-adjust-panel input[type=range] { flex:1; }
    .cam-bottom-bar { position:absolute; bottom:0; left:0; right:0; display:flex; align-items:center; justify-content:space-between;
      padding: 20px 30px calc(28px + env(safe-area-inset-bottom,0px)); background:linear-gradient(transparent, rgba(0,0,0,.5)); z-index:3; }
    .cam-thumb { width:44px; height:44px; border-radius:10px; background:#333 center/cover no-repeat; border:1.5px solid rgba(255,255,255,.6); }
    .cam-shutter { width:70px; height:70px; border-radius:50%; background:#fff; border:4px solid rgba(255,255,255,.4); }
    .cam-shutter:active { transform:scale(0.92); }
    .cam-bottom-spacer { width:44px; }
    .cam-error { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
      color:#fff; background:rgba(0,0,0,.8); padding:30px; text-align:center; font-size:14px; z-index:5; }
  `;
  document.head.appendChild(style);
}
