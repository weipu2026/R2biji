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
import { releaseSession } from '../public/js/features/lock.js';
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
