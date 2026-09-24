/* ============================================================
 * JMbiji 库业务层(仅浏览器,云端版)—— 分类 / 笔记 / 附件
 *
 * 保存纪律(DESIGN.md §8),每次保存必须走 saveCategory():
 *   1. CAS 条件写:PUT 带 If-Match(上次见到的 etag);
 *      服务器版本已变 → 412 → 上层弹冲突选择,绝不静默覆盖
 *   2. 备份:服务器在覆盖/删除前自动把旧版存入 backup/(每分类 10 份)
 *   3. 附件内容寻址:同一张图只存一份,写一次永不再动
 * ============================================================ */

import * as C from './crypto.js';
import * as V from './vaultlib.js';
import * as F from './format.js';
import * as API from './api.js';

export class LibraryError extends Error {
  constructor(msg, code) { super(msg); this.name = 'LibraryError'; this.code = code; }
}

export class Library {
  /**
   * @param {{contentKey, attachKey, filenameKey}} keys
   * @param {object} vaultJson 解锁后的 vault.json 内容
   * @param {Uint8Array} dekBytes 裸 DEK(改主密码需要)
   * @param {string} vaultEtag 解锁时 vault.json 的 etag(改密码 CAS 用)
   */
  constructor(keys, vaultJson, dekBytes, vaultEtag) {
    this.keys = keys;
    this.vaultJson = vaultJson;
    this.dek = dekBytes;
    this.vaultEtag = vaultEtag;
    /** name → { data|null, lastSeenEtag|null, size, conflict, error|null } */
    this.categories = new Map();
  }

  /* ============ 扫描 ============ */

  async rescan() {
    const list = await API.listCats();
    const next = new Map();
    for (const { name, size } of list) {
      const prev = this.categories.get(name);
      next.set(name, {
        data: prev ? prev.data : null,          // 已解密的保留在内存(锁屏时随实例一起丢弃)
        lastSeenEtag: prev ? prev.lastSeenEtag : null,
        size,
        conflict: false,
        error: prev ? prev.error : null,
      });
    }
    this.categories = next;
    return list;
  }

  listCategories() {
    return [...this.categories.keys()];
  }

  categoryInfo(name) {
    return this.categories.get(name) || null;
  }

  /* ============ 分类:读 ============ */

  /** 懒加载:点开才解密 */
  async loadCategory(name) {
    const cat = this.categories.get(name);
    if (!cat) throw new LibraryError(`分类不存在:${name}`, 'missing');
    if (cat.data) return cat.data;
    try {
      const got = await API.getCat(name);
      if (!got) { cat.error = '服务器上已不存在'; throw new LibraryError(`分类「${name}」已不存在`, 'missing'); }
      cat.data = await V.decryptCategory(this.keys.contentKey, got.bytes);
      cat.lastSeenEtag = got.etag;
      cat.error = null;
    } catch (e) {
      if (e instanceof C.FormatError || e instanceof C.CryptoError) cat.error = e.message;
      else if (!(e instanceof LibraryError)) cat.error = `读取失败:${e.message}`;
      throw e;
    }
    return cat.data;
  }

  async loadAllCategories() {
    for (const name of this.categories.keys()) {
      const cat = this.categories.get(name);
      if (!cat.data && !cat.error) {
        try { await this.loadCategory(name); } catch { /* 单个损坏不拖垮搜索,error 已记录 */ }
      }
    }
  }

  /* ============ 分类:写 ============ */

  /**
   * 保存一个分类(每次重新加密 → 全新 nonce)。
   * 返回 {ok:true} 或 {conflict:true}(服务器版本已变,拒绝覆盖)。
   * @param {string} name
   * @param {{force?:boolean}} opt force=true 时以服务器当前版本为基线覆盖
   *   (服务器仍会先把旧版存入 backup/,不丢数据)
   */
  async saveCategory(name, opt = {}) {
    const cat = this.categories.get(name);
    if (!cat || !cat.data) return { ok: true };

    let etag = cat.lastSeenEtag;
    if (opt.force || !etag) {
      const cur = await API.getCat(name);
      if (!cur) return { conflict: true };
      etag = cur.etag;
    }

    const outBytes = await V.encryptCategory(this.keys.contentKey, cat.data);
    const res = await API.putCat(name, outBytes, { etag });
    if (res.status === 412) return { conflict: true };
    if (res.status !== 200) throw new LibraryError(`保存失败(HTTP ${res.status})`, 'save');
    cat.lastSeenEtag = res.etag;
    return { ok: true };
  }

  /* ============ 分类:增删改 ============ */

  async createCategory(rawName) {
    const name = F.sanitizeCategoryName(rawName);
    if (!name) throw new LibraryError('分类名不能为空(或只含非法字符)', 'bad-name');
    if (this.categories.has(name)) throw new LibraryError(`分类「${name}」已存在`, 'dup');
    const collision = F.findCaseCollision([...this.categories.keys()], name);
    if (collision) throw new LibraryError(`与既有分类「${collision}」仅大小写不同,会撞名`, 'case-collision');

    const data = { notes: [] };
    const bytes = await V.encryptCategory(this.keys.contentKey, data);
    const res = await API.putCat(name, bytes, { createOnly: true });
    if (res.status === 409) throw new LibraryError(`分类「${name}」已存在(服务器)`, 'dup');
    if (res.status !== 201) throw new LibraryError(`创建失败(HTTP ${res.status})`, 'create');
    this.categories.set(name, { data, lastSeenEtag: res.etag, size: bytes.length, conflict: false, error: null });
    return name;
  }

  /**
   * 重命名 = 原密文字节整体搬到新键(不重加密、不换 nonce)+ 删旧键。
   * 先建新、后删旧:中途失败最多留下两份,不丢数据。
   */
  async renameCategory(oldName, rawNewName) {
    const cat = this.categories.get(oldName);
    if (!cat) throw new LibraryError(`分类不存在:${oldName}`, 'missing');

    const newName = F.sanitizeCategoryName(rawNewName);
    if (!newName) throw new LibraryError('分类名不能为空(或只含非法字符)', 'bad-name');
    if (newName === oldName) return newName;
    if (this.categories.has(newName)) throw new LibraryError(`分类「${newName}」已存在`, 'dup');
    const collision = F.findCaseCollision([...this.categories.keys()], newName);
    if (collision) throw new LibraryError(`与既有分类「${collision}」仅大小写不同,会撞名`, 'case-collision');

    const got = await API.getCat(oldName);
    if (!got) throw new LibraryError(`分类「${oldName}」已不存在`, 'missing');

    const res = await API.putCat(newName, got.bytes, { createOnly: true });
    if (res.status === 409) throw new LibraryError(`分类「${newName}」已存在(服务器)`, 'dup');
    if (res.status !== 201) throw new LibraryError(`重命名失败(HTTP ${res.status})`, 'rename');

    await API.deleteCat(oldName);
    this.categories.delete(oldName);
    this.categories.set(newName, {
      data: cat.data,
      lastSeenEtag: res.etag,
      size: got.bytes.length,
      conflict: false,
      error: null,
    });
    return newName;
  }

  async deleteCategory(name) {
    const cat = this.categories.get(name);
    if (!cat) throw new LibraryError(`分类不存在:${name}`, 'missing');
    await API.deleteCat(name); // 服务器在删除前自动备份
    this.categories.delete(name);
  }

  /* ============ vault.json ============ */

  /** 修改主密码:只重包数据钥匙 + 更新鉴权哈希,分类文件零改动、零重传。
   * ★ KEK 换了 → 鉴权令牌随之更换 → 必须同步更新内存中的 Bearer,
   *   否则服务端 auth.hash 已是新令牌的哈希,后续所有请求 401。 */
  async changeMasterPassword(newPassword) {
    const { json, authKeyHex } = await V.rewrapVault(this.vaultJson, this.dek, newPassword);
    const etag = await API.putVaultJson(JSON.stringify(json, null, 2), this.vaultEtag);
    this.vaultJson = json;
    this.vaultEtag = etag;
    API.setToken(authKeyHex);
    return json;
  }

  /* ============ 附件 ============ */

  /** 入库一张图:内容寻址命名;服务器端已存在即去重,不重复存储 */
  async addAttachment(originalBytes, originalName) {
    const blobName = await V.blobFileNameFor(this.keys.filenameKey, originalBytes, originalName);
    const status = await API.putBlob(blobName, await V.encryptBlob(this.keys.attachKey, originalBytes));
    return { file: blobName, existed: status === 200 };
  }

  async readAttachment(blobName) {
    const bytes = await API.getBlob(blobName);
    if (!bytes) throw new LibraryError(`附件不存在:${blobName}`, 'missing');
    return V.decryptBlob(this.keys.attachKey, bytes);
  }

  /** 手动清理:解密全部分类,收集引用,删除未被任何笔记引用的 blob */
  async cleanupOrphanBlobs() {
    await this.loadAllCategories();
    const refs = new Set();
    for (const cat of this.categories.values()) {
      if (!cat.data) continue;
      for (const note of cat.data.notes) {
        for (const att of note.attachments) refs.add(att.file);
      }
    }
    const removed = [];
    for (const name of await API.listBlobs()) {
      if (!refs.has(name)) {
        await API.deleteBlob(name);
        removed.push(name);
      }
    }
    return removed;
  }

  /** 释放密钥与明文(锁屏调用):丢弃整个实例即可,调用方置空引用 */
  destroy() {
    this.keys = null;
    this.dek = null;
    this.vaultJson = null;
    this.categories.clear();
  }
}
