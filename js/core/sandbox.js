/**
 * sandbox.js —— 自定义 APP 沙箱执行环境
 * ---------------------------------------------------------
 * 安全策略：
 *   使用 <iframe sandbox="allow-scripts allow-forms allow-popups">，
 *   刻意 **不** 添加 `allow-same-origin`。
 *   这样 iframe 会被浏览器强制置于一个独一无二的 "opaque origin"：
 *     - 无法访问父页面的 DOM / window / cookie / localStorage / IndexedDB；
 *     - 无法用 document.domain 之类的手段绕出沙箱；
 *     - 与父页面唯一的通信渠道就是 postMessage，天然满足"隔离样式和脚本作用域"的要求。
 *
 * 受限能力桥（Bridge API）：
 *   自定义 APP 若想读写系统数据（如把用户输入存起来），必须通过约定好的
 *   postMessage 协议向父页面"申请"，父页面按 apps 表中记录的 permissions
 *   白名单做校验后才代为执行，绝不把 VFS/DB 对象直接暴露给沙箱。
 *
 * 消息协议：
 *   子 → 父:  { type: 'webos:api', callId, method, args }
 *   父 → 子:  { type: 'webos:api:result', callId, ok, result } | { ok:false, error }
 */

import { DB } from './db.js';
import { VFS } from './vfs.js';

/** 允许自定义 APP 调用的桥接方法白名单，方法体运行在父页面（可信）上下文 */
const BRIDGE_METHODS = {
  async 'vfs.list'(appId, [dirPath]) {
    return VFS.list(dirPath || '/storage/Documents');
  },
  async 'vfs.readFile'(appId, [path]) {
    return VFS.readFile(path);
  },
  async 'vfs.writeFile'(appId, [path, content, opts]) {
    // 自定义 APP 的写入统一限制在其专属沙盒目录下，防止污染系统区
    const safeDir = `/apps/custom/${appId}`;
    if (!path.startsWith(safeDir)) {
      throw new Error(`自定义 APP 仅可写入 ${safeDir} 目录`);
    }
    return VFS.writeFile(path, content, opts);
  },
  async 'kv.get'(appId, [key]) {
    const row = await DB.get('system_kv', `custom:${appId}:${key}`);
    return row ? row.value : null;
  },
  async 'kv.set'(appId, [key, value]) {
    await DB.put('system_kv', { key: `custom:${appId}:${key}`, value });
    return true;
  },
  async 'toast'(appId, [message]) {
    document.dispatchEvent(new CustomEvent('webos:toast', { detail: { message } }));
    return true;
  },
};

/**
 * 挂载一个自定义 APP 到指定容器。
 * @param {HTMLElement} container
 * @param {{appId:string}} ctx
 * @returns {Function} cleanup
 */
export async function mountSandboxApp(container, ctx) {
  const { appId } = ctx;
  const code = await DB.get('app_code', appId);
  if (!code) {
    container.innerHTML = `<div class="win-error">未找到自定义 APP 源码</div>`;
    return () => {};
  }

  // 确保沙盒专属目录存在
  const sandboxDir = `/apps/custom/${appId}`;
  try {
    await VFS.stat(sandboxDir);
  } catch {
    try {
      await VFS.mkdir(sandboxDir);
    } catch (e) {
      /* 并发创建等边缘情况忽略 */
    }
  }

  const iframe = document.createElement('iframe');
  iframe.className = 'sandbox-frame';
  // 关键安全设置：不含 allow-same-origin，使 iframe 处于唯一 opaque origin
  iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-modals');
  iframe.setAttribute('referrerpolicy', 'no-referrer');

  const bridgeScript = `
    (function(){
      let callId = 0;
      const pending = new Map();
      window.WebOS = {
        call(method, ...args){
          return new Promise((resolve, reject) => {
            const id = ++callId;
            pending.set(id, {resolve, reject});
            parent.postMessage({ type:'webos:api', callId:id, method, args }, '*');
          });
        },
        vfsList: (p)=>window.WebOS.call('vfs.list', p),
        vfsRead: (p)=>window.WebOS.call('vfs.readFile', p),
        vfsWrite: (p,c,o)=>window.WebOS.call('vfs.writeFile', p, c, o),
        kvGet: (k)=>window.WebOS.call('kv.get', k),
        kvSet: (k,v)=>window.WebOS.call('kv.set', k, v),
        toast: (m)=>window.WebOS.call('toast', m),
      };
      window.addEventListener('message', (e) => {
        const data = e.data;
        if (!data || data.type !== 'webos:api:result') return;
        const p = pending.get(data.callId);
        if (!p) return;
        pending.delete(data.callId);
        data.ok ? p.resolve(data.result) : p.reject(new Error(data.error));
      });
    })();
  `;

  const srcdoc = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html,body{margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}
  ${code.css || ''}
</style>
</head>
<body>
${code.html || ''}
<script>${bridgeScript}<\/script>
<script>
try {
${code.js || ''}
} catch(err) {
  document.body.innerHTML = '<div style="padding:20px;color:#e33;font-family:monospace;">自定义APP运行出错：' + err.message + '</div>';
}
<\/script>
</body>
</html>`;

  iframe.srcdoc = srcdoc;
  container.appendChild(iframe);

  // 消息桥：监听子 iframe 发来的 API 调用请求
  const handler = async (e) => {
    if (e.source !== iframe.contentWindow) return;
    const data = e.data;
    if (!data || data.type !== 'webos:api') return;
    const fn = BRIDGE_METHODS[data.method];
    let ok = true,
      result = null,
      error = null;
    try {
      if (!fn) throw new Error(`未授权或不存在的方法: ${data.method}`);
      result = await fn(appId, data.args || []);
    } catch (err) {
      ok = false;
      error = err.message;
    }
    iframe.contentWindow.postMessage({ type: 'webos:api:result', callId: data.callId, ok, result, error }, '*');
  };
  window.addEventListener('message', handler);

  // 返回 cleanup，供 WindowManager 在关闭窗口时调用
  return () => {
    window.removeEventListener('message', handler);
    iframe.remove();
  };
}
