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
import { renderCategoryList, renderNoteList, activeNoteData, openCategory, clickable } from '../public/js/features/sidebar.js';
import { Store } from '../public/js/store.js';
import { withDom } from './dom-stub.mjs';

/* DOM 替身与建桩已抽到 tests/dom-stub.mjs —— 多个测试文件共用同一份,
 * 避免同一替身写两遍后分叉(替身与真实 DOM 的语义分叉 = 假绿的常见来源)。
 * 本文件用默认 ctx:icons 万能替身 / 静默 toast / 取消的 modal。 */

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
      sortedCategories: () => ['甲', '乙'],
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
      sortedCategories: () => ['甲'],
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
      sortedCategories: () => ['甲'],
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
      sortedCategories: () => ['甲'],
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

/* ---- 分类行「上移/下移/置顶/重命名」四按钮 ----
 * 分类此前只有置顶一个按钮,顺序被名称字典序钉死。加了手动调序后分类行与笔记行同形。
 * 2026-09-29 用户反馈「缺少分类改名」—— 功能其实早就在,只是入口只有侧栏头部一支
 * 铅笔、纯图标无文字,用户找不到。于是在分类行内补一个重命名入口,笔记行同时补
 * 「移动到其他分类」,**两列一起变成 4 个**:.pin-slot 的净空是按「两列按钮数相同」
 * 推出来的,只加一侧会让两列的图钉槽位错位(见 style.css 的 34px/36px 注释)。
 * 这里钉两件事:①四个按钮都在、顺序与笔记列一致;②每个都有可访问名 ——
 * 图标 svg 带 aria-hidden,title 不算可访问名,漏了 aria-label 读屏器只会播报「按钮」
 * (2026-09-27 审计 P3-4 的同一类问题)。 */
test('★ renderCategoryList:分类行有 上移/下移/置顶/重命名 四个按钮且都有可访问名', async () => {
  await withDom((ctx, byId) => {
    const st = new Store();
    st.set('lib', {
      sortedCategories: () => ['甲'],
      catPin: () => false,
      catCount: () => null,
      categoryInfo: () => ({ data: { notes: [] } }),
      moveCat: async () => true,
    });
    renderCategoryList(ctx(st));
    const li = byId('catList').children[0];
    const btns = li.children.find((c) => c.className === 'cat-btns');
    assert.ok(btns, '分类行必须有 .cat-btns 浮层');
    assert.deepEqual(btns.children.map((b) => b.title), ['上移', '下移', '置顶', '重命名分类'],
      '★ 按钮顺序必须与笔记列一致(排序三项在前,跨分类/改名在后)');
    for (const b of btns.children) {
      assert.equal(b.attrs['aria-label'], b.title,
        `「${b.title}」按钮缺 aria-label(读屏器只会播报「按钮」)`);
    }
  });
});

test('★ clickable:行内按钮上的 Enter/空格不得触发整行动作(否则键盘按不动按钮还切走分类)', () => {
  // 背景(2026-09-28 审计 P1):keydown 挂在行(li)上,键盘用户 Tab 到行内的
  // 「上移/下移/置顶」按钮后按 Enter —— 事件从按钮冒泡到行,旧写法不看 e.target,
  // 于是既 preventDefault 掉按钮自己的激活(按不动)、又执行 openCategory(切走分类)。
  const li = { tabIndex: 0, setAttribute() {}, handlers: {}, addEventListener(ev, fn) { li.handlers[ev] = fn; } };
  let rowAction = 0;
  clickable(li, () => { rowAction += 1; });
  const innerBtn = { tagName: 'BUTTON' };   // 行内的上移/下移/置顶按钮
  let prevented = false;
  li.handlers.keydown({ target: innerBtn, key: 'Enter', preventDefault() { prevented = true; } });
  assert.equal(rowAction, 0, '★ 事件源是行内按钮 → 整行动作不得触发');
  assert.equal(prevented, false, '★ 也不得 preventDefault(否则按钮自己就按不动了)');
  li.handlers.keydown({ target: innerBtn, key: ' ', preventDefault() { prevented = true; } });
  assert.equal(rowAction, 0, '★ 空格同理');
  assert.equal(prevented, false, '★ 空格也不得被吞');
  // 对照:事件源就是本行时,键盘必须照常可用(不能把功能整个挡掉)
  li.handlers.keydown({ target: li, key: 'Enter', preventDefault() { prevented = true; } });
  assert.equal(rowAction, 1, '对照:事件源是本行 → 正常触发');
  assert.equal(prevented, true, '对照:本行按键照旧 preventDefault');
  let spacePrevented = false;
  li.handlers.keydown({ target: li, key: ' ', preventDefault() { spacePrevented = true; } });
  assert.equal(rowAction, 2, '对照:空格也能用');
  assert.equal(spacePrevented, true, '对照:空格照旧 preventDefault');
});

test('★ 分类上移/下移:成功后必须广播 cats-changed;冲突(false)也必须重绘', async () => {
  // 背景(2026-09-28 审计 P2):① 移动成功若不广播,别的标签页的顺序视图永远不动
  // (本地重绘了,别的页面不知道);② 冲突(412,返回 false)时 lib 已把 vault 视图刷成
  // 最新 —— 仍必须重绘,否则界面停在一个已经过期的顺序上(旧实现写在 if (moved) 里)。
  await withDom(async (ctx, byId) => {
    const sent = [];
    let sortedCalls = 0;
    let moveResult = true;
    const st = new Store();
    st.set('tabs', { send: (m) => sent.push(m) });
    st.set('lib', {
      sortedCategories: () => { sortedCalls += 1; return ['甲', '乙']; },
      catPin: () => false,
      catCount: () => null,
      categoryInfo: () => ({ data: { notes: [] } }),
      moveCat: async () => moveResult,
    });
    renderCategoryList(ctx(st));
    const li = byId('catList').children[0];
    const btns = li.children.find((c) => c.className === 'cat-btns');
    const up = btns.children[0];                       // 「上移」
    const before = sortedCalls;                        // 初次渲染那一次
    await up.handlers.click[0]({ stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 0));        // 让 move() 内部的 await 续行走完
    assert.deepEqual(sent, [{ type: 'cats-changed' }],
      '★ 移动成功必须广播 —— 旧实现不广播,别的标签页顺序视图永远不动');
    assert.equal(sortedCalls, before + 1, '成功后要重绘(把新顺序画出来)');

    // 冲突(false):不广播,但**仍然重绘**
    sent.length = 0; moveResult = false;
    await up.handlers.click[0]({ stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(sent, [], '冲突时不该广播(没有真的改动)');
    assert.equal(sortedCalls, before + 2,
      '★ 冲突(412)也必须重绘 —— 旧实现写在 if (moved) 里,界面会停在过期顺序上');
  });
});

test('★ 置顶成功必须广播 cats-changed(别的标签页的置顶视图跟着失效)', async () => {
  await withDom(async (ctx, byId) => {
    const sent = [];
    const st = new Store();
    st.set('tabs', { send: (m) => sent.push(m) });
    st.set('lib', {
      sortedCategories: () => ['甲'],
      catPin: () => false,
      catCount: () => null,
      categoryInfo: () => ({ data: { notes: [] } }),
      setCatPin: async () => {},
    });
    renderCategoryList(ctx(st));
    const li = byId('catList').children[0];
    const btns = li.children.find((c) => c.className === 'cat-btns');
    const pinBtn = btns.children[2];                   // 「置顶」
    await pinBtn.handlers.click[0]({ stopPropagation() {} });
    assert.deepEqual(sent, [{ type: 'cats-changed' }],
      '★ 置顶后必须广播 —— 旧实现只重绘本地,别的标签页置顶视图不动');
  });
});

/* ---- 整表重建后的焦点还原(2026-09-29 审计 P3)----
 * 上移/下移/置顶/切笔记都会**整表重建**列表。不把焦点还回去,键盘用户按一次回车焦点就掉回
 * body,想连按两次「下移」得重新 Tab 一路找回来(视觉上像「按钮只灵一次」)。
 * ★ 断言落在**节点身份**上:只比 dataset.focusKey 的话,被摘掉的**旧节点**还带着同一个键,
 *   把 restoreFocusKey 整段删掉照样绿 —— 那是假绿(设计时就特意规避)。 */
test('★ renderNoteList:整表重建后焦点必须回到同一个 focusKey 的**新节点**', async () => {
  await withDom((ctx, byId) => {
    const notes = [mkNote('b', 500), mkNote('a', 1000)];
    const st = new Store();
    st.set('activeCat', '甲');
    st.set('lib', {
      listCategories: () => ['甲'], sortedCategories: () => ['甲'],
      catPin: () => false, catCount: () => 2,
      categoryInfo: () => ({ data: { notes } }),
    });
    const c = { ...ctx(st), fmtTime: () => '' };   // renderNoteList 要给 li.title 取时间
    renderNoteList(c);
    const ul = byId('noteList');
    const up = ul.querySelector('[data-focus-key="note-up:b"]');
    assert.ok(up, '前置:笔记「上移」按钮带着语义 focusKey');
    up.focus();
    assert.equal(global.document.activeElement, up, '前置:焦点确实在按钮上');
    renderNoteList(c);                            // 真实场景由上移/置顶触发
    const now = global.document.activeElement;
    assert.notEqual(now, up, '前置:重建后旧节点已被替换(否则本条断言没有判别力)');
    assert.equal(now, ul.querySelector('[data-focus-key="note-up:b"]'),
      '★ 焦点必须落在新节点上 —— 删掉 restoreFocusKey 会掉回旧节点/body');
  });
});

test('★ renderCategoryList:整表重建后焦点也必须还回原按钮(不能只修笔记列)', async () => {
  await withDom((ctx, byId) => {
    const st = new Store();
    st.set('lib', {
      listCategories: () => ['甲'], sortedCategories: () => ['甲'],
      catPin: () => false, catCount: () => null,
      categoryInfo: () => ({ data: { notes: [] } }),
    });
    renderCategoryList(ctx(st));
    const ul = byId('catList');
    const pin = ul.querySelector('[data-focus-key="cat-pin:甲"]');
    assert.ok(pin, '前置:分类「置顶」按钮带着语义 focusKey');
    pin.focus();
    renderCategoryList(ctx(st));
    const now = global.document.activeElement;
    assert.notEqual(now, pin, '前置:重建后旧节点已被替换');
    assert.equal(now, ul.querySelector('[data-focus-key="cat-pin:甲"]'),
      '★ 焦点必须落在新节点上(分类列同理)');
  });
});
