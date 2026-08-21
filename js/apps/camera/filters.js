/**
 * filters.js —— 图像滤镜引擎（像素级颜色矩阵变换）
 * ---------------------------------------------------------
 * 供相机取景实时预览、拍照后处理、相册 P 图编辑器共用。
 * 所有滤镜都基于 Canvas 2D 的 ImageData 做逐像素运算，不依赖 WebGL，
 * 兼容性更好；在移动端中等分辨率（如 720p 取景）下性能可接受。
 *
 * 每个滤镜是一个函数 (data:Uint8ClampedArray, params:object) => void，
 * 原地修改 RGBA 数组，避免额外内存分配。
 */

export const FILTER_LIST = [
  { id: 'normal', name: '原片' },
  { id: 'mono', name: '黑白' },
  { id: 'vintage', name: '复古' },
  { id: 'cool', name: '冷色' },
  { id: 'warm', name: '暖色' },
];

function clamp(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

const FILTER_FN = {
  normal(data) {
    // 不做处理
  },
  mono(data) {
    for (let i = 0; i < data.length; i += 4) {
      const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      data[i] = data[i + 1] = data[i + 2] = gray;
    }
  },
  vintage(data) {
    // 复古：降低饱和度、叠加暖褐色调、轻微暗角由调用方在 canvas 层处理
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      data[i] = clamp(r * 0.393 + g * 0.769 + b * 0.189);
      data[i + 1] = clamp(r * 0.349 + g * 0.686 + b * 0.168);
      data[i + 2] = clamp(r * 0.272 + g * 0.534 + b * 0.131);
    }
  },
  cool(data) {
    // 冷色：提升蓝色通道，压低红色通道
    for (let i = 0; i < data.length; i += 4) {
      data[i] = clamp(data[i] * 0.9);
      data[i + 2] = clamp(data[i + 2] * 1.15 + 8);
    }
  },
  warm(data) {
    // 暖色：提升红/黄，压低蓝色通道
    for (let i = 0; i < data.length; i += 4) {
      data[i] = clamp(data[i] * 1.15 + 10);
      data[i + 1] = clamp(data[i + 1] * 1.05);
      data[i + 2] = clamp(data[i + 2] * 0.85);
    }
  },
};

/**
 * 对 ImageData 应用指定滤镜 + 曝光/白平衡调节。
 * @param {ImageData} imageData
 * @param {string} filterId
 * @param {{exposure:number, warmth:number}} adjust  exposure: -100~100, warmth: -100~100
 */
export function applyFilter(imageData, filterId, adjust = { exposure: 0, warmth: 0 }) {
  const data = imageData.data;
  const fn = FILTER_FN[filterId] || FILTER_FN.normal;
  fn(data);

  const expFactor = 1 + (adjust.exposure || 0) / 100;
  const warmShift = (adjust.warmth || 0) / 100;

  if (expFactor !== 1 || warmShift !== 0) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = clamp(data[i] * expFactor + warmShift * 12);
      data[i + 1] = clamp(data[i + 1] * expFactor);
      data[i + 2] = clamp(data[i + 2] * expFactor - warmShift * 12);
    }
  }
  return imageData;
}

/** 亮度/对比度调节（用于 P 图编辑器），brightness/contrast 范围 -100~100 */
export function applyBrightnessContrast(imageData, brightness = 0, contrast = 0) {
  const data = imageData.data;
  const b = brightness * 2.55; // 映射到 -255~255
  const c = (259 * (contrast + 255)) / (255 * (259 - contrast));
  for (let i = 0; i < data.length; i += 4) {
    data[i] = clamp(c * (data[i] - 128) + 128 + b);
    data[i + 1] = clamp(c * (data[i + 1] - 128) + 128 + b);
    data[i + 2] = clamp(c * (data[i + 2] - 128) + 128 + b);
  }
  return imageData;
}

/** 生成缩略图 Blob（用于相册瀑布流快速加载） */
export function makeThumbnail(canvas, maxSize = 320) {
  const ratio = Math.min(1, maxSize / Math.max(canvas.width, canvas.height));
  const tw = Math.round(canvas.width * ratio);
  const th = Math.round(canvas.height * ratio);
  const tCanvas = document.createElement('canvas');
  tCanvas.width = tw;
  tCanvas.height = th;
  const ctx = tCanvas.getContext('2d');
  ctx.drawImage(canvas, 0, 0, tw, th);
  return new Promise((resolve) => tCanvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.7));
}
