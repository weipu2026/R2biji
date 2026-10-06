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

/** 每篇笔记「上次已存正文」的记忆位(WeakMap:随笔记对象一起回收,不进密文、不进存储)。
 *  保存路径靠它判断「这篇这次改没改」—— 只比字符串,不碰加密。
 *  见 Library.snapshotPrev 的注释。 */
const lastSavedContent = new WeakMap();

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
    /** name → { data|null, lastSeenEtag|null, size, conflict, error|null, transient|null }
     *  error     = **永久**错误(密文损坏 / 服务器上已不存在):侧栏标「无法解密」,不再反复重试
     *  transient = **瞬时**错误(网络不通 / 5xx / 超时):下次照常重试,只用于提示(2026-09-29 P2-7) */
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
        // 瞬时失败跨 rescan 保留:它决定「还要不要重试」,不该因为刷新清单而丢掉
        transient: prev ? prev.transient : null,
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

  /**
   * 分类的视觉顺序:置顶优先 → 手动 order → 名称兜底。
   * ★ 列表渲染与「上移/下移」都必须走它 —— 各写一份排序规则,迟早漂移成
   *   「看到的顺序」与「移动时的顺序」不一致,那种 bug 靠肉眼永远查不出来。
   */
  sortedCategories() {
    return F.sortCats([...this.categories.keys()], (n) => this.catMetaOf(n));
  }

  /* ============ 分类元信息(置顶等;存 vault.json.catMeta,跨设备同步) ============ */

  catPin(name) {
    return this.vaultJson?.catMeta?.[name]?.pin === true;
  }

  /** 分类元信息的只读视图(不存在则空对象) —— 调用方不必自己防 undefined */
  catMetaOf(name) {
    return this.vaultJson?.catMeta?.[name] || {};
  }

  /**
   * 分类笔记篇数的本地缓存值。
   * 冷启动时各分类是懒加载的,本地并不知道有几篇 —— 那时返回 null,
   * 由 UI 决定「先不显示」而不是显示一个会跳变的 0。
   */
  catCount(name) {
    const n = this.vaultJson?.catMeta?.[name]?.count;
    return Number.isInteger(n) && n >= 0 ? n : null;
  }

  /**
   * 重新拉取 vault.json(置顶/篇数/手动顺序都在里面)。
   * ★ 跨标签页同步必须调它:rescan() 只重建**分类清单**、不碰 vaultJson ——
   *   只 rescan 会让本标签页继续用陈旧的 catMeta 渲染顺序与置顶(2026-09-28 审计 P2)。
   * @returns {Promise<boolean>} 是否成功刷新
   */
  async refreshVaultMeta() {
    const fresh = await API.fetchVault();
    if (fresh.status !== 200) return false;
    this.vaultJson = fresh.json;
    this.vaultEtag = fresh.etag;
    return true;
  }

  /**
   * 对 vault.json 做一次元信息变更并落盘(CAS)。
   * 412 = 别的会话刚写过 → 重拉最新 vault、在新内容上重放同一变更(按名字写,幂等)再试一次;
   * 变更前后内容一致则不写云端(如清理不存在的元信息)。
   * @param {(json:object)=>void} mutate 在克隆体上就地修改(纯同步函数)
   * @returns {Promise<boolean>} 是否真的写了一次云端
   */
  async updateVaultMeta(mutate) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = JSON.stringify(this.vaultJson);
      const json = JSON.parse(before);
      mutate(json);
      const after = JSON.stringify(json);
      if (after === before) return false;
      try {
        const etag = await API.putVaultJson(after, this.vaultEtag);
        this.vaultJson = json;
        this.vaultEtag = etag;
        return true;
      } catch (e) {
        if (e?.status === 412 && attempt === 0) {
          const fresh = await API.fetchVault();
          if (fresh.status !== 200) throw e;
          this.vaultJson = fresh.json; // 基于最新内容重放;下次循环的 before 自然取到新值
          this.vaultEtag = fresh.etag;
          continue;
        }
        throw e;
      }
    }
    throw new LibraryError('vault.json 持续被其他会话修改,请刷新页面后重试', 'conflict');
  }

  /**
   * 通用分类元信息写入(CAS,跨设备同步)。
   * patch 里值为 undefined / null 的键会被删掉;某分类的条目空了就删条目,
   * 整个 catMeta 空了就删 catMeta —— 不在 vault.json 里留空壳(与旧 setCatPin 同规矩)。
   * @param {string} name
   * @param {Record<string, any>} patch 就地合并的字段(del 语义:传 null)
   * @returns {Promise<boolean>} 是否真的写了一次云端(无变化时 false)
   */
  async setCatMeta(name, patch) {
    return this.updateVaultMeta((json) => {
      const meta = { ...(json.catMeta || {}) };
      const entry = { ...(meta[name] || {}) };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === null) delete entry[k];
        else entry[k] = v;
      }
      if (Object.keys(entry).length) meta[name] = entry;
      else delete meta[name];
      if (Object.keys(meta).length) json.catMeta = meta;
      else delete json.catMeta; // 全空就整个摘掉,不在 vault.json 里留空壳
    });
  }

  /** 分类置顶 / 取消置顶(薄封装,保持旧签名) */
  async setCatPin(name, pin) {
    return this.setCatMeta(name, { pin: pin ? true : null });
  }

  /**
   * 记录分类的笔记篇数。
   * ⚠️ 每次写都是一次 vault.json 的条件写(CAS)+ 一次网络往返,绝不能挂在渲染路径上 ——
   * 只有篇数与本地缓存不一致时才调用它(updateVaultMeta 内部也会比对内容,
   * 无变化直接返回 false 不写云端,这里再挡一层是为了省掉 JSON 克隆的开销)。
   */
  async setCatCount(name, n) {
    return this.setCatMeta(name, { count: n });
  }

  /**
   * 分类上移/下移(顺序存 vault.json 的 catMeta.order,跨设备同步)。
   *
   * ⚠️ 与笔记的 moveNote 有一处本质差别:笔记的 order 在分类文件内部,
   *    改动搭下一次保存的车;分类的 order 只能进 vault.json ——
   *    每次点击都是一次独立的条件写(CAS + 412 重放),有网络往返。
   * ★ 冲突(412)时**不做重放**:catMovePatch 算的是相对位移(交换当前相邻两项),
   *   在新基线上重放等于「再移一格」,与一次点击的语义不符(2026-09-28 审计 P2,已实证)。
   *   改为刷新本地 vault 视图 + 返回 false(本次未移动),用户看到最新顺序后可再点。
   * @param {string} name
   * @param {number} dir -1 上移 / +1 下移
   * @returns {Promise<boolean>} 是否真的写了一次云端(端点/跨置顶分区/冲突 → false)
   */
  async moveCat(name, dir) {
    const patch = F.catMovePatch([...this.categories.keys()], (n) => this.catMetaOf(n), name, dir);
    if (!patch) return false;                // 端点 / 跨置顶分区 → 不动(与笔记 moveNote 同规矩)
    const json = JSON.parse(JSON.stringify(this.vaultJson));
    const meta = { ...(json.catMeta || {}) };
    for (const [n, order] of Object.entries(patch)) meta[n] = { ...(meta[n] || {}), order };
    json.catMeta = meta;
    try {
      const etag = await API.putVaultJson(JSON.stringify(json), this.vaultEtag);
      this.vaultJson = json;
      this.vaultEtag = etag;
      return true;
    } catch (e) {
      if (e?.status === 412) {
        const fresh = await API.fetchVault();
        if (fresh.status === 200) { this.vaultJson = fresh.json; this.vaultEtag = fresh.etag; }
        return false;
      }
      throw e;
    }
  }

  /* ============ 分类:读 ============ */

  /**
   * 懒加载:点开才解密。
   * opt.force = **忽略已缓存的 cat.data,强制重新拉取并解密**。
   *   孤儿清理必须走这条:rescan() 有意保留已解密明文(锁屏才整体丢弃),若清理时
   *   直接拿那份明文清点引用,清点到的就是「几小时前的库」—— 此后别的设备上传的
   *   图片会被判成孤儿删掉,而 blobs 是全应用唯一没有备份层的东西(不可恢复)。
   *   force 时一并清掉 error/transient,让上次失败的分类还有一次重拉机会
   *   (真失败会重新写回,照旧进 unreadable → 整次中止,保守不删这条不受影响)。
   * ⚠️ force 会**替换** cat.data 对象:此前取引用(data.notes 等)的调用方拿到的是
   *   过期对象,改动它不会进库。跨 force 的读写一律重新 loadCategory 取。
   */
  async loadCategory(name, opt = {}) {
    const cat = this.categories.get(name);
    if (!cat) throw new LibraryError(`分类不存在:${name}`, 'missing');
    if (cat.data && !opt.force) return cat.data;
    if (opt.force) { cat.error = null; cat.transient = null; }
    try {
      const got = await API.getCat(name);
      if (!got) { cat.error = '服务器上已不存在'; throw new LibraryError(`分类「${name}」已不存在`, 'missing'); }
      cat.data = await V.decryptCategory(this.keys.contentKey, got.bytes);
      cat.lastSeenEtag = got.etag;
      cat.error = null;
      cat.transient = null;
      /* 预置「上次已存正文」记忆位:解密出来的这一版就是**上一版**。
       * 不预置的话,「加载后第一次编辑再保存」时记忆位是空的 → 改之前那一版
       * 永远进不了历史,而那恰恰是用户最想回退的那一版(2026-10-06 审计)。
       * 只存字符串引用,不额外占内存(正文本来就在),也不做加密运算。 */
      for (const note of cat.data.notes) lastSavedContent.set(note, typeof note.content === 'string' ? note.content : '');
    } catch (e) {
      /* ★ 错误分两类(2026-09-29 审计 P2-7):
       *   永久 —— 密文损坏 / 解不开(FormatError / CryptoError)、服务器上已不存在(LibraryError):
       *     写 cat.error。侧栏据此标「无法解密 ⛔」,loadAllCategories 也不再反复重试。
       *   瞬时 —— 网络不通 / 5xx / 超时(ApiError):**只写 cat.transient,绝不写 cat.error**。
       *     旧实现一视同仁,于是一次网络抖动就把分类永久标成「无法解密」;而
       *     loadAllCategories 只在 !cat.error 时才重试 ⇒ 网络恢复后永不重试,
       *     孤儿图片清理被长期锁死(那是全应用唯一不可恢复的删除,锁死 = 永远清不了)。
       *   ⚠️ cleanupOrphanBlobs 的「读不到就一张不删」判据是 !cat.data,与 cat.error 无关,
       *     所以瞬时失败照旧进 unreadable —— 「保守不删」这条安全性不受本次改动影响。 */
      if (e instanceof C.FormatError || e instanceof C.CryptoError || e instanceof LibraryError) {
        cat.error = e.message;
      } else {
        cat.transient = e.message;
      }
      throw e;
    }
    return cat.data;
  }

  /**
   * 全部解密。opt 透传给 loadCategory({force:true} 时**强制重拉**,
   * 孤儿清理与「最近删除」都靠它拿到与云端一致的引用面。
   * 限并发 4 路(与导出同口径):纯串行在几十个分类的大库里要等十几秒,
   * 而全并发会挤爆连接 —— 实测 40 分类 6.2s → 1.1s(5.7×)。
   */
  async loadAllCategories(opt = {}) {
    const names = [...this.categories.keys()];
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(4, names.length) }, async () => {
      while (i < names.length) {
        const name = names[i++];
        const cat = this.categories.get(name);
        if (!cat) continue;
        if (opt.force || (!cat.data && !cat.error)) {
          try { await this.loadCategory(name, opt); } catch { /* 单个损坏不拖垮搜索,error 已记录 */ }
        }
      }
    }));
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
    if (!cat || !cat.data) {
      // 没有可保存的内存数据(如冲突后选「以云端版本为准」,data 已置 null)。
      // 绝不能谎报 {ok:true} —— 调用方会把它当「保存成功」移出待保存队列,
      // 真实存在的改动会静默脱离保存流程。如实返回 skipped,由调用方决定去向。
      console.warn(`saveCategory:「${name}」没有内存数据可保存,已跳过`);
      return { skipped: true };
    }

    let etag = cat.lastSeenEtag;
    if (opt.force || !etag) {
      const cur = await API.getCat(name);
      if (!cur) return { conflict: true };
      etag = cur.etag;
    }

    // 保存前给「改动过的那几篇」留档上一版正文(没改动的篇目零加密开销,
    // 首存零上传 —— 见 snapshotPrev 的注释)
    for (const note of cat.data.notes) await this.snapshotPrev(note);

    const outBytes = await V.encryptCategory(this.keys.contentKey, cat.data);
    const res = await API.putCat(name, outBytes, { etag });
    // ★ conflict 此前全项目**从未被置 true**(2026-10-06 审计):侧栏那个
      // 「疑似同步冲突」警示因此是死分支。现在 412 时置位、成功时清零。
    if (res.status === 412) { cat.conflict = true; return { conflict: true }; }
    if (res.status !== 200) throw new LibraryError(`保存失败(HTTP ${res.status})`, 'save');
    cat.conflict = false;
    cat.lastSeenEtag = res.etag;
    return { ok: true };
  }

  /* ============ 分类:增删改 ============ */

  /**
   * 把一条笔记追加到目标分类并**立即**落盘(跨分类移动的第一阶段)。
   *
   * 为什么不走 markDirty + saveAll:saveAll 遍历的是脏标记集合(Set),**顺序不可控**。
   *   跨分类移动会让源、目标两个分类同时进队列 —— 若先写源、后写目标,而两次网络写
   *   之间中断(关标签页 / 锁屏),那条笔记就是「从源删掉了、没进目标」= **丢失**。
   *   本方法把顺序握在代码手里:先写目标,成功之后调用方才去动源,于是最坏情况
   *   只剩「短暂重复」—— 下一轮保存自动收敛,且云端每分类留 10 份备份。
   *
   * 失败语义:任何失败都**不留半成品** —— 目标分类的内存回滚到调用前,云端未被改动。
   * @param {string} name 目标分类名
   * @param {object} note 笔记对象(调用方应传深拷贝:随后要从源分类里把它删掉)
   * @returns {Promise<{ok:true}|{conflict:true}|{skipped:true}>}
   */
  async appendNoteToCategory(name, note) {
    const dst = this.categories.get(name);
    if (!dst) throw new LibraryError(`分类不存在:${name}`, 'missing');
    await this.loadCategory(name);          // 已解密过的分类:零网络请求
    if (!dst.data) throw new LibraryError(`分类「${name}」当前无法读取`, 'stale');
    if (dst.data.notes.some((n) => n.id === note.id)) {
      throw new LibraryError(`「${name}」里已有同一篇笔记(id 重复)`, 'dup');
    }
    const before = dst.data.notes.length;
    dst.data.notes.push(note);
    let res;
    try {
      res = await this.saveCategory(name);
    } catch (e) {
      dst.data.notes.length = before;       // 回滚内存:绝不留「以为存上了」的假象
      throw e;
    }
    if (!res?.ok) {
      dst.data.notes.length = before;
      // saveCategory 里已跑过快照循环,被追加的那篇可能带上了 snaps + 已上传的 blob;
      // 只还原长度不够 —— 那个 blob 会成为孤儿(内容寻址、无泄漏,但白占空间,
      // 靠 cleanupOrphanBlobs 兜底,这里顺手把多出来的引用截掉)
      const added = dst.data.notes[before];
      if (added && Array.isArray(added.snaps) && added.snaps.length) {
        added.snaps = added.snaps.slice(0, added.snaps.length - 1);
      }
    }
    return res ?? { skipped: true };
  }

  /**
   * 一次条件写里更新**多个**分类的篇数(侧栏徽章的数据源)。
   *
   * 为什么要有批量版:跨分类移动会同时改变两个分类的篇数。逐个调 setCatCount
   * 就是两次 vault.json 条件写 —— 两次网络往返、两次 412 重放机会,而免费版
   * Workers 的每日请求数是硬上限。这里合并成一次 mutate。
   * 只在真有变化时才写云端(updateVaultMeta 内部还会再比对一次内容)。
   * @param {Record<string, number>} pairs 分类名 → 篇数
   * @returns {Promise<boolean>} 是否真的写了一次云端
   */
  async setCatCounts(pairs) {
    // 这一层只省本地开销(JSON 克隆 + 字符串比较);「要不要真的发一次云端条件写」
    // 由 updateVaultMeta 内部的内容比对把关 —— 两层职责不同,别把这行当请求数守卫。
    const todo = Object.entries(pairs)
      .filter(([n, c]) => Number.isInteger(c) && c >= 0 && this.catCount(n) !== c);
    if (!todo.length) return false;
    return this.updateVaultMeta((json) => {
      const meta = { ...(json.catMeta || {}) };
      for (const [n, c] of todo) meta[n] = { ...(meta[n] || {}), count: c };
      json.catMeta = meta;
    });
  }

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

    // 删除半程必须带条件:got.etag 是刚才 get 到的服务器当前版本 ——
    // 不带 etag 是无条件删,并发设备刚保存的新版会被静默删掉(与 deleteCategory 同理)
    await API.deleteCat(oldName, got.etag);
    this.categories.delete(oldName);
    this.categories.set(newName, {
      data: cat.data,
      lastSeenEtag: res.etag,
      size: got.bytes.length,
      conflict: false,
      error: null,
    });
    // 置顶等元信息跟着改名走;失败不影响改名本身(下次重命名会再对齐)
    if (this.vaultJson?.catMeta?.[oldName]) {
      try {
        await this.updateVaultMeta((json) => {
          json.catMeta[newName] = json.catMeta[oldName];
          delete json.catMeta[oldName];
        });
      } catch { /* 元信息迁移失败只影响置顶显示,不回滚改名 */ }
    }
    return newName;
  }

  async deleteCategory(name) {
    const cat = this.categories.get(name);
    if (!cat) throw new LibraryError(`分类不存在:${name}`, 'missing');
    // 条件删除:带上本地见过的 etag。没打开过的分类没有 etag,先拉一次 ——
    // 删除本来就该基于当前版本,否则竞态下会把别的设备刚保存的新版静默删掉。
    // ★ 服务端现在**要求** If-Match(缺头 → 428):拉不到 etag 就不能删,
    //   必须把原因如实抛给用户,而不是退回「无条件删」——那条路已不存在,
    //   静默放过只会让用户看到莫名的 428 报错。
    if (!cat.lastSeenEtag) {
      try {
        await this.loadCategory(name);
      } catch (e) {
        throw new LibraryError(`无法读取「${name}」的当前版本,未执行删除:${e?.message || e}`, 'stale');
      }
    }
    if (!cat.lastSeenEtag) {
      throw new LibraryError(`未取到「${name}」的版本号,未执行删除(请刷新后重试)`, 'stale');
    }
    await API.deleteCat(name, cat.lastSeenEtag); // 服务器删除前自动备份;412 = 刚被其他设备改过,上层如实提示
    this.categories.delete(name);
    // 残留的分类元信息(置顶 / 篇数)顺手清掉;失败无害(名字已不在清单里,永不显示)
    // —— 必须整条删、不能只清 pin:否则篇数会跟着同名分类「复活」
    if (this.vaultJson?.catMeta?.[name]) {
      try { await this.setCatMeta(name, { pin: null, count: null, order: null }); } catch { /* 忽略 */ }
    }
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

  /* ============ 版本历史(快照) ============ */
  /*
   * 快照 = 笔记正文的加密副本,走与附件完全同一条内容寻址 blob 流水线:
   * 同内容必然同名 → 天然去重,多端各自产生的同一版本也不冲突、不重复存储。
   * 引用存进 note.snaps(最新在前,{file,ts}),随分类密文一起加密保存,
   * 不新增任何服务端键;备份导出 / 恢复也自动带上(blob 走通用清单)。
   */

  /**
   * 给一篇笔记的「当前正文」拍快照:与最新快照同内容则不动。
   * opt.anchor=true(恢复历史前调用):把当前正文钉成永久锚 —— 恢复永远可逆。
   * 失败(网络等)只放弃本次快照,绝不抛出 —— 历史是保险,不是主数据,
   * 不能因为它阻塞正文保存;同名幂等,下次保存会自然补上。
   * @returns {Promise<boolean>} 是否真的新增/合并了一档
   */
  /**
   * 给**指定内容**存一份快照(内容寻址:同内容自动去重,不重复上传)。
   * @param {object} note 笔记对象(引用会写进 note.snaps)
   * @param {string} content 要留档的正文
   * @param {{anchor?:boolean, strict?:boolean}} [opt]
   *   anchor=true 把这条钉成永久锚(恢复历史前用:保证「恢复前的正文」回得去);
   *   strict=true 失败即抛(存档是后续动作的前提时用,见 restoreSnapshot)。
   */
  async snapshotContent(note, content, opt = {}) {
    if (typeof content !== 'string' || !content) return false; // 空正文不入史
    try {
      const bytes = new TextEncoder().encode(content);
      const file = await V.blobFileNameFor(this.keys.filenameKey, bytes, 'snap.md');
      const snaps = Array.isArray(note.snaps) ? note.snaps : [];
      const next = F.pushSnap(snaps, { file, ts: Date.now() }, { anchor: opt.anchor === true });
      if (next === snaps) return false; // 同内容去重:无新条目
      await API.putBlob(file, await V.encryptBlob(this.keys.attachKey, bytes));
      note.snaps = next;
      return true;
    } catch (e) {
      if (opt.strict) throw e;
      console.warn('snapshotContent:快照上传失败,本次跳过(不影响正文保存)', e);
      return false;
    }
  }

  /** 给一篇笔记的「当前正文」拍快照(恢复流程与显式补档用) */
  async snapshotNote(note, opt = {}) {
    return this.snapshotContent(note, typeof note?.content === 'string' ? note.content : '', opt);
  }

  /**
   * 保存路径专用:给「上一版正文」留档,然后把记忆位更新为当前正文。
   *
   * ★ 为什么不是「每次保存都存当前正文」(2026-10-06 审计 P1/P2 重构):
   *   ① 稳态下每次保存要对分类内**每篇**笔记做 TextEncoder + SHA-256 + HMAC
   *      只为判断「内容变没变」—— 实测 100 篇×20KB 约 6~7ms/次,占本地加密
   *      开销 40~60%,而「4 秒停笔就自动存」意味着每 4 秒付一次;
   *   ② 老库首次保存时 snaps 全为空 → **每篇笔记各触发一次串行 blob 上传**
   *      (100 篇 = 100 次串行请求,一次保存堵十几秒)。
   *   改法:用 WeakMap 记住每篇「上次已存内容」,保存时只比字符串(零加密开销),
   *   变了才给**上一版**留档。语义反而更准:历史要回答的是「我刚才改坏了什么」,
   *   需要的正是改之前的那一版,而不是刚才存下去的当前版。
   *   首存为 0 次上传,稳态为「改动篇数次」上传 + 0 次额外哈希。
   */
  async snapshotPrev(note, opt = {}) {
    const current = typeof note?.content === 'string' ? note.content : '';
    const prev = lastSavedContent.get(note);
    lastSavedContent.set(note, current); // 先记下本次,下一轮比的是它
    if (prev === undefined || prev === current || !prev) return false; // 首次 / 没改过 / 原为空
    return this.snapshotContent(note, prev, opt);
  }

  /** 读一个历史版本的正文(blob 名来自 note.snaps) */
  async readSnapshot(blobName) {
    const bytes = await API.getBlob(blobName);
    if (!bytes) throw new LibraryError(`历史版本不存在:${blobName}`, 'missing');
    return new TextDecoder().decode(await V.decryptBlob(this.keys.attachKey, bytes));
  }

  /**
   * 恢复历史版本:先把「恢复前的当前正文」拍进历史(恢复可逆 —— 想反悔,
   * 历史列表最上面那条就是),再把正文换掉。由调用方负责 markDirty + 保存。
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async restoreSnapshot(catName, noteId, blobName) {
    const cat = this.categories.get(catName);
    const note = cat?.data?.notes.find((n) => n.id === noteId);
    if (!note) return { ok: false, reason: '笔记不存在或分类未解锁' };
    let text;
    try {
      text = await this.readSnapshot(blobName);
    } catch (e) {
      return { ok: false, reason: `历史版本读取失败:${e?.message || '未知错误'}` };
    }
    // anchor:把「恢复前的正文」钉成永久锚 —— 恢复可逆的前提。
    // ⚠️ strict:true = 存档失败就中止(2026-10-06 审计 P1):否则网络失败时
    //   「恢复前的正文」既没进历史也没上传,而 content 已被覆盖 —— 这一版
    //   永久丢失,却让用户以为「随时可反悔」。
    try {
      await this.snapshotNote(note, { anchor: true, strict: true });
    } catch (e) {
      return { ok: false, reason: `当前正文存档失败(${e?.message || '网络异常'}),已中止恢复 —— 否则这次恢复不可逆` };
    }
    note.content = text;
    note.updatedAt = Date.now();
    return { ok: true };
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
   *   3. **已解密的分类在 rescan 后仍是旧明文**(rescan 有意保留 data):
   *      若直接拿旧明文清点,清点面就是「本机上次打开该分类时」的库 ——
   *      此后别的设备传上来的图不在引用里,会被当孤儿删掉(2026-10-06 审计 P0)。
   *      故这里用 force:true 强制全部重拉重解密:慢一点,换「绝不删正在用的图」。
   *
   * 残余窗口:强制重拉到删除之间(秒级)别的设备若恰好新建分类并附图,仍可能误删。
   * 要更硬的保证得在服务端做标记-清扫或给新 blob 设冷却期,暂不引入。
   */
  async cleanupOrphanBlobs() {
    await this.rescan(); // ① 清单必须是新的:本机那份可能已经落后于别的设备
    await this.loadAllCategories({ force: true }); // ② 全部**重新**解密,清点面必须是当下的库
    const refs = new Set();
    const unreadable = [];
    for (const [name, cat] of this.categories) {
      if (!cat.data) { unreadable.push(name); continue; }
      for (const note of cat.data.notes) {
        for (const att of note.attachments) refs.add(att.file);
        for (const s of (note.snaps || [])) refs.add(s.file); // 版本历史也是活的引用,清了就回不去
      }
      // 回收站里的笔记仍引用着图片:不数进去,恢复回来就是一排裂图
      for (const note of (cat.data.trash || [])) {
        for (const att of (note.attachments || [])) refs.add(att.file);
        for (const s of (note.snaps || [])) refs.add(s.file);
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
    let nCats = 0;
    let nBlobs = 0;
    const step = (label) => onProgress({ done, total, label });
    // 小并发池:纯串行在大库里太慢,全并发又会挤爆连接;4 路刚刚好
    const pool = async (items, worker) => {
      let i = 0;
      await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
        while (i < items.length) await worker(items[i++]);
      }));
    };

    await pool(cats, async (c) => {
      const got = await API.getCat(c.name);
      if (!got) return; // 导出期间被别的设备删了:跳过,不编造
      entries.push({ name: `cats/${c.name}.enc`, bytes: got.bytes });
      nCats += 1;
      done += got.bytes.length;
      step(`cats/${c.name}.enc`);
    });
    await pool(blobs, async (b) => {
      const bytes = await API.getBlob(b.name);
      if (!bytes) return;
      entries.push({ name: `blobs/${b.name}`, bytes });
      nBlobs += 1;
      done += bytes.length;
      step(`blobs/${b.name}`);
    });

    // counts 必须是**实际写入包里的数量**,不是计划值:导出途中被删的对象会
    // 静默缺席,报计划值会让用户以为包里有其实没有的东西
    return {
      bytes: zipStore(entries),
      counts: { cats: nCats, blobs: nBlobs, bytes: done + entries[0].bytes.length },
    };
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
        else failed.push(`${name}:HTTP ${res.status}`);
      } catch (e) {
        // 失败项带上原因(2026-10-06 审计 P3):只给名字的话用户无法判断是网络、
        // 密文不匹配还是别的 —— recover.html 那边已是「名称:原因」的同一口径
        failed.push(`${name}:${e?.message || '未知原因'}`);
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
      } catch (e) {
        failed.push(`${name}:${e?.message || '未知原因'}`);
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
