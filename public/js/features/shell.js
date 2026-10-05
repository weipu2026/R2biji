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

/* ================= 启动流程 ================= */

/* 导出原因:ui.js 的「从备份恢复」在重建了库之后需要**重跑一遍启动流程**
 * (vaultJson 已失效、当前会话令牌也对不上),那个调用点在 ui.js 里。
 * 由 ui.js import 本函数即可 —— 反向(本文件 import ui.js)才是不允许的。 */
export async function boot(ctx) {
  ctx.loadSettings();
  ctx.api.loadAccessKey();
  ctx.showLock('loading'); // 首屏即过渡态:主密码框只在该手动解锁时出现,别闪现
  // 拉取 vault.json:404 = 未建库 → 建库流程;其余错误 → 提示
  for (;;) {
    let res;
    try {
      res = await ctx.api.fetchVault();
    } catch (e) {
      if (e.code === 'access-key') {
        const key = await ctx.modal({
          type: 'prompt', title: '访问密钥',
          label: `输入部署时设置的 ACCESS_KEY(≥16 字符)`,
          text: '此服务器启用了访问密钥(与主密码是两回事)。密钥只保存在本机浏览器里,换设备/换浏览器需再输一次。',
        });
        if (key != null && key.trim()) { ctx.api.saveAccessKey(key.trim()); continue; }
        ctx.dom.byId('lockErr').textContent = '未提供访问密钥,无法连接笔记库';
        ctx.dom.byId('lockErr').hidden = false;
        ctx.dom.byId('lockLoading').hidden = true;
        return;
      }
      // 服务端 fail closed(ACCESS_KEY 未配置/过短):原样显示它给的可操作提示
      ctx.dom.byId('lockErr').textContent = e.code === 'setup-required' ? e.message : `无法连接服务器:${e.message}`;
      ctx.dom.byId('lockErr').hidden = false;
      ctx.dom.byId('lockLoading').hidden = true;
      return;
    }
    if (res.status === 404) { ctx.showLock('setup'); return; }
    /* ⚠️ 必须用 set():store 的状态都在 _state 里,实例上没有字段。
     *    若按老习惯直接往实例上挂属性(写成「ctx.store 点 字段名 等于 值」),
     *    那只是个没人读的实例属性,后续 get 读不到 —— 表现为「解锁永远说库损坏」。
     *    (2026-09-27 实测:护栏「建库后进入应用」超时,根因就是这个。) */
    ctx.store.set('vaultJson', res.json);
    ctx.store.set('vaultEtag', res.etag);
    // 「记住本设备」:本机有可用会话就直接进,不问主密码(失败会自己回落锁屏)
    if (ctx.store.get('settings').rememberDevice && await ctx.resumeSession()) return;
    ctx.showLock('unlock');
    return;
  }
}

/* ================= 事件绑定 ================= */

function bindEvents(ctx) {
  const $ = (id) => ctx.dom.byId(id);
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
  // 等宽字体开关:偏好只存本浏览器(localStorage,非敏感),键名随 jmbiji.* 约定,
  // 存取失败(隐私模式)静默降级为仅本次会话生效 —— 与主题偏好同一套纪律
  const monoBtn = $('btnMono');
  if (monoBtn) {
    const monoApply = (on) => {
      $('editBody').classList.toggle('mono', on);
      monoBtn.setAttribute('aria-pressed', String(on));
    };
    let monoOn = false;
    try { monoOn = localStorage.getItem('jmbiji.mono') === '1'; } catch { monoOn = false; }
    monoApply(monoOn);
    monoBtn.addEventListener('click', () => {
      monoOn = !monoOn;
      monoApply(monoOn);
      try { localStorage.setItem('jmbiji.mono', monoOn ? '1' : '0'); } catch { /* 仅本次会话生效 */ }
    });
  }
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
  $('btnCleanBlobs').addEventListener('click', async () => {
    if (!ctx.store.get('lib')) return;
    const yes = await ctx.modal({ type: 'confirm', title: '清理未引用图片', text: '将解密全部分类并删除没被任何笔记引用的图片文件。继续?' });
    if (!yes) return;
    try {
      const removed = await ctx.store.get('lib').cleanupOrphanBlobs();
      ctx.renderCategoryList(); // 清理前会重新拉一次清单,界面跟着对齐
      ctx.toast(removed.length ? `已清理 ${removed.length} 张未引用图片` : '没有需要清理的图片');
    } catch (e) {
      // 清理是 fail closed 的:读不全就一张不删。这条提示必须看得清、看得久,
      // 否则用户会以为「点过了就等于清干净了」。
      ctx.toast(`清理已中止:${e.message}`, 'error');
    }
  });
  $('btnExport').addEventListener('click', () => ctx.exportFullBackup());
  $('btnImport').addEventListener('click', () => $('importInput').click());
  $('importInput').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file) ctx.importFromBackup(file);
  });

  $('autoLock').addEventListener('change', () => ctx.saveSettings());
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
  for (const b of document.querySelectorAll('#edTools .ed-btn')) {
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
    if (document.querySelector('dialog[open]')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      ctx.saveAll();
    }
    // Ctrl+K 聚焦搜索(比浏览器默认的「搜索 with 引擎」在这里有用得多)
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      $('searchBox').focus();
      $('searchBox').select();
    }
    // Escape 收起搜索面板(顺带清空输入)。模态框未开时面板才可能可见,
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

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && ctx.store.get('dirty').size > 0) ctx.saveAll();
  });

  window.addEventListener('beforeunload', (e) => {
    if (ctx.store.get('dirty').size > 0) { e.preventDefault(); e.returnValue = ''; }
  });
}

/* ================= 入口 ================= */

export async function start(ctx) {
  ctx.initTheme(); // 先定深浅色:锁屏第一屏就应该是用户要的样子
  bindEvents(ctx);
  // 多标签页同步:BroadcastChannel 不可用时 TabSync 会静默降级(store.tabs.enabled === false),
  // 其余功能一律照常 —— 同步是锦上添花,不是必需品。
  ctx.store.set('tabs', new ctx.TabSync({ onMessage: (msg) => ctx.onTabMessage(msg) }));
  await boot(ctx);
}
