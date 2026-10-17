/* ============================================================
 * features/lock.js 的会话销毁不变量
 *
 * 为什么单独测这个:真机护栏(S0)只能观测「视图切到锁屏 / 刷新后不回应用」,
 * 而「Library 实例是否真的被销毁、密钥是否还留在内存里」是**内存状态**,
 * 行为层看不见 —— 2026-09-27 反向探针实测:把 `lib.destroy()` 删掉,
 * 34 条护栏断言全绿,完全抓不到。这类不变量只能落在单测上。
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseSession, autoLock } from '../public/js/features/lock.js';
import { Store } from '../public/js/store.js';

/** 造一个最简 Library 替身:只关心 destroy 有没有被调用 */
function fakeLibrary() {
  return { destroyed: false, destroy() { this.destroyed = true; } };
}

function fakeDeps() {
  const calls = { clearToken: 0, clearSession: 0 };
  return {
    calls,
    api: { clearToken() { calls.clearToken += 1; } },
    session: { clearSession() { calls.clearSession += 1; } },
  };
}

test('★ releaseSession 必须销毁 Library 实例并把它从 store 摘掉(密钥不得留在内存)', () => {
  const store = new Store();
  const lib = fakeLibrary();
  store.set('lib', lib);
  const deps = fakeDeps();

  const had = releaseSession(store, deps);

  assert.equal(had, true, '应当报告「确实销毁了一个活动会话」');
  assert.equal(lib.destroyed, true, 'lib.destroy() 必须被调用 —— 这是密钥释放的唯一入口');
  assert.equal(store.get('lib'), null, 'lib 必须从 store 摘掉,否则后续回调还能读到它');
});

test('★ releaseSession 必须清令牌与本机会话(否则「锁定」形同虚设)', () => {
  const store = new Store();
  store.set('lib', fakeLibrary());
  const deps = fakeDeps();

  releaseSession(store, deps);

  assert.equal(deps.calls.clearToken, 1, '必须清鉴权令牌(否则刷新后还能请求)');
  assert.equal(deps.calls.clearSession, 1, '必须清本机会话(否则刷新一下又自动进去了)');
});

test('releaseSession 必须清空脏标记 / 当前分类 / 当前笔记 / 编辑态', () => {
  const store = new Store();
  store.set('lib', fakeLibrary());
  store.set('activeCat', '甲');
  store.set('activeNoteId', 'n1');
  store.set('editing', true);
  store.get('dirty').add('甲');

  releaseSession(store, fakeDeps());

  assert.equal(store.get('activeCat'), null);
  assert.equal(store.get('activeNoteId'), null);
  assert.equal(store.get('editing'), false);
  assert.equal(store.get('dirty').size, 0, '脏标记必须清空');
});

test('releaseSession 必须清掉挂起的自动保存 / 状态栏定时器(计时器泄漏)', () => {
  const store = new Store();
  store.set('lib', fakeLibrary());
  // 用一个真实句柄:如果没被 clearTimeout,它会在这个测试结束后仍可能触发
  let fired = 0;
  store.set('autoSaveTimer', setTimeout(() => { fired += 1; }, 10));
  store.set('statusTimer', setTimeout(() => { fired += 1; }, 10));

  releaseSession(store, fakeDeps());

  assert.equal(store.get('autoSaveTimer'), null, 'autoSaveTimer 必须被清并置 null');
  assert.equal(store.get('statusTimer'), null, 'statusTimer 必须被清并置 null');
});

test('没有活动会话时 releaseSession 也不报错,并如实报告 false', () => {
  const store = new Store();
  store.set('lib', null);
  const deps = fakeDeps();

  const had = releaseSession(store, deps);

  assert.equal(had, false, '没有 lib 时应报告 false(而不是假装销毁过)');
  assert.equal(deps.calls.clearSession, 1, '即使没有 lib,令牌与会话仍必须清干净');
});

test('★ releaseSession:必须把 Library 手里最新的 vault.json 交还给会话态', () => {
  // 背景(2026-09-28 真机探针):store.vaultJson 只在 boot 时拉过一次;而
  // 改主密码(换 KDF 盐与 wrap)、调序/置顶(只改 catMeta)都只更新 Library 自己那份副本。
  // 不交还的话「改完主密码 → 锁定 → **原地**解锁(不刷新页面)」会拿旧 wrap 去解新密码
  // (报「主密码错误」),再用旧密码试则是 401 —— 用户被锁在门外,只能刷新页面。
  const store = new Store();
  const stale = { kdf: { salt: 'OLD' } };
  const fresh = { kdf: { salt: 'NEW' }, catMeta: { 甲: { pin: true } } };
  store.set('vaultJson', stale);
  store.set('vaultEtag', 'etag1');
  store.set('lib', { vaultJson: fresh, vaultEtag: 'etag2', destroy() {} });

  releaseSession(store, fakeDeps());

  assert.equal(store.get('vaultJson'), fresh,
    '★ 必须交还 Library 那份(不交还 → 改密码后原地解锁会报「主密码错误」)');
  assert.equal(store.get('vaultEtag'), 'etag2', 'etag 必须跟着走(CAS 才用得上最新值)');
});

test('releaseSession:lib 缺失或它没有 vaultJson 时,不得把会话态覆盖成 undefined', () => {
  const store = new Store();
  store.set('vaultJson', { keep: true });
  store.set('vaultEtag', 'etag-keep');
  releaseSession(store, fakeDeps());                 // lib 为 null
  assert.deepEqual(store.get('vaultJson'), { keep: true }, '没有 lib 时不得动会话态');
  assert.equal(store.get('vaultEtag'), 'etag-keep');

  const store2 = new Store();
  store2.set('vaultJson', { keep: 2 });
  store2.set('lib', fakeLibrary());                  // 替身没有 vaultJson/vaultEtag
  releaseSession(store2, fakeDeps());
  assert.deepEqual(store2.get('vaultJson'), { keep: 2 },
    'lib 没有 vaultJson 时也不得覆盖成 undefined');
});

/* ============================================================
 * 2026-10-12 全站审计 P1:空闲自动锁屏不得「谎报已锁」
 *
 * 真机表现:人走开 → 定时器到点 → 屏幕上明文还在,回来一看界面却写着
 * 「已自动锁屏」。根因是走的是 lockNow 的默认 confirmDiscard:true ——
 * 有未保存改动时弹出确认框,而**唯一的取消分支就是不锁定**;没人点 ⇒ 永不锁定,
 * 而调用方在定时器里无条件报了成功。安全语义上这是最坏的一种组合。
 * 现在走 autoLock(ctx):confirmDiscard:false + 如实报数。
 * ============================================================ */

/** 造一个最简 ctx:只关心 lockNow 收到的参数与 toast 说了什么 */
function fakeLockCtx(lockNowImpl) {
  const calls = { lockNow: [], toasts: [] };
  return {
    calls,
    ctx: {
      lockNow: async (opt) => { calls.lockNow.push(opt); return lockNowImpl ? lockNowImpl(opt) : 0; },
      toast: (msg, kind) => { calls.toasts.push({ msg: String(msg), kind }); },
    },
  };
}

test('★ autoLock 必须 confirmDiscard:false(弹确认框等人点 = 永不锁定 + 谎报已锁)', async () => {
  const { calls, ctx } = fakeLockCtx(() => 0);
  await autoLock(ctx);

  assert.equal(calls.lockNow.length, 1, '必须真的调用一次 lockNow');
  assert.deepEqual(calls.lockNow[0], { confirmDiscard: false },
    '★ 自动锁屏必须显式关掉确认框 —— 默认 true 会弹框等人点,而人不在场');
  assert.equal(calls.toasts.length, 1, '锁完必须给一条提示');
  assert.equal(calls.toasts[0].msg, '已自动锁屏');
  assert.equal(calls.toasts[0].kind, 'warn');
});

test('autoLock:有改动没存上时必须如实报数,不得只说「已自动锁屏」', async () => {
  const { calls, ctx } = fakeLockCtx(() => 2);
  await autoLock(ctx);
  const t = calls.toasts[0];
  assert.match(t.msg, /已自动锁屏/, '仍要说明已经锁上了');
  assert.match(t.msg, /2 个/, '★ 必须报出**具体数量** —— 静默丢改动是本项目反复修过的 P1');
  assert.match(t.msg, /服务器上的是完整版本/, '要安抚住「云端是不是也没了」这个疑问');
});

test('★ autoLock:锁定失败必须报错,不许沉默(会话没释放、明文还在屏幕上)', async () => {
  /* 这条路径存在的全部意义就是「不谎报已锁」。若失败时静默 return,
   * 用户回来看到的是「什么都没发生」,而真正的状态是「明文留在屏幕上、会话没销毁」
   * —— 触发它的场景恰恰是人已经走开。 */
  const { calls, ctx } = fakeLockCtx(() => { throw new Error('tabs 通道炸了'); });
  await autoLock(ctx);

  assert.equal(calls.toasts.length, 1, '失败也必须给提示 —— 沉默 = 最坏结果');
  const t = calls.toasts[0];
  assert.equal(t.kind, 'error', '失败必须用 error 档(留 8 秒),不能是普通提示');
  assert.match(t.msg, /失败/, '必须明说是失败');
  assert.match(t.msg, /手动锁定/, '要给出下一步动作');
  assert.doesNotMatch(t.msg, /^已自动锁屏$/, '★ 绝不能在没锁上的时候报「已自动锁屏」');
});

test('autoLock:lockNow 返回 undefined(异常路径)时不得当成「丢了改动」乱报数', async () => {
  const { calls, ctx } = fakeLockCtx(() => undefined);
  await autoLock(ctx);
  assert.equal(calls.toasts[0].msg, '已自动锁屏', 'undefined 应退化成「没丢改动」的普通提示');
});

test('★ doUnlock 失败必须收干净半成品会话(lib 与令牌不得留在内存)', async () => {
  const { doUnlock } = await import('../public/js/features/lock.js');
  /* setToken 与 S.set(lib) 都在 await lib.rescan() 之前执行;rescan 抛错时
   * 若只写错误文本,lib 与令牌会原样留在内存,而界面停在锁屏 ——
   * 之后 onTabMessage 的 `if (!S.lib) return` 会把这个死会话当成活的。 */
  const store = new Store();
  store.set('vaultJson', {});
  store.set('vaultEtag', 'e1');
  let destroyed = 0;
  let token = null;
  class Lib {
    constructor() { this.rescan = async () => { throw new Error('网络断了'); }; }
    destroy() { destroyed += 1; }
  }
  const nodes = new Map();
  const byId = (id) => {
    if (!nodes.has(id)) nodes.set(id, { hidden: true, textContent: '', value: '' });
    return nodes.get(id);
  };
  const ctx = {
    store,
    dom: { byId },
    vault: { unlockVault: async () => ({ ok: true, dek: 'd', authKeyHex: 'a' }), deriveAllKeys: async () => ({}) },
    api: { setToken: (t) => { token = t; }, clearToken: () => { token = null; } },
    Library: Lib,
    enterApp: async () => { throw new Error('不该走到这里'); },
    toast: () => {},
  };
  await doUnlock(ctx, 'pw');
  assert.equal(store.get('lib'), null, '半成品 lib 必须从会话态摘掉');
  assert.equal(destroyed, 1, '必须调用 destroy() 释放密钥');
  assert.equal(token, null, '必须清掉鉴权令牌');
  assert.match(byId('lockErr').textContent, /打开失败/, '锁屏上要如实报错');
});
