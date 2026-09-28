/* ============================================================
 * feature: 左侧栏(分类列表 + 笔记列表)
 * ------------------------------------------------------------
 * 从 ui.js 的「左侧:分类」「左侧:笔记列表」两个区块原样迁出。
 *
 * ★ 与 note.js 互为依赖,靠 ctx 解开循环:
 *   sidebar → note : openCategory 的「新建笔记」引导按钮要 addNote;
 *                    openNote 要 renderReadView;
 *                    renderNoteList 的按钮要 moveNote / toggleNotePin
 *   note    → sidebar : 几乎每个操作后都要 renderNoteList / activeNoteData
 *   两个模块**都不 import 对方** —— 由 ui.js 在 ctx 里把两边接起来。
 *   一旦谁 import 了谁,加载顺序就未定义(tests/features.test.mjs 会红)。
 *
 * 依赖(经 ctx 注入):
 *   - dom.byId(id)         取元素
 *   - icons                描边图标表
 *   - toast / modal        通知与对话框
 *   - store                会话态(lib / activeCat / activeNoteId / editing / dirty / tabs)
 *   - addNote()            新建笔记(note.js)
 *   - renderReadView()     重绘阅读视图(note.js)
 *   - moveNote(id,dir)     笔记上移/下移(note.js)
 *   - toggleNotePin(id)    笔记置顶开关(note.js)
 *   - showEmpty(...)       空状态区
 *   - closeDrawer()        移动端收起抽屉
 *   - format               { sortNotes }(也可以直接 import)
 * ============================================================ */
import * as F from '../format.js';

/** 列表项统一可点:键盘可达(Tab 聚焦 + Enter/空格触发),而非只认鼠标 click。
 *  ⚠️ 角色语义:侧栏列表是单选场景,用 listbox/option(而非 button/列表项各设
 *  role="button")保住「列表, N 项」的读屏播报。
 *  ⚠️ 这里**不设** aria-selected —— 选中态是列表渲染器的职责(渲染循环里
 *  按 active 与否设值),在此无条件设 false 会把渲染循环先设好的 true 覆盖掉
 *  (2026-09-27 修复探针实测踩到:active 类在、aria-selected 却是 false)。
 *  实际「按下」走 Enter/空格监听。(2026-09-27 审计 P3-5) */
export function clickable(el, fn) {
  el.tabIndex = 0;
  el.setAttribute('role', 'option');
  el.addEventListener('click', fn);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(e); }
  });
}

export function renderCategoryList(ctx) {
  const S = ctx.store;
  const $ = (id) => ctx.dom.byId(id);
  const ul = $('catList');
  ul.textContent = '';
  ul.setAttribute('role', 'listbox');
  ul.setAttribute('aria-label', '分类列表');
  const lib = S.get('lib');
  // 锁屏/切库的极短竞态里会渲染到「lib 已置 null」的瞬间(store.js:releaseSession)。
  // 此前直接 lib.listCategories() 会抛 TypeError 打断整条渲染链
  // (2026-09-27 审计 P2)。空手画个空列表即可,下一拍 boot 会重画。
  if (!lib) return;
  const names = lib.listCategories();
  const activeCat = S.get('activeCat');
  // 置顶优先,组内按名称排序(与云端清单字典序一致,顺序可预期)
  names.sort((a, b) => ((lib.catPin(b) === true) - (lib.catPin(a) === true)) || a.localeCompare(b));
  for (const name of names) {
    const info = lib.categoryInfo(name);
    const pinned = lib.catPin(name);
    const li = document.createElement('li');
    li.className = 'cat-item' + (name === activeCat ? ' active' : '');
    li.classList.toggle('pinned', pinned);
    if (info?.conflict) li.classList.add('warn');
    if (info?.error) li.classList.add('broken');
    // 选中态同步到可访问名:读屏器由此知道「当前打开的是哪个分类」
    li.setAttribute('aria-selected', name === activeCat ? 'true' : 'false');

    const label = document.createElement('span');
    label.className = 'cat-name';
    label.textContent = name;
    label.title = info?.conflict ? '疑似同步冲突副本,请核对内容后处理'
      : info?.error ? `无法解密:${info.error}` : name;
    li.appendChild(label);

    /* 笔记篇数徽章:规模一眼可见,不用逐个点开数。
     * 值是本地缓存的(catMeta.count),冷启动时可能还不知道 —— 此时整块不渲染,
     * 而不是先画一个 0 再跳成真实数(闪烁比没有更糟)。 */
    const count = lib.catCount(name);
    if (count !== null) {
      const cnt = document.createElement('span');
      cnt.className = 'cat-count';
      cnt.textContent = String(count);
      cnt.title = `${count} 篇笔记`;
      li.appendChild(cnt);
    }

    /* 状态告警(⚠ 冲突 / ⛔ 无法解密):同样是 SVG 图标 + 定宽槽位,
     * 与图钉槽位同款做法 —— 名字多长都不会把告警符推到不同位置,
     * 也不会因为告警符从无到有而让标题宽度跳动。
     * 语义进 aria-label,读屏用户不再只听到一个裸字符。 */
    const warnSlot = document.createElement('span');
    warnSlot.className = 'warn-slot';
    if (info?.conflict || info?.error) {
      warnSlot.classList.add(info.error ? 'blocked' : 'warn');
      warnSlot.innerHTML = info.error ? ctx.icons.blocked : ctx.icons.warn;
      warnSlot.setAttribute('aria-label', info.error ? `无法解密:${info.error}` : '疑似同步冲突');
      warnSlot.title = label.title;
    }
    li.appendChild(warnSlot);

    /* 置顶图钉挂在标题之后:正文列从左对齐,不再被图标推右。
     * 空槽位也占位,悬停浮层出现/消失时标题宽度纹丝不动 */
    const slot = document.createElement('span');
    slot.className = 'pin-slot';
    if (pinned) {
      const mark = document.createElement('span');
      mark.className = 'pin-mark';
      mark.innerHTML = ctx.icons.pin;
      slot.appendChild(mark);
    }
    li.appendChild(slot);

    const btns = document.createElement('div');
    btns.className = 'cat-btns';
    const pinBtn = document.createElement('button');
    pinBtn.className = 'icon-btn';
    pinBtn.title = pinned ? '取消置顶' : '置顶';
    // svg 图标带 aria-hidden="true",title 又不算可访问名 → 必须显式给 aria-label,
    // 否则读屏器只播报「按钮」(2026-09-27 审计 P3-4)
    pinBtn.setAttribute('aria-label', pinBtn.title);
    pinBtn.innerHTML = ctx.icons.pin;
    pinBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await lib.setCatPin(name, !pinned);
        ctx.toast(pinned ? `已取消置顶「${name}」` : `已置顶「${name}」`);
      } catch (err) {
        ctx.toast(`置顶失败:${err.message}`, 'error');
      }
      renderCategoryList(ctx);
    });
    btns.appendChild(pinBtn);
    li.appendChild(btns);

    clickable(li, () => openCategory(ctx, name));
    ul.appendChild(li);
  }
  if (!names.length) {
    const li = document.createElement('li');
    li.className = 'cat-item none';
    li.textContent = '暂无分类,点上方 + 新建';
    ul.appendChild(li);
  }
}

/** 打开分类的序号守卫:慢请求后到不得覆盖用户后选的分类。
 *  ★ 与 search.js 的 searchSeq 同款做法 —— 这类竞态句柄只服务本模块,不进 store。 */
let catOpenSeq = 0;

export async function openCategory(ctx, name) {
  const S = ctx.store;
  const seq = ++catOpenSeq;
  try {
    await S.get('lib').loadCategory(name);
  } catch (e) {
    if (seq !== catOpenSeq) return; // 期间用户已换分类,这个失败不必再弹
    ctx.toast(`分类「${name}」无法打开:${e.message}`, 'error');
    renderCategoryList(ctx);
    return;
  }
  if (seq !== catOpenSeq) return; // 慢的分类请求后到:放弃,别覆盖用户新选的分类
  /* 点分类默认读列表最顶端那篇(2026-09-28 用户要求:省掉「再点一次笔记」这步)。
   * 顺序必须用 F.sortNotes —— 与侧栏渲染同源,视觉第一行就是第一篇。
   * 例外:重载**当前**分类(冲突回云端 / 多标签页同步)时,原选中的笔记还在
   * 就保持不动 —— 那两种场景用户正读着它,拽到顶端等于把人踢走。 */
  const catInfo = S.get('lib').categoryInfo(name);
  const notes = catInfo?.data ? F.sortNotes(catInfo.data.notes) : [];
  const prevId = S.get('activeNoteId');
  const openId = notes.some((n) => n.id === prevId) ? prevId : (notes[0]?.id ?? null);
  S.patch({ activeCat: name, activeNoteId: openId, editing: false });
  ctx.dom.byId('activeCatName').textContent = name;
  renderCategoryList(ctx);
  renderNoteList(ctx);
  ctx.closeDrawer(); // 移动端:选完分类收起抽屉,把屏幕还给内容
  if (openId) {
    ctx.renderReadView();
  } else {
    /* 真正空分类才落空状态,并顺手给「新建笔记」引导 */
    ctx.showEmpty(`「${name}」暂无笔记`, { label: '新建笔记', fn: () => ctx.addNote() });
  }
}

export async function addCategory(ctx) {
  const name = await ctx.modal({ type: 'prompt', title: '新建分类', label: '分类名,如:秘钥 / 攻略' });
  if (name == null) return;
  try {
    const created = await ctx.store.get('lib').createCategory(name);
    ctx.store.get('tabs')?.send({ type: 'cats-changed' });
    await openCategory(ctx, created);
  } catch (e) {
    ctx.toast(e.message, 'error');
  }
}

export async function renameCategory(ctx) {
  const S = ctx.store;
  const activeCat = S.get('activeCat');
  if (!activeCat) return;
  const name = await ctx.modal({ type: 'prompt', title: '重命名分类', value: activeCat, text: '改名只换文件名,笔记内容零改动、零重加密传输' });
  if (name == null || name === activeCat) return;
  try {
    const created = await S.get('lib').renameCategory(activeCat, name);
    // 未保存的改动跟着搬到新名字:重命名只是换键名,本地这份改过的数据
    // 仍是最新内容;脏标记留在旧名上等于让它脱离保存队列(静默丢失)。
    // 代数一并搬迁 —— 重命名不改变内容新旧,saveAll 的窗口期判定要延续。
    S.moveDirty(activeCat, created);
    S.get('tabs')?.send({ type: 'cats-changed' });
    S.set('activeCat', created);
    renderCategoryList(ctx);
    renderNoteList(ctx);
    ctx.dom.byId('activeCatName').textContent = created;
    ctx.toast(`已重命名为「${created}」`);
  } catch (e) {
    ctx.toast(e.message, 'error');
  }
}

export async function deleteCategory(ctx) {
  const S = ctx.store;
  const activeCat = S.get('activeCat');
  if (!activeCat) {
    ctx.toast('先选择一个要删除的分类', 'warn');
    return;
  }
  const yes = await ctx.modal({
    type: 'confirm', danger: true,
    title: `删除分类「${activeCat}」`,
    text: '分类文件将从服务器删除,删除前会自动备份(每分类保留最近 10 份)。引用的图片不会自动删,可稍后手动「清理未引用图片」。',
  });
  if (!yes) return;
  try {
    await S.get('lib').deleteCategory(activeCat);
    S.clearDirty(activeCat);
    S.get('tabs')?.send({ type: 'cats-changed' });
    S.patch({ activeCat: null, activeNoteId: null });
    renderCategoryList(ctx);
    renderNoteList(ctx);
    ctx.dom.byId('activeCatName').textContent = '未选择分类';
    ctx.showEmpty('从左侧选择一个分类');
    ctx.toast('分类已删除(旧版本已自动备份到服务器)');
  } catch (e) {
    ctx.toast(e.message, 'error');
  }
}

/* ================= 笔记列表 ================= */

export function activeNoteData(ctx) {
  const S = ctx.store;
  const activeCat = S.get('activeCat');
  if (!activeCat) return null;
  const cat = S.get('lib')?.categoryInfo(activeCat);
  if (!cat?.data) return null;
  return cat.data.notes.find((n) => n.id === S.get('activeNoteId')) || null;
}

export function renderNoteList(ctx) {
  const S = ctx.store;
  const $ = (id) => ctx.dom.byId(id);
  const ul = $('noteList');
  ul.textContent = '';
  ul.setAttribute('role', 'listbox');
  ul.setAttribute('aria-label', '笔记列表');
  const activeCat = S.get('activeCat');
  const lib = S.get('lib');
  // 同 renderCategoryList:lib 为 null(锁屏竞态)时不要解引用,清一下标题即可
  if (!lib) { $('activeCatName').textContent = '未选择分类'; return; }
  const cat = activeCat && lib.categoryInfo(activeCat);
  if (!cat?.data) { $('activeCatName').textContent = activeCat || '未选择分类'; return; }

  /* ⚠️ 必须走 F.sortNotes,不能直接用 cat.data.notes 的存储顺序。
   *   两者只在「天然有序」时才恰好一致 —— 一旦用户点过「上移/下移」,
   *   变化的只是各项的 order 值,数组本身仍是插入序 → 界面会纹丝不动,
   *   要等下次从密文重载(顺序才按 order 重建)才看见效果。
   *   2026-09-27 反向探针实测:store 里 order 已正确互换(2000/1000),
   *   而列表渲染顺序不变 —— 就是这行漏掉排序导致的。
   *   与下方 moveNoteSelection(:334)保持同源,视觉第几行就是第几个。 */
  const notes = F.sortNotes(cat.data.notes);
  const activeNoteId = S.get('activeNoteId');
  // 侧栏标题带上篇数:规模一眼可见,不用点进去数
  $('activeCatName').textContent = `${activeCat} · ${notes.length} 篇`;
  for (const note of notes) {
    const li = document.createElement('li');
    li.className = 'note-item' + (note.id === activeNoteId ? ' active' : '');
    li.classList.toggle('pinned', note.pin === true);
    li.setAttribute('aria-selected', note.id === activeNoteId ? 'true' : 'false');

    const main = document.createElement('div');
    main.className = 'note-main';

    const title = document.createElement('div');
    title.className = 'note-title';
    title.textContent = note.title || '无标题';
    // 单行清单不展开内容,悬停用原生气泡兜底给出时间与正文概要
    li.title = `${ctx.fmtTime(note.updatedAt)} · ${(note.content.trim().replace(/\s+/g, ' ').slice(0, 60)) || '(空)'}`;
    main.appendChild(title);

    /* 图钉在标题之后 + 定宽槽位:多条置顶的图标落在同一条竖线上,
     * 且不侵占标题起点(与分类列左对齐) */
    const slot = document.createElement('span');
    slot.className = 'pin-slot';
    if (note.pin === true) {
      const mark = document.createElement('span');
      mark.className = 'pin-mark';
      mark.innerHTML = ctx.icons.pin;
      slot.appendChild(mark);
    }
    main.appendChild(slot);
    li.appendChild(main);

    const btns = document.createElement('div');
    btns.className = 'note-btns';
    const upBtn = document.createElement('button');
    upBtn.className = 'icon-btn';
    upBtn.title = '上移';
    upBtn.setAttribute('aria-label', '上移'); // svg 带 aria-hidden,title 不作可访问名
    upBtn.innerHTML = ctx.icons.up;
    upBtn.addEventListener('click', (e) => { e.stopPropagation(); ctx.moveNote(note.id, -1); });
    const downBtn = document.createElement('button');
    downBtn.className = 'icon-btn';
    downBtn.title = '下移';
    downBtn.setAttribute('aria-label', '下移');
    downBtn.innerHTML = ctx.icons.down;
    downBtn.addEventListener('click', (e) => { e.stopPropagation(); ctx.moveNote(note.id, 1); });
    const pinBtn = document.createElement('button');
    pinBtn.className = 'icon-btn';
    pinBtn.title = note.pin ? '取消置顶' : '置顶';
    pinBtn.setAttribute('aria-label', pinBtn.title);
    pinBtn.innerHTML = ctx.icons.pin;
    pinBtn.addEventListener('click', (e) => { e.stopPropagation(); ctx.toggleNotePin(note.id); });
    btns.append(upBtn, downBtn, pinBtn);
    li.appendChild(btns);

    clickable(li, () => openNote(ctx, note.id));
    ul.appendChild(li);
  }
  if (!notes.length) {
    const li = document.createElement('li');
    li.className = 'note-item none';
    li.textContent = '暂无笔记';
    ul.appendChild(li);
  }
}

export function openNote(ctx, noteId) {
  const S = ctx.store;
  ctx.closeDrawer(); // 移动端:选完笔记收起抽屉
  S.patch({ activeNoteId: noteId, editing: false });
  renderNoteList(ctx);
  ctx.renderReadView();
}

/**
 * 按 J / K 切换上一条 / 下一条笔记。
 * @param {number} delta +1 下一条,-1 上一条
 * @returns {boolean} 是否真的移动了(没移动就返回 false,让调用方别 preventDefault)
 *
 * 几条刻意的取舍:
 *   · 顺序用 F.sortNotes —— 与侧栏渲染同源,视觉第几行就是第几个。
 *   · 不跨分类、到头即停:越界时静默返回 false。连续按住 J 到末尾不会弹一堆提示。
 *   · 只在读态生效:编辑态下 J/K 就是普通字符,必须让它们落进 textarea。
 *   · 焦点在输入类元素里一律不接管,否则搜索框里打 j 会跳笔记。
 */
export function moveNoteSelection(ctx, delta) {
  const S = ctx.store;
  const activeCat = S.get('activeCat');
  if (!activeCat || S.get('editing')) return false;
  if (!ctx.dom.byId('searchPanel').hidden) return false;
  const focus = document.activeElement;
  if (focus && (focus.isContentEditable
      || /^(INPUT|TEXTAREA|SELECT)$/.test(focus.tagName))) return false;
  const cat = S.get('lib')?.categoryInfo(activeCat);
  if (!cat?.data) return false;
  const notes = F.sortNotes(cat.data.notes);
  if (!notes.length) return false;
  const cur = notes.findIndex((n) => n.id === S.get('activeNoteId'));
  // 当前没选中(= -1)时:下一条给第一项、上一条给最后一项
  const next = cur < 0 ? (delta > 0 ? 0 : notes.length - 1) : cur + delta;
  if (next < 0 || next >= notes.length) return false;
  if (next === cur) return false;
  openNote(ctx, notes[next].id);
  // 键盘走得比眼快,把新选中的那条滚进视野(侧栏可能很长)
  const li = ctx.dom.byId('noteList').querySelector('.note-item.active');
  li?.scrollIntoView({ block: 'nearest' });
  return true;
}
