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

/** 跑一次搜索并把结果渲染进 #searchPanel。
 *  空查询 → 收起面板;期间用户又输入 → 本轮结果作废(seq 守卫)。 */
export async function runSearch(ctx) {
  const lib = ctx.store.get('lib');
  const q = ctx.dom.byId('searchBox').value.trim();
  const panel = ctx.dom.byId('searchPanel');
  if (!q) { panel.hidden = true; panel.textContent = ''; return; }
  if (!lib) return;
  const seq = ++searchSeq;
  await lib.loadAllCategories();
  if (seq !== searchSeq) return; // 期间用户又输入了:这轮结果作废
  const notesByCat = new Map();
  for (const name of lib.listCategories()) {
    const cat = lib.categoryInfo(name);
    if (cat.data) notesByCat.set(name, cat.data.notes);
  }
  const results = findMatches(notesByCat, q);
  panel.textContent = '';
  const head = document.createElement('div');
  head.className = 'search-head';
  head.textContent = `${results.length} 条匹配`;
  panel.appendChild(head);
  const ul = document.createElement('ul');
  ul.className = 'search-list';
  for (const r of results.slice(0, 50)) {
    const li = renderSearchResult(r, q);
    ctx.clickable(li, () => {
      ctx.store.set('activeCat', r.cat);
      ctx.openNote(r.note.id);
      ctx.renderCategoryList();
      ctx.dom.byId('activeCatName').textContent = r.cat;
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
  const box = ctx.dom.byId('searchBox');
  if (box) box.value = '';
}
