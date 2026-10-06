/* ============================================================
 * 会话状态的单一容器(可订阅)
 * ------------------------------------------------------------
 * 为什么需要:
 *   ui.js 原先散着 245 处 `S.xxx` 直访 —— 改状态的地方和读状态的地方
 *   混在一个 2000 行文件里,「设了值但忘了刷 UI」没有任何机制兜底
 *   (典型:搜索点击里手动补了一次 renderCategoryList,漏补就静默失效)。
 *
 * 设计取向(刻意克制):
 *   - **只做状态的单一入口**,不接管渲染。现有显式 render*() 调用一律保留,
 *     渲染时序完全不变 → 行为等价,可用真机护栏严格验证。
 *   - subscribe 是**可选**能力,为后续按 feature 拆分时准备的。
 *   - set() 做**值相等短路**:值没变则不通知。这条是订阅机制的安全底线 ——
 *     没有它,「订阅回调里又 set 回同一个值」会直接把调用链打成死循环。
 *
 * 边界(不放进 store 的东西):
 *   - 纯流程控制的一次性句柄/标志(autoSaveTimer/saving/resavePending 等)
 *     不驱动 UI,放进来只会增加噪音。它们由各自流程本地持有。
 * ============================================================ */

/** 会话态字段的默认值(单一出处)。
 *  含两类:① 驱动 UI 的状态(可订阅);② 流程控制句柄/标志。
 *  ② 本可留在各流程本地,但因为 `S` 是指向本 store 的代理(见 createProxy),
 *  任何字段读写都会落到这里 —— 与其留成隐式字段,不如显式声明、由单测护栏兜住。 */
export function defaultState() {
  return {
    // ① 驱动 UI 的状态
    lib: null,             // Library 实例(持密钥与明文;锁屏即置 null)
    vaultJson: null,       // 解锁前拉到的 vault.json(解锁成功后转存进 Library)
    vaultEtag: null,       // vault.json 的 etag(改密码 CAS 用)
    activeCat: null,       // 当前选中的分类名
    activeNoteId: null,    // 当前打开的笔记 id
    editing: false,        // 是否处于编辑态
    lockMode: null,        // 锁屏态:'loading'(探测中)/ 'setup'(建库)/ 'unlock'(解锁)/ 进应用后为 null
    dirty: new Set(),      // 有未保存改动的分类名
    dirtyGen: new Map(),   // 分类名 → 改动代数。markDirty 每加一次该分类就 +1;
                           // saveCategory 的 await 期间若用户又改了同一分类,代数会变,
                           // 保存结束后据此判断「这轮存的是不是最新内容」——避免无条件
                           // 把新改动一并从 dirty 里抹掉(2026-09-27 审计 P1 竞态)。
    tabs: null,            // TabSync:同浏览器多标签页通知(可能不可用)
    objectUrls: new Map(), // blobName → objectURL(图片展示缓存)
    // ② 流程控制(不驱动 UI,但经代理读写故一并声明)
    settings: { autoLockMinutes: 0, rememberDevice: true, lastExportAt: 0 },
    saving: false,         // saveAll 是否正在跑(防重入)
    savePromise: null,     // saveAll 本轮的 promise:让 lockNow 等到「真的存完了」
                           // (2026-10-06 审计 P1:此前 S.saving 时直接 return,
                           //  lockNow await 的是 undefined → 在途保存被 destroy 打断,
                           //  未保存改动静默丢失)
    resavePending: false,  // saveAll 期间又来新改动:本轮结束后补跑
    autoSaveTimer: null,   // 空闲自动保存的 setTimeout 句柄
    statusTimer: null,     // 状态栏防抖刷新的 setTimeout 句柄
    idleTimer: null,       // 自动锁屏的 setTimeout 句柄
  };
}

export class Store {
  constructor(initial = defaultState()) {
    this._state = initial;
    this._subs = new Map();   // key → Set<fn>
    this._any = new Set();    // 监听全部变更的订阅者(调试/护栏用)
  }

  /** 读取。字段不存在返回 undefined(与直访对象一致,不抛错)。 */
  get(key) { return this._state[key]; }

  /**
   * 写入。值相等则短路(不通知、不改变引用)。
   * @returns {boolean} 是否真的发生了变更
   *
   * ⚠️ 短路是硬性要求:subscribe 回调里若再 set 同值,没有短路就会无限递归。
   *    对 Set/Map 这类容器,按「引用相等即短路」处理 —— 调用方原地 mutate 容器
   *    (如 `S.dirty.add(x)` / `S.settings.x = 1`)时不触发通知(这是既有代码的
   *    使用方式,保持一致)。
   *
   * ⚠️⚠️ 由此推出一条**必须遵守的规则**:凡是有人 subscribe 的字段,
   *    **必须整体换新对象**(`store.set('settings', {...S.settings, x: 1})`),
   *    不能原地改属性。原地改不会发出通知,订阅者会静默失联。
   *    S1 阶段尚无订阅者,故既有原地改法行为不变;S2/S3 引入订阅时必须先改造。
   */
  set(key, value) {
    const prev = this._state[key];
    if (Object.is(prev, value)) return false;
    this._state[key] = value;
    this._emit(key, value, prev);
    return true;
  }

  /* ---------- 脏标记:Set + 代数 Map 成对维护 ---------- */

  /**
   * 标记某分类有未保存改动,并把它的改动代数 +1。
   * @returns {number} 该分类此刻的代数
   *
   * ⚠️ 必须走这里,不要直接 `dirty.add()` —— 代数 Map 是 saveAll
   *    判定「await 期间是否又改了」的唯一凭据,漏加会让新旧改动无法区分。
   */
  markDirty(name) {
    this._state.dirty.add(name);
    const gen = (this._state.dirtyGen.get(name) || 0) + 1;
    this._state.dirtyGen.set(name, gen);
    return gen;
  }

  /**
   * 仅当该分类自 `gen` 以来没有新改动时才移出待保存队列。
   * @returns {boolean} 是否真的移除了(未移除说明 await 期间用户又改了)
   */
  clearDirtyIfUnchanged(name, gen) {
    if (this._state.dirtyGen.get(name) !== gen) return false;
    this._state.dirty.delete(name);
    this._state.dirtyGen.delete(name);
    return true;
  }

  /**
   * 无条件移出待保存队列(删除分类/丢弃改动等场景),两处一起清。
   * @returns {boolean} 此前是否在队列里
   */
  clearDirty(name) {
    this._state.dirtyGen.delete(name);
    return this._state.dirty.delete(name);
  }

  /** 清空全部脏标记(锁屏放弃改动)。 */
  clearAllDirty() {
    this._state.dirty.clear();
    this._state.dirtyGen.clear();
  }

  /** 重命名分类时把脏标记与代数一并搬到新名字下(重命名不改变内容新旧)。 */
  moveDirty(from, to) {
    if (!this._state.dirty.delete(from)) return false;
    this._state.dirty.add(to);
    const gen = this._state.dirtyGen.get(from);
    this._state.dirtyGen.delete(from);
    if (gen !== undefined) this._state.dirtyGen.set(to, gen);
    return true;
  }

  /** 批量写入:只通知一次(避免中途状态被订阅者看到半成品)。 */  patch(obj) {
    const changed = [];
    for (const [k, v] of Object.entries(obj)) {
      const prev = this._state[k];
      if (Object.is(prev, v)) continue;
      this._state[k] = v;
      changed.push([k, v, prev]);
    }
    for (const [k, v, prev] of changed) this._emit(k, v, prev);
    return changed.length > 0;
  }

  /**
   * 订阅某个键的变更。返回退订函数。
   * @param {string} key
   * @param {(value:any, prev:any)=>void} fn
   */
  subscribe(key, fn) {
    if (!this._subs.has(key)) this._subs.set(key, new Set());
    this._subs.get(key).add(fn);
    return () => { this._subs.get(key)?.delete(fn); };
  }

  /** 订阅任意键的变更(调试/护栏观测用)。返回退订函数。 */
  subscribeAny(fn) {
    this._any.add(fn);
    return () => { this._any.delete(fn); };
  }

  _emit(key, value, prev) {
    const subs = this._subs.get(key);
    if (subs) {
      // 复制一份再遍历:回调里退订/新增订阅不会打乱本轮遍历
      for (const fn of [...subs]) {
        try { fn(value, prev); } catch (e) { console.error('store 订阅回调异常', key, e); }
      }
    }
    for (const fn of [...this._any]) {
      try { fn(key, value, prev); } catch (e) { console.error('store 订阅回调异常', key, e); }
    }
  }

  /** 测试辅助:导出快照(浅拷贝)。 */
  snapshot() { return { ...this._state }; }
}

/** 全应用共享的单例。ui.js 与各 feature 都从这里读写会话态。 */
export const store = new Store();

/**
 * 把 Store 包装成「看起来像普通对象」的代理,供既有代码零改动地直访。
 *
 * 为什么要有它:ui.js 里已有 272 处 `S.xxx` 直访(读写混用)。
 * 逐处改写成 store.get/set 会把 `S.lib.loadCategory()` 变成
 * `store.get('lib').loadCategory()` —— 改动面大且可读性反而下降。
 * 用代理后:读写语法完全不变,但状态真实汇聚在 Store 里(单一容器 + 可订阅)。
 *
 * ⚠️ 未声明字段也可写(inline 直访的既有行为),但**必须先在 defaultState 声明**,
 *    否则 tests/store.test.mjs 的「字段齐全」用例会红 —— 那是有意设置的护栏。
 */
export function createProxy(st) {
  return new Proxy({}, {
    get(_t, key) {
      if (typeof key === 'symbol') return undefined;
      const v = st.get(key);
      if (v !== undefined) return v;
      // ★ 字段里没有 → 回落到 Store 原型上的方法,并**绑定到真实 store**。
      //   否则 `S.markDirty(x)` 会抛「不是函数」;即便拿到也会把 this 绑成
      //   Proxy 本身,方法内 `this._state` 经代理读到 undefined → 抛错。
      //   (2026-09-27:引入 S.markDirty/S.clearDirty 等状态方法后发现)
      const proto = Store.prototype[key];
      if (typeof proto === 'function') return proto.bind(st);
      return undefined;
    },
    set(_t, key, value) {
      st.set(key, value);
      return true;
    },
    has(_t, key) { return st.get(key) !== undefined; },
    ownKeys() { return Object.keys(st.snapshot()); },
    getOwnPropertyDescriptor() { return { enumerable: true, configurable: true }; },
  });
}
