/* 侧栏渲染的「lib 为空」护栏单测。
 *
 * 背景(2026-09-27 全站审计 P2):
 *   renderCategoryList / renderNoteList / activeNoteData 此前直接
 *   `S.get('lib').xxx()`。锁屏或切库的极短竞态里 lib 已被置 null
 *   (store.js:releaseSession),此时渲染会抛 TypeError 打断整条链。
 *
 * 这组用例把「lib 为 null 时不得抛错」钉成契约 —— 修回旧写法必须翻红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCategoryList, renderNoteList, activeNoteData } from '../public/js/features/sidebar.js';
import { Store } from '../public/js/store.js';

/* ---- 最小 DOM 桩:只需 createElement + classList + textContent + appendChild ---- */
class FakeNode {
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
  }
  appendChild(c) { this.children.push(c); return c; }
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
      toggle: (c, on) => { if (on === undefined) { self.classes.has(c) ? self.classes.delete(c) : self.classes.add(c); } else if (on) self.classes.add(c); else self.classes.delete(c); },
      contains: (c) => self.classes.has(c),
    };
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener() {}
  removeEventListener() {}
}

function withDom(fn) {
  const nodes = new Map();
  global.document = {
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (t) => { const n = new FakeNode(undefined); n._text = t; return n; },
  };
  // byId 返回稳定的节点:同一 id 反复取到同一个,便于断言
  const byId = (id) => {
    if (!nodes.has(id)) nodes.set(id, new FakeNode('div'));
    return nodes.get(id);
  };
  const ctx = (store) => ({
    store,
    dom: { byId },
    icons: new Proxy({}, { get: () => '<svg></svg>' }),
    toast: () => {},
    modal: async () => null,
  });
  try {
    return fn(ctx, byId);
  } finally {
    delete global.document;
  }
}

test('★ renderCategoryList:lib 为 null 时不抛错(锁屏竞态护栏)', () => {
  withDom((ctx) => {
    const st = new Store();               // lib 初值就是 null
    assert.equal(st.get('lib'), null, '前置:lib 确实是 null');
    assert.doesNotThrow(() => renderCategoryList(ctx(st)),
      '★ 修回 `lib.listCategories()` 直解引用会在这里抛 TypeError');
  });
});

test('★ renderNoteList:lib 为 null 时不抛错,且标题降级为「未选择分类」', () => {
  withDom((ctx, byId) => {
    const st = new Store();
    st.set('activeCat', '甲');            // 有选中分类,但 lib 仍为 null
    assert.doesNotThrow(() => renderNoteList(ctx(st)));
    assert.equal(byId('activeCatName').textContent, '未选择分类',
      'lib 为空时标题要降级,不能停留在旧值');
  });
});

test('★ renderNoteList:无选中分类时不抛错', () => {
  withDom((ctx) => {
    const st = new Store();               // activeCat 也是 null
    assert.doesNotThrow(() => renderNoteList(ctx(st)));
  });
});

test('★ activeNoteData:lib 为 null 时返回 null 而非抛错', () => {
  withDom((ctx) => {
    const st = new Store();
    st.set('activeCat', '甲');            // 迫使走到 categoryInfo 那一行
    let r;
    assert.doesNotThrow(() => { r = activeNoteData(ctx(st)); });
    assert.equal(r, null, 'lib 缺失应视作「没有这篇笔记」');
  });
});

test('lib 正常存在时,渲染照常产出分类项(护栏不能把功能挡掉)', () => {
  withDom((ctx, byId) => {
    const st = new Store();
    st.set('lib', {
      listCategories: () => ['甲', '乙'],
      catPin: () => false,
      catCount: () => null,
      categoryInfo: () => ({ data: { notes: [] } }),
      setCatPin: async () => {},
    });
    renderCategoryList(ctx(st));
    const ul = byId('catList');
    assert.equal(ul.children.length, 2, '正常路径要真的画出两个分类');
  });
});
