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
import { renderCategoryList, renderNoteList, activeNoteData, openCategory } from '../public/js/features/sidebar.js';
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
      toggle: (c, on) => { if (on === undefined) { self.classes.has(c) ? self.classes.delete(c) : self.classes.add(c); } else if (on) self.classes.add(c); else self.classes.delete(c); },
      contains: (c) => self.classes.has(c),
    };
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener() {}
  removeEventListener() {}
}

/* ★ 所有调用方一律 `await withDom(...)` —— **同步体也要 await**:
 *   本函数在 finally 里 `delete global.document`,不 await 时这次清理会与下一个
 *   用例的建桩在微任务队列里交错,「测试能不能过」就变成依赖调度顺序的侥幸。
 *   (2026-09-28 复查:withDom 改成 async 后旧用例没跟着 await,当时靠队列顺序侥幸成立。) */
async function withDom(fn) {
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
    // await:调用方可能传 async 函数(如 openCategory)——不 await 的话,
    // finally 会在异步体跑到一半时就删掉 global.document,中途报「undefined」假错
    return await fn(ctx, byId);
  } finally {
    delete global.document;
  }
}

test('★ renderCategoryList:lib 为 null 时不抛错(锁屏竞态护栏)', async () => {
  await withDom((ctx) => {
    const st = new Store();               // lib 初值就是 null
    assert.equal(st.get('lib'), null, '前置:lib 确实是 null');
    assert.doesNotThrow(() => renderCategoryList(ctx(st)),
      '★ 修回 `lib.listCategories()` 直解引用会在这里抛 TypeError');
  });
});

test('★ renderNoteList:lib 为 null 时不抛错,且标题降级为「未选择分类」', async () => {
  await withDom((ctx, byId) => {
    const st = new Store();
    st.set('activeCat', '甲');            // 有选中分类,但 lib 仍为 null
    assert.doesNotThrow(() => renderNoteList(ctx(st)));
    assert.equal(byId('activeCatName').textContent, '未选择分类',
      'lib 为空时标题要降级,不能停留在旧值');
  });
});

test('★ renderNoteList:无选中分类时不抛错', async () => {
  await withDom((ctx) => {
    const st = new Store();               // activeCat 也是 null
    assert.doesNotThrow(() => renderNoteList(ctx(st)));
  });
});

test('★ activeNoteData:lib 为 null 时返回 null 而非抛错', async () => {
  await withDom((ctx) => {
    const st = new Store();
    st.set('activeCat', '甲');            // 迫使走到 categoryInfo 那一行
    let r;
    assert.doesNotThrow(() => { r = activeNoteData(ctx(st)); });
    assert.equal(r, null, 'lib 缺失应视作「没有这篇笔记」');
  });
});

test('lib 正常存在时,渲染照常产出分类项(护栏不能把功能挡掉)', async () => {
  await withDom((ctx, byId) => {
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

/* ---- openCategory 的「点分类即读第一篇」契约(2026-09-28 用户要求)----
 * 点分类默认打开列表最顶端那篇,省掉「再点一次笔记」这步;
 * 例外:重载当前分类(冲突回云端 / 多标签页同步)时原选中还在就保持,
 * 别把正读着的人拽到顶端。顺序必须走 sortNotes —— 视觉第一行就是第一篇。 */

function mkNote(id, order, pin = false) {
  return { id, order, pin, createdAt: 1, updatedAt: 1, title: `笔记${id}`, content: '' };
}

/* 各用例共用的行为记录器(用例内先归零再用) */
const rec = { read: 0, empty: 0, emptyText: '', emptyOpts: null };

test('★ openCategory:点分类自动打开列表最顶端那篇(置顶优先,即 sortNotes 首项)', async () => {
  await withDom(async (ctx, byId) => {
    // 存储顺序故意乱:置顶的「a」order 更大 —— 顶端是置顶项,不是数组首项
    const notes = [mkNote('b', 500), mkNote('a', 1000, true)];
    const st = new Store();
    st.set('lib', {
      loadCategory: async () => {},
      listCategories: () => ['甲'],
      catPin: () => false,
      catCount: () => 2,
      categoryInfo: () => ({ data: { notes } }),
    });
    rec.read = 0; rec.empty = 0;
    const c = { ...ctx(st), closeDrawer: () => {}, fmtTime: () => '',
      renderReadView: () => { rec.read++; },
      showEmpty: () => { rec.empty++; } };
    await openCategory(c, '甲');
    assert.equal(st.get('activeNoteId'), 'a',
      '★ 修回 activeNoteId: null 会在这里红 —— 点分类必须默认读最顶端那篇');
    assert.equal(rec.read, 1, '应直接进阅读视图');
    assert.equal(rec.empty, 0, '不该再出现「从左侧选择一条笔记」空态(那就是用户要多点的一步)');
  });
});

test('★ openCategory:重载当前分类时,原选中的笔记还在就保持不动', async () => {
  await withDom(async (ctx) => {
    const notes = [mkNote('b', 500), mkNote('a', 1000)];
    const st = new Store();
    st.set('lib', {
      loadCategory: async () => {},
      listCategories: () => ['甲'],
      catPin: () => false,
      catCount: () => 2,
      categoryInfo: () => ({ data: { notes } }),
    });
    st.set('activeNoteId', 'b'); // 用户正读着「b」(如多标签页同步触发重载)
    rec.read = 0; rec.empty = 0;
    const c = { ...ctx(st), closeDrawer: () => {}, fmtTime: () => '',
      renderReadView: () => { rec.read++; },
      showEmpty: () => { rec.empty++; } };
    await openCategory(c, '甲');
    assert.equal(st.get('activeNoteId'), 'b', '重载不该把正读着的人拽到顶端');
    assert.equal(rec.read, 1, '仍应重绘阅读视图(内容可能已更新)');
  });
});

test('★ openCategory:真正空分类才落空状态,并给「新建笔记」引导', async () => {
  await withDom(async (ctx) => {
    const st = new Store();
    st.set('lib', {
      loadCategory: async () => {},
      listCategories: () => ['甲'],
      catPin: () => false,
      catCount: () => 0,
      categoryInfo: () => ({ data: { notes: [] } }),
    });
    rec.read = 0; rec.empty = 0; rec.emptyText = '';
    const c = { ...ctx(st), closeDrawer: () => {}, fmtTime: () => '',
      renderReadView: () => { rec.read++; },
      showEmpty: (text, opts) => { rec.emptyText = text; rec.emptyOpts = opts; rec.empty++; } };
    await openCategory(c, '甲');
    assert.equal(st.get('activeNoteId'), null, '没笔记可选,选中态应为空');
    assert.equal(rec.empty, 1, '空分类要显示空状态');
    assert.match(rec.emptyText, /暂无笔记/);
    assert.equal(rec.emptyOpts?.label, '新建笔记', '空分类保留「新建笔记」引导');
    assert.equal(rec.read, 0, '没有笔记就不该进阅读视图');
  });
});
