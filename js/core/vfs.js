/**
 * vfs.js —— 虚拟文件系统（Virtual File System）
 * ---------------------------------------------------------
 * 基于 IndexedDB 的 `vfs_nodes` 表实现一棵"类 Unix"文件树。
 * 系统的核心代码、APP 配置、用户文档、照片索引等，最终都以节点形式
 * 挂在这棵树上，文件管理器 APP 直接读写这棵树，实现"系统核心代码存于 VFS"的要求。
 *
 * 权限模型（简化版 Linux）：
 *  - 每个节点有 owner（属主）、group（属组）、mode（9bit 权限位，八进制表示，如 0o755）。
 *  - 当前会话身份固定为 uid = 'user'，属于 group 'users'；系统身份为 uid = 'system'。
 *  - mode 三段：owner段 / group段 / other段，每段 r(4) w(2) x(1)。
 *  - 校验规则：
 *      若 currentUser === node.owner            → 用 owner 段
 *      否则若 currentUser 所在 group === node.group → 用 group 段
 *      否则                                      → 用 other 段
 *  - 权限不足时抛出 VFSError('EACCES', ...)。
 */

import { DB } from './db.js';

// 当前登录身份（模拟单用户系统，固定为 user；系统进程以 system 身份写入只读区）
export const CURRENT_UID = 'user';
export const CURRENT_GID = 'users';

export class VFSError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'ENOENT' | 'EEXIST' | 'EACCES' | 'ENOTEMPTY' | 'EISDIR' | 'ENOTDIR'
    this.name = 'VFSError';
  }
}

function normalizePath(p) {
  if (!p.startsWith('/')) p = '/' + p;
  // 去除多余斜杠、处理 .. 等（简化：仅折叠连续斜杠）
  return p.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

function parentOf(p) {
  const norm = normalizePath(p);
  if (norm === '/') return null;
  const idx = norm.lastIndexOf('/');
  return idx === 0 ? '/' : norm.slice(0, idx);
}

function nameOf(p) {
  const norm = normalizePath(p);
  if (norm === '/') return '/';
  return norm.slice(norm.lastIndexOf('/') + 1);
}

/** 权限位转字符串，如 rwxr-xr-- ，用于文件管理器 UI 展示 */
export function modeToString(mode, type) {
  const bits = mode.toString(8).padStart(3, '0').split('').map(Number);
  const chars = bits.map((b) => (b & 4 ? 'r' : '-') + (b & 2 ? 'w' : '-') + (b & 1 ? 'x' : '-'));
  return (type === 'dir' ? 'd' : '-') + chars.join('');
}

/** 校验当前用户对某节点是否具备所需权限（'r' | 'w' | 'x'） */
function checkPermission(node, need) {
  const bitFor = need === 'r' ? 4 : need === 'w' ? 2 : 1;
  let segment;
  if (CURRENT_UID === node.owner) {
    segment = (node.mode >> 6) & 7;
  } else if (CURRENT_GID === node.group) {
    segment = (node.mode >> 3) & 7;
  } else {
    segment = node.mode & 7;
  }
  if (!(segment & bitFor)) {
    throw new VFSError('EACCES', `权限不足：无法对 ${node.path} 执行 "${need}" 操作`);
  }
}

class VirtualFileSystem {
  constructor() {
    this._initialized = false;
  }

  /**
   * 初始化文件系统：若根目录不存在，则建立系统默认目录骨架。
   * 目录结构参考 Linux FHS 简化版：
   *   /system        （只读，system:system 0o755，存放系统核心"代码"占位说明）
   *   /system/apps   （只读，各内置 APP 的元信息占位文件）
   *   /storage        （用户可写，user:users 0o755）
   *   /storage/DCIM   （相册照片对应的虚拟路径）
   *   /storage/Documents
   *   /storage/Downloads（导入文件落地目录）
   *   /apps/custom    （自定义 APP 源码的虚拟挂载点，实际内容存 app_code 表，这里放清单）
   */
  async init() {
    if (this._initialized) return;
    const root = await DB.get('vfs_nodes', '/');
    if (!root) {
      await this._seedDefaultTree();
    }
    this._initialized = true;
  }

  async _seedDefaultTree() {
    const now = Date.now();
    const dirs = [
      { path: '/', name: '/', owner: 'system', group: 'system', mode: 0o755 },
      { path: '/system', name: 'system', owner: 'system', group: 'system', mode: 0o755 },
      { path: '/system/apps', name: 'apps', owner: 'system', group: 'system', mode: 0o755 },
      { path: '/apps', name: 'apps', owner: 'system', group: 'system', mode: 0o755 },
      { path: '/apps/custom', name: 'custom', owner: 'user', group: 'users', mode: 0o775 },
      { path: '/storage', name: 'storage', owner: 'user', group: 'users', mode: 0o755 },
      { path: '/storage/DCIM', name: 'DCIM', owner: 'user', group: 'users', mode: 0o755 },
      { path: '/storage/Documents', name: 'Documents', owner: 'user', group: 'users', mode: 0o755 },
      { path: '/storage/Downloads', name: 'Downloads', owner: 'user', group: 'users', mode: 0o755 },
    ];
    for (const d of dirs) {
      await DB.put('vfs_nodes', {
        path: d.path,
        parentPath: d.path === '/' ? null : parentOf(d.path),
        name: d.name,
        type: 'dir',
        content: null,
        mime: 'inode/directory',
        size: 0,
        owner: d.owner,
        group: d.group,
        mode: d.mode,
        createdAt: now,
        modifiedAt: now,
      });
    }
    // 写入几份"系统核心代码"的说明性只读文件，体现"系统代码存于 VFS"的要求
    await this._writeSystemReadme();
  }

  async _writeSystemReadme() {
    const now = Date.now();
    const readme = {
      path: '/system/README.md',
      parentPath: '/system',
      name: 'README.md',
      type: 'file',
      content:
        '# WebOS 系统说明\n\n本目录代表系统核心区（只读，owner=system）。\n' +
        '真实的可执行系统代码位于宿主页面的 /js/core 与 /js/apps 目录（浏览器同源静态资源），\n' +
        '此处的 vfs_nodes 记录用于在"文件管理器"APP 中可视化系统结构，并作为自定义 APP、\n' +
        '用户文档等运行时数据的统一存储与权限校验层。\n',
      mime: 'text/markdown',
      size: 0,
      owner: 'system',
      group: 'system',
      mode: 0o444, // 只读
      createdAt: now,
      modifiedAt: now,
    };
    readme.size = readme.content.length;
    await DB.put('vfs_nodes', readme);
  }

  /** 列出某目录下的直接子节点 */
  async list(dirPath) {
    const path = normalizePath(dirPath);
    const dir = await DB.get('vfs_nodes', path);
    if (!dir) throw new VFSError('ENOENT', `目录不存在: ${path}`);
    if (dir.type !== 'dir') throw new VFSError('ENOTDIR', `不是目录: ${path}`);
    checkPermission(dir, 'r');
    const children = await DB.getAllByIndex('vfs_nodes', 'by_parent', path);
    return children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  }

  /** 读取节点元信息（不判权限，用于内部展示） */
  async stat(path) {
    const node = await DB.get('vfs_nodes', normalizePath(path));
    if (!node) throw new VFSError('ENOENT', `路径不存在: ${path}`);
    return node;
  }

  /** 读取文件内容（校验读权限） */
  async readFile(path) {
    const node = await this.stat(path);
    if (node.type !== 'file') throw new VFSError('EISDIR', `是目录而非文件: ${path}`);
    checkPermission(node, 'r');
    return node.content;
  }

  /** 新建文件夹 */
  async mkdir(path, { owner = CURRENT_UID, group = CURRENT_GID, mode = 0o755 } = {}) {
    const p = normalizePath(path);
    const existing = await DB.get('vfs_nodes', p);
    if (existing) throw new VFSError('EEXIST', `已存在: ${p}`);
    const parentPath = parentOf(p);
    const parent = await DB.get('vfs_nodes', parentPath);
    if (!parent) throw new VFSError('ENOENT', `父目录不存在: ${parentPath}`);
    checkPermission(parent, 'w');
    const now = Date.now();
    await DB.put('vfs_nodes', {
      path: p,
      parentPath,
      name: nameOf(p),
      type: 'dir',
      content: null,
      mime: 'inode/directory',
      size: 0,
      owner,
      group,
      mode,
      createdAt: now,
      modifiedAt: now,
    });
    return p;
  }

  /** 写入文件（不存在则创建，存在则覆盖内容，需校验对应权限） */
  async writeFile(path, content, { mime = 'text/plain', owner = CURRENT_UID, group = CURRENT_GID, mode = 0o644 } = {}) {
    const p = normalizePath(path);
    const existing = await DB.get('vfs_nodes', p);
    const now = Date.now();
    if (existing) {
      if (existing.type !== 'file') throw new VFSError('EISDIR', `是目录: ${p}`);
      checkPermission(existing, 'w');
      existing.content = content;
      existing.mime = mime;
      existing.size = typeof content === 'string' ? content.length : content?.size || 0;
      existing.modifiedAt = now;
      await DB.put('vfs_nodes', existing);
      return existing;
    }
    const parentPath = parentOf(p);
    const parent = await DB.get('vfs_nodes', parentPath);
    if (!parent) throw new VFSError('ENOENT', `父目录不存在: ${parentPath}`);
    checkPermission(parent, 'w');
    const node = {
      path: p,
      parentPath,
      name: nameOf(p),
      type: 'file',
      content,
      mime,
      size: typeof content === 'string' ? content.length : content?.size || 0,
      owner,
      group,
      mode,
      createdAt: now,
      modifiedAt: now,
    };
    await DB.put('vfs_nodes', node);
    return node;
  }

  /** 重命名 / 移动 */
  async rename(oldPath, newName) {
    const p = normalizePath(oldPath);
    const node = await DB.get('vfs_nodes', p);
    if (!node) throw new VFSError('ENOENT', `不存在: ${p}`);
    const parent = await DB.get('vfs_nodes', node.parentPath);
    checkPermission(parent, 'w');
    checkPermission(node, 'w');
    const newPath = normalizePath(node.parentPath === null ? '/' + newName : `${node.parentPath}/${newName}`);
    if (await DB.get('vfs_nodes', newPath)) throw new VFSError('EEXIST', `目标已存在: ${newPath}`);

    // 若是目录，需要递归迁移所有子孙节点的路径前缀
    if (node.type === 'dir') {
      const all = await DB.getAll('vfs_nodes');
      const prefix = p + '/';
      const affected = all.filter((n) => n.path.startsWith(prefix));
      for (const child of affected) {
        const suffix = child.path.slice(p.length);
        const newChildPath = newPath + suffix;
        child.path = newChildPath;
        child.parentPath = child.parentPath === p ? newPath : newPath + child.parentPath.slice(p.length);
        await DB.put('vfs_nodes', child);
      }
      await DB.delete('vfs_nodes', p);
    } else {
      await DB.delete('vfs_nodes', p);
    }
    node.path = newPath;
    node.name = newName;
    node.parentPath = parentOf(newPath);
    node.modifiedAt = Date.now();
    await DB.put('vfs_nodes', node);
    return node;
  }

  /** 删除文件或目录（目录默认要求为空，force=true 递归删除） */
  async remove(path, { force = false } = {}) {
    const p = normalizePath(path);
    const node = await DB.get('vfs_nodes', p);
    if (!node) throw new VFSError('ENOENT', `不存在: ${p}`);
    const parent = await DB.get('vfs_nodes', node.parentPath);
    if (parent) checkPermission(parent, 'w');
    checkPermission(node, 'w');

    if (node.type === 'dir') {
      const children = await DB.getAllByIndex('vfs_nodes', 'by_parent', p);
      if (children.length > 0 && !force) {
        throw new VFSError('ENOTEMPTY', `目录非空: ${p}`);
      }
      if (force) {
        // 递归删除所有子孙
        const all = await DB.getAll('vfs_nodes');
        const prefix = p + '/';
        const affected = all.filter((n) => n.path.startsWith(prefix));
        for (const child of affected) await DB.delete('vfs_nodes', child.path);
      }
    }
    await DB.delete('vfs_nodes', p);
    return true;
  }

  /** 修改权限位（仅 owner 本人可修改，类似 Unix chmod） */
  async chmod(path, mode) {
    const node = await this.stat(path);
    if (node.owner !== CURRENT_UID) {
      throw new VFSError('EACCES', `仅属主可修改权限: ${path}`);
    }
    node.mode = mode;
    node.modifiedAt = Date.now();
    await DB.put('vfs_nodes', node);
    return node;
  }

  /** 从宿主设备导入文件（File 对象）到 VFS 指定目录 */
  async importFile(dirPath, file) {
    const dir = normalizePath(dirPath);
    const target = `${dir === '/' ? '' : dir}/${file.name}`;
    let content;
    if (file.type.startsWith('text/') || file.type === 'application/json') {
      content = await file.text();
    } else {
      content = file; // 保留 Blob，供下载/预览使用
    }
    return this.writeFile(target, content, { mime: file.type || 'application/octet-stream' });
  }
}

export const VFS = new VirtualFileSystem();
export { normalizePath, parentOf, nameOf, checkPermission };
