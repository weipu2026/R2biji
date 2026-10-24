/* ============================================================
 * features/shell.js —— 启动编排与事件绑定(S4 从 ui.js 迁出)
 * ------------------------------------------------------------
 * 这是**唯一**需要知道全部 DOM id 的模块:启动流程(拉 vault.json →
 * 锁屏 / 建库 / 解锁 / 记住本设备 → 进入应用)与所有按钮、快捷键的绑定都在这里。
 *
 * 设计取舍:
 *   · 它不含业务逻辑 —— 每个监听都只是把「DOM 事件」转成对某个 feature 入口的
 *     一次调用。要改业务,去对应 feature,不必回到本文件。
 *   · 所有依赖经 ctx 注入(与其它 feature 一致),因此**不得 import ui.js**。
 *   · ctx 里的跨模块入口**已由 ui.js 绑定好 ctx**(如 showLock 已等价于
 *     showLock(ctx, mode)),所以本文件里一律写 `ctx.showLock('unlock')`
 *     这种形式,绝不自己把 ctx 当参数传进去。
 *
 * ⚠️ 两条踩过的坑(2026-09-27):
 *   ① `ctx.store` 是**原始 store 实例**,状态全在 `_state` 里 —— 实例上没有任何字段。
 *      因此只能 get / set 两个方法:`get` 读、`set` 写。
 *      直接写字段名(读或写)都不行 —— 写只是给实例挂了个没人看的属性(状态没进 store,
 *      后续读不到);读则恒为 undefined(嵌套字段还会 TypeError)。
 *      ui.js 内部的 `S`(createProxy)才支持字段直访 —— 那是**ui.js 特权**,
 *      feature 一律走 get/set。tests/store-discipline.test.mjs 会拦住违规写法。
 *   ② 绑定函数内部取一次 `const $ = (id) => ctx.dom.byId(id)`,只为本文件书写方便 ——
 *      它不改变依赖来源(所有 DOM 访问仍然只经由 ctx.dom)。
 * ============================================================ */

import * as F from '../format.js';

/* ================= 启动流程 ================= */

/**
 * 拉取库级信息(vault.json)并写入会话态。
 *
 * ★ 抽成独立函数是为了让「锁屏上的解锁点击」也能重新拉一次(见 lock.js 的 doUnlock):
 *   boot 那次拉取失败时(办公网首次 TLS 握手/代理慢,超过启动探测的 10s 超时是最常见
 *   的触发),`store.vaultJson` 是 **null**。此时用户点「解锁」会走到
 *   `unlockVault(null)` → reason='corrupt' → 屏幕上出现「vault.json 已损坏,请从备份恢复」
 *   —— 一句既吓人、药方又完全错误的话(库里什么都没坏,只是这一次没连上)。
 *   (2026-10-12 用户真机反馈;复盘见 AUDIT-2026-10-12.md)
 *
 * @param {{ timeoutMs?: number }} [opt] 覆盖单次请求超时:启动探测取默认(10s,断网时
 *   不能让锁屏转两分钟圈);用户主动点击触发的补拉给更长预算(他愿意多等一会儿)。
 * @returns {Promise<'ok'|'missing'>} 'missing' = 服务器上确实没有库(该建库)
 * @throws {ApiError} 网络不通 / 访问密钥 / 服务端未就绪(由调用方如实转述)
 */
export async function loadVaultInfo(ctx, opt = {}) {
  for (;;) {
    let res;
    try {
      res = await ctx.api.fetchVault(opt);
    } catch (e) {
      /* 访问密钥门的重试也收在这里:此前只写在 boot 的循环里,于是「锁屏上点解锁」
       * 这条补拉路径遇到 401 access-key 会直接把错误弹给用户,连输入框都不出现
       * (用户换设备/清了站点数据后必然撞上)。收进来之后 boot 与两条补拉路径
       * 共用同一份实现。 */
      if (e.code !== 'access-key') throw e;
      const key = await ctx.modal({
        type: 'prompt', title: '访问密钥',
        label: '输入部署时设置的 ACCESS_KEY(≥16 字符)',
        text: '此服务器启用了访问密钥(与主密码是两回事)。密钥只保存在本机浏览器里,换设备/换浏览器需再输一次。',
      });
      if (key != null && key.trim()) { ctx.api.saveAccessKey(key.trim()); continue; }
      throw new Error('未提供访问密钥,无法连接笔记库');
    }
    if (res.status === 404) {
      // 服务器上没有库:把上一次可能残留的库信息清掉,别让解锁拿旧的一份去解
      ctx.store.set('vaultJson', null);
      ctx.store.set('vaultEtag', null);
      return 'missing';
    }
    /* ⚠️ 必须用 set():store 的状态都在 _state 里,实例上没有字段。
     *    若按老习惯直接往实例上挂属性,那只是个没人读的实例属性,后续 get 读不到 ——
     *    表现为「解锁永远说库损坏」。(2026-09-27 实测:护栏「建库后进入应用」超时,根因就是这个。) */
    ctx.store.set('vaultJson', res.json);
    ctx.store.set('vaultEtag', res.etag);
    return 'ok';
  }
}

/* 导出原因:ui.js 的「从备份恢复」在重建了库之后需要**重跑一遍启动流程**
 * (vaultJson 已失效、当前会话令牌也对不上),那个调用点在 ui.js 里。
 * 由 ui.js import 本函数即可 —— 反向(本文件 import ui.js)才是不允许的。 */
export async function boot(ctx) {
  ctx.loadSettings();
  ctx.api.loadAccessKey();
  ctx.showLock('loading'); // 首屏即过渡态:主密码框只在该手动解锁时出现,别闪现
  let status;
  try {
    status = await loadVaultInfo(ctx);
  } catch (e) {
    /* 网络不通 / 服务端 fail closed(ACCESS_KEY 未配置或过短) / 用户取消了访问密钥:
     * 原样转述底层那句可操作提示(api.js 的网络分支已拼过「无法连接服务器:」,
     * 这里不再加工,否则会出现双前缀)。
     * ★ 放出的必须是**可重试**的解锁表单:此时 store.vaultJson 仍是 null,
     *   用户点「解锁」会先走 doUnlock 的补拉分支(见 lock.js)拿到库信息再解 ——
     *   这条重试路径才让「表单可见」有意义(2026-10-12 用户真机反馈)。
     *   用 showLock('unlock') 而非手动 hidden=false:顺带复位 lockMode(旧写法留在
     *   'loading',屏幕长得像解锁页却自称还在探测中)、清空上次的密码、放回焦点。 */
    ctx.showLock('unlock');
    ctx.dom.byId('lockErr').textContent = e.message;
    ctx.dom.byId('lockErr').hidden = false;
    return;
  }
  if (status === 'missing') { ctx.showLock('setup'); return; }
  // 「记住本设备」:本机有可用会话就直接进,不问主密码(失败会自己回落锁屏)
  if (ctx.store.get('settings').rememberDevice && await ctx.resumeSession()) return;
  ctx.showLock('unlock');
}

/* ================= 事件绑定 ================= */

/* 反向混版占位元素(2026-10-24):见 bindEvents 里 $ 的说明。 */
const voidEl = {
  addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {},
  insertAdjacentHTML() {}, dispatchEvent() { return false; },
  classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
  dataset: {}, style: { setProperty() {}, removeProperty() {} },
  value: '', checked: false, hidden: true, textContent: '', innerHTML: '',
  focus() {}, click() {}, blur() {}, setRangeText() {},
  querySelector: () => null, querySelectorAll: () => [],
  closest: () => null, contains: () => false, getAttribute: () => null,
};

/* 等宽偏好(编辑态那枚按钮与设置面板共用同一份状态)。
 * 提升到模块作用域:设置面板要读当前值、改完要同步按钮 aria-pressed,
 * 状态不能再藏在 bindEvents 的局部变量里(2026-10-24 A2)。 */
let monoOn = false;
function applyMono(ctx, on) {
  monoOn = on;
  const ta = ctx.dom.byId('editBody');
  if (ta) ta.classList.toggle('mono', on);
  const btn = ctx.dom.byId('btnMono');
  if (btn) btn.setAttribute('aria-pressed', String(on));
}
export function getMono() { return monoOn; }
export function setMono(ctx, on) {
  applyMono(ctx, on);
  try { localStorage.setItem('jmbiji.mono', on ? '1' : '0'); } catch { /* 仅本次会话生效 */ }
}

function bindEvents(ctx) {
  // ⚠️ || voidEl 不是偷懒:离线时旧 HTML 缺控件会在这里抛错并烧掉后半段绑定
  const $ = (id) => ctx.dom.byId(id) || voidEl;
  const ICON = ctx.icons;

  // 建库时实时反馈密码强度(解锁态不提示:那是既有密码,提示也无从改)
  const updatePwHint = () => {
    if (ctx.store.get('lockMode') !== 'setup') return;
    const hint = $('pwHint');
    const pw = $('pwInput').value;
    if (!pw) { hint.textContent = ''; hint.className = 'pw-hint'; return; }
    const a = ctx.assessPassword(pw);
    hint.textContent = a.msg;
    hint.className = `pw-hint ${a.level}`;
  };
  $('pwInput').addEventListener('input', updatePwHint);

  $('pwBtn').addEventListener('click', () => {
    const pw = $('pwInput').value;
    if (ctx.store.get('lockMode') === 'setup') ctx.doCreateLibrary(pw, $('pwConfirm').value);
    else ctx.doUnlock(pw);
  });
  $('pwInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('pwBtn').click(); });
  $('pwConfirm').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('pwBtn').click(); });

  $('btnLock').addEventListener('click', () => ctx.lockNow());
  /* 静态按钮图标统一注入:HTML 里不再放 emoji/Unicode 字符 */
  $('btnMenu').innerHTML = ICON.menu;
  $('btnAddCat').innerHTML = ICON.plus;
  $('btnAddNote').innerHTML = ICON.plus;
  $('btnRenameCat').innerHTML = ICON.pencil;
  $('btnTrash').insertAdjacentHTML('afterbegin', ICON.trash + ' ');
  $('btnCopyAll').insertAdjacentHTML('afterbegin', ICON.copy + ' ');
  $('pwToggle').innerHTML = ICON.eye;
  /* 顶栏「锁定」与底栏五枚图标:原本在 index.html 里各写一份内联 SVG,
   * 尺寸还各不相同(btnLock 13px、其余 16px),与 ICON 表的 15px 三档并存。
   * 现在统一由 ICON 注入 —— 图标只有一处定义,改尺寸/改线宽不会漏。 */
  $('btnLock').insertAdjacentHTML('afterbegin', ICON.lock + ' ');
  $('btnChangePw').innerHTML = ICON.key;
  $('btnExport').innerHTML = ICON.download;
  $('btnImport').innerHTML = ICON.upload;
  $('btnCleanBlobs').innerHTML = ICON.broom;
  $('btnDelCat').innerHTML = ICON.trash2;
  /* 编辑器工具条的「行内代码 / 列表行」:以前是 ‹› 与 ≡ 两个 Unicode 字形 ——
   * 字形随系统字体变、与描边图标体系不是一套质感,且违反「符号只走 SVG」的既定口径。
   * 这两个按钮在 HTML 里没有 id,用 data 属性定位(与事件委托同一套选择器)。 */
  const edCodeBtn = document.querySelector('#edTools [data-wrap="`"]');
  if (edCodeBtn) edCodeBtn.innerHTML = ICON.code;
  const edListBtn = document.querySelector('#edTools [data-prefix="- "]');
  if (edListBtn) edListBtn.innerHTML = ICON.list;
  $('pwToggle').addEventListener('click', () => {
    const inp = $('pwInput');
    const show = inp.type === 'password';   // 当前是遮挡态 → 本次要显形
    inp.type = show ? 'text' : 'password';
    $('pwToggle').innerHTML = show ? ICON.eyeOff : ICON.eye;
    $('pwToggle').title = show ? '隐藏密码' : '显示密码';
    $('pwToggle').setAttribute('aria-label', $('pwToggle').title);
    inp.focus();
  });
  $('btnAddCat').addEventListener('click', () => ctx.addCategory());
  $('btnRenameCat').addEventListener('click', () => ctx.renameCategory());
  $('btnDelCat').addEventListener('click', () => ctx.deleteCategory());
  $('btnAddNote').addEventListener('click', () => ctx.addNote());
  $('btnEdit').addEventListener('click', () => ctx.enterEditMode());
  /* 读态双击进编辑 —— 与「点『编辑』」等价的一条捷径(DESIGN.md §7.2 早有此说,
   * 但代码里一直没有,属文档单方面承诺)。
   * 三个必须放行的例外:
   *   ① 落在交互元素上(复制按钮 / 附件 chip / 密钥显形 / 链接)—— 交给它们自己处理;
   *   ② 命中区不可编辑(空状态提示);
   *   ③ 用户正在选词 —— 双击正是「选中一个词」的手势,此时进编辑会把人打断。
   * 用 closest 一次判定,避免逐层 event.target 判断漏掉嵌套结构。 */
  $('readView').addEventListener('dblclick', (e) => {
    if (ctx.store.get('editing')) return;        // 已在编辑态(理论上 readView 隐藏了,兜底)
    const el = e.target instanceof Element ? e.target : null;
    if (!el || !el.closest('#readView')) return;
    // 例外①:交互元素自己处理点击
    if (el.closest('button, a, input, textarea, .blk-copy, .att-chip, .secret')) return;
    // 例外③:正在选词(双击选词的手势)
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && String(sel).trim()) return;
    ctx.enterEditMode();
  });
  /* 手机端:阅读面「划到边界再划一下」翻到上/下一篇。
   * 手机上没有侧栏可点(分类与笔记列表都收在抽屉里),翻篇全靠反复开抽屉太别扭;
   * 手势判定在 note.js(纯函数 + 触屏监听),这里只负责绑一次。
   * 只在贴边时接管 —— 中段上划仍是正常阅读滚动。 */
  ctx.bindReadSwipe();
  $('btnDone').addEventListener('click', () => ctx.exitEditMode());
  // 显式保存:先把输入框里的内容收进内存态,再走与 Ctrl+S 同一条上传流水线
  $('btnSaveNow').addEventListener('click', () => {
    ctx.collectEditChanges();
    ctx.saveAll();
  });
  $('btnCopyAll').addEventListener('click', () => ctx.copyWholeNote());
  $('btnDelNote').addEventListener('click', () => ctx.deleteNote());
  $('btnHistory').addEventListener('click', () => ctx.openHistory());
  /* 等宽字体开关:偏好只存本浏览器(localStorage,非敏感),键名随 jmbiji.* 约定,
   * 存取失败(隐私模式)静默降级为仅本次会话生效 —— 与主题偏好同一套纪律。
   * 状态与写住在模块级(applyMono / setMono),设置面板共用同一份。 */
  try { monoOn = localStorage.getItem('jmbiji.mono') === '1'; } catch { monoOn = false; }
  applyMono(ctx, monoOn);
  $('btnMono').addEventListener('click', () => setMono(ctx, !monoOn));
  $('btnAddAtt').addEventListener('click', () => $('attInput').click());
  $('attInput').addEventListener('change', (e) => {
    ctx.addAttachments([...e.target.files]);
    e.target.value = '';
  });
  /* Ctrl+V 粘贴图片直接入附件。
   * 截图工具(微信/QQ/系统截图)默认只进剪切板,以前必须先存成文件再点「添加图片」;
   * 现在在编辑区直接粘就行,走的还是 addAttachments() 那条流水线(加密入库、去重、广播同一条路)。
   *
   * 三条边界:
   *   ① 只接图片。clipboardData 里挑不出 image/* 就原样放行 —— 粘一段文字、粘个网址
   *      都还是浏览器默认行为(落进 textarea 光标处),不抢。
   *   ② 不往正文插 Markdown。render.js 是「不解析链接」的安全子集渲染器,
   *      插 ![](x) 只会渲染成一段纯文字,不如不插。
   *   ③ 只在编辑态。监听挂在 #editView 上,读态(甚至锁屏)下粘贴完全不接管 ——
   *      否则用户复制正文去别处粘会被无端拦截。
   * 命中图片才 preventDefault:不这么做的话,部分浏览器会把 image/png 当成
   * 「一个文件路径字符串」塞进 textarea 光标处,留下一行乱码。 */
  $('editView').addEventListener('paste', (e) => {
    if (!ctx.store.get('editing')) return;
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return; // 不是图片 → 放行默认粘贴
    e.preventDefault();
    ctx.addAttachments(files);
  });
  /* ★ 2026-10-18 审计 H1:清理要**解密全部分类**,是数秒到数十秒的长任务,而此前
   *   这里既无忙态也无防重入 —— 用户点完「确定」盯着毫无变化的界面,会以为卡死而
   *   刷新或重复点击;重复点击会让两次清理并发枚举/删除 blob,正好放大 DESIGN §11.14
   *   承认的「秒级残余窗口」。
   *   与导出/恢复同一套口径:busy 状态 + 禁用按钮,结束用 refreshSaveStatus 收尾。 */
  $('btnCleanBlobs').addEventListener('click', async () => {
    if (!ctx.store.get('lib')) return;
    const yes = await ctx.modal({
      type: 'confirm', title: '清理未引用图片',
      text: '将解密全部分类并删除没被任何笔记引用的图片文件。继续?',
      okLabel: '开始清理',   // 别让这颗按钮写成「删除」:它不是删除操作
    });
    if (!yes) return;
    const cleanBtn = $('btnCleanBlobs');
    cleanBtn.disabled = true;                  // 防重入:并发清理会放大秒级残余窗口
    ctx.setStatus('正在清理未引用图片…', 'busy');
    try {
      const removed = await ctx.store.get('lib').cleanupOrphanBlobs();
      ctx.renderCategoryList(); // 清理前会重新拉一次清单,界面跟着对齐
      ctx.toast(removed.length ? `已清理 ${removed.length} 张未引用图片` : '没有需要清理的图片');
    } catch (e) {
      // 清理是 fail closed 的:读不全就一张不删。这条提示必须看得清、看得久,
      // 否则用户会以为「点过了就等于清干净了」。
      ctx.toast(`清理已中止:${e.message}`, 'error');
    } finally {
      cleanBtn.disabled = false;
      ctx.refreshSaveStatus();   // 权威终态:把 busy 换回 已保存 / 有未保存更改
    }
  });
  $('btnExport').addEventListener('click', () => ctx.exportFullBackup());
  /* 快捷键帮助:侧栏这枚键盘图标 + 桌面端按 ?。已有 9 个快捷键,而此前没有任何
   * 地方集中展示 —— 新用户全靠一个个试出来(2026-10-18 补齐)。 */
  $('btnHelpKeys').innerHTML = ICON.keyboard;   // HTML 里零 SVG 的口径:图标一律由 shell 注入
  $('btnHelpKeys').addEventListener('click', () => openKeyHelp(ctx));
  $('btnImport').addEventListener('click', () => $('importInput').click());

  /* ── 集中设置面板(2026-10-24 A2):侧栏那枚滑杆图标 ── */
  $('btnSettings').innerHTML = ICON.sliders;
  $('btnSettings').addEventListener('click', () => ctx.openSettings());

  /* ── 打印(2026-10-24 B2):阅读态操作条那枚打印机 ──
   * 只负责调浏览器打印;「打印出来只有标题与正文」由 style.css 的
   * @media print 保证(隐藏侧栏/顶栏/按钮,正文通铺)。 */
  $('btnPrint').insertAdjacentHTML('afterbegin', ICON.printer + ' ');
  $('btnPrint').addEventListener('click', () => window.print());

  /* ── 页面级拖拽导入(2026-10-24 B1) ─────────────────────────
   * 把 .zip / .md 拖到页面任意处即导入,与点导入图标选文件走同一条
   * 分流(routeImports)。三条边界:
   *  ① 只认拖动**文件**(dataTransfer.types 含 'Files')—— 拖选区文字、
   *     拖链接都不弹遮罩,浏览器默认行为完全不受影响;
   *  ② dragover 必须 preventDefault:不拦的放置目标,浏览器不会派发 drop;
   *  ③ dragleave 只在 relatedTarget === null(指针离开窗口)时收遮罩 ——
   *     页面元素之间的移动会连续触发 dragleave,每次都收会让遮罩狂闪。
   * 遮罩自身 pointer-events:none(见 style.css),放置目标就是 document。 */
  let dropArmed = false;
  window.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dropArmed) { dropArmed = true; $('dropVeil').hidden = false; }
  });
  window.addEventListener('dragleave', (e) => {
    if (e.relatedTarget !== null || !dropArmed) return;
    dropArmed = false;
    $('dropVeil').hidden = true;
  });
  window.addEventListener('drop', (e) => {
    if (!dropArmed) return;               // 不是文件拖拽(或遮罩已收起)
    e.preventDefault();
    dropArmed = false;
    $('dropVeil').hidden = true;
    routeImports(ctx, [...(e.dataTransfer?.files || [])]);
  });
  /* 同一入口两种语义,按扩展名分流(2026-10-18 批量导入;2026-10-24 抽成
   * routeImports 供拖拽放置共用 —— 两条入口的分流规则必须只有一份):
   *   .zip            → 从备份恢复(原路径,整包合入)
   *   .md/.markdown/.txt → 批量导入(按篇建进当前分类)
   * 混选时两边都跑:zip 走恢复、文本走导入,各自如实报结果。 */
  $('importInput').addEventListener('change', (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    routeImports(ctx, files);
  });

  // 自动锁屏的原监听($('autoLock').change)随侧栏那个 <select> 一起移除了
  // (2026-10-24 A2):现在由设置面板调 ctx.saveSettings({autoLockMinutes}),
  // store.settings 是单一来源,「元素反读」那条路反而多一层不同步风险。
  $('rememberDevice').addEventListener('change', () => ctx.saveRememberPref());

  // 深浅色切换:点一次就固定下来(写入偏好,之后不再跟随系统变化)
  $('btnTheme').addEventListener('click', () => ctx.toggleTheme());

  // 移动端抽屉:汉堡键开,遮罩点击关
  $('btnMenu').addEventListener('click', () => {
    const open = !$('sidebar').classList.contains('open');
    $('sidebar').classList.toggle('open', open);
    $('sideBackdrop').hidden = !open;
    $('btnMenu').setAttribute('aria-expanded', String(open));
  });
  $('sideBackdrop').addEventListener('click', () => ctx.closeDrawer());

  // Markdown 快捷插入:选区包裹 / 行前缀,写完立刻算改动
  /* ★ 必须排除 [data-genpw](2026-10-17 审计 P3):那枚 pw 按钮在 index.html 里
     *   同时带着 class="ed-btn" 与 data-genpw,会被这个循环和下面那条生成器监听
     *   **双重绑定** —— 编辑态点它先 ta.focus() + collectEditChanges()(随即被
     *   弹窗焦点覆盖),确是重复绑定。旧注释写着「不走 wrap/prefix 委托」,与实际不符。 */
  for (const b of document.querySelectorAll('#edTools .ed-btn:not([data-genpw])')) {
    b.addEventListener('click', () => {
      if (!ctx.store.get('editing')) return;
      const ta = $('editBody');
      if (b.dataset.wrap) ctx.wrapSel(ta, b.dataset.wrap);
      else if (b.dataset.prefix) ctx.prefixLines(ta, b.dataset.prefix);
      ta.focus();
      ctx.collectEditChanges();
    });
  }

  // 编辑器里 Tab 是缩进,不是「把焦点跳走」
  $('editBody').addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    e.target.setRangeText('  ', e.target.selectionStart, e.target.selectionEnd, 'end');
    ctx.collectEditChanges();
  });

  // 修改主密码:左下角图标排里的「钥」(HTML 侧定义,这里只绑事件)
  $('btnChangePw').addEventListener('click', () => ctx.changePassword());
  $('btnTrash').addEventListener('click', () => ctx.openTrash());
  $('btnExportMd').addEventListener('click', () => ctx.exportNoteMd());
  // 随机密码生成器(ed-tools 里的 pw 按钮,不走 wrap/prefix 委托)
  document.querySelector('#edTools [data-genpw]')?.addEventListener('click', () => ctx.openPwGenerator());
  // 敏感行:点击显形 / 遮回;显形 30 秒后自动遮回
  /* 敏感行:点击显形 / 遮回;显形 30 秒后自动遮回。
   * ★ 切换逻辑抽出来供鼠标与键盘共用(2026-09-29 审计 P3:此前只有 click,
   *   键盘用户既看不到值、也拿不到自己的密码,而 title 还写着「点击显示」)。
   *   同步 aria-expanded,读屏器才能播报「已展开/已收起」。 */
  const toggleSecret = (t) => {
    const masked = t.classList.toggle('masked');
    clearTimeout(t._remask);
    if (!masked) t._remask = setTimeout(() => t.classList.add('masked'), 30000);
    if (typeof t.setAttribute === 'function') t.setAttribute('aria-expanded', String(!masked));
  };
  $('readBody').addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target.closest('.secret') : null;
    if (!t) return;
    toggleSecret(t);
  });
  $('readBody').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const t = e.target instanceof Element ? e.target.closest('.secret') : null;
    // 只认「事件源就是敏感行本身」:行内将来若有别的可聚焦元素,别抢它的键
    if (!t || e.target !== t) return;
    e.preventDefault();
    toggleSecret(t);
  });

  $('editTitle').addEventListener('input', () => ctx.collectEditChanges());
  $('editBody').addEventListener('input', () => ctx.collectEditChanges());

  let searchTimer = null;
  $('searchBox').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => ctx.runSearch(), 160);
  });
  document.addEventListener('click', (e) => {
    if (!$('searchPanel').hidden && !$('searchPanel').contains(e.target) && e.target !== $('searchBox')) {
      ctx.closeSearch(); // 收起 + 清空输入(重聚焦不再接着旧词搜)
    }
  });

  document.addEventListener('keydown', (e) => {
    /* ★ 全局快捷键只在「已进入应用、且没有遮挡」时接管(2026-09-29 审计 P3):
     *   · 锁屏 / 建库 / 加载态(lockMode 非空,见 store.js):库还没解锁,
     *     任何快捷键都不该有反应 —— 以前锁屏按 Ctrl+K 会点亮搜索框、J/K 还会切笔记;
     *   · 模态框打开:弹窗正等用户选择,此时切笔记 / 存盘只会把上下文带跑
     *     (模态框自己的 Enter/Esc 走 dialog 的原生行为,不受这里影响)。
     *   放在最前面整类放行,而不是逐个分支各自判 —— 后面新增快捷键不会再漏。 */
    if (ctx.store.get('lockMode')) return;
    /* Ctrl/⌘ + Shift + L = 立即锁定(「老板键」)。
     * ★ 2026-10-11:私密笔记最常撞上的场景是「有人走过来」—— 而此前锁屏只有一个入口
     *   (右上角那枚按钮),伸手去点太慢、动作也太显眼。给一条纯键盘的退路。
     * ★ confirmDiscard:false 是**必需**的,不是图省事:lockNow 默认在有未保存改动时弹
     *   确认框,而那个框唯一的「取消」分支就是**不锁定** —— 在「有人走过来」的当口把
     *   正文继续留在屏幕上,恰恰废掉了老板键的全部意义。这里不给这个选择。
     *   改动仍会先尽力保存一次(lockNow 内部已 await);确实没存上的,锁完如实说
     *   ——「快」但不「瞒」。
     * ★ 2026-10-11 审计 P2:本分支必须排在下面那条 dialog[open] 全局守卫**之前** ——
     *   老板键的核心场景恰是紧急时刻,而那一刻屏幕上完全可能正开着弹窗(回收站 /
     *   版本历史 / 移动到分类 / 密码生成器)。排在守卫之后会被静默拦掉,等于在最需要
     *   它的时候失效。showLock 内部本就会 dlg.close() 关掉弹窗,技术上毫无障碍。
     *   lockMode 守卫仍留在更前面(锁屏态本来就没什么可锁的)。 */
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      Promise.resolve(ctx.lockNow({ confirmDiscard: false }))
        .then((n) => n > 0 && ctx.toast(`已锁定 · ${n} 个分类的改动没能存上,已放弃(服务器上的是完整版本)`, 'warn'))
        .catch(() => { /* 锁定异常不该冒泡成 unhandledrejection(审计 P3) */ });
      return;   // 已接管:不再往下走,免得还去命中别的分支
    }
    if (document.querySelector('dialog[open]')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      // 与「保存」按钮同一条路:先 collect 再 save。按钮那条 collect、快捷键这条不 collect,
      // 靠 input 监听逐键同步才碰巧等价 —— 任何不触发 input 的赋值(自动填充/
      // programmatic)就会让两条入口分叉(2026-10-06 审计 P3)
      ctx.collectEditChanges();
      ctx.saveAll();
    }
    // Ctrl+K 聚焦搜索(比浏览器默认的「搜索 with 引擎」在这里有用得多)
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      $('searchBox').focus();
      $('searchBox').select();
    }    // Escape 收起搜索面板(顺带清空输入)。模态框未开时面板才可能可见,
    // 二者不会同时在前台,不需要 stopPropagation 去拦别的处理器
    if (e.key === 'Escape' && !$('searchPanel').hidden) {
      ctx.closeSearch();
      $('searchBox').blur();
    }
    // Ctrl+Enter = 完成(退出编辑),写完一大段不用伸手去够右下角
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && ctx.store.get('editing')) {
      e.preventDefault();
      ctx.exitEditMode();
    }
    /* ?(Shift+/)= 打开快捷键清单。
     * ★ 与 J/K 不同,它**不能**在输入框里生效:正文和搜索框里打 ? 是正常字符。
     *   (J/K 靠 moveNoteSelection 内部判断焦点,而这里必须自己判 —— 抄那段会
     *    把「搜索框里打 j」一起放行,那是另一个功能。) */
    if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const f = document.activeElement;
      const typing = !!f && (f.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(f.tagName));
      if (!typing) {
        e.preventDefault();
        openKeyHelp(ctx);
        return;   // 已接管:别再往下走,免得还去命中别的分支
      }
    }
    // J / K(或 Alt+↓ / Alt+↑)= 读态切换下一条 / 上一条
    // ★ 必须放行带 ctrl/meta 的组合(2026-09-29 审计 P3):Alt+Ctrl+↓、⌘+Alt+↑ 这类
    //   是系统/浏览器级组合键,以前只要 altKey 为真就接管,等于从它们手里抢按键
    const altDown = e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp');
    const jk = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.key === 'j' || e.key === 'K' || e.key === 'k' || e.key === 'J');
    if (jk || altDown) {
      const down = altDown ? e.key === 'ArrowDown' : (e.key === 'j' || e.key === 'J');
      if (ctx.moveNoteSelection(down ? 1 : -1)) e.preventDefault();
    }
  });

  /* ── 混版自愈打标(2026-10-24)─────────────────────────────
   * 能执行到这里 = bindEvents 全程无异常 = 上面每一条 $('id').addEventListener
   * 都成功绑上了。给 HTML 声明的接线点(data-controls)逐个打标,
   * start() 的 mixedShellGaps 随后核对「存在却没标」的项。
   * ⚠️ 判据落在** HTML 声明**上而不是 JS 自己的清单:旧 JS 根本不认识
   *    新按钮,它的清单里没有,只有 HTML 声明的才暴露缺口。 */
  for (const id of (document.documentElement.dataset.controls || '').split(/\s+/).filter(Boolean)) {
    const el = ctx.dom.byId(id);
    if (el) el.dataset.wired = '1';
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && ctx.store.get('dirty').size > 0) ctx.saveAll();
  });

  window.addEventListener('beforeunload', (e) => {
    if (ctx.store.get('dirty').size > 0) { e.preventDefault(); e.returnValue = ''; }
  });
}

/* ================= 批量导入 Markdown ================= */

/**
 * 把一批 .md / .txt 按篇建进当前分类,一次条件写落盘。
 *
 * 为什么值得做:此前「导入」只接受 .zip 备份包,从 Obsidian / Notion / Typora
 * 迁入只能一篇篇手工粘贴 —— 而「导入」正是这类工具的标准入口。
 *
 * 标题/正文的解析在 format.js 的纯函数里(可离线单测),本函数只做编排:
 * 读文件 → 建笔记对象 → 按目标分类自己的 order 号段排到末尾 → 一次 CAS 写。
 * @param {object} ctx
 * @param {File[]} files 已按扩展名过滤过的文本文件
 */
async function importMdFiles(ctx, files) {
  const cat = ctx.store.get('activeCat');
  const lib = ctx.store.get('lib');
  if (!cat || !lib) { ctx.toast('先选择要导入到哪个分类(左侧列表)', 'warn'); return; }
  ctx.setStatus('正在导入…', 'busy');
  const failed = [];
  const notes = [];
  for (const f of files) {
    try {
      const { title, content } = F.mdFileToNote(await f.text(), f.name);
      notes.push({
        id: `n${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}${notes.length}`,
        title,
        content,
        order: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        attachments: [],
      });
    } catch (e) {
      // 单个文件读不出来不能拖垮整批:批量导入要能部分成功
      failed.push(`${f.name}:${e?.message || '读取失败'}`);
    }
  }
  if (!notes.length) {
    ctx.refreshSaveStatus();
    ctx.toast(failed.length ? `没有可导入的文件:${failed[0]}` : '没有可导入的文件', 'error');
    return;
  }
  try {
    await lib.loadCategory(cat);
    const info = lib.categoryInfo(cat);
    // order 按**目标**分类自己的号段算,依次排到末尾(与 moveNoteToCategory 同源);
    // 非有限值(order 脏数据)要跳过,否则 Math.max 会传染成 NaN 让顺序失效
    let last = null;
    if (info?.data) {
      for (const n of F.sortNotes(info.data.notes)) if (Number.isFinite(n.order)) last = n.order;
    }
    for (const n of notes) { last = F.orderBetween(last, null); n.order = last; }

    const r = await lib.appendNotesToCategory(cat, notes);
    if (r?.ok) {
      const cnt = info?.data ? info.data.notes.length : notes.length;
      // 篇数徽章单独对齐一次(与跨分类移动同一处置):失败只是徽章晚一拍,不影响正文
      lib.setCatCounts({ [cat]: cnt }).then(() => ctx.renderCategoryList()).catch(() => {});
      ctx.store.get('tabs')?.send({ type: 'cat-saved', name: cat });
      ctx.renderNoteList();
      ctx.toast(`已导入 ${r.added} 篇到「${cat}」${r.dup ? `(${r.dup} 篇 id 重复已跳过)` : ''}`);
    } else if (r?.conflict) {
      ctx.toast(`「${cat}」刚被其他设备改过,本次导入未生效;请重试`, 'error');
    } else {
      ctx.toast('没有可导入的内容', 'warn');
    }
  } catch (e) {
    ctx.toast(`导入失败:${e.message}`, 'error');
  } finally {
    ctx.refreshSaveStatus();   // 权威终态收尾:把「正在导入…」换回 已保存 / 有未保存更改
  }
  if (failed.length) ctx.toast(`${failed.length} 个文件没读出来:${failed[0]}`, 'error');
}

/* ================= 导入分流(文件选择与拖拽放置共用) ================= */

/** 按扩展名把待导入文件分三堆(纯函数,可离线单测)。
 *  .zip → 备份恢复;.md/.markdown/.txt → 批量导入;其余 → 不支持。
 *  大小写不敏感(.MD / .Zip 都认)。 */
export function classifyImportFiles(files) {
  const zips = [], texts = [], bad = [];
  for (const f of files || []) {
    const name = String(f?.name || '');
    if (/\.zip$/i.test(name)) zips.push(f);
    else if (/\.(md|markdown|txt)$/i.test(name)) texts.push(f);
    else bad.push(f);
  }
  return { zips, texts, bad };
}

/** 执行分流(2026-10-24 从 importInput 的 change 里抽出,拖拽放置共用)。 */
export function routeImports(ctx, files) {
  const { zips, texts, bad } = classifyImportFiles(files);
  if (zips.length) {
    if (zips.length > 1) ctx.toast('一次只能恢复一个备份包,已取第一个', 'warn');
    ctx.importFromBackup(zips[0]);
  }
  if (texts.length) importMdFiles(ctx, texts);
  if (!zips.length && !texts.length && bad.length) {
    ctx.toast('只支持 .zip 备份包与 .md / .txt 文本文件', 'warn');
  }
}

/* ================= 快捷键帮助 ================= */

/**
 * 快捷键清单数据。抽成**导出常量**是为了能离线单测:
 * 键位重复、文案为空、组名为空,这类「文案漂移」在真机上要逐条按才看得出来。
 *
 * 分组按使用场景切,不按修饰键切 —— 用户是带着「我现在想干什么」来的。
 * 桌面端限定的条目集中在「全局 / 阅读 / 编辑」,触屏手势单独一组并标清:
 * 手机上照抄一份「用不了的清单」只会让人以为功能缺失。
 */
export const KEY_HELP_GROUPS = [
  {
    name: '全局', items: [
      { keys: ['Ctrl', 'S'], desc: '保存(停笔 4 秒也会自动存)' },
      { keys: ['Ctrl', 'K'], desc: '聚焦搜索框,搜索标题与正文' },
      { keys: ['Esc'], desc: '收起搜索面板' },
      { keys: ['Ctrl', 'Shift', 'L'], desc: '立即锁定(老板键:有人走过来时按)' },
      { keys: ['?'], desc: '打开这份快捷键清单' },
    ],
  },
  {
    name: '阅读', items: [
      { keys: ['J'], desc: '下一条笔记' },
      { keys: ['K'], desc: '上一条笔记' },
      { keys: ['Alt', '↑ / ↓'], desc: '切换上一条 / 下一条(与 J/K 等价)' },
      { keys: ['Enter'], desc: '打开左侧列表中聚焦的那一条' },
    ],
  },
  {
    name: '编辑', items: [
      { keys: ['Tab'], desc: '插入缩进(不会跳出输入框)' },
      { keys: ['Ctrl', 'Enter'], desc: '完成编辑并保存' },
      { keys: ['Ctrl', 'V'], desc: '把剪贴板里的图片直接粘成附件' },
    ],
  },
  {
    name: '触屏手势(手机 / 平板)', items: [
      { keys: ['上下滑动'], desc: '划到边界再划一下:翻到上 / 下一篇' },
      { keys: ['双击正文'], desc: '进入编辑' },
      { keys: ['点图片'], desc: '放大查看原图' },
    ],
  },
];

/** 弹出快捷键清单。桌面端按 ? 或点侧栏那枚键盘图标都能打开。 */
async function openKeyHelp(ctx) {
  await ctx.modal({
    type: 'custom',
    title: '键盘快捷键',
    text: '带 Ctrl 的条目是桌面端快捷键;手机上用最下面那组触屏手势。',
    build: (body) => {
      for (const g of KEY_HELP_GROUPS) {
        const h = document.createElement('div');
        h.className = 'keyhelp-group';
        h.textContent = g.name;
        body.appendChild(h);
        const list = document.createElement('div');
        list.className = 'keyhelp-list';
        for (const it of g.items) {
          const row = document.createElement('div');
          row.className = 'keyhelp-row';
          const kbd = document.createElement('span');
          kbd.className = 'keyhelp-keys';
          kbd.textContent = it.keys.join(' + ');
          const desc = document.createElement('span');
          desc.className = 'keyhelp-desc';
          desc.textContent = it.desc;
          row.append(kbd, desc);
          list.appendChild(row);
        }
        body.appendChild(list);
      }
    },
  });
}

/* ================= 入口 ================= */

/** 混版自愈判据(纯函数,可离线单测;doc 形如浏览器 document)。
 *  HTML 的 data-controls 声明了「本版本应该有绑定」的接线点;文档里
 *  存在、却没被本版本 JS 打上 wired 标的,就是「新 HTML + 旧 JS」混版 ——
 *  部署后首次访问,index.html 走 network-first 永远最新,而 js 模块走
 *  stale-while-revalidate 可能还是旧版,旧 JS 不认识新按钮:图标不注入、
 *  点击没反应、控制台零报错(2026-10-24 用户线上实测,根因即此)。
 *  只认「存在但没标」:声明了却不存在 = 旧 HTML + 新 JS(离线兜底),
 *  那是反向混版,绑定处已有 voidEl 保险,不重载(重载也还是旧 HTML)。 */
export function mixedShellGaps(doc) {
  const declared = String(doc.documentElement?.dataset?.controls || '').split(/\s+/).filter(Boolean);
  return declared.filter((id) => {
    const el = doc.getElementById(id);
    return !!el && el.dataset?.wired !== '1';
  });
}

/** 混版自愈动作:清掉 SW 缓存并重载一次。
 *  · 同一会话只做一次(sessionStorage 记账):重载后仍是旧 JS(典型:离线)
 *    也不能反复重载,下次联网访问自然拿到新版;
 *  · 离线时不动作:重载只会再拿一份旧缓存,白折腾;
 *  · 清缓存失败也照常重载 —— SWR 的后台回源在首次访问时就已在跑,
 *    重载时缓存很可能已是新的;真不是新的,网络也会给一份。 */
async function healMixedShell(gaps) {
  try { if (sessionStorage.getItem('jmbiji.shellHeal')) return; } catch { /* 隐私模式 */ }
  try { sessionStorage.setItem('jmbiji.shellHeal', '1'); } catch { /* 忽略 */ }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  console.info('[JMbiji] 检测到界面资源混版(新页面 + 旧脚本),自动刷新以对齐:', gaps.join(', '));
  try {
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch { /* 忽略:照常重载 */ }
  location.reload();
}

export async function start(ctx) {
  ctx.initTheme(); // 先定深浅色:锁屏第一屏就应该是用户要的样子
  ctx.reading.apply(); // 阅读排版偏好(字号/行距/宽度)与主题同一时机落 CSS 变量
  bindEvents(ctx);
  /* 混版自愈:新 HTML + 旧 JS 时,新控件没人绑(无图标、点击无反应、零报错)。
   * 核对 HTML 声明清单,有缺口就清缓存重载一次。 */
  const gaps = mixedShellGaps(document);
  if (gaps.length) healMixedShell(gaps);
  // 多标签页同步:BroadcastChannel 不可用时 TabSync 会静默降级(store.tabs.enabled === false),
  // 其余功能一律照常 —— 同步是锦上添花,不是必需品。
  ctx.store.set('tabs', new ctx.TabSync({ onMessage: (msg) => ctx.onTabMessage(msg) }));
  await boot(ctx);
}
