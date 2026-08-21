/**
 * editor.js —— P 图编辑器
 * ---------------------------------------------------------
 * 以浮层（overlay）形式挂载在任意容器上，供相机 APP 拍照后"再编辑"、
 * 相册 APP 点击照片后"编辑"两处复用。
 *
 * 功能：
 *   - 裁剪：拖拽裁剪框四角/边，确认后用 Canvas 二次绘制裁切区域
 *   - 旋转：90° 步进旋转（Canvas 坐标变换）
 *   - 滤镜叠加：复用 filters.js 的 5 种滤镜
 *   - 亮度 / 对比度调节滑块
 *   - 保存：写回 photos 表为一条新记录（parentId 指向原图），不覆盖原图
 */

import { DB, uuid } from '../../core/db.js';
import { VFS } from '../../core/vfs.js';
import { FILTER_LIST, applyFilter, applyBrightnessContrast, makeThumbnail } from './filters.js';

/**
 * 打开编辑器浮层。
 * @param {HTMLElement} hostContainer 挂载编辑器的容器（一般是当前 APP 的 win-body）
 * @param {{id?:string, blob:Blob}} photo 待编辑的照片；若来自已保存照片，需带 id 用于回填 parentId
 * @param {{onSaved?:Function, onClose?:Function}} callbacks
 */
export function openEditor(hostContainer, photo, callbacks = {}) {
  injectEditorStyles();

  const overlay = document.createElement('div');
  overlay.className = 'editor-overlay';
  overlay.innerHTML = `
    <div class="editor-topbar">
      <button class="editor-cancel">取消</button>
      <span class="editor-title">编辑照片</span>
      <button class="editor-save">保存</button>
    </div>
    <div class="editor-canvas-wrap">
      <canvas class="editor-canvas"></canvas>
      <div class="editor-crop-box" hidden>
        <div class="crop-handle crop-tl"></div>
        <div class="crop-handle crop-tr"></div>
        <div class="crop-handle crop-bl"></div>
        <div class="crop-handle crop-br"></div>
      </div>
    </div>
    <div class="editor-filter-strip"></div>
    <div class="editor-sliders">
      <label>亮度 <input type="range" class="ed-brightness" min="-100" max="100" value="0"></label>
      <label>对比度 <input type="range" class="ed-contrast" min="-100" max="100" value="0"></label>
    </div>
    <div class="editor-tools">
      <button class="editor-tool" data-tool="rotate">↻ 旋转</button>
      <button class="editor-tool" data-tool="crop">⬚ 裁剪</button>
      <button class="editor-tool" data-tool="reset">⟲ 重置</button>
    </div>
  `;
  hostContainer.appendChild(overlay);

  const canvas = overlay.querySelector('.editor-canvas');
  const cctx = canvas.getContext('2d', { willReadFrequently: true });
  const cropBox = overlay.querySelector('.editor-crop-box');

  const editState = {
    rotation: 0,
    filterId: 'normal',
    brightness: 0,
    contrast: 0,
    cropping: false,
    cropRect: null, // {x,y,w,h} 相对 canvas 显示坐标
  };

  let sourceBitmap = null;

  // ---------- 加载原图 ----------
  const img = new Image();
  const url = URL.createObjectURL(photo.blob);
  img.onload = () => {
    sourceBitmap = img;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    redraw();
    URL.revokeObjectURL(url);
  };
  img.src = url;

  // ---------- 渲染滤镜条 ----------
  const filterStrip = overlay.querySelector('.editor-filter-strip');
  FILTER_LIST.forEach((f) => {
    const btn = document.createElement('button');
    btn.className = 'editor-filter-chip' + (f.id === 'normal' ? ' active' : '');
    btn.textContent = f.name;
    btn.addEventListener('click', () => {
      editState.filterId = f.id;
      filterStrip.querySelectorAll('.editor-filter-chip').forEach((el) => el.classList.remove('active'));
      btn.classList.add('active');
      redraw();
    });
    filterStrip.appendChild(btn);
  });

  // ---------- 重绘：应用旋转 + 滤镜 + 亮度对比度 ----------
  function redraw() {
    if (!sourceBitmap) return;
    const rad = (editState.rotation * Math.PI) / 180;
    const swap = editState.rotation % 180 !== 0;
    const w = sourceBitmap.naturalWidth;
    const h = sourceBitmap.naturalHeight;
    canvas.width = swap ? h : w;
    canvas.height = swap ? w : h;

    cctx.save();
    cctx.translate(canvas.width / 2, canvas.height / 2);
    cctx.rotate(rad);
    cctx.drawImage(sourceBitmap, -w / 2, -h / 2, w, h);
    cctx.restore();

    const frame = cctx.getImageData(0, 0, canvas.width, canvas.height);
    applyFilter(frame, editState.filterId, { exposure: 0, warmth: 0 });
    applyBrightnessContrast(frame, editState.brightness, editState.contrast);
    cctx.putImageData(frame, 0, 0);
  }

  overlay.querySelector('.ed-brightness').addEventListener('input', (e) => {
    editState.brightness = Number(e.target.value);
    redraw();
  });
  overlay.querySelector('.ed-contrast').addEventListener('input', (e) => {
    editState.contrast = Number(e.target.value);
    redraw();
  });

  // ---------- 工具：旋转 / 裁剪 / 重置 ----------
  overlay.querySelectorAll('.editor-tool').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tool = btn.dataset.tool;
      if (tool === 'rotate') {
        editState.rotation = (editState.rotation + 90) % 360;
        redraw();
      } else if (tool === 'crop') {
        toggleCropMode();
      } else if (tool === 'reset') {
        editState.rotation = 0;
        editState.filterId = 'normal';
        editState.brightness = 0;
        editState.contrast = 0;
        overlay.querySelector('.ed-brightness').value = 0;
        overlay.querySelector('.ed-contrast').value = 0;
        filterStrip.querySelectorAll('.editor-filter-chip').forEach((el, i) => el.classList.toggle('active', i === 0));
        redraw();
      }
    });
  });

  function toggleCropMode() {
    editState.cropping = !editState.cropping;
    cropBox.hidden = !editState.cropping;
    if (editState.cropping) {
      const rect = canvas.getBoundingClientRect();
      cropBox.style.left = '10%';
      cropBox.style.top = '10%';
      cropBox.style.width = '80%';
      cropBox.style.height = '80%';
      bindCropDrag();
    }
  }

  function bindCropDrag() {
    // 简化实现：整体拖动裁剪框（四角把手用于缩放）
    let mode = null,
      startX = 0,
      startY = 0,
      startRect = null;

    function getRect() {
      const wrap = overlay.querySelector('.editor-canvas-wrap');
      const wrapRect = wrap.getBoundingClientRect();
      const boxRect = cropBox.getBoundingClientRect();
      return { wrapRect, boxRect };
    }

    cropBox.onpointerdown = (e) => {
      mode = e.target.classList.contains('crop-handle') ? e.target.className.split(' ')[1] : 'move';
      startX = e.clientX;
      startY = e.clientY;
      const { wrapRect } = getRect();
      startRect = {
        left: cropBox.offsetLeft,
        top: cropBox.offsetTop,
        width: cropBox.offsetWidth,
        height: cropBox.offsetHeight,
        wrapW: wrapRect.width,
        wrapH: wrapRect.height,
      };
      e.stopPropagation();
      cropBox.setPointerCapture(e.pointerId);
    };
    cropBox.onpointermove = (e) => {
      if (!mode) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (mode === 'move') {
        cropBox.style.left = Math.max(0, startRect.left + dx) + 'px';
        cropBox.style.top = Math.max(0, startRect.top + dy) + 'px';
      } else if (mode === 'crop-br') {
        cropBox.style.width = Math.max(40, startRect.width + dx) + 'px';
        cropBox.style.height = Math.max(40, startRect.height + dy) + 'px';
      } else if (mode === 'crop-tl') {
        cropBox.style.left = Math.max(0, startRect.left + dx) + 'px';
        cropBox.style.top = Math.max(0, startRect.top + dy) + 'px';
        cropBox.style.width = Math.max(40, startRect.width - dx) + 'px';
        cropBox.style.height = Math.max(40, startRect.height - dy) + 'px';
      }
      // tr / bl 简化省略，用户可用 move + br/tl 组合达到同等效果
    };
    cropBox.onpointerup = () => {
      mode = null;
    };
  }

  /** 将当前裁剪框映射为 canvas 像素坐标，执行裁剪 */
  function applyCrop() {
    if (!editState.cropping) return;
    const wrap = overlay.querySelector('.editor-canvas-wrap');
    const wrapRect = wrap.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const boxRect = cropBox.getBoundingClientRect();

    const scaleX = canvas.width / canvasRect.width;
    const scaleY = canvas.height / canvasRect.height;

    const cropX = Math.max(0, (boxRect.left - canvasRect.left) * scaleX);
    const cropY = Math.max(0, (boxRect.top - canvasRect.top) * scaleY);
    const cropW = Math.min(canvas.width - cropX, boxRect.width * scaleX);
    const cropH = Math.min(canvas.height - cropY, boxRect.height * scaleY);

    const cropped = document.createElement('canvas');
    cropped.width = cropW;
    cropped.height = cropH;
    cropped.getContext('2d').drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

    canvas.width = cropW;
    canvas.height = cropH;
    cctx.drawImage(cropped, 0, 0);

    editState.cropping = false;
    cropBox.hidden = true;
  }

  // ---------- 取消 / 保存 ----------
  overlay.querySelector('.editor-cancel').addEventListener('click', () => {
    overlay.remove();
    callbacks.onClose && callbacks.onClose();
  });

  overlay.querySelector('.editor-save').addEventListener('click', async () => {
    if (editState.cropping) applyCrop();

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    const thumbBlob = await makeThumbnail(canvas);
    const id = uuid();
    const now = Date.now();
    const filename = `EDIT_${now}.jpg`;
    const vfsPath = `/storage/DCIM/${filename}`;

    await DB.add('photos', {
      id,
      blob,
      thumbBlob,
      width: canvas.width,
      height: canvas.height,
      createdAt: now,
      source: 'edited',
      parentId: photo.id || null,
      filters: {
        filterId: editState.filterId,
        rotation: editState.rotation,
        brightness: editState.brightness,
        contrast: editState.contrast,
      },
      vfsPath,
    });

    try {
      await VFS.writeFile(vfsPath, JSON.stringify({ type: 'photo-ref', photoId: id }), {
        mime: 'application/x-webos-photo-ref',
        mode: 0o644,
      });
    } catch (e) {
      console.warn('[Editor] VFS 写入引用失败:', e);
    }

    document.dispatchEvent(new CustomEvent('webos:toast', { detail: { message: '已保存为新照片' } }));
    overlay.remove();
    callbacks.onSaved && callbacks.onSaved(id);
  });
}

function injectEditorStyles() {
  if (document.getElementById('editor-styles')) return;
  const style = document.createElement('style');
  style.id = 'editor-styles';
  style.textContent = `
    .editor-overlay { position:absolute; inset:0; background:#000; display:flex; flex-direction:column; z-index:20; }
    .editor-topbar { display:flex; align-items:center; justify-content:space-between; padding:12px 16px;
      color:#fff; background:#111; flex-shrink:0; }
    .editor-topbar button { color:#0a84ff; font-size:15px; font-weight:600; }
    .editor-title { color:#fff; font-size:14px; }
    .editor-canvas-wrap { flex:1; position:relative; display:flex; align-items:center; justify-content:center; overflow:hidden; background:#000; min-height: 0; }
    .editor-canvas { max-width:100%; max-height:100%; touch-action:none; }
    .editor-crop-box { position:absolute; border:1.5px dashed #ffd60a; box-shadow:0 0 0 2000px rgba(0,0,0,.5); touch-action:none; }
    .crop-handle { position:absolute; width:18px; height:18px; background:#ffd60a; border-radius:50%; touch-action:none; }
    .crop-tl { left:-9px; top:-9px; } .crop-tr { right:-9px; top:-9px; }
    .crop-bl { left:-9px; bottom:-9px; } .crop-br { right:-9px; bottom:-9px; }
    .editor-filter-strip { display:flex; gap:6px; padding:10px 12px; overflow-x:auto; background:#111; flex-shrink:0; }
    .editor-filter-chip { flex-shrink:0; padding:6px 14px; border-radius:14px; background:#222; color:#ccc; font-size:12px; }
    .editor-filter-chip.active { background:#ffd60a; color:#000; font-weight:700; }
    .editor-sliders { background:#111; padding:6px 16px 4px; flex-shrink:0; }
    .editor-sliders label { display:flex; align-items:center; gap:10px; color:#ccc; font-size:12px; margin:6px 0; }
    .editor-sliders input[type=range] { flex:1; }
    .editor-tools { display:flex; justify-content:space-around; padding:10px 16px calc(14px + env(safe-area-inset-bottom,0px));
      background:#111; flex-shrink:0; }
    .editor-tool { color:#fff; font-size:13px; padding:8px 14px; border-radius:10px; background:#222; }
  `;
  document.head.appendChild(style);
}
