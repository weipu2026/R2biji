/* ============================================================
 * feature: 数据操作(剪贴板清理 / 导出提醒 / 回收站 / 密码生成器 / 导出 .md)
 * ------------------------------------------------------------
 * 从 ui.js 的「最近删除 / 密码生成器 / 导出 .md」区块原样迁出。
 *
 * 依赖(经 ctx 注入):
 *   - dom.byId(id)        取元素
 *   - toast / modal       通知与对话框
 *   - store               会话态(lib / settings / activeCat)
 *   - markDirty(name)     标记分类有未保存改动
 *   - renderNoteList()    重绘笔记列表
 *   - activeNoteData()    取当前笔记对象
 *   - copyText(text,btn)  复制并给按钮反馈
 *   - downloadBytes(...)  下载字节为文件
 *   - genPassword         来自 format.js(纯函数,本模块直接 import)
 * ============================================================ */
import * as F from '../format.js';

/** 剪贴板自动清除的计时器句柄。模块级持有(只服务本模块的竞态控制)。 */
let clipWipeTimer = null;

/** 剪贴板自动清除:密码本里复制的内容多半是敏感值,60 秒后自动清空 ——
 * 不给「复制完忘了、剪贴板被任意应用读走」留口子。
 * 清空要求页面保持前台,失败(失焦等)即放弃,不打扰。 */
export function scheduleClipboardWipe(ctx, seconds = 60) {
  clearTimeout(clipWipeTimer);
  ctx.toast(`已复制,${seconds} 秒后自动清空剪贴板`);
  clipWipeTimer = setTimeout(async () => {
    try { await navigator.clipboard.writeText(' '); } catch { /* 失焦等场景清不掉,放弃 */ }
  }, seconds * 1000);
}

/** 导出备份到期提醒:30 天没导出(或从未导出)就给「导出」图标挂小红点 */
export function refreshExportDue(ctx) {
  const lib = ctx.store.get('lib');
  const settings = ctx.store.get('settings');
  const last = Number(settings.lastExportAt) || 0;
  const due = lib.listCategories().length > 0
    && (!last || Date.now() - last > 30 * 86400000);
  ctx.dom.byId('btnExport').classList.toggle('due', due);
  if (due && !last) ctx.toast('还没导出过全库备份,建议先导出一份(左下角下载图标)', 'warn');
}

/** 最近删除:回收站存在各分类密文内部的 trash 数组里,
 * 与笔记同一条加密 / CAS / 备份流水线,不新增任何服务端键 */
export async function openTrash(ctx) {
  const lib = ctx.store.get('lib');
  if (!lib) return;
  await lib.loadAllCategories().catch(() => {}); // 没解密过的分类补齐(个人库量小)
  const entries = [];
  for (const [name, cat] of lib.categories) {
    for (const t of cat.data?.trash || []) entries.push({ catName: name, note: t });
  }
  entries.sort((a, b) => b.note.deletedAt - a.note.deletedAt);

  await ctx.modal({
    type: 'custom',
    title: `最近删除(${entries.length} 条,保留 ${F.TRASH_DAYS} 天)`,
    text: entries.length ? '恢复即回到原分类;「彻底删除」不可恢复。' : '回收站是空的。',
    build: (body) => {
      for (const { catName, note } of entries) {
        const row = document.createElement('div');
        row.className = 'trash-row';
        const info = document.createElement('div');
        info.className = 'trash-info';
        const t = document.createElement('div');
        t.className = 'trash-title';
        t.textContent = note.title || '无标题';
        const meta = document.createElement('div');
        meta.className = 'trash-meta';
        meta.textContent = `${catName} · 删除于 ${F.relTime(note.deletedAt)}`;
        info.append(t, meta);
        const ops = document.createElement('div');
        ops.className = 'trash-ops';
        const restore = document.createElement('button');
        restore.className = 'btn small primary';
        restore.textContent = '恢复';
        restore.addEventListener('click', () => restoreFromTrash(ctx, catName, note, row));
        const purge = document.createElement('button');
        purge.className = 'btn small ghost danger';
        purge.textContent = '彻底删除';
        purge.addEventListener('click', () => purgeFromTrash(ctx, catName, note, row));
        ops.append(restore, purge);
        row.append(info, ops);
        body.appendChild(row);
      }
    },
  });
}

function restoreFromTrash(ctx, catName, note, row) {
  const lib = ctx.store.get('lib');
  const cat = lib.categoryInfo(catName);
  if (!cat?.data) { ctx.toast('原分类已不可读,无法恢复', 'error'); return; }
  cat.data.trash = (cat.data.trash || []).filter((t) => t.id !== note.id);
  delete note.deletedAt;
  const maxOrder = cat.data.notes.reduce((m, n) => Math.max(m, n.order), 0);
  note.order = F.orderBetween(maxOrder, null); // 排到分类末尾
  cat.data.notes.push(note);
  ctx.markDirty(catName);
  row.remove();
  if (ctx.store.get('activeCat') === catName) ctx.renderNoteList();
  ctx.toast(`已恢复到「${catName}」`);
}

function purgeFromTrash(ctx, catName, note, row) {
  const lib = ctx.store.get('lib');
  const cat = lib.categoryInfo(catName);
  if (!cat?.data) return;
  cat.data.trash = (cat.data.trash || []).filter((t) => t.id !== note.id);
  ctx.markDirty(catName);
  row.remove();
  ctx.toast('已彻底删除(保存后生效)');
}

/** 单篇导出为 .md 文件(纯正文,不加密 —— 由用户自己决定放哪) */
export function exportNoteMd(ctx) {
  const note = ctx.activeNoteData();
  if (!note) return;
  const name = (note.title || '无标题').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60);
  ctx.downloadBytes(new TextEncoder().encode(note.content), `${name}.md`, 'text/markdown');
}

/** 随机密码生成器:Web Crypto + 拒绝采样,生成只在本机内存里进行 */
export async function openPwGenerator(ctx) {
  await ctx.modal({
    type: 'custom',
    title: '随机密码生成器',
    text: 'Web Crypto 生成,已剔除易混淆字符(0/O、1/l/I);生成只在本机内存里进行。',
    build: (body) => {
      const opts = document.createElement('div');
      opts.className = 'gen-opts';
      const lenLabel = document.createElement('label');
      lenLabel.className = 'gen-opt';
      lenLabel.textContent = '长度';
      const lenSel = document.createElement('select');
      for (const n of [12, 16, 20, 24, 32]) {
        const o = document.createElement('option');
        o.value = String(n);
        o.textContent = `${n} 位`;
        if (n === 16) o.selected = true;
        lenSel.appendChild(o);
      }
      lenLabel.appendChild(lenSel);
      const symLabel = document.createElement('label');
      symLabel.className = 'gen-opt';
      const symChk = document.createElement('input');
      symChk.type = 'checkbox';
      symChk.checked = true;
      symLabel.append(symChk, document.createTextNode(' 含符号'));
      opts.append(lenLabel, symLabel);

      const out = document.createElement('input');
      out.className = 'modal-input';
      out.readOnly = true;
      out.setAttribute('aria-label', '生成的密码');
      out.style.fontFamily = 'var(--mono)';
      out.style.fontSize = '15px';

      const ops = document.createElement('div');
      ops.className = 'modal-btns';
      ops.style.justifyContent = 'flex-start';
      const regen = document.createElement('button');
      regen.className = 'btn ghost';
      regen.textContent = '换一个';
      const copy = document.createElement('button');
      copy.className = 'btn primary';
      copy.textContent = '复制';
      ops.append(regen, copy);

      const gen = () => { out.value = F.genPassword(Number(lenSel.value), { symbols: symChk.checked }); };
      regen.addEventListener('click', gen);
      lenSel.addEventListener('change', gen);
      symChk.addEventListener('change', gen);
      copy.addEventListener('click', () => ctx.copyText(out.value, copy));

      body.append(opts, out, ops);
      gen();
    },
  });
}
