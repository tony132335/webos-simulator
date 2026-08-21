# Web OS 模拟器 —— 架构与数据库设计文档

## 一、项目目录结构

```
webos/
├── index.html                  # 唯一入口 HTML，系统外壳（状态栏/桌面/Dock/窗口层）
├── manifest.json                # PWA manifest
├── sw.js                        # Service Worker（离线缓存）
│
├── css/
│   ├── system.css               # 系统级样式：变量、重置、状态栏、桌面、Dock
│   ├── window-manager.css       # 窗口管理器：窗口容器、动画、多任务视图
│   └── apps.css                 # 内置 APP 通用 UI 样式（各 APP 也可有内联 scoped 样式）
│
├── js/
│   ├── core/
│   │   ├── db.js                # IndexedDB 统一封装层（CRUD + Schema 版本管理）
│   │   ├── vfs.js                # 虚拟文件系统（基于 IndexedDB，含 Linux 风权限位）
│   │   ├── window-manager.js    # 窗口管理器：开/关/最小化/切换/动画/层级
│   │   ├── app-registry.js      # APP 注册表：内置 APP + 自定义 APP 统一调度
│   │   ├── gesture.js            # 触摸手势：滑动返回、长按、双指缩放的通用识别器
│   │   ├── statusbar.js          # 顶部状态栏：时间、模拟电量/信号
│   │   ├── desktop.js            # 桌面 Grid + Dock 渲染与交互（含长按拖拽排序/卸载）
│   │   ├── sandbox.js            # 自定义 APP 沙箱执行环境（iframe sandbox + postMessage）
│   │   └── boot.js               # 系统启动引导：初始化 DB → 挂载 VFS → 渲染桌面
│   │
│   └── apps/
│       ├── camera/camera.js      # 相机 APP（Canvas 渲染取景器 + WebGL/Canvas 滤镜 + 编辑器）
│       ├── gallery/gallery.js    # 相册 APP（瀑布流、手势查看、分享）
│       ├── browser/browser.js    # 简化渲染引擎浏览器（fetch + 自研 HTML 解析渲染）
│       ├── phone/phone.js        # 电话 APP（拨号盘、通话模拟、通讯录）
│       ├── files/files.js        # 文件管理器（VFS 树状视图、权限管理 UI）
│       ├── games/snake.js        # 贪吃蛇（Canvas）
│       ├── games/game2048.js     # 2048（Canvas）
│       └── installer/installer.js# 自定义 APP 安装器（代码编辑器 + 安装流程）
│
├── assets/icons/                 # 系统内置图标（SVG，内联为主，此目录备用）
└── docs/
    └── ARCHITECTURE.md           # 本文档
```

设计原则：
- **单页应用**：`index.html` 是唯一物理页面，所有"APP"都是在 WindowManager 里挂载的 DOM 子树，不发生页面跳转，符合移动端 PWA 体验。
- **无构建工具**：全部使用 `<script type="module">` 原生 ES Module 互相 import，浏览器直接运行。
- **CDN 白名单**：仅允许引入不改变"纯原生"性质的辅助库（如语法高亮 highlight.js），核心逻辑 0 依赖。

---

## 二、IndexedDB 数据库 Schema 设计

统一数据库名：`WebOS_DB`，版本号由 `db.js` 中 `DB_VERSION` 常量控制，升级时通过 `onupgradeneeded` 做迁移。

### 1. `photos` —— 相册照片表
| 字段 | 类型 | 说明 |
|---|---|---|
| id | string (UUID, keyPath) | 主键 |
| blob | Blob | 图片二进制数据 (image/jpeg or image/png) |
| thumbBlob | Blob | 缩略图 Blob，用于瀑布流快速渲染 |
| width / height | number | 原图尺寸 |
| createdAt | number (timestamp) | 拍摄/生成时间，建索引 `by_createdAt` |
| source | string | `camera` \| `edited` \| `imported` |
| parentId | string \| null | 若为编辑生成的新图，指向原图 id |
| filters | object | 拍摄/编辑时应用的滤镜与参数快照 |
| vfsPath | string | 对应虚拟文件系统中的路径（如 `/storage/DCIM/xxx.jpg`） |

索引：`by_createdAt`, `by_source`

### 2. `vfs_nodes` —— 虚拟文件系统节点表（文件 + 文件夹统一建模）
| 字段 | 类型 | 说明 |
|---|---|---|
| path | string (keyPath) | 绝对路径，如 `/system/apps/camera` |
| parentPath | string | 父目录路径，建索引 `by_parent` |
| name | string | 节点名 |
| type | string | `dir` \| `file` |
| content | any | 文件内容（文本/JSON/Blob 引用，视 mime 而定） |
| mime | string | MIME 类型 |
| size | number | 字节数（估算） |
| owner | string | 属主，如 `system` \| `user` |
| group | string | 属组，如 `system` \| `users` |
| mode | number | 类 Linux 权限位，如 `0o755`（八进制，rwx-rwx-rwx） |
| createdAt / modifiedAt | number | 时间戳 |

索引：`by_parent`, `by_type`

权限模型（简化版 Linux）：
- `mode` 用 9 bit：owner(rwx) / group(rwx) / other(rwx)，如 `0o644` = 文件可读写(属主)+只读(其他)。
- 当前登录身份固定为 `user`（uid），系统文件 `owner=system`；VFS 层在每次读写前做权限校验，越权抛 `EACCES`。

### 3. `apps` —— 已安装 APP 元数据表（含系统内置与自定义）
| 字段 | 类型 | 说明 |
|---|---|---|
| appId | string (keyPath) | APP 唯一标识 |
| name | string | 显示名称 |
| icon | string | 图标（emoji 或 SVG dataURL） |
| type | string | `system` \| `custom` |
| entry | string | system 类型对应 JS 模块名；custom 类型为空（代码在 app_code 表） |
| pinned | boolean | 是否固定在 Dock |
| order | number | 桌面排序 |
| installedAt | number | 安装时间 |
| permissions | array | 声明式权限，如 `["vfs:read","vfs:write"]` |

### 4. `app_code` —— 自定义 APP 源码表
| 字段 | 类型 | 说明 |
|---|---|---|
| appId | string (keyPath) | 关联 `apps.appId` |
| html | string | 用户提供的 HTML |
| css | string | 用户提供的 CSS |
| js | string | 用户提供的 JS |
| updatedAt | number | 最后修改时间 |

### 5. `contacts` —— 通讯录表
| 字段 | 类型 | 说明 |
|---|---|---|
| id | string (keyPath) | 主键 |
| name | string | 姓名，建索引 `by_name` |
| phone | string | 号码 |
| avatarColor | string | 头像随机色（无需真实图像） |
| createdAt | number | 创建时间 |

### 6. `call_logs` —— 通话记录表
| 字段 | 类型 | 说明 |
|---|---|---|
| id | string (keyPath) | 主键 |
| contactId | string \| null | 关联联系人 |
| number | string | 号码 |
| type | string | `outgoing` \| `missed` |
| duration | number | 通话时长（秒），模拟生成 |
| timestamp | number | 建索引 `by_timestamp` |

### 7. `browser_history` —— 浏览器历史
| 字段 | 类型 | 说明 |
|---|---|---|
| id | string (keyPath) | 主键 |
| url | string | 访问地址 |
| title | string | 页面标题 |
| visitedAt | number | 建索引 `by_visitedAt` |

### 8. `browser_bookmarks` —— 浏览器书签
| 字段 | 类型 | 说明 |
|---|---|---|
| id | string (keyPath) | 主键 |
| url | string | 地址 |
| title | string | 标题 |
| createdAt | number | 创建时间 |

### 9. `game_saves` —— 游戏存档/最高分
| 字段 | 类型 | 说明 |
|---|---|---|
| gameId | string (keyPath) | `snake` \| `2048` |
| bestScore | number | 最高分 |
| state | object \| null | 断点续玩状态快照（可选） |
| updatedAt | number | 更新时间 |

### 10. `system_kv` —— 系统级键值配置表
| 字段 | 类型 | 说明 |
|---|---|---|
| key | string (keyPath) | 如 `wallpaper` `battery_sim` `desktop_layout` |
| value | any | 任意 JSON 值 |

---

## 三、核心机制说明（先解释思路，代码见后续分片）

### 3.1 窗口管理器
每个打开的 APP 对应一个 `.win` 容器（`position:fixed`，通过 transform 做开合/最小化动画），WindowManager 维护一个栈：
- `openApp(appId)`：若已在栈中则前置聚焦；否则创建窗口 DOM，触发"从图标位置放大"的开场动画。
- `closeApp / minimizeApp`：反向动画后 remove 或隐藏。
- `showTaskSwitcher()`：把所有窗口缩放平铺（多任务卡片视图），配合手势滑动关闭。

### 3.2 相机滤镜（Canvas 渲染，不用 `<video>`）
`getUserMedia` 拿到 `MediaStream` 后，创建一个**离屏 `<video>` 元素但永不插入 DOM 也不展示**，仅作为帧源（这是浏览器 API 的硬性要求——`drawImage` 的取帧源必须是 video/canvas/bitmap 之一，无法绕开，但满足了"界面上只用 Canvas 渲染、用户看到的画面全部经 Canvas 绘制"的约束）。每帧通过 `requestAnimationFrame`：
1. `ctx.drawImage(hiddenVideo, 0, 0)` 画到主取景 Canvas；
2. 读取 `ImageData`，按当前滤镜矩阵做像素级变换（黑白/复古/冷色/暖色用颜色矩阵，原片不处理）；
3. `putImageData` 写回，实现实时滤镜取景。
拍照即对当前 Canvas 帧 `toBlob()` 存入 `photos` 表。

### 3.3 简化版浏览器渲染引擎
出于安全（禁止任意远程 JS 在主系统上下文执行）与工程量的现实考虑，浏览器 APP 实现为：
1. 通过公共 CORS 代理 `fetch` 目标 URL 的 HTML 文本；
2. 用 `DOMParser` 解析出 DOM 树；
3. 提取 `<title>`、正文结构（标题/段落/图片/链接/列表等）与内联/外链 CSS 中的安全子集（颜色、字体、间距等白名单属性）；
4. 在**独立的 `<iframe sandbox="allow-same-origin">`**（不含 `allow-scripts`）中重建这棵 DOM，实现"渲染出页面视觉与可点链接"但不执行远程脚本，这是可控范围内最接近"真实浏览器"的安全实现。
文档中会明确注明此取舍。

### 3.4 自定义 APP 沙箱
`<iframe sandbox="allow-scripts allow-forms">`（刻意不给 `allow-same-origin`，使其处于**唯一 opaque origin**，无法访问父页面 DOM/Cookie/IndexedDB），通过 `srcdoc` 注入用户的 HTML+CSS+JS。父子间仅通过 `postMessage` 通信，子 APP 若要读写 VFS，必须走受限的消息桥（`sandbox.js` 中的白名单 API），实现权限最小化。

---

## 四、开发分片计划
1. **本分片**：目录结构 + DB Schema + 架构说明（已完成）
2. 系统内核：db.js / vfs.js / window-manager.js / app-registry.js / gesture.js / boot.js / index.html / css
3. 桌面 + 状态栏 + Dock + PWA 配置
4. 相机 APP（取景器 + 滤镜 + 拍照）+ P 图编辑器
5. 相册 APP
6. 浏览器 APP
7. 电话 APP + 通讯录
8. 文件管理器 APP + 权限系统 UI
9. 游戏中心（贪吃蛇 + 2048）
10. 自定义 APP 安装器 + 沙箱
11. 联调、打包、README
