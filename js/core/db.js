/**
 * db.js —— IndexedDB 统一封装层
 * ---------------------------------------------------------
 * 设计目标：
 *  1. 全系统只开一个数据库连接（单例），所有 APP / 系统模块共用。
 *  2. 对上层提供 Promise 化的 CRUD API，屏蔽原生 IndexedDB 的事件回调复杂度。
 *  3. 集中管理表结构（object store）与索引，版本升级时统一在 onupgradeneeded 里迁移。
 *
 * 使用方式：
 *   import { DB } from './db.js';
 *   await DB.ready();                       // 等待数据库打开完成
 *   await DB.add('photos', photoObj);        // 新增
 *   await DB.put('photos', photoObj);        // 新增或覆盖
 *   await DB.get('photos', id);              // 按主键查
 *   await DB.getAll('photos');               // 查全部
 *   await DB.getAllByIndex('photos','by_createdAt', range);
 *   await DB.delete('photos', id);           // 删除
 *   await DB.clear('photos');                // 清空整表
 */

const DB_NAME = 'WebOS_DB';
const DB_VERSION = 1;

/**
 * Schema 定义：每张表的 keyPath 与索引。
 * 新增表 / 索引时，只需要在这里追加，并把 DB_VERSION + 1，
 * 迁移逻辑会在 onupgradeneeded 中根据 oldVersion 做增量创建。
 */
const SCHEMA = {
  photos: {
    keyPath: 'id',
    indexes: [
      { name: 'by_createdAt', keyPath: 'createdAt' },
      { name: 'by_source', keyPath: 'source' },
    ],
  },
  vfs_nodes: {
    keyPath: 'path',
    indexes: [
      { name: 'by_parent', keyPath: 'parentPath' },
      { name: 'by_type', keyPath: 'type' },
    ],
  },
  apps: {
    keyPath: 'appId',
    indexes: [
      { name: 'by_type', keyPath: 'type' },
      { name: 'by_order', keyPath: 'order' },
    ],
  },
  app_code: {
    keyPath: 'appId',
    indexes: [],
  },
  contacts: {
    keyPath: 'id',
    indexes: [{ name: 'by_name', keyPath: 'name' }],
  },
  call_logs: {
    keyPath: 'id',
    indexes: [{ name: 'by_timestamp', keyPath: 'timestamp' }],
  },
  browser_history: {
    keyPath: 'id',
    indexes: [{ name: 'by_visitedAt', keyPath: 'visitedAt' }],
  },
  browser_bookmarks: {
    keyPath: 'id',
    indexes: [{ name: 'by_createdAt', keyPath: 'createdAt' }],
  },
  game_saves: {
    keyPath: 'gameId',
    indexes: [],
  },
  system_kv: {
    keyPath: 'key',
    indexes: [],
  },
};

class Database {
  constructor() {
    this._db = null;
    this._readyPromise = this._open();
  }

  /** 打开（或首次创建）数据库连接 */
  _open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (evt) => {
        const db = evt.target.result;
        for (const [storeName, def] of Object.entries(SCHEMA)) {
          let store;
          if (!db.objectStoreNames.contains(storeName)) {
            store = db.createObjectStore(storeName, { keyPath: def.keyPath });
          } else {
            store = evt.target.transaction.objectStore(storeName);
          }
          for (const idx of def.indexes) {
            if (!store.indexNames.contains(idx.name)) {
              store.createIndex(idx.name, idx.keyPath, { unique: !!idx.unique });
            }
          }
        }
      };

      req.onsuccess = (evt) => {
        this._db = evt.target.result;
        this._db.onversionchange = () => {
          // 另一个标签页升级了数据库版本，关闭当前连接避免阻塞
          this._db.close();
        };
        resolve(this._db);
      };

      req.onerror = () => reject(req.error);
      req.onblocked = () => console.warn('[DB] 数据库升级被其他标签页阻塞');
    });
  }

  /** 供外部 await，确保数据库已打开 */
  ready() {
    return this._readyPromise;
  }

  /** 获取一个事务 */
  async _tx(storeName, mode = 'readonly') {
    await this.ready();
    const tx = this._db.transaction(storeName, mode);
    return { tx, store: tx.objectStore(storeName) };
  }

  /** 新增记录（主键已存在会报错） */
  async add(storeName, value) {
    const { tx, store } = await this._tx(storeName, 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.add(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.onerror = () => reject(tx.error);
    });
  }

  /** 新增或覆盖记录 */
  async put(storeName, value) {
    const { tx, store } = await this._tx(storeName, 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.put(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.onerror = () => reject(tx.error);
    });
  }

  /** 按主键获取单条记录 */
  async get(storeName, key) {
    const { store } = await this._tx(storeName, 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  /** 获取整表所有记录 */
  async getAll(storeName) {
    const { store } = await this._tx(storeName, 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  /** 通过索引查询（可传 IDBKeyRange 或具体值） */
  async getAllByIndex(storeName, indexName, query = null) {
    const { store } = await this._tx(storeName, 'readonly');
    return new Promise((resolve, reject) => {
      const idx = store.index(indexName);
      const req = idx.getAll(query ?? undefined);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  /** 删除单条记录 */
  async delete(storeName, key) {
    const { tx, store } = await this._tx(storeName, 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.delete(key);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
      tx.onerror = () => reject(tx.error);
    });
  }

  /** 清空整表 */
  async clear(storeName) {
    const { tx, store } = await this._tx(storeName, 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.clear();
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
      tx.onerror = () => reject(tx.error);
    });
  }

  /** 统计记录数 */
  async count(storeName) {
    const { store } = await this._tx(storeName, 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /** 批量写入（在同一事务内，性能优于逐条 put） */
  async bulkPut(storeName, values) {
    const { tx, store } = await this._tx(storeName, 'readwrite');
    return new Promise((resolve, reject) => {
      for (const v of values) store.put(v);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }
}

// 全局单例，整个系统共用一个数据库连接
export const DB = new Database();

/** 生成 UUID（用于各表主键） */
export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
