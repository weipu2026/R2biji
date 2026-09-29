/* ============================================================
 * feature: 笔记(阅读视图 / 编辑视图 / 增删排序 / 附件)
 * ------------------------------------------------------------
 * 从 ui.js 的「阅读视图」「编辑视图」「笔记增删排序」三个区块原样迁出。
 *
 * ★ 与 sidebar.js 互为依赖,靠 ctx 解开循环:
 *   本模块用 sidebar 的 activeNoteData / renderNoteList / openNote;
 *   sidebar 用本模块的 addNote / renderReadView / moveNote / toggleNotePin。
 *   两边都**不 import 对方** —— 由 ui.js 在 ctx 里接起来。
 *
 * ★ 原地改对象的契约(store 的已知边界,改动前必读):
 *   笔记的标题/正文/附件都是**原地改** cat.data.notes[i] 的属性,不走 store.set,
 *   因此不会触发订阅通知。这是刻意的:名单里每条笔记都要整体换新对象的话,
 *   每次敲键都要重建整个数组。代价是「谁改了笔记」必须自己负责在改完后
 *   调 ctx.markDirty(cat) + 重绘,这个模块里每一处改动后都跟着这两步。
 *
 * 依赖(经 ctx 注入):
 *   - dom.byId(id) / icons / toast / modal
 *   - store                会话态(lib / activeCat / activeNoteId / editing / objectUrls)
 *   - activeNoteData()     取当前笔记对象(sidebar.js)
 *   - renderNoteList()     重绘笔记列表(sidebar.js)
 *   - openNote(id)         打开某条笔记(sidebar.js)
 *   - markDirty(name)      标记分类有未保存改动
 *   - saveAll()            「完成」时立刻上传
 *   - copyText / showEmpty / fmtTime
 *   - orderBetween / sortNotes 来自 format.js(纯函数,直接 import)
 * ============================================================ */
import * as F from '../format.js';

/* ================= 阅读视图 ================= */

/* 上一次渲染的是哪一篇 —— 只用来判断「该不该把阅读面滚回顶部」。
 * 模块级持有:阅读面全场只有一块,状态天然全局。 */
let lastReadNoteId = null;

/* ================= 触屏上下滑动翻篇 ================= */

/** 触发翻篇的最小纵向位移(px)。太小会把手指抖动当成翻篇。 */
export const SWIPE_MIN_PX = 56;

/**
 * 把一次滑动手势翻译成「翻到哪一篇」——纯函数,便于确定性单测。
 * @param {{dx:number, dy:number, atTop:boolean, atBottom:boolean}} g
 *        dx/dy = 手指位移(手指向上为负);atTop/atBottom = **手势开始时**阅读面是否已贴边。
 * @returns {number} 0 = 不翻篇;1 = 下一篇;-1 = 上一篇
 *
 * 三条刻意的取舍:
 *   · 只认「**手势开始时**就已经贴边」的回弹式滑动。中段起手向上划只是正常阅读滚动,
 *     抢过来翻篇会让长笔记读不下去 —— 手机阅读器通行做法是「划到底、再划一下才翻页」。
 *     用起始态而非结束态:滚动带惯性,结束时 scrollTop 还在变化,判定会飘。
 *   · 纵向位移必须大于横向 —— 手机上斜着划很常见,不能把普通滚动/选中误判成翻篇。
 *   · 内容短到不需要滚动时 atTop 与 atBottom 同时为真 → 两个方向都能翻篇,
 *     这正是「短笔记靠滑动切换」的预期行为。
 */
export function readSwipeIntent({ dx, dy, atTop, atBottom }) {
  if (Math.abs(dy) < SWIPE_MIN_PX) return 0;
  if (Math.abs(dx) > Math.abs(dy)) return 0;
  if (dy < 0) return atBottom ? 1 : 0;   // 上划(手指向上):已到底 → 下一篇
  return atTop ? -1 : 0;                 // 下划(手指向下):已到顶 → 上一篇
}

/**
 * 当前文本选区的字符数。无 DOM 环境(纯 Node 单测)恒为 0。
 * 手机端「长按选字 / 拖选区手柄」与「上下滑动翻篇」抬起的都是同一种触摸事件,
 * 只有它能区分两者 —— 详见 bindReadSwipe 的 touchend。
 */
function selectionLength() {
  const g = typeof window !== 'undefined' ? window : null;
  if (!g || typeof g.getSelection !== 'function') return 0;
  const sel = g.getSelection();
  return sel ? String(sel).length : 0;
}

/**
 * 在阅读面绑定触屏上下滑动翻篇。**启动时调一次**即可 ——
 * 它跟着 DOM 节点活,不跟渲染走(每次 renderReadView 都绑会叠加监听,
 * 一次滑动翻好几篇)。
 *
 * 除了翻篇,它还负责**不抢**一种同样会抬起触摸的操作:手机上长按选字 / 拖着
 * 选区手柄扩展选区。这两件事的手指位移与翻篇手势长得一模一样,只有一个判据能
 * 区分 —— 手势期间「选区的有无或长度变了没有」。
 * @param {object} ctx
 */
export function bindReadSwipe(ctx) {
  const view = ctx.dom.byId('readView');
  if (!view || typeof view.addEventListener !== 'function') return;
  /** 手势起点 + **起点时刻**的贴边状态与选区长度;null = 当前没有进行中的手势。 */
  let start = null;
  /** 本轮手势期间选区**变化过**没有 —— 由 selectionchange 直接置位,手势开始时清掉。
   *  为什么不能只在 touchend 读一次:某些移动浏览器在抬起的那一刻,系统选择控件会
   *  先清掉/重建选区(拖手柄时尤其明显),此刻读到的长度可能正好是 0 —— 于是
   *  「用户在选字」被判成「用户在翻篇」,缺陷照旧。selectionchange 是这件事的**直接
   *  信号**,发生在手势过程中,不依赖抬起瞬间的状态。两条判据都留:拿不到 document
   *  的环境(如纯 Node 单测)注册不了监听,那时快照那条仍在兜底。 */
  let selChanged = false;
  const doc = view.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (doc && typeof doc.addEventListener === 'function') {
    // 启动时绑一次、不解绑:本函数全场只调一次,监听跟着页面活
    doc.addEventListener('selectionchange', () => { if (start) selChanged = true; });
  }
  const edges = () => {
    const max = view.scrollHeight - view.clientHeight;
    // 内容短到滚不动时 max ≈ 0:此时两端同时成立,两个方向都能翻篇
    return { atTop: view.scrollTop <= 0, atBottom: max <= 1 || view.scrollTop >= max - 1 };
  };
  view.addEventListener('touchstart', (e) => {
    start = null;
    selChanged = false;
    // 多指(捏合缩放)不接管;编辑态兜底(readView 那时本就隐藏)
    if (e.touches.length !== 1 || ctx.store.get('editing')) return;
    const t = e.touches[0];
    start = { x: t.clientX, y: t.clientY, ...edges(), selLen: selectionLength() };
  }, { passive: true });
  view.addEventListener('touchend', (e) => {
    if (!start) return;
    const from = start;
    start = null;
    const t = e.changedTouches && e.changedTouches[0];
    if (!t) return;
    /* 手势期间选区的有无/长度变了 → 用户在选字(长按选词、拖手柄扩展选区),
     * 这不是翻篇手势,必须让给系统;否则会在选到一半时把用户翻到别的笔记去。
     * 判据用「**变化**」而不是「当前有选区」:后者会让页面上残留的旧选区
     * 永久挡住翻篇 —— 用户选完字没点空白取消,就再也划不动了。
     * 无 DOM 环境(纯 Node 单测)两条都不成立,不受影响。 */
    const nowSel = selectionLength();
    if (selChanged || (nowSel > 0 && nowSel !== from.selLen)) return;
    const delta = readSwipeIntent({
      dx: t.clientX - from.x, dy: t.clientY - from.y, atTop: from.atTop, atBottom: from.atBottom,
    });
    // 越界(已是本分类第一/最后一篇)静默 —— 与 J/K 的既有取舍同源,连续划不会弹一串提示
    if (delta) ctx.moveNoteSelection(delta);
  }, { passive: true });
  // 系统手势/来电打断时作废这次手势,避免把半截位移当成翻篇
  view.addEventListener('touchcancel', () => { start = null; }, { passive: true });
}

export function renderReadView(ctx) {
  const $ = (id) => ctx.dom.byId(id);
  const note = ctx.activeNoteData();
  if (!note) { ctx.showEmpty('从左侧选择一条笔记'); lastReadNoteId = null; return; }
  $('emptyState').hidden = true;
  $('editView').hidden = true;
  const view = $('readView');
  view.hidden = false;
  /* 换笔记就把阅读面滚回顶部。滚动容器是 #readView(overflow-y:auto),而本函数
   * 只重填 #readBody,容器自身的 scrollTop 会原样留着 → 从长文中段去点分类/点笔记,
   * 会直接落在新笔记的中间(新文更短时还会被夹到底部)。
   * ★ 同一篇的重绘**保持位置**:编辑完成、冲突取云端版、多标签页同步都属于这类,
   *   那时用户正读着这一篇,拽回顶部才是打扰(与 sidebar.openCategory 的例外同源)。
   * (2026-09-28:通栏阅读上线后暴露 —— 旧流程点分类必经 showEmpty,
   *  那条路径会 hidden 掉 #readView、滚动盒重建而顺带归零。)*/
  if (lastReadNoteId !== note.id) {
    view.scrollTop = 0;
    lastReadNoteId = note.id;
  }

  $('readTitle').textContent = note.title || '无标题';
  $('readMeta').textContent = `更新于 ${ctx.fmtTime(note.updatedAt)}${note.attachments.length ? ` · ${note.attachments.length} 个附件` : ''}`;

  const body = $('readBody');
  body.textContent = '';
  const md = ctx.renderMarkdown(note.content);
  for (const blk of md.querySelectorAll('.blk')) {
    const btn = document.createElement('button');
    btn.className = 'blk-copy';
    btn.innerHTML = ctx.icons.copy;
    btn.title = '复制本段';
    btn.addEventListener('click', () => ctx.copyText(blk.dataset.copy || blk.textContent, btn));
    blk.appendChild(btn);
  }
  body.appendChild(md);
  if (!note.content.trim()) {
    const hint = document.createElement('p');
    hint.className = 'read-empty';
    hint.textContent = '(空笔记,点「编辑」写点东西)';
    body.appendChild(hint);
  }

  renderReadAttachments(ctx, note);
}

function renderReadAttachments(ctx, note) {
  const box = ctx.dom.byId('readAtts');
  box.textContent = '';
  if (!note.attachments.length) return;
  const head = document.createElement('div');
  head.className = 'atts-head';
  head.textContent = '附件';
  box.appendChild(head);
  for (const att of note.attachments) {
    const chip = document.createElement('button');
    chip.className = 'att-chip';
    chip.innerHTML = ctx.icons.image + '<span class="att-name"></span>';
    chip.querySelector('.att-name').textContent = att.name;
    chip.title = '点击解密并显示';
    chip.addEventListener('click', () => toggleAttachmentImage(ctx, att, chip));
    box.appendChild(chip);
  }
}

/** 解密中的附件:防双击竞态重复贴图。模块级持有(只服务本模块)。 */
const attLoading = new Set();

async function toggleAttachmentImage(ctx, att, chip) {
  const S = ctx.store;
  const existing = S.get('objectUrls').get(att.file);
  const next = chip.nextElementSibling;
  if (next && next.classList.contains('att-img')) { next.remove(); return; }
  if (attLoading.has(att.file)) return;
  attLoading.add(att.file);
  try {
    let url = existing;
    if (!url) {
      const bytes = await S.get('lib').readAttachment(att.file);
      url = URL.createObjectURL(new Blob([bytes], { type: guessMime(att.name) }));
      S.get('objectUrls').set(att.file, url);
    }
    const wrap = document.createElement('div');
    wrap.className = 'att-img';
    const img = document.createElement('img');
    img.src = url;
    img.alt = att.name;
    wrap.appendChild(img);
    const dl = document.createElement('a');
    dl.href = url; dl.download = att.name; dl.textContent = '下载';
    dl.className = 'att-dl';
    wrap.appendChild(dl);
    chip.after(wrap);
  } catch (e) {
    ctx.toast(`附件解密失败:${e.message}`, 'error');
  } finally {
    attLoading.delete(att.file);
  }
}

function guessMime(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp' }[ext] || 'application/octet-stream';
}

export async function copyWholeNote(ctx) {
  const note = ctx.activeNoteData();
  if (!note) return;
  ctx.copyText(`${note.title}\n\n${note.content}`, ctx.dom.byId('btnCopyAll'));
}

/* ================= 编辑视图 ================= */

export function enterEditMode(ctx) {
  const S = ctx.store;
  const $ = (id) => ctx.dom.byId(id);
  const note = ctx.activeNoteData();
  if (!note) return;
  S.set('editing', true);
  $('readView').hidden = true;
  $('emptyState').hidden = true;
  $('editView').hidden = false;
  $('editTitle').value = note.title;
  $('editBody').value = note.content;
  renderEditAttachments(ctx, note);
  $('editTitle').focus();
}

export function collectEditChanges(ctx) {
  const S = ctx.store;
  const $ = (id) => ctx.dom.byId(id);
  const note = ctx.activeNoteData();
  if (!note) return;
  const title = $('editTitle').value.trim() || '无标题';
  const content = $('editBody').value;
  if (title !== note.title || content !== note.content) {
    note.title = title;
    note.content = content;
    note.updatedAt = Date.now();
    ctx.markDirty(S.get('activeCat'));
  }
  renderEditAttachments(ctx, note);
}

export function exitEditMode(ctx) {
  const S = ctx.store;
  collectEditChanges(ctx);
  ctx.saveAll(); // 「完成」即收尾:立刻上传,别让顶部挂着「有未保存更改」等 4 秒兜底
  S.set('editing', false);
  renderReadView(ctx);
  ctx.renderNoteList();
}

export function renderEditAttachments(ctx, note) {
  const S = ctx.store;
  const box = ctx.dom.byId('editAtts');
  box.textContent = '';
  if (!note.attachments.length) return;
  for (const [i, att] of note.attachments.entries()) {
    const chip = document.createElement('span');
    chip.className = 'att-chip editable';
    chip.innerHTML = ctx.icons.image + '<span class="att-name"></span>';
    chip.querySelector('.att-name').textContent = att.name;
    const del = document.createElement('button');
    del.className = 'att-del';
    del.textContent = '×';
    del.title = '从本笔记移除(图片文件保留,可稍后清理)';
    del.addEventListener('click', () => {
      note.attachments.splice(i, 1);
      note.updatedAt = Date.now();
      ctx.markDirty(S.get('activeCat'));
      renderEditAttachments(ctx, note);
    });
    chip.appendChild(del);
    box.appendChild(chip);
  }
}

export async function addAttachments(ctx, files) {
  const S = ctx.store;
  const activeCat = S.get('activeCat');
  const cat = S.get('lib').categoryInfo(activeCat);
  const note = ctx.activeNoteData();
  if (!cat || !note) return;
  const added = [];
  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { file: blobName } = await S.get('lib').addAttachment(bytes, file.name);
      const entry = { file: blobName, name: file.name };
      added.push(entry);
      note.attachments.push(entry);
    } catch (e) {
      ctx.toast(`「${file.name}」入库失败:${e.message}`, 'error');
    }
  }
  if (!added.length) return;
  // 上传途中可能收到另一标签页的 cat-saved → cat.data 被整体换掉(置 null 或换新
  // 对象),对旧引用直接解引用曾在这里 TypeError、已入库附件引用悬空。
  // 改为把已入库的附件合并进最新数据对象:
  if (cat.data) {
    const live = cat.data.notes.find((n) => n.id === note.id);
    if (live) {
      const have = new Set(live.attachments.map((a) => a.file));
      for (const a of added) if (!have.has(a.file)) live.attachments.push(a);
      live.updatedAt = Date.now();
      ctx.markDirty(activeCat);
      renderEditAttachments(ctx, live);
      return;
    }
  }
  ctx.toast('图片已入库,但该分类刚被其他标签页更新;重新打开分类后再查看', 'warn');
}

/* ================= 笔记增删排序 ================= */

let addingNote = false;

export async function addNote(ctx) {
  const S = ctx.store;
  if (addingNote) return; // 双击会造出两条「无标题」:忙态守卫
  const activeCat = S.get('activeCat');
  if (!activeCat) { ctx.toast('先选择一个分类', 'warn'); return; }
  addingNote = true;
  try {
    const cat = S.get('lib').categoryInfo(activeCat);
    if (!cat) return;
    await S.get('lib').loadCategory(activeCat);
    if (!cat.data) return; // 加载失败已在下面提示,这里别再解引用
    const sorted = F.sortNotes(cat.data.notes);
    const note = {
      id: `n${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
      title: '无标题',
      content: '',
      order: F.orderBetween(sorted.length ? sorted[sorted.length - 1].order : null, null),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      attachments: [],
    };
    cat.data.notes.push(note);
    ctx.markDirty(activeCat);
    ctx.openNote(note.id);
    enterEditMode(ctx);
  } catch (e) {
    // 分类加载失败以前是无提示的 unhandled rejection
    ctx.toast(`无法新建笔记:${e.message}`, 'error');
  } finally {
    addingNote = false;
  }
}

export async function deleteNote(ctx) {
  const S = ctx.store;
  const note = ctx.activeNoteData();
  if (!note) return;
  const yes = await ctx.modal({ type: 'confirm', danger: true, title: '删除笔记', text: `「${note.title || '无标题'}」将被删除(保存后生效,云端旧版有自动备份)。` });
  if (!yes) return;
  // 用户确认删除的是「眼前这份」(含编辑框里未提交的字),不是上次收尾的旧版 ——
  // 先收集再入回收站(2026-09-29 审计;与移动分类同一处修复模式)。
  if (S.get('editing')) { try { ctx.collectEditChanges?.(); } catch { /* 按内存现状删除 */ } }
  const activeCat = S.get('activeCat');
  const cat = S.get('lib').categoryInfo(activeCat);
  // 延期删除:先进本分类密文内的回收站,30 天内可恢复;真正清除由
  // normalizeNoteData 在读取时按 deletedAt 过期裁剪,与多端自然同步
  cat.data.trash = cat.data.trash || [];
  cat.data.trash.push({ ...note, deletedAt: Date.now() });
  cat.data.notes = cat.data.notes.filter((n) => n.id !== note.id);
  ctx.markDirty(activeCat);
  S.patch({ activeNoteId: null, editing: false });
  ctx.renderNoteList();
  ctx.showEmpty('笔记已移入「最近删除」,30 天内可恢复(保存后生效)', null, 'trash');
}

export function toggleNotePin(ctx, noteId) {
  const S = ctx.store;
  const activeCat = S.get('activeCat');
  const cat = S.get('lib').categoryInfo(activeCat);
  const note = cat?.data?.notes.find((n) => n.id === noteId);
  if (!note) return;
  note.pin = !note.pin;
  ctx.markDirty(activeCat); // pin 存在分类密文里,随保存多端同步
  ctx.renderNoteList();
}

export function moveNote(ctx, noteId, dir) {
  const S = ctx.store;
  const activeCat = S.get('activeCat');
  const cat = S.get('lib').categoryInfo(activeCat);
  const sorted = F.sortNotes(cat.data.notes);
  const idx = sorted.findIndex((n) => n.id === noteId);
  if (idx < 0) return;
  const target = dir < 0 ? idx - 1 : idx + 1;
  if (target < 0 || target >= sorted.length) return;
  // 不跨置顶分区移动:分区由 pin 优先排序保证,跨区交换不会有视觉反馈
  if ((sorted[target].pin === true) !== (sorted[idx].pin === true)) return;
  // 相邻交换 order 值:所见即所得,且不产生中值新数(order 永不漂移)
  const a = sorted[idx].order;
  sorted[idx].order = sorted[target].order;
  sorted[target].order = a;
  ctx.markDirty(activeCat);
  ctx.renderNoteList();
}

/* ================= 跨分类移动 ================= */

/** 忙态守卫:跨分类移动要写两个文件、网络往返期间重复点击会造出两份副本。 */
let movingNote = false;

/**
 * 把一篇笔记移到另一个分类。
 *
 * 写入顺序是刻意的 —— **先写目标、成功之后才动源**(见 Library.appendNoteToCategory):
 *   ① 先写目标分类(含这篇笔记),失败则源一动不动,零损失;
 *   ② 目标落盘成功后才从源分类删掉,并标脏交给常规保存流水线。
 *   反序(先删源再写目标)遇上中断就是**笔记丢失**;按这个顺序最坏只剩短暂重复,
 *   而且重复会被下一轮保存收敛、云端每分类还有 10 份备份兜底。
 *
 * 免费版 Workers 的请求数:目标已解密时 = 写目标 + 写源 + 1 次篇数(两处合并成一次
 *   vault 条件写)。**不额外增加任何请求**,也不新建服务端键。
 *
 * @returns {Promise<boolean>} 是否真的移动成功(失败已自行 toast)
 */
export async function moveNoteToCategory(ctx, noteId, toName) {
  const S = ctx.store;
  if (movingNote) return false;
  const fromName = S.get('activeCat');
  if (!fromName || !toName || fromName === toName) return false;
  const lib = S.get('lib');
  const src = lib?.categoryInfo(fromName);
  const note = src?.data?.notes.find((n) => n.id === noteId);
  if (!note) return false;
  const dst = lib.categoryInfo(toName);
  if (!dst) { ctx.toast(`分类「${toName}」已不存在`, 'error'); return false; }

  movingNote = true;
  try {
    // 正在编辑的就是这篇:先把编辑框里未提交的标题/正文收进内存,再拷贝出去。
    // 否则移动走的是「上次收尾时提交的旧内容」,编辑框里的字随移动静默丢失
    // (2026-09-29 审计;收集失败不阻断移动 —— 顶多退回旧行为)。
    if (S.get('editing') && S.get('activeNoteId') === noteId) {
      try { ctx.collectEditChanges?.(); } catch { /* 收集不了就按内存现状移动 */ }
    }
    // 深拷贝:这篇笔记随后要从源分类里删掉,两边不能共享同一个对象引用
    const moved = JSON.parse(JSON.stringify(note));
    delete moved.deletedAt;
    // 目标分类的末尾 —— order 必须按**目标**分类自己的号段算,源分类的 order 在这里无意义
    await lib.loadCategory(toName);
    const dstNotes = dst.data ? F.sortNotes(dst.data.notes) : [];
    moved.order = F.orderBetween(dstNotes.length ? dstNotes[dstNotes.length - 1].order : null, null);

    const res = await lib.appendNoteToCategory(toName, moved);
    if (!res?.ok) {
      ctx.toast(res?.conflict
        ? `「${toName}」刚被其他设备改过,本次移动未生效;源分类未改动,请重试`
        : `移动到「${toName}」未生效:目标分类当前不可写入;源分类未改动`, 'error');
      return false;
    }

    /* —— 目标已落盘,现在才动源 —— */
    const idx = src.data.notes.findIndex((n) => n.id === noteId);
    if (idx >= 0) src.data.notes.splice(idx, 1);
    ctx.markDirty(fromName);
    // 两处篇数合并成**一次** vault 条件写(拆成两次就是两次网络往返)
    lib.setCatCounts({
      [fromName]: src.data.notes.length,
      [toName]: dst.data ? dst.data.notes.length : 0,
    }).then(() => ctx.renderCategoryList()).catch(() => { /* 徽章晚一拍对齐,正文不受影响 */ });
    // 目标分类的云端版本变了 → 通知其他标签页那张表失效(源分类的控制流在保存成功后自己发)
    S.get('tabs')?.send({ type: 'cat-saved', name: toName });

    if (S.get('activeNoteId') === noteId) {
      S.patch({ activeNoteId: null, editing: false });
      ctx.showEmpty(`「${moved.title || '无标题'}」已移动到「${toName}」`, null, 'list');
    }
    ctx.renderNoteList();
    ctx.toast(`已移动到「${toName}」`);
    return true;
  } catch (e) {
    ctx.toast(`移动失败:${e.message}`, 'error');
    return false;
  } finally {
    movingNote = false;
  }
}

/**
 * 弹出分类清单让用户点选目标分类。
 * 不做成「输入分类名」:名字要精确匹配,输错一次就白操作一遍(还可能误建同名分类)。
 * 分类很多时清单可滚动(样式同回收站列表)。
 */
export async function pickCategoryForNote(ctx, noteId) {
  const S = ctx.store;
  const lib = S.get('lib');
  const fromName = S.get('activeCat');
  if (!lib || !fromName) { ctx.toast('先选择一个分类', 'warn'); return; }
  const note = lib.categoryInfo(fromName)?.data?.notes.find((n) => n.id === noteId);
  if (!note) return;
  const names = lib.sortedCategories().filter((n) => n !== fromName);
  if (!names.length) { ctx.toast('只有一个分类,先新建一个分类才能移动', 'warn'); return; }

  let picked = null;
  await ctx.modal({
    type: 'custom',
    title: '移动到其他分类',
    text: `「${note.title || '无标题'}」将移动到所选分类的末尾;源分类的这篇会移除。`,
    build: (body) => {
      const list = document.createElement('div');
      list.className = 'cat-pick';
      for (const name of names) {
        const b = document.createElement('button');
        b.className = 'btn ghost block';
        b.textContent = name;
        const cnt = lib.catCount(name);
        if (cnt !== null) b.title = `${cnt} 篇笔记`;
        b.addEventListener('click', () => {
          picked = name;
          ctx.dom.byId('modal')?.close();   // 关弹窗(与弹窗自带「关闭」同一路径),再由下方执行移动
        });
        list.appendChild(b);
      }
      body.appendChild(list);
    },
  });
  if (picked) await moveNoteToCategory(ctx, noteId, picked);
}
