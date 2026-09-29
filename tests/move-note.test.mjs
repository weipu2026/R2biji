/* ============================================================
 * 分类改名 / 跨分类移动 —— 端侧接线护栏(2026-09-29)
 * ------------------------------------------------------------
 * 背景:
 *   ① 用户反馈「缺少分类改名」—— 功能其实 2026-09 就实现了(lib + ctx + 侧栏头部
 *      铅笔按钮),只是入口纯图标、且**未选分类时静默 return**,点了毫无反馈。
 *   ② 「文章移动分类」确实没有,本轮新加。它是全应用唯一会同时写两个分类文件的
 *      操作 —— 顺序写反遇上中断就是笔记丢失,所以这里把顺序与失败语义钉死。
 *
 * 这里只测「接线接上没有、失败时有没有乱动数据」。真实布局与手势仍需真机验证。
 * ★ 调用链会走到 renderCategoryList / renderNoteList(它们是 sidebar 内部直接调用,
 *   不走 ctx),所以每个用例都必须在 withDom 里跑 —— 否则渲染一抛错就被
 *   renameCategoryByName 自己的 catch 吞掉,用例「通过」得毫无意义(假绿)。
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withDom, withLocalStorage } from './dom-stub.mjs';
import { Store } from '../public/js/store.js';
import { renameCategory, renameCategoryByName, renderCategoryList, renderNoteList } from '../public/js/features/sidebar.js';
import { moveNoteToCategory, pickCategoryForNote } from '../public/js/features/note.js';

/** 把一个 Store + 一堆「被调过就记下来」的桩拼成 ctx。
 *  dom 必须由调用方(通常是 withDom 的 byId)注入 —— 见文件头那条说明。 */
function recorder(st, extra = {}) {
  const rec = { toasts: [], dirty: [], sent: [], empties: [], modals: [] };
  const ctx = {
    store: st,
    icons: new Proxy({}, { get: () => '<svg></svg>' }),
    toast: (m, k) => rec.toasts.push([m, k]),
    markDirty: (n) => rec.dirty.push(n),
    renderNoteList: () => {},
    renderCategoryList: () => {},
    showEmpty: (t) => rec.empties.push(t),
    fmtTime: () => '刚刚',
    closeDrawer: () => {},
    modal: async () => null,
    moveNote: () => {},
    toggleNotePin: () => {},
    pickCategoryForNote: () => {},
    ...extra,
  };
  return { ctx, rec };
}

/** 渲染链需要的最小 Library 面(少了任何一个,renderCategoryList/renderNoteList 都会抛)。 */
function renderableLib(extra = {}) {
  return {
    sortedCategories: () => [],
    categoryInfo: () => ({ data: { notes: [] } }),
    catPin: () => false,
    catCount: () => null,
    ...extra,
  };
}

/** 造一个只有「甲 / 乙」两个分类的 Library 桩。 */
function libStub({ jia, yi = [], appendResult = { ok: true }, withYi = true } = {}) {
  const calls = { load: [], appended: [], counts: [] };
  const state = {
    甲: { data: { notes: jia.map((n, i) => ({ ...n, order: (i + 1) * 1000 })), trash: [] } },
  };
  if (withYi) state.乙 = { data: { notes: yi.map((n, i) => ({ ...n, order: (i + 1) * 1000 })), trash: [] } };
  const lib = {
    categoryInfo: (n) => state[n] || null,
    sortedCategories: () => Object.keys(state),
    catCount: (n) => (state[n]?.data ? state[n].data.notes.length : null),
    loadCategory: async (n) => { calls.load.push(n); return state[n]?.data; },
    appendNoteToCategory: async (n, note) => {
      calls.appended.push(n);
      if (appendResult.ok && state[n]) state[n].data.notes.push(note);
      return appendResult;
    },
    setCatCounts: async (pairs) => { calls.counts.push(pairs); return true; },
  };
  return { lib, calls, state };
}

/* ================= 功能一:分类改名 ================= */

test('★ renameCategory:没选分类时必须给出提示(旧写法静默 return → 用户以为功能不存在)', async () => {
  await withDom(async (f, byId) => {
    const st = new Store();                 // activeCat 初值就是 null
    let modalCalled = 0;
    const { ctx, rec } = recorder(st, { dom: { byId }, modal: async () => { modalCalled += 1; return null; } });
    await renameCategory(ctx);
    assert.equal(modalCalled, 0, '没选分类时不该弹输入框');
    assert.equal(rec.toasts.length, 1, '★ 必须给一次反馈,否则用户判定「没有这个功能」');
    assert.equal(rec.toasts[0][1], 'warn', '提示是提醒级,不是错误级');
    assert.match(rec.toasts[0][0], /先选择一个/);
  });
});

test('★ renameCategoryByName:改「不是当前选中」的那个分类 —— 不能动 activeCat', async () => {
  await withDom(async (f, byId) => {
    const st = new Store();
    st.set('activeCat', '乙');
    st.set('activeNoteId', 'k1');
    const renamed = [];
    let lastReadMigrated = null;
    st.set('lib', renderableLib({ renameCategory: async (o, n) => { renamed.push([o, n]); return n; } }));
    st.set('dirty', new Set(['甲', '乙']));
    const { ctx, rec } = recorder(st, {
      dom: { byId },
      modal: async () => '甲改',                                  // 用户输入的新名
      renameLastReadCat: (from, to) => { lastReadMigrated = [from, to]; },
    });
    st.set('tabs', { send: (m) => rec.sent.push(m) });

    await renameCategoryByName(ctx, '甲');

    assert.deepEqual(renamed, [['甲', '甲改']], '改的必须是被点的那一行,不是当前选中的那个');
    assert.equal(st.get('activeCat'), '乙', '★ 改别的分类时当前分类不能被挪走');
    assert.deepEqual(lastReadMigrated, ['甲', '甲改'], '本机阅读位置记录也要跟着换名');
    assert.equal(rec.sent.length, 1, '要通知其他标签页:分类清单变了');
    assert.ok(st.get('dirty').has('甲改') && !st.get('dirty').has('甲'),
      '未保存标记要搬到新名下(留在旧名上等于脱离保存队列)');
    assert.equal(rec.toasts.length, 1, '成功要给出反馈');
    assert.match(rec.toasts[0][0], /已重命名为「甲改」/);
  });
});

test('★ renameCategoryByName:改的是当前分类时 activeCat 与标题行都跟着走', async () => {
  await withDom(async (f, byId) => {
    const st = new Store();
    st.set('activeCat', '甲');
    st.set('activeNoteId', 'k1');
    st.set('lib', renderableLib({ renameCategory: async (o, n) => n }));
    st.set('tabs', { send: () => {} });
    const { ctx } = recorder(st, { dom: { byId }, modal: async () => '甲新' });

    await renameCategoryByName(ctx, '甲');

    assert.equal(st.get('activeCat'), '甲新', '当前分类改名后要指向新名字');
    assert.match(byId('activeCatName').textContent, /甲新/,
      '★ 标题行要显示新名 —— 旧实现在渲染后又手动覆盖一次,把「· N 篇」抹掉了');
  });
});

test('★ renameLastReadCat:只改 cat、noteId 原样;不匹配就不动', async () => {
  const ls = withLocalStorage();
  try {
    const { renameLastReadCat } = await import('../public/js/ui.js');
    assert.equal(renameLastReadCat('甲', '乙'), false, '没有记录 → false');
    ls.map.set('jmbiji.lastRead', JSON.stringify({ cat: '甲', noteId: 'k1' }));
    assert.equal(renameLastReadCat('丙', '丁'), false, '记录不属于这个分类 → 不动');
    assert.equal(JSON.parse(ls.map.get('jmbiji.lastRead')).cat, '甲');
    assert.equal(renameLastReadCat('甲', '乙'), true, '匹配 → 改写');
    assert.deepEqual(JSON.parse(ls.map.get('jmbiji.lastRead')), { cat: '乙', noteId: 'k1' },
      '★ noteId 必须原样保留(笔记没动,只是分类换了名字)');
    assert.equal(renameLastReadCat('乙', '乙'), false, '同名改名是空操作');
  } finally { ls.restore(); }
});

test('★ 分类行的重命名按钮:改的是它所在那一行(不是当前选中那个)', async () => {
  await withDom(async (f, byId) => {
    const st = new Store();
    st.set('activeCat', '甲');                 // 当前选中的是甲
    const renamed = [];
    let asked = null;
    st.set('lib', renderableLib({
      sortedCategories: () => ['甲', '乙'],
      renameCategory: async (o, n) => { renamed.push([o, n]); return n; },
    }));
    st.set('tabs', { send: () => {} });
    const { ctx } = recorder(st, {
      dom: { byId },
      modal: async (o) => { asked = o.title; return '乙新'; },
    });

    renderCategoryList(ctx);
    const li = byId('catList').children[1];      // 第二行 = 乙
    const btns = li.children.find((c) => c.className === 'cat-btns');
    btns.children.find((b) => b.title === '重命名分类').fire('click');
    await new Promise((r) => setTimeout(r, 0));

    assert.match(asked, /「乙」/, '弹窗标题要指出改的是哪一行');
    assert.deepEqual(renamed, [['乙', '乙新']],
      '★ 点哪一行就改哪一行 —— 退化成「按当前选中改名」会改错分类');
  });
});

/* ================= 功能二:跨分类移动 ================= */

test('★ moveNoteToCategory:目标先落盘、源后删;篇数一次写两处', async () => {
  await withDom(async (f, byId) => {
    const st = new Store();
    st.set('activeCat', '甲');
    st.set('activeNoteId', 'k2');
    const { lib, calls, state } = libStub({ jia: [{ id: 'k1', title: '留下', content: 'a' }, { id: 'k2', title: '搬走', content: 'b' }] });
    st.set('lib', lib);
    const { ctx, rec } = recorder(st, { dom: { byId } });
    st.set('tabs', { send: (m) => rec.sent.push(m) });

    const ok = await moveNoteToCategory(ctx, 'k2', '乙');

    assert.equal(ok, true);
    assert.deepEqual(calls.appended, ['乙'], '先写的是**目标**分类');
    assert.equal(state['乙'].data.notes.length, 1, '目标里多了一篇');
    assert.equal(state['乙'].data.notes[0].id, 'k2');
    assert.deepEqual(state['甲'].data.notes.map((n) => n.id), ['k1'], '源里少了一篇');
    assert.deepEqual(rec.dirty, ['甲'], '★ 源分类要标脏,交给常规保存流水线落盘');
    assert.deepEqual(calls.counts, [{ 甲: 1, 乙: 1 }], '★ 两处篇数必须**一次**写完(拆两次就是两次网络往返)');
    assert.deepEqual(rec.sent, [{ type: 'cat-saved', name: '乙' }], '目标分类的云端版本变了 → 通知其他标签页');
    assert.equal(st.get('activeNoteId'), null, '搬走的正是当前在读的那篇 → 选中态要清掉');
    assert.match(rec.empties[0], /已移动到「乙」/, '阅读区要告诉用户它去哪了');
  });
});

test('★ moveNoteToCategory:目标写失败(冲突)→ 源一动不动,也不标脏', async () => {
  await withDom(async (f, byId) => {
    const st = new Store();
    st.set('activeCat', '甲');
    st.set('activeNoteId', 'k2');
    const { lib, calls, state } = libStub({
      jia: [{ id: 'k2', title: '搬走', content: 'b' }],
      appendResult: { conflict: true },
    });
    st.set('lib', lib);
    const { ctx, rec } = recorder(st, { dom: { byId } });

    const ok = await moveNoteToCategory(ctx, 'k2', '乙');

    assert.equal(ok, false, '目标没写成就不能算移动成功');
    assert.deepEqual(state['甲'].data.notes.map((n) => n.id), ['k2'],
      '★ 源分类必须纹丝不动 —— 这正是「先写目标」换来的安全性');
    assert.equal(rec.dirty.length, 0, '★ 失败就不该标记源分类待保存(那等于把源改成「已删」的样子)');
    assert.equal(calls.counts.length, 0, '没移动成功就不该动篇数');
    assert.equal(st.get('activeNoteId'), 'k2', '当前阅读的笔记不能被清掉');
    assert.equal(rec.toasts.length, 1, '必须如实报错');
    assert.equal(rec.toasts[0][1], 'error');
  });
});

test('★ moveNoteToCategory:并发第二次调用被忙态守卫挡住(否则会造出两份副本)', async () => {
  await withDom(async (f, byId) => {
    const st = new Store();
    st.set('activeCat', '甲');
    st.set('activeNoteId', 'k2');
    let resolveAppend;
    const gate = new Promise((r) => { resolveAppend = r; });
    const { lib, calls } = libStub({ jia: [{ id: 'k2', title: 'x', content: '' }] });
    lib.appendNoteToCategory = (n) => { calls.appended.push(n); return gate; };
    st.set('lib', lib);
    const { ctx } = recorder(st, { dom: { byId } });

    const first = moveNoteToCategory(ctx, 'k2', '乙');
    const second = await moveNoteToCategory(ctx, 'k2', '乙');
    assert.equal(second, false, '★ 网络往返期间的第二次点击必须被挡掉');
    resolveAppend({ ok: true });
    assert.equal(await first, true, '第一次照常完成');
    assert.deepEqual(calls.appended, ['乙'], '只追加了一次');
  });
});

test('★ pickCategoryForNote:只有一个分类时直接提示,不弹空窗', async () => {
  await withDom(async (f, byId) => {
    const st = new Store();
    st.set('activeCat', '甲');
    const { lib } = libStub({ jia: [{ id: 'k1', title: 'a', content: '' }], withYi: false });
    st.set('lib', lib);
    let modalCalled = 0;
    const { ctx, rec } = recorder(st, { dom: { byId }, modal: async () => { modalCalled += 1; return null; } });

    await pickCategoryForNote(ctx, 'k1');
    assert.equal(modalCalled, 0, '没有可去的地方就不该弹窗');
    assert.equal(rec.toasts.length, 1);
    assert.match(rec.toasts[0][0], /只有一个分类/);
  });
});

test('★ pickCategoryForNote:列出其他分类(不含当前),点选后真的移动', async () => {
  await withDom(async (f, byId) => {
    const st = new Store();
    st.set('activeCat', '甲');
    st.set('activeNoteId', 'k1');
    const { lib, calls, state } = libStub({
      jia: [{ id: 'k1', title: '搬我', content: '' }],
      yi: [{ id: 'y1', title: '乙原有', content: '' }],
    });
    st.set('lib', lib);
    let pickedBody = null;
    const { ctx } = recorder(st, {
      dom: { byId },
      // 弹窗桩:真的执行 build(把按钮建出来),并让「关闭」resolve —— 模拟真实 <dialog>
      modal: (opts) => new Promise((resolve) => {
        const body = { children: [], appendChild(c) { this.children.push(c); return c; } };
        pickedBody = body;
        opts.build(body);
        byId('modal').close = () => resolve(null);
      }),
    });

    const p = pickCategoryForNote(ctx, 'k1');
    await Promise.resolve(); await Promise.resolve();   // 让 modal 桩跑到 build
    const list = pickedBody.children[0];
    assert.deepEqual(list.children.map((b) => b.textContent), ['乙'],
      '★ 清单里只该有「其他」分类 —— 当前分类不能出现(移到自己等于空操作)');
    list.children[0].fire('click');
    await p;

    assert.deepEqual(calls.appended, ['乙'], '点选后要真的把笔记写进目标分类');
    assert.deepEqual(state['甲'].data.notes.map((n) => n.id), [], '源的这篇要被移走');
    assert.equal(state['乙'].data.notes.length, 2, '目标分类多了一篇');
  });
});

test('★ renderNoteList:笔记行的操作按钮是 4 个且含「移动到其他分类」', async () => {
  await withDom(async (f, byId) => {
    const st = new Store();
    st.set('activeCat', '甲');
    st.set('lib', {
      categoryInfo: () => ({ data: { notes: [{ id: 'k1', title: '一篇', content: '', order: 1000, updatedAt: 1, pin: false, attachments: [] }] } }),
    });
    const { ctx } = recorder(st, { dom: { byId } });
    renderNoteList(ctx);
    const li = byId('noteList').children[0];
    const btns = li.children.find((c) => c.className === 'note-btns');
    assert.ok(btns, '笔记行必须有 .note-btns 浮层');
    assert.deepEqual(btns.children.map((b) => b.title), ['上移', '下移', '置顶', '移动到其他分类'],
      '★ 顺序与分类列同构(排序三项在前,跨分类操作在后),数量必须与分类列一致');
    for (const b of btns.children) {
      assert.equal(b.attrs['aria-label'], b.title, `「${b.title}」按钮缺 aria-label`);
    }
  });
});
