/**
 * gesture.js —— 通用触摸手势识别器
 * ---------------------------------------------------------
 * 提供三种可复用的手势绑定工具函数，供窗口管理器、相册、桌面等模块调用：
 *   1. bindEdgeSwipeBack(el, onBack)       —— 从屏幕左边缘右滑返回（类 iOS 手势）
 *   2. bindLongPress(el, onLongPress, ms)  —— 长按触发（用于桌面图标进入编辑/卸载模式）
 *   3. bindPinchZoom(el, {onZoom,onPan})   —— 双指捏合缩放 + 拖拽（用于相册大图查看）
 *   4. bindSwipe(el, {onSwipeLeft,onSwipeRight}) —— 左右滑动（相册切图、任务切换等）
 *
 * 所有函数都使用 passive listener（尽量不 preventDefault，除非手势正在进行以避免页面滚动冲突）。
 */

/** 从屏幕左边缘（默认 20px 内）开始右滑超过阈值即触发返回 */
export function bindEdgeSwipeBack(el, onBack, { edgeWidth = 24, threshold = 80 } = {}) {
  let startX = null;
  let startY = null;
  let tracking = false;

  el.addEventListener(
    'touchstart',
    (e) => {
      const t = e.touches[0];
      if (t.clientX <= edgeWidth) {
        startX = t.clientX;
        startY = t.clientY;
        tracking = true;
      }
    },
    { passive: true }
  );

  el.addEventListener(
    'touchmove',
    (e) => {
      if (!tracking) return;
      const t = e.touches[0];
      const dx = t.clientX - startX;
      const dy = Math.abs(t.clientY - startY);
      if (dx > 10 && dy < 40) {
        el.style.transform = `translateX(${Math.min(dx, 200)}px)`;
        el.style.opacity = String(Math.max(1 - dx / 400, 0.5));
      }
    },
    { passive: true }
  );

  el.addEventListener('touchend', (e) => {
    if (!tracking) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - startX;
    el.style.transform = '';
    el.style.opacity = '';
    if (dx > threshold) onBack();
    tracking = false;
    startX = startY = null;
  });
}

/** 长按手势，超过 durationMs 未移动则触发 */
export function bindLongPress(el, onLongPress, durationMs = 500) {
  let timer = null;
  let moved = false;
  let startX = 0;
  let startY = 0;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  el.addEventListener(
    'touchstart',
    (e) => {
      moved = false;
      const t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      timer = setTimeout(() => {
        if (!moved) {
          onLongPress(e);
          if (navigator.vibrate) navigator.vibrate(15);
        }
      }, durationMs);
    },
    { passive: true }
  );

  el.addEventListener(
    'touchmove',
    (e) => {
      const t = e.touches[0];
      if (Math.abs(t.clientX - startX) > 10 || Math.abs(t.clientY - startY) > 10) {
        moved = true;
        clear();
      }
    },
    { passive: true }
  );

  el.addEventListener('touchend', clear);
  el.addEventListener('touchcancel', clear);

  // 桌面端兼容：鼠标长按
  el.addEventListener('mousedown', (e) => {
    timer = setTimeout(() => onLongPress(e), durationMs);
  });
  el.addEventListener('mouseup', clear);
  el.addEventListener('mouseleave', clear);
}

/** 双指捏合缩放 + 单指拖拽平移，回调传出 scale / translateX / translateY */
export function bindPinchZoom(el, { onChange, minScale = 1, maxScale = 4 } = {}) {
  let scale = 1;
  let lastDist = null;
  let translateX = 0;
  let translateY = 0;
  let lastX = 0;
  let lastY = 0;
  let panning = false;

  function dist(touches) {
    const [a, b] = touches;
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  el.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length === 2) {
        lastDist = dist(e.touches);
      } else if (e.touches.length === 1 && scale > 1) {
        panning = true;
        lastX = e.touches[0].clientX;
        lastY = e.touches[0].clientY;
      }
    },
    { passive: true }
  );

  el.addEventListener(
    'touchmove',
    (e) => {
      if (e.touches.length === 2 && lastDist !== null) {
        const d = dist(e.touches);
        const delta = d / lastDist;
        scale = Math.min(maxScale, Math.max(minScale, scale * delta));
        lastDist = d;
        onChange && onChange({ scale, translateX, translateY });
      } else if (e.touches.length === 1 && panning) {
        const dx = e.touches[0].clientX - lastX;
        const dy = e.touches[0].clientY - lastY;
        translateX += dx;
        translateY += dy;
        lastX = e.touches[0].clientX;
        lastY = e.touches[0].clientY;
        onChange && onChange({ scale, translateX, translateY });
      }
    },
    { passive: true }
  );

  el.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) lastDist = null;
    if (e.touches.length === 0) {
      panning = false;
      if (scale <= 1) {
        // 复位
        scale = 1;
        translateX = 0;
        translateY = 0;
        onChange && onChange({ scale, translateX, translateY });
      }
    }
  });

  return {
    reset() {
      scale = 1;
      translateX = 0;
      translateY = 0;
      onChange && onChange({ scale, translateX, translateY });
    },
  };
}

/** 左右滑动手势（用于相册切图等），要求水平位移显著大于垂直位移 */
export function bindSwipe(el, { onSwipeLeft, onSwipeRight, threshold = 50 } = {}) {
  let startX = null;
  let startY = null;

  el.addEventListener(
    'touchstart',
    (e) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    },
    { passive: true }
  );

  el.addEventListener('touchend', (e) => {
    if (startX === null) return;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = Math.abs(e.changedTouches[0].clientY - startY);
    if (Math.abs(dx) > threshold && dy < 60) {
      if (dx < 0) onSwipeLeft && onSwipeLeft();
      else onSwipeRight && onSwipeRight();
    }
    startX = startY = null;
  });
}
