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
import { zipStore, readZipStore } from './zip.js';

const td = new TextDecoder();

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

  /**
   * 手动清理:解密全部分类,收集引用,删除未被任何笔记引用的 blob。
   *
   * ⚠️ 这是全应用**唯一一处不可恢复的删除** —— blobs 没有备份层
   * (DELETE /api/blob 直接删对象,不像分类那样先写 backup/),删掉就是删掉了。
   * 所以这里必须 fail closed:「清点不全」的每一种情况都宁可整次中止、一张不删。
   *
   * 两个曾经踩空的口子(都会静默删掉正在被引用的图):
   *   1. 本机分类清单可能是**解锁时**拉的,别的设备此后新建的分类不在其中
   *      —— 只按本地清单清点,那些分类的图片全成了「孤儿」。故先 rescan。
   *   2. 某个分类读不出来(密文损坏,或一次瞬时 GET 失败)时,它的引用无从得知。
   *      旧实现 `if (!cat.data) continue;` 把它跳过,等于把它引用的图全判成孤儿。
   *
   * 残余窗口:rescan 到删除之间(秒级)别的设备若恰好新建分类并附图,仍可能误删。
   * 要更硬的保证得在服务端做标记-清扫或给新 blob 设冷却期,暂不引入。
   */
  async cleanupOrphanBlobs() {
    await this.rescan(); // ① 清单必须是新的:本机那份可能已经落后于别的设备
    await this.loadAllCategories(); // ② 全部解密,才能清点引用
    const refs = new Set();
    const unreadable = [];
    for (const [name, cat] of this.categories) {
      if (!cat.data) { unreadable.push(name); continue; }
      for (const note of cat.data.notes) {
        for (const att of note.attachments) refs.add(att.file);
      }
    }
    if (unreadable.length) {
      throw new LibraryError(
        `有 ${unreadable.length} 个分类无法读取(${unreadable.join('、')}),无法清点它们引用的图片;`
        + '已中止清理,未删除任何图片。请先解决这些分类的读取问题再重试。',
        'unreadable',
      );
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

  /* ============ 全库备份(导出 / 恢复) ============ */

  /**
   * 导出全库:一个 zip,内含 vault.json + cats/*.enc + blobs/*。
   *
   * ★ 全程**不解密** —— 导出的就是密文本身。所以这个包的安全级别等同于 vault.json:
   *   拿到它的人仍然要爆破主密码才能看到内容,但它**不受访问密钥门与限流的任何保护**,
   *   必须放在不会外泄的位置(别丢公共网盘、别留在浏览器下载目录里当唯一副本)。
   *
   * 为什么必须有它:vault.json 的单独副本**只有钥匙、没有箱子** ——
   * 桶丢了或账号出问题,手上那把钥匙打不开任何东西。这个包才是完整的一份。
   *
   * 不含 `backup/` 里的历史版本:那是服务器端的滚动备份,本包是「当前全量」。
   * (Worker 也没有暴露 backup/ 的接口,这是有意的。)
   *
   * @param {{onPlan?:(p:{cats:number,blobs:number,bytes:number})=>boolean|Promise<boolean>,
   *          onProgress?:(p:{done:number,total:number,label:string})=>void}} [opt]
   *   onPlan 在真正开始拉取**之前**调用,拿到真实总量(个人库也可能上百 MB,
   *   手机上有内存压力,得让人先看到体积再决定);返回 false 即中止。
   * @returns {Promise<{bytes:Uint8Array, counts:{cats:number, blobs:number, bytes:number}}>}
   */
  async exportBackup({ onPlan, onProgress = () => {} } = {}) {
    // vault.json 重新拉一次,不用内存里那份:导出物该是**服务器上此刻**的样子
    const vault = await API.fetchVault();
    if (vault.status !== 200 || !vault.json) {
      throw new LibraryError('服务器上还没有库,没有可导出的内容', 'no-vault');
    }
    const cats = await API.listCats();
    const blobs = await API.listBlobInfo();
    const total = cats.reduce((n, c) => n + (c.size || 0), 0)
      + blobs.reduce((n, b) => n + (b.size || 0), 0);

    if (onPlan && !(await onPlan({ cats: cats.length, blobs: blobs.length, bytes: total }))) {
      throw new LibraryError('已取消导出', 'cancelled');
    }

    const entries = [{
      name: F.VAULT_NAME,
      bytes: new TextEncoder().encode(JSON.stringify(vault.json, null, 2)),
    }];
    let done = 0;
    const step = (label) => onProgress({ done, total, label });

    for (const c of cats) {
      const got = await API.getCat(c.name);
      if (!got) continue; // 导出期间被别的设备删了:跳过,不编造
      entries.push({ name: `cats/${c.name}.enc`, bytes: got.bytes });
      done += got.bytes.length;
      step(`cats/${c.name}.enc`);
    }
    for (const b of blobs) {
      const bytes = await API.getBlob(b.name);
      if (!bytes) continue;
      entries.push({ name: `blobs/${b.name}`, bytes });
      done += bytes.length;
      step(`blobs/${b.name}`);
    }

    return { bytes: zipStore(entries), counts: { cats: cats.length, blobs: blobs.length, bytes: total } };
  }

  /**
   * 从备份包恢复。规则刻意保守 —— 宁可不恢复,也不要把库搞成「一半新一半旧」:
   *
   *  · 包里必须有结构合法的 vault.json,否则直接拒绝(不是本应用的备份)
   *  · 服务器上已有 vault.json 且**不是同一个库**(包裹的 DEK 不同)→ 拒绝:
   *    把另一个库的密文塞进来,只会得到一堆永远解不开的文件
   *  · 分类只做「仅新建」:已存在的一律跳过并如实报告,**绝不覆盖**
   *    (恢复的目的是补回缺的,不是把服务器上较新的版本盖回旧的)
   *  · 附件天然幂等(名字=内容寻址),已存在即去重,无覆盖概念
   *
   * @param {Uint8Array} zipBytes
   * @param {(p:{label:string, i:number, n:number})=>void} [onProgress]
   * @returns {Promise<{vaultCreated:boolean, catsAdded:string[], catsSkipped:string[], blobsAdded:number, blobsExisted:number, failed:string[]}>}
   */
  async importBackup(zipBytes, onProgress = () => {}) {
    const entries = readZipStore(zipBytes); // 结构 / CRC 不对会在这里抛 ZipError
    const byName = new Map(entries.map((e) => [e.name, e.bytes]));

    const vaultRaw = byName.get(F.VAULT_NAME);
    if (!vaultRaw) {
      throw new LibraryError(`备份包里没有 ${F.VAULT_NAME},不是本应用的备份`, 'bad-backup');
    }
    let incoming;
    try {
      incoming = JSON.parse(td.decode(vaultRaw));
    } catch {
      throw new LibraryError('备份包里的 vault.json 不是合法 JSON', 'bad-backup');
    }
    if (incoming?.magic !== 'JMBIJI' || !incoming?.kdf || !incoming?.wrap
      || !incoming?.auth?.hash || !/^[0-9a-f]{64}$/.test(incoming.auth.hash)) {
      throw new LibraryError('备份包里的 vault.json 结构不合法', 'bad-backup');
    }

    /* ---- 先处理 vault.json:不同库绝不混 ---- */
    const current = await API.fetchVault();
    let vaultCreated = false;
    if (current.status === 200) {
      const sameDek = !!current.json?.wrap?.wrappedDek
        && current.json.wrap.wrappedDek === incoming.wrap.wrappedDek;
      if (!sameDek) {
        throw new LibraryError(
          '服务器上已有另一个库。把这份备份导进去会让钥匙与密文对不上(全是解不开的文件),已中止。'
          + '请先确认要恢复到哪个桶。',
          'foreign-vault',
        );
      }
    } else {
      const res = await API.createVaultJson(JSON.stringify(incoming, null, 2));
      if (res.status === 409) throw new LibraryError('服务器上已有库,已中止', 'exists');
      if (res.status !== 201) throw new LibraryError(`创建 vault.json 失败(HTTP ${res.status})`, 'create');
      vaultCreated = true;
    }

    /* ---- 分类:仅新建 ---- */
    const catEntries = entries.filter((e) => e.name.startsWith('cats/') && e.name.endsWith('.enc'));
    const blobEntries = entries.filter((e) => e.name.startsWith('blobs/'));
    const n = catEntries.length + blobEntries.length;
    let i = 0;
    const tick = (label) => onProgress({ label, i: ++i, n });

    const catsAdded = [];
    const catsSkipped = [];
    const failed = [];
    for (const e of catEntries) {
      const name = e.name.slice('cats/'.length, -'.enc'.length);
      tick(e.name);
      try {
        const res = await API.putCat(name, e.bytes, { createOnly: true });
        if (res.status === 201) catsAdded.push(name);
        else if (res.status === 409) catsSkipped.push(name);
        else failed.push(name);
      } catch {
        failed.push(name);
      }
    }

    /* ---- 附件:内容寻址,天然幂等 ---- */
    let blobsAdded = 0;
    let blobsExisted = 0;
    for (const e of blobEntries) {
      const name = e.name.slice('blobs/'.length);
      tick(e.name);
      try {
        const status = await API.putBlob(name, e.bytes);
        if (status === 201) blobsAdded += 1; else blobsExisted += 1;
      } catch {
        failed.push(name);
      }
    }

    return { vaultCreated, catsAdded, catsSkipped, blobsAdded, blobsExisted, failed };
  }

  /** 释放密钥与明文(锁屏调用):丢弃整个实例即可,调用方置空引用 */
  destroy() {
    this.keys = null;
    this.dek = null;
    this.vaultJson = null;
    this.categories.clear();
  }
}
