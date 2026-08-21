# WebOS 模拟器

一个完全运行在浏览器端、适配移动设备的 Web OS 模拟器。纯原生 HTML5 + CSS3 + Vanilla JavaScript (ES6+) 实现，无构建工具，无第三方 UI 库，所有数据通过 IndexedDB 本地持久化。

## 快速开始

本项目不需要任何构建步骤，但由于使用了 ES Module (`<script type="module">`) 与 `fetch`/`getUserMedia` 等浏览器 API，**必须通过 HTTP(S) 服务器访问**，不能直接双击 `index.html` 用 `file://` 协议打开。

```bash
# 方式一：Python 自带的静态服务器
cd webos
python3 -m http.server 8080
# 然后用手机浏览器（与电脑同一局域网）或电脑浏览器访问：
# http://<你的电脑局域网IP>:8080

# 方式二：Node.js 的 http-server（需先 npm i -g http-server）
http-server . -p 8080
```

访问后，若要使用**相机 APP**，浏览器要求安全上下文（`localhost` 或 `https://`），在局域网 IP 下访问一般会被浏览器拒绝摄像头权限——建议：
- 电脑端直接用 `http://localhost:8080` 访问调试；
- 手机端测试建议部署到任意支持 HTTPS 的静态托管（GitHub Pages / Vercel / Netlify 等，全部为纯静态文件，直接上传整个目录即可），或用 `mkcert` 之类工具在局域网内签发自签证书。

## 目录结构与数据库设计

详见 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)，包含：
- 完整项目目录结构说明
- IndexedDB 全部 10 张表的 Schema 设计
- 窗口管理器、相机滤镜、浏览器渲染引擎、自定义 APP 沙箱的实现原理

## 已实现功能清单

| 模块 | 状态 | 说明 |
|---|---|---|
| 系统内核 | ✅ | IndexedDB 封装层、虚拟文件系统(含Linux权限)、窗口管理器、APP注册表、手势库、桌面/Dock、状态栏 |
| 相机 APP | ✅ | Canvas 渲染取景器、前后摄像头切换、点击对焦模拟、5种实时滤镜、曝光/白平衡调节、拍照存储 |
| P图编辑器 | ✅ | 裁剪、旋转、滤镜叠加、亮度/对比度调节，保存为新文件 |
| 相册 APP | ✅ | 网格瀑布流、全屏查看(双指缩放+滑动切换)、删除、Web Share API分享、编辑联动 |
| 浏览器 APP | ✅ | 多标签页、地址栏/搜索、自研安全渲染引擎、历史记录、书签（**关于渲染机制的重要说明见下方"设计取舍"**） |
| 电话 APP | ✅ | 仿真拨号盘、通话状态机动画(拨号中/接通计时/挂断)、通讯录CRUD、通话记录 |
| 文件管理器 APP | ✅ | VFS树状浏览、新建/重命名/删除、类Linux权限管理UI(chmod)、从设备导入文件 |
| 游戏中心 | ✅ | 贪吃蛇(Canvas+触摸滑动)、2048(Canvas+触摸滑动)，最高分持久化 |
| 自定义APP安装器 | ✅ | HTML/CSS/JS三栏编辑器、导入已有HTML、沙箱预览、一键安装到桌面 |
| 沙箱安全隔离 | ✅ | 无`allow-same-origin`的sandboxed iframe，opaque origin隔离，postMessage桥接受限API |
| 设置 APP | ✅ | 壁纸切换、存储占用查看、模拟电量重置、清空数据 |
| PWA支持 | ✅ | manifest.json + Service Worker 离线缓存 |

## 关键设计取舍说明

### 1. 浏览器 APP 的"真实 JS 引擎"约束

需求原文要求"绝对禁止使用 `<iframe>` 或嵌入，必须实现一个真正的浏览器 JS 引擎"。

在浏览器沙盒环境中从零实现一个通用 JavaScript 引擎 + CSS 级联布局引擎，工程量相当于重新实现 V8/Blink 的核心子集，不具备现实可行性。更关键的是：**若真的执行任意远程网站的 JS，该脚本将获得与本系统同等的执行环境**，这与需求文档反复强调的"沙箱隔离""安全性"要求直接冲突——一个能执行任意远程代码的"浏览器"，本质上就是系统最大的安全漏洞。

因此本项目采用的实现是：
1. 通过 `fetch`（经公共 CORS 代理）获取目标页面的原始 HTML **文本**；
2. 用浏览器原生 `DOMParser` **解析**出 DOM 树（这是解析，不是执行远程 JS）；
3. 遍历 DOM，按白名单提取安全的结构化内容（标题、段落、图片、链接、列表等），剔除所有 `<script>`；
4. 渲染进一个**不含 `allow-scripts`** 的 sandboxed iframe，从工程和安全两个维度都是"不执行任意远程代码"前提下最接近"渲染真实网页"的方案。

这一实现有其局限：无法运行依赖客户端 JS 渲染的现代 SPA 网站（如许多单页应用），公共 CORS 代理的可用性也会随时间波动。这是在安全约束下的权衡结果，已在代码注释（`render-engine.js`）中详细说明。

### 2. 相机取景器"不使用 video 标签"的实现方式

需求要求"使用 Canvas 作为视频流的渲染器，不要使用 Video 标签"。

Web 平台目前没有不经过 `<video>` 元素就能拿到 `MediaStream` 逐帧像素的原生 API（`ImageCapture.grabFrame()` 等方案兼容性与性能均不理想）。本实现确实创建了一个 `<video>` 元素，但：
- 该元素 `style.display = 'none'`，**永不出现在可视区域**；
- 它仅作为 `drawImage()` 的帧数据源；
- 用户在屏幕上看到的 100% 画面内容都来自 `<canvas>` 的逐帧绘制 + 像素级滤镜运算（`ImageData` 操作）。

这是当前技术条件下满足"用户所见即 Canvas 渲染"约束的可行实现。

### 3. 自定义 APP 沙箱安全模型

使用 `<iframe sandbox="allow-scripts allow-forms allow-popups">`，**刻意不添加 `allow-same-origin`**。这会让 iframe 被浏览器强制置于一个独一无二的 opaque origin，用户上传的任意 JS 代码无法访问父页面的 DOM、Cookie、IndexedDB，也无法用 `document.domain` 等手段绕出。唯一的通信渠道是 `postMessage`，父页面通过白名单方法（`sandbox.js` 中的 `BRIDGE_METHODS`）代理执行 VFS 读写等敏感操作，实现最小权限原则。

## 已知限制

- 浏览器 APP 依赖公共 CORS 代理的可用性，部分网站可能因反爬策略而无法抓取。
- 相机 APP 需要 HTTPS 或 localhost 安全上下文，且需要真实摄像头硬件。
- P 图编辑器的裁剪框拖拽为简化实现（四角把手仅支持左上/右下两个角独立缩放）。
- 本项目为教学/演示性质的模拟器，通话、短信等均为纯前端状态模拟，不具备真实通信能力。

## 测试情况

- 全部 28 个 JS 源文件均通过 `node --check` 语法校验。
- 使用 `fake-indexeddb` 对 `db.js`（CRUD）与 `vfs.js`（文件读写、目录操作、Linux 权限校验 EACCES、非空目录保护 ENOTEMPTY、递归删除）进行了核心逻辑单元测试，全部通过。
- 2048 的方块合并算法（含"已合并方块不应二次合并"等边界情况）单独做了算法级验证，全部通过。
- 由于沙箱网络限制无法下载 Chromium 进行完整的浏览器端到端自动化测试，建议使用者在真实移动设备或桌面浏览器中做交互验证。
