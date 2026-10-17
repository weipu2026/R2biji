/* ============================================================
 * feature: 全局搜索(顶栏搜索框 + 结果面板)
 * ------------------------------------------------------------
 * 从 ui.js 的「搜索」区块原样迁出。
 *
 * 依赖(经 ctx 注入):
 *   - dom.byId(id)      取元素
 *   - store            会话态(读 lib / activeCat,写 activeCat)
 *   - openNote(id)     打开某条笔记(切到阅读视图)
 *   - renderCategoryList() 重绘分类列表(高亮跟着 activeCat 走)
 *   - clickable(el, fn) 把元素变成可点(含键盘可达性)
 *   - findMatches / renderSearchResult 来自 search.js(纯函数,直接 import)
 * ============================================================ */
import { findMatches, renderSearchResult } from '../search.js';

/** 搜索序号守卫:慢查询后到不得覆盖新查询的结果。
 *  模块级持有即可 —— 它只服务于本模块的竞态控制,无需进 store。 */
let searchSeq = 0;

/** 结果面板一次最多渲染多少条。
 *  超出部分**必须在表头明说**(见 resultHeadline),否则用户会把「显示上限」误当成「库里就这么多」。 */
const SEARCH_RESULT_LIMIT = 50;

/** 结果表头文案(纯函数,抽出来是为了能离线单测)。
 *  ★ 匹配数与显示数必须分开说(2026-10-07 定稿复盘):
 *   此前表头恒写 `${results.length} 条匹配`、列表却只渲染前 50 条 ——
 *   用户看到「128 条匹配」却只翻得到 50 条,界面上**没有任何提示**,
 *   合理推断是「我的库就这么大」,而这不是事实。
 *  ★ 第三个参数是「没读到几个分类」(2026-10-12 全站审计·假阴性):
 *   某分类解密/拉取失败时它的笔记根本不在候选集里,结果却是干干净净的
 *   「0 条匹配」—— 用户会得出「我没有这条笔记」,而事实是「这次没读到」。
 *   搜索是**找不到就白找**的动作,这种假阴性比多一行提示危险得多,必须说清。
 * @param {number} total  findMatches 返回的**真实**总数
 * @param {number} limit  实际渲染条数上限
 * @param {number} [unreadable=0] 本轮没能读取的分类数(0 = 全部读到)
 */
export function resultHeadline(total, limit = SEARCH_RESULT_LIMIT, unreadable = 0) {
  const base = total > limit
    ? `${limit} / ${total} 条匹配(只显示前 ${limit} 条,请细化关键词)`
    : `${total} 条匹配`;
  return unreadable > 0
    ? `${base} · 有 ${unreadable} 个分类这次没读到,结果可能不全`
    : base;
}

/** 跑一次搜索并把结果渲染进 #searchPanel。
 *  空查询 → 收起面板;期间用户又输入 → 本轮结果作废(seq 守卫)。 */
export async function runSearch(ctx) {
  const lib = ctx.store.get('lib');
  const q = ctx.dom.byId('searchBox').value.trim();
  const panel = ctx.dom.byId('searchPanel');
  /* ★ 空查询也要**作废在途轮次**(2026-10-17 审计 P1):不递增 searchSeq 的话,
   *   首次搜索触发的 loadAllCategories(全分类拉取,冷启动数百 ms~秒级)仍在飞,
   *   用户这时清空输入框 / 按 Esc / 点别处,旧轮次醒来后 seq 校验照样通过 →
   *   把旧关键词的结果重新渲染、并把 panel.hidden 置回 false ——
   *   面板对着一个空输入框自行弹出。closeSearch 同理(见其内部)。 */
  if (!q) { searchSeq++; panel.hidden = true; panel.textContent = ''; return; }
  if (!lib) return;
  const seq = ++searchSeq;
  /* 离线/超时不能冒泡成 unhandledrejection(2026-10-17 审计 P2):调用方是
   * shell.js 里 setTimeout(() => ctx.runSearch(), 160) 的浮空 Promise。
   * 至少给个反馈 —— 否则离线按 Ctrl+K 输入关键词,面板既不开也没任何提示。 */
  try { await lib.loadAllCategories(); }
  catch (e) { ctx.toast(`搜索需要先联网加载全部分类:${e.message}`, 'error'); return; }
  if (seq !== searchSeq) return; // 期间用户又输入了:这轮结果作废
  const notesByCat = new Map();
  let unreadable = 0;
  for (const name of lib.listCategories()) {
    const cat = lib.categoryInfo(name);
    /* ★ 读不到 ≠ 没有匹配(2026-10-12 全站审计):没解开的分类以前被静默跳过,
     *   它的笔记根本不在候选集里,结果却是一句干净的「0 条匹配」—— 属于假阴性,
     *   而搜索正是「找不到就等于白找」的动作。记下数量,交给表头如实说明。 */
    if (cat.data) notesByCat.set(name, cat.data.notes);
    else unreadable += 1;
  }
  const results = findMatches(notesByCat, q);
  panel.textContent = '';
  const head = document.createElement('div');
  head.className = 'search-head';
  head.textContent = resultHeadline(results.length, SEARCH_RESULT_LIMIT, unreadable);
  panel.appendChild(head);
  const ul = document.createElement('ul');
  ul.className = 'search-list';
  /* role=option 的条目必须有 listbox 父级才成立(2026-09-29 审计 P3):以前 ul 没有角色,
   * 读屏器拿到一串「选项」却不知道它们属于哪个列表、也不知道共几条。 */
  ul.setAttribute('role', 'listbox');
  ul.setAttribute('aria-label', '搜索结果');
  for (const r of results.slice(0, SEARCH_RESULT_LIMIT)) {
    const li = renderSearchResult(r, q);
    ctx.clickable(li, () => {
      ctx.store.set('activeCat', r.cat);
      ctx.openNote(r.note.id);
      ctx.renderCategoryList();
      /* ★ 不要再手动写 activeCatName(2026-10-17 审计 P1):openNote → renderNoteList
       *   刚把标题写成「分类 · N 篇」,这里用裸分类名覆盖会把篇数抹掉,
       *   直到下次重绘才回来。sidebar.js 的注释早已写明
       *   「标题栏由 renderNoteList 统一维护,这里再手动覆盖一次只会把篇数抹掉」。 */
      panel.hidden = true;
      ctx.dom.byId('searchBox').value = '';
    });
    ul.appendChild(li);
  }
  panel.appendChild(ul);
  /* 窄屏顶栏会 flex-wrap 成两行,硬编码 top:52px 会让面板压在搜索框上;
   * 按顶栏实际底边定位,窗口尺寸变化时也重算 */
  const bar = document.querySelector('.topbar');
  if (bar) panel.style.top = Math.round(bar.getBoundingClientRect().bottom + 6) + 'px';
  panel.hidden = false;
}

/** 收起搜索面板并清空输入(点其他地方 / Escape 时调用)。 */
export function closeSearch(ctx) {
  const panel = ctx.dom.byId('searchPanel');
  if (panel && !panel.hidden) panel.hidden = true;
  /* 作废在途搜索轮次(2026-10-17 审计 P1):与 runSearch 空查询分支同理。
   * 只隐藏面板是不够的 —— 首次搜索触发的 loadAllCategories 可能还在飞,
   * 它醒来后会把面板重新弹开。 */
  searchSeq++;
  const box = ctx.dom.byId('searchBox');
  if (box) box.value = '';
}
