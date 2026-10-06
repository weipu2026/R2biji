/* ============================================================
 * 端侧 DOM 最小替身 —— 供 features/ 的接线用例共用
 * ------------------------------------------------------------
 * 为什么抽成共享模块:同一份替身写两遍,两份迟早分叉 —— 而「替身与真实 DOM 的
 * 语义分叉」是最危险的一类假绿(被测代码错、断言照样绿)。e2e.test.mjs 里
 * 「响应体只能读一次」那条注释记的就是同一类教训。
 * 它只服务「接线是否接上」这类断言(哪个按钮在、点了调谁、状态怎么变),
 * 不模拟布局与真实事件冒泡 —— 视觉与手势仍需真机验证。
 * ============================================================ */

export class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.classes = new Set();
    this.dataset = {};
    this._text = null;
    this.title = '';
    this.innerHTML = '';
    this.tabIndex = 0;
    this.attrs = {};
    this.handlers = {};      // 记录监听器,便于用例直接触发按钮行为(不模拟真实事件冒泡)
    this.hidden = false;
    this.value = '';
    this.open = true;
  }
  appendChild(c) { c._parent = this; this.children.push(c); return c; }
  append(...cs) { for (const c of cs) this.appendChild(c); }
  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() {
    if (this._text !== null) return this._text;
    return this.children.map((c) => c.textContent).join('');
  }
  set className(v) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classes].join(' '); }
  get classList() {
    const self = this;
    return {
      add: (...cs) => cs.forEach((c) => self.classes.add(c)),
      remove: (...cs) => cs.forEach((c) => self.classes.delete(c)),
      toggle: (c, on) => {
        if (on === undefined) { self.classes.has(c) ? self.classes.delete(c) : self.classes.add(c); }
        else if (on) self.classes.add(c);
        else self.classes.delete(c);
      },
      contains: (c) => self.classes.has(c),
    };
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(ev, fn) { (this.handlers[ev] ||= []).push(fn); }
  removeEventListener() {}
  /** 触发本节点上注册的某个事件(用例直接驱动,不经真实事件系统) */
  fire(ev, arg = {}) {
    for (const fn of this.handlers[ev] || []) fn({ stopPropagation() {}, preventDefault() {}, target: this, ...arg });
  }

  /* ---- 供「整表重建后的焦点还原」用例 ---- */
  contains(n) { let p = n; while (p) { if (p === this) return true; p = p._parent; } return false; }
  /** 只支持 [data-focus-key="…"] —— 生产代码只用这一种选择器 */
  querySelector(sel) {
    const m = /^\[data-focus-key="(.*)"\]$/.exec(sel);
    if (!m) return null;
    let found = null;
    const walk = (n) => {
      for (const c of n.children || []) {
        if (!found && c.dataset && c.dataset.focusKey === m[1]) found = c;
        if (!found) walk(c);
      }
    };
    walk(this);
    return found;
  }
  /** 只支持「后代里的 .class」与「自身 .class」两种 —— 生产代码(render.js 的
   *  敏感行预判)只用这一种。不支持的 selector 直接抛错,免得「静默返回空」
   *  让用例把「选择器没匹配上」读成「元素不存在」(2026-10-06 踩过)。 */
  querySelectorAll(sel) {
    const cls = /^\.([\w-]+)$/.exec(sel);
    if (!cls) throw new Error(`FakeNode.querySelectorAll 只支持 .class,收到:${sel}`);
    const out = [];
    const walk = (n) => {
      for (const c of n.children || []) {
        if (c.classes && c.classes.has(cls[1])) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  focus() { if (globalThis.document) globalThis.document.activeElement = this; }
  /** 深克隆(render.js 的 cloneWithoutStars 会用)。子树结构复制,
   *  children 逐个克隆 —— 与真实 DOM 的 cloneNode(true) 语义一致。 */
  cloneNode(deep = false) {
    const c = new FakeNode(this.tag);
    c.classes = new Set(this.classes);
    c.dataset = { ...this.dataset };
    c.attrs = { ...this.attrs };
    c._text = this._text;
    c.title = this.title;
    if (deep) for (const ch of this.children) c.children.push(ch.cloneNode ? ch.cloneNode(true) : ch);
    return c;
  }
  remove() { const p = this._parent; if (p) p.children = p.children.filter((c) => c !== this); }
  /** <dialog> 的关闭。用例可覆盖它来观测「弹窗被关掉」这件事。 */
  close() { this.open = false; }
}

/**
 * 建一套 DOM 桩并跑用例。
 *
 * ★ 一律 `await withDom(...)` —— **同步体也要 await**:本函数在 finally 里
 *   `delete global.document`,不 await 时清理会与下一个用例的建桩在微任务队列里
 *   交错,「测试能不能过」就变成依赖调度顺序的侥幸。
 *
 * @param {(ctx:(store:any)=>object, byId:(id:string)=>FakeNode, nodes:Map)=>any} fn
 * @param {(store:any, byId:(id:string)=>FakeNode, nodes:Map)=>object} [makeCtx]
 *        自定义 ctx(默认给 icons 万能替身、静默 toast、取消的 modal)
 */
export async function withDom(fn, makeCtx) {
  const nodes = new Map();
  const byId = (id) => {
    if (!nodes.has(id)) nodes.set(id, new FakeNode('div'));
    return nodes.get(id);
  };
  globalThis.document = {
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (t) => { const n = new FakeNode(undefined); n._text = t; return n; },
    activeElement: null,          // focus() 会写它;captureFocusKey 读它
    getElementById: (id) => byId(id),
    // 生产代码在 document 上挂 visibilitychange / pagehide 等监听(ui.js 的
    // startIdleTimer、shell.js 的离开前保存),缺了会直接抛 TypeError
    addEventListener() {},
    removeEventListener() {},
    hidden: false,
  };
  const build = makeCtx || ((store, byIdFn) => ({
    store,
    dom: { byId: byIdFn },
    icons: new Proxy({}, { get: () => '<svg></svg>' }),
    toast: () => {},
    modal: async () => null,
  }));
  const ctx = (store) => build(store, byId, nodes);
  try {
    return await fn(ctx, byId, nodes);
  } finally {
    delete globalThis.document;
  }
}

/** localStorage 替身(Node 里没有)。session.js / api.js 与阅读位置都按
 *  「不可用就降级」写,这里给可用版本,才能测到真实路径。 */
export function withLocalStorage() {
  const map = new Map();
  const prev = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
  return {
    map,
    restore() { if (prev === undefined) delete globalThis.localStorage; else globalThis.localStorage = prev; },
  };
}
