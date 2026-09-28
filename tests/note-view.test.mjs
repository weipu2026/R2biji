/* ============================================================
 * 阅读视图(renderReadView)行为契约 —— 纯 Node,零依赖
 *
 * 桩一份最小 DOM,直接驱动 public/js/features/note.js 的**真实实现**。
 * 这个函数此前没有单测(仅 sidebar-guard 里以桩代过),所以它的回归是无声的。
 *
 * 钉住两条:
 *   1. 换笔记 → 阅读面必须滚回顶部。滚动容器是 #readView(overflow-y:auto),
 *      而 renderReadView 只重填 #readBody,容器 scrollTop 会原样留着 ——
 *      从长文中段去点分类/点笔记就会落在新笔记中间(2026-09-28 通栏阅读上线后暴露)。
 *   2. 同一篇重绘 → 保持位置。编辑完成 / 冲突取云端版 / 多标签页同步都属于这类,
 *      那时用户正读着这一篇,拽回顶部是打扰。
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReadView } from '../public/js/features/note.js';

/* ---- 最小 DOM 桩:createElement + 三个属性 + querySelectorAll ---- */
class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.className = '';
    this.hidden = false;
    this.scrollTop = 0; // 滚动容器要的就是这个
    this.dataset = {};
    this._text = null;
    this._listeners = [];
  }
  appendChild(c) { this.children.push(c); return c; }
  append(...cs) { for (const c of cs) this.appendChild(c); }
  after() {}
  remove() {}
  addEventListener(ev, fn) { this._listeners.push([ev, fn]); }
  removeEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; } // 测试内容里没有 .blk 块
  get classList() {
    const self = this;
    return { contains: (c) => self.className.split(/\s+/).includes(c), add() {}, remove() {} };
  }
  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() {
    if (this._text !== null) return this._text;
    return this.children.map((c) => c.textContent).join('');
  }
  set innerHTML(v) { this._html = v; }
  get innerHTML() { return this._html || ''; }
}

/** 同一次调用内共享的节点表;byId 对未知 id 现造节点(与浏览器不同,但够用) */
function mkCtx(noteRef, calls) {
  const nodes = new Map();
  const byId = (id) => {
    if (!nodes.has(id)) nodes.set(id, new FakeNode('div'));
    return nodes.get(id);
  };
  return {
    dom: { byId },
    store: { get: () => new Map(), patch() {} },
    activeNoteData: () => noteRef.current,
    fmtTime: (t) => `t${t}`,
    renderMarkdown: () => { const n = new FakeNode('div'); n.className = 'md'; return n; },
    icons: { copy: '<svg/>' },
    copyText: () => {},
    showEmpty: (text) => { calls.push(['empty', text]); },
    _nodes: nodes,
    _byId: byId,
  };
}

function mkNote(id, content = 'x') {
  return { id, title: `标题${id}`, content, updatedAt: 1700000000000, attachments: [] };
}

test('★ 换笔记:阅读面滚回顶部(否则从长文中段点分类会落在新笔记中间)', () => {
  const noteRef = { current: mkNote('a') };
  const calls = [];
  const ctx = mkCtx(noteRef, calls);
  const view = ctx._byId('readView');

  view.scrollTop = 500; // 上一条长笔记读到一半
  renderReadView(ctx);
  assert.equal(view.scrollTop, 0, '换笔记必须归零,否则第一条就落在半途');
  assert.equal(ctx._byId('readTitle').textContent, '标题a', '顺带确认确实渲染了这一条');

  view.scrollTop = 900; // 长文读到很后面
  noteRef.current = mkNote('b');
  renderReadView(ctx);
  assert.equal(view.scrollTop, 0, '再换一条也要归零');
  assert.equal(ctx._byId('readTitle').textContent, '标题b');
});

test('★ 同一篇重绘:必须保持阅读位置(编辑完成/冲突回云端/多标签同步不该把人拽回顶部)', () => {
  const noteRef = { current: mkNote('a') };
  const ctx = mkCtx(noteRef, []);
  const view = ctx._byId('readView');

  renderReadView(ctx);
  view.scrollTop = 640; // 用户正读到这一篇的中间
  renderReadView(ctx); // 例如保存后重绘、或多标签页同步重载
  assert.equal(view.scrollTop, 640, '同一篇重绘不得归零');
});

test('★ 落回空状态后再开笔记:位置同样要归零(空状态是另一次进入)', () => {
  const noteRef = { current: mkNote('a') };
  const calls = [];
  const ctx = mkCtx(noteRef, calls);
  const view = ctx._byId('readView');

  renderReadView(ctx);
  view.scrollTop = 300;
  noteRef.current = null; // 例如分类被别的标签页删掉 → showEmpty('从左侧选择一条笔记')
  renderReadView(ctx);
  assert.equal(calls.at(-1)[0], 'empty', '没有笔记时应落空状态');
  assert.equal(calls.at(-1)[1], '从左侧选择一条笔记');

  view.scrollTop = 700; // 空状态期间容器位置(近似)
  noteRef.current = mkNote('a'); // 又打开了同一篇
  renderReadView(ctx);
  assert.equal(view.scrollTop, 0, '从空状态回来后应从头读,不能沿用旧位置');
});

test('阅读视图:正文节点被整体替换,不叠加(重绘不重复插入)', () => {
  const noteRef = { current: mkNote('a') };
  const ctx = mkCtx(noteRef, []);
  const body = ctx._byId('readBody');
  renderReadView(ctx);
  const first = body.children.length;
  renderReadView(ctx);
  assert.equal(body.children.length, first, '每次重绘前必须清空 readBody,否则正文会叠成 N 份');
});
