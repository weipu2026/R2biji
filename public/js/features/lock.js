/* ============================================================
 * feature: 锁屏 / 解锁 / 建库 / 「记住本设备」
 * ------------------------------------------------------------
 * 从 ui.js 的「锁屏」「『记住本设备』」「解锁 / 建库」三个区块原样迁出。
 *
 * ★ 安全不变量(改动前必读):
 *   锁定 = 丢弃 Library 实例 → 密钥与全部明文一起释放。以下三条缺一不可:
 *     ① S.lib.destroy() 且置 null(vaultlib 侧清空内存中的子密钥)
 *     ② API.clearToken()(否则刷新后还能请求)
 *     ③ clearSession()(否则「锁定」形同虚设:刷新一下又自动进去了)
 *   同时必须清掉挂起的定时器(autoSaveTimer / statusTimer / idleTimer)——
 *   会话结束后不该再有任何计时逻辑跑起来。
 *
 * 依赖(经 ctx 注入):
 *   - dom.byId(id)            取元素
 *   - toast(msg,kind)         轻提示
 *   - modal(opts)             通用对话框(未保存改动的二次确认)
 *   - store                   会话态(读写 lib/vaultJson/settings/lockMode/dirty/tabs)
 *   - saveAll()               锁定前尽力保存
 *   - resetStatusPriority()   回到锁屏要清状态栏粘性(否则下次解锁首条 ok 被拦)
 *   - stopIdleTimer()         停掉空闲计时
 *   - enterApp()              解锁成功后进入应用
 *   - onLocked()              锁定后由宿主做的事(本项目:无需额外动作)
 *   - api                     { setToken, clearToken, createVaultJson }
 *   - session                 { saveSession, clearSession }
 *   - vault                   { unlockVault, deriveAllKeys, createVault, dekMatchesVault }
 *   - format                  { assessPassword }(纯函数,也可直接 import)
 *   - Library                 建库 / 解锁时构造实例
 * ============================================================ */
import * as F from '../format.js';

/** 恢复会话失败时要在锁屏上说明的原因,由 showLock 消费一次后清空 */
let pendingLockMsg = null;

export function showLock(ctx, mode) {
  const S = ctx.store;
  const $ = (id) => ctx.dom.byId(id);
  /* ★ 必须先关掉共用 <dialog>(2026-10-06 审计 P1):它被 showModal() 放进
   *   top layer,渲染层级在 #lock **之上**,而 #app 只是 hidden ——
   *   于是「最近删除」的笔记标题/分类名、随机密码生成器已生成的密码、
   *   「移动到其他分类」的分类清单会**浮在锁屏上方**直接可读。
   *   dialog.close() 会让 modal() 的 Promise 落定 null(其 close 处理器已就位),
   *   语义正确(用户没做任何选择)。 */
  const dlg = $('modal');
  if (dlg && dlg.open) dlg.close();
  $('app').hidden = true;
  $('lock').hidden = false;
  $('lockErr').hidden = true;
  // 回到锁屏 = 上一会话彻底结束,状态栏的粘性优先级一并清零,
  // 否则下次解锁后第一次「已保存」会被上一轮的 error 拦掉
  ctx.resetStatusPriority();
  if (pendingLockMsg) {
    $('lockErr').textContent = pendingLockMsg;
    $('lockErr').hidden = false;
    pendingLockMsg = null;
  }
  const loading = mode === 'loading';
  $('lockLoading').hidden = !loading;
  $('lockForm').hidden = loading;
  $('rememberDevice').checked = S.get('settings').rememberDevice !== false;
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
  S.set('lockMode', mode);
}

/**
 * 会话销毁:把「锁定必毁全部明文」这条安全不变量收敛到一处。
 * ★ 抽成纯函数(只依赖 store + 两个注入点)是为了**可单测** ——
 *   真机护栏只能观测到「视图切到锁屏 / 刷新后不回应用」,
 *   而「lib 是否真的被销毁、密钥是否还留在内存」是内存状态,
 *   行为层看不见,只能靠单测断言(见 tests/lock.test.mjs)。
 *
 * 顺序有讲究:先把 lib 置 null(后续任何异步回调读到的都是 null),再清令牌与会话。
 * @returns {boolean} 是否确实销毁了一个活动会话
 */
export function releaseSession(store, { api, session }) {
  const lib = store.get('lib');
  // ★ 释放 Library 之前,把它手里**最新**的那份 vault.json(和 etag)交还给会话态。
  //   store.vaultJson 只在 boot 时拉过一次;而改主密码(换 KDF 盐与 wrap)、
  //   调序/置顶(只改 catMeta)都只更新 Library 自己那份副本 —— 不交还的话,
  //   「锁定 → **原地**解锁(不刷新页面)」会拿旧 wrap 去解新密码(报「主密码错误」,
  //   再用旧密码试则是 401),或拿旧 catMeta 渲染出过期的顺序/置顶。
  //   (2026-09-28 真机探针实测;同源的另一半在 ui.js 的 rescanFromTabs。)
  if (lib) {
    if (lib.vaultJson) store.set('vaultJson', lib.vaultJson);
    if (lib.vaultEtag) store.set('vaultEtag', lib.vaultEtag);
  }
  if (lib) { lib.destroy(); store.set('lib', null); }
  api.clearToken();
  // 锁定 = 忘掉本机记住的会话(真正的「退出登录」)。不清的话「锁定」形同虚设:
  // 刷新一下又自动进去了。想再次免密,解锁时勾着「记住本设备」即可。
  session.clearSession();
  store.patch({ activeCat: null, activeNoteId: null, editing: false });
  store.clearAllDirty(); // 走 store 的既有 API(直写容器会绕过它的维护逻辑)
  for (const url of store.get('objectUrls').values()) URL.revokeObjectURL(url);
  store.get('objectUrls').clear();
  // ★ 必须连自动保存定时器一起清。dirty.clear() 后挂起的 4 秒定时器到点仍会跑
  //   saveAll();虽然 saveAll 开头的 `if (!lib) return` 兜住了「锁屏后不写数据」,
  //   但定时器本身不该在会话结束后继续存在 —— 它会在用户已回到锁屏界面时触发
  //   一次网络/状态逻辑,属计时器泄漏。
  clearTimeout(store.get('autoSaveTimer'));
  store.set('autoSaveTimer', null);
  clearTimeout(store.get('statusTimer'));
  store.set('statusTimer', null);
  /* ★ 锁定 = 明文全部离开内存,DOM 也不例外(2026-10-06 审计 P1)。
   *   lib.destroy() 只丢密钥与解密后的数据结构;可 #readBody(当前笔记全文)、
   *   #editBody / #editTitle(未提交的编辑内容)、#searchPanel(搜索结果片段)、
   *   #noteList(分类下全部标题)这些**明文节点仍留在页面里**,
   *   而 #app 只是 hidden —— 谁都能在解锁前把它们读回来(截图、扩展、
   *   DevTools 残留脚本)。与 lock.js 开头「锁定 = 丢弃 Library 实例(密钥与明文
   *   一起释放)」的不变量对齐。 */
  for (const id of ['readBody', 'readTitle', 'readMeta', 'editBody', 'editTitle',
    'searchPanel', 'noteList', 'readAtts', 'editAtts']) {
    // document 不存在(Node 侧的会话态测试)时跳过 —— 清理明文是浏览器侧的责任
    const el = typeof document === 'undefined' ? null : document.getElementById(id);
    if (el) el.textContent = '';
  }
  return !!lib;
}

/**
 * 锁定 = 退出登录。
 * @param {{broadcast?:boolean, confirmDiscard?:boolean}} [opt]
 *   broadcast:false      = 收到别的标签页的「锁定」通知,不再回声;
 *   confirmDiscard:false = 远端锁定(另一端已结束会话),不弹确认直接锁。
 */
export async function lockNow(ctx, { broadcast = true, confirmDiscard = true } = {}) {
  const S = ctx.store;
  if (S.get('dirty').size > 0) {
    /* ★ 必须等**在途**保存真的跑完(2026-10-06 审计 P1 数据丢失):
     *   此前这里 `await ctx.saveAll()`,而 saveAll 在 S.saving 为真时是
     *   「置 resavePending 后立即 return」—— await 等到的是 undefined。
     *   于是确认框一关就 releaseSession → lib.destroy()(keys 置 null),
     *   在途的 saveCategory 读到 null 抛 TypeError,被 saveAll 的 catch 吞成
     *   「保存失败」,而脏标记已被清空 ⇒ 未保存改动静默消失。
     *   现在 await 的是 S.savePromise(同一轮保存的 promise):等它落地,
     *   它自己会把「会话已销毁 → 不再写、不算失败」处理好。 */
    try { await (S.get('savePromise') || ctx.saveAll()); } catch { /* 尽力保存 */ }
  }
  // ★ 锁定必毁全部明文,这是安全不变量;但「毁改动」必须经用户确认 ——
  //   冲突弹窗里刚选过「留待稍后」的分类,转身就在这里被静默清空,等于承诺作废。
  //   保存/冲突处理完仍有未保存改动时,让人在「放弃改动并锁定」与「暂不锁定」
  //   之间二选一。远端锁定不问:另一标签页已把会话结束掉,没有可商量的余地。
  if (confirmDiscard && S.get('dirty').size > 0) {
    const yes = await ctx.modal({
      type: 'confirm', danger: true,
      title: '还有未保存的改动',
      text: `${S.get('dirty').size} 个分类的改动尚未保存成功,锁定将放弃这些改动(服务器上的版本不受影响)。确定锁定吗?`,
    });
    if (!yes) return;
  }
  // 先通知再清:锁定会清掉共享的 localStorage 会话,不通知的话
  // 另一个标签页还开着就等于「锁定」没生效(它的内存里还留着令牌与明文)
  if (broadcast) S.get('tabs')?.send({ type: 'locked' });
  releaseSession(S, { api: ctx.api, session: ctx.session });
  ctx.stopIdleTimer();
  showLock(ctx, S.get('vaultJson') ? 'unlock' : 'setup');
}

/**
 * 解锁/建库成功后,按用户意愿把会话落盘(勾选了才存)。
 * 与 lockNow 里的 clearSession 是一对:存 → 免密进入,清 → 需要重新输主密码。
 * ★ 导出供 ui.js 的 changePassword 复用:改密码换了鉴权令牌(DEK 不变),
 *   本机记住的会话必须同步更新,否则下次打开拿旧令牌 → 401 → 被迫重输主密码。
 */
export function rememberNow(ctx, dek, authKeyHex) {
  if (!ctx.store.get('settings').rememberDevice) return;
  if (!ctx.session.saveSession({ dek, authKeyHex })) {
    // 隐私模式 / 存储被禁:降级为「不记住」。必须说一声 ——
    // 否则用户以为已经记住了,下次打开发现还要输密码,会以为程序坏了。
    ctx.toast('本浏览器不允许保存登录状态,下次打开仍需输入主密码', 'warn');
  }
}

/** vault.json 备份:浏览器下载一份到本地(建库后 / 改密码后自动触发) */
export function downloadVaultBackup(json) {
  const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'vault.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export async function doUnlock(ctx, password) {
  const S = ctx.store;
  const $ = (id) => ctx.dom.byId(id);
  const err = $('lockErr');
  err.hidden = true;
  try {
    const res = await ctx.vault.unlockVault(S.get('vaultJson'), password);
    if (!res.ok) {
      err.textContent = res.reason === 'password' ? '主密码错误' : 'vault.json 已损坏,请从备份恢复';
      err.hidden = false;
      return;
    }
    const keys = await ctx.vault.deriveAllKeys(res.dek);
    ctx.api.setToken(res.authKeyHex);
    const lib = new ctx.Library(keys, S.get('vaultJson'), res.dek, S.get('vaultEtag'));
    S.set('lib', lib);
    await lib.rescan();
    if (res.weakKdf) ctx.toast('注意:本库的密钥派生迭代次数低于当前建议值', 'warn');
    rememberNow(ctx, res.dek, res.authKeyHex);
    await ctx.enterApp();
  } catch (e) {
    err.textContent = `打开失败:${e.message}`;
    err.hidden = false;
  }
}

export async function doCreateLibrary(ctx, password, password2) {
  const S = ctx.store;
  const $ = (id) => ctx.dom.byId(id);
  const err = $('lockErr');
  err.hidden = true;
  const policy = F.assessPassword(password);
  if (!policy.ok) { err.textContent = policy.msg; err.hidden = false; return; }
  if (password !== password2) { err.textContent = '两次输入的密码不一致'; err.hidden = false; return; }
  try {
    const { json, dek, authKeyHex } = await ctx.vault.createVault(password);
    const { status, etag } = await ctx.api.createVaultJson(JSON.stringify(json, null, 2));
    if (status === 409) {
      err.textContent = '服务器上已存在笔记库,请直接解锁';
      err.hidden = false;
      S.set('vaultJson', null); // 重新走 boot 拉取
      S.set('lockMode', 'unlock');
      $('pwConfirmField').hidden = true;
      $('pwBtn').textContent = '解锁';
      $('pwInput').value = '';
      $('pwInput').focus();
      return;
    }
    const keys = await ctx.vault.deriveAllKeys(dek);
    ctx.api.setToken(authKeyHex);
    const lib = new ctx.Library(keys, json, dek, etag);
    S.set('lib', lib);
    S.set('vaultJson', json);
    await lib.rescan();
    rememberNow(ctx, dek, authKeyHex);
    downloadVaultBackup(json);
    ctx.toast('笔记库已创建。vault.json 备份已开始下载,请妥善保存(全库钥匙的唯一载体)');
    await ctx.enterApp();
  } catch (e) {
    err.textContent = `创建失败:${e.message}`;
    err.hidden = false;
  }
}

/**
 * 用本机记住的会话直接进入应用。
 * ★ 迁到本模块(原在 ui.js 的 boot 区块):与 unlock 同属密钥生命周期,
 *   散在两处最容易出现「一半清了、一半没清」。
 * @returns {boolean} true = 已进入;false = 回落锁屏(不可用的会话已清掉)
 *
 * 两种失败都要清掉会话并说明原因,不能静默:
 *  · 钥匙与库不匹配(桶换过 / vault.json 被别的库覆盖)→ 不清就会「进去了但每个分类都打不开」
 *  · 令牌失效(多半是别的设备改过主密码)→ 不清就会每次打开都失败一次
 */
export async function resumeSession(ctx) {
  const S = ctx.store;
  const sess = ctx.session.loadSession();
  if (!sess) return false;
  try {
    if (!(await ctx.vault.dekMatchesVault(S.get('vaultJson'), sess.dek))) {
      ctx.session.clearSession();
      pendingLockMsg = '本机记住的钥匙与这个库不匹配(可能换过桶或被别的库覆盖),已清除,请重新输入主密码';
      return false;
    }
    ctx.api.setToken(sess.authKeyHex);
    const keys = await ctx.vault.deriveAllKeys(sess.dek);
    const lib = new ctx.Library(keys, S.get('vaultJson'), sess.dek, S.get('vaultEtag'));
    S.set('lib', lib);
    await lib.rescan(); // 令牌过期 → 401 在这里抛出来
    await ctx.enterApp();
    return true;
  } catch (e) {
    const cur = S.get('lib');
    if (cur) { cur.destroy(); S.set('lib', null); }
    ctx.api.clearToken();
    ctx.session.clearSession();
    pendingLockMsg = e?.status === 401
      ? '登录令牌已失效(可能在其他设备改过主密码),请重新输入主密码'
      : `无法恢复上次的登录状态(${e.message}),请重新输入主密码`;
    return false;
  }
}
