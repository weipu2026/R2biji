/* ============================================================
 * JMbiji 界面控制器(仅浏览器)
 * 状态只存内存;锁屏 = 丢弃 Library 实例(密钥与明文一起释放)
 * ============================================================ */

import * as V from './vaultlib.js';
import * as F from './format.js';
import * as API from './api.js';
import { Library } from './lib.js';
import { renderMarkdown } from './render.js';
import { findMatches, renderSearchResult } from './search.js';
import { saveSession, loadSession, clearSession } from './session.js';
import { TabSync, planSavedCategoryAction } from './tabsync.js';

const $ = (id) => document.getElementById(id);

const AUTOSAVE_MS = 5 * 60 * 1000;      // 改动停止后 5 分钟兜底
const SAVE_DEBOUNCE_MS = 800;            // 状态栏防抖刷新
/* 自动锁屏默认「关闭」。它与「记住本设备」的目的正好相反:前者要「离开就得输密码」,
 * 后者要「打开即用」。默认给后者,想要前者自己去侧栏选 —— 选了之后空闲到点会
 * 锁定并**忘掉本机会话**,语义一致:锁定 = 需要重新输主密码。 */
const DEFAULT_AUTOLOCK_MIN = 0;

const S = {
  lib: null,             // Library 实例(持密钥与明文;锁屏即置 null)
  vaultJson: null,       // 解锁前拉到的 vault.json(解锁成功后转存进 Library)
  vaultEtag: null,       // vault.json 的 etag(改密码 CAS 用)
  activeCat: null,
  activeNoteId: null,
  editing: false,
  dirty: new Set(),      // 有未保存改动的分类名
  saving: false,
  autoSaveTimer: null,
  statusTimer: null,
  idleTimer: null,
  tabs: null,            // TabSync:同一浏览器多个标签页之间的通知(可能不可用)
  settings: { autoLockMinutes: DEFAULT_AUTOLOCK_MIN, rememberDevice: true },
  objectUrls: new Map(), // blobName → objectURL(图片展示缓存)
};

/* ================= 工具 ================= */

function toast(msg, kind = 'info') {
  const box = document.createElement('div');
  box.className = `toast toast-${kind}`;
  box.textContent = msg;
  $('toasts').appendChild(box);
  // 错误提示留久一点:失败信息(尤其是「已中止」这类)通常比「已复制」更需要看清
  setTimeout(() => box.remove(), kind === 'error' ? 8000 : 3000);
}

/**
 * 通用对话框:返回 Promise。type: 'prompt' | 'confirm' | 'conflict'
 *
 * 导出仅为了可测:这是唯一一处「按钮 → 返回值」的映射,写错了不会有任何报错,
 * 只会静默失效(见下面 prompt 分支的注释)。tests/dialog.test.mjs 用极简 DOM 替身覆盖它。
 */
export function modal({ type, title, label, value = '', text = '', danger = false, password = false, build = null }) {
  return new Promise((resolve) => {
    const dlg = $('modal');
    const body = $('modalBody');
    body.textContent = '';

    // ★ Esc(以及一切非按钮的关闭路径)也必须落定 Promise,否则调用方 await 永久挂起:
    //   保存冲突弹窗按 Esc 曾把 S.saving 卡成恒 true,整个保存流水线静默失效;
    //   boot 的访问密钥弹窗按 Esc 则页面永久卡在锁屏。
    //   cancel = 原生 dialog 的 Esc 关闭(先于 close 触发);close = 兜底其余关闭路径。
    //   按钮路径先落定值,close 事件晚到时 settled 保证不会改写返回值。
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
    dlg.addEventListener('cancel', () => settle(null));
    dlg.addEventListener('close', () => settle(null));

    const h = document.createElement('h3');
    h.textContent = title;
    body.appendChild(h);

    let input = null; let input2 = null;
    if (type === 'prompt') {
      if (text) { const p = document.createElement('p'); p.className = 'modal-text'; p.textContent = text; body.appendChild(p); }
      input = document.createElement('input');
      input.className = 'modal-input';
      input.value = value;
      if (password) input.type = 'password';
      if (label) input.placeholder = label;
      body.appendChild(input);
    } else if (type === 'confirm') {
      const p = document.createElement('p');
      p.className = 'modal-text';
      p.textContent = text;
      body.appendChild(p);
    } else if (type === 'conflict') {
      const p = document.createElement('p');
      p.className = 'modal-text';
      p.textContent = text;
      body.appendChild(p);
    }

    if (type === 'custom' && build) build(body); // 调用方自建内容区(回收站列表 / 生成器)

    const row = document.createElement('div');
    row.className = 'modal-btns';

    /** 造一个按钮。val 传 undefined = 不自动 resolve,由调用方自己接管点击。 */
    const mkBtn = (labelText, cls, val) => {
      const b = document.createElement('button');
      b.className = cls;
      b.textContent = labelText;
      if (val !== undefined) b.addEventListener('click', () => { dlg.close(); settle(val); });
      row.appendChild(b);
      return b;
    };

    if (type === 'prompt') {
      // ⚠️ 必须由**这个**监听器给出 input.value,不能靠外面再补一个覆盖。
      // 曾经的写法是 mkBtn('确定', ..., null) + 再 addEventListener 覆盖 —— 但
      // mkBtn 内部那个 resolve(null) 先注册就先落地(Promise 只认第一次 resolve),
      // 于是「确定」点了等于没点:新建分类 / 重命名分类 / 修改主密码全部静默失效,
      // 只有按回车能用。离线单测测的是 Library 层,碰不到弹窗这一层。
      // 现在由 tests/dialog.test.mjs 钉住「点确定必须返回输入框的值」。
      const ok = mkBtn('确定', 'btn primary');
      ok.addEventListener('click', () => { dlg.close(); settle(input.value); });
      mkBtn('取消', 'btn ghost', null).addEventListener('click', () => settle(null));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { dlg.close(); settle(input.value); } });
    } else if (type === 'confirm') {
      mkBtn(danger ? '删除' : '确定', danger ? 'btn danger' : 'btn primary', true);
      mkBtn('取消', 'btn ghost', false);
    } else if (type === 'conflict') {
      mkBtn('用我的版本覆盖', 'btn danger', 'mine');
      mkBtn('以磁盘版本为准', 'btn primary', 'disk');
      mkBtn('取消', 'btn ghost', 'cancel');
    } else if (type === 'custom') {
      mkBtn('关闭', 'btn ghost', null);
    }

    body.appendChild(row);
    dlg.showModal();
    if (input) { input.focus(); input.select(); }
  });
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  scheduleClipboardWipe();
  if (btn) {
    const old = btn.textContent;
    btn.textContent = '已复制';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = old; btn.classList.remove('copied'); }, 1500);
  }
}

/** 编辑器选区包裹:已包裹则剥掉(再点一次 = 取消)。导出仅为可测(tests/edtools.test.mjs) */
export function wrapSel(ta, mark) {
  const s = ta.selectionStart;
  const e = ta.selectionEnd;
  const v = ta.value;
  const sel = v.slice(s, e);
  if (v.slice(s - mark.length, s) === mark && v.slice(e, e + mark.length) === mark) {
    ta.value = v.slice(0, s - mark.length) + sel + v.slice(e + mark.length);
    ta.setSelectionRange(s - mark.length, e - mark.length);
    return;
  }
  ta.value = v.slice(0, s) + mark + sel + mark + v.slice(e);
  ta.setSelectionRange(s + mark.length, e + mark.length);
}

/** 编辑器行前缀(# / - ):作用于选区触及的整行;全部已带前缀则剥掉。导出仅为可测 */
export function prefixLines(ta, prefix) {
  const v = ta.value;
  const s = ta.selectionStart;
  const e = ta.selectionEnd;
  const ls = v.lastIndexOf('\n', s - 1) + 1;
  const nl = v.indexOf('\n', e);
  const le = nl === -1 ? v.length : nl;
  const lines = v.slice(ls, le).split('\n');
  const all = lines.every((l) => l.startsWith(prefix));
  // 开关语义:全带 → 全剥;否则只给缺前缀的行补(已带的行二次补会变成嵌套列表)
  const out = lines.map((l) => (all ? l.slice(prefix.length) : (l.startsWith(prefix) ? l : prefix + l))).join('\n');
  ta.value = v.slice(0, ls) + out + v.slice(le);
  ta.setSelectionRange(ls, ls + out.length);
}

/* ================= 保存状态 ================= */

function setStatus(text, kind = 'ok') {
  const el = $('saveStatus');
  el.textContent = text;
  el.dataset.kind = kind;
}

function refreshSaveStatus() {
  clearTimeout(S.statusTimer);
  S.statusTimer = setTimeout(() => {
    if (S.dirty.size > 0) setStatus('有未保存更改', 'dirty');
    else setStatus('已保存', 'ok');
  }, SAVE_DEBOUNCE_MS);
}

/* ================= 保存流水线 ================= */

function markDirty(catName) {
  S.dirty.add(catName);
  refreshSaveStatus();
  clearTimeout(S.autoSaveTimer);
  S.autoSaveTimer = setTimeout(() => { saveAll(); }, AUTOSAVE_MS);
}

async function saveAll() {
  if (!S.lib || S.saving || S.dirty.size === 0) return;
  S.saving = true;
  setStatus('保存中…', 'busy');
  const names = [...S.dirty];
  let failed = 0;
  for (const name of names) {
    try {
      const res = await S.lib.saveCategory(name);
      if (res.conflict) {
        S.dirty.delete(name);
        await handleConflict(name);
      } else {
        S.dirty.delete(name);
        // 通知其他标签页:这个分类的云端版本变了,它们手里的是旧数据
        S.tabs?.send({ type: 'cat-saved', name });
      }
    } catch (e) {
      failed += 1;
      console.error('保存失败', name, e);
    }
  }
  S.saving = false;
  if (failed > 0) { setStatus(`保存失败 ×${failed}`, 'error'); toast(`${failed} 个分类保存失败,详见控制台`, 'error'); }
  else refreshSaveStatus();
}

async function handleConflict(name) {
  const choice = await modal({
    type: 'conflict',
    title: `「${name}」在云端已被其他设备修改`,
    text: '旧版本已自动保留在服务器备份里,不会丢失。选「以云端版本为准」将放弃本地未保存的改动。',
  });
  const cat = S.lib.categoryInfo(name);
  if (choice === 'mine') {
    try {
      await S.lib.saveCategory(name, { force: true });
      S.tabs?.send({ type: 'cat-saved', name });
      toast(`「${name}」已用本地版本覆盖(云端旧版已备份)`);
    } catch (e) {
      // 覆盖失败必须把该分类放回待保存队列:saveAll 在弹冲突前已把它移出,
      // 这里若吞掉,改动会永久脱离保存队列、锁定/刷新后无提示丢失
      S.dirty.add(name);
      toast(`「${name}」覆盖保存失败:${e.message};已保留在待保存列表`, 'error');
    }
  } else if (choice === 'disk') {
    // 丢弃内存改动,重读云端
    cat.data = null; cat.lastSeenEtag = null; cat.error = null;
    if (S.activeCat === name) {
      await openCategory(name);
    }
    toast(`「${name}」已改为云端版本,本地未保存的改动已放弃`, 'warn');
  } else {
    S.dirty.add(name); // 留待稍后
  }
  refreshSaveStatus();
}

/* ================= 多标签页同步 ================= */

/**
 * 收到别的标签页的通知。
 * ★ 只把消息当作「去重新核对一次」的提示,绝不当权威状态 ——
 *   所以 cats-changed 一律走 rescan()(重新问服务器),不照消息改内存;
 *   这样即便消息是错的(或来自同源的恶意页面),最坏也只是多拉一次数据。
 */
function onTabMessage(msg) {
  // 退出登录是共享的(localStorage 会话),别的标签页锁了,这里也得锁
  if (msg.type === 'locked') { lockNow({ broadcast: false, confirmDiscard: false }); return; }
  if (!S.lib) return;

  if (msg.type === 'cats-changed') { rescanFromTabs(); return; }

  if (msg.type === 'cat-saved') {
    const action = planSavedCategoryAction({
      isKnown: !!S.lib.categoryInfo(msg.name),
      isDirty: S.dirty.has(msg.name),
    });
    if (action === 'ignore') return;
    if (action === 'warn-dirty') {
      // 本地有未保存的改动 → 绝不自动刷新(会把它丢掉),只提前说明会冲突
      toast(`「${msg.name}」已在另一个标签页保存;你这里的改动在保存时会提示冲突`, 'warn');
      return;
    }
    const cat = S.lib.categoryInfo(msg.name);
    cat.data = null; cat.lastSeenEtag = null; cat.error = null;
    if (S.activeCat === msg.name) openCategory(msg.name);
    toast(`「${msg.name}」已在另一个标签页更新,已载入最新版本`);
  }
}

/** 别的标签页增删/改名了分类 → 重新问服务器 */
async function rescanFromTabs() {
  try {
    await S.lib.rescan();
  } catch {
    return; // 网络问题:不打扰用户,下次操作自然会重试
  }
  renderCategoryList();
  if (S.activeCat && !S.lib.categoryInfo(S.activeCat)) {
    // 本标签页正开着的分类,在别处被删了
    S.activeCat = null; S.activeNoteId = null; S.editing = false;
    $('activeCatName').textContent = '未选择分类';
    renderNoteList();
    showEmpty('该分类已在另一个标签页被删除');
  }
}

/* ================= 锁屏 ================= */

/** 恢复会话失败时要在锁屏上说明的原因,由 showLock 消费一次后清空 */
let pendingLockMsg = null;

function showLock(mode) {
  $('app').hidden = true;
  $('lock').hidden = false;
  $('lockErr').hidden = true;
  if (pendingLockMsg) {
    $('lockErr').textContent = pendingLockMsg;
    $('lockErr').hidden = false;
    pendingLockMsg = null;
  }
  $('lockForm').hidden = false;
  $('rememberDevice').checked = S.settings.rememberDevice !== false;
  const isSetup = mode === 'setup';
  $('pwConfirmField').hidden = !isSetup;
  $('pwBtn').textContent = isSetup ? '创建笔记库' : '解锁';
  const hint = $('pwHint');
  hint.hidden = !isSetup;
  hint.textContent = '';
  hint.className = 'pw-hint';
  if (isSetup) {
    $('pwInput').placeholder = '设定主密码';
    $('pwInput').value = '';
    $('pwConfirm').value = '';
  } else {
    $('pwInput').placeholder = '主密码';
    $('pwInput').value = '';
  }
  $('pwInput').focus();
  S.lockMode = mode;
}

/**
 * 锁定 = 退出登录。
 * @param {{broadcast?:boolean, confirmDiscard?:boolean}} [opt]
 *   broadcast:false      = 收到别的标签页的「锁定」通知,不再回声;
 *   confirmDiscard:false = 远端锁定(另一端已结束会话),不弹确认直接锁。
 */
async function lockNow({ broadcast = true, confirmDiscard = true } = {}) {
  if (S.dirty.size > 0) {
    try { await saveAll(); } catch { /* 尽力保存 */ }
  }
  // ★ 锁定必毁全部明文,这是安全不变量;但「毁改动」必须经用户确认 ——
  //   冲突弹窗里刚选过「留待稍后」的分类,转身就在这里被静默清空,等于承诺作废。
  //   保存/冲突处理完仍有未保存改动时,让人在「放弃改动并锁定」与「暂不锁定」
  //   之间二选一。远端锁定不问:另一标签页已把会话结束掉,没有可商量的余地。
  if (confirmDiscard && S.dirty.size > 0) {
    const yes = await modal({
      type: 'confirm', danger: true,
      title: '还有未保存的改动',
      text: `${S.dirty.size} 个分类的改动尚未保存成功,锁定将放弃这些改动(服务器上的版本不受影响)。确定锁定吗?`,
    });
    if (!yes) return;
  }
  // 先通知再清:锁定会清掉共享的 localStorage 会话,不通知的话
  // 另一个标签页还开着就等于「锁定」没生效(它的内存里还留着令牌与明文)
  if (broadcast) S.tabs?.send({ type: 'locked' });
  if (S.lib) { S.lib.destroy(); S.lib = null; }
  API.clearToken();
  // 锁定 = 忘掉本机记住的会话(真正的「退出登录」)。不清的话「锁定」形同虚设:
  // 刷新一下又自动进去了。想再次免密,解锁时勾着「记住本设备」即可。
  clearSession();
  S.activeCat = null; S.activeNoteId = null; S.editing = false;
  S.dirty.clear();
  for (const url of S.objectUrls.values()) URL.revokeObjectURL(url);
  S.objectUrls.clear();
  stopIdleTimer();
  showLock(S.vaultJson ? 'unlock' : 'setup');
}

/* ================= 「记住本设备」 ================= */

/**
 * 解锁/建库成功后,按用户意愿把会话落盘(勾选了才存)。
 * 与 lockNow 里的 clearSession 是一对:存 → 免密进入,清 → 需要重新输主密码。
 */
function rememberNow(dek, authKeyHex) {
  if (!S.settings.rememberDevice) return;
  if (!saveSession({ dek, authKeyHex })) {
    // 隐私模式 / 存储被禁:降级为「不记住」。必须说一声 ——
    // 否则用户以为已经记住了,下次打开发现还要输密码,会以为程序坏了。
    toast('本浏览器不允许保存登录状态,下次打开仍需输入主密码', 'warn');
  }
}

/* ================= 解锁 / 建库 ================= */

/** vault.json 备份:浏览器下载一份到本地(建库后 / 改密码后自动触发) */
function downloadVaultBackup(json) {
  const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'vault.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function doUnlock(password) {
  const err = $('lockErr');
  err.hidden = true;
  try {
    const res = await V.unlockVault(S.vaultJson, password);
    if (!res.ok) {
      err.textContent = res.reason === 'password' ? '主密码错误' : 'vault.json 已损坏,请从备份恢复';
      err.hidden = false;
      return;
    }
    const keys = await V.deriveAllKeys(res.dek);
    API.setToken(res.authKeyHex);
    S.lib = new Library(keys, S.vaultJson, res.dek, S.vaultEtag);
    await S.lib.rescan();
    if (res.weakKdf) toast('注意:本库的密钥派生迭代次数低于当前建议值', 'warn');
    rememberNow(res.dek, res.authKeyHex);
    await enterApp();
  } catch (e) {
    err.textContent = `打开失败:${e.message}`;
    err.hidden = false;
  }
}

async function doCreateLibrary(password, password2) {
  const err = $('lockErr');
  err.hidden = true;
  const policy = F.assessPassword(password);
  if (!policy.ok) { err.textContent = policy.msg; err.hidden = false; return; }
  if (password !== password2) { err.textContent = '两次输入的密码不一致'; err.hidden = false; return; }
  try {
    const { json, dek, authKeyHex } = await V.createVault(password);
    const { status, etag } = await API.createVaultJson(JSON.stringify(json, null, 2));
    if (status === 409) {
      err.textContent = '服务器上已存在笔记库,请直接解锁';
      err.hidden = false;
      S.vaultJson = null; // 重新走 boot 拉取
      S.lockMode = 'unlock';
      $('pwConfirmField').hidden = true;
      $('pwBtn').textContent = '解锁';
      $('pwInput').value = '';
      $('pwInput').focus();
      return;
    }
    const keys = await V.deriveAllKeys(dek);
    API.setToken(authKeyHex);
    S.lib = new Library(keys, json, dek, etag);
    S.vaultJson = json;
    await S.lib.rescan();
    rememberNow(dek, authKeyHex);
    downloadVaultBackup(json);
    toast('笔记库已创建。vault.json 备份已开始下载,请妥善保存(全库钥匙的唯一载体)');
    await enterApp();
  } catch (e) {
    err.textContent = `创建失败:${e.message}`;
    err.hidden = false;
  }
}

/* ================= 进入应用 ================= */

async function enterApp() {
  $('lock').hidden = true;
  $('app').hidden = false;
  $('searchBox').value = '';
  $('searchPanel').hidden = true;
  renderCategoryList();
  S.activeCat = null;
  S.activeNoteId = null;
  S.editing = false;
  renderNoteList();
  const hasCats = S.lib.listCategories().length > 0;
  showEmpty(hasCats ? '从左侧选择一个分类' : '还没有分类,先建一个',
    hasCats ? null : { label: '＋ 新建分类', fn: addCategory });
  refreshSaveStatus();
  startIdleTimer();
  refreshExportDue();
}

/**
 * 空状态文案 + 可选引导按钮:没有分类/笔记时直接把下一步递到用户手上,
 * 而不是只留一句让人自己找入口的提示。
 */
function showEmpty(text, action) {
  const box = $('emptyState');
  box.hidden = false;
  $('readView').hidden = true;
  $('editView').hidden = true;
  box.textContent = '';
  const p = document.createElement('p');
  p.textContent = text;
  box.appendChild(p);
  if (action) {
    const b = document.createElement('button');
    b.className = 'btn primary';
    b.textContent = action.label;
    b.addEventListener('click', action.fn);
    box.appendChild(b);
  }
}

/* ================= 左侧:分类 ================= */

/** 列表项统一可点:键盘可达(Tab 聚焦 + Enter/空格触发),而非只认鼠标 click */
function clickable(el, fn) {
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.addEventListener('click', fn);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(e); }
  });
}

function renderCategoryList() {
  const ul = $('catList');
  ul.textContent = '';
  const names = S.lib.listCategories(); // 只调一次:原来循环内外各查一遍
  for (const name of names) {
    const info = S.lib.categoryInfo(name);
    const li = document.createElement('li');
    li.className = 'cat-item' + (name === S.activeCat ? ' active' : '');
    if (info?.conflict) li.classList.add('warn');
    if (info?.error) li.classList.add('broken');

    const label = document.createElement('span');
    label.className = 'cat-name';
    label.textContent = name + (info?.conflict ? ' ⚠' : '') + (info?.error ? ' ⛔' : '');
    label.title = info?.conflict ? '疑似同步冲突副本,请核对内容后处理'
      : info?.error ? `无法解密:${info.error}` : name;
    li.appendChild(label);
    clickable(li, () => openCategory(name));
    ul.appendChild(li);
  }
  if (!names.length) {
    const li = document.createElement('li');
    li.className = 'cat-item none';
    li.textContent = '暂无分类,点上方 + 新建';
    ul.appendChild(li);
  }
}

let catOpenSeq = 0; // 打开分类的序号守卫:慢请求后到不得覆盖用户后选的分类

async function openCategory(name) {
  const seq = ++catOpenSeq;
  try {
    await S.lib.loadCategory(name);
  } catch (e) {
    if (seq !== catOpenSeq) return; // 期间用户已换分类,这个失败不必再弹
    toast(`分类「${name}」无法打开:${e.message}`, 'error');
    renderCategoryList();
    return;
  }
  if (seq !== catOpenSeq) return; // 慢的分类请求后到:放弃,别覆盖用户新选的分类
  if (S.editing) S.editing = false;
  S.activeCat = name;
  S.activeNoteId = null;
  $('activeCatName').textContent = name;
  renderCategoryList();
  renderNoteList();
  closeDrawer(); // 移动端:选完分类收起抽屉,把屏幕还给内容
  showEmpty(`「${name}」暂无笔记`, { label: '＋ 新建笔记', fn: addNote });
}

async function addCategory() {
  const name = await modal({ type: 'prompt', title: '新建分类', label: '分类名,如:秘钥 / 攻略' });
  if (name == null) return;
  try {
    const created = await S.lib.createCategory(name);
    S.tabs?.send({ type: 'cats-changed' });
    await openCategory(created);
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function renameCategory() {
  if (!S.activeCat) return;
  const name = await modal({ type: 'prompt', title: '重命名分类', value: S.activeCat, text: '改名只换文件名,笔记内容零改动、零重加密传输' });
  if (name == null || name === S.activeCat) return;
  try {
    const created = await S.lib.renameCategory(S.activeCat, name);
    // 未保存的改动跟着搬到新名字:重命名只是换键名,本地这份改过的数据
    // 仍是最新内容;脏标记留在旧名上等于让它脱离保存队列(静默丢失)
    if (S.dirty.delete(S.activeCat)) S.dirty.add(created);
    S.tabs?.send({ type: 'cats-changed' });
    S.activeCat = created;
    renderCategoryList();
    renderNoteList();
    $('activeCatName').textContent = created;
    toast(`已重命名为「${created}」`);
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function deleteCategory() {
  if (!S.activeCat) {
    toast('先选择一个要删除的分类', 'warn');
    return;
  }
  const yes = await modal({
    type: 'confirm', danger: true,
    title: `删除分类「${S.activeCat}」`,
    text: '分类文件将从服务器删除,删除前会自动备份(每分类保留最近 10 份)。引用的图片不会自动删,可稍后手动「清理未引用图片」。',
  });
  if (!yes) return;
  try {
    await S.lib.deleteCategory(S.activeCat);
    S.dirty.delete(S.activeCat);
    S.tabs?.send({ type: 'cats-changed' });
    S.activeCat = null; S.activeNoteId = null;
    renderCategoryList();
    renderNoteList();
    $('activeCatName').textContent = '未选择分类';
    showEmpty('从左侧选择一个分类');
    toast('分类已删除(旧版本已自动备份到服务器)');
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* ================= 左侧:笔记列表 ================= */

function activeNoteData() {
  if (!S.activeCat) return null;
  const cat = S.lib.categoryInfo(S.activeCat);
  if (!cat?.data) return null;
  return cat.data.notes.find((n) => n.id === S.activeNoteId) || null;
}

function renderNoteList() {
  const ul = $('noteList');
  ul.textContent = '';
  const cat = S.activeCat && S.lib.categoryInfo(S.activeCat);
  if (!cat?.data) { $('activeCatName').textContent = S.activeCat || '未选择分类'; return; }

  const notes = F.sortNotes(cat.data.notes);
  // 侧栏标题带上篇数:规模一眼可见,不用点进去数
  $('activeCatName').textContent = `${S.activeCat} · ${notes.length} 篇`;
  for (const note of notes) {
    const li = document.createElement('li');
    li.className = 'note-item' + (note.id === S.activeNoteId ? ' active' : '');

    const main = document.createElement('div');
    main.className = 'note-main';

    const title = document.createElement('div');
    title.className = 'note-title';
    title.textContent = note.title || '无标题';
    main.appendChild(title);

    const row = document.createElement('div');
    row.className = 'note-preview-row';
    const preview = document.createElement('div');
    preview.className = 'note-preview';
    preview.textContent = note.content.trim().replace(/\s+/g, ' ').slice(0, 40) || '(空)';
    row.appendChild(preview);
    const time = document.createElement('span');
    time.className = 'note-time';
    time.textContent = F.relTime(note.updatedAt);
    time.title = `更新于 ${fmtTime(note.updatedAt)}`;
    row.appendChild(time);
    main.appendChild(row);
    li.appendChild(main);

    const btns = document.createElement('div');
    btns.className = 'note-btns';
    const upBtn = document.createElement('button');
    upBtn.className = 'icon-btn';
    upBtn.title = '上移';
    upBtn.textContent = '↑';
    upBtn.addEventListener('click', (e) => { e.stopPropagation(); moveNote(note.id, -1); });
    const downBtn = document.createElement('button');
    downBtn.className = 'icon-btn';
    downBtn.title = '下移';
    downBtn.textContent = '↓';
    downBtn.addEventListener('click', (e) => { e.stopPropagation(); moveNote(note.id, 1); });
    const copyBtn = document.createElement('button');
    copyBtn.className = 'icon-btn';
    copyBtn.title = '复制全文';
    copyBtn.textContent = '⧉';
    copyBtn.addEventListener('click', (e) => { e.stopPropagation(); copyText(note.content, copyBtn); });
    btns.append(upBtn, downBtn, copyBtn);
    li.appendChild(btns);

    clickable(li, () => openNote(note.id));
    ul.appendChild(li);
  }
  if (!notes.length) {
    const li = document.createElement('li');
    li.className = 'note-item none';
    li.textContent = '暂无笔记';
    ul.appendChild(li);
  }
}

function openNote(noteId) {
  closeDrawer(); // 移动端:选完笔记收起抽屉
  if (S.editing) S.editing = false;
  S.activeNoteId = noteId;
  renderNoteList();
  renderReadView();
}

/* ================= 阅读视图 ================= */

function renderReadView() {
  const note = activeNoteData();
  if (!note) { showEmpty('从左侧选择一条笔记'); return; }
  $('emptyState').hidden = true;
  $('editView').hidden = true;
  const view = $('readView');
  view.hidden = false;

  $('readTitle').textContent = note.title || '无标题';
  $('readMeta').textContent = `更新于 ${fmtTime(note.updatedAt)}${note.attachments.length ? ` · ${note.attachments.length} 个附件` : ''}`;

  const body = $('readBody');
  body.textContent = '';
  const md = renderMarkdown(note.content);
  for (const blk of md.querySelectorAll('.blk')) {
    const btn = document.createElement('button');
    btn.className = 'blk-copy';
    btn.textContent = '⧉';
    btn.title = '复制本段';
    btn.addEventListener('click', () => copyText(blk.dataset.copy || blk.textContent, btn));
    blk.appendChild(btn);
  }
  body.appendChild(md);
  if (!note.content.trim()) {
    const hint = document.createElement('p');
    hint.className = 'read-empty';
    hint.textContent = '(空笔记,点「编辑」写点东西)';
    body.appendChild(hint);
  }

  renderReadAttachments(note);
}

function renderReadAttachments(note) {
  const box = $('readAtts');
  box.textContent = '';
  if (!note.attachments.length) return;
  const head = document.createElement('div');
  head.className = 'atts-head';
  head.textContent = '附件';
  box.appendChild(head);
  for (const att of note.attachments) {
    const chip = document.createElement('button');
    chip.className = 'att-chip';
    chip.textContent = `🖼 ${att.name}`;
    chip.title = '点击解密并显示';
    chip.addEventListener('click', () => toggleAttachmentImage(att, chip));
    box.appendChild(chip);
  }
}

const attLoading = new Set(); // 解密中的附件:防双击竞态重复贴图

async function toggleAttachmentImage(att, chip) {
  const existing = S.objectUrls.get(att.file);
  const next = chip.nextElementSibling;
  if (next && next.classList.contains('att-img')) { next.remove(); return; }
  if (attLoading.has(att.file)) return;
  attLoading.add(att.file);
  try {
    let url = existing;
    if (!url) {
      const bytes = await S.lib.readAttachment(att.file);
      url = URL.createObjectURL(new Blob([bytes], { type: guessMime(att.name) }));
      S.objectUrls.set(att.file, url);
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
    toast(`附件解密失败:${e.message}`, 'error');
  } finally {
    attLoading.delete(att.file);
  }
}

function guessMime(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp' }[ext] || 'application/octet-stream';
}

async function copyWholeNote() {
  const note = activeNoteData();
  if (!note) return;
  copyText(`${note.title}\n\n${note.content}`, $('btnCopyAll'));
}

/* ================= 编辑视图 ================= */

function enterEditMode() {
  const note = activeNoteData();
  if (!note) return;
  S.editing = true;
  $('readView').hidden = true;
  $('emptyState').hidden = true;
  $('editView').hidden = false;
  $('editTitle').value = note.title;
  $('editBody').value = note.content;
  renderEditAttachments(note);
  $('editTitle').focus();
}

function collectEditChanges() {
  const note = activeNoteData();
  if (!note) return;
  const title = $('editTitle').value.trim() || '无标题';
  const content = $('editBody').value;
  if (title !== note.title || content !== note.content) {
    note.title = title;
    note.content = content;
    note.updatedAt = Date.now();
    markDirty(S.activeCat);
  }
  renderEditAttachments(note);
}

function exitEditMode() {
  collectEditChanges();
  S.editing = false;
  renderReadView();
  renderNoteList();
}

function renderEditAttachments(note) {
  const box = $('editAtts');
  box.textContent = '';
  if (!note.attachments.length) return;
  for (const [i, att] of note.attachments.entries()) {
    const chip = document.createElement('span');
    chip.className = 'att-chip editable';
    chip.textContent = `🖼 ${att.name}`;
    const del = document.createElement('button');
    del.className = 'att-del';
    del.textContent = '×';
    del.title = '从本笔记移除(图片文件保留,可稍后清理)';
    del.addEventListener('click', () => {
      note.attachments.splice(i, 1);
      note.updatedAt = Date.now();
      markDirty(S.activeCat);
      renderEditAttachments(note);
    });
    chip.appendChild(del);
    box.appendChild(chip);
  }
}

async function addAttachments(files) {
  const cat = S.lib.categoryInfo(S.activeCat);
  const note = activeNoteData();
  if (!cat || !note) return;
  const added = [];
  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { file: blobName } = await S.lib.addAttachment(bytes, file.name);
      const entry = { file: blobName, name: file.name };
      added.push(entry);
      note.attachments.push(entry);
    } catch (e) {
      toast(`「${file.name}」入库失败:${e.message}`, 'error');
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
      markDirty(S.activeCat);
      renderEditAttachments(live);
      return;
    }
  }
  toast('图片已入库,但该分类刚被其他标签页更新;重新打开分类后再查看', 'warn');
}

/* ================= 笔记增删排序 ================= */

let addingNote = false;

async function addNote() {
  if (addingNote) return; // 双击会造出两条「无标题」:忙态守卫
  if (!S.activeCat) { toast('先选择一个分类', 'warn'); return; }
  addingNote = true;
  try {
    const cat = S.lib.categoryInfo(S.activeCat);
    if (!cat) return;
    await S.lib.loadCategory(S.activeCat);
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
    markDirty(S.activeCat);
    openNote(note.id);
    enterEditMode();
  } catch (e) {
    // 分类加载失败以前是无提示的 unhandled rejection
    toast(`无法新建笔记:${e.message}`, 'error');
  } finally {
    addingNote = false;
  }
}

async function deleteNote() {
  const note = activeNoteData();
  if (!note) return;
  const yes = await modal({ type: 'confirm', danger: true, title: '删除笔记', text: `「${note.title || '无标题'}」将被删除(保存后生效,云端旧版有自动备份)。` });
  if (!yes) return;
  const cat = S.lib.categoryInfo(S.activeCat);
  // 延期删除:先进本分类密文内的回收站,30 天内可恢复;真正清除由
  // normalizeNoteData 在读取时按 deletedAt 过期裁剪,与多端自然同步
  cat.data.trash = cat.data.trash || [];
  cat.data.trash.push({ ...note, deletedAt: Date.now() });
  cat.data.notes = cat.data.notes.filter((n) => n.id !== note.id);
  markDirty(S.activeCat);
  S.activeNoteId = null;
  S.editing = false;
  renderNoteList();
  showEmpty('笔记已移入「最近删除」,30 天内可恢复(保存后生效)');
}

function moveNote(noteId, dir) {
  const cat = S.lib.categoryInfo(S.activeCat);
  const sorted = F.sortNotes(cat.data.notes);
  const idx = sorted.findIndex((n) => n.id === noteId);
  if (idx < 0) return;
  const target = dir < 0 ? idx - 1 : idx + 1;
  if (target < 0 || target >= sorted.length) return;
  // 上移:新位置夹在 sorted[idx-2] 与 sorted[idx-1] 之间;下移对称
  const prevOrder = dir < 0 ? (sorted[idx - 2] ? sorted[idx - 2].order : null) : sorted[idx + 1].order;
  const nextOrder = dir < 0 ? sorted[idx - 1].order : (sorted[idx + 2] ? sorted[idx + 2].order : null);
  sorted[idx].order = F.orderBetween(prevOrder, nextOrder);
  markDirty(S.activeCat);
  renderNoteList();
}

/* ================= 搜索 ================= */

let searchSeq = 0; // 搜索序号守卫:慢查询后到不得覆盖新查询的结果

async function runSearch() {
  const q = $('searchBox').value.trim();
  const panel = $('searchPanel');
  if (!q) { panel.hidden = true; panel.textContent = ''; return; }
  if (!S.lib) return;
  const seq = ++searchSeq;
  await S.lib.loadAllCategories();
  if (seq !== searchSeq) return; // 期间用户又输入了:这轮结果作废
  const notesByCat = new Map();
  for (const name of S.lib.listCategories()) {
    const cat = S.lib.categoryInfo(name);
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
    clickable(li, () => {
      S.activeCat = r.cat;
      openNote(r.note.id);
      renderCategoryList();
      $('activeCatName').textContent = r.cat;
      panel.hidden = true;
      $('searchBox').value = '';
    });
    ul.appendChild(li);
  }
  panel.appendChild(ul);
  panel.hidden = false;
}

/* ================= 自动锁屏 ================= */

const IDLE_EVENTS = ['pointerdown', 'keydown', 'wheel'];

function resetIdleTimer() {
  if (S.settings.autoLockMinutes <= 0 || !S.lib) return;
  clearTimeout(S.idleTimer);
  S.idleTimer = setTimeout(() => { lockNow(); toast('已自动锁屏', 'warn'); }, S.settings.autoLockMinutes * 60 * 1000);
}
function startIdleTimer() {
  stopIdleTimer();
  for (const ev of IDLE_EVENTS) document.addEventListener(ev, resetIdleTimer, { passive: true });
  resetIdleTimer();
}
function stopIdleTimer() {
  clearTimeout(S.idleTimer);
  for (const ev of IDLE_EVENTS) document.removeEventListener(ev, resetIdleTimer);
}

/* ================= 最近删除 / 密码生成器 / 导出 .md ================= */

/** 剪贴板自动清除:密码本里复制的内容多半是敏感值,60 秒后自动清空 ——
 * 不给「复制完忘了、剪贴板被任意应用读走」留口子。
 * 清空要求页面保持前台,失败(失焦等)即放弃,不打扰。 */
let clipWipeTimer = null;
function scheduleClipboardWipe(seconds = 60) {
  clearTimeout(clipWipeTimer);
  toast(`已复制,${seconds} 秒后自动清空剪贴板`);
  clipWipeTimer = setTimeout(async () => {
    try { await navigator.clipboard.writeText(' '); } catch { /* 失焦等场景清不掉,放弃 */ }
  }, seconds * 1000);
}

/** 导出备份到期提醒:30 天没导出(或从未导出)就给「导出」图标挂小红点 */
function refreshExportDue() {
  const last = Number(S.settings.lastExportAt) || 0;
  const due = S.lib.listCategories().length > 0
    && (!last || Date.now() - last > 30 * 86400000);
  $('btnExport').classList.toggle('due', due);
  if (due && !last) toast('还没导出过全库备份,建议先导出一份(左下角下载图标)', 'warn');
}

/** 最近删除:回收站存在各分类密文内部的 trash 数组里,
 * 与笔记同一条加密 / CAS / 备份流水线,不新增任何服务端键 */
async function openTrash() {
  if (!S.lib) return;
  await S.lib.loadAllCategories().catch(() => {}); // 没解密过的分类补齐(个人库量小)
  const entries = [];
  for (const [name, cat] of S.lib.categories) {
    for (const t of cat.data?.trash || []) entries.push({ catName: name, note: t });
  }
  entries.sort((a, b) => b.note.deletedAt - a.note.deletedAt);

  await modal({
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
        restore.addEventListener('click', () => restoreFromTrash(catName, note, row));
        const purge = document.createElement('button');
        purge.className = 'btn small ghost danger';
        purge.textContent = '彻底删除';
        purge.addEventListener('click', () => purgeFromTrash(catName, note, row));
        ops.append(restore, purge);
        row.append(info, ops);
        body.appendChild(row);
      }
    },
  });
}

function restoreFromTrash(catName, note, row) {
  const cat = S.lib.categoryInfo(catName);
  if (!cat?.data) { toast('原分类已不可读,无法恢复', 'error'); return; }
  cat.data.trash = (cat.data.trash || []).filter((t) => t.id !== note.id);
  delete note.deletedAt;
  const maxOrder = cat.data.notes.reduce((m, n) => Math.max(m, n.order), 0);
  note.order = F.orderBetween(maxOrder, null); // 排到分类末尾
  cat.data.notes.push(note);
  markDirty(catName);
  row.remove();
  if (S.activeCat === catName) renderNoteList();
  toast(`已恢复到「${catName}」`);
}

function purgeFromTrash(catName, note, row) {
  const cat = S.lib.categoryInfo(catName);
  if (!cat?.data) return;
  cat.data.trash = (cat.data.trash || []).filter((t) => t.id !== note.id);
  markDirty(catName);
  row.remove();
  toast('已彻底删除(保存后生效)');
}

/** 单篇导出为 .md 文件(纯正文,不加密 —— 由用户自己决定放哪) */
function exportNoteMd() {
  const note = activeNoteData();
  if (!note) return;
  const name = (note.title || '无标题').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60);
  downloadBytes(new TextEncoder().encode(note.content), `${name}.md`, 'text/markdown');
}

/** 随机密码生成器:Web Crypto + 拒绝采样,生成只在本机内存里进行 */
async function openPwGenerator() {
  await modal({
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
      copy.addEventListener('click', () => copyText(out.value, copy));

      body.append(opts, out, ops);
      gen();
    },
  });
}

/* ================= 设置 ================= */

function loadSettings() {
  try {
    const raw = localStorage.getItem('jmbiji.settings');
    if (raw) S.settings = { ...S.settings, ...JSON.parse(raw) };
  } catch { /* 忽略 */ }
  $('autoLock').value = String(S.settings.autoLockMinutes);
  $('rememberDevice').checked = S.settings.rememberDevice !== false;
}
function saveSettings() {
  S.settings.autoLockMinutes = Number($('autoLock').value) || 0;
  try { localStorage.setItem('jmbiji.settings', JSON.stringify(S.settings)); } catch { /* 忽略 */ }
  startIdleTimer();
}

/** 勾选/取消「记住本设备」。取消时立刻把已存的会话删掉,不给「取消了其实还留着」留余地。 */
function saveRememberPref() {
  S.settings.rememberDevice = $('rememberDevice').checked;
  try { localStorage.setItem('jmbiji.settings', JSON.stringify(S.settings)); } catch { /* 忽略 */ }
  if (!S.settings.rememberDevice) clearSession();
}

/* ================= 修改主密码 ================= */

async function changePassword() {
  if (!S.lib) return;
  const pw = await modal({ type: 'prompt', title: '修改主密码', label: `新密码(至少 ${F.PASSWORD_MIN_LEN} 位)`, password: true, text: '只重包数据钥匙,笔记文件一个字节都不会重传。完成后请重新备份 vault.json 到库外。' });
  if (pw == null) return;
  const policy = F.assessPassword(pw);
  if (!policy.ok) { toast(policy.msg, 'error'); return; }
  const pw2 = await modal({ type: 'prompt', title: '再输一遍新密码', password: true });
  if (pw2 == null) return;
  if (pw !== pw2) { toast('两次输入不一致', 'error'); return; }
  try {
    const json = await S.lib.changeMasterPassword(pw);
    // 改密码换了鉴权令牌(DEK 不变)。本机记住的会话必须同步更新,
    // 否则下次打开会拿旧令牌去请求 → 401 → 被迫重输主密码(等于白记了)。
    rememberNow(S.lib.dek, API.getToken());
    downloadVaultBackup(json);
    toast('主密码已修改。新的 vault.json 备份已开始下载,请替换手头旧备份!', 'warn');
  } catch (e) {
    toast(`修改失败:${e.message}`, 'error');
  }
}

/* ================= 全库备份(导出 / 恢复) ================= */

/** 人类可读的体积 */
function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${i === 0 || v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function downloadBytes(bytes, fileName, mime = 'application/zip') {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  // 大包要给足时间让浏览器读走;提前 revoke 会得到一个空文件
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function exportFullBackup() {
  if (!S.lib) return;
  try {
    const { bytes, counts } = await S.lib.exportBackup({
      // 先把真实体积摆出来再决定 —— 个人库也可能上百 MB,手机上有内存压力
      onPlan: (plan) => modal({
        type: 'confirm',
        title: '导出全库',
        text: `${plan.cats} 个分类 · ${plan.blobs} 张图片 · 约 ${fmtBytes(plan.bytes)}\n\n`
          + '包里是 vault.json、全部分类密文与全部附件(全程不解密,仍然是密文)。\n'
          + '⚠️ 拿到这个包的人不受访问密钥门与限流保护,请放在不会外泄的位置。',
      }),
      onProgress: ({ done, total }) => {
        setStatus(total ? `导出中 ${Math.round((done / total) * 100)}%` : '导出中…', 'busy');
      },
    });
    downloadBytes(bytes, F.backupArchiveName());
    S.settings.lastExportAt = Date.now();
    saveSettings();
    $('btnExport').classList.remove('due');
    setStatus('已导出', 'ok');
    toast(`全库备份已下载:${counts.cats} 个分类 / ${counts.blobs} 张图片(约 ${fmtBytes(counts.bytes)})`);
  } catch (e) {
    refreshSaveStatus();
    if (e.code === 'cancelled') return;
    toast(`导出失败:${e.message}`, 'error');
  }
}

async function importFromBackup(file) {
  if (!S.lib) return;
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (e) {
    toast(`读取文件失败:${e.message}`, 'error');
    return;
  }
  const yes = await modal({
    type: 'confirm',
    title: '从备份恢复',
    text: `把「${file.name}」里的内容补进当前库:缺失的分类与图片会被恢复,`
      + '已存在的一律跳过、绝不覆盖。继续?',
  });
  if (!yes) return;

  setStatus('恢复中…', 'busy');
  try {
    const r = await S.lib.importBackup(bytes, ({ i, n }) => {
      setStatus(n ? `恢复中 ${i}/${n}` : '恢复中…', 'busy');
    });
    const parts = [];
    if (r.vaultCreated) parts.push('库钥匙已建立');
    parts.push(`分类 +${r.catsAdded.length}`);
    if (r.catsSkipped.length) parts.push(`跳过已存在 ${r.catsSkipped.length}`);
    parts.push(`图片 +${r.blobsAdded}(去重 ${r.blobsExisted})`);
    if (r.failed.length) parts.push(`失败 ${r.failed.length}`);

    if (r.vaultCreated) {
      // 恢复出来的库,钥匙来自备份包 —— 当前会话的令牌与它对不上,必须重新解锁。
      // 且 S.vaultJson 还是旧的,得让 boot() 重新拉一次,否则解锁会读到「已损坏」。
      S.vaultJson = null;
      S.vaultEtag = null;
      await lockNow({ broadcast: false });
      await boot();
      toast(`恢复完成(${parts.join(', ')})。请用这份备份对应的主密码解锁`, 'warn');
      return;
    }
    await S.lib.rescan();
    renderCategoryList();
    refreshSaveStatus();
    toast(`恢复完成:${parts.join(', ')}`);
  } catch (e) {
    refreshSaveStatus();
    toast(`恢复失败:${e.message}`, 'error');
  }
}

/* ================= 深浅色主题 ================= */

/* 手动选择存 localStorage 并优先于系统;未选择时跟随系统,系统切换实时跟进。
 * 只写 <html data-theme> 一个开关,CSS 侧就只需要一份暗色变量块。 */
const THEME_KEY = 'jmbiji.theme';

function loadThemePref() {
  try { return localStorage.getItem(THEME_KEY); } catch { return null; }
}

function setThemePref(mode) {
  try { localStorage.setItem(THEME_KEY, mode); } catch { /* 隐私模式:仅本次会话生效 */ }
}

function applyTheme(mode) {
  const root = document.documentElement;
  if (root) root.dataset.theme = mode;
  const btn = $('btnTheme');
  if (btn) {
    btn.textContent = mode === 'dark' ? '☀' : '☾';
    btn.title = mode === 'dark' ? '切换为浅色' : '切换为深色';
    btn.setAttribute('aria-label', btn.title);
  }
  const meta = document.querySelector && document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', mode === 'dark' ? '#1e2128' : '#faf8f2');
}

function initTheme() {
  const pref = loadThemePref();
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  applyTheme(pref || (mq && mq.matches ? 'dark' : 'light'));
  if (!pref && mq && mq.addEventListener) {
    mq.addEventListener('change', (e) => {
      if (!loadThemePref()) applyTheme(e.matches ? 'dark' : 'light');
    });
  }
}

/** 移动端抽屉收起。桌面同样无害(没有 open 类,backdrop 本来就 hidden)。 */
function closeDrawer() {
  const sb = $('sidebar');
  if (sb) sb.classList.remove('open');
  const bd = $('sideBackdrop');
  if (bd) bd.hidden = true;
  const menu = $('btnMenu');
  if (menu) menu.setAttribute('aria-expanded', 'false');
}

/* ================= 启动与事件绑定 ================= */

async function boot() {
  loadSettings();
  API.loadAccessKey();
  // 拉取 vault.json:404 = 未建库 → 建库流程;其余错误 → 提示
  for (;;) {
    let res;
    try {
      res = await API.fetchVault();
    } catch (e) {
      if (e.code === 'access-key') {
        const key = await modal({
          type: 'prompt', title: '访问密钥',
          label: `输入部署时设置的 ACCESS_KEY(≥16 字符)`,
          text: '此服务器启用了访问密钥(与主密码是两回事)。密钥只保存在本机浏览器里,换设备/换浏览器需再输一次。',
        });
        if (key != null && key.trim()) { API.saveAccessKey(key.trim()); continue; }
        $('lockErr').textContent = '未提供访问密钥,无法连接笔记库';
        $('lockErr').hidden = false;
        $('lockForm').hidden = true;
        return;
      }
      // 服务端 fail closed(ACCESS_KEY 未配置/过短):原样显示它给的可操作提示
      $('lockErr').textContent = e.code === 'setup-required' ? e.message : `无法连接服务器:${e.message}`;
      $('lockErr').hidden = false;
      $('lockForm').hidden = true;
      return;
    }
    if (res.status === 404) { showLock('setup'); return; }
    S.vaultJson = res.json;
    S.vaultEtag = res.etag;
    // 「记住本设备」:本机有可用会话就直接进,不问主密码(失败会自己回落锁屏)
    if (S.settings.rememberDevice && await resumeSession()) return;
    showLock('unlock');
    return;
  }
}

/**
 * 用本机记住的会话直接进入应用。
 * @returns {boolean} true = 已进入;false = 回落锁屏(不可用的会话已清掉)
 *
 * 两种失败都要清掉会话并说明原因,不能静默:
 *  · 钥匙与库不匹配(桶换过 / vault.json 被别的库覆盖)→ 不清就会「进去了但每个分类都打不开」
 *  · 令牌失效(多半是别的设备改过主密码)→ 不清就会每次打开都失败一次
 */
async function resumeSession() {
  const sess = loadSession();
  if (!sess) return false;
  try {
    if (!(await V.dekMatchesVault(S.vaultJson, sess.dek))) {
      clearSession();
      pendingLockMsg = '本机记住的钥匙与这个库不匹配(可能换过桶或被别的库覆盖),已清除,请重新输入主密码';
      return false;
    }
    API.setToken(sess.authKeyHex);
    const keys = await V.deriveAllKeys(sess.dek);
    S.lib = new Library(keys, S.vaultJson, sess.dek, S.vaultEtag);
    await S.lib.rescan(); // 令牌过期 → 401 在这里抛出来
    await enterApp();
    return true;
  } catch (e) {
    if (S.lib) { S.lib.destroy(); S.lib = null; }
    API.clearToken();
    clearSession();
    pendingLockMsg = e?.status === 401
      ? '登录令牌已失效(可能在其他设备改过主密码),请重新输入主密码'
      : `无法恢复上次的登录状态(${e.message}),请重新输入主密码`;
    return false;
  }
}

function bindEvents() {
  // 建库时实时反馈密码强度(解锁态不提示:那是既有密码,提示也无从改)
  const updatePwHint = () => {
    if (S.lockMode !== 'setup') return;
    const hint = $('pwHint');
    const pw = $('pwInput').value;
    if (!pw) { hint.textContent = ''; hint.className = 'pw-hint'; return; }
    const a = F.assessPassword(pw);
    hint.textContent = a.msg;
    hint.className = `pw-hint ${a.level}`;
  };
  $('pwInput').addEventListener('input', updatePwHint);

  $('pwBtn').addEventListener('click', () => {
    const pw = $('pwInput').value;
    if (S.lockMode === 'setup') doCreateLibrary(pw, $('pwConfirm').value);
    else doUnlock(pw);
  });
  $('pwInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('pwBtn').click(); });
  $('pwConfirm').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('pwBtn').click(); });

  $('btnLock').addEventListener('click', () => lockNow());
  $('btnAddCat').addEventListener('click', addCategory);
  $('btnRenameCat').addEventListener('click', renameCategory);
  $('btnDelCat').addEventListener('click', deleteCategory);
  $('btnAddNote').addEventListener('click', addNote);
  $('btnEdit').addEventListener('click', enterEditMode);
  $('btnDone').addEventListener('click', exitEditMode);
  // 显式保存:先把输入框里的内容收进内存态,再走与 Ctrl+S 同一条上传流水线
  $('btnSaveNow').addEventListener('click', () => {
    collectEditChanges();
    saveAll();
  });
  $('btnCopyAll').addEventListener('click', copyWholeNote);
  $('btnDelNote').addEventListener('click', deleteNote);
  $('btnAddAtt').addEventListener('click', () => $('attInput').click());
  $('attInput').addEventListener('change', (e) => {
    addAttachments([...e.target.files]);
    e.target.value = '';
  });
  $('btnCleanBlobs').addEventListener('click', async () => {
    if (!S.lib) return;
    const yes = await modal({ type: 'confirm', title: '清理未引用图片', text: '将解密全部分类并删除没被任何笔记引用的图片文件。继续?' });
    if (!yes) return;
    try {
      const removed = await S.lib.cleanupOrphanBlobs();
      renderCategoryList(); // 清理前会重新拉一次清单,界面跟着对齐
      toast(removed.length ? `已清理 ${removed.length} 张未引用图片` : '没有需要清理的图片');
    } catch (e) {
      // 清理是 fail closed 的:读不全就一张不删。这条提示必须看得清、看得久,
      // 否则用户会以为「点过了就等于清干净了」。
      toast(`清理已中止:${e.message}`, 'error');
    }
  });
  $('btnExport').addEventListener('click', exportFullBackup);
  $('btnImport').addEventListener('click', () => $('importInput').click());
  $('importInput').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file) importFromBackup(file);
  });

  $('autoLock').addEventListener('change', saveSettings);
  $('rememberDevice').addEventListener('change', saveRememberPref);

  // 深浅色切换:点一次就固定下来(写入偏好,之后不再跟随系统变化)
  $('btnTheme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    setThemePref(next);
    applyTheme(next);
  });

  // 移动端抽屉:汉堡键开,遮罩点击关
  $('btnMenu').addEventListener('click', () => {
    const open = !$('sidebar').classList.contains('open');
    $('sidebar').classList.toggle('open', open);
    $('sideBackdrop').hidden = !open;
    $('btnMenu').setAttribute('aria-expanded', String(open));
  });
  $('sideBackdrop').addEventListener('click', closeDrawer);

  // Markdown 快捷插入:选区包裹 / 行前缀,写完立刻算改动
  for (const b of document.querySelectorAll('#edTools .ed-btn')) {
    b.addEventListener('click', () => {
      if (!S.editing) return;
      const ta = $('editBody');
      if (b.dataset.wrap) wrapSel(ta, b.dataset.wrap);
      else if (b.dataset.prefix) prefixLines(ta, b.dataset.prefix);
      ta.focus();
      collectEditChanges();
    });
  }

  // 编辑器里 Tab 是缩进,不是「把焦点跳走」
  $('editBody').addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    e.target.setRangeText('  ', e.target.selectionStart, e.target.selectionEnd, 'end');
    collectEditChanges();
  });

  // 修改主密码:左下角图标排里的「钥」(HTML 侧定义,这里只绑事件)
  $('btnChangePw').addEventListener('click', changePassword);
  $('btnTrash').addEventListener('click', openTrash);
  $('btnExportMd').addEventListener('click', exportNoteMd);
  // 随机密码生成器(ed-tools 里的 pw 按钮,不走 wrap/prefix 委托)
  document.querySelector('#edTools [data-genpw]')?.addEventListener('click', openPwGenerator);
  // 敏感行:点击显形 / 遮回;显形 30 秒后自动遮回
  $('readBody').addEventListener('click', (e) => {
    const t = e.target.closest('.secret');
    if (!t) return;
    const masked = t.classList.toggle('masked');
    clearTimeout(t._remask);
    if (!masked) t._remask = setTimeout(() => t.classList.add('masked'), 30000);
  });

  $('editTitle').addEventListener('input', () => { collectEditChanges(); });
  $('editBody').addEventListener('input', () => { collectEditChanges(); });

  let searchTimer = null;
  $('searchBox').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 160);
  });
  document.addEventListener('click', (e) => {
    if (!$('searchPanel').hidden && !$('searchPanel').contains(e.target) && e.target !== $('searchBox')) {
      $('searchPanel').hidden = true;
    }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveAll();
    }
    // Ctrl+K 聚焦搜索(比浏览器默认的「搜索 with 引擎」在这里有用得多)
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      $('searchBox').focus();
      $('searchBox').select();
    }
    // Ctrl+Enter = 完成(退出编辑),写完一大段不用伸手去够右下角
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && S.editing) {
      e.preventDefault();
      exitEditMode();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && S.dirty.size > 0) saveAll();
  });

  window.addEventListener('beforeunload', (e) => {
    if (S.dirty.size > 0) { e.preventDefault(); e.returnValue = ''; }
  });
}

export async function start() {
  initTheme(); // 先定深浅色:锁屏第一屏就应该是用户要的样子
  bindEvents();
  // 多标签页同步:BroadcastChannel 不可用时 TabSync 会静默降级(S.tabs.enabled === false),
  // 其余功能一律照常 —— 同步是锦上添花,不是必需品。
  S.tabs = new TabSync({ onMessage: onTabMessage });
  await boot();
}
