/* ============================================================
 * 搜索单测 —— findMatches 纯函数(高亮偏移必须在压缩空白后的串上)
 * 曾经:snipOffset 拿原始下标当压缩后的偏移,匹配词前面一带空白
 * 就高亮错位(实测把 admin123 高亮成了「妥善保存。」)
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { findMatches, renderSearchResult } from '../public/js/search.js';
import { withDom } from './dom-stub.mjs';

function notesOf(content, title = '无标题') {
  return new Map([['工作', [{ id: 'n1', title, content }]]]);
}

test('findMatches:snipOffset 在压缩空白后仍精确指向匹配词', () => {
  // 匹配词前面有换行与连续空格,压缩空白会让长度缩短 ——
  // 偏移若还按原始下标算,mark 就会落在匹配词之前
  const content = '重要说明:\n\n  账号 admin123 保密,勿泄露。';
  const [hit] = findMatches(notesOf(content), 'admin123');
  assert.ok(hit, '必须命中');
  const marked = hit.snippet.slice(hit.snipOffset, hit.snipOffset + 'admin123'.length);
  assert.equal(marked, 'admin123', `高亮切片应为匹配词,实际:${JSON.stringify(marked)}`);
  assert.equal(hit.snippet, '重要说明: 账号 admin123 保密,勿泄露。', '片段空白应已压缩');
});

test('findMatches:匹配词在片段开头/结尾时偏移不越界', () => {
  const head = findMatches(notesOf('admin123 在最前面'), 'admin123');
  assert.equal(head[0].snipOffset, 0);
  assert.equal(head[0].snippet.slice(0, 8), 'admin123');

  const tail = findMatches(notesOf('前文铺垫很长很长很长很长,admin123'), 'admin123');
  assert.equal(tail[0].snippet.slice(tail[0].snipOffset, tail[0].snipOffset + 8), 'admin123');
});

test('findMatches:标题命中不产片段;无命中返回空数组', () => {
  const byTitle = findMatches(notesOf('正文无关', '密钥说明'), '密钥');
  assert.equal(byTitle[0].inTitle, true);
  assert.equal(byTitle[0].snippet, null);
  assert.equal(findMatches(notesOf('完全无关的正文'), '不存在').length, 0);
});

test('findMatches:空查询直接返回空', () => {
  assert.deepEqual(findMatches(notesOf('任意'), ''), []);
});

/* ---------- 渲染层(2026-10-06 审计 P0:高亮与前缀曾被整体抹掉) ---------- */

test('renderSearchResult:片段保留前缀 + 恰好一个 <mark> 包住匹配词', async () => {
  await withDom(async () => {
    const content = '重要说明: 账号 admin123 保密,勿泄露。';
    const [hit] = findMatches(notesOf(content), 'admin123');
    const li = renderSearchResult(hit, 'admin123');
    const snip = li.children.find((c) => c.tag === 'div' && c.className === 'search-item-snippet');
    const marks = snip.children.filter((c) => c.tag === 'mark');
    assert.equal(marks.length, 1, '必须恰好一个高亮节点');
    assert.equal(marks[0].textContent, 'admin123', '高亮内容必须是匹配词本身');
    // ★ 前缀必须完整保留:旧实现第二次 highlightInto(...,'') 用 textContent 赋值
    //   把前文与 <mark> 一起抹掉,实测只剩「 保密,勿泄露。」
    assert.ok(snip.textContent.startsWith('重要说明: 账号 '), `前缀丢失,实得:${JSON.stringify(snip.textContent)}`);
    assert.equal(snip.textContent, content, '片段拼回来必须等于原文');
  });
});

test('renderSearchResult:命中词在片段开头/结尾/整段命中三种边界都不丢内容', async () => {
  await withDom(async () => {
    for (const [content, q] of [
      ['admin123 是账号,勿泄露', 'admin123'],          // 命中在开头
      ['前置说明很长,末尾是 admin123', 'admin123'],   // 命中在结尾
      ['admin123', 'admin123'],                       // 整段就是命中词
    ]) {
      const [hit] = findMatches(notesOf(content), q);
      const li = renderSearchResult(hit, q);
      const snip = li.children.find((c) => c.tag === 'div' && c.className === 'search-item-snippet');
      const marks = snip.children.filter((c) => c.tag === 'mark');
      assert.equal(marks.length, 1, `「${content}」高亮数不对`);
      assert.equal(marks[0].textContent, q);
      assert.ok(snip.textContent.includes(q), `「${content}」匹配词丢失`);
      if (content !== q) assert.ok(snip.textContent.length > q.length, `「${content}」其余内容被吃掉`);
    }
  });
});

test('renderSearchResult:标题命中走 <mark>、标题未命中不高亮', async () => {
  await withDom(async () => {
    const [hit] = findMatches(notesOf('正文里没有 query', 'CF 中转配置'), '中转');
    const li = renderSearchResult(hit, '中转');
    const title = li.children.find((c) => c.tag === 'div' && c.className === 'search-item-title');
    const marks = title.children.filter((c) => c.tag === 'mark');
    assert.equal(marks.length, 1, '标题命中必须有高亮');
    assert.equal(marks[0].textContent, '中转');
    assert.equal(title.textContent, 'CF 中转配置');
  });
});


/* ---------- 结果表头文案(2026-10-07 定稿复盘) ---------- */

test('搜索结果表头:不超过上限时只报真实总数', async () => {
  const { resultHeadline } = await import('../public/js/features/search.js');
  assert.equal(resultHeadline(0), '0 条匹配');
  assert.equal(resultHeadline(1), '1 条匹配');
  assert.equal(resultHeadline(50), '50 条匹配');
  assert.ok(!resultHeadline(50).includes('/'), '未超上限时不该出现「N / M」那种分栏写法');
});

test('★ 搜索结果表头:超过上限必须同时说出「显示数 / 总数」', async () => {
  const { resultHeadline } = await import('../public/js/features/search.js');
  const h = resultHeadline(128);
  assert.ok(h.includes('50') && h.includes('128'),
    `超上限时表头必须同时给出显示条数与真实总数,实际「${h}」`);
  assert.ok(/前\s*50|只显示/.test(h), `表头必须明说这是截断,实际「${h}」`);
  /* 这条是本护栏的核心:界面上只渲染前 50 条却不提示时,
   * 用户看到「128 条匹配」会合理推断「库里就这么多」—— 而这不是事实。 */
});

test('搜索结果表头:上限之差 1 就该提示(判据不能是宽松的近似)', async () => {
  const { resultHeadline } = await import('../public/js/features/search.js');
  assert.equal(resultHeadline(50), '50 条匹配');
  assert.ok(resultHeadline(51).includes('51'), '51 条就必须提示,不能等到很悬殊才提示');
});

/* ---------- runSearch / closeSearch 的竞态与错误反馈(2026-10-17 审计) ---------- */

/** 造一套能真跑 runSearch 的 ctx:lib.loadAllCategories 由用例控制何时放行。
 *  面板渲染需要 document.querySelector('.topbar')(窄屏定位),桩里返回 null 即可。
 *  @returns {{ctx:object, byId:Function, release:Function, clicks:Function[]}} */
function mkSearchCtx(byId, { failLoad = null, notes = null } = {}) {
  let release = () => {};
  const gate = new Promise((r) => { release = r; });
  const lib = {
    listCategories: () => ['工作'],
    categoryInfo: () => ({ data: { notes: notes || [{ id: 'n1', title: '账号说明', content: '账号 admin123 保密' }] } }),
    loadAllCategories: () => (failLoad ? Promise.reject(failLoad) : gate),
  };
  const clicks = [];
  const ctx = {
    store: { get: (k) => (k === 'lib' ? lib : undefined), set: () => {} },
    dom: { byId },
    toast: () => {},
    clickable: (el, fn) => { clicks.push(fn); },
    openNote: () => {},
    renderCategoryList: () => {},
  };
  return { ctx, byId, release, clicks };
}

test('★ 空查询必须作废在途搜索轮次 —— 慢搜索不能在空输入框上自己弹出来', async () => {
  const { runSearch } = await import('../public/js/features/search.js');
  await withDom(async (_mkctx, byId) => {
    document.querySelector = () => null; // 生产代码要按 .topbar 底边定位,桩里没有它
    const { ctx, release } = mkSearchCtx(byId);
    byId('searchBox').value = 'admin123';
    const inflight = runSearch(ctx);          // 首次搜索:卡在 loadAllCategories(冷启动)
    byId('searchBox').value = '';             // 用户在等待期间清空了输入框
    await runSearch(ctx);                     // 空查询:应立即收起并作废上一轮
    assert.equal(byId('searchPanel').hidden, true, '空查询要收起面板');
    release();
    await inflight;                           // 旧轮次醒来
    assert.equal(byId('searchPanel').hidden, true, '旧轮次不得把面板重新弹开');
    assert.equal(byId('searchPanel').children.length, 0, '旧轮次不得渲染结果');
  });
});

test('★ closeSearch(Esc / 点别处)同样要作废在途轮次', async () => {
  const { runSearch, closeSearch } = await import('../public/js/features/search.js');
  await withDom(async (_mkctx, byId) => {
    document.querySelector = () => null;
    const { ctx, release } = mkSearchCtx(byId);
    byId('searchBox').value = 'admin123';
    const inflight = runSearch(ctx);
    closeSearch(ctx);                         // 用户按 Esc
    release();
    await inflight;
    assert.equal(byId('searchPanel').hidden, true, 'Esc 之后旧轮次不得重新弹面板');
    assert.equal(byId('searchBox').value, '', 'Esc 要清空输入');
  });
});

test('★ 搜索前拉全部分类失败(离线)必须给反馈,不能冒泡成 unhandledrejection', async () => {
  const { runSearch } = await import('../public/js/features/search.js');
  await withDom(async (_mkctx, byId) => {
    document.querySelector = () => null;
    const { ctx } = mkSearchCtx(byId, { failLoad: new Error('Failed to fetch') });
    const toasts = [];
    ctx.toast = (text, kind) => { toasts.push({ text, kind }); };
    byId('searchBox').value = 'admin123';
    await runSearch(ctx);
    assert.equal(toasts.length, 1, '必须给一条提示(旧写法无 catch → 面板不开也没提示)');
    assert.equal(toasts[0].kind, 'error');
    assert.ok(toasts[0].text.includes('Failed to fetch'), '要把原始错误说出来,便于排障');
    assert.equal(byId('searchPanel').children.length, 0, '失败时不得渲染任何结果');
  });
});

test('★ 点搜索结果不得覆盖 activeCatName(会把「分类 · N 篇」的篇数抹掉)', async () => {
  const { runSearch } = await import('../public/js/features/search.js');
  await withDom(async (_mkctx, byId) => {
    document.querySelector = () => null;
    const { ctx, release, clicks } = mkSearchCtx(byId);
    /* 真实顺序:openNote → renderNoteList 会把标题写成「分类 · N 篇」 */
    ctx.openNote = () => { byId('activeCatName').textContent = '工作 · 2 篇'; };
    byId('searchBox').value = 'admin123';
    const p = runSearch(ctx);
    release();
    await p;
    assert.equal(clicks.length, 1, '应渲染出 1 条可点结果');
    clicks[0]();
    assert.equal(byId('activeCatName').textContent, '工作 · 2 篇',
      '点结果后标题必须保持 renderNoteList 写的「分类 · N 篇」,不能被裸分类名覆盖');
  });
});
