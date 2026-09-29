/* ============================================================
 * 进应用就该有内容 —— 纯 Node,零依赖
 *
 * 2026-09-29 用户反馈:电脑版、手机版打开,阅读区都是空白 +「从左侧选择一个分类」。
 * 查证结论:那不是缺陷,是从第一个提交起就有的默认行为(ui.js 的 enterApp 把
 * activeCat/activeNoteId 复位后直接落空态)。但用户每次进来都要自己重新找一遍
 * 位置 —— 应用其实知道该给他看什么。改成:回到上次读的那篇,没有则打开第一个
 * 分类的顶端那篇;真的一个分类都没有,才落「新建分类」引导。
 *
 * 本文件覆盖三件事:
 *   1. pickRestoreCategory 的三级降级链(纯函数,判别力最强)
 *   2. readLastRead / rememberRead 的容错与「复位不污染记忆」
 *   3. restoreReading 的**真实接线**(真实 openCategory + renderReadView,
 *      只桩 DOM / 网络 / localStorage),确保不是「算了但不落地」
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pickRestoreCategory, readLastRead, rememberRead, restoreReading, enterApp,
} from '../public/js/ui.js';
import { openCategory, activeNoteData, renderNoteList } from '../public/js/features/sidebar.js';
import { renderReadView } from '../public/js/features/note.js';
import { Store, store as appStore } from '../public/js/store.js';

const KEY = 'jmbiji.lastRead';

/* ---------- localStorage 桩 ---------- */
function withStorage(fn, initial = null) {
  const has = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
  const orig = globalThis.localStorage;
  const map = new Map();
  if (initial !== null) map.set(KEY, initial);
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
  try {
    return fn(map);
  } finally {
    if (has) globalThis.localStorage = orig; else delete globalThis.localStorage;
  }
}

/* ---------- 最小 DOM 桩(与 category-open-flow 同款) ---------- */
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
  /* ⚠️ 空串要当成「清空」而不是「文本就是空」:真实 DOM 里 `el.textContent = ''`
   * 会清掉子节点,之后再 appendChild 的内容仍算在 textContent 里。若把 '' 记成有效
   * 文本,showEmpty 那种「先清空再逐块追加」的写法就会让断言读到空串(实测踩过)。 */
  set textContent(v) { this.children = []; const s = String(v); this._text = s === '' ? null : s; }
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

/** document 只在用例体内存在;本函数是 async,调用方必须 await */
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

/** cats: { 分类名: 笔记数组 } —— 真实 Store + 真实 feature 函数接线后的 ctx
 *  @param {{failLoad?:boolean}} [opts] failLoad: 让 loadCategory 抛错,模拟
 *    离线 / 网络抖动 / 该分类已在别端删掉 */
function mkCtx(cats, { failLoad = false } = {}) {
  const nodes = new Map();
  const byId = (id) => {
    if (!nodes.has(id)) nodes.set(id, new FakeNode('div'));
    return nodes.get(id);
  };
  const store = new Store();
  store.set('lib', {
    loadCategory: async () => { if (failLoad) throw new Error('网络不通'); },
    listCategories: () => Object.keys(cats),
    sortedCategories: () => Object.keys(cats),
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
    /* 以下三个是真实实现:本文件的价值在于验证整条接线,而不是只验算出来的结果 */
    activeNoteData: () => activeNoteData(ctx),
    renderNoteList: () => renderNoteList(ctx),
    renderReadView: () => renderReadView(ctx),
    showEmpty: (text) => { empties.push(text); byId('readView').hidden = true; },
  };
  return { ctx, byId, store, empties };
}

/* ---------- 1. 降级链(纯函数) ---------- */

test('进应用:一个分类都没有 → 没有可打开的,交回调用方引导', () => {
  assert.equal(pickRestoreCategory([], null), null);
  assert.equal(pickRestoreCategory([], { cat: '甲', noteId: 'n1' }), null,
    '连分类都没有时,记忆里的分类名不该被当成有效目标');
});

test('进应用:没有记忆(首次使用)→ 打开第一个分类', () => {
  assert.equal(pickRestoreCategory(['甲', '乙'], null), '甲');
});

test('★ 进应用:记忆里的分类还在 → 回到那个分类(而不是第一个)', () => {
  assert.equal(pickRestoreCategory(['甲', '乙', '丙'], { cat: '丙', noteId: 'n9' }), '丙',
    '目标是「回到上次的位置」;退化成第一个分类就等于没记住');
});

test('★ 进应用:记忆里的分类已被删/改名 → 降级到第一个分类', () => {
  assert.equal(pickRestoreCategory(['甲', '乙'], { cat: '已经没了的分类', noteId: 'n9' }), '甲',
    '分类没了不能把启动流程带停,降级到第一个分类继续');
});

test('进应用:记忆里没有 noteId(只记了分类)→ 仍然回到该分类', () => {
  assert.equal(pickRestoreCategory(['甲', '乙'], { cat: '乙', noteId: null }), '乙');
});

/* ---------- 2. 记忆读写与容错 ---------- */

test('readLastRead:没有值/坏 JSON/缺分类名 一律当「没有」,不抛', () => {
  withStorage(() => {
    assert.equal(readLastRead(), null, '没写过 → null');

    globalThis.localStorage.setItem(KEY, '{这不是 JSON');
    assert.equal(readLastRead(), null, '坏 JSON 不得把启动流程带崩');

    globalThis.localStorage.setItem(KEY, JSON.stringify({ noteId: 'n1' }));
    assert.equal(readLastRead(), null, '没有分类名的记录无意义');

    globalThis.localStorage.setItem(KEY, JSON.stringify({ cat: '', noteId: 'n1' }));
    assert.equal(readLastRead(), null, '空分类名同样无意义');
  });
});

test('readLastRead:noteId 形态不对时归一成 null,但分类名保留', () => {
  withStorage(() => {
    globalThis.localStorage.setItem(KEY, JSON.stringify({ cat: '甲', noteId: 42 }));
    assert.deepEqual(readLastRead(), { cat: '甲', noteId: null });

    globalThis.localStorage.setItem(KEY, JSON.stringify({ cat: '甲', noteId: 'n1' }));
    assert.deepEqual(readLastRead(), { cat: '甲', noteId: 'n1' });
  });
});

test('rememberRead:正常记录当前分类与笔记', () => {
  withStorage((map) => {
    const store = new Store();
    store.set('activeCat', '甲');
    store.set('activeNoteId', 'n1');
    rememberRead(store);
    assert.deepEqual(JSON.parse(map.get(KEY)), { cat: '甲', noteId: 'n1' });
  });
});

test('★ rememberRead:复位态(锁屏清空)不得覆盖掉记忆', () => {
  withStorage((map) => {
    map.set(KEY, JSON.stringify({ cat: '甲', noteId: 'n1' }));

    const reset = new Store();               // 解锁前的复位:两个字段都是 null
    rememberRead(reset);
    assert.deepEqual(JSON.parse(map.get(KEY)), { cat: '甲', noteId: 'n1' },
      '清空状态不是「读到了哪」—— 写进去会把用户的位置抹掉');

    const half = new Store();                // 只有分类、还没选中笔记
    half.set('activeCat', '乙');
    rememberRead(half);
    assert.deepEqual(JSON.parse(map.get(KEY)), { cat: '甲', noteId: 'n1' },
      '还没落到具体某一篇时也不该改记忆');
  });
});

/* ---------- 3. 真实接线 ---------- */

test('★ 进应用:回到上次读的那一篇(不是该分类的置顶那篇)', async () => {
  await withDom(async () => {
    const { ctx, store } = mkCtx({
      甲: [mkNote('a', 1000, true), mkNote('b', 500)],   // 置顶的是 a
      乙: [mkNote('y1', 1000), mkNote('y2', 500)],
    });
    await withStorage(async () => {
      globalThis.localStorage.setItem(KEY, JSON.stringify({ cat: '甲', noteId: 'b' }));

      const opened = await restoreReading(ctx);

      assert.equal(opened, true, '有分类就该真的打开内容');
      assert.equal(store.get('activeCat'), '甲');
      assert.equal(store.get('activeNoteId'), 'b', '要回到上次读的 b,而不是置顶的 a');
      assert.equal(store.get('editing'), false, '进应用应落在读态');
    });
  });
});

test('★ 进应用:记忆里的笔记已被删 → 落到该分类的置顶那篇', async () => {
  await withDom(async () => {
    const { ctx, store } = mkCtx({ 甲: [mkNote('a', 1000, true), mkNote('b', 500)] });
    await withStorage(async () => {
      globalThis.localStorage.setItem(KEY, JSON.stringify({ cat: '甲', noteId: '早就删了的id' }));

      const opened = await restoreReading(ctx);

      assert.equal(opened, true);
      assert.equal(store.get('activeCat'), '甲', '分类还在,就该留在这个分类');
      assert.equal(store.get('activeNoteId'), 'a', '笔记没了要降级到顶端,而不是停在没有选中的状态');
    });
  });
});

test('★ 进应用:记忆里的分类已被删 → 打开第一个分类', async () => {
  await withDom(async () => {
    const { ctx, store } = mkCtx({
      甲: [mkNote('a', 1000)],
      乙: [mkNote('y1', 1000)],
    });
    await withStorage(async () => {
      globalThis.localStorage.setItem(KEY, JSON.stringify({ cat: '已删除的分类', noteId: 'n9' }));

      const opened = await restoreReading(ctx);

      assert.equal(opened, true);
      assert.equal(store.get('activeCat'), '甲', '降级到第一个分类');
      assert.equal(store.get('activeNoteId'), 'a');
    });
  });
});

test('进应用:没有记忆时打开第一个分类的顶端那篇', async () => {
  await withDom(async () => {
    const { ctx, store } = mkCtx({ 甲: [mkNote('a', 1000, true), mkNote('b', 500)] });
    await withStorage(async () => {
      const opened = await restoreReading(ctx);

      assert.equal(opened, true);
      assert.equal(store.get('activeCat'), '甲');
      assert.equal(store.get('activeNoteId'), 'a', '首次使用也应直接读到内容,而不是停在空态');
    });
  });
});

test('★ 进应用:一个分类都没有 → 如实报告没打开(由调用方落「新建分类」引导)', async () => {
  await withDom(async () => {
    const { ctx, store } = mkCtx({});
    await withStorage(async () => {
      const opened = await restoreReading(ctx);

      assert.equal(opened, false, '没有分类就不能假装打开了');
      assert.equal(store.get('activeCat'), null, '不该凭空写一个分类进去');
    });
  });
});

test('★ restoreReading:分类加载失败 → 如实返回「没打开」(否则调用方的兜底永不触发)', async () => {
  await withDom(async () => {
    const { ctx, store } = mkCtx({ 甲: [mkNote('a', 1000)] }, { failLoad: true });
    await withStorage(async () => {
      const opened = await restoreReading(ctx);

      assert.equal(opened, false,
        'openCategory 把失败吞在自己的 catch 里、且不碰阅读区 —— 这里若回报 true,调用方就永远不会落兜底');
      assert.equal(store.get('activeCat'), null, '失败时不该留下一个「像是打开了」的分类');
    });
  });
});

/* ---------- 4. enterApp 壳子:复位 → 定位 → 兜底 → 收尾 ----------
 * 为什么要单测这一层:上面所有用例都从 restoreReading 起步,而用户看到的是 enterApp。
 * 「复位顺序 / 兜底文案 / 订阅只注册一次」这三件事错了界面就对不上 —— 此前一行都没被
 * 覆盖(2026-09-29 复查自己上一轮改动时发现的缺口:改动主体不可测 = 等于没有护栏)。 */

/** enterApp 走的是模块级 `$() = document.getElementById`,所以要一整套 document 桩。
 *  任意 id 返回同一个节点:与真实页面同构(节点是静态的,只有 hidden 与文本在变)。 */
async function withAppDom(fn) {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, new FakeNode('div'));
    return nodes.get(id);
  };
  const has = Object.prototype.hasOwnProperty.call(globalThis, 'document');
  const orig = globalThis.document;
  globalThis.document = {
    getElementById: get,
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (t) => { const n = new FakeNode('#text'); n._text = String(t); return n; },
    addEventListener() {}, removeEventListener() {},
  };
  try {
    return await fn(get);
  } finally {
    /* enterApp 收尾会挂一个防抖计时器(刷新保存状态),它 500ms 后要碰 document ——
     * 本桩那时已撤掉。真实页面 document 一直在,这里必须显式取消,否则会变成
     * 「测试结束后仍有异步活动」的噪音报错。 */
    clearTimeout(appStore.get('statusTimer'));
    if (has) globalThis.document = orig; else delete globalThis.document;
  }
}

/** enterApp 用的是 ui.js 模块内的 store 单例(不是自造 ctx 里的那个)—— 要往那一个里种库。 */
function seedAppLib(cats, { failLoad = false } = {}) {
  appStore.set('lib', {
    loadCategory: async () => { if (failLoad) throw new Error('网络不通'); },
    listCategories: () => Object.keys(cats),
    sortedCategories: () => Object.keys(cats),
    catCount: (n) => (cats[n] ? cats[n].length : null),
    catPin: () => false,
    categoryInfo: (n) => (cats[n] ? { data: { notes: cats[n] } } : null),
  });
}

/** 空态框上那个按钮的文字(没有按钮返回 null) */
function emptyActionText(byId) {
  const btn = byId('emptyState').children.find((c) => c.tagName === 'BUTTON');
  return btn ? btn.textContent : null;
}

test('★ 进应用(壳):有分类 → 内容真的摆上阅读区,空态收起', async () => {
  await withAppDom(async (byId) => {
    await withStorage(async () => {
      seedAppLib({ 甲: [mkNote('a', 1000), mkNote('b', 500)] });

      await enterApp();

      assert.equal(appStore.get('activeCat'), '甲');
      assert.equal(byId('readView').hidden, false, '阅读区必须显示出来');
      assert.equal(byId('emptyState').hidden, true, '空态必须收起');
      assert.equal(appStore.get('lockMode'), null,
        '进应用必须清 lockMode —— 否则全局快捷键(含 J/K)会被守卫整类拦掉');
    });
  });
});

test('★★ 进应用(壳):分类在、但载入失败 → 落「可重试」的兜底,绝不停在「正在载入…」', async () => {
  await withAppDom(async (byId) => {
    await withStorage(async () => {
      seedAppLib({ 甲: [mkNote('a', 1000)] }, { failLoad: true });

      await enterApp();

      const box = byId('emptyState');
      assert.equal(box.hidden, false, '必须落到空态上,不能把阅读区晾着');
      assert.ok(!box.textContent.includes('正在载入'),
        `「正在载入…」不得成为最终文案(用户会一直等一个永远不会来的内容),实际:${box.textContent}`);
      assert.ok(box.textContent.includes('内容没能载入'), `实际文案:${box.textContent}`);
      assert.equal(emptyActionText(byId), '重试', '必须给一个能点的重试,而不是只留一句话等人猜');
    });
  });
});

test('进应用(壳):一个分类都没有 → 落「新建分类」,与载入失败区分开', async () => {
  await withAppDom(async (byId) => {
    await withStorage(async () => {
      seedAppLib({});

      await enterApp();

      const box = byId('emptyState');
      assert.equal(box.hidden, false);
      assert.ok(box.textContent.includes('还没有分类'), `实际文案:${box.textContent}`);
      assert.equal(emptyActionText(byId), '新建分类');
    });
  });
});

test('进应用(壳):反复解锁不会重复订阅 activeNoteId(否则回调越挂越多)', async () => {
  await withAppDom(async () => {
    await withStorage(async () => {
      seedAppLib({ 甲: [mkNote('a', 1000)] });

      await enterApp();
      await enterApp();

      const subs = appStore._subs.get('activeNoteId');
      assert.equal(subs ? subs.size : 0, 1,
        '「记住读到哪」必须只订阅一次:本函数每次解锁都会跑,重复订阅会让每次切换笔记都重复写一遍');
    });
  });
});
