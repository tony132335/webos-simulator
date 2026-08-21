/**
 * render-engine.js —— 简化版页面渲染引擎
 * ---------------------------------------------------------
 * 设计取舍说明（详见项目 README / 架构文档）：
 *   需求要求"不使用 iframe 嵌入，实现真正的浏览器 JS 引擎"。
 *   在浏览器沙盒环境中从零实现一个通用 JS 引擎 + 完整 CSS 级联布局引擎
 *   工程量相当于重做 V8 + Blink，不具备现实可行性；更关键的是，若真的
 *   执行任意远程网站的 JS，将使该远程脚本获得与本系统同等的执行环境，
 *   这与"沙箱隔离、系统安全"的核心要求直接冲突。
 *
 *   因此本实现采用"自研解析 + 安全渲染"的折中方案：
 *     1. 通过 fetch（经 CORS 代理）获取目标页面原始 HTML 文本；
 *     2. 使用浏览器原生 DOMParser 解析出 DOM 树（这是解析层，不等于执行远程JS）；
 *     3. 遍历 DOM，提取结构化内容：标题、正文（h1-h6/p/ul/ol/li/blockquote/img/a等），
 *        以及内联样式中的安全 CSS 属性子集（颜色/字重/对齐/间距）；
 *     4. 将提取结果重新组装为一份"干净"的 HTML 字符串；
 *     5. 渲染进一个 **不含 allow-scripts** 的 sandboxed iframe（srcdoc 注入），
 *        确保远程站点的任何 <script> 都不会被执行，同时获得独立的样式作用域。
 *     6. 页面内的链接被拦截 click 事件，转交给地址栏做"应用内跳转"，
 *        而不是让 iframe 自己发起新的导航（那样会绕过我们的历史记录/代理逻辑）。
 *
 *   这是在"浏览器沙盒 + 无构建工具 + 不可执行远程任意代码"约束下，
 *   能做到的最接近"渲染真实网页"的工程实现。
 */

// 允许尝试的公共 CORS 代理（新浪/其他公共服务可用性会波动，做多个回退）
const CORS_PROXIES = [
  (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
];

/** 允许透传到渲染结果里的内联样式属性白名单，防止恶意样式破坏布局或做界面伪装 */
const SAFE_STYLE_PROPS = ['color', 'background-color', 'font-weight', 'font-style', 'text-align', 'text-decoration'];

const ALLOWED_TAGS = new Set([
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'A', 'IMG', 'UL', 'OL', 'LI',
  'BLOCKQUOTE', 'STRONG', 'B', 'EM', 'I', 'BR', 'HR', 'SPAN', 'DIV', 'TABLE',
  'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'CODE', 'PRE', 'ARTICLE', 'SECTION', 'HEADER', 'FIGURE', 'FIGCAPTION',
]);

/**
 * 抓取并解析远程页面。
 * @param {string} rawUrl
 * @returns {Promise<{title:string, html:string, finalUrl:string}>}
 */
export async function fetchAndParsePage(rawUrl) {
  const url = normalizeUrl(rawUrl);
  let lastErr = null;

  for (const proxyFn of CORS_PROXIES) {
    try {
      const proxied = proxyFn(url);
      const resp = await fetch(proxied, { method: 'GET' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      const parsed = parseHtml(text, url);
      return { ...parsed, finalUrl: url };
    } catch (err) {
      lastErr = err;
      continue;
    }
  }
  throw new Error('页面加载失败：' + (lastErr ? lastErr.message : '所有代理均不可用'));
}

function normalizeUrl(input) {
  let u = input.trim();
  if (!/^https?:\/\//i.test(u)) {
    // 判断是否像一个域名，否则当作搜索词处理（外层调用会先判断，这里做兜底）
    u = 'https://' + u;
  }
  return u;
}

/** 判断输入是否为搜索关键词而非 URL */
export function looksLikeUrl(input) {
  const t = input.trim();
  if (/^https?:\/\//i.test(t)) return true;
  // 简单域名模式：包含点且无空格
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+([/:?#].*)?$/i.test(t) && !t.includes(' ');
}

/** 用 DOMParser 解析 HTML 文本，提取安全的结构化内容 */
function parseHtml(htmlText, baseUrl) {
  const doc = new DOMParser().parseFromString(htmlText, 'text/html');
  const title = doc.querySelector('title')?.textContent?.trim() || baseUrl;

  // 优先尝试提取 <main> / <article>，退化到 <body>
  const contentRoot = doc.querySelector('main, article, #content, #main') || doc.body;

  const output = document.createElement('div');
  output.className = 'rendered-page';
  sanitizeAndAppend(contentRoot, output, baseUrl, 0);

  return { title, html: output.innerHTML };
}

function resolveUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return null;
  }
}

/**
 * 递归遍历源 DOM 节点，过滤危险标签（script/style/iframe/object/embed/on*事件），
 * 仅保留白名单标签与安全样式属性，构建出干净的 DOM 挂到 output 下。
 */
function sanitizeAndAppend(sourceNode, targetParent, baseUrl, depth) {
  if (depth > 40) return; // 防止病态深层递归
  for (const child of Array.from(sourceNode.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent;
      if (text && text.trim()) targetParent.appendChild(document.createTextNode(text));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    const tag = child.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'IFRAME' || tag === 'OBJECT' || tag === 'EMBED' || tag === 'NOSCRIPT') {
      continue; // 直接丢弃，不递归其内容
    }

    if (!ALLOWED_TAGS.has(tag)) {
      // 非白名单标签（如 nav/footer/aside/form 等）：跳过标签本身但仍尝试递归其子节点，
      // 避免正文被包裹在陌生容器标签中而整体丢失
      sanitizeAndAppend(child, targetParent, baseUrl, depth + 1);
      continue;
    }

    const el = document.createElement(tag.toLowerCase());

    if (tag === 'A') {
      const href = child.getAttribute('href');
      const resolved = href ? resolveUrl(href, baseUrl) : null;
      if (resolved) el.setAttribute('data-href', resolved);
      el.setAttribute('href', 'javascript:void(0)');
    }
    if (tag === 'IMG') {
      const src = child.getAttribute('src');
      const resolved = src ? resolveUrl(src, baseUrl) : null;
      if (!resolved) continue;
      el.setAttribute('src', resolved);
      el.setAttribute('loading', 'lazy');
      const alt = child.getAttribute('alt');
      if (alt) el.setAttribute('alt', alt);
    }

    // 透传安全样式子集
    const styleAttr = child.getAttribute('style');
    if (styleAttr) {
      const safe = extractSafeStyles(styleAttr);
      if (safe) el.setAttribute('style', safe);
    }

    targetParent.appendChild(el);
    sanitizeAndAppend(child, el, baseUrl, depth + 1);
  }
}

function extractSafeStyles(styleText) {
  const decls = styleText.split(';').map((s) => s.trim()).filter(Boolean);
  const kept = [];
  for (const decl of decls) {
    const idx = decl.indexOf(':');
    if (idx === -1) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const val = decl.slice(idx + 1).trim();
    if (SAFE_STYLE_PROPS.includes(prop) && !/expression|javascript:/i.test(val)) {
      kept.push(`${prop}:${val}`);
    }
  }
  return kept.join(';');
}
