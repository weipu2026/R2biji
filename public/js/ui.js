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
// ★ 会话态统一收口到 store:下方 `S` 是指向 store 的代理,读写语法与原先完全一致,
//   但状态已汇聚到单一容器(后续按 feature 拆分时可直接订阅)。见 store.js 顶部说明。
import { store, createProxy } from './store.js';
// ★ 拆出的 feature 模块(每个只依赖 ctx 注入的共享基础设施,不碰本文件私有变量)
import { initTheme, toggleTheme } from './features/theme.js';
import { runSearch, closeSearch } from './features/search.js';
import { scheduleClipboardWipe, refreshExportDue, openTrash, exportNoteMd, openPwGenerator } from './features/data.js';
import {
  showLock, lockNow, doUnlock, doCreateLibrary, resumeSession,
  rememberNow, downloadVaultBackup,
} from './features/lock.js';
import {
  clickable, renderCategoryList, openCategory, addCategory, renameCategory, deleteCategory,
  activeNoteData, renderNoteList, openNote, moveNoteSelection,
} from './features/sidebar.js';
import {
  renderReadView, copyWholeNote, enterEditMode, collectEditChanges, exitEditMode,
  addAttachments, addNote, deleteNote, toggleNotePin, moveNote, bindReadSwipe,
} from './features/note.js';
// shell 只导出 boot 给本文件用(「从备份恢复」后要重跑启动流程);
// 它的入口 start 由 main.js 直接调用,并把手上的 ctx 传进去。
import { boot } from './features/shell.js';

const S = createProxy(store);

const $ = (id) => document.getElementById(id);

const IDLE_SAVE_MS = 4000;               // 改动停止 4 秒后自动保存(输入中每次按键都会重置计时)

/** 单色描边图标:统一用 SVG 而非 emoji/Unicode 字符 ——
 * 彩色 emoji(📌)与 Unicode 装饰符(☰✎⧉)在 Windows/macOS/Android 上字形各异,
 * 且与底栏已有的描边图标体系不是一套质感;这里做单一来源。
 * 颜色一律 currentColor,跟随各处的文字色与主题。 */
const ICON = {
  plus: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="13" height="13" x="9" y="9" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  up: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>',
  down: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>',
  pin: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>',
  moon: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
  sun: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  menu: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/></svg>',
  eye: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
  image: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></svg>',
  warn: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
  blocked: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  key: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/></svg>',
  download: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="3" y2="15"/></svg>',
  upload: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>',
  broom: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg>',
  trash2: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>',
  code: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/></svg>',
  list: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>',
  sparkle: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2 14.4 9.6 22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4Z"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 3 18 18"/><path d="M10.6 10.6a3 3 0 0 0 4.2 4.2"/><path d="M9.9 5.2A10.9 10.9 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2"/><path d="M6.2 6.2A17.6 17.6 0 0 0 2 12s3.5 7 10 7c1.2 0 2.3-.2 3.3-.6"/></svg>',
};

/* ------------------------------------------------------------
 * feature 上下文(ctx)
 * ------------------------------------------------------------
 * 从 ui.js 拆出去的 feature 模块不直接耦合本文件的私有变量,而是通过 ctx
 * 拿到它们需要的「共享基础设施」。当前注入:
 *   - dom.byId(id)         取元素(ui.js 的 `$` 的等价物)
 *   - icons                描边图标表(ICON)
 *   - toast(msg,kind)      轻提示
 *   - modal(opts)          通用对话框
 *   - store                会话态(读/写;见 store.js)
 *   - openNote(id)         打开某条笔记(sidebar.js)
 *   - activeNoteData()     取当前笔记对象(sidebar.js)
 *   - renderNoteList()     重绘笔记列表(sidebar.js)
 *   - renderCategoryList() 重绘分类列表(sidebar.js)
 *   - fmtTime(ts)          时间格式化(工具区)
 *   - markDirty(name)      标记某分类有未保存改动
 *   - clickable(el,fn)     让元素可点(含键盘可达性)
 *   - copyText(text,btn)   复制并给按钮反馈
 *   - downloadBytes(...)   下载字节为文件
 *   - saveAll()            立刻跑一次保存流水线
 *   - resetStatusPriority() 清状态栏粘性(error 唯一粘性,见 §8.1.2)
 *   - stopIdleTimer()      停掉空闲计时(锁定时用)
 *   - enterApp()           解锁成功后进入应用
 *   - api                  { setToken, clearToken, createVaultJson }
 *   - session              { saveSession, loadSession, clearSession }
 *   - vault                { unlockVault, deriveAllKeys, createVault, dekMatchesVault }
 *   - Library              Library 构造器(建库 / 解锁时用)
 *   - addNote()            新建一条笔记(note.js)
 *   - renderReadView()     重绘阅读视图(note.js)
 *   - moveNote(id,dir)     笔记上移 / 下移(note.js)
 *   - toggleNotePin(id)    笔记置顶开关(note.js)
 *   - showEmpty(...)       空状态区(图标 + 文案 + 可选引导按钮)
 *   - closeDrawer()        移动端收起左侧抽屉
 *   - renderMarkdown(text) Markdown → DOM(render.js 的安全子集渲染器)
 * ★ 跨模块入口一律在这里**绑定 ctx 后再注入**:feature 之间的调用写成
 *   `ctx.openNote(id)` 而不是 `ctx.openNote(ctx, id)` —— 谁都不必知道「ctx 要透传」
 *   这件事,接线全部收在本文件。少一层约定就少一类「忘了传 ctx」的运行时崩溃
 *   (2026-09-27 实测:最初注入裸函数引用,note.js 调 ctx.activeNoteData() 直接
 *    TypeError: Cannot read properties of undefined (reading 'store'))。
 * 新增注入项时**只加不删**,避免已拆出的 feature 失效;
 * 每加一项都要在 tests/features.test.mjs 的 CTX_KEYS 里同步登记(那边会双向对账)。
 * ------------------------------------------------------------ */
const ctx = {
  dom: { byId: $ },
  icons: ICON,
  toast,
  modal,
  store,
  markDirty,
  copyText,
  downloadBytes,
  saveAll,
  resetStatusPriority,
  stopIdleTimer,
  enterApp,
  api: API,
  session: { saveSession, loadSession, clearSession },
  vault: V,
  Library,
  fmtTime,
  showEmpty,
  closeDrawer,
  renderMarkdown,
  /* —— 以下为本文件私有、但 shell.js 需要的基础设施 —— */
  assessPassword: F.assessPassword,      // 建库时的密码强度提示
  wrapSel,                               // 编辑器「选区包裹」快捷插入
  prefixLines,                           // 编辑器「行前缀」快捷插入
  loadSettings,                          // 启动时读自动锁屏偏好
  saveSettings,
  saveRememberPref,
  changePassword,
  exportFullBackup,
  importFromBackup,
  TabSync,                               // shell 在 start() 里 new
  onTabMessage,                          // 多标签页消息入口
  // —— 以下为 feature 之间的入口:统一绑定 ctx(见上方说明)
  // clickable 本身签名就是 (el, fn),不需要绑定 ctx,直接注入裸引用
  clickable,
  openNote: (id) => openNote(ctx, id),
  activeNoteData: () => activeNoteData(ctx),
  renderNoteList: () => renderNoteList(ctx),
  renderCategoryList: () => renderCategoryList(ctx),
  addNote: () => addNote(ctx),
  renderReadView: () => renderReadView(ctx),
  moveNote: (id, dir) => moveNote(ctx, id, dir),
  toggleNotePin: (id) => toggleNotePin(ctx, id),
  // —— 以下为 shell.js 的入口绑定(一律不带 ctx,由这里接线)——
  showLock: (mode) => showLock(ctx, mode),
  lockNow: () => lockNow(ctx),
  doUnlock: (pw) => doUnlock(ctx, pw),
  doCreateLibrary: (pw, pw2) => doCreateLibrary(ctx, pw, pw2),
  resumeSession: () => resumeSession(ctx),
  addCategory: () => addCategory(ctx),
  renameCategory: () => renameCategory(ctx),
  deleteCategory: () => deleteCategory(ctx),
  openCategory: (n) => openCategory(ctx, n),
  enterEditMode: () => enterEditMode(ctx),
  exitEditMode: () => exitEditMode(ctx),
  collectEditChanges: () => collectEditChanges(ctx),
  addAttachments: (files) => addAttachments(ctx, files),
  copyWholeNote: () => copyWholeNote(ctx),
  deleteNote: () => deleteNote(ctx),
  moveNoteSelection: (d) => moveNoteSelection(ctx, d),
  // 触屏滑动翻篇的监听在启动时绑一次(shell.js 的 bindEvents 调),不是事件回调
  bindReadSwipe: () => bindReadSwipe(ctx),
  runSearch: () => runSearch(ctx),
  closeSearch: () => closeSearch(ctx),
  toggleTheme: () => toggleTheme(ctx),
  initTheme: () => initTheme(ctx),
  openTrash: () => openTrash(ctx),
  openPwGenerator: () => openPwGenerator(ctx),
  exportNoteMd: () => exportNoteMd(ctx),
};

const SAVE_DEBOUNCE_MS = 800;            // 状态栏防抖刷新
/* 自动锁屏默认「关闭」。它与「记住本设备」的目的正好相反:前者要「离开就得输密码」,
 * 后者要「打开即用」。默认给后者,想要前者自己去侧栏选 —— 选了之后空闲到点会
 * 锁定并**忘掉本机会话**,语义一致:锁定 = 需要重新输主密码。
 * 取值来自 store 的 defaultState(单一出处,别在这里另写字面量)。 */
const DEFAULT_AUTOLOCK_MIN = store.get('settings').autoLockMinutes;

/* 会话态的定义已迁到 store.js 的 defaultState()(单一出处)。
 * 原先这里的 `const S = { lib, vaultJson, ... }` 是裸对象,现改为:
 *   S = createProxy(store)  → 读写语法不变,状态汇聚进 store(可订阅)。 */

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
    // ★ close 事件是**异步(task)派发**的,而 dlg 是全应用共用的同一个 <dialog>:
    //   连续两次 modal(「修改主密码」的两问)时,第二个弹窗会在第一个弹窗排队的
    //   close 事件派发**之前**就注册好监听 —— 「确定」按钮是同步 settle,紧接着的
    //   `await` 续行是微任务,先于那个 task 跑 → 于是新弹窗收到的是**别人**那次的
    //   close、被 settle(null) 提前落定,整条流程静默失效(2026-09-28 审计 P1,真机复现)。
    //   两道防线:
    //     ① settle 时摘掉监听,不留悬挂监听;
    //     ② close 只在「弹窗真的已经关掉」时才落定 —— 排队中的旧 close 到达时,新弹窗
    //        还开着(open === true),必须忽略。⚠️ 只做①是不够的:被派发到的是新弹窗
    //        自己刚注册的监听,①摘不掉它(2026-09-28 补护栏时被这条用例抓出来)。
    const onCancel = () => settle(null);
    const onClose = () => { if (dlg.open) return; settle(null); };
    const settle = (v) => {
      if (settled) return;
      settled = true;
      dlg.removeEventListener('cancel', onCancel);
      dlg.removeEventListener('close', onClose);
      resolve(v);
    };
    dlg.addEventListener('cancel', onCancel);
    dlg.addEventListener('close', onClose);

    const h = document.createElement('h3');
    h.textContent = title;
    /* 可访问名(2026-09-29 审计 P3):把 <dialog> 与标题关联 —— 读屏器打开弹窗时
     * 先播报标题,而不是只报一句「对话框」。#modalTitle 是静态 id:全应用复用同一个
     * <dialog>,所以每次都要重设一次(标题内容会变)。 */
    h.setAttribute('id', 'modalTitle');
    body.appendChild(h);
    dlg.setAttribute('aria-labelledby', 'modalTitle');

    let input = null; let input2 = null;
    if (type === 'prompt') {
      if (text) { const p = document.createElement('p'); p.className = 'modal-text'; p.textContent = text; body.appendChild(p); }
      input = document.createElement('input');
      input.className = 'modal-input';
      input.value = value;
      if (password) input.type = 'password';
      if (label) input.placeholder = label;
      // placeholder **不算**可访问名(读屏器不播报它)—— 必须显式给一个(2026-09-29 审计 P3)
      input.setAttribute('aria-label', label || title || '输入');
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
  scheduleClipboardWipe(ctx);
  flashCopied(btn);
}

/**
 * 「已复制」反馈。按钮有两种骨架,分开处理:
 *   · 纯图标按钮(.blk-copy,26×24):把 SVG 换成对勾 —— 尺寸不变、零布局位移。
 *     原来直接 textContent = '已复制',三个汉字塞进 26px 宽的框里必然溢出。
 *   · 图标+文字按钮(如「复制全文」):只换文字段,保留前导图标。
 *     原来整体覆盖会把图标一起抹掉,按钮宽度在 1.5 秒里跳一下。
 * 判据是「按钮里有没有非空文字」,不靠类名 —— 类名以后改了这里也不会失灵。
 * 两种都上 .copied 绿色,状态不依赖文字本身传达。
 */
function flashCopied(btn) {
  if (!btn) return;
  btn.classList.add('copied');
  const label = btn.querySelector('.btn-label');
  if (label) {
    /* 图标 + 文字(复用时按钮已拆好结构):只动文字段 */
    const old = label.textContent;
    label.textContent = ' 已复制';
    setTimeout(() => { label.textContent = old; btn.classList.remove('copied'); }, 1500);
    return;
  }
  const hasText = btn.textContent.trim().length > 0;
  if (!hasText) {
    /* 纯图标按钮:换对勾,SVG 尺寸与原图标一致(都是 15px),框子不撑不缩 */
    const prev = btn.innerHTML;
    btn.innerHTML = ICON.check;
    setTimeout(() => { btn.innerHTML = prev; btn.classList.remove('copied'); }, 1500);
    return;
  }
  /* 有文字但还没拆过结构:拆成「前导图标 + .btn-label」,以后只动 label */
  const text = btn.textContent.trim();
  const iconEl = btn.querySelector('svg');
  const tail = btn.textContent.slice(btn.textContent.indexOf(text));
  btn.textContent = '';
  if (iconEl) btn.insertAdjacentHTML('afterbegin', iconEl.outerHTML);
  const span = document.createElement('span');
  span.className = 'btn-label';
  span.textContent = tail;
  btn.appendChild(span);
  span.textContent = ' 已复制';
  setTimeout(() => { span.textContent = tail; btn.classList.remove('copied'); }, 1500);
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

/**
 * 状态栏优先级:error > busy > dirty > ok(判据在 F.statusAllowsOverride,可单测)。
 * ★ 为什么要优先级:refreshSaveStatus 是 800ms 防抖 —— 保存失败时先由 saveAll
 *   直接 setStatus('保存失败 ×N','error'),若此刻还有一次 markDirty 挂起的防抖回调
 *   到点(且 S.dirty 已被清空),它会用「已保存」把刚显示的错误盖掉 →
 *   用户看到「已保存」而实际有分类没存上,是**误导性的假绿**。
 *   error 因而是「粘性」的:只有同类 error 或显式 resetStatusPriority() 能改变它。
 */
let statusRank = -1;

function setStatus(text, kind = 'ok', authoritative = false) {
  if (!F.statusAllowsOverride(statusRank, kind, authoritative)) return;
  statusRank = F.STATUS_RANK[kind] ?? 0;
  const el = $('saveStatus');
  el.textContent = text;
  el.dataset.kind = kind;
}

/** 显式清零优先级:用户新动作(重新编辑 / 解锁 / 回到锁屏)后允许 ok 重新覆盖 */
function resetStatusPriority() {
  statusRank = -1;
}

function refreshSaveStatus() {
  clearTimeout(S.statusTimer);
  S.statusTimer = setTimeout(() => {
    // ★ 权威终态:保存流水线已跑完,这里写的才是真实结果。
    //   必须传 authoritative=true —— 否则上一句 setStatus('保存中…','busy')
    //   留下的 rank 2 会把「已保存」挡在外面,状态栏永久卡在「保存中…」。
    //   (error 依然粘住:authoritative 也盖不动 error,防假绿。)
    if (S.dirty.size > 0) setStatus('有未保存更改', 'dirty', true);
    else setStatus('已保存', 'ok', true);
  }, SAVE_DEBOUNCE_MS);
}

/* ================= 保存流水线 ================= */

function markDirty(catName) {
  S.markDirty(catName);
  // 用户又改了东西 = 进入新一轮保存周期,清掉上一轮残留的 error 粘性,
  // 否则上次的「保存失败」会永久占住状态栏,即使这次已经存好了
  resetStatusPriority();
  refreshSaveStatus();
  clearTimeout(S.autoSaveTimer);
  S.autoSaveTimer = setTimeout(() => { saveAll(); }, IDLE_SAVE_MS);
}

async function saveAll() {
  if (!S.lib || S.dirty.size === 0) return;
  if (S.saving) { S.resavePending = true; return; } // 保存进行中又来新改动:别丢,结束后补跑
  S.saving = true;
  setStatus('保存中…', 'busy');
  const names = [...S.dirty];
  let failed = 0;
  for (const name of names) {
    // 记下发起保存时该分类的改动代数:await 期间用户若又编辑同一分类,
    // 代数会变 → 结束时不清脏标记,新改动继续留在队列里等下一轮。
    // (2026-09-27 审计 P1:此前无条件 delete,窗口期的新编辑会被静默抹掉)
    const gen = S.dirtyGen.get(name);
    try {
      const res = await S.lib.saveCategory(name);
      if (res.skipped) {
        // 没有内存数据可存(saveCategory 如实上报),移出待保存队列
        S.clearDirtyIfUnchanged(name, gen);
      } else if (res.conflict) {
        S.clearDirtyIfUnchanged(name, gen);
        await handleConflict(name);
      } else {
        S.clearDirtyIfUnchanged(name, gen);
        // 通知其他标签页:这个分类的云端版本变了,它们手里的是旧数据
        S.tabs?.send({ type: 'cat-saved', name });
        syncCatCount(name);
      }
    } catch (e) {
      failed += 1;
      console.error('保存失败', name, e);
    }
  }
  S.saving = false;
  if (S.resavePending) { S.resavePending = false; setTimeout(() => { saveAll(); }, 300); return; }
  if (failed > 0) { setStatus(`保存失败 ×${failed}`, 'error'); toast(`${failed} 个分类保存失败,详见控制台`, 'error'); }
  else refreshSaveStatus();
}

/**
 * 把某分类的权威篇数写回 catMeta(侧栏徽章的数据源)。
 * 只在刚保存成功时调用 —— 那一刻内存里的 notes 才是与云端一致的真值。
 * 有意不 await:徽章晚一拍亮没关系,不能让元信息写的网络往返拖慢保存流水线;
 * 失败也静默 —— setCatCount 内部已挡「没变化就不写」,真失败就等下次保存再对齐。
 */
function syncCatCount(name) {
  const cat = S.lib?.categoryInfo(name);
  if (!cat?.data) return;
  const n = cat.data.notes.length;
  if (S.lib.catCount(name) === n) return;
  S.lib.setCatCount(name, n).then(() => {
    if (S.lib.catCount(name) === n) renderCategoryList(ctx);
  }).catch(() => { /* 元信息失败不影响正文,下次保存会再试 */ });
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
      const r = await S.lib.saveCategory(name, { force: true });
      /* ★ 必须看返回值(2026-09-29 审计 P2-9):saveCategory 在「没有内存数据」时返回
       *   {skipped:true}、在「云端刚又被改/已被删」时返回 {conflict:true} —— 两种都**不抛错**。
       *   旧写法丢弃返回值:覆盖其实没发生,却弹了绿字「已覆盖」;而 saveAll 早在弹窗前
       *   就把它移出了待保存队列 ⇒ 改动**静默脱离保存流程**(违反 DESIGN「绝不静默覆盖」)。
       *   失败一律放回待保存队列并如实报错,与 catch 分支同一条纪律。 */
      if (r?.ok) {
        S.tabs?.send({ type: 'cat-saved', name });
        toast(`「${name}」已用本地版本覆盖(云端旧版已备份)`);
      } else {
        S.markDirty(name);
        toast(r?.conflict
          ? `「${name}」云端版本又变了,本次覆盖未生效;已放回待保存列表,请重试`
          : `「${name}」没有可覆盖的本地数据;已放回待保存列表`, 'error');
      }
    } catch (e) {
      // 覆盖失败必须把该分类放回待保存队列:saveAll 在弹冲突前已把它移出,
      // 这里若吞掉,改动会永久脱离保存队列、锁定/刷新后无提示丢失
      S.markDirty(name);
      toast(`「${name}」覆盖保存失败:${e.message};已保留在待保存列表`, 'error');
    }
  } else if (choice === 'disk') {
    // 丢弃内存改动,重读云端
    cat.data = null; cat.lastSeenEtag = null; cat.error = null; cat.transient = null;
    S.clearDirty(name); // 本地已无未保存改动,别让「未保存」标记一直挂着
    if (S.activeCat === name) {
      await openCategory(ctx, name);
    }
    toast(`「${name}」已改为云端版本,本地未保存的改动已放弃`, 'warn');
  } else {
    S.markDirty(name); // 留待稍后
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
  if (msg.type === 'locked') { lockNow(ctx, { broadcast: false, confirmDiscard: false }); return; }
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
    void (async () => {
      const cat = S.lib.categoryInfo(msg.name);
      cat.data = null; cat.lastSeenEtag = null; cat.error = null; cat.transient = null;
      // ★ 必须 await 重载成功后再报喜,否则加载失败时用户会同时看到
      //   绿色「已载入最新版本」+ 红色「分类无法打开」两条矛盾 toast
      //   (2026-09-27 审计 P3-6;与 handleConflict 的 disk 分支同款时序)
      if (S.activeCat === msg.name) await openCategory(ctx, msg.name);
      toast(`「${msg.name}」已在另一个标签页更新,已载入最新版本`);
    })();
  }
}

/** 别的标签页增删/改名了分类 → 重新问服务器 */
async function rescanFromTabs() {
  try {
    await S.lib.rescan();
    // ★ 分类清单改了,vault.json 的元信息(置顶/篇数/手动顺序)也必须重拉 ——
    //   rescan() 只重建分类清单、不碰 vaultJson,只 rescan 会让本标签页继续按陈旧的
    //   catMeta 渲染顺序与置顶(2026-09-28 审计 P2)。
    await S.lib.refreshVaultMeta();
  } catch {
    return; // 网络问题:不打扰用户,下次操作自然会重试
  }
  renderCategoryList(ctx);
  if (S.activeCat && !S.lib.categoryInfo(S.activeCat)) {
    // 本标签页正开着的分类,在别处被删了
    S.activeCat = null; S.activeNoteId = null; S.editing = false;
    $('activeCatName').textContent = '未选择分类';
    renderNoteList(ctx);
    showEmpty('该分类已在另一个标签页被删除');
  }
}

/* ================= 锁屏 ================= */
/* ================= 锁屏 / 解锁 / 建库 ================= */
/* 已迁出到 features/lock.js(依赖 ctx.store / ctx.modal / ctx.saveAll / ctx.stopIdleTimer
 * / ctx.enterApp / ctx.api / ctx.session / ctx.vault / ctx.Library;F.assessPassword 由
 * 该模块直接 import format.js)。
 * 原先的 pendingLockMsg / showLock / lockNow / rememberNow / downloadVaultBackup
 * / doUnlock / doCreateLibrary / resumeSession 定义在这里,现改为 import ——
 * ★ resumeSession 一并迁走:它与解锁同属密钥生命周期,散在两处最容易「一半清了一半没清」。 */

/* ================= 进入应用 ================= */

/* ---- 上次读到哪:解锁后把内容直接摆上来 ---- */

const LAST_READ_KEY = 'jmbiji.lastRead';

/**
 * 读上次的阅读位置。任何形态不对的值一律当成「没有」——
 * 坏数据不该把启动流程带进异常分支。
 * @returns {{cat:string,noteId:string|null}|null}
 */
export function readLastRead() {
  try {
    const raw = localStorage.getItem(LAST_READ_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || typeof v.cat !== 'string' || !v.cat) return null;
    return { cat: v.cat, noteId: typeof v.noteId === 'string' && v.noteId ? v.noteId : null };
  } catch { return null; }
}

/** 记住当前正在读的笔记。复位(null)一律跳过 —— 那不是「用户读到了哪」。
 *  必须走 store.get():状态都在 _state 里,实例上没有字段(代理与原实例都支持 get)。 */
export function rememberRead(store = S) {
  const cat = store.get('activeCat');
  const noteId = store.get('activeNoteId');
  if (!cat || !noteId) return;
  try { localStorage.setItem(LAST_READ_KEY, JSON.stringify({ cat, noteId })); } catch { /* 忽略 */ }
}

/**
 * 进应用该打开哪个分类 —— 纯函数,把三级降级链钉死。
 * @param {string[]} names 视觉顺序的分类名(置顶 → 手动 order → 名称兜底)
 * @param {{cat:string,noteId:string|null}|null} last
 * @returns {string|null} 要打开的分类;null = 一个分类都没有
 *
 *   ① 上次读的分类还在 → 回到它(那篇笔记还在就回到那篇,不在就落到它的顶端)
 *   ② 上次的分类没了(改名/删除/换了个库)→ 第一个分类
 *   ③ 一个分类都没有 → null,由调用方给「新建分类」引导
 */
export function pickRestoreCategory(names, last) {
  if (!names.length) return null;
  if (last && names.includes(last.cat)) return last.cat;
  return names[0];
}

/**
 * 进应用时把内容摆到阅读区:优先回到上次读的那篇,否则打开第一个分类的顶端那篇。
 * @returns {Promise<boolean>} 阅读区是否已经归属到某个分类(false = 调用方该落兜底)
 *
 * ⚠️ 不能写成「没抛错就算成功」。`openCategory` 把**加载失败吞在自己的 catch 里**
 *    (只 toast + 重画分类列表),它**不碰阅读区**;若这里无条件返回 true,调用方的
 *    兜底分支就永不触发 —— 阅读区会**永久停在「正在载入…」**,比原来那句可操作的
 *    「从左侧选择一个分类」更糟(用户既看不到内容,也没有任何东西可点)。
 *    触发场景真实存在:离线打开、网络抖动、本机 vault 缓存里的分类已被别端删掉。
 *    判据取 `activeCat`:openCategory 只在**真正打开成功**后才写它。
 * ⚠️ 判「非空」而不是「等于 cat」:加载慢时用户可能已在侧栏自己点了别的分类,
 *    那时 activeCat 是**他选的那个** —— 那是他想要的,不该被这里判成失败。
 */
export async function restoreReading(ctx) {
  const names = ctx.store.get('lib').sortedCategories();  // 视觉顺序单一来源,与侧栏首行同源
  const last = readLastRead();
  const cat = pickRestoreCategory(names, last);
  if (!cat) return false;
  /* 先把 activeNoteId 摆成记忆里那篇:openCategory 的既定行为是
   * 「列表里还有就保持不动,否则取顶端那篇」——笔记已删的降级由它兜住,
   * 这里不再重复判断一遍(判两处必然有一天会分家)。 */
  ctx.store.set('activeNoteId', last && last.cat === cat ? last.noteId : null);
  await openCategory(ctx, cat);
  return ctx.store.get('activeCat') !== null;
}

/** 记住阅读位置的订阅只注册一次(enterApp 每次解锁都会跑,重复订阅会叠加回调)。 */
let readPosSubscribed = false;

/** 解锁成功后的第一屏:复位 → 定位该读哪篇 → 兜底 → 收尾。
 *  ★ 导出**只为可测**:这条链路的每一步顺序错了界面都会对不上,而此前它一行都没被
 *    覆盖 —— 那 14 条用例只到 `restoreReading` 为止,壳子里的接线是裸的。 */
export async function enterApp() {
  $('lock').hidden = true;
  $('app').hidden = false;
  $('searchBox').value = '';
  $('searchPanel').hidden = true;
  renderCategoryList(ctx);
  /* ★ 进应用 = 锁屏态结束,必须显式复位 lockMode。
   *   store.js 的契约写的是「进应用后为 null」,但此前**只有 showLock 会写这个字段,
   *   没有任何地方清过它** —— 于是 2026-09-29 加的 P3 全局快捷键守卫
   *   (lockMode 非空就整类 return)会让解锁一次之后 Ctrl+K / Ctrl+S / Ctrl+Enter /
   *   J/K / Alt+↑↓ **全部永久失效**。真机 S0【14】的 Ctrl+K / Alt+↓ 正对照当场抓到。 */
  S.lockMode = null;
  /* 先复位:解锁有可能是「换了个库」,上一条会话的分类/笔记若留着,界面会显示成
   * 新库里某个同名分类的内容。复位之后再按**当前库**重新定位该读哪篇。 */
  S.activeCat = null;
  S.activeNoteId = null;
  S.editing = false;
  renderNoteList(ctx);
  if (!readPosSubscribed) {
    readPosSubscribed = true;
    /* 所有改变「正在读哪篇」的路径都会写 activeNoteId(点列表 / J / K / 滑动翻篇 /
     * 换分类 / 删除后自动选相邻),订阅这一处就全覆盖,不必在每个入口各写一遍。 */
    S.subscribe('activeNoteId', () => rememberRead());
  }
  const names = S.lib.sortedCategories();
  /* 有分类时先给一句过渡文案再异步打开 —— 否则会先闪一下「从左侧选择一个分类」,
   * 用户刚看完那句,内容又跳出来了。 */
  if (names.length) showEmpty('正在载入…');
  /* 2026-09-29 用户反馈:电脑版、手机版打开都是一片空白 +「从左侧选择一个分类」——
   * 等于每次进来都要自己重新找一遍位置。现在直接摆上:上次读的那篇 / 第一个分类的顶端。 */
  if (!await restoreReading(ctx)) {
    /* 兜底必须分两种 —— 它们对用户是**完全不同的处境**:
     *   · 一个分类都没有 → 确实没东西可打开,给「新建分类」
     *   · 有分类却没打开 → 载入失败(离线 / 网络抖动 / 该分类已在别端删掉)。
     *     少了这一支,上面那句「正在载入…」就会一直挂着:用户既看不到内容,
     *     屏幕上也没有任何东西可点 —— 比改动前那句可操作的提示更糟。 */
    if (names.length) {
      showEmpty('内容没能载入,可重试或从左侧选择其他分类', {
        label: '重试',
        fn: async () => {
          if (!await restoreReading(ctx)) ctx.toast('仍然打不开:网络不通,或该分类已不存在', 'error');
        },
      });
    } else {
      showEmpty('还没有分类,先建一个', { label: '新建分类', fn: () => addCategory(ctx) });
    }
  }
  refreshSaveStatus();
  startIdleTimer();
  refreshExportDue(ctx);
}

/**
 * 空状态文案 + 可选引导按钮:没有分类/笔记时直接把下一步递到用户手上,
 * 而不是只留一句让人自己找入口的提示。
 */
/**
 * 空状态:一个图标 + 一句说明 + (可选)一个入口按钮。
 * 图标现在由这里注入 —— 原先 CSS 的 .empty::before 里写死了一个 ❖ 字符,
 * 文案与按钮却在这里,同一个视觉组件散在两处;而 ❖ 属 Unicode 装饰符,
 * 与本项目的描边图标体系不是一套质感。现在统一走 ICON。
 * @param {string} text 说明文案
 * @param {{label:string, fn:Function}|null} [action] 引导按钮(没有就只显示文案)
 * @param {string} [iconKey] ICON 内的键名,默认 sparkle
 */
function showEmpty(text, action, iconKey = 'sparkle') {
  const box = $('emptyState');
  box.hidden = false;
  $('readView').hidden = true;
  $('editView').hidden = true;
  box.textContent = '';
  const deco = document.createElement('div');
  deco.className = 'empty-deco';
  deco.innerHTML = ICON[iconKey] || ICON.sparkle;
  box.appendChild(deco);
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

/* ================= 左侧:分类 + 笔记列表 ================= */
/* 已迁出到 features/sidebar.js(依赖 ctx.store / ctx.icons / ctx.toast / ctx.modal
 * / ctx.showEmpty / ctx.closeDrawer / ctx.fmtTime,以及 note.js 的 ctx.addNote /
 * ctx.renderReadView / ctx.moveNote / ctx.toggleNotePin)。
 * 原先的 clickable / renderCategoryList / openCategory / addCategory / renameCategory
 * / deleteCategory / activeNoteData / renderNoteList / openNote / moveNoteSelection
 * 定义在这里,现改为 import —— 调用点名保持不变。
 * ★ 与 note.js 互为依赖,靠 ctx 解开循环:两个模块都不 import 对方,由本文件组装。 */
/* ================= 阅读 / 编辑 / 笔记增删排序 ================= */
/* 已迁出到 features/note.js(依赖 ctx.store / ctx.icons / ctx.toast / ctx.modal
 * / ctx.activeNoteData / ctx.renderNoteList / ctx.openNote / ctx.markDirty / ctx.saveAll
 * / ctx.copyText / ctx.showEmpty / ctx.fmtTime / ctx.renderMarkdown;F.sortNotes 与
 * F.orderBetween 由该模块直接 import format.js)。
 * 原先的 renderReadView / renderReadAttachments / toggleAttachmentImage / guessMime
 * / copyWholeNote / enterEditMode / collectEditChanges / exitEditMode / renderEditAttachments
 * / addAttachments / addNote / deleteNote / toggleNotePin / moveNote 定义在这里,现改为 import。
 * ★ note.js 与 sidebar.js 互为依赖,靠 ctx 解开循环(见 sidebar.js 顶部的说明)。 */
/* ================= 搜索 ================= */
/* 已迁出到 features/search.js(依赖 ctx.store / ctx.openNote / ctx.renderCategoryList
 * / ctx.clickable;findMatches 与 renderSearchResult 由该模块直接 import search.js)。
 * 原先的 searchSeq 与 runSearch 定义在这里,现改为 import —— 调用点名保持不变。 */
/* ================= 自动锁屏 ================= */

const IDLE_EVENTS = ['pointerdown', 'keydown', 'wheel'];

function resetIdleTimer() {
  if (S.settings.autoLockMinutes <= 0 || !S.lib) return;
  clearTimeout(S.idleTimer);
  S.idleTimer = setTimeout(() => { lockNow(ctx); toast('已自动锁屏', 'warn'); }, S.settings.autoLockMinutes * 60 * 1000);
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
/* 已迁出到 features/data.js(依赖 ctx.modal / ctx.markDirty / ctx.renderNoteList
 * / ctx.activeNoteData / ctx.copyText / ctx.downloadBytes;F.TRASH_DAYS 与
 * F.genPassword 由该模块直接 import format.js)。
 * 原先的 scheduleClipboardWipe / refreshExportDue / openTrash / restoreFromTrash
 * / purgeFromTrash / exportNoteMd / openPwGenerator 定义在这里,现改为 import。 */
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
    rememberNow(ctx, S.lib.dek, API.getToken());
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
      await lockNow(ctx, { broadcast: false });
      await boot(ctx);   // 重跑启动流程(见 features/shell.js 的 boot 说明)
      toast(`恢复完成(${parts.join(', ')})。请用这份备份对应的主密码解锁`, 'warn');
      return;
    }
    await S.lib.rescan();
    renderCategoryList(ctx);
    refreshSaveStatus();
    toast(`恢复完成:${parts.join(', ')}`);
  } catch (e) {
    refreshSaveStatus();
    toast(`恢复失败:${e.message}`, 'error');
  }
}

/* ================= 深浅色主题 ================= */
/* 已迁出到 features/theme.js(零 store 依赖,只依赖 ctx.dom / ctx.icons)。
 * 原先的 THEME_KEY / loadThemePref / setThemePref / applyTheme / initTheme
 * 五个定义在这里,现改为从模块 import(见文件顶部 import 区)——
 * 调用点名保持 applyTheme/initTheme 不变。 */

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
/* 已迁出到 features/shell.js(启动编排 boot / 事件绑定 bindEvents / 入口 start)。
 * 新增 DOM 事件监听一律加在 shell.js;此处只保留共享基础设施与 ctx 组装。
 *
 * 入口接线(public/js/main.js):
 *     import { start } from './features/shell.js';
 *     import { ctx } from './ui.js';
 *     start(ctx);
 * 让 main.js 负责「组装 + 启动」这两步,ui.js 就不必再持有启动知识。 */

/** 组装好的注入包:交给 features/shell.js 的 start() 用。
 *  ⚠️ 导出的是**原始 store**(在 ctx.store 上),不是本文件那个 Proxy S ——
 *     外部(含所有 feature)一律用 ctx.store.get('x') 读,属性赋值写。 */
/* 导出 handleConflict 仅为了可测:它「按 saveCategory 返回值分流」的判定写错了
 * 也不会有任何报错,只会静默失效(2026-09-29 审计 P2-9:覆盖失败仍弹绿字、
 * 改动静默脱离保存队列)。tests/dialog.test.mjs 钉住这条分流。 */
export { ctx, handleConflict };
