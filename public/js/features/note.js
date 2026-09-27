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

export function renderReadView(ctx) {
  const $ = (id) => ctx.dom.byId(id);
  const note = ctx.activeNoteData();
  if (!note) { ctx.showEmpty('从左侧选择一条笔记'); return; }
  $('emptyState').hidden = true;
  $('editView').hidden = true;
  const view = $('readView');
  view.hidden = false;

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
