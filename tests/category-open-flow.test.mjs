/* ============================================================
 * 组合链路:点分类 → 选中顶端笔记 → 从顶部开始阅读 —— 纯 Node,零依赖
 *
 * 为什么单独开一个文件:
 *   sidebar-guard 把 renderReadView 打成**桩**(只数调用次数),note-view 直接调
 *   **真函数**但自己造 activeNoteData。两头都没验过中间那层接线 ——
 *   「openCategory 写进去的 activeNoteId,activeNoteData 读的是不是同一处」
 *   若哪天写成两套字段,上面两个文件会同时全绿,而线上点分类一片空白。
 *   本文件用真实的 Store + 真实的 activeNoteData/renderNoteList/renderReadView
 *   把整条链路跑通,只桩掉 DOM 与网络。
 *
 * 覆盖用户提的两件事的**组合结果**:
 *   1. 点分类默认读列表最顶端那篇(置顶优先,与侧栏首行同源)
 *   2. 换笔记时阅读面从顶部开始(长文读到半途切分类不会落在新笔记中间)
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCategory, openNote, activeNoteData, renderNoteList } from '../public/js/features/sidebar.js';
import { renderReadView } from '../public/js/features/note.js';
import { Store } from '../public/js/store.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/* ---- 最小 DOM 桩 ---- */
class FakeNode {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = [];
    this.className = '';
    this.hidden = false;
    this.scrollTop = 0;
    this.tabIndex = -1;
    this.title = '';
    this.attrs = {};
    this.dataset = {};
    this._text = null;
    this._html = '';
  }
  appendChild(c) { this.children.push(c); return c; }
  append(...cs) { for (const c of cs) this.appendChild(c); }
  after() {}
  remove() {}
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener() {}
  removeEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  get classList() {
    const self = this;
    const list = () => String(self.className).split(/\s+/).filter(Boolean);
    const write = (arr) => { self.className = arr.join(' '); };
    return {
      contains: (c) => list().includes(c),
      add: (...cs) => { const a = list(); for (const c of cs) if (!a.includes(c)) a.push(c); write(a); },
      remove: (...cs) => write(list().filter((x) => !cs.includes(x))),
      toggle: (c, force) => {
        const has = list().includes(c);
        const want = force === undefined ? !has : !!force;
        if (want && !has) write([...list(), c]);
        if (!want && has) write(list().filter((x) => x !== c));
        return want;
      },
    };
  }
  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() {
    if (this._text !== null) return this._text;
    return this.children.map((c) => c.textContent).join('');
  }
  set innerHTML(v) { this._html = v; }
  get innerHTML() { return this._html; }
}

function mkNote(id, order, pin = false) {
  return { id, title: `标题${id}`, content: '', order, pin, createdAt: 1, updatedAt: 1, attachments: [] };
}

/* document 只在用例体内存在;结束后立刻撤掉(与 sidebar-guard 同款纪律,
 * 且因为本函数是 async,**调用方必须 await**,否则 finally 会与下一个用例的建桩交错) */
async function withDom(fn) {
  global.document = {
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (t) => { const n = new FakeNode('#text'); n._text = String(t); return n; },
  };
  try {
    return await fn();
  } finally {
    delete global.document;
  }
}

/** cats: { 分类名: 笔记数组 } —— 返回真实 Store + 真实 feature 函数接线后的 ctx */
function mkCtx(cats) {
  const nodes = new Map();
  const byId = (id) => {
    if (!nodes.has(id)) nodes.set(id, new FakeNode('div'));
    return nodes.get(id);
  };
  const store = new Store();
  store.set('lib', {
    loadCategory: async () => {},
    listCategories: () => Object.keys(cats),
    sortedCategories: () => Object.keys(cats),   // 渲染走它(moveCat 与列表同源)
    catCount: (n) => (cats[n] ? cats[n].length : null),
    catPin: () => false,
    categoryInfo: (n) => (cats[n] ? { data: { notes: cats[n] } } : null),
  });
  const empties = [];
  const ctx = {
    dom: { byId },
    store,
    icons: new Proxy({}, { get: () => '<svg/>' }),
    fmtTime: () => '刚刚',
    toast: () => {},
    modal: async () => null,
    closeDrawer: () => {},
    addNote: () => {},
    moveNote: () => {},
    toggleNotePin: () => {},
    copyText: () => {},
    renderMarkdown: () => { const n = new FakeNode('div'); n.className = 'md'; return n; },
    /* —— 以下四个是真实实现(不是桩),本文件的价值所在 —— */
    activeNoteData: () => activeNoteData(ctx),
    renderNoteList: () => renderNoteList(ctx),
    renderReadView: () => renderReadView(ctx),
    /* showEmpty 只能桩:真实的那份在 ui.js,而 ui.js 在 import 期就会绑一堆全局
     * 事件(它是应用入口)。桩按真实契约来:显示空状态 + 隐藏阅读面。
     * 为了让这份桩不会与真实实现悄悄分家,末尾有一条对 ui.js 源码的文本断言。 */
    showEmpty: (text) => { empties.push(text); byId('readView').hidden = true; },
  };
  return { ctx, byId, store, empties };
}

test('★ 组合链路:点分类 → 直接读到顶端那篇,且从顶部开始', async () => {
  await withDom(async () => {
    // 存储顺序故意乱:置顶的「a」order 更大 —— 顶端应是置顶项,不是数组首项
    const { ctx, byId, store, empties } = mkCtx({ 甲: [mkNote('b', 500), mkNote('a', 1000, true)] });
    byId('readView').scrollTop = 700; // 上次读的长文停在 700px 处

    await openCategory(ctx, '甲');

    assert.equal(store.get('activeNoteId'), 'a', '点分类要选中列表顶端那篇(置顶优先)');
    assert.equal(byId('readTitle').textContent, '标题a', '阅读视图渲染的必须是这一篇');
    assert.equal(byId('readView').scrollTop, 0, '阅读面要从顶部开始,不能沿用上一篇的位置');
    assert.equal(byId('readView').hidden, false, '有笔记就不该停在空状态');
    assert.deepEqual(empties, [], '不该出现「从左侧选择一条笔记」——那正是用户要多点的一步');
    assert.equal(store.get('editing'), false, '点分类应落在阅读态');
  });
});

test('★ 组合链路:长文读到半途再切分类 → 新笔记也从顶部开始', async () => {
  await withDom(async () => {
    /* order 越小越靠上(新建笔记取「末项 order + 1000」,所以新笔记落在底部)。
     * 乙 里 y2 的 order 更小 → 它才是列表顶端那行。 */
    const { ctx, byId, store } = mkCtx({
      甲: [mkNote('a', 1000, true), mkNote('b', 500)],
      乙: [mkNote('y1', 1000), mkNote('y2', 500)],
    });
    await openCategory(ctx, '甲');
    byId('readView').scrollTop = 1200; // 甲的长文读到很后面

    await openCategory(ctx, '乙');

    assert.equal(store.get('activeNoteId'), 'y2', '乙的顶端(order 最小的一条)');
    assert.equal(byId('readTitle').textContent, '标题y2');
    assert.equal(byId('readView').scrollTop, 0, '换分类同样要归零');
  });
});

test('★ 组合链路:重载当前分类(冲突回云端/多标签同步)→ 保持选中与阅读位置', async () => {
  await withDom(async () => {
    const { ctx, byId, store } = mkCtx({ 甲: [mkNote('a', 1000, true), mkNote('b', 500)] });
    await openCategory(ctx, '甲');   // 默认打开置顶的「a」
    openNote(ctx, 'b');              // 用户点列表里的「b」——必须走真实路径(它会 renderReadView)
    byId('readView').scrollTop = 640;

    await openCategory(ctx, '甲');   // 同一分类重载(冲突回云端 / 多标签同步都是这条路)

    assert.equal(store.get('activeNoteId'), 'b', '重载不该把正读着的人拽到顶端');
    assert.equal(byId('readView').scrollTop, 640, '同一篇重绘必须保持阅读位置');
  });
});

test('★ 组合链路:空分类才落空状态,并给「新建笔记」引导', async () => {
  await withDom(async () => {
    const { ctx, byId, empties } = mkCtx({ 丙: [] });
    await openCategory(ctx, '丙');
    assert.equal(empties.length, 1, '空分类应显示空状态');
    assert.match(empties[0], /暂无笔记/);
    assert.equal(byId('readView').hidden, true, '空状态下阅读面要收起');
  });
});

test('组合链路的 showEmpty 桩必须与 ui.js 的真实契约一致(防桩与实现悄悄分家)', () => {
  const src = readFileSync(join(ROOT, 'public/js/ui.js'), 'utf8');
  const m = /function showEmpty\([\s\S]*?\n}/.exec(src);
  assert.ok(m, 'ui.js 里应能找到 showEmpty 定义');
  assert.match(m[0], /\$\('readView'\)\.hidden = true;/, '真实 showEmpty 必须隐藏 #readView(桩按此建模)');
  assert.match(m[0], /box\.hidden = false;/, '真实 showEmpty 必须显示空状态容器');
});
